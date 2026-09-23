import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openUnicanvas, addPoseLayer, LAYER_TYPES } from "./helpers/app.mjs";
import { measureAlphaBBoxInPage } from "./helpers/measure.mjs";

// CYCLES defaults to the brief's 5-cycle drift probe; evidence runs may ask
// for a longer series through the environment.
const CYCLES = Math.max(2, Number(process.env.CYCLES) || 5);

const POSE_EDIT_BAR = ".vnccs-uc-pose-edit-bar";
const PROGRESS_LABEL = ".vnccs-uc-generation-progress .vnccs-uc-progress-label";

// The status line is visibility-hidden outside generation runs, so editor
// readiness is polled through textContent (mirrors helpers/app.mjs).
async function waitForPoseEditorReady(page) {
  await expect(page.locator(POSE_EDIT_BAR)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.locator(PROGRESS_LABEL).textContent(), { timeout: 60_000 })
    .toContain("drag the mannequin");
}

/**
 * Re-enter pose edit through the POSE layer row. helpers/app.mjs
 * runEditSaveCycle right-clicks the first [data-layer-id] row, but the widget
 * seeds mask/raster layers above the pose layer and their context menu has no
 * "Edit pose" entry, so this spec drives the re-entry itself.
 */
async function runEditSaveCycle(page) {
  if (!(await page.locator(POSE_EDIT_BAR).isVisible().catch(() => false))) {
    await page
      .locator("[data-layer-id]")
      .filter({ hasText: /^Pose/ })
      .first()
      .click({ button: "right" });
    await page.locator(`${".vnccs-uc-layer-menu"} button:has-text("Edit pose")`).click();
  }
  await waitForPoseEditorReady(page);
  await page.locator(`${POSE_EDIT_BAR} button:has-text("Save pose")`).click();
  await expect(page.locator(POSE_EDIT_BAR)).toBeHidden({ timeout: 30_000 });
}

test("edit->save cycles do not deform the mannequin", async ({ page }) => {
  await openUnicanvas(page);
  await addPoseLayer(page);
  await runEditSaveCycle(page);
  const measure = async () => {
    const layers = await page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers());
    const pose = layers.find((l) => l.type === LAYER_TYPES.pose);
    const pixels = await page.evaluate((id) => globalThis.__VNCCS_UC_E2E__.getLayerPixels(id), pose.id);
    return measureAlphaBBoxInPage(page, pixels.dataURL);
  };
  // Spec 5.1 storage clause: with unchanged input, layer.poseData must be
  // stable across edit -> save cycles too - a fix that only re-centers or
  // redraws the pixels while the stored pose keeps drifting must fail here.
  const readPoseData = async () => {
    const layers = await page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers());
    const pose = layers.find((l) => l.type === LAYER_TYPES.pose);
    const poseData = await page.evaluate((id) => globalThis.__VNCCS_UC_E2E__.getLayerPoseData(id), pose.id);
    expect(poseData, "the E2E hook must expose the pose layer poseData").not.toBeNull();
    return JSON.stringify(poseData);
  };
  const firstPoseData = await readPoseData();
  const first = await measure();
  const probe = [{ cycle: 1, ...first }];
  for (let cycle = 2; cycle <= CYCLES; cycle += 1) {
    await runEditSaveCycle(page);
    const poseData = await readPoseData();
    expect(poseData, `layer.poseData drifted at cycle ${cycle} (spec 5.1 storage clause)`).toBe(firstPoseData);
    probe.push({ cycle, ...(await measure()) });
  }
  const outDir = resolve(import.meta.dirname, "evidence", "pose-roundtrip");
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, "probe.json"), JSON.stringify(probe, null, 2));
  const last = probe[probe.length - 1];
  expect(Math.abs(last.width / first.width - 1)).toBeLessThan(0.01);
  expect(Math.abs(last.height / first.height - 1)).toBeLessThan(0.01);
  expect(Math.abs(last.area / first.area - 1)).toBeLessThan(0.01);
});

test("saving an unchanged pose preserves the layer's moved placement (spec 5.1b)", async ({ page }) => {
  await openUnicanvas(page);
  await addPoseLayer(page);
  await runEditSaveCycle(page);
  const centroid = async () => {
    const layers = await page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers());
    const pose = layers.find((l) => l.type === LAYER_TYPES.pose);
    const pixels = await page.evaluate((id) => globalThis.__VNCCS_UC_E2E__.getLayerPixels(id), pose.id);
    return measureAlphaBBoxInPage(page, pixels.dataURL);
  };
  const placed = await centroid();
  expect(placed.area).toBeGreaterThan(0);
  // The move tool bakes the placement into the layer bitmap: drag the layer
  // bottom-left (Save pose left the move tool active).
  const stage = page.locator("canvas.vnccs-uc-stage").first();
  const box = await stage.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 300, box.y + box.height / 2 + 200, { steps: 8 });
  await page.mouse.up();
  const moved = await centroid();
  expect(Math.abs(moved.centroidX - placed.centroidX)).toBeGreaterThan(5);
  expect(Math.abs(moved.centroidY - placed.centroidY)).toBeGreaterThan(5);
  // Edit pose -> Save pose WITHOUT touching anything: the placement must
  // survive instead of jumping back to the canvas centre.
  await runEditSaveCycle(page);
  const after = await centroid();
  expect(Math.abs(after.centroidX - moved.centroidX)).toBeLessThanOrEqual(2);
  expect(Math.abs(after.centroidY - moved.centroidY)).toBeLessThanOrEqual(2);
});
