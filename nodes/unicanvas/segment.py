"""SAM / SAM2 click segmentation for the selection tools."""

from __future__ import annotations

import inspect
from typing import Any

import numpy as np
import torch
from PIL import Image

from .imaging import _decode_data_url, _encode_png_data_url
from .locks import _COMFY_MODEL_OP_LOCK, _MODEL_CACHE_LOCK


_SAM_CACHE: dict[str, tuple[Any, Any, Any]] = {}

SAM_MODEL_IDS = {
    "sam2_large": "facebook/sam2.1-hiera-large",
    "sam1_huge": "facebook/sam-vit-huge",
}


def _load_sam_model(model_key: str) -> tuple[Any, Any, Any]:
    key = model_key if model_key in SAM_MODEL_IDS else "sam2_large"
    with _MODEL_CACHE_LOCK:
        cached = _SAM_CACHE.get(key)
        if cached is not None:
            return cached

    model_id = SAM_MODEL_IDS[key]
    if key == "sam1_huge":
        from transformers.models.sam import SamModel
        from transformers.models.sam.processing_sam import SamProcessor

        model = SamModel.from_pretrained(model_id)
        processor = SamProcessor.from_pretrained(model_id)
    else:
        from transformers.models.sam2 import Sam2Model
        from transformers.models.sam2.processing_sam2 import Sam2Processor

        model = Sam2Model.from_pretrained(model_id)
        processor = Sam2Processor.from_pretrained(model_id)

    try:
        import comfy.model_management as model_management

        device = model_management.get_torch_device()
    except Exception:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if getattr(device, "type", None) not in {"cpu", "cuda"}:
        device = torch.device("cpu")
    model.to(device)
    model.eval()
    cached = (model, processor, device)
    with _MODEL_CACHE_LOCK:
        _SAM_CACHE[key] = cached
    return cached


def _largest_sam_mask(mask_batch: Any) -> torch.Tensor:
    masks = mask_batch[0] if isinstance(mask_batch, (list, tuple)) else mask_batch
    if isinstance(masks, np.ndarray):
        masks = torch.from_numpy(masks)
    masks = masks.detach().cpu()
    while masks.ndim > 3:
        masks = masks[0]
    if masks.ndim == 2:
        return masks > 0
    if masks.ndim != 3:
        raise RuntimeError(f"Unexpected SAM mask shape: {tuple(masks.shape)}")
    binary = masks > 0
    areas = binary.flatten(1).sum(dim=1)
    if not int(areas.max().item()):
        return binary[0]
    return binary[int(torch.argmax(areas).item())]


def _feature_value(features: Any, key: str) -> Any:
    try:
        if isinstance(features, dict):
            return features.get(key)
        data = getattr(features, "data", None)
        if isinstance(data, dict):
            return data.get(key)
        return getattr(features, key, None)
    except Exception:
        return None


def _to_cpu_tensor(value: Any) -> Any:
    return value.detach().cpu() if hasattr(value, "detach") else value


def _post_process_sam_masks(processor: Any, pred_masks: torch.Tensor, inputs: Any) -> Any:
    original_sizes = _to_cpu_tensor(_feature_value(inputs, "original_sizes"))
    reshaped_input_sizes = _to_cpu_tensor(_feature_value(inputs, "reshaped_input_sizes"))
    if original_sizes is None:
        raise RuntimeError("SAM processor returned no original image sizes")

    kwargs = {"masks": pred_masks.detach().cpu(), "original_sizes": original_sizes}
    signature = inspect.signature(processor.post_process_masks)
    if "reshaped_input_sizes" in signature.parameters:
        kwargs["reshaped_input_sizes"] = reshaped_input_sizes if reshaped_input_sizes is not None else original_sizes
    return processor.post_process_masks(**kwargs)


def _run_unicanvas_segment(payload: dict[str, Any]) -> dict[str, Any]:
    model_key = str(payload.get("model") or "sam2_large")
    model_key = model_key if model_key in SAM_MODEL_IDS else "sam2_large"
    points_payload = payload.get("points") or []
    if not isinstance(points_payload, list) or not points_payload:
        raise ValueError("SAM needs at least one point")

    image_rgba = _decode_data_url(str(payload.get("image") or ""), "RGBA")
    image = Image.new("RGB", image_rgba.size, (255, 255, 255))
    image.paste(image_rgba, mask=image_rgba.getchannel("A"))
    width, height = image.size

    points: list[list[float]] = []
    labels: list[int] = []
    for item in points_payload:
        if not isinstance(item, dict):
            continue
        x = float(item.get("x", -1))
        y = float(item.get("y", -1))
        if x < 0 or y < 0 or x >= width or y >= height:
            continue
        label = 0 if int(item.get("label", 1)) <= 0 else 1
        points.append([x, y])
        labels.append(label)
    if not points:
        raise ValueError("SAM points are outside the layer crop")

    with _COMFY_MODEL_OP_LOCK:
        model, processor, device = _load_sam_model(model_key)
        if model_key == "sam1_huge":
            processor_points = [points]
            processor_labels = [labels]
        else:
            processor_points = [[points]]
            processor_labels = [[labels]]
        inputs = processor(
            images=image,
            input_points=processor_points,
            input_labels=processor_labels,
            return_tensors="pt",
        )
        if hasattr(inputs, "to"):
            inputs = inputs.to(device)
        else:
            inputs = {key: value.to(device) if hasattr(value, "to") else value for key, value in inputs.items()}

        with torch.inference_mode():
            outputs = model(**inputs)

    pred_masks = getattr(outputs, "pred_masks", None)
    if pred_masks is None:
        raise RuntimeError("SAM returned no masks")
    masks = _post_process_sam_masks(processor, pred_masks, inputs)
    mask = _largest_sam_mask(masks)
    mask_np = (mask.numpy().astype(np.uint8) * 255)
    mask_image = Image.fromarray(mask_np, mode="L")
    if mask_image.size != image.size:
        mask_image = mask_image.resize(image.size, Image.Resampling.NEAREST)
    rgba_mask = Image.new("RGBA", image.size, (255, 255, 255, 0))
    rgba_mask.putalpha(mask_image)
    return {
        "status": "ok",
        "model": model_key,
        "mask": _encode_png_data_url(rgba_mask),
        "width": image.width,
        "height": image.height,
    }
