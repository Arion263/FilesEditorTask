"""Convert uploaded files into editor-ready (sanitised) HTML.

Supported: .txt, .md / .markdown, .docx. Anything else is rejected with a
clear message. Conversion happens server-side so the browser never has to
parse untrusted binary formats and the output is always sanitised.
"""

from __future__ import annotations

import html
import io
import os
import re
import zipfile
from dataclasses import dataclass

import mammoth
import markdown as md

from .config import MAX_UPLOAD_BYTES, SUPPORTED_UPLOAD_EXTENSIONS
from .errors import bad_request
from .sanitize import sanitize_html


@dataclass
class ConvertedFile:
    title: str
    html: str


def _decode_text(raw: bytes) -> str:
    # UTF-16 only when a BOM says so; otherwise strict UTF-8, so binary files
    # renamed to .txt are rejected instead of imported as garbage.
    encoding = "utf-16" if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8-sig"
    try:
        text = raw.decode(encoding)
    except UnicodeDecodeError:
        text = None
    if text is None or "\x00" in text:
        raise bad_request(
            "The file doesn't look like UTF-8 text. Please save it as UTF-8 and try again.",
            code="unreadable_file",
        )
    return text


def _txt_to_html(text: str) -> str:
    # Blank lines separate paragraphs; single newlines become <br>.
    paragraphs = re.split(r"\n\s*\n", text.replace("\r\n", "\n").strip())
    return "".join(
        "<p>" + html.escape(p).replace("\n", "<br>") + "</p>" for p in paragraphs if p.strip()
    )


def _md_to_html(text: str) -> str:
    return md.markdown(text, extensions=["sane_lists"])


def _docx_to_html(raw: bytes) -> str:
    if not zipfile.is_zipfile(io.BytesIO(raw)):
        raise bad_request("This .docx file appears to be corrupted.", code="unreadable_file")
    try:
        # Images are dropped: the editor doesn't support them in this scope.
        result = mammoth.convert_to_html(
            io.BytesIO(raw), convert_image=mammoth.images.img_element(lambda _img: {})
        )
    except Exception as exc:  # mammoth raises a variety of parsing errors
        raise bad_request(
            "We couldn't read this .docx file. Is it a valid Word document?",
            code="unreadable_file",
        ) from exc
    return result.value


def convert_upload(filename: str | None, raw: bytes) -> ConvertedFile:
    if not filename:
        raise bad_request("No file was provided.", code="missing_file")
    stem, ext = os.path.splitext(os.path.basename(filename))
    ext = ext.lower()
    if ext not in SUPPORTED_UPLOAD_EXTENSIONS:
        raise bad_request(
            f"Unsupported file type '{ext or filename}'. Supported types: .txt, .md, .docx.",
            code="unsupported_file_type",
        )
    if not raw:
        raise bad_request("The uploaded file is empty.", code="empty_file")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise bad_request("The uploaded file is too large (max 4 MB).", code="file_too_large")

    if ext == ".docx":
        body = _docx_to_html(raw)
    elif ext == ".txt":
        body = _txt_to_html(_decode_text(raw))
    else:
        body = _md_to_html(_decode_text(raw))

    clean = sanitize_html(body)
    if not clean:
        clean = "<p></p>"
    title = stem.strip()[:200] or "Imported document"
    return ConvertedFile(title=title, html=clean)
