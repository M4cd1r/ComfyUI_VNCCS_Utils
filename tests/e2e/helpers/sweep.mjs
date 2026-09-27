import { expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clickOutsidePopovers, openUnicanvas } from "./app.mjs";
import { pngDataURL, rgbaPng } from "./png.mjs";

const BACKDROP = `data:image/png;base64,${readFileSync(fileURLToPath(new URL("../fixtures/backdrop.png", import.meta.url))).toString("base64")}`;
/** Left half opaque, right half clear: a Remove background / SAM answer with a visible effect. */
export const HALF_ALPHA = pngDataURL(rgbaPng(16, 16, (x) => [255, 255, 255, x < 8 ? 255 : 0]));

/**
 * Stubs every UniCanvas route that would run a model (nothing downloads, no GPU): draw, remove
 * background, segment (SAM), depth, layer naming, ControlNet preprocessing and preset downloads.
 * Each request body is logged under its route name. Real CPU routes (assets, projects, library,
 * color match, save output is stubbed so nothing lands in output/) stay live.
 */
export async function stubInference(page) {
  const log = { draw: [], remove_bg: [], segment: [], depth: [], describe_layers: [], control_preprocess: [], download: [], save_output: [] };
  const json = (route, body) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  const body = (route) => { try { return route.request().postDataJSON(); } catch (_) { return null; } };
  await page.route("**/vnccs/unicanvas/draw", (route) => { log.draw.push(body(route)); return json(route, { images: [BACKDROP], performance: "stub" }); });
  await page.route("**/vnccs/unicanvas/remove_bg", (route) => { log.remove_bg.push(body(route)); return json(route, { alpha: HALF_ALPHA, width: 16, height: 16, method: "birefnet", edit_model: null }); });
  await page.route("**/vnccs/unicanvas/segment", (route) => { log.segment.push(body(route)); return json(route, { mask: HALF_ALPHA }); });
  await page.route("**/vnccs/unicanvas/depth", (route) => { log.depth.push(body(route)); return json(route, { depth: BACKDROP, width: 512, height: 512, horizonY: 180 }); });
  await page.route("**/vnccs/unicanvas/describe_layers", (route) => {
    const request = body(route) || {};
    log.describe_layers.push(request);
    return json(route, {
      names: (request.layers || []).map((item) => ({ id: item.id, name: `Named ${String(item.id).slice(-4)}`, category: "prop" })),
      groups: (request.groups || []).map((item) => ({ id: item.id, name: null })),
      model: request.model,
    });
  });
  await page.route("**/vnccs/unicanvas/control_preprocess", (route) => { log.control_preprocess.push(body(route)); return json(route, { image: BACKDROP }); });
  await page.route("**/vnccs/unicanvas/presets/download", (route) => { log.download.push(body(route)); return json(route, { queued: [] }); });
  await page.route("**/vnccs/unicanvas/save_output**", (route) => {
    log.save_output.push({ url: route.request().url(), body: body(route) });
    return json(route, { ok: true, path: "output/unicanvas_sweep.png", filename: "unicanvas_sweep.png", width: 64, height: 64 });
  });
  return log;
}

// Control sweep (issue #33) helpers: one surface object for the standalone tab and for a workflow
// node in fullscreen, so the same area checks run on both. State is read through the read-only
// E2E hook (createUniCanvasE2EHook in web/vnccs_unicanvas_modes.mjs); every change goes through
// the real UI.

const MODES_URL = "/extensions/ComfyUI_VNCCS_Utils/vnccs_unicanvas_modes.mjs";

/**
 * Fail on any page error or console error raised while the widget is in use. Collection starts
 * when this is called, after the ComfyUI page has loaded (ComfyUI's own start-up requests are not
 * UniCanvas controls).
 */
export function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location()?.url || "";
    // ComfyUI core's own start-up fetches (user.css, templates, release notes, the missing-model
    // metadata HEAD requests of its default workflow) are not UniCanvas controls. Every other
    // console error, and a failed load of a UniCanvas route or file, fails the sweep.
    if (/^Failed to load resource/.test(message.text()) && !/\/vnccs\/|ComfyUI_VNCCS_Utils/.test(url)) return;
    errors.push(`console.error: ${message.text()} @ ${url}`);
  });
  return {
    errors,
    clear: () => { errors.length = 0; },
    expectNone: (label = "") => expect(errors, `page / console errors ${label}`).toEqual([]),
  };
}

async function publishHook(page, source) {
  await page.evaluate(async ([url, from]) => {
    if (from === "standalone") { window.__ucHook = globalThis.__VNCCS_UC_E2E__; return; }
    const { createUniCanvasE2EHook } = await import(url);
    const node = window.app.graph._nodes.find((item) => item.type === "VNCCS_UniCanvas");
    window.__ucHook = createUniCanvasE2EHook(node.uniCanvasWidget);
  }, [MODES_URL, source]);
}

/** The standalone Unicanvas tab. */
export async function openStandaloneSurface(page) {
  const routes = await stubInference(page);
  await openUnicanvas(page);
  await publishHook(page, "standalone");
  const watch = watchErrors(page);
  return makeSurface(page, "standalone", page.locator(".vnccs-uc2-standalone-shell .vnccs-unicanvas"), watch, routes);
}

/** A fresh workflow with one UniCanvas node, opened in fullscreen. */
export async function openNodeSurface(page) {
  const routes = await stubInference(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 60_000 });
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
  await page.evaluate(() => {
    window.app.graph.clear();
    const node = window.LiteGraph.createNode("VNCCS_UniCanvas");
    node.pos = [40, 40];
    window.app.graph.add(node);
  });
  await expect.poll(() => page.evaluate(() => Boolean(window.app.graph._nodes.find((n) => n.type === "VNCCS_UniCanvas")?.uniCanvasWidget?._vnccsFullscreenButton)), { timeout: 30_000 }).toBe(true);
  await page.evaluate(() => window.app.graph._nodes.find((n) => n.type === "VNCCS_UniCanvas").uniCanvasWidget._vnccsFullscreenButton.click());
  await expect(page.locator(".vnccs-uc2-fullscreen-portal")).toBeVisible();
  const root = page.locator(".vnccs-uc2-fullscreen-portal .vnccs-unicanvas");
  await expect(root.locator(".vnccs-uc-left")).toBeVisible({ timeout: 30_000 });
  await publishHook(page, "node");
  const watch = watchErrors(page);
  return makeSurface(page, "node", root, watch, routes);
}

function makeSurface(page, kind, root, watch, routes) {
  const hook = (name, ...args) => page.evaluate(([fn, rest]) => window.__ucHook[fn](...rest), [name, args]);
  const surface = {
    kind, page, root, watch, hook, routes,
    stack: () => hook("getLayerStack"),
    depth: () => hook("getHistoryDepth"),
    settings: () => hook("getSettings"),
    tool: () => hook("getActiveTool"),
    status: () => hook("getStatusText"),
    layers: () => hook("listLayers"),
    activeLayer: async () => { const s = await hook("getLayerStack"); return s.layers.find((l) => l.id === s.activeLayerId) || null; },
    alpha: (id) => hook("getLayerAlphaCount", id),
    row: (id) => root.locator(`[data-layer-id="${id}"]`),
    button: (title) => root.locator(`button[title="${title}"]`).first(),
    stage: () => root.locator("canvas.vnccs-uc-stage").first(),
    async selectTool(tool) {
      await root.locator(`.vnccs-uc-tool[data-tool="${tool}"]`).first().click();
      await expect.poll(() => hook("getActiveTool")).toBe(tool);
    },
    /** Client point of a (0..1, 0..1) point inside the generation bbox. */
    async bboxPoint(u, v) {
      const bbox = await hook("getBbox");
      return hook("worldToClient", bbox.x + u * bbox.width, bbox.y + v * bbox.height);
    },
    /** A pointer drag through bbox-relative points; `during` runs before the button is released. */
    async drag(points, { during = null, steps = 6 } = {}) {
      const client = [];
      for (const [u, v] of points) client.push(await surface.bboxPoint(u, v));
      await page.mouse.move(client[0].x, client[0].y);
      await page.mouse.down();
      for (const p of client.slice(1)) await page.mouse.move(p.x, p.y, { steps });
      const seen = during ? await during() : null;
      await page.mouse.up();
      return seen;
    },
    /** Choose `value` in a select through its custom dropdown menu (a click on the option row). */
    async pick(select, value) {
      await select.scrollIntoViewIfNeeded();
      const label = await select.evaluate((el, v) => [...el.options].find((o) => o.value === v)?.label?.trim() ?? null, value);
      expect(label, `option ${value} exists`).not.toBeNull();
      await select.click();
      const menu = page.locator(".vnccs-custom-select-menu:visible").last();
      await expect(menu).toBeVisible();
      await menu.locator('[role="option"]', { hasText: label }).first().click();
      await expect(menu).toBeHidden();
      await expect.poll(() => select.inputValue()).toBe(value);
    },
    async undo() { await surface.button("Undo").click(); },
    async redo() { await surface.button("Redo").click(); },
    /** Undo then redo one mutating action: `read` must return to `before`, then to `after`. */
    async expectUndoRedo(read, before, after) {
      await surface.undo();
      await expect.poll(read).toEqual(before);
      await surface.redo();
      await expect.poll(read).toEqual(after);
    },
    async newLayerAfter(action) {
      const known = new Set((await surface.layers()).map((l) => l.id));
      await action();
      await expect.poll(async () => (await surface.layers()).some((l) => !known.has(l.id)), { timeout: 20_000 }).toBe(true);
      return (await surface.layers()).find((l) => !known.has(l.id));
    },
    async addRaster() {
      return surface.newLayerAfter(() => root.locator(".vnccs-uc-section-actions [title=\"Add raster\"]").click());
    },
    async importImage(file) {
      return surface.newLayerAfter(async () => {
        const [chooser] = await Promise.all([page.waitForEvent("filechooser"), root.locator('button[title="Import image"]').first().click()]);
        await chooser.setFiles(file);
      });
    },
    /** The widget's own modal (confirm / prompt): optionally type `value`, then press `button`. */
    async answerModal(button, value = null) {
      const modal = root.locator(".vnccs-uc-modal").last();
      await expect(modal).toBeVisible();
      if (value !== null) await modal.locator("input").first().fill(value);
      await modal.locator("button", { hasText: button }).last().click();
      await expect(modal).toBeHidden();
    },
    async menuItem(id, item) {
      const menu = await surface.layerMenu(id);
      await menu.locator(`[data-menu-item="${item}"]`).click();
      await expect(menu).toBeHidden();
    },
    async layerMenu(id) {
      await surface.row(id).click({ button: "right" });
      const menu = root.locator(".vnccs-uc-layer-menu");
      await expect(menu).toBeVisible();
      return menu;
    },
    async closePopovers() {
      if (kind === "standalone") await clickOutsidePopovers(page);
      else {
        const bar = root.locator(".vnccs-uc-bottom").first();
        const box = await bar.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + Math.min(6, box.height / 2));
      }
    },
    /** Realtime rule: `read` changes during a range drag (before release) and ends at `final`. */
    async dragRange(locator, fromFraction, toFraction, read) {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      const y = box.y + box.height / 2;
      const before = await read();
      await page.mouse.move(box.x + box.width * fromFraction, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * ((fromFraction + toFraction) / 2), y, { steps: 5 });
      await page.waitForTimeout(80);
      const during = await read();
      await page.mouse.move(box.x + box.width * toFraction, y, { steps: 5 });
      await page.waitForTimeout(80);
      const late = await read();
      await page.mouse.up();
      const after = await read();
      return { before, during, late, after };
    },
  };
  return surface;
}

/** Pixel checksum of a PNG data URL (computed in the page): sum of RGBA, opaque count. */
export function pixelSum(page, dataURL) {
  return page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let sum = 0, opaque = 0;
    for (let i = 0; i < data.length; i += 4) { sum += data[i] + data[i + 1] + data[i + 2] + data[i + 3]; if (data[i + 3] >= 8) opaque += 1; }
    return { sum, opaque };
  }, dataURL);
}
