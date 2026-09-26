"""Storage primitives shared by the project store (``projects.py``) and history (``history.py``).

Plain file helpers with no knowledge of the project layout: the store-wide lock, atomic JSON
writes, id validation, blob-reference collection and the comfy user of a request. Both stores
build on this module, so neither has to reach into the other's private helpers.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from typing import Any

from .route_utils import RouteError
from .state import _SAFE_ID_RE


STORE_LOCK = threading.RLock()
SHA_RE = re.compile(r"^[0-9a-f]{64}$")


class ProjectError(RouteError):
    """A project storage error a route turns into ``{"error": ...}`` with ``status``."""


def safe_id(value: Any, what: str = "id") -> str:
    """``value`` as a path-safe id; raises a 400 ``ProjectError`` when it would need changing."""
    raw = str(value or "")
    safe = _SAFE_ID_RE.sub("_", raw)[:96].strip("_")
    if not safe or safe != raw:
        raise ProjectError(f"[VNCCS UniCanvas] Invalid {what}.", 400)
    return safe


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def now() -> float:
    return time.time()


def parse_rev(value: Any, what: str = "ifRev") -> int | None:
    """An optimistic-concurrency revision from a request; None when absent, 400 when not an integer."""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        raise ProjectError(f"[VNCCS UniCanvas] {what} must be an integer.", 400) from None


def atomic_write_bytes(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{uuid.uuid4().hex[:8]}.tmp"
    with open(tmp, "wb") as handle:
        handle.write(data)
    os.replace(tmp, path)


def atomic_write_json(path: str, value: Any) -> None:
    atomic_write_bytes(path, json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def read_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def collect_blob_refs(value: Any, into: set[str]) -> set[str]:
    """Adds the sha of every ``{"blob": "<sha>.png"}`` ref found in ``value`` to ``into``."""
    if isinstance(value, dict):
        blob = value.get("blob")
        if isinstance(blob, str) and blob.endswith(".png") and SHA_RE.match(blob[:-4]):
            into.add(blob[:-4])
        for item in value.values():
            collect_blob_refs(item, into)
    elif isinstance(value, list):
        for item in value:
            collect_blob_refs(item, into)
    return into


def default_user_root() -> str:
    """``<ComfyUI user directory>``; raises if ComfyUI does not provide one."""
    import folder_paths

    getter = getattr(folder_paths, "get_user_directory", None)
    root = getter() if callable(getter) else None
    if not root:
        raise ProjectError("[VNCCS UniCanvas] The ComfyUI user directory is not available.", 500)
    return str(root)


def request_user(request) -> str:
    """The comfy user of a request, resolved the way ComfyUI's own userdata routes do."""
    try:
        from server import PromptServer

        manager = getattr(PromptServer.instance, "user_manager", None)
    except (ImportError, AttributeError):
        manager = None
    if manager is None:
        return "default"
    try:
        return str(manager.get_request_user_id(request) or "default")
    except Exception as exc:
        raise ProjectError(f"[VNCCS UniCanvas] Unknown ComfyUI user: {exc}", 403) from exc
