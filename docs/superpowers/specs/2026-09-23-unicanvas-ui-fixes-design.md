# VNCCS UniCanvas — UI Fixes & E2E Test Platform Design (2026-09-23)

Design spec for the post-implementation verification round in `M4cd1r/ComfyUI_VNCCS_Utils`
(fork of `AHEKOT/ComfyUI_VNCCS_Utils`). Target branch: `unicanvas-next`.

The companion repository `AHEKOT/ComfyUI_VNCCS` (node "VNCSS") is a runtime dependency of
the test platform only and must not be modified.

All four UI/runtime items below were reported by the owner from live testing of the current
`unicanvas-next` build on 2026-09-23. The remaining two workstreams (E2E harness, test
platform image) exist to make that testing fast and cheap on Runpod.

## 1. Scope

In scope:

1. Mannequin options: move from the dimming modal to a left-sidebar section, visible only
   during `Edit pose`.
2. UniCanvas settings: one larger panel anchored under the ⚙ gear instead of over the left
   sidebar.
3. Bug A: the `Edit pose -> Save pose` round trip must be the identity — repeated cycles
   currently deform the mannequin progressively.
4. Bug B: `Edit pose` currently frames the view on the mannequin's head; it must frame on
   the torso center with the mannequin centered in the canvas.
5. Playwright E2E harness for items 1-4, parameterized by the ComfyUI URL of a test pod.
6. Docker test platform (Dockerfile + docker-compose) that boots ComfyUI with the VNCSS and
   VNCCS_Utils custom nodes preinstalled — Lane A: local CPU-only Docker (primary), Lane B:
   optional Runpod GPU pod for GPU-dependent verification.
7. Repository `AGENTS.md` documentation of the E2E harness and the test platform.

Out of scope: any change to `ComfyUI_VNCCS`; generation quality and model plumbing; new
features beyond the fixes above; multi-character pose scenes.

## 2. Defects (verified live, 2026-09-23)

| # | Symptom | Where |
|---|---------|-------|
| 2.1 | Mannequin options open as a modal on `vnccs-uc-modal-overlay` (`background:rgba(4,4,8,.58)`) — the screen dims and the stage is blocked. Required: options in the left sidebar (`vnccs-uc-left`, next to GENERATE / model pickers), no dimming, mannequin visible on the photo background while adjusting. | `web/vnccs_unicanvas_pose_layers.mjs:893` (`openUniCanvasPoseOptions`) |
| 2.2 | Settings open as a small panel at fixed `left:24px; top:48px`, i.e. visually over the left sidebar (11px font, 280px min-width). Required: one bigger panel anchored under the gear in the canvas corner bar. | `web/vnccs_unicanvas.js:6871` (`openUniCanvasSettings`) |
| 2.3 | Repeating `Edit pose -> Save pose` (without touching anything) progressively distorts the mannequin (reported: gets narrower, proportions shift). | `web/vnccs_unicanvas_pose_layers.mjs:1156-1264` |
| 2.4 | Entering `Edit pose` frames the mannequin head at the canvas center instead of the torso middle, so the mannequin is off-center. | `web/vnccs_unicanvas_pose_layers.mjs` edit-session setup |

## 3. Mannequin options section (item 1)

3.1 **Placement.** The option controls render as a section inside `vnccs-uc-left` (the
widget's left column that hosts GENERATE and the Parameters/model panels), appended below
the Parameters section. The section title is `Mannequin options`.

3.2 **Lifecycle.** The section mounts when a pose edit session starts (`Edit pose` /
pose-layer edit entry) and unmounts when the session ends (`Save pose`, `Cancel`, layer
removal, widget dispose). Outside an edit session the section does not exist — no permanent
sidebar footprint.

3.3 **No modal.** `vnccs-uc-modal-overlay` is not used for mannequin options. Nothing dims
or blocks the stage: the pose-edit overlay stays `background:transparent`
(`web/vnccs_unicanvas_pose_layers.mjs:72`) and the photo/layer stack remains visible behind
the mannequin while options are adjusted.

3.4 **Contents (unchanged behavior).** Gender toggle (Male/Female, `meshParams.gender`),
Body (age/weight/muscle/height), Female section (breast size, firmness) shown only while
female, Male section (show genitals + penis morphs) shown only while male, Proportions
(section keys `POSE_EDIT_PROPORTION_KEYS`). Double-click a slider resets it.

3.5 **Realtime (repo AGENTS.md rule).** Every control drives the mannequin continuously
from `input`/`pointermove`; morph application is coalesced per animation frame
(`requestAnimationFrame`), the newest value always wins, and slider/number pairs stay
synchronized during the gesture. End-of-gesture events may only persist/commit, never first
paint.

3.6 **Edit bar.** The `Options` button is removed from the pose-edit bar (`Pose Library`,
`Save pose`, `Cancel` remain) — the sidebar section is always visible during editing, the
button would be redundant.

## 4. Settings panel under the gear (item 2)

4.1 **Anchor.** The panel positions directly below the ⚙ gear button of the canvas corner
bar (`gearBtn`), computing `gearBtn.getBoundingClientRect()` against the widget container —
the same anchoring approach as the edit-refs popover (`web/vnccs_unicanvas.js:6860-6867`).
It must never land over the left sidebar.

4.2 **One panel, bigger.** A single scrollable panel (same field list as today: remove-bg
backend + edit model, character-generation recipe). Minimum width 400px, 13px base font,
`max-height:70vh` with `overflow-y:auto`, visible border and shadow (reads as "open and
attached to the gear"), clamped inside the container on narrow hosts.

4.3 **Closing.** Toggle: clicking the gear again closes; `Close` button; clicking outside
the panel closes. No dim overlay.

4.4 **Realtime.** Every field commits on `input` (existing `commit()` -> `flushSettingsToWidget`),
custom selects keep the repo `installCustomSelects` convention.

## 5. Pose round-trip idempotence — Bug A (item 3)

5.1 **Invariant.** For a session that changes nothing: `save(edit(load(pose))) == pose`, and
the composition over N cycles equals one cycle. Concretely the rendered layer pixel bounds
and `layer.poseData` (bone deltas, morphs, camera, size) must be stable across cycles within
numeric tolerance.

5.1b **Position preservation** (owner acceptance criterion, 2026-09-23): after a pose
change and Save, the mannequin's torso anchor stays at the same position on the canvas —
the capture is torso-anchored (6.2) and the editor save draws the capture at the fixed
natural rect, so re-posing limbs does not translate the body; silhouette changes are the
pose change itself. Legacy layers re-frame once on their first save (6.3). Verification
gate: on the merged build, a pose-change save must not translate the torso anchor; if
residual drift is measured, the draw offset aligns the new capture's content centre with
the layer's previous content centre (never scaled).

5.2 **Storage contract.** `poseData.pose.bonePositions` stays RELATIVE to the shaped rest
(`bonePositionsRel:true`, `web/vnccs_unicanvas_pose_layers.mjs:1156-1192`) and carries
**un-scaled** deltas: proportion morphs (`*_length`, `head_size`, ...) and body morphs
influence the rendered mesh/skeleton only and must never be multiplied into the stored
deltas.

5.3 **Process (systematic debugging).** Root cause first: read `setPose`, `getPose`,
`updateBoneLengthScale`, `shapedBoneRestPositions`, `loadData` in
`web/vnccs_pose_studio_core.js` and identify where a scale factor enters the persisted
positions. A numeric round-trip test (stub viewer, N=10 cycles) is written and shown RED
before any fix, then GREEN after.

5.4 **Fix location by evidence.** Option Z1: normalize at the storage boundary
(`relativize`/`absolutize` + save/load) so the stored delta is canonical. Option Z2: make
the viewer-core apply path idempotent (`setPose` after `updateBoneLengthScale`). No drift
compensation ("re-center on save") is acceptable — that treats the symptom.

## 6. Torso-anchored framing — Bug B (item 4)

6.1 **Anchor.** The framing anchor is the torso center: the midpoint between the pelvis
head and the top of the chest/neck segment of the rig. The exact bone names are pinned by
unit test (rig: MakeHuman-derived Pose Studio skeleton); a fallback chain (pelvis+spine,
then model bounding-box center excluding the head bone) is documented in code.

6.2 **WYSIWYG.** The edit-session view framing and the capture framing used by `Save pose`
(`captureUniCanvasPoseEditPNG`) are the same framing object, so what the user sees is what
lands in the layer pixels. The mannequin is centered in the canvas horizontally and the
torso center sits at the canvas center vertically.

6.3 **Legacy layers.** Existing pose layers re-frame on their first save after this change;
this is the intended fix behavior and is noted in `CHANGELOG.md`.

## 7. E2E test harness (Playwright) — item 5

7.1 **Layout.** `tests/e2e/` with its own `package.json` (private; devDependency
`@playwright/test`) and `playwright.config.mjs`, so the repository root stays
dependency-free and the existing `node --test` / pytest CI is untouched. Tests are plain JS
(`.spec.mjs`) to match the repository style.

7.2 **Target.** The only input is the ComfyUI URL of the running platform:
`COMFYUI_URL=http://localhost:8188` (Lane A, local Docker CPU) or
`COMFYUI_URL=https://<pod>.proxy.runpod.net` (Lane B, Runpod). No `webServer`, no
authentication. `fullyParallel:false`, one worker (a single shared ComfyUI state),
`retries:1`, chromium only.

7.3 **Fixtures & measurement basis.** Helpers to: open the standalone "Unicanvas" sidebar
tab (no workflow), add a pose layer, enter/leave `Edit pose`, run an edit->save cycle, and
measure the rendered mannequin. Two measurement bases only: (a) a 2D layer-pixel scan
(alpha bounding box + centroid) of the saved layer — used by the round-trip and framing
specs (6.2 makes the saved framing identical to the edit view, so the assertion transfers);
(b) a Playwright element screenshot of the live pose-edit canvas (composited, includes the
WebGL output) with a pixel diff — used for during-gesture realtime assertions. The live
WebGL drawing buffer is never read directly. GPU generation is never called; the mannequin
pipeline is client-side WebGL and needs no models.

7.4 **Specs (one per implemented item, plus a harness smoke test):**

| Spec | Asserts | Covers |
|---|---|---|
| `smoke.spec.mjs` | standalone tab loads, pose layer add → edit → save happy path | harness itself |
| `mannequin-options.spec.mjs` | section exists in `.vnccs-uc-left` during Edit pose and is gone after Save/Cancel; no `.vnccs-uc-modal-overlay` while it is open; slider `input` (basis b) changes the mannequin before any pointerup; gender toggle swaps Female/Male sections | item 1 + realtime rule |
| `settings-panel.spec.mjs` | gear opens exactly one panel whose box starts below the gear (and clear of `.vnccs-uc-left`), width ≥ 400px; second gear click / outside click / Close dismiss it; a field change commits without reopening | item 2 |
| `pose-roundtrip.spec.mjs` | 5 consecutive edit→save cycles keep the mannequin alpha bbox within 1% of cycle 1 (width, height, area) | Bug A (red until fixed) |
| `pose-framing.spec.mjs` | on entering Edit pose the mannequin alpha bbox is horizontally centered (±2% canvas width) and the torso anchor sits at the vertical canvas center (±3%) | Bug B (red until fixed) |

7.5 **Evidence mode.** `npm run evidence -- --label <topic>` captures Before/After pairs
against the live pod: same crop, same scale, side-by-side labelled exactly `Before` / `After`
(English, per `~/.dsh/AGENTS.md`), plus a standalone `After` shot and the measured geometry
(element boxes, computed styles) written next to the images. Output goes to
`tests/e2e/evidence/<topic>/` (kept locally; hosted on an `evidence/<topic>` branch when a
PR is opened).

## 8. Test platform image (Dockerfile + compose) — item 6

8.1 **Goal — two lanes.** The platform boots a ComfyUI with the VNCSS and VNCCS_Utils
custom nodes preinstalled and no per-session clone/pip work.

- **Lane A (primary): local Docker, CPU-only.** The four fixes under test are browser-side
  (DOM + client-side WebGL mannequin), so no GPU is needed to browse and drive the UI. The
  whole E2E suite runs against `http://localhost:8188` on the developer machine. Zero
  Runpod cost.
- **Lane B (optional): Runpod GPU pod** from the CUDA variant of the same image, used only
  for GPU-dependent verification (image generation, remove-bg backends, Generate character).
  Boot-to-test under ~3 minutes instead of the ~25 minute manual install of the 2026-09-23
  session.

**No fork-specific hardcodes.** The repository under test is a parameter everywhere
(build args, env, script parameters) because this fork merges into the mainline later:
`VNCSS_UTILS_REPO` (default `https://github.com/M4cd1r/ComfyUI_VNCCS_Utils`) and
`VNCSS_UTILS_REF` (default `unicanvas-next`) are build args, `sync-wip.ps1` takes the
working tree and target URL as parameters, and the registry name is documented as
configurable.

8.2 **`tests/e2e/platform/Dockerfile`.** One parameterized file, `ARG BASE_IMAGE`
(default `python:3.12-slim` = Lane A CPU) with a documented CUDA build using
`runpod/comfyui:cuda12.8` as `BASE_IMAGE` (Lane B, ComfyUI 0.26.x + CUDA 12.8 per the
Runpod policy). Common steps: clone ComfyUI (CPU lane only — the CUDA base ships it),
`VNCSS_UTILS_REPO`/`VNCSS_UTILS_REF` + `VNCSS_REPO`/`VNCSS_REF` (defaults
`https://github.com/AHEKOT/ComfyUI_VNCCS` / `main`) into `custom_nodes/`, CPU torch wheels
on Lane A (torch is preinstalled on Lane B), preinstall the Python requirements of ComfyUI
and both custom nodes (the expensive part), then one headless ComfyUI boot as a build-time
sanity check.

8.3 **`tests/e2e/platform/docker-compose.yml` (Lane A).** Local CPU-only run: service
`comfyui`, `8188:8188`, `ipc:host`, a healthcheck on `/system_stats`, and a bind mount of
the working tree over `custom_nodes/ComfyUI_VNCCS_Utils` so WIP code is testable without
rebuilding the image. `docker compose up` on any CPU machine is the whole setup before
`COMFYUI_URL=http://localhost:8188 npx playwright test`.

8.4 **WIP code injection.** The image is immutable; code under test is refreshed at run
time. Lane A uses the compose bind mount (8.3). Lane B uses
`tests/e2e/platform/sync-wip.ps1` (parameters: `-Source` working tree, `-Target` pod SSH
destination; packs `web/`, `nodes/`, `tests/`, sends them and restarts ComfyUI). Rebuilding
the image is needed only when Python requirements change.

8.5 **Image name & registry (parameterized).** Lane A never needs a registry — the image is
built locally (`docker compose build`). Lane B publishes for pod pulls; the name is a
parameter with the documented default `ghcr.io/m4cd1r/comfyui-vnccs-test` (GitHub `gh` CLI
auth already in use; Docker Hub as fallback). Build/push runs manually from this machine
and is documented in AGENTS.md (`docker buildx build --push`); a CI workflow is explicitly
out of scope for this round and gets added only if local build/push proves impossible.

8.6 **Runpod usage — Lane B only (policy-bound).** Used when GPU inference must be
exercised. `create-pod` with the CUDA image: 1× cheapest GPU with ≥24 GB VRAM and CUDA 12.8
(RTX 4090 preferred), 150 GB container disk, no network volume, ports `8188/http` + `22/tcp`,
`startSsh`, a pre-declared lifetime with a kill task scheduled at launch, and the hard $1
per-session cost cap from `~/.dsh/AGENTS.md`. Teardown: stop and terminate the pod and
confirm no stray pods remain.

## 9. Documentation (item 7)

The repository `AGENTS.md` keeps its existing realtime-interaction rules and gains two
English sections:

- **E2E tests (Playwright)** — what lives in `tests/e2e/`, that the only input is
  `COMFYUI_URL`, the install/run commands, the spec inventory and what each spec guards,
  evidence mode and its output layout, and the rule that E2E must never trigger GPU
  generation or model downloads.
- **Test platform (Docker)** — the two lanes (Lane A local CPU Docker as primary, Lane B
  Runpod GPU pod for GPU-dependent verification only), what the image ships, the build args
  (`VNCSS_UTILS_REPO`/`REF`, `VNCSS_REPO`/`REF`, `BASE_IMAGE`), compose usage,
  `sync-wip.ps1`, the configurable image target, the note that nothing is hardcoded to this
  fork (it merges into the mainline later), and the Runpod cost guardrails (cheapest ≥24 GB
  CUDA 12.8 GPU, kill task at launch, $1 cap, terminate after testing).

## 10. Testing & verification

1. **Unit/contract tests** (existing `node --test` / pytest harness, red → green): numeric
   round-trip identity (5.3), framing anchor math with pinned bone names (6.1), UI contracts
   — mannequin section mounts in `.vnccs-uc-left` and disappears with the session, options
   never mount `vnccs-uc-modal-overlay`, settings panel carries the anchored class/style
   contract (class-vs-style mismatches are exactly what stub-DOM tests catch best).
2. **E2E on the live pod** (section 7) is the acceptance gate for items 1-4, including the
   two red specs for Bug A and Bug B.
3. **Screenshots** for every UI change, captured on the live instance: Before/After pair
   (same crop, same scale, labelled `Before`/`After`) + standalone After + measured geometry
   (4.2, 3.x), per `~/.dsh/AGENTS.md`; local evidence copy kept under
   `tests/e2e/evidence/`.
4. **Realtime rule** (repo `AGENTS.md`) is verified by the `mannequin-options` spec: visible
   effect on `input`/`pointermove` during the gesture, not on release.

## 11. Risks

- **WebGL readback** is unreliable for assertions (drawing buffer may be cleared), so all
  geometric assertions scan the 2D layer pixels after save/capture — never the live WebGL
  buffer.
- **Rig bone names** differ between MakeHuman-derived builds; 6.1 pins them in tests and the
  fallback chain keeps framing sane if a name is missing.
- **Image size** (~2-3 GB CPU lane, ~8-12 GB CUDA lane) makes builds slow; the image is
  dependency-stable and WIP code syncs at run time (8.4), so rebuilds are rare.
- **CUDA-only imports** in custom-node Python code must not break the CPU lane at import
  time; the Docker build-time boot (8.2) catches this, and any offending import is guarded
  rather than the lane being dropped.
- **Legacy layers re-frame** on first save (6.3) — accepted and documented behavior change.
- **Root-cause uncertainty for Bug A** — 5.4 names both fix locations; if neither makes the
  round trip an identity, the work stops and the architecture of the pose storage is
  revisited with the owner instead of shipping a compensation.
