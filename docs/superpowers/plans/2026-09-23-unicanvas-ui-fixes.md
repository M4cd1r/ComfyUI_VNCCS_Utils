# UniCanvas UI Fixes & E2E Test Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpower-subagent-driven-development (recommended) or superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the four live-verification fixes (mannequin options in the left sidebar, settings panel under the gear, pose round-trip idempotence, torso-anchored framing) with a Playwright E2E harness and a Docker test platform that make verification fast and cheap.

**Architecture:** All UI fixes land in the two existing widget modules (`web/vnccs_unicanvas_pose_layers.mjs`, `web/vnccs_unicanvas.js`); the pose-storage fix hardens the relativize/absolutize round trip against skeleton reshaping in `web/vnccs_pose_studio_core.js`. The E2E harness lives in `tests/e2e/` with its own `package.json` and drives a real ComfyUI (`COMFYUI_URL`) whose custom nodes are bind-mounted from the working tree (Lane A: local CPU Docker).

**Tech Stack:** Vanilla JS (repo style, no bundler), `node:test` + pytest (existing suites), Playwright (`@playwright/test`, JS specs), Docker/Compose (CPU image `python:3.12-slim`, CUDA variant `runpod/comfyui:cuda12.8`).

**Spec:** `docs/superpowers/specs/2026-09-23-unicanvas-ui-fixes-design.md` (sections cited as spec §N).

## Global Constraints

- Realtime rule (repo `AGENTS.md`): every control shows its effect from `input`/`pointermove`; `change`/`pointerup`/blur may only commit persistence/undo/expensive work; no debounce of visible feedback until release; rAF-coalesced updates always render the newest value; no full reload for a local edit when the runtime object can be updated; keep the last valid frame visible; newest async result wins; slider+number pairs stay synchronized during the gesture; one undo command per completed gesture.
- English everywhere that ships: code comments, test names, commit messages, screenshot labels (`Before` / `After`), docs.
- No fork hardcodes (spec §8.1): `VNCSS_UTILS_REPO`/`VNCSS_UTILS_REF`, `VNCSS_REPO`/`VNCSS_REF`, image name are parameters; this fork merges into the mainline later.
- E2E never calls GPU generation and never downloads models (spec §7.3).
- Environment: Windows host, pwsh; local checkout is CRLF (`core.autocrlf=true`) - regexes in tests must be `\r?\n` tolerant; Python interpreter `C:\Users\admin\dsh-local\vnccs-work\.venv\Scripts\python.exe`; Node v22; Docker available locally (no registry push needed for Lane A).
- Baseline test noise (pre-existing, CI-green, DO NOT chase): pytest = 2 failures (`factory3d` tempfile lock, `security-scan` CRLF hash pin); `node --test` = 9 failures in `factory3d`/`camera`/`importFile` CRLF-class files. Compare counts, never "fix" them here.
- Test commands: `node --test tests/<file>.mjs` (per-file, from repo root); `C:\Users\admin\dsh-local\vnccs-work\.venv\Scripts\python.exe -m pytest tests -q`; E2E `npx playwright test` from `tests/e2e/` with `COMFYUI_URL` set.
- Screenshot evidence (owner rule): every UI change ships Before/After (same crop, same scale, labelled `Before`/`After`) + standalone `After` + measured geometry, captured on the live instance, kept under `tests/e2e/evidence/<topic>/`.

## File Structure

| File | Responsibility |
|---|---|
| `tests/e2e/platform/Dockerfile` | Parameterized ComfyUI + custom nodes image (CPU default, CUDA variant) |
| `tests/e2e/platform/docker-compose.yml` | Lane A: local CPU run with working-tree bind mount + healthcheck |
| `tests/e2e/platform/sync-wip.ps1` | Lane B: push `web/`+`nodes/` to a pod and restart ComfyUI |
| `tests/e2e/package.json` | Isolated Playwright dependency + scripts (`test`, `evidence`) |
| `tests/e2e/playwright.config.mjs` | `COMFYUI_URL`-based config, 1 worker, chromium |
| `tests/e2e/helpers/app.mjs` | Page-driving helpers (open Unicanvas, pose layer, edit/save cycle) |
| `tests/e2e/helpers/measure.mjs` | Alpha-bbox/centroid measurement of saved layer pixels |
| `tests/e2e/evidence.mjs` | Before/After capture + labelled side-by-side compose + geometry dump |
| `tests/e2e/*.spec.mjs` | Smoke + one spec per fix (spec §7.4) |
| `web/vnccs_unicanvas_pose_layers.mjs` | Mannequin options section, pose storage round trip, torso framing |
| `web/vnccs_unicanvas.js` | Settings popover anchor/size, E2E test hook on the standalone widget |
| `web/vnccs_pose_studio_core.js` | Only if the probe implicates core (rest-cache after reshape) |
| `tests/test_unicanvas_pose_layers.mjs` | Contract + round-trip + anchor unit tests (existing stub-DOM harness) |
| `tests/test_unicanvas_frontend.mjs` | Settings popover contract test |
| `AGENTS.md`, `CHANGELOG.md` | E2E/platform documentation, behavior notes |

---

### Task 1: Lane A test platform (Docker CPU image + compose + pod sync tool)

**Files:**
- Create: `tests/e2e/platform/Dockerfile`
- Create: `tests/e2e/platform/docker-compose.yml`
- Create: `tests/e2e/platform/sync-wip.ps1`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: ComfyUI serving the working tree at `http://localhost:8188` (Lane A). `docker compose -f tests/e2e/platform/docker-compose.yml up -d` is the single entry point used by every later task. `sync-wip.ps1 -Target <ssh-host> [-Port <port>] [-Source <repo-root>]` is the Lane B refresh entry point.

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1
# ComfyUI test platform for VNCCS + VNCCS_Utils UI verification.
# Lane A (CPU):   docker build -t vnccs-comfyui-test .
# Lane B (CUDA):  docker build --build-arg BASE_IMAGE=runpod/comfyui:cuda12.8 \
#                     --build-arg TORCH_INDEX=preinstalled -t <registry>/comfyui-vnccs-test .
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

ARG COMFYUI_REPO=https://github.com/comfyanonymous/ComfyUI
ARG COMFYUI_REF=master
ARG VNCSS_REPO=https://github.com/AHEKOT/ComfyUI_VNCCS
ARG VNCSS_REF=main
ARG VNCSS_UTILS_REPO=https://github.com/M4cd1r/ComfyUI_VNCCS_Utils
ARG VNCSS_UTILS_REF=unicanvas-next
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch ${COMFYUI_REF} ${COMFYUI_REPO} /opt/ComfyUI

# torch is preinstalled on the CUDA base image; skip the wheel download there.
RUN if [ "${TORCH_INDEX}" != "preinstalled" ]; then \
      pip install --no-cache-dir torch torchvision --index-url ${TORCH_INDEX}; \
    fi \
 && pip install --no-cache-dir -r /opt/ComfyUI/requirements.txt

RUN git clone --depth 1 --branch ${VNCSS_REF} ${VNCSS_REPO} /opt/ComfyUI/custom_nodes/ComfyUI_VNCCS \
 && git clone --depth 1 --branch ${VNCSS_UTILS_REF} ${VNCSS_UTILS_REPO} /opt/ComfyUI/custom_nodes/ComfyUI_VNCCS_Utils \
 && find /opt/ComfyUI/custom_nodes -maxdepth 2 -name 'requirements.txt' -print \
      | xargs -r -n1 pip install --no-cache-dir -r

# Build-time sanity boot: fails the build if a custom node cannot import (e.g. CUDA-only import).
RUN python /opt/ComfyUI/main.py --cpu --quick-test-for-ci

EXPOSE 8188
WORKDIR /opt/ComfyUI
CMD ["python", "main.py", "--listen", "0.0.0.0", "--port", "8188", "--cpu"]
```

- [ ] **Step 2: Write docker-compose.yml**

```yaml
services:
  comfyui:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        VNCSS_UTILS_REPO: ${VNCSS_UTILS_REPO:-https://github.com/M4cd1r/ComfyUI_VNCCS_Utils}
        VNCSS_UTILS_REF: ${VNCSS_UTILS_REF:-unicanvas-next}
    ports:
      - "8188:8188"
    ipc: host
    volumes:
      # Code under test comes from the working tree - no image rebuild for WIP code.
      - ../../..:/opt/ComfyUI/custom_nodes/ComfyUI_VNCCS_Utils
      - comfyui-models:/opt/ComfyUI/models
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8188/system_stats"]
      interval: 5s
      timeout: 3s
      retries: 30
volumes:
  comfyui-models:
```

- [ ] **Step 3: Write sync-wip.ps1 (Lane B refresh)**

```powershell
param(
  [Parameter(Mandatory = $true)][string]$Target,          # e.g. root@69.30.85.249
  [int]$Port = 22,
  [string]$Source = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$RemoteDir = '/opt/ComfyUI/custom_nodes/ComfyUI_VNCCS_Utils'
)
$ErrorActionPreference = 'Stop'
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ('vnccs-wip-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
foreach ($dir in 'web', 'nodes') {
  Copy-Item (Join-Path $Source $dir) (Join-Path $staging $dir) -Recurse
}
$archive = Join-Path $staging 'wip.tar.gz'
tar -czf $archive -C $staging web nodes
ssh -p $Port $Target "mkdir -p $RemoteDir"
scp -P $Port $archive "${Target}:${RemoteDir}/wip.tar.gz"
ssh -p $Port $Target "tar -xzf $RemoteDir/wip.tar.gz -C $RemoteDir && rm $RemoteDir/wip.tar.gz && (pkill -f 'python.*main.py' || true)"
Write-Output "WIP synced to ${Target}:${RemoteDir}. ComfyUI restarts via the platform's auto-restart; poll COMFYUI_URL/system_stats before testing."
```

- [ ] **Step 4: Build the CPU image and boot it**

Run (workdir `tests/e2e/platform`): `docker compose build`
Expected: build succeeds, including the `--quick-test-for-ci` sanity boot (a CUDA-only import failure would fail here).

- [ ] **Step 5: Verify the platform serves both custom nodes**

Run (workdir `tests/e2e/platform`): `docker compose up -d`, then:

```powershell
$r = Invoke-RestMethod http://localhost:8188/object_info
[bool]($r.VNCCS_UniCanvas) -and [bool]($r.VNCCS_Config)
```

Expected: `True` (both custom nodes registered). Also `Invoke-RestMethod http://localhost:8188/system_stats` returns JSON.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/platform
git commit -m "test(e2e): add CPU-first Docker test platform for ComfyUI UI verification"
```

---

### Task 2: Playwright harness, test hook, measurement + evidence helpers, smoke spec

**Files:**
- Create: `tests/e2e/package.json`, `tests/e2e/playwright.config.mjs`
- Create: `tests/e2e/helpers/app.mjs`, `tests/e2e/helpers/measure.mjs`, `tests/e2e/evidence.mjs`
- Create: `tests/e2e/smoke.spec.mjs`
- Modify: `web/vnccs_unicanvas_modes.mjs:671-691` (registerSidebarTab `render` - expose the test hook)
- Test: `tests/e2e/smoke.spec.mjs`

**Interfaces:**
- Consumes: Task 1 platform at `COMFYUI_URL`.
- Produces (used by Tasks 3-7):
  - `window.__VNCCS_UC_E2E__ = { listLayers(), getLayerPixels(layerId) }` - `getLayerPixels` returns `{ width, height, dataURL }` from the layer's own 2D canvas (full render resolution).
  - `helpers/app.mjs`: `openUnicanvas(page)`, `addPoseLayer(page)`, `enterPoseEdit(page)`, `savePose(page)`, `cancelPose(page)`, `runEditSaveCycle(page)`.
  - `helpers/measure.mjs`: `measureAlphaBBox(dataURL)` -> `{ minX, minY, maxX, maxY, width, height, centroidX, centroidY, area }` (pure JS, decode via `OffscreenCanvas`) and `measureAlphaBBoxInPage(page, dataURL)` = `page.evaluate(measureAlphaBBox, dataURL)` - the call form used by all specs.
  - `evidence.mjs`: `node evidence.mjs --topic <t> --phase before|after|compose` writing `tests/e2e/evidence/<t>/<phase>.png`, `<phase>.geometry.json`, and on `compose` a labelled `<t>.pair.png` + standalone `<t>.after.png`.

- [ ] **Step 1: Scaffold the harness**

`tests/e2e/package.json`:

```json
{
  "name": "vnccs-unicanvas-e2e",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "playwright test",
    "evidence": "node evidence.mjs"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0"
  }
}
```

`tests/e2e/playwright.config.mjs`:

```js
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.COMFYUI_URL || "http://localhost:8188";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs/,
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 120_000,
  use: {
    baseURL,
    viewport: { width: 1600, height: 1000 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

- [ ] **Step 2: Add the E2E test hook to the standalone widget**

In `web/vnccs_unicanvas_modes.mjs`, inside `render(container)` right after `if (!widget) widget = createStandaloneWidget(UniCanvasWidgetClass);` (line 679), add:

```js
      // Read-only E2E hook (tests/e2e): exposes full-resolution pose layer
      // pixels for geometric assertions. No behavior change.
      globalThis.__VNCCS_UC_E2E__ = {
        listLayers: () => (widget.layers || []).map((l) => ({ id: l.id, type: l.type })),
        getLayerPixels: (layerId) => {
          const layer = (widget.layers || []).find((l) => l.id === layerId);
          if (!layer?.canvas) return null;
          return {
            width: layer.canvas.width,
            height: layer.canvas.height,
            dataURL: layer.canvas.toDataURL("image/png"),
          };
        },
      };
```

- [ ] **Step 3: Write the failing smoke test**

`tests/e2e/smoke.spec.mjs`:

```js
import { test, expect } from "@playwright/test";
import { openUnicanvas, addPoseLayer, enterPoseEdit, savePose, LAYER_TYPES } from "./helpers/app.mjs";
import { measureAlphaBBoxInPage } from "./helpers/measure.mjs";

test("standalone Unicanvas: pose layer add -> edit -> save happy path", async ({ page }) => {
  await openUnicanvas(page);
  await addPoseLayer(page);
  await enterPoseEdit(page);
  await savePose(page);
  const layers = await page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers());
  const pose = layers.find((l) => l.type === LAYER_TYPES.pose);
  expect(pose).toBeTruthy();
  const pixels = await page.evaluate((id) => globalThis.__VNCCS_UC_E2E__.getLayerPixels(id), pose.id);
  const bbox = await measureAlphaBBoxInPage(page, pixels.dataURL);
  expect(bbox.area).toBeGreaterThan(0); // the mannequin really rendered
});
```

- [ ] **Step 4: Implement helpers/app.mjs**

```js
import { expect } from "@playwright/test";

export const LAYER_TYPES = { pose: "pose" };

export async function openUnicanvas(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const tab = page.locator('[data-label="Unicanvas"], button[title="Unicanvas"]').first();
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await tab.click();
  await expect(page.locator(".vnccs-uc-left")).toBeVisible({ timeout: 30_000 });
}

export async function addPoseLayer(page) {
  await page.locator('[title="Add pose layer"]').first().click();
  await expect(page.locator(".vnccs-uc-pose-edit-bar")).toBeVisible({ timeout: 30_000 });
}

export async function enterPoseEdit(page) {
  // Re-entering edit on the selected pose layer (Edit pose layer-menu entry).
  await page.locator('[title="More"]').first().click().catch(() => {});
  await page.locator('button:has-text("Edit pose")').first().click();
  await expect(page.locator(".vnccs-uc-pose-edit-bar")).toBeVisible({ timeout: 30_000 });
}

export async function savePose(page) {
  await page.locator('.vnccs-uc-pose-edit-bar button:has-text("Save pose")').click();
  await expect(page.locator(".vnccs-uc-pose-edit-bar")).toBeHidden({ timeout: 30_000 });
}

export async function cancelPose(page) {
  await page.locator('.vnccs-uc-pose-edit-bar button:has-text("Cancel")').click();
  await expect(page.locator(".vnccs-uc-pose-edit-bar")).toBeHidden({ timeout: 30_000 });
}

export async function runEditSaveCycle(page) {
  await enterPoseEdit(page);
  await savePose(page);
}
```

Note for the implementer: `addPoseLayer` already opens the mannequin editor (see `web/vnccs_unicanvas_pose_layers.mjs:502-503`), so `enterPoseEdit` doubles as a re-entry helper; if the layer menu markup differs, use the layer row's `Edit pose` entry (`web/vnccs_unicanvas_layer_tools.mjs:34`) and keep the function signature unchanged.

- [ ] **Step 5: Implement helpers/measure.mjs**

```js
export async function measureAlphaBBox(dataURL) {
  const bitmap = await createImageBitmap(await (await fetch(dataURL)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  let minX = width, minY = height, maxX = -1, maxY = -1, area = 0, sumX = 0, sumY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] < 8) continue;
      area += 1; sumX += x; sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (area === 0) return { minX, minY, maxX, maxY, width: 0, height: 0, centroidX: null, centroidY: null, area: 0 };
  return {
    minX, minY, maxX, maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    centroidX: sumX / area,
    centroidY: sumY / area,
    area,
  };
}

// measureAlphaBBox needs OffscreenCanvas, so specs run it inside the page.
export const measureAlphaBBoxInPage = (page, dataURL) => page.evaluate(measureAlphaBBox, dataURL);
```

(This runs inside `page.evaluate` call sites in later specs; it is a pure function and can be serialized there.)

- [ ] **Step 6: Implement evidence.mjs**

```js
#!/usr/bin/env node
// Evidence capture for UI changes (owner rule): Before/After pairs (same crop,
// same scale, labels exactly "Before"/"After"), standalone After, measured geometry.
import { chromium } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.reduce((acc, cur, i) => {
  if (cur.startsWith("--")) acc.push([cur.slice(2), args[i + 1] ?? ""]);
  return acc;
}, []));
const topic = opt.topic || "topic";
const phase = opt.phase || "after"; // before | after | compose
const baseURL = process.env.COMFYUI_URL || "http://localhost:8188";
const outDir = resolve(import.meta.dirname, "evidence", topic);
await mkdir(outDir, { recursive: true });

if (phase === "compose") {
  const before = await readFile(resolve(outDir, "before.png"));
  const after = await readFile(resolve(outDir, "after.png"));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1700, height: 900 } });
  await page.setContent(`<body style="margin:0;background:#111;display:flex;gap:8px;padding:8px;font:700 22px sans-serif;color:#fff">
    <figure style="margin:0"><figcaption>Before</figcaption><img src="data:image/png;base64,${before.toString("base64")}"></figure>
    <figure style="margin:0"><figcaption>After</figcaption><img src="data:image/png;base64,${after.toString("base64")}"></figure>
  </body>`);
  await page.locator("body").screenshot({ path: resolve(outDir, `${topic}.pair.png`) });
  await page.locator("figure").nth(1).screenshot({ path: resolve(outDir, `${topic}.after.png`) });
  await browser.close();
  console.log(`composed ${topic}.pair.png`);
  process.exit(0);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(baseURL, { waitUntil: "domcontentloaded" });
await page.locator('[data-label="Unicanvas"], button[title="Unicanvas"]').first().click();
await page.waitForSelector(".vnccs-uc-left", { timeout: 30_000 });
// Scenario per topic keeps crops identical between before/after (same locator).
const shots = {
  "mannequin-options": ".vnccs-uc-left",
  "settings-panel": ".vnccs-uc-staging-popover, .vnccs-uc-left",
  "pose-roundtrip": ".vnccs-uc-pose-edit-overlay",
  "pose-framing": ".vnccs-uc-pose-edit-overlay",
};
const target = page.locator(shots[topic] || ".vnccs-uc-left").first();
await target.screenshot({ path: resolve(outDir, `${phase}.png`) });
const geometry = await target.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return { x: r.x, y: r.y, width: r.width, height: r.height, fontSize: s.fontSize, zIndex: s.zIndex, background: s.background };
});
await writeFile(resolve(outDir, `${phase}.geometry.json`), JSON.stringify(geometry, null, 2));
await browser.close();
console.log(`captured ${phase}.png for ${topic}`);
```

- [ ] **Step 7: Run the smoke spec (red -> green sanity of the harness)**

Run (workdir `tests/e2e`): `npm install`, `npx playwright install chromium`, then `COMFYUI_URL=http://localhost:8188 npx playwright test smoke.spec.mjs`.
Expected: PASS (this validates the hook, helpers and selectors against the live DOM; if a selector misses, fix the helper - never the assertion semantics).

- [ ] **Step 8: Commit**

```bash
git add tests/e2e web/vnccs_unicanvas_modes.mjs
git commit -m "test(e2e): add Playwright harness, layer-pixel hook, measurement and evidence helpers"
```

---

### Task 3: Mannequin options -> left sidebar section (spec §3)

**Files:**
- Modify: `web/vnccs_unicanvas_pose_layers.mjs:747-787` (edit bar: drop the `Options` button), `:893-1019` (replace `openUniCanvasPoseOptions` modal with a sidebar section), `:1201-1215` (`closeUniCanvasPoseEditSession` unmount)
- Test: `tests/test_unicanvas_pose_layers.mjs` (contract test, reuse the file's existing document/widget stubs)
- Test: `tests/e2e/mannequin-options.spec.mjs`

**Interfaces:**
- Consumes: `widget.left` (`vnccs-uc-left` element, `web/vnccs_unicanvas.js:912`), `createSliderNumber`, `normalizePoseLayerMorphs`, `session.applyExternalCharacterCreatorValues` (existing).
- Produces: `buildUniCanvasPoseOptionsSection(state, session) -> HTMLElement` (class `vnccs-uc-pose-options-section`), `mountUniCanvasPoseOptions(widget, session)`, `unmountUniCanvasPoseOptions(widget)`. Session field `session.optionsSection: HTMLElement|null`.

- [ ] **Step 0: Capture Before evidence (the current build must still show the modal)**

Run (workdir `tests/e2e`): `COMFYUI_URL=http://localhost:8188 node evidence.mjs --topic mannequin-options --phase before`
Expected: `evidence/mannequin-options/before.png` + `before.geometry.json` exist.

- [ ] **Step 1: Write the failing contract test** (append to `tests/test_unicanvas_pose_layers.mjs`)

```js
test("mannequin options render as a sidebar section, never as a modal overlay", () => {
  const { widget, state, session } = makePoseEditFixture(); // reuse the file's existing stubs
  const section = buildUniCanvasPoseOptionsSection(state, session);
  assert.equal(section.className, "vnccs-uc-pose-options-section");
  mountUniCanvasPoseOptions(widget, session);
  assert.ok(widget.left.contains(session.optionsSection), "options mount into the left column");
  assert.equal(widget.container.querySelectorAll(".vnccs-uc-modal-overlay").length, 0, "no dimming overlay");
  unmountUniCanvasPoseOptions(widget);
  assert.equal(session.optionsSection, null);
});
```

(If the file has no `makePoseEditFixture`, build the three stubs the same way the existing tests construct `widget`/`state`/`session`, and export the three new functions from `web/vnccs_unicanvas_pose_layers.mjs`.)

- [ ] **Step 2: Run the contract test to verify it fails**

Run: `node --test tests/test_unicanvas_pose_layers.mjs`
Expected: FAIL (`buildUniCanvasPoseOptionsSection is not defined`).

- [ ] **Step 3: Write the failing E2E spec**

`tests/e2e/mannequin-options.spec.mjs`:

```js
import { test, expect } from "@playwright/test";
import { openUnicanvas, addPoseLayer, savePose } from "./helpers/app.mjs";

test("mannequin options live in the left sidebar during Edit pose only", async ({ page }) => {
  await openUnicanvas(page);
  await addPoseLayer(page); // opens the pose editor
  const section = page.locator(".vnccs-uc-pose-options-section");
  await expect(section).toBeVisible();
  await expect(page.locator(".vnccs-uc-left")).toContainText("Mannequin options");
  await expect(page.locator(".vnccs-uc-modal-overlay")).toHaveCount(0);

  // Realtime rule: moving a slider must change the mannequin before pointerup.
  const slider = section.locator('input[type="range"]').first();
  await slider.dispatchEvent("pointerdown", { buttons: 1 });
  await slider.dispatchEvent("pointermove", { buttons: 1 });
  await slider.evaluate((el) => {
    el.value = String(Math.min(Number(el.max), Number(el.value) + 0.2));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect
    .poll(async () => page.evaluate(() => document.querySelector(".vnccs-uc-pose-edit-canvas") !== null))
    .toBe(true);

  await savePose(page);
  await expect(section).toHaveCount(0); // gone with the edit session
});
```

- [ ] **Step 4: Run the E2E spec to verify it fails**

Run: `COMFYUI_URL=http://localhost:8188 npx playwright test mannequin-options.spec.mjs`
Expected: FAIL (options render as a modal today).

- [ ] **Step 5: Implement the sidebar section**

In `web/vnccs_unicanvas_pose_layers.mjs` replace `openUniCanvasPoseOptions` with (keep the existing control bodies - gender toggle, sections, sliders, genitals checkbox - but build a plain section instead of `vnccs-uc-modal-overlay`/`vnccs-uc-modal`):

```js
export function buildUniCanvasPoseOptionsSection(state, session) {
  ensureUniCanvasPoseLayerStyles(state);
  const section = document.createElement("section");
  section.className = "vnccs-uc-pose-options-section";
  const title = document.createElement("div");
  title.className = "vnccs-uc-pose-panel-title";
  title.textContent = "Mannequin options";
  const hint = document.createElement("div");
  hint.className = "vnccs-uc-pose-status-note";
  hint.textContent = "Morphs update live; double-click a slider to reset it.";
  section.append(title, hint);
  // ...existing bodies of openUniCanvasPoseOptions (scheduleMorphApply,
  // setMorphValue, gender toggle, addSection/addSlider, genitals checkbox,
  // updateGenderUI/updateGenderVisibility) append into `section` instead of
  // `modal`, and there is NO Close button and NO overlay.
  return section;
}

export function mountUniCanvasPoseOptions(widget, session) {
  unmountUniCanvasPoseOptions(widget);
  const section = buildUniCanvasPoseOptionsSection(getUniCanvasPoseLayerState(widget), session);
  widget.left.appendChild(section);
  session.optionsSection = section;
  installCustomSelects?.(section);
  return section;
}

export function unmountUniCanvasPoseOptions(widget) {
  const session = widget?._poseLayerState?.session;
  session?.optionsSection?.remove();
  if (session) session.optionsSection = null;
}
```

Wire-up (same file):
- `editUniCanvasPoseLayer` (after `buildUniCanvasPoseEditOverlay`, ~line 1333): `mountUniCanvasPoseOptions(widget, session);`
- `closeUniCanvasPoseEditSession` (~line 1201): `unmountUniCanvasPoseOptions(widget);` before `session.overlay?.remove()`.
- `buildUniCanvasPoseEditOverlay` (line 777-783): drop the `optsBtn` and its `_button(...)`; `bar.append(title, libBtn, saveBtn, cancelBtn)`.
- Add CSS to `POSE_LAYER_STYLES` (line 62-76):

```
.vnccs-uc-pose-options-section { display:flex; flex-direction:column; gap:6px; padding:6px; border:1px solid var(--uc-border); border-radius:8px; }
```

- [ ] **Step 6: Run both tests to verify they pass**

Run: `node --test tests/test_unicanvas_pose_layers.mjs` (PASS; whole-file count must not grow failures) and `COMFYUI_URL=http://localhost:8188 npx playwright test mannequin-options.spec.mjs` (PASS).

- [ ] **Step 7: Capture After evidence**

Run: `node evidence.mjs --topic mannequin-options --phase after` (scenario crops `.vnccs-uc-left` - same as before). Compose in Task 7.

- [ ] **Step 8: Commit**

```bash
git add web/vnccs_unicanvas_pose_layers.mjs tests/test_unicanvas_pose_layers.mjs tests/e2e/mannequin-options.spec.mjs
git commit -m "feat(unicanvas): move mannequin options into the left sidebar during pose editing"
```

---

### Task 4: UniCanvas settings -> one larger panel under the gear (spec §4)

**Files:**
- Modify: `web/vnccs_unicanvas.js:6871-7013` (`openUniCanvasSettings`), `:62-243` (STYLES)
- Test: `tests/test_unicanvas_frontend.mjs` (contract test)
- Test: `tests/e2e/settings-panel.spec.mjs`

**Interfaces:**
- Consumes: `this.gearBtn` (`web/vnccs_unicanvas.js:1086`), `installCustomSelects` (existing).
- Produces: settings popover root class `vnccs-uc-settings-popover`, anchored under the gear via `anchorPopoverTo(panel, anchorEl, host)` (new small helper next to `openUniCanvasSettings`).

- [ ] **Step 0: Capture Before evidence**

Run (workdir `tests/e2e`): `COMFYUI_URL=http://localhost:8188 node evidence.mjs --topic settings-panel --phase before`

- [ ] **Step 1: Write the failing contract test** (append to `tests/test_unicanvas_frontend.mjs`)

```js
test("settings popover carries the anchored class and size contract", () => {
  const styles = readSource("web/vnccs_unicanvas.js"); // reuse the file's source-reading helper
  assert.match(styles, /\.vnccs-uc-settings-popover\s*\{[^}]*min-width:\s*400px/);
  assert.match(styles, /\.vnccs-uc-settings-popover\s*\{[^}]*font-size:\s*13px/);
  assert.match(styles, /\.vnccs-uc-settings-popover\s*\{[^}]*max-height:\s*70vh/);
  const source = readSource("web/vnccs_unicanvas.js");
  assert.match(source, /anchorPopoverTo\(panel,\s*this\.gearBtn,\s*this\.container\)/);
});
```

(Reuse the file's existing source-reading helper; if it is named differently, use that name and keep the assertions.)

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/test_unicanvas_frontend.mjs`
Expected: FAIL (no `.vnccs-uc-settings-popover` rules / no `anchorPopoverTo`).

- [ ] **Step 3: Write the failing E2E spec**

`tests/e2e/settings-panel.spec.mjs`:

```js
import { test, expect } from "@playwright/test";
import { openUnicanvas } from "./helpers/app.mjs";

test("settings open as one larger panel anchored under the gear", async ({ page }) => {
  await openUnicanvas(page);
  const gear = page.locator('[title="Settings"]').first();
  const left = page.locator(".vnccs-uc-left");
  await gear.click();
  const panel = page.locator(".vnccs-uc-settings-popover");
  await expect(panel).toHaveCount(1);

  const [gearBox, panelBox, leftBox] = [
    await gear.boundingBox(), await panel.boundingBox(), await left.boundingBox(),
  ];
  expect(panelBox.width).toBeGreaterThanOrEqual(400);
  expect(panelBox.y).toBeGreaterThanOrEqual(gearBox.y + gearBox.height - 1); // below the gear
  const overlapsLeft = panelBox.x < leftBox.x + leftBox.width && panelBox.x + panelBox.width > leftBox.x;
  expect(overlapsLeft).toBe(false); // never over the left sidebar

  await page.mouse.click(2, 2); // outside click closes
  await expect(panel).toHaveCount(0);
  await gear.click();
  await expect(panel).toHaveCount(1);
  await gear.click(); // second gear click closes
  await expect(panel).toHaveCount(0);
});
```

- [ ] **Step 4: Run the E2E spec to verify it fails**

Run: `COMFYUI_URL=http://localhost:8188 npx playwright test settings-panel.spec.mjs`
Expected: FAIL (no `.vnccs-uc-settings-popover`; panel lands at `left:24px; top:48px`).

- [ ] **Step 5: Implement the anchored popover**

In `web/vnccs_unicanvas.js`:

```js
  // Anchor a popover below `anchorEl`, clamped inside `host` (spec 4.1-4.2).
  anchorPopoverTo(panel, anchorEl, host) {
    const hostRect = host.getBoundingClientRect();
    const rect = anchorEl.getBoundingClientRect();
    const width = panel.offsetWidth || 400;
    const left = Math.min(
      Math.max(4, rect.right - hostRect.left - width),
      Math.max(4, hostRect.width - width - 4),
    );
    const top = Math.min(rect.bottom - hostRect.top + 6, Math.max(4, hostRect.height - panel.offsetHeight - 4));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }
```

In `openUniCanvasSettings` (line 6877-6879): replace the inline `panel.style.cssText = ...` with `panel.className = "vnccs-uc-settings-popover";`, and after `this.container.appendChild(panel);` replace `panel.style.left = "24px"; panel.style.top = "48px";` with `this.anchorPopoverTo(panel, this.gearBtn, this.container);`. Add outside-click closing (second gear click already toggles via the existing guard):

```js
    this._vnccsSettingsOutside = (event) => {
      if (panel.contains(event.target) || this.gearBtn.contains(event.target)) return;
      panel.remove();
      this._vnccsSettingsPopover = null;
      document.removeEventListener("pointerdown", this._vnccsSettingsOutside, true);
    };
    document.addEventListener("pointerdown", this._vnccsSettingsOutside, true);
```

(Also remove the listener in the existing `Close` button handler and in the toggle branch at the top of `openUniCanvasSettings`.)

Add to `STYLES` (before the closing backtick, line 243):

```
.vnccs-uc-settings-popover {
  position:absolute; z-index:30; min-width:400px; max-width:min(520px, calc(100% - 8px));
  max-height:70vh; overflow-y:auto; padding:12px; border-radius:10px;
  background:rgba(20,16,30,.96); border:1px solid rgba(255,255,255,.18);
  box-shadow:0 12px 32px rgba(0,0,0,.55); color:#e8e8f0; font:13px sans-serif; display:grid; gap:8px;
}
```

- [ ] **Step 6: Run both tests to verify they pass**

Run: `node --test tests/test_unicanvas_frontend.mjs` (contract PASS) and `COMFYUI_URL=http://localhost:8188 npx playwright test settings-panel.spec.mjs` (PASS).

- [ ] **Step 7: Capture After evidence**

Run: `node evidence.mjs --topic settings-panel --phase after`

- [ ] **Step 8: Commit**

```bash
git add web/vnccs_unicanvas.js tests/test_unicanvas_frontend.mjs tests/e2e/settings-panel.spec.mjs
git commit -m "fix(unicanvas): anchor the settings panel under the gear as one larger popover"
```

---

### Task 5: Pose round-trip idempotence - Bug A (spec §5)

**Files:**
- Modify: `web/vnccs_unicanvas_pose_layers.mjs:1061-1105` (`applyUniCanvasPoseProportionParams`, `applyUniCanvasPoseEditMorphs`), `:1156-1192` (`relativize`/`absolutize`)
- Modify (only if the probe implicates core): `web/vnccs_pose_studio_core.js` (`_cacheShapedRestBonePositions` call sites; `initialBoneStates` mutation at `:3249-3250`)
- Test: `tests/test_unicanvas_pose_layers.mjs` (numeric round-trip test with a faithful viewer stub)
- Test: `tests/e2e/pose-roundtrip.spec.mjs`

**Interfaces:**
- Consumes: `relativizeUniCanvasPoseBones(viewer, pose)`, `absolutizeUniCanvasPoseBones(viewer, pose)` (export both for tests if not already), `buildPoseLayerData`, `normalizePoseLayerMorphs`.
- Produces: invariant - for N cycles of load -> edit -> save with unchanged input, `layer.poseData` and the rendered alpha bbox are stable (spec §5.1). New private helper `restyleUniCanvasPoseRest(viewer)` = "re-cache the shaped rest after every skeleton reshape".

- [ ] **Step 0: Capture Before evidence and run the drift probe**

Run (workdir `tests/e2e`): `COMFYUI_URL=http://localhost:8188 node evidence.mjs --topic pose-roundtrip --phase before`
Then run the E2E spec from Step 3 with `CYCLES=5` - it logs per-cycle `{width, height, area}` into `tests/e2e/evidence/pose-roundtrip/probe.json` (the spec writes this file). This table is the probe evidence (spec §5.3).

- [ ] **Step 1: Write the failing numeric round-trip test** (append to `tests/test_unicanvas_pose_layers.mjs`)

```js
// Faithful stub of the viewer semantics the round trip relies on:
// getPose() -> absolute local positions; setPose() resets to rest then applies;
// updateBoneLengthScale() rescales a child offset from UN-shaped initial and
// re-caches the shaped rest (vnccs_pose_studio_core.js:3535-3540, 3607-3642).
class FakeViewer {
  constructor(initialOffsets) {
    this.initialBoneStates = Object.fromEntries(
      Object.entries(initialOffsets).map(([name, position]) => [name, { position: vec(position) }]),
    );
    this.shapedBoneRestPositions = {};
    this.scaled = {};
    this.positions = {};
    this.restyle();
  }
  restyle() {
    for (const [name, initial] of Object.entries(this.initialBoneStates)) {
      const scale = this.scaled[name] ?? 1;
      const rest = [initial.position.x * scale, initial.position.y * scale, initial.position.z * scale];
      this.shapedBoneRestPositions[name] = vec(rest);
      this.positions[name] = [...rest];
    }
  }
  getPose() { return { bonePositions: Object.fromEntries(Object.entries(this.positions).map(([n, p]) => [n, [...p]])) }; }
  setPose(pose) {
    this.restyle();
    for (const [name, p] of Object.entries(pose.bonePositions || {})) this.positions[name] = [...p];
  }
  updateBoneLengthScale(group, value) { /* maps one child, mirrors _boneLengthChildrenForGroup */ this.scaled[CHILD_OF[group]] = 0.5 + value; this.restyle(); }
}

test("edit -> save -> load round trip is the identity over 10 cycles", () => {
  const viewer = new FakeViewer({ upperarm_l: [1, 0, 0], spine: [0, 1, 0] });
  let pose = { bonePositions: { upperarm_l: [1.4, 0.2, 0], spine: [0, 1.2, 0] } }; // user-modified
  const first = relativizeUniCanvasPoseBones(viewer, pose);
  let current = first;
  for (let cycle = 0; cycle < 10; cycle += 1) {
    viewer.updateBoneLengthScale("shoulder_l", 0.5); // neutral 1.0 scale, re-caches rest
    current = relativizeUniCanvasPoseBones(viewer, absolutizeUniCanvasPoseBones(viewer, current));
  }
  assert.deepEqual(current.bonePositions, first.bonePositions);
});
```

(`vec` = the file's existing tiny vector stub or `{x, y, z}` with `clone()`/`multiplyScalar()` as used by the module under test; `CHILD_OF = { shoulder_l: "upperarm_l", spine: "spine_02" }` mirrors `_boneLengthChildrenForGroup`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/test_unicanvas_pose_layers.mjs`
Expected: FAIL - deltas differ across cycles (this pins the exact drift the user sees).

- [ ] **Step 3: Write the failing E2E spec**

`tests/e2e/pose-roundtrip.spec.mjs`:

```js
import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openUnicanvas, addPoseLayer, runEditSaveCycle, LAYER_TYPES } from "./helpers/app.mjs";
import { measureAlphaBBoxInPage } from "./helpers/measure.mjs";

test("5 edit->save cycles do not deform the mannequin", async ({ page }) => {
  await openUnicanvas(page);
  await addPoseLayer(page);
  await runEditSaveCycle(page);
  const measure = async () => {
    const layers = await page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers());
    const pose = layers.find((l) => l.type === LAYER_TYPES.pose);
    const pixels = await page.evaluate((id) => globalThis.__VNCCS_UC_E2E__.getLayerPixels(id), pose.id);
    return measureAlphaBBoxInPage(page, pixels.dataURL);
  };
  const first = await measure();
  const probe = [{ cycle: 1, ...first }];
  for (let cycle = 2; cycle <= 5; cycle += 1) {
    await runEditSaveCycle(page);
    probe.push({ cycle, ...(await measure()) });
  }
  await writeFile(
    resolve(import.meta.dirname, "evidence", "pose-roundtrip", "probe.json"),
    JSON.stringify(probe, null, 2),
  );
  const last = probe[probe.length - 1];
  expect(Math.abs(last.width / first.width - 1)).toBeLessThan(0.01);
  expect(Math.abs(last.height / first.height - 1)).toBeLessThan(0.01);
  expect(Math.abs(last.area / first.area - 1)).toBeLessThan(0.01);
});
```

(`measureAlphaBBox` must run in the browser - `OffscreenCanvas` - so every spec calls it through `measureAlphaBBoxInPage(page, dataURL)`; add that wrapper to `helpers/measure.mjs` in Task 2 as `export const measureAlphaBBoxInPage = (page, dataURL) => page.evaluate(measureAlphaBBox, dataURL);`.)

- [ ] **Step 4: Run the E2E spec to verify it fails**

Run: `COMFYUI_URL=http://localhost:8188 npx playwright test pose-roundtrip.spec.mjs`
Expected: FAIL (bbox drifts across cycles). Read `probe.json`: the failing dimension tells which term compounds (width-only -> bone-offset scaling of shoulder/hip groups; all -> rest-cache/`initialBoneStates` corruption).

- [ ] **Step 5: Implement the fix at the failing layer**

Primary fix (storage/re-cache hardening - `web/vnccs_unicanvas_pose_layers.mjs`):

```js
// Spec 5.2: the shaped rest must always describe the CURRENT rest skeleton.
// Every reshape (length scales, head/arm/hand/foot scales) re-caches it so
// relativize/absolutize stays the identity across edit -> save cycles.
function restyleUniCanvasPoseRest(viewer) {
  viewer?._cacheShapedRestBonePositions?.();
}

function applyUniCanvasPoseProportionParams(viewer, morphs) {
  if (!viewer || !morphs) return;
  for (const [key, rawValue] of Object.entries(morphs)) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    if (key.endsWith("_length")) {
      const group = key.slice(0, -"_length".length);
      if (!group) continue;
      if (typeof viewer.updateBoneLengthScale === "function") viewer.updateBoneLengthScale(group, value);
      continue;
    }
    const setterNames = POSE_PROPORTION_SIZE_SETTERS[key];
    if (!setterNames) continue;
    for (const name of setterNames) {
      if (typeof viewer[name] === "function") { viewer[name](value); break; }
    }
  }
  restyleUniCanvasPoseRest(viewer);
}
```

If `probe.json` shows drift even with that in place, the corruption is in the core (`web/vnccs_pose_studio_core.js:3249-3250` mutates `initialBoneStates` from current positions) - apply the guarded core fix there:

```js
// Only re-baseline from current positions when NO pose is applied; otherwise a
// posed position silently becomes the "initial" rest and compounds on save.
if (this.initialBoneStates?.[bone.name] && !this._poseDirty) {
  this.initialBoneStates[bone.name].position.copy(bone.position);
}
```

(`_poseDirty` = a boolean the module sets in `setPose` when any `bonePositions`/`bones` entry is applied and clears in `resetPose`/`loadData`.)

- [ ] **Step 6: Run both tests to verify they pass**

Run: `node --test tests/test_unicanvas_pose_layers.mjs` (round-trip PASS) and `COMFYUI_URL=http://localhost:8188 npx playwright test pose-roundtrip.spec.mjs` (PASS, `probe.json` flat within 1%).

- [ ] **Step 7: Capture After evidence**

Run: `node evidence.mjs --topic pose-roundtrip --phase after` (attach `probe.json` to the evidence folder as the measured geometry of this fix).

- [ ] **Step 8: Commit**

```bash
git add web/vnccs_unicanvas_pose_layers.mjs tests/test_unicanvas_pose_layers.mjs tests/e2e/pose-roundtrip.spec.mjs
# plus web/vnccs_pose_studio_core.js if the guarded core fix was needed
git commit -m "fix(unicanvas): make the pose edit->save round trip the identity across cycles"
```

---

### Task 6: Torso-anchored framing - Bug B (spec §6)

**Files:**
- Modify: `web/vnccs_unicanvas_pose_layers.mjs` (new `computeTorsoAnchor`, `applyUniCanvasPoseFraming`; wire into `editUniCanvasPoseLayer` after `viewer.setPose`, ~line 1379, and into `applyUniCanvasPoseEditCapture`/`captureUniCanvasPoseEditPNG`)
- Test: `tests/test_unicanvas_pose_layers.mjs` (anchor math)
- Test: `tests/e2e/pose-framing.spec.mjs`

**Interfaces:**
- Consumes: `viewer.bones` (name -> bone with world position), `viewer.orbit.target`, `viewer.sceneCameraTarget` (`web/vnccs_pose_studio_core.js:3049`, consumed by `updateCaptureCamera:4643`), `captureUniCanvasPoseLayerPNG(viewer, w, h, camera)`.
- Produces: `computeTorsoAnchor(viewer) -> {x, y, z} | null`, `applyUniCanvasPoseFraming(viewer) -> anchor | null`. `poseData.camera` after save has `offset_x: 0, offset_y: 0` (spec §6.3 re-frame).

- [ ] **Step 0: Capture Before evidence**

Run (workdir `tests/e2e`): `COMFYUI_URL=http://localhost:8188 node evidence.mjs --topic pose-framing --phase before`

- [ ] **Step 1: Write the failing anchor test** (append to `tests/test_unicanvas_pose_layers.mjs`)

```js
test("computeTorsoAnchor centers between pelvis and upper chest, never the head", () => {
  const viewer = {
    bones: boneStub({
      root: [0, 0, 0], pelvis: [0, 3, 0], spine_02: [0, 4, 0], spine_03: [0, 5, 0],
      neck: [0, 6, 0], head: [0, 7, 0], upperarm_l: [-1, 5.5, 0], upperarm_r: [1, 5.5, 0],
      thigh_l: [-0.5, 2.5, 0], thigh_r: [0.5, 2.5, 0],
    }),
  };
  const anchor = computeTorsoAnchor(viewer);
  assert.ok(anchor, "anchor resolved");
  // Mid-torso: between pelvis (3) and upper chest (5) -> ~4; the head (7) must
  // not drag the anchor up.
  assert.ok(Math.abs(anchor.y - 4) < 0.35, `anchor.y=${anchor.y} expected ~4`);
  assert.ok(Math.abs(anchor.x) < 1e-6);
});

test("computeTorsoAnchor falls back to the mesh center on an unknown rig", () => {
  const viewer = { bones: boneStub({ something: [0, 1, 0] }), meshCenter: { x: 0, y: 2, z: 0 } };
  const anchor = computeTorsoAnchor(viewer);
  assert.deepEqual(anchor, { x: 0, y: 2, z: 0 });
});
```

(`boneStub(map)` = existing-style helper returning `name -> { getWorldPosition(v){ Object.assign(v, ...) } }`; if the file has none, write a 6-line local one.)

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/test_unicanvas_pose_layers.mjs`
Expected: FAIL (`computeTorsoAnchor is not defined`).

- [ ] **Step 3: Write the failing E2E spec**

`tests/e2e/pose-framing.spec.mjs`:

```js
import { test, expect } from "@playwright/test";
import { openUnicanvas, addPoseLayer, savePose, LAYER_TYPES } from "./helpers/app.mjs";
import { measureAlphaBBoxInPage } from "./helpers/measure.mjs";

test("Edit pose frames the mannequin on the canvas center (torso, not head)", async ({ page }) => {
  await openUnicanvas(page);
  await addPoseLayer(page);
  await savePose(page); // spec 6.2: the saved framing == the edit view framing
  const layers = await page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers());
  const pose = layers.find((l) => l.type === LAYER_TYPES.pose);
  const pixels = await page.evaluate((id) => globalThis.__VNCCS_UC_E2E__.getLayerPixels(id), pose.id);
  const bbox = await measureAlphaBBoxInPage(page, pixels.dataURL);
  const canvasCenterX = pixels.width / 2;
  // Horizontal: the mannequin is centered (its own midline at frame center).
  expect(Math.abs((bbox.minX + bbox.maxX) / 2 - canvasCenterX) / pixels.width).toBeLessThan(0.02);
  // Vertical: the torso anchor sits at frame center - the bbox center of a
  // standing figure sits slightly BELOW the torso (legs), so assert the torso
  // third of the bbox is centered (spec 6.1).
  const torsoY = bbox.minY + bbox.height * 0.35;
  expect(Math.abs(torsoY - pixels.height / 2) / pixels.height).toBeLessThan(0.03);
});
```

- [ ] **Step 4: Run the E2E spec to verify it fails**

Run: `COMFYUI_URL=http://localhost:8188 npx playwright test pose-framing.spec.mjs`
Expected: FAIL (the mannequin sits high - the head is framed as the center).

- [ ] **Step 5: Implement the framing**

In `web/vnccs_unicanvas_pose_layers.mjs`:

```js
// Spec 6.1: torso center = centroid of pelvis/spine/chest/shoulder joints,
// excluding head/neck. Fallback: viewer.meshCenter.
const TORSO_BONE_PATTERN = /(pelvis|hips|spine|chest|shoulder|upperarm)/i;
const EXCLUDED_BONE_PATTERN = /(head|neck)/i;

export function computeTorsoAnchor(viewer) {
  const bones = viewer?.bones || {};
  const names = Object.keys(bones).filter(
    (name) => TORSO_BONE_PATTERN.test(name) && !EXCLUDED_BONE_PATTERN.test(name),
  );
  const points = [];
  const v = { x: 0, y: 0, z: 0 };
  for (const name of names) {
    const bone = bones[name];
    if (typeof bone?.getWorldPosition === "function") {
      bone.getWorldPosition(v);
      points.push({ x: v.x, y: v.y, z: v.z });
    }
  }
  if (!points.length) {
    const c = viewer?.meshCenter;
    return c ? { x: c.x, y: c.y, z: c.z } : null;
  }
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }), { x: 0, y: 0, z: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length, z: sum.z / points.length };
}

// Spec 6.2: one framing for the edit view and the capture - both aim at the
// torso anchor. The live view keeps the user's orbit direction, the capture
// keeps its stored zoom and zero offsets (6.3 re-frame).
export function applyUniCanvasPoseFraming(viewer) {
  const anchor = computeTorsoAnchor(viewer);
  if (!anchor || !viewer.orbit) return null;
  const THREE = viewer.THREE;
  viewer.sceneCameraTarget = new THREE.Vector3(anchor.x, anchor.y, anchor.z);
  viewer.orbit.target.copy(viewer.sceneCameraTarget);
  const dist = 45; // matches updateCaptureCamera (vnccs_pose_studio_core.js:4650)
  const dir = viewer.camera.position.clone().sub(viewer.orbit.target);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
  viewer.camera.position.copy(viewer.orbit.target).add(dir.normalize().multiplyScalar(dist));
  viewer.orbit.update();
  viewer.requestRender?.();
  return anchor;
}
```

Wire-up (same file):
- `editUniCanvasPoseLayer` after `viewer.setPose(...)` (line 1379): `applyUniCanvasPoseFraming(viewer);`
- `applyUniCanvasPoseEditCapture` (line 1245): pass a re-framed camera into `buildPoseLayerData`: `camera: { ...session.poseData.camera, offset_x: 0, offset_y: 0 }` and use the same in `captureUniCanvasPoseEditPNG` (so the PNG and the stored framing agree).

- [ ] **Step 6: Run both tests to verify they pass**

Run: `node --test tests/test_unicanvas_pose_layers.mjs` (anchor tests PASS) and `COMFYUI_URL=http://localhost:8188 npx playwright test pose-framing.spec.mjs` (PASS).

- [ ] **Step 7: Capture After evidence**

Run: `node evidence.mjs --topic pose-framing --phase after`

- [ ] **Step 8: Commit**

```bash
git add web/vnccs_unicanvas_pose_layers.mjs tests/test_unicanvas_pose_layers.mjs tests/e2e/pose-framing.spec.mjs
git commit -m "fix(unicanvas): frame pose editing on the torso center instead of the head"
```

---

### Task 7: AGENTS.md documentation, CHANGELOG, evidence pairs, full verification

**Files:**
- Modify: `AGENTS.md` (append two English sections; keep the realtime rules untouched)
- Modify: `CHANGELOG.md`
- Create: `tests/e2e/evidence/<topic>/<topic>.pair.png` + `<topic>.after.png` (generated)

**Interfaces:**
- Consumes: Tasks 1-6 (all specs green, all before/after captures present).
- Produces: documented E2E/platform workflow (spec §9), composed evidence pairs (spec §7.5), green full suites.

- [ ] **Step 1: Write the AGENTS.md sections** (append to `AGENTS.md`)

```markdown
## E2E tests (Playwright)

`tests/e2e/` contains browser E2E tests for the UniCanvas UI. The only input is the
ComfyUI URL of the running test platform:

    cd tests/e2e
    npm install && npx playwright install chromium
    COMFYUI_URL=http://localhost:8188 npx playwright test

- Specs: `smoke` (harness sanity), `mannequin-options` (sidebar section + realtime rule),
  `settings-panel` (popover under the gear), `pose-roundtrip` (edit->save idempotence),
  `pose-framing` (torso-centered framing).
- The tests never call GPU generation and never download models. Geometric assertions read
  the saved pose layer pixels through the read-only `window.__VNCCS_UC_E2E__` hook
  (`listLayers`, `getLayerPixels`) plus `helpers/measure.mjs`.
- Evidence for UI changes (Before/After, labels exactly `Before`/`After`, plus measured
  geometry): `node evidence.mjs --topic <topic> --phase before|after|compose`. Output:
  `tests/e2e/evidence/<topic>/`. Keep the local copy; host it on an `evidence/<topic>`
  branch when opening a PR.

## Test platform (Docker)

`tests/e2e/platform/` builds a ComfyUI with the VNCSS and VNCCS_Utils custom nodes
preinstalled. Two lanes:

- **Lane A (primary, CPU-only, local):** `docker compose up -d -f tests/e2e/platform/docker-compose.yml`
  serves the UI at `http://localhost:8188`; the working tree is bind-mounted over
  `custom_nodes/ComfyUI_VNCCS_Utils`, so WIP code needs no image rebuild. CPU is enough for
  all UI/E2E work - the mannequin pipeline is client-side WebGL. No GPU inference
  (GENERATE, remove-bg backends, Generate character) is exercised on this lane.
- **Lane B (optional, Runpod GPU pod):** only for GPU-dependent verification. Build the CUDA
  variant (`--build-arg BASE_IMAGE=runpod/comfyui:cuda12.8 --build-arg TORCH_INDEX=preinstalled`),
  refresh WIP code with `sync-wip.ps1 -Target <ssh-host>`. Cost guardrails (from
  `~/.dsh/AGENTS.md`): cheapest GPU with >=24 GB VRAM and CUDA 12.8 (RTX 4090 preferred),
  150 GB disk, no network volume, kill task scheduled at launch, hard $1 per-session cap,
  stop AND terminate the pod afterwards and confirm no stray pods remain.

Nothing is hardcoded to this fork (it merges into the mainline later): `VNCSS_UTILS_REPO`,
`VNCSS_UTILS_REF`, `VNCSS_REPO`, `VNCSS_REF` and the image name are all build args /
parameters.
```

- [ ] **Step 2: Update CHANGELOG.md**

Add under the unreleased heading: the sidebar mannequin options (modal removed), the anchored settings popover, the round-trip idempotence fix, the torso framing fix, and the note "existing pose layers re-frame on their first save" (spec §6.3).

- [ ] **Step 3: Compose the evidence pairs**

Run (workdir `tests/e2e`), for each topic `mannequin-options`, `settings-panel`, `pose-roundtrip`, `pose-framing`:
`node evidence.mjs --topic <topic> --phase compose`
Expected: `<topic>.pair.png` (side-by-side, labels `Before`/`After`) + `<topic>.after.png` in each evidence folder.

- [ ] **Step 4: Run the full verification (evidence before claims)**

Run from repo root:
1. `node --test tests/` - expect the known baseline of 9 failures (factory3d/camera/importFile CRLF class) and ZERO new failures.
2. `C:\Users\admin\dsh-local\vnccs-work\.venv\Scripts\python.exe -m pytest tests -q` - expect the known baseline of 2 failures (factory3d tempfile lock, security-scan CRLF hash pin) and ZERO new failures.
3. `COMFYUI_URL=http://localhost:8188 npx playwright test` (workdir `tests/e2e`) - expect ALL specs green.

Record the actual counts in the task report. If any count regresses: STOP and investigate (systematic-debugging), do not claim completion.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md CHANGELOG.md tests/e2e/evidence
git commit -m "docs: document the E2E harness and Docker test platform; add UI evidence"
```
