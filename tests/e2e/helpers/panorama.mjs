import { expect } from "@playwright/test";

// Node-mode UniCanvas helpers for the panorama spec. State is read from the node's widget;
// every change goes through the real UI (buttons, orbit keyboard, pointer strokes).

export async function addUniCanvasNode(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 60_000 });
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
  await page.evaluate(() => {
    window.app.graph.clear();
    const node = window.LiteGraph.createNode("VNCCS_UniCanvas");
    node.pos = [40, 40];
    window.app.graph.add(node);
  });
  await openFullscreen(page);
}

export async function openFullscreen(page) {
  await expect.poll(() => page.evaluate(() => Boolean(ucNode()?.uniCanvasWidget?._vnccsFullscreenButton)), { timeout: 30_000 }).toBe(true);
  await page.evaluate(() => { const w = ucNode().uniCanvasWidget; if (!w._vnccsFullscreen) w._vnccsFullscreenButton.click(); });
  await expect(page.locator(".vnccs-unicanvas .vnccs-uc-left").first()).toBeVisible({ timeout: 30_000 });
}

export const root = (page) => page.locator(".vnccs-unicanvas").filter({ has: page.locator(".vnccs-uc-left:visible") }).first();

export async function installPageHelpers(page) {
  await page.addInitScript(() => {
    window.ucNode = () => window.app?.graph?._nodes?.find((node) => node.type === "VNCCS_UniCanvas") || null;
    window.ucWidget = () => window.ucNode()?.uniCanvasWidget || null;
    // Count opaque pixels of a canvas inside a rect (x/y may wrap horizontally).
    window.ucAlpha = (canvas, rect, threshold = 8) => {
      if (!canvas) return -1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      let count = 0;
      const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
      const w = Math.min(canvas.width - x0, Math.ceil(rect.width)), h = Math.min(canvas.height - y0, Math.ceil(rect.height));
      if (w <= 0 || h <= 0) return 0;
      const data = ctx.getImageData(x0, y0, w, h).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] >= threshold) count += 1;
      return count;
    };
  });
}

export async function importPanorama(page, file) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    root(page).locator('button[title="Import image"]').first().click(),
  ]);
  await chooser.setFiles(file);
  const dialog = page.getByRole("dialog", { name: "Import as panorama?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Panorama", exact: true }).click();
  await expect.poll(() => page.evaluate(() => ucWidget()?.panorama?.settings?.baseLayerId || null), { timeout: 30_000 }).toBeTruthy();
}

export const camera = (page) => page.evaluate(() => {
  const s = ucWidget().panorama?.settings;
  return s ? { yaw: s.yaw, pitch: s.pitch, roll: s.roll, fov: s.fov } : null;
});

export const viewPanel = (page) => root(page).locator("[data-panorama-panel]");

/** Open the panorama view mode through the panorama layer's globe button (#33). */
export async function openPanoramaView(page) {
  if (await viewPanel(page).isVisible()) return;
  const id = await page.evaluate(() => ucWidget().panorama.settings.baseLayerId);
  await root(page).locator(`[data-layer-id="${id}"] button[title="Edit panorama view"]`).click();
  await expect(viewPanel(page)).toBeVisible();
}

/** Leave the view mode with its Save, Cancel or Reset button. */
export async function panoramaViewAction(page, action) {
  await viewPanel(page).locator(`button[data-panorama-action="${action}"]`).click();
}

/**
 * Rotate through the orbit control's keyboard bindings (5 degrees per press) inside the view
 * mode, then Save (one history entry) unless `save` is false.
 */
export async function rotate(page, key, presses, { save = true } = {}) {
  await openPanoramaView(page);
  const orbit = root(page).locator(".vnccs-uc-panorama-orbit");
  await orbit.focus();
  for (let i = 0; i < presses; i += 1) await page.keyboard.press(key);
  await page.waitForTimeout(50);
  if (save) {
    await panoramaViewAction(page, "save");
    await expect(viewPanel(page)).toBeHidden();
  }
}

export async function selectTool(page, tool) {
  await root(page).locator(`.vnccs-uc-tools [data-tool="${tool}"]`).click();
}

export async function selectLayer(page, id) {
  await page.evaluate((layerId) => ucWidget().setActiveLayer(layerId), id);
}

/** Client coordinates of a point in the square editing window (0..1 each axis). */
export async function viewPoint(page, u, v) {
  return page.evaluate(([pu, pv]) => {
    const w = ucWidget();
    const rect = w.canvas.getBoundingClientRect();
    const size = w.getStageViewportSize();
    const wx = w.bbox.x + pu * w.bbox.width, wy = w.bbox.y + pv * w.bbox.height;
    return { x: rect.left + (wx * w.view.scale + w.view.x) * rect.width / size.width,
      y: rect.top + (wy * w.view.scale + w.view.y) * rect.height / size.height };
  }, [u, v]);
}

export async function stroke(page, points) {
  const client = [];
  for (const [u, v] of points) client.push(await viewPoint(page, u, v));
  await page.mouse.move(client[0].x, client[0].y);
  await page.mouse.down();
  for (const p of client.slice(1)) await page.mouse.move(p.x, p.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(50);
}

/** Opaque pixel count of a layer's stored equirectangular surface inside a rect. */
export const panoAlpha = (page, id, rect) => page.evaluate(([layerId, r]) => {
  const w = ucWidget();
  w.panorama.commit();
  return ucAlpha(w.layers.find((l) => l.id === layerId)?.panoramaCanvas, r);
}, [id, rect]);

export const layers = (page) => page.evaluate(() => ucWidget().layers.map((l) => ({ id: l.id, type: l.type, name: l.name, locked: l.locked })));
