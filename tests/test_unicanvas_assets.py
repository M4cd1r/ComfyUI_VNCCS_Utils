"""Asset library storage and routes (Plan 10.4, issue #23)."""

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
import io
import json
import os

import pytest
from PIL import Image

from nodes.unicanvas import projects
from nodes.unicanvas.projects import BLOB_GC_MIN_AGE_SECONDS, ProjectError, ProjectStore


def _png(color=(255, 0, 0, 255), size=(8, 8)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def _data_url(data: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(data).decode("ascii")


def _character(color=(255, 0, 0, 255)):
    return {
        "kind": "character", "name": "Alice", "tags": ["cast", "hero", "cast", ""],
        "data": {"imageDataURL": _data_url(_png(color)), "size": {"width": 8, "height": 8},
                 "anchor": {"x": 0.5, "y": 1}, "identityPrompt": "red hair", "heightFactor": 1.1},
    }


@pytest.fixture()
def store(tmp_path):
    root = tmp_path / "user"
    root.mkdir()
    return ProjectStore(str(root), "default")


def _age_everything(folder, seconds):
    for name in os.listdir(folder):
        path = os.path.join(folder, name)
        stamp = os.path.getmtime(path) - seconds
        os.utime(path, (stamp, stamp))


def test_project_asset_pixels_live_in_the_project_blob_store(store):
    project = store.create_project("Assets")
    asset = store.create_asset("project", project["id"], _character())
    assert asset["kind"] == "character" and asset["tags"] == ["cast", "hero"] and asset["rev"] == 1
    ref = asset["data"]["imageDataURL"]
    assert set(ref) == {"blob", "crop"} and ref["blob"].endswith(".png")
    blobs = os.listdir(os.path.join(store.project_dir(project["id"]), "blobs"))
    assert ref["blob"] in blobs and asset["thumbnail"]["blob"] in blobs
    path = os.path.join(store.project_dir(project["id"]), "assets", asset["id"], "asset.json")
    assert os.path.isfile(path)
    assert store.get_asset("project", project["id"], asset["id"])["data"]["identityPrompt"] == "red hair"


def test_global_library_is_shared_by_every_project(store):
    first = store.create_project("One")
    second = store.create_project("Two")
    asset = store.create_asset("global", None, {**_character(), "kind": "prop", "name": "Lamp"})
    assert os.path.isfile(os.path.join(store.library, "assets", asset["id"], "asset.json"))
    assert os.path.isfile(store.library_blob_path(asset["data"]["imageDataURL"]["blob"][:-4]))
    assert [item["id"] for item in store.list_assets("global")] == [asset["id"]]
    # Project scopes stay separate from each other and from the library.
    assert store.list_assets("project", first["id"]) == []
    assert store.list_assets("project", second["id"]) == []
    assert store.get_library_blob(asset["data"]["imageDataURL"]["blob"][:-4]).startswith(b"\x89PNG")


def test_list_filters_by_kind_and_searches_name_and_tags(store):
    store.create_asset("global", None, _character())
    store.create_asset("global", None, {"kind": "background", "name": "Forest", "tags": ["outdoor"],
                                        "data": {"imageDataURL": _data_url(_png((0, 255, 0, 255)))}})
    store.create_asset("global", None, {"kind": "preset", "name": "House style", "data": {"settings": {"steps": 20}}})
    assert [item["name"] for item in store.list_assets("global", kind="background")] == ["Forest"]
    assert [item["name"] for item in store.list_assets("global", query="OUTDOOR")] == ["Forest"]
    assert [item["name"] for item in store.list_assets("global", query="ali")] == ["Alice"]
    preset = next(item for item in store.list_assets("global") if item["kind"] == "preset")
    assert preset["thumbnail"] is None


@pytest.mark.parametrize("bad", ["../x", "..", "a/b", "a\\b", "", "x" * 200])
def test_asset_path_traversal_is_refused(store, bad):
    project = store.create_project("Safe")
    for scope, project_id in (("global", None), ("project", project["id"])):
        with pytest.raises(ProjectError) as info:
            store.get_asset(scope, project_id, bad)
        assert info.value.status == 400
        with pytest.raises(ProjectError):
            store.delete_asset(scope, project_id, bad)
    with pytest.raises(ProjectError) as info:
        store.list_assets("project", "../other")
    assert info.value.status == 400
    with pytest.raises(ProjectError) as info:
        store.get_library_blob("../" + "0" * 61)
    assert info.value.status == 400


def test_unknown_scope_and_kinds_are_refused(store):
    with pytest.raises(ProjectError):
        store.list_assets("elsewhere")
    with pytest.raises(ProjectError) as info:
        store.create_asset("global", None, {"kind": "skin", "name": "VN skin"})
    assert "reserved" in str(info.value)
    with pytest.raises(ProjectError):
        store.create_asset("global", None, {"kind": "sound"})
    with pytest.raises(ProjectError) as info:
        store.create_asset("project", "prj_missing", _character())
    assert info.value.status == 404


def test_push_updates_data_bumps_rev_and_guards_races(store):
    asset = store.create_asset("global", None, _character())
    pushed = store.put_asset("global", None, asset["id"], {"data": _character((0, 0, 255, 255))["data"], "ifRev": 1})
    assert pushed["rev"] == 2 and pushed["name"] == "Alice"
    assert pushed["data"]["imageDataURL"]["blob"] != asset["data"]["imageDataURL"]["blob"]
    with pytest.raises(ProjectError) as info:
        store.put_asset("global", None, asset["id"], {"name": "Stale", "ifRev": 1})
    assert info.value.status == 409 and info.value.extra["rev"] == 2
    with pytest.raises(ProjectError):
        store.put_asset("global", None, asset["id"], {"kind": "prop"})
    store.delete_asset("global", None, asset["id"])
    with pytest.raises(ProjectError) as info:
        store.get_asset("global", None, asset["id"])
    assert info.value.status == 404


def test_gc_keeps_asset_referenced_blobs(store):
    project = store.create_project("GC")
    kept = store.create_asset("project", project["id"], _character())
    dropped = store.create_asset("project", project["id"], _character((0, 255, 0, 255)))
    store.delete_asset("project", project["id"], dropped["id"])
    blobs = os.path.join(store.project_dir(project["id"]), "blobs")
    _age_everything(blobs, BLOB_GC_MIN_AGE_SECONDS + 60)
    removed = store.collect_garbage(project["id"])
    assert dropped["data"]["imageDataURL"]["blob"][:-4] in removed
    names = os.listdir(blobs)
    assert kept["data"]["imageDataURL"]["blob"] in names and kept["thumbnail"]["blob"] in names

    global_kept = store.create_asset("global", None, _character((1, 2, 3, 255)))
    global_dropped = store.create_asset("global", None, _character((4, 5, 6, 255)))
    store.delete_asset("global", None, global_dropped["id"])
    library_blobs = os.path.join(store.library, "blobs")
    _age_everything(library_blobs, BLOB_GC_MIN_AGE_SECONDS + 60)
    removed = store.collect_library_garbage()
    assert global_dropped["data"]["imageDataURL"]["blob"][:-4] in removed
    assert global_kept["data"]["imageDataURL"]["blob"] in os.listdir(library_blobs)


def test_asset_routes(tmp_path):
    web = pytest.importorskip("aiohttp.web")
    root = tmp_path / "user"
    root.mkdir()
    stores = {}

    def factory(user):
        return stores.setdefault(user, ProjectStore(str(root), user))

    table = {(method, path): handler for method, path, handler in projects.project_routes(web, lambda request, size: True, factory)}
    base = "/vnccs/unicanvas/projects"
    library = "/vnccs/unicanvas/library"

    class Request:
        def __init__(self, match_info=None, payload=None, query=None):
            self.match_info = match_info or {}
            self._payload = payload
            self.query = query or {}
            self.can_read_body = payload is not None
            self.headers = {}

        async def json(self):
            return self._payload

    async def call(method, path, **kwargs):
        response = await table[(method, path)](Request(**kwargs))
        return response.status, (json.loads(response.body) if response.content_type == "application/json" else response.body)

    async def scenario():
        _status, first = await call("POST", base, payload={"name": "First"})
        _status, second = await call("POST", base, payload={"name": "Second"})
        status, asset = await call("POST", f"{base}/{{id}}/assets", match_info={"id": first["id"]}, payload=_character())
        assert status == 200 and asset["scope"] == "project"
        status, listed = await call("GET", f"{base}/{{id}}/assets", match_info={"id": first["id"]}, query={"kind": "character"})
        assert status == 200 and [item["id"] for item in listed["assets"]] == [asset["id"]]
        status, listed = await call("GET", f"{base}/{{id}}/assets", match_info={"id": second["id"]})
        assert listed["assets"] == []
        status, body = await call("GET", f"{base}/{{id}}/assets/{{asset}}", match_info={"id": first["id"], "asset": "../../x"})
        assert status == 400 and "error" in body
        status, body = await call("GET", f"{library}/assets/{{asset}}", match_info={"asset": "../projects"})
        assert status == 400
        status, body = await call("POST", f"{library}/assets", payload={"kind": "skin"})
        assert status == 400

        status, shared = await call("POST", f"{library}/assets", payload={**_character(), "kind": "prop", "name": "Lamp"})
        assert status == 200 and shared["scope"] == "global"
        status, listed = await call("GET", f"{library}/assets", query={"q": "lamp"})
        assert [item["id"] for item in listed["assets"]] == [shared["id"]]
        status, data = await call("GET", f"{library}/blobs/{{sha}}", match_info={"sha": shared["data"]["imageDataURL"]["blob"][:-4]})
        assert status == 200 and data.startswith(b"\x89PNG")
        status, pushed = await call("PUT", f"{library}/assets/{{asset}}", match_info={"asset": shared["id"]},
                                    payload={"name": "Desk lamp", "ifRev": 1})
        assert status == 200 and pushed["rev"] == 2
        status, body = await call("PUT", f"{library}/assets/{{asset}}", match_info={"asset": shared["id"]},
                                  payload={"name": "Old", "ifRev": 1})
        assert status == 409 and body["rev"] == 2
        status, body = await call("DELETE", f"{library}/assets/{{asset}}", match_info={"asset": shared["id"]})
        assert status == 200 and body["deleted"] is True

    asyncio.run(scenario())

