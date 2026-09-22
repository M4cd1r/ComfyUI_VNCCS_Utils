"""VNCSS_CONFIG node: external model plumbing for VNCCS UniCanvas."""
from __future__ import annotations

import json
from typing import Any

REFERENCE_INPUTS = ("reference_image_1", "reference_image_2", "reference_image_3", "reference_image_4")


def _load_state(node_state: str) -> dict[str, Any]:
    try:
        state = json.loads(node_state) if isinstance(node_state, str) and node_state.strip() else (node_state or {})
    except Exception:
        state = {}
    return state if isinstance(state, dict) else {}


def _apply_lora_cached(model, clip, lora_name, strength, clip_strength=None):
    """Patch a LoRA onto model/clip. Mirrors UniCanvasModule.apply_loras caching."""
    import comfy.sd
    import comfy.utils

    lora_sd = comfy.utils.load_torch_file(lora_name, safe_load=True)
    return comfy.sd.load_lora_for_models(
        model, clip, lora_sd, float(strength),
        float(strength) if clip_strength is None else float(clip_strength),
    )


def normalize_lora_stack(raw: Any) -> list[dict[str, Any]]:
    stack: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        try:
            strength = float(item.get("strength", 1.0))
        except (TypeError, ValueError):
            strength = 1.0
        stack.append({"name": name, "strength": strength, "enabled": bool(item.get("enabled", True))})
    return stack


def apply_lora_stack(model: Any, clip: Any, lora_stack: list[dict[str, Any]], config: Any = None):
    for item in lora_stack:
        if not item.get("enabled") or abs(float(item.get("strength", 1.0))) <= 1e-6:
            continue
        model, clip = _apply_lora_cached(model, clip, item["name"], item["strength"])
    return model, clip


class VNCCS_Config:
    """Bundles external MODEL/CLIP/VAE, a LoRA stack and reference images."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "node_state": ("STRING", {"multiline": False, "default": "{}"}),
            },
            "optional": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "audio_vae": ("VAE",),
                "reference_image_1": ("IMAGE",),
                "reference_image_2": ("IMAGE",),
                "reference_image_3": ("IMAGE",),
                "reference_image_4": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("VNCSS_CONFIG",)
    RETURN_NAMES = ("config",)
    FUNCTION = "execute"
    CATEGORY = "VNCCS/config"

    @classmethod
    def VALIDATE_INPUTS(cls, input_types):
        return True

    def execute(
        self,
        node_state: str = "{}",
        model: Any = None,
        clip: Any = None,
        vae: Any = None,
        audio_vae: Any = None,
        reference_image_1: Any = None,
        reference_image_2: Any = None,
        reference_image_3: Any = None,
        reference_image_4: Any = None,
    ) -> tuple[dict[str, Any]]:
        state = _load_state(node_state)
        edit_model = bool(state.get("edit_model", False))
        lora_stack = normalize_lora_stack(state.get("loras"))

        if model is None:
            raise RuntimeError("[VNCCS Config] Model input is not connected.")
        if clip is None:
            raise RuntimeError("[VNCCS Config] CLIP input is not connected.")
        if vae is None:
            raise RuntimeError("[VNCCS Config] VAE input is not connected.")

        references = {
            name: value
            for name, value in zip(
                REFERENCE_INPUTS,
                (reference_image_1, reference_image_2, reference_image_3, reference_image_4),
            )
            if value is not None
        }
        if edit_model and "reference_image_1" not in references:
            raise RuntimeError("[VNCCS Config] Edit model requires reference_image_1.")

        model, clip = apply_lora_stack(model, clip, lora_stack)

        config = {
            "model": model,
            "clip": clip,
            "vae": vae,
            "audio_vae": audio_vae,
            "references": references,
            "edit_model": edit_model,
            "lora_stack": lora_stack,
        }
        return (config,)
