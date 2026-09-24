# Plan 07 - VN preview overlay

## Goal

Show how the scene will look **inside the game**: a dialogue textbox with placeholder text, a
nameplate, quick-menu buttons and the safe areas of the target resolution. The composition can
then be judged against what the UI will cover. A face at textbox height, or a character cut by
the nameplate, are the typical mistakes this catches.

**The overlay is a preview only. This is a hard rule:**

- It is **never** part of the layer stack, never rendered into layer pixels, never included in
  flatten/export/save/PSD, never sent to any generation route (GENERATE, bake, sprites,
  remove background, color match) and never part of the node's `image` output.
- The text is **automatic lorem ipsum** (plus a placeholder speaker name). There is no text
  layer, no user-authored dialogue and no script editing. The user can pick a text **length**
  (short / medium / long / two lines / max lines) to test the box, but cannot type content.
- It generates no code, script or engine files.

## What already exists

- `render()` draws the stage in layers: background, layers, the bbox overlay (`drawBboxOverlay`),
  the staging overlay (`drawStagingOverlay`), the tool previews and the input tools overlay
  (`drawInputToolsOverlay`). The VN overlay is one more **screen-space overlay pass** at the
  very end, after everything else and before the HUD.
- The corner bar next to *Snap to grid* and the settings gear (`openUniCanvasSettings`,
  `anchorPopoverTo`) are the place for a toggle and its popover.
- The generation bbox (`this.bbox`) is the natural "game screen" frame.

## The game frame

The overlay is laid out inside a **game frame**, a world-space rect that represents the game
screen:

- By default it is the generation bbox. A "Lock frame" option detaches it, so moving the bbox
  for local inpaints does not move the preview. The frame is then drawn with its own handles and
  can be dragged and resized (with the aspect ratio kept).
- **Aspect presets:** 16:9 at 1920x1080 (default), 16:9 at 1280x720, 4:3 at 1440x1080, 16:10
  at 1920x1200, and mobile portrait 9:16 at 1080x1920. The preset sets the frame aspect and
  the **reference resolution** that UI sizes are computed in. The frame is then scaled to fit,
  so all UI metrics are defined in reference pixels.
- With the overlay on, the area outside the frame is dimmed by 55%.

## Overlay elements

Every element is drawn from a **UI skin**, a plain JSON description in reference pixels.
Skins ship in `web/assets/vn_preview_skins/` and are selectable in the popover:

- **Textbox:** a rect (default bottom, full width minus 2x60 px margins, height 260 px),
  fill color/alpha, corner radius, border, and inner padding.
- **Nameplate:** position relative to the textbox (default top-left, overlapping), size,
  fill, and font.
- **Dialogue text:** font family (a system font stack or a bundled open-licensed font), size
  (default 34 px), line height, color, shadow/outline, and max lines. Text wraps inside the
  padding with the real canvas `measureText` so the line breaks are realistic.
- **Quick menu:** a row of small labels under or inside the textbox (Back, History, Skip,
  Auto, Save, Load, Settings), all non-interactive.
- **Choice menu** (optional toggle): 2-3 centered choice buttons with lorem text.
- **Side image slot** (optional toggle): a rect at the textbox's left where some engines show a
  character head. It is drawn as an outline only.
- **Safe areas:** the action-safe (93%) and title-safe (90%) outlines, plus an optional
  mobile notch/rounded-corner mask for the portrait preset.
- **Occlusion warning:** when enabled, the canvas highlights (red outline) any character layer
  whose **face region** is covered by the textbox or nameplate. The face region is
  `sprite.faceRect` (plan 03), the bake `headRect` of a baked pose layer (plan 02) or, for other layers,
  the top 18% of the alpha bbox. Character layers are pose/sprite layers and layers filed under
  `Characters` (plan 05).

Shipped skins:

1. `Clean dark` (a translucent dark box, white text, the default).
2. `Classic paper` (a light parchment box, serif text).
3. `Ren'Py default-like` (the proportions of a default Ren'Py 16:9 project, a generic look,
   without any Ren'Py assets).
4. `Mobile bubble` (for 9:16).

A skin can be **imported** from a JSON file and optionally from a PNG for the textbox frame
(9-slice fields in the JSON). That makes it possible to preview the real game's UI art
without it ever entering the scene. Imported skins persist with the project (plan 10) or,
before plan 10, in `localStorage` under a UniCanvas key (the per-viewer convenience rule).

## Placeholder text

- Generated locally from a built-in lorem ipsum corpus. The length presets are: short (≈ 40
  characters), medium (≈ 110), long (≈ 220), two lines, and max lines (fills exactly the
  skin's max lines).
- The speaker name is a placeholder (`Lorem`) or, when a character layer is active, **that
  character's name**. This helps check the nameplate width with real names, and it is the
  only non-lorem text allowed.
- "Shuffle" regenerates the text (seeded).

## UX

- The **VN preview** toggle is in the corner bar (a speech-bubble icon), with the shortcut `P`
  when the canvas has focus (added to the shortcut map). Its popover holds the preset, skin,
  text length, shuffle, element toggles, the occlusion warning and "Lock frame".
- The overlay updates live while layers move or transform (realtime: it is part of the
  render pass, so every `pointermove` repaint includes it).
- The overlay also appears in the timeline playback (plan 06) when enabled. It is still
  excluded from the animation export, but the export dialog has an explicit "Include VN
  preview overlay (preview video only)" checkbox, **off by default**. This is the only path
  where the overlay reaches pixels, and those pixels go to a preview file, never to a layer or
  to generation.
- Screenshot action: "Copy preview to clipboard" copies the frame with the overlay to the
  clipboard for sharing a mock. The file is named `*_preview.png` so it is not mistaken for
  an asset.

## State

`settings.vn_preview = { enabled, preset, skinId, textLength, seed, toggles, lockFrame,
frameRect }` is stored with the widget settings (it is a UI preference, not scene content).
No history entries are created, except moving/resizing a locked frame, which is one entry
because it is a deliberate layout change.

## Where the code goes

- New `web/vnccs_unicanvas_vn_preview.mjs`: frame handling, skin loading/validation,
  lorem generator, text layout, the overlay pass, occlusion detection, the popover and the
  shortcut hook.
- `web/assets/vn_preview_skins/*.json`: shipped skins.
- `web/vnccs_unicanvas.js`: one call at the end of `render()` (the screen-space pass) and
  one guard that asserts no export/generation path calls it. The guard is structural: the pass
  lives only in `render()`, never in `drawFlattenedLayers` / `makeExportCanvas`.
- `web/vnccs_unicanvas_modes.mjs`: the `P` shortcut.

## Tests

- `vn-preview.spec.mjs` (CPU):
  - Toggle on -> overlay pixels appear on the stage canvas.
  - Save to output / flatten / the generation payload (a stubbed `draw` route, inspecting the
    request image) contain **no** overlay pixels: they are pixel-identical to the same
    operation with the overlay off. This is the key guarantee.
  - Max lines -> the text wraps within the textbox (measure the overlay text bbox).
  - Occlusion warning -> a sprite with `faceRect` under the textbox gets flagged, and it is
    cleared after moving the sprite up (live, during the drag).
  - Preset 9:16 -> the frame aspect changes.
- Evidence topic `vn-preview`: before = a scene, after = the same scene with the `Clean dark`
  overlay and an occlusion warning.

## Acceptance

- The overlay never leaves the viewport except through the explicit, off-by-default
  preview-video option and the clipboard preview screenshot.
- The text is always placeholder (lorem + a character name). There are no text layers.
- Layout is correct for every preset and skin, and it is live during manipulation.

## Out of scope

- Text layers, dialogue authoring, scripts and engine code generation.
- Interactive UI (clickable choices, menus).
- Typewriter text animation.
