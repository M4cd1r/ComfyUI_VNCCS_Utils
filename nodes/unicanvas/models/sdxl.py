"""SDXL / Illustrious model family."""

from __future__ import annotations

from dataclasses import dataclass

from ..loras import LoraRequirement
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
    lora_requirements: tuple[LoraRequirement, ...] = (
        LoraRequirement(
            name_setting="dmd_lora_name",
            match=SDXL_TURBO_LORA_NAME,
            enabled_setting="turbo_enabled",
            strength_setting="dmd_lora_strength",
            description="DMD2 4-step turbo",
        ),
    )
