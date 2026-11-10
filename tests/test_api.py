"""End-to-end API tests: every request goes through Flask routing, auth,
validation and a real (temporary) SQLite database."""

import io

from conftest import make_docx


def create_doc(client, **payload):
    resp = client.post("/api/documents", json=payload)
    assert resp.status_code == 201, resp.get_json()
    return resp.get_json()["document"]


def share(client, doc_id, email, role):
    return client.post(f"/api/documents/{doc_id}/shares", json={"email": email, "role": role})


# --------------------------------------------------------------------------- #
# auth
# --------------------------------------------------------------------------- #
def test_requires_authentication(app):
    client = app.test_client()
    resp = client.get("/api/documents")
    assert resp.status_code == 401
    assert resp.get_json()["error"]["code"] == "unauthenticated"


def test_login_rejects_bad_password(app):
    resp = app.test_client().post(
        "/api/auth/login", json={"email": "alice@example.com", "password": "nope"}
    )
    assert resp.status_code == 401


def test_register_then_me_and_duplicate_email(app):
    client = app.test_client()
    resp = client.post(
        "/api/auth/register",
        json={"email": "Dave@Example.com", "name": "Dave", "password": "longenough"},
    )
    assert resp.status_code == 201
    assert client.get("/api/auth/me").get_json()["user"]["email"] == "dave@example.com"

    dup = app.test_client().post(
        "/api/auth/register",
        json={"email": "dave@example.com", "name": "Dave 2", "password": "longenough"},
    )
    assert dup.status_code == 409


# --------------------------------------------------------------------------- #
# documents: create / rename / edit / reopen
# --------------------------------------------------------------------------- #
def test_document_lifecycle_preserves_formatting(alice):
    doc = create_doc(alice)
    assert doc["title"] == "Untitled document"
    assert doc["role"] == "owner" and doc["version"] == 1

    html = (
        "<h1>Plan</h1><p><strong>bold</strong> <em>italic</em> <u>under</u></p>"
        "<ul><li><p>one</p></li></ul><ol><li><p>first</p></li></ol>"
    )
    resp = alice.patch(
        f"/api/documents/{doc['id']}",
        json={"title": "  Q3   plan ", "content": html, "base_version": 1},
    )
    assert resp.status_code == 200
    saved = resp.get_json()["document"]
    assert saved["title"] == "Q3 plan"
    assert saved["version"] == 2

    # "Reopen": a fresh GET returns exactly the formatted content.
    reopened = alice.get(f"/api/documents/{doc['id']}").get_json()["document"]
    assert reopened["content"] == html
    for tag in ("<h1>", "<strong>", "<em>", "<u>", "<ul>", "<ol>"):
        assert tag in reopened["content"]

    listing = alice.get("/api/documents").get_json()
    assert [d["title"] for d in listing["owned"]] == ["Q3 plan"]
    assert listing["shared"] == []


def test_content_is_sanitised(alice):
    doc = create_doc(
        alice,
        title="xss",
        content='<p onclick="evil()">hi</p><script>alert(1)</script><a href="javascript:x">l</a>',
    )
    assert "script" not in doc["content"]
    assert "onclick" not in doc["content"]
    assert "javascript:" not in doc["content"]
    assert "<p>hi</p>" in doc["content"]


def test_validation_errors(alice):
    doc = create_doc(alice)
    url = f"/api/documents/{doc['id']}"
    assert alice.patch(url, json={"title": "x"}).status_code == 400  # no base_version
    assert alice.patch(url, json={"title": "   ", "base_version": 1}).status_code == 400
    assert alice.patch(url, json={"title": "x" * 201, "base_version": 1}).status_code == 400
    assert alice.patch(url, json={"base_version": 1}).status_code == 400
    assert alice.patch(url, data="not json", content_type="text/plain").status_code == 400


def test_stale_save_is_rejected_with_conflict(alice):
    doc = create_doc(alice)
    url = f"/api/documents/{doc['id']}"
    assert alice.patch(url, json={"content": "<p>a</p>", "base_version": 1}).status_code == 200
    stale = alice.patch(url, json={"content": "<p>b</p>", "base_version": 1})
    assert stale.status_code == 409
    assert stale.get_json()["error"]["code"] == "version_conflict"
    assert alice.get(url).get_json()["document"]["content"] == "<p>a</p>"


# --------------------------------------------------------------------------- #
# sharing
# --------------------------------------------------------------------------- #
def test_sharing_grants_role_based_access(alice, bob, carol):
    doc = create_doc(alice, title="Shared plan", content="<p>v1</p>")
    url = f"/api/documents/{doc['id']}"

    # Before sharing, Bob can't even tell the document exists.
    assert bob.get(url).status_code == 404

    assert share(alice, doc["id"], "bob@example.com", "editor").status_code == 201
    assert share(alice, doc["id"], "carol@example.com", "viewer").status_code == 201

    # Owned vs shared distinction in listings.
    bob_list = bob.get("/api/documents").get_json()
    assert bob_list["owned"] == []
    assert bob_list["shared"][0]["title"] == "Shared plan"
    assert bob_list["shared"][0]["role"] == "editor"
    assert bob_list["shared"][0]["owner"]["email"] == "alice@example.com"
    assert alice.get("/api/documents").get_json()["owned"][0]["share_count"] == 2

    # Editor can edit; viewer can read but not edit.
    assert bob.patch(url, json={"content": "<p>v2</p>", "base_version": 1}).status_code == 200
    assert carol.get(url).get_json()["document"]["content"] == "<p>v2</p>"
    assert carol.patch(url, json={"content": "<p>x</p>", "base_version": 2}).status_code == 403

    # Only the owner manages sharing or deletes.
    assert share(bob, doc["id"], "carol@example.com", "editor").status_code == 403
    assert bob.delete(url).status_code == 403

    # Role change (upsert) and revoke.
    assert share(alice, doc["id"], "carol@example.com", "editor").status_code == 200
    bob_id = bob.get("/api/auth/me").get_json()["user"]["id"]
    assert alice.delete(f"{url}/shares/{bob_id}").status_code == 200
    assert bob.get(url).status_code == 404
    assert bob.get("/api/documents").get_json()["shared"] == []


def test_share_validation(alice):
    doc = create_doc(alice)
    assert share(alice, doc["id"], "nobody@example.com", "viewer").status_code == 404
    assert share(alice, doc["id"], "alice@example.com", "viewer").status_code == 400
    assert share(alice, doc["id"], "bob@example.com", "admin").status_code == 400


def test_delete_document_removes_shares(alice, bob):
    doc = create_doc(alice)
    share(alice, doc["id"], "bob@example.com", "viewer")
    assert alice.delete(f"/api/documents/{doc['id']}").status_code == 204
    assert bob.get("/api/documents").get_json()["shared"] == []


# --------------------------------------------------------------------------- #
# file upload / import
# --------------------------------------------------------------------------- #
def upload(client, url, filename, raw):
    return client.post(
        url,
        data={"file": (io.BytesIO(raw), filename)},
        content_type="multipart/form-data",
    )


def test_import_markdown_creates_formatted_document(alice):
    md = b"# Meeting notes\n\nSome **bold** and *italic*.\n\n- one\n- two\n"
    resp = upload(alice, "/api/documents/import", "notes.md", md)
    assert resp.status_code == 201
    doc = resp.get_json()["document"]
    assert doc["title"] == "notes"
    assert "<h1>Meeting notes</h1>" in doc["content"]
    assert "<strong>bold</strong>" in doc["content"]
    assert "<ul>" in doc["content"]


def test_import_txt_escapes_html(alice):
    raw = "Line one\nline two\n\n<script>x</script> second para".encode()
    doc = upload(alice, "/api/documents/import", "plain.txt", raw).get_json()["document"]
    assert doc["content"] == (
        "<p>Line one<br>line two</p><p>&lt;script&gt;x&lt;/script&gt; second para</p>"
    )


def test_import_docx(alice):
    raw = make_docx([("Report", "Heading1"), ("Body text", None)])
    resp = upload(alice, "/api/documents/import", "report.docx", raw)
    assert resp.status_code == 201, resp.get_json()
    content = resp.get_json()["document"]["content"]
    assert "<h1>" in content and "Report" in content
    assert "<strong>Body text</strong>" in content


def test_convert_returns_html_without_creating_document(alice):
    resp = upload(alice, "/api/convert", "snippet.md", b"## Sub\n\n1. a\n2. b")
    assert resp.status_code == 200
    assert "<h2>Sub</h2>" in resp.get_json()["html"]
    assert alice.get("/api/documents").get_json()["owned"] == []


def test_import_rejects_bad_files(alice):
    url = "/api/documents/import"
    assert upload(alice, url, "image.png", b"\x89PNG").get_json()["error"]["code"] == (
        "unsupported_file_type"
    )
    assert upload(alice, url, "empty.txt", b"").status_code == 400
    assert upload(alice, url, "bin.txt", b"\xff\xfe\x00\xd8\x00").status_code == 400
    assert upload(alice, url, "fake.docx", b"not a zip").status_code == 400
    assert upload(alice, url, "big.txt", b"a" * (4 * 1024 * 1024 + 1)).status_code == 400
    assert alice.post(url, data={}, content_type="multipart/form-data").status_code == 400
