# Plan 04 - Scene states

## Goal

A VN scene is one background plus many **states**: who is on stage, where they stand, which
expression each one shows, day or night, rain or not. The plan adds **scene states** (the
equivalent of Photoshop layer comps): named snapshots of the scene's presentational
properties. They switch in one click, update in place and export in bulk.

A state never stores pixels. It stores **which pixels show and how**. The layers own the
pixels. That keeps states cheap (dozens per scene) and keeps edits to a layer visible in every
state that shows it.

## What a state captures

Per layer (keyed by layer id):

- `visible`
- `opacity`
- `blendMode`
- `offset`: a translation of the layer relative to its stored position, in world pixels. It
  covers "the character stands further left in this state" without duplicating pixels.
  Position only in v1. Scale and rotate still need a real transform or a duplicate layer.
- `spriteVariantId` for sprite layers (plan 03).
- `showMannequin` for pose layers (plan 02).
- Group `visible` / `opacity` / `collapsed` is **not** captured. Collapse is a UI preference.
  Group visibility and opacity are captured like layers.

Scene-level:

- `name`, `id`, `order`, `note` (free text, for example "ch2 - argument after dinner").
- `thumbnail`: a small composite PNG rendered at capture time and on every update (for the
  states panel).
- `createdAt` / `updatedAt`.

Layers that did not exist when a state was captured follow the **default policy** when that
state is applied: they keep their current properties. The "hidden in other states" option
of the add-layer flow can instead mark them hidden in every existing state. That is useful
when adding a new character that only appears in some states.

## Data model

`widget.sceneStates = { activeStateId, states: [...] }`, serialized in
`buildSerializedState` under `sceneStates`. A state is `{ id, name, order, note, layers:
{ [layerId]: { visible, opacity, blendMode, offset, spriteVariantId?, showMannequin? } },
thumbnailDataURL, createdAt, updatedAt }`.

`offset` is applied at **render time**. It is not baked into layer pixels. The renderer's
per-layer draw (`drawRasterLayerVisible` / `drawRasterLayerToWorldRect` and the flatten path
`drawFlattenedLayers` used by export and generation) adds the active state's offset for that
layer. Hit testing, the move tool, the transform tools and the alpha bounds (`getLayerWorldBounds`)
use the same offset through one accessor, `getLayerStateOffset(layer)`. A layer move while a
state is active changes the **state offset** when the "Move affects: this state / all states"
toggle is `this state` (default when more than one state exists). Otherwise it moves the pixels
as today.

## UX

A **States** section in the right column under Layers, collapsed by default when no states
exist:

- A thumbnail list of states (drag to reorder). The active state is highlighted. A modified
  indicator (dot) appears when the live scene differs from the active state.
- Actions: **New state from current**, **Update state** (overwrite the active state with the
  live properties), **Duplicate**, **Rename** (inline), **Delete**, **Revert to state**.
- A click on a state applies it. Application is instant: properties are set, no pixels move,
  and one `requestRender`.
- Hover over a thumbnail previews the state on the canvas (realtime, reverted on leave), the
  same as sprite variant hover.
- `Alt+1..9` applies states 1-9 (shortcut map in `web/vnccs_unicanvas_modes.mjs`).
- The layer row shows a small "varies" marker when a layer's visibility or variant differs
  across states, so users know which layers are state-driven.

**Export:** "Export states..." renders the flattened composite of every selected state (the
bbox or the full content bounds, chosen in the dialog) and writes one PNG per state through
`POST /vnccs/unicanvas/save_output`. File names come from the state names. The route gets an
optional `subfolder` field (sanitized, created under `output/`) so a scene exports into
`output/<scene name>/`. In node mode, the node's `image` output stays the live composite.

**Generation and states:** GENERATE always works on the live scene (the active state as
applied plus any unsaved modifications). Accepted results are new layers, and they follow the
new-layer policy above.

## Undo

- Apply a state: one `applySceneState` history entry storing the previous per-layer
  properties and the previous `activeStateId`.
- New / update / delete / rename / reorder state: one `sceneStates` entry each (the before and
  after of the `sceneStates` object, without thumbnails, which are regenerated).
- Moving with "this state": a normal move gesture that records the state offset change, one
  entry.

## Where the code goes

- New `web/vnccs_unicanvas_states.mjs`: the state model, capture/apply/diff, the section UI,
  thumbnails, the export dialog, and shortcuts.
- `web/vnccs_unicanvas.js`: the `getLayerStateOffset` accessor used by the render, flatten,
  bounds and hit-test paths; the move tool routing; serialization; and the two history entry
  kinds.
- `web/vnccs_unicanvas_modes.mjs`: the `Alt+digit` shortcuts.
- `nodes/unicanvas/save_output.py`: the `subfolder` field on `save_output` (path-sanitized: no `..`, no
  absolute paths, max depth 2).

## Tests

- `scene-states.spec.mjs`: build a fixture with a background and two characters (raster
  fixtures), then:
  - Capture state A (both visible) and B (one hidden, the other offset by 200 px).
  - Apply A/B/A and assert the pixels of the flattened composite equal the captures.
  - Move in B with "this state" -> A is unchanged.
  - Delete a layer that exists in states -> states drop the key, no error.
  - Undo an apply -> the previous properties return.
  - Reload -> states persist.
  - Export -> one PNG per state (a `save_output` spy).
- Evidence topic `scene-states`: the states panel with 3 states plus canvas captures of each.

## Acceptance

- Switching states is instant (no pixel copies) and exact.
- States survive layer edits, reorders, deletions and reloads.
- Offsets are honored everywhere: render, export, generation composite, hit testing.

## Out of scope

- Per-state pixel edits (use sprite variants or duplicate layers).
- Per-state scale/rotation.
- Branching or script logic between states (engine export, plan 09).
