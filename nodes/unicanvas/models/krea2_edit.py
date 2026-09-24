"""Krea2 Identity Edit v1.2 model family (mandatory edit LoRA, grounded Qwen3-VL prompt)."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import ClassVar

from ..comfy_bridge import _call_node_method
from ..latents import _unwrap_latent_samples
from ..loras import LoraRequirement
from .base import UniCanvasModelModule
from .capabilities import STANDARD_TASKS, ModelCapabilities, PromptGuide


KREA2_EDIT_DEFAULTS = {
    "generation_mode": "krea2_edit",
    "model_loader": "diffusion_model",
    "diffusion_model_name": "krea2_turbo_fp8_scaled.safetensors",
    "clip_name": "qwen3vl_4b_fp8_scaled.safetensors",
    "vae_name": "qwen_image_vae.safetensors",
    "clip_type": "krea2",
    "krea2_edit_lora_name": "Krea2/krea2_identity_edit_v1_2.safetensors",
    "krea2_likeness": 4.0,
    "sampler_name": "euler",
    "scheduler": "simple",
    "steps": 10,
    "cfg": 1.0,
    "denoise": 1.0,
}


@dataclass(frozen=True)
class Krea2EditUniCanvasModule(UniCanvasModelModule):
    """Identity Edit v1.2: mandatory LoRA, grounded Qwen3-VL and clean source tokens."""

    sampling_scratch_keys: ClassVar[tuple[str, ...]] = ("_krea2_edit_clip", "_krea2_edit_image", "_krea2_edit_vae")

    capabilities: ModelCapabilities = ModelCapabilities(
        label="Krea2 Edit",
        tasks=tuple(STANDARD_TASKS[key] for key in ("image_to_image", "inpaint", "outpaint")),
        requires_source_image=True,
        source_image_message="Krea2 Edit requires an image inside the bbox. Import an image and describe the edit.",
        default_loader="diffusion_model",
        prompt_guide=PromptGuide(
            hint="Describe the change: make the jacket red, add a hat, turn it into a watercolor",
            guide=(
                "Krea2 Identity Edit changes an existing image: import an image, put the bbox "
                "over the area to edit and describe the change (recoloring, adding objects, "
                "changing attributes or style). Likeness controls how closely the result follows "
                "the source. Use the Krea2 Edit Raw card (stronger guidance) to remove objects. "
                "Stay at or below about 2 megapixels. The negative prompt is not used."
            ),
            examples=("Make the car matte black and add rain on the windshield.",),
            negative_prompt=False,
        ),
    )

    lora_requirements: tuple[LoraRequirement, ...] = (
        LoraRequirement(
            name_setting="krea2_edit_lora_name",
            default_name=KREA2_EDIT_DEFAULTS["krea2_edit_lora_name"],
            fixed_strength=1.0,
            clip_strength=0.0,
            required=True,
            dedupe_from_stack=True,
            description="Krea2 Identity Edit adapter (mandatory)",
        ),
    )

    def encode_prompt(self, clip, text, gen_settings):
        # Defer until the exact bbox reference is prepared, including outpaint pixels.
        gen_settings["_krea2_edit_clip"] = clip
        return text or ""

    def prepare_reference_conditioning(self, positive, negative, vae, image_tensor, gen_settings, draw_id="unknown"):
        from .krea2_edit_inference import Krea2EditGroundedEncode

        clip = gen_settings.pop("_krea2_edit_clip")
        encoder = Krea2EditGroundedEncode()
        positive = encoder.encode(clip, positive, image=image_tensor, grounding_px=768)[0]
        # Trained unconditional: the SAME reference image with an empty instruction.
        negative = encoder.encode(clip, "", image=image_tensor, grounding_px=768)[0]
        gen_settings["_krea2_edit_image"] = image_tensor
        gen_settings["_krea2_edit_vae"] = vae
        return positive, negative

    def create_empty_latent(self, width, height, gen_settings, draw_id="unknown"):
        latent = _call_node_method(["EmptySD3LatentImage"], ["generate"], width=width, height=height,
                                  batch_size=max(1, int(gen_settings.get("batch_size", 1))))
        if latent is None:
            raise ValueError("Krea2 Edit requires EmptySD3LatentImage. Update ComfyUI.")
        return latent

    def sample_latent(self, model, positive, negative, latent, seed, steps, cfg, sampler_name,
                      scheduler, denoise, gen_settings, draw_id="unknown", width=None, height=None):
        from .krea2_edit_inference import patch_krea2_edit

        model = patch_krea2_edit(model, gen_settings.pop("_krea2_edit_vae"),
                                gen_settings.pop("_krea2_edit_image"), latent,
                                gen_settings["krea2_likeness"])
        return super().sample_latent(model, positive, negative, latent, seed, steps, cfg,
                                     sampler_name, scheduler, 1.0, gen_settings, draw_id, width, height)

    def decode_samples(self, vae, samples, gen_settings):
        return vae.decode(_unwrap_latent_samples(samples))

    # -- settings and draw hooks ------------------------------------------------------------

    def normalize_settings(self, settings):
        likeness = float(settings.get("krea2_likeness", 4.0))
        if not math.isfinite(likeness) or not 0 <= likeness <= 10:
            raise ValueError("Krea2 Edit likeness must be between 0 and 10")
        settings["krea2_likeness"] = likeness
        settings["denoise"] = 1.0
        return settings

    def prepare_generation_latent(self, ctx):
        # Every edit mode samples a fresh noise target; the source only enters through
        # the grounded conditioning and the patched model, never as the initial latent.
        return self.create_empty_latent(ctx.width, ctx.height, ctx.settings, draw_id=ctx.draw_id)
