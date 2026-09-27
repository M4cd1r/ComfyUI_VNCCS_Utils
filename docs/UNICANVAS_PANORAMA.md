# UniCanvas panorama mode

Import a full **360 × 180° equirectangular image**, normally in a 2:1 aspect ratio.
Images with width/height at least 1.9 trigger an import question. Choose
**Panorama**, **Regular image**, or **Cancel**. Use the regular image import
button. Aspect ratio is only
a hint: an ordinary wide photo does not contain a complete spherical scene.
Cubemaps and partial/cylindrical panoramas require conversion before import.

## The panorama layer

Importing as **Panorama** creates a layer of type `panorama`, shown at the bottom of
**Image Layers** with a globe button. It holds the complete equirectangular pixels and
its own settings:

- **Camera**: yaw, pitch, roll and field of view.
- **Projection**: equirectangular (the only projection available today).
- **Navigation quality**: the size of the lightweight preview rendered while the camera
  moves (Fast 256 px, Balanced 384 px, Sharp 768 px). The full editing-window quality
  returns when the gesture ends.

The view is set in a **panorama view mode**. The globe button of the panorama layer opens
it; outside the mode the view settings are hidden. The mode shows, at the top of the side
panel, the sphere control and, under **Panorama view**, exact yaw/pitch/roll/FOV sliders
with numeric fields plus the projection and navigation-quality selectors. Dragging the
canvas with the left button also turns the view while the mode is open, whatever tool is
selected. Sliders and fields move the view on every input event; each gesture ends with a
full-quality view when it is released or the field is confirmed. The mode ends with:

- **Save**: keeps the view; the whole session is one Undo step.
- **Cancel**: restores the view from before the mode was opened; nothing is recorded.
- **Reset** (stays in the mode): returns to the initial view position (yaw, pitch and roll
  0, FOV 90).

Undo and Redo wait until the mode is saved or canceled. A document has one panorama layer:
duplicating it creates an ordinary layer holding a copy of the spherical pixels.

## Editing and navigation

- The square bbox is a 1024 × 1024 perspective editing window. The document
  retains the panorama's full dimensions. Inference scale still controls
  generation resolution independently of the editing window.
- The compact sphere control rotates the view directly: drag inside the sphere
  for heading/elevation, drag its outer ring for roll, and scroll over it to change
  the field of view. All three rotation axes update during the gesture. The
  regular pan and zoom controls still navigate the editor.
- With the sphere focused, arrow keys rotate heading/elevation, Q/E change roll,
  and +/- change field of view. Hold Shift for smaller keyboard increments.
- Select the normal brush, eraser, mask, shape, move, resize/perspective, or SAM
  tools to edit the visible part of a layer. Edits are transferred to spherical
  coordinates, including across the left/right seam and around the poles.
  Finish an edit or apply/cancel a transform before changing the camera.
- The panorama layer remains at the bottom, initially locked. Select an
  editable layer above it, or unlock it to edit its visible region. It cannot be
  placed above other layers or into a group.
- Delete the panorama layer to exit panorama mode. A confirmation warns
  that the entire panorama workspace will be permanently discarded, including
  all layers, staged results, and undo/redo history. Cancel keeps it intact;
  **Delete panorama** opens an empty regular canvas. There is no separate exit
  button, and the deleted workspace cannot be restored through Undo.
- Further image imports become overlays anchored to the current view. Existing
  layers in a flat document are fitted together into the initial panorama view
  when the mode is enabled. Undo can restore that original flat document.
- A generation result remembers the camera used for its request, so rotating
  while it runs does not change where it is previewed or accepted. SAM prompts
  belong to the current view and are cleared when navigation begins; a late SAM
  response from an old view is ignored.
- Flattening combines visible raster layers into a panorama layer and retains
  the original base underneath, hidden. Undo restores the previous layers.
- Groups work as in a flat document: new group, group/ungroup, duplicate, delete,
  move (every image layer of the group moves in the current view), opacity and
  blend. Flattening a group combines the spherical pixels of its image layers.
  The panorama layer itself never joins a group.
- A **ControlNet layer** is sent with a panorama generation like with a flat one:
  the guide is taken from the current view, the same view as the image and mask.
- **History results** can be placed as a layer: the result lands in the current
  view (where it was generated when that was the editing window, otherwise fitted
  into it), as one Undo step.
- **Sprite sets** remember the camera they were made in. Switching or generating
  variants works from any view and puts the variant at the sprite's place on the
  sphere; paint made in another view reaches the active variant there. A move,
  transform or paint-all stroke in another view first re-anchors the whole set to
  that view (every variant is re-projected once). Staged sprite results preview
  flat at the sprite's rect, which is exact from the sprite's own camera; accepting
  them always lands on the sphere correctly. Splitting and merging pose layers is
  still not available in panorama documents.

## Export and saved workflows

The standard **Export layers as PSD** action and the node's **IMAGE** output
always use the complete equirectangular document; the node output applies layer
groups (hidden groups, group opacity and blend) and includes sprite sets. The camera and square bbox do
not crop the output. No additional panorama export button is added. Masks remain editing aids and are not included in the
composite image. PSD keeps visible raster layers in full panorama coordinates.

Panoramas use version 4 of `unicanvas_state`: the layer of type `panorama` carries
its settings in a `panorama` object (`projection`, `width`, `height`, `yaw`, `pitch`,
`roll`, `fov`, `quality`, `contentRevision`), and spherical layer pixels are stored
through the existing ComfyUI state cache. Workflows saved in version 3 (settings in a
document-level `panorama` entry with a raster base layer) open unchanged: the base
layer becomes the panorama layer and takes over the saved camera and pixels, and the
next save writes version 4. The node output accepts both versions. Older versions 1 and
2 retain flat canvas behavior. Before queue execution, the latest panorama pixels are committed
and their upload is awaited; a failed upload stops queueing to prevent exporting
stale content. Workflows continue to depend on their ComfyUI host's state cache.

## Limits and verification

- WebGL 2 is required. Images are limited to 8192 pixels per side and
  33,554,432 pixels total (including a standard 8192 × 4096 panorama), subject to
  the GPU's texture limit. Existing upload/cache size limits also apply.
- Navigation uses a reduced-resolution preview during a gesture (see navigation
  quality above) and restores
  full editing-window quality on completion. It never resamples the stored
  panorama. Imported overlays and generated patches use up to a 4096-pixel
  square when transferred to the sphere; brush edits use the editing window.
- Large panoramas require substantial CPU/GPU memory. Pixel history is bounded
  by memory as well as the normal gesture limit; older history may be evicted.
- Automated tests cover coordinate round trips, seams, poles, erasure,
  unchanged-pixel preservation, live control events, history, generation camera
  capture, cache restoration, queue synchronization, and full-image export.
  On macOS the production shader is also tested using native OpenGL without a
  browser (only its GLSL version/precision declarations are adapted).
- `tests/e2e/panorama.spec.mjs` drives the real UI with a 2048 × 1024 fixture:
  panorama import, seam editing with undo/redo, save/reopen, PNG (node IMAGE)
  and PSD export size, the captured generation camera (draw route stubbed), the
  panorama layer settings panel, and opening a version 3 workflow.
  `tests/test_unicanvas_panorama_layer.mjs` covers the version 3 migration and the
  settings panel without a browser.
- Final layout, pen/mouse interaction, actual model generation, and WebGL
  behavior must be checked in the real ComfyUI installation. A useful acceptance
  check is to paint across the seam, turn through 360°, undo/redo, generate while
  looking elsewhere, save/reopen the workflow, and export PNG/PSD/IMAGE.
