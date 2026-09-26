"""Depth route (model mocked) and horizon estimation from a depth map (Plan 08, #11)."""

from __future__ import annotations

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

import numpy as np
import pytest
from PIL import Image

from nodes.unicanvas import depth, routes


def _planar_ground(height: int, width: int, horizon: float, slope: float = 0.01, tilt: float = 0.0) -> np.ndarray:
    """Inverse depth of a flat ground: linear in the row below the horizon, sky (0) above it."""
    ys, xs = np.mgrid[0:height, 0:width].astype(np.float64)
    ground = slope * (ys - horizon) + tilt * (xs - (width - 1) / 2.0)
    return np.clip(ground, 0.0, None).astype(np.float32)


def _data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


@pytest.mark.parametrize("horizon", [60.0, 150.0, -40.0])
def test_horizon_of_a_planar_depth_map(horizon):
    height, width = 300, 240
    found = depth.estimate_horizon(_planar_ground(height, width, horizon))
    assert found is not None
    assert abs(found - horizon) <= 0.02 * height


def test_horizon_ignores_a_figure_standing_on_the_ground():
    height, width, horizon = 320, 256, 90.0
    ground = _planar_ground(height, width, horizon)
    ground[200:300, 100:140] = ground.max() * 1.5  # a person much closer than the ground behind
    found = depth.estimate_horizon(ground)
    assert found is not None and abs(found - horizon) <= 0.02 * height


def test_no_horizon_without_a_receding_ground():
    assert depth.estimate_horizon(np.full((120, 90), 0.5, dtype=np.float32)) is None
    ceiling = _planar_ground(120, 90, 10.0)[::-1].copy()  # closer toward the TOP of the picture
    assert depth.estimate_horizon(ceiling) is None


def test_depth_png_is_16_bit_at_the_input_size():
    url = depth.depth_to_png16(_planar_ground(24, 32, 5.0))
    image = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))
    assert image.size == (32, 24)
    assert image.mode in {"I;16", "I"}
    values = np.asarray(image)
    assert values.max() == 65535 and values.min() == 0


def test_depth_worker_with_the_model_mocked(monkeypatch):
    calls = []

    def fake_predict(image):
        calls.append(image.size)
        return _planar_ground(image.height, image.width, 4.0, slope=0.2)

    monkeypatch.setattr(depth, "_predict_depth", fake_predict)
    result = depth._run_unicanvas_depth({"image": _data_url(Image.new("RGB", (16, 12), (40, 80, 120)))})
    assert calls == [(16, 12)]
    assert (result["width"], result["height"]) == (16, 12)
    assert abs(result["horizonY"] - 4.0) <= 0.02 * 12
    decoded = Image.open(io.BytesIO(base64.b64decode(result["depth"].split(",", 1)[1])))
    assert decoded.size == (16, 12)
    with pytest.raises(ValueError):
        depth._run_unicanvas_depth({})


class _Routes:
    def __init__(self):
        self.handlers = {}

    def _add(self, method, path):
        def decorator(handler):
            self.handlers[(method, path)] = handler
            return handler

        return decorator

    def get(self, path):
        return self._add("GET", path)

    def post(self, path):
        return self._add("POST", path)

    def put(self, path):
        return self._add("PUT", path)

    def patch(self, path):
        return self._add("PATCH", path)

    def delete(self, path):
        return self._add("DELETE", path)


class _Request:
    def __init__(self, payload):
        self._body = json.dumps(payload)
        self.headers = {"Content-Length": str(len(self._body))}
        self.can_read_body = True

    async def json(self):
        return json.loads(self._body)


def _depth_handler(monkeypatch):
    pytest.importorskip("aiohttp.web")
    table = _Routes()
    monkeypatch.setattr(sys.modules["server"], "PromptServer", types.SimpleNamespace(instance=types.SimpleNamespace(routes=table)), raising=False)
    monkeypatch.setattr(routes, "_UNICANVAS_LAYER_ROUTES_REGISTERED", False)
    monkeypatch.setattr(routes, "project_routes", lambda web, check: [])
    routes.register_unicanvas_layer_routes()
    return table.handlers[("POST", "/vnccs/unicanvas/depth")]


def test_depth_route_on_a_tiny_image(monkeypatch):
    handler = _depth_handler(monkeypatch)
    monkeypatch.setattr(depth, "_predict_depth", lambda image: _planar_ground(image.height, image.width, 2.0, slope=0.5))
    response = asyncio.run(handler(_Request({"image": _data_url(Image.new("RGB", (8, 8), (255, 0, 0)))})))
    assert response.status == 200
    body = json.loads(response.body)
    assert (body["width"], body["height"]) == (8, 8)
    assert body["depth"].startswith("data:image/png;base64,")

    bad = asyncio.run(handler(_Request({"image": ""})))
    assert bad.status == 400 and "error" in json.loads(bad.body)

    def broken(_image):
        raise RuntimeError("model exploded")

    monkeypatch.setattr(depth, "_predict_depth", broken)
    failed = asyncio.run(handler(_Request({"image": _data_url(Image.new("RGB", (8, 8)))})))
    assert failed.status == 500 and json.loads(failed.body)["error"] == "model exploded"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
