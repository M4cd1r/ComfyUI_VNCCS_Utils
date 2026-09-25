import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { importImageLayer, openUnicanvas, setLayerNaming } from "./helpers/app.mjs";

// Plan 08 (#11): horizon + calibration, depth-scaled moves around the feet anchor, lossless
// repeated moves, undo of perspective edits and of depth-scaled moves. No GPU: the depth route
// is stubbed.
const BACKDROP = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const CHARACTER = fileURLToPath(new URL("./fixtures/character.png", import.meta.url));
const shell = ".vnccs-uc2-standalone-shell";
const stage = `${shell} canvas.vnccs-uc-stage`;

const hook = (page, name, ...args) => page.evaluate(([fn, rest]) => globalThis.__VNCCS_UC_E2E__[fn](...rest), [name, args]);
const layers = (page) => hook(page, "listLayers");
const perspective = (page) => hook(page, "getScenePerspective");
const character = (page, id) => hook(page, "getLayerCharacter", id);

/** Client coordinates of a world point on the stage. */
async function client(page, point) {
  const view = await hook(page, "getView");
  const box = await page.locator(stage).first().boundingBox();
  const size = await page.locator(stage).first().evaluate((canvas) => ({ width: canvas.clientWidth, height: canvas.clientHeight }));
  return {
    x: box.x + (view.x + point.x * view.scale) * (box.width / size.width),
    y: box.y + (view.y + point.y * view.scale) * (box.height / size.height),
  };
}

async function drag(page, from, to, { steps = 12, during } = {}) {
  const a = await client(page, from);
  const b = await client(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  const samples = [];
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps);
    if (during) samples.push(await during());
  }
  await page.mouse.up();
  return samples;
}

/** Alpha-cropped pixels of a layer, for comparing content independent of its position. */
async function croppedPixels(page, id) {
  const pixels = await hook(page, "getLayerPixels", id);
  return page.evaluate(async (dataURL) => {
    const image = new Image();
    image.src = dataURL;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let left = width, right = -1, top = height, bottom = -1;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] <= 8) continue;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    const crop = ctx.getImageData(left, top, right - left + 1, bottom - top + 1);
    return { width: crop.width, height: crop.height, data: Array.from(crop.data) };
  }, pixels.dataURL);
}

function meanDifference(a, b) {
  expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(0);
  expect(Math.abs(a.height - b.height)).toBeLessThanOrEqual(0);
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 1) sum += Math.abs(a.data[i] - b.data[i]);
  return sum / a.data.length;
}

async function newLayerAfter(page, action) {
  const before = new Set((await layers(page)).map((layer) => layer.id));
  await action();
  await expect.poll(async () => (await layers(page)).filter((layer) => !before.has(layer.id)).length, { timeout: 15_000 }).toBe(1);
  return (await layers(page)).find((layer) => !before.has(layer.id));
}

test("perspective calibration drives live, lossless, undoable depth-scaled moves", async ({ page }) => {
  await openUnicanvas(page);
  await setLayerNaming(page, { autoFile: false }); // keep imported layers where the spec expects them
  await newLayerAfter(page, () => importImageLayer(page, BACKDROP));
  const figure = await newLayerAfter(page, () => importImageLayer(page, CHARACTER));
  const start = await character(page, figure.id);
  expect(start.rect.height).toBeGreaterThan(100);

  // G selects the Perspective tool; its first drag on the stage creates the horizon.
  await page.locator(stage).first().focus();
  await page.keyboard.press("g");
  await expect.poll(() => hook(page, "getActiveTool")).toBe("perspective");
  await expect(page.locator(`${shell} .vnccs-uc-tool[data-tool="perspective"]`)).toHaveClass(/active/);
  const horizonY = start.rect.y - 10;
  await drag(page, { x: start.feet.x + 300, y: horizonY - 60 }, { x: start.feet.x + 300, y: horizonY });
  await expect.poll(async () => Math.abs((await perspective(page)).horizonY - horizonY)).toBeLessThan(2);
  const horizon = (await perspective(page)).horizonY;

  // Calibrate from the selected character, then undo / redo that perspective edit.
  const beforeCalibration = await perspective(page);
  await page.locator(`${shell} [data-scene-action="calibrate"]`).click();
  await expect.poll(async () => (await perspective(page)).referenceHeight?.heightPx).toBeCloseTo(start.rect.height, 1);
  const calibrated = await perspective(page);
  expect(calibrated.referenceHeight.feetY).toBeCloseTo(start.feet.y, 1);
  expect(calibrated.horizonY).toBeCloseTo(horizon, 5);
  await page.locator(`${shell} [title="Undo"]`).first().click();
  await expect.poll(() => perspective(page)).toEqual(beforeCalibration);
  await page.locator(`${shell} [title="Redo"]`).first().click();
  await expect.poll(() => perspective(page)).toEqual(calibrated);

  // Depth-scale on, move tool: drag the feet 200 px down.
  await page.locator(`${shell} [data-scene-depth-scale]`).click();
  await expect(page.locator(`${shell} [data-scene-depth-scale]`)).toHaveAttribute("aria-pressed", "true");
  await page.locator(`${shell} .vnccs-uc-tool[data-tool="move"]`).click();
  const original = await croppedPixels(page, figure.id);
  const target = { x: start.feet.x, y: start.feet.y + 200 };
  const expected = start.rect.height * (target.y - horizon) / (start.feet.y - horizon);
  const live = await drag(page, start.feet, target, { during: () => hook(page, "getDepthScaleDrag") });
  const heights = live.filter(Boolean).map((sample) => sample.height);
  expect(heights.length).toBeGreaterThan(5);
  expect(heights[Math.floor(heights.length / 2)]).toBeGreaterThan(start.rect.height + 5);
  expect(heights[Math.floor(heights.length / 2)]).toBeLessThan(expected - 5);
  const moved = await character(page, figure.id);
  expect(Math.abs(moved.rect.height - expected) / expected).toBeLessThanOrEqual(0.015);
  const world = await hook(page, "getView");
  const tolerance = 2 + 1 / world.scale;
  expect(Math.abs(moved.feet.x - target.x)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(moved.feet.y - target.y)).toBeLessThanOrEqual(tolerance);

  // Undo reverts the depth-scaled move as one entry; redo brings it back.
  await page.locator(`${shell} [title="Undo"]`).first().click();
  await expect.poll(async () => (await character(page, figure.id)).rect.height).toBeCloseTo(start.rect.height, 0);
  await page.locator(`${shell} [title="Redo"]`).first().click();
  await expect.poll(async () => (await character(page, figure.id)).rect.height).toBeCloseTo(moved.rect.height, 0);

  // Up / down / up: back at the start the pixels are the original ones.
  for (const [from, to] of [[target, start.feet], [start.feet, target], [target, start.feet]]) {
    const at = await character(page, figure.id);
    await drag(page, at.feet, to);
  }
  const back = await character(page, figure.id);
  expect(Math.abs(back.rect.height - start.rect.height)).toBeLessThanOrEqual(1);
  expect(meanDifference(await croppedPixels(page, figure.id), original)).toBeLessThan(2);

  // Estimate from background: a stubbed depth answer proposes a horizon; Accept applies it.
  await page.route("**/vnccs/unicanvas/depth", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ depth: "data:image/png;base64,", width: 8, height: 8, horizonY: 2 }),
  }));
  await page.keyboard.press("Escape");
  await page.locator(`${shell} .vnccs-uc-tool[data-tool="perspective"]`).click();
  await page.locator(`${shell} [data-scene-action="estimate"]`).click();
  const accept = page.locator(`${shell} [data-scene-action="accept"]`);
  await expect(accept).toBeVisible({ timeout: 15_000 });
  await accept.click();
  await expect.poll(async () => (await perspective(page)).horizonY).not.toBeCloseTo(horizon, 0);
});

// Plan 08.2 (#19): shadow layers and the scene light. Written for the CPU Docker lane; the
// shadows are drawn client-side, so nothing is stubbed.
const menu = `${shell} .vnccs-uc-layer-menu`;
const layerRow = (page, id) => page.locator(`${shell} [data-layer-id="${id}"]`).first();

/** Alpha-weighted centroid and mass of a layer's pixels (world coordinates). */
async function centroid(page, id) {
  const pixels = await hook(page, "getLayerPixels", id);
  const stack = await hook(page, "getCompositePixels");
  return page.evaluate(async ([dataURL, origin]) => {
    const image = new Image();
    image.src = dataURL;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const { data, width } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let sx = 0, sy = 0, mass = 0;
    for (let i = 0; i < data.length / 4; i += 1) {
      const alpha = data[i * 4 + 3];
      if (alpha <= 4) continue;
      sx += (i % width) * alpha; sy += Math.floor(i / width) * alpha; mass += alpha;
    }
    return mass ? { x: origin.x + sx / mass, y: origin.y + sy / mass, mass } : { x: null, y: null, mass: 0 };
  }, [pixels.dataURL, stack.origin]);
}

async function addShadow(page, sourceId, label) {
  return newLayerAfter(page, async () => {
    await layerRow(page, sourceId).click({ button: "right" });
    await expect(page.locator(menu)).toBeVisible();
    await page.locator(menu).getByRole("button", { name: label, exact: true }).click();
  });
}

async function setLight(page, key, value) {
  await page.locator(`${shell} [data-light-control="${key}"]`).fill(String(value));
}

test("shadow layers follow their character live, obey the light, detach, undo and persist", async ({ page }) => {
  await openUnicanvas(page);
  await newLayerAfter(page, () => importImageLayer(page, BACKDROP));
  const figure = await newLayerAfter(page, () => importImageLayer(page, CHARACTER));
  const start = await character(page, figure.id);

  // Add contact shadow: a new layer filed right under the character, a multiply shadow.
  const contact = await addShadow(page, figure.id, "Add contact shadow");
  expect(await hook(page, "getLayerShadow", contact.id)).toMatchObject({ sourceLayerId: figure.id, kind: "contact" });
  expect((await hook(page, "getLayerMeta", contact.id)).origin).toBe("shadow");
  const order = (await layers(page)).map((layer) => layer.id);
  expect(order.indexOf(contact.id)).toBe(order.indexOf(figure.id) + 1);
  const rest = await centroid(page, contact.id);
  expect(rest.mass).toBeGreaterThan(0);
  expect(Math.abs(rest.x - start.feet.x)).toBeLessThan(4);
  expect(Math.abs(rest.y - start.feet.y)).toBeLessThan(12);

  // Undo removes the added shadow; redo files it under the character again.
  await page.locator(`${shell} [title="Undo"]`).first().click();
  await expect.poll(async () => (await layers(page)).some((layer) => layer.id === contact.id)).toBe(false);
  await page.locator(`${shell} [title="Redo"]`).first().click();
  await expect.poll(async () => {
    const ids = (await layers(page)).map((layer) => layer.id);
    return ids.indexOf(contact.id) === ids.indexOf(figure.id) + 1;
  }).toBe(true);

  // The contact shadow follows a move-tool drag of the character before pointerup.
  await layerRow(page, figure.id).click();
  await page.locator(`${shell} .vnccs-uc-tool[data-tool="move"]`).click();
  const offset = { x: 120, y: 40 };
  const a = await client(page, start.feet);
  const b = await client(page, { x: start.feet.x + offset.x, y: start.feet.y + offset.y });
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) await page.mouse.move(a.x + (b.x - a.x) * i / 10, a.y + (b.y - a.y) * i / 10);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const during = await centroid(page, contact.id);
  expect(Math.abs(during.x - (rest.x + offset.x))).toBeLessThan(4);
  expect(Math.abs(during.y - (rest.y + offset.y))).toBeLessThan(4);
  await page.mouse.up();
  const moved = await character(page, figure.id);

  // Cast shadow: a light on the right throws it left of the feet, on the left to the right.
  const cast = await addShadow(page, figure.id, "Add cast shadow");
  await expect(page.locator(`${shell} [data-light-control="azimuth"]`)).toBeVisible();
  await setLight(page, "elevation", 35);
  await setLight(page, "azimuth", 90);
  await expect.poll(async () => (await hook(page, "getSceneLight")).azimuth).toBe(90);
  await expect.poll(async () => (await centroid(page, cast.id)).x - moved.feet.x).toBeLessThan(-10);
  await setLight(page, "azimuth", 270);
  await expect.poll(async () => (await centroid(page, cast.id)).x - moved.feet.x).toBeGreaterThan(10);

  // A light gesture on the sun handle is one undo entry.
  const lightBefore = await hook(page, "getSceneLight");
  const radius = Math.max(24, moved.rect.height * 0.6);
  const reach = radius * (0.12 + 0.88 * (1 - lightBefore.elevation / 90));
  const sun = {
    x: moved.feet.x + Math.sin(lightBefore.azimuth * Math.PI / 180) * reach,
    y: moved.feet.y + Math.cos(lightBefore.azimuth * Math.PI / 180) * reach * 0.35,
  };
  await drag(page, sun, { x: moved.feet.x, y: moved.feet.y + radius * 0.3 });
  await expect.poll(async () => (await hook(page, "getSceneLight")).azimuth).toBeLessThan(10);
  const lightAfter = await hook(page, "getSceneLight");
  await page.locator(`${shell} [title="Undo"]`).first().click();
  await expect.poll(() => hook(page, "getSceneLight")).toEqual(lightBefore);
  await page.locator(`${shell} [title="Redo"]`).first().click();
  await expect.poll(() => hook(page, "getSceneLight")).toEqual(lightAfter);

  // Shadows and the light survive a reload.
  await page.waitForTimeout(2500); // standalone persistence is debounced
  await page.reload({ waitUntil: "domcontentloaded" });
  await openUnicanvas(page, { navigate: false });
  await expect.poll(async () => (await layers(page)).some((layer) => layer.id === cast.id), { timeout: 30_000 }).toBe(true);
  expect(await hook(page, "getSceneLight")).toEqual(lightAfter);
  expect(await hook(page, "getLayerShadow", contact.id)).toMatchObject({ sourceLayerId: figure.id, kind: "contact" });
  expect(await hook(page, "getLayerShadow", cast.id)).toMatchObject({ sourceLayerId: figure.id, kind: "cast" });
  await expect.poll(async () => (await centroid(page, contact.id)).mass).toBeGreaterThan(0);

  // Detach leaves a plain raster layer with the same pixels.
  const pixelsBefore = await croppedPixels(page, cast.id);
  await layerRow(page, cast.id).click({ button: "right" });
  await page.locator(menu).getByRole("button", { name: "Detach shadow", exact: true }).click();
  await expect.poll(() => hook(page, "getLayerShadow", cast.id)).toBe(null);
  expect((await layers(page)).find((layer) => layer.id === cast.id).type).toBe("raster");
  expect(meanDifference(await croppedPixels(page, cast.id), pixelsBefore)).toBeLessThan(1);
});
// Plan 08.3 (#20): Harmonize panel and foreground occluder. No GPU: the draw and depth routes are
// stubbed, and the character gets a synthetic normal pass (a sphere) through the E2E hook.

async function selectEditFamily(page) {
  await page.locator(`${shell} [data-model-selection-mode="custom"]`).first().click();
  for (const [key, value] of [["model_loader", "diffusion_model"], ["generation_mode", "flux_klein"]]) {
    await page.evaluate(([setting, next]) => {
      const select = document.querySelector(`.vnccs-uc2-standalone-shell select[data-setting="${setting}"]`);
      select.value = next;
      select.dispatchEvent(new Event("input", { bubbles: true }));
    }, [key, value]);
  }
}

/**
 * A PNG data URL drawn in the page: a background color, then rectangles `[color, x, y, w, h]` in
 * 0..1 units of the image, or a sphere normal pass (the normal points left on the left half).
 */
async function pagePNG(page, width, height, { background = null, rects = [], sphere = false } = {}) {
  return page.evaluate(([w, h, fill, boxes, normals]) => {
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(0, 0, w, h); }
    for (const [color, x, y, bw, bh] of boxes) { ctx.fillStyle = color; ctx.fillRect(x * w, y * h, bw * w, bh * h); }
    if (normals) {
      const image = ctx.createImageData(w, h);
      for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
        const nx = (x + 0.5) / w * 2 - 1, nz = Math.sqrt(Math.max(0, 1 - nx * nx)), i = (y * w + x) * 4;
        image.data[i] = Math.round((nx * 0.5 + 0.5) * 255); image.data[i + 1] = 128;
        image.data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255); image.data[i + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
    }
    return canvas.toDataURL("image/png");
  }, [width, height, background, rects, sphere]);
}

/** Mean luminance of the opaque pixels in the left and right halves of a layer's alpha crop. */
async function halves(page, id) {
  const crop = await croppedPixels(page, id);
  let left = 0, right = 0, nl = 0, nr = 0;
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const i = (y * crop.width + x) * 4;
      if (crop.data[i + 3] < 200) continue;
      const lum = 0.2126 * crop.data[i] + 0.7152 * crop.data[i + 1] + 0.0722 * crop.data[i + 2];
      if (x < crop.width / 2) { left += lum; nl += 1; } else { right += lum; nr += 1; }
    }
  }
  return { left: left / Math.max(1, nl), right: right / Math.max(1, nr) };
}

async function openHarmonize(page, id) {
  await layerRow(page, id).click({ button: "right" });
  await page.locator(menu).getByRole("button", { name: "Harmonize...", exact: true }).click();
  await expect(page.locator(`${shell} [data-harmonize-panel="${id}"]`)).toBeVisible();
  return page.locator(`${shell} [data-harmonize-panel="${id}"]`);
}

test("harmonize relights live, cancels exactly, stages AI results, lifts an occluder and undoes each", async ({ page }) => {
  await openUnicanvas(page);
  await setLayerNaming(page, { autoFile: false });
  const backdrop = await newLayerAfter(page, () => importImageLayer(page, BACKDROP));
  const figure = await newLayerAfter(page, () => importImageLayer(page, CHARACTER));
  const start = await character(page, figure.id);
  const normals = await pagePNG(page, Math.round(start.rect.width), Math.round(start.rect.height), { sphere: true });
  expect(await hook(page, "setLayerNormalPass", figure.id, normals, start.rect)).toBe(true);
  const original = await croppedPixels(page, figure.id);
  const base = await halves(page, figure.id);

  // Relight: a light from the left brightens the left half more than the right while the
  // strength slider is still held.
  const panel = await openHarmonize(page, figure.id);
  await panel.locator('[data-harmonize-light="azimuth"]').fill("270");
  await panel.locator('[data-harmonize-light="elevation"]').fill("20");
  await panel.locator('[data-harmonize="relightStrength"]').fill("0");
  await panel.locator('[data-harmonize="relight"]').check();
  const slider = await panel.locator('[data-harmonize="relightStrength"]').boundingBox();
  await page.mouse.move(slider.x + 2, slider.y + slider.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(slider.x + 2 + (slider.width - 4) * i / 8, slider.y + slider.height / 2);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const during = await halves(page, figure.id);
  expect((await hook(page, "getHarmonize")).relight.on).toBe(true);
  expect(during.left - base.left).toBeGreaterThan(during.right - base.right + 5);
  await page.mouse.up();

  // Cancel restores the pixels exactly.
  await panel.locator('[data-harmonize-action="cancel"]').click();
  await expect(page.locator(`${shell} [data-harmonize-panel]`)).toHaveCount(0);
  expect(meanDifference(await croppedPixels(page, figure.id), original)).toBe(0);

  // Apply is one undo entry.
  const again = await openHarmonize(page, figure.id);
  await again.locator('[data-harmonize="relight"]').check();
  await again.locator('[data-harmonize-action="apply"]').click();
  const relit = await croppedPixels(page, figure.id);
  expect(meanDifference(relit, original)).toBeGreaterThan(1);
  await page.locator(`${shell} [title="Undo"]`).first().click();
  await expect.poll(async () => meanDifference(await croppedPixels(page, figure.id), original)).toBe(0);
  await page.locator(`${shell} [title="Redo"]`).first().click();
  await expect.poll(async () => meanDifference(await croppedPixels(page, figure.id), relit)).toBeLessThan(1);
  await page.locator(`${shell} [title="Undo"]`).first().click();

  // AI harmonize: a stubbed edit model answers twice, first with an opaque red image (staged,
  // silhouette kept), then with a transparent one whose box is far wider (rejected).
  await selectEditFamily(page);
  const red = await pagePNG(page, 64, 64, { background: "#ff0000" });
  const wide = await pagePNG(page, 64, 64, { rects: [["#00ff00", 0, 0, 1, 0.9]] });
  const answers = [red, wide];
  let drawCalls = 0;
  await page.route("**/vnccs/unicanvas/draw", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.mode).toBe("inpaint");
    expect(body.settings.positive).toMatch(/^Relight the character to match the scene lighting/);
    await route.fulfill({ json: { images: [answers[Math.min(drawCalls, answers.length - 1)]] } });
    drawCalls += 1;
  });
  const ai = await openHarmonize(page, figure.id);
  await ai.locator('[data-harmonize-action="ai"]').click();
  await expect.poll(async () => (await hook(page, "getStaging")).length).toBe(1);
  await page.locator(`${shell} [title="Accept as layer"]`).first().click();
  await expect.poll(async () => (await hook(page, "getStaging")).length).toBe(0);
  const harmonized = await croppedPixels(page, figure.id);
  expect(harmonized.width).toBe(original.width);
  expect(harmonized.height).toBe(original.height);
  const opaque = harmonized.data.findIndex((value, index) => index % 4 === 3 && value > 200);
  expect(harmonized.data[opaque - 3]).toBeGreaterThan(200); // red
  expect(harmonized.data[opaque - 2]).toBeLessThan(40);
  await page.locator(`${shell} [title="Undo"]`).first().click();
  await expect.poll(async () => meanDifference(await croppedPixels(page, figure.id), original)).toBe(0);
  const retry = await openHarmonize(page, figure.id);
  await retry.locator('[data-harmonize-action="ai"]').click();
  await expect.poll(() => drawCalls).toBe(2);
  await page.waitForTimeout(500);
  expect((await hook(page, "getStaging")).length).toBe(0);
  await retry.locator('[data-harmonize-action="cancel"]').click();

  // Occluder: the stubbed depth map is near (bright) over the lower-left part of the character
  // box and far elsewhere, so the occluder holds exactly those background pixels, above the figure.
  const back = await character(page, backdrop.id);
  const near = {
    x: start.rect.x, y: start.rect.y + start.rect.height * 0.5,
    width: start.rect.width * 0.4, height: start.rect.height * 0.3,
  };
  const depth = await pagePNG(page, Math.round(back.rect.width), Math.round(back.rect.height), {
    background: "rgb(77,77,77)",
    rects: [["#ffffff", (near.x - back.rect.x) / back.rect.width, (near.y - back.rect.y) / back.rect.height, near.width / back.rect.width, near.height / back.rect.height]],
  });
  await page.route("**/vnccs/unicanvas/depth", (route) => route.fulfill({ json: { depth, horizonY: null } }));
  const occluder = await newLayerAfter(page, async () => {
    await layerRow(page, figure.id).click({ button: "right" });
    await page.locator(menu).getByRole("button", { name: "Create foreground occluder", exact: true }).click();
  });
  expect((await hook(page, "getLayerMeta", occluder.id)).origin).toBe("occluder");
  expect(occluder.name).toMatch(/^Occluder - /);
  let ids = (await layers(page)).map((layer) => layer.id);
  expect(ids.indexOf(occluder.id)).toBe(ids.indexOf(figure.id) - 1);
  const lifted = await character(page, occluder.id);
  expect(Math.abs(lifted.rect.x - near.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(lifted.rect.y - near.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(lifted.rect.width - near.width)).toBeLessThanOrEqual(3);
  expect(Math.abs(lifted.rect.height - near.height)).toBeLessThanOrEqual(3);
  const occluderPixels = await croppedPixels(page, occluder.id);
  const background = await hook(page, "getLayerPixels", backdrop.id);
  const stack = await hook(page, "getCompositePixels");
  const matches = await page.evaluate(async ([occluderURL, backgroundURL, rect, origin]) => {
    const load = async (url) => { const image = new Image(); image.src = url; await image.decode(); return image; };
    const [a, b] = await Promise.all([load(occluderURL), load(backgroundURL)]);
    const read = (image) => {
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
      return ctx.getImageData(Math.round(rect.x - origin.x), Math.round(rect.y - origin.y), Math.round(rect.width), Math.round(rect.height)).data;
    };
    const pa = read(a), pb = read(b);
    let diff = 0, count = 0;
    for (let i = 0; i < pa.length; i += 4) {
      if (pa[i + 3] < 250) continue;
      diff += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
      count += 1;
    }
    return { mean: diff / Math.max(1, count * 3), count };
  }, [(await hook(page, "getLayerPixels", occluder.id)).dataURL, background.dataURL, lifted.rect, stack.origin]);
  expect(occluderPixels.width).toBeGreaterThan(0);
  expect(matches.count).toBeGreaterThan(0);
  expect(matches.mean).toBeLessThan(1);

  // Undo removes the occluder; redo files it right above the character again.
  await page.locator(`${shell} [title="Undo"]`).first().click();
  await expect.poll(async () => (await layers(page)).some((layer) => layer.id === occluder.id)).toBe(false);
  await page.locator(`${shell} [title="Redo"]`).first().click();
  await expect.poll(async () => {
    ids = (await layers(page)).map((layer) => layer.id);
    return ids.indexOf(occluder.id) === ids.indexOf(figure.id) - 1;
  }).toBe(true);
});
