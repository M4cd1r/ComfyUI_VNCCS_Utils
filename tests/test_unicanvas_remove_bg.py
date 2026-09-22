import inspect
import sys
import types

import numpy as np
import pytest
import torch
from PIL import Image

from helpers.unicanvas_images import decode_png_data_url, png_data_url
from nodes import unicanvas
from nodes.unicanvas import (
    UC_QI21_REMOVE_BG_UNAVAILABLE,
    _run_unicanvas_remove_bg,
)

EXPECTED_QI21_MESSAGE = (
    "[VNCCS UniCanvas] Remove bg \u2013 QI2.1 requires the Qwen-Image-2.1 module (QI2.1 family)."
)


class _FakeQi21Module:
    """Contract stub for the parallel-branch Qwen-Image-2.1 module."""

    def __init__(self):
        self.received = None

    def remove_background(self, image):
        self.received = image
        height, width = image.shape[0], image.shape[1]
        rgba = torch.zeros((height, width, 4), dtype=torch.float32)
        rgba[..., :3] = image
        rgba[..., 3] = 0.5
        return rgba


class _ModuleWithoutSubjectExtraction:
    pass


def test_qi21_contract_stub_receives_rgb_tensor(monkeypatch):
    fake = _FakeQi21Module()
    monkeypatch.setitem(unicanvas.UNICANVAS_MODEL_MODULES, "qwen_image21", fake)

    image = Image.new("RGB", (4, 3), (200, 100, 50))
    result = _run_unicanvas_remove_bg({"method": "qi21", "image": png_data_url(image)})

    received = fake.received
    assert isinstance(received, torch.Tensor)
    assert tuple(received.shape) == (3, 4, 3)
    assert received.dtype == torch.float32
    assert float(received.min()) >= 0.0
    assert float(received.max()) <= 1.0
    out = decode_png_data_url(result["alpha"])
    assert out.mode == "RGBA"
    assert out.size == (4, 3)
    assert abs(out.getpixel((0, 0))[3] - 128) <= 1
    assert result["method"] == "qi21"


def test_qi21_fails_fast_without_qwen_image21_module(monkeypatch):
    # Simulate the module being absent: the route must fail fast with the exact
    # contract message instead of reaching the real QI2.1 loading path.
    monkeypatch.delitem(unicanvas.UNICANVAS_MODEL_MODULES, "qwen_image21", raising=False)
    with pytest.raises(RuntimeError) as excinfo:
        _run_unicanvas_remove_bg({"method": "qi21", "image": png_data_url(Image.new("RGB", (2, 2)))})

    assert str(excinfo.value) == EXPECTED_QI21_MESSAGE
    assert str(excinfo.value) == UC_QI21_REMOVE_BG_UNAVAILABLE


def test_qi21_fails_fast_without_remove_background(monkeypatch):
    monkeypatch.setitem(unicanvas.UNICANVAS_MODEL_MODULES, "qwen_image21", _ModuleWithoutSubjectExtraction())

    with pytest.raises(RuntimeError) as excinfo:
        _run_unicanvas_remove_bg({"method": "qi21", "image": png_data_url(Image.new("RGB", (2, 2)))})

    assert str(excinfo.value) == EXPECTED_QI21_MESSAGE


def test_birefnet_loader_resolves_with_dual_form_import(monkeypatch):
    """Exercise the REAL loader path against the real module.

    The loader must try the ComfyUI-relative import form first and fall back to
    the absolute form used under tests/conftest.py's top-level "nodes" stub;
    both forms resolve to the same auto_mask_bgr. Only leaf dependencies that
    are optional in the test venv are stubbed (cv2, folder_paths.models_dir).
    """
    monkeypatch.setitem(sys.modules, "cv2", types.ModuleType("cv2"))
    monkeypatch.setattr(sys.modules["folder_paths"], "models_dir", ".", raising=False)

    masker = unicanvas._uc_load_birefnet_masker()

    from vnccs_sam3d.processing.birefnet_mask import auto_mask_bgr

    assert callable(masker)
    assert masker is auto_mask_bgr
    source = inspect.getsource(unicanvas._uc_load_birefnet_masker)
    assert source.index("from ..vnccs_sam3d") < source.index("from vnccs_sam3d.processing.birefnet_mask")


def test_birefnet_applies_mask_as_alpha(monkeypatch):
    calls = []

    def fake_masker(img_bgr):
        calls.append(img_bgr)
        mask = np.zeros(img_bgr.shape[:2], dtype=np.uint8)
        mask[:, :2] = 1
        return mask, np.array([[0, 0, 1, 1]], dtype=np.float32)

    monkeypatch.setattr(unicanvas, "_uc_load_birefnet_masker", lambda: fake_masker)

    image = Image.new("RGB", (4, 3), (10, 20, 30))
    result = _run_unicanvas_remove_bg({"method": "birefnet", "image": png_data_url(image)})

    assert len(calls) == 1
    # auto_mask_bgr works on BGR arrays.
    assert int(calls[0][0, 0, 0]) == 30
    out = decode_png_data_url(result["alpha"])
    assert out.mode == "RGBA"
    assert out.size == (4, 3)
    assert out.getpixel((0, 0))[3] == 255
    assert out.getpixel((1, 0))[3] == 255
    assert out.getpixel((2, 0))[3] == 0
    assert out.getpixel((3, 2))[3] == 0
    assert result["method"] == "birefnet"


def test_unknown_remove_bg_method_is_rejected():
    with pytest.raises(ValueError, match=r"\[VNCCS UniCanvas\] Unknown remove bg method"):
        _run_unicanvas_remove_bg({"method": "magic", "image": png_data_url(Image.new("RGB", (2, 2)))})
