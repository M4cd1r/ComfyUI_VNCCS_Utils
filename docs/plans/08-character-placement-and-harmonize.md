# Plan 08 - Character placement and harmonize

## Goal

Characters dropped onto a background look like stickers. They have the wrong scale for where
they stand, no contact with the floor, the wrong light, and hard cut edges. This plan adds three
tools that together make a character **sit in the scene**:

1. **Ground plane and depth-correct scaling**: a horizon line and ground plane. Characters
   dragged "into" the scene scale by perspective, anchored at their feet.
2. **Contact and cast shadows**: generated, linked shadow layers that follow the character
   live.
3. **Harmonize**: color and light matching. There is a realtime client-side pass (color match
   plus normal-based relight for pose characters) and an AI pass (an edit-model relight/edge
   blend, staged). There is also a depth-based **foreground occluder** for "character behind
   the table".

## What already exists

- Color match (`web/vnccs_unicanvas_layer_tools.mjs`: `openColorMatchPopover`, realtime
  preview while dragging the strength, commit on release; route `/vnccs/unicanvas/color_match`).
- Remove background, SAM segmentation (`/vnccs/unicanvas/segment`), inpaint/edit generation.
- Live pose layers with a camera and 3D mannequins (`web/vnccs_unicanvas_pose.mjs`). Plan 01
  adds ID masks from the same capture path. Plans 02 and 03 record the **feet anchor** of
  baked/sprite characters.
- Panorama mode (`web/vnccs_unicanvas_panorama.mjs`) has its own spherical camera.
- Transform tools (move/scale/rotate/perspective via `transformDraft`) and snap.

## 1. Ground plane and depth-correct scaling

### Scene perspective model

`widget.scenePerspective = { enabled, horizonY, vanishX, referenceHeight: { feetY,
heightPx }, groundTint }`, serialized with the state.

- **Horizon** is a world-space y. **Vanish X** is the optional central vanishing point, used
  only for the guide grid.
- **Reference:** one calibration of "a standard character standing with feet at `feetY` is
  `heightPx` tall". It is set by the "Calibrate from selected character" button (it takes the
  active character's feet anchor and alpha height) or by dragging the calibration figure
  gizmo.
- Pinhole flat-ground rule: for a character of the reference real height, image height is
  proportional to (feetY - horizonY). So the **expected height at feet y** =
  `heightPx * (y - horizonY) / (referenceFeetY - horizonY)`. Characters may carry a relative
  height factor (`layer.meta.heightFactor`, default 1: 0.8 for a child, 1.1 for a tall
  character). For pose layers it is derived from the studio character's mesh `height` morph
  when present.

### UX

- **Perspective tool** (a new tool in the tools column, shortcut `G`): shows the horizon line
  (draggable), the ground grid in perspective (drawn from the vanish point, fading with
  distance), and the calibration figure. Dragging updates live.
- **Depth-scale toggle** on the move tool (the corner bar, next to *Snap to grid*): when on,
  moving a character layer (pose, sprite, or `Characters` folder member) **rescales it around
  its feet anchor** live during the drag, so its height matches the expected height at its
  current feet y. The scale is applied through the same transform path as the resize tool, and
  pixels are resampled from `hiresCanvas` when present, so repeated moves never degrade quality
  (always resampled from the source, never from the previous result). The whole drag is one
  history entry. Snap to ground: the feet snap onto the horizontal line under the cursor, never
  above the horizon (a clamp).
- **Estimate from background** (a button in the perspective tool panel): runs depth
  estimation on the background layer (the lowest visible raster layer or the `Background`
  folder composite) and proposes a horizon. The horizon is the image row where the ground
  depth gradient vanishes: fit a plane to the lower-third depth samples and intersect it with
  infinity. The proposal is shown as a ghost line with Accept/Discard. The depth model is
  `depth-anything/Depth-Anything-V2-Small-hf` (Apache-2.0) through the `transformers`
  depth-estimation pipeline. It is lazy-downloaded into `models/depth/` on first use, with the
  same caching/unloading pattern as plan 05's naming models. Route:
  `POST /vnccs/unicanvas/depth` -> a 16-bit PNG depth map at the input size. It is cached per
  background layer pixel revision (`bumpLayerPixelRevision`), so the model runs once per
  background change.

## 2. Shadows

A **shadow layer** is a raster layer with `shadow = { sourceLayerId, kind, params }`, filed
directly under its source in the stack (inside the same group). It is regenerated
client-side (2D canvas, cheap) whenever the source's pixels, render transform (plans 04/06)
or the shadow params change. That makes it realtime during a character drag, because the
shadow pass is part of the same rAF frame.

- **Contact shadow** (`kind: contact`): an elliptical soft blob under the feet anchor. The
  width is 60% of the alpha bbox width at the feet rows. The height, softness and opacity are
  params. Multiply blend, color from the scene light ambient (below).
- **Cast shadow** (`kind: cast`): the silhouette alpha is flattened onto the ground plane
  along the light direction. It is sheared and squashed vertically by the light elevation,
  anchored on the feet row, blurred with distance from the feet (a gradient blur
  approximation: 3 blurred copies blended by distance), and opacity-faded with length. Without
  a perspective model, the ground is the horizontal line through the feet.
- Commands: context menu "Add contact shadow", "Add cast shadow", plus a **Shadows** row in the
  harmonize panel. Params are edited live (sliders, realtime) with one history entry per
  gesture. "Detach shadow" converts it to a plain raster layer.

## 3. Scene light

`widget.sceneLight = { azimuth, elevation, color, intensity, ambientColor, ambientIntensity }`,
edited with a **light gizmo**: a sun handle orbiting the selected character, drawn in the
perspective tool and the harmonize panel. It is live, and it drives cast shadow direction,
shadow color and the relight below. An "Estimate" button proposes the azimuth from the
background: the dominant luminance gradient direction of the blurred background around the
character (a heuristic). Accept or ignore it.

## 4. Harmonize

The **Harmonize** panel (layer context menu "Harmonize..." for character layers) has three
stages. Each one is independently toggled and previewed live:

1. **Color** - the existing color match against a new reference option, "area around the
   character": the background composite in the character's bbox dilated by 25%, excluding the
   character. It uses the existing realtime strength slider path.
2. **Relight (quick, client-side)** - for pose layers and baked characters with a normal pass:
   `UniCanvasPoseEditor` gets `captureNormalPass(size)` next to plan 01's ID pass
   (camera-space normals, the same camera and size, captured on `commit()`, stored as
   `layer.poseNormalCanvas` and serialized to the state cache like the ID canvas).
   Shading = ambient + intensity x max(0, N·L) with the scene light, applied to the character
   pixels as a multiply/screen blend at a `strength` param. It runs in a small WebGL fragment
   pass (fallback: a 2D canvas per-pixel loop at half resolution during interaction, full
   resolution on release). It is realtime while dragging the light gizmo or the strength
   slider. Layers without a normal pass skip this stage (the checkbox is disabled with a
   tooltip).
3. **AI harmonize (staged)** - an edit-model pass over the character's bbox plus a 15%
   margin: the working image is the current composite, and the mask is the character alpha
   dilated by 12 px with an 8 px soft edge band. The instruction comes from a template in
   settings: "Relight the character to match the scene lighting and colors, blend the edges
   naturally, keep the identity, pose, outfit and silhouette unchanged." Results go to the
   staging popover. Accepting **replaces the character layer's pixels** (one history entry),
   and the silhouette drift guard from plan 02 applies (the alpha bbox must stay within 5%).

Stages 1-2 commit into the layer as one history entry on "Apply". Until then they are a live
preview over the untouched pixels. Cancel restores the pixels, the same pattern as the color
match preview.

## 5. Foreground occluder (character behind objects)

"Create foreground occluder" (the harmonize panel, or the context menu on a character):
builds a new raster layer from the **background pixels that are in front of the
character**. Those are the background pixels inside the character's bbox whose depth (from the
cached depth map) is nearer than the character's feet depth, plus a margin. The mask is
refined optionally with SAM (the existing segment route, seeded with points in the occluding
region). The layer is placed **above** the character in the stack and named "Occluder - <object>"
(plan 05 naming). This is ordinary layer stacking, not a clipping mask. Moving the character
later leaves the occluder in place. A table stays a table.

## Where the code goes

- New `web/vnccs_unicanvas_scene_place.mjs`: the perspective model, perspective tool, depth-scale
  move hook, horizon estimation client, light model and gizmo.
- New `web/vnccs_unicanvas_harmonize.mjs`: shadow layers and their regeneration, the harmonize
  panel, the relight WebGL pass, the AI harmonize request/staging, and the occluder builder.
- `web/vnccs_unicanvas_pose.mjs`: the normal pass in `commit()` (next to the plan 01 ID pass).
- `web/vnccs_unicanvas.js`: the tool registration (`G`), the move-tool hook, serialization of
  `scenePerspective`, `sceneLight`, `shadow`, `poseNormalCanvas`; history kinds for
  perspective/light edits.
- `web/vnccs_unicanvas_layer_tools.mjs`: menu items `harmonize`, `add-contact-shadow`,
  `add-cast-shadow`, `create-occluder`.
- `nodes/unicanvas.py`: the `depth` route with model download/cache/unload, and the extended
  color match reference option (it can be built client-side; no backend change unless the
  current route requires a full reference image).

## Tests

- `placement.spec.mjs` (CPU):
  - Set the horizon and calibrate -> drag a character down 200 px with depth-scale -> its
    height equals the expected formula ±1.5%, and the feet anchor stays under the cursor. The
    height changes during the drag (the realtime rule).
  - A repeated up/down drag returns to the original pixels within a tolerance (resampling from
    the source).
  - Contact shadow follows the character live during a drag.
  - Relight with a synthetic normal pass -> a light from the left brightens the left half of a
    fixture more than the right.
  - The occluder with a stubbed depth route (a fixture depth map) creates a layer above the
    character that holds exactly the "near" background pixels.
  - Undo of each operation.
- Backend pytest: the depth route on a tiny image with the model mocked. Horizon estimation on a
  synthetic planar depth map returns the known horizon ±2%.
- Evidence topic `placement-harmonize`: before = a pasted character, after = scaled + contact
  shadow + relight.

## Acceptance

- Depth-scaled moves are live and lossless across repeated moves.
- Shadows and relight update in realtime and never need a release to show.
- Every AI step is staged, and none of them moves the silhouette.

## Out of scope

- Full 3D scene reconstruction or camera solving beyond horizon + calibration.
- The perspective tool and depth-scale in panorama mode (the tool is disabled there with a
  tooltip; the panorama camera already defines the view).
- Physically based shadows from the background geometry.
- Relighting arbitrary raster characters without a normal pass (only the AI stage covers
  them).
