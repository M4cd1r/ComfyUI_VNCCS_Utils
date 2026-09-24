"""Krea2 Identity Edit v1.2 model family (mandatory edit LoRA, grounded Qwen3-VL prompt)."""

from __future__ import annotations

from dataclasses import dataclass

from ..comfy_bridge import _call_node_method
from ..latents import _unwrap_latent_samples
from ..loras import _apply_lora_cached, _lora_name_matches
from .base import UniCanvasModelModule


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

    def apply_loras(self, model, clip, gen_settings):
        name = str(gen_settings.get("krea2_edit_lora_name") or KREA2_EDIT_DEFAULTS["krea2_edit_lora_name"])
        model, clip = _apply_lora_cached(model, clip, name, 1.0, clip_strength=0.0)
        # The edit adapter is mandatory and must not be applied twice by the optional stack.
        settings = dict(gen_settings)
        settings["lora_stack"] = [item for item in gen_settings.get("lora_stack", []) or []
                                  if isinstance(item, dict) and not _lora_name_matches(
                                      item.get("name") or item.get("lora_name"), name)]
        return super().apply_loras(model, clip, settings)

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
