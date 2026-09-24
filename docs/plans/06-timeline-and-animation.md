# Plan 06 - Timeline and animation

## Goal

VN scenes move a little: a character slides in, breathes, blinks, shakes when surprised, the
camera pushes in, the screen fades. The plan adds a **scene timeline** to UniCanvas. It
keyframes layer properties, drives sprite variants over time, adds procedural idle motion and
enter/exit transitions, plays back live on the canvas and exports video (WebM / MP4 / GIF /
PNG sequence).

It is a **2D scene timeline** over existing layers. It is not a skeletal animator. Skeletal
animation already exists in Pose Studio. Pose layers can carry that animation (see "Pose
layers").

## What already exists

- `web/vnccs_pose_animation.mjs`: a mature keyframe model for Pose Studio (tracks,
  `INTERPOLATION_PRESETS` hold/linear/ease/smooth, `applyInterpolation`, key
  move/copy/paste/retime, `playbackFrameForElapsed`, fps and frame count limits) and the
  `PoseAnimationTimeline` dope-sheet UI (virtualized rows, ruler, key selection, shortcuts).
  Its track value types are bone-specific (quaternion, vector3, the character transform
  tracks), so the scene timeline **reuses the generic parts** (interpolation, playback
  timing, retime, key selection math, the visual language of the dope sheet) and adds its own
  scalar/vector/step track types. Do not fork the file. Extract the generic helpers into
  `web/vnccs_animation_core.mjs` and import them from both.
- Plan 04 introduces render-time per-layer offsets (`getLayerStateOffset`). The timeline
  generalizes this into a render-time **layer transform** accessor.
- `av` (PyAV) and Pillow are backend dependencies. They cover video/GIF encoding.
- Sprite layers (plan 03) and scene states (plan 04).

## Data model

`widget.timeline = { schemaVersion, fps, frameCount, loop, currentFrame, workArea: {start,
end}, tracks: { [trackId]: { target, property, type, keys: [...] } }, effects: [...],
markers: [...] }`, serialized in `buildSerializedState`.

- **Default:** 24 fps, 72 frames (3 s), loop on. Limits: 1-60 fps, 2-3600 frames.
- **Track targets:** a layer id, a group id (plan 05, applied to all children through the
  group's render transform), or `camera` (the export view rect).
- **Properties and types:**
  - `position` vector2 (world px offset from the layer's rest placement)
  - `scale` vector2 (around the layer's anchor: the sprite anchor or the alpha bbox bottom
    center)
  - `rotation` scalar (degrees, around the anchor)
  - `opacity` scalar
  - `visible` step
  - `spriteVariant` step (a variant id)
  - `blur` scalar (a render-time canvas filter, optional, for depth-of-field pulls)
  - Camera: `rect` (x, y, width, height of the export frame, i.e. pan/zoom) and `shake`.
- **Keys:** `{ id, frame, value, interpolation }`, with interpolation names identical to
  `INTERPOLATION_PRESETS`.
- **Effects (procedural, non-keyframed):** `{ id, target, kind, params, start, end }`:
  - `breathe` (a vertical scale oscillation around the anchor, amplitude 0.4-1.5%, period
    3-5 s, random phase per character)
  - `bob` (a small vertical sine)
  - `shake` (a decaying noise offset, for surprise/impact)
  - `blink` (switches `spriteVariant` to the sprite's `blink` / `eyes closed` variant for 3-4
    frames at random intervals of 2-6 s, seeded so exports are deterministic; needs that
    variant, and the sprite panel offers to generate it through plan 03's preset list)
  - `talk` (alternates `mouth open` / `mouth closed` variants at 8-12 Hz inside a range)
- **Markers:** named frames (for example "line 1") for navigation. They are not exported.

The evaluation order per layer per frame: rest placement, then the scene-state offset (plan
04), then keyframed transform, then effects. The result is one 2D affine matrix plus opacity,
visibility and the active variant. The renderer applies it at draw time.
**Layer pixels are never modified by the timeline.**

## Rendering

- One accessor, `getLayerRenderTransform(layer, frame)`, replaces the plan 04 offset accessor
  everywhere (render, flatten, bounds, hit test). With no timeline or at frame 0 with no keys,
  it returns identity plus the state offset, so today's behavior is untouched.
- Drawing a transformed layer uses `ctx.setTransform` for the affine part, not warped drawing.
  The LOD cache (`drawLayerCanvasVisibleWithLod`) is reused with the transformed destination
  rect. Perspective is not animatable.
- **Timeline mode** is on while the timeline panel is open. The canvas shows the evaluated frame.
  Painting tools work on the layer's rest pixels. The brush maps pointer coordinates through the
  inverse of the frame transform, so painting on a moved character lands on the character.
- **Generation** (GENERATE, bake, sprites) always uses the **rest pose of the scene at the
  active state**, never an animated frame, unless the user explicitly picks "Generate at
  current frame" from the GENERATE dropdown.

## Timeline panel UX

- A bottom dock (the same visual language as the Pose Studio dope sheet) with a resizable
  height and a collapsed height of 32 px. Rows: camera, then layers and groups in stack order
  (folders collapsible, following plan 05), with the animated properties shown as sub-rows.
- Transport: play/pause (`Space` while the canvas has focus and no text target), go to
  start/end, previous/next key, loop toggle, and an fps/length field. There is also the
  **work area** bar.
- **Scrubbing** the ruler updates the canvas on every `pointermove` (rAF coalesced). This is
  the realtime rule, so no release is needed to see the frame.
- **Auto-key** (toggle, default on in timeline mode): moving, scaling, rotating or changing the
  opacity of a layer at a frame writes a key at that frame. Without auto-key, a property change
  in timeline mode changes the rest value, and a small warning chip says so.
- Key editing: click to select, drag to move (live), Alt-drag to duplicate, Delete, copy/paste
  across layers, and right-click to set the interpolation. There is also a box-select.
- **Quick presets** (a right-click on a layer row -> "Add motion"): Enter from left/right
  (slide + fade, 0.5 s), Exit to left/right, Fade in/out, Pop in (scale 0.9 -> 1 with ease
  out), Jump (a quick up-down), Nod (a small rotation), Shake, Breathe, Blink, Talk.
  They are inserted at the playhead as keys/effects. They are ordinary keys afterwards.
- **Insert state as keys:** picking a scene state (plan 04) at the playhead writes
  visibility/opacity/position/variant keys that reproduce it, so a state change becomes a
  timed transition.
- The playhead is independent from the active scene state. A small chip shows "animated"
  whenever the displayed frame differs from the rest scene.

## Pose layers

Pose layers already keep Pose Studio animation tracks in `layer.pose.studio` (each studio
character's `animation`), and UniCanvas currently uses the selected frame for a still image
(`docs/UNICANVAS_POSE_LAYERS.md`). In the timeline, a pose layer with animated characters
shows one **Pose animation** row with its range and a time offset (scene frame -> studio frame
mapping, with the studio fps converted to the scene fps).

Playback shows **mannequin renders**. Only one `UniCanvasPoseEditor` instance is live at a time
(it owns one embedded `PoseStudioWidget`), so frames are produced by an explicit **Prepare
pose frames** action (it also runs automatically before an export). For each animated pose
layer it activates the editor hidden (`activate(layer, { show: false })`), steps the studio
animation frame by frame, captures through `captureSurface` at the layer rect size into a frame
cache (LRU, 256 MB cap, keyed by the layer's pose hash + frame), and releases the editor. While
frames are missing, playback shows the nearest cached frame (the last valid frame, never a
blank). A pose edit invalidates that layer's cache.

**Baked** characters (plan 02) do not re-bake per frame. On a baked layer the pose animation
row is disabled with the note "baked characters use 2D motion and sprite variants", and 2D
tracks and effects animate the baked pixels instead. Per-frame baking is out of scope.

## Export

"Export animation..." dialog:

- Format: WebM (VP9) / MP4 (H.264) / GIF / PNG sequence.
- Range: work area or full. Size: the bbox, the camera rect or a custom size, with a scale
  preset (100% / 50%). Alpha: PNG sequence and WebM keep alpha when the background layers are
  hidden.
- The frontend renders every frame deterministically offscreen through the flatten path with
  the frame's transforms. That is no screen capture, so the result is independent of the
  viewport. Frames stream to the backend in chunks: `POST /vnccs/unicanvas/animation/begin`
  -> `.../frames` (batches of PNG data URLs, sequential and ordered) -> `.../end`. The route
  keeps a job directory in temp, encodes with PyAV (WebM/MP4) or Pillow (GIF, with palette
  per frame and optimize on), and writes into `output/<subfolder>/` (the same sanitizing as
  plan 04's `save_output` subfolder). A progress bar shows two phases, rendering and
  encoding, and Cancel deletes the job.
- In node mode the node's `image` output stays the still composite. Animation export is a UI
  action only.

## Undo

- A key gesture (move/insert/delete/interp change/preset insert) is one `timeline` history
  entry, with the before/after of the affected tracks.
- Effects add/remove/edit: one entry.
- Playback and scrubbing: no history.

## Where the code goes

- New `web/vnccs_animation_core.mjs`: generic interpolation, timing and retime helpers,
  extracted from `vnccs_pose_animation.mjs`, which then imports them. Pose Studio behavior
  must not change, and its existing tests/behavior are the regression check.
- New `web/vnccs_unicanvas_timeline.mjs`: the model, evaluator (transform, effects, seeded
  randomness), panel UI, transport, auto-key, presets and the export dialog/pipeline.
- `web/vnccs_unicanvas.js`: the `getLayerRenderTransform` accessor wired into render,
  flatten, bounds, hit test and brush mapping; serialization; history kind.
- `web/vnccs_unicanvas_pose.mjs`: the hidden-activation frame stepping and capture used by
  the frame cache (the cache itself lives in the timeline module).
- `nodes/unicanvas.py`: the animation export job routes (begin/frames/end/cancel) and the
  encoders.

## Tests

- `timeline.spec.mjs` (CPU):
  - Add two position keys, scrub -> the layer bbox at the mid frame equals the interpolated
    value (±1 px). The canvas updates during the drag, before `pointerup` (the realtime rule).
  - Hold interpolation steps.
  - Auto-key off -> the rest value changes and no key is written.
  - A `blink` effect with a fixed seed -> the same frames switch the variant across two runs.
  - Export PNG sequence with the route stubbed -> N ordered frames are received and frame k is
    pixel-equal to the scrubbed frame k.
  - Undo a key move.
  - Reload -> the timeline persists.
- Backend pytest: encode 10 synthetic frames to WebM/MP4/GIF with PyAV/Pillow. The frame count
  and size must be correct.
- Evidence topic `timeline`: the panel with an "Enter from left" preset, plus frames 0 / mid
  / end.

## Acceptance

- Scrubbing and playback are realtime on a 12-layer scene at 1080p on the CPU test lane
  (≥ 20 fps playback target, no dropped last frame on scrub).
- Exports are deterministic and match the scrubbed frames.
- A scene with an empty timeline renders and generates exactly as before.

## Out of scope

- Per-frame baking of characters.
- Audio tracks and lip sync from audio.
- Mesh deformation (Live2D).
- Engine-specific exports such as Ren'Py ATL (plan 09, deferred). The keyframe data is kept
  engine-neutral so that exporter can be written later.
