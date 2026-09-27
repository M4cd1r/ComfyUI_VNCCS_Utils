"""Timeline animation export (Plan 06.2, issue #18).

The widget renders every frame offscreen and streams them here in ordered batches:

- ``POST /vnccs/unicanvas/animation/begin`` opens a job (format, fps, size, frame count, output
  subfolder and name) with a directory under ComfyUI's temp dir,
- ``.../frames`` appends a batch of PNG data URLs starting at ``start`` (batches must arrive in
  order, so the job always holds frames 0..received-1),
- ``.../end`` encodes the job into ``output/<subfolder>/`` and deletes the job directory,
- ``.../cancel`` deletes the job (also while it is encoding),
- ``GET .../status/{job_id}`` reports the encoding progress for the dialog's second phase.

WebM (VP9, alpha kept as yuva420p) and MP4 (H.264, yuv420p over black) go through PyAV; GIF
through Pillow (a palette per frame, optimize on, over black); a PNG sequence is copied into a new
folder ``<name>`` (alpha kept). The subfolder uses the same sanitizing as ``save_output``.
"""

from __future__ import annotations

import base64
import binascii
import io
import os
import re
import shutil
import threading
import time
import uuid
from fractions import Fraction
from typing import Any, Callable, NamedTuple

from PIL import Image

from .constants import _MAX_PIXELS, _MAX_UPLOAD_BYTES
from .paths import _unicanvas_runtime_temp_root
from .route_utils import RouteError, json_route, read_json_object
from .save_output import _sanitize_name_part, _sanitize_output_subfolder


MAX_ANIMATION_FRAMES = 3600
MAX_ANIMATION_FPS = 60
MAX_ANIMATION_SIDE = 4096
# An abandoned job (tab closed mid-export) is removed by the next request that touches the job table.
JOB_TTL_SECONDS = 2 * 60 * 60
_JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_DEFAULT_NAME = "animation"
_DEFAULT_SUBFOLDER = "unicanvas_animation"

_JOBS: dict[str, dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()


class AnimationExportError(RouteError, ValueError):
    """A request error (reported as a 400, or a 404 by the status route)."""


class AnimationExportCancelled(RouteError, RuntimeError):
    """The job was cancelled while encoding (reported as a 409 with ``cancelled: true``)."""

    def __init__(self, message: str):
        super().__init__(message, 409, cancelled=True)


def _jobs_root() -> str:
    root = os.path.join(_unicanvas_runtime_temp_root(), "vnccs_unicanvas_animation")
    os.makedirs(root, exist_ok=True)
    return root


def _int_field(payload: dict[str, Any], name: str, low: int, high: int) -> int:
    try:
        value = int(payload.get(name))
    except (TypeError, ValueError):
        raise AnimationExportError(f"[VNCCS UniCanvas] animation {name} must be an integer.") from None
    if value < low or value > high:
        raise AnimationExportError(f"[VNCCS UniCanvas] animation {name} must be between {low} and {high}.")
    return value


def _job(job_id: Any) -> dict[str, Any]:
    key = str(job_id or "")
    if not _JOB_ID_RE.match(key):
        raise AnimationExportError("[VNCCS UniCanvas] Unknown animation export job.")
    with _JOBS_LOCK:
        job = _JOBS.get(key)
    if job is None:
        raise AnimationExportError("[VNCCS UniCanvas] Unknown animation export job.")
    return job


def _drop_job(job_id: str) -> None:
    with _JOBS_LOCK:
        job = _JOBS.pop(job_id, None)
    if job is not None:
        shutil.rmtree(job["dir"], ignore_errors=True)


def _expire_jobs(now: float) -> None:
    with _JOBS_LOCK:
        stale = [job_id for job_id, job in _JOBS.items() if now - job["touched"] > JOB_TTL_SECONDS and not job["encoding"]]
    for job_id in stale:
        _drop_job(job_id)


def begin_animation_export(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise AnimationExportError("[VNCCS UniCanvas] animation export expects a JSON object.")
    fmt = str(payload.get("format") or "").lower()
    if fmt not in ANIMATION_FORMATS:
        raise AnimationExportError(f"[VNCCS UniCanvas] animation format must be one of {', '.join(ANIMATION_FORMATS)}.")
    fps = _int_field(payload, "fps", 1, MAX_ANIMATION_FPS)
    width = _int_field(payload, "width", 1, MAX_ANIMATION_SIDE)
    height = _int_field(payload, "height", 1, MAX_ANIMATION_SIDE)
    if width * height > _MAX_PIXELS:
        raise AnimationExportError("[VNCCS UniCanvas] animation frame size is too large.")
    frame_count = _int_field(payload, "frame_count", 1, MAX_ANIMATION_FRAMES)
    subfolder_raw = payload.get("subfolder")
    try:
        subfolder = _sanitize_output_subfolder(_DEFAULT_SUBFOLDER if subfolder_raw is None else subfolder_raw)
    except ValueError as exc:
        raise AnimationExportError(str(exc)) from None
    name = _sanitize_name_part(str(payload.get("name") or "")) or _DEFAULT_NAME
    now = time.time()
    _expire_jobs(now)
    job_id = uuid.uuid4().hex
    job_dir = os.path.join(_jobs_root(), job_id)
    os.makedirs(job_dir)
    job = {
        "id": job_id, "dir": job_dir, "format": fmt, "fps": fps, "width": width, "height": height,
        "frame_count": frame_count, "subfolder": subfolder, "name": name, "received": 0,
        "encoded": 0, "encoding": False, "cancelled": False, "touched": now,
    }
    with _JOBS_LOCK:
        _JOBS[job_id] = job
    return {"ok": True, "job_id": job_id, "frame_count": frame_count}


def _decode_frame(data_url: Any, width: int, height: int) -> Image.Image:
    if not isinstance(data_url, str) or not data_url.startswith("data:image/png;base64,"):
        raise AnimationExportError("[VNCCS UniCanvas] animation frames must be PNG data URLs.")
    try:
        raw = base64.b64decode(data_url.split(",", 1)[1], validate=True)
    except (binascii.Error, ValueError):
        raise AnimationExportError("[VNCCS UniCanvas] animation frame is not valid base64.") from None
    if len(raw) > _MAX_UPLOAD_BYTES:
        raise AnimationExportError("[VNCCS UniCanvas] animation frame is too large.")
    try:
        image = Image.open(io.BytesIO(raw))
        if image.format != "PNG":
            raise AnimationExportError("[VNCCS UniCanvas] animation frames must be PNG images.")
        if image.size != (width, height):
            raise AnimationExportError(f"[VNCCS UniCanvas] animation frame is {image.width}x{image.height}, expected {width}x{height}.")
        return image.convert("RGBA")
    except AnimationExportError:
        raise
    except Exception as exc:
        raise AnimationExportError(f"[VNCCS UniCanvas] animation frame could not be read: {exc}") from None


def _frame_path(job: dict[str, Any], index: int) -> str:
    return os.path.join(job["dir"], f"frame_{index:05d}.png")


def add_animation_frames(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise AnimationExportError("[VNCCS UniCanvas] animation export expects a JSON object.")
    _expire_jobs(time.time())
    job = _job(payload.get("job_id"))
    frames = payload.get("frames")
    if not isinstance(frames, list) or not frames:
        raise AnimationExportError("[VNCCS UniCanvas] animation frames must be a non-empty list.")
    try:
        start = int(payload.get("start"))
    except (TypeError, ValueError):
        raise AnimationExportError("[VNCCS UniCanvas] animation frames need a start index.") from None
    with _JOBS_LOCK:
        if job["encoding"]:
            raise AnimationExportError("[VNCCS UniCanvas] animation export is already encoding.")
        if start != job["received"]:
            raise AnimationExportError(f"[VNCCS UniCanvas] animation frames out of order: expected frame {job['received']}, got {start}.")
        if start + len(frames) > job["frame_count"]:
            raise AnimationExportError("[VNCCS UniCanvas] more animation frames than announced.")
        # Reserve the range so a concurrent duplicate batch cannot interleave.
        job["received"] = start + len(frames)
        job["touched"] = time.time()
    try:
        for offset, data_url in enumerate(frames):
            _decode_frame(data_url, job["width"], job["height"]).save(_frame_path(job, start + offset), format="PNG")
    except BaseException:
        with _JOBS_LOCK:
            job["received"] = start
        raise
    return {"ok": True, "received": job["received"], "frame_count": job["frame_count"]}


def _reserve_output_file(folder: str, name: str, extension: str) -> str:
    suffix = 1
    while True:
        candidate = os.path.join(folder, f"{name}.{extension}" if suffix == 1 else f"{name}-{suffix}.{extension}")
        try:
            os.close(os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            return candidate
        except FileExistsError:
            suffix += 1


def _reserve_output_folder(parent: str, name: str) -> str:
    suffix = 1
    while True:
        candidate = os.path.join(parent, name if suffix == 1 else f"{name}-{suffix}")
        try:
            os.makedirs(candidate)
            return candidate
        except FileExistsError:
            suffix += 1


def _output_folder(subfolder: str) -> str:
    import folder_paths

    root = os.path.realpath(str(folder_paths.get_output_directory() or "output"))
    folder = os.path.realpath(os.path.join(root, subfolder)) if subfolder else root
    if os.path.commonpath([root, folder]) != root:
        raise AnimationExportError("[VNCCS UniCanvas] animation subfolder must stay inside output/.")
    os.makedirs(folder, exist_ok=True)
    return folder


def _frames(job: dict[str, Any]):
    for index in range(job["frame_count"]):
        if job["cancelled"]:
            raise AnimationExportCancelled("[VNCCS UniCanvas] animation export cancelled.")
        with Image.open(_frame_path(job, index)) as image:
            yield index, image.convert("RGBA")
        job["encoded"] = index + 1


def _over_black(image: Image.Image) -> Image.Image:
    base = Image.new("RGBA", image.size, (0, 0, 0, 255))
    base.alpha_composite(image)
    return base.convert("RGB")


def _even(image: Image.Image) -> Image.Image:
    """H.264 4:2:0 needs even dimensions: pad the last row / column with black."""
    width, height = image.size
    if width % 2 == 0 and height % 2 == 0:
        return image
    padded = Image.new(image.mode, (width + width % 2, height + height % 2))
    padded.paste(image, (0, 0))
    return padded


def _encode_video(job: dict[str, Any], path: str) -> None:
    import av

    webm = job["format"] == "webm"
    with av.open(path, mode="w", format="webm" if webm else "mp4") as container:
        stream = container.add_stream("libvpx-vp9" if webm else "libx264", rate=Fraction(job["fps"], 1))
        width, height = job["width"], job["height"]
        if not webm:
            width += width % 2
            height += height % 2
        stream.width = width
        stream.height = height
        stream.pix_fmt = "yuva420p" if webm else "yuv420p"
        if webm:
            stream.options = {"crf": "30", "b": "0", "row-mt": "1"}
        else:
            stream.options = {"crf": "18", "preset": "medium"}
        for _, image in _frames(job):
            if webm:
                frame = av.VideoFrame.from_image(image)
            else:
                frame = av.VideoFrame.from_image(_even(_over_black(image)))
            for packet in stream.encode(frame.reformat(format=stream.pix_fmt)):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def _encode_gif(job: dict[str, Any], path: str) -> None:
    frames = [_over_black(image).quantize(colors=256, method=Image.Quantize.MEDIANCUT) for _, image in _frames(job)]
    duration = max(10, round(1000 / job["fps"]))
    frames[0].save(path, format="GIF", save_all=True, append_images=frames[1:], duration=duration, loop=0, optimize=True, disposal=1)


def _write_png_sequence(job: dict[str, Any], folder: str) -> list[str]:
    paths = []
    for index, _ in _frames(job):
        target = os.path.join(folder, f"{job['name']}_{index:05d}.png")
        shutil.copyfile(_frame_path(job, index), target)
        paths.append(target)
    return paths


class _Encoder(NamedTuple):
    """How one format reserves its output path and writes the job there (returns the file count)."""

    reserve: Callable[[str, str, str], str]
    write: Callable[[dict[str, Any], str], int]


def _single_file(encode: Callable[[dict[str, Any], str], None]) -> Callable[[dict[str, Any], str], int]:
    def write(job: dict[str, Any], output: str) -> int:
        encode(job, output)
        return 1
    return write


_ENCODERS: dict[str, _Encoder] = {
    "webm": _Encoder(_reserve_output_file, _single_file(_encode_video)),
    "mp4": _Encoder(_reserve_output_file, _single_file(_encode_video)),
    "gif": _Encoder(_reserve_output_file, _single_file(_encode_gif)),
    "png": _Encoder(lambda folder, name, _fmt: _reserve_output_folder(folder, name),
                    lambda job, output: len(_write_png_sequence(job, output))),
}
ANIMATION_FORMATS = tuple(_ENCODERS)


def end_animation_export(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise AnimationExportError("[VNCCS UniCanvas] animation export expects a JSON object.")
    job = _job(payload.get("job_id"))
    with _JOBS_LOCK:
        if job["encoding"]:
            raise AnimationExportError("[VNCCS UniCanvas] animation export is already encoding.")
        if job["received"] != job["frame_count"]:
            raise AnimationExportError(f"[VNCCS UniCanvas] animation export has {job['received']} of {job['frame_count']} frames.")
        job["encoding"] = True
        job["touched"] = time.time()
    output = None
    try:
        folder = _output_folder(job["subfolder"])
        fmt = job["format"]
        encoder = _ENCODERS[fmt]
        output = encoder.reserve(folder, job["name"], fmt)
        result = {"ok": True, "format": fmt, "path": output, "files": encoder.write(job, output)}
        result.update({"frames": job["frame_count"], "width": job["width"], "height": job["height"], "fps": job["fps"]})
        return result
    except BaseException:
        # A failed or cancelled encode leaves nothing half-written in output/.
        if output and os.path.isdir(output):
            shutil.rmtree(output, ignore_errors=True)
        elif output and os.path.exists(output):
            try:
                os.unlink(output)
            except OSError:
                pass
        raise
    finally:
        _drop_job(job["id"])


def cancel_animation_export(payload: dict[str, Any]) -> dict[str, Any]:
    job_id = str((payload or {}).get("job_id") or "") if isinstance(payload, dict) else ""
    if not _JOB_ID_RE.match(job_id):
        raise AnimationExportError("[VNCCS UniCanvas] Unknown animation export job.")
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            return {"ok": True, "cancelled": False}
        job["cancelled"] = True
        encoding = job["encoding"]
    # An encoding job stops at its next frame and cleans up in end_animation_export.
    if not encoding:
        _drop_job(job_id)
    return {"ok": True, "cancelled": True}


def animation_export_status(job_id: str) -> dict[str, Any]:
    _expire_jobs(time.time())
    job = _job(job_id)
    return {
        "ok": True, "received": job["received"], "encoded": job["encoded"], "frame_count": job["frame_count"],
        "encoding": job["encoding"], "cancelled": job["cancelled"],
    }


def animation_export_routes(web, content_length_ok) -> list[tuple[str, str, Any]]:
    """(method, path, handler) triples for ``routes.py`` under /vnccs/unicanvas/animation."""
    import asyncio

    base = "/vnccs/unicanvas/animation"

    def handler(worker, max_bytes: int):
        async def run(request):
            payload = await read_json_object(request, "[VNCCS UniCanvas] Animation export expects a JSON object.")
            return await asyncio.to_thread(worker, payload)
        return json_route(web, content_length_ok, max_bytes, run, subject="Animation export", failure="Animation export failed")

    async def status(request):
        try:
            return await asyncio.to_thread(animation_export_status, str(request.match_info.get("job_id") or ""))
        except AnimationExportError as exc:
            raise RouteError(str(exc), 404) from None

    small = 64 * 1024
    return [
        ("POST", f"{base}/begin", handler(begin_animation_export, small)),
        ("POST", f"{base}/frames", handler(add_animation_frames, _MAX_UPLOAD_BYTES + 1024 * 1024)),
        ("POST", f"{base}/end", handler(end_animation_export, small)),
        ("POST", f"{base}/cancel", handler(cancel_animation_export, small)),
        ("GET", f"{base}/status/{{job_id}}", json_route(web, content_length_ok, small, status,
                                                       subject="Animation export", failure="Animation export failed")),
    ]
