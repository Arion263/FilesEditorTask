# Technical Constraints & Architectural Boundaries

This document details the architectural boundaries and operational constraints associated with our target deployment platform (Vercel Serverless Functions), storage providers, and browser-based rich-text rendering.

---

## 1. File Upload Payload Ceiling (Direct Upload Limit: 4 MB)

### The Constraint
- **Vercel Serverless Request Body Limit:** Vercel enforces a strict **4.5 MB** limit on HTTP request bodies arriving at serverless functions across standard plans.
- If an HTTP client attempts to post a multipart form payload exceeding this limit directly to `/api/documents/import` or `/api/convert`, Vercel's edge proxy terminates the connection and immediately responds with HTTP **`413 FUNCTION_PAYLOAD_TOO_LARGE`**, preventing the Flask backend from executing or returning a structured JSON error.
- **Adopted Configuration:** To guarantee safe transport margins and accommodate multipart boundary overhead, the application sets a strict direct upload cap of **4 MB** (`server/config.py`, `src/lib/api.ts`).

### Product Impact
- Very large `.docx` files containing high-resolution embedded images or massive formatting structures exceeding 4 MB will be rejected by pre-flight validation on both client and server before reaching the proxy limit.

---

## 2. Serverless Ephemeral Filesystem & Persistence

### The Constraint
- In serverless runtime instances, the root filesystem is **read-only**, with the exception of the `/tmp` scratch directory.
- The `/tmp` directory is ephemeral: it is recycled across cold boots, isolated across parallel container instances, and discarded upon each new code deployment.
- A local SQLite database in `/tmp` cannot provide durable multi-user persistence in serverless production environments. Durable storage requires an external hosted database (PostgreSQL via Neon / Supabase).

---

## 3. In-Browser DOM Rendering Limits (TipTap / ProseMirror)

### The Constraint
- The application transforms document bodies into sanitized HTML for live editing inside TipTap.
- A 4 MB raw text or Markdown file corresponds to approximately **700,000 to 800,000 words** (over 1,500 pages of continuous text).
- Rendering and calculating layout for massive DOM node trees in real time within the browser engine will cause significant frame rate drops and interface unresponsiveness.

---

## 4. Scalability Solutions & Future Roadmap

To scale beyond these initial boundaries in subsequent releases, the following architectural paths are established:

1. **Direct-to-Bucket Pre-Signed Uploads:**
   - The web client requests a short-lived pre-signed upload URL from `/api/storage/presign`.
   - The client uploads the raw binary file directly to an object storage bucket (Neon S3, Cloudflare R2, or AWS S3), completely bypassing Vercel's 4.5 MB serverless proxy.
   - An asynchronous backend worker or serverless handler then processes and streams the file from storage.

2. **Dedicated Containerized Infrastructure:**
   - Deploying the Python WSGI/ASGI service on a dedicated container platform (e.g., Railway, Render, Fly.io, or Google Cloud Run) where reverse-proxy request limits (Nginx, Gunicorn, Uvicorn) can be customized to 20 MB, 50 MB, or higher.

> **Note:** These solutions are not strictly necessary for the current product scope, as the 4 MB direct threshold reliably accommodates standard document editing workflows (`.txt`, `.md`, `.docx`).
