"""CPU compositor that flattens a UniCanvas state (blend modes, opacity, crops) to RGBA."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import torch
from PIL import Image

from .constants import _MAX_PANORAMA_PIXELS, _MAX_PIXELS
from .imaging import _decode_data_url, _pil_rgba_to_image_tensor
from .state import _load_unicanvas_state


def _number(value: Any, default: float) -> float:
    try:
        result = float(value)
        if math.isfinite(result):
            return result
    except Exception:
        pass
    return default


def _rect_from_state(value: Any, default: dict[str, float]) -> dict[str, float]:
    data = value if isinstance(value, dict) else {}
    return {
        "x": _number(data.get("x"), default["x"]),
        "y": _number(data.get("y"), default["y"]),
        "width": max(1.0, _number(data.get("width"), default["width"])),
        "height": max(1.0, _number(data.get("height"), default["height"])),
    }


def _apply_layer_opacity(image: Image.Image, opacity: float) -> Image.Image:
    opacity = max(0.0, min(1.0, opacity))
    if opacity >= 0.999:
        return image
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A").point(lambda value: int(round(value * opacity)))
    rgba.putalpha(alpha)
    return rgba


_UNICANVAS_BLEND_MODES = {
    "source-over",
    "normal",
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
    "color-dodge",
    "color-burn",
    "hard-light",
    "soft-light",
    "difference",
    "exclusion",
    "hue",
    "saturation",
    "color",
    "luminosity",
}


def _blend_luminosity(color: np.ndarray) -> np.ndarray:
    return color[..., 0] * 0.3 + color[..., 1] * 0.59 + color[..., 2] * 0.11


def _blend_saturation(color: np.ndarray) -> np.ndarray:
    return np.max(color, axis=-1) - np.min(color, axis=-1)


def _blend_clip_color(color: np.ndarray) -> np.ndarray:
    result = color.copy()
    luminosity = _blend_luminosity(result)[..., None]
    minimum = np.min(result, axis=-1, keepdims=True)
    maximum = np.max(result, axis=-1, keepdims=True)

    low = minimum < 0.0
    low_scale = np.divide(
        luminosity,
        luminosity - minimum,
        out=np.zeros_like(luminosity),
        where=np.abs(luminosity - minimum) > 1e-7,
    )
    result = np.where(low, luminosity + (result - luminosity) * low_scale, result)

    high = maximum > 1.0
    high_scale = np.divide(
        1.0 - luminosity,
        maximum - luminosity,
        out=np.zeros_like(luminosity),
        where=np.abs(maximum - luminosity) > 1e-7,
    )
    result = np.where(high, luminosity + (result - luminosity) * high_scale, result)
    return np.clip(result, 0.0, 1.0)


def _blend_set_luminosity(color: np.ndarray, luminosity: np.ndarray) -> np.ndarray:
    return _blend_clip_color(color + (luminosity - _blend_luminosity(color))[..., None])


def _blend_set_saturation(color: np.ndarray, saturation: np.ndarray) -> np.ndarray:
    order = np.argsort(color, axis=-1)
    sorted_color = np.take_along_axis(color, order, axis=-1)
    minimum = sorted_color[..., 0]
    middle = sorted_color[..., 1]
    maximum = sorted_color[..., 2]
    span = maximum - minimum
    adjusted_middle = np.divide(
        (middle - minimum) * saturation,
        span,
        out=np.zeros_like(middle),
        where=span > 1e-7,
    )
    adjusted_maximum = np.where(span > 1e-7, saturation, 0.0)
    adjusted_sorted = np.stack(
        (np.zeros_like(adjusted_middle), adjusted_middle, adjusted_maximum),
        axis=-1,
    )
    result = np.empty_like(color)
    np.put_along_axis(result, order, adjusted_sorted, axis=-1)
    return result


def _blend_rgb(backdrop: np.ndarray, source: np.ndarray, mode: str) -> np.ndarray:
    if mode in {"source-over", "normal"}:
        return source
    if mode == "multiply":
        return backdrop * source
    if mode == "screen":
        return backdrop + source - backdrop * source
    if mode == "overlay":
        return np.where(
            backdrop <= 0.5,
            2.0 * backdrop * source,
            1.0 - 2.0 * (1.0 - backdrop) * (1.0 - source),
        )
    if mode == "darken":
        return np.minimum(backdrop, source)
    if mode == "lighten":
        return np.maximum(backdrop, source)
    if mode == "color-dodge":
        return np.where(
            source >= 1.0 - 1e-7,
            1.0,
            np.minimum(1.0, backdrop / np.maximum(1.0 - source, 1e-7)),
        )
    if mode == "color-burn":
        return np.where(
            source <= 1e-7,
            0.0,
            1.0 - np.minimum(1.0, (1.0 - backdrop) / np.maximum(source, 1e-7)),
        )
    if mode == "hard-light":
        return np.where(
            source <= 0.5,
            2.0 * backdrop * source,
            1.0 - 2.0 * (1.0 - backdrop) * (1.0 - source),
        )
    if mode == "soft-light":
        soft_curve = np.where(
            backdrop <= 0.25,
            ((16.0 * backdrop - 12.0) * backdrop + 4.0) * backdrop,
            np.sqrt(np.maximum(backdrop, 0.0)),
        )
        return np.where(
            source <= 0.5,
            backdrop - (1.0 - 2.0 * source) * backdrop * (1.0 - backdrop),
            backdrop + (2.0 * source - 1.0) * (soft_curve - backdrop),
        )
    if mode == "difference":
        return np.abs(backdrop - source)
    if mode == "exclusion":
        return backdrop + source - 2.0 * backdrop * source
    if mode == "hue":
        adjusted = _blend_set_saturation(source, _blend_saturation(backdrop))
        return _blend_set_luminosity(adjusted, _blend_luminosity(backdrop))
    if mode == "saturation":
        adjusted = _blend_set_saturation(backdrop, _blend_saturation(source))
        return _blend_set_luminosity(adjusted, _blend_luminosity(backdrop))
    if mode == "color":
        return _blend_set_luminosity(source, _blend_luminosity(backdrop))
    if mode == "luminosity":
        return _blend_set_luminosity(backdrop, _blend_luminosity(source))
    return source


def _alpha_composite_with_blend(backdrop: Image.Image, source: Image.Image, mode: str) -> Image.Image:
    mode = str(mode or "source-over").lower()
    if mode not in _UNICANVAS_BLEND_MODES or mode in {"source-over", "normal"}:
        return Image.alpha_composite(backdrop.convert("RGBA"), source.convert("RGBA"))

    backdrop = backdrop.convert("RGBA")
    source = source.convert("RGBA")
    result = backdrop.copy()
    width, height = backdrop.size
    for top in range(0, height, 256):
        bottom = min(height, top + 256)
        box = (0, top, width, bottom)
        backdrop_values = np.asarray(backdrop.crop(box), dtype=np.float32) / 255.0
        source_values = np.asarray(source.crop(box), dtype=np.float32) / 255.0
        backdrop_rgb = backdrop_values[..., :3]
        source_rgb = source_values[..., :3]
        backdrop_alpha = backdrop_values[..., 3:4]
        source_alpha = source_values[..., 3:4]
        blended_rgb = np.clip(_blend_rgb(backdrop_rgb, source_rgb, mode), 0.0, 1.0)
        output_alpha = source_alpha + backdrop_alpha * (1.0 - source_alpha)
        output_premultiplied = (
            source_alpha * (1.0 - backdrop_alpha) * source_rgb
            + source_alpha * backdrop_alpha * blended_rgb
            + (1.0 - source_alpha) * backdrop_alpha * backdrop_rgb
        )
        output_rgb = np.divide(
            output_premultiplied,
            output_alpha,
            out=np.zeros_like(output_premultiplied),
            where=output_alpha > 1e-7,
        )
        output = np.concatenate((output_rgb, output_alpha), axis=-1)
        output_image = Image.fromarray(np.round(np.clip(output, 0.0, 1.0) * 255.0).astype(np.uint8), "RGBA")
        result.paste(output_image, (0, top))
    return result


def _render_unicanvas_state_to_rgba(unicanvas_state: str) -> Image.Image:
    state = _load_unicanvas_state(unicanvas_state)
    panorama = state.get("panorama")
    if panorama is not None:
        if not isinstance(panorama, dict) or panorama.get("projection") != "equirectangular":
            raise ValueError("Unsupported UniCanvas panorama projection")
        try:
            pano_width, pano_height = int(panorama["width"]), int(panorama["height"])
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise ValueError("Invalid panorama dimensions") from exc
        if not (0 < pano_width <= 8192 and 0 < pano_height <= 8192 and pano_width * pano_height <= _MAX_PANORAMA_PIXELS):
            raise ValueError("UniCanvas panorama dimensions are too large or invalid")
        # Panorama layers already contain spherical edits in full equirectangular
        # coordinates. The perspective bbox and camera never crop node output.
        state = {**state, "origin": {"x": 0, "y": 0}, "bbox": {"x": 0, "y": 0, "width": pano_width, "height": pano_height}}
    origin = _rect_from_state(state.get("origin"), {"x": 0, "y": 0, "width": 1, "height": 1})
    bbox = _rect_from_state(state.get("bbox"), {"x": 0, "y": 0, "width": 1024, "height": 1024})
    width = max(1, int(round(bbox["width"])))
    height = max(1, int(round(bbox["height"])))
    pixel_limit = _MAX_PANORAMA_PIXELS if panorama else _MAX_PIXELS
    if width * height > pixel_limit:
        raise ValueError("UniCanvas output dimensions are too large")
    bbox_local_x = bbox["x"] - origin["x"]
    bbox_local_y = bbox["y"] - origin["y"]
    out = Image.new("RGBA", (width, height), (0, 0, 0, 0))

    layers = state.get("layers") or []
    if panorama:
        base_id = panorama.get("baseLayerId")
        if not any(isinstance(layer, dict) and layer.get("id") == base_id and layer.get("type") == "raster" for layer in layers):
            raise ValueError("The panorama base layer is missing")
        layers = sorted(layers, key=lambda layer: isinstance(layer, dict) and layer.get("id") == base_id)
    for layer in reversed(layers):
        if not isinstance(layer, dict):
            continue
        if layer.get("type") not in {"raster", "pose"} or layer.get("visible") is False:
            continue
        crop = layer.get("crop")
        data_url = layer.get("dataURL")
        if not isinstance(crop, dict) or not data_url:
            if panorama:
                raise ValueError("Panorama layer pixels are missing")
            continue

        layer_x = int(round(_number(crop.get("x"), 0)))
        layer_y = int(round(_number(crop.get("y"), 0)))
        layer_w = max(1, int(round(_number(crop.get("width"), 1))))
        layer_h = max(1, int(round(_number(crop.get("height"), 1))))
        if panorama and (layer_x, layer_y, layer_w, layer_h) != (0, 0, width, height):
            raise ValueError("Panorama layer dimensions do not match the document")
        dst_x = int(round(layer_x - bbox_local_x))
        dst_y = int(round(layer_y - bbox_local_y))
        inter_left = max(0, dst_x)
        inter_top = max(0, dst_y)
        inter_right = min(width, dst_x + layer_w)
        inter_bottom = min(height, dst_y + layer_h)
        if inter_right <= inter_left or inter_bottom <= inter_top:
            continue

        image = _decode_data_url(str(data_url), "RGBA", max_pixels=pixel_limit)
        if panorama and image.size != (width, height):
            raise ValueError("Panorama layer dimensions do not match the document")
        src_left = inter_left - dst_x
        src_top = inter_top - dst_y
        src_right = src_left + (inter_right - inter_left)
        src_bottom = src_top + (inter_bottom - inter_top)
        image = image.crop((src_left, src_top, src_right, src_bottom))
        image = _apply_layer_opacity(image, _number(layer.get("opacity"), 1.0))
        blend_mode = str(layer.get("blendMode") or "source-over").lower()
        if blend_mode in {"source-over", "normal"} or blend_mode not in _UNICANVAS_BLEND_MODES:
            out.alpha_composite(image, (inter_left, inter_top))
        else:
            region = out.crop((inter_left, inter_top, inter_right, inter_bottom))
            out.paste(_alpha_composite_with_blend(region, image, blend_mode), (inter_left, inter_top))

    return out


def _render_unicanvas_state_to_image_tensor(unicanvas_state: str) -> torch.Tensor:
    return _pil_rgba_to_image_tensor(_render_unicanvas_state_to_rgba(unicanvas_state))
