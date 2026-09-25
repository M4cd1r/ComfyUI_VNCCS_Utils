"""Saving the composite or a single layer into ComfyUI's output directory.

Backs ``POST /vnccs/unicanvas/save_output`` (Save to output / layer save).
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Any

from PIL import Image

from .imaging import _decode_data_url
from .render import _render_unicanvas_state_to_rgba
from .state import _read_unicanvas_state_cache


_UNICANVAS_SAVE_OUTPUT_SEQ = 0
_UNICANVAS_SAVE_OUTPUT_LOCK = threading.Lock()

# Scene-state export writes into output/<scene>/[<part>/]: at most two folder levels.
_MAX_SUBFOLDER_DEPTH = 2
_UNSAFE_NAME_CHARS = re.compile(r'[\x00-\x1f<>:"/\\|?*]+')


def _sanitize_name_part(value: str) -> str:
    """One safe file or folder name: control and path characters become "_", no dots at the ends."""
    cleaned = _UNSAFE_NAME_CHARS.sub("_", str(value)).strip().strip(".").strip()
    return cleaned[:120]


def _sanitize_output_subfolder(value: Any) -> str:
    """A relative folder under output/: refuses "..", absolute paths and more than two levels."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("[VNCCS UniCanvas] save_output subfolder must be a string.")
    raw = value.strip()
    if not raw:
        return ""
    if raw.startswith(("/", "\\")) or os.path.isabs(raw) or re.match(r"^[A-Za-z]:", raw):
        raise ValueError("[VNCCS UniCanvas] save_output subfolder must be a relative path.")
    parts = [part.strip() for part in re.split(r"[\\/]+", raw) if part.strip()]
    if any(part in {".", ".."} for part in parts):
        raise ValueError("[VNCCS UniCanvas] save_output subfolder may not contain '.' or '..'.")
    if len(parts) > _MAX_SUBFOLDER_DEPTH:
        raise ValueError(f"[VNCCS UniCanvas] save_output subfolder may be at most {_MAX_SUBFOLDER_DEPTH} levels deep.")
    safe = [_sanitize_name_part(part) for part in parts]
    if any(not part for part in safe):
        raise ValueError("[VNCCS UniCanvas] save_output subfolder has an empty folder name.")
    return os.path.join(*safe)


def _sanitize_output_name(value: Any) -> str:
    """The base file name for a named save (scene-state export), or "" for the default name."""
    if not isinstance(value, str):
        return ""
    name = value.strip()
    if name.lower().endswith(".png"):
        name = name[:-4]
    return _sanitize_name_part(name)


def _reserve_exclusive(candidate: str) -> bool:
    try:
        os.close(os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
    except FileExistsError:
        return False
    return True


def _unicanvas_reserve_output_path(output_dir: str, name: str = "") -> str:
    """Atomically reserve a unique output name.

    Without ``name`` the file is unicanvas-<timestamp>-<n>.png; with it, <name>.png and then
    <name>-2.png, <name>-3.png, ... The lock serialises the counter and O_EXCL reserves the
    name, so concurrent saves (Save to output plus the layer context menu) cannot collide.
    """
    global _UNICANVAS_SAVE_OUTPUT_SEQ
    timestamp = int(time.time() * 1000)
    with _UNICANVAS_SAVE_OUTPUT_LOCK:
        if name:
            suffix = 1
            while True:
                candidate = os.path.join(output_dir, f"{name}.png" if suffix == 1 else f"{name}-{suffix}.png")
                if _reserve_exclusive(candidate):
                    return candidate
                suffix += 1
        while True:
            _UNICANVAS_SAVE_OUTPUT_SEQ += 1
            candidate = os.path.join(output_dir, f"unicanvas-{timestamp}-{_UNICANVAS_SAVE_OUTPUT_SEQ}.png")
            if _reserve_exclusive(candidate):
                return candidate


def _unicanvas_save_output_image(image: Image.Image, subfolder: str = "", name: str = "") -> str:
    import folder_paths

    output_dir = str(folder_paths.get_output_directory() or "output")
    if subfolder:
        root = os.path.realpath(output_dir)
        output_dir = os.path.realpath(os.path.join(root, subfolder))
        if os.path.commonpath([root, output_dir]) != root or output_dir == root:
            raise ValueError("[VNCCS UniCanvas] save_output subfolder must stay inside output/.")
    os.makedirs(output_dir, exist_ok=True)
    path = _unicanvas_reserve_output_path(output_dir, name)
    try:
        image.save(path, format="PNG")
    except BaseException:
        # The O_EXCL reservation created the file: a failed save must not leave
        # a zero-byte PNG behind in output/.
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
    return path


def _unicanvas_state_layer_image(state: dict[str, Any], layer_id: str) -> Image.Image:
    layers = state.get("layers")
    if isinstance(layers, list):
        for layer in layers:
            if not isinstance(layer, dict) or str(layer.get("id") or "") != str(layer_id):
                continue
            data_url = layer.get("dataURL") or layer.get("hiresDataURL")
            if data_url:
                return _decode_data_url(str(data_url), "RGBA")
            break
    raise ValueError(f"[VNCCS UniCanvas] Layer '{layer_id}' has no stored pixels to save.")


def _run_unicanvas_save_output(payload: dict[str, Any]) -> dict[str, Any]:
    """Save one PNG into ComfyUI's output directory for the Save to output action.

    ``image`` carries the PNG data URL of the flattened composite, or of a single
    layer when ``layer_id`` is set (the layer keeps its alpha channel). Without
    ``image`` the pixels come from ``state`` (or the server-side state cache via
    ``state_id``): ``layer_id`` saves only that layer's PNG, otherwise the whole
    state renders to one flattened composite.

    Optional ``subfolder`` (relative, at most two levels, created under output/) and ``name``
    (the file's base name) serve the scene-state export, which writes one PNG per state.
    """
    if not isinstance(payload, dict):
        raise ValueError("[VNCCS UniCanvas] save_output expects a JSON object.")
    subfolder = _sanitize_output_subfolder(payload.get("subfolder"))
    name = _sanitize_output_name(payload.get("name"))
    layer_id = str(payload.get("layer_id") or "").strip() or None
    data_url = payload.get("image")
    if data_url:
        image = _decode_data_url(str(data_url), "RGBA")
    else:
        state = payload.get("state")
        if state is None and payload.get("state_id"):
            state = _read_unicanvas_state_cache(str(payload.get("state_id")))
        if not isinstance(state, dict):
            raise ValueError("[VNCCS UniCanvas] save_output needs an image or a canvas state.")
        if layer_id:
            image = _unicanvas_state_layer_image(state, layer_id)
        else:
            image = _render_unicanvas_state_to_rgba(json.dumps(state))
    if layer_id:
        image = image.convert("RGBA")
    path = _unicanvas_save_output_image(image, subfolder, name)
    return {"ok": True, "path": path, "width": image.width, "height": image.height}
