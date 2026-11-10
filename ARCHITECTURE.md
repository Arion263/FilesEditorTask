# System Architecture & Technical Specifications

This document outlines the architectural decisions, storage pipelines, data models, and operational patterns implemented across the **Files Editor** full-stack application.

---

## 1. Hybrid Serverless Architecture (Next.js + Flask WSGI on Vercel)

The system pairs a modern React frontend with a lightweight, robust Python backend running within a single Vercel deployment:

```
┌────────────────────────────────────────────────────────┐
│                     Vercel Edge                        │
│                                                        │
│   ┌─────────────────────┐    ┌─────────────────────┐   │
│   │ Next.js App Router  │    │ api/index.py (WSGI) │   │
│   │ (Frontend & Pages)  │    │ (Flask API Core)    │   │
│   └──────────┬──────────┘    └──────────▲──────────┘   │
│              │                          │              │
│              └──── /api/* (Rewrites) ───┘              │
└────────────────────────────────────────────────────────┘
```

- **Unified Origin Routing:** Next.js proxies `/api/:path*` to `127.0.0.1:5328` in local development via `next.config.ts`, and rewrites to the single serverless function entrypoint (`api/index.py`) in production.
- **Session Authentication:** Auth state is managed via secure, `HttpOnly`, `SameSite=Lax` signed cookies (`fe_session`), eliminating cross-origin CORS overhead.
- **Modular Packaging:** Core Python application modules reside in `/server` to prevent Vercel from compiling redundant serverless functions.

---

## 2. Persistence Layer (SQLite & PostgreSQL via SQLAlchemy Core)

Database access uses **SQLAlchemy Core** without a heavy ORM to ensure predictable queries, portability across database engines, and fast cold-start performance in serverless environments:

- **Local Development & Testing:** Runs against local SQLite (`local.db` or temporary file databases during `pytest`) with zero external infrastructure required. Foreign key enforcement is enabled via connection listener hooks (`PRAGMA foreign_keys=ON`).
- **Production (Serverless PostgreSQL):** Connects to hosted PostgreSQL (e.g., **Neon** or **Supabase**) via `psycopg` (v3). Connection pooling uses `NullPool` with `pool_pre_ping=True` to prevent idle connection exhaustion during concurrent serverless container lifecycles.
- **Idempotent Bootstrapping:** Schema creation (`metadata.create_all()`) and demo account seeding (`_seed_demo_users()`) run idempotently on startup with concurrency guard exceptions (`IntegrityError`).

### Data Entities:
1. **`users`:** Account credentials (hashed with Werkzeug PBKDF2), display name, and email.
2. **`folders`:** User-owned organizational containers (`id`, `owner_id`, `name`, `created_at`).
3. **`documents`:** Core document content (`id`, `owner_id`, `folder_id`, `title`, `content`, `version`, timestamps).
4. **`document_shares`:** Access control mapping (`document_id`, `user_id`, `role: 'viewer' | 'editor'`).

---

## 3. Object Storage Pipeline (Neon S3-Compatible Storage)

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

## 4. Idempotency & Storage Garbage Collection (Cron Worker)

To prevent orphaned files from accumulating in cloud storage when documents are deleted or operations fail:

1. **Synchronous Deletion with Exponential Backoff:** When a document is deleted via `DELETE /api/documents/<id>`, the database record and share permissions are removed first. The API then attempts to delete all objects under `docs/<id>/` in S3 with exponential backoff retries.
2. **Daily Garbage Collection Worker (`server/cron.py`):**
   - Configured in `vercel.json` to execute once daily via Vercel Cron (`0 3 * * *`).
   - Authenticated using `Authorization: Bearer <CRON_SECRET>`.
   - Scans all storage prefixes under `docs/` using S3 paginated listings (`list_objects_v2`).
   - Reconciles every encountered `doc_id` against active records in the PostgreSQL/SQLite `documents` table.
   - Automatically purges orphaned objects in batches of up to 1,000 keys (`delete_objects`).

---

## 5. Security, Sanitization & Concurrency

- **Strict HTML Sanitization (`nh3`):** All document updates and file imports pass through a server-side allow-list filter restricting HTML tags (`p`, `h1`-`h3`, `strong`, `em`, `u`, `s`, `ul`, `ol`, `li`, `blockquote`, `code`, `pre`, `a`, `img`) and prohibiting `javascript:` schemes or unsafe attributes.
- **Optimistic Concurrency Control:** Every document has a monotonic `version` integer. Clients provide `base_version` on write operations; if another collaborator saved concurrently, the server aborts the transaction with HTTP **`409 version_conflict`**, prompting the client to reload without overwriting work.
- **Scoped User Access:** Collaborators have explicit `viewer` (read-only) or `editor` (title and content modification) privileges. Only the `owner` can manage access or delete a document. Unauthorized access attempts return HTTP **`404 Not Found`** to prevent ID enumeration.

---

## 6. Environment Variables Reference

The application uses the following environment variables across local and production deployments:

| Variable | Required In | Purpose |
| :--- | :--- | :--- |
| `DATABASE_URL` / `POSTGRES_URL` | Production (Vercel) | Database connection string. Automatically converted to use the `postgresql+psycopg://` driver. Defaults to SQLite locally if omitted. |
| `SECRET_KEY` | Production (Vercel) | Cryptographic secret used to sign session cookies. |
| `SEED_DEMO_USERS` | Optional (`1` by default) | Toggle (`1` or `0`) to seed demo accounts (`alice@example.com`, etc.) on database initialization. |
| `AWS_ENDPOINT_URL_S3` | Production (Storage) | Custom S3 endpoint URL provided by Neon Object Storage / Cloudflare R2. |
| `AWS_ACCESS_KEY_ID` | Production (Storage) | S3 access key identifier for authenticating object storage requests. |
| `AWS_SECRET_ACCESS_KEY` | Production (Storage) | S3 secret access key for authenticating object storage requests. |
| `AWS_REGION` | Production (Storage) | Geographic or logical region for the S3 bucket (e.g., `us-east-1` or `auto`). |
| `AWS_S3_BUCKET_NAME` | Production (Storage) | Name of the target S3 bucket where document assets are stored (defaults to `files-editor`). |
| `CRON_SECRET` | Production (Vercel) | Shared secret token passed in the `Authorization: Bearer` header by Vercel Cron to secure the `/api/cron/cleanup-storage` endpoint. |
