import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { importImageLayer, openUnicanvas } from "./helpers/app.mjs";

// Issue #13: painted Inpaint Mask pixels are sent as `keep` with Remove background. The route
// is stubbed (no inference on the CPU lane): it records the request and answers with an
// opaque PNG, which leaves the layer unchanged.
const BACKDROP_IMAGE = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const OPAQUE_ALPHA = `data:image/png;base64,${readFileSync(BACKDROP_IMAGE).toString("base64")}`;
const KEEP_LINE = ".vnccs-uc-settings-popover .vnccs-uc-remove-bg-keep";

async function stubRemoveBg(page) {
  const requests = [];
  await page.route("**/vnccs/unicanvas/remove_bg", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { alpha: OPAQUE_ALPHA, width: 1, height: 1, method: "birefnet", edit_model: null } });
  });
  return requests;
}

async function listLayers(page) {
  return page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers());
}

/** Painted pixels (alpha > 8, the widget's mask threshold) of a layer, read from its canvas. */
async function paintedPixels(page, layerId) {
  return page.evaluate(async (id) => {
    const pixels = globalThis.__VNCCS_UC_E2E__.getLayerPixels(id);
    const image = new Image();
    image.src = pixels.dataURL;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) painted += 1;
    return painted;
  }, layerId);
}

async function readKeepLine(page) {
  await page.locator(".vnccs-uc-gear").first().click();
  const line = page.locator(KEEP_LINE);
  await expect(line).toHaveCount(1);
  const text = (await line.textContent()).trim();
  await page.locator(".vnccs-uc-settings-popover").locator('button:has-text("Close")').click();
  return text;
}

async function runRemoveBackground(page, layerId, requests) {
  const count = requests.length;
  await page.locator(`[data-layer-id="${layerId}"]`).first().click({ button: "right" });
  await page.locator(".vnccs-uc-layer-menu button", { hasText: /^Remove background$/ }).click();
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(count + 1);
  return requests[count];
}

async function paintMaskStroke(page) {
  await page.locator('[title="Mask brush"]').first().click();
  const box = await page.locator("canvas.vnccs-uc-stage").first().boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 60, cy);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) await page.mouse.move(cx - 60 + step * 10, cy + step * 2);
  await page.mouse.up();
}

test("remove background sends the painted inpaint mask as keep areas", async ({ page }) => {
  const requests = await stubRemoveBg(page);
  await openUnicanvas(page);
  const before = new Set((await listLayers(page)).map((layer) => layer.id));
  await importImageLayer(page, BACKDROP_IMAGE);
  const imported = (await listLayers(page)).find((layer) => layer.type === "raster" && !before.has(layer.id));
  expect(imported).toBeTruthy();
  const mask = (await listLayers(page)).find((layer) => layer.type === "mask");
  expect(mask).toBeTruthy();

  // No painted mask: the popover says so and the request carries no keep field.
  expect(await readKeepLine(page)).toBe("Keep areas: none");
  const plain = await runRemoveBackground(page, imported.id, requests);
  expect(plain.image).toMatch(/^data:image\/png;base64,/);
  expect(plain).not.toHaveProperty("keep");

  // A mask stroke over the layer: the popover shows the painted pixel count ...
  await paintMaskStroke(page);
  const painted = await paintedPixels(page, mask.id);
  expect(painted).toBeGreaterThan(0);
  expect(await readKeepLine(page)).toBe(`Keep areas: Inpaint Mask layer (${painted} px painted)`);

  // ... and Remove background sends it as `keep`, the size of the layer crop.
  const kept = await runRemoveBackground(page, imported.id, requests);
  expect(kept.keep).toMatch(/^data:image\/png;base64,/);
  const sizes = await page.evaluate(async ({ image, keep }) => {
    const load = async (src) => { const img = new Image(); img.src = src; await img.decode(); return [img.width, img.height]; };
    return { image: await load(image), keep: await load(keep) };
  }, { image: kept.image, keep: kept.keep });
  expect(sizes.keep).toEqual(sizes.image);
});
