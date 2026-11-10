"""S3-compatible Object Storage management (Neon Bucket, AWS S3, Cloudflare R2).
Includes exponential backoff retries and idempotent deletion.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)


def is_s3_configured() -> bool:
    return bool(
        os.environ.get("AWS_ACCESS_KEY_ID")
        and os.environ.get("AWS_SECRET_ACCESS_KEY")
        and (os.environ.get("AWS_ENDPOINT_URL_S3") or os.environ.get("AWS_REGION"))
    )


def get_s3_client():
    endpoint = os.environ.get("AWS_ENDPOINT_URL_S3") or None
    access_key = os.environ.get("AWS_ACCESS_KEY_ID")
    secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY")
    region = os.environ.get("AWS_REGION", "auto")

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
        config=Config(signature_version="s3v4"),
    )


def get_bucket_name() -> str:
    return os.environ.get("AWS_S3_BUCKET_NAME", "files-editor")


def upload_image_buffer(
    data: bytes,
    content_type: str,
    doc_id: str,
    image_name: str,
    max_retries: int = 3,
) -> str | None:
    """Uploads an image buffer to S3 with exponential backoff retries.
    Returns the public/accessible URL of the uploaded image.
    Key format: docs/{doc_id}/{image_name}
    """
    if not is_s3_configured():
        return None

    client = get_s3_client()
    bucket = get_bucket_name()
    key = f"docs/{doc_id}/{image_name}"

    delay = 0.5
    for attempt in range(1, max_retries + 1):
        try:
            client.put_object(
                Bucket=bucket,
                Key=key,
                Body=data,
                ContentType=content_type,
            )
            endpoint = os.environ.get("AWS_ENDPOINT_URL_S3", "").rstrip("/")
            if endpoint:
                return f"{endpoint}/{bucket}/{key}"
            region = os.environ.get("AWS_REGION", "us-east-1")
            return f"https://{bucket}.s3.{region}.amazonaws.com/{key}"
        except Exception as exc:
            logger.warning("S3 upload failed (attempt %d/%d): %s", attempt, max_retries, exc)
            if attempt == max_retries:
                logger.error("Giving up S3 upload for %s", key)
                return None
            time.sleep(delay)
            delay *= 2

    return None


def delete_document_assets(doc_id: str, max_retries: int = 3) -> bool:
    """Idempotently delete all objects under `docs/{doc_id}/` in the S3 bucket."""
    if not is_s3_configured():
        return True

    client = get_s3_client()
    bucket = get_bucket_name()
    prefix = f"docs/{doc_id}/"

    delay = 0.5
    for attempt in range(1, max_retries + 1):
        try:
            # 1. List objects with prefix
            paginator = client.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
                objects = [{"Key": obj["Key"]} for obj in page.get("Contents", [])]
                if objects:
                    client.delete_objects(Bucket=bucket, Delete={"Objects": objects})
            return True
        except Exception as exc:
            logger.warning(
                "S3 delete assets failed for doc %s (attempt %d/%d): %s",
                doc_id,
                attempt,
                max_retries,
                exc,
            )
            if attempt == max_retries:
                logger.error("Failed to delete S3 assets for doc %s", doc_id)
                return False
            time.sleep(delay)
            delay *= 2

    return False
