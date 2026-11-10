import io
import zipfile

import pytest

from server import create_app
from server.config import Config
from server.db import DEMO_PASSWORD


@pytest.fixture()
def app(tmp_path):
    config = Config(
        database_url=f"sqlite:///{tmp_path / 'test.db'}",
        secret_key="test-secret",
        secure_cookies=False,
        seed_demo_users=True,
        testing=True,
    )
    return create_app(config)


def _login(app, email):
    client = app.test_client()
    resp = client.post("/api/auth/login", json={"email": email, "password": DEMO_PASSWORD})
    assert resp.status_code == 200, resp.get_json()
    return client


@pytest.fixture()
def alice(app):
    return _login(app, "alice@example.com")


@pytest.fixture()
def bob(app):
    return _login(app, "bob@example.com")


@pytest.fixture()
def carol(app):
    return _login(app, "carol@example.com")


def make_docx(paragraphs: list[tuple[str, str | None]]) -> bytes:
    """Build a minimal valid .docx in memory: [(text, style_or_None), ...]."""
    body = ""
    for text, style in paragraphs:
        ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
        body += f"<w:p>{ppr}<w:r><w:rPr><w:b/></w:rPr><w:t>{text}</w:t></w:r></w:p>"
    files = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>"
        ),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            "</Relationships>"
        ),
        "word/document.xml": (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body>{body}</w:body></w:document>"
        ),
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()
