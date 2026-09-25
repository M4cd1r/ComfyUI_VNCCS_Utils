import { test, expect } from "@playwright/test";
import { openPoseTool, openUnicanvas, poseLayer } from "./helpers/app.mjs";

// Plan 01 (#4): several mannequins in one pose layer, one reference each, exact per-character
// masks from the ID pass, and split / merge of pose layers. Nothing here runs inference.
const shell = ".vnccs-uc2-standalone-shell";
const STAGE = `${shell} canvas.vnccs-uc-stage`;
const CARD = ".vnccs-uc-pose-side .vnccs-uc-pose-character";
const hook = (page, name, ...args) => page.evaluate(([fn, rest]) => globalThis.__VNCCS_UC_E2E__[fn](...rest), [name, args]);
const scene = (page, id) => hook(page, "getPoseScene", id);
const stack = (page) => hook(page, "getLayerStack");

// Two distinct 2x2 PNG references, generated in memory (no binary fixtures needed).
const PNG_RED = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4o6EBRAwQCgAjrgSxn17XlQAAAABJRU5ErkJggg==";
const PNG_BLUE = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGPQsLkDRAwQCgAgPgUBnTSBygAAAABJRU5ErkJggg==";
const reference = (name, base64) => ({ name, mimeType: "image/png", buffer: Buffer.from(base64, "base64") });

async function uploadFor(page, rowIndex, file) {
  const row = page.locator(`${CARD} .vnccs-uc-pose-character-item`).nth(rowIndex);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), row.getByRole("button", { name: "Upload image" }).click()]);
  await chooser.setFiles(file);
}

async function commitPose(page) {
  // Save pose leaves the editor through commit(), which refreshes the ID pass.
  await page.locator(".vnccs-uc-pose-editbar").getByRole("button", { name: "Save pose" }).click();
}

async function alphaIoU(page, originalId, partIds) {
  return page.evaluate(async ([original, parts]) => {
    const pixels = (id) => globalThis.__VNCCS_UC_E2E__.getLayerPixels(id);
    const read = async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const base = await read(pixels(original).dataURL);
    const union = new Uint8Array(base.length / 4);
    for (const id of parts) {
      const data = await read(pixels(id).dataURL);
      for (let i = 0; i < union.length; i += 1) if (data[i * 4 + 3] > 8) union[i] = 1;
    }
    let both = 0, either = 0;
    for (let i = 0; i < union.length; i += 1) {
      const a = base[i * 4 + 3] > 8, b = union[i] === 1;
      if (a && b) both += 1;
      if (a || b) either += 1;
    }
    return either ? both / either : 0;
  }, [originalId, partIds]);
}

test("two mannequins bind their own references, get disjoint masks and split into two layers", async ({ page }) => {
  await openUnicanvas(page);
  await openPoseTool(page);
  const pose = await poseLayer(page);

  // A legacy-shaped layer: one mannequin writes only pose.character.
  await expect(page.locator(`${CARD} .vnccs-uc-pose-character-item`)).toHaveCount(0);
  const [single] = await Promise.all([page.waitForEvent("filechooser"), page.locator(CARD).getByRole("button", { name: "Upload image" }).first().click()]);
  await single.setFiles(reference("alice.png", PNG_RED));
  await expect.poll(async () => (await scene(page, pose.id)).characters[0].ref?.name ?? null).toBe("alice.png");
  expect((await scene(page, pose.id)).hasCharacterRefs).toBe(false);

  // Add a second mannequin in the embedded studio: the card switches to one row per mannequin.
  await page.locator('.vnccs-uc-pose-side [aria-label="Add Character 2"]').click();
  await expect(page.locator(`${CARD} .vnccs-uc-pose-character-item`)).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator(`${CARD} .vnccs-uc-pose-character-count`)).toHaveText("1/2 characters bound");
  await uploadFor(page, 1, reference("bob.png", PNG_BLUE));
  await expect(page.locator(`${CARD} .vnccs-uc-pose-character-count`)).toHaveText("2/2 characters bound");
  const bound = await scene(page, pose.id);
  expect(bound.characters.map((item) => item.ref?.name)).toEqual(["alice.png", "bob.png"]);

  // After a commit the ID pass has exactly two non-empty, disjoint regions inside the layer alpha.
  await commitPose(page);
  await expect.poll(async () => (await scene(page, pose.id)).idPass?.counts?.length ?? 0, { timeout: 30_000 }).toBe(2);
  const { idPass } = await scene(page, pose.id);
  expect(idPass.counts.every((count) => count > 0)).toBe(true);
  expect(idPass.overlap).toBe(0);
  expect(idPass.outside).toBeLessThanOrEqual(Math.ceil(idPass.counts.reduce((a, b) => a + b, 0) * 0.01));

  // Split: two pose layers, one reference each, whose alpha union matches the original.
  const before = await stack(page);
  await page.locator(`${shell} [data-layer-id="${pose.id}"]`).click({ button: "right" });
  await page.locator(".vnccs-uc-layer-menu button", { hasText: "Split characters to layers" }).click();
  await expect.poll(async () => (await stack(page)).layers.filter((layer) => layer.type === "pose").length, { timeout: 60_000 }).toBe(3);
  const after = await stack(page);
  const parts = after.layers.filter((layer) => layer.type === "pose" && layer.id !== pose.id);
  expect(after.layers.find((layer) => layer.id === pose.id).visible).toBe(false);
  for (const part of parts) expect((await scene(page, part.id)).characters.map((item) => item.ref?.name).filter(Boolean)).toHaveLength(1);
  // The original is hidden, so compare with its own pixels, which a split never changes.
  expect(await alphaIoU(page, pose.id, parts.map((part) => part.id))).toBeGreaterThanOrEqual(0.98);

  // One undo step reverts the split.
  await page.locator(STAGE).first().focus();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await stack(page)).layers.map((layer) => layer.id)).toEqual(before.layers.map((layer) => layer.id));
  expect((await stack(page)).layers.find((layer) => layer.id === pose.id).visible).toBe(true);
});

test("removing a mannequin drops its reference", async ({ page }) => {
  await openUnicanvas(page);
  await openPoseTool(page);
  const pose = await poseLayer(page);
  await page.locator('.vnccs-uc-pose-side [aria-label="Add Character 2"]').click();
  await expect(page.locator(`${CARD} .vnccs-uc-pose-character-item`)).toHaveCount(2, { timeout: 30_000 });
  await uploadFor(page, 1, reference("bob.png", PNG_BLUE));
  await expect.poll(async () => (await scene(page, pose.id)).characters[1]?.ref?.name ?? null).toBe("bob.png");
  // Character 2 is active after it was added; remove it and confirm.
  await page.locator('.vnccs-uc-pose-side [aria-label="Remove Character 2"]').click();
  await page.locator('[role="dialog"] button, [class*="modal"] button', { hasText: /^Remove/ }).last().click();
  await expect(page.locator(`${CARD} .vnccs-uc-pose-character-item`)).toHaveCount(0, { timeout: 30_000 });
  const after = await scene(page, pose.id);
  expect(after.characters).toHaveLength(1);
  expect(after.hasCharacterRefs).toBe(false);
});
