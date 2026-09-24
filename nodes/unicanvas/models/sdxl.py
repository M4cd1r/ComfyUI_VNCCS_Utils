"""SDXL / Illustrious model family."""

from __future__ import annotations

from dataclasses import dataclass

from ..loras import LoraRequirement
from .base import UniCanvasModelModule
from .capabilities import ModelCapabilities, PromptGuide


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
    capabilities: ModelCapabilities = ModelCapabilities(
        label="SDXL",
        prompt_guide=PromptGuide(
            hint="Comma-separated tags, subject first: 1girl, solo, school uniform, cherry blossoms, masterpiece",
            guide=(
                "SDXL checkpoints, especially Illustrious and Pony merges, follow comma-separated "
                "Danbooru-style tags best; short phrases also work. Start with the subject and "
                "count (1girl, solo), then appearance, clothing, pose, background, lighting and "
                "quality or style tags. Use the negative prompt for what to avoid (lowres, bad "
                "hands, watermark, text). For inpaint describe only what belongs in the mask."
            ),
            examples=("1girl, solo, silver hair, red eyes, school uniform, classroom, window light, masterpiece",),
        ),
    )
    lora_requirements: tuple[LoraRequirement, ...] = (
        LoraRequirement(
            name_setting="dmd_lora_name",
            match=SDXL_TURBO_LORA_NAME,
            enabled_setting="turbo_enabled",
            strength_setting="dmd_lora_strength",
            description="DMD2 4-step turbo",
        ),
    )
