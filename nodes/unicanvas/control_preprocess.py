"""Control images from the scene for the ControlNet layer (issue #46).

Backs ``POST /vnccs/unicanvas/control_preprocess`` ``{ image, type, params }`` ->
``{ type, width, height, raw, encoding, model }``:

- ``image`` is the flattened scene inside the bbox (the browser's ``makeExportCanvas("image")``).
- ``raw`` is a grayscale PNG data URL at the input size. It is the preprocessor's raw output, not
  the final control image: the browser keeps it per source and turns it into the control layer
  with its live sliders (depth clip/gamma/invert, lineart threshold/thickness/invert), so dragging
  a slider never goes back to the server. ``encoding`` is ``gray16`` (depth) or ``gray8``.

Preprocessors are a registry (``register_control_preprocessor``), not an ``if`` chain:

- ``depth`` reuses Depth Anything V2 Small from ``depth.py`` (near is bright).
- ``lineart`` runs the Informative Drawings generator (MIT) that the ControlNet lineart annotator
  uses, pinned in ``helper_models`` and downloaded on first use; kept loaded like the depth model,
  ``unload_lineart_model`` frees it. The raw output is line strength (lines bright, paper black).
- ``canny`` is OpenCV Canny with ``low`` / ``high`` / ``blur`` params. The browser has its own
  realtime Canny for the sliders; this one serves API callers and tests.

Pose control images are drawn in the browser from the pose layers (no model), so pose is not here.
"""

from __future__ import annotations

import base64
import io
import threading
from dataclasses import dataclass
from typing import Any, Callable

import numpy as np
from PIL import Image

from .helper_models import ensure_helper_model_file
from .locks import _COMFY_MODEL_OP_LOCK


LINEART_MODEL_KEY = "lineart_informative_drawings"
# The generator halves the size twice; inputs are padded to a multiple of this.
_LINEART_MULTIPLE = 8
_LINEART_MAX_SIDE = 1024
_MODEL_LOCK = threading.Lock()
_MODEL: dict[str, Any] = {}


@dataclass(frozen=True)
class ControlPreprocessor:
    key: str
    label: str
    # (RGB image, params) -> (raw array at the image size, encoding "gray8" | "gray16", model key)
    run: Callable[[Image.Image, dict[str, Any]], tuple[np.ndarray, str, str]]
    uses_model: bool = False


_CONTROL_PREPROCESSORS: dict[str, ControlPreprocessor] = {}


def register_control_preprocessor(
    key: str,
    run: Callable[[Image.Image, dict[str, Any]], tuple[np.ndarray, str, str]],
    *,
    label: str | None = None,
    uses_model: bool = False,
) -> ControlPreprocessor:
    if not isinstance(key, str) or not key:
        raise ValueError("A control preprocessor needs a key.")
    entry = ControlPreprocessor(key=key, label=label or key, run=run, uses_model=uses_model)
    _CONTROL_PREPROCESSORS[key] = entry
    return entry


def get_control_preprocessor(key: str) -> ControlPreprocessor | None:
    return _CONTROL_PREPROCESSORS.get(key)


def control_preprocessor_keys() -> list[str]:
    return list(_CONTROL_PREPROCESSORS)


def _float_param(params: dict[str, Any], name: str, default: float, low: float, high: float) -> float:
    try:
        value = float(params.get(name, default))
    except (TypeError, ValueError):
        value = default
    if not np.isfinite(value):
        value = default
    return min(high, max(low, value))


def gray_png(values: np.ndarray, encoding: str = "gray8") -> str:
    """A 0..1 float array as a grayscale PNG data URL (8 or 16 bit)."""
    clipped = np.clip(np.nan_to_num(np.asarray(values, dtype=np.float64)), 0.0, 1.0)
    if encoding == "gray16":
        image = Image.fromarray(np.round(clipped * 65535.0).astype(np.uint16))
    else:
        image = Image.fromarray(np.round(clipped * 255.0).astype(np.uint8), mode="L")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _normalize(values: np.ndarray) -> np.ndarray:
    array = np.nan_to_num(np.asarray(values, dtype=np.float64))
    low, high = (float(array.min()), float(array.max())) if array.size else (0.0, 0.0)
    return (array - low) / (high - low) if high > low else np.zeros_like(array)


# --- depth -----------------------------------------------------------------------------------


def _depth_preprocess(image: Image.Image, _params: dict[str, Any]) -> tuple[np.ndarray, str, str]:
    from . import depth

    with _COMFY_MODEL_OP_LOCK:
        values = depth._predict_depth(image)
    return _normalize(values), "gray16", depth.DEPTH_MODEL_KEY


# --- canny -----------------------------------------------------------------------------------


def canny_edges(image: Image.Image, low: float = 100.0, high: float = 200.0, blur: float = 1.0) -> np.ndarray:
    """OpenCV Canny on the luminance: 1.0 on edges, 0.0 elsewhere. ``blur`` is a Gaussian sigma."""
    import cv2

    gray = np.asarray(image.convert("L"), dtype=np.uint8)
    if blur > 0:
        gray = cv2.GaussianBlur(gray, (0, 0), sigmaX=float(blur))
    low, high = sorted((float(low), float(high)))
    return (cv2.Canny(gray, low, high) > 0).astype(np.float64)


def _canny_preprocess(image: Image.Image, params: dict[str, Any]) -> tuple[np.ndarray, str, str]:
    low = _float_param(params, "low", 100.0, 0.0, 1000.0)
    high = _float_param(params, "high", 200.0, 0.0, 1000.0)
    blur = _float_param(params, "blur", 1.0, 0.0, 10.0)
    return canny_edges(image, low, high, blur), "gray8", "opencv_canny"


# --- lineart ---------------------------------------------------------------------------------


def _lineart_generator():
    """The Informative Drawings generator (3 residual blocks), as the ControlNet annotator builds it."""
    import torch.nn as nn

    norm = nn.InstanceNorm2d

    class ResidualBlock(nn.Module):
        def __init__(self, features: int):
            super().__init__()
            self.conv_block = nn.Sequential(
                nn.ReflectionPad2d(1), nn.Conv2d(features, features, 3), norm(features), nn.ReLU(inplace=True),
                nn.ReflectionPad2d(1), nn.Conv2d(features, features, 3), norm(features),
            )

        def forward(self, x):
            return x + self.conv_block(x)

    class Generator(nn.Module):
        def __init__(self, blocks: int = 3):
            super().__init__()
            self.model0 = nn.Sequential(nn.ReflectionPad2d(3), nn.Conv2d(3, 64, 7), norm(64), nn.ReLU(inplace=True))
            down, features = [], 64
            for _ in range(2):
                down += [nn.Conv2d(features, features * 2, 3, stride=2, padding=1), norm(features * 2), nn.ReLU(inplace=True)]
                features *= 2
            self.model1 = nn.Sequential(*down)
            self.model2 = nn.Sequential(*[ResidualBlock(features) for _ in range(blocks)])
            up = []
            for _ in range(2):
                up += [nn.ConvTranspose2d(features, features // 2, 3, stride=2, padding=1, output_padding=1), norm(features // 2), nn.ReLU(inplace=True)]
                features //= 2
            self.model3 = nn.Sequential(*up)
            self.model4 = nn.Sequential(nn.ReflectionPad2d(3), nn.Conv2d(64, 1, 7), nn.Sigmoid())

        def forward(self, x):
            return self.model4(self.model3(self.model2(self.model1(self.model0(x)))))

    return Generator()


def _torch_device():
    import torch

    try:
        import comfy.model_management as model_management

        device = model_management.get_torch_device()
    except Exception:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if getattr(device, "type", None) not in {"cpu", "cuda"}:
        device = torch.device("cpu")
    return device


def _load_lineart_model():
    with _MODEL_LOCK:
        cached = _MODEL.get(LINEART_MODEL_KEY)
        if cached is not None:
            return cached
        import torch

        path = ensure_helper_model_file(LINEART_MODEL_KEY)
        model = _lineart_generator()
        model.load_state_dict(torch.load(path, map_location="cpu", weights_only=True))
        device = _torch_device()
        _MODEL[LINEART_MODEL_KEY] = (model.to(device).eval(), device)
        return _MODEL[LINEART_MODEL_KEY]


def unload_lineart_model() -> None:
    with _MODEL_LOCK:
        _MODEL.clear()


def _predict_lineart(image: Image.Image) -> np.ndarray:
    """Line strength 0..1 (lines bright) at the input size."""
    import torch

    model, device = _load_lineart_model()
    width, height = image.size
    scale = min(1.0, _LINEART_MAX_SIDE / max(width, height))
    work_w = max(_LINEART_MULTIPLE, int(round(width * scale / _LINEART_MULTIPLE)) * _LINEART_MULTIPLE)
    work_h = max(_LINEART_MULTIPLE, int(round(height * scale / _LINEART_MULTIPLE)) * _LINEART_MULTIPLE)
    work = image.convert("RGB").resize((work_w, work_h), Image.BICUBIC)
    tensor = torch.from_numpy(np.asarray(work, dtype=np.float32) / 255.0).permute(2, 0, 1)[None].to(device)
    with torch.inference_mode():
        # The generator draws dark lines on white paper.
        paper = model(tensor)[0, 0].float().cpu().numpy()
    lines = Image.fromarray(np.clip((1.0 - paper) * 255.0, 0, 255).astype(np.uint8), mode="L")
    return np.asarray(lines.resize((width, height), Image.BILINEAR), dtype=np.float64) / 255.0


def _lineart_preprocess(image: Image.Image, _params: dict[str, Any]) -> tuple[np.ndarray, str, str]:
    with _COMFY_MODEL_OP_LOCK:
        values = _predict_lineart(image)
    return values, "gray8", LINEART_MODEL_KEY


register_control_preprocessor("depth", _depth_preprocess, label="Depth (Depth Anything V2 Small)", uses_model=True)
register_control_preprocessor("canny", _canny_preprocess, label="Canny edges")
register_control_preprocessor("lineart", _lineart_preprocess, label="Lineart (Informative Drawings)", uses_model=True)


# --- route worker ----------------------------------------------------------------------------


def _run_unicanvas_control_preprocess(payload: dict[str, Any]) -> dict[str, Any]:
    from .imaging import _decode_data_url

    payload = payload if isinstance(payload, dict) else {}
    source = payload.get("image")
    if not isinstance(source, str) or not source:
        raise ValueError("[VNCCS UniCanvas] control_preprocess needs an 'image' data URL.")
    kind = payload.get("type")
    entry = get_control_preprocessor(kind) if isinstance(kind, str) else None
    if entry is None:
        known = ", ".join(control_preprocessor_keys())
        raise ValueError(f"[VNCCS UniCanvas] Unknown control preprocessor {kind!r} (known: {known}).")
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    image = _decode_data_url(source, "RGB")
    values, encoding, model = entry.run(image, params)
    values = np.asarray(values)
    if values.shape != (image.height, image.width):
        raise RuntimeError(f"[VNCCS UniCanvas] The {entry.label} preprocessor answered with the wrong size.")
    return {
        "type": entry.key,
        "width": image.width,
        "height": image.height,
        "raw": gray_png(values, encoding),
        "encoding": encoding,
        "model": model,
    }
