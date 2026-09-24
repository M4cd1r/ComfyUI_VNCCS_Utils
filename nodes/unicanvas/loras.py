"""LoRA and model-patch loading with a process-wide cache."""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
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


def _setting_float(settings: dict[str, Any], key: str | None, default: float) -> float:
    if not key:
        return float(default)
    value = settings.get(key, default)
    if value is None or value == "":
        return float(default)
    return float(value)


@dataclass(frozen=True)
class LoraRequirement:
    """A LoRA a model family applies on its own, before the user's LoRA stack.

    Families declare these instead of hand-writing ``apply_loras``. A rule reads
    the LoRA name from ``name_setting`` (falling back to ``default_name``) and is
    applied only when every condition holds:

    * ``enabled_setting`` is truthy (e.g. a Turbo switch), when given;
    * the name matches ``match`` (a canonical file), when given;
    * the draw mode is in ``draw_modes``, when given;
    * the strength is non-zero, and positive when ``require_positive_strength``.

    ``required`` rules apply regardless of the node's own LoRA settings being
    overridden by a linked config; a missing file raises instead of being skipped.
    ``fixed_strength`` pins the strength (the user cannot change it) and
    ``dedupe_from_stack`` removes the same file from the user's stack so it is
    never applied twice. ``resolver`` maps the name to a loadable file, e.g. a
    lazy download: it runs when ``resolve_match`` is unset or matches the name.
    """

    name_setting: str
    default_name: str = ""
    match: str | None = None
    enabled_setting: str | None = None
    strength_setting: str | None = None
    default_strength: float = 1.0
    fixed_strength: float | None = None
    require_positive_strength: bool = False
    clip_strength: float | None = None
    draw_modes: frozenset[str] | None = None
    required: bool = False
    dedupe_from_stack: bool = False
    resolver: Callable[[], str] | None = None
    resolve_match: str | None = None
    description: str = ""

    def resolve(self, settings: dict[str, Any]) -> tuple[str, float] | None:
        """Return ``(lora_name, strength)`` when the rule applies to these settings."""
        name = str(settings.get(self.name_setting) or self.default_name or "")
        if not name:
            return None
        if self.enabled_setting and not settings.get(self.enabled_setting):
            return None
        if self.match and not _lora_name_matches(name, self.match):
            return None
        if self.draw_modes is not None and str(settings.get("draw_mode") or "") not in self.draw_modes:
            return None
        if self.fixed_strength is not None:
            strength = float(self.fixed_strength)
        else:
            strength = _setting_float(settings, self.strength_setting, self.default_strength)
        if strength == 0 or (self.require_positive_strength and strength <= 0):
            return None
        if self.resolver is not None and (self.resolve_match is None or _lora_name_matches(name, self.resolve_match)):
            name = self.resolver()
        return name, strength

    def describe(self) -> dict[str, Any]:
        """JSON-safe summary for the frontend (``/vnccs/unicanvas/assets``)."""
        return {
            "name_setting": self.name_setting,
            "default_name": self.default_name,
            "match": self.match,
            "enabled_setting": self.enabled_setting,
            "strength_setting": self.strength_setting,
            "fixed_strength": self.fixed_strength,
            "draw_modes": sorted(self.draw_modes) if self.draw_modes is not None else None,
            "required": self.required,
            "description": self.description,
        }


def _apply_lora_requirements(
    model: Any,
    clip: Any,
    requirements: tuple[LoraRequirement, ...],
    settings: dict[str, Any],
) -> tuple[Any, Any, list[str]]:
    """Apply the family's own LoRAs; return the names the user stack must skip."""
    deduped: list[str] = []
    for requirement in requirements:
        resolved = requirement.resolve(settings)
        if resolved is None:
            continue
        name, strength = resolved
        model, clip = _apply_lora_cached(model, clip, name, strength, clip_strength=requirement.clip_strength)
        if requirement.dedupe_from_stack:
            deduped.append(name)
    return model, clip, deduped


def _apply_lora_stack(model: Any, clip: Any, lora_stack: Any, skip_names: list[str] | tuple[str, ...] = ()):
    """Apply the user's LoRA stack (node widget or VNCSS Config), skipping deduped files."""
    if not isinstance(lora_stack, list):
        return model, clip
    for item in lora_stack:
        if not isinstance(item, dict):
            continue
        lora_name = str(item.get("name") or item.get("lora_name") or "")
        if any(_lora_name_matches(lora_name, skipped) for skipped in skip_names):
            continue
        strength = float(item.get("strength", item.get("model_strength", 1.0)))
        clip_strength = item.get("clip_strength", None)
        model, clip = _apply_lora_cached(
            model,
            clip,
            lora_name,
            strength,
            None if clip_strength is None else float(clip_strength),
        )
    return model, clip
