# Plan 03 - Sprite sets

## Goal

A VN character appears as a **sprite**: the same body in the same place, swapped between
expressions (neutral, happy, sad, angry, surprised, embarrassed...) and sometimes outfits or
poses. The plan adds a **sprite layer**: one layer that holds a named set of pixel-aligned
variants of one character, shows one active variant at a time, and generates missing variants
from the base.

The key property is **alignment**. Every variant shares one canvas rect and one anchor, so
switching the variant never makes the character jump. The same alignment carries into any
later export (plan 09, deferred).

## What already exists

- Baked pose layers (plan 02) give a character rendered from a known pose, with the mannequin
  silhouette as ground truth and a feet anchor.
- The edit-model families and the reference-image slots (`Picture 2..5`).
- Staging (`addStagingItem`, the staging popover with accept / discard / next).
- The layer stack, thumbnails (`getLayerThumbnailCanvas`) and the layer context menu
  (`LAYER_MENU_ITEMS`).
- Inpaint with a mask: generating only the face region keeps the body pixel-identical.

## Data model

A new layer type **`sprite`**:

- `canvas`: always the **active variant's** pixels (so every existing reader works unchanged:
  render, flatten, export, generation composite, thumbnails).
- `sprite`: `{ schemaVersion, characterId, characterName, anchor, rect, activeVariantId,
  variants: [...], faceRect, sourceLayerId? }`.
  - `rect`: the shared world rect of all variants (x, y, width, height). Variants are always
    stored at exactly this size.
  - `anchor`: `{ x, y }` in rect space. Default is the feet contact point (bottom center of the
    alpha bbox, refined to the lowest opaque rows). It is used by plans 04, 06 and 08.
  - `faceRect`: the head/face region in rect space. For sprites created from a baked pose layer
    it is the bake's `headRect` (plan 02: the head bone box projected through the capture camera
    at bake time, +15% margin). Otherwise it is set by the user with a rectangle drag in the
    sprite panel. It is the default edit region for expressions.
  - `variants[]`: `{ id, name, kind: "expression" | "outfit" | "pose" | "custom", prompt,
    seed, status: "empty" | "ready" | "failed", pixels (runtime canvas), createdAt, meta }`.
    `meta` is the plan 10 provenance.
- Serialization: each ready variant is serialized as a crop PNG
  (`sprite.variants[i].dataURL`). `canvas` is not serialized separately. It is rebuilt from
  the active variant on load.

Sprite layers can be transformed like raster layers. A move or scale applies to `rect` and
to **all** variants (one transform, applied lazily per variant on activation, so a move stays
cheap). Brush and eraser paint into the active variant only. That is intended for fixing one
expression. A "Paint on all variants" toggle in the sprite panel applies body fixes
everywhere.

## Creating a sprite layer

- **From a baked pose layer** (context menu "Create sprite set", one baked character; split
  multi-character layers first, plan 01): the baked pixels become the `neutral` variant.
  `faceRect` comes from the bake's `headRect`, and the anchor comes from the projected feet
  bones (captured at bake time next to `headRect`). The pose layer stays (hidden) and is linked
  by `sourceLayerId`, so a re-pose plus re-bake can later regenerate the base.
- **From any raster layer** (context menu "Create sprite set"): the layer pixels become
  `neutral`, the anchor is detected from alpha, and `faceRect` is empty until the user drags it.
- The sprite layer lands in the character's group (plan 05) and takes the character's name.

## Generating variants

The **sprite panel** (shown in the left column when a sprite layer is active, like the pose
options section) lists variants as a thumbnail grid with the active one highlighted:

- **Preset expression list** (one click adds the whole set as `empty` variants): neutral,
  happy, laughing, smile closed eyes, sad, crying, angry, annoyed, surprised, shocked,
  embarrassed/blushing, thinking, smug, scared, sleepy. Each preset carries a short
  instruction ("same character, same pose, only change the facial expression to <x>, keep
  hair, clothes and lighting identical").
- **Custom variant**: a name + an instruction. `kind` is `outfit` for outfits, which uses the
  whole-body region instead of `faceRect`.
- **Generate missing** / per-variant **Generate** / **Regenerate**.

Pipeline for one variant:

1. Working image: the `neutral` variant (never the active one, so errors do not compound).
2. Region: for `expression` variants, an inpaint of `faceRect` with a soft-edged mask, so the
   body stays pixel-identical. For `outfit`, the full alpha with the face region protected.
3. Model: the current edit family (edit families are preferred; non-edit families use the
   masked inpaint path). The character's reference image (the pose layer's bound reference,
   plan 01, or the library character, plan 10) goes in as `Picture 2` when the family takes
   reference images.
4. Result: the generated pixels are composited over the neutral variant **only inside the
   region**, with the neutral alpha preserved (the silhouette cannot change for expressions).
   For outfits, the alpha is taken from the result after background removal and re-anchored
   on the feet anchor.
5. The result is staged in place on the sprite (staging popover). Accept stores it in the
   variant. With `batch_size > 1`, candidates are cycled like any staging.

**Generate missing** runs the pipeline sequentially for every `empty` variant and
auto-accepts the first result (the same rule as plan 02's GENERATE pre-pass), with progress
`Generating sprite <name> (i/n)`. Each accepted variant is one history entry, grouped into
one `historyGroup`.

## Switching variants

- A click on a thumbnail makes it active. `canvas` swaps to the variant pixels immediately
  with no reload and no flicker. The switch is a small `spriteVariant` history entry.
- Keyboard: with a sprite layer active, `,` and `.` cycle variants (added to the shortcut map
  in `web/vnccs_unicanvas_modes.mjs`, `TOOL_SHORTCUTS` / `handleUniCanvasShortcut`).
- Hover preview: hovering a thumbnail previews that variant on the canvas (realtime) without
  changing the active variant. Leaving restores it.
- Scene states (plan 04) store `activeVariantId` per sprite layer.

## Where the code goes

- New `web/vnccs_unicanvas_sprites.mjs`: the sprite type, creation, the panel, the generation
  pipeline, variant switching, and the shortcuts hook.
- `web/vnccs_unicanvas.js`: `addLayer` accepts type `sprite`. `serializeLayer` /
  `applySerializedState` handle `sprite`. `cloneHistoryLayer` and snapshot restore handle
  variants (clone variant canvases lazily: store references and copy on write, because sprite
  sets can be large). The transform tools apply to all variants through a hook from the
  sprites module.
- `web/vnccs_unicanvas_layer_tools.mjs`: menu items `create-sprite-set` (raster and baked pose
  layers) and `split-variant-to-layer` (sprite: copies the active variant into a new raster
  layer).
- `web/vnccs_unicanvas_pose.mjs` / `web/vnccs_unicanvas_bake.mjs`: the bake records store the
  projected head and feet points used for `faceRect` and `anchor`.
- `nodes/unicanvas.py`: none. It reuses the draw route with the existing inpaint mask payload.

## Tests (CPU, generation stubbed)

- `sprites.spec.mjs`:
  - Create a sprite set from a raster fixture -> neutral variant, detected anchor (the bottom
    center of the alpha within 2 px).
  - Add the preset expressions -> 15 `empty` variants.
  - Generate missing with a stubbed draw returning a fixture face patch -> every variant
    becomes `ready`, pixels outside `faceRect` are bit-identical to neutral, and the alpha is
    identical.
  - Switch variants -> the canvas pixels change and the alpha bbox is identical across all
    variants (the no-jump guarantee).
  - Move the layer -> every variant moves (check the bbox after activating each one).
  - Undo after Generate missing -> one step restores the empty variants.
  - Save and reload the state -> variants and the active variant persist.
- Evidence topic `sprite-set`: a grid of 6 variants of one character, plus geometry showing
  identical alpha bboxes.

## Acceptance

- Variant switching never changes the alpha bbox or anchor.
- Expression variants never change pixels outside `faceRect`.
- Missing variants generate in one click with one undo step.

## Out of scope

- Eye/mouth animation frames (blink/talk). Plan 06 covers them at the timeline level with
  variant switching.
- Live2D-style mesh deformation.
- Export formats (plan 09, deferred).
