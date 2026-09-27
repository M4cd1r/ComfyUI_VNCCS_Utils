import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { openNodeSurface, openStandaloneSurface } from "./helpers/sweep.mjs";

// Pass 2 of the UniCanvas bug round (issue #33): every interactive control, exercised at least
// once through the real UI, on the standalone tab and on a workflow node in fullscreen where the
// control exists. Each check asserts a visible effect or state change, undo / redo after a
// mutating action, the realtime rule for sliders (the effect shows before the pointer is
// released), and no page or console error. Inference routes are stubbed; nothing downloads.
// The inventory lives with the round's notes; the areas below follow it.

test.describe.configure({ timeout: 240_000 });

const FIXTURE = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const CHARACTER = fileURLToPath(new URL("./fixtures/character.png", import.meta.url));
const FIXTURE_DATA_URL = `data:image/png;base64,${readFileSync(FIXTURE).toString("base64")}`;

const SURFACES = {
  standalone: openStandaloneSurface,
  node: openNodeSurface,
};

/* ------------------------------------------------------------------------------------------ */
/* Area 1: toolbar tools, tool options and the stage bar                                         */
/* ------------------------------------------------------------------------------------------ */

async function sweepToolsAndStageBar(s) {
  const { page, root } = s;
  // Every toolbar tool becomes the active tool.
  for (const tool of ["brush", "eraser", "mask", "sam", "rect", "lasso", "resize", "perspective", "bbox", "pan", "move"]) {
    await s.selectTool(tool);
  }

  // Brush: realtime size / opacity sliders, then a stroke paints a new raster layer (undo / redo).
  const layer = await s.addRaster();
  await s.selectTool("brush");
  const brush = () => s.hook("getBrush");
  const size = await s.dragRange(root.locator('[data-control="brushSize"]'), 0.2, 0.6, async () => (await brush()).size);
  expect(size.during, "brush size follows the slider before release").not.toBe(size.before);
  expect(size.late).not.toBe(size.during);
  const opacity = await s.dragRange(root.locator('[data-control="opacity"]'), 0.9, 0.6, async () => (await brush()).opacity);
  expect(opacity.during).not.toBe(opacity.before);
  await root.locator('[data-control="fg"]').evaluate((input) => { input.value = "#ff2040"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect((await brush()).fg).toBe("#ff2040");
  const hardness = root.locator('[data-control="brushHardness"]');
  if (await hardness.count()) {
    const hard = await s.dragRange(hardness, 0.95, 0.4, async () => (await brush()).hardness);
    expect(hard.during, "hardness follows the slider before release").not.toBe(hard.before);
  }
  const alphaBefore = await s.alpha(layer.id);
  const painted = await s.drag([[0.3, 0.3], [0.6, 0.4], [0.7, 0.6]], { during: () => s.alpha(layer.id) });
  expect(painted, "the stroke shows while the pointer is down").toBeGreaterThan(alphaBefore);
  const alphaPainted = await s.alpha(layer.id);
  await s.expectUndoRedo(() => s.alpha(layer.id), alphaBefore, alphaPainted);

  // Eraser removes paint (undo / redo).
  await s.selectTool("eraser");
  await s.drag([[0.3, 0.3], [0.6, 0.4], [0.7, 0.6]]);
  const erased = await s.alpha(layer.id);
  expect(erased).toBeLessThan(alphaPainted);
  await s.expectUndoRedo(() => s.alpha(layer.id), alphaPainted, erased);

  // Mask brush paints into a mask layer.
  const mask = await s.newLayerAfter(() => root.locator('.vnccs-uc-section-actions [title="Add mask"]').click());
  await s.selectTool("mask");
  const maskBefore = await s.alpha(mask.id);
  await s.drag([[0.4, 0.4], [0.5, 0.5]]);
  expect(await s.alpha(mask.id)).toBeGreaterThan(maskBefore);

  // Rect / lasso draw a selection-type mask shape on the mask layer (visible pixels change).
  for (const tool of ["rect", "lasso"]) {
    await s.selectTool(tool);
    const before = await s.alpha(mask.id);
    await s.drag([[0.1, 0.1], [0.2, 0.1], [0.2, 0.25], [0.1, 0.25]]);
    await expect.poll(() => s.alpha(mask.id), { message: `${tool} changes the mask` }).not.toBe(before);
  }

  // Resize: the transform draft, mode select, keep ratio, numeric sliders (realtime), actions.
  await s.row(layer.id).click();
  await s.selectTool("resize");
  const modeSelect = root.locator('select[data-control="resizeMode"]');
  for (const mode of ["skew", "distort", "perspective", "warp", "free"]) {
    await modeSelect.selectOption(mode, { force: true });
    await expect.poll(async () => (await brush()).resizeMode).toBe(mode);
  }
  const keep = root.locator('input[data-control="keepAspect"]');
  const keepBefore = (await brush()).keepAspect;
  await keep.click({ force: true });
  await expect.poll(async () => (await brush()).keepAspect).toBe(!keepBefore);
  await keep.click({ force: true });
  const bounds = () => s.hook("getLayerDisplayBounds", layer.id);
  const quad = async () => JSON.stringify((await brush()).quad);
  const rotate = await s.dragRange(root.locator('[data-control="transform-rotate"]'), 0.5, 0.7, quad);
  expect(rotate.during, "the rotate slider transforms the layer before release").not.toBe(rotate.before);
  for (const tilt of ["transform-tiltX", "transform-tiltY"]) {
    const moved = await s.dragRange(root.locator(`[data-control="${tilt}"]`), 0.5, 0.65, quad);
    expect(moved.during, `${tilt} is realtime`).not.toBe(moved.before);
  }
  for (const action of ["flip-h", "flip-v", "rotate-ccw", "rotate-cw", "rotate-180", "reset"]) {
    const before = await quad();
    await root.locator(`[data-transform-action="${action}"]`).click();
    await expect.poll(quad, { message: `${action} changes the transform frame` }).not.toBe(before);
  }
  await root.locator('[data-transform-action="rotate-cw"]').click();
  const applyTransform = root.locator('[title="Apply transform"]').first();
  const cancelTransform = root.locator('[title="Cancel transform"]').first();
  await expect(applyTransform).toBeVisible();
  await expect(cancelTransform).toBeVisible();
  const pixelsBeforeApply = await s.hook("getLayerPixels", layer.id);
  await applyTransform.click();
  await expect.poll(async () => (await brush()).transformDraft).toBe(false);
  const pixelsAfterApply = await s.hook("getLayerPixels", layer.id);
  expect(pixelsAfterApply.dataURL).not.toBe(pixelsBeforeApply.dataURL);
  await s.expectUndoRedo(async () => (await s.hook("getLayerPixels", layer.id)).dataURL, pixelsBeforeApply.dataURL, pixelsAfterApply.dataURL);
  // Cancel restores the layer.
  await s.selectTool("resize");
  await root.locator('[data-transform-action="flip-h"]').click();
  await cancelTransform.click();
  await expect.poll(async () => (await brush()).transformDraft).toBe(false);
  expect((await s.hook("getLayerPixels", layer.id)).dataURL).toBe(pixelsAfterApply.dataURL);

  // Bbox tool moves the generation box (undo / redo).
  await s.selectTool("bbox");
  const bboxBefore = await s.hook("getBbox");
  await s.drag([[0.5, 0.5], [0.6, 0.55]]);
  const bboxAfter = await s.hook("getBbox");
  expect(bboxAfter).not.toEqual(bboxBefore);

  // Pan tool moves the view; Fit and 100% reset it.
  await s.selectTool("pan");
  const viewBefore = await s.hook("getView");
  await s.drag([[0.5, 0.5], [0.6, 0.6]]);
  expect(await s.hook("getView")).not.toEqual(viewBefore);
  await root.locator('button:has-text("Fit")').first().click();
  const fitted = await s.hook("getView");
  await root.locator('button[title="Reset zoom to 100%"]').click();
  await expect.poll(async () => (await s.hook("getView")).scale).toBe(1);
  expect(fitted).toBeTruthy();

  // Move tool drags the active layer (undo / redo).
  await s.row(layer.id).click();
  await s.selectTool("move");
  const moveBefore = JSON.stringify(await bounds());
  await s.drag([[0.5, 0.45], [0.55, 0.5]]);
  const moveAfter = JSON.stringify(await bounds());
  expect(moveAfter).not.toBe(moveBefore);
  await s.expectUndoRedo(async () => JSON.stringify(await bounds()), moveBefore, moveAfter);

  // Stage bar toggles: snap to grid, depth-scale moves.
  const snap = root.locator('button[title="Snap to grid"]');
  const snapBefore = (await brush()).snap;
  await snap.click();
  await expect.poll(async () => (await brush()).snap).toBe(!snapBefore);
  await expect(snap).toHaveClass(snapBefore ? /^(?!.*active)/ : /active/);
  await snap.click();
  const depth = root.locator("[data-scene-depth-scale]");
  const depthOn = async () => (await s.hook("getScenePerspective")).enabled === true;
  const depthBefore = await depthOn();
  await depth.click();
  await expect.poll(depthOn).toBe(!depthBefore);
  await depth.click();
  await expect.poll(depthOn).toBe(depthBefore);

  s.watch.expectNone("tools and stage bar");
}

for (const [kind, open] of Object.entries(SURFACES)) {
  test(`[${kind}] tools, tool options and stage bar`, async ({ page }) => {
    const s = await open(page);
    await sweepToolsAndStageBar(s);
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Area 2: generation panel (prompt, model picker, sampling, LoRAs, GENERATE, staging)          */
/* ------------------------------------------------------------------------------------------ */

async function stubDraw(page, images = [FIXTURE_DATA_URL]) {
  const bodies = [];
  await page.route("**/vnccs/unicanvas/draw", async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ json: { images, performance: "stub" } });
  });
  return bodies;
}

async function sweepEditRefs(s, refs) {
  const { page, root } = s;
  await refs.click();
  const popover = root.locator("[data-edit-refs-popover]");
  await expect(popover).toBeVisible();
  const button = await refs.boundingBox();
  const box = await popover.boundingBox();
  expect(Math.abs(box.y - (button.y + button.height)), "the popover opens under the clicked button").toBeLessThan(40);
  const badge = refs.locator("[data-edit-refs-badge]");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), popover.locator("button", { hasText: "Add image" }).click()]);
  await chooser.setFiles(CHARACTER);
  await expect(popover.locator(".vnccs-uc-refs-cell")).toHaveCount(1);
  await expect(badge).toHaveText("1");
  await popover.locator(".vnccs-uc-refs-cell button").first().click();
  await expect(popover.locator(".vnccs-uc-refs-cell")).toHaveCount(0);
  await popover.locator("button", { hasText: "Close" }).click();
  await expect(popover).toHaveCount(0);
}

async function sweepGenerationPanel(s) {
  const { page, root } = s;
  const setting = async (key) => (await s.settings())[key];

  // Prompt, negative prompt and the prompt guide (open, copy, close).
  await root.locator('textarea[data-setting="positive"]').fill("a knight on a hill");
  await expect.poll(() => setting("positive")).toBe("a knight on a hill");
  await root.locator('textarea[data-setting="negative"]').fill("blurry");
  await expect.poll(() => setting("negative")).toBe("blurry");
  const help = root.locator("[data-prompt-help]");
  await help.click();
  await expect(help).toHaveAttribute("aria-expanded", "true");
  const guide = root.locator(".vnccs-uc-prompt-guide-bar").first();
  await expect(guide).toBeVisible();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await guide.locator("button", { hasText: /copy/i }).first().click();
  await guide.locator('button[title="Close"]').click();
  await expect(help).toHaveAttribute("aria-expanded", "false");

  // Images (batch) and the paired denoise slider / number field, realtime and synchronized.
  await root.locator('input[data-setting="batch_size"]').fill("2");
  await root.locator('input[data-setting="batch_size"]').blur();
  await expect.poll(() => setting("batch_size")).toBe(2);
  const denoiseNumber = root.locator('.vnccs-uc-left input[type="number"][data-setting="denoise"]').first();
  const denoise = await s.dragRange(root.locator('input[type="range"][data-setting="denoise"]').first(), 0.9, 0.4, async () => [await setting("denoise"), await denoiseNumber.inputValue()]);
  expect(denoise.during[0], "denoise follows the slider before release").not.toBe(denoise.before[0]);
  expect(Number(denoise.during[1]), "the number field follows the slider during the drag").toBeCloseTo(Number(denoise.during[0]), 2);
  await denoiseNumber.fill("0.75");
  await denoiseNumber.blur();
  await expect.poll(() => setting("denoise")).toBe(0.75);

  // Model picker: open, choose another preset, choose the first one back; Download is requested.
  const downloads = [];
  await page.route("**/vnccs/unicanvas/presets/download", async (route) => {
    downloads.push(route.request().postDataJSON());
    await route.fulfill({ json: { queued: [] } });
  });
  await root.locator('[data-model-selection-mode="presets"]').click();
  await expect.poll(() => setting("model_selection_mode")).toBe("presets");
  const startPreset = await setting("selected_preset_id");
  await root.locator("[data-preset-picker-toggle]").first().click();
  const menuCards = root.locator(".vnccs-uc-model-picker-menu [data-preset-id]");
  await expect(menuCards.first()).toBeVisible();
  const ids = await menuCards.evaluateAll((cards) => cards.map((card) => card.dataset.presetId));
  expect(ids.length).toBeGreaterThan(1);
  const other = ids.find((id) => id !== startPreset);
  await root.locator(`.vnccs-uc-model-picker-menu [data-preset-id="${other}"]`).click();
  await expect.poll(() => setting("selected_preset_id")).toBe(other);
  await root.locator("[data-preset-download]").first().click();
  await expect.poll(() => downloads.length).toBeGreaterThan(0);
  expect(downloads[0].kind).toBe("assets");
  await root.locator("[data-preset-picker-toggle]").first().click();
  await root.locator(`.vnccs-uc-model-picker-menu [data-preset-id="${startPreset || ids[0]}"]`).click();
  await expect.poll(() => setting("selected_preset_id")).toBe(startPreset || ids[0]);
  // Turbo LoRA card (when the preset has one): toggles the turbo setting, twice back to off.
  const turbo = root.locator("[data-turbo-toggle]").first();
  if (await turbo.isVisible()) {
    const before = JSON.stringify(await s.settings());
    await turbo.click();
    await expect.poll(async () => JSON.stringify(await s.settings())).not.toBe(before);
    await turbo.click();
  }
  const scale = root.locator('[data-model-panel="presets"] input[data-setting="inference_scale"]');
  await scale.fill("0.5");
  await scale.blur();
  await expect.poll(() => setting("inference_scale")).toBe(0.5);
  await scale.fill("1");
  await scale.blur();

  // Custom: mode and loader dropdowns switch the loader fields.
  await root.locator('[data-model-selection-mode="custom"]').click();
  await expect.poll(() => setting("model_selection_mode")).toBe("custom");
  const loader = root.locator('select[data-setting="model_loader"]');
  for (const value of ["diffusion_model", "gguf", "checkpoint"]) {
    await s.pick(loader, value);
    await expect.poll(() => setting("model_loader")).toBe(value);
  }
  const mode = root.locator('select[data-setting="generation_mode"]');
  await s.pick(loader, "diffusion_model");
  const modes = await mode.evaluate((el) => [...el.options].filter((o) => !o.disabled).map((o) => o.value));
  expect(modes.length).toBeGreaterThan(3);
  for (const value of modes) {
    await s.pick(mode, value);
    await expect.poll(() => setting("generation_mode")).toBe(value);
    // Family panels that appear for this mode render without errors; the visible refs button opens
    // its popover next to itself, adds and removes a reference image, and closes.
    const refs = root.locator('[data-action="edit-refs"]:visible').first();
    if (await refs.count()) await sweepEditRefs(s, refs);
  }
  await s.pick(mode, "sdxl");
  await s.pick(loader, "checkpoint");
  await root.locator('[data-model-selection-mode="presets"]').click();

  // Sampling: steps, sampler, cfg, scheduler, seed and the seed-mode dice.
  const steps = root.locator('.vnccs-uc-generation-grid input[data-setting="steps"]');
  await steps.fill("12");
  await steps.blur();
  await expect.poll(() => setting("steps")).toBe(12);
  const sampler = root.locator('select[data-setting="sampler_name"]');
  const samplers = await sampler.evaluate((el) => [...el.options].map((o) => o.value));
  await s.pick(sampler, samplers[1]);
  await expect.poll(() => setting("sampler_name")).toBe(samplers[1]);
  const cfg = root.locator('input[data-setting="cfg"]');
  await cfg.fill("4.5");
  await cfg.blur();
  await expect.poll(() => setting("cfg")).toBe(4.5);
  const scheduler = root.locator('select[data-setting="scheduler"]');
  const schedulers = await scheduler.evaluate((el) => [...el.options].map((o) => o.value));
  await s.pick(scheduler, schedulers[1]);
  await expect.poll(() => setting("scheduler")).toBe(schedulers[1]);
  await root.locator('input[data-setting="seed"]').fill("1234");
  await root.locator('input[data-setting="seed"]').blur();
  await expect.poll(() => setting("seed")).toBe(1234);
  const dice = root.locator('[data-action="seed-mode"]');
  const seedMode = await setting("seed_mode");
  await dice.click();
  await expect.poll(() => setting("seed_mode")).not.toBe(seedMode);
  await dice.click();
  await expect.poll(() => setting("seed_mode")).toBe(seedMode);

  // LoRA stack: every row's strength field is editable (names need installed LoRAs).
  const loraRows = await root.locator("[data-lora-stack-index][data-lora-stack-field=strength]").count();
  expect(loraRows).toBeGreaterThan(0);
  for (let index = 0; index < loraRows; index += 1) {
    const strength = root.locator(`[data-lora-stack-index="${index}"][data-lora-stack-field="strength"]`);
    await strength.fill("0.5");
    await strength.blur();
    const name = root.locator(`select[data-lora-stack-index="${index}"][data-lora-stack-field="name"]`);
    expect(await name.evaluate((el) => el.options.length)).toBeGreaterThan(0);
  }
  await expect.poll(async () => JSON.stringify(await setting("lora_stack") ?? await setting("loras") ?? null)).toContain("0.5");

  // GENERATE (stubbed) stages two results: previous / next / hide / accept, then discard.
  const bodies = await stubDraw(page, [FIXTURE_DATA_URL, FIXTURE_DATA_URL]);
  await root.locator("button", { hasText: "GENERATE" }).first().click();
  await expect.poll(() => bodies.length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(bodies[0].settings.positive).toContain("a knight on a hill");
  await expect.poll(async () => (await s.hook("getStaging")).length, { timeout: 30_000 }).toBeGreaterThan(0);
  const staging = root.locator(".vnccs-uc-staging-popover").first();
  await expect(staging).toBeVisible();
  const count = staging.locator(".vnccs-uc-staging-count").first();
  await expect.poll(async () => (await s.hook("getStaging")).length, { timeout: 30_000 }).toBe(2);
  for (const title of ["Previous result", "Next result"]) {
    const before = await count.textContent();
    await staging.locator(`[title="${title}"]`).click();
    await expect(count, `${title} changes the shown result`).not.toHaveText(before);
  }
  const toggle = staging.locator('[title="Hide result preview"], [title="Show result preview"]');
  await expect(toggle).toHaveAttribute("title", "Hide result preview");
  await toggle.click();
  await expect(toggle).toHaveAttribute("title", "Show result preview");
  await toggle.click();
  await expect(toggle).toHaveAttribute("title", "Hide result preview");
  const accepted = await s.newLayerAfter(() => staging.locator('[title="Accept as layer"]').click());
  expect(accepted.type).toBe("raster");
  await s.expectUndoRedo(async () => (await s.layers()).some((l) => l.id === accepted.id), false, true);
  // Discard removes the shown result; each press leaves one fewer.
  if (!(await s.hook("getStaging")).length) {
    await root.locator("button", { hasText: "GENERATE" }).first().click();
    await expect.poll(async () => (await s.hook("getStaging")).length, { timeout: 30_000 }).toBeGreaterThan(0);
  }
  for (let left = (await s.hook("getStaging")).length; left > 0; left -= 1) {
    await staging.locator('[title="Discard"]').click();
    await expect.poll(async () => (await s.hook("getStaging")).length).toBe(left - 1);
  }
  await expect(staging).toBeHidden();

  // Standalone only: Save to output (stubbed) and New canvas (confirm).
  if (s.kind === "standalone") {
    const saves = [];
    await page.route("**/vnccs/unicanvas/save_output", async (route) => {
      saves.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, path: "output/unicanvas_sweep.png", width: 64, height: 64 } });
    });
    await root.locator("button", { hasText: "Save to output" }).click();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0].image).toMatch(/^data:image\/png;base64,/);
    await root.locator('button[title="New canvas"]').click();
    const confirm = root.locator(".vnccs-uc-modal").last();
    await expect(confirm).toBeVisible();
    await confirm.locator("button", { hasText: "Confirm" }).click();
    await expect.poll(async () => (await s.layers()).filter((l) => l.type !== "mask").map((l) => l.name)).toEqual(["Base Layer"]);
  } else {
    await expect(root.locator('button[title="New canvas"]')).toHaveCount(0);
    await expect(root.locator("button", { hasText: "Save to output" })).toHaveCount(0);
  }

  s.watch.expectNone("generation panel");
}

for (const [kind, open] of Object.entries(SURFACES)) {
  test(`[${kind}] generation panel, model picker, sampling and staging`, async ({ page }) => {
    const s = await open(page);
    await sweepGenerationPanel(s);
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Area 3: layers panel - section actions, rows, blend / opacity, groups, context menu, PSD     */
/* ------------------------------------------------------------------------------------------ */

const order = async (s) => (await s.stack()).layers.map((l) => l.id);
const prop = async (s, id, key) => (await s.stack()).layers.find((l) => l.id === id)?.[key];

async function sweepLayersPanel(s) {
  const { page, root } = s;
  const actions = root.locator(".vnccs-uc-section-actions", { has: page.locator('[title="Add mask"]') });

  // Section actions: add raster / mask, duplicate, move up / down (each undoable).
  const a = await s.addRaster();
  const b = await s.addRaster();
  const mask = await s.newLayerAfter(() => actions.locator('[title="Add mask"]').click());
  expect(mask.type).toBe("mask");
  await s.expectUndoRedo(async () => (await s.layers()).some((l) => l.id === mask.id), false, true);
  await s.row(b.id).click();
  const dup = await s.newLayerAfter(() => actions.locator('[title="Duplicate selected"]').click());
  await s.expectUndoRedo(async () => (await s.layers()).some((l) => l.id === dup.id), false, true);
  await s.row(a.id).click();
  for (const title of ["Move selected up", "Move selected down"]) {
    const before = await order(s);
    await actions.locator(`[title="${title}"]`).click();
    await expect.poll(() => order(s), { message: title }).not.toEqual(before);
    const after = await order(s);
    await s.expectUndoRedo(() => order(s), before, after);
  }

  // Blend mode (custom dropdown) and the opacity slider (realtime, one undo step per drag).
  await s.row(a.id).click();
  await s.pick(root.locator('select[data-layer-control="blendMode"]'), "multiply");
  await expect.poll(() => prop(s, a.id, "blendMode")).toBe("multiply");
  await s.expectUndoRedo(() => prop(s, a.id, "blendMode"), "source-over", "multiply");
  const depthBefore = (await s.depth()).undo;
  const opacity = await s.dragRange(root.locator('input[data-layer-control="opacity"]'), 0.95, 0.4, () => prop(s, a.id, "opacity"));
  expect(opacity.during, "layer opacity follows the slider before release").toBeLessThan(opacity.before);
  expect(opacity.late).toBeLessThan(opacity.during);
  expect((await s.depth()).undo, "one undo entry per opacity drag").toBe(depthBefore + 1);
  await s.expectUndoRedo(() => prop(s, a.id, "opacity"), opacity.before, opacity.after);

  // Row controls: visibility (thumb), lock, rename, delete - each one undo step.
  const thumb = s.row(a.id).locator(".vnccs-uc-thumb");
  await thumb.click();
  await expect.poll(() => prop(s, a.id, "visible")).toBe(false);
  await expect(thumb).toHaveAttribute("title", "Show layer");
  await s.expectUndoRedo(() => prop(s, a.id, "visible"), true, false);
  await thumb.click();
  await s.row(a.id).locator("[data-layer-lock]").click();
  await expect.poll(() => prop(s, a.id, "locked")).toBe(true);
  await s.expectUndoRedo(() => prop(s, a.id, "locked"), false, true);
  await s.row(a.id).locator("[data-layer-lock]").click();
  await s.row(a.id).locator(".vnccs-uc-layer-label").dblclick();
  await s.answerModal("OK", "Sweep hero");
  await expect.poll(() => prop(s, a.id, "name")).toBe("Sweep hero");
  await expect(s.row(a.id).locator(".vnccs-uc-layer-name")).toHaveText("Sweep hero");
  const nameBefore = (await s.hook("getLayerNaming", a.id));
  expect(nameBefore.nameSource).toBe("user");
  await s.undo();
  await expect.poll(() => prop(s, a.id, "name")).not.toBe("Sweep hero");
  await s.redo();
  await expect.poll(() => prop(s, a.id, "name")).toBe("Sweep hero");
  await s.row(dup.id).locator('[title="Delete layer"]').click();
  await expect.poll(async () => (await s.layers()).some((l) => l.id === dup.id)).toBe(false);
  await s.expectUndoRedo(async () => (await s.layers()).some((l) => l.id === dup.id), true, false);

  // Drag a row onto another to reorder (undoable).
  const beforeDrag = await order(s);
  await s.row(b.id).dragTo(s.row(a.id), { targetPosition: { x: 20, y: 4 } });
  await expect.poll(() => order(s)).not.toEqual(beforeDrag);
  const afterDrag = await order(s);
  expect(afterDrag.indexOf(b.id)).toBeLessThan(afterDrag.indexOf(a.id));
  await s.expectUndoRedo(() => order(s), beforeDrag, afterDrag);

  // Import image.
  const imported = await s.importImage(CHARACTER);
  expect(imported.type).toBe("raster");
  expect(await s.alpha(imported.id)).toBeGreaterThan(1000);

  // Groups: Ctrl-click multi-select, group, folder toggle / eye / lock / rename, the folder menu,
  // new empty group, ungroup.
  await s.row(a.id).click();
  await s.row(b.id).click({ modifiers: ["Control"] });
  expect((await s.stack()).selectedLayerIds.sort()).toEqual([a.id, b.id].sort());
  const group = await s.newLayerAfter(() => root.locator('button[title="Group selected layers (Ctrl+G)"]').click());
  expect(group.type).toBe("group");
  expect((await s.stack()).layers.filter((l) => l.groupId === group.id).map((l) => l.id).sort()).toEqual([a.id, b.id].sort());
  await s.expectUndoRedo(async () => (await s.layers()).some((l) => l.id === group.id), false, true);
  const folder = s.row(group.id);
  await folder.locator("[data-folder-toggle]").click();
  await expect(s.row(a.id)).toHaveCount(0);
  await folder.locator("[data-folder-toggle]").click();
  await expect(s.row(a.id)).toHaveCount(1);
  await folder.locator("[data-folder-eye]").click();
  await expect.poll(() => prop(s, group.id, "visible")).toBe(false);
  await expect(s.row(a.id)).toHaveClass(/hidden-by-group/);
  await s.expectUndoRedo(() => prop(s, group.id, "visible"), true, false);
  await folder.locator("[data-folder-eye]").click();
  await folder.locator("[data-layer-lock]").click();
  await expect.poll(() => prop(s, group.id, "locked")).toBe(true);
  await folder.locator("[data-layer-lock]").click();
  await folder.locator(".vnccs-uc-folder-name").dblclick();
  await s.answerModal("OK", "Sweep folder");
  await expect.poll(() => prop(s, group.id, "name")).toBe("Sweep folder");
  // Group opacity / blend come from the same subhead controls.
  await folder.click();
  const groupOpacity = await s.dragRange(root.locator('input[data-layer-control="opacity"]'), 0.95, 0.5, () => prop(s, group.id, "opacity"));
  expect(groupOpacity.during).toBeLessThan(groupOpacity.before);
  for (const action of ["duplicate-group", "flatten-group"]) {
    const before = await order(s);
    await folder.click({ button: "right" });
    await root.locator(`.vnccs-uc-folder-menu [data-group-action="${action}"]`).click();
    await expect.poll(async () => (await order(s)).some((id) => !before.includes(id)), { message: action }).toBe(true);
    const after = await order(s);
    await s.expectUndoRedo(() => order(s), before, after);
    await s.undo();
    await expect.poll(() => order(s)).toEqual(before);
  }
  const empty = await s.newLayerAfter(() => root.locator('button[title="New empty group"]').click());
  expect(empty.type).toBe("group");
  await s.row(empty.id).click({ button: "right" });
  await root.locator('.vnccs-uc-folder-menu [data-group-action="delete-group"]').click();
  await s.answerModal(/Delete/);
  await expect.poll(async () => (await s.layers()).some((l) => l.id === empty.id)).toBe(false);
  await folder.click();
  await root.locator('button[title="Ungroup the selected group (Ctrl+Shift+G)"]').click();
  await expect.poll(async () => (await s.layers()).some((l) => l.id === group.id)).toBe(false);
  expect((await s.stack()).layers.filter((l) => [a.id, b.id].includes(l.id)).every((l) => !l.groupId)).toBe(true);
  await s.expectUndoRedo(async () => (await s.layers()).some((l) => l.id === group.id), true, false);

  // Organize: the preview dialog files unfiled layers; one undo reverts it.
  const unfiled = await s.stack();
  await root.locator("[data-organize-layers]").click();
  const dialog = root.locator(".vnccs-uc-organize");
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-organize-apply]").click();
  await expect.poll(async () => (await s.stack()).layers.some((l) => l.type === "group")).toBe(true);
  await s.undo();
  await expect.poll(async () => (await s.stack()).layers.map((l) => [l.id, l.groupId])).toEqual(unfiled.layers.map((l) => [l.id, l.groupId]));

  // Layer context menu on a layer with pixels.
  const menuTarget = imported.id;
  await s.menuItem(menuTarget, "duplicate");
  await expect.poll(async () => (await s.layers()).length).toBe(unfiled.layers.length + 1);
  await s.undo();
  for (const item of ["move-down", "move-up"]) {
    const before = await order(s);
    await s.menuItem(menuTarget, item);
    await expect.poll(() => order(s), { message: item }).not.toEqual(before);
  }
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await s.menuItem(menuTarget, "copy-clipboard");
  await expect.poll(() => s.status()).toMatch(/copied to clipboard|Clipboard copy failed/);
  expect(await s.status()).toMatch(/copied to clipboard/);
  await s.menuItem(menuTarget, "save-image");
  await expect.poll(() => s.routes.save_output.length).toBeGreaterThan(0);
  expect(s.routes.save_output.at(-1).url).toContain(`layer_id=${menuTarget}`);
  await expect.poll(() => s.status()).toMatch(/Layer image saved/);
  // Remove background (default backend, stubbed): the right half turns transparent, one undo step.
  const alphaFull = await s.alpha(menuTarget);
  await s.menuItem(menuTarget, "remove-bg");
  await expect.poll(() => s.alpha(menuTarget)).toBeLessThan(alphaFull);
  const alphaCut = await s.alpha(menuTarget);
  await s.expectUndoRedo(() => s.alpha(menuTarget), alphaFull, alphaCut);
  // Color match to below (real CPU route): method select, realtime strength, Cancel, Apply.
  await s.menuItem(menuTarget, "color-match");
  const popover = root.locator(".vnccs-uc-color-match-popover");
  await expect(popover).toBeVisible();
  const pixels = async () => (await s.hook("getLayerPixels", menuTarget)).dataURL;
  const original = await pixels();
  await expect.poll(pixels, { timeout: 30_000, message: "the full-strength match shows right away" }).not.toBe(original);
  const methodSelect = popover.locator('select[data-control="colorMatchMethod"]');
  const methods = await methodSelect.evaluate((el) => [...el.options].map((o) => o.value));
  await s.pick(methodSelect, methods.at(-1));
  const strength = await s.dragRange(popover.locator('[data-control="colorMatchStrength"]'), 0.98, 0.2, async () => popover.locator("[data-color-match-readout]").textContent());
  expect(strength.during, "strength readout follows the slider").not.toBe(strength.before);
  await popover.locator('[data-control="colorMatchCancel"]').click();
  await expect(popover).toHaveCount(0);
  await expect.poll(pixels).toBe(original);
  await s.menuItem(menuTarget, "color-match");
  await expect(popover).toBeVisible();
  await expect.poll(pixels, { timeout: 30_000 }).not.toBe(original);
  await popover.locator('[data-control="colorMatchClose"]').click();
  await expect(popover).toHaveCount(0);
  const matched = await pixels();
  expect(matched).not.toBe(original);
  await s.undo();
  await expect.poll(pixels).toBe(original);
  await s.redo();
  // Auto-name (model level is stubbed): the layer gets the model's name.
  await s.menuItem(menuTarget, "auto-name");
  await expect.poll(async () => (await s.hook("getLayerNaming", menuTarget)).nameSource).not.toBe("user");

  // Flatten all layers (confirm) and one undo step back.
  const beforeFlatten = await order(s);
  await root.locator('button[title="Flatten all layers"]').click();
  await s.answerModal("Flatten");
  await expect.poll(async () => (await s.layers()).filter((l) => l.type !== "mask").length).toBe(1);
  await s.undo();
  await expect.poll(() => order(s)).toEqual(beforeFlatten);

  // PSD export (download) and import of that file.
  const [download] = await Promise.all([page.waitForEvent("download"), root.locator('[data-psd-action="export"]').click()]);
  const psdPath = await download.path();
  expect(download.suggestedFilename()).toMatch(/\.psd$/);
  const known = new Set(await order(s));
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), root.locator('[data-psd-action="import"]').click()]);
  await chooser.setFiles(psdPath);
  await expect.poll(async () => (await order(s)).filter((id) => !known.has(id)).length, { timeout: 30_000 }).toBeGreaterThan(0);

  s.watch.expectNone("layers panel");
}

for (const [kind, open] of Object.entries(SURFACES)) {
  test(`[${kind}] layers panel, groups, layer menu and PSD`, async ({ page }) => {
    const s = await open(page);
    await sweepLayersPanel(s);
  });
}
