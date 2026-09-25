import { test, expect } from "@playwright/test";
import { openPoseTool, openUnicanvas, poseLayer } from "./helpers/app.mjs";

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


// Plan 06.2 (#18): animation export and pose animation. The export routes are stubbed with
// page.route (nothing is encoded); pose frames are real mannequin renders on the CPU lane.

async function readPixels(page, dataUrls) {
  return page.evaluate(async (urls) => Promise.all(urls.map(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: Array.from(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data) };
  })), dataUrls);
}

test("timeline export: a PNG sequence streams N ordered frames equal to the scrubbed frames", async ({ page }) => {
  const received = [];
  let begin = null;
  await page.route("**/vnccs/unicanvas/animation/begin", async (route) => {
    begin = JSON.parse(route.request().postData());
    await route.fulfill({ json: { ok: true, job_id: "0".repeat(32), frame_count: begin.frame_count } });
  });
  await page.route("**/vnccs/unicanvas/animation/frames", async (route) => {
    const body = JSON.parse(route.request().postData());
    expect(body.start).toBe(received.length);
    received.push(...body.frames);
    await route.fulfill({ json: { ok: true, received: received.length, frame_count: begin.frame_count } });
  });
  await page.route("**/vnccs/unicanvas/animation/status/*", (route) => route.fulfill({ json: { ok: true, encoded: received.length, frame_count: received.length } }));
  await page.route("**/vnccs/unicanvas/animation/end", (route) => route.fulfill({ json: { ok: true, format: "png", path: "output/unicanvas_animation/e2e", files: received.length, frames: received.length } }));

  await openUnicanvas(page);
  const hero = await newLayerAfter(page, () => page.locator(`${shell} [title="Add raster"]`).first().click());
  await drawRect(page, 0.30, 0.40, 0.40, 0.70);
  await openTimeline(page);
  // Frame 0 at rest, frame 5 moved right, work area 0..5: six frames.
  const x = page.locator(`${DOCK} [data-tl="field-x"]`);
  await setFrame(page, 0);
  await x.fill("0");
  await x.dispatchEvent("input");
  await x.dispatchEvent("change");
  await setFrame(page, 5);
  await x.fill("120");
  await x.dispatchEvent("input");
  await x.dispatchEvent("change");
  const workEnd = page.locator(`${DOCK} [data-work-handle="end"]`);
  const ruler = await page.locator(`${DOCK} [data-tl="ruler"]`).boundingBox();
  const handle = await workEnd.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(ruler.x + 5 + (5 / 71) * (ruler.width - 10), handle.y + handle.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await timeline(page)).timeline.workArea).toEqual({ start: 0, end: 5 });

  await control(page, "export").click();
  const dialog = page.locator("[data-anim-export]");
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-anim="format"]').selectOption("png");
  await dialog.locator('[data-anim="range"]').selectOption("work");
  await dialog.locator('[data-anim="frame"]').selectOption("bbox");
  await dialog.locator('[data-anim="export"]').click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  expect(begin).toMatchObject({ format: "png", frame_count: 6 });
  expect(received).toHaveLength(6);

  // Frame k of the export is pixel-equal to the composite of scrubbed frame k.
  for (const k of [0, 3, 5]) {
    await setFrame(page, k);
    const scrubbed = await hook(page, "renderTimelineFrame", (await timeline(page)).timeline.currentFrame);
    const [exported, expected] = await readPixels(page, [received[k], scrubbed]);
    expect(exported.width).toBe(expected.width);
    expect(exported.height).toBe(expected.height);
    expect(exported.data).toEqual(expected.data);
  }
  // Frames differ where the layer moved.
  const [first, last] = await readPixels(page, [received[0], received[5]]);
  expect(first.data).not.toEqual(last.data);
  expect(hero.id).toBeTruthy();
});

test("timeline pose animation: prepared frames play and the last cached frame shows while frames are missing", async ({ page }) => {
  await page.route("**/vnccs/unicanvas/animation/**", (route) => route.fulfill({ status: 500, json: { error: "not under test" } }));
  await openUnicanvas(page);
  await openPoseTool(page);
  const pose = await poseLayer(page);
  expect(pose).not.toBeNull();
  await page.locator(".vnccs-uc-pose-editbar").getByRole("button", { name: "Save pose" }).click();
  await page.locator(`${shell} .vnccs-uc-tool[data-tool="move"]`).click();

  // A 12-frame studio animation at 12 fps that walks the mannequin sideways.
  const ok = await page.evaluate(async (id) => {
    const anim = await import("/extensions/ComfyUI_VNCCS_Utils/vnccs_pose_animation.mjs");
    const state = anim.createDefaultAnimationState({}, { fps: 12, duration: 1 });
    anim.setCharacterTransformKeyframe(state, "@characterPosition", 0, { x: -0.6, y: 0, z: 0, zoom: 1 }, "linear");
    anim.setCharacterTransformKeyframe(state, "@characterPosition", 11, { x: 0.6, y: 0, z: 0, zoom: 1 }, "linear");
    return globalThis.__VNCCS_UC_E2E__.setPoseLayerAnimation(id, JSON.parse(anim.serializeAnimationStateSnapshot(state)));
  }, pose.id);
  expect(ok).toBe(true);

  await openTimeline(page);
  await page.locator(`${DOCK} [data-tl="fps"]`).fill("12");
  await page.locator(`${DOCK} [data-tl="fps"]`).dispatchEvent("change");
  await expect(page.locator(`${DOCK} [data-pose-clip="${pose.id}"]`)).toBeVisible();

  // Nothing prepared: the still shows (no pose frame), never a blank.
  await setFrame(page, 4);
  expect((await timeline(page)).poseDisplay[pose.id]).toMatchObject({ studioFrame: 4, shownFrame: null });

  // An export over the work area 0..3 prepares only studio frames 0..3 (the stubbed encoder then
  // fails, which leaves the prepared frames in place).
  const ruler = await page.locator(`${DOCK} [data-tl="ruler"]`).boundingBox();
  const handle = await page.locator(`${DOCK} [data-work-handle="end"]`).boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(ruler.x + 5 + (3 / 71) * (ruler.width - 10), handle.y + handle.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await timeline(page)).timeline.workArea).toEqual({ start: 0, end: 3 });
  await control(page, "export").click();
  const dialog = page.locator("[data-anim-export]");
  await dialog.locator('[data-anim="range"]').selectOption("work");
  await dialog.locator('[data-anim="export"]').click();
  await expect.poll(async () => (await timeline(page)).poseFrames.layers[pose.id] ?? [], { timeout: 120_000 }).toEqual([0, 1, 2, 3]);
  await expect(dialog.locator('[data-anim="phase"]')).toContainText("Export failed");
  await dialog.locator('[data-anim="cancel"]').click();

  // Frame 9 is missing: the last cached frame (3) shows, identical to scene frame 3.
  await setFrame(page, 9);
  expect((await timeline(page)).poseDisplay[pose.id]).toMatchObject({ studioFrame: 9, shownFrame: 3 });
  const [held, three] = await readPixels(page, [await hook(page, "renderTimelineFrame", 9), await hook(page, "renderTimelineFrame", 3)]);
  expect(held.data).toEqual(three.data);
  expect(held.data.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);

  // Prepare pose frames fills the rest; frame 9 now shows its own render.
  await control(page, "prepare-pose").click();
  await expect.poll(async () => (await timeline(page)).poseFrames.layers[pose.id]?.length ?? 0, { timeout: 120_000 }).toBe(12);
  expect((await timeline(page)).poseDisplay[pose.id]).toMatchObject({ studioFrame: 9, shownFrame: 9 });
  const [nine, zero] = await readPixels(page, [await hook(page, "renderTimelineFrame", 9), await hook(page, "renderTimelineFrame", 0)]);
  expect(nine.data).not.toEqual(zero.data);
});
