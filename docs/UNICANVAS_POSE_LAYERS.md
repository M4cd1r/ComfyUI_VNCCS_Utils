# UniCanvas Pose Studio layers

The mannequin icon in the vertical tool rail creates a live Pose Studio layer inside the current generation bbox and opens it in the pose editor. With a pose layer selected, the same icon edits that layer instead. Select a raster layer before using the tool to create another independent pose layer; Pose Studio's own Characters section can also manage multiple mannequins in one scene.

## Edit session

A pose layer is edited only in an explicit session, so outside of it the layer behaves like any other image layer: selecting it only selects it, the Move tool drags it (the live scene keeps the moved placement), it reorders, hides, locks and duplicates, and a plain right click on the canvas opens its layer menu. Enter the session with the Pose tool, **Edit pose** in the layer menu, the pose button in the layer row, or a double-click on the pose layer in the canvas.

While editing:

- the right sidebar (denoise, masks, layers) is replaced by the pose settings: the **Character reference** section, then the Pose Studio **Body** and **Scene** pages;
- the view frames the pose rectangle, and a bar at the bottom of the canvas lists the viewport controls (left: joints, right-drag: orbit, middle: pan, wheel: zoom) with **Pose Library**, **Cancel** and **Save pose**;
- UniCanvas undo/redo is paused (Pose Studio's own undo works inside the editor).

**Save pose** (also Enter or Esc outside a text field) keeps the pose and records the whole session as one undo step; **Cancel** restores the pose and pixels from before the session. Selecting another tool or layer saves as well.

## Editor

The host imports `PoseStudioWidget` from `web/vnccs_pose_studio.js`. It mounts the actual Body and Scene controls in the right sidebar for the duration of the edit session. The standard UniCanvas model, prompt, settings and Generate panel stays visible and interactive. There are no Poses or Character tabs. No rig, morph, IK, hand, library, lighting or prompt implementation is copied into UniCanvas. The original Pose Library button is in Scene. The shared central action toolbar stays hidden. Pose Library dialogs rise above the UniCanvas toolbox and other controls.

Only the active Pose tool shows its controls and viewport handles. The panels stay mounted when hidden, preserving expanded groups, drafts and scrolling. Body and hand changes, camera navigation and lighting update the layer during interaction. The layer can be moved, reordered, hidden, locked, duplicated and deleted. Pixel painting and destructive image transforms require a raster layer; use the shared Pose Studio controls to edit a live scene. Pose Studio output dimensions resize the live layer and, when still aligned, its bbox. Animation scenes retain their tracks; UniCanvas uses the currently selected frame for a still-image generation.

The canvas displays a transparent rendering. A separate transparent WebGL overlay contains only interaction handles, so image layers above the pose still cover it correctly. Normal canvas composition, node output and **Export Layers as PSD** include the pose's rendered pixels. PSD carries the image layer; the editable 3D scene remains in the UniCanvas workflow/cache.

## Character reference and inference

The **Character reference** section at the top of the editing sidebar has a preview, a layer picker, Upload image and Clear, and says when no reference is bound. It accepts an image file or an existing image layer. A reference is optional: a mannequin without one is never baked and reaches the scene pass as a mannequin (see Character bake below). Uploaded references are fitted into the reference canvas. A selected visible lower layer is already part of the reference and is included once. Other selected layers are fitted from their full content bounds, even when their canvas position is outside the bbox.

A character bake (below) sends QiE2511 or Klein9b exactly two images:

1. **image1:** the pose rendering in the bbox, composited over Pose Studio's solid background color.
2. **image2:** the lower visible image layers, composited bottom-to-top, plus the selected character reference. Uncovered pixels are white.

A file with an opaque background can cover the lower composite within its fitted rectangle. Use a transparent character image when the underlying scene must remain visible there.

The prompt is produced by Pose Studio's existing `generatePromptFromLights` method and template. The selected pose prompt and UniCanvas prompt fill `<user_prompt>`; lights fill `<lighting>`. The default character reference remains `image2`. There is no third reference image.

Pose generation uses full denoising. QiE2511 encodes both images as ordered visual/text and VAE references. Klein9b appends both reference latents in the same order to positive and negative conditioning using its existing node pipeline. Normal image editing retains its previous reference path. Only bakes need these families: the scene pass runs with any UniCanvas model, and bakes then use the Bake model from the settings.

## Multi-character scenes

One pose layer holds up to four mannequins (Pose Studio's character slots) under one camera. Each mannequin is bound to its own reference in `layer.pose.characterRefs`, a map from studio character id to a reference of the same shape as `character`, plus an optional identity `prompt` ("red-haired girl in a school uniform"). `layer.pose.character` stays the reference of the first mannequin (lowest slot): `poseCharacterRef(layer, id)` in `web/vnccs_unicanvas_pose_state.mjs` falls back to it, and writing the first mannequin's reference writes both. A layer with one mannequin never creates the map, so its state, workflows and requests are unchanged. Removing a mannequin drops its reference on the next state change; a scene asset that replaces the mannequins keeps the references by slot.

With one mannequin the Character reference card is unchanged. With two or more it shows a row per mannequin (studio color, name, preview, source picker, Upload image, Clear, identity prompt, inline issue) and `n/m characters bound` in its header. Clicking a row selects that mannequin in the studio, and the active mannequin's row is highlighted. `poseCharacterIssues(host, layer)` returns one issue per unbound mannequin; unbound mannequins are simply not baked.

After every commit the editor renders an ID pass (`captureIdPass`): each mannequin unlit in a fixed ID color by slot (red, green, blue, white), everything else hidden, through the same `viewer.capture` call as the layer pixels, so depth resolves occlusion. The result is runtime `layer.poseIdCanvas` with `layer.poseIdMeta = { key, ids, rect }`; the state cache stores it as `poseId` (a PNG), workflow metadata never does. `getPoseCharacterMask(layer, id, { dilate })` is the only reader and returns a binary alpha mask over the layer rect, or null when the ID pass is missing or stale (the key hashes mannequins, viewport and rect); callers `await editor.flush()` first. `captureSoloPass(size, id)` renders one mannequin alone, including parts the others occlude.

## Character bake and scene Generate

A mannequin with a bound reference can be **baked**: `web/vnccs_unicanvas_bake.mjs` generates that character in the same pose and placement and keeps it as the character's baked pixels, while the 3D scene stays editable.

- **State.** `layer.pose.bake = { characters: { [id]: { status, poseHash, refHash, seed, model, bakedAt, headRect, feetPoint, error } }, showMannequin }` is serialized with the pose; old layers have none and read as unbaked. `poseHash` covers the character's studio entry (pose, mesh, transform, animation), the active frame, the viewport, the rect size and the lights; `refHash` covers the bound reference (layer id plus its `pixelRevision`, or the upload's data hash) and the identity prompt. After every commit a baked character whose hash changed becomes `stale` (and `baked` again when an undo restores the scene); stale bakes keep showing their pixels.
- **Pixels.** `layer.mannequinSurface` is what the editor renders over `pose.rect`; `layer.bakeParts[id] = { surface, rect, anchor }` is one baked character in its working rect, anchored to the pose rect so moving the layer moves it. `layer.canvas` / `hiresCanvas` are the composite view: unbaked mannequins cut with their ID masks, then the baked characters back to front (by feet position). The view is rebuilt only when an input changes. While the Pose tool edits the layer, or with **Show mannequin** on (a layer-row toggle with no history entry), the mannequins show. The state cache stores the mannequin and baked parts as `bakePixels`; workflow metadata never does.
- **Pipeline** (one character): working rect = pose rect + 10 % clamped to the world, inference size by `getInferenceSize(rect)`; `image1` = the character's solo pass over the studio background, `image2` = the lower visible composite plus only that character's reference; prompt = studio pose prompt + identity prompt through `generatePromptFromLights`; the request is the usual `pose_edit` draw with `denoise: 1`. The result is cut out with the configured background remover (SAM 3 falls back to BiRefNet) on the silhouette box + 15 %, keeping only alpha components that touch the mannequin silhouette, then clipped by the character's visible ID mask dilated by how far the alpha reaches past the silhouette, minus the other characters' visible pixels. The projected head box and feet point are stored for later plans.
- **Model.** The current engine when it is QiE2511 or Klein9b, otherwise the **Character bake** settings group: family, preset (default: the first downloaded preset of a bake family), optional steps / CFG. Bakes always use the direct `/vnccs/unicanvas/draw` route, also with a linked `VNCSS Config`.
- **UX.** Each reference-card row has a bake chip (`mannequin`, `baked`, `stale`, `baking…`, `failed` with its error) and **Bake** / **Re-bake** (new seed). A manual bake is staged in place (accept / discard / next, batch variants); accepting writes one history entry. The layer menu's **Bake characters** bakes every bound, unbaked or stale character of that layer as one undo step.
- **GENERATE.** Visible, unlocked pose layers intersecting the bbox are scanned; bound characters that are unbaked, failed or stale (setting *Re-bake stale characters on Generate*) bake first, auto-accepted, and the button shows the count (`+2 bakes`). The scene pass then runs the normal draw over the composite with whatever Prompt is set, empty included; with nothing to bake it is the plain GENERATE. The bakes and the accepted scene result are one undo step (if anything else is recorded first, the bakes become their own step). A failed bake stops the scene pass; successful bakes are kept and the failed row shows the error. GENERATE while editing a pose saves the pose first. In panorama documents bakes return to the pose layer's own camera.

The layer context menu has **Split characters to layers** (pose layers with 2+ mannequins: one pose layer per mannequin with the same rect, viewport and camera, pixels from the solo pass, the original hidden directly below) and **Merge pose layers** (a multi-selection of pose layers with identical rect and viewport, at most four mannequins, references merged by character id). Each is one undo step. Both are unavailable in panorama documents for now. `Rasterize` drops `pose` and the ID pass.

## Persistence and lifecycle

Each `type: "pose"` layer includes a `pose` object containing the Pose Studio scene schema, viewport camera, world rectangle and character selection. Workflow metadata excludes uploaded character pixels; the existing UniCanvas state cache stores them with preview pixels. Existing animation cache references remain owned by Pose Studio. Static poses do not serialize the internal default timeline as an animation. In image mode, existing compact animation references are preserved without requesting the animation cache; switching to animation mode restores them on demand.

Queue execution waits for the active scene's model/morph work and state upload. Stale initialization or capture work cannot replace another layer. Removing the editor uses Pose Studio's shared `dispose()` method to release workers, renderer, observers, timers and listeners. Older raster/mask workflows keep their schema and behavior.

In panorama mode a pose retains its original editing camera. Activating its tool returns to that camera; rotating the panorama leaves the Pose tool. At another viewing angle, inference uses the already projected pose pixels so the generation view does not jump. Standard PSD export continues to export the full panorama.

## Verification

The focused tests cover shared panel mounting, scroll and keyboard state, bbox geometry, realtime preview updates, transparent capture/helper restoration, asynchronous layer replacement, reference composition/order, cache metadata, both model adapters and node output. The standalone Pose Studio bootstrap and existing frontend/backend suites also cover the reused editor. Actual browser interaction and model inference must be checked on the ComfyUI host.
