"""Documents, sharing and file-import endpoints.

Access model (deliberately simple):
    owner  - full control: edit, rename, delete, manage sharing
    editor - edit content and rename
    viewer - read only
Documents a user cannot access respond 404 (not 403) so IDs can't be probed.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from flask import Blueprint, g, jsonify, request
from sqlalchemy import and_, delete, insert, select, update
from sqlalchemy.engine import Connection
from sqlalchemy.exc import IntegrityError

from .config import MAX_CONTENT_CHARS, MAX_TITLE_CHARS
from .db import document_shares, documents, folders, new_id, users, utcnow
from .errors import ApiError, bad_request, forbidden, not_found
from .http import get_engine, json_body, login_required, optional_str, public_user
from .importers import convert_upload
from .sanitize import sanitize_html
from .storage import delete_document_assets

bp = Blueprint("documents", __name__, url_prefix="/api")

ROLES = ("viewer", "editor")
DEFAULT_TITLE = "Untitled document"


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:  # SQLite hands back naive datetimes; we store UTC.
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def clean_title(raw: Any, *, allow_default: bool) -> str:
    if raw is None and allow_default:
        return DEFAULT_TITLE
    if not isinstance(raw, str):
        raise bad_request("Title must be a string.", code="invalid_title")
    title = " ".join(raw.split())  # collapse whitespace/newlines
    if not title:
        if allow_default:
            return DEFAULT_TITLE
        raise bad_request("Title can't be empty.", code="invalid_title")
    if len(title) > MAX_TITLE_CHARS:
        raise bad_request(
            f"Title must be at most {MAX_TITLE_CHARS} characters.", code="invalid_title"
        )
    return title


def clean_content(raw: Any) -> str:
    if not isinstance(raw, str):
        raise bad_request("Content must be an HTML string.", code="invalid_content")
    if len(raw) > MAX_CONTENT_CHARS:
        raise bad_request("This document is too large to save.", code="content_too_large")
    return sanitize_html(raw)


def load_with_role(conn: Connection, doc_id: str, user_id: str):
    """Return (document_row, role) for the current user, or raise 404."""
    row = conn.execute(
        select(documents, document_shares.c.role.label("share_role"))
        .select_from(
            documents.outerjoin(
                document_shares,
                and_(
                    document_shares.c.document_id == documents.c.id,
                    document_shares.c.user_id == user_id,
                ),
            )
        )
        .where(documents.c.id == doc_id)
    ).first()
    if row is None:
        raise not_found()
    if row.owner_id == user_id:
        return row, "owner"
    if row.share_role in ROLES:
        return row, row.share_role
    raise not_found()


def list_shares(conn: Connection, doc_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        select(users.c.id, users.c.email, users.c.name, document_shares.c.role,
               document_shares.c.created_at)
        .join(users, users.c.id == document_shares.c.user_id)
        .where(document_shares.c.document_id == doc_id)
        .order_by(users.c.name)
    ).all()
    return [
        {"user": public_user(r), "role": r.role, "created_at": iso(r.created_at)}
        for r in rows
    ]


def serialize_document(conn: Connection, row, role: str) -> dict[str, Any]:
    owner = conn.execute(select(users).where(users.c.id == row.owner_id)).first()
    folder_name = None
    if getattr(row, "folder_id", None):
        f = conn.execute(select(folders.c.name).where(folders.c.id == row.folder_id)).first()
        if f:
            folder_name = f[0]
    payload = {
        "id": row.id,
        "title": row.title,
        "content": row.content,
        "version": row.version,
        "folder_id": getattr(row, "folder_id", None),
        "folder_name": folder_name,
        "created_at": iso(row.created_at),
        "updated_at": iso(row.updated_at),
        "role": role,
        "owner": public_user(owner),
    }
    if role == "owner":
        payload["shares"] = list_shares(conn, row.id)
    return payload


def create_document(
    title: str,
    content: str,
    doc_id: str | None = None,
    folder_id: str | None = None,
) -> dict[str, Any]:
    now = utcnow()
    doc_id = doc_id or new_id()
    with get_engine().begin() as conn:
        conn.execute(
            insert(documents).values(
                id=doc_id,
                owner_id=g.user.id,
                folder_id=folder_id,
                title=title,
                content=content,
                version=1,
                created_at=now,
                updated_at=now,
            )
        )
        row, role = load_with_role(conn, doc_id, g.user.id)
        return serialize_document(conn, row, role)


def uploaded_file():
    file = request.files.get("file")
    if file is None:
        raise bad_request("Attach a file in the 'file' form field.", code="missing_file")
    return file.filename, file.read()


# --------------------------------------------------------------------------- #
# documents
# --------------------------------------------------------------------------- #
@bp.get("/documents")
@login_required
def list_documents():
    me = g.user.id
    with get_engine().connect() as conn:
        user_folders = conn.execute(
            select(folders.c.id, folders.c.name, folders.c.created_at)
            .where(folders.c.owner_id == me)
            .order_by(folders.c.name)
        ).all()
        owned = conn.execute(
            select(
                documents.c.id,
                documents.c.title,
                documents.c.folder_id,
                documents.c.updated_at,
                folders.c.name.label("folder_name"),
            )
            .outerjoin(folders, folders.c.id == documents.c.folder_id)
            .where(documents.c.owner_id == me)
            .order_by(documents.c.updated_at.desc())
        ).all()
        shared = conn.execute(
            select(
                documents.c.id,
                documents.c.title,
                documents.c.folder_id,
                documents.c.updated_at,
                document_shares.c.role,
                users.c.id.label("owner_id"),
                users.c.name.label("owner_name"),
                users.c.email.label("owner_email"),
                folders.c.name.label("folder_name"),
            )
            .join(document_shares, document_shares.c.document_id == documents.c.id)
            .join(users, users.c.id == documents.c.owner_id)
            .outerjoin(folders, folders.c.id == documents.c.folder_id)
            .where(document_shares.c.user_id == me)
            .order_by(documents.c.updated_at.desc())
        ).all()
        share_counts: dict[str, int] = {}
        if owned:
            for (doc_id,) in conn.execute(
                select(document_shares.c.document_id).where(
                    document_shares.c.document_id.in_([d.id for d in owned])
                )
            ):
                share_counts[doc_id] = share_counts.get(doc_id, 0) + 1

    return jsonify(
        folders=[{"id": f.id, "name": f.name} for f in user_folders],
        owned=[
            {
                "id": d.id,
                "title": d.title,
                "folder_id": d.folder_id,
                "folder_name": d.folder_name,
                "updated_at": iso(d.updated_at),
                "role": "owner",
                "share_count": share_counts.get(d.id, 0),
            }
            for d in owned
        ],
        shared=[
            {
                "id": d.id,
                "title": d.title,
                "folder_id": d.folder_id,
                "folder_name": d.folder_name,
                "updated_at": iso(d.updated_at),
                "role": d.role,
                "owner": {"id": d.owner_id, "name": d.owner_name, "email": d.owner_email},
            }
            for d in shared
        ],
    )


@bp.post("/documents")
@login_required
def create():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        raise bad_request("Expected a JSON object in the request body.")
    title = clean_title(data.get("title"), allow_default=True)
    content = clean_content(data.get("content", ""))
    folder_id = data.get("folder_id")
    return jsonify(document=create_document(title, content, folder_id=folder_id)), 201


@bp.get("/documents/<doc_id>")
@login_required
def get_document(doc_id: str):
    with get_engine().connect() as conn:
        row, role = load_with_role(conn, doc_id, g.user.id)
        return jsonify(document=serialize_document(conn, row, role))


@bp.patch("/documents/<doc_id>")
@login_required
def update_document(doc_id: str):
    """Rename and/or save content.

    Requires `base_version` (the version the client last loaded/saved). If
    someone else saved in between, we return 409 instead of silently
    overwriting their work (optimistic concurrency).
    """
    data = json_body()
    base_version = data.get("base_version")
    if not isinstance(base_version, int) or isinstance(base_version, bool):
        raise bad_request("'base_version' (integer) is required.", code="missing_version")

    changes: dict[str, Any] = {}
    if "title" in data:
        changes["title"] = clean_title(data["title"], allow_default=False)
    if "content" in data:
        changes["content"] = clean_content(data["content"])
    if "folder_id" in data:
        changes["folder_id"] = data["folder_id"] or None
    if not changes:
        raise bad_request("Nothing to update: send 'title', 'content', or 'folder_id'.")

    with get_engine().begin() as conn:
        row, role = load_with_role(conn, doc_id, g.user.id)
        if role == "viewer":
            raise forbidden("You have view-only access to this document.")
        result = conn.execute(
            update(documents)
            .where(documents.c.id == doc_id, documents.c.version == base_version)
            .values(**changes, version=documents.c.version + 1, updated_at=utcnow())
        )
        if result.rowcount == 0:
            raise ApiError(
                409,
                "version_conflict",
                "This document was changed by someone else. Reload to get the latest version.",
            )
        row, role = load_with_role(conn, doc_id, g.user.id)
        return jsonify(document=serialize_document(conn, row, role))


@bp.delete("/documents/<doc_id>")
@login_required
def delete_document(doc_id: str):
    with get_engine().begin() as conn:
        _row, role = load_with_role(conn, doc_id, g.user.id)
        if role != "owner":
            raise forbidden("Only the owner can delete this document.")
        # Explicit share cleanup keeps behaviour identical on SQLite and Postgres.
        conn.execute(delete(document_shares).where(document_shares.c.document_id == doc_id))
        conn.execute(delete(documents).where(documents.c.id == doc_id))

    # Delete external storage assets asynchronously/idempotently with retries
    delete_document_assets(doc_id)
    return "", 204


# --------------------------------------------------------------------------- #
# folders
# --------------------------------------------------------------------------- #
@bp.get("/folders")
@login_required
def list_folders():
    with get_engine().connect() as conn:
        rows = conn.execute(
            select(folders.c.id, folders.c.name, folders.c.created_at)
            .where(folders.c.owner_id == g.user.id)
            .order_by(folders.c.name)
        ).all()
        return jsonify(
            folders=[{"id": r.id, "name": r.name, "created_at": iso(r.created_at)} for r in rows]
        )


@bp.post("/folders")
@login_required
def create_folder():
    data = json_body()
    name = (data.get("name") or "").strip()
    if not name or len(name) > 100:
        raise bad_request("Folder name must be between 1 and 100 characters.")
    folder_id = new_id()
    now = utcnow()
    with get_engine().begin() as conn:
        conn.execute(
            insert(folders).values(
                id=folder_id,
                owner_id=g.user.id,
                name=name,
                created_at=now,
            )
        )
    return jsonify(folder={"id": folder_id, "name": name, "created_at": iso(now)}), 201


@bp.delete("/folders/<folder_id>")
@login_required
def delete_folder(folder_id: str):
    with get_engine().begin() as conn:
        f = conn.execute(
            select(folders).where(folders.c.id == folder_id, folders.c.owner_id == g.user.id)
        ).first()
        if not f:
            raise not_found("Folder not found.")
        # Nullify folder_id on documents in this folder (documents are not deleted)
        conn.execute(
            update(documents).where(documents.c.folder_id == folder_id).values(folder_id=None)
        )
        conn.execute(delete(folders).where(folders.c.id == folder_id))
    return "", 204


# --------------------------------------------------------------------------- #
# sharing
# --------------------------------------------------------------------------- #
@bp.get("/documents/<doc_id>/shares")
@login_required
def get_shares(doc_id: str):
    with get_engine().connect() as conn:
        _row, role = load_with_role(conn, doc_id, g.user.id)
        if role != "owner":
            raise forbidden("Only the owner can see who has access.")
        return jsonify(shares=list_shares(conn, doc_id))


@bp.post("/documents/<doc_id>/shares")
@login_required
def share_document(doc_id: str):
    """Grant (or change) access for another user, identified by email."""
    data = json_body()
    email = (optional_str(data, "email") or "").strip().lower()
    role = data.get("role", "viewer")
    if not email:
        raise bad_request("Enter the email of the person to share with.", code="invalid_email")
    if role not in ROLES:
        raise bad_request("Role must be 'viewer' or 'editor'.", code="invalid_role")

    with get_engine().begin() as conn:
        doc, my_role = load_with_role(conn, doc_id, g.user.id)
        if my_role != "owner":
            raise forbidden("Only the owner can share this document.")
        target = conn.execute(select(users).where(users.c.email == email)).first()
        if target is None:
            raise ApiError(
                404,
                "user_not_found",
                f"No account found for {email}. They need to sign up first.",
            )
        if target.id == doc.owner_id:
            raise bad_request("You already own this document.", code="share_with_self")

        existing = conn.execute(
            select(document_shares.c.role).where(
                document_shares.c.document_id == doc_id,
                document_shares.c.user_id == target.id,
            )
        ).first()
        try:
            if existing:
                conn.execute(
                    update(document_shares)
                    .where(
                        document_shares.c.document_id == doc_id,
                        document_shares.c.user_id == target.id,
                    )
                    .values(role=role)
                )
            else:
                conn.execute(
                    insert(document_shares).values(
                        document_id=doc_id, user_id=target.id, role=role, created_at=utcnow()
                    )
                )
        except IntegrityError:
            raise ApiError(409, "share_conflict", "Access was just changed. Please retry.")
        shares = list_shares(conn, doc_id)
    return jsonify(shares=shares), (200 if existing else 201)


@bp.delete("/documents/<doc_id>/shares/<user_id>")
@login_required
def revoke_share(doc_id: str, user_id: str):
    """Owner revokes someone's access, or a collaborator removes themselves."""
    with get_engine().begin() as conn:
        _row, my_role = load_with_role(conn, doc_id, g.user.id)
        if my_role != "owner" and user_id != g.user.id:
            raise forbidden("Only the owner can change who has access.")
        result = conn.execute(
            delete(document_shares).where(
                document_shares.c.document_id == doc_id,
                document_shares.c.user_id == user_id,
            )
        )
        if result.rowcount == 0:
            raise ApiError(404, "share_not_found", "That person doesn't have access.")
        shares = list_shares(conn, doc_id) if my_role == "owner" else []
    return jsonify(shares=shares)


# --------------------------------------------------------------------------- #
# file import
# --------------------------------------------------------------------------- #
@bp.post("/documents/import")
@login_required
def import_document():
    """Upload a .txt/.md/.docx file and turn it into a new editable document."""
    filename, raw = uploaded_file()
    doc_id = new_id()
    converted = convert_upload(filename, raw, doc_id=doc_id)
    return jsonify(document=create_document(converted.title, converted.html, doc_id=doc_id)), 201


@bp.post("/convert")
@login_required
def convert_file():
    """Convert a file to sanitised HTML so the editor can insert it into a draft."""
    filename, raw = uploaded_file()
    doc_id = request.args.get("doc_id")
    converted = convert_upload(filename, raw, doc_id=doc_id)
    return jsonify(title=converted.title, html=converted.html)
