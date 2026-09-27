"""The extension's web files are served with no-cache so browsers never run a stale build."""

import asyncio
import importlib.util
import os
import sys
import tempfile
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_web_cache():
    spec = importlib.util.spec_from_file_location("vnccs_web_cache_under_test", os.path.join(ROOT, "api", "web_cache.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


web_cache = _load_web_cache()
HAS_AIOHTTP = importlib.util.find_spec("aiohttp") is not None


class _Middlewares(list):
    frozen = False

    def append(self, item):
        if self.frozen:
            raise RuntimeError("Cannot modify frozen list.")
        super().append(item)


class WebCachePrefixTests(unittest.TestCase):
    def test_prefix_is_the_extension_folder_comfyui_serves(self):
        folder = os.path.join("custom_nodes", "ComfyUI_VNCCS_Utils")
        self.assertEqual(web_cache.extension_web_prefix(folder), "/extensions/ComfyUI_VNCCS_Utils/")
        self.assertEqual(web_cache.extension_web_prefix(folder + os.sep), "/extensions/ComfyUI_VNCCS_Utils/")


class WebCacheRegistrationTests(unittest.TestCase):
    def setUp(self):
        if not HAS_AIOHTTP:
            # Only the web.middleware decorator is needed to build the middleware.
            stub = types.ModuleType("aiohttp")
            stub.web = types.SimpleNamespace(middleware=lambda fn: fn)
            sys.modules["aiohttp"] = stub
            self.addCleanup(sys.modules.pop, "aiohttp", None)

    def test_registers_on_a_starting_app(self):
        app = types.SimpleNamespace(middlewares=_Middlewares())
        self.assertTrue(web_cache.register_web_cache_middleware(app, ROOT))
        self.assertEqual(len(app.middlewares), 1)

    def test_a_running_app_is_left_alone(self):
        middlewares = _Middlewares()
        middlewares.frozen = True
        app = types.SimpleNamespace(middlewares=middlewares)
        self.assertFalse(web_cache.register_web_cache_middleware(app, ROOT))

    def test_only_extension_paths_get_the_header(self):
        middleware = web_cache.make_web_cache_middleware("/extensions/ComfyUI_VNCCS_Utils/")

        async def handler(_request):
            return types.SimpleNamespace(headers={})

        def run(path):
            return asyncio.run(middleware(types.SimpleNamespace(path=path), handler)).headers

        self.assertEqual(run("/extensions/ComfyUI_VNCCS_Utils/vnccs_unicanvas_util.mjs"), {"Cache-Control": "no-cache"})
        self.assertEqual(run("/extensions/other_pack/widget.mjs"), {})
        self.assertEqual(run("/extensions/ComfyUI_VNCCS_Utils_fork/x.mjs"), {})


@unittest.skipUnless(HAS_AIOHTTP, "aiohttp is not installed")
class WebCacheServerTests(unittest.TestCase):
    """A real aiohttp static route behind a ComfyUI-style outer cache middleware."""

    def test_mjs_revalidates_and_wins_over_comfyui_js_default(self):
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer

        @web.middleware
        async def comfy_cache_control(request, handler):
            # Mirrors ComfyUI's middleware/cache_middleware.py: .js is no-store, .mjs untouched.
            response = await handler(request)
            if request.path.endswith(".js"):
                response.headers.setdefault("Cache-Control", "no-store")
            return response

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                ext_dir = os.path.join(tmp, "ComfyUI_VNCCS_Utils")
                os.makedirs(os.path.join(ext_dir, "web"))
                for name in ("mod.mjs", "entry.js"):
                    with open(os.path.join(ext_dir, "web", name), "w", encoding="utf-8") as handle:
                        handle.write("export const x = 1;\n")
                app = web.Application(middlewares=[comfy_cache_control])
                self.assertTrue(web_cache.register_web_cache_middleware(app, ext_dir))
                app.add_routes([web.static("/extensions/ComfyUI_VNCCS_Utils", os.path.join(ext_dir, "web"))])
                async with TestClient(TestServer(app)) as client:
                    first = await client.get("/extensions/ComfyUI_VNCCS_Utils/mod.mjs")
                    self.assertEqual(first.status, 200)
                    self.assertEqual(first.headers.get("Cache-Control"), "no-cache")
                    again = await client.get(
                        "/extensions/ComfyUI_VNCCS_Utils/mod.mjs",
                        headers={"If-Modified-Since": first.headers["Last-Modified"]},
                    )
                    self.assertEqual(again.status, 304)
                    entry = await client.get("/extensions/ComfyUI_VNCCS_Utils/entry.js")
                    self.assertEqual(entry.headers.get("Cache-Control"), "no-cache")

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
