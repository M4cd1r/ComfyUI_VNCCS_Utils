"""ControlNet weights for model families: resolve, lazily download and load a pinned model patch.

A family declares its ControlNet as data (``capabilities.ControlNetSupport`` with pinned
``ControlNetWeights``) and applies it in its ``apply_control`` hook; this module is the shared
part: find the file in ComfyUI's folder (``model_patches`` by default), download the pinned file
through ``huggingface_hub`` (``token=False``) on first use, and load it with ``ModelPatchLoader``.
"""

from __future__ import annotations

import contextlib
import os
import shutil
from typing import TYPE_CHECKING, Any

from .debug import _uc_log
from .loras import _load_model_patch
from .paths import _get_full_path_agnostic, _safe_get_folder_paths


if TYPE_CHECKING:
    from .models.capabilities import ControlNetWeights


def control_net_weights_name(weights: ControlNetWeights, settings: dict[str, Any] | None) -> str:
    """The file the draw uses: the family setting (a user-installed file) or the pinned file."""
    if weights.setting:
        name = str((settings or {}).get(weights.setting) or "").strip()
        if name:
            return name
    return weights.local_name


def ensure_control_net_weights(weights: ControlNetWeights, requested: str | None = None, draw_id: str = "unknown") -> str:
    """Return the name to load from ``weights.folder``, downloading the pinned file when missing.

    A requested name that is not the pinned file is returned unchanged (the user's own file).
    """
    import folder_paths

    pinned = weights.local_name
    requested = str(requested or pinned).replace("\\", "/").strip()
    basename = os.path.basename(requested) or pinned
    if basename != pinned:
        return requested
    if _get_full_path_agnostic(folder_paths, weights.folder, requested, require_exists=True):
        return requested
    if _get_full_path_agnostic(folder_paths, weights.folder, basename, require_exists=True):
        return basename

    folders = _safe_get_folder_paths(folder_paths, weights.folder)
    if folders:
        target_dir = folders[0]
    else:
        models_dir = os.path.abspath(getattr(folder_paths, "models_dir", os.path.join(os.getcwd(), "models")))
        target_dir = os.path.join(models_dir, weights.folder)
    os.makedirs(target_dir, exist_ok=True)
    target_path = os.path.join(target_dir, basename)
    if os.path.isfile(target_path):
        return basename

    _uc_log(draw_id, "ControlNet weights download started", {**weights.describe(), "target": target_path})
    try:
        from huggingface_hub import hf_hub_download

        cached_path = hf_hub_download(
            repo_id=weights.hf_repo,
            filename=weights.hf_path,
            revision=weights.revision or None,
            repo_type="model",
            local_files_only=False,
            token=False,
        )
        tmp_path = target_path + ".tmp"
        shutil.copy2(cached_path, tmp_path)
        os.replace(tmp_path, target_path)
    except Exception as exc:
        with contextlib.suppress(Exception):
            os.remove(target_path + ".tmp")
        raise RuntimeError(f"Failed to download ControlNet weights {weights.hf_path} from {weights.hf_repo}: {exc}") from exc
    _uc_log(draw_id, "ControlNet weights downloaded", {"path": target_path})
    return basename


def load_control_net_patch(weights: ControlNetWeights, settings: dict[str, Any] | None, draw_id: str = "unknown") -> Any:
    """Resolve (and download) the family's ControlNet file, then load it as a ComfyUI model patch."""
    name = ensure_control_net_weights(weights, control_net_weights_name(weights, settings), draw_id)
    patch = _load_model_patch(name)
    _uc_log(draw_id, "ControlNet patch loaded", {"name": name})
    return patch
