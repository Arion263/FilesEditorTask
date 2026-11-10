"""Small request helpers shared by the blueprints."""

from __future__ import annotations

from functools import wraps
from typing import Any, Callable

from flask import current_app, g, request, session
from sqlalchemy import select
from sqlalchemy.engine import Engine

from .db import users
from .errors import ApiError, bad_request


def get_engine() -> Engine:
    return current_app.extensions["engine"]


def json_body() -> dict[str, Any]:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise bad_request("Expected a JSON object in the request body.")
    return data


def optional_str(data: dict[str, Any], key: str) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise bad_request(f"'{key}' must be a string.")
    return value


def public_user(row) -> dict[str, str]:
    return {"id": row.id, "email": row.email, "name": row.name}


def login_required(view: Callable) -> Callable:
    """Resolve the signed-cookie session into g.user or reply 401."""

    @wraps(view)
    def wrapper(*args, **kwargs):
        user_id = session.get("user_id")
        user = None
        if user_id:
            with get_engine().connect() as conn:
                user = conn.execute(select(users).where(users.c.id == user_id)).first()
        if user is None:
            session.clear()
            raise ApiError(401, "unauthenticated", "Please sign in to continue.")
        g.user = user
        return view(*args, **kwargs)

    return wrapper
