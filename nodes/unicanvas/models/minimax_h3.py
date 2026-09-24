"""MiniMax H3 model family, driven by models supplied through a VNCSS Config node."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import torch

from ..comfy_bridge import _call_comfy_node
from ..debug import _uc_log
from ..loaders import _load_generation_assets
from .base import UniCanvasModelModule, _reference_image_slots
from .qwen_image21 import QWEN_IMAGE21_SUBJECT_EXTRACTION_PROMPT


@dataclass(frozen=True)
class MiniMaxH3UniCanvasModule(UniCanvasModelModule):
    key: str = "minimax_h3"
    aliases: tuple[str, ...] = ("minimaxh3", "minimax-h3", "h3")
    defaults: dict[str, Any] = field(default_factory=lambda: {
        "steps": 20,
        "sampler_name": "res_multistep",
        "scheduler": "simple",
        "cfg": 1.0,
        "denoise": 1.0,
        "frame_count": 5,
        "ref_image_size": "match",
    })
    is_edit_model: bool = True

    def uses_edit_masked_latents(self, mode: str) -> bool:
        return False

    def uses_differential_diffusion(self, mode: str) -> bool:
        return False

    def encode_prompt(self, clip: Any, text: str, gen_settings: dict[str, Any]):
        # The H3 conditioning (prompt + reference pictures) is built in one call
        # by MiniMaxH3ReferenceToVideo inside sample_latent; stash the prompt and
        # return a placeholder that the pipeline never samples.
        gen_settings["_h3_prompt"] = text or ""
        return [[torch.zeros(1, 4), {}]]

    def validate_conditioning(self, positive, negative, gen_settings):
        return None

    def create_empty_latent(self, width: int, height: int, gen_settings, draw_id: str = "unknown"):
        return {"samples": torch.zeros(1, 16, 8, 8)}

    def prepare_reference_conditioning(self, positive, negative, vae, image_tensor, gen_settings, draw_id="unknown"):
        gen_settings["_h3_reference_image"] = image_tensor
        return positive, negative

    def _h3_reference_images(self, gen_settings: dict[str, Any]) -> dict[str, Any]:
        slots = _reference_image_slots(gen_settings.get("_h3_reference_image"), gen_settings)
        return {f"ref_image_{slot}": value for slot, value in slots.items()}

    def sample_latent(
        self,
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
        external = gen_settings.get("_external") or {}
        clip = external.get("clip")
        vae = external.get("vae")
        audio_vae = external.get("audio_vae")
        if audio_vae is None:
            raise RuntimeError("[VNCCS UniCanvas] MiniMax H3 requires the audio VAE.")
        prompt = str(gen_settings.get("_h3_prompt") or "")
        refs = self._h3_reference_images(gen_settings)
        target_w = int(width or 1344) // 32 * 32
        target_h = int(height or 768) // 32 * 32
        length = int(self.defaults.get("frame_count", 5))

        positive_h3, latent_h3 = _call_comfy_node(
            "MiniMaxH3ReferenceToVideo",
            clip=clip,
            vae=vae,
            audio_vae=audio_vae,
            prompt=prompt,
            width=target_w,
            height=target_h,
            length=length,
            ref_image_size=str(self.defaults.get("ref_image_size", "match")),
            ref_images=refs,
        )
        guider = _call_comfy_node("BasicGuider", model=model, conditioning=positive_h3)[0]
        noise = _call_comfy_node("RandomNoise", noise_seed=int(seed))[0]
        sampler_object = _call_comfy_node("KSamplerSelect", sampler_name=sampler_name or "res_multistep")[0]
        sigmas = _call_comfy_node(
            "BasicScheduler",
            model=model,
            scheduler=scheduler or "simple",
            steps=int(steps),
            denoise=float(denoise),
        )[0]
        sampled = _call_comfy_node(
            "SamplerCustomAdvanced",
            noise=noise,
            guider=guider,
            sampler=sampler_object,
            sigmas=sigmas,
            latent_image=latent_h3,
        )[0]
        _uc_log(draw_id, "MiniMax H3 region edit sampled", {
            "width": target_w, "height": target_h, "steps": steps,
            "refs": sorted(refs), "seed": seed,
        })
        return sampled

    def decode_samples(self, vae: Any, samples: Any, gen_settings: dict[str, Any]):
        # The tiling widgets are passed explicitly because _call_comfy_node cannot fill in
        # missing required parameters; the values are the ComfyUI core widget defaults, so
        # the result matches a graph run. Cores that do not declare a keyword drop it in
        # _call_comfy_node's signature filter instead of failing.
        decoded = _call_comfy_node(
            "VAEDecodeTiled",
            samples=samples,
            vae=vae,
            tile_size=512,
            overlap=64,
            temporal_size=64,
            temporal_overlap=8,
        )[0]
        if hasattr(decoded, "shape") and len(decoded.shape) == 4 and decoded.shape[0] > 1:
            return decoded[:1]  # H3 returns a frame packet; the still is the first frame
        return decoded

    def remove_background(self, image: torch.Tensor) -> torch.Tensor:
        """MiniMax H3 RGBA subject extraction (spec 10.3).

        Edit-model remove-bg contract: (H,W,3) float 0..1 in, (H,W,4) float 0..1
        out with the extracted subject in alpha. Runs the family's region-edit
        flow with the subject-extraction instruction and keeps the RGBA-VAE
        alpha channel.
        """
        if not torch.is_tensor(image) or image.ndim != 3 or int(image.shape[-1]) != 3 or not torch.is_floating_point(image):
            raise ValueError(
                "[VNCCS UniCanvas] Remove bg – Edit model (MiniMax H3) expects a float (H,W,3) image tensor."
            )
        pixels = image.clamp(0.0, 1.0).unsqueeze(0)
        draw_id = "remove_background"
        height, width = int(pixels.shape[1]), int(pixels.shape[2])
        gen_settings = dict(self.defaults)
        gen_settings["draw_mode"] = "img2img"
        gen_settings["_draw_id"] = draw_id
        try:
            model, _clip, vae = _load_generation_assets(gen_settings)
        except Exception as exc:
            raise RuntimeError(
                f"[VNCCS UniCanvas] Remove bg – Edit model (MiniMax H3) requires the MiniMax H3 stack: {exc}"
            ) from exc
        gen_settings["_h3_prompt"] = QWEN_IMAGE21_SUBJECT_EXTRACTION_PROMPT
        gen_settings["_h3_reference_image"] = pixels
        positive, negative = self.prepare_reference_conditioning(None, None, vae, pixels, gen_settings, draw_id)
        latent = self.create_empty_latent(width, height, gen_settings, draw_id)
        sampled = self.sample_latent(
            model=model,
            positive=positive,
            negative=negative,
            latent=latent,
            seed=0,
            steps=int(self.defaults.get("steps", 20)),
            cfg=1.0,
            sampler_name=str(self.defaults.get("sampler_name", "res_multistep")),
            scheduler=str(self.defaults.get("scheduler", "simple")),
            denoise=1.0,
            gen_settings=gen_settings,
            draw_id=draw_id,
            width=width,
            height=height,
        )
        decoded = self.decode_samples(vae, sampled, gen_settings)
        result = decoded[0] if torch.is_tensor(decoded) and decoded.ndim == 4 else decoded
        if not torch.is_tensor(result) or result.ndim != 3 or int(result.shape[-1]) != 4:
            raise RuntimeError(
                "[VNCCS UniCanvas] Remove bg – Edit model (MiniMax H3) subject extraction must return an RGBA image."
            )
        return result.clamp(0.0, 1.0)
