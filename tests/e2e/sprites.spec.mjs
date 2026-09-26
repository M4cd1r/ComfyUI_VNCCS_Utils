import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { importImageLayer, openUnicanvas, setLayerNaming } from "./helpers/app.mjs";

// Plan 03 (#6): sprite sets. /vnccs/unicanvas/draw is stubbed with a red "face patch" PNG, so
// nothing runs inference. Written for the CPU Docker lane.
const FIXTURE = fileURLToPath(new URL("./fixtures/character.png", import.meta.url));
const shell = ".vnccs-uc2-standalone-shell";
const STAGE = `${shell} canvas.vnccs-uc-stage`;
const PANEL = `${shell} [data-sprite-panel]`;
const PNG_RED = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4o6EBRAwQCgAjrgSxn17XlQAAAABJRU5ErkJggg==";

const hook = (page, name, ...args) => page.evaluate(([fn, rest]) => globalThis.__VNCCS_UC_E2E__[fn](...rest), [name, args]);
const sprite = (page, id) => hook(page, "getSpriteState", id);
const stack = (page) => hook(page, "getLayerStack");
const row = (page, id) => page.locator(`${shell} [data-layer-id="${id}"]`);
const undo = (page, redo = false) => page.locator(`${shell} .vnccs-uc-icon[title="${redo ? "Redo" : "Undo"}"]`).first().click();

async function stubDraw(page) {
  const draws = [];
  await page.route("**/vnccs/unicanvas/draw", async (route) => {
    draws.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ images: [`data:image/png;base64,${PNG_RED}`], performance: "stub" }) });
  });
  return draws;
}

/** RGBA of one variant (rect size), read in the page. */
async function variantPixels(page, layerId, variantId) {
  return page.evaluate(async ([layer, variant]) => {
    const url = globalThis.__VNCCS_UC_E2E__.getSpriteVariantPixels(layer, variant);
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: [...ctx.getImageData(0, 0, bitmap.width, bitmap.height).data] };
  }, [layerId, variantId]);
}

function alphaBox({ width, height, data }) {
  let x1 = width, y1 = height, x2 = -1, y2 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] <= 16) continue;
    x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y);
  }
  return x2 < 0 ? null : { x: x1, y: y1, width: x2 - x1 + 1, height: y2 - y1 + 1 };
}

async function createSpriteSet(page) {
  await setLayerNaming(page, { level: "off", autoFile: false });
  await importImageLayer(page, FIXTURE);
  const source = (await stack(page)).activeLayerId;
  await row(page, source).first().click({ button: "right" });
  await page.locator('.vnccs-uc-layer-menu [data-menu-item="create-sprite-set"]').click();
  await expect.poll(async () => (await stack(page)).layers.find((layer) => layer.type === "sprite")?.id || null).not.toBeNull();
  const layer = (await stack(page)).layers.find((layer) => layer.type === "sprite");
  await expect(page.locator(PANEL)).toBeVisible();
  return { source, id: layer.id };
}

async function dragFace(page) {
  const face = page.locator(`${PANEL} [data-sprite-face] canvas`);
  const box = await face.boundingBox();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.02);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.22, { steps: 6 });
  await page.mouse.up();
}

test("sprite set: create, add presets, generate missing in one undo step, switch, move and reload", async ({ page }) => {
  const draws = await stubDraw(page);
  await openUnicanvas(page);
  const { source, id } = await createSpriteSet(page);

  // A neutral variant with the anchor at the alpha's bottom centre; the source stays hidden.
  let state = await sprite(page, id);
  expect(state.variants.map((variant) => variant.name)).toEqual(["neutral"]);
  expect((await stack(page)).layers.find((layer) => layer.id === source).visible).toBe(false);
  const neutralId = state.variants[0].id;
  const neutral = await variantPixels(page, id, neutralId);
  const bbox = alphaBox(neutral);
  expect(Math.abs(state.anchor.x - (bbox.x + bbox.width / 2))).toBeLessThanOrEqual(2);
  expect(Math.abs(state.anchor.y - (bbox.y + bbox.height))).toBeLessThanOrEqual(2);

  // Presets: the base plus 15 empty expressions (neutral included, #6).
  await page.locator(`${PANEL} [data-sprite-action="add-presets"]`).click();
  state = await sprite(page, id);
  expect(state.variants).toHaveLength(16);
  expect(state.variants.filter((variant) => variant.status === "empty")).toHaveLength(15);

  // Face area, then Generate missing.
  await dragFace(page);
  await expect.poll(async () => (await sprite(page, id)).faceRect).not.toBeNull();
  const undoBefore = (await stack(page)).undo;
  await page.locator(`${PANEL} [data-sprite-action="generate-missing"]`).click();
  await expect.poll(async () => (await sprite(page, id)).variants.filter((variant) => variant.status === "ready").length, { timeout: 60_000 }).toBe(16);
  expect(draws).toHaveLength(15);
  expect(draws.every((body) => body.mode === "inpaint" && body.mask)).toBe(true);
  expect((await stack(page)).undo).toBe(undoBefore + 1);
  state = await sprite(page, id);
  const face = state.faceRect;
  for (const variant of state.variants.slice(1)) {
    const pixels = await variantPixels(page, id, variant.id);
    expect(pixels.width).toBe(neutral.width);
    expect(pixels.height).toBe(neutral.height);
    let outside = 0, alpha = 0, changed = 0;
    for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) {
      const offset = (y * pixels.width + x) * 4;
      if (pixels.data[offset + 3] !== neutral.data[offset + 3]) alpha++;
      const same = [0, 1, 2].every((channel) => pixels.data[offset + channel] === neutral.data[offset + channel]);
      const inside = x >= face.x && x < face.x + face.width && y >= face.y && y < face.y + face.height;
      if (!inside && !same) outside++;
      if (inside && !same) changed++;
    }
    expect(alpha, `${variant.name}: alpha bit-identical`).toBe(0);
    expect(outside, `${variant.name}: pixels outside faceRect unchanged`).toBe(0);
    expect(changed, `${variant.name}: the face was repainted`).toBeGreaterThan(0);
  }

  // One undo restores the empty variants; redo brings them back.
  await undo(page);
  await expect.poll(async () => (await sprite(page, id)).variants.filter((variant) => variant.status === "empty").length).toBe(15);
  await undo(page, true);
  await expect.poll(async () => (await sprite(page, id)).variants.filter((variant) => variant.status === "ready").length).toBe(16);

  // Switching keeps the alpha bbox identical across variants.
  const crop = await hook(page, "getLayerCrop", id);
  for (const name of ["happy", "sad", "sleepy"]) {
    const variant = state.variants.find((item) => item.name === name);
    await page.locator(`${PANEL} [data-sprite-variant="${variant.id}"]`).click();
    await expect.poll(async () => (await sprite(page, id)).activeVariantId).toBe(variant.id);
    expect((await hook(page, "getLayerCrop", id)).rect).toEqual(crop.rect);
  }
  // `,` / `.` cycle variants while the canvas has focus.
  const beforeKey = (await sprite(page, id)).activeVariantId;
  await page.locator(STAGE).hover();
  await page.keyboard.press(".");
  await expect.poll(async () => (await sprite(page, id)).activeVariantId).not.toBe(beforeKey);
  await page.keyboard.press(",");
  await expect.poll(async () => (await sprite(page, id)).activeVariantId).toBe(beforeKey);

  // Moving the layer moves every variant: the shared rect moves, the variants keep their size.
  const rectBefore = (await sprite(page, id)).rect;
  await page.locator(`${shell} .vnccs-uc-tool[data-tool="move"]`).click();
  const stageBox = await page.locator(STAGE).boundingBox();
  const at = { x: stageBox.x + stageBox.width / 2, y: stageBox.y + stageBox.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 60, at.y + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await sprite(page, id)).rect.x).not.toBe(rectBefore.x);
  const moved = await sprite(page, id);
  expect(moved.rect.width).toBe(rectBefore.width);
  expect(moved.rect.height).toBe(rectBefore.height);
  const movedCrop = (await hook(page, "getLayerCrop", id)).rect;
  await page.locator(`${PANEL} [data-sprite-variant="${neutralId}"]`).click();
  const neutralCrop = (await hook(page, "getLayerCrop", id)).rect;
  expect(neutralCrop.x - movedCrop.x).toBe(0);
  expect(neutralCrop.y - movedCrop.y).toBe(0);

  // Variants and the active variant survive a reload.
  const saved = await sprite(page, id);
  await page.waitForTimeout(2500); // standalone persistence is debounced
  await page.reload({ waitUntil: "domcontentloaded" });
  await openUnicanvas(page, { navigate: false });
  await expect.poll(async () => (await sprite(page, id))?.variants.length ?? 0, { timeout: 30_000 }).toBe(16);
  const reloaded = await sprite(page, id);
  expect(reloaded.activeVariantId).toBe(saved.activeVariantId);
  expect(reloaded.rect).toEqual(saved.rect);
  expect(reloaded.variants.every((variant) => variant.status === "ready")).toBe(true);
  const happy = reloaded.variants.find((variant) => variant.name === "happy");
  expect(alphaBox(await variantPixels(page, id, happy.id))).toEqual(bbox);
});

test("Split variant to layer copies the active variant into a raster layer", async ({ page }) => {
  await openUnicanvas(page);
  const { id } = await createSpriteSet(page);
  await row(page, id).first().click({ button: "right" });
  await page.locator('.vnccs-uc-layer-menu [data-menu-item="split-variant-to-layer"]').click();
  const layers = (await stack(page)).layers;
  const copy = layers[layers.findIndex((layer) => layer.id === id) - 1];
  expect(copy.type).toBe("raster");
  expect((await hook(page, "getLayerCrop", copy.id)).rect).toEqual((await hook(page, "getLayerCrop", id)).rect);
});
