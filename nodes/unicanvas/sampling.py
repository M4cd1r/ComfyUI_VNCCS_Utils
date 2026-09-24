"""Direct (graph-less) sampling, VAE lifecycle and ComfyUI progress suppression."""

from __future__ import annotations

import contextlib
import gc
import inspect
import threading
from typing import Any

import torch

from .comfy_bridge import _call_node_method
from .debug import _latent_debug, _uc_log
from .progress import _set_draw_progress


_COMFY_PROGRESS_PATCH_LOCK = threading.Lock()
_COMFY_PROGRESS_PATCHED = False
_COMFY_PROGRESS_LOCAL = threading.local()


def _apply_differential_diffusion(model: Any, draw_id: str, strength: float = 1.0) -> Any:
    try:
        from comfy_extras.nodes_differential_diffusion import DifferentialDiffusion

        model = model.clone()
        model.set_model_denoise_mask_function(
            lambda *args, **kwargs: DifferentialDiffusion.forward(*args, **kwargs, strength=strength)
        )
        _uc_log(draw_id, "DifferentialDiffusion applied", {"strength": strength})
        return model
    except Exception as exc:
        _uc_log(draw_id, "DifferentialDiffusion unavailable", {"error": str(exc)})
        return model


def _ensure_direct_sampling_prompt_context(prompt_id: str = "unicanvas_draw") -> None:
    try:
        from server import PromptServer

        if not hasattr(PromptServer.instance, "last_prompt_id"):
            PromptServer.instance.last_prompt_id = prompt_id
    except Exception:
        pass


def _install_direct_sampling_progress_suppressor() -> None:
    global _COMFY_PROGRESS_PATCHED
    if _COMFY_PROGRESS_PATCHED:
        return
    with _COMFY_PROGRESS_PATCH_LOCK:
        if _COMFY_PROGRESS_PATCHED:
            return
        try:
            from server import PromptServer

            instance = PromptServer.instance
            original_send_sync = getattr(instance, "send_sync", None)
            if not callable(original_send_sync):
                _COMFY_PROGRESS_PATCHED = True
                return
            if getattr(original_send_sync, "_vnccs_unicanvas_progress_guard", False):
                _COMFY_PROGRESS_PATCHED = True
                return

            def guarded_send_sync(*args: Any, **kwargs: Any):
                event = args[0] if args else kwargs.get("event")
                if event == "progress" and getattr(_COMFY_PROGRESS_LOCAL, "suppress", 0):
                    return None
                return original_send_sync(*args, **kwargs)

            guarded_send_sync._vnccs_unicanvas_progress_guard = True  # type: ignore[attr-defined]
            setattr(instance, "send_sync", guarded_send_sync)
        except Exception:
            pass
        _COMFY_PROGRESS_PATCHED = True


@contextlib.contextmanager
def _suppress_direct_sampling_comfy_progress():
    _install_direct_sampling_progress_suppressor()
    depth = int(getattr(_COMFY_PROGRESS_LOCAL, "suppress", 0) or 0)
    _COMFY_PROGRESS_LOCAL.suppress = depth + 1
    try:
        yield
    finally:
        if depth:
            _COMFY_PROGRESS_LOCAL.suppress = depth
        else:
            try:
                delattr(_COMFY_PROGRESS_LOCAL, "suppress")
            except AttributeError:
                pass


def _sample_generation_latent_default(
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
):
    import nodes

    _ensure_direct_sampling_prompt_context()
    _uc_log(
        draw_id,
        "KSampler input",
        {
            "seed": seed,
            "steps": steps,
            "cfg": cfg,
            "sampler_name": sampler_name,
            "scheduler": scheduler,
            "denoise": denoise,
            "latent": _latent_debug(latent),
        },
    )

    def on_step(step: int, *_args: Any) -> None:
        current = min(max(int(step) + 1, 1), max(steps, 1))
        _set_draw_progress(draw_id, "sampling", 0.35 + 0.5 * (current / max(steps, 1)), current, steps, f"Sampling step {current}/{steps}")

    kwargs = dict(
        model=model,
        seed=seed,
        steps=steps,
        cfg=cfg,
        sampler_name=sampler_name,
        scheduler=scheduler,
        positive=positive,
        negative=negative,
        latent=latent,
        denoise=denoise,
    )
    try:
        sig = inspect.signature(nodes.common_ksampler)
        if "callback" in sig.parameters:
            kwargs["callback"] = on_step
        _set_draw_progress(draw_id, "sampling", 0.35, 0, steps, f"Sampling 0/{steps}")
        with _suppress_direct_sampling_comfy_progress():
            sampled = nodes.common_ksampler(**kwargs)[0]
        _uc_log(draw_id, "common_ksampler output", _latent_debug(sampled))
        return sampled
    except Exception as exc:
        _uc_log(draw_id, "common_ksampler with progress failed; falling back to KSampler", {"error": str(exc)})

    _set_draw_progress(draw_id, "sampling", 0.35, 0, steps, f"Sampling 0/{steps}")
    with _suppress_direct_sampling_comfy_progress():
        sampled = _call_node_method(
            ["KSampler"],
            ["sample"],
            model=model,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            positive=positive,
            negative=negative,
            latent_image=latent,
            latent=latent,
            denoise=denoise,
        )
    _set_draw_progress(draw_id, "sampling", 0.85, steps, steps, f"Sampling {steps}/{steps}")
    if isinstance(sampled, tuple) and sampled:
        _uc_log(draw_id, "KSampler tuple output", _latent_debug(sampled[0]))
        return sampled[0]
    if sampled is not None:
        _uc_log(draw_id, "KSampler output", _latent_debug(sampled))
        return sampled
    raise RuntimeError("Sampler returned no latent output")


def _preload_vae_for_direct_decode(vae: Any, gen_settings: dict[str, Any], draw_id: str = "unknown") -> None:
    generation_mode = str((gen_settings or {}).get("generation_mode") or "").lower()
    draw_mode = str((gen_settings or {}).get("draw_mode") or "").lower()
    if generation_mode not in {"z_image", "z-image", "zimage", "z_image_turbo"} or draw_mode not in {"inpaint", "outpaint"}:
        return

    patcher = getattr(vae, "patcher", None)
    if patcher is None:
        _uc_log(draw_id, "VAE preload skipped", {"reason": "VAE has no patcher"})
        return

    try:
        import comfy.model_management as model_management

        load_models_gpu = getattr(model_management, "load_models_gpu", None)
        if not callable(load_models_gpu):
            _uc_log(draw_id, "VAE preload skipped", {"reason": "model_management.load_models_gpu is unavailable"})
            return

        kwargs = {}
        with contextlib.suppress(Exception):
            sig = inspect.signature(load_models_gpu)
            if "memory_required" in sig.parameters:
                kwargs["memory_required"] = 0
        load_models_gpu([patcher], **kwargs)
        _uc_log(draw_id, "VAE preloaded before Z-image sampling", {"kwargs": kwargs})
    except Exception as exc:
        _uc_log(draw_id, "VAE preload failed", {"error": str(exc)})


def _unload_vae_after_direct_decode(vae: Any, gen_settings: dict[str, Any], draw_id: str = "unknown") -> None:
    generation_mode = str((gen_settings or {}).get("generation_mode") or "").lower()
    draw_mode = str((gen_settings or {}).get("draw_mode") or "").lower()
    if generation_mode not in {"z_image", "z-image", "zimage", "z_image_turbo"} or draw_mode not in {"inpaint", "outpaint"}:
        return

    patcher = getattr(vae, "patcher", None)
    if patcher is None:
        return

    try:
        import comfy.model_management as model_management

        loaded_models = getattr(model_management, "current_loaded_models", None)
        if not isinstance(loaded_models, list):
            _uc_log(draw_id, "VAE post-decode unload skipped", {"reason": "current_loaded_models is unavailable"})
            return

        unloaded = 0
        for index in range(len(loaded_models) - 1, -1, -1):
            loaded_model = loaded_models[index]
            if getattr(loaded_model, "model", None) is not patcher:
                continue
            try:
                loaded_model.model_unload(1e30)
            finally:
                loaded_models.pop(index)
            unloaded += 1

        gc.collect()
        with contextlib.suppress(Exception):
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        _uc_log(draw_id, "VAE unloaded after direct decode", {"unloaded": unloaded})
    except Exception as exc:
        _uc_log(draw_id, "VAE post-decode unload failed", {"error": str(exc)})


def _release_generation_sampling_refs(gen_settings: dict[str, Any], draw_id: str = "unknown") -> None:
    released_keys = []
    for key in (
        "_z_image_fun_controlnet_image",
        "_z_image_fun_controlnet_mask",
        "_z_image_fun_controlnet_vae",
        "_z_image_fun_controlnet_patch_model",
        "_anima_lllite_image",
        "_anima_lllite_mask",
        "_pose_edit_images",
        "_qwen_edit_reference_image",
        "_qwen_edit_mask",
        "_qwen_edit_latent",
        "_qwen21_latent",
        "_qwen21_clip",
        "_qwen21_prompts",
        "_qwen21_prompt",
        "_qwen21_negative_prompt",
        "_krea2_edit_clip",
        "_krea2_edit_image",
        "_krea2_edit_vae",
    ):
        if key in gen_settings:
            gen_settings.pop(key, None)
            released_keys.append(key)
    gc.collect()
    with contextlib.suppress(Exception):
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    if released_keys:
        _uc_log(draw_id, "released sampling-only references before VAE decode", {"keys": released_keys})
