"""Lightweight authentication: email + password, signed session cookie.

Demo accounts are seeded on startup (see db.DEMO_USERS); reviewers can also
register new accounts to try sharing between arbitrary users.
"""

from __future__ import annotations

import re

from flask import Blueprint, current_app, g, jsonify, session
from sqlalchemy import func, insert, select
from sqlalchemy.exc import IntegrityError
from werkzeug.security import check_password_hash, generate_password_hash

from .db import DEMO_PASSWORD, DEMO_USERS, new_id, users, utcnow
from .errors import ApiError, bad_request
from .http import get_engine, json_body, login_required, optional_str, public_user

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def normalise_email(raw: str | None) -> str:
    email = (raw or "").strip().lower()
    if not email or len(email) > 254 or not EMAIL_RE.match(email):
        raise bad_request("Please enter a valid email address.", code="invalid_email")
    return email


def _start_session(user_id: str) -> None:
    session.clear()
    session["user_id"] = user_id
    session.permanent = True


@bp.post("/register")
def register():
    data = json_body()
    email = normalise_email(optional_str(data, "email"))
    name = (optional_str(data, "name") or "").strip()
    password = optional_str(data, "password") or ""
    if not 1 <= len(name) <= 100:
        raise bad_request("Name must be between 1 and 100 characters.", code="invalid_name")
    if not 8 <= len(password) <= 128:
        raise bad_request("Password must be 8-128 characters long.", code="invalid_password")

    user_id = new_id()
    try:
        with get_engine().begin() as conn:
            conn.execute(
                insert(users).values(
                    id=user_id,
                    email=email,
                    name=name,
                    password_hash=generate_password_hash(password),
                    created_at=utcnow(),
                )
            )
    except IntegrityError:
        raise ApiError(409, "email_taken", "An account with this email already exists.")

    _start_session(user_id)
    return jsonify(user={"id": user_id, "email": email, "name": name}), 201


@bp.post("/login")
def login():
    data = json_body()
    email = (optional_str(data, "email") or "").strip().lower()
    password = optional_str(data, "password") or ""
    with get_engine().connect() as conn:
        user = conn.execute(select(users).where(func.lower(users.c.email) == email)).first()
    if user is None or not check_password_hash(user.password_hash, password):
        raise ApiError(401, "invalid_credentials", "Incorrect email or password.")
    _start_session(user.id)
    return jsonify(user=public_user(user))


@bp.post("/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@bp.get("/me")
@login_required
def me():
    return jsonify(user=public_user(g.user))


@bp.get("/demo-accounts")
def demo_accounts():
    """Expose the seeded demo logins so the login page can offer one-click sign-in."""
    if not current_app.config["SEED_DEMO_USERS"]:
        return jsonify(accounts=[])
    return jsonify(
        accounts=[{"email": e, "name": n, "password": DEMO_PASSWORD} for e, n in DEMO_USERS]
    )
