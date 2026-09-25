import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { test, expect } from "@playwright/test";
import {
  addUniCanvasNode, camera, importPanorama, installPageHelpers, layers, openFullscreen, panoAlpha,
  root, rotate, selectLayer, selectTool, stroke,
} from "./helpers/panorama.mjs";

// 2048x1024 equirectangular fixture from issue #15, re-encoded (WebP q60) to keep the repo small.
const PANORAMA = fileURLToPath(new URL("./fixtures/panorama-2048x1024.webp", import.meta.url));
const SEAM_LEFT = { x: 0, y: 480, width: 64, height: 64 };
const SEAM_RIGHT = { x: 1984, y: 480, width: 64, height: 64 };

test.describe.configure({ timeout: 300_000 });

async function openPanorama(page) {
  await installPageHelpers(page);
  await addUniCanvasNode(page);
  await importPanorama(page, PANORAMA);
  const all = await layers(page);
  return { base: all.find((l) => l.type === "raster" && l.name === "Base Layer"), mask: all.find((l) => l.type === "mask") };
}

/** Turn to the left/right seam (yaw 180) through the sphere's keyboard control. */
async function faceSeam(page) {
  await rotate(page, "ArrowRight", 36);
  expect(Math.abs((await camera(page)).yaw)).toBe(180);
}

test("import as Panorama keeps the full 2048x1024 document behind a square editing view", async ({ page }) => {
  await openPanorama(page);
  const state = await page.evaluate(() => {
    const w = ucWidget();
    return { settings: w.panorama.settings, bbox: w.bbox,
      surfaces: w.layers.map((l) => [l.panoramaCanvas.width, l.panoramaCanvas.height]),
      baseLocked: w.layers.find((l) => l.id === w.panorama.settings.baseLayerId)?.locked };
  });
  expect(state.settings).toMatchObject({ projection: "equirectangular", width: 2048, height: 1024 });
  expect(state.bbox).toMatchObject({ width: 1024, height: 1024 });
  for (const surface of state.surfaces) expect(surface).toEqual([2048, 1024]);
  expect(state.baseLocked).toBe(true);
  // #28: the imported panorama is its own layer type with a settings panel.
  const panoramaLayer = (await layers(page)).find((l) => l.type === "panorama");
  expect(panoramaLayer?.id).toBe(state.settings.baseLayerId);
  expect((await layers(page)).filter((l) => l.type === "panorama")).toHaveLength(1);
  await expect(root(page).locator("[data-panorama-panel]")).toBeVisible();
  // The whole source survives: every pixel of the base surface is opaque.
  const baseId = await page.evaluate(() => ucWidget().panorama.settings.baseLayerId);
  expect(await panoAlpha(page, baseId, { x: 0, y: 0, width: 2048, height: 1024 })).toBe(2048 * 1024);
});

test("paint, erase, mask, move, undo and redo land on both sides of the seam", async ({ page }) => {
  const { base, mask } = await openPanorama(page);
  await faceSeam(page);
  await selectLayer(page, base.id);
  await selectTool(page, "brush");
  await stroke(page, [[0.4, 0.5], [0.6, 0.5]]);
  const painted = [await panoAlpha(page, base.id, SEAM_LEFT), await panoAlpha(page, base.id, SEAM_RIGHT)];
  expect(painted[0]).toBeGreaterThan(0);
  expect(painted[1]).toBeGreaterThan(0);

  await selectTool(page, "eraser");
  await stroke(page, [[0.45, 0.5], [0.55, 0.5]]);
  expect(await panoAlpha(page, base.id, SEAM_LEFT)).toBeLessThan(painted[0]);
  expect(await panoAlpha(page, base.id, SEAM_RIGHT)).toBeLessThan(painted[1]);
  await root(page).locator('button[title="Undo"]').click();
  expect(await panoAlpha(page, base.id, SEAM_LEFT)).toBe(painted[0]);
  expect(await panoAlpha(page, base.id, SEAM_RIGHT)).toBe(painted[1]);
  await root(page).locator('button[title="Redo"]').click();
  expect(await panoAlpha(page, base.id, SEAM_LEFT)).toBeLessThan(painted[0]);
  await root(page).locator('button[title="Undo"]').click();

  await selectTool(page, "move");
  await stroke(page, [[0.5, 0.5], [0.5, 0.6]]);
  expect(await panoAlpha(page, base.id, SEAM_LEFT)).toBe(0);
  expect(await panoAlpha(page, base.id, { x: 0, y: 540, width: 64, height: 120 })).toBeGreaterThan(0);
  expect(await panoAlpha(page, base.id, { x: 1984, y: 540, width: 64, height: 120 })).toBeGreaterThan(0);
  await root(page).locator('button[title="Undo"]').click();
  expect(await panoAlpha(page, base.id, SEAM_LEFT)).toBe(painted[0]);

  await selectLayer(page, mask.id);
  await selectTool(page, "mask");
  await stroke(page, [[0.4, 0.4], [0.6, 0.4]]);
  expect(await panoAlpha(page, mask.id, { x: 0, y: 380, width: 64, height: 80 })).toBeGreaterThan(0);
  expect(await panoAlpha(page, mask.id, { x: 1984, y: 380, width: 64, height: 80 })).toBeGreaterThan(0);

  // A full extra turn does not resample or move stored pixels.
  await rotate(page, "ArrowRight", 72);
  expect(await panoAlpha(page, base.id, SEAM_LEFT)).toBe(painted[0]);
  expect(await panoAlpha(page, base.id, SEAM_RIGHT)).toBe(painted[1]);
});

test("a saved workflow reopens with its spherical pixels and camera", async ({ page }) => {
  const { base } = await openPanorama(page);
  await faceSeam(page);
  await selectLayer(page, base.id);
  await selectTool(page, "brush");
  await stroke(page, [[0.4, 0.5], [0.6, 0.5]]);
  const savedCamera = await camera(page);
  const painted = [await panoAlpha(page, base.id, SEAM_LEFT), await panoAlpha(page, base.id, SEAM_RIGHT)];
  await page.evaluate(async () => { await ucWidget().flushStateUpload(); });
  const workflow = await page.evaluate(() => JSON.stringify(window.app.graph.serialize()));

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 60_000 });
  await page.evaluate(async (data) => { await window.app.loadGraphData(JSON.parse(data)); }, workflow);
  await openFullscreen(page);
  await expect.poll(() => page.evaluate(() => Boolean(ucWidget()?.panorama)), { timeout: 30_000 }).toBe(true);
  expect(await camera(page)).toEqual(savedCamera);
  expect(await panoAlpha(page, base.id, SEAM_LEFT)).toBe(painted[0]);
  expect(await panoAlpha(page, base.id, SEAM_RIGHT)).toBe(painted[1]);
});

test("the node IMAGE output saves the complete panorama as a 2048x1024 PNG", async ({ page }) => {
  await openPanorama(page);
  await rotate(page, "ArrowUp", 6); // a camera away from the default must not crop the output
  await page.evaluate(async () => { await ucWidget().flushStateUpload(); });
  const promptId = await page.evaluate(async () => {
    const save = window.LiteGraph.createNode("SaveImage");
    save.pos = [900, 40];
    window.app.graph.add(save);
    ucNode().connectByType(0, save, "IMAGE");
    const response = await window.app.queuePrompt(0, 1);
    return response?.prompt_id || response?.[0]?.prompt_id || null;
  });
  let image = null;
  await expect.poll(async () => {
    const history = await (await page.request.get(promptId ? `/history/${promptId}` : "/history")).json();
    for (const entry of Object.values(history)) {
      for (const output of Object.values(entry.outputs || {})) if (output.images?.length) image = output.images[0];
    }
    return Boolean(image);
  }, { timeout: 120_000 }).toBe(true);
  const png = await (await page.request.get(`/view?${new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" })}`)).body();
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([2048, 1024]);
});

test("PSD export keeps the full equirectangular size", async ({ page }) => {
  await openPanorama(page);
  await rotate(page, "ArrowRight", 9);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    root(page).getByRole("button", { name: "Export Layers as PSD" }).click(),
  ]);
  const psd = fs.readFileSync(await download.path());
  expect(psd.subarray(0, 4).toString()).toBe("8BPS");
  expect([psd.readUInt32BE(18), psd.readUInt32BE(14)]).toEqual([2048, 1024]);
});

test("a generation result stays at the camera captured for its request", async ({ page }) => {
  await openPanorama(page);
  const stub = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 1024;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(0, 0, 1024, 1024);
    return c.toDataURL("image/png").split(",")[1];
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let requested = false;
  await page.route("**/vnccs/unicanvas/draw", async (route) => {
    requested = true;
    await gate;
    await route.fulfill({ json: { images: [{ filename: "panorama_stub.png", type: "temp", subfolder: "" }] } });
  });
  await page.route(/\/view\?filename=panorama_stub\.png/, (route) =>
    route.fulfill({ contentType: "image/png", body: Buffer.from(stub, "base64") }));

  const requestCamera = await camera(page); // yaw 0: the result belongs around x = 1024
  await root(page).getByRole("button", { name: "GENERATE" }).click();
  await expect.poll(() => requested, { timeout: 20_000 }).toBe(true);
  await rotate(page, "ArrowRight", 18); // look elsewhere while the draw runs
  expect((await camera(page)).yaw).toBe(90);
  release();
  await expect.poll(() => page.evaluate(() => ucWidget().stagingItems.length), { timeout: 20_000 }).toBeGreaterThan(0);
  const staged = await page.evaluate(() => ucWidget().stagingItems[0].panoramaCamera);
  expect({ yaw: staged.yaw, pitch: staged.pitch, roll: staged.roll, fov: staged.fov }).toEqual(requestCamera);

  await page.evaluate(() => ucWidget().acceptStaging());
  const accepted = await page.evaluate(() => ucWidget().activeLayerId);
  // yaw 0 with a 90 degree FOV covers longitudes -45..45: x 768..1280 on the 2048-wide surface.
  expect(await panoAlpha(page, accepted, { x: 800, y: 500, width: 448, height: 24 })).toBeGreaterThan(0);
  expect(await panoAlpha(page, accepted, { x: 1400, y: 500, width: 300, height: 24 })).toBe(0);
});

test("the panorama layer settings panel moves the camera live and saves its settings on the layer", async ({ page }) => {
  await openPanorama(page);
  const panoramaId = (await layers(page)).find((l) => l.type === "panorama").id;
  await root(page).locator(`[data-layer-id="${panoramaId}"] button[title="Panorama settings"]`).click();
  const panel = root(page).locator("[data-panorama-panel]");
  await expect(panel.locator("details")).toHaveAttribute("open", "");
  // Realtime: the camera follows each input event, before the change (release) event.
  const yaw = panel.locator('input[type="range"][data-panorama-setting="yaw"]');
  await yaw.evaluate((input) => { input.value = "60"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await expect.poll(async () => (await camera(page)).yaw).toBe(60);
  await expect(panel.locator('input[type="number"][data-panorama-setting="yaw"]')).toHaveValue("60");
  await yaw.evaluate((input) => input.dispatchEvent(new Event("change", { bubbles: true })));
  await panel.locator('select[data-panorama-setting="quality"]').evaluate((select) => {
    select.value = "sharp"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const saved = await page.evaluate(() => ucWidget().buildSerializedState(false));
  expect(saved.version).toBe(4);
  expect(saved.panorama).toBeUndefined();
  const layer = saved.layers.find((l) => l.type === "panorama");
  expect(layer.panorama).toMatchObject({ projection: "equirectangular", width: 2048, height: 1024, yaw: 60, quality: "sharp" });
});

test("a version 3 panorama workflow opens as a panorama layer with its pixels and camera", async ({ page }) => {
  const { base } = await openPanorama(page);
  await faceSeam(page);
  await selectLayer(page, base.id);
  await selectTool(page, "brush");
  await stroke(page, [[0.4, 0.5], [0.6, 0.5]]);
  const savedCamera = await camera(page);
  const painted = [await panoAlpha(page, base.id, SEAM_LEFT), await panoAlpha(page, base.id, SEAM_RIGHT)];
  const panoramaId = await page.evaluate(() => ucWidget().panorama.settings.baseLayerId);
  const panoramaPixels = await panoAlpha(page, panoramaId, { x: 0, y: 0, width: 2048, height: 1024 });
  // Rewrite the saved document into the version 3 format (camera on the document, raster base).
  const workflow = await page.evaluate(async () => {
    const w = ucWidget();
    const state = w.buildSerializedState(true);
    const layer = state.layers.find((l) => l.type === "panorama");
    state.version = 3;
    state.panorama = { ...layer.panorama, baseLayerId: layer.id };
    delete state.panorama.quality;
    layer.type = "raster"; delete layer.panorama;
    state.state_id = `v3-${Date.now()}`;
    const graph = window.app.graph.serialize();
    const node = graph.nodes.find((n) => n.type === "VNCCS_UniCanvas");
    const index = node.widgets_values.findIndex((value) => typeof value === "string" && value.includes('"state_id"'));
    node.widgets_values[index] = JSON.stringify({ ...state, storage: "inline" });
    return JSON.stringify(graph);
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 60_000 });
  await page.evaluate(async (data) => { await window.app.loadGraphData(JSON.parse(data)); }, workflow);
  await openFullscreen(page);
  await expect.poll(() => page.evaluate(() => Boolean(ucWidget()?.panorama)), { timeout: 30_000 }).toBe(true);
  const migrated = (await layers(page)).find((l) => l.id === panoramaId);
  expect(migrated.type).toBe("panorama");
  expect(await camera(page)).toEqual(savedCamera);
  expect(await panoAlpha(page, panoramaId, { x: 0, y: 0, width: 2048, height: 1024 })).toBe(panoramaPixels);
  expect(await panoAlpha(page, base.id, SEAM_LEFT)).toBe(painted[0]);
  expect(await panoAlpha(page, base.id, SEAM_RIGHT)).toBe(painted[1]);
  expect((await page.evaluate(() => ucWidget().buildSerializedState(false))).version).toBe(4);
});
