"""Cron job tasks: daily garbage collection for Cloudinary orphaned assets."""

from __future__ import annotations

import logging
import os

from flask import Blueprint, current_app, jsonify, request
from sqlalchemy import select

from .db import documents
from .errors import forbidden
from .http import get_engine
from .storage import configure_cloudinary, is_cloudinary_configured

logger = logging.getLogger(__name__)

bp = Blueprint("cron", __name__, url_prefix="/api/cron")


@bp.route("/cleanup-storage", methods=["GET", "POST"])
def cleanup_storage():
    """Daily garbage collection.
    Finds folders or tags in Cloudinary under `files_editor/docs/<doc_id>`
    and deletes any whose document_id does not exist in the database.
    """
    cron_secret = current_app.extensions["fe_config"].cron_secret
    # In Vercel, cron jobs pass the secret in Authorization: Bearer <CRON_SECRET>
    auth_header = request.headers.get("Authorization", "")
    expected = f"Bearer {cron_secret}" if cron_secret else None

    if expected and auth_header != expected:
        raise forbidden("Unauthorized cron request.")

    if not is_cloudinary_configured():
        return jsonify(ok=True, message="Cloudinary not configured, nothing to clean.")

    configure_cloudinary()
    import cloudinary.api

    # Fetch all active document IDs from the database
    with get_engine().connect() as conn:
        active_ids = set(conn.execute(select(documents.c.id)).scalars().all())

    cleaned_count = 0
    errors: list[str] = []

    try:
        # List subfolders inside files_editor/docs
        res = cloudinary.api.subfolders("files_editor/docs")
        folders = [f["name"] for f in res.get("folders", [])]

        for doc_id in folders:
            if doc_id not in active_ids:
                logger.info("Found orphaned Cloudinary folder for doc_id=%s. Deleting...", doc_id)
                try:
                    cloudinary.api.delete_resources_by_prefix(f"files_editor/docs/{doc_id}/")
                    cloudinary.api.delete_folder(f"files_editor/docs/{doc_id}")
                    cleaned_count += 1
                except Exception as exc:
                    logger.warning("Failed deleting folder for doc_id=%s: %s", doc_id, exc)
                    errors.append(f"{doc_id}: {str(exc)}")

    except Exception as exc:
        logger.error("Error during storage cleanup scan: %s", exc)
        return jsonify(ok=False, error=str(exc)), 500

    return jsonify(
        ok=True,
        scanned_folders=len(folders) if "folders" in locals() else 0,
        cleaned_orphans=cleaned_count,
        errors=errors,
    )
