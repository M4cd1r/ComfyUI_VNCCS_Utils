# Plan 01 - Multi-character pose scenes

## Goal

Make **interactions between characters** a first-class UniCanvas workflow: one pose layer holds
up to 4 mannequins under a shared camera (a hug, a handshake, a fight, carrying someone, two
people at a table). **Each mannequin is bound to its own character reference**, and the scene
knows which pixels belong to which character.

## Why

Interactions are the hardest thing to get from image models. Two separate layers know nothing
about each other: hands do not meet, scale drifts, and occlusion is guessed. A shared 3D scene
gives exact contact points, consistent proportions and real depth ordering. Plan 02 then renders
every character of the scene with its own identity.

## What already exists (current code)

- **Live pose layers** (`docs/UNICANVAS_POSE_LAYERS.md`): `type: "pose"` layers carry
  `layer.pose = { version, rect, studio, character, viewport, ui, panoramaCamera }`.
  `studio` is the full Pose Studio scene schema, edited by a real embedded `PoseStudioWidget`
  (`web/vnccs_unicanvas_pose.mjs`, class `UniCanvasPoseEditor`: `activate`, `capturePreview`,
  `commit`, `flush`, `generation`, `release`). The layer pixels are the transparent viewport
  capture (`capturePreview` writes `layer.canvas` and `hiresCanvas`).
- **Multiple mannequins already work inside one pose layer:** Pose Studio's own Characters
  section manages up to `MAX_POSE_STUDIO_CHARACTERS = 4` mannequins
  (`web/vnccs_pose_characters.mjs`: `createPoseStudioCharacter` with `id`, `slot`, `name`,
  `color`, `transform`, `mesh`, `poses`, `animation`). They are stored in
  `layer.pose.studio.characters`.
- **One character reference per layer:** `layer.pose.character` is `{ source: "layer", layerId }`
  or `{ source: "upload", name, dataURL }`. It is set from the Character reference card
  (`buildCharacterMenu` / `refreshCharacterMenu`) and validated by `poseCharacterIssue`.
  Generation (`UniCanvasPoseEditor.generation` -> `pose_edit { image1, image2 }` ->
  `_prepare_pose_edit_images` in `nodes/unicanvas/draw.py`) sends the pose render as `image1` and
  the lower composite plus **the one** reference as `image2`. With several mannequins, the
  model cannot know which identity belongs to which mannequin. That is the gap this plan closes.
- The Pose Library (Scene tab) loads **scene assets with a `characters` array**
  (`activeCharacterFromSceneAsset`, the multi-character scene loader in
  `web/vnccs_pose_studio.js`).
- The depth-only backdrop (`web/vnccs_unicanvas_pose_backdrop.mjs`) keeps mannequins from
  sinking behind the flat 2D backdrop.

## Data model

`layer.pose` gains:

- `characterRefs`: a map from a **studio character id** to a character reference in the
  existing shape (`{ source: "layer", layerId }` | `{ source: "upload", name, dataURL }`, plus
  `{ source: "library", assetId }` once plan 10 phase B lands). It also holds an optional
  per-character `prompt` (a short identity description, for example "red-haired girl in a
  school uniform"), used by plan 02.
- **Compatibility:** `layer.pose.character` stays the reference of the **first** studio
  character (the lowest slot). Reading goes through a new helper,
  `poseCharacterRef(layer, characterId)`, in `web/vnccs_unicanvas_pose_state.mjs`. It returns
  `characterRefs[id]`, falling back to `layer.pose.character` for the first character. Writing
  the first character's reference also writes `layer.pose.character`, so the existing
  generation path, workflows and caches keep working unchanged. `poseCharacterIssue` is
  generalized to `poseCharacterIssues(host, layer)`, which returns one issue per character
  without a valid reference (the same messages as today).
- Serialization: `serializePose` handles `characterRefs` exactly like `character`. Uploaded
  `dataURL`s are dropped from workflow metadata and kept in the state cache, and `mergePoseCache`
  restores them per id.
- Stale ids: when a studio character is removed, its `characterRefs` entry is dropped on the
  next `onStateChange`. When a scene asset replaces the characters, references are remapped by
  **slot** (the reference bound to slot N moves to the new character in slot N).

## Character reference card (UX)

The card at the lower right (`buildCharacterMenu`) becomes per-mannequin:

- With one mannequin it looks and behaves exactly like today.
- With 2+ mannequins it shows a **row per mannequin**: the character color dot (the studio
  `color`), the studio name (editable in Pose Studio's Characters section), a thumbnail of the
  bound reference, and the actions *From layer* (select) / *Upload image* / *Clear*. A
  one-line **identity prompt** field per row is optional.
- Selecting a row also selects that mannequin in the embedded studio (its active character), so
  the viewport highlights who is being bound. Selecting a mannequin in the studio highlights its
  row.
- Missing references show the issue inline on the row. The trigger button shows `2/3 characters
  bound` when incomplete.
- Every change is one history entry through `recordHistoryBefore`, like the current card.

## Interaction presets

- A curated set of **two- and three-person scene assets** ships in the pose library data as an
  "Interactions" category: hug, handshake, high five, kiss on the cheek, arm around the
  shoulder, princess carry, piggyback, punch/block, sitting side by side, whisper, pointing at
  each other, dancing pair and a three-person group photo. They are authored at the default
  mannequin proportions with contact points in place. They load through the existing Pose
  Library path, so no new loader is written.
- Applying one keeps the bound references (the slot remap above). The mannequins' **mesh
  morphs** are kept per slot when the scene asset has none, so an adult and a child keep their
  bodies.
- **Contact under different proportions:** when kept morphs change body heights, contact drifts.
  After applying, the character transforms of the preset are scaled by the height ratio of each
  mannequin to the default mannequin (the relative placement is scaled around the pair's
  midpoint). If Pose Studio's IK already exposes an effector API reachable from the embedded
  widget, add a "Snap hands" helper that pins the paired hand effectors together. Otherwise the
  helper is out of scope. No new IK system.

## Per-character identity pass (ID mask)

Plan 02 needs to know which pixels belong to which mannequin, **after occlusion**.

- `UniCanvasPoseEditor` gets `captureIdPass(size)`. It temporarily switches every mannequin to
  an unlit flat material in its studio `color` (every other scene object hidden, no
  antialiasing), renders through the same `viewer.capture(...)` call that `captureSurface`
  uses, and then restores the materials. The depth buffer resolves occlusion, so the result is
  an exact visible-pixel map per character.
- It is produced together with the final capture in `commit()` (not on every preview frame) and
  stored as a runtime canvas `layer.poseIdCanvas`, serialized as a crop PNG in the state cache
  (like the layer pixels, never in workflow metadata).
- `getPoseCharacterMask(layer, characterId, { dilate })` in
  `web/vnccs_unicanvas_pose_state.mjs` returns a binary alpha mask in layer space by matching
  the character's color. It is the only reader. When the ID canvas is missing or stale (the
  studio state hash changed since it was captured), the next `commit()` regenerates it, and
  callers `await editor.flush()` first. That is the same pattern `draw()` already uses before
  generation.
- `captureSoloPass(size, characterId)` renders one mannequin alone (the others hidden) with the
  normal transparent capture. Plan 02 uses it as the full-body pose source, including the parts
  occluded by the other characters.

## Split and merge

- **Split characters to layers** (layer context menu, pose layers with 2+ mannequins): creates
  one pose layer per mannequin. Each gets a copy of the studio scene with only that character,
  the same `rect`, `viewport` and camera, and its own reference moved into `character`. The
  original layer stays hidden, directly below, so the split is reversible. The whole operation
  is one history entry. This is the path to per-character sprites (plan 03) and per-character
  motion (plan 06).
- **Merge pose layers** (multi-selection from plan 05, all pose layers with an identical `rect`
  and `viewport`): the inverse. It is capped at 4 mannequins, and the references are merged by
  character id.
- `LAYER_MENU_ITEMS` in `web/vnccs_unicanvas_layer_tools.mjs` gets `split-characters` and
  `merge-pose-layers` (`poseOnly`, with a mannequin-count condition). `Rasterize` stays, and it
  drops `pose` and `poseIdCanvas`.

## Generation until plan 02 lands

The single-shot `pose_edit` path stays as is. With 2+ mannequins and several bound references,
`composePoseReference` places **each reference in its own column** of `image2`, ordered
left-to-right by the mannequins' screen x in `image1`. The pose prompt gets a generated
mapping line ("the character on the left is the first person in image2, ...") appended to
`<user_prompt>`. This is a best-effort improvement. The reliable path is plan 02's per-character
bake.

## Where the code goes

- `web/vnccs_unicanvas_pose_state.mjs`: `characterRefs` helpers, `poseCharacterRef`,
  `poseCharacterIssues`, `getPoseCharacterMask`, the slot remap, and serialization/merge.
- `web/vnccs_unicanvas_pose.mjs`: the per-mannequin card rows, the selection sync with the
  studio, `captureIdPass`, `captureSoloPass`, ID capture in `commit()`, and the
  multi-reference layout in `generation()` / `composePoseReference`.
- `web/vnccs_unicanvas_layer_tools.mjs`: split/merge menu items and actions.
- `web/vnccs_unicanvas.js`: serialization of `poseIdCanvas`, `cloneHistoryLayer` / snapshot
  support for it, and the `draw()` issue check switched to `poseCharacterIssues`.
- Pose library data: the Interactions scene assets.

## Undo

- A reference bind/clear: one entry (as today).
- Split / merge: one entry each (a `historyGroup` of layer adds and a property change; plan 02
  defines `historyGroup`).
- Studio edits keep their current behavior (committed into the layer and synced as they happen
  now).

## Tests

- `pose-multi-character.spec.mjs` (CPU):
  - Create a pose layer, add a second mannequin through the studio Characters section, and bind
    two references (fixture PNGs) -> the card shows 2 rows, and `poseCharacterRef` resolves
    each.
  - Commit -> the ID canvas has exactly two non-empty, disjoint color regions, and their union
    lies inside the layer alpha.
  - Remove a mannequin -> its reference is dropped.
  - Apply an interaction preset -> references stay by slot.
  - Split -> two pose layers whose alpha union matches the original (IoU >= 0.98), each with
    one reference.
  - Undo the split.
  - A legacy fixture state (one `character`, no `characterRefs`) loads and generates the same
    request as before.
- `pose-backdrop.spec.mjs` and `smoke.spec.mjs` stay green.
- Evidence topic `multi-character`: before = one mannequin, after = the hug preset with two bound
  characters (the card rows plus the canvas), with geometry (the per-character mask bbox).

## Acceptance

- Up to 4 mannequins per pose layer, each bound to its own reference, with realtime studio
  editing as today.
- Per-character visible masks are available after every commit.
- Existing single-character layers, workflows and generation are unchanged.

## Out of scope

- Physics or collision between characters.
- A new IK system.
- More than 4 mannequins per layer (use several layers).
- Per-character cameras.
