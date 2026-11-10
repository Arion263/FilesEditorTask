"""Runtime configuration, resolved from environment variables.

Local development defaults to a SQLite file so the app runs with zero setup.
Production (Vercel) must provide DATABASE_URL pointing at hosted Postgres,
because serverless functions have no durable filesystem.
"""

from __future__ import annotations

import os
import secrets
import tempfile
from dataclasses import dataclass, field


def _load_local_dotenv() -> None:
    """Load .env / .env.local in local development without overriding existing env vars."""
    if os.environ.get("PYTEST_CURRENT_TEST") or os.environ.get("VERCEL"):
        return
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for filename in (".env.local", ".env"):
        path = os.path.join(root, filename)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                for raw_line in f:
                    line = raw_line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, val = line.split("=", 1)
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    if key and key not in os.environ:
                        os.environ[key] = val
        except OSError:
            pass


_load_local_dotenv()

# Upload limits: 4 MB (Vercel serverless request body hard ceiling is 4.5 MB).
MAX_UPLOAD_BYTES = 4 * 1024 * 1024  # 4 MB
# Vercel caps request bodies at 4.5 MB; keep JSON saves well below it.
MAX_CONTENT_CHARS = 2_000_000
MAX_TITLE_CHARS = 200
SUPPORTED_UPLOAD_EXTENSIONS = (".txt", ".md", ".markdown", ".docx")


def _normalise_db_url(url: str) -> str:
    """Force the psycopg (v3) driver for Postgres URLs from Neon/Supabase/etc."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


def _default_db_url() -> str:
    if os.environ.get("VERCEL"):
        # Read-only filesystem except /tmp. Data here is EPHEMERAL - only a
        # safety net so the deployment boots; /api/health reports it.
        return "sqlite:///" + os.path.join(tempfile.gettempdir(), "files_editor.db")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return "sqlite:///" + os.path.join(root, "local.db")


@dataclass
class Config:
    database_url: str = field(
        default_factory=lambda: _normalise_db_url(
            os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL") or _default_db_url()
        )
    )
    secret_key: str = field(
        default_factory=lambda: os.environ.get("SECRET_KEY") or secrets.token_hex(32)
    )
    secure_cookies: bool = field(default_factory=lambda: bool(os.environ.get("VERCEL")))
    seed_demo_users: bool = field(
        default_factory=lambda: os.environ.get("SEED_DEMO_USERS", "1") != "0"
    )
    s3_endpoint_url: str = field(
        default_factory=lambda: os.environ.get("AWS_ENDPOINT_URL_S3", "")
    )
    s3_access_key_id: str = field(
        default_factory=lambda: os.environ.get("AWS_ACCESS_KEY_ID", "")
    )
    s3_secret_access_key: str = field(
        default_factory=lambda: os.environ.get("AWS_SECRET_ACCESS_KEY", "")
    )
    s3_region: str = field(
        default_factory=lambda: os.environ.get("AWS_REGION", "auto")
    )
    s3_bucket_name: str = field(
        default_factory=lambda: os.environ.get("AWS_S3_BUCKET_NAME", "files-editor")
    )
    cron_secret: str = field(
        default_factory=lambda: os.environ.get("CRON_SECRET", "")
    )
    neon_realtime_url: str = field(
        default_factory=lambda: (
            os.environ.get("NEON_REALTIME_URL")
            or os.environ.get("NEXT_PUBLIC_NEON_REALTIME_URL")
            or ""
        )
    )
    neon_realtime_secret: str = field(
        default_factory=lambda: os.environ.get("NEON_REALTIME_SECRET", "")
    )
    testing: bool = False

    @property
    def storage_kind(self) -> str:
        if self.database_url.startswith("postgresql"):
            return "postgres"
        if os.environ.get("VERCEL"):
            return "ephemeral-sqlite"
        return "sqlite"
