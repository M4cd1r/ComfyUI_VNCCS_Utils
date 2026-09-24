"""Base class every UniCanvas model family adapter derives from."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import torch
from PIL import Image

from ..constants import OUTPAINT_PROMPT_SUFFIX
from ..debug import _latent_debug, _uc_log
from ..latents import _unwrap_latent_samples
from ..loras import _apply_lora_cached, _clone_model_clip
from ..masking import _make_edit_outpaint_reference_rgb, _sample_transparent_outpaint_rgb
from ..sampling import _sample_generation_latent_default


@dataclass(frozen=True)
class UniCanvasModelModule:
    """Backend adapter for one UniCanvas model family.

    The frontend cannot rely on graph connections for model objects because the
    draw action runs inside the widget before a workflow execution starts. Each
    model family therefore owns its own loader contract and generation quirks.
    """

    key: str
    aliases: tuple[str, ...]
    defaults: dict[str, Any]
    is_edit_model: bool = False

    def uses_edit_masked_latents(self, mode: str) -> bool:
        return mode in {"inpaint", "outpaint"}

    def uses_differential_diffusion(self, mode: str) -> bool:
        return mode in {"inpaint", "outpaint"}

    def outpaint_prompt_suffix(self) -> str:
        return OUTPAINT_PROMPT_SUFFIX if self.is_edit_model else ""

    def prepare_outpaint_reference_image(self, source_rgba: Image.Image, mask_image: Image.Image, draw_id: str) -> Image.Image:
        if self.is_edit_model:
            return _make_edit_outpaint_reference_rgb(source_rgba, draw_id)
        return _sample_transparent_outpaint_rgb(source_rgba, draw_id)

    def apply_loras(self, model: Any, clip: Any, gen_settings: dict[str, Any]):
        lora_stack = gen_settings.get("lora_stack") or []
        if isinstance(lora_stack, list):
            for item in lora_stack:
                if not isinstance(item, dict):
                    continue
                lora_name = str(item.get("name") or item.get("lora_name") or "")
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

    def encode_prompt(self, clip: Any, text: str, _gen_settings: dict[str, Any]):
        tokens = clip.tokenize(text or "")
        cond, pooled = clip.encode_from_tokens(tokens, return_pooled=True)
        return [[cond, {"pooled_output": pooled}]]

    def validate_conditioning(self, _positive: Any, _negative: Any, _gen_settings: dict[str, Any]) -> None:
        return None

    def clone_assets(self, model: Any, clip: Any) -> tuple[Any, Any]:
        return _clone_model_clip(model, clip)

    def create_empty_latent(self, width: int, height: int, _gen_settings: dict[str, Any], draw_id: str = "unknown") -> dict[str, Any]:
        import nodes

        batch_size = max(1, int((_gen_settings or {}).get("batch_size", 1) or 1))
        encoded = nodes.EmptyLatentImage().generate(width, height, batch_size)[0]
        _uc_log(draw_id, "created empty SD latent", _latent_debug(encoded))
        return encoded

    def decode_samples(self, vae: Any, samples: Any, _gen_settings: dict[str, Any]):
        latent_samples = _unwrap_latent_samples(samples)
        tile_size = 256 if str((_gen_settings or {}).get("generation_mode") or "").lower() in {"z_image", "z-image", "zimage", "z_image_turbo"} else 512
        overlap = min(64, max(32, tile_size // 4))
        _uc_log(str((_gen_settings or {}).get("_draw_id") or "unknown"), "VAE tiled decode", {"tile_size": tile_size, "overlap": overlap})
        return vae.decode_tiled(latent_samples, tile_x=tile_size, tile_y=tile_size, overlap=overlap)

    def prepare_reference_conditioning(
        self,
        positive: Any,
        negative: Any,
        vae: Any,
        image_tensor: torch.Tensor,
        gen_settings: dict[str, Any],
        draw_id: str = "unknown",
    ) -> tuple[Any, Any]:
        return positive, negative

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
        return _sample_generation_latent_default(
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
        )


def _reference_image_slots(image_tensor: Any, gen_settings: dict[str, Any] | None) -> dict[int, Any]:
    """Map Edit model reference images to their numbered slots (spec 3 and 9).

    Slot 1 is the canvas working area; slots 2..11 hold the VNCSS Config
    reference images (reference_image_1..10) in socket order. Gaps are
    preserved: a reference in socket position N always occupies slot N+1.
    Shared by the MiniMax H3 (<Picture N>) and Qwen-Image-2.1 (<image N>)
    modules.
    """
    from ...vncss_config import REFERENCE_INPUTS

    slots: dict[int, Any] = {}
    if image_tensor is not None:
        slots[1] = image_tensor
    external_refs = ((gen_settings or {}).get("_external") or {}).get("references") or {}
    for slot, name in enumerate(REFERENCE_INPUTS, start=2):
        value = external_refs.get(name)
        if value is not None:
            slots[slot] = value
    return slots
