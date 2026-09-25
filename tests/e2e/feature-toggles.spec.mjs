import { test, expect } from "@playwright/test";
import { openUnicanvas } from "./helpers/app.mjs";

// Issue #50: Settings > VNCCS > UniCanvas switches hide parts of UniCanvas live, in every open
// widget, and switching them back restores them. Nothing generates or downloads.
const shell = ".vnccs-uc2-standalone-shell";
const settingId = (group, key) => `VNCCS.UniCanvas.${group}.${key}`;
const TOGGLES = {
  anima: settingId("ModelFamilies", "family_anima"),
  brush: settingId("Tools", "tool_brush"),
  masks: settingId("LayerTypes", "maskLayers"),
  states: settingId("Features", "sceneStates"),
  vnPreview: settingId("Features", "vnPreview"),
};
const FAMILY_IDS = ["sdxl", "anima", "flux_klein", "z_image", "krea2_edit", "qwen_image_edit", "qwen_image21", "minimax_h3"]
  .map((key) => settingId("ModelFamilies", `family_${key}`));

const setLive = (page, id, value) => page.evaluate(([key, next]) => globalThis.app.extensionManager.setting.set(key, next), [id, value]);
const readSetting = (page, id) => page.evaluate((key) => globalThis.app.extensionManager.setting.get(key), id);
const listLayers = (page) => page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers());

// Every switch back on for the next spec (stored per user on the server).
test.afterEach(async ({ page }) => {
  for (const id of [...Object.values(TOGGLES), ...FAMILY_IDS]) {
    await page.request.post(`/api/settings/${id}`, { data: true });
  }
});

test("a family, a tool, a layer type and features hide and come back live", async ({ page }) => {
  await openUnicanvas(page);
  const modeOption = page.locator(`${shell} select[data-setting="generation_mode"] option[value="anima"]`);
  const brush = page.locator(`${shell} .vnccs-uc-tool[data-tool="brush"]`);
  const addMask = page.locator(`${shell} .vnccs-uc-section-actions [title="Add mask"]`);
  const states = page.locator(`${shell} [data-scene-states]`);
  const vnButton = page.locator(`${shell} .vnccs-uc-vnp-toggle`);
  await expect(brush).toBeVisible();
  await expect(addMask).toBeVisible();
  await expect(states).toBeVisible();
  await expect(vnButton).toBeVisible();
  await expect(modeOption).toHaveJSProperty("hidden", false);

  // The active tool falls back to Move when it is switched off.
  await brush.click();
  await expect(brush).toHaveAttribute("aria-pressed", "true");

  await setLive(page, TOGGLES.anima, false);
  await setLive(page, TOGGLES.brush, false);
  await setLive(page, TOGGLES.masks, false);
  await setLive(page, TOGGLES.states, false);
  await setLive(page, TOGGLES.vnPreview, false);
  await expect(modeOption).toHaveJSProperty("hidden", true);
  await expect(modeOption).toHaveJSProperty("disabled", true);
  await expect(brush).toBeHidden();
  await expect(page.locator(`${shell} .vnccs-uc-tool[data-tool="move"]`)).toHaveAttribute("aria-pressed", "true");
  await expect(addMask).toBeHidden();
  await expect(states).toBeHidden();
  await expect(vnButton).toBeHidden();

  // B no longer selects the brush.
  await page.locator(`${shell} canvas.vnccs-uc-stage`).first().click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("b");
  await expect(page.locator(`${shell} .vnccs-uc-tool[data-tool="move"]`)).toHaveAttribute("aria-pressed", "true");

  for (const id of Object.values(TOGGLES)) await setLive(page, id, true);
  await expect(modeOption).toHaveJSProperty("hidden", false);
  await expect(brush).toBeVisible();
  await expect(addMask).toBeVisible();
  await expect(states).toBeVisible();
  await expect(vnButton).toBeVisible();
});

test("a document with layers of a switched-off type survives a reload", async ({ page }) => {
  await openUnicanvas(page);
  const before = (await listLayers(page)).filter((layer) => layer.type === "mask").length;
  await page.locator(`${shell} .vnccs-uc-section-actions [title="Add mask"]`).click();
  await expect.poll(async () => (await listLayers(page)).filter((layer) => layer.type === "mask").length).toBe(before + 1);
  const saved = await listLayers(page);

  await setLive(page, TOGGLES.masks, false);
  // Let the standalone document save, then reload the page.
  await page.waitForTimeout(3_000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openUnicanvas(page, { navigate: false });
  await expect(page.locator(`${shell} .vnccs-uc-section-actions [title="Add mask"]`)).toBeHidden();
  await expect.poll(async () => (await listLayers(page)).map((layer) => layer.id)).toEqual(saved.map((layer) => layer.id));
  expect(await readSetting(page, TOGGLES.masks)).toBe(false);
});

test("the last model family cannot be switched off", async ({ page }) => {
  await openUnicanvas(page);
  for (const id of FAMILY_IDS.slice(1)) await setLive(page, id, false);
  await setLive(page, FAMILY_IDS[0], false);
  await expect.poll(() => readSetting(page, FAMILY_IDS[0])).toBe(true);
  await expect(page.locator(`${shell} select[data-setting="generation_mode"] option[value="sdxl"]`)).toHaveJSProperty("hidden", false);
});
