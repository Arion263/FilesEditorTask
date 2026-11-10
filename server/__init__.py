"""Flask application factory for the Files Editor API."""

from __future__ import annotations

from datetime import timedelta

from flask import Flask, jsonify

from . import auth, cron, documents, notifications
from .config import Config
from .db import init_db, make_engine
from .errors import register_error_handlers


def create_app(config: Config | None = None) -> Flask:
    config = config or Config()
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=config.secret_key,
        TESTING=config.testing,
        SEED_DEMO_USERS=config.seed_demo_users,
        # Covers JSON saves (<=2M chars) and multipart uploads (<=4 MB file).
        MAX_CONTENT_LENGTH=int(6.0 * 1024 * 1024),
        SESSION_COOKIE_NAME="fe_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=config.secure_cookies,
        PERMANENT_SESSION_LIFETIME=timedelta(days=7),
    )

    engine = make_engine(config.database_url)
    init_db(engine, seed_demo_users=config.seed_demo_users)
    app.extensions["engine"] = engine
    app.extensions["fe_config"] = config

    register_error_handlers(app)
    app.register_blueprint(auth.bp)
    app.register_blueprint(documents.bp)
    app.register_blueprint(notifications.bp)
    app.register_blueprint(cron.bp)

    @app.get("/api/health")
    def health():
        return jsonify(status="ok", storage=config.storage_kind)

    return app
