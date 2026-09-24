# Plan 10 - Projects, asset library and generation history

## Goal

A visual novel is dozens of scenes with the same cast. UniCanvas today holds **one canvas**,
and its persistence is fragile:

- Node mode keeps a light state in the `unicanvas_state` widget and the full state in a
  **server cache under ComfyUI's temp directory** (`_UNICANVAS_STATE_CACHE_DIR` in
  `nodes/unicanvas.py`). ComfyUI clears the temp directory on startup, so the full state
  survives only through the `localStorage` backup (`saveLocalStateBackup`), which silently
  gives up when the state is too large.
- Standalone mode persists **only** to `localStorage` (`writeStandaloneState` in
  `web/vnccs_unicanvas_modes.mjs`), and it stops above about 4 MB with "work will not survive
  a reload".

This plan adds three layers, delivered in phases:

- **Phase A - Provenance and projects:** `layer.meta` provenance on every layer, and
  durable server-side **project files** holding **multiple scenes**, saved incrementally.
- **Phase B - Asset library:** reusable characters, backgrounds, props, poses, preview skins
  and generation presets, shared across scenes and projects.
- **Phase C - Generation history:** every generation is recorded with its full settings and
  all its results, browsable in a gallery, restorable and re-runnable.

Phase A is the foundation for plans 02, 03, 05 and 07. It ships first.

## Phase A - Provenance and projects

### `layer.meta` (provenance)

Every layer gets `meta = { origin, createdAt, historyId?, prompt?, negative?, mode?, model?,
seed?, character?: { id, name }, sourceName?, derivedFrom?, assetId?, heightFactor? }`.

- `origin`: `base` | `paint` | `generate` | `bake` | `sprite` | `import` | `psd` | `paste` |
  `duplicate` | `rasterize` | `split` | `occluder` | `shadow` | `asset`.
- It is set at every creation site: `_createInitialLayers` (base), `addLayer` from the UI
  (paint), `acceptStaging` (generate; the staging item must carry a **settings snapshot**, so
  `_stageGeneratedImages` stores `{ prompt, negative, mode, model family/ckpt, loras, seed,
  steps, cfg, sampler, scheduler, denoise, bbox, historyId }` on each item), `importFile` /
  `createPsdLayer` (import/psd with the file or PSD layer name), `duplicateActiveLayer`
  (duplicate, `derivedFrom`), `createUniCanvasPoseLayer` / `rasterizeUniCanvasPoseLayer`, and
  the new sites in plans 01-08.
- It is serialized in `serializeLayer` and restored as is. Old layers get
  `{ origin: "unknown" }`. It is shown in a layer row tooltip and in the history gallery.

### Project model

A **project** holds scenes, a project-level asset library (phase B) and a history (phase C).

Storage lives under ComfyUI's user directory: `folder_paths.get_user_directory()` /
`<comfy user>` / `vnccs_unicanvas/projects/<projectId>/`. It is durable, per ComfyUI user,
outside temp and outside `output/`. Layout:

- `project.json`: `{ schemaVersion, id, name, createdAt, updatedAt, rev, scenes: [{ id,
  name, order, thumbnail, updatedAt }], activeSceneId, settings }`.
- `scenes/<sceneId>/scene.json`: exactly the `buildSerializedState` shape, with every
  `dataURL` / `hiresDataURL` / variant / mask / ID / normal pixel field replaced by a **blob
  reference** `{ blob: "<sha256>.png", crop }`.
- `blobs/<sha256>.png`: content-addressed pixel blobs, shared across scenes, so a
  duplicated scene or layer costs no extra disk.
- `thumbs/<sceneId>.png`: a 512 px scene thumbnail.
- `assets/`, `history/`: phases B and C.

**Saving is incremental.** The client tracks each layer's pixel revision
(`bumpLayerPixelRevision` already exists) and uploads only blobs whose revision changed since
the last save. Upload order: first the missing blobs (`PUT /vnccs/unicanvas/projects/{id}/blobs/{sha}`,
which is idempotent, where the server verifies the hash), then the scene JSON with an
optimistic `ifRev` (`PUT .../scenes/{sceneId}`). A stale `ifRev` (another tab saved) returns
`409`, and the UI offers "Reload theirs" / "Save mine as a copy". Blob garbage collection runs
on project open: blobs unreferenced by any scene, asset or history record older than 24 h
are deleted.

**Autosave:** the same scheduling as today's `scheduleStateUpload` (debounced, deferred while
`isPointerDown` or `drawInProgress`), but targeting the project. The status chip in the corner
shows `Saved` / `Saving...` / `Offline - retrying`. Failed saves retry with backoff and keep
the dirty set. Nothing is dropped.

**Routes** (`nodes/unicanvas.py`, all under `/vnccs/unicanvas/projects`):

- `GET` list (id, name, updatedAt, scene count, thumbnail)
- `POST` create
- `GET {id}`
- `PATCH {id}` (rename, settings, scene order)
- `POST {id}/duplicate`
- `DELETE {id}` (moved to `vnccs_unicanvas/trash/`, purged after 30 days)
- `POST {id}/scenes` (new, or duplicate with `fromSceneId`)
- `GET/PUT/DELETE {id}/scenes/{sceneId}`
- `PUT/GET {id}/blobs/{sha}`
- `POST {id}/export` (a zip of the project directory, for backup/transfer)
- `POST /vnccs/unicanvas/projects/import` (the zip)

Ids are sanitized with the existing `_SAFE_ID_RE` rule, and every path is resolved and checked
to stay inside the projects root.

### UX

- **Project bar** (the top of the right column, or the fullscreen chrome title area): the
  project name (click opens the project browser) and the **scene tabs** (the active scene,
  `+` new scene, a right-click menu with rename/duplicate/delete/reorder by drag).
- **Project browser** (a modal): a grid of projects with thumbnails, search, new, open,
  duplicate, rename, delete, and export/import zip.
- Switching scenes saves the current one (awaits a pending save) and loads the other through
  `applySerializedState` with blob fetches. The last valid frame stays visible while loading
  (no blank flash), with a progress chip.
- **Node mode:** the node's widget stores `{ projectId, sceneId }` plus the light state. On
  execution, `export_state` renders the scene from the project (a new code path next to the
  state cache read, `_read_unicanvas_state_cache`). The temp state cache stays as a fallback
  for workflows that were never attached to a project.
- **Standalone mode:** projects replace the `localStorage` document. `localStorage` keeps only
  `{ lastProjectId, lastSceneId }` (the per-viewer convenience rule).
- **Migration:** on first load of a widget or standalone tab with an existing state (server
  cache or `localStorage`) and no `projectId`, the state is imported automatically into a new
  project "Untitled - <date>" with one scene. A one-time status note says so. The old storage
  is left untouched, so a rollback is possible.

## Phase B - Asset library

Two scopes with the same format: **project assets** (`projects/<id>/assets/`) and the **global
library** (`vnccs_unicanvas/library/`), for cross-project reuse (a recurring cast, a UI skin).

Asset kinds and payloads (`asset.json` + blobs):

- `character`: name, VNCCS character id (if any), **identity reference image** (used by plan
  02), `heightFactor` (plan 08), default morphs, tags, and an optional linked **sprite set**
  (plan 03 variants as blobs with their anchor/faceRect).
- `background`: an image (+ optional depth map cache and the perspective model from plan 08, so
  a reused background brings its horizon calibration).
- `prop`: an image with alpha and an anchor.
- `pose`: a pose layer `poseData` (single or multi-character, plan 01).
- `skin`: a VN preview skin (plan 07).
- `preset`: a generation settings snapshot (model family, ckpt, LoRA stack, sampler, steps,
  cfg, prompt templates), so the look of a VN stays the same across scenes.

UX:

- A **Library** panel (a tab next to Layers): kinds as filters, search by name/tag, thumbnails,
  and a project/global scope switch.
- **Save to library** in the layer context menu (character layers become `character` with the
  sprite set; others become `prop`/`background` by category from plan 05). Presets are saved
  from the settings popover.
- **Drag an asset onto the canvas** inserts it as a layer (`meta.origin = "asset"`,
  `meta.assetId`) at the drop point, anchored on its anchor (feet for characters; with plan 08
  depth-scale on, it is scaled for the drop y). Characters insert their sprite set as a sprite
  layer (plan 03), or a pose layer with the identity preselected when the asset has no sprites.
- **Update from library** / **Push to library** on layers linked to an asset (a changed
  identity reference or new sprite variants propagate on request, never automatically).
- The character dropdown of pose layers (the `/vnccs/list_characters` source) also lists
  library characters (`source: "library"`), and plan 02 bakes them with their identity
  reference.

## Phase C - Generation history

Every generation run writes a **history record** to `projects/<id>/history/<historyId>.json`
+ blobs:

- The kind (`generate` | `bake` | `sprite` | `harmonize` | `remove_bg` | `color_match`), the scene
  and target layer ids, the timestamp and duration.
- The full settings snapshot (the same fields as `layer.meta`, plus the LoRA stack, preset id,
  config-linked flag and inference size).
- Input thumbnails (working image, mask) at 256 px.
- **All** results (every staged image, including discarded ones) as blobs, each with
  `accepted: true|false` and the layer id it became.

The record is written by the client when a run settles (staging populated, or failure with
the error). Results are uploaded as blobs, so each accepted image is stored exactly once
(content addressing).

**History gallery** (a tab next to Library): a reverse-chronological grid with filters (scene,
kind, accepted only, model family, text search over prompts). Per record:

- **Restore settings** (applies the snapshot to the panel, one history entry for the settings
  change),
- **Re-run** (same seed) / **Re-run new seed**,
- **Place result as layer** (for discarded results too),
- **Show the layer** (jumps to the layer that came from it), and a **compare** view (A/B slider
  between two results).

Retention: a per-project cap, default 1000 records or 4 GB of blobs, configurable in
settings. Pruning removes the oldest discarded results first, then whole records, and never
blobs referenced by a scene or asset.

## Where the code goes

- New `web/vnccs_unicanvas_project.mjs`: the project client (routes, blob hashing with
  `crypto.subtle.digest`, the incremental save queue, conflict handling, autosave, migration,
  the project bar and browser, the scene tabs).
- New `web/vnccs_unicanvas_library.mjs`: the Library panel, save/insert/update assets.
- New `web/vnccs_unicanvas_history_gallery.mjs`: record building (hooked into `draw()`, bake,
  sprites, harmonize, remove bg, color match), the gallery UI and the actions.
- `web/vnccs_unicanvas.js`: `layer.meta` at creation sites, the staging items carrying the
  settings snapshot, `serializeLayer` blob-reference mode, and the persistence hooks
  (`scheduleStateUpload` / `flushStateUpload` route to the project when attached).
- `web/vnccs_unicanvas_modes.mjs`: standalone persistence switches to projects and keeps only
  the last ids in `localStorage`.
- New `nodes/unicanvas_projects.py` (keeps `nodes/unicanvas.py` from growing further):
  storage, path safety, blob store, GC, zip export/import, and the routes. It is registered
  from the same `PromptServer` block as the other routes. `export_state` in
  `nodes/unicanvas.py` gains the project read path.

## Tests

- Backend pytest:
  - Path traversal attempts are refused.
  - A blob hash mismatch is refused.
  - `ifRev` conflict -> 409.
  - GC keeps referenced blobs.
  - A zip export -> import round trip is equal.
  - A migration import of a fixture state produces an equivalent scene.
- `projects.spec.mjs` (CPU):
  - Create a project, paint and generate (stubbed), then reload the page -> the scene is
    restored pixel-identically.
  - Add a second scene, switch back and forth -> both are intact, and there is no blank frame
    during the switch (the stage canvas is never fully transparent between frames).
  - Duplicate a scene -> no new blobs uploaded (a spy on `PUT blobs`).
  - Restart the container (Lane A `docker compose restart`) -> the project survives. This is
    the regression check for the temp directory wipe.
  - Standalone: a 10 MB state persists (above the old `localStorage` limit).
- `library.spec.mjs`: save a character with a sprite set -> insert it into another scene ->
  the variants are equal. Drag-insert lands the anchor at the drop point.
- `history-gallery.spec.mjs`: a stubbed generation with batch 3, accept 1 -> the record has 3
  results, 1 accepted. Restore settings -> the panel values are equal. Place a discarded
  result -> a new layer.
- Evidence topics `projects` (the project bar + scene tabs), `library`, `history-gallery`.

## Acceptance

- Work survives ComfyUI restarts, browser reloads and large states in both node and
  standalone modes.
- Saving is incremental. Unchanged layers are never re-uploaded.
- Every generated image (accepted or not) can be found, restored and re-run.
- Existing workflows and standalone documents migrate automatically without data loss.

## Out of scope

- Multi-user collaboration or cloud sync.
- VN engine export (plan 09, deferred). The project format already holds what that exporter
  needs: scenes, states, sprite sets with anchors, and provenance.
