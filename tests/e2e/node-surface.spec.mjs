import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { importImageLayer, openUnicanvas } from "./helpers/app.mjs";

// Node vs standalone surface and the undo / redo key capture.
// - The UniCanvas node in a workflow hides scene states (#7), the timeline (#9), the VN preview
//   (#10) and the project / scene selector with history (#22, #24); the standalone tab shows them.
// - In node fullscreen and in the open standalone tab Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z act on the
//   UniCanvas history only; inline (not fullscreen) ComfyUI keeps its own keys.
// "Reaches ComfyUI" is observed with a window bubble-phase listener registered by the test: it
// runs where ComfyUI's keybinding service listens, after any UniCanvas capture.
const FIXTURE = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const shell = ".vnccs-uc2-standalone-shell";
const STANDALONE_ONLY = [".vnccs-uc-states", "[data-timeline-toggle]", ".vnccs-uc-vnp-toggle", ".vnccs-uc-project-bar"];

async function watchWindowHistoryKeys(page) {
  await page.evaluate(() => {
    window.__ucSeenHistoryKeys = [];
    window.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && /^[zy]$/i.test(event.key)) window.__ucSeenHistoryKeys.push(event.key);
    });
  });
}
const seenKeys = (page) => page.evaluate(() => window.__ucSeenHistoryKeys.length);
const blurAll = (page) => page.evaluate(() => document.activeElement?.blur?.());

async function addUniCanvasNode(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 60_000 });
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
  await page.evaluate(() => {
    window.app.graph.clear();
    const node = window.LiteGraph.createNode("VNCCS_UniCanvas");
    node.pos = [60, 40];
    window.app.graph.add(node);
    const widget = node.uniCanvasWidget;
    window.__ucSurfaceTest = { node, calls: [] };
    for (const name of ["undo", "redo"]) {
      const original = widget[name];
      widget[name] = (...args) => {
        window.__ucSurfaceTest.calls.push(name);
        return original.apply(widget, args);
      };
    }
  });
  const root = page.locator(".vnccs-unicanvas").first();
  await expect(root).toBeVisible({ timeout: 30_000 });
  return root;
}
const historyCalls = (page) => page.evaluate(() => [...window.__ucSurfaceTest.calls]);

test("the workflow node hides the standalone-only features and their shortcuts", async ({ page }) => {
  const root = await addUniCanvasNode(page);
  await expect(root).toHaveClass(/vnccs-uc-node-surface/);
  await expect(root).toHaveAttribute("data-surface", "node");
  for (const selector of STANDALONE_ONLY) {
    for (const element of await root.locator(selector).all()) await expect(element).toBeHidden();
  }
  // P (VN preview) and Alt+1 (scene state 1) do nothing on the node.
  await root.locator("canvas.vnccs-uc-stage").click({ position: { x: 40, y: 40 } });
  await page.keyboard.press("p");
  await page.keyboard.press("Alt+1");
  const vn = await page.evaluate(() => window.__ucSurfaceTest.node.uniCanvasWidget.vnPreview?.state?.enabled === true);
  expect(vn).toBe(false);
});

test("the standalone tab shows scene states, the VN preview, the timeline and the project bar", async ({ page }) => {
  await openUnicanvas(page);
  const root = page.locator(`${shell} .vnccs-unicanvas`);
  await expect(root).toHaveAttribute("data-surface", "standalone");
  await expect(root).not.toHaveClass(/vnccs-uc-node-surface/);
  for (const selector of STANDALONE_ONLY) await expect(root.locator(selector).first()).toBeVisible();
});

test("node: undo keys stay with ComfyUI inline and belong to UniCanvas in fullscreen", async ({ page }) => {
  const root = await addUniCanvasNode(page);
  await watchWindowHistoryKeys(page);

  // Inline: UniCanvas does not steal Ctrl+Z / Ctrl+Y.
  await blurAll(page);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  expect(await seenKeys(page)).toBe(2);
  expect(await historyCalls(page)).toEqual([]);

  // Fullscreen: every history combo runs the UniCanvas history and stops there.
  await root.locator(".vnccs-uc2-fullscreen-btn").click();
  await expect(page.locator(".vnccs-uc2-fullscreen-portal")).toBeVisible();
  await blurAll(page);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  await page.keyboard.press("Control+Shift+z");
  await page.keyboard.press("Meta+z");
  expect(await seenKeys(page)).toBe(2);
  expect(await historyCalls(page)).toEqual(["undo", "redo", "redo", "undo"]);

  // A text field keeps its native undo: neither ComfyUI nor the canvas history sees it.
  const prompt = root.locator("textarea").first();
  await prompt.fill("hello");
  await prompt.focus();
  await page.keyboard.press("Control+z");
  expect(await seenKeys(page)).toBe(2);
  expect((await historyCalls(page)).length).toBe(4);

  // Leaving fullscreen gives the keys back to ComfyUI.
  await blurAll(page);
  await page.keyboard.press("Escape");
  await expect(page.locator(".vnccs-uc2-fullscreen-portal")).toHaveCount(0);
  await page.keyboard.press("Control+z");
  expect(await seenKeys(page)).toBe(3);
  expect((await historyCalls(page)).length).toBe(4);
});

test("standalone: undo keys act on the UniCanvas history while the tab is open", async ({ page }) => {
  await openUnicanvas(page);
  await importImageLayer(page, FIXTURE);
  await watchWindowHistoryKeys(page);
  const undoDepth = async () => (await page.evaluate(() => globalThis.__VNCCS_UC_E2E__.getLayerStack())).undo;
  const before = await undoDepth();
  expect(before).toBeGreaterThan(0);

  // Focus outside the canvas (not a text field) still undoes UniCanvas, not the graph.
  await blurAll(page);
  await page.keyboard.press("Control+z");
  await expect.poll(undoDepth).toBe(before - 1);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(undoDepth).toBe(before);
  expect(await seenKeys(page)).toBe(0);

  // Closing the tab hands the keys back to ComfyUI.
  await page.locator('[data-testid="vnccs-unicanvas-standalone-tab-button"], .vnccs-unicanvas-sidebar-icon').first().click();
  await expect(page.locator(shell)).toHaveCount(0);
  await blurAll(page);
  await page.keyboard.press("Control+z");
  expect(await seenKeys(page)).toBe(1);
});
