"""Shared building blocks for the JSON route tables of the feature modules.

``projects.py``, ``history.py`` and ``animation_export.py`` each return ``(method, path, handler)``
triples that ``routes.py`` registers. Their handlers share one shape, built here: a request size
check, the work itself, a :class:`RouteError` answered with its own status and an unexpected
exception answered (and logged) as a 500. No aiohttp import: callers pass ``web`` in.
"""

from __future__ import annotations

import logging
import traceback
from typing import Any, Awaitable, Callable


class RouteError(Exception):
    """An error a route answers with ``{"error": message, **extra}`` and ``status``."""

    def __init__(self, message: str, status: int = 400, **extra: Any):
        super().__init__(message)
        self.status = status
        self.extra = extra


async def read_json_object(request, message: str = "[VNCCS UniCanvas] Expected a JSON object.") -> dict[str, Any]:
    """The request body as a JSON object; ``{}`` without a body, a 400 on malformed JSON or a non-object."""
    if not getattr(request, "can_read_body", False):
        return {}
    try:
        payload = await request.json()
    except ValueError:  # json.JSONDecodeError, and aiohttp's content-type complaints
        raise RouteError(message, 400) from None
    if not isinstance(payload, dict):
        raise RouteError(message, 400)
    return payload


def match(request, key: str) -> str:
    """A path parameter, ``""`` when missing."""
    return request.match_info.get(key) or ""


def json_route(
    web,
    content_length_ok: Callable[[Any, int], bool],
    max_bytes: int,
    work: Callable[[Any], Awaitable[Any]],
    *,
    subject: str,
    failure: str,
) -> Callable[[Any], Awaitable[Any]]:
    """An aiohttp handler around ``work(request)``.

    ``work`` returns a JSON-serialisable value or a ready ``web.StreamResponse``. ``subject``
    names the request in the 413 message ("Project" -> "Project request is too large."),
    ``failure`` prefixes the 500 message ("Project storage failed: <error>").
    """

    async def run(request):
        if not content_length_ok(request, max_bytes):
            return web.json_response({"error": f"[VNCCS UniCanvas] {subject} request is too large."}, status=413)
        try:
            result = await work(request)
        except RouteError as exc:
            return web.json_response({"error": str(exc), **exc.extra}, status=exc.status)
        except Exception as exc:
            logging.error("[VNCCS UniCanvas] %s: %s", failure, traceback.format_exc())
            return web.json_response({"error": f"[VNCCS UniCanvas] {failure}: {exc}"}, status=500)
        return result if isinstance(result, web.StreamResponse) else web.json_response(result)

    return run
