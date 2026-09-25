import { test, expect } from "@playwright/test";
import { openPoseTool, openUnicanvas, poseLayer } from "./helpers/app.mjs";

// Plan 02 (#5): character bake and scene Generate. /vnccs/unicanvas/draw and
// /vnccs/unicanvas/remove_bg are stubbed with in-memory PNGs, so nothing runs inference.
const SHELL = ".vnccs-uc2-standalone-shell";
const STAGE = `${SHELL} canvas.vnccs-uc-stage`;
const CARD = ".vnccs-uc-pose-side .vnccs-uc-pose-character";
const hook = (page, name, ...args) => page.evaluate(([fn, rest]) => globalThis.__VNCCS_UC_E2E__[fn](...rest), [name, args]);
const bake = (page, id) => hook(page, "getPoseBake", id);

// 2x2 PNGs: a red "generated" image and an opaque white remove-background mask.
const PNG_RED = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4o6EBRAwQCgAjrgSxn17XlQAAAABJRU5ErkJggg==";
const PNG_WHITE = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADklEQVR4nGP4DwUMMAYAj4IP8TylVlEAAAAASUVORK5CYII=";
const RED_URL = `data:image/png;base64,${PNG_RED}`;
const WHITE_URL = `data:image/png;base64,${PNG_WHITE}`;
const reference = (name) => ({ name, mimeType: "image/png", buffer: Buffer.from(PNG_RED, "base64") });

/** Stubs both routes; returns the recorded draw requests (bakes carry pose_edit). */
async function stubInference(page, { failBake = false } = {}) {
  const draws = [];
  await page.route("**/vnccs/unicanvas/draw", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    draws.push(body);
    if (failBake && body.pose_edit) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "stub bake failure" }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ images: [RED_URL], performance: "stub" }) });
  });
  await page.route("**/vnccs/unicanvas/remove_bg", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ alpha: WHITE_URL }) }));
  return draws;
}

async function useBakeEngine(page) {
  // The current engine bakes when it is QiE2511 or Klein9b.
  await page.locator(`${SHELL} [data-model-selection-mode="custom"]`).first().click();
  await page.evaluate(() => {
    for (const [key, value] of [["model_loader", "gguf"], ["generation_mode", "qwen_image_edit"]]) {
      const select = document.querySelector(`.vnccs-uc2-standalone-shell select[data-setting="${key}"]`);
      select.value = value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}

async function bindFirstCharacter(page) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator(CARD).getByRole("button", { name: "Upload image" }).first().click()]);
  await chooser.setFiles(reference("alice.png"));
}

async function savePose(page) {
  await page.locator(".vnccs-uc-pose-editbar").getByRole("button", { name: "Save pose" }).click();
}

async function layerAlphaSum(page, id) {
  return page.evaluate(async (layerId) => {
    const url = globalThis.__VNCCS_UC_E2E__.getLayerPixels(layerId).dataURL;
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let red = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 8 && data[i] > 200 && data[i + 1] < 60) red += 1;
    return red;
  }, id);
}

test("a manual bake is staged, accepted and shown; Show mannequin needs no history; a pose edit makes it stale", async ({ page }) => {
  const draws = await stubInference(page);
  await openUnicanvas(page);
  await useBakeEngine(page);
  await openPoseTool(page);
  const pose = await poseLayer(page);
  await bindFirstCharacter(page);
  const chip = page.locator(`${CARD} .vnccs-uc-bake-chip`).first();
  await expect(chip).toHaveText("mannequin");

  await page.locator(`${CARD} [data-bake-action="bake"]`).first().click();
  await expect(page.locator(`${SHELL} [title="Accept as layer"]`).first()).toBeVisible({ timeout: 60_000 });
  expect(draws).toHaveLength(1);
  expect(Object.keys(draws[0].pose_edit)).toEqual(["image1", "image2"]);
  expect(draws[0].pose_edit.image1).toMatch(/^data:image\/png/);
  expect(draws[0].settings.denoise).toBe(1);

  const undoBefore = (await bake(page, pose.id)).undo;
  await page.locator(`${SHELL} [title="Accept as layer"]`).first().click();
  await expect.poll(async () => (await bake(page, pose.id)).characters[0].status).toBe("baked");
  expect((await bake(page, pose.id)).undo).toBe(undoBefore + 1);

  // Leaving the Pose tool shows the baked (red) pixels.
  await savePose(page);
  await expect.poll(async () => (await bake(page, pose.id)).bakedView).toBe(true);
  const bakedRed = await layerAlphaSum(page, pose.id);
  expect(bakedRed).toBeGreaterThan(0);

  // Show mannequin swaps the pixels without a history entry.
  const undoCount = (await bake(page, pose.id)).undo;
  await page.locator(`${SHELL} [data-layer-id="${pose.id}"] [data-bake-toggle]`).click();
  await expect.poll(async () => (await bake(page, pose.id)).showMannequin).toBe(true);
  expect(await layerAlphaSum(page, pose.id)).toBeLessThan(bakedRed);
  expect((await bake(page, pose.id)).undo).toBe(undoCount);
  await page.locator(`${SHELL} [data-layer-id="${pose.id}"] [data-bake-toggle]`).click();
  await expect.poll(async () => (await bake(page, pose.id)).showMannequin).toBe(false);

  // Editing the pose makes the bake stale; its pixels stay visible after saving.
  await page.locator(`${SHELL} [data-layer-id="${pose.id}"] .vnccs-uc-layer-edit-pose`).click();
  await page.locator('.vnccs-uc-pose-side [aria-label="Add Character 2"]').click();
  await page.locator('.vnccs-uc-pose-side [aria-label="Remove Character 2"]').click();
  await page.locator('[role="dialog"] button, [class*="modal"] button', { hasText: /^Remove/ }).last().click();
  const box = await page.locator(STAGE).first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await savePose(page);
  await expect.poll(async () => (await bake(page, pose.id)).characters[0].status, { timeout: 30_000 }).toBe("stale");
  expect(await layerAlphaSum(page, pose.id)).toBeGreaterThan(0);
});

test("GENERATE bakes the bound mannequin only, runs the scene pass, and one undo reverts both", async ({ page }) => {
  const draws = await stubInference(page);
  await openUnicanvas(page);
  await useBakeEngine(page);
  await openPoseTool(page);
  const pose = await poseLayer(page);
  await page.locator('.vnccs-uc-pose-side [aria-label="Add Character 2"]').click();
  await expect(page.locator(`${CARD} .vnccs-uc-pose-character-item`)).toHaveCount(2, { timeout: 30_000 });
  const row = page.locator(`${CARD} .vnccs-uc-pose-character-item`).first();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), row.getByRole("button", { name: "Upload image" }).click()]);
  await chooser.setFiles(reference("alice.png"));
  await savePose(page);

  await expect(page.locator(`${SHELL} .vnccs-uc-bake-count`).first()).toHaveText("+1 bake");
  await page.locator(`${SHELL} textarea[data-setting="positive"]`).fill("");
  const layersBefore = (await hook(page, "listLayers")).length;
  await page.locator(`${SHELL} button`, { hasText: "GENERATE" }).first().click();
  await expect(page.locator(`${SHELL} [title="Accept as layer"]`).first()).toBeVisible({ timeout: 60_000 });
  expect(draws.map((body) => Boolean(body.pose_edit))).toEqual([true, false]);
  expect(draws[1].image).toMatch(/^data:image\/png/); // the empty Prompt still sends the scene request
  const state = await bake(page, pose.id);
  expect(state.characters.map((item) => item.status)).toEqual(["baked", "none"]);

  await page.locator(`${SHELL} [title="Accept as layer"]`).first().click();
  await expect.poll(async () => (await hook(page, "listLayers")).length).toBe(layersBefore + 1);
  await page.locator(STAGE).first().focus();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await hook(page, "listLayers")).length).toBe(layersBefore);
  expect((await bake(page, pose.id)).characters.map((item) => item.status)).toEqual(["none", "none"]);
});

test("with nothing to bake GENERATE sends only the scene request, and a failed bake sends none", async ({ page }) => {
  const draws = await stubInference(page, { failBake: true });
  await openUnicanvas(page);
  await useBakeEngine(page);
  await openPoseTool(page);
  const pose = await poseLayer(page);
  await savePose(page);

  // An unbound mannequin no longer blocks GENERATE: it reaches the scene pass as a mannequin.
  await page.locator(`${SHELL} button`, { hasText: "GENERATE" }).first().click();
  await expect(page.locator(`${SHELL} [title="Accept as layer"]`).first()).toBeVisible({ timeout: 60_000 });
  expect(draws).toHaveLength(1);
  expect(draws[0].pose_edit).toBeUndefined();
  await page.locator(`${SHELL} [title="Discard"], ${SHELL} [title="Discard staging"]`).first().click().catch(() => {});

  await page.locator(`${SHELL} [data-layer-id="${pose.id}"] .vnccs-uc-layer-edit-pose`).click();
  await bindFirstCharacter(page);
  await savePose(page);
  draws.length = 0;
  await page.locator(`${SHELL} button`, { hasText: "GENERATE" }).first().click();
  await expect.poll(async () => (await bake(page, pose.id)).characters[0].status, { timeout: 60_000 }).toBe("failed");
  expect(draws).toHaveLength(1);
  expect(draws[0].pose_edit).toBeTruthy();
  expect((await bake(page, pose.id)).characters[0].error).toMatch(/stub bake failure/);
});
