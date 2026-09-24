"""LoRA and model-patch loading with a process-wide cache."""

from __future__ import annotations

import os
from typing import Any

from .comfy_bridge import _call_node_method
from .locks import _MODEL_CACHE_LOCK
from .paths import _get_full_path_agnostic


_LORA_CACHE: dict[str, Any] = {}


def _clone_model_clip(model: Any, clip: Any) -> tuple[Any, Any]:
    return (model.clone() if hasattr(model, "clone") else model, clip.clone() if hasattr(clip, "clone") else clip)


def _normalize_lora_name(value: Any) -> str:
    return str(value or "").replace("\\", "/").strip().lower()


def _lora_name_matches(value: Any, expected: str) -> bool:
    normalized = _normalize_lora_name(value)
    expected_normalized = _normalize_lora_name(expected)
    return normalized == expected_normalized or os.path.basename(normalized) == os.path.basename(expected_normalized)


def _get_lora_full_path(lora_name: str) -> str:
    import folder_paths

    path = _get_full_path_agnostic(folder_paths, "loras", lora_name, require_exists=True)
    if not path:
        raise ValueError(f"LoRA not found: {lora_name}")
    return path


def _apply_lora_cached(model: Any, clip: Any, lora_name: str, strength: float, clip_strength: float | None = None):
    if not lora_name or float(strength or 0) == 0:
        return model, clip
    import comfy.sd
    import comfy.utils

    with _MODEL_CACHE_LOCK:
        lora = _LORA_CACHE.get(lora_name)
    if lora is None:
        lora = comfy.utils.load_torch_file(_get_lora_full_path(lora_name), safe_load=True)
        with _MODEL_CACHE_LOCK:
            _LORA_CACHE[lora_name] = lora
    return comfy.sd.load_lora_for_models(model, clip, lora, strength, strength if clip_strength is None else clip_strength)


def _load_model_patch(patch_name: str):
    if not patch_name:
        raise ValueError("Model patch name is required")
    loaded = _call_node_method(
        ["ModelPatchLoader"],
        ["load_model_patch"],
        name=patch_name,
    )
    if loaded is None:
        raise ValueError(f"Model patch not found or failed to load: {patch_name}")
    return loaded
