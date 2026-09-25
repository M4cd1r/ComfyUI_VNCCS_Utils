import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { importImageLayer, openUnicanvas, setLayerNaming } from "./helpers/app.mjs";

// Plan 10 (#12): every layer records where its pixels came from (layer.meta), generated layers
// carry the settings snapshot of their run, and pixel changes bump a runtime pixel revision.
const FIXTURE = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const FIXTURE_DATA_URL = `data:image/png;base64,${readFileSync(FIXTURE).toString("base64")}`;

const hook = (page, name, ...args) => page.evaluate(([fn, rest]) => globalThis.__VNCCS_UC_E2E__[fn](...rest), [name, args]);
const layers = (page) => hook(page, "listLayers");
const meta = (page, id) => hook(page, "getLayerMeta", id);
const revision = (page, id) => hook(page, "getLayerPixelRevision", id);
const shell = ".vnccs-uc2-standalone-shell";

async function newLayerAfter(page, action) {
  const before = new Set((await layers(page)).map((layer) => layer.id));
  await action();
  await expect.poll(async () => (await layers(page)).filter((layer) => !before.has(layer.id)).length, { timeout: 15_000 }).toBe(1);
  return (await layers(page)).find((layer) => !before.has(layer.id));
}

test("layers record their origin, generated layers their run, and meta survives a reload", async ({ page }) => {
  await openUnicanvas(page);
  await setLayerNaming(page, { autoFile: false }); // this spec counts and places layers itself

  // Paint: a UI-added raster layer, then a brush stroke on it bumps its pixel revision.
  const painted = await newLayerAfter(page, () => page.locator(`${shell} [title="Add raster"]`).first().click());
  expect(await meta(page, painted.id)).toMatchObject({ origin: "paint" });
  const beforeStroke = await revision(page, painted.id);
  await page.locator(`${shell} .vnccs-uc-tool[data-tool="brush"]`).click();
  const box = await page.locator(`${shell} canvas.vnccs-uc-stage`).first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => revision(page, painted.id)).toBeGreaterThan(beforeStroke);

  // Visibility is not a pixel change.
  const beforeToggle = await revision(page, painted.id);
  const thumb = page.locator(`${shell} [data-layer-id="${painted.id}"] .vnccs-uc-thumb`);
  await thumb.click();
  await thumb.click();
  expect(await revision(page, painted.id)).toBe(beforeToggle);

  // Import keeps the file stem.
  const imported = await newLayerAfter(page, () => importImageLayer(page, FIXTURE));
  expect(await meta(page, imported.id)).toMatchObject({ origin: "import", sourceName: "backdrop" });

  // Duplicate points back at its source.
  await page.locator(`${shell} [data-layer-id="${imported.id}"]`).click();
  const duplicate = await newLayerAfter(page, () => page.locator(`${shell} [title="Duplicate selected"]`).first().click());
  expect(await meta(page, duplicate.id)).toMatchObject({ origin: "duplicate", derivedFrom: imported.id });

  // A stubbed generation: no GPU, the draw route answers with the fixture image.
  await page.route("**/vnccs/unicanvas/draw", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ images: [FIXTURE_DATA_URL], performance: "stub" }),
  }));
  await page.locator(`${shell} textarea[data-setting="positive"]`).fill("a red lighthouse at dusk");
  await page.locator(`${shell} button`, { hasText: "GENERATE" }).first().click();
  const accept = page.locator(`${shell} [title="Accept as layer"]`).first();
  await expect(accept).toBeVisible({ timeout: 30_000 });
  const generated = await newLayerAfter(page, () => accept.click());
  const generatedMeta = await meta(page, generated.id);
  expect(generatedMeta).toMatchObject({ origin: "generate", prompt: "a red lighthouse at dusk" });
  expect(generatedMeta.historyId).toMatch(/^gen_/);
  expect(typeof generatedMeta.seed).toBe("number");
  expect(generatedMeta.model).toBeTruthy();

  // The row tooltip shows origin, prompt, model and seed.
  const title = await page.locator(`${shell} [data-layer-id="${generated.id}"] .vnccs-uc-layer-label`).getAttribute("title");
  expect(title).toContain("Origin: Generated");
  expect(title).toContain("Prompt: a red lighthouse at dusk");
  expect(title).toContain(`Seed: ${generatedMeta.seed}`);

  // Reload: meta comes back as saved.
  const expected = {};
  for (const layer of [painted, imported, duplicate, generated]) expected[layer.id] = await meta(page, layer.id);
  await page.waitForTimeout(2500); // the state cache upload is debounced
  await page.reload({ waitUntil: "domcontentloaded" });
  await openUnicanvas(page, { navigate: false });
  await expect.poll(async () => {
    const ids = new Set((await layers(page)).map((layer) => layer.id));
    return Object.keys(expected).every((id) => ids.has(id));
  }, { timeout: 30_000 }).toBe(true);
  for (const [id, value] of Object.entries(expected)) expect(await meta(page, id)).toEqual(value);
});
