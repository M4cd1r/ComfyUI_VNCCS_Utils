"""Layer background removal (edit model, BiRefNet, rembg, SAM3).

Backs ``POST /vnccs/unicanvas/remove_bg``
``{ method: "edit" | "birefnet" | "rembg" | "sam3", edit_model?, image }``.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from PIL import Image

from .imaging import _decode_data_url, _encode_png_data_url, _uc_image_to_rgb_tensor, _uc_rgba_tensor_to_image
from .models.registry import _get_unicanvas_model_module
from .segment import _run_unicanvas_segment


UC_QI21_REMOVE_BG_UNAVAILABLE = (
    "[VNCCS UniCanvas] Remove bg – QI2.1 requires the Qwen-Image-2.1 module (QI2.1 family)."
)


def _uc_resolve_qi21_module():
    """Contract #3: the QI2.1 stack is obtained through the existing registry lookup."""
    try:
        module = _get_unicanvas_model_module("qwen_image21")
    except Exception:
        module = None
    if module is None or not callable(getattr(module, "remove_background", None)):
        raise RuntimeError(UC_QI21_REMOVE_BG_UNAVAILABLE)
    return module


def _uc_load_birefnet_masker():
    # Inside a ComfyUI process this extension loads vnccs_sam3d as a sibling
    # subpackage, so the relative form resolves; the absolute fallback covers
    # flat imports (tests/conftest.py stubs "nodes" as a top-level package,
    # where the relative form cannot resolve).
    try:
        from ...vnccs_sam3d.processing.birefnet_mask import auto_mask_bgr
    except ImportError:
        from vnccs_sam3d.processing.birefnet_mask import auto_mask_bgr

    return auto_mask_bgr


UC_REMOVE_BG_METHODS = ("edit", "birefnet", "rembg", "sam3")
UC_REMOVE_BG_EDIT_MODELS = ("qwen_image21", "minimax_h3")
UC_EDIT_REMOVE_BG_UNAVAILABLE = (
    "[VNCCS UniCanvas] Remove bg – Edit model requires an RGBA-VAE edit model module ({model})."
)
UC_REMBG_REMOVE_BG_UNAVAILABLE = (
    "[VNCCS UniCanvas] Remove bg – rembg requires the 'rembg' package (pip install rembg)."
)
UC_SAM3_REMOVE_BG_UNAVAILABLE = (
    "[VNCCS UniCanvas] Remove bg – SAM 3 needs the SAM stack: {error}"
)


def _uc_resolve_edit_remove_bg_module(edit_model: str):
    try:
        module = _get_unicanvas_model_module(edit_model)
    except Exception:
        module = None
    if module is None or not callable(getattr(module, "remove_background", None)):
        if edit_model == "qwen_image21":
            raise RuntimeError(UC_QI21_REMOVE_BG_UNAVAILABLE)
        raise RuntimeError(UC_EDIT_REMOVE_BG_UNAVAILABLE.format(model=edit_model))
    return module


def _uc_remove_bg_rembg(image: Image.Image) -> Image.Image:
    try:
        from rembg import remove as rembg_remove
    except ImportError as exc:
        raise RuntimeError(UC_REMBG_REMOVE_BG_UNAVAILABLE) from exc
    result = rembg_remove(image)
    return result if getattr(result, "mode", "") == "RGBA" else result.convert("RGBA")


def _uc_remove_bg_sam3(image: Image.Image) -> Image.Image:
    """SAM-stack automatic subject mask (the extension's SAM 3 pipeline).

    Reuses the interactive segmentation logic with automatic prompts: one
    centre-positive point plus corner-negative points, then the largest
    predicted mask becomes the kept subject.
    """
    width, height = image.size
    points = [
        {"x": width * 0.5, "y": height * 0.5, "label": 1},
        {"x": 1, "y": 1, "label": 0},
        {"x": width - 2, "y": 1, "label": 0},
        {"x": 1, "y": height - 2, "label": 0},
        {"x": width - 2, "y": height - 2, "label": 0},
    ]
    try:
        result = _run_unicanvas_segment({
            "model": "sam2_large",
            "image": _encode_png_data_url(image.convert("RGB")),
            "points": points,
        })
    except Exception as exc:
        raise RuntimeError(UC_SAM3_REMOVE_BG_UNAVAILABLE.format(error=exc)) from exc
    return _decode_data_url(str(result.get("mask") or ""), "RGBA")


def _run_unicanvas_remove_bg(payload: dict[str, Any]) -> dict[str, Any]:
    payload = payload or {}
    raw_method = str(payload.get("method") or "").strip().lower()
    method = "edit" if raw_method == "qi21" else raw_method
    edit_model = str(payload.get("edit_model") or "qwen_image21").strip().lower()
    if method not in UC_REMOVE_BG_METHODS:
        raise ValueError(f"[VNCCS UniCanvas] Unknown remove bg method '{raw_method}'.")
    if method == "edit" and edit_model not in UC_REMOVE_BG_EDIT_MODELS:
        raise ValueError(f"[VNCCS UniCanvas] Unknown remove bg edit model '{edit_model}'.")
    # Fail fast before any pixel work when the requested stack is unavailable.
    module = _uc_resolve_edit_remove_bg_module(edit_model) if method == "edit" else None
    if method == "rembg":
        _uc_require_rembg_available()
    image = _decode_data_url(str(payload.get("image") or ""), "RGB")
    if method == "edit":
        rgba = module.remove_background(_uc_image_to_rgb_tensor(image))
        result = _uc_rgba_tensor_to_image(rgba)
    elif method == "rembg":
        result = _uc_remove_bg_rembg(image)
    elif method == "sam3":
        result = _uc_remove_bg_sam3(image)
    else:
        masker = _uc_load_birefnet_masker()
        img_bgr = np.asarray(image, dtype=np.uint8)[:, :, ::-1].copy()
        mask, _bounds = masker(img_bgr)
        alpha = (np.asarray(mask) > 0).astype(np.uint8) * 255
        result = Image.new("RGBA", image.size, (255, 255, 255, 0))
        result.putalpha(Image.fromarray(alpha, mode="L"))
    return {
        "alpha": _encode_png_data_url(result),
        "width": result.width,
        "height": result.height,
        "method": method,
        "edit_model": edit_model if method == "edit" else None,
    }


def _uc_require_rembg_available() -> None:
    try:
        import rembg  # noqa: F401
    except ImportError as exc:
        raise RuntimeError(UC_REMBG_REMOVE_BG_UNAVAILABLE) from exc
