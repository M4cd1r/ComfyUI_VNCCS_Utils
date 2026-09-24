"""In-memory draw progress and draw result stores polled by the frontend."""

from __future__ import annotations

import threading
import time
from typing import Any


_DRAW_PROGRESS: dict[str, dict[str, Any]] = {}
_DRAW_PROGRESS_LOCK = threading.Lock()
_DRAW_PROGRESS_MAX = 256
_DRAW_PROGRESS_TTL_SECONDS = 60 * 60
_DRAW_PROGRESS_RUNNING_TTL_SECONDS = 24 * 60 * 60


def _prune_draw_progress(now: float | None = None) -> None:
    now = time.time() if now is None else now
    expired = []
    for draw_id, state in _DRAW_PROGRESS.items():
        age = max(0.0, now - float(state.get("updated_at", now)))
        stage = state.get("stage")
        if (stage in {"complete", "error"} and age > _DRAW_PROGRESS_TTL_SECONDS) or age > _DRAW_PROGRESS_RUNNING_TTL_SECONDS:
            expired.append(draw_id)
    for draw_id in expired:
        _DRAW_PROGRESS.pop(draw_id, None)
    if len(_DRAW_PROGRESS) <= _DRAW_PROGRESS_MAX:
        return
    ordered = sorted(
        _DRAW_PROGRESS.items(),
        key=lambda item: (item[1].get("stage") not in {"complete", "error"}, float(item[1].get("updated_at", 0))),
    )
    for draw_id, _ in ordered[:len(_DRAW_PROGRESS) - _DRAW_PROGRESS_MAX]:
        _DRAW_PROGRESS.pop(draw_id, None)


def _set_draw_progress(draw_id: str, stage: str, progress: float, step: int = 0, steps: int = 0, message: str | None = None) -> None:
    payload = {
        "draw_id": draw_id,
        "stage": stage,
        "progress": max(0.0, min(1.0, float(progress))),
        "step": max(0, int(step or 0)),
        "steps": max(0, int(steps or 0)),
        "message": message or stage,
        "updated_at": time.time(),
    }
    with _DRAW_PROGRESS_LOCK:
        _DRAW_PROGRESS[draw_id] = payload
        _prune_draw_progress()


def _get_draw_progress(draw_id: str) -> dict[str, Any]:
    with _DRAW_PROGRESS_LOCK:
        _prune_draw_progress()
        return dict(_DRAW_PROGRESS.get(draw_id) or {
            "draw_id": draw_id,
            "stage": "unknown",
            "progress": 0,
            "step": 0,
            "steps": 0,
            "message": "Waiting",
            "updated_at": time.time(),
        })


_DRAW_RESULTS: dict[str, dict[str, Any]] = {}
_DRAW_RESULTS_LOCK = threading.Lock()
_DRAW_RESULTS_TTL_SECONDS = 60 * 60


def _prune_draw_results(now: float | None = None) -> None:
    # Caller must hold _DRAW_RESULTS_LOCK (same contract as _prune_draw_progress).
    now = time.time() if now is None else now
    expired = []
    for draw_id, result in _DRAW_RESULTS.items():
        age = max(0.0, now - float(result.get("stored_at", now)))
        if age > _DRAW_RESULTS_TTL_SECONDS:
            expired.append(draw_id)
    for draw_id in expired:
        _DRAW_RESULTS.pop(draw_id, None)


def _store_draw_result(draw_id: str, result: dict[str, Any]) -> None:
    stored = dict(result)
    with _DRAW_RESULTS_LOCK:
        _prune_draw_results()
        # "stored_at" is the TTL clock for this entry; _get_draw_result filters it out.
        stored["stored_at"] = time.time()
        _DRAW_RESULTS[str(draw_id)] = stored


def _get_draw_result(draw_id: str) -> dict[str, Any]:
    with _DRAW_RESULTS_LOCK:
        _prune_draw_results()
        result = _DRAW_RESULTS.get(str(draw_id))
        if not result:
            return {"present": False}
        return {"present": True, "images": result.get("images") or [], "mask": result.get("mask")}
