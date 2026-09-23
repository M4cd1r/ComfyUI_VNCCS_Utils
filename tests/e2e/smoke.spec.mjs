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
