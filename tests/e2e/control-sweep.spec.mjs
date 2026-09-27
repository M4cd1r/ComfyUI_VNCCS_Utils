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
    // Family panels that appear for this mode render without errors; the edit-refs button opens.
    const refs = root.locator('[data-action="edit-refs"]:visible').first();
    if (await refs.count()) {
      await refs.click();
      const modal = root.locator(".vnccs-uc-modal").last();
      await expect(modal).toBeVisible();
      await modal.locator("button", { hasText: /^(Close|Cancel|Done)$/ }).first().click();
      await expect(modal).toBeHidden();
    }
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
  for (const title of ["Next result", "Previous result"]) {
    const button = staging.locator(`[title="${title}"]`);
    if (await button.isEnabled()) await button.click();
  }
  const hide = staging.locator('[title="Hide result preview"]');
  await hide.click();
  await hide.click();
  const accepted = await s.newLayerAfter(() => staging.locator('[title="Accept as layer"]').click());
  expect(accepted.type).toBe("raster");
  await s.expectUndoRedo(async () => (await s.layers()).some((l) => l.id === accepted.id), false, true);
  if ((await s.hook("getStaging")).length) {
    await staging.locator('[title="Discard"]').click();
    await expect.poll(async () => (await s.hook("getStaging")).length).toBe(0);
  } else {
    await root.locator("button", { hasText: "GENERATE" }).first().click();
    await expect.poll(async () => (await s.hook("getStaging")).length, { timeout: 30_000 }).toBeGreaterThan(0);
    await staging.locator('[title="Discard"]').click();
    await expect.poll(async () => (await s.hook("getStaging")).length).toBe(0);
  }

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
