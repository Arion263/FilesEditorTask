# System Architecture & Technical Specifications

This document outlines the architectural decisions, storage pipelines, data models, real-time reactive streaming, and operational patterns implemented across the **Files Editor** full-stack application.

---

## 1. Hybrid Serverless Architecture (Next.js + Flask WSGI on Vercel)

The system pairs a modern React frontend (Next.js App Router) with a lightweight, robust Python WSGI backend running together within a unified Vercel deployment:

```
┌────────────────────────────────────────────────────────────────────────┐
│                              Vercel Edge                               │
│                                                                        │
│   ┌────────────────────────────────┐    ┌──────────────────────────┐   │
│   │ Next.js App Router             │    │ api/index.py (WSGI)      │   │
│   │ • React 19 Frontend            │    │ • Flask API Core         │   │
│   │ • TipTap Rich Text Editor      │    │ • Python WSGI Router     │   │
│   │ • /realtime/* Route Handlers   │    │ • File Importers (.docx) │   │
│   │ • Direct Neon DB Serverless    │    │ • Sanitization (nh3)     │   │
│   └───────────────┬────────────────┘    └─────────────▲────────────┘   │
│                   │                                   │                │
│                   └──────── /api/* (Rewrites) ────────┘                │
└────────────────────────────────────────────────────────────────────────┘
```

- **Unified Origin Routing:** Next.js proxies `/api/:path*` to `127.0.0.1:5328` in local development via `next.config.ts`, and rewrites to the single serverless function entrypoint (`api/index.py`) in production.
- **Session Authentication:** Auth state is managed via secure, `HttpOnly`, `SameSite=Lax` signed cookies (`fe_session`), eliminating cross-origin CORS overhead.
- **Modular Packaging:** Core Python application modules reside in `/server` to prevent Vercel from compiling redundant serverless functions.
- **Direct Edge Data Mutations:** High-frequency, real-time notification interactions bypass Flask entirely, routing directly through Next.js serverless route handlers (`/realtime/*`) into Neon PostgreSQL via `@neondatabase/serverless`.

---

## 2. Persistence Layer & Domain Model

Database access uses **SQLAlchemy Core** in Python and **`@neondatabase/serverless`** in Next.js without a heavy ORM to ensure deterministic queries, minimal cold-start overhead, and portability across environments:

- **Local Development & Testing:** Runs against local SQLite (`local.db` or temporary file databases during `pytest`) with zero external infrastructure required. Foreign key enforcement is enabled via connection listener hooks (`PRAGMA foreign_keys=ON`).
- **Production (Serverless PostgreSQL):** Connects to hosted Lakebase PostgreSQL (**Neon**) via `psycopg` (v3). Connection pooling uses `NullPool` with `pool_pre_ping=True` to prevent idle connection exhaustion during concurrent serverless container lifecycles.
- **Idempotent Bootstrapping:** Schema creation (`metadata.create_all()`) and demo account seeding (`_seed_demo_users()`) run idempotently on startup with concurrency guard exceptions (`IntegrityError`).

### Data Entities & Schema:

```
┌──────────────┐       1:N       ┌──────────────┐
│    users     ├────────────────►│   folders    │
└──────┬───────┘                 └──────┬───────┘
       │                                │
       │ 1:N                            │ 1:N (nullable)
       ▼                                ▼
┌──────────────┐       1:N       ┌──────────────┐
│  documents   │◄────────────────┤document_shares│
└──────┬───────┘                 └──────────────┘
       │
       │ 1:N
       ▼
┌──────────────┐
│notifications │
└──────────────┘
```

1. **`users`:** Account credentials (hashed with Werkzeug PBKDF2), display name, and email. Users do **not** carry system-level roles (e.g., admin); roles in this business model are strictly document-scoped access levels.
2. **`folders`:** User-owned organizational containers (`id`, `owner_id`, `name`, `created_at`).
3. **`documents`:** Core document content (`id`, `owner_id`, `folder_id`, `title`, `content`, `version`, timestamps).
4. **`document_shares`:** Access control mapping (`document_id`, `user_id`, `role: 'viewer' | 'editor'`, `created_at`).
5. **`notifications`:** Real-time event log for document sharing (`id`, `recipient_id`, `actor_id`, `actor_name`, `actor_email`, `document_id`, `document_title`, `role`, `is_read`, `created_at`). Indexed on `recipient_id` with stable primary key identity required for Neon Realtime replication.

---

## 3. Real-Time Reactive Architecture (Neon Realtime WebSocket)

The application implements end-to-end reactivity using **Neon Realtime** (Live SQL API over WebSockets), replacing polling with an event-driven streaming pipeline:

```
┌────────────────────────────────────────────────────────────────────────┐
│                            Browser Client                              │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ NotificationCenter Component                                   │   │
│   │ • Persistent WebSocket Connection (@neon/realtime/client)       │   │
│   │ • useLiveQuery Hook (@neon/realtime-react)                     │   │
│   │ • Auto-Reconnection & Refresh Scheduler (QueryRenewal)         │   │
│   └──────────────▲─────────────────────────────────┬───────────────┘   │
└──────────────────┼─────────────────────────────────┼───────────────────┘
                   │ wss://...                       │
                   │ (Direct Live SQL Stream)        │ POST /realtime/seal
                   ▼                                 ▼
┌─────────────────────────────────────┐   ┌──────────────────────────────┐
│        Neon Realtime Gateway        │   │ Next.js Serverless Route     │
│       (Live SQL WebSocket API)      │   │ • Verifies active user       │
└──────────────────▲──────────────────┘   │ • Calls realtime.seal()      │
                   │                      │ • Signs encrypted capability │
                   │ WAL Streaming        └──────────────┬───────────────┘
                   ▼                                     │
┌────────────────────────────────────────────────────────▼───────────────┐
│                    Neon Lakebase PostgreSQL (neondb)                   │
│                                                                        │
│ • notifications table with replica identity                            │
│ • Share event inserts row & generates txid via pg_current_xact_id()    │
│ • Mutations (read, read-all, delete) execute via @neondatabase/serverless│
└────────────────────────────────────────────────────────────────────────┘
```

### Key Realtime Capabilities:
1. **Persistent WebSocket Pipeline:** The browser establishes a direct WebSocket connection (`wss://...neon.tech/`) to Neon's Live SQL gateway using a singleton client factory (`getRealtimeClient` in `src/lib/realtime-client.ts`). The connection remains open continuously across route navigations, React StrictMode mount/unmount cycles, and component re-renders, preventing premature socket disposal and eliminating repeated HTTP polling.
2. **Sealed Live Queries:** Query definitions remain strictly server-side. Next.js creates a deterministic, parameterized SQL query (`WHERE recipient_id = $1`) and encrypts it with `NEON_REALTIME_SECRET` into a short-lived bearer capability (60-second lifetime). The client subscribes with the capability without exposing raw SQL or credentials.
3. **Automated Capability Renewal:** The React runtime (`useLiveQuery` + `refreshQuery`) automatically requests a renewed sealed capability 10 seconds before expiration, ensuring seamless streaming without socket dropouts.
4. **Realtime UI & Diagnostics:**
   - **Fault-Tolerant Boundary:** `RealtimeErrorBoundary` catches and exposes subscription issues gracefully to the status pill without interrupting page execution.
   - **Status Badge:** Displays live socket connectivity (`live` 🟢, `connecting` 🟡, `error` 🔴).
   - **Debug Inspector:** An embedded diagnostics panel details WebSocket URL, query fingerprint, last received transaction timestamp, and provides a manual *Reconnect* trigger.
   - **Toast Notifications:** Incoming share events trigger top-right floating toasts (`top-16 right-3 sm:right-6`) with smooth animations, action buttons (*Open document* / *Dismiss*), and a 7-second auto-dismiss timeout.
   - **Cross-Component Synchronization:** Incoming WebSocket notifications dispatch synthetic events (`fe:document-shared`) that silently refresh the dashboard's **"Shared with me"** section in real time.

---

## 4. Object Storage Pipeline (Neon S3-Compatible Storage)

When importing `.docx` files containing embedded media, images are extracted in-memory, uploaded to cloud object storage, and replaced with public URLs in the document HTML:

```
[Uploaded .docx] 
       │
       ▼
 [Mammoth Parser] ──(Extract Images)──► [server/storage.py] ──► [Neon S3 Bucket]
       │                                                              │
       ▼                                                              ▼
 [HTML Content] ◄──────────────────────────────────────────── (Asset URLs)
       │
       ▼
[Sanitization & Save]
```

- **Resilient Uploads:** Object operations in `server/storage.py` employ exponential backoff retry policies (up to 3 attempts).
- **Graceful Fallback:** If object storage environment variables are absent, images fall back to Base64 data URIs so documents render reliably in offline and local development environments.
- **Direct Document Export:** The editor interface provides direct client-side generation and download for `.html` (with standalone CSS and image assets) and `.md` (Markdown).

---

## 5. Storage Garbage Collection (Cron Worker)

To prevent orphaned files from accumulating in cloud storage when documents are deleted or operations fail:

1. **Synchronous Deletion with Exponential Backoff:** When a document is deleted via `DELETE /api/documents/<id>`, the database record, share records, and notification history are purged first. The API then attempts to delete all objects under `docs/<id>/` in S3 with exponential backoff retries.
2. **Daily Garbage Collection Worker (`server/cron.py`):**
   - Configured in `vercel.json` to execute once daily via Vercel Cron (`0 3 * * *`).
   - Authenticated using `Authorization: Bearer <CRON_SECRET>`.
   - Scans all storage prefixes under `docs/` using S3 paginated listings (`list_objects_v2`).
   - Reconciles every encountered `doc_id` against active records in the PostgreSQL/SQLite `documents` table.
   - Automatically purges orphaned objects in batches of up to 1,000 keys (`delete_objects`).

---

## 6. Security, Sanitization & Concurrency

- **Strict HTML Sanitization (`nh3`):** All document updates and file imports pass through a server-side allow-list filter restricting HTML tags (`p`, `h1`-`h3`, `strong`, `em`, `u`, `s`, `ul`, `ol`, `li`, `blockquote`, `code`, `pre`, `a`, `img`) and prohibiting `javascript:` schemes or unsafe attributes.
- **Optimistic Concurrency Control:** Every document has a monotonic `version` integer. Clients provide `base_version` on write operations; if another collaborator saved concurrently, the server aborts the transaction with HTTP **`409 version_conflict`**, prompting the client to reload without overwriting work.
- **Document-Scoped Permissions:** Collaborators have explicit `viewer` (read-only) or `editor` (title and content modification) privileges. Only the `owner` can manage access or delete a document. Unauthorized access attempts return HTTP **`404 Not Found`** to prevent ID enumeration.

---

## 7. Environment Variables Reference

The application uses the following environment variables across local development and production deployments:

| Variable | Required In | Purpose |
| :--- | :--- | :--- |
| `DATABASE_URL` / `POSTGRES_URL` | Production (Vercel) | PostgreSQL connection string (pooled recommended). Automatically converted to use the `postgresql+psycopg://` driver in Python and direct connection in `@neondatabase/serverless`. |
| `SECRET_KEY` | Production (Vercel) | Cryptographic secret used to sign session cookies and internal capability tokens. |
| `SEED_DEMO_USERS` | Optional (`1` by default) | Toggle (`1` or `0`) to seed demo accounts (`alice@example.com`, `bob@example.com`, `carol@example.com`) on database initialization. |
| `NEON_REALTIME_URL` | Production (Realtime) | Neon Realtime WebSocket gateway URL (`https://<project-id>.rt.<region>.aws.neon.tech/`). |
| `NEXT_PUBLIC_NEON_REALTIME_URL` | Production (Frontend) | Publicly accessible WebSocket URL consumed by `@neon/realtime/client` in the browser. |
| `NEON_REALTIME_SECRET` | Production (Realtime) | Private server-side secret (`nrt_live_...`) used to encrypt and seal live SQL queries. |
| `NEON_REALTIME_DB` | Optional (`neondb` default) | Target PostgreSQL database name to bind real-time query capabilities against. |
| `AWS_ENDPOINT_URL_S3` | Production (Storage) | Custom S3 endpoint URL provided by Neon Object Storage / Cloudflare R2. |
| `AWS_ACCESS_KEY_ID` | Production (Storage) | S3 access key identifier for authenticating object storage requests. |
| `AWS_SECRET_ACCESS_KEY` | Production (Storage) | S3 secret access key for authenticating object storage requests. |
| `AWS_REGION` | Production (Storage) | Geographic or logical region for the S3 bucket (e.g., `us-east-1` or `auto`). |
| `AWS_S3_BUCKET_NAME` | Production (Storage) | Name of the target S3 bucket where document assets are stored (defaults to `files-editor`). |
| `CRON_SECRET` | Production (Vercel) | Shared secret token passed in the `Authorization: Bearer` header by Vercel Cron to secure `/api/cron/cleanup-storage`. |
