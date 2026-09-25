import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { importImageLayer, openUnicanvas, setLayerNaming } from "./helpers/app.mjs";
import { measureAlphaBBoxInPage } from "./helpers/measure.mjs";

// Plan 05 (#8): nested layer groups, multi-selection and one-step group history.
const FIXTURE = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const FIXTURE_DATA_URL = `data:image/png;base64,${readFileSync(FIXTURE).toString("base64")}`;
const shell = ".vnccs-uc2-standalone-shell";
const STAGE = `${shell} canvas.vnccs-uc-stage`;

const hook = (page, name, ...args) => page.evaluate(([fn, rest]) => globalThis.__VNCCS_UC_E2E__[fn](...rest), [name, args]);
const stack = (page) => hook(page, "getLayerStack");
const composite = (page) => hook(page, "getCompositePixels");
const row = (page, id) => page.locator(`${shell} [data-layer-id="${id}"]`);

// Largest channel difference between two same-size PNG data URLs (computed in the page).
function pixelDiff(page, a, b, reference = null) {
  return page.evaluate(async ([first, second, ref]) => {
    const read = async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const left = await read(first);
    let right;
    if (ref) {
      // Reference for an isolated group: its children composited alone, drawn at the group's alpha.
      const layers = await Promise.all(ref.layers.map(async (url) => createImageBitmap(await (await fetch(url)).blob())));
      const scratch = new OffscreenCanvas(layers[0].width, layers[0].height);
      const sctx = scratch.getContext("2d");
      for (const bitmap of [...layers].reverse()) sctx.drawImage(bitmap, 0, 0);
      const out = new OffscreenCanvas(scratch.width, scratch.height);
      const octx = out.getContext("2d");
      octx.globalAlpha = ref.alpha;
      octx.drawImage(scratch, 0, 0);
      right = octx.getImageData(0, 0, out.width, out.height).data;
    } else right = await read(second);
    if (left.length !== right.length) return Infinity;
    let max = 0;
    for (let i = 0; i < left.length; i += 1) max = Math.max(max, Math.abs(left[i] - right[i]));
    return max;
  }, [a, b, reference]);
}

async function newLayerAfter(page, action) {
  const before = new Set((await stack(page)).layers.map((layer) => layer.id));
  await action();
  await expect.poll(async () => (await stack(page)).layers.filter((layer) => !before.has(layer.id)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  return (await stack(page)).layers.find((layer) => !before.has(layer.id));
}

async function undo(page, redo = false) {
  await page.locator(STAGE).first().focus();
  await page.keyboard.press(redo ? "Control+Shift+z" : "Control+z");
}

function depthOf(layers, layer) {
  let depth = 0;
  let parent = layers.find((item) => item.id === layer.groupId);
  while (parent) {
    depth += 1;
    parent = layers.find((item) => item.id === parent.groupId);
  }
  return depth;
}

// Rows at fixed thirds: dropping in the middle third of a folder files the layer inside it.
async function dropOn(page, sourceId, targetId, zone) {
  const target = row(page, targetId);
  const box = await target.boundingBox();
  const y = zone === "before" ? 3 : zone === "after" ? box.height - 3 : box.height / 2;
  await row(page, sourceId).dragTo(target, { targetPosition: { x: box.width / 2, y } });
}

test("layer groups: grouping, isolated opacity, visibility, drag in/out, group move, depth, history and reload", async ({ page }) => {
  await openUnicanvas(page);
  await setLayerNaming(page, { autoFile: false }); // this spec counts and places layers itself
  const base = (await stack(page)).layers.find((layer) => layer.type === "raster");

  // Two content layers: an imported image and a painted stroke across it.
  const imported = await newLayerAfter(page, () => importImageLayer(page, FIXTURE));
  const painted = await newLayerAfter(page, () => page.locator(`${shell} [title="Add raster"]`).first().click());
  await page.locator(`${shell} .vnccs-uc-tool[data-tool="brush"]`).click();
  const box = await page.locator(STAGE).first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.52, { steps: 10 });
  await page.mouse.up();
  const ungrouped = await composite(page);

  // Ctrl+click builds the selection; Ctrl+G groups it at the topmost selected position.
  await row(page, painted.id).click();
  await row(page, imported.id).click({ modifiers: ["Control"] });
  expect((await stack(page)).selectedLayerIds.sort()).toEqual([imported.id, painted.id].sort());
  await page.keyboard.press("Control+g");
  let state = await stack(page);
  const group = state.layers.find((layer) => layer.type === "group");
  expect(group).toBeTruthy();
  const order = state.layers.map((layer) => layer.id);
  expect(order.indexOf(group.id)).toBe(order.indexOf(painted.id) - 1);
  expect(order.indexOf(imported.id)).toBe(order.indexOf(painted.id) + 1);
  expect(state.layers.find((layer) => layer.id === painted.id).groupId).toBe(group.id);
  expect(state.layers.find((layer) => layer.id === imported.id).groupId).toBe(group.id);
  expect(state.layers.findIndex((layer) => layer.type !== "mask")).toBe(order.indexOf(group.id));
  await expect(row(page, group.id)).toHaveClass(/vnccs-uc-folder/);
  // Pass-through: the composite is pixel-identical to the ungrouped stack.
  expect(await pixelDiff(page, (await composite(page)).dataURL, ungrouped.dataURL)).toBe(0);

  // Group opacity 0.5 renders the group isolated: children composited alone, then at 50 %.
  await row(page, group.id).click();
  await page.locator(`${shell} [data-layer-control="opacity"]`).fill("0.5");
  expect((await stack(page)).layers.find((layer) => layer.id === group.id).opacity).toBe(0.5);
  const children = [painted.id, imported.id];
  const pixels = [];
  for (const id of children) pixels.push((await hook(page, "getLayerPixels", id)).dataURL);
  const halfComposite = await composite(page);
  expect(await pixelDiff(page, halfComposite.dataURL, null, { layers: pixels, alpha: 0.5 })).toBeLessThanOrEqual(1);
  await expect(row(page, group.id).locator(".vnccs-uc-folder-opacity")).toHaveText("50%");

  // Hiding the group hides every child in the export.
  await row(page, group.id).locator("[data-folder-eye]").click();
  expect((await measureAlphaBBoxInPage(page, (await composite(page)).dataURL)).area).toBe(0);
  await row(page, group.id).locator("[data-folder-eye]").click();
  expect(await pixelDiff(page, (await composite(page)).dataURL, halfComposite.dataURL)).toBe(0);

  // Drag inside a folder (middle third) and back out (top third of the folder row).
  const folder = await newLayerAfter(page, () => page.locator(`${shell} [title="New empty group"]`).first().click());
  expect(folder.type).toBe("group");
  await dropOn(page, base.id, folder.id, "inside");
  await expect.poll(async () => (await stack(page)).layers.find((layer) => layer.id === base.id).groupId).toBe(folder.id);
  await dropOn(page, base.id, folder.id, "before");
  await expect.poll(async () => (await stack(page)).layers.find((layer) => layer.id === base.id).groupId).toBe(null);

  // Moving the group moves every child together, as one undo step.
  const boundsOf = async (id) => measureAlphaBBoxInPage(page, (await hook(page, "getLayerPixels", id)).dataURL);
  const worldBounds = async (id) => {
    const origin = (await composite(page)).origin;
    const bounds = await boundsOf(id);
    return { x: bounds.minX + origin.x, y: bounds.minY + origin.y };
  };
  const startPainted = await worldBounds(painted.id);
  const startImported = await worldBounds(imported.id);
  await row(page, group.id).click();
  await page.locator(`${shell} .vnccs-uc-tool[data-tool="move"]`).click();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5 + 60, box.y + box.height * 0.5 + 40, { steps: 8 });
  await page.mouse.up();
  const movedPainted = await worldBounds(painted.id);
  const movedImported = await worldBounds(imported.id);
  const dx = movedPainted.x - startPainted.x;
  const dy = movedPainted.y - startPainted.y;
  expect(dx).toBeGreaterThan(0);
  expect(dy).toBeGreaterThan(0);
  expect(movedImported.x - startImported.x).toBe(dx);
  expect(movedImported.y - startImported.y).toBe(dy);
  await undo(page);
  expect(await worldBounds(painted.id)).toEqual(startPainted);
  expect(await worldBounds(imported.id)).toEqual(startImported);
  await undo(page, true);
  expect(await worldBounds(painted.id)).toEqual(movedPainted);

  // A historyGroup (duplicate group = several layer adds + structure) undoes and redoes as one.
  const beforeDuplicate = (await stack(page)).layers.length;
  await row(page, group.id).click();
  await page.locator(`${shell} [title="Duplicate selected"]`).first().click();
  expect((await stack(page)).layers.length).toBe(beforeDuplicate + 3);
  await undo(page);
  expect((await stack(page)).layers.length).toBe(beforeDuplicate);
  await undo(page, true);
  expect((await stack(page)).layers.length).toBe(beforeDuplicate + 3);
  await undo(page);

  // Depth 3 is allowed, a fourth level is refused.
  await row(page, folder.id).click();
  const level2 = await newLayerAfter(page, () => page.locator(`${shell} [title="New empty group"]`).first().click());
  await dropOn(page, level2.id, folder.id, "inside");
  await expect.poll(async () => (await stack(page)).layers.find((layer) => layer.id === level2.id).groupId).toBe(folder.id);
  const level3 = await newLayerAfter(page, () => page.locator(`${shell} [title="New empty group"]`).first().click());
  await dropOn(page, level3.id, level2.id, "inside");
  await expect.poll(async () => (await stack(page)).layers.find((layer) => layer.id === level3.id).groupId).toBe(level2.id);
  state = await stack(page);
  expect(depthOf(state.layers, state.layers.find((layer) => layer.id === level3.id))).toBe(2); // three nested folders
  await row(page, base.id).click();
  const loose = await newLayerAfter(page, () => page.locator(`${shell} [title="New empty group"]`).first().click());
  await dropOn(page, loose.id, level3.id, "inside");
  state = await stack(page);
  expect(state.layers.find((layer) => layer.id === loose.id).groupId).toBe(null);
  expect(Math.max(...state.layers.filter((layer) => layer.type === "group").map((layer) => depthOf(state.layers, layer)))).toBe(2);
  await dropOn(page, base.id, level3.id, "inside"); // a layer inside the third level is fine
  await expect.poll(async () => (await stack(page)).layers.find((layer) => layer.id === base.id).groupId).toBe(level3.id);

  // The structure survives a reload.
  const saved = (await stack(page)).layers.map(({ id, type, groupId, opacity, visible }) => ({ id, type, groupId, opacity, visible }));
  await page.waitForTimeout(2500); // standalone persistence is debounced
  await page.reload({ waitUntil: "domcontentloaded" });
  await openUnicanvas(page, { navigate: false });
  await expect.poll(async () => (await stack(page)).layers.length, { timeout: 30_000 }).toBe(saved.length);
  expect((await stack(page)).layers.map(({ id, type, groupId, opacity, visible }) => ({ id, type, groupId, opacity, visible }))).toEqual(saved);
  await expect(row(page, group.id)).toHaveClass(/vnccs-uc-folder/);
});

test("layer groups: a legacy state without groups loads unchanged", async ({ page }) => {
  const legacy = {
    version: 2,
    storage: "local",
    origin: { x: 0, y: 0 },
    size: { width: 1024, height: 1024 },
    bbox: { x: 0, y: 0, width: 1024, height: 1024 },
    activeLayerId: "legacy-top",
    layers: [
      { id: "legacy-mask", name: "Inpaint Mask", type: "mask", visible: true, locked: false, opacity: 1, blendMode: "source-over", crop: null, dataURL: null },
      { id: "legacy-top", name: "Top", type: "raster", visible: true, locked: false, opacity: 1, blendMode: "source-over", crop: { x: 100, y: 100, width: 512, height: 512 }, dataURL: FIXTURE_DATA_URL },
      { id: "legacy-base", name: "Base", type: "raster", visible: true, locked: false, opacity: 0.8, blendMode: "multiply", crop: { x: 0, y: 0, width: 512, height: 512 }, dataURL: FIXTURE_DATA_URL },
    ],
  };
  await page.addInitScript((value) => {
    if (!sessionStorage.getItem("vnccs-groups-legacy-seeded")) {
      localStorage.setItem("vnccs-unicanvas-standalone", JSON.stringify({ saved_at: Date.now(), state: value }));
      sessionStorage.setItem("vnccs-groups-legacy-seeded", "1");
    }
  }, legacy);
  await openUnicanvas(page);
  await expect.poll(async () => (await stack(page)).layers.map((layer) => layer.id), { timeout: 30_000 })
    .toEqual(["legacy-mask", "legacy-top", "legacy-base"]);
  const state = await stack(page);
  expect(state.layers.some((layer) => layer.type === "group")).toBe(false);
  expect(state.layers.every((layer) => layer.groupId === null)).toBe(true);
  expect(state.layers[2]).toMatchObject({ opacity: 0.8, blendMode: "multiply" });
  await expect(page.locator(`${shell} .vnccs-uc-folder`)).toHaveCount(0);
});
