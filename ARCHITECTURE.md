# Architecture & Engineering Priorities

## 1. Hybrid Next.js + Flask Architecture on Vercel
To satisfy the requirement of a **Next.js full-stack build on Vercel backed by a Flask API**, the project uses Vercel's hybrid routing layout:
- **Single WSGI Entrypoint (`api/index.py`):** Vercel turns every file under `/api` into a distinct serverless function. By placing a thin entrypoint at `api/index.py` and housing the actual Flask application package under `server/`, all `/api/*` endpoints share a single Python serverless function and database engine configuration.
- **Unified Routing (`next.config.ts`):** During local development (`NODE_ENV === "development"`), Next.js proxies `/api/:path*` to the local Flask server on `http://127.0.0.1:5328/api/:path*`. In production on Vercel, `/api/:path*` rewrites to `/api/`, passing the original request path into Flask's URL router (`auth` and `documents` blueprints). Because frontend and API are served from the same origin, authentication uses `HttpOnly`, `SameSite=Lax` signed session cookies with zero CORS complexity.

## 2. Persistence Strategy (SQLite Locally, Postgres in Production)
- **Why SQLAlchemy Core:** Using SQLAlchemy Core (`server/db.py`) gives us a single schema definition (`users`, `documents`, `document_shares`) and query layer that runs identically on **SQLite** (`local.db` for zero-setup local evaluation and `pytest`) and **PostgreSQL** (`psycopg` v3 on Vercel).
- **Serverless Connection Handling:** Serverless functions spin up and tear down processes unpredictably. For PostgreSQL, `make_engine()` configures `NullPool` with `pool_pre_ping=True` so invocations do not leak idle connections, and `_normalise_db_url()` automatically rewrites `postgres://` / `postgresql://` URLs from Neon/Supabase/Vercel Postgres to `postgresql+psycopg://`.
- **Idempotent Startup Provisioning:** On boot, `init_db()` runs `metadata.create_all()` and seeds the three demo accounts (`alice`, `bob`, `carol`) while catching `IntegrityError` to stay safe under concurrent serverless cold starts.

## 3. Rich-Text Representation, Sanitization & Concurrency
- **Sanitized HTML as Canonical Format:** Both the TipTap editor and the file importers (`.txt`, `.md`, `.docx`) speak HTML. Every write path (`POST /api/documents`, `PATCH /api/documents/<id>`, `POST /api/documents/import`, `POST /api/convert`) passes through `server/sanitize.py` (`nh3`), stripping any tag or attribute outside the editor's allow-list and blocking `javascript:` URLs.
- **Optimistic Concurrency (`base_version`):** Rather than building full CRDT/WebSocket co-editing (out of scope) or allowing silent last-write-wins data loss, every document carries an integer `version`. `PATCH /api/documents/<id>` updates with `WHERE id = :id AND version = :base_version`; if another collaborator saved first, the API returns `409 version_conflict` and the UI prompts the user to reload the latest version.

## 4. File Upload Design
- **Two Product-Relevant Flows:** Users can either upload a `.txt`, `.md`, or `.docx` file on the dashboard to create a brand-new document (`POST /api/documents/import`), or click **Insert from file…** inside the editor toolbar to convert a file and insert its contents into an existing draft (`POST /api/convert`).
- **Defense in Depth:** File extension, empty-file, and 2 MB size checks run both client-side (for instant feedback) and server-side (`server/importers.py`), alongside UTF-8/UTF-16 BOM validation for text files and ZIP structure verification before passing `.docx` archives to `mammoth`.
