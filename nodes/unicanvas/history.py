"""UniCanvas generation history (Plan 10.5).

Every generation-like run (generate, remove_bg, color_match; bake, sprite and harmonize once
they exist) writes one record into its project::

    projects/<projectId>/history/<historyId>.json
        {schemaVersion, id, kind, sceneId, targetLayerId, createdAt, durationMs, status, error,
         settings, snapshot, presetId, configLinked, inferenceSize, outputSize, bbox, mode,
         inputs: {imageDataURL, maskDataURL},                     256 px thumbnails as blob refs
         results: [{index, imageDataURL, accepted, layerId, seed, width, height}]}

Pixel fields are content-addressed blobs shared with the scenes (``ProjectStore._dehydrate``), so
an accepted image is stored exactly once however many records and scenes reference it; the blob
GC in ``ProjectStore.collect_garbage`` already counts history references.

Retention is per project (``project.settings.history = {maxRecords, maxBytes}``, default 1000
records or 4 GB of blobs). Pruning drops the oldest discarded results first, then whole records,
and never deletes a blob a scene or an asset references.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Callable

from .projects import (
    MAX_SCENE_BYTES,
    ProjectError,
    ProjectStore,
    _STORE_LOCK,
    _atomic_write_json,
    _collect_blob_refs,
    _new_id,
    _now,
    _read_json,
    _request_user,
    _safe_id,
    default_user_root,
)


HISTORY_SCHEMA_VERSION = 1
DEFAULT_MAX_RECORDS = 1000
DEFAULT_MAX_BYTES = 4 * 1024 ** 3
HISTORY_KINDS = ("generate", "bake", "sprite", "harmonize", "remove_bg", "color_match")
MAX_RESULTS = 128


def retention_settings(project: dict[str, Any]) -> dict[str, int]:
    """The project's history caps, falling back to the defaults for missing or invalid values."""
    raw = ((project or {}).get("settings") or {}).get("history")
    raw = raw if isinstance(raw, dict) else {}

    def positive(key: str, default: int) -> int:
        try:
            value = int(raw.get(key))
        except (TypeError, ValueError):
            return default
        return value if value > 0 else default

    return {"maxRecords": positive("maxRecords", DEFAULT_MAX_RECORDS), "maxBytes": positive("maxBytes", DEFAULT_MAX_BYTES)}


def _clean_results(results: Any) -> list[dict[str, Any]]:
    if not isinstance(results, list):
        return []
    cleaned = []
    for index, item in enumerate(results[:MAX_RESULTS]):
        if not isinstance(item, dict):
            continue
        entry = dict(item)
        entry["index"] = index
        entry["accepted"] = entry.get("accepted") is True
        entry["layerId"] = str(entry.get("layerId") or "")[:200] or None
        cleaned.append(entry)
    return cleaned


def _timestamp(value: Any) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else _now()


class HistoryStore:
    """History records of one comfy user's projects, on top of ``ProjectStore``."""

    def __init__(self, projects: ProjectStore):
        self.projects = projects

    # -- paths ---------------------------------------------------------------------------------

    def history_dir(self, project_id: str) -> str:
        return self.projects._inside(os.path.join(self.projects.project_dir(project_id), "history"))

    def record_path(self, project_id: str, history_id: str) -> str:
        return self.projects._inside(os.path.join(self.history_dir(project_id), f"{_safe_id(history_id, 'history id')}.json"))

    # -- records -------------------------------------------------------------------------------

    def _load_all(self, project_id: str) -> list[dict[str, Any]]:
        directory = self.history_dir(project_id)
        records = []
        for name in os.listdir(directory) if os.path.isdir(directory) else []:
            if not name.endswith(".json"):
                continue
            try:
                record = _read_json(os.path.join(directory, name))
            except (OSError, ValueError):
                continue
            if isinstance(record, dict) and record.get("id"):
                records.append(record)
        records.sort(key=lambda record: (record.get("createdAt") or 0, record.get("id") or ""))
        return records

    def list_records(self, project_id: str, limit: int | None = None) -> dict[str, Any]:
        """Records newest first, with the project's caps and current usage."""
        project = self.projects.load_project(project_id)
        records = list(reversed(self._load_all(project_id)))
        if limit is not None and limit > 0:
            records = records[:limit]
        usage = self.usage(project_id)
        return {"records": records, "settings": retention_settings(project), "usage": usage}

    def get_record(self, project_id: str, history_id: str) -> dict[str, Any]:
        self.projects.load_project(project_id)
        path = self.record_path(project_id, history_id)
        if not os.path.isfile(path):
            raise ProjectError("[VNCCS UniCanvas] History record not found.", 404)
        return _read_json(path)

    def create_record(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ProjectError("[VNCCS UniCanvas] A history record must be an object.", 400)
        kind = payload.get("kind")
        if kind not in HISTORY_KINDS:
            raise ProjectError(f"[VNCCS UniCanvas] Unknown history kind: {kind}.", 400)
        with _STORE_LOCK:
            self.projects.load_project(project_id)
            requested = payload.get("id")
            history_id = _safe_id(requested, "history id") if requested else _new_id("gen")
            path = self.record_path(project_id, history_id)
            if os.path.exists(path):
                raise ProjectError("[VNCCS UniCanvas] A history record with this id already exists.", 409)
            record = self.projects._dehydrate(project_id, payload)
            record.update({
                "schemaVersion": HISTORY_SCHEMA_VERSION,
                "id": history_id,
                "kind": kind,
                "createdAt": _timestamp(payload.get("createdAt")),
                "results": _clean_results(record.get("results")),
            })
            os.makedirs(os.path.dirname(path), exist_ok=True)
            _atomic_write_json(path, record)
            pruned = self.prune(project_id)
            return {"record": record, "pruned": pruned}

    def patch_record(self, project_id: str, history_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        """Updates result flags (``results: [{index, accepted, layerId}]``) and the duration/error."""
        if not isinstance(patch, dict):
            raise ProjectError("[VNCCS UniCanvas] Expected a JSON object.", 400)
        with _STORE_LOCK:
            record = self.get_record(project_id, history_id)
            results = record.get("results") or []
            for change in patch.get("results") or []:
                if not isinstance(change, dict):
                    continue
                index = change.get("index")
                if not isinstance(index, int) or not 0 <= index < len(results):
                    raise ProjectError("[VNCCS UniCanvas] Unknown history result.", 400)
                if "accepted" in change:
                    results[index]["accepted"] = change.get("accepted") is True
                if "layerId" in change:
                    results[index]["layerId"] = str(change.get("layerId") or "")[:200] or None
            for key in ("durationMs", "status", "error"):
                if key in patch:
                    record[key] = patch[key]
            _atomic_write_json(self.record_path(project_id, history_id), record)
            return record

    def delete_record(self, project_id: str, history_id: str) -> None:
        with _STORE_LOCK:
            path = self.record_path(project_id, history_id)
            if not os.path.isfile(path):
                raise ProjectError("[VNCCS UniCanvas] History record not found.", 404)
            os.remove(path)

    # -- retention -----------------------------------------------------------------------------

    def _protected_blobs(self, project_id: str) -> set[str] | None:
        """Blobs a scene or an asset references; None when a file could not be read."""
        referenced: set[str] = set()
        directory = self.projects.project_dir(project_id)
        for sub in ("scenes", "assets"):
            for folder, _dirs, files in os.walk(os.path.join(directory, sub)):
                for name in files:
                    if not name.endswith(".json"):
                        continue
                    try:
                        _collect_blob_refs(_read_json(os.path.join(folder, name)), referenced)
                    except (OSError, ValueError):
                        return None
        return referenced

    def _blob_size(self, project_id: str, sha: str) -> int:
        try:
            return os.path.getsize(self.projects.blob_path(project_id, sha))
        except OSError:
            return 0

    def usage(self, project_id: str) -> dict[str, int]:
        records = self._load_all(project_id)
        blobs: set[str] = set()
        for record in records:
            _collect_blob_refs(record, blobs)
        return {"records": len(records), "bytes": sum(self._blob_size(project_id, sha) for sha in blobs)}

    def prune(self, project_id: str, max_records: int | None = None, max_bytes: int | None = None) -> dict[str, Any]:
        """Enforces the caps: oldest discarded results first, then whole records (oldest first).

        Bytes count the history's own blobs, i.e. those no scene or asset references: pruning
        can only free those, so the rest never counts against the cap and is never deleted.
        """
        with _STORE_LOCK:
            caps = retention_settings(self.projects.load_project(project_id))
            max_records = max_records or caps["maxRecords"]
            max_bytes = max_bytes or caps["maxBytes"]
            protected = self._protected_blobs(project_id)
            if protected is None:
                return {"records": [], "results": 0, "blobs": []}  # an unreadable scene could hide references
            records = self._load_all(project_id)
            refcount: dict[str, int] = {}
            per_record: dict[str, set[str]] = {}
            for record in records:
                refs = _collect_blob_refs(record, set())
                per_record[record["id"]] = refs
                for sha in refs:
                    refcount[sha] = refcount.get(sha, 0) + 1
            sizes = {sha: self._blob_size(project_id, sha) for sha in refcount}

            def own_bytes() -> int:
                return sum(sizes[sha] for sha, count in refcount.items() if count > 0 and sha not in protected)

            def release(refs: set[str]) -> None:
                for sha in refs:
                    refcount[sha] -= 1

            def retain(refs: set[str]) -> None:
                for sha in refs:
                    refcount[sha] = refcount.get(sha, 0) + 1

            removed_records: list[str] = []
            changed: dict[str, dict[str, Any]] = {}
            removed_results = 0

            def drop_record(record: dict[str, Any]) -> None:
                release(per_record.pop(record["id"]))
                removed_records.append(record["id"])
                changed.pop(record["id"], None)

            while len(records) > max_records:
                drop_record(records.pop(0))
            if own_bytes() > max_bytes:
                for record in records:
                    discarded = [item for item in record.get("results") or [] if not item.get("accepted")]
                    if not discarded:
                        continue
                    record["results"] = [item for item in record["results"] if item.get("accepted")]
                    removed_results += len(discarded)
                    release(per_record[record["id"]])
                    per_record[record["id"]] = _collect_blob_refs(record, set())
                    retain(per_record[record["id"]])
                    changed[record["id"]] = record
                    if own_bytes() <= max_bytes:
                        break
            while records and own_bytes() > max_bytes:
                drop_record(records.pop(0))
            for history_id in removed_records:
                path = self.record_path(project_id, history_id)
                if os.path.isfile(path):
                    os.remove(path)
            for history_id, record in changed.items():
                _atomic_write_json(self.record_path(project_id, history_id), record)
            deleted_blobs = []
            for sha, count in refcount.items():
                if count > 0 or sha in protected:
                    continue
                path = self.projects.blob_path(project_id, sha)
                if os.path.isfile(path):
                    os.remove(path)
                    deleted_blobs.append(sha)
            return {"records": removed_records, "results": removed_results, "blobs": deleted_blobs}


# -- aiohttp routes ------------------------------------------------------------------------------

def history_routes(web, content_length_ok: Callable[[Any, int], bool],
                   store_factory: Callable[[str], ProjectStore] | None = None) -> list[tuple[str, str, Callable]]:
    """(method, path, handler) triples under /vnccs/unicanvas/projects/{id}/history."""
    base = "/vnccs/unicanvas/projects/{id}/history"

    def store_for(request) -> HistoryStore:
        user = _request_user(request)
        return HistoryStore(store_factory(user) if store_factory else ProjectStore(default_user_root(), user))

    def handler(max_bytes: int, work):
        async def run(request):
            if not content_length_ok(request, max_bytes):
                return web.json_response({"error": "[VNCCS UniCanvas] History request is too large."}, status=413)
            try:
                result = await work(request, store_for(request))
                return web.json_response(result)
            except ProjectError as exc:
                return web.json_response({"error": str(exc), **exc.extra}, status=exc.status)
            except Exception as exc:
                return web.json_response({"error": f"[VNCCS UniCanvas] History storage failed: {exc}"}, status=500)
        return run

    async def body(request) -> dict[str, Any]:
        if not getattr(request, "can_read_body", False):
            return {}
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ProjectError("[VNCCS UniCanvas] Expected a JSON object.", 400)
        return payload

    def m(request, key):
        return request.match_info.get(key) or ""

    async def list_(request, store):
        try:
            limit = int(getattr(request, "query", {}).get("limit") or 0) or None
        except (TypeError, ValueError):
            limit = None
        return await asyncio.to_thread(store.list_records, m(request, "id"), limit)

    async def create(request, store):
        return await asyncio.to_thread(store.create_record, m(request, "id"), await body(request))

    async def get(request, store):
        return await asyncio.to_thread(store.get_record, m(request, "id"), m(request, "hid"))

    async def patch(request, store):
        return await asyncio.to_thread(store.patch_record, m(request, "id"), m(request, "hid"), await body(request))

    async def delete(request, store):
        await asyncio.to_thread(store.delete_record, m(request, "id"), m(request, "hid"))
        return {"deleted": True}

    async def prune(request, store):
        return await asyncio.to_thread(store.prune, m(request, "id"))

    small = 1024 * 1024
    return [
        ("GET", base, handler(small, list_)),
        ("POST", base, handler(MAX_SCENE_BYTES, create)),
        ("POST", f"{base}/prune", handler(small, prune)),
        ("GET", f"{base}/{{hid}}", handler(small, get)),
        ("PATCH", f"{base}/{{hid}}", handler(small, patch)),
        ("DELETE", f"{base}/{{hid}}", handler(small, delete)),
    ]
