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
    cloudinary_url: str = field(
        default_factory=lambda: os.environ.get("CLOUDINARY_URL", "")
    )
    cron_secret: str = field(
        default_factory=lambda: os.environ.get("CRON_SECRET", "")
    )
    testing: bool = False

    @property
    def storage_kind(self) -> str:
        if self.database_url.startswith("postgresql"):
            return "postgres"
        if os.environ.get("VERCEL"):
            return "ephemeral-sqlite"
        return "sqlite"
