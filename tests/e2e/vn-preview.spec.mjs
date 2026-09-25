import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { importImageLayer, openPoseTool, openUnicanvas, poseLayer } from "./helpers/app.mjs";

// Plan 07 (#10): the VN preview overlay is a preview only. It shows on the stage canvas and
// never reaches save to output, flatten or a generation request.
const FIXTURE = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const FIXTURE_DATA_URL = `data:image/png;base64,${readFileSync(FIXTURE).toString("base64")}`;
const shell = ".vnccs-uc2-standalone-shell";
const toggle = `${shell} [title="VN preview (P)"]`;
const stage = `${shell} canvas.vnccs-uc-stage`;

const vn = (page) => page.evaluate(() => globalThis.__VNCCS_UC_E2E__.getVnPreview());

async function setVnOn(page, on) {
  const btn = page.locator(toggle).first();
  if (((await btn.getAttribute("aria-pressed")) === "true") !== on) await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", on ? "true" : "false");
  if (on) await expect.poll(async () => (await vn(page))?.lines?.length ?? 0).toBeGreaterThan(0);
  await page.mouse.click(3, 3); // close the popover
  await page.waitForTimeout(150);
}

async function setSelect(page, name, value) {
  const popover = page.locator(".vnccs-uc-vnp-popover");
  if (!(await popover.count())) await page.locator(toggle).first().click({ button: "right" });
  await page.locator(`.vnccs-uc-vnp-popover select[data-vnp="${name}"]`).evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

/** RGBA of the stage canvas at a CSS-pixel point relative to the canvas. */
function stagePixel(page, x, y) {
  return page.locator(stage).first().evaluate((canvas, [px, py]) => {
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    return [...canvas.getContext("2d").getImageData(Math.round(px * scale), Math.round(py * scale), 1, 1).data];
  }, [x, y]);
}

test("the overlay draws on the stage but never reaches save, flatten or the generation payload", async ({ page }) => {
  await openUnicanvas(page);
  await importImageLayer(page, FIXTURE);
  await page.waitForTimeout(500);

  // Stage pixels: the textbox area changes when the overlay is on.
  await setVnOn(page, true);
  const on = await vn(page);
  const probe = { x: on.textbox.x + on.textbox.width / 2 + 2, y: on.textbox.y + 6 }; // canvas-local CSS px
  const onPixel = await stagePixel(page, probe.x, probe.y);
  await setVnOn(page, false);
  const offPixel = await stagePixel(page, probe.x, probe.y);
  expect(onPixel).not.toEqual(offPixel);

  // Save to output: same image with the overlay on and off.
  const saved = [];
  await page.route("**/vnccs/unicanvas/save_output", async (route) => {
    saved.push(JSON.parse(route.request().postData()).image);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ path: "output/stub.png", width: 1, height: 1 }) });
  });
  const saveButton = page.locator(`${shell} button`, { hasText: "Save to output" }).first();
  await saveButton.click();
  await expect.poll(() => saved.length).toBe(1);
  await setVnOn(page, true);
  await saveButton.click();
  await expect.poll(() => saved.length).toBe(2);
  expect(saved[1]).toBe(saved[0]);

  // Generation payload: the request image is identical with the overlay on and off.
  const drawn = [];
  await page.route("**/vnccs/unicanvas/draw", async (route) => {
    const body = JSON.parse(route.request().postData());
    drawn.push({ image: body.image, hasVnSettings: Boolean(body.settings && "vn_preview" in body.settings) });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ images: [FIXTURE_DATA_URL], performance: "stub" }) });
  });
  const generate = page.locator(`${shell} button`, { hasText: "GENERATE" }).first();
  const discard = page.locator(`${shell} [title="Discard"]`).first();
  await generate.click();
  await expect(discard).toBeVisible({ timeout: 30_000 });
  await discard.click();
  await setVnOn(page, false);
  await generate.click();
  await expect(discard).toBeVisible({ timeout: 30_000 });
  await discard.click();
  expect(drawn).toHaveLength(2);
  expect(drawn[0].image).toBeTruthy();
  expect(drawn[0].image).toBe(drawn[1].image);
  expect(drawn.some((d) => d.hasVnSettings)).toBe(false);

  // Flatten: the master layer is pixel-identical with the overlay on and off.
  const flatten = async () => {
    await page.locator(`${shell} button`, { hasText: "Flatten layers" }).first().click();
    await page.locator("button", { hasText: /^Flatten$/ }).last().click();
    await expect.poll(async () => (await page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers())).filter((l) => l.type !== "mask").length).toBe(1);
    const [master] = (await page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers())).filter((l) => l.type !== "mask");
    return (await page.evaluate((id) => globalThis.__VNCCS_UC_E2E__.getLayerPixels(id), master.id)).dataURL;
  };
  const flatOff = await flatten();
  await page.locator(stage).first().click({ position: { x: 5, y: 5 }, button: "middle" });
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers())).length).toBeGreaterThan(1);
  await setVnOn(page, true);
  const flatOn = await flatten();
  expect(flatOn).toBe(flatOff);
});

test("max lines wraps inside the textbox and 9:16 changes the frame aspect", async ({ page }) => {
  await openUnicanvas(page);
  await setVnOn(page, true);
  await setSelect(page, "textLength", "max_lines");
  await expect.poll(async () => (await vn(page)).textLength).toBe("max_lines");
  const state = await vn(page);
  expect(state.lines.length).toBe(state.maxLines);
  expect(state.overflow).toBe(false);
  for (const line of state.lines) {
    expect(line.x).toBeGreaterThanOrEqual(state.textbox.x);
    expect(line.x + line.width).toBeLessThanOrEqual(state.textbox.x + state.textbox.width);
    expect(line.y).toBeGreaterThanOrEqual(state.textbox.y);
    expect(line.y + line.height).toBeLessThanOrEqual(state.textbox.y + state.textbox.height);
  }

  expect(state.frame.width / state.frame.height).toBeCloseTo(16 / 9, 2);
  await setSelect(page, "preset", "9x16_1920");
  await expect.poll(async () => {
    const { frame } = await vn(page);
    return Number((frame.width / frame.height).toFixed(3));
  }).toBeCloseTo(9 / 16, 2);
  const portrait = await vn(page);
  expect(portrait.frameScreen.height).toBeGreaterThan(portrait.frameScreen.width);
  // The P shortcut toggles the overlay while the canvas has focus.
  await page.locator(stage).first().focus();
  await page.keyboard.press("p");
  await expect(page.locator(toggle).first()).toHaveAttribute("aria-pressed", "false");
});

test("a character whose face sits under the textbox is flagged, and the flag clears live while dragging up", async ({ page }) => {
  await openUnicanvas(page);
  await openPoseTool(page);
  const pose = await poseLayer(page);
  await page.keyboard.press("Enter"); // leave the pose editor, keep the layer
  await expect.poll(() => page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers().length)).toBeGreaterThan(1);
  await setVnOn(page, true);
  await page.locator(`${shell} .vnccs-uc-tool[data-tool="move"]`).click();

  const face = async () => (await vn(page)).characters.find((c) => c.id === pose.id)?.face;
  await expect.poll(async () => Boolean(await face())).toBe(true);
  const box = (await vn(page)).textbox;
  expect((await vn(page)).flaggedLayerIds).not.toContain(pose.id); // the new pose's face starts above the textbox
  let f = await face();
  const canvasBox = await page.locator(stage).first().boundingBox();
  const drag = async (dy, release = true) => {
    // getVnPreview() rects are canvas-local CSS pixels.
    const start = { x: canvasBox.x + f.x + f.width / 2, y: canvasBox.y + f.y + f.height + 40 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y + dy, { steps: 12 });
    if (release) await page.mouse.up();
  };

  // Move the character down until its face is under the textbox.
  await drag(box.y + box.height / 2 - (f.y + f.height / 2));
  await expect.poll(async () => (await vn(page)).flaggedLayerIds).toContain(pose.id);
  f = await face();

  // Drag it back up: the flag clears during the drag, before the release.
  await drag(-(box.height + f.height + 120), false);
  await expect.poll(async () => (await vn(page)).flaggedLayerIds).not.toContain(pose.id);
  await page.mouse.up();
  await expect.poll(async () => (await vn(page)).flaggedLayerIds).not.toContain(pose.id);
});
