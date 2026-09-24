"""Generation settings normalisation and dispatch to the active model family."""

from __future__ import annotations

import math
from typing import Any

from .loaders import _get_unicanvas_model_loader
from .models.registry import _get_unicanvas_model_module
from .presets import _PRESET_MODEL_SETTING_KEYS, _unicanvas_load_preset_registry


def _infer_unicanvas_loader_type(settings: dict[str, Any]) -> str:
    explicit = str(settings.get("model_loader") or settings.get("loader_type") or "").lower()
    if explicit:
        return explicit
    if settings.get("gguf_model_name"):
        return "gguf"
    generation_mode = str(settings.get("generation_mode", "illustrious")).lower()
    if generation_mode in {"qwen_image_edit", "qwen-edit", "qwen_edit", "qwen-image-edit", "qwen_image_edit_2511"}:
        return "gguf"
    if generation_mode in {"anima", "flux_klein", "flux-klein", "klein", "z_image", "z-image", "zimage", "z_image_turbo"} or settings.get("diffusion_model_name"):
        return "diffusion_model"
    return "checkpoint"


def _get_selected_preset_model_settings(settings: dict[str, Any]) -> dict[str, Any]:
    if str(settings.get("model_selection_mode") or "").lower() != "presets":
        return {}
    preset_id = str(settings.get("selected_preset_id") or "")
    if not preset_id:
        return {}
    registry = _unicanvas_load_preset_registry()
    for preset in registry.get("presets", []):
        if not isinstance(preset, dict) or str(preset.get("id") or "") != preset_id:
            continue
        preset_settings = preset.get("settings")
        if not isinstance(preset_settings, dict):
            return {}
        return {key: preset_settings[key] for key in _PRESET_MODEL_SETTING_KEYS if key in preset_settings}
    return {}


def _normalize_gen_settings(gen_settings: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(gen_settings or {})
    preset_model_settings = _get_selected_preset_model_settings(normalized)
    normalized.update(preset_model_settings)
    loader = _get_unicanvas_model_loader(_infer_unicanvas_loader_type(normalized))
    generation_mode = loader.forced_mode or str(normalized.get("generation_mode", "illustrious")).lower()
    mode_settings = normalized.get("mode_settings", {})
    module = _get_unicanvas_model_module(generation_mode)
    mode_profile = {}
    if isinstance(mode_settings, dict):
        mode_profile = mode_settings.get(generation_mode) or mode_settings.get(module.key) or {}
    defaults = module.defaults
    merged = dict(defaults)
    merged.update(normalized)
    if isinstance(mode_profile, dict):
        merged.update(mode_profile)
    merged.update(preset_model_settings)
    merged["generation_mode"] = module.key
    merged["generation_mode_alias"] = generation_mode
    merged["model_loader"] = loader.key
    if loader.forced_mode:
        merged["loader_forced_generation_mode"] = loader.forced_mode
    if "sampler" in merged and "sampler_name" not in merged:
        merged["sampler_name"] = merged["sampler"]
    if "sampler_name" in merged:
        merged["sampler"] = merged["sampler_name"]
    if module.key == "krea2_edit":
        likeness = float(merged.get("krea2_likeness", 4.0))
        if not math.isfinite(likeness) or not 0 <= likeness <= 10:
            raise ValueError("Krea2 Edit likeness must be between 0 and 10")
        merged["krea2_likeness"] = likeness
        merged["denoise"] = 1.0
    return merged


def _apply_generation_loras(model: Any, clip: Any, gen_settings: dict[str, Any]):
    module = _get_unicanvas_model_module(str(gen_settings.get("generation_mode", "illustrious")).lower())
    return module.apply_loras(model, clip, gen_settings)


def _encode_generation_prompt(clip: Any, text: str, gen_settings: dict[str, Any]):
    module = _get_unicanvas_model_module(str(gen_settings.get("generation_mode", "illustrious")).lower())
    return module.encode_prompt(clip, text, gen_settings)


def _create_empty_generation_latent(width: int, height: int, gen_settings: dict[str, Any], draw_id: str = "unknown") -> dict[str, Any]:
    module = _get_unicanvas_model_module(str(gen_settings.get("generation_mode", "illustrious")).lower())
    return module.create_empty_latent(width, height, gen_settings, draw_id=draw_id)


def _sample_generation_latent(
    model: Any,
    positive: Any,
    negative: Any,
    latent: Any,
    seed: int,
    steps: int,
    cfg: float,
    sampler_name: str,
    scheduler: str,
    denoise: float,
    gen_settings: dict[str, Any],
    draw_id: str = "unknown",
    width: int | None = None,
    height: int | None = None,
):
    module = _get_unicanvas_model_module(str(gen_settings.get("generation_mode", "illustrious")).lower())
    return module.sample_latent(
        model=model,
        positive=positive,
        negative=negative,
        latent=latent,
        seed=seed,
        steps=steps,
        cfg=cfg,
        sampler_name=sampler_name,
        scheduler=scheduler,
        denoise=denoise,
        gen_settings=gen_settings,
        draw_id=draw_id,
        width=width,
        height=height,
    )


def _decode_generation_samples(vae: Any, samples: Any, gen_settings: dict[str, Any]):
    module = _get_unicanvas_model_module(str(gen_settings.get("generation_mode", "illustrious")).lower())
    return module.decode_samples(vae, samples, gen_settings)
