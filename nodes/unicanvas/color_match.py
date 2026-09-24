"""Layer color matching against a reference image.

Backs ``POST /vnccs/unicanvas/color_match`` ``{ image, reference, method, strength }``.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import torch
from PIL import Image

from .imaging import _decode_data_url, _encode_png_data_url, _uc_image_to_rgb_tensor


UC_COLOR_MATCH_METHODS = ("mkl", "hm", "reinhard", "mvgd", "hm-mvgd-hm", "hm-mkl-hm", "reinhard_lab_gpu")


def _reinhard_lab_transfer_np(src: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """Pure Reinhard (LAB mean/std) transfer - fallback when color-matcher is unavailable.

    Delegates to the torch implementation so the LAB transfer math has a single
    source of truth; the array signature stays for the numpy callers.
    """
    matched = _reinhard_lab_gpu_transfer(
        torch.from_numpy(np.asarray(src, dtype=np.float32)),
        torch.from_numpy(np.asarray(ref, dtype=np.float32)),
    )
    return matched.detach().cpu().numpy()


def _torch_srgb_to_lab(rgb: torch.Tensor) -> torch.Tensor:
    array = rgb.clamp(0.0, 1.0).to(dtype=torch.float32)
    linear = torch.where(array <= 0.04045, array / 12.92, ((array + 0.055) / 1.055) ** 2.4)
    matrix = array.new_tensor(
        [
            [0.4124564, 0.3575761, 0.1804375],
            [0.2126729, 0.7151522, 0.0721750],
            [0.0193339, 0.1191920, 0.9503041],
        ]
    )
    xyz = linear @ matrix.T
    xyz = xyz / xyz.new_tensor([0.95047, 1.0, 1.08883])
    f = torch.where(xyz > 0.008856, torch.clamp(xyz, min=0.0) ** (1.0 / 3.0), 7.787 * xyz + 16.0 / 116.0)
    fx, fy, fz = f[..., 0], f[..., 1], f[..., 2]
    return torch.stack([116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)], dim=-1)


def _torch_lab_to_srgb(lab: torch.Tensor) -> torch.Tensor:
    fy = (lab[..., 0] + 16.0) / 116.0
    fx = fy + lab[..., 1] / 500.0
    fz = fy - lab[..., 2] / 200.0
    f = torch.stack([fx, fy, fz], dim=-1)
    cube = f ** 3
    xyz = torch.where(cube > 0.008856, cube, (f - 16.0 / 116.0) / 7.787) * lab.new_tensor([0.95047, 1.0, 1.08883])
    matrix = lab.new_tensor(
        [
            [3.2404542, -1.5371385, -0.4985314],
            [-0.9692660, 1.8760108, 0.0415560],
            [0.0556434, -0.2040259, 1.0572252],
        ]
    )
    linear = xyz @ matrix.T
    return torch.where(linear <= 0.0031308, 12.92 * linear, 1.055 * torch.clamp(linear, min=0.0) ** (1.0 / 2.4) - 0.055).clamp(0.0, 1.0)


def _reinhard_lab_gpu_transfer(src: torch.Tensor, ref: torch.Tensor) -> torch.Tensor:
    """Torch Reinhard (LAB mean/std) transfer; follows the tensors' device."""
    src_lab = _torch_srgb_to_lab(src)
    ref_lab = _torch_srgb_to_lab(ref)
    out = torch.empty_like(src_lab)
    for channel in range(3):
        source = src_lab[..., channel]
        reference = ref_lab[..., channel]
        out[..., channel] = (source - source.mean()) / (source.std(unbiased=False) + 1e-6) * (reference.std(unbiased=False) + 1e-6) + reference.mean()
    return _torch_lab_to_srgb(out)


def _load_color_matcher_class():
    """Return the color-matcher ColorMatcher class, or None when the package is unavailable."""
    try:
        from color_matcher import ColorMatcher
    except Exception:
        return None
    return ColorMatcher


def _uc_tensor_to_u8(tensor: torch.Tensor) -> np.ndarray:
    array = tensor.detach().to(device="cpu", dtype=torch.float32).clamp(0.0, 1.0).numpy()
    return (array * 255.0).round().astype(np.uint8)


def _color_match_transfer(src: torch.Tensor, ref: torch.Tensor, method: str) -> tuple[torch.Tensor, str]:
    """Transfer ref's color statistics onto src; returns (matched RGB, engine name)."""
    method = str(method or "mkl").strip().lower()
    if method not in UC_COLOR_MATCH_METHODS:
        raise ValueError(f"[VNCCS UniCanvas] Unknown color match method '{method}'.")
    if method == "reinhard_lab_gpu":
        return _reinhard_lab_gpu_transfer(src, ref), "reinhard_lab_gpu"
    matcher_cls = _load_color_matcher_class()
    if matcher_cls is not None:
        try:
            matched = matcher_cls().transfer(src=_uc_tensor_to_u8(src), ref=_uc_tensor_to_u8(ref), method=method)
            return torch.from_numpy(np.asarray(matched, dtype=np.float32) / 255.0), "color-matcher"
        except Exception:
            pass
    fallback = _reinhard_lab_transfer_np(src.detach().cpu().numpy(), ref.detach().cpu().numpy())
    return torch.from_numpy(fallback), "reinhard-fallback"


def _uc_clamp_strength(strength: Any) -> float:
    try:
        value = float(strength)
    except (TypeError, ValueError):
        value = 10.0
    return max(0.0, min(10.0, value))


def _apply_color_match_strength(src: torch.Tensor, matched: torch.Tensor, strength: Any) -> torch.Tensor:
    """strength 0..10: 0 keeps the target, 10 applies the full transfer."""
    alpha = _uc_clamp_strength(strength) / 10.0
    return (src + (matched - src) * alpha).clamp(0.0, 1.0)


def _run_unicanvas_color_match(payload: dict[str, Any]) -> dict[str, Any]:
    payload = payload or {}
    image = _decode_data_url(str(payload.get("image") or ""), "RGBA")
    reference = _decode_data_url(str(payload.get("reference") or ""), "RGB")
    method = str(payload.get("method") or "mkl").strip().lower()
    src = _uc_image_to_rgb_tensor(image)
    ref = _uc_image_to_rgb_tensor(reference)
    matched, engine = _color_match_transfer(src, ref, method)
    result = _apply_color_match_strength(src, matched, payload.get("strength", 10.0))
    rgb = (result.detach().to(device="cpu", dtype=torch.float32).clamp(0.0, 1.0).numpy() * 255.0).round().astype(np.uint8)
    alpha = np.asarray(image.convert("RGBA"))[:, :, 3]
    rgba = np.concatenate([rgb, alpha[:, :, None]], axis=-1)
    return {
        "image": _encode_png_data_url(Image.fromarray(rgba, mode="RGBA")),
        "method": method,
        "engine": engine,
        "strength": _uc_clamp_strength(payload.get("strength", 10.0)),
    }
