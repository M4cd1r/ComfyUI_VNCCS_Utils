"""Import stubs so nodes.* can be imported without a running ComfyUI server."""
import sys
import types
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent


def _stub(name: str) -> types.ModuleType:
    module = types.ModuleType(name)
    sys.modules.setdefault(name, module)
    return sys.modules[name]


for _name in (
    "comfy",
    "comfy.sd",
    "comfy.utils",
    "comfy.model_management",
    "comfy.sample",
    "comfy.samplers",
    "comfy.controlnet",
    "comfy.conds",
    "comfy.supported_models_base",
    "comfy.patcher_extension",
    "folder_paths",
    "server",
    "nodes",
):
    _stub(_name)

sys.modules["comfy"].sd = sys.modules["comfy.sd"]
sys.modules["comfy"].utils = sys.modules["comfy.utils"]
sys.modules["comfy.sd"].load_lora_for_models = mock.MagicMock(
    side_effect=lambda model, clip, lora_sd, strength, clip_strength=1.0: (
        f"lora-model({strength})",
        f"lora-clip({clip_strength})",
    )
)
sys.modules["comfy.utils"].load_torch_file = mock.MagicMock(return_value={"lora": True})
sys.modules["folder_paths"].get_filename_list = mock.MagicMock(return_value=["demo.safetensors"])
sys.modules["folder_paths"].get_full_path = mock.MagicMock(
    side_effect=lambda kind, name: f"/models/{kind}/{name}"
)
sys.modules["folder_paths"].get_output_directory = mock.MagicMock(return_value="output")

# The bare "nodes" stub shadows ComfyUI's core nodes.py, but tests import this
# repository's own nodes/ package through it (e.g. `from nodes.vncss_config
# import ...`), so point the stub's package path at that directory.
sys.modules["nodes"].__path__ = [str(_REPO_ROOT / "nodes")]

# pytest's Package.setup() imports the repository-root __init__.py (the full
# ComfyUI extension entry point, which needs cv2/aiohttp/huggingface_hub and a
# live server) before every test. Pre-register an empty package shell under the
# name pytest derives for it, so unit tests only load the modules they exercise.
_root_package = types.ModuleType(_REPO_ROOT.name.replace(".", "_"))
_root_package.__path__ = [str(_REPO_ROOT)]
sys.modules.setdefault(_root_package.__name__, _root_package)

# pytest 9's Package.setup() can also resolve the repository-root package to the
# literal name "__init__" (its file stem) when the checkout directory name is not
# a valid identifier, e.g. worktrees named "...-p5". Pre-register that alias on
# the same empty shell so the full ComfyUI extension entry point never executes.
sys.modules.setdefault("__init__", _root_package)
