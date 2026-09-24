"""SDXL / Illustrious model family."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..loras import _apply_lora_cached, _lora_name_matches
from .base import UniCanvasModelModule


SDXL_TURBO_LORA_NAME = "DMD2/dmd2_sdxl_4step_lora_fp16.safetensors"

ILLUSTRIOUS_DEFAULTS = {
    "generation_mode": "illustrious",
    "ckpt_name": "",
    "sampler": "euler",
    "sampler_name": "euler",
    "scheduler": "normal",
    "steps": 20,
    "cfg": 8.0,
}


@dataclass(frozen=True)
class SDXLUniCanvasModule(UniCanvasModelModule):
    def apply_loras(self, model: Any, clip: Any, gen_settings: dict[str, Any]):
        lora_name = str(gen_settings.get("dmd_lora_name") or "")
        if gen_settings.get("turbo_enabled") and _lora_name_matches(lora_name, SDXL_TURBO_LORA_NAME):
            model, clip = _apply_lora_cached(
                model,
                clip,
                lora_name,
                float(gen_settings.get("dmd_lora_strength", 1.0)),
            )
        return super().apply_loras(model, clip, gen_settings)
