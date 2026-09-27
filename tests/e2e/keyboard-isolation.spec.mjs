import { test, expect } from "@playwright/test";
import { openUnicanvas } from "./helpers/app.mjs";

// Keyboard isolation (owner's must-have): no ComfyUI keybinding may fire while a UniCanvas
// surface covers the app, and ComfyUI's workflow must never reload under a fullscreen Ctrl+Z.
// ComfyUI keybindings are observed at their only dispatch seam, the command store's execute;
// workflow reloads through app.loadGraphData; queueing through app.queuePrompt.

async function watchComfy(page) {
  await page.evaluate(() => {
    const seen = { commands: [], loads: 0, queues: 0, bubble: [] };
    window.__ucKeyIso = seen;
    const store = window.app.extensionManager.command;
    const execute = store.execute;
    store.execute = function (commandId, ...rest) {
      seen.commands.push(String(commandId || ""));
      return execute.call(this, commandId, ...rest);
    };
    const load = window.app.loadGraphData;
    window.app.loadGraphData = function (...args) {
      seen.loads += 1;
      return load.apply(this, args);
    };
    const queue = window.app.queuePrompt;
    window.app.queuePrompt = function (...args) {
      seen.queues += 1;
      return queue.apply(this, args);
    };
    // Where ComfyUI's keybinding service listens: window, bubble phase.
    window.addEventListener("keydown", (event) => seen.bubble.push(event.key));
  });
}
const comfySeen = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__ucKeyIso)));

test("Ctrl+Z in node fullscreen undoes exactly one UniCanvas step and the workflow never reloads", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 60_000 });
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
  await page.evaluate(() => {
    window.app.graph.clear();
    const node = window.LiteGraph.createNode("VNCCS_UniCanvas");
    node.pos = [120, 60];
    window.app.graph.add(node);
    window.app.canvas.ds.scale = 0.5;
    window.app.canvas.ds.offset = [80, 240];
    window.app.canvas.setDirty?.(true, true);
    // Leave the node add on ComfyUI's undo stack on purpose: a leaked graph undo would remove
    // the node, reload the workflow and collapse fullscreen.
    window.app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
    window.__ucKeyIsoNode = node;
  });
  const root = page.locator(".vnccs-unicanvas").first();
  await expect(root).toBeVisible({ timeout: 30_000 });
  await watchComfy(page);

  await root.locator(".vnccs-uc2-fullscreen-btn").click();
  const portal = page.locator(".vnccs-uc2-fullscreen-portal");
  await expect(portal).toBeVisible({ timeout: 15_000 });
  const layers = portal.locator(".vnccs-uc-layer");
  const addMask = portal.locator('button[title="Add mask"]');
  const before = await layers.count();
  for (let i = 0; i < 3; i += 1) await addMask.click();
  await expect(layers).toHaveCount(before + 3);

  // One press, one step: never two, never zero.
  await page.keyboard.press("Control+z");
  await expect(layers).toHaveCount(before + 2, { timeout: 5_000 });
  await page.waitForTimeout(400);
  await expect(layers).toHaveCount(before + 2);
  await page.keyboard.press("Control+z");
  await expect(layers).toHaveCount(before + 1, { timeout: 5_000 });
  await page.waitForTimeout(400);
  await expect(layers).toHaveCount(before + 1);

  await expect(portal).toBeVisible();
  const seen = await comfySeen(page);
  expect(seen.loads).toBe(0);
  expect(seen.commands.filter((id) => id === "Comfy.Undo" || id === "Comfy.Redo")).toEqual([]);
  expect(seen.bubble).toEqual([]);
  // The same node instance still owns the same widget: nothing was re-configured.
  expect(await page.evaluate(() => window.app.graph._nodes.includes(window.__ucKeyIsoNode)
    && window.__ucKeyIsoNode.uniCanvasWidget?.container?.isConnected === true)).toBe(true);
});

test("standalone tab: ComfyUI keybindings (Ctrl+S, Ctrl+Enter, Delete) never fire", async ({ page }) => {
  await openUnicanvas(page);
  // A selected graph node that Delete would remove if the key leaked to LiteGraph/ComfyUI.
  await page.evaluate(() => {
    const node = window.LiteGraph.createNode("PrimitiveNode") || window.LiteGraph.createNode("Note");
    window.app.graph.add(node);
    window.app.canvas.selectNode?.(node);
    window.__ucKeyIsoGraphNode = node;
  });
  await watchComfy(page);
  await page.evaluate(() => document.activeElement?.blur?.());

  for (const key of ["Control+s", "Control+Enter", "Delete", "Backspace", "Control+a", "r", "Control+o"]) {
    await page.keyboard.press(key);
  }
  await page.waitForTimeout(500);

  const seen = await comfySeen(page);
  expect(seen.commands).toEqual([]);
  expect(seen.queues).toBe(0);
  expect(seen.loads).toBe(0);
  expect(seen.bubble).toEqual([]);
  expect(await page.evaluate(() => window.app.graph._nodes.includes(window.__ucKeyIsoGraphNode))).toBe(true);
  await expect(page.locator(".vnccs-uc2-standalone-shell")).toBeVisible();

  // Closing the tab hands the keyboard back: ComfyUI sees keys again.
  await page.locator('[data-testid="vnccs-unicanvas-standalone-tab-button"], .vnccs-unicanvas-sidebar-icon').first().click();
  await expect(page.locator(".vnccs-uc2-standalone-shell")).toHaveCount(0);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press("Control+s");
  await expect.poll(async () => (await comfySeen(page)).bubble.length).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
});
