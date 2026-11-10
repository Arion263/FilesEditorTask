"""Consistent JSON error responses: {"error": {"code": ..., "message": ...}}."""

from __future__ import annotations

from flask import Flask, jsonify
from werkzeug.exceptions import HTTPException


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def bad_request(message: str, code: str = "invalid_request") -> ApiError:
    return ApiError(400, code, message)


def not_found(message: str = "Document not found.") -> ApiError:
    # Used for "doesn't exist" AND "you can't see it" so IDs can't be probed.
    return ApiError(404, "not_found", message)


def forbidden(message: str) -> ApiError:
    return ApiError(403, "forbidden", message)


def register_error_handlers(app: Flask) -> None:
    @app.errorhandler(ApiError)
    def _api_error(err: ApiError):
        return jsonify(error={"code": err.code, "message": err.message}), err.status

    @app.errorhandler(HTTPException)
    def _http_error(err: HTTPException):
        code = (err.name or "error").lower().replace(" ", "_")
        message = err.description or err.name
        if err.code == 413:
            message = "The uploaded file is too large (max 4 MB)."
        return jsonify(error={"code": code, "message": message}), err.code

    @app.errorhandler(Exception)
    def _unhandled(err: Exception):  # pragma: no cover - safety net
        app.logger.exception("Unhandled error: %s", err)
        return (
            jsonify(error={"code": "internal_error", "message": "Something went wrong on our side."}),
            500,
        )
