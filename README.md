# Files Editor

A full-stack collaborative rich-text document editor built with **Next.js (App Router + TipTap)** on the frontend and a **Flask (Python WSGI) serverless API** on the backend, structured for zero-config deployment on **Vercel**.

---

## Core Capabilities

1. **Document Creation & Rich-Text Editing**
   - Create, rename, edit, auto-save (900 ms debounce + `Ctrl/Cmd+S`), and reopen documents.
   - Rich-text formatting powered by TipTap (ProseMirror):
     - **Bold**, *Italic*, <u>Underline</u>, ~~Strikethrough~~
     - Headings (`H1`, `H2`, `H3`) and normal paragraph text
     - Bulleted lists, numbered lists, and blockquotes
     - Undo / Redo history
   - Optimistic concurrency control (`base_version`) prevents silent overwrites when multiple collaborators edit the same document.

2. **File Upload & Import (2 Workflows)**
   - **Supported file types:** `.txt`, `.md` / `.markdown`, and `.docx` (up to **4 MB**). Unsupported extensions, empty files, binary masquerades, and corrupted `.docx` archives are rejected with clear error messages.
   - **Workflow A — Turn a file into a new editable document:** Drag-and-drop a file onto the dashboard or click **Upload file** (`POST /api/documents/import`).
   - **Workflow B — Import content into an existing draft:** Inside the editor toolbar, click **Insert from file…** (`POST /api/convert`) to convert and insert formatted HTML directly at the cursor position.

3. **Sharing & Access Control**
   - Every document has an **Owner** and supports sharing with other users by email as either **Can edit (`editor`)** or **View only (`viewer`)**.
   - Clear visual distinction on the dashboard between **My documents** (with `Owner` and `Shared with N` / `Private` badges) and **Shared with me** (with `Can edit` / `View only` badges and owner attribution).
   - View-only users open documents in read-only mode with a top banner; unauthorized users receive `404` so document IDs cannot be enumerated.

4. **Persistence**
   - Uses **SQLAlchemy Core** across both **SQLite** (zero-config local development in `local.db`) and **PostgreSQL** (`DATABASE_URL` / `POSTGRES_URL` in production on Vercel).
   - All HTML stored in the database is sanitized server-side via [`nh3`](https://github.com/messense/nh3) against an explicit tag/attribute allow-list matching the editor's schema.

---

## Quick Start (Local Development)

### Prerequisites
- **Node.js** 20+ and `npm`
- **Python** 3.11+

### 1. Install Python dependencies
```bash
python -m venv .venv

# Windows (PowerShell / CMD)
.\.venv\Scripts\pip install -r requirements-dev.txt

# macOS / Linux
.venv/bin/pip install -r requirements-dev.txt
```

### 2. Install Node.js dependencies
```bash
npm install
```

### 3. Run the full-stack development server
Activate your virtual environment so `python` resolves to `.venv`, then start both Next.js (`:3000`) and Flask (`:5328`) together:

```bash
# Windows (PowerShell)
$env:PATH = "$PWD\.venv\Scripts;$env:PATH"
npm run dev

# macOS / Linux
PATH="$PWD/.venv/bin:$PATH" npm run dev
```

Open **http://localhost:3000**. Next.js automatically proxies `/api/*` requests to `http://127.0.0.1:5328/api/*`.

### Demo Accounts (Seeded Automatically)
On the sign-in screen you can sign in with a single click using any of the seeded accounts (or register a new account):
- `alice@example.com` (`password123`)
- `bob@example.com` (`password123`)
- `carol@example.com` (`password123`)

> **Tip:** Open two browser windows (or one normal window as Alice and one private/incognito window as Bob) to test document sharing and role permissions end-to-end.

---

## Running Automated Tests

The test suite (`tests/test_api.py`) runs 15 end-to-end integration tests against the Flask WSGI app and an isolated SQLite database, covering authentication, rich-text persistence, XSS sanitization, optimistic concurrency (`409 version_conflict`), role-based sharing (`owner` / `editor` / `viewer`), and `.txt` / `.md` / `.docx` file uploads and validation:

```bash
# Windows
.\.venv\Scripts\pytest

# macOS / Linux
.venv/bin/pytest
```

---

## Deploying to Vercel (Next.js + Flask Serverless)

This repository follows Vercel's official **Next.js + Flask** hybrid architecture:
- `api/index.py` exports the WSGI `app` (`app = create_app()`), which Vercel compiles into a Python Serverless Function utilizing `requirements.txt`.
- `next.config.ts` rewrites `/api/:path*` to `/api/` in production so all `/api/*` paths are routed cleanly into the Flask blueprint router.
- Application modules live in `/server` so Vercel only creates a single serverless entrypoint (`api/index.py`).

### Steps to Deploy
1. Push this repository to **GitHub** (or GitLab / Bitbucket).
2. Import the repository into **[Vercel](https://vercel.com/new)** (Framework Preset: **Next.js**).
3. Configure the following **Environment Variables** in your Vercel project settings:
   - `DATABASE_URL`: Your pooled PostgreSQL connection string (e.g., from **Neon**, **Supabase**, or **Vercel Postgres**). Both `postgres://` and `postgresql://` URLs are automatically normalized to `postgresql+psycopg://`.
   - `SECRET_KEY`: A random 32-byte hex secret so signed session cookies persist across serverless instances (`python -c "import secrets; print(secrets.token_hex(32))"`).
4. Click **Deploy**. Tables and demo accounts are initialized idempotently on first boot. You can verify the deployment health and active storage backend at `/api/health`.

---

## Architecture Note

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for a concise breakdown of architectural decisions, what was prioritized, and the trade-offs made for this scope.
