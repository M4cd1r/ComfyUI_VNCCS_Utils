"""The UniCanvas draw action: txt2img, img2img, inpaint and outpaint in one entry point."""

from __future__ import annotations

import contextlib
import gc
import time
from typing import Any

import torch
from PIL import Image

from .constants import _MAX_PIXELS
from .debug import UNICANVAS_DEBUG, _latent_debug, _tensor_debug, _uc_log
from .generation import (
    _apply_generation_loras,
    _create_empty_generation_latent,
    _decode_generation_samples,
    _encode_generation_prompt,
    _normalize_gen_settings,
    _sample_generation_latent,
)
from .imaging import (
    _decode_data_url,
    _image_tensor_to_pil_list,
    _pil_to_image_tensor,
    _pil_to_mask_image,
    _pil_to_mask_tensor,
)
from .latents import (
    _encode_source_latent,
    _prepare_masked_generation_latent,
    _repeat_conditioning_batch,
    _repeat_latent_batch,
)
from .loaders import _load_generation_assets
from .locks import _COMFY_MODEL_OP_LOCK
from .masking import _combine_mask_with_source_alpha, _make_gradient_denoise_mask, _make_gradient_paste_mask
from .models.qwen_image21 import _apply_qwen21_spectrum
from .models.registry import _get_unicanvas_model_module
from .models.z_image import _preload_z_image_fun_controlnet_patch
from .progress import _set_draw_progress
from .sampling import (
    _apply_differential_diffusion,
    _preload_vae_for_direct_decode,
    _release_generation_sampling_refs,
    _unload_vae_after_direct_decode,
)


def _append_prompt_suffix(prompt: str, suffix: str) -> str:
    prompt = str(prompt or "").strip()
    suffix = str(suffix or "").strip()
    if not suffix:
        return prompt
    if suffix.lower() in prompt.lower():
        return prompt
    if not prompt:
        return suffix
    return f"{prompt}, {suffix}"


def _save_temp_image(image: Image.Image, prefix: str = "VNCCS_UniCanvas") -> dict[str, str]:
    import folder_paths

    output_dir = folder_paths.get_temp_directory()
    full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        prefix, output_dir, image.width, image.height
    )
    file = f"{filename}_{counter:05}_.png"
    image.save(f"{full_output_folder}/{file}", compress_level=1)
    return {"filename": file, "subfolder": subfolder, "type": "temp"}


def _prepare_pose_edit_images(payload: dict[str, Any], model_key: str, size: tuple[int, int]) -> list[Image.Image] | None:
    """Validate the explicit Pose Studio contract before loading model assets."""
    pose_edit = payload.get("pose_edit")
    if pose_edit is None:
        return None
    if model_key not in {"qwen_image_edit", "flux_klein"}:
        raise ValueError("Pose layers require QiE2511 or Klein9b")
    if payload.get("mode") != "img2img" or payload.get("source_empty"):
        raise ValueError("Pose editing requires img2img with two reference images")
    if not isinstance(pose_edit, dict) or set(pose_edit) != {"image1", "image2"}:
        raise ValueError("Pose editing requires image1 (pose) and image2 (background and character)")
    images = []
    for key in ("image1", "image2"):
        rgba = _decode_data_url(str(pose_edit[key] or ""), "RGBA")
        if rgba.size != size:
            raise ValueError(f"Pose {key} dimensions must match inference_size")
        background = Image.new("RGBA", size, (255, 255, 255, 255))
        background.alpha_composite(rgba)
        images.append(background.convert("RGB"))
    return images


def _run_unicanvas_draw(payload: dict[str, Any]) -> dict[str, Any]:
    draw_id = str(payload.get("debug_id") or f"{int(time.time() * 1000)}")
    _set_draw_progress(draw_id, "queued", 0.01, 0, 0, "Queued")
    mode = str(payload.get("mode") or "img2img")
    if mode not in {"txt2img", "img2img", "inpaint", "outpaint"}:
        raise ValueError("mode must be txt2img, img2img, inpaint or outpaint")

    gen_settings = payload.get("settings")
    if not isinstance(gen_settings, dict):
        # Graph generation hands the node state's settings over as "gen_settings".
        gen_settings = payload.get("gen_settings")
    gen_settings = dict(gen_settings) if isinstance(gen_settings, dict) else {}
    external = payload.get("external")
    if external:
        # A VNCSS_CONFIG draw forwards its own model block, so the pass-through loader owns the assets.
        gen_settings["_external"] = external
        gen_settings["model_loader"] = "external"
        # _normalize_gen_settings merges the selected preset over these settings before inferring the
        # loader, and every preset ships its own model_loader/generation_mode (the widget defaults
        # select the "sdxl" preset), which would silently replace the wired config. Drop the preset
        # selection keys so the external block always wins; non-external draws are untouched.
        gen_settings.pop("model_selection_mode", None)
        gen_settings.pop("selected_preset_id", None)
        # The config overrides the node's model-side settings: its model already carries the config
        # LoRA stack and its reference inputs fill the numbered slots, so the node's own LoRA stack,
        # Turbo LoRA and uploaded references (greyed out in the widget) must not stack on top.
        gen_settings["lora_stack"] = []
        gen_settings["turbo_enabled"] = False
        gen_settings.pop("edit_reference_images", None)
    # Widget-uploaded Edit model reference images (spec 9): the upload popover is
    # an alternative to the VNCSS Config reference inputs and occupies the same
    # numbered slots (reference_image_N -> <Picture N+1>).
    edit_refs = gen_settings.get("edit_reference_images")
    if isinstance(edit_refs, list) and edit_refs:
        external_block = gen_settings.get("_external")
        if not isinstance(external_block, dict):
            external_block = {}
            gen_settings["_external"] = external_block
        references = external_block.get("references")
        if not isinstance(references, dict):
            references = {}
            external_block["references"] = references
        uploads = [item for item in edit_refs if isinstance(item, str) and item][:4]
        for index, value in enumerate(uploads):
            name = f"reference_image_{index + 1}"
            if references.get(name) is None:
                references[name] = _pil_to_image_tensor(_decode_data_url(value, "RGB"))
    settings = _normalize_gen_settings(gen_settings)
    settings.pop("_pose_edit_images", None)
    settings["draw_mode"] = mode
    seed = int(settings.get("seed", 0))
    batch_size = max(1, min(99, int(settings.get("batch_size", 1) or 1)))
    settings["batch_size"] = batch_size
    steps = int(settings.get("steps", 24))
    cfg = float(settings.get("cfg", 7.0))
    denoise = float(settings.get("denoise", 0.65 if mode == "img2img" else 1.0))
    if mode == "txt2img":
        denoise = 1.0
    sampler_name = str(settings.get("sampler_name") or settings.get("sampler") or "euler")
    scheduler = str(settings.get("scheduler") or "normal")
    grow_mask_by = int(settings.get("grow_mask_by", 6))
    mask_blur = int(settings.get("mask_blur", 16))
    coherence_edge_size = int(settings.get("canvas_coherence_edge_size", 16))
    positive_text = str(settings.get("positive", ""))
    model_module = _get_unicanvas_model_module(str(settings.get("generation_mode", "illustrious")).lower())
    if model_module.key == "minimax_h3" and not external:
        # The H3 family is driven by VNCSS_CONFIG: it supplies clip/vae/audio_vae and the reference
        # dataset, while by-name loading of that stack is deferred (spec section 14). Without a config
        # the draw would dead-end on "requires the audio VAE", which has no control outside the config
        # node, so fail fast here, before any asset loading, with the actionable message.
        raise RuntimeError(
            "[VNCCS UniCanvas] MiniMax H3 requires a connected VNCSS Config node (clip, vae, audio_vae)."
        )
    outpaint_prompt_suffix = model_module.outpaint_prompt_suffix() if mode == "outpaint" else ""
    if outpaint_prompt_suffix:
        positive_text = _append_prompt_suffix(positive_text, outpaint_prompt_suffix)
    negative_text = str(settings.get("negative", ""))
    _uc_log(
        draw_id,
        "request",
        {
            "mode": mode,
            "bbox": payload.get("bbox"),
            "inference_size": payload.get("inference_size"),
            "output_size": payload.get("output_size"),
            "source_empty": payload.get("source_empty"),
            "generation_mode": settings.get("generation_mode"),
            "model_loader": settings.get("model_loader"),
            "ckpt_name": settings.get("ckpt_name"),
            "diffusion_model_name": settings.get("diffusion_model_name"),
            "gguf_model_name": settings.get("gguf_model_name"),
            "clip_name": settings.get("clip_name"),
            "clip_type": settings.get("clip_type"),
            "vae_name": settings.get("vae_name"),
            "lora_stack_count": len(settings.get("lora_stack") or []) if isinstance(settings.get("lora_stack"), list) else None,
            "mode_settings_keys": sorted(str(key) for key in settings.get("mode_settings", {}).keys()) if isinstance(settings.get("mode_settings"), dict) else None,
            "turbo_enabled": settings.get("turbo_enabled"),
            "seed": seed,
            "batch_size": batch_size,
            "steps": steps,
            "cfg": cfg,
            "denoise": denoise,
            "sampler_name": sampler_name,
            "scheduler": scheduler,
            "grow_mask_by": grow_mask_by,
            "mask_blur": mask_blur,
            "canvas_coherence_edge_size": coherence_edge_size,
            "outpaint_prompt_suffix": outpaint_prompt_suffix or None,
            "positive_len": len(positive_text),
            "negative_len": len(negative_text),
        },
    )

    pose_payload = payload.get("pose_edit")
    source_url = pose_payload.get("image2") if isinstance(pose_payload, dict) else payload.get("image")
    source_rgba = _decode_data_url(str(source_url or ""), "RGBA")
    source = source_rgba.convert("RGB")
    reference_source = source
    source_for_composite = source
    width, height = source.size
    source_empty = bool(payload.get("source_empty"))
    pose_images = _prepare_pose_edit_images(payload, model_module.key, (width, height))
    if pose_images:
        denoise = 1.0
        settings["denoise"] = 1.0
        source = reference_source = source_for_composite = pose_images[1]
        settings["qwen_latent_image_index"] = 1
    if model_module.key == "krea2_edit" and (mode == "txt2img" or source_empty or source_rgba.getextrema()[3][1] == 0):
        raise ValueError("Krea2 Edit requires an image inside the bbox. Import an image and describe the edit.")
    inference_payload = payload.get("inference_size") or {}
    expected_width = int(inference_payload.get("width") or width)
    expected_height = int(inference_payload.get("height") or height)
    if (width, height) != (expected_width, expected_height):
        raise ValueError(
            f"inference_size mismatch: payload says {expected_width}x{expected_height}, image is {width}x{height}"
        )
    output_payload = payload.get("output_size") or {}
    output_width = int(output_payload.get("width") or width)
    output_height = int(output_payload.get("height") or height)
    if output_width < 1 or output_height < 1:
        raise ValueError("output_size must be positive")
    if output_width * output_height > _MAX_PIXELS:
        raise ValueError("output_size is too large")

    with contextlib.ExitStack() as _model_stack:
        _model_stack.enter_context(_COMFY_MODEL_OP_LOCK)
        _model_stack.enter_context(torch.inference_mode())
        _set_draw_progress(draw_id, "loading", 0.08, 0, steps, "Loading models")
        model, clip, vae = _load_generation_assets(settings)
        model, clip = model_module.clone_assets(model, clip)
        settings["_draw_id"] = draw_id
        _preload_z_image_fun_controlnet_patch(settings, mode, draw_id)
        _preload_vae_for_direct_decode(vae, settings, draw_id)
        if model_module.key == "qwen_image_edit":
            settings["_qwen_edit_clip"] = clip
            settings["_qwen_edit_vae"] = vae
        _set_draw_progress(draw_id, "loras", 0.14, 0, steps, "Applying LoRAs")
        model, clip = _apply_generation_loras(model, clip, settings)
        if model_module.key == "qwen_image_edit":
            settings["_qwen_edit_clip"] = clip
        _set_draw_progress(draw_id, "conditioning", 0.2, 0, steps, "Encoding prompts")
        if model_module.key == "qwen_image_edit":
            positive = []
            negative = []
            _uc_log(
                draw_id,
                "Qwen Image Edit prompt encoding deferred",
                {"reason": "Qwen Image Edit 2511 needs the prepared reference image and VL image tokens"},
            )
        else:
            positive = _encode_generation_prompt(clip, positive_text, settings)
            negative = _encode_generation_prompt(clip, negative_text, settings)
            model_module.validate_conditioning(positive, negative, settings)

        mask = None
        mask_image = None
        paste_mask_image = None
        _set_draw_progress(draw_id, "preparing", 0.26, 0, steps, "Preparing source")
        if mode in {"inpaint", "outpaint"}:
            mask_image = _decode_data_url(str(payload.get("mask") or ""), "RGBA")
            if mask_image.size != source.size:
                _uc_log(draw_id, "mask resized to source size", {"from": mask_image.size, "to": source.size})
                mask_image = mask_image.resize(source.size, Image.Resampling.BILINEAR)
            if mode == "outpaint":
                mask_image = _combine_mask_with_source_alpha(mask_image, source_rgba)
                denoise_mask_image, expanded_mask_area = _make_gradient_denoise_mask(
                    mask_image, coherence_edge_size, draw_id
                )
                paste_mask_image = _make_gradient_paste_mask(expanded_mask_area, mask_blur, draw_id)
                source = model_module.prepare_outpaint_reference_image(source_rgba, mask_image, draw_id)
                reference_source = source
                source_for_composite = source_rgba.convert("RGB")
                mask = _pil_to_mask_tensor(denoise_mask_image)
            else:
                denoise_mask_image, expanded_mask_area = _make_gradient_denoise_mask(
                    mask_image, coherence_edge_size, draw_id
                )
                paste_mask_image = _make_gradient_paste_mask(expanded_mask_area, mask_blur, draw_id)
                mask = _pil_to_mask_tensor(denoise_mask_image)
            if mask is not None and float(mask.sum().item()) <= 0.0:
                _uc_log(
                    draw_id,
                    "empty masked-mode mask converted to img2img",
                    {
                        "from_mode": mode,
                        "reason": "masked generation with an empty mask produces an empty paste mask and applies zero result pixels",
                    },
                )
                mode = "img2img"
                settings["draw_mode"] = mode
                if settings.pop("_z_image_fun_controlnet_patch_model", None) is not None:
                    gc.collect()
                    with contextlib.suppress(Exception):
                        if torch.cuda.is_available():
                            torch.cuda.empty_cache()
                    _uc_log(
                        draw_id,
                        "Z-image Fun ControlNet patch released after empty mask mode switch",
                        {"to_mode": mode},
                    )
                mask = None
                mask_image = None
                paste_mask_image = None
            if model_module.key == "qwen_image_edit" and mask is not None:
                settings["_qwen_edit_mask"] = mask
            if mask_image is not None and UNICANVAS_DEBUG:
                mask_for_debug = _pil_to_mask_image(mask_image)
                _uc_log(
                    draw_id,
                    "mask decoded",
                    {
                        "full_mask_size": mask_image.size,
                        "note": "active_bbox_gt_0_01 is only the non-zero mask area inside the full inference image",
                        "tensor": _tensor_debug(mask),
                    },
                )
                source_debug = _save_temp_image(source, f"VNCCS_UniCanvas_{draw_id}_source")
                mask_debug = _save_temp_image(mask_for_debug, f"VNCCS_UniCanvas_{draw_id}_mask")
                paste_mask_debug = _save_temp_image(paste_mask_image, f"VNCCS_UniCanvas_{draw_id}_paste_mask") if paste_mask_image is not None else None
                _uc_log(
                    draw_id,
                    "debug input images saved",
                    {"source": source_debug, "mask": mask_debug, "paste_mask": paste_mask_debug},
                )
        else:
            _uc_log(draw_id, "mask skipped", {"reason": f"mode is {mode}"})
        if model_module.is_edit_model and (mode == "txt2img" or source_empty):
            source = Image.new("RGB", (width, height), (0, 0, 0))
            reference_source = source
            source_for_composite = source
            _uc_log(draw_id, "edit-model txt2img source replaced with black reference image", {"size": source.size})
        image_tensor = _pil_to_image_tensor(source)
        reference_image_tensor = _pil_to_image_tensor(reference_source)
        if pose_images:
            settings["_pose_edit_images"] = [_pil_to_image_tensor(image) for image in pose_images]
        _uc_log(
            draw_id,
            "source prepared",
            {
                "size": source.size,
                "tensor": _tensor_debug(image_tensor),
                "reference_size": reference_source.size,
                "reference_tensor": _tensor_debug(reference_image_tensor),
            },
        )
        if model_module.key == "z_image" and mode in {"inpaint", "outpaint"} and mask is not None:
            settings["_z_image_fun_controlnet_image"] = image_tensor
            settings["_z_image_fun_controlnet_mask"] = mask
            settings["_z_image_fun_controlnet_vae"] = vae
            _uc_log(
                draw_id,
                "Z-image Fun ControlNet inputs prepared",
                {
                    "mode": mode,
                    "image": _tensor_debug(image_tensor),
                    "mask": _tensor_debug(mask),
                    "patch": settings.get("fun_controlnet_patch_name"),
                },
            )
        if model_module.key == "anima" and mode in {"inpaint", "outpaint"} and mask is not None and bool(settings.get("anima_lllite_inpaint", True)):
            settings["_anima_lllite_image"] = image_tensor
            settings["_anima_lllite_mask"] = mask
            _uc_log(
                draw_id,
                "Anima LLLite inputs prepared",
                {
                    "mode": mode,
                    "image": _tensor_debug(image_tensor),
                    "mask": _tensor_debug(mask),
                    "weights": settings.get("anima_lllite_name"),
                },
            )
        positive, negative = model_module.prepare_reference_conditioning(
            positive=positive,
            negative=negative,
            vae=vae,
            image_tensor=reference_image_tensor,
            gen_settings=settings,
            draw_id=draw_id,
        )
        if (
            not model_module.is_edit_model
            and model_module.uses_differential_diffusion(mode)
            and mode in {"inpaint", "outpaint"}
            and mask is not None
        ):
            model = _apply_differential_diffusion(model, draw_id, strength=1.0)
        _set_draw_progress(draw_id, "latent", 0.32, 0, steps, "Preparing latent")
        if model_module.key == "qwen_image21":
            # Qwen-Image-2.1 owns its 64-channel RGBA latents: the <image1>
            # working-area latent is prepared during reference conditioning and
            # inpaint/outpaint are img2img runs with mask paste-back (spec 9), so
            # no InpaintModelConditioning context is built for this family.
            latent = settings.get("_qwen21_latent")
            if not isinstance(latent, dict):
                latent = _create_empty_generation_latent(width, height, settings, draw_id=draw_id)
            _uc_log(draw_id, "Qwen-Image-2.1 latent prepared", {"mode": mode, "latent": _latent_debug(latent)})
        elif model_module.key == "krea2_edit" or mode == "txt2img" or (source_empty and mask is None):
            latent = _create_empty_generation_latent(width, height, settings, draw_id=draw_id)
        elif mode in {"inpaint", "outpaint"} and mask is not None:
            positive, negative, latent = _prepare_masked_generation_latent(
                model_module=model_module,
                mode=mode,
                positive=positive,
                negative=negative,
                vae=vae,
                image_tensor=image_tensor,
                mask=mask,
                grow_mask_by=grow_mask_by,
                draw_id=draw_id,
                gen_settings=settings,
            )
        elif model_module.key == "qwen_image_edit" and isinstance(settings.get("_qwen_edit_latent"), dict):
            latent = settings["_qwen_edit_latent"]
            _uc_log(
                draw_id,
                "Qwen Image Edit uses encoder reference latent",
                {"reason": "matches VNCCS_QWEN_Encoder output latent", "latent": _latent_debug(latent)},
            )
        else:
            latent = _encode_source_latent(vae, image_tensor, None, grow_mask_by, draw_id=draw_id)
        latent = _repeat_latent_batch(latent, batch_size, draw_id)
        if model_module.key == "qwen_image_edit":
            settings["_qwen_edit_latent"] = latent
        positive = _repeat_conditioning_batch(positive, batch_size, draw_id, "positive")
        negative = _repeat_conditioning_batch(negative, batch_size, draw_id, "negative")
        if model_module.key == "qwen_image21":
            # Spectrum acceleration runs after every model mutation (the LoRA
            # stack included) and before sampling.
            model = _apply_qwen21_spectrum(model, settings, draw_id)
        latent = _sample_generation_latent(
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
            gen_settings=settings,
            draw_id=draw_id,
            width=width,
            height=height,
        )
        model = None
        clip = None
        positive = None
        negative = None
        image_tensor = None
        reference_image_tensor = None
        mask = None
        _release_generation_sampling_refs(settings, draw_id)
        _set_draw_progress(draw_id, "decoding", 0.88, steps, steps, "Decoding")
        decoded = _decode_generation_samples(vae, latent, settings)
        _uc_log(draw_id, "decoded image tensor", _tensor_debug(decoded))
        result_images = _image_tensor_to_pil_list(decoded)
        _unload_vae_after_direct_decode(vae, settings, draw_id)

    output_size = (output_width, output_height)
    if mode in {"inpaint", "outpaint"} and mask_image is not None:
        resized_images = []
        for result_image in result_images:
            if result_image.size != output_size:
                _uc_log(draw_id, "masked result resized to output size", {"from": result_image.size, "to": output_size})
                result_image = result_image.resize(output_size, Image.Resampling.LANCZOS)
            resized_images.append(result_image)
        result_images = resized_images
        _uc_log(
            draw_id,
            "masked-region output",
            {
                "note": "Returning raw generated pixels plus paste mask; frontend stores only masked regions as the layer.",
                "result_count": len(result_images),
                "result_size": result_images[0].size if result_images else output_size,
                "paste_mask_size": paste_mask_image.size if paste_mask_image is not None else mask_image.size,
            },
        )
    else:
        resized_images = []
        for result_image in result_images:
            if result_image.size != output_size:
                _uc_log(draw_id, "result resized to output size", {"from": result_image.size, "to": (output_width, output_height)})
                result_image = result_image.resize(output_size, Image.Resampling.LANCZOS)
            resized_images.append(result_image)
        result_images = resized_images

    _set_draw_progress(draw_id, "saving", 0.96, steps, steps, "Saving result")
    saved_images = [
        _save_temp_image(result_image, f"VNCCS_UniCanvas_{draw_id}_{index + 1:02d}")
        for index, result_image in enumerate(result_images)
    ]
    if not saved_images:
        raise RuntimeError("Generation returned no decoded images")
    saved = saved_images[0] if saved_images else None
    saved_mask = None
    if mode in {"inpaint", "outpaint"} and paste_mask_image is not None:
        mask_to_save = paste_mask_image
        if mask_to_save.size != output_size:
            mask_to_save = mask_to_save.resize(output_size, Image.Resampling.BILINEAR)
        saved_mask = _save_temp_image(mask_to_save, f"VNCCS_UniCanvas_{draw_id}_result_mask")
    _uc_log(draw_id, "result saved", {"image": saved, "images": saved_images, "mask": saved_mask, "count": len(saved_images), "size": output_size})
    _set_draw_progress(draw_id, "complete", 1.0, steps, steps, "Complete")
    result_payload = {
        "status": "ok",
        "image": saved,
        "images": saved_images,
        "mask": saved_mask,
        "width": output_width,
        "height": output_height,
        "inference_width": width,
        "inference_height": height,
        "generation_mode": settings.get("generation_mode", "illustrious"),
        "debug_id": draw_id,
    }
    if payload.get("return_tensor"):
        result_payload["tensor"] = decoded.detach().cpu()
    return result_payload
