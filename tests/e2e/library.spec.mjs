import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { importImageLayer, openUnicanvas } from "./helpers/app.mjs";

// Plan 10.4 (#23): the asset library. Save layers as character / prop / background assets from the
// layer menu, insert them into another scene (click and drag onto the canvas) and see a global
// asset from a second project. No GPU: nothing here generates. Sprite sets (Plan 03) are not
// merged yet, so a character is compared as its single image.
const CHARACTER = fileURLToPath(new URL("./fixtures/character.png", import.meta.url));
const BACKDROP = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const SHELL = ".vnccs-uc2-standalone-shell";

const hook = (page, name, ...args) => page.evaluate(([fn, rest]) => globalThis.__VNCCS_UC_E2E__[fn](...rest), [name, args]);
const project = (page) => hook(page, "getProjectInfo");
const layers = (page) => hook(page, "listLayers");
const topRaster = async (page) => (await layers(page)).find((layer) => layer.type === "raster");

async function createProject(page, name) {
  await page.locator(`${SHELL} .vnccs-uc-project-name`).click();
  await expect(page.locator(`${SHELL} .vnccs-uc-project-browser`)).toBeVisible();
  await page.locator(`${SHELL} .vnccs-uc-project-browser-head button`, { hasText: "New" }).click();
  const input = page.locator(`${SHELL} .vnccs-uc-modal .vnccs-uc-field input`);
  await input.fill(name);
  await input.press("Enter");
  await expect(page.locator(`${SHELL} .vnccs-uc-project-name span`)).toHaveText(name, { timeout: 30_000 });
  return project(page);
}

async function newScene(page) {
  const before = (await project(page)).sceneId;
  await page.locator(`${SHELL} .vnccs-uc-scene-add`).click();
  await expect.poll(async () => (await project(page)).sceneId, { timeout: 30_000 }).not.toBe(before);
}

async function saveToLibrary(page, layerId, { name, kind, scope }) {
  await page.locator(`${SHELL} [data-layer-id="${layerId}"]`).first().click({ button: "right" });
  await page.locator('.vnccs-uc-layer-menu [data-menu-item="library-save"]').click();
  const dialog = page.locator(".vnccs-uc-library-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-field="name"]').fill(name);
  await dialog.locator('[data-field="kind"]').evaluate((select, value) => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }, kind);
  await dialog.locator('[data-field="scope"]').evaluate((select, value) => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }, scope);
  await dialog.locator('[data-action="save"]').click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await hook(page, "getLayerMeta", layerId))?.assetId || null, { timeout: 15_000 }).not.toBeNull();
  return hook(page, "getLayerMeta", layerId);
}

async function openLibrary(page, scope) {
  await page.locator(`${SHELL} [data-library-tab="library"]`).click();
  await page.locator(`${SHELL} .vnccs-uc-library [data-scope="${scope}"]`).click();
}

/** Stage client point for a world point (the stage canvas is not CSS-scaled in the standalone shell). */
async function clientPoint(page, world) {
  const view = await hook(page, "getView");
  const box = await page.locator(`${SHELL} canvas.vnccs-uc-stage`).first().boundingBox();
  return { x: world.x * view.scale + view.x, y: world.y * view.scale + view.y, box };
}

test("library: save a character, insert it into another scene with equal pixels, drag-insert at the drop point", async ({ page, request }) => {
  await openUnicanvas(page);
  const created = await createProject(page, `E2E library ${Date.now()}`);
  await importImageLayer(page, CHARACTER);
  const source = await topRaster(page);
  const original = await hook(page, "getLayerCrop", source.id);
  const meta = await saveToLibrary(page, source.id, { name: "Alice", kind: "character", scope: "project" });
  expect(meta.assetScope).toBe("project");
  expect(meta.assetKind).toBe("character");

  // Another scene of the same project: click-insert, pixels equal the saved layer's.
  await newScene(page);
  await openLibrary(page, "project");
  const card = page.locator(`${SHELL} .vnccs-uc-library-card[data-asset-id="${meta.assetId}"]`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const count = (await layers(page)).length;
  await card.click();
  await expect.poll(async () => (await layers(page)).length, { timeout: 15_000 }).toBe(count + 1);
  const inserted = await topRaster(page);
  expect((await hook(page, "getLayerMeta", inserted.id))).toMatchObject({ origin: "asset", assetId: meta.assetId });
  const copy = await hook(page, "getLayerCrop", inserted.id);
  expect(copy.dataURL).toBe(original.dataURL);
  expect([copy.rect.width, copy.rect.height]).toEqual([original.rect.width, original.rect.height]);

  // Drag-insert: the feet (bottom center of the alpha rect) land on the drop point.
  const target = { x: 400, y: 700 };
  const { x, y, box } = await clientPoint(page, target);
  await card.dragTo(page.locator(`${SHELL} canvas.vnccs-uc-stage`).first(), { targetPosition: { x, y } });
  await expect.poll(async () => (await layers(page)).length, { timeout: 15_000 }).toBe(count + 2);
  const dropped = await topRaster(page);
  const feet = (await hook(page, "getLayerCharacter", dropped.id)).feet;
  const view = await hook(page, "getView");
  expect(Math.abs(feet.x - target.x)).toBeLessThanOrEqual(2 / view.scale + 1);
  expect(Math.abs(feet.y - target.y)).toBeLessThanOrEqual(2 / view.scale + 1);
  expect(box).not.toBeNull();

  await request.delete(`/vnccs/unicanvas/projects/${created.projectId}`);
});

test("library: backgrounds and props round-trip, and a global asset shows up in a second project", async ({ page, request }) => {
  await openUnicanvas(page);
  const first = await createProject(page, `E2E library A ${Date.now()}`);
  await importImageLayer(page, BACKDROP);
  const background = await topRaster(page);
  const backgroundPixels = await hook(page, "getLayerCrop", background.id);
  const bgMeta = await saveToLibrary(page, background.id, { name: "Backdrop", kind: "background", scope: "project" });
  await importImageLayer(page, CHARACTER);
  const prop = await topRaster(page);
  const propPixels = await hook(page, "getLayerCrop", prop.id);
  const propMeta = await saveToLibrary(page, prop.id, { name: `Global prop ${Date.now()}`, kind: "prop", scope: "global" });
  expect(propMeta.assetScope).toBe("global");

  await newScene(page);
  await openLibrary(page, "project");
  await page.locator(`${SHELL} .vnccs-uc-library [data-kind="background"]`).click();
  await page.locator(`${SHELL} .vnccs-uc-library-card[data-asset-id="${bgMeta.assetId}"]`).click();
  await expect.poll(async () => (await layers(page)).some((layer) => layer.name === "Backdrop"), { timeout: 15_000 }).toBe(true);
  const stack = await layers(page);
  const insertedBackground = stack.find((layer) => layer.name === "Backdrop");
  // Backgrounds go under every other raster layer.
  expect(stack.filter((layer) => layer.type === "raster").at(-1).id).toBe(insertedBackground.id);
  expect((await hook(page, "getLayerCrop", insertedBackground.id)).dataURL).toBe(backgroundPixels.dataURL);

  // A second project sees the global prop, and inserting it gives the same pixels.
  const second = await createProject(page, `E2E library B ${Date.now()}`);
  await openLibrary(page, "global");
  const card = page.locator(`${SHELL} .vnccs-uc-library-card[data-asset-id="${propMeta.assetId}"]`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  await expect.poll(async () => (await topRaster(page))?.name, { timeout: 15_000 }).toBe(await card.locator(".vnccs-uc-library-name").textContent());
  expect((await hook(page, "getLayerCrop", (await topRaster(page)).id)).dataURL).toBe(propPixels.dataURL);
  await openLibrary(page, "project");
  await expect(page.locator(`${SHELL} .vnccs-uc-library-card[data-asset-id="${bgMeta.assetId}"]`)).toHaveCount(0);

  await request.delete(`/vnccs/unicanvas/library/assets/${propMeta.assetId}`);
  await request.delete(`/vnccs/unicanvas/projects/${first.projectId}`);
  await request.delete(`/vnccs/unicanvas/projects/${second.projectId}`);
});
