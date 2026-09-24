# Plan 02 - Character bake and scene Generate

## Goal

Edit models look at the **whole scene** at once: the working area is `Picture 1` and the prompt
is an instruction. This plan keeps that model and adds one thing on top: **every mannequin can
turn itself into its character** ("bake"). The final **GENERATE** then works on a scene whose
characters are already rendered.

1. A pose layer mannequin with a bound character reference (plan 01; the single
   `layer.pose.character` today) can be **baked** on demand. The mannequin render is replaced
   by that character, generated in the same pose and placement, and the live 3D scene is kept.
2. If a character is bound but **not baked yet**, or its bake is **stale** because the pose
   changed, the main **GENERATE** first bakes every such character, and then runs the normal
   scene generation over the composite with the baked characters.
3. Mannequins **without** a character reference are pose guides. They are never baked, and they
   are left out of the scene pass composite (see below).

This replaces the earlier "regional prompts" idea. There is no regional conditioning: the bake
isolates identity per character, and the scene pass gives coherence.

## What already exists (current code)

- `draw()` in `web/vnccs_unicanvas.js` picks **one** pose layer (`poseGenerationLayer`: the
  active one, or the first visible pose layer intersecting the bbox). It checks
  `poseCharacterIssue`, requires `qwen_image_edit` (QiE2511) or `flux_klein` (Klein9b), calls
  `UniCanvasPoseEditor.generation(layer, inferenceSize)` and sends
  `pose_edit { image1, image2 }` with `positive` from `generatePromptFromLights` and
  `denoise: 1`. The result is staged like any generation. **That call is already a bake of one
  pose layer over the bbox.** This plan turns it into a per-character, per-layer, stateful
  operation.
- `nodes/unicanvas/draw.py`: `_prepare_pose_edit_images` validates the two-image contract, and the
  QiE2511/Klein9b adapters consume `_pose_edit_images`.
- Remove background backends (`/vnccs/unicanvas/remove_bg`: edit model / BiRefNet / rembg /
  SAM 3, chosen in the settings popover).
- Plan 01: `characterRefs`, `getPoseCharacterMask`, `captureSoloPass`, `captureIdPass`.

## Bake data model

Each pose layer gets `layer.pose.bake`:

- `characters`: a map from a studio character id to `{ status: "none" | "baked" | "stale" |
  "failed", poseHash, refHash, seed, model, bakedAt, headRect?, error? }`.
- `showMannequin`: a boolean view toggle.

Pixel sources on the layer:

- `layer.mannequinCanvas`: what `capturePreview` produces today. `capturePreview` writes here
  instead of into `layer.canvas` directly.
- `layer.bakedCanvas`: the composited baked characters in the same layer space.
- `layer.canvas` (read by the renderer, flatten, export, thumbnails and the E2E hook) is a
  **composite view**. Where a character is baked and `showMannequin` is false, its baked pixels
  are shown. Unbaked characters show their mannequin pixels (cut with their ID masks). A
  single-mannequin layer simply swaps canvases. The view is rebuilt only when one of its
  inputs changes, and a swap is a reference change plus `invalidateLayerCaches`, not a copy per
  frame.
- **While the Pose tool is active on the layer**, the mannequin is shown (you are editing the
  pose). Leaving the tool shows the baked pixels again.
- Serialization: `mannequinDataURL` and `bakedDataURL` crops go to the state cache (never to
  workflow metadata), and `bake` goes into `serializePose`. Old layers load with
  `mannequinCanvas = canvas` and no bake entries.

**Hashes and staleness:** `poseHash` covers that character's pose, mesh, transform and
animation frame, plus the shared camera (`viewport`), `rect` size and lights. `refHash` covers
the bound reference (layer id + that layer's pixel revision, or the upload data hash) and the
identity prompt. After every `commit()`, a baked character whose `poseHash` or `refHash`
changed becomes `stale`. A stale bake keeps showing the old baked pixels (last valid frame) with
a badge. It never flashes back to the mannequin.

## Bake pipeline (one character)

The pipeline reuses the existing `pose_edit` contract. It adds no new model path.

1. **Working rect:** the pose layer's `rect` (not the generation bbox), expanded by 10% and
   clamped to the world. Inference size follows the same scale rules as `getInferenceSize`,
   applied to that rect.
2. **image1:** `captureSoloPass` of that character (the full body even where others occlude
   it) over the studio background color. This is what `generation()` builds today, restricted
   to one character.
3. **image2:** the lower visible composite (`poseLayerBelow`) plus **that character's**
   reference, laid out exactly as `composePoseReference` does today.
4. **Prompt:** the studio pose prompt plus that character's identity prompt plus lights,
   through `generatePromptFromLights`. The scene Prompt field is **not** used for bakes.
5. **Model:** the current engine when it is QiE2511 or Klein9b. Otherwise it is the **Bake
   model** from the settings popover (a new "Character bake" group: family QiE2511 / Klein9b,
   the preset card, and optional steps/cfg overrides). The default is the first *ready* preset of
   those families. This removes today's "Pose layers require QiE2511 or Klein9b ... or hide the
   pose layer" block for the scene pass, because only bakes need those families.
6. **Extract:** the result is a full working-rect image. The character is cut out with the
   configured remove-background backend on the crop around the dilated solo silhouette (+15%).
   The alpha component overlapping the mannequin silhouette is kept, and the rest is dropped.
   Hair and clothes extending past the mannequin are kept because the component is taken from
   the generated alpha, not from the mannequin.
7. **Composite:** into `bakedCanvas`, clipped by that character's **visible** ID mask (plan 01)
   dilated by the extent of the generated alpha beyond the silhouette, so occlusion by other
   mannequins matches the 3D scene. Characters are composited back to front by camera depth.
8. **Head rect:** the projected head bone box of that character at bake time is stored as
   `headRect` (used by plans 03 and 07).

## UX

- **Character reference card** (plan 01 rows): each row gets a bake chip (`mannequin` /
  `baked` / `stale` / `baking…` / `failed`) and **Bake** / **Re-bake** (new seed) actions.
  The layer row gets a **Show mannequin** toggle.
- Layer context menu: **Bake characters** (pose layers) bakes every bound, unbaked or stale
  character of that layer.
- **A manual bake is staged:** the result appears in the staging popover in place (accept /
  discard / next, with batch variants). Accept writes the bake as one history entry.
- Progress: the existing progress bar, showing `Baking <name> (i/n)`.

## GENERATE

`draw()` gets a **bake pre-pass** that replaces the current single-pose branch:

1. Collect candidates: visible pose layers intersecting the bbox. For each bound character
   with status `none`, `failed` or `stale`, a bake is needed. Stale characters are included by
   default, and the setting `rebake_stale_on_generate` can turn that off.
2. The GENERATE button shows the pending count ("+2 bakes") before the click, so the cost is
   visible.
3. On click the candidates bake sequentially. Each result is **auto-accepted** (the user asked
   for the whole scene) and written as one entry, and all of them are wrapped in one
   `historyGroup` together with the scene pass acceptance later.
4. **Scene pass:** runs the normal `draw()` path with the current engine over the bbox
   composite in which pose layers show their baked pixels. **Guide-only mannequins** (no
   reference) are excluded from the composite, with a status note ("1 pose guide not
   rendered"). The scene Prompt is the edit instruction. If the Prompt field is empty, the
   scene pass is skipped and GENERATE ends after the bakes ("Characters baked; add a prompt to
   run a scene pass").
5. A split GENERATE menu (a small chevron) offers **Bake characters only** and
   **Generate (bake + scene)** (the default).
6. Failure: if any bake fails, the scene pass does not run. Failed characters are marked with
   the error on their row, and successful bakes are kept.

**`historyGroup`** is a new entry kind in `applyHistoryEntry`: it applies its children in order
and undoes them in reverse. One click = one undo step. Plans 01, 03, 05 and 10 reuse it.

**Queued mode** (linked `VNCSS Config`): bakes always use the direct `/vnccs/unicanvas/draw`
route with the bake model, because the bake does not depend on the linked graph. Only the scene
pass is queued, as today. **Panorama mode:** bakes run in the pose layer's own camera
(`poseAtPanoramaCamera`). A pose shown at another panorama angle is baked from its original
camera and projected like its pixels are today.

## Where the code goes

- New `web/vnccs_unicanvas_bake.mjs`: the bake state, hashes, the pipeline, the pre-pass
  collector, the staging integration, and the chips/actions on the card rows.
- `web/vnccs_unicanvas_pose.mjs`: `capturePreview` targets `mannequinCanvas` and triggers the
  view rebuild. It exposes the solo/ID passes (plan 01) and the head bone projection.
  `generation()` becomes the one-character building block used by the bake module.
- `web/vnccs_unicanvas_pose_state.mjs`: the bake serialization in `serializePose` /
  `mergePoseCache`, and the composite view builder.
- `web/vnccs_unicanvas.js`: the `draw()` pre-pass and scene pass rules, `historyGroup`,
  the GENERATE split menu, the settings popover "Character bake" group, and serialization of
  the two canvases.
- `web/vnccs_unicanvas_layer_tools.mjs`: the `bake-characters` menu item.
- `nodes/unicanvas/draw.py`: none required. `_prepare_pose_edit_images` already takes arbitrary
  sizes that match `inference_size`.

## Tests (CPU, generation stubbed)

- `bake.spec.mjs`, with `page.route` stubbing `/vnccs/unicanvas/draw` (a fixture PNG of a
  character over a background) and `/vnccs/unicanvas/remove_bg` (a fixture alpha):
  - Manual bake -> staged -> accept -> the layer shows baked pixels and its status is `baked`.
    The request carries `pose_edit` with the solo image1.
  - Toggle Show mannequin -> the pixels switch and no history entry is added.
  - Edit the pose -> `stale`, and the baked pixels are still visible.
  - Two mannequins -> the baked pixels of A never appear inside B's visible mask.
  - GENERATE with one bound and one guide mannequin plus a prompt -> exactly one bake request,
    then one scene request whose image contains no guide mannequin pixels. One undo reverts
    everything.
  - Empty prompt -> bakes only.
  - A failed bake -> no scene request, and the row shows the error.
- `smoke.spec.mjs` / `pose-backdrop.spec.mjs` stay green.
- Evidence topic `character-bake`: before = two mannequins in a scene, after = baked (the
  fixture in E2E; a real Lane B render for the PR description).

## Acceptance

- Baking never moves a character: the baked alpha bbox stays within 5% of the mannequin
  silhouette bbox (the same tolerance as the other placement guarantees).
- GENERATE on a scene with unbaked characters produces the scene in one click and one undo.
- The mannequin and the 3D scene are never lost. The pose stays editable after baking.

## Out of scope

- Regional prompting or attention masking in the scene pass.
- Per-frame baking of animations (plan 06 uses 2D motion and sprite variants).
- Baking plain raster layers.
