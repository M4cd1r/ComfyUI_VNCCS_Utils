# Task 5 Report: Pose round-trip idempotence (Bug A) — with Fix Round 1

**Status: DONE_WITH_CONCERNS** (production fix verified correct by review; fix round 1 delivered: real evidence pair, poseData stability clause, and the 5.1b placement-preservation production fix)

**Work location:** `.worktrees/t5-pose-roundtrip`, branch `feat/unicanvas-pose-roundtrip`.

## Round 0 (original task)

- **Commit (relocated by controller):** `aa41a63` on unicanvas-next → cherry-picked as `fad0f77` on `feat/unicanvas-pose-roundtrip`.
- **Root cause (probe-verified):** the editor save squeezed each fresh 1024x1024 capture into the layer's PREVIOUS alpha bounds (`getLayerAlphaBounds`), shrinking the mannequin every edit→save cycle (378x595 → 140x346 → 52x202 → 20x118 → 8x69; exactly the 378/1024 and 595/1024 squeeze ratios per cycle). The viewer capture itself was byte-identical across cycles — rest cache, `initialBoneStates`, morph solve all exonerated.
- **Fix:** `drawUniCanvasPoseRenderIntoLayer(..., { respectLayerCrop })`; the editor save path draws 1:1 at natural `render.size` (bridge previews keep crop alignment). Exported `relativizeUniCanvasPoseBones` / `absolutizeUniCanvasPoseBones` / `drawUniCanvasPoseRenderIntoLayer` for tests.
- **Result:** probe.json pixel-identical across 5 cycles; numeric suite 30/30 (main checkout state); e2e RED→GREEN.

## Fix Round 1 (this round, all in the t5 worktree)

### FIX 1 — Real Before/After evidence pair

- `tests/e2e/evidence/pose-roundtrip/before.png` = **retained pre-fix artifact** (`debug-cycle-3.png`): cycle-3 pose layer pixels captured live from the PRE-FIX build (vnccs-t5 instance, RED probe phase). Shows the collapsed "stick figure".
- `after.png` = cycle-3 pose layer pixels captured live from the FINAL fixed build (3 add→edit→save cycles, unchanged input).
- Same crop (full 2048x2048 layer bitmap, 1:1 pixels) and same scale on both sides; verified dimensions equal.
- Composed via `node evidence.mjs --topic pose-roundtrip --phase compose` → `pose-roundtrip.pair.png` (labels exactly "Before"/"After", sides at identical 800px scale) + standalone `pose-roundtrip.after.png`.
- `evidence.mjs` compose branch was adapted locally (bound each side to 800px so both 2048px sides fit the 1700px viewport; the unadapted compose cropped to an empty corner). Uncommitted per standing steering.
- Local capture tool `tests/e2e/capture-cycle-pixels.mjs` used for After (uncommitted, kept in the worktree for future evidence rounds; delete on request).

### FIX 2 — `layer.poseData` stability clause (spec 5.1 storage)

- Hook: `web/vnccs_unicanvas_modes.mjs` `__VNCCS_UC_E2E__.getLayerPoseData(layerId)` — read-only deep clone (`JSON.parse(JSON.stringify(layer.poseData))`), sibling of `getLayerPixels`. No behavior change.
- Spec: `tests/e2e/pose-roundtrip.spec.mjs` reads the hook after every save cycle and asserts the JSON-stringified `poseData` equals cycle 1's for cycles 2..N (message names the spec 5.1 storage clause).
- **RED demonstration (mutation test):** temporarily mutated `relativizeUniCanvasPoseBones` to add +1e-6 to each stored delta per save — a visually INVISIBLE storage drift of exactly the class a "compensating visual-only fix" would leave behind. Result: `layer.poseData drifted at cycle 2 (spec 5.1 storage clause)` — `Root:[0.000001,0,0]` vs `Root:[0.000002,0,0]` — while the alpha-bbox assertions remained untouched (a 1e-6 model-unit shift is subpixel). Mutation reverted; suite GREEN. The clause therefore adds teeth the pixel assertions cannot provide.
- Note: on the ORIGINAL Bug A the stored poseData was already stable (drift was purely in the redraw), so this clause is a forward guard, not a Bug A detector — as the controller's RED argument states.

### FINDING → production fix: preserve the moved placement (spec 5.1b)

- **Reproduction (controller-reported, verified):** mannequin moved to bottom-left (move tool bakes the offset into the bitmap via `moveActiveLayerPixels` → `commitActiveLayerMove`, vnccs_unicanvas.js:3898/3925, which redraws the bitmap shifted and refreshes `_boundsCache` at :3954) → Edit pose → Save pose unchanged → the character jumped back to the canvas centre (the natural-rect fallback from the Bug A fix discarded the baked placement).
- **Fix (`web/vnccs_unicanvas_pose_layers.mjs`):** in the `respectLayerCrop:false` (editor save) branch, before drawing: read the previous content bounds (`widget.getLayerAlphaBounds(layer)`), scan the incoming capture's alpha bounds on a scratch canvas (`scanUniCanvasCaptureAlphaBounds` → `widget.getCanvasAlphaBounds`, same style as the widget's own bounds scan), then shift the 1:1 natural rect by `previousContentCentre − (naturalRect + incomingContentCentre)`. Never scales; empty-layer fallback stays centred; the `respectLayerCrop:true` bridge branch is untouched. Fixed point: after one aligned save the drawn content centre equals the previous centre, so repeated saves reproduce the identical footprint (idempotence e2e + poseData clause stay green).
- **Unit RED** (`tests/test_unicanvas_pose_placement.mjs`, self-contained — see branch note below): with the draw-recorder stub, an off-centre previous content must be redrawn with its content centre preserved (≤0.5px) at natural size, and an empty layer stays centred. Pre-fix: `content centre must match the previous placement on x` (drew centred). Post-fix: pass.
- **E2E RED** (`pose-roundtrip.spec.mjs`, second test): add pose layer → save → move-tool drag (−300, +200 on `canvas.vnccs-uc-stage`) → Edit pose → Save pose unchanged → canvas-space centroid preserved within 2px. Pre-fix: failed the centroid assertion (the owner's jump). Post-fix: pass.
- **GREEN:** placement unit 1/1; full e2e suite: pose-roundtrip (2), smoke, measure (2) all pass; poseData clause green.

## Verification summary

| Suite | Result |
|---|---|
| `node --test tests/test_unicanvas_pose_placement.mjs` | 1/1 pass |
| `npx playwright test` (worktree, http://localhost:8195) | 4 passed (1 environmental flake on first attempt, see below) |
| `npx playwright test pose-roundtrip.spec.mjs` (re-run for stability) | 2/2 pass |

## Files changed this round

- `web/vnccs_unicanvas_pose_layers.mjs` — 5.1b placement-preserving save draw (production fix)
- `web/vnccs_unicanvas_modes.mjs` — `getLayerPoseData` hook
- `tests/e2e/pose-roundtrip.spec.mjs` — poseData stability clause + 5.1b placement e2e
- `tests/test_unicanvas_pose_placement.mjs` — new self-contained unit test (new file)
- `.superpowers/sdd/2026-09-23-unicanvas-ui-fixes/task-5-report.md` — this report
- Local-only (uncommitted): `tests/e2e/evidence.mjs` (compose bounding + pose-editor opener), `tests/e2e/capture-cycle-pixels.mjs`, `tests/e2e/evidence/pose-roundtrip/*` (gitignored evidence)

## Deviations / notes for the controller

1. **Branch pre-existing breakage:** on `feat/unicanvas-pose-roundtrip` (fad0f77) the committed `tests/test_unicanvas_pose_layers.mjs` imports `buildUniCanvasPoseOptionsSection` / `mountUniCanvasPoseOptions` / `unmountUniCanvasPoseOptions`, which require the T3 production commit (e65b762 on unicanvas-next) that is NOT on this branch — `node --test tests/test_unicanvas_pose_layers.mjs` fails at import until that production commit lands here. My new unit test therefore lives in a self-contained `tests/test_unicanvas_pose_placement.mjs` (its own draw-recorder stub) so it is runnable on this branch today and stays valid after the T3 merge.
2. **Container removed externally mid-round:** the vnccs-t5 container (worktree bind, port 8195) vanished (`docker ps -a` empty, not OOM-exited — removed) between e2e runs; I recreated it from the worktree with the same project/port. Other agents' containers untouched. Current state: `vnccs-t5-comfyui-1` healthy on `0.0.0.0:8195`.
3. **First-boot environmental flake:** right after container recreation, ComfyUI's own `dialog-overlay` (z-1700) intercepted the Unicanvas tab click for ~120s on the first spec attempt (timeout → retry passed). Unrelated to the code; worth a pre-wait in the harness if fresh-container runs become common.
4. **Round-0 notes still standing:** the brief's FakeViewer round-trip test is a regression pin (storage was already identity); bridge preview path keeps `respectLayerCrop:true` semantics (unchanged); evidence.mjs/capture tooling stays uncommitted per steering.

## Live instances

- **http://r1s3n.local:8195/** — vnccs-t5, bound to THIS worktree (fix round 1 live), healthy, left RUNNING.
- http://localhost:8188/ — shared merged instance (verified serving the round-0 fix; used for the first After-capture cross-check).
