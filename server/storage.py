"""Cloudinary asset management with retries and synchronization."""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import cloudinary
import cloudinary.api
import cloudinary.uploader

logger = logging.getLogger(__name__)


def is_cloudinary_configured() -> bool:
    return bool(os.environ.get("CLOUDINARY_URL"))


def configure_cloudinary() -> None:
    url = os.environ.get("CLOUDINARY_URL")
    if url:
        cloudinary.config(cloudinary_url=url)


def upload_image_buffer(
    data: bytes,
    content_type: str,
    doc_id: str,
    image_name: str,
    max_retries: int = 3,
) -> dict[str, Any] | None:
    """Uploads an image buffer with an exponential backoff retry system.
    Tags the asset with `files_editor` and `doc_{doc_id}` for easy bulk operations.
    """
    if not is_cloudinary_configured():
        return None

    configure_cloudinary()
    public_id = f"files_editor/docs/{doc_id}/{image_name}"
    tags = ["files_editor", f"doc_{doc_id}"]

    delay = 0.5
    for attempt in range(1, max_retries + 1):
        try:
            res = cloudinary.uploader.upload(
                data,
                public_id=public_id,
                folder=f"files_editor/docs/{doc_id}",
                tags=tags,
                overwrite=True,
                resource_type="image",
            )
            return res
        except Exception as exc:
            logger.warning(
                "Cloudinary upload failed (attempt %d/%d): %s",
                attempt,
                max_retries,
                exc,
            )
            if attempt == max_retries:
                logger.error("Giving up Cloudinary upload for %s", public_id)
                return None
            time.sleep(delay)
            delay *= 2

    return None


def delete_document_assets(doc_id: str, max_retries: int = 3) -> bool:
    """Idempotently delete all assets in Cloudinary belonging to `doc_id`.
    Uses tag and prefix deletion with retries.
    """
    if not is_cloudinary_configured():
        return True

    configure_cloudinary()
    tag = f"doc_{doc_id}"
    prefix = f"files_editor/docs/{doc_id}/"

    delay = 0.5
    for attempt in range(1, max_retries + 1):
        try:
            # 1. Delete by tag
            cloudinary.api.delete_resources_by_tag(tag)
            # 2. Delete by folder/prefix in case tag missed any
            cloudinary.api.delete_resources_by_prefix(prefix)
            return True
        except Exception as exc:
            logger.warning(
                "Cloudinary delete assets failed for doc %s (attempt %d/%d): %s",
                doc_id,
                attempt,
                max_retries,
                exc,
            )
            if attempt == max_retries:
                logger.error("Failed to delete Cloudinary assets for %s", doc_id)
                return False
            time.sleep(delay)
            delay *= 2

    return False
