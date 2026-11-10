"""Database schema and engine setup (SQLAlchemy Core).

The same schema runs on SQLite (local/tests) and Postgres (production).
Tables are created idempotently on startup; for a project of this size that
is simpler and safer than a migration tool, see ARCHITECTURE.md.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    create_engine,
    event,
    insert,
    select,
    update,
)
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import NullPool
from werkzeug.security import generate_password_hash

metadata = MetaData()


def new_id() -> str:
    return uuid.uuid4().hex


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


users = Table(
    "users",
    metadata,
    Column("id", String(32), primary_key=True, default=new_id),
    Column("email", String(254), nullable=False),
    Column("name", String(100), nullable=False),
    Column("password_hash", String(255), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, default=utcnow),
    UniqueConstraint("email", name="uq_users_email"),
)

documents = Table(
    "documents",
    metadata,
    Column("id", String(32), primary_key=True, default=new_id),
    Column(
        "owner_id",
        String(32),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("title", String(200), nullable=False),
    # Sanitised HTML produced by the TipTap editor (or the import converters).
    Column("content", Text, nullable=False, default=""),
    # Incremented on every content/title change; used for optimistic locking.
    Column("version", Integer, nullable=False, default=1),
    Column("created_at", DateTime(timezone=True), nullable=False, default=utcnow),
    Column("updated_at", DateTime(timezone=True), nullable=False, default=utcnow),
    Index("ix_documents_owner_id", "owner_id"),
)

document_shares = Table(
    "document_shares",
    metadata,
    Column(
        "document_id",
        String(32),
        ForeignKey("documents.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "user_id",
        String(32),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("role", String(10), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, default=utcnow),
    CheckConstraint("role IN ('viewer', 'editor')", name="ck_document_shares_role"),
    # PK covers (document_id, ...) lookups; this covers "shared with me".
    Index("ix_document_shares_user_id", "user_id"),
)

DEMO_PASSWORD = "password123"
DEMO_USERS = (
    ("alice@example.com", "Alice"),
    ("bob@example.com", "Bob"),
    ("carol@example.com", "Carol"),
)


def make_engine(url: str) -> Engine:
    if url.startswith("sqlite"):
        engine = create_engine(url, connect_args={"check_same_thread": False})

        @event.listens_for(engine, "connect")
        def _enable_sqlite_fks(dbapi_conn, _record):  # pragma: no cover - trivial
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()

        return engine
    # Serverless: each invocation may be a fresh process, so don't hold a pool.
    # Point DATABASE_URL at a pooler (Neon/Supabase pooled URL) instead.
    return create_engine(url, poolclass=NullPool, pool_pre_ping=True)


def init_db(engine: Engine, seed_demo_users: bool) -> None:
    metadata.create_all(engine)
    if not seed_demo_users:
        return
    try:
        _seed_demo_users(engine)
    except IntegrityError:
        # Two cold starts seeded concurrently; the other one won. Harmless.
        pass


def _seed_demo_users(engine: Engine) -> None:
    with engine.begin() as conn:
        existing = set(conn.execute(select(users.c.email)).scalars())
        missing = [(email, name) for email, name in DEMO_USERS if email not in existing]
        if missing:
            pw_hash = generate_password_hash(DEMO_PASSWORD)
            conn.execute(
                insert(users),
                [
                    {
                        "id": new_id(),
                        "email": email,
                        "name": name,
                        "password_hash": pw_hash,
                        "created_at": utcnow(),
                    }
                    for email, name in missing
                ],
            )
        for email, name in DEMO_USERS:
            if email in existing:
                conn.execute(update(users).where(users.c.email == email).values(name=name))
