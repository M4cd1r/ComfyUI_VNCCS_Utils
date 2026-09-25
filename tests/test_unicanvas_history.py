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

import pytest
from PIL import Image

from nodes.unicanvas import history
from nodes.unicanvas.history import HistoryStore
from nodes.unicanvas.projects import ProjectError, ProjectStore


def _png(color=(255, 0, 0, 255), size=(8, 8)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def _data_url(data: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(data).decode("ascii")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _record(record_id, created_at, colors, accepted=(), kind="generate", scene_id="scn_a", prompt="a cat"):
    return {
        "id": record_id, "kind": kind, "sceneId": scene_id, "createdAt": created_at, "durationMs": 1200,
        "status": "ok", "settings": {"positive": prompt, "seed": 7, "steps": 20},
        "snapshot": {"prompt": prompt, "modelFamily": "sdxl", "seed": 7, "historyId": record_id},
        "inputs": {"imageDataURL": _data_url(_png((1, 2, 3, 255), (4, 4)))},
        "results": [
            {"imageDataURL": _data_url(_png(color)), "accepted": index in accepted, "layerId": f"layer_{index}" if index in accepted else None, "seed": 7 + index}
            for index, color in enumerate(colors)
        ],
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


@pytest.fixture()
def hist(store):
    return HistoryStore(store)


def test_record_keeps_every_result_as_a_content_addressed_blob(store, hist):
    pid = store.create_project("History")["id"]
    colors = [(255, 0, 0, 255), (0, 255, 0, 255), (0, 0, 255, 255)]
    created = hist.create_record(pid, _record("gen_one", 100.0, colors, accepted=(1,)))["record"]
    assert created["id"] == "gen_one" and created["schemaVersion"] == history.HISTORY_SCHEMA_VERSION
    assert os.path.isfile(os.path.join(store.project_dir(pid), "history", "gen_one.json"))
    assert len(created["results"]) == 3
    assert [item["accepted"] for item in created["results"]] == [False, True, False]
    assert [item["index"] for item in created["results"]] == [0, 1, 2]
    for item, color in zip(created["results"], colors):
        assert item["imageDataURL"]["blob"] == f"{_sha(_png(color))}.png"
        assert os.path.isfile(store.blob_path(pid, _sha(_png(color))))
    assert created["inputs"]["imageDataURL"]["blob"].endswith(".png")
    # The same accepted image in a second record is stored once.
    hist.create_record(pid, _record("gen_two", 101.0, [colors[1]], accepted=(0,)))
    blobs = os.listdir(os.path.join(store.project_dir(pid), "blobs"))
    assert len(blobs) == 4  # three results + one input thumbnail


def test_list_is_newest_first_and_reports_caps_and_usage(store, hist):
    pid = store.create_project("History")["id"]
    hist.create_record(pid, _record("gen_old", 10.0, [(1, 1, 1, 255)]))
    hist.create_record(pid, _record("gen_new", 20.0, [(2, 2, 2, 255)]))
    listed = hist.list_records(pid)
    assert [record["id"] for record in listed["records"]] == ["gen_new", "gen_old"]
    assert listed["settings"] == {"maxRecords": 1000, "maxBytes": 4 * 1024 ** 3}
    assert listed["usage"]["records"] == 2 and listed["usage"]["bytes"] > 0
    assert [record["id"] for record in hist.list_records(pid, limit=1)["records"]] == ["gen_new"]


def test_patch_marks_results_accepted_and_validates(store, hist):
    pid = store.create_project("History")["id"]
    hist.create_record(pid, _record("gen_p", 1.0, [(1, 1, 1, 255), (2, 2, 2, 255)]))
    record = hist.patch_record(pid, "gen_p", {"results": [{"index": 1, "accepted": True, "layerId": "layer_x"}]})
    assert record["results"][1]["accepted"] is True and record["results"][1]["layerId"] == "layer_x"
    assert hist.get_record(pid, "gen_p")["results"][1]["layerId"] == "layer_x"
    with pytest.raises(ProjectError) as err:
        hist.patch_record(pid, "gen_p", {"results": [{"index": 5, "accepted": True}]})
    assert err.value.status == 400


def test_invalid_kind_duplicate_id_and_traversal_are_refused(store, hist):
    pid = store.create_project("History")["id"]
    with pytest.raises(ProjectError):
        hist.create_record(pid, {**_record("gen_k", 1.0, []), "kind": "nope"})
    hist.create_record(pid, _record("gen_k", 1.0, []))
    with pytest.raises(ProjectError) as err:
        hist.create_record(pid, _record("gen_k", 2.0, []))
    assert err.value.status == 409
    with pytest.raises(ProjectError):
        hist.get_record(pid, "../project")
    with pytest.raises(ProjectError) as missing:
        hist.get_record(pid, "gen_missing")
    assert missing.value.status == 404


def test_pruning_drops_discarded_results_first_then_whole_records(store, hist):
    pid = store.create_project("History")["id"]
    hist.create_record(pid, _record("gen_1", 1.0, [(10, 0, 0, 255), (11, 0, 0, 255)], accepted=(0,)))
    hist.create_record(pid, _record("gen_2", 2.0, [(20, 0, 0, 255), (21, 0, 0, 255)], accepted=(0,)))
    hist.create_record(pid, _record("gen_3", 3.0, [(30, 0, 0, 255), (31, 0, 0, 255)], accepted=(0,)))
    discarded_1 = _sha(_png((11, 0, 0, 255)))
    discarded_2 = _sha(_png((21, 0, 0, 255)))
    discarded_3 = _sha(_png((31, 0, 0, 255)))
    accepted_1 = _sha(_png((10, 0, 0, 255)))
    size = lambda sha: os.path.getsize(store.blob_path(pid, sha))  # noqa: E731
    # Room for everything but one byte: only the oldest discarded result goes.
    pruned = hist.prune(pid, max_bytes=hist.usage(pid)["bytes"] - 1)
    assert pruned["records"] == [] and pruned["results"] == 1 and pruned["blobs"] == [discarded_1]
    assert [item["accepted"] for item in hist.get_record(pid, "gen_1")["results"]] == [True]
    assert os.path.isfile(store.blob_path(pid, discarded_2))
    # Less than what stays after every discarded result is gone: then the oldest record goes.
    pruned = hist.prune(pid, max_bytes=hist.usage(pid)["bytes"] - size(discarded_2) - size(discarded_3) - 1)
    assert pruned["results"] == 2 and pruned["records"] == ["gen_1"]
    assert sorted(pruned["blobs"]) == sorted([discarded_2, discarded_3, accepted_1])
    assert [record["id"] for record in hist.list_records(pid)["records"]] == ["gen_3", "gen_2"]


def test_pruning_by_record_count_removes_the_oldest(store, hist):
    pid = store.create_project("History")["id"]
    store.patch_project(pid, {"settings": {"history": {"maxRecords": 2}}})
    for index in range(3):
        result = hist.create_record(pid, _record(f"gen_{index}", float(index), [(index, 9, 9, 255)]))
    assert result["pruned"]["records"] == ["gen_0"]
    assert [record["id"] for record in hist.list_records(pid)["records"]] == ["gen_2", "gen_1"]


def test_pruning_never_deletes_blobs_a_scene_references(store, hist):
    pid = store.create_project("History")["id"]
    scene_id = store.load_project(pid)["scenes"][0]["id"]
    shared = _png((77, 77, 77, 255))
    store.put_scene(pid, scene_id, {"layers": [{"id": "l1", "dataURL": _data_url(shared), "crop": None}]})
    hist.create_record(pid, _record("gen_s", 1.0, [(77, 77, 77, 255), (78, 0, 0, 255)]))
    pruned = hist.prune(pid, max_records=1, max_bytes=1)
    assert pruned["records"] == ["gen_s"]
    assert os.path.isfile(store.blob_path(pid, _sha(shared)))
    assert _sha(shared) not in pruned["blobs"]
    assert not os.path.isfile(store.blob_path(pid, _sha(_png((78, 0, 0, 255)))))


def test_protected_blobs_do_not_count_against_the_byte_cap(store, hist):
    pid = store.create_project("History")["id"]
    scene_id = store.load_project(pid)["scenes"][0]["id"]
    shared = _png((5, 5, 5, 255))
    store.put_scene(pid, scene_id, {"layers": [{"id": "l1", "dataURL": _data_url(shared), "crop": None}]})
    record = _record("gen_c", 1.0, [(5, 5, 5, 255)], accepted=(0,))
    record["inputs"] = {}
    hist.create_record(pid, record)
    assert hist.prune(pid, max_bytes=1) == {"records": [], "results": 0, "blobs": []}


def test_gc_keeps_blobs_only_history_references(store, hist):
    pid = store.create_project("History")["id"]
    hist.create_record(pid, _record("gen_gc", 1.0, [(3, 3, 3, 255)]))
    assert store.collect_garbage(pid, now=10 ** 12) == []


def test_retention_settings_fall_back_to_defaults():
    assert history.retention_settings({}) == {"maxRecords": 1000, "maxBytes": 4 * 1024 ** 3}
    assert history.retention_settings({"settings": {"history": {"maxRecords": "5", "maxBytes": -1}}}) == {"maxRecords": 5, "maxBytes": 4 * 1024 ** 3}


def test_history_routes_map_errors_to_status_codes(user_root):
    web = pytest.importorskip("aiohttp.web")
    projects = {}

    def factory(user):
        return projects.setdefault(user, ProjectStore(str(user_root), user))

    table = {(method, path): handler for method, path, handler in history.history_routes(web, lambda request, size: True, factory)}
    base = "/vnccs/unicanvas/projects/{id}/history"
    for key in [("GET", base), ("POST", base), ("POST", f"{base}/prune"), ("GET", f"{base}/{{hid}}"),
                ("PATCH", f"{base}/{{hid}}"), ("DELETE", f"{base}/{{hid}}")]:
        assert key in table, key
    # routes.py registers them through project_routes.
    from nodes.unicanvas import projects as project_module
    project_table = {(method, path) for method, path, _ in project_module.project_routes(web, lambda request, size: True, factory)}
    assert set(table) <= project_table

    class Request:
        def __init__(self, match_info=None, payload=None, query=None):
            self.match_info = match_info or {}
            self._payload = payload
            self.can_read_body = payload is not None
            self.headers = {}
            self.query = query or {}

        async def json(self):
            return self._payload

    async def call(method, path, **kwargs):
        response = await table[(method, path)](Request(**kwargs))
        return response.status, json.loads(response.body)

    async def scenario():
        pid = factory("default").create_project("Routes")["id"]
        status, body = await call("POST", base, match_info={"id": pid}, payload=_record("gen_r", 1.0, [(1, 0, 0, 255)] * 3, accepted=(1,)))
        assert status == 200 and len(body["record"]["results"]) == 3
        status, body = await call("GET", base, match_info={"id": pid})
        assert status == 200 and [record["id"] for record in body["records"]] == ["gen_r"]
        status, body = await call("PATCH", f"{base}/{{hid}}", match_info={"id": pid, "hid": "gen_r"},
                                  payload={"results": [{"index": 0, "accepted": True, "layerId": "l0"}]})
        assert status == 200 and body["results"][0]["accepted"] is True
        status, body = await call("GET", f"{base}/{{hid}}", match_info={"id": pid, "hid": "missing"})
        assert status == 404 and "error" in body
        status, body = await call("POST", base, match_info={"id": pid}, payload={"kind": "bad"})
        assert status == 400 and "error" in body
        status, body = await call("POST", f"{base}/prune", match_info={"id": pid})
        assert status == 200 and body["records"] == []
        status, body = await call("DELETE", f"{base}/{{hid}}", match_info={"id": pid, "hid": "gen_r"})
        assert status == 200 and body == {"deleted": True}
        status, body = await call("GET", base, match_info={"id": "missing"})
        assert status == 404

    asyncio.run(scenario())


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q", "-p", "no:cacheprovider"]))
