# Plan 05 - Layer groups and auto naming

## Goal

Two things that belong together:

1. **Layer groups (folders)**: nested groups in the layer stack. You can collapse them, hide
   them, set their opacity, move them as a whole and drag layers in and out.
2. **Automatic naming and filing**: layers and folders name themselves ("Eileen - happy",
   "Night street background", "Rain overlay") and land in the right semantic folder
   (Background / Characters / Props / Effects / Overlays). It uses layer provenance first and
   a **small local LLM** (text) or **small VLM** (vision) when provenance is not enough.

A VN scene with several characters, sprite sets and states quickly has 30+ layers. Today the
list is flat, with only two fixed sections (masks and rasters), and names are
"Layer 7".

## What already exists

- `widget.layers` is a flat array. `normalizeLayerOrder` keeps masks first. `getLayerInsertIndex`
  / `insertLayerByType` place new layers. `reorderLayer(sourceId, targetId, placement)` with
  `getLayerDropPlacement` (before/after) implements row drag-and-drop.
- `renderLayerList` builds two fixed sections (`createLayerGroupHead`,
  `createLayerGroupEmpty`, `attachLayerGroupDrop`). These are the mask/raster *sections*,
  not user groups. The CSS names `.vnccs-uc-layer-group*` are taken, so user groups use
  `.vnccs-uc-folder*`.
- `getNextLayerName(type)` generates "Layer N" style names.
- Layer rows: `createLayerRow` / `updateLayerRow` / `refreshLayerRow`, with inline rename.
- `transformers` and `huggingface_hub` are already in `requirements.txt`. The BiRefNet path in
  `nodes/unicanvas/remove_bg.py` shows the lazy-download-on-first-use pattern.

## Part A - Layer groups

### Data model

- A new layer type **`group`**: `{ id, name, type: "group", visible, locked, opacity,
  blendMode, collapsed, groupId, nameSource, meta }`. It has no canvas.
- Every non-mask layer (including groups) gets an optional `groupId` (the parent group id,
  null at the root). Maximum nesting depth is 3.
- **Order invariant:** the flat `layers` array keeps its current meaning. A group's
  descendants are **contiguous and directly follow the group entry**, in the same top-to-bottom
  order as the root. `normalizeLayerOrder` is extended to enforce it (masks first, then the
  root sequence with each group's subtree expanded in place). Every mutation (add, delete,
  reorder, duplicate, accept staging, PSD import) goes through it, so all existing code that
  iterates `layers` keeps working.
- Mask layers never belong to a group. They stay in the mask section, because generation reads
  them globally.
- `groupId` and the group entries are serialized in `serializeLayer` (groups serialize without
  pixel data) and restored by `applySerializedState`. Old states have no groups and load
  unchanged.

### Rendering

- **Pass-through** (default `blendMode: "pass-through"`, opacity 1): children are drawn
  directly in stack order, exactly as today. There is no extra cost.
- **Isolated** (group opacity < 1 or a non pass-through blend mode): the group's visible
  children are composited into a scratch canvas covering the visible world rect, and that
  canvas is drawn with the group's opacity and blend. The same logic applies in
  `drawFlattenedLayers` (export/generation), so the output matches the viewport. This is plain
  group compositing, not a clipping mask or an adjustment layer.
- Effective visibility is the group chain's visibility AND the layer's own. Effective lock is
  the chain's lock OR the layer's own. Painting tools refuse a locked or hidden effective
  target with the existing status message pattern.

### Layer panel UX

- Folder rows: a disclosure triangle, a folder icon, the name, the eye, the lock and an opacity
  readout. Children are indented 12 px per depth level. Collapsed groups hide their children
  rows. Collapse is not history and is persisted as a UI preference.
- Drag and drop: the existing before/after placement plus an **inside** placement (the middle
  third of a folder row) that files the layer into the group at its top. Dropping a group into
  its own descendant is refused.
- **Multi-selection** for group operations: Ctrl/Cmd+click toggles, Shift+click selects a
  range (`widget.selectedLayerIds`). The active layer (the painting/transform target) stays
  single, and it is the last clicked.
- Commands:
  - **Group selected** (`Ctrl+G`): a new group at the topmost selected position.
  - **Ungroup** (`Ctrl+Shift+G`): children move to the parent at the group position.
  - **New empty group**.
  - **Duplicate group** (deep).
  - **Delete group**, with a choice: delete contents / keep contents.
  - **Flatten group to layer**: renders the isolated group into a new raster layer that
    replaces the group.
- **Move tool on a group** (or on a multi-selection) moves all children together as one
  gesture, with realtime preview through the existing move preview path per child, committed
  as one history entry. Scale/rotate of a whole group is out of scope for v1.
- Group opacity: a slider in the layer subhead (the same control as layers), live while
  dragging, one history entry per gesture.

### Undo

New history kinds: `groupStructure` (a before/after snapshot of the `{ id, groupId, order }`
triples plus created/removed group entries). It is used for group, ungroup, reparent (drop
inside), delete group (keep contents) and organize (Part B). Group property changes (visibility,
opacity, blend, name) reuse the existing layer property entry path. Deleting a group with
contents and duplicating it reuse the existing add/delete layer entries wrapped in
`historyGroup` (plan 02).

## Part B - Automatic naming and filing

### Provenance first (no model needed)

Most layers already know what they are. Plan 10 phase A adds `layer.meta` (origin, prompt,
character, source file, generation mode). Names derive from it deterministically:

- Pose layer: the name of the bound character reference (the reference layer's name, the
  uploaded file stem, or the library character name), `<A> & <B>` for several bound mannequins
  (plan 01), and `Pose` when nothing is bound. Studio character names set in Pose Studio win
  over file stems when the user changed them from the default "Main Character" / "Character N".
- Sprite layer: `<Character>`. The active variant shows as a suffix chip, not in the name.
- Baked result: `<Character> (baked)` only while the mannequin is also shown. Otherwise
  `<Character>`.
- Imported file / PSD layer: the file stem / PSD layer name (never overwritten by the model).
- Duplicate: `<source name> copy`.
- Accepted staging result: needs the model (a summary of the prompt), with a fallback to the
  first 4 meaningful prompt words.
- Painted layer (no provenance): needs the vision model, with a fallback to `Paint <N>`.
- Color match / remove background derived layers keep the source name.

Each layer gets `nameSource`: `auto` | `user` | `import`. An inline rename sets `user`. Auto
naming **never** touches `user` or `import` names. A context menu item "Auto-name" resets a
layer to `auto` and names it again.

### The small models

A backend service in `nodes/unicanvas/describe_layers.py`, `POST /vnccs/unicanvas/describe_layers`, handles
batch requests: `[{ layerId, kind, prompt?, character?, thumbnail? }]` ->
`[{ layerId, name, category, confidence }]`.

- **Text LLM** (default): `Qwen/Qwen3-0.6B` (Apache-2.0) through `transformers`, CPU-capable
  and GPU when available. It is lazy-downloaded with `huggingface_hub` into
  `models/LLM/Qwen3-0.6B/` on first use (the same UX as the BiRefNet auto-download: a status
  line "Downloading naming model..."). Thinking mode is disabled. The prompt is a fixed
  system instruction plus the generation prompt. It must answer with one JSON object
  `{"name": "<2-5 words, Title case>", "category": "<one of the list>"}`. Decoding is greedy,
  max 40 new tokens. The output is parsed strictly. On any parse failure the rules fallback is
  used, never a raw model string.
- **Vision model** (optional, for layers without a prompt): `HuggingFaceTB/SmolVLM-256M-Instruct`
  (Apache-2.0), same download pattern into `models/LLM/SmolVLM-256M-Instruct/`. The input is
  the layer's alpha-cropped thumbnail at 384 px on a neutral gray background, with the same
  JSON contract.
- Both models are loaded once, kept in a module-level cache and unloaded after 10 minutes idle
  (a timer), and they share ComfyUI's model management only for device selection
  (`comfy.model_management.get_torch_device`). They never evict diffusion models. The
  service runs in `asyncio.to_thread` and serializes requests with a lock.
- **Categories** (fixed list, used as the folder names): `Background`, `Characters`,
  `Props`, `Effects`, `Lighting`, `Overlays`, `Other`.

Settings (gear popover, a new "Layer naming" group): `Auto naming: Off / Rules only /
Rules + LLM (default) / Rules + LLM + vision`, and `Auto-file new layers into folders`
(default on). Nothing is ever downloaded unless the chosen level needs it.

### When naming runs

- On layer creation (accept staging, import, paint layer first stroke commit, bake,
  create sprite) the layer gets its rules/fallback name immediately, and a background request
  refines it. Results for layers that were deleted, renamed by the user or re-generated in the
  meantime are dropped (a per-layer `nameToken`). The newest request wins.
- Requests are batched (debounced 800 ms, max 16 layers per call). Naming never blocks the UI
  and never creates history entries. A name that changes by itself is metadata, and undoing a
  layer add removes the layer anyway.
- Group names: a group created by the user starts as `Group N`. When all its children share a
  character, it is named after the character. Otherwise its name comes from the LLM, fed with
  the child names ("name this folder in 1-3 words"). Only groups with `nameSource: auto`.

### Filing (auto-organize)

- **Auto-file new layers** (setting on): a new layer goes into the root folder of its category,
  created on demand. Character-linked layers (pose, sprite, baked, with `meta.character`) go to
  `Characters / <Character name>`. Filing is part of the layer's creation history entry, so
  undoing the add also removes an empty folder that was created for it.
- **Organize layers** (a button in the Layers section header): computes a filing plan for
  **all** root-level unfiled layers. It shows a preview dialog listing `layer -> folder` with
  checkboxes and applies the checked moves as one `groupStructure` history entry. Existing
  user folders are never renamed or dissolved. Layers already inside a user folder are never
  moved.
- Stacking: folders are placed in a canonical order at creation (Overlays, Effects, Lighting,
  Characters, Props, Background, from top to bottom). The user may reorder them afterwards, and
  auto-filing respects the new order.

## Where the code goes

- New `web/vnccs_unicanvas_groups.mjs`: the group type, order invariant helpers, isolated
  compositing helper, folder rows, drag-inside, multi-select, group commands and shortcuts.
- New `web/vnccs_unicanvas_naming.mjs`: provenance rules, the request batching and stale-drop
  logic, filing and the Organize dialog.
- `web/vnccs_unicanvas.js`: `normalizeLayerOrder` delegates to the groups module. Hooks in
  `renderLayerList` / `createLayerRow` (indent, folder rows, multi-select), in the render and
  flatten loops (isolated group compositing), in the move tool (group move), and in
  serialization and history.
- `nodes/unicanvas/describe_layers.py` (registered in `routes.py`): the `describe_layers` route, model download/cache/unload, and the
  prompt templates.
- `web/vnccs_unicanvas_modes.mjs`: `Ctrl+G` / `Ctrl+Shift+G`.

## Tests

- `layer-groups.spec.mjs` (CPU):
  - Group two layers -> the order invariant holds and the composite is pixel-identical.
  - Group opacity 0.5 -> the composite equals the isolated reference.
  - Hide the group -> the children are hidden in the export.
  - Drag inside / out.
  - Move the group -> all children move, with one undo.
  - Nested depth 3 is allowed and depth 4 is refused.
  - Reload -> the structure persists. A legacy state loads with no groups.
- `auto-naming.spec.mjs` (CPU, `describe_layers` stubbed): accept a staging result -> the
  fallback name appears immediately, then the stubbed name. A user rename is never
  overwritten. Deleting a layer before the reply -> no error, and the reply is dropped.
  Organize -> preview -> apply -> one undo reverts it.
- Backend unit test (pytest, no download): the strict JSON parser and the rules fallback on
  malformed model output.
- Evidence topic `layer-groups`: before = a flat list of 14 layers, after = organized
  folders.

## Acceptance

- Groups behave like Photoshop groups for visibility, opacity, move and structure, with
  pixel-identical pass-through compositing.
- Names are meaningful without any model (rules only), and better with the model.
- User names are never overwritten. The model is never downloaded unless enabled.

## Out of scope

- Clipping masks, per-layer masks and adjustment layers (rejected).
- Group scale/rotate transforms (v1).
- Cloud LLMs of any kind.
