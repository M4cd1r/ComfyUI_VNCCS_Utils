import pathlib
import sys
import types

# Same package shell as tests/conftest.py, so the suite also runs from oddly named worktrees.
if "__init__" not in sys.modules:
    _root_package_shell = types.ModuleType("__init__")
    _root_package_shell.__path__ = [str(pathlib.Path(__file__).resolve().parent.parent)]
    sys.modules["__init__"] = _root_package_shell

import asyncio
import base64
import hashlib
import io
import json
import os
import shutil

import pytest
from PIL import Image

from nodes.unicanvas import project_io, projects
from nodes.unicanvas.projects import ProjectError, ProjectStore


def _png(color=(255, 0, 0, 255), size=(8, 8)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def _data_url(data: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(data).decode("ascii")


def _state(color=(255, 0, 0, 255)):
    return {
        "version": 3, "origin": {"x": 0, "y": 0}, "size": {"width": 8, "height": 8},
        "bbox": {"x": 0, "y": 0, "width": 8, "height": 8}, "activeLayerId": "l1",
        "layers": [{
            "id": "l1", "name": "Layer", "type": "raster", "visible": True, "opacity": 1,
            "blendMode": "source-over", "crop": {"x": 0, "y": 0, "width": 8, "height": 8},
            "dataURL": _data_url(_png(color)), "hiresRect": None, "hiresDataURL": None,
            "meta": {"origin": "paint"},
        }],
    }


@pytest.fixture()
def user_root(tmp_path, monkeypatch):
    root = tmp_path / "user"
    root.mkdir()
    monkeypatch.setattr(sys.modules["folder_paths"], "get_user_directory", lambda: str(root), raising=False)
    return root


@pytest.fixture()
def store(user_root):
    return ProjectStore(str(user_root), "default")


def _blobs(store, project_id):
    return sorted(os.listdir(os.path.join(store.project_dir(project_id), "blobs")))


def test_layout_lives_in_the_user_directory(store, user_root):
    project = store.create_project("Chapter 1")
    directory = pathlib.Path(store.project_dir(project["id"]))
    assert directory.parent == user_root / "default" / "vnccs_unicanvas" / "projects"
    for sub in ("scenes", "blobs", "thumbs", "assets", "history"):
        assert (directory / sub).is_dir()
    stored = json.loads((directory / "project.json").read_text())
    assert {"schemaVersion", "id", "name", "createdAt", "updatedAt", "rev", "scenes", "activeSceneId", "settings"} <= set(stored)
    assert len(stored["scenes"]) == 1 and stored["activeSceneId"] == stored["scenes"][0]["id"]


def test_scene_pixels_become_content_addressed_blobs(store):
    project = store.create_project("P")
    scene_id = project["scenes"][0]["id"]
    entry = store.put_scene(project["id"], scene_id, _state(), if_rev=1)
    stored = store.get_scene(project["id"], scene_id)["state"]
    ref = stored["layers"][0]["dataURL"]
    sha = hashlib.sha256(_png()).hexdigest()
    assert ref == {"blob": f"{sha}.png", "crop": {"x": 0, "y": 0, "width": 8, "height": 8}}
    assert stored["layers"][0]["meta"] == {"origin": "paint"}
    assert _blobs(store, project["id"]) == [f"{sha}.png"]
    hydrated = store.get_scene(project["id"], scene_id, hydrate=True)["state"]
    assert hydrated["layers"][0]["dataURL"] == _state()["layers"][0]["dataURL"]
    assert entry["rev"] == 2


@pytest.mark.parametrize("bad", ["../escape", "..", "a/b", "a\\b", "", "x" * 200, "%2e%2e"])
def test_path_traversal_is_refused(store, bad):
    project = store.create_project("P")
    with pytest.raises(ProjectError) as info:
        store.load_project(bad)
    assert info.value.status == 400
    with pytest.raises(ProjectError):
        store.get_scene(project["id"], bad)
    with pytest.raises(ProjectError):
        store.blob_path(project["id"], bad)
    with pytest.raises(ProjectError):
        ProjectStore(store.base, bad)


def test_blob_hash_mismatch_is_refused(store):
    project = store.create_project("P")
    data = _png()
    with pytest.raises(ProjectError) as info:
        store.put_blob(project["id"], "0" * 64, data)
    assert info.value.status == 400
    sha = hashlib.sha256(data).hexdigest()
    assert store.put_blob(project["id"], sha, data)["created"] is True
    assert store.put_blob(project["id"], sha, data)["created"] is False, "PUT is idempotent"
    assert store.get_blob(project["id"], sha) == data


def test_scene_referencing_a_missing_blob_is_refused(store):
    project = store.create_project("P")
    state = _state()
    state["layers"][0]["dataURL"] = {"blob": f"{'a' * 64}.png", "crop": None}
    with pytest.raises(ProjectError) as info:
        store.put_scene(project["id"], project["scenes"][0]["id"], state)
    assert info.value.status == 400


def test_stale_if_rev_returns_409_with_the_current_rev(store):
    project = store.create_project("P")
    scene_id = project["scenes"][0]["id"]
    store.put_scene(project["id"], scene_id, _state(), if_rev=1)
    with pytest.raises(ProjectError) as info:
        store.put_scene(project["id"], scene_id, _state((0, 255, 0, 255)), if_rev=1)
    assert info.value.status == 409
    assert info.value.extra == {"rev": 2}


def test_gc_keeps_referenced_blobs_and_deletes_old_unreferenced_ones(store):
    project = store.create_project("P")
    pid = project["id"]
    store.put_scene(pid, project["scenes"][0]["id"], _state())
    kept = hashlib.sha256(_png()).hexdigest()
    history = pathlib.Path(store.project_dir(pid)) / "history" / "h1.json"
    history_png = _png((0, 0, 255, 255))
    history_sha = store.store_png(pid, history_png)
    history.write_text(json.dumps({"image": {"blob": f"{history_sha}.png"}}))
    old_orphan = store.store_png(pid, _png((1, 2, 3, 255)))
    new_orphan = store.store_png(pid, _png((4, 5, 6, 255)))
    old = project_io.now() - projects.BLOB_GC_MIN_AGE_SECONDS - 60
    for sha in (kept, history_sha, old_orphan):
        os.utime(store.blob_path(pid, sha), (old, old))
    assert store.collect_garbage(pid) == [old_orphan]
    assert set(_blobs(store, pid)) == {f"{kept}.png", f"{history_sha}.png", f"{new_orphan}.png"}
    store.open_project(pid)  # GC runs on open too and removes nothing more
    assert f"{kept}.png" in _blobs(store, pid)


def test_duplicating_a_scene_writes_no_new_blobs(store):
    project = store.create_project("P")
    pid = project["id"]
    store.put_scene(pid, project["scenes"][0]["id"], _state())
    before = _blobs(store, pid)
    copy = store.create_scene(pid, from_scene_id=project["scenes"][0]["id"])
    assert _blobs(store, pid) == before
    assert store.get_scene(pid, copy["id"])["state"] == store.get_scene(pid, project["scenes"][0]["id"])["state"]
    assert len(store.load_project(pid)["scenes"]) == 2


def test_zip_export_then_import_round_trips(store):
    project = store.create_project("Round trip")
    pid = project["id"]
    store.put_scene(pid, project["scenes"][0]["id"], _state(), thumbnail=_data_url(_png(size=(1024, 600))))
    store.create_scene(pid, name="Night", state=_state((0, 0, 0, 255)))
    data = store.export_zip(pid)

    def snapshot(project_id):
        directory = pathlib.Path(store.project_dir(project_id))
        return {str(path.relative_to(directory)): path.read_bytes() for path in sorted(directory.rglob("*")) if path.is_file()}

    original = snapshot(pid)
    shutil.rmtree(store.project_dir(pid))
    imported = store.import_zip(data)
    assert imported["id"] == pid
    assert snapshot(pid) == original
    for sub in ("assets", "history"):
        assert os.path.isdir(os.path.join(store.project_dir(pid), sub))
    thumb = Image.open(store.thumb_path(pid, project["scenes"][0]["id"]))
    assert max(thumb.size) == projects.THUMBNAIL_SIZE
    # Importing the same zip again keeps the first project and gets a fresh id.
    again = store.import_zip(data)
    assert again["id"] != pid


def test_import_refuses_unsafe_zip_paths(store):
    import zipfile

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("project.json", json.dumps({"id": "evil", "scenes": []}))
        archive.writestr("../outside.txt", "x")
    with pytest.raises(ProjectError):
        store.import_zip(buffer.getvalue())
    assert not os.path.exists(os.path.join(store.base, "outside.txt"))
    assert not os.path.exists(os.path.join(store.root, "evil"))


def test_project_survives_a_temp_directory_wipe(store, tmp_path, monkeypatch):
    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setattr(sys.modules["folder_paths"], "get_temp_directory", lambda: str(temp), raising=False)
    project = store.create_project("Durable")
    pid, scene_id = project["id"], project["scenes"][0]["id"]
    store.put_scene(pid, scene_id, _state())
    before = store.get_scene(pid, scene_id, hydrate=True)
    shutil.rmtree(temp)  # ComfyUI clears its temp directory on startup
    temp.mkdir()
    reopened = ProjectStore(str(pathlib.Path(store.base).parent.parent), "default")
    assert reopened.get_scene(pid, scene_id, hydrate=True) == before
    assert not any(temp.iterdir()), "nothing of the project lives in the temp directory"


def test_delete_moves_to_trash_and_purges_after_30_days(store):
    project = store.create_project("Old")
    store.delete_project(project["id"])
    assert store.list_projects() == []
    trashed = os.listdir(store.trash)
    assert len(trashed) == 1 and trashed[0].startswith(project["id"])
    assert store.purge_trash(now=project_io.now() + 29 * 24 * 3600) == 0
    assert store.purge_trash(now=project_io.now() + 31 * 24 * 3600) == 1
    assert os.listdir(store.trash) == []


def test_patch_reorders_scenes_and_list_summarizes(store):
    project = store.create_project("P")
    pid = project["id"]
    second = store.create_scene(pid, name="Two")
    first = project["scenes"][0]["id"]
    patched = store.patch_project(pid, {"name": "Renamed", "sceneOrder": [second["id"], first], "settings": {"a": 1}})
    assert [scene["id"] for scene in patched["scenes"]] == [second["id"], first]
    assert patched["name"] == "Renamed" and patched["settings"] == {"a": 1}
    with pytest.raises(ProjectError):
        store.patch_project(pid, {"sceneOrder": [first]})
    listed = store.list_projects()
    assert listed[0]["id"] == pid and listed[0]["sceneCount"] == 2
    dup = store.duplicate_project(pid)
    assert dup["id"] != pid and len(dup["scenes"]) == 2
    store.delete_scene(pid, second["id"])
    with pytest.raises(ProjectError):
        store.delete_scene(pid, first)  # a project keeps one scene


def test_unwritable_user_directory_is_an_error_not_a_temp_fallback(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("not a directory")
    with pytest.raises(ProjectError) as info:
        ProjectStore(str(blocker), "default").create_project("P")
    assert info.value.status == 500
    assert "not writable" in str(info.value)


def test_multi_user_installs_keep_projects_apart(user_root):
    ProjectStore(str(user_root), "alice").create_project("A")
    assert ProjectStore(str(user_root), "bob").list_projects() == []
    assert len(ProjectStore(str(user_root), "alice").list_projects()) == 1


def test_routes_map_errors_to_status_codes(user_root):
    web = pytest.importorskip("aiohttp.web")
    stores = {}

    def factory(user):
        return stores.setdefault(user, ProjectStore(str(user_root), user))

    table = {(method, path): handler for method, path, handler in projects.project_routes(web, lambda request, size: True, factory)}
    base = "/vnccs/unicanvas/projects"
    for key in [("GET", base), ("POST", base), ("POST", f"{base}/import"), ("GET", f"{base}/{{id}}"),
                ("PATCH", f"{base}/{{id}}"), ("DELETE", f"{base}/{{id}}"), ("POST", f"{base}/{{id}}/duplicate"),
                ("POST", f"{base}/{{id}}/export"), ("POST", f"{base}/{{id}}/scenes"),
                ("GET", f"{base}/{{id}}/scenes/{{scene}}"), ("PUT", f"{base}/{{id}}/scenes/{{scene}}"),
                ("DELETE", f"{base}/{{id}}/scenes/{{scene}}"), ("PUT", f"{base}/{{id}}/blobs/{{sha}}"),
                ("GET", f"{base}/{{id}}/blobs/{{sha}}")]:
        assert key in table, key

    class Request:
        def __init__(self, match_info=None, payload=None, raw=b""):
            self.match_info = match_info or {}
            self._payload = payload
            self._raw = raw
            self.can_read_body = payload is not None or bool(raw)
            self.headers = {}

        async def json(self):
            if isinstance(self._payload, Exception):
                raise self._payload
            return self._payload

        async def read(self):
            return self._raw

    async def call(method, path, **kwargs):
        response = await table[(method, path)](Request(**kwargs))
        return response.status, (json.loads(response.body) if response.content_type == "application/json" else response.body)

    async def scenario():
        status, project = await call("POST", base, payload={"name": "Via route"})
        assert status == 200
        pid, sid = project["id"], project["scenes"][0]["id"]
        status, body = await call("GET", f"{base}/{{id}}", match_info={"id": "../x"})
        assert status == 400 and "error" in body
        status, body = await call("GET", f"{base}/{{id}}", match_info={"id": "prj_missing"})
        assert status == 404
        status, body = await call("PUT", f"{base}/{{id}}/blobs/{{sha}}", match_info={"id": pid, "sha": "0" * 64}, raw=_png())
        assert status == 400
        status, entry = await call("PUT", f"{base}/{{id}}/scenes/{{scene}}", match_info={"id": pid, "scene": sid},
                                   payload={"state": _state(), "ifRev": 1})
        assert status == 200 and entry["rev"] == 2
        status, body = await call("PUT", f"{base}/{{id}}/scenes/{{scene}}", match_info={"id": pid, "scene": sid},
                                  payload={"state": _state(), "ifRev": 1})
        assert status == 409 and body["rev"] == 2
        status, body = await call("GET", f"{base}/{{id}}/thumbs/{{scene}}", match_info={"id": pid, "scene": "scn_missing"})
        assert status == 404 and "error" in body
        # Client errors are 400s, not "storage failed" 500s.
        status, body = await call("PATCH", f"{base}/{{id}}", match_info={"id": pid},
                                  payload=json.JSONDecodeError("Expecting value", "{", 1))
        assert status == 400 and "JSON object" in body["error"]
        status, body = await call("PATCH", f"{base}/{{id}}", match_info={"id": pid}, payload=[1, 2])
        assert status == 400 and "JSON object" in body["error"]
        for bad_rev in ("abc", [1], {"n": 1}):
            status, body = await call("PUT", f"{base}/{{id}}/scenes/{{scene}}", match_info={"id": pid, "scene": sid},
                                      payload={"state": _state(), "ifRev": bad_rev})
            assert status == 400 and "ifRev" in body["error"], bad_rev
        status, data = await call("POST", f"{base}/{{id}}/export", match_info={"id": pid})
        assert status == 200 and data[:2] == b"PK"

    asyncio.run(scenario())


def test_export_state_renders_a_scene_stored_in_a_project(user_root):
    pytest.importorskip("torch")
    from nodes.unicanvas.node import VNCCS_UniCanvas

    store = ProjectStore(str(user_root), "default")
    project = store.create_project("Render")
    scene_id = project["scenes"][0]["id"]
    store.put_scene(project["id"], scene_id, _state((0, 255, 0, 255)))
    widget_state = json.dumps({"projectId": project["id"], "sceneId": scene_id, "layers": []})
    (tensor,) = VNCCS_UniCanvas().export_state(widget_state)
    assert tuple(tensor.shape)[:3] == (1, 8, 8)
    assert float(tensor[0, 0, 0, 1]) == pytest.approx(1.0)
    assert float(tensor[0, 0, 0, 0]) == pytest.approx(0.0)
    # A state never attached to a project keeps the inline path.
    (inline,) = VNCCS_UniCanvas().export_state(json.dumps(_state((255, 0, 0, 255))))
    assert float(inline[0, 0, 0, 0]) == pytest.approx(1.0)
