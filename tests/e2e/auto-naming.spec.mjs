import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { importImageLayer, openUnicanvas, setLayerNaming } from "./helpers/app.mjs";

// Issue #17: automatic layer names and filing. No GPU and no model download: the draw route
// and describe_layers are stubbed, and describe_layers answers only when the spec releases it.
const FIXTURE = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const FIXTURE_DATA_URL = `data:image/png;base64,${readFileSync(FIXTURE).toString("base64")}`;

const hook = (page, name, ...args) => page.evaluate(([fn, rest]) => globalThis.__VNCCS_UC_E2E__[fn](...rest), [name, args]);
const stack = (page) => hook(page, "getLayerStack");
const naming = (page, id) => hook(page, "getLayerNaming", id);
const shell = ".vnccs-uc2-standalone-shell";
const row = (page, id) => page.locator(`${shell} [data-layer-id="${id}"]`);
const undo = (page) => page.locator(`${shell} .vnccs-uc-icon[title="Undo"]`).first().click();

async function newLeafAfter(page, action) {
  const leaves = async () => (await stack(page)).layers.filter((layer) => layer.type !== "group");
  const before = new Set((await leaves()).map((layer) => layer.id));
  await action();
  await expect.poll(async () => (await leaves()).filter((layer) => !before.has(layer.id)).length, { timeout: 30_000 }).toBe(1);
  return (await leaves()).find((layer) => !before.has(layer.id));
}

/** describe_layers stub: every request waits for `release()`, then answers `answer(item)`. */
async function stubNaming(page, answer) {
  const pending = [];
  const requests = [];
  await page.route("**/vnccs/unicanvas/describe_layers", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    requests.push(body);
    await new Promise((resolve) => pending.push(resolve));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        names: (body.layers || []).map((item) => ({ id: item.id, ...answer(item) })),
        groups: (body.groups || []).map((item) => ({ id: item.id, name: null })),
        model: body.model,
      }),
    });
  });
  return {
    requests,
    release: async () => {
      await expect.poll(() => pending.length, { timeout: 15_000 }).toBeGreaterThan(0);
      pending.splice(0).forEach((resolve) => resolve());
    },
  };
}

async function acceptGeneration(page, prompt) {
  await page.locator(`${shell} textarea[data-setting="positive"]`).fill(prompt);
  await page.locator(`${shell} button`, { hasText: "GENERATE" }).first().click();
  const accept = page.locator(`${shell} [title="Accept as layer"]`).first();
  await expect(accept).toBeVisible({ timeout: 30_000 });
  return newLeafAfter(page, () => accept.click());
}

test.beforeEach(async ({ page }) => {
  await page.route("**/vnccs/unicanvas/draw", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ images: [FIXTURE_DATA_URL], performance: "stub" }),
  }));
});

test("accepted results get the fallback name at once, then the model name, filed in one undo step", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  const naming$ = await stubNaming(page, () => ({ name: "Red Lighthouse", category: "Props", parsed: true }));
  await openUnicanvas(page);
  await setLayerNaming(page, { level: "model", autoFile: true });

  const layer = await acceptGeneration(page, "masterpiece, a red lighthouse at dusk");
  expect(await naming(page, layer.id)).toMatchObject({ name: "Red Lighthouse Dusk", nameSource: "auto", groupId: null });
  await naming$.release();
  await expect.poll(async () => (await naming(page, layer.id)).name).toBe("Red Lighthouse");
  expect(naming$.requests[0].layers[0]).toMatchObject({ prompt: "masterpiece, a red lighthouse at dusk", fallback: "Red Lighthouse Dusk" });

  // Auto-filing: the layer sits in a new Props folder, and one undo removes both.
  const state = await stack(page);
  const folder = state.layers.find((item) => item.type === "group" && item.name === "Props");
  expect(folder).toBeTruthy();
  expect((await naming(page, layer.id)).groupId).toBe(folder.id);
  await undo(page);
  const after = await stack(page);
  expect(after.layers.some((item) => item.id === layer.id)).toBe(false);
  expect(after.layers.some((item) => item.id === folder.id)).toBe(false);
  expect(errors).toEqual([]);
});

test("a user rename is never overwritten and a reply for a deleted layer is dropped", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  const naming$ = await stubNaming(page, () => ({ name: "Model Name", category: "Props", parsed: true }));
  await openUnicanvas(page);
  await setLayerNaming(page, { level: "model", autoFile: false });

  const renamed = await acceptGeneration(page, "a wooden chair");
  await row(page, renamed.id).locator(".vnccs-uc-layer-label").dblclick();
  const input = page.locator(`${shell} .vnccs-uc-modal input.vnccs-uc-input`);
  await input.fill("My chair");
  await input.press("Enter");
  expect(await naming(page, renamed.id)).toMatchObject({ name: "My chair", nameSource: "user" });
  await naming$.release();
  await page.waitForTimeout(500);
  expect((await naming(page, renamed.id)).name).toBe("My chair");

  const deleted = await acceptGeneration(page, "a brass lamp");
  // Delete only once the request is in flight, so the reply really arrives for a missing layer.
  await expect.poll(() => naming$.requests.length, { timeout: 15_000 }).toBe(2);
  await row(page, deleted.id).locator('[title="Delete layer"]').click();
  await expect.poll(async () => (await stack(page)).layers.some((item) => item.id === deleted.id)).toBe(false);
  await naming$.release();
  await page.waitForTimeout(500);
  expect((await stack(page)).layers.some((item) => item.id === deleted.id)).toBe(false);
  expect(errors).toEqual([]);
});

test("Organize previews the moves and one undo reverts them", async ({ page }) => {
  await openUnicanvas(page);
  await setLayerNaming(page, { level: "rules", autoFile: false });

  const imported = await newLeafAfter(page, () => importImageLayer(page, FIXTURE)); // "backdrop" -> Background
  const painted = await newLeafAfter(page, () => page.locator(`${shell} [title="Add raster"]`).first().click());
  expect((await naming(page, painted.id)).name).toMatch(/^Paint \d+$/);
  const before = await stack(page);

  await page.locator(`${shell} [data-organize-layers]`).click();
  const dialog = page.locator(`${shell} .vnccs-uc-organize`);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(`[data-organize-layer="${imported.id}"]`)).toContainText("Background");
  await expect(dialog.locator(`[data-organize-layer="${painted.id}"]`)).toContainText("Other");
  await dialog.locator("[data-organize-apply]").click();

  const filed = await stack(page);
  expect(filed.undo).toBe(before.undo + 1);
  const folderOf = (id) => filed.layers.find((item) => item.id === filed.layers.find((layer) => layer.id === id).groupId)?.name;
  expect(folderOf(imported.id)).toBe("Background");
  expect(folderOf(painted.id)).toBe("Other");

  await undo(page);
  const reverted = await stack(page);
  expect(reverted.layers.map((item) => [item.id, item.groupId])).toEqual(before.layers.map((item) => [item.id, item.groupId]));
});

test("auto-filing puts an imported layer into its category folder and undo removes the folder", async ({ page }) => {
  await openUnicanvas(page);
  await setLayerNaming(page, { level: "rules", autoFile: true });
  const imported = await newLeafAfter(page, () => importImageLayer(page, FIXTURE));
  const state = await stack(page);
  const folder = state.layers.find((item) => item.id === state.layers.find((layer) => layer.id === imported.id).groupId);
  expect(folder).toMatchObject({ type: "group", name: "Background" });
  expect((await naming(page, imported.id))).toMatchObject({ name: "backdrop", nameSource: "import" });
  await undo(page);
  const after = await stack(page);
  expect(after.layers.some((item) => item.id === imported.id || item.id === folder.id)).toBe(false);
});
