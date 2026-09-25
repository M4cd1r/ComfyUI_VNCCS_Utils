"""Control preprocess route and registry (issue #46): stubbed depth/lineart models, real canny."""

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

from nodes.unicanvas import control_preprocess, depth, helper_models, routes


def _data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _decode(url: str) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))))


def _square(size: int = 48, lo: int = 12, hi: int = 36) -> Image.Image:
    image = Image.new("RGB", (size, size), (0, 0, 0))
    image.paste((230, 230, 230), (lo, lo, hi, hi))
    return image


def test_registry_holds_the_builtin_preprocessors_and_accepts_new_ones(monkeypatch):
    assert {"depth", "canny", "lineart"} <= set(control_preprocess.control_preprocessor_keys())
    assert control_preprocess.get_control_preprocessor("pose") is None, "pose is drawn in the browser"
    monkeypatch.setattr(control_preprocess, "_CONTROL_PREPROCESSORS", dict(control_preprocess._CONTROL_PREPROCESSORS))
    entry = control_preprocess.register_control_preprocessor(
        "gray", lambda image, _params: (np.asarray(image.convert("L"), dtype=np.float64) / 255.0, "gray8", "none"), label="Gray"
    )
    assert control_preprocess.get_control_preprocessor("gray") is entry
    result = control_preprocess._run_unicanvas_control_preprocess({"image": _data_url(Image.new("RGB", (4, 3), (255, 255, 255))), "type": "gray"})
    assert (result["width"], result["height"], result["type"]) == (4, 3, "gray")
    assert _decode(result["raw"]).min() == 255
    with pytest.raises(ValueError):
        control_preprocess.register_control_preprocessor("", lambda image, params: None)


def test_real_canny_outlines_a_square():
    pytest.importorskip("cv2")
    result = control_preprocess._run_unicanvas_control_preprocess({"image": _data_url(_square()), "type": "canny", "params": {"low": 50, "high": 150, "blur": 0}})
    edges = _decode(result["raw"])
    assert edges.shape == (48, 48)
    assert result["encoding"] == "gray8"
    assert edges[24, 24] == 0 and edges[2, 2] == 0
    assert edges[24, 10:14].max() == 255, "the left side of the square is an edge"
    # Params are clamped instead of failing.
    wild = control_preprocess._run_unicanvas_control_preprocess({"image": _data_url(_square()), "type": "canny", "params": {"low": "x", "high": 1e9, "blur": -3}})
    assert _decode(wild["raw"]).shape == (48, 48)


def test_depth_uses_the_depth_model_and_answers_16_bit(monkeypatch):
    calls = []

    def fake_predict(image):
        calls.append(image.size)
        ys = np.mgrid[0 : image.height, 0 : image.width][0].astype(np.float32)
        return ys * 3.0 + 7.0

    monkeypatch.setattr(depth, "_predict_depth", fake_predict)
    result = control_preprocess._run_unicanvas_control_preprocess({"image": _data_url(Image.new("RGB", (10, 6))), "type": "depth"})
    assert calls == [(10, 6)]
    assert result["encoding"] == "gray16" and result["model"] == depth.DEPTH_MODEL_KEY
    values = _decode(result["raw"])
    assert values.shape == (6, 10)
    assert values.min() == 0 and values.max() == 65535, "normalized to the full range"


def test_lineart_output_is_line_strength_at_the_input_size(monkeypatch):
    monkeypatch.setattr(control_preprocess, "_predict_lineart", lambda image: np.full((image.height, image.width), 0.5))
    result = control_preprocess._run_unicanvas_control_preprocess({"image": _data_url(Image.new("RGB", (7, 5))), "type": "lineart"})
    assert result["model"] == control_preprocess.LINEART_MODEL_KEY
    assert _decode(result["raw"]).shape == (5, 7)


def test_lineart_model_is_pinned_and_downloaded_without_credentials():
    helper = helper_models.HELPER_MODELS[control_preprocess.LINEART_MODEL_KEY]
    assert helper.repo_id == "lllyasviel/Annotators"
    assert len(helper.revision) == 40 and all(c in "0123456789abcdef" for c in helper.revision)
    assert helper.files == ("sk_model.pth",)
    assert control_preprocess._MODEL == {}, "nothing is loaded at import time"


def test_lineart_generator_runs_on_a_tiny_image(monkeypatch):
    torch = pytest.importorskip("torch")
    model = control_preprocess._lineart_generator().eval()
    monkeypatch.setattr(control_preprocess, "_load_lineart_model", lambda: (model, torch.device("cpu")))
    values = control_preprocess._predict_lineart(Image.new("RGB", (13, 9), (128, 64, 32)))
    assert values.shape == (9, 13)
    assert 0.0 <= values.min() and values.max() <= 1.0
    # The state dict keys match the annotator's weights layout.
    keys = set(model.state_dict())
    assert {"model0.1.weight", "model1.0.weight", "model2.0.conv_block.1.weight", "model3.0.weight", "model4.1.weight"} <= keys


def test_worker_errors():
    with pytest.raises(ValueError, match="needs an 'image'"):
        control_preprocess._run_unicanvas_control_preprocess({"type": "canny"})
    with pytest.raises(ValueError, match="Unknown control preprocessor 'scribble'"):
        control_preprocess._run_unicanvas_control_preprocess({"image": _data_url(Image.new("RGB", (2, 2))), "type": "scribble"})
    with pytest.raises(ValueError, match="Unknown control preprocessor"):
        control_preprocess._run_unicanvas_control_preprocess({"image": _data_url(Image.new("RGB", (2, 2))), "type": "pose"})


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


class _Request:
    def __init__(self, payload, length=None):
        self._body = json.dumps(payload)
        self.headers = {"Content-Length": str(len(self._body) if length is None else length)}
        self.can_read_body = True

    async def json(self):
        return json.loads(self._body)


def _handler(monkeypatch):
    pytest.importorskip("aiohttp.web")
    table = _Routes()
    monkeypatch.setattr(sys.modules["server"], "PromptServer", types.SimpleNamespace(instance=types.SimpleNamespace(routes=table)), raising=False)
    monkeypatch.setattr(routes, "_UNICANVAS_LAYER_ROUTES_REGISTERED", False)
    monkeypatch.setattr(routes, "project_routes", lambda web, check: [])
    routes.register_unicanvas_layer_routes()
    return table.handlers[("POST", "/vnccs/unicanvas/control_preprocess")]


def test_route_answers_with_the_raw_map(monkeypatch):
    handler = _handler(monkeypatch)
    monkeypatch.setattr(depth, "_predict_depth", lambda image: np.ones((image.height, image.width), dtype=np.float32))
    response = asyncio.run(handler(_Request({"image": _data_url(Image.new("RGB", (8, 8))), "type": "depth"})))
    assert response.status == 200
    body = json.loads(response.body)
    assert (body["width"], body["height"], body["type"]) == (8, 8, "depth")
    assert body["raw"].startswith("data:image/png;base64,")


def test_route_errors(monkeypatch):
    handler = _handler(monkeypatch)
    unknown = asyncio.run(handler(_Request({"image": _data_url(Image.new("RGB", (4, 4))), "type": "nope"})))
    assert unknown.status == 400 and "Unknown control preprocessor" in json.loads(unknown.body)["error"]
    missing = asyncio.run(handler(_Request({"type": "depth"})))
    assert missing.status == 400
    too_big = asyncio.run(handler(_Request({"type": "depth"}, length=routes._MAX_UPLOAD_BYTES * 4)))
    assert too_big.status == 413 and "too large" in json.loads(too_big.body)["error"]

    def broken(_image):
        raise RuntimeError("model exploded")

    monkeypatch.setattr(depth, "_predict_depth", broken)
    failed = asyncio.run(handler(_Request({"image": _data_url(Image.new("RGB", (4, 4))), "type": "depth"})))
    assert failed.status == 500 and json.loads(failed.body)["error"] == "model exploded"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
