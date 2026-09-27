import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { installPageHelpers, openFullscreen } from "./helpers/panorama.mjs";

// Issue #33: workflows saved before the panorama layer type (#28) still open in the node. Before
// #28 a flat document was saved as version 2 and a panorama document as version 3 with the camera
// on the document; both are written here by hand in that format (not by today's serializer) and
// loaded through ComfyUI's loadGraphData. Layers, pixels, camera and settings must survive.
const BACKDROP = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const PANORAMA = fileURLToPath(new URL("./fixtures/panorama-2048x1024.webp", import.meta.url));
const dataUrl = (file, type) => `data:${type};base64,${readFileSync(file).toString("base64")}`;

test.describe.configure({ timeout: 240_000 });

const SETTINGS = { positive: "a lighthouse at dusk", negative: "blurry", steps: 13, cfg: 5.5, seed: 4242, denoise: 0.55 };

/** Load a workflow holding one UniCanvas node whose `unicanvas_state` is `state`. */
async function loadWorkflowWithState(page, state) {
  await installPageHelpers(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 60_000 });
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
  await page.evaluate(async (saved) => {
    const { app, LiteGraph } = window;
    app.graph.clear();
    const node = LiteGraph.createNode("VNCCS_UniCanvas");
    node.pos = [40, 40];
    app.graph.add(node);
    const index = node.widgets.findIndex((widget) => widget.name === "unicanvas_state");
    const graph = app.graph.serialize();
    graph.nodes.find((item) => item.type === "VNCCS_UniCanvas").widgets_values[index] = JSON.stringify(saved);
    await app.loadGraphData(graph);
  }, state);
  await openFullscreen(page);
  await expect.poll(() => page.evaluate(() => ucWidget()?.layers?.length ?? 0), { timeout: 30_000 }).toBe(state.layers.length);
}

const layerSummary = (page) => page.evaluate(() => ucWidget().layers.map((layer) => ({
  id: layer.id, name: layer.name, type: layer.type, groupId: layer.groupId || null,
  opacity: layer.opacity, blendMode: layer.blendMode || "source-over", visible: layer.visible,
})));

test("a flat version 2 workflow from before #28 keeps layers, pixels, groups and settings", async ({ page }) => {
  const state = {
    version: 2, storage: "inline", state_id: `pre28-flat-${Date.now()}`,
    origin: { x: -128, y: -128 }, size: { width: 1280, height: 1280 }, bbox: { x: 0, y: 0, width: 1024, height: 768 },
    settings: SETTINGS, activeLayerId: "art",
    layers: [
      { id: "mask", name: "Inpaint Mask", type: "mask", visible: true, opacity: 1, crop: null, dataURL: null },
      { id: "folder", name: "Scenery", type: "group", visible: true, opacity: 1, collapsed: false },
      { id: "art", name: "Backdrop", type: "raster", groupId: "folder", visible: true, opacity: 0.7, blendMode: "multiply",
        crop: { x: 100, y: 50, width: 512, height: 512 }, dataURL: dataUrl(BACKDROP, "image/png") },
      { id: "base", name: "Base Layer", type: "raster", visible: false, opacity: 1, crop: null, dataURL: null },
    ],
  };
  await loadWorkflowWithState(page, state);

  expect(await layerSummary(page)).toEqual([
    { id: "mask", name: "Inpaint Mask", type: "mask", groupId: null, opacity: 1, blendMode: "source-over", visible: true },
    { id: "folder", name: "Scenery", type: "group", groupId: null, opacity: 1, blendMode: "pass-through", visible: true },
    { id: "art", name: "Backdrop", type: "raster", groupId: "folder", opacity: 0.7, blendMode: "multiply", visible: true },
    { id: "base", name: "Base Layer", type: "raster", groupId: null, opacity: 1, blendMode: "source-over", visible: false },
  ]);
  const doc = await page.evaluate(() => {
    const w = ucWidget();
    const art = w.layers.find((layer) => layer.id === "art");
    return { origin: w.origin, size: w.size, bbox: w.bbox, settings: w.settings,
      artAlpha: ucAlpha(art.canvas, { x: 0, y: 0, width: art.canvas.width, height: art.canvas.height }),
      artBounds: w.getLayerAlphaBounds(art) };
  });
  expect(doc.origin).toEqual(state.origin);
  expect(doc.size).toEqual(state.size);
  expect(doc.bbox).toEqual(state.bbox);
  expect(doc.settings).toMatchObject(SETTINGS);
  // The whole opaque image, at its crop (the saved alpha bounds, in layer-canvas pixels).
  expect(doc.artAlpha).toBe(512 * 512);
  expect(doc.artBounds).toEqual(state.layers[2].crop);

  // Saving again writes the current flat format with the same settings.
  const saved = await page.evaluate(() => ucWidget().buildSerializedState(false));
  expect(saved.version).toBe(2);
  expect(saved.panorama).toBeUndefined();
  expect(saved.settings).toMatchObject(SETTINGS);
});

test("a version 3 panorama workflow from before #28 opens with its camera, layers and settings", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // The panorama pixels as a PNG data URL, as version 3 stored them.
  const base = await page.evaluate(async (src) => {
    const bitmap = await createImageBitmap(await (await fetch(src)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
  }, dataUrl(PANORAMA, "image/webp"));
  const camera = { yaw: 30, pitch: 10, roll: 0, fov: 80 };
  const state = {
    version: 3, storage: "inline", state_id: `pre28-pano-${Date.now()}`,
    origin: { x: 0, y: 0 }, size: { width: 1024, height: 1024 }, bbox: { x: 0, y: 0, width: 1024, height: 1024 },
    panorama: { projection: "equirectangular", width: 2048, height: 1024, baseLayerId: "sky", contentRevision: 3, ...camera },
    settings: SETTINGS, activeLayerId: "paint",
    layers: [
      // Version 3 wrote every layer of a panorama document at full size, an empty mask included.
      { id: "mask", name: "Inpaint Mask", type: "mask", visible: true, opacity: 1, crop: { x: 0, y: 0, width: 2048, height: 1024 },
        dataURL: await page.evaluate(() => Object.assign(document.createElement("canvas"), { width: 2048, height: 1024 }).toDataURL("image/png")) },
      { id: "paint", name: "Paint", type: "raster", visible: true, opacity: 0.8, crop: { x: 0, y: 0, width: 2048, height: 1024 },
        dataURL: await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 2048; canvas.height = 1024;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ff0000";
          ctx.fillRect(1000, 400, 100, 50);
          return canvas.toDataURL("image/png");
        }) },
      { id: "sky", name: "Sky", type: "raster", visible: true, opacity: 1, locked: true, crop: { x: 0, y: 0, width: 2048, height: 1024 }, dataURL: base },
    ],
  };
  await loadWorkflowWithState(page, state);
  await expect.poll(() => page.evaluate(() => Boolean(ucWidget()?.panorama)), { timeout: 30_000 }).toBe(true);

  const doc = await page.evaluate(() => {
    const w = ucWidget();
    const layer = (id) => w.layers.find((item) => item.id === id);
    const full = { x: 0, y: 0, width: 2048, height: 1024 };
    return {
      layers: w.layers.map((item) => [item.id, item.type, item.name]),
      settings: w.settings, panorama: w.panorama.settings, locked: layer("sky").locked, opacity: layer("paint").opacity,
      sky: ucAlpha(layer("sky").panoramaCanvas, full),
      paint: ucAlpha(layer("paint").panoramaCanvas, full),
      paintAt: ucAlpha(layer("paint").panoramaCanvas, { x: 1000, y: 400, width: 100, height: 50 }),
    };
  });
  expect(doc.layers).toEqual([["mask", "mask", "Inpaint Mask"], ["paint", "raster", "Paint"], ["sky", "panorama", "Sky"]]);
  expect(doc.panorama).toMatchObject({ projection: "equirectangular", width: 2048, height: 1024, baseLayerId: "sky", ...camera });
  expect(doc.settings).toMatchObject(SETTINGS);
  expect(doc.locked).toBe(true);
  expect(doc.opacity).toBe(0.8);
  expect(doc.sky).toBe(2048 * 1024);
  expect(doc.paint).toBe(100 * 50);
  expect(doc.paintAt).toBe(100 * 50);

  const saved = await page.evaluate(() => ucWidget().buildSerializedState(false));
  expect(saved.version).toBe(4);
  expect(saved.panorama).toBeUndefined();
  expect(saved.layers.find((item) => item.id === "sky").panorama).toMatchObject(camera);
  expect(saved.settings).toMatchObject(SETTINGS);
});
