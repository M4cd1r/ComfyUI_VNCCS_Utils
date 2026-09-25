import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def _load_pose_library():
    aiohttp_module = types.ModuleType("aiohttp")
    aiohttp_module.web = types.SimpleNamespace()
    previous = sys.modules.get("aiohttp")
    sys.modules["aiohttp"] = aiohttp_module
    try:
        spec = importlib.util.spec_from_file_location("vnccs_pose_library_bundled_test", ROOT / "api" / "pose_library.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if previous is None:
            sys.modules.pop("aiohttp", None)
        else:
            sys.modules["aiohttp"] = previous


POSE_LIBRARY = _load_pose_library()


class _Response:
    def __init__(self, data, status=200):
        self.data = data
        self.status = status


class _Request:
    def __init__(self, match_info=None, query=None, body=None):
        self.match_info = match_info or {}
        self.query = query or {}
        self.headers = {"Content-Length": str(len(json.dumps(body or {})))}
        self._body = body or {}

    async def json(self):
        return self._body


class BundledInteractionPresetTests(unittest.TestCase):
    def setUp(self):
        self._library = tempfile.TemporaryDirectory()
        self.addCleanup(self._library.cleanup)
        patches = [
            mock.patch.object(POSE_LIBRARY, "get_library_path", return_value=self._library.name),
            mock.patch.object(POSE_LIBRARY, "load_pose_repositories", return_value=[]),
            mock.patch.object(POSE_LIBRARY.web, "json_response", _Response, create=True),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_presets_are_listed_under_interactions(self):
        response = asyncio.run(POSE_LIBRARY.list_poses(_Request(query={})))
        bundled = [pose for pose in response.data["poses"] if pose["repository"] == POSE_LIBRARY.BUNDLED_REPOSITORY]
        self.assertEqual(len(bundled), 13)
        self.assertEqual({pose["category"] for pose in bundled}, {"Interactions"})
        self.assertTrue(all(pose["has_preview"] for pose in bundled))

    def test_presets_load_by_name_with_and_without_repository(self):
        path, repository, category = POSE_LIBRARY.find_pose_file("Handshake")
        self.assertEqual((repository, category), (POSE_LIBRARY.BUNDLED_REPOSITORY, "Interactions"))
        self.assertTrue(path.endswith("Handshake.json"))
        found = POSE_LIBRARY.find_pose_file("Handshake", POSE_LIBRARY.BUNDLED_REPOSITORY, "Interactions")
        self.assertEqual(found, (path, repository, category))
        self.assertEqual(POSE_LIBRARY.find_pose_file("Handshake", POSE_LIBRARY.BUNDLED_REPOSITORY, "Other"), (None, None, None))

    def test_user_pose_with_the_same_name_wins_without_repository(self):
        local = Path(self._library.name) / POSE_LIBRARY.LOCAL_USER_REPOSITORY / "Mine"
        local.mkdir(parents=True)
        (local / "Hug.json").write_text(json.dumps({"bones": {}}), encoding="utf-8")
        path, repository, _category = POSE_LIBRARY.find_pose_file("Hug")
        self.assertEqual(repository, POSE_LIBRARY.LOCAL_USER_REPOSITORY)
        self.assertEqual(Path(path), local / "Hug.json")

    def test_presets_are_read_only(self):
        query = {"repository": POSE_LIBRARY.BUNDLED_REPOSITORY, "category": "Interactions"}
        response = asyncio.run(POSE_LIBRARY.delete_pose(_Request(match_info={"name": "Hug"}, query=query)))
        self.assertEqual(response.status, 403)
        self.assertTrue((ROOT / "pose_presets" / "Interactions" / "Hug.json").exists())
        for body in (
            {"name": "Hug", "pose": {"bones": {}}, "repository": POSE_LIBRARY.BUNDLED_REPOSITORY, "category": "Interactions"},
            {"name": "Hug 2", "old_name": "Hug", "old_repository": POSE_LIBRARY.BUNDLED_REPOSITORY, "old_category": "Interactions", "pose": {"bones": {}}},
        ):
            response = asyncio.run(POSE_LIBRARY.save_pose(_Request(body=body)))
            self.assertEqual(response.status, 403)
        self.assertTrue((ROOT / "pose_presets" / "Interactions" / "Hug.json").exists())


if __name__ == "__main__":
    unittest.main()
