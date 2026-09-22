# VNCSS_CONFIG + MiniMax H3 Region Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpower-subagent-driven-development (recommended) or superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `VNCSS_CONFIG` node (external model/clip/vae plumbing, LoRA stack, `Edit model` switch with a 4-slot reference dataset) and a MiniMax H3 region-editing module to UniCanvas, including the queued graph-generation path.

**Architecture:** `VNCCS_Config` packages externally connected `MODEL`/`CLIP`/`VAE` tensors (plus LoRA patches and reference images) into a `VNCSS_CONFIG` object. `VNCCS_UniCanvas` gains an optional `config` input; when connected, GENERATE queues a normal ComfyUI prompt and `export_state` runs the draw pipeline with the external objects, returning the result both as the node's `IMAGE` output and through a new result route for the widget. MiniMax H3 region editing reuses the built-in `MiniMaxH3ReferenceToVideo` node (REF2VA): the canvas working area becomes reference picture 1, `VNCSS_CONFIG` references become pictures 2–5.

**Tech Stack:** Python 3 (ComfyUI custom node, `comfy.sd`, built-in `comfy_extras.nodes_minimax_h3` nodes), vanilla JS DOM widgets, pytest with `sys.modules` stubs for ComfyUI modules.

**Spec:** `docs/superpowers/specs/2026-09-22-vnccs-unicanvas-design.md` (sections 2–4, 11–13). Plans 2–5 cover fullscreen+standalone, pose layers, input tools + layer utilities, and QI2.1 + Spectrum.

## Global Constraints

- Everything that leaves the session is English: commit messages, code comments, test names, UI strings, error text.
- Repository rule (`AGENTS.md`): every interactive control updates visible state continuously during interaction (`input`/`pointermove`); `change`/`pointerup` only commit history/persistence.
- Never modify `AHEKOT/ComfyUI_VNCCS`; all work happens in `M4cd1r/ComfyUI_VNCCS_Utils`, branch `unicanvas-next`.
- Error messages use the `[VNCCS UniCanvas] …` / `[VNCCS Config] …` prefix format.
- `pytest` runs in the ComfyUI Python environment (torch must import; verify with `python -c "import torch"` before Task 1).
- UI changes ship with before/after screenshots (same crop/scale, labels exactly `Before`/`After`) on an `evidence/<topic>` branch; final manual testing is done by the repository owner.

## File Structure

- `nodes/vncss_config.py` (new) — `VNCCS_Config` node: input validation, LoRA-stack application, `VNCSS_CONFIG` packaging. One responsibility: turn graph inputs into a validated config object.
- `nodes/unicanvas.py` (modify) — `ExternalUniCanvasLoader` (pass-through loader for external tensors), `MiniMaxH3UniCanvasModule` (H3 family adapter), `_call_comfy_node` bridge helper, `config` input + graph draw path on `VNCCS_UniCanvas`, routes `/vnccs/unicanvas/loras` and `/vnccs/unicanvas/result/{draw_id}`.
- `web/vnccs_config.js` (new) — DOM widget for `VNCCS_Config`: LoRA stack UI, `Edit model` switch, reference-socket sync.
- `web/vnccs_unicanvas.js` (modify) — `MiniMax H3` family tab + settings, `VNCSS_CONFIG` engine mode, queued GENERATE path with progress/result polling.
- `__init__.py` (modify) — register `VNCCS_Config` in `NODE_CLASS_MAPPINGS` / `NODE_DISPLAY_NAME_MAPPINGS`.
- `tests/conftest.py` (new) — ComfyUI module stubs so `nodes.*` imports work outside a running server.
- `tests/test_vncss_config.py`, `tests/test_unicanvas_h3.py` (new) — pytest coverage for Tasks 1–5.

---

### Task 1: `VNCCS_Config` node skeleton with validation

**Files:**
- Create: `nodes/vncss_config.py`
- Modify: `__init__.py:5-39`
- Test: `tests/conftest.py`, `tests/test_vncss_config.py`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `VNCCS_Config` node class with `RETURN_TYPES = ("VNCSS_CONFIG",)`, `FUNCTION = "execute"`, `execute(self, node_state="{}", model=None, clip=None, vae=None, audio_vae=None, reference_image_1=None, reference_image_2=None, reference_image_3=None, reference_image_4=None) -> tuple[dict]`. The returned dict: `{"model": Any, "clip": Any, "vae": Any, "audio_vae": Any, "references": dict[str, torch.Tensor], "edit_model": bool, "lora_stack": list[dict]}` where `references` keys are `reference_image_1..4` (only connected ones). Later tasks rely on exactly these keys.

- [ ] **Step 1: Create the test stubs (`tests/conftest.py`)**

```python
"""Import stubs so nodes.* can be imported without a running ComfyUI server."""
import sys
import types
from unittest import mock


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
```

- [ ] **Step 2: Write the failing tests (`tests/test_vncss_config.py`)**

```python
import json
import pytest

from nodes.vncss_config import VNCCS_Config


def _state(payload: dict) -> str:
    return json.dumps(payload)


def test_packages_connected_inputs():
    model, clip, vae = object(), object(), object()
    ref = object()
    result = VNCCS_Config().execute(
        _state({"loras": [], "edit_model": True}),
        model=model,
        clip=clip,
        vae=vae,
        reference_image_1=ref,
    )[0]
    assert result["model"] is model
    assert result["clip"] is clip
    assert result["vae"] is vae
    assert result["edit_model"] is True
    assert result["references"] == {"reference_image_1": ref}


def test_missing_model_raises_config_error():
    with pytest.raises(RuntimeError, match=r"\[VNCCS Config\] Model input is not connected\."):
        VNCCS_Config().execute(_state({"loras": [], "edit_model": False}), clip=object(), vae=object())


def test_missing_clip_and_vae_raise():
    with pytest.raises(RuntimeError, match=r"\[VNCCS Config\] CLIP input is not connected\."):
        VNCCS_Config().execute(_state({"loras": []}), model=object(), vae=object())
    with pytest.raises(RuntimeError, match=r"\[VNCCS Config\] VAE input is not connected\."):
        VNCCS_Config().execute(_state({"loras": []}), model=object(), clip=object())


def test_edit_model_requires_reference_1():
    with pytest.raises(RuntimeError, match=r"\[VNCCS Config\] Edit model requires reference_image_1\."):
        VNCCS_Config().execute(
            _state({"loras": [], "edit_model": True}),
            model=object(), clip=object(), vae=object(),
        )


def test_invalid_node_state_falls_back_to_defaults():
    result = VNCCS_Config().execute("not-json", model=object(), clip=object(), vae=object())[0]
    assert result["edit_model"] is False
    assert result["lora_stack"] == []
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `python -m pytest tests/test_vncss_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'nodes.vncss_config'`

- [ ] **Step 4: Implement `nodes/vncss_config.py`**

```python
"""VNCSS_CONFIG node: external model plumbing for VNCCS UniCanvas."""
from __future__ import annotations

import json
from typing import Any

REFERENCE_INPUTS = ("reference_image_1", "reference_image_2", "reference_image_3", "reference_image_4")


def _load_state(node_state: str) -> dict[str, Any]:
    try:
        state = json.loads(node_state) if isinstance(node_state, str) and node_state.strip() else (node_state or {})
    except Exception:
        state = {}
    return state if isinstance(state, dict) else {}


class VNCCS_Config:
    """Bundles external MODEL/CLIP/VAE, a LoRA stack and reference images."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "node_state": ("STRING", {"multiline": False, "default": "{}"}),
            },
            "optional": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "audio_vae": ("VAE",),
                "reference_image_1": ("IMAGE",),
                "reference_image_2": ("IMAGE",),
                "reference_image_3": ("IMAGE",),
                "reference_image_4": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("VNCSS_CONFIG",)
    RETURN_NAMES = ("config",)
    FUNCTION = "execute"
    CATEGORY = "VNCCS/config"

    @classmethod
    def VALIDATE_INPUTS(cls, input_types):
        return True

    def execute(
        self,
        node_state: str = "{}",
        model: Any = None,
        clip: Any = None,
        vae: Any = None,
        audio_vae: Any = None,
        reference_image_1: Any = None,
        reference_image_2: Any = None,
        reference_image_3: Any = None,
        reference_image_4: Any = None,
    ) -> tuple[dict[str, Any]]:
        state = _load_state(node_state)
        edit_model = bool(state.get("edit_model", False))
        lora_stack = state.get("loras") or []
        if not isinstance(lora_stack, list):
            lora_stack = []

        if model is None:
            raise RuntimeError("[VNCCS Config] Model input is not connected.")
        if clip is None:
            raise RuntimeError("[VNCCS Config] CLIP input is not connected.")
        if vae is None:
            raise RuntimeError("[VNCCS Config] VAE input is not connected.")

        references = {
            name: value
            for name, value in zip(
                REFERENCE_INPUTS,
                (reference_image_1, reference_image_2, reference_image_3, reference_image_4),
            )
            if value is not None
        }
        if edit_model and "reference_image_1" not in references:
            raise RuntimeError("[VNCCS Config] Edit model requires reference_image_1.")

        config = {
            "model": model,
            "clip": clip,
            "vae": vae,
            "audio_vae": audio_vae,
            "references": references,
            "edit_model": edit_model,
            "lora_stack": lora_stack,
        }
        return (config,)
```

- [ ] **Step 5: Register the node in `__init__.py`**

Add `from .nodes.vncss_config import VNCCS_Config` next to the existing `nodes.unicanvas` import (line 5) and extend the mappings:

```python
NODE_CLASS_MAPPINGS = {
    "VNCCS_UniCanvas": VNCCS_UniCanvas,
    "VNCCS_Config": VNCCS_Config,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VNCCS_UniCanvas": "VNCCS UniCanvas",
    "VNCCS_Config": "VNCSS_CONFIG",
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `python -m pytest tests/test_vncss_config.py -v`
Expected: 5 passed

- [ ] **Step 7: Commit**

```bash
git add nodes/vncss_config.py __init__.py tests/conftest.py tests/test_vncss_config.py
git commit -m "feat: add VNCSS_CONFIG node with external model plumbing

Adds the VNCCS_Config node that bundles externally connected MODEL/CLIP/VAE
sockets, an optional audio VAE, and a four-slot reference-image dataset into a
validated VNCSS_CONFIG object consumed by VNCCS_UniCanvas."
```

---

### Task 2: LoRA stack application + `/vnccs/unicanvas/loras` route

**Files:**
- Modify: `nodes/vncss_config.py`
- Modify: `nodes/unicanvas.py` (`register_unicanvas_routes`, around line 4183)
- Test: `tests/test_vncss_config.py`

**Interfaces:**
- Consumes: `VNCCS_Config.execute` from Task 1.
- Produces: `apply_lora_stack(model, clip, lora_stack, config=None) -> tuple[model, clip]` in `nodes/vncss_config.py`; `execute` now returns the LoRA-patched `model`/`clip` and `config["lora_stack"]` normalized to `[{"name": str, "strength": float, "enabled": bool}]`. Route `GET /vnccs/unicanvas/loras` returns `{"loras": [str, ...]}`.

- [ ] **Step 1: Write the failing tests (append to `tests/test_vncss_config.py`)**

```python
from nodes.vncss_config import apply_lora_stack, normalize_lora_stack


def test_normalize_lora_stack_filters_and_defaults():
    stack = normalize_lora_stack([
        {"name": "a.safetensors", "strength": 0.5, "enabled": True},
        {"name": "", "strength": 1.0},
        {"strength": 2.0},
        "junk",
        {"name": "b.safetensors", "strength": "0.8", "enabled": False},
    ])
    assert stack == [
        {"name": "a.safetensors", "strength": 0.5, "enabled": True},
        {"name": "b.safetensors", "strength": 0.8, "enabled": False},
    ]


def test_apply_lora_stack_applies_enabled_in_order(monkeypatch):
    calls = []
    import nodes.vncss_config as vc

    def fake_cached(model, clip, name, strength, clip_strength=None):
        calls.append((name, strength))
        return f"m-{name}", f"c-{name}"

    monkeypatch.setattr(vc, "_apply_lora_cached", fake_cached, raising=False)
    model, clip = apply_lora_stack(
        "m0", "c0",
        [
            {"name": "one", "strength": 0.3, "enabled": True},
            {"name": "off", "strength": 1.0, "enabled": False},
            {"name": "two", "strength": 0.7, "enabled": True},
        ],
    )
    assert calls == [("one", 0.3), ("two", 0.7)]
    assert model == "m-two" and clip == "c-two"


def test_execute_returns_patched_model(monkeypatch):
    import nodes.vncss_config as vc
    monkeypatch.setattr(vc, "_apply_lora_cached",
                        lambda m, c, n, s, cs=None: (f"m-{n}", f"c-{n}"), raising=False)
    result = VNCCS_Config().execute(
        _state({"loras": [{"name": "x", "strength": 0.5, "enabled": True}], "edit_model": False}),
        model="m0", clip="c0", vae="v0",
    )[0]
    assert result["model"] == "m-x"
    assert result["clip"] == "c-x"
    assert result["lora_stack"] == [{"name": "x", "strength": 0.5, "enabled": True}]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_vncss_config.py -v`
Expected: FAIL with `ImportError: cannot import name 'apply_lora_stack'`

- [ ] **Step 3: Implement in `nodes/vncss_config.py`**

Append to the module (and change `execute` to call it — replace the `config = {…}` block's `model`/`clip` values):

```python
def _apply_lora_cached(model, clip, lora_name, strength, clip_strength=None):
    """Patch a LoRA onto model/clip. Mirrors UniCanvasModule.apply_loras caching."""
    import comfy.sd
    import comfy.utils

    lora_sd = comfy.utils.load_torch_file(lora_name, safe_load=True)
    return comfy.sd.load_lora_for_models(
        model, clip, lora_sd, float(strength),
        float(strength) if clip_strength is None else float(clip_strength),
    )


def normalize_lora_stack(raw: Any) -> list[dict[str, Any]]:
    stack: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        try:
            strength = float(item.get("strength", 1.0))
        except (TypeError, ValueError):
            strength = 1.0
        stack.append({"name": name, "strength": strength, "enabled": bool(item.get("enabled", True))})
    return stack


def apply_lora_stack(model: Any, clip: Any, lora_stack: list[dict[str, Any]], config: Any = None):
    for item in lora_stack:
        if not item.get("enabled") or abs(float(item.get("strength", 1.0))) <= 1e-6:
            continue
        model, clip = _apply_lora_cached(model, clip, item["name"], item["strength"])
    return model, clip
```

In `execute`, replace `lora_stack = state.get("loras") or []` handling with:

```python
        lora_stack = normalize_lora_stack(state.get("loras"))
```

and before building `config`:

```python
        model, clip = apply_lora_stack(model, clip, lora_stack)
```

- [ ] **Step 4: Add the LoRA list route to `register_unicanvas_routes` (after `/vnccs/unicanvas/checkpoints`, line 4188)**

```python
    @PromptServer.instance.routes.get("/vnccs/unicanvas/loras")
    async def vnccs_unicanvas_loras(_request):
        try:
            import folder_paths

            return web.json_response({"loras": sorted(folder_paths.get_filename_list("loras"))})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_vncss_config.py -v`
Expected: 8 passed

- [ ] **Step 6: Commit**

```bash
git add nodes/vncss_config.py nodes/unicanvas.py tests/test_vncss_config.py
git commit -m "feat: apply VNCSS_CONFIG LoRA stack and expose lora list route"
```

---

### Task 3: `_call_comfy_node` bridge, `ExternalUniCanvasLoader`, H3 module registration

**Files:**
- Modify: `nodes/unicanvas.py` (near `UniCanvasModelLoader`, line 1259; `_get_unicanvas_model_loader`, line 1506; `_get_unicanvas_model_module`, line 1497)
- Test: `tests/test_unicanvas_h3.py`

**Interfaces:**
- Consumes: `UniCanvasModelModule` base (line 332: `key`, `aliases`, `defaults`, `is_edit_model`, `apply_loras`, `encode_prompt`, `create_empty_latent`, `decode_samples`, `prepare_reference_conditioning`, `sample_latent`), `UniCanvasModelLoader` base (line 1259).
- Produces: `_call_comfy_node(class_name: str, **kwargs) -> tuple`; `ExternalUniCanvasLoader` with `forced_mode = "minimax_h3"` variant parameter (a generic external loader: `ExternalUniCanvasLoader(forced_mode)`); `MiniMaxH3UniCanvasModule` with `key = "minimax_h3"`, `aliases = ("minimaxh3", "minimax-h3", "h3")`, `defaults` dict (keys used later: `steps`, `sampler_name`, `scheduler`, `cfg`, `denoise`, `frame_count`, `ref_image_size`). `_get_unicanvas_model_module("minimax_h3")` returns it.

- [ ] **Step 1: Write the failing tests (`tests/test_unicanvas_h3.py`)**

```python
import pytest

from nodes.unicanvas import (
    MiniMaxH3UniCanvasModule,
    _call_comfy_node,
    _get_unicanvas_model_loader,
    _get_unicanvas_model_module,
)


def test_module_registered_with_aliases():
    module = _get_unicanvas_model_module("minimax_h3")
    assert isinstance(module, MiniMaxH3UniCanvasModule)
    assert _get_unicanvas_model_module("h3") is module
    assert _get_unicanvas_model_module("MiniMaxH3") is module
    assert module.key == "minimax_h3"
    assert module.is_edit_model is True


def test_defaults_follow_h3_recipe():
    module = _get_unicanvas_model_module("minimax_h3")
    assert module.defaults["steps"] == 20
    assert module.defaults["sampler_name"] == "res_multistep"
    assert module.defaults["scheduler"] == "simple"
    assert module.defaults["cfg"] == 1.0
    assert module.defaults["frame_count"] == 5


def test_external_loader_passthrough():
    loader = _get_unicanvas_model_loader("external")
    external = {"model": "M", "clip": "C", "vae": "V"}
    model, clip, vae = loader.load({"_external": external}, draw_id="t")
    assert (model, clip, vae) == ("M", "C", "V")


def test_external_loader_requires_config():
    loader = _get_unicanvas_model_loader("external")
    with pytest.raises(RuntimeError, match=r"\[VNCCS UniCanvas\] External model block is missing\."):
        loader.load({}, draw_id="t")


def test_call_comfy_node_uses_registry(monkeypatch):
    import nodes as comfy_nodes

    class Dummy:
        FUNCTION = "run"

        def run(self, value):
            return ("ok", value)

    monkeypatch.setattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {"DummyNode": Dummy}, raising=False)
    assert _call_comfy_node("DummyNode", value=3) == ("ok", 3)


def test_call_comfy_node_missing_raises():
    with pytest.raises(RuntimeError, match=r"Required node 'NopeNode' is not available"):
        _call_comfy_node("NopeNode")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_unicanvas_h3.py -v`
Expected: FAIL with `ImportError: cannot import name 'MiniMaxH3UniCanvasModule'`

- [ ] **Step 3: Implement in `nodes/unicanvas.py`**

Add `_call_comfy_node` (adapted from the VNCCS character-generator pattern) above `UniCanvasModelModule` (line 332):

```python
def _call_comfy_node(class_name: str, **kwargs):
    """Invoke a built-in/registered ComfyUI node class without a graph."""
    import inspect

    import nodes as comfy_nodes

    mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {}) or {}
    cls = mappings.get(class_name)
    if cls is None:
        raise RuntimeError(f"Required node '{class_name}' is not available")
    instance = cls()
    method_name = getattr(cls, "FUNCTION", None)
    method = getattr(instance, method_name, None) if method_name else None
    if method is None:
        for candidate in ("execute", "sample", "decode", "process"):
            method = getattr(instance, candidate, None)
            if method is not None:
                break
    if method is None:
        raise RuntimeError(f"Node '{class_name}' has no callable FUNCTION")
    signature = inspect.signature(method)
    accepts_kwargs = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in signature.parameters.values())
    accepted = kwargs if accepts_kwargs else {k: v for k, v in kwargs.items() if k in signature.parameters}
    return method(**accepted)
```

Add the H3 module next to the other family modules (after `QwenImageEditUniCanvasModule`, line 725):

```python
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
```

(`field` is already imported via `dataclass` usage in this module — if not, use `from dataclasses import dataclass, field` at the top.)

Add the external loader next to `GGUFUniCanvasLoader` (after line 1382):

```python
class ExternalUniCanvasLoader(UniCanvasModelLoader):
    """Pass-through loader for a VNCSS_CONFIG model block."""

    def __init__(self, forced_mode: str | None = None):
        self.forced_mode = forced_mode

    def cache_key(self, gen_settings):
        return (self.key, "external")

    def load(self, gen_settings, draw_id: str = "unknown"):
        external = (gen_settings or {}).get("_external") or {}
        model = external.get("model")
        clip = external.get("clip")
        vae = external.get("vae")
        if model is None or clip is None or vae is None:
            raise RuntimeError("[VNCCS UniCanvas] External model block is missing.")
        return model, clip, vae
```

Give `ExternalUniCanvasLoader` the class attribute `key = "external"` (same style as the existing loaders). Before writing the loader body, read `CheckpointUniCanvasLoader`/`DiffusionModelUniCanvasLoader`/`GGUFUniCanvasLoader` (lines 1272–1420) and match their `load()` signature and return shape exactly; the test asserts the `(model, clip, vae)` triple those loaders return. Extend `_get_unicanvas_model_loader` (line 1506) dispatch:

```python
    key = str(loader_type or "checkpoint").lower()
    if key == "external":
        return ExternalUniCanvasLoader()
```

and register the module in `_get_unicanvas_model_module` (line 1497) with an explicit dispatch at the top of the function body:

```python
    key = str(generation_mode or "illustrious").lower()
    if key in {"minimax_h3", "minimaxh3", "minimax-h3", "h3"}:
        return MiniMaxH3UniCanvasModule()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_unicanvas_h3.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add nodes/unicanvas.py tests/test_unicanvas_h3.py
git commit -m "feat: add MiniMax H3 module skeleton and external model loader"
```

---

### Task 4: H3 sampling path (REF2VA region edit)

**Files:**
- Modify: `nodes/unicanvas.py` (`MiniMaxH3UniCanvasModule`, Task 3)
- Test: `tests/test_unicanvas_h3.py`

**Interfaces:**
- Consumes: `_call_comfy_node`, `MiniMaxH3UniCanvasModule` from Task 3; `gen_settings["_h3_prompt"]`, `gen_settings["_h3_reference_image"]`, `gen_settings["_external"]["references"]` (keys `reference_image_1..4`).
- Produces: `MiniMaxH3UniCanvasModule.sample_latent(...) -> sampled latent` (same contract as `UniCanvasModelModule.sample_latent`, line 414) and `decode_samples(vae, samples, gen_settings) -> IMAGE tensor of the first frame`. Reference mapping contract: working-area tensor → `ref_image_1` (picture 1), `reference_image_N` → `ref_image_(N+1)`.

- [ ] **Step 1: Write the failing tests (append to `tests/test_unicanvas_h3.py`)**

```python
import torch


def test_reference_mapping_order(monkeypatch):
    module = _get_unicanvas_model_module("minimax_h3")
    captured = {}

    def fake_call(name, **kwargs):
        captured.setdefault(name, []).append(kwargs)
        if name == "MiniMaxH3ReferenceToVideo":
            return ("positive", "latent")
        if name == "BasicGuider":
            return ("guider",)
        if name == "RandomNoise":
            return ("noise",)
        if name == "KSamplerSelect":
            return ("sampler",)
        if name == "BasicScheduler":
            return ("sigmas",)
        if name == "SamplerCustomAdvanced":
            return ({"samples": torch.zeros(1, 4, 8, 8)}, {"samples": torch.zeros(1, 4, 8, 8)})
        raise AssertionError(name)

    monkeypatch.setattr("nodes.unicanvas._call_comfy_node", fake_call)
    gen_settings = {
        "_h3_prompt": "Keep the face from <Picture 2>.",
        "_h3_reference_image": torch.zeros(1, 64, 64, 3),
        "_external": {
            "references": {
                "reference_image_1": torch.ones(1, 32, 32, 3),
                "reference_image_2": torch.full((1, 32, 32, 3), 2.0),
            }
        },
    }
    module.sample_latent(
        model="M", positive=None, negative=None, latent=None, seed=7,
        steps=20, cfg=1.0, sampler_name="res_multistep", scheduler="simple",
        denoise=1.0, gen_settings=gen_settings, draw_id="t", width=64, height=64,
    )
    encode_kwargs = captured["MiniMaxH3ReferenceToVideo"][0]
    refs = encode_kwargs["ref_images"]
    assert list(refs) == ["ref_image_1", "ref_image_2", "ref_image_3"]
    assert torch.equal(refs["ref_image_1"], torch.zeros(1, 64, 64, 3))
    assert torch.equal(refs["ref_image_2"], torch.ones(1, 32, 32, 3))
    assert torch.equal(refs["ref_image_3"], torch.full((1, 32, 32, 3), 2.0))
    assert encode_kwargs["prompt"] == "Keep the face from <Picture 2>."
    assert encode_kwargs["length"] == 5
    assert captured["BasicGuider"][0]["conditioning"] == "positive"
    assert captured["SamplerCustomAdvanced"][0]["latent_image"] == "latent"


def test_decode_samples_takes_first_frame(monkeypatch):
    module = _get_unicanvas_model_module("minimax_h3")
    frames = torch.zeros(5, 32, 32, 3)
    monkeypatch.setattr(
        "nodes.unicanvas._call_comfy_node",
        lambda name, **kwargs: (frames,) if name == "VAEDecodeTiled" else (_ for _ in ()).throw(AssertionError(name)),
    )
    out = module.decode_samples("V", {"samples": torch.zeros(1, 4, 8, 8)}, {"_draw_id": "t"})
    assert out.shape[0] == 1


def test_sample_latent_requires_audio_vae():
    module = _get_unicanvas_model_module("minimax_h3")
    import pytest

    with pytest.raises(RuntimeError, match=r"\[VNCCS UniCanvas\] MiniMax H3 requires the audio VAE\."):
        module.sample_latent(
            model="M", positive=None, negative=None, latent=None, seed=1,
            steps=20, cfg=1.0, sampler_name="res_multistep", scheduler="simple",
            denoise=1.0,
            gen_settings={"_h3_prompt": "p", "_external": {}},
            draw_id="t", width=64, height=64,
        )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_unicanvas_h3.py -v`
Expected: 3 new FAILs (`sample_latent` falls through to the default sampler; `decode_samples` missing).

- [ ] **Step 3: Implement `sample_latent` + `decode_samples` on `MiniMaxH3UniCanvasModule`**

```python
    def _h3_reference_images(self, gen_settings: dict[str, Any]) -> dict[str, Any]:
        refs: dict[str, Any] = {}
        region = gen_settings.get("_h3_reference_image")
        if region is not None:
            refs["ref_image_1"] = region
        external_refs = (gen_settings.get("_external") or {}).get("references") or {}
        for index, name in enumerate(
            ("reference_image_1", "reference_image_2", "reference_image_3", "reference_image_4"), start=2
        ):
            value = external_refs.get(name)
            if value is not None:
                refs[f"ref_image_{index}"] = value
        return refs

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
        decoded = _call_comfy_node("VAEDecodeTiled", samples=samples, vae=vae)[0]
        if hasattr(decoded, "shape") and len(decoded.shape) == 4 and decoded.shape[0] > 1:
            return decoded[:1]  # H3 returns a frame packet; the still is the first frame
        return decoded
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_unicanvas_h3.py -v`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add nodes/unicanvas.py tests/test_unicanvas_h3.py
git commit -m "feat: implement MiniMax H3 REF2VA region editing sampling path"
```

---

### Task 5: `config` input + queued graph generation + result route

**Files:**
- Modify: `nodes/unicanvas.py` (`VNCCS_UniCanvas` line 1654, `_run_unicanvas_draw` line 3659 and its return at 4009, `register_unicanvas_routes` line 4176)
- Test: `tests/test_unicanvas_h3.py`

**Interfaces:**
- Consumes: `VNCSS_CONFIG` dict from Tasks 1–2 (`model`/`clip`/`vae`/`audio_vae`/`references`/`edit_model`/`lora_stack`), `_run_unicanvas_draw(payload) -> dict` with `"images"` data URLs (line 4009).
- Produces: `VNCCS_UniCanvas.execute/export_state(unicanvas_state, config=None, unique_id=None) -> (IMAGE,)`; `_run_unicanvas_draw` accepts `payload["external"]` (dict of raw tensors) and `payload["return_tensor"]` (adds `"tensor"` to the result); `_store_draw_result(draw_id, result)` + route `GET /vnccs/unicanvas/result/{draw_id}` returning `{"present": false}` or `{"present": true, "images": [...], "mask": data_url|null}`.

- [ ] **Step 1: Write the failing tests (append to `tests/test_unicanvas_h3.py`)**

```python
def test_graph_generate_runs_draw_and_returns_tensor(monkeypatch):
    from nodes import unicanvas as uc
    from nodes.vncss_config import VNCCS_Config

    captured = {}

    def fake_draw(payload):
        captured.update(payload)
        return {"images": ["data:image/png;base64,AAAA"], "tensor": torch.zeros(1, 8, 8, 3)}

    monkeypatch.setattr(uc, "_run_unicanvas_draw", fake_draw)
    config = VNCCS_Config().execute(
        '{"loras": [], "edit_model": False}', model="M", clip="C", vae="V",
    )[0]
    node = uc.VNCCS_UniCanvas()
    (image,) = node.export_state(
        '{"state_id": "s1", "layers": [], "settings": {"draw_id": "draw-1", "generation_mode": "minimax_h3"}}',
        config=config,
        unique_id="9",
    )
    assert captured["debug_id"] == "draw-1"
    assert captured["external"]["model"] == "M"
    assert captured["return_tensor"] is True
    assert image.shape == (1, 8, 8, 3)


def test_graph_generate_without_config_keeps_legacy_export(monkeypatch):
    from nodes import unicanvas as uc

    monkeypatch.setattr(
        uc, "_render_unicanvas_state_to_image_tensor", lambda state: torch.zeros(1, 4, 4, 3)
    )
    (image,) = uc.VNCCS_UniCanvas().export_state('{"layers": []}', config=None, unique_id="9")
    assert image.shape == (1, 4, 4, 3)


def test_result_store_roundtrip():
    from nodes.unicanvas import _store_draw_result, _get_draw_result

    _store_draw_result("draw-x", {"images": ["data:x"], "mask": None})
    assert _get_draw_result("draw-x") == {"present": True, "images": ["data:x"], "mask": None}
    assert _get_draw_result("missing") == {"present": False}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_unicanvas_h3.py -v`
Expected: 3 new FAILs (`export_state` takes no `config`; `_store_draw_result` missing).

- [ ] **Step 3: Implement in `nodes/unicanvas.py`**

Extend `VNCCS_UniCanvas` (line 1654):

```python
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "unicanvas_state": ("STRING", {"multiline": True, "default": "{}"}),
            },
            "optional": {
                "config": ("VNCSS_CONFIG",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, unicanvas_state: str = "{}", config=None, unique_id: str | None = None):
        return unicanvas_state

    def export_state(self, unicanvas_state: str = "{}", config=None, unique_id: str | None = None):
        if config is None:
            return (_render_unicanvas_state_to_image_tensor(unicanvas_state),)
        state = _load_unicanvas_state(unicanvas_state)
        settings = state.get("settings") if isinstance(state.get("settings"), dict) else {}
        draw_id = str(settings.get("draw_id") or f"uc-graph-{unique_id or 'node'}")
        result = _run_unicanvas_draw({
            "state": state,
            "gen_settings": settings,
            "debug_id": draw_id,
            "external": {
                "model": config.get("model"),
                "clip": config.get("clip"),
                "vae": config.get("vae"),
                "audio_vae": config.get("audio_vae"),
                "references": config.get("references") or {},
            },
            "return_tensor": True,
        })
        _store_draw_result(draw_id, {"images": result.get("images") or [], "mask": result.get("mask")})
        return (result["tensor"],)
```

Add the result store next to `_get_draw_progress` (line 1563):

```python
_DRAW_RESULTS: dict[str, dict[str, Any]] = {}


def _store_draw_result(draw_id: str, result: dict[str, Any]) -> None:
    _DRAW_RESULTS[str(draw_id)] = dict(result)


def _get_draw_result(draw_id: str) -> dict[str, Any]:
    result = _DRAW_RESULTS.get(str(draw_id))
    if not result:
        return {"present": False}
    return {"present": True, "images": result.get("images") or [], "mask": result.get("mask")}
```

In `_run_unicanvas_draw(payload)`:
1. Near the top (after `draw_id` is known), stash `gen_settings["_external"] = payload.get("external") or {}`.
2. Where the loader is chosen (the `_get_unicanvas_model_loader(...)` call site around lines 2466–2512), pass `"external"` as `loader_type` when `payload.get("external")` is present, and forward `gen_settings["_external"]`.
3. Just before the `return {… "images": saved_images …}` at line 4009 add:

```python
        if payload.get("return_tensor"):
            result_payload["tensor"] = decoded.detach().cpu()
```

(Name the returned dict `result_payload` — adjust the existing `return {…}` into `result_payload = {…}` + `return result_payload` if needed.)

Add the result route after `/vnccs/unicanvas/progress/{draw_id}` (line 4276):

```python
    @PromptServer.instance.routes.get("/vnccs/unicanvas/result/{draw_id}")
    async def vnccs_unicanvas_result(request):
        return web.json_response(_get_draw_result(str(request.match_info.get("draw_id") or "")))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/ -v`
Expected: all tests pass (12 + previous)

- [ ] **Step 5: Commit**

```bash
git add nodes/unicanvas.py tests/test_unicanvas_h3.py
git commit -m "feat: add VNCSS_CONFIG graph generation path and draw result route"
```

---

### Task 6: `web/vnccs_config.js` widget (LoRA stack + Edit model switch)

**Files:**
- Create: `web/vnccs_config.js`

**Interfaces:**
- Consumes: `VNCCS_Config` node with hidden `node_state` widget (JSON: `{"loras": [{"name", "strength", "enabled"}], "edit_model": bool}`), route `GET /vnccs/unicanvas/loras` (Task 2).
- Produces: `app.registerExtension({ name: "VNCCS.Config" })` that attaches `UniCanvasConfigWidget` to `VNCCS_Config` nodes; node inputs `reference_image_1..4` visible only when `edit_model` is true (same `addInput`/`removeInput` pattern as VNCCS Control Center's `_syncCustomModelInput`).

- [ ] **Step 1: Implement `web/vnccs_config.js`**

```js
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const REFERENCE_INPUTS = ["reference_image_1", "reference_image_2", "reference_image_3", "reference_image_4"];

class UniCanvasConfigWidget {
  constructor(node) {
    this.node = node;
    this.state = this._readState();
    this.loraNames = [];
    this.container = document.createElement("div");
    this.container.className = "vnccs-config-root";
    this.container.innerHTML = `
      <style>
        .vnccs-config-root { display:flex; flex-direction:column; gap:8px; padding:8px; color:#eee; font:12px sans-serif; }
        .vnccs-config-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
        .vnccs-config-lora { display:grid; grid-template-columns:minmax(0,2fr) 64px 24px; gap:6px; align-items:center; }
        .vnccs-config-btn { border:1px solid #555; background:#222; color:#eee; border-radius:6px; height:26px; cursor:pointer; }
        .vnccs-config-switch { width:42px; height:22px; border-radius:999px; border:1px solid #f08fa3; background:#f08fa322; position:relative; cursor:pointer; }
        .vnccs-config-switch::after { content:""; position:absolute; top:3px; left:3px; width:14px; height:14px; border-radius:50%; background:#aaa; transition:left .12s ease; }
        .vnccs-config-switch.on::after { left:23px; background:#ffd45c; }
      </style>
      <div class="vnccs-config-row"><strong>LoRA stack</strong><button class="vnccs-config-btn" data-action="add-lora">+ add LoRA</button></div>
      <div data-role="lora-list"></div>
      <div class="vnccs-config-row"><span>Edit model</span><div class="vnccs-config-switch" data-action="edit-model"></div></div>`;
    this.loraList = this.container.querySelector('[data-role="lora-list"]');
    this.editSwitch = this.container.querySelector('[data-action="edit-model"]');
    this.editSwitch.classList.toggle("on", !!this.state.edit_model);

    this.container.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action], [data-lora-action]");
      if (!btn) return;
      const action = btn.dataset.action || btn.dataset.loraAction;
      if (action === "edit-model") {
        this.state.edit_model = !this.state.edit_model;
        this.editSwitch.classList.toggle("on", this.state.edit_model);
        this._syncReferenceInputs();
        this._writeState();
      } else if (action === "add-lora") {
        this.state.loras.push({ name: this.loraNames[0] || "", strength: 1.0, enabled: true });
        this.renderLoras();
        this._writeState();
      } else if (action === "remove-lora") {
        this.state.loras.splice(Number(btn.dataset.index), 1);
        this.renderLoras();
        this._writeState();
      }
    });
    // Realtime rule (AGENTS.md): strength updates from `input`, never on release.
    this.container.addEventListener("input", (e) => {
      const target = e.target;
      const index = Number(target.dataset.index);
      const entry = this.state.loras[index];
      if (!entry) return;
      if (target.dataset.field === "strength") entry.strength = Number(target.value);
      if (target.dataset.field === "enabled") entry.enabled = target.checked;
      this._writeState();
    });
    this.container.addEventListener("change", (e) => {
      const target = e.target;
      if (target.dataset.field === "name") {
        this.state.loras[Number(target.dataset.index)].name = target.value;
        this._writeState();
      }
    });

    this._loadLoraNames().then(() => {
      this.renderLoras();
      this._syncReferenceInputs();
    });
  }

  _readState() {
    const widget = this.node.widgets?.find((w) => w.name === "node_state");
    try {
      return { loras: [], edit_model: false, ...JSON.parse(widget?.value || "{}") };
    } catch {
      return { loras: [], edit_model: false };
    }
  }

  _writeState() {
    const widget = this.node.widgets?.find((w) => w.name === "node_state");
    if (widget) widget.value = JSON.stringify(this.state);
  }

  async _loadLoraNames() {
    try {
      const res = await api.fetchApi("/vnccs/unicanvas/loras");
      const data = await res.json();
      this.loraNames = data.loras || [];
    } catch {
      this.loraNames = [];
    }
  }

  _syncReferenceInputs() {
    REFERENCE_INPUTS.forEach((name) => {
      const index = (this.node.inputs || []).findIndex((input) => input?.name === name);
      if (this.state.edit_model) {
        if (index === -1) {
          this.node.addInput(name, "IMAGE");
          this.node.setDirtyCanvas(true, true);
        }
      } else if (index !== -1) {
        this.node.removeInput(index);
        this.node.setDirtyCanvas(true, true);
      }
    });
  }

  renderLoras() {
    this.loraList.innerHTML = "";
    this.state.loras.forEach((entry, index) => {
      const row = document.createElement("div");
      row.className = "vnccs-config-lora";
      const options = this.loraNames
        .map((name) => `<option value="${name}" ${name === entry.name ? "selected" : ""}>${name}</option>`)
        .join("");
      row.innerHTML = `
        <select data-field="name" data-index="${index}">${options}</select>
        <input type="number" min="0" max="2" step="0.05" value="${entry.strength}" data-field="strength" data-index="${index}">
        <button class="vnccs-config-btn" data-lora-action="remove-lora" data-index="${index}">✕</button>`;
      this.loraList.appendChild(row);
    });
  }
}

app.registerExtension({
  name: "VNCCS.Config",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "VNCCS_Config") return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      const stateWidget = this.widgets?.find((w) => w.name === "node_state");
      if (stateWidget) {
        stateWidget.type = "hidden";
        stateWidget.hidden = true;
        stateWidget.computeSize = () => [0, -4];
        if (stateWidget.element) stateWidget.element.style.display = "none";
      }
      this.configWidget = new UniCanvasConfigWidget(this);
      this.addDOMWidget("vnccs_config_ui", "ui", this.configWidget.container, { serialize: false, hideOnZoom: false });
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      setTimeout(() => this.configWidget?._syncReferenceInputs(), 50);
    };
  },
});
```

- [ ] **Step 2: Manual verification (ComfyUI running, browser open)**

1. Restart ComfyUI, refresh the browser, add a `VNCSS_CONFIG` node.
2. Expected: panel shows the LoRA stack with `+ add LoRA`, and an `Edit model` switch (off).
3. Toggle `Edit model` on → four `reference_image_1..4` (IMAGE) sockets appear on the node; off → sockets disappear. Reload the page with the switch on → sockets are restored (state persisted in `node_state`).
4. Click `+ add LoRA` → row with a LoRA `<select>` (filled from `models/loras`), a strength field, and `✕`. Drag the strength field → value changes continuously (realtime rule). Remove works.
5. Connect `Load Checkpoint` (model/clip/vae) into the sockets and queue the node alone → executes without errors in the console.

- [ ] **Step 3: Commit**

```bash
git add web/vnccs_config.js
git commit -m "feat: add VNCSS_CONFIG widget with LoRA stack and Edit model switch"
```

---

### Task 7: UniCanvas frontend — H3 family tab, config mode, queued GENERATE

**Files:**
- Modify: `web/vnccs_unicanvas.js` (settings defaults near line 417/605, `draw()` at line 5518, model picker controls near line 1866, `NUMERIC_SETTINGS` at line 417)

**Interfaces:**
- Consumes: node input `config` (Task 5), `GET /vnccs/unicanvas/progress/{draw_id}` (existing), `GET /vnccs/unicanvas/result/{draw_id}` (Task 5), `gen_settings.draw_id` convention (Task 5).
- Produces: `this.settings.generation_mode` accepts `"minimax_h3"`; `draw()` routes to `app.queuePrompt` when the `config` input is linked and polls until `result.present`; result images enter the existing staging flow exactly like the HTTP path (`stagingMode`/`hasResultMask` handling around line 5579).

- [ ] **Step 1: Add the family tab and settings**

In the model tab list builder (the function rendering `.vnccs-uc-model-tab` entries, near line 1866) add one entry alongside the existing generation modes:

```js
      { id: "minimax_h3", label: "MiniMax H3" },
```

In `DEFAULT_SETTINGS` (the object at line ~605 with `model_selection_mode: "presets"`) add:

```js
    generation_mode: "illustrious",
    minimax_h3_steps: 20,
    minimax_h3_frame_count: 5,
    draw_id: "",
```

and extend `NUMERIC_SETTINGS` (line 417) with `"minimax_h3_steps"`.

When `generation_mode === "minimax_h3"` is active, `renderModelSelectionControls` shows one numeric control `minimax_h3_steps` (label `Steps`, min 1, max 60) plus a hint text `REF2VA region edit — working area is <Picture 1>, Edit model references are <Picture 2..5>.`

- [ ] **Step 2: Route GENERATE through the queue when `config` is linked**

Inside `draw()` (line 5518), before the `fetch("/vnccs/unicanvas/draw", …)` call, branch on config linkage:

```js
    const configInput = (this.node?.inputs || []).find((input) => input?.name === "config");
    const configLinked = !!(configInput && configInput.link != null);
    if (configLinked) {
      this.settings.draw_id = `uc_${Date.now().toString(36)}`;
      this.settings.queued_draw = this._buildDrawPayload({ includeDebugId: false });
      this.syncSettingsToWidget();
      this.startDrawProgressPolling(this.settings.draw_id);
      try {
        await app.queuePrompt(0, 1);
        const images = await this._pollForResult(this.settings.draw_id);
        await this._stageGeneratedImages(images.images, images.mask, mode);
        this.setStatus(`Generated ${images.images.length} image(s)`);
      } catch (err) {
        this.setStatus(`[VNCCS UniCanvas] ${err.message || err}`, true);
      } finally {
        this.stopDrawProgressPolling();
        this.drawInProgress = false;
        this.drawBtn.disabled = false;
      }
      return;
    }
```

Add the polling helper next to `startDrawProgressPolling` (line 5803):

```js
  async _pollForResult(drawId, timeoutMs = 600000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const res = await fetch(`/vnccs/unicanvas/result/${encodeURIComponent(drawId)}?t=${Date.now()}`);
      const data = await res.json();
      if (data.present) return data;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Timed out waiting for the queued generation result");
  }
```

Refactor the staging hand-off first: in `draw()` the block that builds and assigns `this.staging` (lines ~5579–5595: `stagingMode`, `stagingMaskCanvas`, placement and `clearEdgeConnected: mode === "inpaint"`) becomes one method used by both the HTTP path and the queued path:

```js
  _stageGeneratedImages(images, maskCanvas, mode) {
    const hasResultMask = !!maskCanvas;
    const stagingMode = hasResultMask ? mode : (mode === "inpaint" || mode === "outpaint" ? "img2img" : mode);
    const stagingMaskCanvas = hasResultMask && (mode === "inpaint" || mode === "outpaint") ? maskCanvas : null;
    this.staging = {
      mode: stagingMode,
      images,
      maskCanvas: stagingMaskCanvas,
      placement: this.getBboxPlacement(),
      clearEdgeConnected: mode === "inpaint",
    };
  }
```

Move the exact statements from the existing block into this method (keep every property the current block sets — the code above is the contract, the property list must stay identical to lines 5579–5595) and replace the block with `this._stageGeneratedImages(bitmaps, maskCanvas, mode)`. The queued path then ends with:

```js
        const images = await this._pollForResult(this.settings.draw_id);
        let maskCanvas = null;
        if (images.mask) maskCanvas = await this._maskCanvasFromDataUrl(images.mask);
        const bitmaps = await Promise.all(
          (images.images || []).map(async (url) => createImageBitmap(await (await fetch(url)).blob()))
        );
        if (!bitmaps.length) throw new Error("Queued generation returned no images");
        this._stageGeneratedImages(bitmaps, maskCanvas, mode);
```

- [ ] **Step 3: Manual verification (with `VNCSS_CONFIG` connected)**

1. Add `VNCCS_UniCanvas` + `VNCSS_CONFIG`; connect a checkpoint loader into config and `config` into UniCanvas; select `MiniMax H3` in the UniCanvas family tab.
2. Paint a region, type an instruction prompt, press GENERATE → the prompt appears in the ComfyUI queue; progress updates in the UniCanvas progress bar; the result opens the staging popover over the region.
3. Toggle `Edit model` on config with two reference images; prompt `Keep the identity from <Picture 2>.` → generation runs and the output reflects the reference.
4. Disconnect `config`, GENERATE again → legacy direct path works unchanged.
5. Check the console: no uncaught errors; `delete`/`ctrl+z` outside inputs still belong to ComfyUI (keyboard isolation comes in Plan 2).

- [ ] **Step 4: Commit**

```bash
git add web/vnccs_unicanvas.js
git commit -m "feat: route UniCanvas generation through VNCSS_CONFIG with H3 family tab"
```

---

### Task 8: README, evidence screenshots, final verification

**Files:**
- Modify: `README.md`
- Create (local workspace, pushed to `evidence/vncss-config-h3` branch): `evidence/vncss-config-h3/*.png`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: README section documenting `VNCSS_CONFIG` + H3 usage; screenshot set on the evidence branch; plan checkboxes complete.

- [ ] **Step 1: Update `README.md` (English)**

Add a section `## VNCSS_CONFIG and MiniMax H3 region editing` covering: node inputs (`model`/`clip`/`vae`, optional `audio_vae`, `reference_image_1..4` via `Edit model`), the LoRA stack, the `MiniMax H3` family tab (working area = `<Picture 1>`, references = `<Picture 2..5>`, `res_multistep`/`simple`, 20 steps, audio VAE required), and the queued generation behavior when `config` is connected.

- [ ] **Step 2: Capture before/after screenshots on the live instance**

Using a running ComfyUI with the branch checked out:
1. `Before`: `VNCSS_CONFIG`-less setup — UniCanvas node and its model picker before the change (use the upstream build).
2. `After`: same crop/region with the new node, LoRA stack, `Edit model` on (four reference sockets visible), and the `MiniMax H3` family tab selected. Labels burned in as exactly `Before` / `After`; record measured node geometry (x/y/width/height) beside the images.
3. Push PNGs to `evidence/vncss-config-h3` in the fork and keep local copies in the workspace.

- [ ] **Step 3: Run the full test suite**

Run: `python -m pytest tests/ -v`
Expected: all tests pass.

- [ ] **Step 4: Commit and prepare the PR package**

```bash
git add README.md
git commit -m "docs: document VNCSS_CONFIG and MiniMax H3 region editing"
git push -u origin unicanvas-next
```

Open the PR with the evidence-branch screenshot links in the body and a note that final manual acceptance is done by the repository owner.

---

## Follow-up plans (this spec, separate documents)

- Plan 2: Fullscreen mode + keyboard isolation + standalone sidebar mode (spec sections 5–6).
- Plan 3: Pose layers with live bridge and in-place pose editing (spec section 7).
- Plan 4: Brush-size gesture + radial HUD + layer utilities (context menu, PSD import, background removal, color match) (spec sections 8, 10).
- Plan 5: Qwen-Image-2.1 provider + vendored Spectrum (spec section 9).
