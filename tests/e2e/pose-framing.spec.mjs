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
