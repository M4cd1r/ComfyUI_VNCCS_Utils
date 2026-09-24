# Plan 01 - Multi-character pose scenes

## Goal

A pose layer holds **up to 4 characters under one shared camera**, so interactions work
properly: a hug, a handshake, a fight, one character carrying another, two people at a
table. Each character has its own pose, character identity, morphs and world transform. They
occlude each other correctly because they live in one 3D scene and are rendered in one pass.

This lifts the "v1 handles one character" limit from the design spec (section 1, "Out of
scope") and delivers the first "Future work" item (section 14).

## Why

Interactions are the hardest thing to get from image models. Two separate single-character
layers know nothing about each other: hands do not meet, scale drifts, and occlusion is
guessed. A shared skeleton scene gives exact contact points, consistent proportions and real
depth ordering. Plan 02 then renders the characters from that scene.

## What already exists

- `web/vnccs_pose_characters.mjs`: `MAX_POSE_STUDIO_CHARACTERS = 4`,
  `createPoseStudioCharacter`, `normalizePoseStudioCharacters`,
  `serializePoseStudioCharacter`, `nextCharacterId/Slot/Color`, `DEFAULT_CHARACTER_COLORS`,
  and the character transform helpers. This is the Pose Studio multi-character data model.
  Reuse it and do not invent a second one.
- `web/vnccs_pose_studio_core.js` (`PoseViewerCore`): an active character plus
  `passiveCharacters` (a Map), `removePassiveCharacter`, `clearPassiveCharacters`. The
  embedded UniCanvas editor already constructs `PoseViewerCore`, so the viewer can show
  several characters.
- The Pose Studio library already stores **scene assets** with a `characters` array (the
  library loader in `web/vnccs_pose_studio.js` around the "Library scene contains N characters"
  warning). Interaction poses can therefore be library scenes.
- `web/vnccs_unicanvas_pose_layers.mjs`: `buildPoseLayerData` / `normalizePoseLayerData`
  (schema v1, single `pose` + `character` + `camera` + `render`), the edit session
  (`editUniCanvasPoseLayer`, `saveUniCanvasPoseEdit`, `cancelUniCanvasPoseEdit`), torso
  framing (`computeTorsoAnchor`, `applyUniCanvasPoseFraming`), the draw record that keeps
  placement stable (spec 5.1b), and the bridge (`handleUniCanvasPoseLayerRender`).

## Data model: `poseData` schema v2

`POSE_LAYER_SCHEMA_VERSION` becomes 2. `layer.poseData` gets:

- `characters`: an array of 1-4 entries in the Pose Studio character shape (id, slot, color,
  `character` identity `{id, name, source, morphs}`, `pose` stored relative to the shaped rest
  exactly like today, and `transform` `{x, y, z, zoom}` from `normalizeCharacterTransform`).
- `activeCharacterId`: the character the editor selects on open.
- `camera` and `render`: unchanged, shared by all characters.
- `interaction`: optional `{ libraryId, name }` when the scene came from an interaction
  preset, for provenance only.

**Migration:** `normalizePoseLayerData` accepts v1 and returns v2. A v1 layer becomes one
character with slot 0 and the identity transform. The top-level `pose` / `character` fields
of v1 are no longer written, but they stay readable forever. Every existing reader of
`poseData.character` (the layer panel, `generateCharacterFromPoseLayer`, the character
dropdown mirror) switches to a helper `getPoseLayerActiveCharacter(poseData)`. The E2E hook
`getLayerPoseData` returns the v2 shape. `pose-roundtrip.spec.mjs` is updated to compare v2
payloads, and its idempotence clause must still hold.

## Editor UX (embedded mannequin editor)

The edit overlay from `buildUniCanvasPoseEditOverlay` gets a **character strip** at its top
edge:

- One chip per character, showing the character color dot and name. Click selects the active
  character. The active character becomes the viewer's active rig, and the others are pushed
  back as passive characters.
- `+` adds a character (disabled at 4). A new character copies the active character's
  identity, gets `nextCharacterSlot` / `nextCharacterColor`, and is offset along +X by one
  shoulder width so it does not spawn inside the first one.
- `x` removes a character (disabled when only one is left).
- A per-chip character picker (the same list as the existing character dropdown, from
  `/vnccs/list_characters`) sets that character's identity and morphs.

Mannequin options in the left sidebar (`mountUniCanvasPoseOptions`) always edit the **active**
character. Switching the active character rebinds the options section in place. It is not
rebuilt with a flash, and the realtime rule applies: morph sliders repaint the active
character live.

**Placing characters relative to each other:** in the viewer, a move gizmo on the active
character's root edits `transform` (x/z on the floor, y for jumps and lifts). This is the
existing Pose Studio character transform. The UniCanvas layer transform tools still move the
whole rendered layer on the canvas.

**Interaction presets:** the Pose Library button opens the existing library. Scene assets with
2+ characters are shown in a separate "Interactions" tab. Applying one replaces the characters'
poses and transforms. Identities are kept: character N of the scene maps to the chip in the
same position, and missing characters are added with the first character's identity. A new
set of interaction scene assets ships in the pose library data: hug, handshake, high five,
kiss on cheek, arm around shoulder, carry (princess), piggyback, fight punch/block, sit side by
side, whisper, pointing at each other, dancing pair, and a three-person group photo. Each asset
must be authored at the default mannequin proportions so mapped identities keep contact.

**Contact preservation when morphs differ:** when identities with different heights are mapped
onto an interaction preset, hands no longer meet exactly. Resolve this in v1 by scaling the
preset's relative transforms by the height ratio. Only offer an IK "snap hands together"
helper if the viewer already has an IK solver entry point. Otherwise it is out of scope. Do not
add a new IK system for this plan.

## Rendering and capture

- Save pose renders **all** characters in one capture through the existing capture path
  (`captureUniCanvasPoseLayerPNG` with the shared camera and `render.size`). Framing
  (`applyUniCanvasPoseFraming`) centers on the **union** torso anchor, the mean of each
  character's torso anchor. For a single character it reduces exactly to today's behavior,
  so `pose-framing.spec.mjs` stays green.
- **Per-character ID mask:** the same save also renders an ID pass. Every character is drawn in
  its unique flat slot color, unlit, with no antialiasing on the ID pass, into an offscreen
  target of the same size. It is stored on the layer as a runtime canvas `layer.poseIdCanvas`
  and serialized as a crop PNG next to the layer pixels (`poseIdDataURL`). From it, the helper
  `getPoseLayerCharacterMask(layer, characterId)` returns a binary alpha mask for one character
  in layer space. Plan 02 uses these masks to bake and composite characters individually, and
  plan 08 uses them for per-character contact shadows. Occlusion is real because the ID pass
  uses the depth buffer.
- The draw record / placement stability (spec 5.1b) is unchanged: the saved layer keeps its
  canvas placement across edit/save cycles, anchored on the union torso anchor.

## Bridge (live Pose Studio link)

The Pose Studio bridge (`vnccs:unicanvas:pose-layer` bus, answered in
`web/vnccs_pose_studio.js` near `VNCCS_POSE_LAYER_BUS_EVENT`) already renders the studio's full
scene, which can hold several characters. The render detail gets a `characters` array in
the v2 shape. `mergeUniCanvasPoseLayerDetail` stores it into `poseData.characters`. An optional
`idMask` data URL in the final-quality render fills `poseIdCanvas`. When the studio does not
send `idMask` (older studio), the ID canvas is marked stale and regenerated on the next
embedded edit/save. Plan 02 falls back to whole-layer bake when a mask is missing.
`pose-studio-bridge.spec.mjs` must stay green. Add a case that pushes a two-character scene and
asserts `poseData.characters.length === 2`.

## Layer utilities

- **Split characters to layers** (layer context menu, pose layers with 2+ characters): creates
  one pose layer per character. Each has the same camera, `render.size` and canvas placement,
  and contains only that character. The original stays hidden so the split is reversible.
  Everything happens in one undo entry. This is the path to per-character sprites (plan 03) and
  per-character animation (plan 06).
- **Merge pose layers** (multi-select of pose layers with identical camera and size): the
  inverse, capped at 4 characters.
- `Rasterize` keeps working. It drops `poseData` and the ID canvas.

## Where the code goes

- `web/vnccs_unicanvas_pose_layers.mjs`: schema v2, migration, the active-character helper, the
  union anchor, the ID-mask capture and mask accessor, the split/merge operations, and the
  bridge merge. If the file grows past about 2.3k lines, move the multi-character editor UI
  (strip, chip picker, interactions tab) into a new `web/vnccs_unicanvas_pose_scene.mjs`.
- `web/vnccs_unicanvas_layer_tools.mjs`: `LAYER_MENU_ITEMS` gains `split-characters` and
  `merge-pose-layers` (pose-only, with a character-count condition).
- `web/vnccs_unicanvas.js`: `serializeLayer` / `applySerializedState` carry `poseIdDataURL`.
  The history clone (`cloneHistoryLayer`) includes `poseIdCanvas`.
- `web/vnccs_pose_studio.js`: the bridge answerer adds `characters` and `idMask` to render
  details.
- Pose library data: the new interaction scene assets.

## Undo

- Save pose (any number of characters changed): one `layerPixels` entry, as today, with
  `poseData` and the ID canvas captured in the before/after snapshot.
- Split and merge: one entry each.
- Adding, removing or reordering characters inside an open edit session is **not** separate
  history. Cancel reverts the whole session, like today.

## Tests

- `pose-multi-character.spec.mjs` (new): add a pose layer, add a second character, save, and
  assert `poseData.characters.length === 2`. The two character masks must be disjoint and
  non-empty, and their union must lie inside the layer alpha. Run edit -> save twice unchanged
  and assert identical pixels and poseData (the idempotence clause extended to v2). Split,
  then assert two pose layers whose alpha union equals the original alpha (IoU >= 0.98).
- Migration: load a fixture state with a v1 pose layer and assert it opens, renders and saves
  as v2 with an unchanged bbox.
- Existing specs `pose-roundtrip`, `pose-framing`, `pose-studio-bridge` and
  `mannequin-options` stay green.
- Evidence topic `multi-character`: before = a single mannequin, after = a hug interaction
  preset with two characters, plus geometry (per-character bbox).

## Acceptance

- Up to 4 characters, correctly occluded, edited live with realtime morph sliders.
- Interaction presets apply in one click and keep contact at default proportions.
- Per-character masks are available for every saved multi-character pose layer.
- A v1 layer opens and round-trips without drift.

## Out of scope

- Physics or collision between characters.
- A new IK system.
- More than 4 characters per layer (split into several layers instead).
- Per-character cameras.
