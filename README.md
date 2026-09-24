# ComfyUI VNCCS Utils

A collection of utility nodes from the [VNCCS](https://github.com/AHEKOT/ComfyUI_VNCCS) project for everyday ComfyUI workflows, including **VNCCS 3D Factory**, **VNCCS UniCanvas**, **VNCCS Pose Studio**, and supporting generation utilities.

<table>
<tr>
<td width="50%" align="center">
<strong>Join The Community</strong><br>
Share results, ask questions, and follow VNCCS updates.<br><br>
<a href="https://discord.com/invite/9Dacp4wvQw" target="_blank"><img src="images/VNCCS_Discord_Button.png" alt="Join our Discord"></a>
</td>
<td width="50%" align="center">
<strong>Support VNCCS</strong><br>
VNCCS is developed independently. Support helps keep the project moving.<br><br>
<a href="https://www.buymeacoffee.com/MIUProject" target="_blank"><img src="images/VNCCS_Donate_Button.png" alt="Support VNCCS"></a>
</td>
</tr>
</table>

---

## VNCCS 3D Factory

<p align="center">
  <img src="images/3d-factory-logo.png" alt="VNCCS 3D Factory logo" width="360">
</p>

**VNCCS 3D Factory** is a scene-oriented image-to-3D Gaussian workspace inside
ComfyUI. It runs the open-source
[`VAST-AI-Research/TripoSplat`](https://github.com/VAST-AI-Research/TripoSplat)
pipeline locally, turns reference images into editable 3D Gaussian models, keeps
every generated object in a persistent scene, and renders the actual Gaussian
assets through the bundled SparkJS viewport.

### Key Features

* **True Gaussian Viewport**: Multiple Gaussian PLY objects render together
  with orbit, pan, detail zoom, adaptive camera clipping, selection, and an
  optional grid—there is no synthetic floor mesh. Compact SPLAT payloads are
  generated lazily in one bounded, content-addressed cache rather than stored
  beside every model.
* **Scene Manager**: Create and reopen scenes; generated objects, names,
  transforms, generation settings, and exports persist on the ComfyUI host.
* **Gaussian PLY Import**: Add an existing validated Gaussian PLY to the active
  scene; it appears immediately in the object list and live viewport.
* **Interactive Transforms**: Click objects in the viewport and move, rotate,
  or uniformly scale them with visible viewport gizmos. Exact numeric fields
  remain available in a collapsed precision panel.
* **Saved Scene Cameras**: A graphical FPV look pad and roll control rotate the
  camera in place without changing normal viewport orbit behavior. Add up to
  32 named scene cameras, click one to inspect its exact view, and receive the
  current view followed by every saved camera as an ordered ComfyUI `IMAGE`
  LIST at the shared Scene Export resolution.
* **Local TripoSplat Pipeline**: The official pipeline runs in process with
  ComfyUI's PyTorch device. Model setup and weight download are graphical.
* **Object and Scene PLY Export**: Export every transformed object separately
  or combine the visible scene as an editable Gaussian PLY. The export bakes
  transforms into the actual Gaussian centers and covariance, preserves
  opacity and spherical-harmonic color data, and embeds the current camera plus
  every saved scene camera without lossy triangle reconstruction.
* **Gaussian Library**: Save individual objects or complete scenes with
  automatic 3D previews. `.vnccs3d` packages keep only canonical PLY assets,
  then synchronize or publish manifest-driven model repositories on Hugging
  Face through the Pose Studio repository workflow.
* **Observable Jobs**: Background removal, image encoding, diffusion steps,
  Gaussian decoding, serialization, and scene insertion expose real progress.
  Every stage is printed to the ComfyUI console and retained in a downloadable
  per-job log.
* **Persistent Widget State**: Scene selection, generation controls, source
  reference, object transforms and selection, current and saved cameras, grid,
  and transform mode are saved with the workflow. Reference images are
  persisted on the ComfyUI host rather than temporary browser file URLs.

👉 **[Setup and workflow guide](docs/VNCCS_3D_FACTORY.md)**

## VNCCS UniCanvas

<p align="center">
  <img src="images/uni-canvas-logo.png" alt="VNCCS UniCanvas logo" width="360">
</p>

**VNCCS UniCanvas** is an integrated infinite-canvas image generation and editing workspace inside ComfyUI. It is designed for freeform creative work: generate anywhere, edit any region, build results across layers, and keep refining without being locked to a single fixed image boundary.

### Key Features

*   **Infinite Canvas Workflow**: Work beyond a single image frame and place generations wherever the composition needs them.
*   **Layer-Based Editing**: Build images from separate raster and mask layers with visibility, opacity, selection, movement, and compositing controls.
*   **Generation Anywhere**: Use a selected region as the generation target for new images, image edits, inpaint, outpaint, and full-area transformations.
*   **Mask and Object Tools**: Paint masks, refine selections, and use SAM-powered object selection to isolate or remove parts of an image.
*   **Preset and Custom Models**: Switch between built-in presets or use manual model selection for supported generation backends.
*   **Krea2 Identity Edit**: Download Turbo or Raw FP8 and all required weights from the model card. Edit the bbox image with grounded Qwen3-VL and adjust **Likeness** in the upper-right control. See the [Krea2 Edit guide](docs/UNICANVAS_KREA2_EDIT.md).
*   **Turbo and LoRA Controls**: Use Turbo LoRA cards and a general LoRA Stack directly from the generation panel.
*   **Canvas Editing Tools**: Move, transform, resize, snap, undo/redo, and manage generation results without leaving the node.
*   **Progress and Result Handling**: Track generation progress and apply results back into the canvas as editable layers.
*   **Live Pose Studio Layers**: Insert an editable mannequin from the vertical toolbar. The shared Pose Studio interface appears only while its tool is active. Choose a character from disk or a layer and generate with QiE2511 or Klein9b using the pose and background/character composite as two references. See the [pose layer guide](docs/UNICANVAS_POSE_LAYERS.md).
*   **360° Panorama Editing**: Import an equirectangular panorama, look around from its center, and paint, mask, transform, or generate within a square perspective view. A compact sphere control rotates all three axes. Edits stay on the sphere; the standard PSD export and node output use the complete panorama. See the [panorama guide](docs/UNICANVAS_PANORAMA.md).

## UniCanvas tools

### Input tools

*   **Radial HUD**: a **right mouse button hold** opens a four-sector radial HUD
    at the cursor (for every tool except SAM). Drag up for **size**, right for
    **opacity**, down for **hardness**, or left for the **foreground color**;
    once a sector is selected, keep dragging to adjust its value live and
    release to commit. The HUD is the only right-button gesture (the former
    Alt + right-button brush-size drag was removed by request); the SAM tool
    keeps its right-click subtract-point meaning.
*   **Brush hardness**: a new brush-engine setting (0-1) with a slider in the
    brush tool settings and a radial HUD sector. Values below 1 render strokes
    with radial-gradient stamps for soft edges; the effect is immediate while
    painting.

### Settings (gear icon)

The gear icon sits in the canvas corner bar, next to *Snap to grid*, and opens the UniCanvas settings: the background-removal backend - **edit model / BiRefNet / rembg / SAM 3** (default **BiRefNet**; the edit-model backend offers Qwen Image 2.1 and MiniMax H3, the RGBA-VAE edit models).

### Edit model reference images

Next to the full-width *Steps* field of every edit-model family sits a stacked-cards icon with a count badge. It opens the reference-image popover: up to 4 uploaded images condition the edit model, each thumbnail labelled `Picture 2`, `Picture 3`, ... so the positive prompt can refer to them by name (the working area is always `Picture 1` / `<image1>`). The uploads are an alternative to wiring `reference_image_N` inputs through the `VNCSS Config` node and travel in the same numbered slots.

### Layer utilities

Right-click a layer row to open the layer context menu:

*   **Copy layer as image to clipboard**: copies the layer as a PNG with alpha
    through `navigator.clipboard.write`.
*   **Save layer as image**: writes the layer PNG to ComfyUI's `output/`
    through `POST /vnccs/unicanvas/save_output`. Both export entries crop the
    layer to its alpha bounds, so the PNG contains the visible artwork rather
    than the full canvas backing store.
*   **Remove background**: runs the backend chosen in the settings (gear icon)
    and applies the result as alpha - **edit model** (Qwen Image 2.1 or
    MiniMax H3 RGBA subject extraction), **BiRefNet** (vendored BiRefNet-lite
    path, auto-downloaded on first use), **rembg** or **SAM 3** (automatic
    subject mask from the SAM stack). One-shot operation with status-line
    progress and a single undo entry.
*   **Color match to below**: matches the active layer's colors to the
    composite of the visible layers below it (or, failing that, the composite
    without the active layer). The popover offers the methods `mkl`, `hm`,
    `reinhard`, `mvgd`, `hm-mvgd-hm`, `hm-mkl-hm`, and `reinhard_lab_gpu`
    plus a strength slider (0-10) with a live preview while dragging and a
    commit on release. Backed by the `color-matcher` package with a pure
    Reinhard (LAB mean/std) fallback.
*   **Rasterize** / **Edit pose**: live Pose Studio layers only. *Edit pose*
    selects the layer and opens its embedded Pose Studio editor; *Rasterize*
    bakes the current pose render into a plain raster layer (one undo step).

**Import PSD** sits next to **Export Layers as PSD** and loads raster layers
(name, visibility, opacity, blend mode, stacking order) from a PSD file with
the bundled `ag-psd` reader. Everything UniCanvas cannot represent (clipping
masks, adjustment layers, layer effects, text/vector/smart-object layers
without raster data) is skipped and reported in the status line.

## VNCSS Config and MiniMax H3 region editing

`VNCSS Config` feeds UniCanvas with `MODEL`/`CLIP`/`VAE` tensors that already
exist in the graph, so the canvas can be driven by any loader chain instead of
the built-in model picker. Connect its `config` output to the `config` input of
the `VNCCS UniCanvas` node.

### Node inputs

| Socket | Type | Notes |
|---|---|---|
| `model` | MODEL | Required — execution fails with `[VNCCS Config] Model input is not connected.` otherwise. |
| `clip` | CLIP | Required. |
| `vae` | VAE | Required. |
| `audio_vae` | VAE | Optional socket, mandatory when the `MiniMax H3` family is selected; every other family ignores it. |
| `reference_image_1..4` | IMAGE | Added and removed dynamically by the `Edit model` switch. |

### LoRA stack

The node panel holds an ordered LoRA stack: `+ add LoRA` appends a row with a
LoRA picker (populated from `models/loras` through `GET /vnccs/unicanvas/loras`),
a strength field, an on/off checkbox and `✕` to remove the row. Strength and
enable changes apply immediately while editing; rows that are switched off or
left at strength 0 are skipped. The stack is applied to `model`/`clip` during
graph execution, before sampling.

### Edit model switch

*   **Off (default)** — classic img2img / inpaint / outpaint behavior.
*   **On** — reveals the four `reference_image_1..4` (IMAGE) sockets and enables
    reference-conditioned editing in the connected node. `reference_image_1` must
    be connected. Switching it off disconnects and removes the sockets cleanly.

The switch and the LoRA stack live in the node's hidden `node_state` widget, so
they are saved with the workflow and restored — together with the dynamic
reference sockets — when the workflow is reloaded.

### MiniMax H3 region editing

Select the **MiniMax H3** family in the UniCanvas engine panel. H3 region editing is
driven by a connected `VNCSS Config` node (`clip`, `vae`, `audio_vae` and the reference
dataset); selecting the family without a connected config fails fast with
`[VNCCS UniCanvas] MiniMax H3 requires a connected VNCSS Config node (clip, vae, audio_vae).`
Generation is a REF2VA-style region edit: the selected working area is `<Picture 1>`,
the `Edit model` reference sockets become `<Picture 2..5>` in socket order, and the
prompt is the edit instruction:

```text
Keep the identity from <Picture 2>. Use the pose from <Picture 3>.
```

Defaults: sampler `res_multistep`, scheduler `simple`, 20 steps (adjustable
1–60 in the panel), cfg 1. No mask is required — the bounding box of the
selection is the working area. For this family the connected `audio_vae` is
mandatory, because the MiniMax H3 conditioning builds its aligned audio-video
latent from it; a connected config without it stops generation with `[VNCCS
UniCanvas] MiniMax H3 requires the audio VAE.` Results arrive in the usual staging
popover (accept / discard).

### Queued generation with a connected config

External `MODEL`/`CLIP`/`VAE` tensors only exist while a graph executes, so when
the `config` input is connected, **GENERATE queues a normal ComfyUI prompt**
instead of calling the direct draw endpoint:

1. The widget stamps a `draw_id`, bundles the current composition (bbox,
   composite, mask, mode) into the node settings and calls `app.queuePrompt`.
2. `VNCSS Config` executes first, applying the LoRA stack to `model`/`clip` and
   packaging the references; `VNCCS_UniCanvas` then samples the queued draw and
   stores the result under that `draw_id`.
3. The widget polls `GET /vnccs/unicanvas/progress/{draw_id}` for progress and
   `GET /vnccs/unicanvas/result/{draw_id}` until the result is present, then
   hands it to the normal staging flow. A prompt execution error fails the draw
   immediately instead of waiting for the result timeout.

Without a connected `config` (and in standalone sidebar mode) UniCanvas keeps
using the existing direct `POST /vnccs/unicanvas/draw` path with its own model
loading, unchanged.

## Fullscreen mode

UniCanvas opens a distraction-free fullscreen workspace from the **Fullscreen** icon
button at the top-right of the stage:

- The widget is re-parented — same instance, no reload — into a `position:fixed`
  `inset:0` portal; the stage re-lays out and the view fits automatically.
- While fullscreen is active, keyboard input is isolated: `keydown` / `keyup` /
  `keypress` events that are not targeted at `input` / `textarea` / `select` /
  `[contenteditable]` are swallowed in the capture phase before LiteGraph or ComfyUI
  sees them, and graph navigation forwarding (wheel / middle-click panning) is
  suspended. Text fields keep working normally.
- Fullscreen chrome shows the title, a **✕** exit button, and an optional "true
  fullscreen" toggle that uses `requestFullscreen()`.
- The vertical tools column renders **50% smaller** while fullscreen.
- The UniCanvas shortcut map works whenever the canvas has focus (fullscreen or not):

| Shortcut | Action |
|---|---|
| `B` / `V` / `E` / `M` / `L` / `S` | Brush / Move / Eraser / Mask brush / Lasso / Rectangle tools |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `[` / `]` | Shrink / grow the brush size |
| `Tab` | Toggle panel visibility |
| `Esc` | Exit fullscreen |

## Standalone Unicanvas mode

The **Unicanvas** sidebar tab (with its own icon in the sidebar tab strip) runs UniCanvas
as a standalone image app — no node, no workflow:

- Entering the tab hides all ComfyUI chrome (top bar and sidebar panels) and keeps only
  the icon sidebar visible; leaving the tab restores the standard chrome. This is the
  default behavior, not a toggle.
- The engine picker offers the built-in presets plus custom models from disk across all
  model families. An external `VNCSS Config` is node-mode only — the engine panel says
  so, and standalone mode ignores any config connected elsewhere.
- Output actions replace the node's `image` socket: **Save to output** writes the
  flattened composite into ComfyUI's `output/` directory through
  `POST /vnccs/unicanvas/save_output` (the button is also present in node mode; the
  same route saves a single layer's PNG with its alpha channel when `layer_id` is
  given), and **New** asks "Are you sure?" before clearing all layers and images and
  creating a fresh base layer.
- Work persists to `localStorage` under the `vnccs-unicanvas-standalone` key, so it
  survives a page reload.

## Qwen-Image-2.1

UniCanvas can generate with **Qwen-Image-2.1** through the `QwenImage21` family tab in the engine
picker (node widget and standalone host):

- **Model stack** (official Qwen-Image-2.1 architecture, ComfyUI-native weights from
  `Comfy-Org/Qwen-Image-2.1`): 7B / 32-layer single-stream DiT diffusion model, Qwen3-VL 8B text
  encoder (encodes instructions and condition images), and the 64-channel RGBA image VAE with 16x
  spatial compression. Loading follows ComfyUI core (>= 0.37) node semantics: `UNETLoader`,
  `CLIPLoader` (type `qwen_image`) and `VAELoader`.
- **Sampling defaults**: flow matching, `euler` / `simple`, 40 steps, cfg 1.0.
- **Native 2K aspect presets** from the official table: 2048x2048, 2400x1792, 1792x2400, 2528x1696,
  1696x2528, 2752x1536, 1536x2752.
- **All draw modes**: `txt2img`, `img2img`, `inpaint` and `outpaint` (inpaint is img2img with
  mask paste-back).
- **Reference editing** with `VNCSS Config` and the `Edit model` switch: the working area is
  `<image1>`, connected reference images become `<image2..5>` in socket order, and the module
  assembles the instruction in the Qwen-Image-2.1 `<image N>` convention, e.g.
  ```
  Keep the identity from <image2>. Use the pose from <image3>.
  ```
- **RGBA output is the default.** Every generation uses the transparent-RGBA prompt convention from
  the official Qwen space (`This is an RGBA image with transparency. ... The image has alpha channel
  and the background is transparent.`) and staging keeps the alpha channel, so accepted results are
  layers with real transparency. The **`opaque output`** switch is available for the rare case where
  alpha is unwanted: it disables the RGBA prompting and flattens the result.
- `Remove background` with the **edit model** backend set to Qwen Image 2.1 runs the
  Qwen-Image-2.1 RGBA subject-extraction flow over the layer pixels and applies the extracted alpha.
- **Viggle turbo (4-step)** switch (the same pattern as the other turbo switches): enables the
  [Viggle Qwen-Image-2.1-viggle-turbo](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo)
  4-step DMD LoRA over the base transformer and switches Steps to 4 / CFG to 1 (the distillation
  runs without classifier-free guidance). The LoRA downloads into `models/loras/viggle/` on first
  use; switching it off restores the previous steps/CFG/sampler/scheduler.

### Spectrum acceleration

The **Spectrum acceleration** panel (exposed only for the `QwenImage21` family) speeds up
Qwen-Image-2.1 sampling with a vendored port of **Spectrum** (arXiv 2603.01623) from
[`awdqwdasdg/Comfyui-Spectrum-Qwen2.1`](https://github.com/awdqwdasdg/Comfyui-Spectrum-Qwen2.1) —
MIT License, Copyright (c) 2026 ComfyUI-Spectrum-QwenImage21 contributors. The vendored package
lives in `nodes/spectrum_qwen21/` and carries the MIT attribution in every file header. The
package also contains `node_def.py`, the pinned upstream parameter contract (defaults and
min/max/step of every parameter); it is kept for the test-suite only and is **not** registered
as a ComfyUI node.

On selected steps the 32-block Qwen-Image-2.1 transformer is skipped entirely and its final hidden
state is forecast with an online ridge-regularized Chebyshev fit over the real steps, after which
only the cheap output head runs. The port is fail-closed exactly like upstream: any forecast that
cannot be proven safe (or raises) degrades that step to a real forward. `apply_spectrum()` runs
after all model mutations (the `VNCSS Config` LoRA stack included) and before sampling.

The panel offers an enable toggle and the parameters `warmup_steps`, `tail_actual_steps`,
`window_size`, `flex_window`, `max_consecutive_forecasts`, `history_points`, `chebyshev_degree`,
`ridge_lambda`, `blend_weight`, `cache_device`, `force_actual_on_control` and `debug`, with the
presets **`moderate`** (paper default), **`aggressive`** and **`quality`**.

## VNCCS Pose Studio

<p align="center">
  <img src="images/pose-studio-logo.png" alt="VNCCS Pose Studio logo" width="360">
</p>

**Example Workflows:** [QWEN](workflows/VNCCS_Utils%20Pose%20Studio%20QWEN.json) · [Klein9b](workflows/VNCCS_Utils%20Pose%20Studio%20Klein9b.json)

**VNCCS Pose Studio** is a professional 3D posing, framing, lighting, and pose-library environment running directly inside a ComfyUI node. It is designed for building high-quality pose/control references without leaving the graph: adjust the character body, pose bones interactively, frame the camera, tune lights, manage saved poses, and output single images or pose batches.

### Key Features

*   **Interactive 3D Viewport**: Pose the mannequin directly in the node with selectable joints, bone manipulation, transform controls, and full **Undo/Redo** support.
*   **Dynamic Body Generator**: Fine-tune the character shape with sliders for Age, Gender blending, Weight, Muscle, and Height.
*   **Multi-Pose Tabs**: Create multiple independent pose states inside one node, making batch outputs and pose sequences easier to build.
*   **Keyframe Animation Mode**: Switch Pose Studio from static images to a dope-sheet timeline with per-bone tracks, playback, Auto-Key, draggable keys, easing presets, and deterministic frame output.
*   **Mixamo FBX Animation Import**: Import a Mixamo clip as one animated pose; Pose Studio switches to Animation mode and converts retargeted samples into bone keyframes instead of creating pose tabs.
*   **Pose Copy/Paste**: Transfer complex poses between tabs without rebuilding them from scratch.
*   **Modal Pose Gallery**: Save, browse, load, and delete poses in a focused full-screen gallery instead of cluttering the main workspace.
*   **Pose Import/Export**: Batch save and load pose data via JSON for reuse across workflows or projects.
*   **Tracing Support**: Load a background reference image and align the 3D character to it for accurate pose matching.
*   **Precision Camera Controls**: Set output dimensions, zoom, model rotation, and camera orbit with an integrated radar-style control.
*   **Viewport Frame Preview**: Preview the final render boundary directly in the viewport so composition matches the output.
*   **Advanced Environment Lighting**: Control Ambient, Directional, and Point Lights, including 2D radar controls for positioning point lights and radius controls for their influence.
*   **Keep Original Lighting Mode**: Bypass synthetic lighting for clean flat renders, useful for ControlNet-style pose/reference outputs.
*   **Prompt-Aware Lighting Output**: Generate descriptive lighting prompts that can be combined with your scene prompt.
*   **Custom Prompt Templates**: Use tag-based templates such as `<lighting>` and `<user_prompt>` to control how the final prompt is assembled.
*   **Direct Sidebar Prompting**: Add scene details in an auto-expanding prompt field directly inside the Pose Studio UI.
*   **Flexible Export Modes**: Output poses as a list or as a grid, with configurable background color.

👉 **[Detailed Usage Guide](docs/VNCCS_POSE_STUDIO_USAGE.md)**

## Additional Nodes

### VNCCS Visual Camera Control
**[Example Workflow](workflows/VNCCS_Utils%20Visual%20camera%20control%20node%20for%20Qwen-Image-Edit-2511-Multiple-Angles%20LoRa.json)**

An interactive node with a visual widget for controlling camera position. It is designed for intuitive angle control and prompt generation, especially for multi-angle LoRAs like **Qwen-Image-Edit-2511-Multiple-Angles**.

*   **Visual Widget**: Select azimuth and distance with the mouse.
*   **Elevation Slider**: Pick elevation from -30° to 60°.
*   **Trigger Word Toggle**: Enable or disable the `<sks>` trigger from the widget.
*   **Random Range Toggle**: Randomize across the full 360° or restrict random views to the front ±45° while keeping elevation and distance random.

### VNCCS QWEN Detailer
**[Example Workflow](workflows/VNCCS_Utils%20QwenDetailer_ChangeEmotion.json)**

A QWEN-Image-Edit2511 detailer for enhancing detected regions such as faces, hands, and objects with vision-guided instructions.

*   **Smart Cropping**: Automatically squares crops and handles padding.
*   **Vision-Guided Enhancement**: Uses QWEN-generated instructions or user prompts.
*   **Drift Fix**: Helps keep the enhanced area aligned with the original composition.
*   **Quality of Life Tools**: Includes color matching, Poisson blending, and upscaling options.
*   **Inpainting Mode**: Supports mask-based editing and filling black areas.
*   **QWEN Options**: Supports QWEN-Image-Edit2511-specific options such as `distortion_fix` and `qwen_2511` mode.

### VNCCS Model Manager & Selector
**[Example Workflow](workflows/VNCCS_Utils%20Model%20Loader%20ShowCase.json)**

A system for managing and selecting LoRAs and checkpoints directly in ComfyUI, with support for Civitai and HuggingFace.

#### VNCCS Model Manager
The backend node that reads a HuggingFace-hosted `model_updater.json` and manages model downloads.

*   **Repo ID**: Point the manager to your HuggingFace model repository.
*   **Downloads**: Queue and download models in the background.
*   **Civitai Support**: Use API key authentication for restricted Civitai models.

👉 **[Configuration Guide: How to create your own model repo](docs/MODEL_MANAGER_GUIDE.md)**

#### VNCCS Model Selector
The companion UI node for choosing models from the configured repository.

*   **Visual Card UI**: Shows model name, version, status, and description.
*   **Smart Search**: Opens a searchable modal model list.
*   **Status Indicators**: Shows Installed, Update Available, Missing, and Downloading states.
*   **One-Click Install/Update**: Install or update models directly from the selector.
*   **Universal Connection**: Outputs a standard relative path string compatible with standard ComfyUI nodes.

👉 **[Usage Guide: How to use Selector with Standard Loaders](docs/MODEL_SELECTOR_USAGE.md)**

### VNCCS BBox Extractor

A helper node for extracting and visualizing crops when you need detected bounding-box regions without running a full face/detailer workflow.

## Installation

### Recommended: ComfyUI Manager

1. Open **ComfyUI Manager**.
2. Choose **Custom Nodes Manager**.
3. Search for **VNCCS Utils**.
4. Click **Install**.
5. Restart ComfyUI.

### Manual Installation

Open a terminal in your ComfyUI directory and run:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/AHEKOT/ComfyUI_VNCCS_Utils.git
cd ComfyUI_VNCCS_Utils
pip install -r requirements.txt
```

Open **Model setup** inside VNCCS 3D Factory to detect or download the official
TripoSplat weights in the standard `ComfyUI/models/{diffusion_models,vae,clip_vision,background_removal}`
folders. ComfyUI `extra_model_paths` are also searched. The inference pipeline
runs directly in ComfyUI and does not require a separate server.

Restart ComfyUI after installation.

## Star History

<a href="https://www.star-history.com/?repos=AHEKOT%2FComfyUI_VNCCS_Utils%2CAHEKOT%2FComfyUI_VNCCS%2CAHEKOT%2FComfyUI_HYWorld2&type=timeline&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=AHEKOT/ComfyUI_VNCCS_Utils%2CAHEKOT/ComfyUI_VNCCS%2CAHEKOT/ComfyUI_HYWorld2&type=timeline&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=AHEKOT/ComfyUI_VNCCS_Utils%2CAHEKOT/ComfyUI_VNCCS%2CAHEKOT/ComfyUI_HYWorld2&type=timeline&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=AHEKOT/ComfyUI_VNCCS_Utils%2CAHEKOT/ComfyUI_VNCCS%2CAHEKOT/ComfyUI_HYWorld2&type=timeline&legend=top-left" />
 </picture>
</a>
