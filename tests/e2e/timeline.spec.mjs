import { test, expect } from "@playwright/test";
import { openUnicanvas } from "./helpers/app.mjs";

// Plan 06 (#9): the scene timeline. Standalone only; no GPU. One raster "character" drawn with
// the rect tool is keyed at two frames and scrubbed; bounds come from the read-only E2E hook.
const shell = ".vnccs-uc2-standalone-shell";
const STAGE = `${shell} canvas.vnccs-uc-stage`;
const DOCK = `${shell} [data-timeline-dock]`;

const hook = (page, name, ...args) => page.evaluate(([fn, rest]) => globalThis.__VNCCS_UC_E2E__[fn](...rest), [name, args]);
const stack = (page) => hook(page, "getLayerStack");
const timeline = (page) => hook(page, "getTimeline");
const bounds = (page, id) => hook(page, "getLayerDisplayBounds", id);
const control = (page, name) => page.locator(`${DOCK} [data-tl="${name}"]`).first();

async function newLayerAfter(page, action) {
  const before = new Set((await stack(page)).layers.map((layer) => layer.id));
  await action();
  await expect.poll(async () => (await stack(page)).layers.filter((layer) => !before.has(layer.id)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  return (await stack(page)).layers.find((layer) => !before.has(layer.id));
}

async function drawRect(page, x0, y0, x1, y1) {
  await page.locator(`${shell} .vnccs-uc-tool[data-tool="rect"]`).click();
  const box = await page.locator(STAGE).first().boundingBox();
  await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1, { steps: 6 });
  await page.mouse.up();
}

async function setFrame(page, frame) {
  const input = control(page, "frame");
  await input.fill(String(frame));
  await input.dispatchEvent("input");
  await expect.poll(async () => (await timeline(page)).timeline.currentFrame).toBe(frame);
}

// Move-tool drag on the stage (auto-key writes a position key at the playhead).
async function dragStage(page, from, dx) {
  await page.locator(`${shell} .vnccs-uc-tool[data-tool="move"]`).click();
  const box = await page.locator(STAGE).first().boundingBox();
  await page.mouse.move(box.x + box.width * from.x, box.y + box.height * from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * from.x + dx, box.y + box.height * from.y, { steps: 8 });
  await page.mouse.up();
}

async function openTimeline(page) {
  await page.locator(`${shell} [data-timeline-toggle]`).first().click();
  await expect(page.locator(DOCK)).toBeVisible();
}

test("timeline: keys, scrub, hold, auto-key off, seeded blink, undo and reload", async ({ page }) => {
  await openUnicanvas(page);
  const hero = await newLayerAfter(page, () => page.locator(`${shell} [title="Add raster"]`).first().click());
  await drawRect(page, 0.30, 0.40, 0.40, 0.70);
  const rest = await bounds(page, hero.id);
  expect(rest).not.toBeNull();

  // An empty timeline renders the rest scene: the dock opens without changing anything.
  await openTimeline(page);
  expect((await timeline(page)).animated).toBe(false);
  expect(await bounds(page, hero.id)).toEqual(rest);

  // Two position keys: frame 0 at rest (a zero-length drag keys nothing, so key via the field),
  // frame 20 moved right by 200 world px.
  await setFrame(page, 0);
  const x = page.locator(`${DOCK} [data-tl="field-x"]`);
  await x.fill("0");
  await x.dispatchEvent("input");
  await x.dispatchEvent("change");
  await setFrame(page, 20);
  await x.fill("200");
  await x.dispatchEvent("input");
  await x.dispatchEvent("change");
  const keyed = (await timeline(page)).timeline.tracks[`${hero.id}:position`];
  expect(keyed.keys.map((key) => key.frame)).toEqual([0, 20]);

  // Scrubbing the ruler to the mid frame puts the layer at the interpolated value (±1 px), and the
  // canvas updates before pointerup.
  const ruler = page.locator(`${DOCK} [data-tl="ruler"]`);
  const rulerBox = await ruler.boundingBox();
  const frameX = (frame) => rulerBox.x + 5 + (frame / 71) * (rulerBox.width - 10);
  await page.mouse.move(frameX(0), rulerBox.y + rulerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(frameX(10), rulerBox.y + rulerBox.height / 2, { steps: 5 });
  await expect.poll(async () => (await timeline(page)).timeline.currentFrame).toBe(10);
  const mid = await bounds(page, hero.id);
  expect(Math.abs(mid.x - (rest.x + 100))).toBeLessThanOrEqual(1);
  await page.mouse.up();

  // Hold interpolation steps.
  await page.locator(`${DOCK} .vnccs-uc-tl-expand[data-expand="${hero.id}"]`).click();
  await page.locator(`${DOCK} [data-track="${hero.id}:position"]`).first().click({ button: "right" });
  await page.locator(`${shell} [data-tl-action="interp-hold"]`).click();
  await setFrame(page, 19);
  expect(Math.abs((await bounds(page, hero.id)).x - rest.x)).toBeLessThanOrEqual(1);
  await setFrame(page, 20);
  expect(Math.abs((await bounds(page, hero.id)).x - (rest.x + 200))).toBeLessThanOrEqual(1);

  // Undo reverts the interpolation change; a key move and its undo round-trip.
  await page.locator(DOCK).focus();
  await page.keyboard.press("Control+z");
  await setFrame(page, 10);
  expect(Math.abs((await bounds(page, hero.id)).x - (rest.x + 100))).toBeLessThanOrEqual(1);
  const key20 = page.locator(`${DOCK} [data-track="${hero.id}:position"]`).nth(1);
  const keyBox = await key20.boundingBox();
  await page.mouse.move(keyBox.x + keyBox.width / 2, keyBox.y + keyBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(frameX(30), keyBox.y + keyBox.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await timeline(page)).timeline.tracks[`${hero.id}:position`].keys.map((key) => key.frame)).toEqual([0, 30]);
  await page.locator(DOCK).focus();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await timeline(page)).timeline.tracks[`${hero.id}:position`].keys.map((key) => key.frame)).toEqual([0, 20]);

  // Auto-key off: a move changes the rest scene and writes no key.
  await control(page, "auto-key").click();
  await expect(control(page, "auto-key-warning")).toBeVisible();
  await setFrame(page, 0);
  const keysBefore = JSON.stringify((await timeline(page)).timeline.tracks);
  await dragStage(page, { x: 0.35, y: 0.55 }, 60);
  expect(JSON.stringify((await timeline(page)).timeline.tracks)).toBe(keysBefore);
  await control(page, "auto-key").click();

  // A seeded blink switches the variant on the same frames across two runs.
  const runs = await page.evaluate(async () => {
    const { normalizeTimeline, evaluateEffects } = await import("/extensions/ComfyUI_VNCCS_Utils/vnccs_unicanvas_timeline_core.mjs");
    const raw = { frameCount: 480, effects: [{ id: "fx-e2e", kind: "blink", target: "S", params: { variantId: "closed" }, start: 0 }] };
    const frames = (t) => Array.from({ length: 480 }, (_, f) => f).filter((f) => evaluateEffects(t, "S", f).variantId === "closed");
    return [frames(normalizeTimeline(raw)), frames(normalizeTimeline(JSON.parse(JSON.stringify(raw))))];
  });
  expect(runs[0].length).toBeGreaterThan(0);
  expect(runs[0]).toEqual(runs[1]);

  // The timeline persists across a reload.
  const saved = (await timeline(page)).timeline;
  await page.waitForTimeout(2500); // standalone persistence is debounced
  await page.reload({ waitUntil: "domcontentloaded" });
  await openUnicanvas(page, { navigate: false });
  await expect.poll(async () => (await timeline(page))?.timeline?.tracks?.[`${hero.id}:position`]?.keys?.length ?? 0, { timeout: 30_000 }).toBe(2);
  expect((await timeline(page)).timeline.fps).toBe(saved.fps);
});

