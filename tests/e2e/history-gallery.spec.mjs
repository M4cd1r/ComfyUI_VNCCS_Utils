import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { openUnicanvas } from "./helpers/app.mjs";

// Plan 10.5 (#24): every generation run is recorded in the project with all its results, and the
// History gallery restores settings, places discarded results and filters. No GPU: the draw
// route is stubbed with the fixture image (batch 3).
const FIXTURE = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const FIXTURE_DATA_URL = `data:image/png;base64,${readFileSync(FIXTURE).toString("base64")}`;
const SHELL = ".vnccs-uc2-standalone-shell";
const GALLERY = `${SHELL} .vnccs-uc-history-gallery`;

const hook = (page, name, ...args) => page.evaluate(([fn, rest]) => globalThis.__VNCCS_UC_E2E__[fn](...rest), [name, args]);
const project = (page) => hook(page, "getProjectInfo");
const layers = (page) => hook(page, "listLayers");

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

async function historyRecords(request, projectId) {
  return (await (await request.get(`/vnccs/unicanvas/projects/${projectId}/history`)).json()).records;
}

async function generate(page, prompt, images) {
  await page.locator(`${SHELL} textarea[data-setting="positive"]`).fill(prompt);
  await page.locator(`${SHELL} input[data-setting="batch_size"]`).fill(String(images)).catch(() => {});
  await page.locator(`${SHELL} button`, { hasText: "GENERATE" }).first().click();
  await expect(page.locator(`${SHELL} [title="Accept as layer"]`).first()).toBeVisible({ timeout: 30_000 });
}

test("history: a batch of 3 with 1 accepted is recorded; restore, place and filter work", async ({ page, request }) => {
  await openUnicanvas(page);
  const created = await createProject(page, `E2E history ${Date.now()}`);
  await page.route("**/vnccs/unicanvas/draw", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ images: [FIXTURE_DATA_URL, FIXTURE_DATA_URL, FIXTURE_DATA_URL], performance: "stub" }),
  }));

  // Run 1: batch 3, accept one.
  await generate(page, "a red lighthouse at dusk", 3);
  expect(await hook(page, "getStaging")).toHaveLength(3);
  const before = (await layers(page)).length;
  await page.locator(`${SHELL} [title="Accept as layer"]`).first().click();
  await expect.poll(async () => (await layers(page)).length).toBe(before + 1);
  await expect.poll(async () => {
    const [record] = await historyRecords(request, created.projectId);
    return record ? [record.results.length, record.results.filter((item) => item.accepted).length] : null;
  }, { timeout: 30_000 }).toEqual([3, 1]);
  const [first] = await historyRecords(request, created.projectId);
  expect(first.kind).toBe("generate");
  expect(first.sceneId).toBe(created.sceneId);
  expect(first.settings.positive).toBe("a red lighthouse at dusk");
  expect(first.results.every((item) => item.imageDataURL?.blob)).toBe(true);

  // Run 2 with another prompt, discarded entirely.
  await generate(page, "a blue whale", 1);
  await page.locator(`${SHELL} [title="Discard"]`).first().click();
  await expect.poll(async () => (await historyRecords(request, created.projectId)).length, { timeout: 30_000 }).toBe(2);

  // Gallery: the newest record first, filters narrow the grid.
  await page.locator(`${SHELL} .vnccs-uc-history-open`).click();
  await expect(page.locator(GALLERY)).toBeVisible();
  const cards = page.locator(`${GALLERY} .vnccs-uc-history-card`);
  await expect(cards).toHaveCount(2);
  await page.locator(`${GALLERY} [data-history-filter="text"]`).fill("lighthouse");
  await expect(cards).toHaveCount(1);
  await page.locator(`${GALLERY} [data-history-filter="text"]`).fill("");
  await page.locator(`${GALLERY} [data-history-filter="accepted"]`).check();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("data-history-id", first.id);
  await page.locator(`${GALLERY} [data-history-filter="accepted"]`).uncheck();
  await page.locator(`${GALLERY} [data-history-filter="kind"]`).selectOption("remove_bg");
  await expect(cards).toHaveCount(0);
  await page.locator(`${GALLERY} [data-history-filter="kind"]`).selectOption("");
  await expect(cards).toHaveCount(2);

  // Restore settings: the panel values equal the snapshot.
  await page.locator(`${GALLERY} .vnccs-uc-history-card[data-history-id="${first.id}"]`).click();
  await page.locator(`${GALLERY} .vnccs-uc-history-detail button`, { hasText: "Restore settings" }).click();
  const settings = await hook(page, "getSettings");
  for (const key of ["positive", "negative", "seed", "steps", "cfg", "sampler_name", "scheduler", "generation_mode"]) {
    if (key in first.settings) expect(settings[key]).toEqual(first.settings[key]);
  }
  await expect(page.locator(`${SHELL} textarea[data-setting="positive"]`)).toHaveValue("a red lighthouse at dusk");

  // Placing a discarded result creates a new layer.
  const discarded = first.results.findIndex((item) => !item.accepted);
  const count = (await layers(page)).length;
  await page.locator(`${GALLERY} .vnccs-uc-history-result[data-result-index="${discarded}"] button`, { hasText: "Place as layer" }).click();
  await expect.poll(async () => (await layers(page)).length).toBe(count + 1);

  // A/B compare opens with a live slider.
  await page.locator(`${GALLERY} .vnccs-uc-history-result[data-result-index="0"] button`, { hasText: "Pick A/B" }).click();
  await page.locator(`${GALLERY} .vnccs-uc-history-result[data-result-index="1"] button`, { hasText: "Pick A/B" }).click();
  await page.locator(`${GALLERY} button`, { hasText: "Compare A/B" }).click();
  const slider = page.locator(`${SHELL} .vnccs-uc-history-compare-slider`);
  await expect(slider).toBeVisible();
  await slider.fill("25");
  await expect(page.locator(`${SHELL} .vnccs-uc-history-compare img[data-compare="a"]`)).toHaveAttribute("style", /inset\(0(px)? 75%/);

  await request.delete(`/vnccs/unicanvas/projects/${created.projectId}`);
});
