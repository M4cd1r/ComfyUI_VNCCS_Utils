"""Durable UniCanvas project storage (Plan 10.2).

A project holds several scenes and lives in the ComfyUI user directory, never in the temp
directory the state cache uses (ComfyUI wipes that on startup)::

    <user dir>/<comfy user>/vnccs_unicanvas/projects/<projectId>/
        project.json                 {schemaVersion, id, name, createdAt, updatedAt, rev, scenes, activeSceneId, settings}
        scenes/<sceneId>/scene.json  the buildSerializedState shape, pixel fields replaced by blob refs
        blobs/<sha256>.png           content-addressed pixels shared by every scene of the project
        thumbs/<sceneId>.png         512 px scene thumbnail
        assets/<assetId>/asset.json  project-scope library assets (Plan 10.4), pixels in blobs/
        history/<historyId>.json     generation history records (Plan 10.5, history.py)
    <user dir>/<comfy user>/vnccs_unicanvas/library/     the global asset library, same format:
        assets/<assetId>/asset.json, blobs/<sha256>.png
    <user dir>/<comfy user>/vnccs_unicanvas/trash/<projectId>-<timestamp>/   deleted projects, purged after 30 days

``ProjectStore`` holds the file logic and is what the tests exercise; ``project_routes`` wraps it
in aiohttp handlers that ``routes.py`` registers. The storage primitives it shares with
``history.py`` live in ``project_io.py``, the route plumbing in ``route_utils.py``.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import io
import json
import os
import re
import shutil
import uuid
import zipfile
from typing import Any, Callable

from .constants import _MAX_UPLOAD_BYTES
from .project_io import (
    SHA_RE,
    STORE_LOCK,
    ProjectError,
    atomic_write_bytes,
    atomic_write_json,
    collect_blob_refs,
    default_user_root,
    new_id,
    now as current_time,
    parse_rev,
    read_json,
    request_user,
    safe_id,
)
from .route_utils import json_route, match, read_json_object


SCHEMA_VERSION = 1
PROJECTS_DIRNAME = "vnccs_unicanvas"
TRASH_RETENTION_SECONDS = 30 * 24 * 3600
BLOB_GC_MIN_AGE_SECONDS = 24 * 3600
THUMBNAIL_SIZE = 512
MAX_SCENE_BYTES = _MAX_UPLOAD_BYTES * 4
MAX_IMPORT_BYTES = 1024 * 1024 * 1024
_PNG_PREFIX = "data:image/png;base64,"
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
ASSET_SCHEMA_VERSION = 1
ASSET_KINDS = ("character", "background", "prop", "pose", "preset")
RESERVED_ASSET_KINDS = ("skin",)
ASSET_SCOPES = ("project", "global")
ASSET_THUMBNAIL_SIZE = 256
MAX_ASSET_TAGS = 32


def _is_pixel_key(key: Any) -> bool:
    return isinstance(key, str) and key.lower().endswith("dataurl")


def decode_png_data_url(value: str) -> bytes:
    if not isinstance(value, str) or not value.startswith(_PNG_PREFIX):
        raise ProjectError("[VNCCS UniCanvas] Expected a PNG data URL.", 400)
    try:
        data = base64.b64decode(value[len(_PNG_PREFIX):], validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ProjectError("[VNCCS UniCanvas] Invalid PNG data URL.", 400) from exc
    if not data.startswith(_PNG_SIGNATURE):
        raise ProjectError("[VNCCS UniCanvas] The data is not a PNG image.", 400)
    return data


def _put_blob_file(path: str, sha: str, data: bytes) -> dict[str, Any]:
    if hashlib.sha256(data).hexdigest() != sha:
        raise ProjectError("[VNCCS UniCanvas] The blob does not match its hash.", 400)
    if not data.startswith(_PNG_SIGNATURE):
        raise ProjectError("[VNCCS UniCanvas] Blobs must be PNG images.", 400)
    created = not os.path.exists(path)
    if created:
        atomic_write_bytes(path, data)
    else:
        os.utime(path)  # a re-referenced blob is fresh again for the GC grace period
    return {"blob": f"{sha}.png", "created": created}


def _read_blob_file(path: str) -> bytes:
    if not os.path.isfile(path):
        raise ProjectError("[VNCCS UniCanvas] Blob not found.", 404)
    with open(path, "rb") as handle:
        return handle.read()


def _dehydrate_value(value: Any, blob_path: Callable[[str], str]) -> Any:
    """Inline PNG pixel fields become ``{blob, crop}`` refs in the store ``blob_path`` points into."""
    if isinstance(value, list):
        return [_dehydrate_value(item, blob_path) for item in value]
    if not isinstance(value, dict):
        return value
    out: dict[str, Any] = {}
    for key, item in value.items():
        if _is_pixel_key(key) and isinstance(item, str) and item.startswith(_PNG_PREFIX):
            data = decode_png_data_url(item)
            sha = hashlib.sha256(data).hexdigest()
            _put_blob_file(blob_path(sha), sha, data)
            ref_crop = value.get("hiresRect") if key.lower().startswith("hires") else value.get("crop")
            out[key] = {"blob": f"{sha}.png", "crop": ref_crop}
        elif _is_pixel_key(key) and isinstance(item, dict) and "blob" in item:
            sha = str(item.get("blob") or "")[:-4]
            if not os.path.isfile(blob_path(sha)):
                raise ProjectError("[VNCCS UniCanvas] The scene references a blob that was never uploaded.", 400, missingBlob=item.get("blob"))
            out[key] = {"blob": f"{sha}.png", "crop": item.get("crop")}
        else:
            out[key] = _dehydrate_value(item, blob_path)
    return out


def _hydrate_value(value: Any, read_blob: Callable[[str], bytes]) -> Any:
    if isinstance(value, list):
        return [_hydrate_value(item, read_blob) for item in value]
    if not isinstance(value, dict):
        return value
    out: dict[str, Any] = {}
    for key, item in value.items():
        if _is_pixel_key(key) and isinstance(item, dict) and "blob" in item:
            data = read_blob(str(item.get("blob") or "")[:-4])
            out[key] = _PNG_PREFIX + base64.b64encode(data).decode("ascii")
        else:
            out[key] = _hydrate_value(item, read_blob)
    return out


def _collect_unreferenced_blobs(record_dirs: list[str], blobs: str, now: float | None) -> list[str]:
    referenced: set[str] = set()
    for record_dir in record_dirs:
        for folder, _dirs, files in os.walk(record_dir):
            for name in files:
                if name.endswith(".json"):
                    try:
                        collect_blob_refs(read_json(os.path.join(folder, name)), referenced)
                    except (OSError, ValueError):
                        return []  # an unreadable record could hide references: collect nothing
    now = current_time() if now is None else now
    removed = []
    for name in os.listdir(blobs) if os.path.isdir(blobs) else []:
        sha = name[:-4] if name.endswith(".png") else ""
        path = os.path.join(blobs, name)
        if sha in referenced or not SHA_RE.match(sha):
            continue
        if now - os.path.getmtime(path) > BLOB_GC_MIN_AGE_SECONDS:
            os.remove(path)
            removed.append(sha)
    return removed


class ProjectStore:
    """File operations for one comfy user's projects."""

    def __init__(self, user_root: str, user: str = "default"):
        self.base = os.path.abspath(os.path.join(user_root, safe_id(user, "user"), PROJECTS_DIRNAME))
        self.root = os.path.join(self.base, "projects")
        self.trash = os.path.join(self.base, "trash")
        self.library = os.path.join(self.base, "library")

    # -- paths ---------------------------------------------------------------------------------

    def inside(self, path: str, root: str | None = None) -> str:
        root = os.path.abspath(root or self.root)
        resolved = os.path.abspath(path)
        if os.path.commonpath([root, resolved]) != root:
            raise ProjectError("[VNCCS UniCanvas] Path outside the projects directory.", 400)
        return resolved

    def _ensure_writable(self) -> None:
        try:
            os.makedirs(self.root, exist_ok=True)
            probe = os.path.join(self.root, f".write-{uuid.uuid4().hex[:8]}")
            with open(probe, "wb") as handle:
                handle.write(b"")
            os.remove(probe)
        except OSError as exc:
            raise ProjectError(f"[VNCCS UniCanvas] The ComfyUI user directory is not writable ({self.base}): {exc}", 500) from exc

    def project_dir(self, project_id: str) -> str:
        return self.inside(os.path.join(self.root, safe_id(project_id, "project id")))

    def _project_json(self, project_id: str) -> str:
        return os.path.join(self.project_dir(project_id), "project.json")

    def _scene_json(self, project_id: str, scene_id: str) -> str:
        return self.inside(os.path.join(self.project_dir(project_id), "scenes", safe_id(scene_id, "scene id"), "scene.json"))

    def blob_path(self, project_id: str, sha: str) -> str:
        if not isinstance(sha, str) or not SHA_RE.match(sha):
            raise ProjectError("[VNCCS UniCanvas] Invalid blob hash.", 400)
        return self.inside(os.path.join(self.project_dir(project_id), "blobs", f"{sha}.png"))

    def library_blob_path(self, sha: str) -> str:
        if not isinstance(sha, str) or not SHA_RE.match(sha):
            raise ProjectError("[VNCCS UniCanvas] Invalid blob hash.", 400)
        return self.inside(os.path.join(self.library, "blobs", f"{sha}.png"), self.library)

    def thumb_path(self, project_id: str, scene_id: str) -> str:
        return self.inside(os.path.join(self.project_dir(project_id), "thumbs", f"{safe_id(scene_id, 'scene id')}.png"))

    def get_thumb(self, project_id: str, scene_id: str) -> bytes:
        path = self.thumb_path(project_id, scene_id)
        if not os.path.isfile(path):
            raise ProjectError("[VNCCS UniCanvas] Thumbnail not found.", 404)
        with open(path, "rb") as handle:
            return handle.read()

    # -- projects ------------------------------------------------------------------------------

    def load_project(self, project_id: str) -> dict[str, Any]:
        path = self._project_json(project_id)
        if not os.path.isfile(path):
            raise ProjectError("[VNCCS UniCanvas] Project not found.", 404)
        return read_json(path)

    def _save_project(self, project: dict[str, Any]) -> dict[str, Any]:
        project["updatedAt"] = current_time()
        project["rev"] = int(project.get("rev") or 0) + 1
        atomic_write_json(self._project_json(project["id"]), project)
        return project

    def list_projects(self) -> list[dict[str, Any]]:
        self.purge_trash()
        if not os.path.isdir(self.root):
            return []
        items = []
        for name in sorted(os.listdir(self.root)):
            path = os.path.join(self.root, name, "project.json")
            if not os.path.isfile(path):
                continue
            try:
                project = read_json(path)
            except (OSError, ValueError):
                continue
            scenes = project.get("scenes") or []
            first = next((scene for scene in scenes if scene.get("id") == project.get("activeSceneId")), scenes[0] if scenes else None)
            items.append({
                "id": project.get("id"), "name": project.get("name"), "updatedAt": project.get("updatedAt"),
                "sceneCount": len(scenes), "thumbnail": first.get("thumbnail") if first else None,
            })
        items.sort(key=lambda item: item.get("updatedAt") or 0, reverse=True)
        return items

    def create_project(self, name: str = "", settings: dict[str, Any] | None = None, project_id: str | None = None) -> dict[str, Any]:
        with STORE_LOCK:
            self._ensure_writable()
            project_id = safe_id(project_id, "project id") if project_id else new_id("prj")
            directory = self.project_dir(project_id)
            if os.path.exists(directory):
                raise ProjectError("[VNCCS UniCanvas] A project with this id already exists.", 409)
            for sub in ("scenes", "blobs", "thumbs", "assets", "history"):
                os.makedirs(os.path.join(directory, sub), exist_ok=True)
            now = current_time()
            project = {
                "schemaVersion": SCHEMA_VERSION, "id": project_id, "name": str(name or "Untitled project")[:200],
                "createdAt": now, "updatedAt": now, "rev": 0, "scenes": [], "activeSceneId": None,
                "settings": settings if isinstance(settings, dict) else {},
            }
            self._save_project(project)
            self.create_scene(project_id, name="Scene 1")
            return self.load_project(project_id)

    def open_project(self, project_id: str) -> dict[str, Any]:
        project = self.load_project(project_id)
        self.collect_garbage(project_id)
        return project

    def patch_project(self, project_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with STORE_LOCK:
            project = self.load_project(project_id)
            if "name" in patch:
                name = str(patch.get("name") or "").strip()
                if not name:
                    raise ProjectError("[VNCCS UniCanvas] A project needs a name.", 400)
                project["name"] = name[:200]
            if isinstance(patch.get("settings"), dict):
                project["settings"] = patch["settings"]
            if patch.get("activeSceneId") and any(scene["id"] == patch["activeSceneId"] for scene in project["scenes"]):
                project["activeSceneId"] = patch["activeSceneId"]
            order = patch.get("sceneOrder")
            if isinstance(order, list):
                by_id = {scene["id"]: scene for scene in project["scenes"]}
                if sorted(order) != sorted(by_id):
                    raise ProjectError("[VNCCS UniCanvas] The scene order must list every scene once.", 400)
                project["scenes"] = [by_id[scene_id] for scene_id in order]
                for index, scene in enumerate(project["scenes"]):
                    scene["order"] = index
            return self._save_project(project)

    def duplicate_project(self, project_id: str, name: str | None = None) -> dict[str, Any]:
        with STORE_LOCK:
            source = self.load_project(project_id)
            self._ensure_writable()
            copy_id = new_id("prj")
            shutil.copytree(self.project_dir(project_id), self.project_dir(copy_id))
            project = self.load_project(copy_id)
            project["id"] = copy_id
            project["name"] = str(name or f"{source.get('name') or 'Project'} copy")[:200]
            project["createdAt"] = current_time()
            project["rev"] = 0
            return self._save_project(project)

    def delete_project(self, project_id: str) -> None:
        with STORE_LOCK:
            directory = self.project_dir(project_id)
            if not os.path.isfile(os.path.join(directory, "project.json")):
                raise ProjectError("[VNCCS UniCanvas] Project not found.", 404)
            os.makedirs(self.trash, exist_ok=True)
            target = self.inside(os.path.join(self.trash, f"{safe_id(project_id, 'project id')}-{int(current_time())}"), self.trash)
            shutil.move(directory, target)

    def purge_trash(self, now: float | None = None) -> int:
        if not os.path.isdir(self.trash):
            return 0
        now = current_time() if now is None else now
        removed = 0
        for name in os.listdir(self.trash):
            path = self.inside(os.path.join(self.trash, name), self.trash)
            match = re.search(r"-(\d+)$", name)
            stamp = int(match.group(1)) if match else os.path.getmtime(path)
            if now - stamp > TRASH_RETENTION_SECONDS:
                shutil.rmtree(path, ignore_errors=True)
                removed += 1
        return removed

    # -- blobs ---------------------------------------------------------------------------------

    def put_blob(self, project_id: str, sha: str, data: bytes) -> dict[str, Any]:
        self.load_project(project_id)
        return _put_blob_file(self.blob_path(project_id, sha), sha, data)

    def store_png(self, project_id: str, data: bytes) -> str:
        sha = hashlib.sha256(data).hexdigest()
        self.put_blob(project_id, sha, data)
        return sha

    def get_blob(self, project_id: str, sha: str) -> bytes:
        return _read_blob_file(self.blob_path(project_id, sha))

    def get_library_blob(self, sha: str) -> bytes:
        return _read_blob_file(self.library_blob_path(sha))

    def dehydrate(self, project_id: str, value: Any) -> Any:
        """Replaces every inline PNG pixel field by a blob ref; refs the client sent must exist."""
        return _dehydrate_value(value, lambda sha: self.blob_path(project_id, sha))

    def hydrate(self, project_id: str, value: Any) -> Any:
        """Turns blob refs back into PNG data URLs (for rendering a scene in node mode)."""
        return _hydrate_value(value, lambda sha: self.get_blob(project_id, sha))

    def collect_garbage(self, project_id: str, now: float | None = None) -> list[str]:
        """Deletes blobs no scene, asset or history record references and that are older than 24 h."""
        with STORE_LOCK:
            directory = self.project_dir(project_id)
            return _collect_unreferenced_blobs(
                [os.path.join(directory, sub) for sub in ("scenes", "assets", "history")],
                os.path.join(directory, "blobs"), now)

    def collect_library_garbage(self, now: float | None = None) -> list[str]:
        """The same GC for the global library: blobs no global asset references."""
        with STORE_LOCK:
            return _collect_unreferenced_blobs([os.path.join(self.library, "assets")], os.path.join(self.library, "blobs"), now)

    # -- scenes --------------------------------------------------------------------------------

    def _scene_entry(self, project: dict[str, Any], scene_id: str) -> dict[str, Any]:
        entry = next((scene for scene in project["scenes"] if scene["id"] == scene_id), None)
        if entry is None:
            raise ProjectError("[VNCCS UniCanvas] Scene not found.", 404)
        return entry

    def create_scene(self, project_id: str, name: str = "", from_scene_id: str | None = None, state: dict[str, Any] | None = None) -> dict[str, Any]:
        with STORE_LOCK:
            project = self.load_project(project_id)
            scene_id = new_id("scn")
            if from_scene_id:
                source = self._scene_entry(project, safe_id(from_scene_id, "scene id"))
                stored = read_json(self._scene_json(project_id, source["id"]))
                name = name or f"{source.get('name') or 'Scene'} copy"
                thumb = self.thumb_path(project_id, source["id"])
                if os.path.isfile(thumb):
                    shutil.copyfile(thumb, self.thumb_path(project_id, scene_id))
            else:
                stored = self.dehydrate(project_id, state if isinstance(state, dict) else {"layers": []})
            atomic_write_json(self._scene_json(project_id, scene_id), stored)
            now = current_time()
            entry = {
                "id": scene_id, "name": str(name or f"Scene {len(project['scenes']) + 1}")[:200],
                "order": len(project["scenes"]), "thumbnail": None, "updatedAt": now, "rev": 1,
            }
            if os.path.isfile(self.thumb_path(project_id, scene_id)):
                entry["thumbnail"] = f"thumbs/{scene_id}.png"
            project["scenes"].append(entry)
            project["activeSceneId"] = project.get("activeSceneId") or scene_id
            self._save_project(project)
            return entry

    def get_scene(self, project_id: str, scene_id: str, hydrate: bool = False) -> dict[str, Any]:
        project = self.load_project(project_id)
        entry = self._scene_entry(project, safe_id(scene_id, "scene id"))
        state = read_json(self._scene_json(project_id, entry["id"]))
        return {**entry, "state": self.hydrate(project_id, state) if hydrate else state}

    def put_scene(self, project_id: str, scene_id: str, state: dict[str, Any], if_rev: Any = None,
                  name: str | None = None, thumbnail: str | None = None) -> dict[str, Any]:
        if not isinstance(state, dict):
            raise ProjectError("[VNCCS UniCanvas] The scene state must be an object.", 400)
        expected_rev = parse_rev(if_rev)
        # Rendering the thumbnail is pure CPU work: keep it out of the store-wide lock.
        thumb_png = _thumbnail_png(decode_png_data_url(thumbnail)) if thumbnail else None
        with STORE_LOCK:
            project = self.load_project(project_id)
            entry = self._scene_entry(project, safe_id(scene_id, "scene id"))
            if expected_rev is not None and expected_rev != int(entry.get("rev") or 0):
                raise ProjectError("[VNCCS UniCanvas] The scene changed elsewhere.", 409, rev=entry.get("rev"))
            stored = self.dehydrate(project_id, state)
            atomic_write_json(self._scene_json(project_id, entry["id"]), stored)
            if thumb_png is not None:
                atomic_write_bytes(self.thumb_path(project_id, entry["id"]), thumb_png)
                entry["thumbnail"] = f"thumbs/{entry['id']}.png"
            if name:
                entry["name"] = str(name)[:200]
            entry["rev"] = int(entry.get("rev") or 0) + 1
            entry["updatedAt"] = current_time()
            self._save_project(project)
            return entry

    def delete_scene(self, project_id: str, scene_id: str) -> dict[str, Any]:
        with STORE_LOCK:
            project = self.load_project(project_id)
            entry = self._scene_entry(project, safe_id(scene_id, "scene id"))
            if len(project["scenes"]) <= 1:
                raise ProjectError("[VNCCS UniCanvas] A project keeps at least one scene.", 400)
            shutil.rmtree(os.path.dirname(self._scene_json(project_id, entry["id"])), ignore_errors=True)
            thumb = self.thumb_path(project_id, entry["id"])
            if os.path.isfile(thumb):
                os.remove(thumb)
            project["scenes"] = [scene for scene in project["scenes"] if scene["id"] != entry["id"]]
            for index, scene in enumerate(project["scenes"]):
                scene["order"] = index
            if project.get("activeSceneId") == entry["id"]:
                project["activeSceneId"] = project["scenes"][0]["id"]
            return self._save_project(project)

    # -- assets (Plan 10.4) ----------------------------------------------------------------------

    def _asset_scope(self, scope: Any, project_id: Any = None) -> tuple[str, Callable[[str], str], str]:
        """(assets dir, blob path for a sha, root every path must stay inside) of one scope."""
        if scope == "global":
            return os.path.join(self.library, "assets"), self.library_blob_path, self.library
        if scope == "project":
            self.load_project(str(project_id or ""))
            directory = self.project_dir(str(project_id))
            return os.path.join(directory, "assets"), lambda sha: self.blob_path(str(project_id), sha), directory
        raise ProjectError("[VNCCS UniCanvas] Invalid asset scope.", 400)

    def _asset_json(self, scope: Any, project_id: Any, asset_id: Any) -> str:
        assets, _blob_path, root = self._asset_scope(scope, project_id)
        return self.inside(os.path.join(assets, safe_id(asset_id, "asset id"), "asset.json"), root)

    def _ensure_library_writable(self) -> None:
        try:
            os.makedirs(os.path.join(self.library, "assets"), exist_ok=True)
            os.makedirs(os.path.join(self.library, "blobs"), exist_ok=True)
        except OSError as exc:
            raise ProjectError(f"[VNCCS UniCanvas] The ComfyUI user directory is not writable ({self.base}): {exc}", 500) from exc

    @staticmethod
    def _asset_kind(kind: Any) -> str:
        kind = str(kind or "")
        if kind in RESERVED_ASSET_KINDS:
            raise ProjectError(f"[VNCCS UniCanvas] The asset kind '{kind}' is reserved and not supported yet.", 400)
        if kind not in ASSET_KINDS:
            raise ProjectError("[VNCCS UniCanvas] Unknown asset kind.", 400)
        return kind

    @staticmethod
    def _asset_tags(tags: Any) -> list[str]:
        if not isinstance(tags, list):
            return []
        clean = []
        for tag in tags:
            text = str(tag or "").strip()[:64]
            if text and text not in clean:
                clean.append(text)
        return clean[:MAX_ASSET_TAGS]

    def _asset_thumbnail(self, blob_path: Callable[[str], str], payload: dict[str, Any], data: dict[str, Any]) -> dict[str, Any] | None:
        source = payload.get("thumbnail")
        if not (isinstance(source, str) and source.startswith(_PNG_PREFIX)):
            source = data.get("imageDataURL") if isinstance(data.get("imageDataURL"), str) else None
        if not source or not source.startswith(_PNG_PREFIX):
            return None
        png = _thumbnail_png(decode_png_data_url(source), ASSET_THUMBNAIL_SIZE)
        sha = hashlib.sha256(png).hexdigest()
        _put_blob_file(blob_path(sha), sha, png)
        return {"blob": f"{sha}.png", "crop": None}

    @staticmethod
    def _asset_summary(asset: dict[str, Any], scope: str) -> dict[str, Any]:
        thumb = asset.get("thumbnail")
        return {
            "id": asset.get("id"), "kind": asset.get("kind"), "name": asset.get("name"), "tags": asset.get("tags") or [],
            "updatedAt": asset.get("updatedAt"), "rev": asset.get("rev"), "scope": scope,
            "thumbnail": thumb.get("blob") if isinstance(thumb, dict) else None,
        }

    def list_assets(self, scope: Any, project_id: Any = None, kind: Any = None, query: Any = None) -> list[dict[str, Any]]:
        assets, _blob_path, _root = self._asset_scope(scope, project_id)
        needle = str(query or "").strip().lower()
        items = []
        for name in sorted(os.listdir(assets)) if os.path.isdir(assets) else []:
            path = os.path.join(assets, name, "asset.json")
            if not os.path.isfile(path):
                continue
            try:
                asset = read_json(path)
            except (OSError, ValueError):
                continue
            if kind and asset.get("kind") != kind:
                continue
            if needle and needle not in str(asset.get("name") or "").lower() \
                    and not any(needle in str(tag).lower() for tag in asset.get("tags") or []):
                continue
            items.append(self._asset_summary(asset, str(scope)))
        items.sort(key=lambda item: item.get("updatedAt") or 0, reverse=True)
        return items

    def get_asset(self, scope: Any, project_id: Any, asset_id: Any) -> dict[str, Any]:
        path = self._asset_json(scope, project_id, asset_id)
        if not os.path.isfile(path):
            raise ProjectError("[VNCCS UniCanvas] Asset not found.", 404)
        return {**read_json(path), "scope": str(scope)}

    def create_asset(self, scope: Any, project_id: Any, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ProjectError("[VNCCS UniCanvas] Expected a JSON object.", 400)
        with STORE_LOCK:
            if scope == "global":
                self._ensure_library_writable()
            kind = self._asset_kind(payload.get("kind"))
            _assets, blob_path, _root = self._asset_scope(scope, project_id)
            asset_id = new_id("ast")
            data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
            now = current_time()
            asset = {
                "schemaVersion": ASSET_SCHEMA_VERSION, "id": asset_id, "kind": kind,
                "name": str(payload.get("name") or kind.capitalize()).strip()[:200] or kind.capitalize(),
                "tags": self._asset_tags(payload.get("tags")), "createdAt": now, "updatedAt": now, "rev": 1,
                "thumbnail": self._asset_thumbnail(blob_path, payload, data),
                "data": _dehydrate_value(data, blob_path),
            }
            atomic_write_json(self._asset_json(scope, project_id, asset_id), asset)
            return {**asset, "scope": str(scope)}

    def put_asset(self, scope: Any, project_id: Any, asset_id: Any, payload: dict[str, Any]) -> dict[str, Any]:
        """Push to library: replaces the asset's data (and name / tags when given); ``ifRev`` guards races."""
        if not isinstance(payload, dict):
            raise ProjectError("[VNCCS UniCanvas] Expected a JSON object.", 400)
        with STORE_LOCK:
            asset = self.get_asset(scope, project_id, asset_id)
            asset.pop("scope", None)
            if_rev = parse_rev(payload.get("ifRev"))
            if if_rev is not None and if_rev != int(asset.get("rev") or 0):
                raise ProjectError("[VNCCS UniCanvas] The asset changed elsewhere.", 409, rev=asset.get("rev"))
            _assets, blob_path, _root = self._asset_scope(scope, project_id)
            if "kind" in payload and self._asset_kind(payload.get("kind")) != asset.get("kind"):
                raise ProjectError("[VNCCS UniCanvas] An asset keeps its kind.", 400)
            if "name" in payload:
                name = str(payload.get("name") or "").strip()
                if not name:
                    raise ProjectError("[VNCCS UniCanvas] An asset needs a name.", 400)
                asset["name"] = name[:200]
            if "tags" in payload:
                asset["tags"] = self._asset_tags(payload.get("tags"))
            if isinstance(payload.get("data"), dict):
                asset["data"] = _dehydrate_value(payload["data"], blob_path)
                thumbnail = self._asset_thumbnail(blob_path, payload, payload["data"])
                if thumbnail or payload.get("thumbnail") is not None:
                    asset["thumbnail"] = thumbnail
            asset["rev"] = int(asset.get("rev") or 0) + 1
            asset["updatedAt"] = current_time()
            atomic_write_json(self._asset_json(scope, project_id, asset["id"]), asset)
            self._collect_scope_garbage(scope)
            return {**asset, "scope": str(scope)}

    def delete_asset(self, scope: Any, project_id: Any, asset_id: Any) -> None:
        with STORE_LOCK:
            path = self._asset_json(scope, project_id, asset_id)
            if not os.path.isfile(path):
                raise ProjectError("[VNCCS UniCanvas] Asset not found.", 404)
            shutil.rmtree(os.path.dirname(path))
            self._collect_scope_garbage(scope)

    def _collect_scope_garbage(self, scope: Any) -> None:
        """After a write that can orphan global library blobs, collect them; listing never does.

        Project-scope blobs are collected when the project opens (``open_project``)."""
        if scope == "global":
            self.collect_library_garbage()

    # -- export / import -----------------------------------------------------------------------

    def export_zip(self, project_id: str) -> bytes:
        directory = self.project_dir(project_id)
        self.load_project(project_id)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for folder, dirs, files in os.walk(directory):
                dirs.sort()
                rel_folder = os.path.relpath(folder, directory)
                if rel_folder != "." and not files and not dirs:
                    archive.writestr(f"{rel_folder.replace(os.sep, '/')}/", b"")
                for name in sorted(files):
                    if name.endswith(".tmp"):
                        continue
                    path = os.path.join(folder, name)
                    archive.write(path, os.path.relpath(path, directory).replace(os.sep, "/"))
        return buffer.getvalue()

    def import_zip(self, data: bytes) -> dict[str, Any]:
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as exc:
            raise ProjectError("[VNCCS UniCanvas] The file is not a project zip.", 400) from exc
        with archive, STORE_LOCK:
            infos = archive.infolist()
            if sum(info.file_size for info in infos) > MAX_IMPORT_BYTES:
                raise ProjectError("[VNCCS UniCanvas] The project zip is too large.", 413)
            try:
                project = json.loads(archive.read("project.json").decode("utf-8"))
            except (KeyError, ValueError) as exc:
                raise ProjectError("[VNCCS UniCanvas] The zip has no valid project.json.", 400) from exc
            if not isinstance(project, dict):
                raise ProjectError("[VNCCS UniCanvas] The zip has no valid project.json.", 400)
            self._ensure_writable()
            original = str(project.get("id") or "")
            try:
                project_id = safe_id(original, "project id")
            except ProjectError:
                project_id = new_id("prj")
            if os.path.exists(self.project_dir(project_id)):
                project_id = new_id("prj")
            directory = self.project_dir(project_id)
            staging = self.inside(os.path.join(self.root, f".import-{uuid.uuid4().hex[:8]}"))
            try:
                for info in infos:
                    name = info.filename
                    if name.startswith("/") or "\\" in name or ".." in name.split("/") or ":" in name:
                        raise ProjectError("[VNCCS UniCanvas] The zip contains an unsafe path.", 400)
                    target = self.inside(os.path.join(staging, *name.split("/")), staging)
                    if name.endswith("/"):
                        os.makedirs(target, exist_ok=True)
                        continue
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    with archive.open(info) as source, open(target, "wb") as handle:
                        shutil.copyfileobj(source, handle)
                blobs = os.path.join(staging, "blobs")
                for name in os.listdir(blobs) if os.path.isdir(blobs) else []:
                    with open(os.path.join(blobs, name), "rb") as handle:
                        if not name.endswith(".png") or hashlib.sha256(handle.read()).hexdigest() != name[:-4]:
                            raise ProjectError("[VNCCS UniCanvas] A blob in the zip does not match its hash.", 400)
                for sub in ("scenes", "blobs", "thumbs", "assets", "history"):
                    os.makedirs(os.path.join(staging, sub), exist_ok=True)
                project["id"] = project_id
                atomic_write_json(os.path.join(staging, "project.json"), project)
                os.replace(staging, directory)
            finally:
                shutil.rmtree(staging, ignore_errors=True)
            return self.load_project(project_id)


def _thumbnail_png(data: bytes, size: int = THUMBNAIL_SIZE) -> bytes:
    from PIL import Image

    with Image.open(io.BytesIO(data)) as image:
        image.load()
        image.thumbnail((size, size))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()


def load_project_scene_state(project_id: str, scene_id: str, user: str = "default", user_root: str | None = None) -> dict[str, Any]:
    """A scene as a plain serialized state (pixel fields as data URLs), for node-mode rendering."""
    store = ProjectStore(user_root or default_user_root(), user or "default")
    return store.get_scene(project_id, scene_id, hydrate=True)["state"]


# -- aiohttp routes ------------------------------------------------------------------------------

def project_routes(web, content_length_ok: Callable[[Any, int], bool],
                   store_factory: Callable[[str], ProjectStore] | None = None) -> list[tuple[str, str, Callable]]:
    """(method, path, handler) triples for ``routes.py`` to register under /vnccs/unicanvas/projects and /library.

    Generation history (``.../{id}/history``) has its own table in ``history.py``.
    """
    base = "/vnccs/unicanvas/projects"

    def store_for(request) -> ProjectStore:
        user = request_user(request)
        return store_factory(user) if store_factory else ProjectStore(default_user_root(), user)

    def handler(max_bytes: int, work):
        async def run(request):
            return await work(request, store_for(request))
        return json_route(web, content_length_ok, max_bytes, run, subject="Project", failure="Project storage failed")

    body = read_json_object
    m = match

    async def list_(request, store):
        return {"projects": await asyncio.to_thread(store.list_projects)}

    async def create(request, store):
        payload = await body(request)
        return await asyncio.to_thread(store.create_project, payload.get("name") or "", payload.get("settings"))

    async def get(request, store):
        return await asyncio.to_thread(store.open_project, m(request, "id"))

    async def patch(request, store):
        return await asyncio.to_thread(store.patch_project, m(request, "id"), await body(request))

    async def duplicate(request, store):
        payload = await body(request)
        return await asyncio.to_thread(store.duplicate_project, m(request, "id"), payload.get("name"))

    async def delete(request, store):
        await asyncio.to_thread(store.delete_project, m(request, "id"))
        return {"deleted": True}

    async def create_scene(request, store):
        payload = await body(request)
        return await asyncio.to_thread(store.create_scene, m(request, "id"), payload.get("name") or "",
                                       payload.get("fromSceneId"), payload.get("state"))

    async def get_scene(request, store):
        return await asyncio.to_thread(store.get_scene, m(request, "id"), m(request, "scene"))

    async def put_scene(request, store):
        payload = await body(request)
        return await asyncio.to_thread(store.put_scene, m(request, "id"), m(request, "scene"), payload.get("state"),
                                       payload.get("ifRev"), payload.get("name"), payload.get("thumbnail"))

    async def delete_scene(request, store):
        return await asyncio.to_thread(store.delete_scene, m(request, "id"), m(request, "scene"))

    async def put_blob(request, store):
        return await asyncio.to_thread(store.put_blob, m(request, "id"), m(request, "sha"), await request.read())

    async def get_blob(request, store):
        data = await asyncio.to_thread(store.get_blob, m(request, "id"), m(request, "sha"))
        return web.Response(body=data, content_type="image/png", headers={"Cache-Control": "private, max-age=31536000, immutable"})

    async def get_thumb(request, store):
        data = await asyncio.to_thread(store.get_thumb, m(request, "id"), m(request, "scene"))
        return web.Response(body=data, content_type="image/png", headers={"Cache-Control": "no-cache"})

    async def export(request, store):
        project = await asyncio.to_thread(store.load_project, m(request, "id"))
        data = await asyncio.to_thread(store.export_zip, m(request, "id"))
        filename = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(project.get("name") or "project")).strip("_") or "project"
        return web.Response(body=data, content_type="application/zip",
                            headers={"Content-Disposition": f'attachment; filename="{filename}.vnccs-project.zip"'})

    async def import_(request, store):
        return await asyncio.to_thread(store.import_zip, await request.read())

    def asset_scope(request):
        return ("project", m(request, "id")) if m(request, "id") else ("global", None)

    async def list_assets(request, store):
        scope, project_id = asset_scope(request)
        query = getattr(request, "query", None) or {}
        return {"assets": await asyncio.to_thread(store.list_assets, scope, project_id, query.get("kind") or None, query.get("q") or None)}

    async def create_asset(request, store):
        scope, project_id = asset_scope(request)
        return await asyncio.to_thread(store.create_asset, scope, project_id, await body(request))

    async def get_asset(request, store):
        scope, project_id = asset_scope(request)
        return await asyncio.to_thread(store.get_asset, scope, project_id, m(request, "asset"))

    async def put_asset(request, store):
        scope, project_id = asset_scope(request)
        return await asyncio.to_thread(store.put_asset, scope, project_id, m(request, "asset"), await body(request))

    async def delete_asset(request, store):
        scope, project_id = asset_scope(request)
        await asyncio.to_thread(store.delete_asset, scope, project_id, m(request, "asset"))
        return {"deleted": True}

    async def get_library_blob(request, store):
        data = await asyncio.to_thread(store.get_library_blob, m(request, "sha"))
        return web.Response(body=data, content_type="image/png", headers={"Cache-Control": "private, max-age=31536000, immutable"})

    library = "/vnccs/unicanvas/library"
    small = 1024 * 1024
    return [
        ("GET", base, handler(small, list_)),
        ("POST", base, handler(small, create)),
        ("POST", f"{base}/import", handler(MAX_IMPORT_BYTES, import_)),
        ("GET", f"{base}/{{id}}", handler(small, get)),
        ("PATCH", f"{base}/{{id}}", handler(small, patch)),
        ("DELETE", f"{base}/{{id}}", handler(small, delete)),
        ("POST", f"{base}/{{id}}/duplicate", handler(small, duplicate)),
        ("POST", f"{base}/{{id}}/export", handler(small, export)),
        ("POST", f"{base}/{{id}}/scenes", handler(MAX_SCENE_BYTES, create_scene)),
        ("GET", f"{base}/{{id}}/scenes/{{scene}}", handler(small, get_scene)),
        ("PUT", f"{base}/{{id}}/scenes/{{scene}}", handler(MAX_SCENE_BYTES, put_scene)),
        ("DELETE", f"{base}/{{id}}/scenes/{{scene}}", handler(small, delete_scene)),
        ("GET", f"{base}/{{id}}/thumbs/{{scene}}", handler(small, get_thumb)),
        ("PUT", f"{base}/{{id}}/blobs/{{sha}}", handler(_MAX_UPLOAD_BYTES, put_blob)),
        ("GET", f"{base}/{{id}}/blobs/{{sha}}", handler(small, get_blob)),
        # Asset library (Plan 10.4): project scope under the project, global scope under /library.
        ("GET", f"{base}/{{id}}/assets", handler(small, list_assets)),
        ("POST", f"{base}/{{id}}/assets", handler(MAX_SCENE_BYTES, create_asset)),
        ("GET", f"{base}/{{id}}/assets/{{asset}}", handler(small, get_asset)),
        ("PUT", f"{base}/{{id}}/assets/{{asset}}", handler(MAX_SCENE_BYTES, put_asset)),
        ("DELETE", f"{base}/{{id}}/assets/{{asset}}", handler(small, delete_asset)),
        ("GET", f"{library}/assets", handler(small, list_assets)),
        ("POST", f"{library}/assets", handler(MAX_SCENE_BYTES, create_asset)),
        ("GET", f"{library}/assets/{{asset}}", handler(small, get_asset)),
        ("PUT", f"{library}/assets/{{asset}}", handler(MAX_SCENE_BYTES, put_asset)),
        ("DELETE", f"{library}/assets/{{asset}}", handler(small, delete_asset)),
        ("GET", f"{library}/blobs/{{sha}}", handler(small, get_library_blob)),
    ]
