import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { importImageLayer, openUnicanvas } from "./helpers/app.mjs";

// Plan 04 (#7): scene states. A background plus two raster "characters"; state A shows both,
// state B hides one and offsets the other by 200 px. No GPU: save_output is stubbed.
const FIXTURE = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const shell = ".vnccs-uc2-standalone-shell";
const STAGE = `${shell} canvas.vnccs-uc-stage`;
const STATES = `${shell} [data-scene-states]`;

const hook = (page, name, ...args) => page.evaluate(([fn, rest]) => globalThis.__VNCCS_UC_E2E__[fn](...rest), [name, args]);
const stack = (page) => hook(page, "getLayerStack");
const scene = (page) => hook(page, "getSceneStates");
const composite = async (page) => (await hook(page, "getCompositePixels")).dataURL;
const layerRow = (page, id) => page.locator(`${shell} [data-layer-id="${id}"]`);
const stateRow = (page, id) => page.locator(`${STATES} [data-state-id="${id}"]`);
const stateAction = (page, action) => page.locator(`${STATES} [data-state-action="${action}"]`).first();

// Largest channel difference between two same-size PNG data URLs (computed in the page).
function pixelDiff(page, a, b) {
  return page.evaluate(async ([first, second]) => {
    const read = async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const left = await read(first);
    const right = await read(second);
    if (left.length !== right.length) return Infinity;
    let max = 0;
    for (let i = 0; i < left.length; i += 1) max = Math.max(max, Math.abs(left[i] - right[i]));
    return max;
  }, [a, b]);
}

async function newLayerAfter(page, action) {
  const before = new Set((await stack(page)).layers.map((layer) => layer.id));
  await action();
  await expect.poll(async () => (await stack(page)).layers.filter((layer) => !before.has(layer.id)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  return (await stack(page)).layers.find((layer) => !before.has(layer.id));
}

// A filled rectangle on the active layer with the rect tool, in stage fractions.
async function drawRect(page, x0, y0, x1, y1) {
  await page.locator(`${shell} .vnccs-uc-tool[data-tool="rect"]`).click();
  const box = await page.locator(STAGE).first().boundingBox();
  await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1, { steps: 6 });
  await page.mouse.up();
}

async function newState(page) {
  const before = new Set(((await scene(page))?.states || []).map((state) => state.id));
  await stateAction(page, "new").click();
  await expect.poll(async () => ((await scene(page))?.states || []).filter((state) => !before.has(state.id)).length).toBe(1);
  return (await scene(page)).states.find((state) => !before.has(state.id));
}

async function undo(page) {
  await page.locator(STAGE).first().focus();
  await page.keyboard.press("Control+z");
}

test("scene states: capture, apply exactly, move in one state, delete, undo, reload and export", async ({ page }) => {
  await openUnicanvas(page);
  const background = await newLayerAfter(page, () => importImageLayer(page, FIXTURE));
  const anna = await newLayerAfter(page, () => page.locator(`${shell} [title="Add raster"]`).first().click());
  await drawRect(page, 0.30, 0.40, 0.40, 0.70);
  const ben = await newLayerAfter(page, () => page.locator(`${shell} [title="Add raster"]`).first().click());
  await drawRect(page, 0.60, 0.40, 0.70, 0.70);

  // State A: both characters visible.
  const a = await newState(page);
  const compositeA = await composite(page);

  // State B: Ben hidden, Anna offset by 200 px with "Move affects: this state".
  const b = await newState(page);
  expect((await scene(page)).moveScope).toBe("state");
  await layerRow(page, ben.id).locator(".vnccs-uc-thumb").click();
  await layerRow(page, anna.id).click();
  await page.locator(`${shell} .vnccs-uc-tool[data-tool="move"]`).click();
  const { view } = await scene(page);
  const box = await page.locator(STAGE).first().boundingBox();
  const start = { x: box.x + box.width * 0.35, y: box.y + box.height * 0.55 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 200 * view.scale, start.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await scene(page)).offsets[anna.id].x).toBeGreaterThan(190);
  await stateAction(page, "update").click();
  const offsetB = (await scene(page)).offsets[anna.id];
  const compositeB = await composite(page);
  expect(await pixelDiff(page, compositeA, compositeB)).toBeGreaterThan(0);

  // The pixels never moved: A still shows Anna at her stored position.
  const saved = await scene(page);
  expect(saved.states.find((state) => state.id === a.id).layers[anna.id].offset).toEqual({ x: 0, y: 0 });
  expect(saved.states.find((state) => state.id === b.id).layers[anna.id].offset).toEqual(offsetB);
  expect(saved.states.find((state) => state.id === b.id).layers[ben.id].visible).toBe(false);

  // Applying A, B, A reproduces the captured composites exactly.
  for (const [id, expected] of [[a.id, compositeA], [b.id, compositeB], [a.id, compositeA]]) {
    await stateRow(page, id).click();
    await expect.poll(async () => pixelDiff(page, await composite(page), expected)).toBe(0);
  }

  // Undoing an apply restores the previous properties (B's).
  await undo(page);
  await expect.poll(async () => pixelDiff(page, await composite(page), compositeB)).toBe(0);
  expect((await scene(page)).activeStateId).toBe(b.id);

  // Alt+1 applies the first state.
  await page.locator(STAGE).first().focus();
  await page.keyboard.press("Alt+1");
  await expect.poll(async () => (await scene(page)).activeStateId).toBe(a.id);

  // States survive a reload.
  await page.waitForTimeout(2500); // standalone persistence is debounced
  await page.reload({ waitUntil: "domcontentloaded" });
  await openUnicanvas(page, { navigate: false });
  await expect.poll(async () => (await scene(page))?.states?.length ?? 0, { timeout: 30_000 }).toBe(2);
  await stateRow(page, b.id).click();
  await expect.poll(async () => pixelDiff(page, await composite(page), compositeB), { timeout: 15_000 }).toBe(0);

  // Deleting a layer the states reference drops its key without an error.
  const errors = [];
  page.on("pageerror", (err) => errors.push(err));
  await layerRow(page, ben.id).locator('[title="Delete layer"]').click();
  await expect.poll(async () => (await scene(page)).states.every((state) => !(ben.id in state.layers))).toBe(true);
  await stateRow(page, a.id).click();
  expect(errors).toEqual([]);
  expect(background.id).toBeTruthy();

  // Export writes one PNG per state through save_output, into output/<scene>/.
  const requests = [];
  await page.route("**/vnccs/unicanvas/save_output", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    await route.fulfill({ json: { ok: true, path: `output/${body.subfolder}/${body.name}.png`, width: 64, height: 64 } });
  });
  await stateAction(page, "export").click();
  await page.locator(`${shell} .vnccs-uc-states-export [data-states-export-folder]`).fill("Scene 1");
  await page.locator(`${shell} [data-states-export-confirm]`).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests.map((request) => request.subfolder)).toEqual(["Scene 1", "Scene 1"]);
  expect(requests.map((request) => request.name)).toEqual((await scene(page)).states.map((state) => state.name));
  expect(requests.every((request) => request.image.startsWith("data:image/png;base64,"))).toBe(true);
});
