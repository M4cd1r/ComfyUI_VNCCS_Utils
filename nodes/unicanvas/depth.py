"""Relative depth maps of a background and the ground horizon they imply (Plan 08).

Backs ``POST /vnccs/unicanvas/depth`` ``{ image }`` -> ``{ depth, width, height, horizonY }``:

- ``depth`` is a 16-bit grayscale PNG data URL at the input size. Values are the model's relative
  inverse depth (disparity) normalized to 0..65535, so near is bright and far is dark.
- ``horizonY`` is the image row where the ground plane meets infinity (see ``estimate_horizon``),
  or ``None`` when the lower third of the picture is not a receding ground.

The model is Depth Anything V2 Small (Apache-2.0) through the ``transformers`` depth-estimation
pipeline, downloaded on first use into ``models/depth/`` and kept loaded like the layer-naming
model (``unload_depth_model`` frees it). The client caches answers per background pixel revision.
"""

from __future__ import annotations

import threading
from typing import Any

import numpy as np
from PIL import Image

from .helper_models import ensure_helper_model
from .helper_runtime import gray_png, helper_torch_device, normalize_unit
from .locks import _COMFY_MODEL_OP_LOCK


DEPTH_MODEL_KEY = "depth_anything_v2_small"
_MODEL_LOCK = threading.Lock()
_MODEL: dict[str, Any] = {}
# Plane fit: at most this many samples from the lower third, refit while outliers remain.
_MAX_FIT_SAMPLES = 40_000
_FIT_ROUNDS = 6
_OUTLIER_SIGMA = 2.5


def _load_pipeline() -> Any:
    with _MODEL_LOCK:
        cached = _MODEL.get(DEPTH_MODEL_KEY)
        if cached is not None:
            return cached
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation, pipeline

        root = ensure_helper_model(DEPTH_MODEL_KEY)
        device = helper_torch_device()
        processor = AutoImageProcessor.from_pretrained(root, local_files_only=True)
        model = AutoModelForDepthEstimation.from_pretrained(root, local_files_only=True).to(device).eval()
        _MODEL[DEPTH_MODEL_KEY] = pipeline("depth-estimation", model=model, image_processor=processor, device=device)
        return _MODEL[DEPTH_MODEL_KEY]


def unload_depth_model() -> None:
    with _MODEL_LOCK:
        _MODEL.clear()


def predict_depth(image: Image.Image) -> np.ndarray:
    """Relative inverse depth (near is large), float32 ``(height, width)``; holds the model lock."""
    with _COMFY_MODEL_OP_LOCK:
        return _predict_depth(image)


def _predict_depth(image: Image.Image) -> np.ndarray:
    """Relative inverse depth, float32 ``(height, width)`` at the input size."""
    import torch

    estimator = _load_pipeline()
    with torch.inference_mode():
        result = estimator(image.convert("RGB"))
    predicted = result["predicted_depth"]
    if predicted.ndim == 2:
        predicted = predicted[None, None]
    elif predicted.ndim == 3:
        predicted = predicted[:, None]
    resized = torch.nn.functional.interpolate(predicted.float(), size=(image.height, image.width), mode="bicubic", align_corners=False)
    return resized[0, 0].cpu().numpy().astype(np.float32)


def depth_to_png16(depth: np.ndarray) -> str:
    """A depth array as a 16-bit grayscale PNG data URL (min..max stretched to 0..65535)."""
    return gray_png(normalize_unit(depth), "gray16")


def estimate_horizon(depth: np.ndarray) -> float | None:
    """The row where the ground's inverse depth reaches zero, in pixels (may lie above the image).

    On a flat ground seen by a pinhole camera, inverse depth is linear in the image row and zero at
    the horizon. Fit a plane ``d = a*x + b*y + c`` to the lower third (refit without outliers
    such as people standing on the ground) and intersect it with ``d = 0`` at the image center.
    """
    values = np.asarray(depth, dtype=np.float64)
    if values.ndim != 2 or min(values.shape) < 3:
        return None
    height, width = values.shape
    top = (2 * height) // 3
    stride = max(1, int(np.ceil(np.sqrt((height - top) * width / _MAX_FIT_SAMPLES))))
    ys, xs = np.mgrid[top:height:stride, 0:width:stride]
    samples = values[top:height:stride, 0:width:stride]
    keep = np.isfinite(samples)
    xs, ys, samples = xs[keep].astype(np.float64), ys[keep].astype(np.float64), samples[keep]
    if samples.size < 3:
        return None
    coefficients = None
    for _ in range(_FIT_ROUNDS):
        system = np.column_stack([xs, ys, np.ones_like(xs)])
        coefficients, *_ = np.linalg.lstsq(system, samples, rcond=None)
        residual = samples - system @ coefficients
        # Robust spread (MAD): a figure on the ground must not widen the band it is judged by.
        spread = 1.4826 * float(np.median(np.abs(residual - np.median(residual))))
        inliers = np.abs(residual) <= max(_OUTLIER_SIGMA * spread, 1e-9 * (float(np.abs(samples).max()) or 1.0))
        if inliers.all() or inliers.sum() < 3:
            break
        xs, ys, samples = xs[inliers], ys[inliers], samples[inliers]
    a, b, c = (float(value) for value in coefficients)
    # The ground must come closer toward the bottom of the picture.
    value_range = float(np.nanmax(values) - np.nanmin(values)) or 1.0
    if b <= 1e-6 * value_range / height:
        return None
    horizon = -(a * (width - 1) / 2.0 + c) / b
    if not np.isfinite(horizon) or abs(horizon) > 10 * height:
        return None
    return float(horizon)


def _run_unicanvas_depth(payload: dict[str, Any]) -> dict[str, Any]:
    from .imaging import _decode_data_url

    source = (payload or {}).get("image")
    if not isinstance(source, str) or not source:
        raise ValueError("[VNCCS UniCanvas] depth needs an 'image' data URL.")
    image = _decode_data_url(source, "RGB")
    depth = predict_depth(image)
    if depth.shape != (image.height, image.width):
        raise RuntimeError("[VNCCS UniCanvas] The depth model answered with the wrong size.")
    return {
        "depth": depth_to_png16(depth),
        "width": image.width,
        "height": image.height,
        "horizonY": estimate_horizon(depth),
        "model": DEPTH_MODEL_KEY,
    }
