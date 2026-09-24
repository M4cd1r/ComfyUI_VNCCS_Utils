# UniCanvas VN Roadmap - Plans Index

UniCanvas is the Photoshop / Invoke / Krita-AI-like workspace of VNCCS-Utils. Today it is a
strong single-image editor (infinite canvas, raster/mask/pose layers, inpaint/outpaint, SAM,
background removal, color match). These plans turn it into a **visual-novel scene tool**:
scenes with several characters that interact, character sprites with expressions, scene states,
animation, an in-game preview, and projects that survive beyond one canvas.

Each plan describes the idea exhaustively: what the user sees, where it lives in the code, which
data it adds, how it persists, how undo works, what is tested and what is explicitly out of
scope. They contain no code snippets on purpose. An implementer should be able to open a plan and
start implementing without asking design questions. Decisions that were open are resolved
inside the plans.

## Plans

| # | Plan | Summary |
|---|---|---|
| 01 | [Multi-character pose scenes](01-multi-character-pose-scenes.md) | Every mannequin of a live pose layer (up to 4 per Pose Studio scene) is bound to its own character reference, with interaction presets, per-character visibility masks and split/merge. |
| 02 | [Character bake and scene Generate](02-character-bake-and-scene-generate.md) | Every mannequin with a character reference can be baked on demand through the existing `pose_edit` path; GENERATE first bakes the pending ones, then always runs the normal scene pass, in which unbound mannequins are replaced from the prompt and reference images. |
| 03 | [Sprite sets](03-sprite-sets.md) | Expression and outfit variants of one character, pixel-aligned on one anchor, managed as one sprite layer. |
| 04 | [Scene states](04-scene-states.md) | Named snapshots of layer visibility, placement, sprite variant and opacity (layer comps), switched in one click and exported in bulk. |
| 05 | [Layer groups and auto naming](05-layer-groups-and-auto-naming.md) | Nested layer groups plus automatic layer and folder names from provenance and a small local LLM/VLM. |
| 06 | [Timeline and animation](06-timeline-and-animation.md) | Scene timeline with keyframed layer transforms, pose interpolation, idle presets, enter/exit transitions and video export. |
| 07 | [VN preview overlay](07-vn-preview-overlay.md) | Example in-game interfaces (textbox, nameplate, lorem ipsum, safe areas) over the scene, to see how the composition fits a VN UI. Preview only: never pixels or generation input. Custom interfaces are future work. |
| 08 | [Character placement and harmonize](08-character-placement-and-harmonize.md) | Horizon and ground plane with depth-correct scaling, contact shadows and a relight/harmonize pass that blends characters into the background. |
| 10 | [Projects, asset library and generation history](10-projects-assets-history.md) | Server-side project files, a reusable asset library, and a generation history with full provenance. |

Plan numbers follow the original idea list. Idea **09 (export to VN engines: Ren'Py,
Naninovel, Tyrano)** is deferred ("maybe later"). Nothing in these plans may block it: the
manifest data it would need (anchors, states, sprite variants, layer provenance) is produced by
plans 03, 04 and 10 anyway.

## Implementation order and dependencies

```
10 Projects/history (layer.meta provenance, project storage)
 ├─> 05 Groups + auto naming (uses layer.meta)
 │    ├─> 03 Sprite sets (a sprite layer lives in a character group)
 │    └─> 04 Scene states (snapshots groups and sprite variants)
 │         └─> 06 Timeline (a state can be a keyframe source)
 ├─> 01 Multi-character pose scenes
 │    └─> 02 Character bake + scene Generate (per-character masks from 01)
 │         └─> 03 Sprite sets (bake is the sprite variant generator)
 ├─> 07 VN preview overlay (independent, can ship any time)
 └─> 08 Placement + harmonize (independent; uses 02 for relight inputs)
```

Recommended order:

1. **Foundation:** 10 phase A (`layer.meta` provenance and the project format), then 05.
2. **Characters:** 01, then 02.
3. **VN content:** 03, 04, 07.
4. **Motion and polish:** 06, 08, then 10 phases B and C (asset library UI, history gallery).

07 has no dependencies and is a good warm-up or parallel task.

## Rules every plan inherits

These come from `AGENTS.md` and existing specs. They are repeated here so no plan has to restate
them in full.

- **Realtime interaction is mandatory.** Every slider, drag, scrub, gizmo and handle updates the
  visible result from `input` / `pointermove`, coalesced with `requestAnimationFrame`. Release
  may commit history, persistence or final quality, but never reveals the first result.
  Stale async results are dropped, and the newest value wins. One undo entry per completed
  gesture.
- **The history model stays.** Every new mutation goes through
  `recordHistoryBefore` / `pushHistoryEntry` / `applyHistoryEntry` in
  `web/vnccs_unicanvas.js`. New entry kinds are added to `applyHistoryEntry`, never as a
  parallel undo stack.
- **Persistence goes through `buildSerializedState` / `serializeLayer` / `applySerializedState`.**
  Every new layer field is serialized there and restored with a normalizer. Old states without
  the field must load unchanged (additive schema, `version` bump only when the shape of
  existing fields changes).
- **New features live in their own `web/vnccs_unicanvas_<feature>.mjs` module**, installed from
  the widget constructor like `installUniCanvasLayerTools` / `installUniCanvasInputTools`, so
  `web/vnccs_unicanvas.js` (7k+ lines) only receives hook calls, not feature bodies.
- **Backend routes live in `nodes/unicanvas/routes.py`** (feature code in its own
  `nodes/unicanvas/<feature>.py` module) under `/vnccs/unicanvas/...`. They run heavy
  work in `asyncio.to_thread`, return `{error}` with a non-2xx status on failure, and
  lazy-download models on first use like the BiRefNet path.
- **Snapshot of the code base.** The plans are written against `unicanvas-next` after the
  live-Pose-Studio-layers change (the retired `layer.poseData` mannequin system, bridge and
  "Generate character" recipe are gone). If the pose layer contract changes again, update
  plans 01, 02, 03, 06 and 08 before implementing them.
- **No GPU in E2E.** Specs in `tests/e2e/` must pass on the CPU Docker lane. Anything that needs
  inference is tested through a stubbed route (a `page.route` interception returning a fixture
  PNG) plus a Lane B manual check.
- **Evidence.** Every UI-visible plan names an evidence topic for
  `node evidence.mjs --topic <topic>`. Interaction-heavy topics get their own scenario step.
- **Rejected features stay rejected:** per-layer masks, clipping masks, adjustment layers,
  clone stamp, quick mask and canvas view rotation (design spec section 1). The plans avoid them.
  Where a plan needs something similar (for example, group opacity), it says so explicitly.

## Shared vocabulary

- **Layer**: an entry of `widget.layers` (`raster`, `mask`, `pose`, plus `group` and `sprite`
  added by these plans).
- **Provenance / `layer.meta`**: where a layer's pixels came from (plan 10 phase A).
- **Pose layer**: a `type: "pose"` layer holding a live Pose Studio scene in `layer.pose`
  (`studio`, `rect`, `viewport`, `character`), edited through the embedded `PoseStudioWidget`
  in `web/vnccs_unicanvas_pose.mjs` (`docs/UNICANVAS_POSE_LAYERS.md`).
- **Character reference**: the image bound to a mannequin (`From layer` / `Upload image`, plus
  `From library` from plan 10); per mannequin from plan 01 on.
- **Bake**: turning a mannequin into its rendered character through the existing `pose_edit`
  contract (QiE2511 / Klein9b), stored on the pose layer next to the mannequin render, which is
  kept, so the pose stays editable (plan 02).
- **Anchor**: the canonical point a character is placed by. The default is the feet contact
  point (plans 03, 08).
- **Scene state**: a named snapshot of the scene's presentational properties (plan 04).
