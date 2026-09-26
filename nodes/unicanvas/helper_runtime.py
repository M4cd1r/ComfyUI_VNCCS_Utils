"""Runtime helpers shared by the helper-model features (depth, control preprocessors, segmentation).

The device a helper model runs on and the grayscale PNG answers of the map-producing routes.
torch is imported lazily, so importing this module stays cheap and torch-free.
"""

from __future__ import annotations

import base64
import io
from typing import Any

import numpy as np
from PIL import Image


def helper_torch_device() -> Any:
    """ComfyUI's torch device when it is CPU or CUDA, otherwise the CPU."""
    import torch

    try:
        import comfy.model_management as model_management

        device = model_management.get_torch_device()
    except Exception:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if getattr(device, "type", None) not in {"cpu", "cuda"}:
        device = torch.device("cpu")
    return device


def normalize_unit(values: np.ndarray) -> np.ndarray:
    """``values`` stretched min..max to 0..1 (all zeros when flat); NaN and inf become finite first."""
    array = np.nan_to_num(np.asarray(values, dtype=np.float64))
    low, high = (float(array.min()), float(array.max())) if array.size else (0.0, 0.0)
    return (array - low) / (high - low) if high > low else np.zeros_like(array)


def gray_png(values: np.ndarray, encoding: str = "gray8") -> str:
    """A 0..1 float array as a grayscale PNG data URL (``gray8`` or ``gray16``)."""
    clipped = np.clip(np.nan_to_num(np.asarray(values, dtype=np.float64)), 0.0, 1.0)
    if encoding == "gray16":
        image = Image.fromarray(np.round(clipped * 65535.0).astype(np.uint16))
    else:
        image = Image.fromarray(np.round(clipped * 255.0).astype(np.uint8), mode="L")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
