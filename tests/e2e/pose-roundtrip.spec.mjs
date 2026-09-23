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
async function enterPoseEditViaRow(page) {
  if (!(await page.locator(POSE_EDIT_BAR).isVisible().catch(() => false))) {
    await page
      .locator("[data-layer-id]")
      .filter({ hasText: /^Pose/ })
      .first()
      .click({ button: "right" });
    await page.locator(`${".vnccs-uc-layer-menu"} button:has-text("Edit pose")`).click();
  }
  await waitForPoseEditorReady(page);
}

async function runEditSaveCycle(page) {
  await enterPoseEditViaRow(page);
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

// --- Spec 5.1b on a POSE CHANGE (whole-branch review finding C1) -------------

/**
 * Alpha scan of the saved pose layer plus two placement landmarks that a
 * forearm rotation cannot move: the silhouette's bottom edge and the centroid
 * of the bottom band (the feet/legs). If a save translates the body, they move
 * by the same amount as the body does.
 */
async function measurePosePlacement(page, layerId) {
  const measure = async () => {
    const pixels = await page.evaluate((id) => globalThis.__VNCCS_UC_E2E__.getLayerPixels(id), layerId);
    expect(pixels, "the pose layer must still exist").not.toBeNull();
    const bbox = await measureAlphaBBoxInPage(page, pixels.dataURL);
    if (!bbox.area) return { ...bbox, feetCentroidX: null, feetCentroidY: null, poseData: null };
    // Bottom band = the lowest 15% of the silhouette (ankles/feet), measured
    // from the saved bitmap through the read-only hook.
    const band = await page.evaluate(
      async ([dataURL, fromY, toY]) => {
        const bitmap = await createImageBitmap(await (await fetch(dataURL)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0);
        const { data, width } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        let area = 0, sumX = 0, sumY = 0;
        for (let y = fromY; y <= toY; y += 1) {
          for (let x = 0; x < width; x += 1) {
            if (data[(y * width + x) * 4 + 3] < 8) continue;
            area += 1; sumX += x; sumY += y;
          }
        }
        return area ? { area, centroidX: sumX / area, centroidY: sumY / area } : null;
      },
      [pixels.dataURL, Math.max(0, bbox.maxY - Math.round(bbox.height * 0.15)), bbox.maxY],
    );
    const poseData = await page.evaluate((id) => globalThis.__VNCCS_UC_E2E__.getLayerPoseData(id), layerId);
    return {
      ...bbox,
      feetCentroidX: band ? band.centroidX : null,
      feetCentroidY: band ? band.centroidY : null,
      poseData: JSON.stringify(poseData),
    };
  };
  return measure;
}

test("a pose change and save does not translate the mannequin (spec 5.1b)", async ({ page }) => {
  await openUnicanvas(page);
  // The widget state (and therefore earlier spec runs' pose layers) is shared
  // across tests, so track the id of the layer this test creates instead of
  // taking whichever pose layer happens to be first.
  const knownIds = await page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers().map((l) => l.id));
  await addPoseLayer(page);
  const poseLayerId = await page.evaluate((known) => {
    const fresh = globalThis.__VNCCS_UC_E2E__.listLayers().find((l) => l.type === "pose" && !known.includes(l.id));
    return fresh ? fresh.id : null;
  }, knownIds);
  expect(poseLayerId, "adding a pose layer must create a new layer").not.toBeNull();
  await runEditSaveCycle(page);
  const measure = await measurePosePlacement(page, poseLayerId);
  const baseline = await measure();
  expect(baseline.area).toBeGreaterThan(0);
  expect(baseline.feetCentroidX).not.toBeNull();

  // Re-enter the editor and REALLY change the pose. The mannequin is framed on
  // the torso anchor at the canvas centre and the viewer's fixed vertical fov
  // maps the figure to a stable fraction of the canvas height, so the left
  // forearm sits left of the centre by ~0.10 canvas heights. Clicking it
  // selects that bone (rotate gizmo at the joint, radius ~0.09 canvas heights);
  // sweeping that ring ~180 degrees rotates the forearm out of the old
  // silhouette without touching the torso anchor or the legs.
  await page.locator(`[data-layer-id="${poseLayerId}"]`).first().click({ button: "right" });
  await page.locator(`${".vnccs-uc-layer-menu"} button:has-text("Edit pose")`).click();
  await waitForPoseEditorReady(page);
  // Canvas gestures have no DOM signal to await: give the viewer a beat to
  // settle after the framing call and after attaching the gizmo.
  await page.waitForTimeout(400);
  const canvas = page.locator(".vnccs-uc-pose-edit-canvas");
  const box = await canvas.boundingBox();
  const forearm = {
    x: box.x + box.width / 2 - box.height * 0.101,
    y: box.y + box.height / 2,
  };
  const ringRadius = box.height * 0.09;
  await page.mouse.click(forearm.x, forearm.y);
  await page.waitForTimeout(400);
  await page.mouse.move(forearm.x, forearm.y - ringRadius);
  await page.mouse.down();
  await page.mouse.move(forearm.x - ringRadius, forearm.y, { steps: 8 });
  await page.mouse.move(forearm.x, forearm.y + ringRadius, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.locator(`${POSE_EDIT_BAR} button:has-text("Save pose")`).click();
  await expect(page.locator(POSE_EDIT_BAR)).toBeHidden({ timeout: 30_000 });

  const changed = await measure();
  // The pose really changed: different stored pose AND a different silhouette
  // (the sweep swings the forearm out of the old bbox).
  expect(changed.poseData, "the edit must really change the stored pose").not.toBe(baseline.poseData);
  const silhouetteDelta = Math.max(
    Math.abs(changed.width - baseline.width),
    Math.abs(changed.height - baseline.height),
    Math.abs(changed.area / baseline.area - 1) * 100,
  );
  expect(silhouetteDelta, "the silhouette must really change with the pose").toBeGreaterThan(10);
  // The trap: save(pose change) must not translate the body. The feet are not
  // touched by a forearm rotation, so they must still be where they were; the
  // pre-fix bbox-centre alignment moved the whole mannequin by half the
  // silhouette change (tens of px).
  expect(Math.abs(changed.feetCentroidX - baseline.feetCentroidX)).toBeLessThanOrEqual(3);
  expect(Math.abs(changed.maxY - baseline.maxY)).toBeLessThanOrEqual(3);

  const outDir = resolve(import.meta.dirname, "evidence", "pose-roundtrip");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    resolve(outDir, "pose-change-placement.json"),
    JSON.stringify({ baseline, changed }, null, 2),
  );
});
