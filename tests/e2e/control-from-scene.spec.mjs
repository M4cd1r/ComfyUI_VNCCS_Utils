import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { importImageLayer, openPoseTool, openUnicanvas } from "./helpers/app.mjs";

// Issue #46: a ControlNet layer made from the scene. The model-based preprocessors (depth,
// lineart) are stubbed with page.route fixtures, canny and pose run in the browser, and nothing
// generates. Geometry is read through window.__VNCCS_UC_E2E__.
const FIXTURE = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const SHELL = ".vnccs-uc2-standalone-shell";

async function chooseSetting(page, setting, value) {
  await page.evaluate(([key, next]) => {
    const select = document.querySelector(`.vnccs-uc2-standalone-shell select[data-setting="${key}"]`);
    select.value = next;
    select.dispatchEvent(new Event("input", { bubbles: true }));
  }, [setting, value]);
}

async function selectZImage(page) {
  await page.locator(`${SHELL} [data-model-selection-mode="custom"]`).first().click();
  await chooseSetting(page, "model_loader", "diffusion_model");
  await chooseSetting(page, "generation_mode", "z_image");
}

// A horizontal gradient as the stubbed raw map: bright on the left.
async function stubPreprocessors(page) {
  const requests = [];
  await page.route("**/vnccs/unicanvas/control_preprocess", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body.type);
    const raw = await page.evaluate(([width, height]) => {
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d");
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, "#fff"); gradient.addColorStop(1, "#000");
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
      return canvas.toDataURL("image/png");
    }, [64, 64]);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ type: body.type, width: 64, height: 64, raw, encoding: "gray8", model: "stub" }) });
  });
  return requests;
}

const controlLayerId = (page) => page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers().find((l) => l.type === "control")?.id || null);
const layerHash = (page, id) => page.evaluate((layerId) => {
  const pixels = globalThis.__VNCCS_UC_E2E__.getLayerPixels(layerId);
  return pixels ? pixels.dataURL.length + ":" + pixels.dataURL.slice(-64) : null;
}, id);
const undoDepth = (page) => page.evaluate(() => globalThis.__VNCCS_UC_E2E__.getLayerStack().undo);

test("ControlNet from scene: create, type switch, live slider, refresh", async ({ page }) => {
  const requests = await stubPreprocessors(page);
  await openUnicanvas(page);
  await importImageLayer(page, FIXTURE);
  await selectZImage(page);
  await page.locator(`${SHELL} [data-control-add]`).click();
  const panel = page.locator(`${SHELL} [data-control-panel]`);
  await expect(panel.locator("[data-control-from-scene]")).toHaveText("From scene");

  // Depth from the scene (stubbed model): the layer gets pixels and keeps its source.
  await panel.locator('[data-control-field="type"]').selectOption("depth");
  await panel.locator("[data-control-from-scene]").click();
  const id = await controlLayerId(page);
  await expect.poll(() => page.evaluate((layerId) => globalThis.__VNCCS_UC_E2E__.getControlSource(layerId)?.type, id)).toBe("depth");
  const source = await page.evaluate((layerId) => globalThis.__VNCCS_UC_E2E__.getControlSource(layerId), id);
  expect(source.hasImage).toBe(true);
  expect(requests).toContain("depth");
  await expect(panel.locator("[data-control-from-scene]")).toHaveText("Refresh from scene");

  // A live slider: the layer pixels change between two pointermoves before pointerup, and the
  // gesture commits one history entry.
  const undoBefore = await undoDepth(page);
  const slider = panel.locator('[data-scene-param="near"]');
  const box = await slider.boundingBox();
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 3 });
  await expect.poll(() => layerHash(page, id)).not.toBeNull();
  const first = await layerHash(page, id);
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 3 });
  await expect.poll(() => layerHash(page, id)).not.toBe(first);
  expect(await undoDepth(page)).toBe(undoBefore);
  await page.mouse.up();
  await expect.poll(() => undoDepth(page)).toBe(undoBefore + 1);

  // Type switch re-runs on the stored source (canny runs in the browser, no request).
  const count = requests.length;
  const beforeSwitch = await layerHash(page, id);
  await panel.locator('[data-control-field="type"]').selectOption("canny");
  await expect.poll(() => page.evaluate((layerId) => globalThis.__VNCCS_UC_E2E__.getControlSource(layerId)?.type, id)).toBe("canny");
  expect(requests.length).toBe(count);
  expect(await layerHash(page, id)).not.toBe(beforeSwitch);
  await expect(panel.locator('[data-scene-param="low"]')).toBeVisible();

  // Lineart (stubbed) through the type menu too.
  await panel.locator('[data-control-field="type"]').selectOption("lineart");
  await expect.poll(() => page.evaluate((layerId) => globalThis.__VNCCS_UC_E2E__.getControlSource(layerId)?.type, id)).toBe("lineart");
  expect(requests).toContain("lineart");
});

test("ControlNet from scene: a pose control follows its pose layer, painting detaches, Relink restores", async ({ page }) => {
  await stubPreprocessors(page);
  await openUnicanvas(page);
  await selectZImage(page);
  await openPoseTool(page);
  await page.locator(".vnccs-uc-pose-editbar button", { hasText: "Save pose" }).click();

  // Layer menu on the pose layer: "New pose ControlNet layer".
  await page.locator(`${SHELL} .vnccs-uc-layer[data-layer-type="pose"]`).first().click({ button: "right" });
  await page.locator('.vnccs-uc-layer-menu [data-menu-item="control-pose-from-layer"]').click();
  await expect.poll(() => controlLayerId(page)).not.toBeNull();
  const id = await controlLayerId(page);
  await expect.poll(() => page.evaluate((layerId) => globalThis.__VNCCS_UC_E2E__.getControlSource(layerId)?.type, id)).toBe("pose");
  const panel = page.locator(`${SHELL} [data-control-panel]`);
  await expect(panel.locator("[data-control-link]")).toHaveAttribute("data-control-link", "linked");

  // Moving the pose layer redraws the linked skeleton.
  const before = await layerHash(page, id);
  const poseRow = page.locator(`${SHELL} .vnccs-uc-layer[data-layer-type="pose"]`).first();
  await poseRow.click();
  await page.keyboard.press("v");
  const canvas = page.locator(`${SHELL} canvas`).first();
  const area = await canvas.boundingBox();
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width / 2 + 40, area.y + area.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => layerHash(page, id)).not.toBe(before);

  // Painting on the control layer detaches it; Relink restores the link.
  await page.locator(`${SHELL} .vnccs-uc-layer[data-layer-type="control"]`).first().click();
  await page.keyboard.press("b");
  await page.mouse.move(area.x + area.width / 2 - 30, area.y + area.height / 2 - 30);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width / 2 + 30, area.y + area.height / 2 - 30, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate((layerId) => globalThis.__VNCCS_UC_E2E__.getControlSource(layerId)?.linked, id)).toBe(false);
  await expect(panel.locator("[data-control-link]")).toHaveAttribute("data-control-link", "detached");
  await panel.locator("[data-control-relink]").click();
  await panel.locator("[data-scene-confirm]").click();
  await expect.poll(() => page.evaluate((layerId) => globalThis.__VNCCS_UC_E2E__.getControlSource(layerId)?.linked, id)).toBe(true);
});
