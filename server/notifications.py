"""Notifications endpoints for document sharing events (with Neon Realtime integration)."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import hmac
import time
from typing import Any

from flask import Blueprint, current_app, g, jsonify
from sqlalchemy import and_, delete, func, select, text, update
from sqlalchemy.engine import Connection

from .db import notifications
from .errors import not_found
from .http import get_engine, login_required

bp = Blueprint("notifications", __name__, url_prefix="/api/notifications")


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def serialize_notification(row) -> dict[str, Any]:
    return {
        "id": row.id,
        "recipient_id": row.recipient_id,
        "actor_id": row.actor_id,
        "actor_name": row.actor_name,
        "actor_email": row.actor_email,
        "document_id": row.document_id,
        "document_title": row.document_title,
        "role": row.role,
        "is_read": bool(row.is_read),
        "created_at": _iso(row.created_at),
    }


def sign_realtime_token(user_id: str, secret_key: str, ttl_seconds: int = 3600) -> str:
    """Create a short-lived HMAC-SHA256 token so the Next.js Realtime sealer can verify the user."""
    exp = int(time.time()) + ttl_seconds
    payload = f"{user_id}.{exp}"
    sig = hmac.new(secret_key.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def current_txid(conn: Connection) -> str | None:
    """Return pg_current_xact_id()::text on PostgreSQL for Neon Realtime awaitTxId()."""
    if conn.dialect.name == "postgresql":
        row = conn.execute(text("SELECT pg_current_xact_id()::text")).first()
        if row:
            return str(row[0])
    return None


@bp.get("")
@login_required
def list_notifications():
    user_id = g.user.id
    with get_engine().connect() as conn:
        rows = conn.execute(
            select(notifications)
            .where(notifications.c.recipient_id == user_id)
            .order_by(notifications.c.created_at.desc())
            .limit(30)
        ).all()
        unread_count = conn.execute(
            select(func.count())
            .select_from(notifications)
            .where(
                and_(
                    notifications.c.recipient_id == user_id,
                    notifications.c.is_read == False,  # noqa: E712
                )
            )
        ).scalar() or 0

    fe_config = current_app.extensions["fe_config"]
    realtime_enabled = bool(
        fe_config.neon_realtime_url
        and fe_config.neon_realtime_secret
        and fe_config.storage_kind == "postgres"
    )
    realtime_token = sign_realtime_token(user_id, str(current_app.config["SECRET_KEY"]))

    return jsonify(
        notifications=[serialize_notification(r) for r in rows],
        unread_count=int(unread_count),
        realtime={
            "enabled": realtime_enabled,
            "url": fe_config.neon_realtime_url if realtime_enabled else None,
            "token": realtime_token,
        },
    )


@bp.post("/<notif_id>/read")
@login_required
def mark_notification_read(notif_id: str):
    with get_engine().begin() as conn:
        result = conn.execute(
            update(notifications)
            .where(
                and_(
                    notifications.c.id == notif_id,
                    notifications.c.recipient_id == g.user.id,
                )
            )
            .values(is_read=True)
        )
        if result.rowcount == 0:
            raise not_found("Notification not found.")
        txid = current_txid(conn)
    return jsonify(ok=True, txid=txid)


@bp.post("/read-all")
@login_required
def mark_all_notifications_read():
    with get_engine().begin() as conn:
        result = conn.execute(
            update(notifications)
            .where(
                and_(
                    notifications.c.recipient_id == g.user.id,
                    notifications.c.is_read == False,  # noqa: E712
                )
            )
            .values(is_read=True)
        )
        txid = current_txid(conn) if result.rowcount > 0 else None
    return jsonify(ok=True, updated=result.rowcount, txid=txid)


@bp.delete("/<notif_id>")
@login_required
def delete_notification(notif_id: str):
    with get_engine().begin() as conn:
        result = conn.execute(
            delete(notifications).where(
                and_(
                    notifications.c.id == notif_id,
                    notifications.c.recipient_id == g.user.id,
                )
            )
        )
        if result.rowcount == 0:
            raise not_found("Notification not found.")
    return "", 204
