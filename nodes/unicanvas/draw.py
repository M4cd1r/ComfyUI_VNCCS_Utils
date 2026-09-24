"""The UniCanvas draw action: one entry point for every model family and task.

``_run_unicanvas_draw`` parses the payload into a :class:`DrawRequest`, lets the
model family validate it, and runs the family's draw pipeline (its own
``draw_pipeline_class`` or the default :class:`ImageDrawPipeline`). Nothing here
knows individual families; see ``models/base.py`` for the extension points.
"""

from __future__ import annotations

from typing import Any

from PIL import Image

from .draw_pipeline import ImageDrawPipeline, prepare_pose_edit_images
from .draw_request import DrawRequest
from .models.base import UniCanvasModelModule
from .models.registry import UNICANVAS_MODEL_MODULES, _get_unicanvas_model_module


def _pose_edit_family_labels() -> list[str]:
    families = {module.key: module for module in UNICANVAS_MODEL_MODULES.values()}.values()
    return [module.label for module in families if module.capabilities.supports_pose_edit]


def _prepare_pose_edit_images(payload: dict[str, Any], generation_mode: str, size: tuple[int, int]) -> list[Image.Image] | None:
    """Validate the explicit Pose Studio contract for a family named by its generation mode."""
    if payload.get("pose_edit") is None:
        return None
    try:
        module: UniCanvasModelModule | None = _get_unicanvas_model_module(generation_mode)
    except ValueError:
        module = None
    return prepare_pose_edit_images(module, payload, size, _pose_edit_family_labels())


def _create_draw_pipeline(request: DrawRequest) -> ImageDrawPipeline:
    pipeline_class = request.module.draw_pipeline_class or ImageDrawPipeline
    return pipeline_class(request.module, request, supported_pose_labels=_pose_edit_family_labels())


def _run_unicanvas_draw(payload: dict[str, Any]) -> dict[str, Any]:
    request = DrawRequest.from_payload(payload)
    request.module.validate_request(request)
    return _create_draw_pipeline(request).run()
