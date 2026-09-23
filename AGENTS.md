# VNCCS-Utils Project Rules

These instructions apply to the entire repository and every VNCCS-Utils widget, including 3D Factory, Pose Studio, UniCanvas, Model Manager, Model Selector, and future interactive nodes.

## Realtime interaction is mandatory

Every interactive control must show its effect continuously while the user is interacting with it. The user must never have to release the mouse button, pointer, pen, or key before seeing the result.

- Sliders, numeric scrubbing, color controls, angle controls, transform gizmos, drag pads, canvas handles, timelines, terrain controls, camera controls, and similar continuous inputs must update visible state from `input`, `pointermove`, or the equivalent continuous event.
- `change`, `pointerup`, drag-end, and blur may commit undo history, persistence, synchronization, or an expensive final-quality result. They must never be the first event that updates the visible result.
- Do not debounce visible feedback until interaction ends. When frame limiting is necessary, coalesce updates with `requestAnimationFrame` or a bounded realtime cadence and always render the newest value.
- Do not reload the entire scene, widget, model, or preview for a local interactive edit when the affected runtime object can be updated directly.
- If the full operation is too expensive for every frame, show an immediate lightweight preview or lower-detail approximation during interaction, then replace it with the final-quality result after interaction ends.
- Keep the last valid frame visible while a newer preview is being prepared. Do not flash black, empty, stale, or loading-only output during continuous manipulation.
- Cancel or ignore stale asynchronous results. The newest control value always wins.
- Exact numeric fields and their paired sliders must remain synchronized during interaction.
- Undo history should normally create one command per completed gesture, even though the viewport and UI update continuously throughout that gesture.

Any implementation that only reveals a slider or drag result on release is a bug and must not be shipped.

## E2E tests (Playwright)

`tests/e2e/` contains the browser E2E suite for the UniCanvas UI. The only input is the
`COMFYUI_URL` environment variable, pointing at a running test-platform instance (see the
next section):

    cd tests/e2e
    npm install
    npx playwright install chromium          # first run on a machine only
    COMFYUI_URL=http://localhost:8188 npx playwright test

Specs and what each one guards:

- `smoke.spec.mjs` - harness sanity: the standalone Unicanvas tab opens, a pose layer can be
  added, edited and saved, and the saved layer really rendered (non-zero alpha bounding box).
- `measure.spec.mjs` - fixture-level check of `helpers/measure.mjs`
  (`measureAlphaBBoxInPage`) against a synthetic PNG with a known bounding box and centroid,
  because every geometric assertion depends on that measurement.
- `mannequin-options.spec.mjs` - body morph options live in a left-sidebar section during
  Edit pose (no modal, every control reachable, section gone on Save and on Cancel) and the
  realtime rule holds: the mannequin repaints from an `input` event while the gesture is still
  open, before any `pointerup`.
- `settings-panel.spec.mjs` - the settings popover opens under the gear, is at least 400px
  wide, never overlaps the left sidebar (including on 900/700/660px hosts) and closes on an
  outside click, on Close, or on a second gear click.
- `pose-roundtrip.spec.mjs` - edit -> save idempotence: repeated cycles with unchanged input
  keep the saved pose layer pixels and `layer.poseData` identical (spec 5.1 storage clause),
  and a moved pose layer keeps its canvas placement across an edit -> save cycle (spec 5.1b).
- `pose-framing.spec.mjs` - Edit pose frames the mannequin on the torso center (horizontal
  midline within 2%, torso third within 3% of frame center), so the saved capture matches the
  edit view (spec 6.1/6.2).
- `pose-studio-bridge.spec.mjs` - Pose Studio bridge pushes never scale the mannequin (spec
  5.1b on the bridge path): with a live `VNCCS_PoseStudio` node loaded from
  `fixtures/unicanvas-pose-studio-wf.json`, three `capture now` pushes keep the layer bbox
  width, height and area within 5% of the baseline, and a push after moving the layer keeps
  the moved placement instead of jumping back to the canvas center.

The suite never calls GPU generation and never downloads models; CPU is enough because the
mannequin pipeline is client-side WebGL. Geometric assertions read the saved pose layer pixels
through the read-only `window.__VNCCS_UC_E2E__` hook (`listLayers`, `getLayerPixels`,
`getLayerPoseData`) exposed by `web/vnccs_unicanvas_modes.mjs`, plus `helpers/measure.mjs`.

Evidence for UI changes (Before/After, labels exactly `Before`/`After`, plus measured
geometry) is produced by `node evidence.mjs --topic <topic> --phase before|after|compose`
(workdir `tests/e2e`) and written to `tests/e2e/evidence/<topic>/` as `<phase>.png`,
`<phase>.geometry.json` and, on `compose`, a labelled `<topic>.pair.png` plus a standalone
`<topic>.after.png`. Keep the local copy and host it on an `evidence/<topic>` branch when
opening a PR. Interaction-heavy topics may need their own scenario step in `evidence.mjs`
(the per-task artifacts record which scenario a topic's pair came from); the
`mannequin-options` default crop, for example, does not open the pose editor, so that topic's
pair comes from the explicitly captured feature pair.

## Test platform (Docker)

`tests/e2e/platform/` builds a ComfyUI with the VNCSS and VNCCS_Utils custom nodes
preinstalled. Two lanes:

- **Lane A (primary, CPU-only, local):**
  `docker compose -p vnccs-<something> -f tests/e2e/platform/docker-compose.yml up -d`
  serves the UI at `http://localhost:8188`; the working tree is bind-mounted over
  `custom_nodes/ComfyUI_VNCCS_Utils`, so WIP code needs no image rebuild. `PORT=<port>` moves
  that instance to another port. CPU is enough for all UI/E2E work - the mannequin pipeline is
  client-side WebGL. No GPU inference (GENERATE, remove-bg backends, Generate character) is
  exercised on this lane.
- **Lane B (optional, Runpod GPU pod):** only for GPU-dependent verification. Build the CUDA
  variant (`--build-arg BASE_IMAGE=runpod/comfyui:cuda12.8 --build-arg TORCH_INDEX=preinstalled`),
  refresh WIP code with `sync-wip.ps1 -Target <ssh-host>`. Cost guardrails (from
  `~/.dsh/AGENTS.md`): cheapest GPU with >=24 GB VRAM and CUDA 12.8 (RTX 4090 preferred),
  150 GB disk, no network volume, kill task scheduled at launch, hard $1 per-session cap,
  stop AND terminate the pod afterwards and confirm no stray pods remain.

Always give the compose project an explicit unique name (`-p vnccs-<something>`): every
worktree derives the same default project name from the compose file's directory, so two
worktrees would otherwise share one project, one container and one port.

Nothing is hardcoded to this fork (it merges into the mainline later): `VNCSS_UTILS_REPO`,
`VNCSS_UTILS_REF`, `VNCSS_REPO`, `VNCSS_REF` and the image name are all build args /
parameters.

### LAN reachability (owner policy, binding)

Every local ComfyUI instance an agent starts must stay reachable from another device at
`http://r1s3n.local:<PORT>/` for as long as it runs:

- publish the port on every interface (`"<PORT>:8188"` -> `0.0.0.0:<PORT>`, never a loopback
  bind),
- run ComfyUI with `--listen 0.0.0.0` (the platform image's CMD already does),
- use a port inside the pre-opened firewall band 8188-8199,
- verify from a second device - a host-side check alone is not enough.

Name every live URL in the reply while instances run, and say explicitly when an address is
gone.

### Browser cache

After a code change or a container restart the browser keeps the OLD extension bundle: always
hard-reload (Ctrl+Shift+R) before judging a fix on the live instance.

