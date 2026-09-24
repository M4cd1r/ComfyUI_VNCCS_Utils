"""aiohttp routes that expose the UniCanvas backend to the frontend widget."""

from __future__ import annotations

import asyncio
import os
import threading
from typing import Any

from .assets import _get_checkpoint_names, _get_unicanvas_assets
from .color_match import _run_unicanvas_color_match
from .constants import _MAX_UPLOAD_BYTES
from .draw import _run_unicanvas_draw
from .models.qwen_image21 import (
    _QWEN21_TURBO_LORA_DOWNLOAD,
    QWEN21_TURBO_LORA_NAME,
    resolve_qwen21_turbo_lora,
)
from .paths import _get_full_path_agnostic
from .presets import (
    _PRESET_DOWNLOAD_STATUS,
    _enqueue_preset_download,
    _get_unicanvas_presets,
    _unicanvas_find_preset_asset,
    _unicanvas_load_preset_registry,
    _unicanvas_resolve_local_model_path,
)
from .progress import _get_draw_progress, _get_draw_result, _set_draw_progress
from .remove_bg import _run_unicanvas_remove_bg
from .save_output import _run_unicanvas_save_output
from .segment import _run_unicanvas_segment


_DRAW_LOCK = asyncio.Lock()
_UNICANVAS_LAYER_ROUTES_REGISTERED = False


def _content_length_ok(request, max_bytes: int) -> bool:
    try:
        raw_length = request.headers.get("Content-Length")
        if raw_length is None:
            return not getattr(request, "can_read_body", False)
        return int(raw_length) <= max_bytes
    except Exception:
        return False


def register_unicanvas_routes() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return

    @PromptServer.instance.routes.get("/vnccs/unicanvas/checkpoints")
    async def vnccs_unicanvas_checkpoints(_request):
        try:
            return web.json_response({"checkpoints": _get_checkpoint_names()})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/unicanvas/loras")
    async def vnccs_unicanvas_loras(_request):
        try:
            import folder_paths

            return web.json_response({"loras": sorted(folder_paths.get_filename_list("loras"))})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/unicanvas/assets")
    async def vnccs_unicanvas_assets(_request):
        try:
            return web.json_response(_get_unicanvas_assets())
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/unicanvas/presets")
    async def vnccs_unicanvas_presets(_request):
        try:
            return web.json_response(_get_unicanvas_presets())
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/unicanvas/presets/status")
    async def vnccs_unicanvas_presets_status(_request):
        return web.json_response(dict(_PRESET_DOWNLOAD_STATUS))

    @PromptServer.instance.routes.post("/vnccs/unicanvas/presets/download")
    async def vnccs_unicanvas_presets_download(request):
        try:
            payload = await request.json()
            preset_id = str(payload.get("preset_id") or "")
            kind = str(payload.get("kind") or "assets")
            queued: list[str] = []
            if kind == "turbo":
                download_key, asset = _unicanvas_find_preset_asset(preset_id, "turbo")
                if not os.path.exists(_unicanvas_resolve_local_model_path(str(asset.get("local_path") or ""))):
                    _enqueue_preset_download(download_key, asset)
                queued.append(download_key)
            else:
                registry = _unicanvas_load_preset_registry()
                found = None
                for preset in registry.get("presets", []):
                    if isinstance(preset, dict) and str(preset.get("id") or "") == preset_id:
                        found = preset
                        break
                if found is None:
                    raise ValueError(f"Preset '{preset_id}' not found")
                for index, asset in enumerate(found.get("assets") or []):
                    if not isinstance(asset, dict):
                        continue
                    download_key = f"{preset_id}:asset:{index}"
                    if not os.path.exists(_unicanvas_resolve_local_model_path(str(asset.get("local_path") or ""))):
                        _enqueue_preset_download(download_key, asset)
                    queued.append(download_key)
            return web.json_response({"status": "queued", "queued": queued})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.post("/vnccs/unicanvas/draw")
    async def vnccs_unicanvas_draw(request):
        if not _content_length_ok(request, _MAX_UPLOAD_BYTES * 2 + 1024 * 1024):
            return web.json_response({"error": "UniCanvas draw payload is too large"}, status=413)
        payload: dict[str, Any] = {}
        try:
            payload = await request.json()
            async with _DRAW_LOCK:
                result = await asyncio.to_thread(_run_unicanvas_draw, payload)
            return web.json_response(result)
        except Exception as exc:
            import traceback

            traceback.print_exc()
            draw_id = str(payload.get("debug_id") or "unknown")
            _set_draw_progress(draw_id, "error", 1.0, 0, 0, str(exc))
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.post("/vnccs/unicanvas/segment")
    async def vnccs_unicanvas_segment(request):
        if not _content_length_ok(request, _MAX_UPLOAD_BYTES + 1024 * 1024):
            return web.json_response({"error": "UniCanvas SAM payload is too large"}, status=413)
        try:
            payload = await request.json()
            result = await asyncio.to_thread(_run_unicanvas_segment, payload)
            return web.json_response(result)
        except Exception as exc:
            import traceback

            traceback.print_exc()
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/unicanvas/progress/{draw_id}")
    async def vnccs_unicanvas_progress(request):
        return web.json_response(_get_draw_progress(str(request.match_info.get("draw_id") or "")))

    @PromptServer.instance.routes.get("/vnccs/unicanvas/result/{draw_id}")
    async def vnccs_unicanvas_result(request):
        return web.json_response(_get_draw_result(str(request.match_info.get("draw_id") or "")))

    @PromptServer.instance.routes.post("/vnccs/unicanvas/save_output")
    async def vnccs_unicanvas_save_output(request):
        if not _content_length_ok(request, _MAX_UPLOAD_BYTES + 1024 * 1024):
            return web.json_response({"error": "[VNCCS UniCanvas] save_output payload is too large"}, status=413)
        payload: dict[str, Any] = {}
        try:
            body = await request.json()
            if isinstance(body, dict):
                payload = dict(body)
        except Exception:
            payload = {}
        # The layer context menu calls this route with ?layer_id=..., the Save to
        # output button sends it as a JSON field; both select the same layer save.
        layer_id = request.query.get("layer_id") or payload.get("layer_id")
        if layer_id:
            payload["layer_id"] = str(layer_id)
        try:
            result = await asyncio.to_thread(_run_unicanvas_save_output, payload)
            return web.json_response(result)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    register_unicanvas_layer_routes()


def register_unicanvas_layer_routes() -> None:
    global _UNICANVAS_LAYER_ROUTES_REGISTERED
    if _UNICANVAS_LAYER_ROUTES_REGISTERED:
        return
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return

    @PromptServer.instance.routes.post("/vnccs/unicanvas/remove_bg")
    async def vnccs_unicanvas_remove_bg(request):
        if not _content_length_ok(request, _MAX_UPLOAD_BYTES + 1024 * 1024):
            return web.json_response({"error": "[VNCCS UniCanvas] Remove bg payload is too large."}, status=413)
        try:
            payload = await request.json()
            result = await asyncio.to_thread(_run_unicanvas_remove_bg, payload)
            return web.json_response(result)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/unicanvas/qwen21_turbo")
    async def vnccs_unicanvas_qwen21_turbo_status(request):
        import folder_paths

        status = dict(_QWEN21_TURBO_LORA_DOWNLOAD)
        installed = bool(_get_full_path_agnostic(folder_paths, "loras", QWEN21_TURBO_LORA_NAME))
        if installed and status.get("status") != "downloading":
            status = {"status": "success", "progress": 1.0, "message": "Installed"}
        return web.json_response({"lora_name": QWEN21_TURBO_LORA_NAME, **status})

    @PromptServer.instance.routes.post("/vnccs/unicanvas/qwen21_turbo")
    async def vnccs_unicanvas_qwen21_turbo_download(request):
        if _QWEN21_TURBO_LORA_DOWNLOAD.get("status") == "downloading":
            return web.json_response({"queued": True, "lora_name": QWEN21_TURBO_LORA_NAME})
        _QWEN21_TURBO_LORA_DOWNLOAD.update({"status": "queued", "progress": 0.0, "message": "Queued"})

        def _download_worker() -> None:
            try:
                resolve_qwen21_turbo_lora()
            except Exception:
                pass  # the status payload carries the failure message

        threading.Thread(target=_download_worker, daemon=True).start()
        return web.json_response({"queued": True, "lora_name": QWEN21_TURBO_LORA_NAME})

    @PromptServer.instance.routes.post("/vnccs/unicanvas/color_match")
    async def vnccs_unicanvas_color_match(request):
        if not _content_length_ok(request, _MAX_UPLOAD_BYTES * 2 + 1024 * 1024):
            return web.json_response({"error": "[VNCCS UniCanvas] Color match payload is too large."}, status=413)
        try:
            payload = await request.json()
            result = await asyncio.to_thread(_run_unicanvas_color_match, payload)
            return web.json_response(result)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    _UNICANVAS_LAYER_ROUTES_REGISTERED = True
