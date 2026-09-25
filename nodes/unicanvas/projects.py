"""Durable UniCanvas project storage (Plan 10.2).

A project holds several scenes and lives in the ComfyUI user directory, never in the temp
directory the state cache uses (ComfyUI wipes that on startup)::

    <user dir>/<comfy user>/vnccs_unicanvas/projects/<projectId>/
        project.json                 {schemaVersion, id, name, createdAt, updatedAt, rev, scenes, activeSceneId, settings}
        scenes/<sceneId>/scene.json  the buildSerializedState shape, pixel fields replaced by blob refs
        blobs/<sha256>.png           content-addressed pixels shared by every scene of the project
        thumbs/<sceneId>.png         512 px scene thumbnail
        assets/                      reserved for Plan 10.4
        history/<historyId>.json     generation history records (Plan 10.5, history.py)
    <user dir>/<comfy user>/vnccs_unicanvas/trash/<projectId>-<timestamp>/   deleted projects, purged after 30 days

``ProjectStore`` holds the file logic and is what the tests exercise; ``project_routes`` wraps it
in aiohttp handlers that ``routes.py`` registers.
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
import threading
import time
import uuid
import zipfile
from typing import Any, Callable

from .constants import _MAX_UPLOAD_BYTES
from .state import _SAFE_ID_RE


SCHEMA_VERSION = 1
PROJECTS_DIRNAME = "vnccs_unicanvas"
TRASH_RETENTION_SECONDS = 30 * 24 * 3600
BLOB_GC_MIN_AGE_SECONDS = 24 * 3600
THUMBNAIL_SIZE = 512
MAX_SCENE_BYTES = _MAX_UPLOAD_BYTES * 4
MAX_IMPORT_BYTES = 1024 * 1024 * 1024
_SHA_RE = re.compile(r"^[0-9a-f]{64}$")
_PNG_PREFIX = "data:image/png;base64,"
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_STORE_LOCK = threading.RLock()


class ProjectError(Exception):
    """An error a route turns into ``{"error": ...}`` with ``status``."""

    def __init__(self, message: str, status: int = 400, **extra: Any):
        super().__init__(message)
        self.status = status
        self.extra = extra


def _safe_id(value: Any, what: str = "id") -> str:
    raw = str(value or "")
    safe = _SAFE_ID_RE.sub("_", raw)[:96].strip("_")
    if not safe or safe != raw:
        raise ProjectError(f"[VNCCS UniCanvas] Invalid {what}.", 400)
    return safe


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _now() -> float:
    return time.time()


def _is_pixel_key(key: Any) -> bool:
    return isinstance(key, str) and key.lower().endswith("dataurl")


def _atomic_write_bytes(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{uuid.uuid4().hex[:8]}.tmp"
    with open(tmp, "wb") as handle:
        handle.write(data)
    os.replace(tmp, path)


def _atomic_write_json(path: str, value: Any) -> None:
    _atomic_write_bytes(path, json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _read_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


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


def _collect_blob_refs(value: Any, into: set[str]) -> set[str]:
    if isinstance(value, dict):
        blob = value.get("blob")
        if isinstance(blob, str) and blob.endswith(".png") and _SHA_RE.match(blob[:-4]):
            into.add(blob[:-4])
        for item in value.values():
            _collect_blob_refs(item, into)
    elif isinstance(value, list):
        for item in value:
            _collect_blob_refs(item, into)
    return into


def default_user_root() -> str:
    """``<ComfyUI user directory>``; raises if ComfyUI does not provide one."""
    import folder_paths

    getter = getattr(folder_paths, "get_user_directory", None)
    root = getter() if callable(getter) else None
    if not root:
        raise ProjectError("[VNCCS UniCanvas] The ComfyUI user directory is not available.", 500)
    return str(root)


class ProjectStore:
    """File operations for one comfy user's projects."""

    def __init__(self, user_root: str, user: str = "default"):
        self.base = os.path.abspath(os.path.join(user_root, _safe_id(user, "user"), PROJECTS_DIRNAME))
        self.root = os.path.join(self.base, "projects")
        self.trash = os.path.join(self.base, "trash")

    # -- paths ---------------------------------------------------------------------------------

    def _inside(self, path: str, root: str | None = None) -> str:
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
        return self._inside(os.path.join(self.root, _safe_id(project_id, "project id")))

    def _project_json(self, project_id: str) -> str:
        return os.path.join(self.project_dir(project_id), "project.json")

    def _scene_json(self, project_id: str, scene_id: str) -> str:
        return self._inside(os.path.join(self.project_dir(project_id), "scenes", _safe_id(scene_id, "scene id"), "scene.json"))

    def blob_path(self, project_id: str, sha: str) -> str:
        if not isinstance(sha, str) or not _SHA_RE.match(sha):
            raise ProjectError("[VNCCS UniCanvas] Invalid blob hash.", 400)
        return self._inside(os.path.join(self.project_dir(project_id), "blobs", f"{sha}.png"))

    def thumb_path(self, project_id: str, scene_id: str) -> str:
        return self._inside(os.path.join(self.project_dir(project_id), "thumbs", f"{_safe_id(scene_id, 'scene id')}.png"))

    # -- projects ------------------------------------------------------------------------------

    def load_project(self, project_id: str) -> dict[str, Any]:
        path = self._project_json(project_id)
        if not os.path.isfile(path):
            raise ProjectError("[VNCCS UniCanvas] Project not found.", 404)
        return _read_json(path)

    def _save_project(self, project: dict[str, Any]) -> dict[str, Any]:
        project["updatedAt"] = _now()
        project["rev"] = int(project.get("rev") or 0) + 1
        _atomic_write_json(self._project_json(project["id"]), project)
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
                project = _read_json(path)
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
        with _STORE_LOCK:
            self._ensure_writable()
            project_id = _safe_id(project_id, "project id") if project_id else _new_id("prj")
            directory = self.project_dir(project_id)
            if os.path.exists(directory):
                raise ProjectError("[VNCCS UniCanvas] A project with this id already exists.", 409)
            for sub in ("scenes", "blobs", "thumbs", "assets", "history"):
                os.makedirs(os.path.join(directory, sub), exist_ok=True)
            now = _now()
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
        with _STORE_LOCK:
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
        with _STORE_LOCK:
            source = self.load_project(project_id)
            self._ensure_writable()
            new_id = _new_id("prj")
            shutil.copytree(self.project_dir(project_id), self.project_dir(new_id))
            project = self.load_project(new_id)
            project["id"] = new_id
            project["name"] = str(name or f"{source.get('name') or 'Project'} copy")[:200]
            project["createdAt"] = _now()
            project["rev"] = 0
            return self._save_project(project)

    def delete_project(self, project_id: str) -> None:
        with _STORE_LOCK:
            directory = self.project_dir(project_id)
            if not os.path.isfile(os.path.join(directory, "project.json")):
                raise ProjectError("[VNCCS UniCanvas] Project not found.", 404)
            os.makedirs(self.trash, exist_ok=True)
            target = self._inside(os.path.join(self.trash, f"{_safe_id(project_id, 'project id')}-{int(_now())}"), self.trash)
            shutil.move(directory, target)

    def purge_trash(self, now: float | None = None) -> int:
        if not os.path.isdir(self.trash):
            return 0
        now = _now() if now is None else now
        removed = 0
        for name in os.listdir(self.trash):
            path = self._inside(os.path.join(self.trash, name), self.trash)
            match = re.search(r"-(\d+)$", name)
            stamp = int(match.group(1)) if match else os.path.getmtime(path)
            if now - stamp > TRASH_RETENTION_SECONDS:
                shutil.rmtree(path, ignore_errors=True)
                removed += 1
        return removed

    # -- blobs ---------------------------------------------------------------------------------

    def put_blob(self, project_id: str, sha: str, data: bytes) -> dict[str, Any]:
        self.load_project(project_id)
        path = self.blob_path(project_id, sha)
        if hashlib.sha256(data).hexdigest() != sha:
            raise ProjectError("[VNCCS UniCanvas] The blob does not match its hash.", 400)
        if not data.startswith(_PNG_SIGNATURE):
            raise ProjectError("[VNCCS UniCanvas] Blobs must be PNG images.", 400)
        created = not os.path.exists(path)
        if created:
            _atomic_write_bytes(path, data)
        else:
            os.utime(path)  # a re-referenced blob is fresh again for the GC grace period
        return {"blob": f"{sha}.png", "created": created}

    def store_png(self, project_id: str, data: bytes) -> str:
        sha = hashlib.sha256(data).hexdigest()
        self.put_blob(project_id, sha, data)
        return sha

    def get_blob(self, project_id: str, sha: str) -> bytes:
        path = self.blob_path(project_id, sha)
        if not os.path.isfile(path):
            raise ProjectError("[VNCCS UniCanvas] Blob not found.", 404)
        with open(path, "rb") as handle:
            return handle.read()

    def _dehydrate(self, project_id: str, value: Any) -> Any:
        """Replaces every inline PNG pixel field by a blob ref; refs the client sent must exist."""
        if isinstance(value, list):
            return [self._dehydrate(project_id, item) for item in value]
        if not isinstance(value, dict):
            return value
        out: dict[str, Any] = {}
        for key, item in value.items():
            if _is_pixel_key(key) and isinstance(item, str) and item.startswith(_PNG_PREFIX):
                ref_crop = value.get("hiresRect") if key.lower().startswith("hires") else value.get("crop")
                out[key] = {"blob": f"{self.store_png(project_id, decode_png_data_url(item))}.png", "crop": ref_crop}
            elif _is_pixel_key(key) and isinstance(item, dict) and "blob" in item:
                sha = str(item.get("blob") or "")[:-4]
                if not os.path.isfile(self.blob_path(project_id, sha)):
                    raise ProjectError("[VNCCS UniCanvas] The scene references a blob that was never uploaded.", 400, missingBlob=item.get("blob"))
                out[key] = {"blob": f"{sha}.png", "crop": item.get("crop")}
            else:
                out[key] = self._dehydrate(project_id, item)
        return out

    def _hydrate(self, project_id: str, value: Any) -> Any:
        """Turns blob refs back into PNG data URLs (for rendering a scene in node mode)."""
        if isinstance(value, list):
            return [self._hydrate(project_id, item) for item in value]
        if not isinstance(value, dict):
            return value
        out: dict[str, Any] = {}
        for key, item in value.items():
            if _is_pixel_key(key) and isinstance(item, dict) and "blob" in item:
                data = self.get_blob(project_id, str(item.get("blob") or "")[:-4])
                out[key] = _PNG_PREFIX + base64.b64encode(data).decode("ascii")
            else:
                out[key] = self._hydrate(project_id, item)
        return out

    def collect_garbage(self, project_id: str, now: float | None = None) -> list[str]:
        """Deletes blobs no scene, asset or history record references and that are older than 24 h."""
        with _STORE_LOCK:
            directory = self.project_dir(project_id)
            referenced: set[str] = set()
            for sub in ("scenes", "assets", "history"):
                for folder, _dirs, files in os.walk(os.path.join(directory, sub)):
                    for name in files:
                        if name.endswith(".json"):
                            try:
                                _collect_blob_refs(_read_json(os.path.join(folder, name)), referenced)
                            except (OSError, ValueError):
                                return []  # an unreadable record could hide references: collect nothing
            now = _now() if now is None else now
            removed = []
            blobs = os.path.join(directory, "blobs")
            for name in os.listdir(blobs) if os.path.isdir(blobs) else []:
                sha = name[:-4] if name.endswith(".png") else ""
                path = os.path.join(blobs, name)
                if sha in referenced or not _SHA_RE.match(sha):
                    continue
                if now - os.path.getmtime(path) > BLOB_GC_MIN_AGE_SECONDS:
                    os.remove(path)
                    removed.append(sha)
            return removed

    # -- scenes --------------------------------------------------------------------------------

    def _scene_entry(self, project: dict[str, Any], scene_id: str) -> dict[str, Any]:
        entry = next((scene for scene in project["scenes"] if scene["id"] == scene_id), None)
        if entry is None:
            raise ProjectError("[VNCCS UniCanvas] Scene not found.", 404)
        return entry

    def create_scene(self, project_id: str, name: str = "", from_scene_id: str | None = None, state: dict[str, Any] | None = None) -> dict[str, Any]:
        with _STORE_LOCK:
            project = self.load_project(project_id)
            scene_id = _new_id("scn")
            if from_scene_id:
                source = self._scene_entry(project, _safe_id(from_scene_id, "scene id"))
                stored = _read_json(self._scene_json(project_id, source["id"]))
                name = name or f"{source.get('name') or 'Scene'} copy"
                thumb = self.thumb_path(project_id, source["id"])
                if os.path.isfile(thumb):
                    shutil.copyfile(thumb, self.thumb_path(project_id, scene_id))
            else:
                stored = self._dehydrate(project_id, state if isinstance(state, dict) else {"layers": []})
            _atomic_write_json(self._scene_json(project_id, scene_id), stored)
            now = _now()
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
        entry = self._scene_entry(project, _safe_id(scene_id, "scene id"))
        state = _read_json(self._scene_json(project_id, entry["id"]))
        return {**entry, "state": self._hydrate(project_id, state) if hydrate else state}

    def put_scene(self, project_id: str, scene_id: str, state: dict[str, Any], if_rev: Any = None,
                  name: str | None = None, thumbnail: str | None = None) -> dict[str, Any]:
        if not isinstance(state, dict):
            raise ProjectError("[VNCCS UniCanvas] The scene state must be an object.", 400)
        with _STORE_LOCK:
            project = self.load_project(project_id)
            entry = self._scene_entry(project, _safe_id(scene_id, "scene id"))
            if if_rev is not None and int(if_rev) != int(entry.get("rev") or 0):
                raise ProjectError("[VNCCS UniCanvas] The scene changed elsewhere.", 409, rev=entry.get("rev"))
            stored = self._dehydrate(project_id, state)
            _atomic_write_json(self._scene_json(project_id, entry["id"]), stored)
            if thumbnail:
                _atomic_write_bytes(self.thumb_path(project_id, entry["id"]), _thumbnail_png(decode_png_data_url(thumbnail)))
                entry["thumbnail"] = f"thumbs/{entry['id']}.png"
            if name:
                entry["name"] = str(name)[:200]
            entry["rev"] = int(entry.get("rev") or 0) + 1
            entry["updatedAt"] = _now()
            self._save_project(project)
            return entry

    def delete_scene(self, project_id: str, scene_id: str) -> dict[str, Any]:
        with _STORE_LOCK:
            project = self.load_project(project_id)
            entry = self._scene_entry(project, _safe_id(scene_id, "scene id"))
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
        with archive, _STORE_LOCK:
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
                project_id = _safe_id(original, "project id")
            except ProjectError:
                project_id = _new_id("prj")
            if os.path.exists(self.project_dir(project_id)):
                project_id = _new_id("prj")
            directory = self.project_dir(project_id)
            staging = self._inside(os.path.join(self.root, f".import-{uuid.uuid4().hex[:8]}"))
            try:
                for info in infos:
                    name = info.filename
                    if name.startswith("/") or "\\" in name or ".." in name.split("/") or ":" in name:
                        raise ProjectError("[VNCCS UniCanvas] The zip contains an unsafe path.", 400)
                    target = self._inside(os.path.join(staging, *name.split("/")), staging)
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
                _atomic_write_json(os.path.join(staging, "project.json"), project)
                os.replace(staging, directory)
            finally:
                shutil.rmtree(staging, ignore_errors=True)
            return self.load_project(project_id)


def _thumbnail_png(data: bytes) -> bytes:
    from PIL import Image

    with Image.open(io.BytesIO(data)) as image:
        image.load()
        image.thumbnail((THUMBNAIL_SIZE, THUMBNAIL_SIZE))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()


def load_project_scene_state(project_id: str, scene_id: str, user: str = "default", user_root: str | None = None) -> dict[str, Any]:
    """A scene as a plain serialized state (pixel fields as data URLs), for node-mode rendering."""
    store = ProjectStore(user_root or default_user_root(), user or "default")
    return store.get_scene(project_id, scene_id, hydrate=True)["state"]


# -- aiohttp routes ------------------------------------------------------------------------------

def _request_user(request) -> str:
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


def project_routes(web, content_length_ok: Callable[[Any, int], bool],
                   store_factory: Callable[[str], ProjectStore] | None = None) -> list[tuple[str, str, Callable]]:
    """(method, path, handler) triples for ``routes.py`` to register under /vnccs/unicanvas/projects."""
    base = "/vnccs/unicanvas/projects"

    def store_for(request) -> ProjectStore:
        user = _request_user(request)
        return store_factory(user) if store_factory else ProjectStore(default_user_root(), user)

    def handler(max_bytes: int, work):
        async def run(request):
            if not content_length_ok(request, max_bytes):
                return web.json_response({"error": "[VNCCS UniCanvas] Project request is too large."}, status=413)
            try:
                store = store_for(request)
                result = await work(request, store)
                return result if isinstance(result, web.StreamResponse) else web.json_response(result)
            except ProjectError as exc:
                return web.json_response({"error": str(exc), **exc.extra}, status=exc.status)
            except Exception as exc:
                return web.json_response({"error": f"[VNCCS UniCanvas] Project storage failed: {exc}"}, status=500)
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
        path = store.thumb_path(m(request, "id"), m(request, "scene"))
        if not os.path.isfile(path):
            raise ProjectError("[VNCCS UniCanvas] Thumbnail not found.", 404)
        with open(path, "rb") as handle:
            return web.Response(body=handle.read(), content_type="image/png", headers={"Cache-Control": "no-cache"})

    async def export(request, store):
        project = await asyncio.to_thread(store.load_project, m(request, "id"))
        data = await asyncio.to_thread(store.export_zip, m(request, "id"))
        filename = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(project.get("name") or "project")).strip("_") or "project"
        return web.Response(body=data, content_type="application/zip",
                            headers={"Content-Disposition": f'attachment; filename="{filename}.vnccs-project.zip"'})

    async def import_(request, store):
        return await asyncio.to_thread(store.import_zip, await request.read())

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
        # Generation history (Plan 10.5) lives under .../{id}/history; history.py builds on this module.
        *_history_routes(web, content_length_ok, store_factory),
    ]


def _history_routes(web, content_length_ok, store_factory):
    from .history import history_routes  # deferred: history.py imports this module

    return history_routes(web, content_length_ok, store_factory)
