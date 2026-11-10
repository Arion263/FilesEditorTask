"""Cron job tasks: daily garbage collection for orphaned assets in Neon S3 Bucket."""

from __future__ import annotations

import logging
from typing import Any

from flask import Blueprint, current_app, jsonify, request
from sqlalchemy import select

from .db import documents
from .errors import forbidden
from .http import get_engine
from .storage import get_bucket_name, get_s3_client, is_s3_configured

logger = logging.getLogger(__name__)

bp = Blueprint("cron", __name__, url_prefix="/api/cron")


@bp.route("/cleanup-storage", methods=["GET", "POST"])
def cleanup_storage():
    """Daily garbage collection.
    Scans the Neon S3 bucket for assets stored under `docs/{doc_id}/...`.
    If a `doc_id` is not present in the Postgres/SQLite database (e.g. deleted
    by user or interrupted operation), all its orphaned objects are purged from S3.
    """
    cron_secret = current_app.extensions["fe_config"].cron_secret
    auth_header = request.headers.get("Authorization", "")
    expected = f"Bearer {cron_secret}" if cron_secret else None

    # Enforce Vercel cron authentication if secret is defined
    if expected and auth_header != expected:
        raise forbidden("Unauthorized cron request.")

    if not is_s3_configured():
        return jsonify(
            ok=True,
            storage="local_or_unconfigured",
            message="S3 / Neon storage is not configured; no remote assets to clean.",
        )

    client = get_s3_client()
    bucket = get_bucket_name()

    # 1. Fetch all active document IDs from the database
    with get_engine().connect() as conn:
        active_doc_ids = set(conn.execute(select(documents.c.id)).scalars().all())

    scanned_objects = 0
    cleaned_objects = 0
    orphaned_doc_ids: set[str] = set()
    errors: list[str] = []

    try:
        # 2. Paginate over all objects with prefix "docs/"
        paginator = client.get_paginator("list_objects_v2")
        orphan_keys_batch: list[dict[str, str]] = []

        for page in paginator.paginate(Bucket=bucket, Prefix="docs/"):
            contents = page.get("Contents", [])
            scanned_objects += len(contents)

            for item in contents:
                key = item["Key"]
                parts = key.split("/")
                # Expected key structure: docs/<doc_id>/<filename>
                if len(parts) >= 3 and parts[0] == "docs":
                    doc_id = parts[1]
                    if doc_id not in active_doc_ids:
                        orphaned_doc_ids.add(doc_id)
                        orphan_keys_batch.append({"Key": key})

                # S3 delete_objects supports at most 1000 keys per request
                if len(orphan_keys_batch) >= 1000:
                    del_res = client.delete_objects(
                        Bucket=bucket,
                        Delete={"Objects": orphan_keys_batch},
                    )
                    cleaned_objects += len(del_res.get("Deleted", []))
                    orphan_keys_batch = []

        # Delete any remaining orphan keys in the final batch
        if orphan_keys_batch:
            del_res = client.delete_objects(
                Bucket=bucket,
                Delete={"Objects": orphan_keys_batch},
            )
            cleaned_objects += len(del_res.get("Deleted", []))

    except Exception as exc:
        logger.error("Error during Neon S3 storage cleanup scan: %s", exc)
        return jsonify(ok=False, error=str(exc)), 500

    logger.info(
        "Neon S3 storage cleanup finished. Scanned=%d, Cleaned=%d orphans across %d docs.",
        scanned_objects,
        cleaned_objects,
        len(orphaned_doc_ids),
    )

    return jsonify(
        ok=True,
        scanned_objects=scanned_objects,
        cleaned_objects=cleaned_objects,
        orphaned_documents_cleaned=list(orphaned_doc_ids),
        errors=errors,
    )
