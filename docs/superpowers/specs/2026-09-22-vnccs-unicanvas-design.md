# VNCCS UniCanvas — Feature Design (2026-09-22)

Design spec for the UniCanvas upgrade set in `M4cd1r/ComfyUI_VNCCS_Utils` (fork of
`AHEKOT/ComfyUI_VNCCS_Utils`). Target branch for this work: `unicanvas-next`.

The goal is to turn UniCanvas into a Photoshop/Krita/Invoke-style AI canvas: external
model plumbing (`VNCSS_CONFIG`), MiniMax H3 region editing, a true fullscreen mode, a
standalone app mode, live pose layers from Pose Studio, pro input tools, and a set of
layer utilities. This repository only — the `ComfyUI_VNCCS` repository is out of scope
and must not be modified.

## 1. Scope

In scope:

1. `VNCSS_CONFIG` node: external `model`/`clip`/`vae` sockets, LoRA stack, `Edit model`
   switch with a 4-slot reference-image dataset.
2. MiniMax H3 region editing ("H3 inpaint") driven by `VNCSS_CONFIG`.
3. Fullscreen mode with full ComfyUI keyboard isolation.
4. Standalone "Unicanvas" sidebar mode (no workflow) with `Save to output` / `New`.
5. Pose layers from Pose Studio (live bridge, character dropdown, in-place pose editing).
6. Brush-size gesture (Alt + right mouse) and a radial HUD (right mouse).
7. Qwen-Image-2.1 provider with vendored Spectrum acceleration (RGBA by default).
8. Layer utilities: context menu (clipboard/save), PSD import, background removal
   (QI2.1 + BiRefNet), Color Match.

Out of scope: any change to `AHEKOT/ComfyUI_VNCCS` (including its Control Center);
multi-character pose scenes (v1 handles one character); per-layer masks, clipping masks
and adjustment layers (rejected); clone stamp, quick mask, canvas view rotation and the
other rejected feature candidates.

## 2. Architecture

One widget (`UniCanvasWidget`, `web/vnccs_unicanvas.js`) in two hosts:

| Host | Context | Model source | Output |
|---|---|---|---|
| Node mode | `VNCCS_UniCanvas` node in a workflow | Built-in picker and/or `VNCSS_CONFIG` input | `image` (IMAGE) socket + `Save to output` button |
| Standalone mode | Sidebar tab "Unicanvas" | Built-in picker only | `Save to output` button |

Generation flows:

```
[no VNCSS_CONFIG]  GENERATE --> POST /vnccs/unicanvas/draw            (unchanged fast path)
                                 backend loads models itself via
                                 UniCanvasModelLoader (presets/custom)

[with VNCSS_CONFIG] GENERATE --> api.queuePrompt (normal ComfyUI queue)
                                 VNCCS_Config.execute(): applies the LoRA stack
                                   to model/clip, packages references -> VNCSS_CONFIG
                                 VNCCS_UniCanvas.generate(config, state): samples,
                                   writes result into the state cache keyed by draw_id
                                 widget polls /vnccs/unicanvas/progress/{draw_id}
                                   and fetches /vnccs/unicanvas/result/{draw_id} (new)
```

Queueing the prompt is required whenever `VNCSS_CONFIG` is connected because external
`MODEL`/`CLIP`/`VAE` tensors only exist during graph execution. The direct endpoint
remains for the no-config case and for standalone mode.

### Model families

Family tabs (`QIE2511` / `Klein9b` / `MiniMaxH3` / `QwenImage21`) live in the UniCanvas
engine picker (both hosts). `VNCSS_CONFIG` stays lean and family-agnostic. Existing
modules (`SDXL`, `Anima`, `FluxKlein`, `QwenImageEdit`, `ZImage`) are untouched; two
modules are added: `MiniMaxH3UniCanvasModule` and `QwenImage21UniCanvasModule`.

## 3. `VNCSS_CONFIG` node

New file `nodes/vncss_config.py`, class `VNCCS_Config` (display name `VNCSS_CONFIG`).
Output: one `VNCSS_CONFIG` object containing the (possibly LoRA-patched) `model`,
`clip`, `vae`, the reference-image list and flags.

Inputs:

- `model` (MODEL), `clip` (CLIP), `vae` (VAE) — always visible.
- `reference_image_1..4` (IMAGE) — added/removed dynamically by the `Edit model` switch,
  using the same `addInput`/`removeInput` sync pattern as VNCCS Control Center's
  `_syncCustomModelInput()`.

Widget UI (DOM widget, Control Center style):

- **LoRA stack**: ordered list of LoRA entries — file picker (new route
  `/vnccs/unicanvas/loras`), strength slider (realtime per repo AGENTS.md), on/off
  toggle, drag reorder, `+ add LoRA`. Applied in `execute()` via
  `comfy.sd.load_lora_for_models`, mirroring Control Center's `_apply_loras`.
- **Edit model switch**: off = classic img2img/inpaint behavior; on = reveals the 4
  reference sockets and enables reference-conditioned editing in connected nodes.
- State is stored in a hidden `node_state` JSON widget (survives save/load; dynamic
  sockets are re-synced in `onConfigure`).

Reference semantics (shared convention across families):

- The canvas working area (bbox crop of the composite) is always `<Picture 1>` for H3
  and `<image1>` for Qwen-Image-2.1.
- Connected reference images become `<Picture 2..5>` / `<image2..5>` in socket order.
- The user prompt is the edit instruction and references pictures by number, e.g.
  `Keep the identity from <Picture 2>. Use the pose from <Picture 3>.`

An optional `audio_vae` (VAE) socket feeds MiniMax H3's aligned audio-video latent —
the built-in `MiniMaxH3ReferenceToVideo` node needs the audio VAE to build it. It is
required only when the H3 family is active (`[VNCCS UniCanvas] MiniMax H3 requires the
audio VAE.` otherwise); all other families ignore it.

## 4. MiniMax H3 region editing (H3 "inpaint")

New `MiniMaxH3UniCanvasModule` (key `minimax_h3`) in `nodes/unicanvas.py`. Conditioning
and sampling reuse ComfyUI's built-in `MiniMaxH3ReferenceToVideo` node (REF2VA:
prompt + reference pictures → `positive` + empty audio-video latent), followed by
`BasicGuider` + `RandomNoise` + `SamplerCustomAdvanced`, and `VAEDecodeTiled` with the
first decoded frame taken as the still:

- Mode: REF2VA-style edit. No mask is required — the selected working area (bbox) is
  `<Picture 1>`, `Edit model` references are `<Picture 2..5>`, the prompt is the edit
  instruction. This mirrors the `H3_IMAGE_EDIT` flow from MiniMax H3 Image Studio.
- Defaults: sampler `res_multistep`, scheduler `simple`, shift 12/3, 20 steps (base) or
  8 steps (turbo, matching Turbo adapter).
- The result returns to the existing staging popover (accept/discard). On accept: if an
  inpaint mask layer is active, paste back only inside the mask; otherwise replace the
  whole region.
- In this package the H3 module is driven by `VNCSS_CONFIG` (it supplies clip/vae/audio_vae
  and the reference dataset); the draw path fails fast with an actionable message when H3 is
  selected without a connected config. Built-in by-name H3 loading is deferred (see section 14).

## 5. Fullscreen mode (keyboard isolation)

- A `Fullscreen` icon button at the top-right of the stage. On activation the widget DOM
  is re-parented into a `position:fixed; inset:0` portal (same widget instance, no
  reload); the `ResizeObserver` re-lays out and the view fits.
- Keyboard isolation for the duration of fullscreen: `window`-level **capture-phase**
  listeners on `keydown`/`keyup`/`keypress` call `stopImmediatePropagation()` +
  `preventDefault()` for every event not targeted at `input`/`textarea`/`select`/
  `[contenteditable]`. LiteGraph and ComfyUI shortcuts receive nothing.
- `enableUniCanvasGraphNavigationForwarding` is suspended (wheel/middle-click no longer
  pan the graph underneath).
- UniCanvas shortcut map (active whenever the canvas has focus, fullscreen or not):
  tools (`B` brush, `V` move, `E` eraser, `M` mask, `L` lasso, `S` rect), history
  (`Ctrl+Z` / `Ctrl+Shift+Z`), brush size (`[` / `]`), `Tab` toggles panel visibility,
  `Esc` exits fullscreen.
- Fullscreen chrome: title, `✕` exit, and a small optional "true fullscreen" toggle
  (`requestFullscreen()`).

## 6. Standalone sidebar mode

- A sidebar tab labeled **"Unicanvas"** (`app.extensionManager.registerSidebarTab`)
  instantiates `UniCanvasWidget` with `standalone: true` — no node, no workflow. It is a
  plain image app on top of ComfyUI.
- **Default chrome behavior**: entering standalone mode hides all ComfyUI chrome (top
  bar and sidebar panels) and keeps only the icon sidebar visible. This is the default,
  not a toggle; leaving the tab restores the standard ComfyUI chrome.
- Engine: built-in picker only (presets + custom models from disk, all four families).
  When a node-mode widget elsewhere has a `VNCSS_CONFIG`, standalone ignores it and the
  engine panel states that external config is node-mode only.
- Output actions (replacing the node's `image` socket):
  - **`Save to output`** — writes the flattened composite (or active layer via the layer
    context menu) to ComfyUI's `output/` directory through
    `POST /vnccs/unicanvas/save_output` (also present in node mode for convenience).
  - **`New`** — shows an "Are you sure?" confirmation modal; on confirm it clears the
    canvas (all layers and images) and creates a fresh base layer for new work.
- State persists to `localStorage` (`vnccs-unicanvas-standalone`) so work survives a
  page reload.

## 7. Pose layers

A new layer type `pose`, stored as a raster-like layer plus a `poseData` JSON payload.

### 7.1 Layer model

- Behaves like a raster layer in the stack: transforms (move/resize/rotate), opacity,
  blend mode, arbitrary stacking order. Brush/eraser are blocked on it (smart-object
  semantics); `Rasterize` (layer context menu) converts it to a normal raster layer.
- `layer.poseData` JSON (persisted with the state) records everything needed to rebuild:
  `{ schemaVersion, pose, character: { id, name, source: "vnccs" | "mannequin", morphs },
  camera, render: { transparent: true, size } }`.
- v1 handles a single character per layer (the active Pose Studio character).

### 7.2 Creation flow (live bridge)

- `Add pose layer` (in the Layers section next to `Add raster` / `Add mask`) creates the
  layer and broadcasts a subscription on a `window` CustomEvent bus
  (`vnccs:unicanvas:pose-layer`). Pose Studio answers with viewport renders (PNG with
  alpha) plus metadata; UniCanvas replaces the layer pixels: live preview coalesced
  through `requestAnimationFrame` (~15–20 fps) during interaction and a full-quality
  capture on `pointerup`/`change` (AGENTS.md realtime rule).
- The layer is **visible and interactive in place** from the start: it renders inside the
  stack at its real z-position composited over the lower layers, and normal transform
  tools work on it while posing, so placement relative to the layers below is always
  WYSIWYG.
- Character dropdown in the Pose Studio Characters panel: `Mannequin` plus saved VNCCS
  characters from `/vnccs/list_characters`; selecting one applies its morphs through
  the existing `applyExternalCharacterCreatorValues()`. If the VNCCS pack is absent the
  list degrades to `Mannequin` and the status chip says so.
- Status chip on the layer: `linked to Pose Studio` / `waiting…` / `disconnected`, plus a
  manual `capture now` action. Pixel replacement is one `layerPixels` history command
  per gesture.

### 7.3 In-place pose editing (mannequin tool)

- A new tool icon (mannequin) in the tools column: with a pose layer active it enters
  **pose edit mode** — the layer's pixels are temporarily replaced by an interactive
  mannequin loaded from `layer.poseData` (previously chosen pose, character morphs,
  camera), reusing the Pose Studio runtime (`vnccs_pose_studio_core.js` viewer and morph
  runtime) embedded over the stage.
- The pose can be adjusted interactively; `Save pose` (confirm) re-renders the mannequin
  with the stored settings and the new pose, then rebuilds the layer pixels and updates
  `poseData`. `Cancel` restores the previous render untouched.
- The embedded viewer is the only v1 editing path; handing the pose back to a linked
  Pose Studio node is deferred (see section 14).

## 8. Input tools

### 8.1 Brush-size gesture (Alt + right mouse)

- With a brush-family tool active (`brush`, `eraser`, `mask`): **Alt + right-button
  drag** adjusts `brushSize` — moving right grows it, moving left shrinks it
  (sensitivity ≈ 0.5 px radius per pointer px).
- Realtime feedback while dragging: the tool preview circle under the cursor plus a
  floating px badge; the `brushSize` slider syncs live. `pointerup` records one history/
  settings entry. `contextmenu` stays suppressed and the gesture never opens the HUD.

### 8.2 Radial HUD (right mouse)

- **Plain right-button hold** (no Alt) opens a radial HUD at the cursor. If Alt is held,
  the HUD must not appear — the size gesture owns that chord.
- The ring has four parameter sectors chosen by drag direction: up = size, right =
  opacity, down = hardness, left = foreground color. After selecting a sector, dragging
  adjusts that value live; release commits.
- `brushHardness` is a new brush-engine setting (radial-gradient stamps for soft edges;
  the current brush has a fixed edge).

## 9. Qwen-Image-2.1 provider + Spectrum

New `QwenImage21UniCanvasModule` (key `qwen_image21`):

- Model stack (official Qwen-Image-2.1 architecture, ComfyUI-native weights from
  `Comfy-Org/Qwen-Image-2.1`): 7B / 32-layer single-stream DiT diffusion model,
  **Qwen3-VL 8B text encoder** (encodes both instructions and condition images), and
  the **64-channel RGBA image VAE** (16× spatial compression, native transparency).
  Loading follows ComfyUI core (≥ 0.37) node semantics (`UNETLoader`/`CLIPLoader`/
  `VAELoader` types for QI2.1).
- Sampling defaults: flow matching, `euler`/`simple`, 40 steps, native 2K aspect-ratio
  presets from the official table (2048×2048, 2400×1792, 1792×2400, 2528×1696,
  1696×2528, 2752×1536, 1536×2752).
- All draw modes work (`txt2img`, `img2img`, `inpaint`, `outpaint`; inpaint = img2img
  with mask paste-back like other modules).
- Reference editing uses `Edit model` references: working area = `<image1>`, references
  = `<image2..5>`, prompt in QI2.1 `<image N>` convention (the module assembles the
  instruction).
- **RGBA is the default output.** Every generation uses the transparent-RGBA prompt
  convention from the official Qwen space (`This is an RGBA image with transparency.
  … The image has alpha channel and the background is transparent.`) and staging keeps
  alpha, so accepted results are layers with real transparency. A switch (`opaque
  output`) exists for the rare case where alpha is unwanted; it disables the RGBA
  prompting and flattens the result.

Vendored Spectrum (`nodes/spectrum_qwen21/`, ported from
`awdqwdasdg/Comfyui-Spectrum-Qwen2.1`, MIT — attribution in code and README):

- Full package port: `config`, `chebyshev`, `constants`, `controller`, `forward`,
  `patcher`, `state`, `utils`. `apply_spectrum(model, SpectrumConfig(...))` runs after
  all model mutations (LoRA stack from `VNCSS_CONFIG`) and before sampling.
- UI panel `Spectrum acceleration`: toggle plus parameters (`warmup_steps`,
  `tail_actual_steps`, `window_size`, `flex_window`, `max_consecutive_forecasts`,
  `history_points`, `chebyshev_degree`, `ridge_lambda`, `blend_weight`, `cache_device`,
  `force_actual_on_control`, `debug`) with presets `moderate` (paper default),
  `aggressive`, `quality`. Only exposed for the QI2.1 family.
- Fail-closed exactly like upstream: any inability to prove a forecast is safe (or any
  exception) degrades that step to a real forward.

## 10. Layer utilities

### 10.1 Layer context menu (right-click on a layer row)

- `Copy layer as image to clipboard` — PNG (with alpha) to the system clipboard via
  `navigator.clipboard.write`.
- `Save layer as image` — writes the layer PNG to `output/`
  (`/vnccs/unicanvas/save_output?layer_id=…`).
- `Remove bg – QI2.1`, `Remove bg – BiRefNet` (see 10.3), `Color match to below`
  (see 10.4), `Rasterize` (pose layers only), `Edit pose` (pose layers only).

### 10.2 PSD import

- `Import PSD` button next to `Export Layers as PSD`, using `readPsd` from the vendored
  `ag-psd` bundle (same loader as the existing export).
- Mapping is limited to what UniCanvas supports: raster layers with name, visibility,
  opacity and blend mode (mapped to `globalCompositeOperation`), preserving order.
- Everything else is skipped and reported in the status line: clipping masks, adjustment
  layers (levels/curves/HSL etc.), layer effects, text/vector/smart-object layers without
  raster data.

### 10.3 Background removal (two buttons)

- `Remove bg – QI2.1` (preferred): runs the Qwen-Image-2.1 pipeline in RGBA subject
  extraction mode (the model natively extracts subjects from photographs) over the
  layer's pixels and applies the returned alpha. More precise, much better on hair.
  Requires a QI2.1 stack (via `VNCSS_CONFIG` or the built-in picker).
- `Remove bg – BiRefNet`: uses the existing `auto_mask_bgr()` BiRefNet-lite path from
  `vnccs_sam3d` (auto-downloads on first use) and applies the mask as alpha.
- Both are one-shot operations with progress in the status line and a single
  `layerPixels` history entry.

### 10.4 Color Match (ColorMatchV2-style)

- `Color match to below`: target = active layer pixels, reference = composite of visible
  layers below it (fallback: the composite without the active layer; if there is nothing
  to match against, show a status message and do nothing).
- Popover with methods (`mkl`, `hm`, `reinhard`, `mvgd`, `hm-mvgd-hm`, `hm-mkl-hm`,
  `reinhard_lab_gpu`) and a `strength` slider (0–10). Live preview on a scratch copy
  while dragging; commit on release (AGENTS.md realtime rule).
- Backend `POST /vnccs/unicanvas/color_match`: `color-matcher` (added to
  `requirements.txt`, same dependency as KJNodes) plus our torch implementation of
  `reinhard_lab_gpu`, with a pure-Reinhard (LAB mean/std) fallback if the dependency is
  unavailable.

## 11. Error handling

- Message format `[VNCCS UniCanvas] …`, matching VNCCS conventions.
- Fail fast before generation: `VNCSS_CONFIG` connected but incomplete (model/clip/vae
  not connected, references missing while `Edit model` is on for H3/QI2.1 editing),
  model files missing on disk, QI2.1 requested for `Remove bg – QI2.1` without a QI2.1
  stack, `Color match to below` with no layer below.
- Graceful degradation: no `/vnccs/list_characters` → mannequin only with a status chip;
  BiRefNet download failure → status error with retry; `ag-psd` load failure → error in
  status (the export path already falls back to CDN; import follows the same order).
- All asynchronous previews (pose render replacement, Color Match preview) follow the
  newest-wins rule: stale results are dropped.

## 12. Testing and verification

- `pytest` for backend additions: `VNCCS_Config` (LoRA stack application with fake
  loaders, `Edit model` socket sync), `MiniMaxH3UniCanvasModule` (working area = Picture
  1, references = Pictures 2..5), `QwenImage21UniCanvasModule` (registration, RGBA
  default vs opaque switch, reference wiring), `remove_bg` (both methods on small CPU
  tensors/mocks), `color_match` (all methods on small tensors), `save_output`.
- Spectrum's CPU unit tests are ported into `tests/` and must pass without a GPU.
- Frontend changes are verified on a live ComfyUI instance with **before/after
  screenshots** (same crop and scale, labeled exactly `Before` / `After`, measured
  element geometry listed beside the image, plus a standalone `After`). Evidence is
  hosted on an `evidence/<topic>` branch in the fork and linked from the PRs; local
  copies are kept in the workspace.

## 13. Delivery

- All work happens in `M4cd1r/ComfyUI_VNCCS_Utils` on `unicanvas-next` and its feature
  branches. English for every artifact that leaves the session (commits, PRs, code
  comments, tests, UI strings, screenshot labels).
- Five change packages (PR-sized): (1) `VNCSS_CONFIG` + H3 module, (2) fullscreen +
  standalone mode, (3) pose layers, (4) input tools + layer utilities, (5) QI2.1 +
  Spectrum. The implementation plan sequences them with review checkpoints.

## 14. Future work (explicitly deferred)

- Multi-character pose layers (Pose Studio scenes hold up to 4 characters).
- Built-in by-name loading of the MiniMax H3 stack (diffusion model + text encoder + audio VAE
  picker) for config-free H3 region edits.
- Handing pose-layer edits to a linked Pose Studio node instead of the embedded viewer.
- Reference images sourced from canvas layers instead of node sockets.
- Per-layer masks / clipping masks and the other rejected feature candidates.
