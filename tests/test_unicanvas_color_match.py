import base64
import io

import numpy as np
import pytest
import torch
from PIL import Image

from nodes import unicanvas
from nodes.unicanvas import (
    UC_COLOR_MATCH_METHODS,
    _apply_color_match_strength,
    _color_match_transfer,
    _np_srgb_to_lab,
    _reinhard_lab_gpu_transfer,
    _reinhard_lab_transfer_np,
    _run_unicanvas_color_match,
)

# Mid-range (in-gamut) samples keep the LAB round trip free of clipping so
# mean/std assertions stay exact.
_SRC = torch.tensor((0.2 + 0.5 * np.random.RandomState(0).rand(6, 5, 3)).astype(np.float32))
_REF = torch.tensor((0.2 + 0.5 * np.random.RandomState(1).rand(6, 5, 3)).astype(np.float32))


def _png_data_url(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _decode_result_image(result):
    payload = result["image"].split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(payload)))


def test_method_list_matches_design_spec():
    assert UC_COLOR_MATCH_METHODS == (
        "mkl",
        "hm",
        "reinhard",
        "mvgd",
        "hm-mvgd-hm",
        "hm-mkl-hm",
        "reinhard_lab_gpu",
    )


@pytest.mark.parametrize("method", UC_COLOR_MATCH_METHODS)
def test_every_method_runs_on_small_tensors(monkeypatch, method):
    calls = []

    class RecordingMatcher:
        def transfer(self, src=None, ref=None, method=None):
            calls.append(method)
            return np.asarray(ref, dtype=np.uint8).copy()

    monkeypatch.setattr(unicanvas, "_load_color_matcher_class", lambda: RecordingMatcher)

    matched, engine = _color_match_transfer(_SRC, _REF, method)

    assert tuple(matched.shape) == tuple(_SRC.shape)
    assert float(matched.min()) >= 0.0
    assert float(matched.max()) <= 1.0
    if method == "reinhard_lab_gpu":
        assert engine == "reinhard_lab_gpu"
        assert calls == []
    else:
        assert engine == "color-matcher"
        assert calls == [method]


def test_strength_scaling_blends_toward_matched():
    src = torch.full((4, 4, 3), 0.25, dtype=torch.float32)
    matched = torch.full((4, 4, 3), 0.75, dtype=torch.float32)

    assert torch.allclose(_apply_color_match_strength(src, matched, 0.0), src)
    assert torch.allclose(_apply_color_match_strength(src, matched, 10.0), matched)
    assert torch.allclose(_apply_color_match_strength(src, matched, 5.0), torch.full((4, 4, 3), 0.5))
    # strength is clamped to 0..10
    assert torch.allclose(_apply_color_match_strength(src, matched, 25.0), matched)
    assert torch.allclose(_apply_color_match_strength(src, matched, "5"), torch.full((4, 4, 3), 0.5))


def test_missing_dependency_falls_back_to_pure_reinhard(monkeypatch):
    monkeypatch.setattr(unicanvas, "_load_color_matcher_class", lambda: None)

    matched, engine = _color_match_transfer(_SRC, _REF, "mkl")

    assert engine == "reinhard-fallback"
    matched_lab = _np_srgb_to_lab(matched.numpy())
    ref_lab = _np_srgb_to_lab(_REF.numpy())
    # Pure Reinhard matches the reference LAB mean and std.
    assert np.allclose(matched_lab.mean(axis=(0, 1)), ref_lab.mean(axis=(0, 1)), atol=1.0)
    assert np.allclose(matched_lab.std(axis=(0, 1)), ref_lab.std(axis=(0, 1)), atol=1.0)


def test_reinhard_lab_gpu_matches_pure_reinhard():
    gpu = _reinhard_lab_gpu_transfer(_SRC, _REF)
    pure = torch.from_numpy(_reinhard_lab_transfer_np(_SRC.numpy(), _REF.numpy()))

    assert torch.allclose(gpu, pure, atol=2e-2)


def test_run_color_match_preserves_alpha_and_reports_engine(monkeypatch):
    monkeypatch.setattr(unicanvas, "_load_color_matcher_class", lambda: None)
    target = Image.new("RGBA", (4, 4), (200, 40, 40, 128))
    reference = Image.new("RGB", (4, 4), (40, 200, 40))

    result = _run_unicanvas_color_match({
        "image": _png_data_url(target),
        "reference": _png_data_url(reference),
        "method": "hm",
        "strength": 10,
    })

    assert result["engine"] == "reinhard-fallback"
    assert result["method"] == "hm"
    assert result["strength"] == 10.0
    out = _decode_result_image(result)
    assert out.mode == "RGBA"
    assert out.getpixel((0, 0))[3] == 128
    # Full strength moves the target toward the green reference.
    assert out.getpixel((0, 0))[1] > out.getpixel((0, 0))[0]


def test_unknown_color_match_method_is_rejected():
    with pytest.raises(ValueError, match=r"\[VNCCS UniCanvas\] Unknown color match method"):
        _color_match_transfer(_SRC, _REF, "nope")
