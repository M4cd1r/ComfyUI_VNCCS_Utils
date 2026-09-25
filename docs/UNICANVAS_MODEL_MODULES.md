# UniCanvas Model Modules

UniCanvas generates inside its widget, before normal ComfyUI graph connections
can provide model objects. Model support is therefore split into two concepts:

- **Loader**: how `model`, `clip`, and `vae` are loaded.
- **Inference module**: how prompts, reference images, latents, samplers, and
  decoding are wired for one model family.

This split keeps model files independent from the inference graph. For example,
`Diffusion Model` can load both Anima and Flux Klein, while `Checkpoint` always
forces SDXL.

AI agents asked to add a model: follow `docs/agents/ADDING_A_MODEL.md`, which lists
the questions to ask the user before writing any code.

## Extension Points At A Glance

A family is extended in three ways, from the lightest to the heaviest:

1. **Data** - `defaults`, `capabilities` (tasks, accepted inputs, reference slots,
   requirements, prompt guide) and `lora_requirements`.
2. **Hooks** - methods on `UniCanvasModelModule` that the default draw pipeline
   calls with the shared `DrawContext` (`validate_request`, `validate_source`,
   `prepare_pose_edit`, `prepare_draw_assets`, `preload_vae` / `release_vae`,
   `bind_draw_assets`, `encode_draw_prompts`, `on_mask_prepared`,
   `on_masked_mode_dropped`, `prepare_masked_inputs`, `prepare_generation_latent`,
   `prepare_masked_latent`, `after_latent_prepared`, `prepare_model_for_sampling`,
   `apply_control`, `normalize_settings`), plus the model primitives (`encode_prompt`,
   `prepare_reference_conditioning`, `create_empty_latent`, `sample_latent`,
   `decode_samples`, ...). Every hook has a generic default.
3. **A whole draw path** - `draw_pipeline_class` names a subclass of
   `draw_pipeline.ImageDrawPipeline` (or a class with the same `run()` contract).
   Video, 3D or panorama-view families replace entire stages there.

Shared draw code never names a family: `tests/test_unicanvas_draw_pipeline.py`
fails if `draw.py`, `draw_request.py`, `draw_pipeline.py`, `generation.py`,
`latents.py`, `sampling.py` or `loras.py` mention a family key or compare
`.key`. Add a hook with a generic default instead.

## Capabilities, Tasks And Prompt Help

`models/capabilities.py` describes a family as data:

- `GenerationTask` - one thing a family can generate (`text_to_image`,
  `image_to_image`, `inpaint`, `outpaint`, `text_to_video`, `image_to_video`,
  `reference_to_video`, `video_to_video`, `text_to_3d`, `image_to_3d`,
  `panorama_view`, or your own). `canvas_mode` links it to the canvas draw mode;
  `.planned()` declares a capability without a pipeline yet (rejected cleanly,
  shown as "coming later"); `.with_prompt_guide(...)` gives the task its own
  prompt help (e.g. MiniMax H3 image edits vs reference-to-video).
- `MediaKind` - text, image, video, audio, mesh, panorama.
- `ReferenceInputs` - how many reference pictures an edit family reads and how
  the prompt names slot `n` (`Picture {n}`, `<image{n}>`, `<Picture {n}>`).
- `PromptGuide` - `hint` (prompt placeholder), `guide` (paragraphs separated by
  blank lines), `examples`, `negative_prompt` (is the negative used?) and
  `sources` (links the advice is based on - required).
- `ModelCapabilities` - label, tasks, references, prompt guide, requirements
  (`requires_source_image`, `requires_external_config` with their messages),
  `supports_pose_edit`, `default_loader`.

A draw names its task with `task` in the payload, or implicitly through the
canvas `mode`. `UniCanvasModelModule.describe()` is served by
`/vnccs/unicanvas/assets` (`model_modules`); the widget's prompt `?` renders the
guide for the active family from it, so prompt help needs no frontend change.

## LoRA Rules

Families never override `apply_loras`; they declare `LoraRequirement`s
(`loras.py`), applied before the user's LoRA stack:

```python
lora_requirements = (
    LoraRequirement(
        name_setting="my_turbo_lora_name",   # settings key holding the file name
        match=MY_TURBO_LORA_NAME,            # only this canonical file
        enabled_setting="turbo_enabled",     # only with the Turbo switch on
        strength_setting="my_turbo_lora_strength",
        clip_strength=0.0,
    ),
    LoraRequirement(
        name_setting="my_edit_adapter_name",
        default_name="Vendor/edit_adapter.safetensors",
        fixed_strength=1.0,                  # the user cannot change it
        required=True,                       # applied even when a config owns the stack
        dedupe_from_stack=True,              # never applied twice
    ),
)
```

Other options: `require_positive_strength`, `draw_modes` (only for some modes)
and `resolver` / `resolve_match` (e.g. a lazy download on first use).

## Layer Tool Registries

Blend modes (`render.BLEND_MODES`, `register_blend_mode`), panorama projections
(`render.PANORAMA_PROJECTIONS`, `register_panorama_projection`), background
removers (`remove_bg.BACKGROUND_REMOVERS`, `register_background_remover`; any
family implementing `remove_background()` is offered as an edit-model backend)
and color transfers (`color_match.COLOR_TRANSFERS`, `register_color_transfer`)
are registries as well.

## Where The Code Lives

The backend is the `nodes/unicanvas/` package:

- `loaders.py`: `UniCanvasModelLoader` subclasses and their registry.
- `models/base.py`: `UniCanvasModelModule`, the base class of every family.
- `models/<family>.py`: one module per model family (defaults, turbo LoRA names,
  family-specific downloads and the adapter class).
- `models/__init__.py`: registers every family, in one place.
- `pipeline.py`: `UniCanvasNodeStep` / `UniCanvasPipeline`.
- `models/capabilities.py`: tasks, media kinds, reference slots, prompt guides.
- `draw.py` (entry), `draw_request.py` (payload -> `DrawRequest`),
  `draw_pipeline.py` (`ImageDrawPipeline`, `DrawContext`), `latents.py`,
  `sampling.py`, `generation.py`, `loras.py` (`LoraRequirement`): the shared draw
  path.

## Adding A Loader

Add a `UniCanvasModelLoader` subclass in `nodes/unicanvas/loaders.py` when a
model file format needs a different Comfy loader node.

Required methods:

- `cache_key(settings)`: include every setting that changes loaded assets.
- `load_assets(settings)`: return `(model, clip, vae)`.

Register it next to the built-in loaders at the bottom of the registry section:

```python
_register_unicanvas_model_loader(MyLoader("my_loader", ("alias",), forced_mode=None))
```

Use `forced_mode="sdxl"` only when the loader's output must always be handled by
one inference module. `Checkpoint` does this because UniCanvas treats checkpoint
loading as SDXL-only.

## Adding An Inference Module

Create `nodes/unicanvas/models/my_model.py` with the family defaults and, when
the model needs different prompt, latent, sampler, reference, or decode
behavior, a `UniCanvasModelModule` subclass. Then register it in
`nodes/unicanvas/models/__init__.py`.

Simple modules usually only declare defaults and capabilities (register instances
in `models/__init__.py`):

```python
MY_DEFAULTS = {
    "generation_mode": "my_model",
    "model_loader": "diffusion_model",
    "diffusion_model_name": "my-model.safetensors",
    "clip_name": "my-encoder.safetensors",
    "vae_name": "my-vae.safetensors",
    "sampler_name": "euler",
    "scheduler": "normal",
    "steps": 20,
    "cfg": 1.0,
}

_register_unicanvas_model_module(
    UniCanvasModelModule("my_model", ("my-alias",), MY_DEFAULTS)
)
```

For edit models, mark the module explicitly:

```python
_register_unicanvas_model_module(
    MyEditModule("my_edit_model", (), MY_DEFAULTS, is_edit_model=True)
)
```

This flag changes inpaint/outpaint behavior. Edit models use an InvokeAI-style
masked-latent path: UniCanvas VAE-encodes the source image, attaches the denoise
mask to the latent, and lets the sampler keep unmasked areas on the original
latent trajectory. Non-edit modules keep the SDXL/Anima path with native inpaint
conditioning and DifferentialDiffusion.

If the model uses custom inference nodes, define a `UniCanvasPipeline`.

## Declarative Pipelines

Use `UniCanvasNodeStep` to describe a Comfy node call:

```python
UniCanvasNodeStep(
    node="Flux2Scheduler",
    methods=("get_sigmas", "schedule"),
    inputs={"steps": "$steps", "width": "$width", "height": "$height"},
    output="sigmas",
)
```

The runner resolves inputs starting with `$` from the current pipeline context.
It calls the node through `NODE_CLASS_MAPPINGS` and also tries the node's
`FUNCTION` metadata, so contributors usually do not need to know exact Python
method names.

Available common context values:

- `$model`, `$clip`, `$vae`
- `$positive`, `$negative`
- `$positive_text`, `$negative_text`
- `$image_tensor`
- `$latent`
- `$seed`, `$steps`, `$cfg`, `$sampler_name`
- `$width`, `$height`

Flux Klein is the reference implementation. Its pipeline is declared as
`FLUX_KLEIN_PIPELINE` and contains:

- `reference`: attach source image latent to conditioning.
- `sample`: Flux2 scheduler + guider + sampler graph.
- `decode`: VAE decode.

Z-image Turbo is implemented as `ZImageUniCanvasModule`. It uses the standard
`Diffusion Model` loader with the official defaults from
`image_z_image_turbo.json`: `z_image_turbo_bf16.safetensors`,
`qwen_3_4b.safetensors` as `lumina2`, `ae.safetensors`,
`EmptySD3LatentImage`, `ModelSamplingAuraFlow` shift `3`, and
`res_multistep/simple` sampling. It is a non-edit module, so inpaint/outpaint
reuse the same SDXL/Anima inpaint conditioning path.

Z-image negative conditioning has one exception: turbo mode uses the official
workflow's `ConditioningZeroOut` negative conditioning. Turbo mode is selected
when the diffusion/GGUF model filename contains `turbo`, or when the user sets
`cfg` to `1`. Otherwise, the negative prompt remains the full `CLIPTextEncode`
conditioning so non-turbo Z-image models can use negative prompts normally.

## ControlNet

A family with a ControlNet (Union) declares it as data and applies it in one hook; the
shared code, the ControlNet layer in the widget and the request validation need no change.

1. **Declare** `capabilities.control_net = ControlNetSupport(...)` (`models/capabilities.py`):
   - `types` - the `ControlType` values the weights accept (`depth`, `canny`, `lineart`,
     `pose`, `mlsd`, `scribble`, `gray`; add a member to the enum for a new kind). The widget's
     type menu lists exactly these.
   - `weights = ControlNetWeights(hf_repo, hf_path, revision, folder="model_patches",
     setting=...)` - the pinned file, downloaded lazily into ComfyUI's `folder` on first use by
     `control_net.ensure_control_net_weights` (`huggingface_hub`, `token=False`); `setting` names
     a settings key that may point at a user-installed file instead.
   - `default_strength`, `max_strength`, `combines_with_inpaint` (may a control image and an
     Inpaint Mask share one draw?), `supports_range` (does the apply node take
     `start_percent` / `end_percent`?), `prompt_note`.
2. **Apply** in `apply_control(self, ctx) -> model`. The pipeline calls it right after
   `prepare_model_for_sampling`, inside the model lock, only when the request carries a
   control image. `ctx.control_tensor` is the control image as an IMAGE tensor at the working
   size (already cropped with the source for inpaint crop-to-mask), `ctx.request.control`
   holds `type`, `strength`, `start_percent`, `end_percent`. Load the weights with
   `control_net.load_control_net_patch(weights, ctx.settings, ctx.draw_id)` and call the
   ComfyUI core apply node through `_call_comfy_node` / `_call_node_method`.
3. **Mirror** `controlNet: { types, defaultStrength, maxStrength, supportsRange }` in the family's
   entry of the frontend registry (`web/vnccs_unicanvas.js`); the `/assets` descriptor wins,
   the mirror only covers the time before it arrives.
4. **Prompt guide** - add a short ControlNet paragraph (`CONTROL_NET_PROMPT_NOTE`: describe the
   content, the control carries the shape).

`validate_request` rejects a control image for a family without `control_net`, a type the
family does not list, a strength above `max_strength`, and a control plus Inpaint Mask when
`combines_with_inpaint=False`, before any model loads. Today: Z-Image Turbo
(`ZImageFunControlnet`, one patch for control plus the inpaint inputs) and MiniMax H3
(`MiniMaxH3FunControlNetApply` with the control image as a one-frame video). Qwen-Image 2.1's
Fun ControlNet Union has no ComfyUI core loader yet, so it is not declared.

The frontend side lives in `web/vnccs_unicanvas_control.mjs`: the `control` layer type (mask
section, never image content), its panel, and the `control` part of the draw payload (the
topmost active control layer, cropped to the bbox and scaled to the inference size like the
mask).

**From scene** (`web/vnccs_unicanvas_control_scene.mjs`, issue #46): a control layer can be made
from the flattened visible image layers inside the bbox. The layer keeps that source
(`layer.controlSource`) and the result is drawn at the source bbox. The type menu lists the scene
types the family accepts (depth, canny, lineart, pose). Depth and lineart run once on the server
(`POST /vnccs/unicanvas/control_preprocess`, `nodes/unicanvas/control_preprocess.py`, a
`register_control_preprocessor` registry; lineart is the MIT Informative Drawings annotator,
pinned in `helper_models`). Canny runs in the browser. Pose draws an OpenPose COCO-18 skeleton
from the mannequins' joints, which the pose editor projects into `layer.pose.openpose`. All
sliders render live from the cached raw output. A pose control stays linked to its pose layers
until it is painted on, and Relink restores the link.

## Frontend Registration

The frontend registry in `web/vnccs_unicanvas.js` must include the mode label,
defaults, aliases, and `detect` keywords. `detect` is used to switch Mode
automatically when the selected model filename matches a known family.

For models loaded by existing loader types, no new UI fields are needed. The
loader controls which model file selectors are shown:

- `Checkpoint`: `ckpt_name`
- `Diffusion Model`: `diffusion_model_name`, `clip_name`, `vae_name`
- `GGUF`: `gguf_model_name`, `clip_name`, `vae_name`

When adding a new loader field, add it in the JS loader registry and return its
asset list from `/vnccs/unicanvas/assets`.

## Inpaint And Outpaint

UniCanvas has two inpaint/outpaint strategies:

- Non-edit modules use SDXL/Anima-style inpaint conditioning. The source is
  encoded with inpaint metadata, DifferentialDiffusion may be applied, and the
  generated result is pasted back through the mask.
- Edit modules (`is_edit_model=True`) use masked source latents. The source image
  is VAE-encoded and a `noise_mask` is attached to the latent. This mirrors
  InvokeAI's rectified-flow edit model flow, where denoise receives both init
  latents and a denoise mask so unmasked regions remain anchored to the original
  image.

For edit-model outpaint, the masked/empty outpaint region is flattened to black
for inference. Do not smear, stretch, or crop the reference automatically: the
black region is intentional context for the edit model.

Outpaint requests also append `outpaint black part of image` to the positive
prompt at runtime. The UI prompt is not changed; the suffix only helps edit
models understand that black/empty canvas regions are targets to extend.

If a model has its own native masked edit implementation, override the module
methods and keep those mask semantics local to that module.
