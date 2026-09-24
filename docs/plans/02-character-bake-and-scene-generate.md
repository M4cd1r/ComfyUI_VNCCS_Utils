# Plan 02 - Character bake and scene Generate

## Goal

Edit models (Qwen Image 2.1, MiniMax H3, Qwen Image Edit, Flux Klein) look at the **whole
scene** at once: the working area is `Picture 1` and the prompt is an instruction. The plan
keeps that model and adds one thing on top: **every mannequin can turn itself into its
character** ("bake"). The final **GENERATE** then works on a scene where every character
has already been rendered.

In short:

1. A pose layer (one or more mannequins, plan 01) with a selected VNCCS character can be
   **baked** on demand: the mannequin render is replaced by that character, generated with the
   character recipe, in exactly the same pose, silhouette and placement.
2. If a character is selected but **not baked yet** (or its bake is stale because the pose
   changed), pressing the main **GENERATE** first bakes every such character, in order, and
   then runs the normal scene generation over the composited result.
3. Mannequin-only layers (character `Mannequin`, no identity) are never auto-baked. They are
   pose guides and stay as they are.

This replaces the "regional prompts" idea. There is no regional conditioning. Identity is
isolated per character by the bake, and scene coherence comes from the scene edit.

## What already exists

- `generateCharacterFromPoseLayer(layer)` in `web/vnccs_unicanvas.js` (near the end of the
  widget class): it reads `layer.poseData.character`, builds the prompt from
  `settings.char_gen_prompt` (`{character}` substitution), sends `img2img` to
  `POST /vnccs/unicanvas/draw` with the char-gen recipe (`char_gen_mode`,
  `char_gen_ckpt_name`, the LoRA, steps/cfg/sampler/scheduler), and **overwrites the layer
  pixels**. This is the prototype of bake. It currently destroys the mannequin render and has
  no state.
- The settings popover (`openUniCanvasSettings`) already holds the character-generation
  recipe.
- `draw()`: the main GENERATE path (direct `/vnccs/unicanvas/draw` or a queued prompt with a
  linked `VNCSS Config`), then `_stageGeneratedImages` and the staging popover.
- Plan 01 adds per-character ID masks (`getPoseLayerCharacterMask`) and solo renders.

## Bake data model

Each pose layer gets `layer.bake`, serialized with the layer:

- `status`: `none` | `baked` | `stale` | `failed`.
- `characters`: per character id, `{ status, poseHash, recipeHash, seed, bakedAt, error? }`.
  A single-character layer has one entry.
- `showMannequin`: a boolean view toggle (default false once baked).

The layer keeps **two pixel sources**:

- `layer.mannequinCanvas`: the mannequin render produced by Save pose / the bridge. This is
  what today lives in `layer.canvas`.
- `layer.bakedCanvas`: the composited baked characters, the same size and placement as the
  mannequin canvas.

`layer.canvas` (what the renderer, export, thumbnails and generation read) points at
`bakedCanvas` when `status` is `baked` or `stale` and `showMannequin` is false. Otherwise it
points at `mannequinCanvas`. Switching never copies pixels. It swaps the reference and calls
`invalidateLayerCaches`. Both canvases are serialized as crops (`mannequinDataURL`,
`bakedDataURL`). Old states without them load with `mannequinCanvas = canvas` and
`status = none`.

**Hashes:** `poseHash` is a stable hash of that character's pose + transform + morphs +
identity + the shared camera + render size. `recipeHash` is a hash of the char-gen settings
and the identity reference (below). After every Save pose / bridge final capture, each
baked character whose `poseHash` changed becomes `stale`. A recipe change marks all baked
characters stale. `stale` keeps showing the old baked pixels (last valid frame) with a badge.
It never flashes back to the mannequin.

## Identity reference

For a stable identity the bake must see the character, not only its name:

- A character's identity reference image is resolved in this order: (1) an image field on the
  `/vnccs/list_characters` entry, if the VNCCS pack provides one (`image`, `preview`, `sheet`;
  read whatever exists, do not require it); (2) a user-assigned reference stored in UniCanvas,
  set from the pose layer panel ("Set identity reference..." takes a canvas layer or an
  uploaded file) and kept per character id in the project asset library (plan 10) or, before
  plan 10 lands, in `settings.char_identity_refs` as a server-cached image id; (3) none, meaning
  prompt + LoRA only, and the panel shows "no identity reference" as a warning, not an error.
- With edit-model families the reference goes in as `Picture 2`, and the bake prompt template
  gains a `{reference}` token that expands to the family's convention (`<image2>` for Qwen
  Image 2.1, `<Picture 2>` for H3/others). The default template becomes: "Render
  {character} from {reference} in exactly the pose, framing and silhouette of the mannequin in
  {working}. Full body, clean lineart, flat background." `{working}` expands to the working
  image token. The template lives in `settings.char_gen_prompt` as today.

## Bake pipeline (one character)

1. **Source:** a solo render of that character (the other characters hidden) from the pose
   data. It uses an offscreen `PoseViewerCore` with the same camera and size, reusing the
   capture path from `vnccs_unicanvas_pose_layers.mjs`. The solo render gives the model the
   full body, including parts occluded by other characters.
2. **Generate:** `POST /vnccs/unicanvas/draw`, `img2img` with the char-gen recipe, the solo
   render as the working image, and the identity reference as `Picture 2`. RGBA output is
   requested where the family supports it (Qwen Image 2.1 default). Otherwise the result goes
   through the configured background removal backend (the existing `remove_bg` route, same
   settings) so the baked character has alpha.
3. **Align:** the generated image is placed back on the solo render's alpha bbox. If the
   bbox of the result alpha differs by more than 3% in size or 2% in position (a model
   drift), it is fitted onto the mannequin bbox anchored on the feet contact point. The
   mannequin silhouette is authoritative.
4. **Composite:** into `bakedCanvas`, clipped by that character's **visible** ID mask from
   plan 01, dilated by 2 px to avoid seams. Occlusion therefore matches the 3D scene exactly.
   Characters are composited back-to-front by camera depth of their torso anchors.

A single-character layer skips the clipping step (its mask is its alpha).

## UX

- **Pose layer panel** (the existing panel from `renderUniCanvasPoseLayerPanel`): each
  character row shows its bake chip: `mannequin` / `baked` / `stale` / `baking...` /
  `failed`. Per-row actions are **Bake** and **Re-bake** (new seed), plus a **Show
  mannequin** eye toggle on the layer.
- Layer context menu: `generate-character` is renamed **Bake characters** and bakes every
  character on the layer that has an identity. The old action id stays as an alias so
  persisted keyboard/menu references keep working.
- **Bake is staged, not blind:** a manual bake result goes through the staging popover
  (accept / discard / next), exactly like GENERATE, shown in place over the layer. With
  `batch_size > 1`, the variants are staged and cycled. Accept writes `bakedCanvas` and the
  `baked` status as one undo entry.
- Progress: the existing generation progress bar with `Baking <name> (i/n)`.

## GENERATE with pending characters

`draw()` gets a **pre-pass**:

1. Collect bake candidates: visible pose layers inside the generation bbox (any overlap)
   whose characters have a VNCCS identity and status `none`, `stale` (when
   `settings.rebake_stale_on_generate`, default true) or `failed`.
2. If there are none, run GENERATE exactly as today.
3. If there are some, the GENERATE button shows a small count badge before the click
   ("+2 bakes") so the cost is visible. On click, the candidates are baked sequentially
   (auto-accept the first result, no staging per character, because the user asked for the
   whole scene). Each result is written to its layer as one undo entry per layer, grouped
   under one "Generate scene" history group (below).
4. Then the normal scene generation runs on the updated composite, and its results go to
   staging as today. The scene prompt is untouched. Nothing is injected into the user's
   instruction.
5. Cancel/failure: if a bake fails, GENERATE stops before the scene pass, the failed
   characters are marked `failed` with the error on their chip, and the successful bakes are
   kept.

**History group:** add a `historyGroup` entry kind that wraps several entries and
undoes/redoes them as one step. It is needed because one click produced several layer
changes. `applyHistoryEntry` handles it by applying the children in order (reverse order on
undo).

**Queued mode (linked `VNCSS Config`):** bakes always use the direct
`/vnccs/unicanvas/draw` route with their own char-gen recipe, because the char-gen recipe is
independent of the linked graph. The scene pass then queues as today. In standalone mode
everything is direct.

## Where the code goes

- New `web/vnccs_unicanvas_bake.mjs`: the bake state model, hashes, identity reference
  resolution, the solo render + generate + align + composite pipeline, the pre-pass collector,
  and the panel chips. It is installed from the widget constructor.
- `web/vnccs_unicanvas.js`: `generateCharacterFromPoseLayer` becomes a thin delegate to the
  bake module. `draw()` calls the pre-pass before building the draw context. Serialization
  covers `bake`, `mannequinDataURL` and `bakedDataURL`. `applyHistoryEntry` handles
  `historyGroup`.
- `web/vnccs_unicanvas_pose_layers.mjs`: marks bakes stale after save/bridge-final, exposes
  the solo render.
- `nodes/unicanvas.py`: no new generation route. The existing `draw` payload already carries
  reference images for edit families (the edit reference slots). Add
  `GET /vnccs/unicanvas/character_reference?id=` only if the identity reference is stored
  server-side before plan 10 exists.

## Tests (CPU lane, generation stubbed)

- `bake.spec.mjs`: stub `/vnccs/unicanvas/draw` with `page.route`, returning a fixture RGBA
  PNG. Then:
  - Manual bake stages, accept -> the layer shows baked pixels and `status: baked`.
  - Toggle Show mannequin -> pixels switch with no history entry.
  - Edit the pose and save -> `stale`, and the baked pixels stay visible.
  - Two characters -> the composite respects the ID masks (the pixels of character A never
    appear inside B's visible mask).
  - GENERATE with one unbaked and one mannequin-only layer -> exactly one bake request plus
    one scene request, in that order, and one undo step reverts everything.
  - A bake failure -> no scene request, `failed` chip.
- Evidence topic `character-bake`: before = two mannequins, after = baked characters (the
  fixture PNG in E2E; a real Lane B render for the PR description).

## Acceptance

- Baking never moves or rescales a character. The mannequin silhouette and placement are
  authoritative (the same 5% bbox tolerance as the bridge spec).
- GENERATE on a scene with unbaked characters produces the scene in one click. One undo
  reverts it.
- The mannequin render is never lost and can be shown again at any time.

## Out of scope

- Regional prompting or attention masking in the scene pass.
- Automatic identity reference extraction from arbitrary images.
- Baking non-pose raster layers.
