import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { openUnicanvas } from "./helpers/app.mjs";

// Issue #45: the ControlNet layer. Offered only for a family that declares a ControlNet
// (capabilities.control_net from /vnccs/unicanvas/assets), holds an imported control image, its
// strength slider is realtime, and GENERATE sends `control` with the draw. No GPU: the draw route
// is stubbed and only the request body is checked.
const FIXTURE = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const FIXTURE_DATA_URL = `data:image/png;base64,${readFileSync(FIXTURE).toString("base64")}`;
const SHELL = ".vnccs-uc2-standalone-shell";

async function chooseSetting(page, setting, value) {
  await page.evaluate(([key, next]) => {
    const select = document.querySelector(`.vnccs-uc2-standalone-shell select[data-setting="${key}"]`);
    select.value = next;
    select.dispatchEvent(new Event("input", { bubbles: true }));
  }, [setting, value]);
}

async function selectFamily(page, mode) {
  await page.locator(`${SHELL} [data-model-selection-mode="custom"]`).first().click();
  await chooseSetting(page, "model_loader", "diffusion_model");
  await chooseSetting(page, "generation_mode", mode);
}

test("ControlNet layer: offered per family, import, realtime strength, and sent with GENERATE", async ({ page }) => {
  await openUnicanvas(page);
  const add = page.locator(`${SHELL} [data-control-add]`);

  // SDXL has no ControlNet: no "New ControlNet layer".
  await selectFamily(page, "sdxl");
  await expect(add).toBeHidden();

  // Z-Image declares one: the action appears.
  await selectFamily(page, "z_image");
  await expect(add).toBeVisible({ timeout: 30_000 });
  await add.click();
  const row = page.locator(`${SHELL} .vnccs-uc-layer[data-layer-type="control"]`);
  await expect(row).toHaveCount(1);
  const panel = page.locator(`${SHELL} [data-control-panel]`);
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-control-field="type"] option')).toContainText(["Canny", "Depth", "Pose"]);

  // Import a control image into the layer.
  const chooser = page.waitForEvent("filechooser");
  await panel.locator("[data-control-import]").click();
  await (await chooser).setFiles(FIXTURE);
  await expect.poll(() => page.evaluate(() => {
    const layer = globalThis.__VNCCS_UC_E2E__?.listLayers?.().find((item) => item.type === "control");
    return layer ? layer.id : null;
  })).not.toBeNull();

  // The strength value follows the slider while dragging, before release.
  const slider = panel.locator('[data-control-field="strength"]');
  const value = panel.locator('[data-control-value="strength"]');
  const box = await slider.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 4 });
  const during = Number(await value.textContent());
  expect(during).toBeLessThan(1);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 4 });
  expect(Number(await value.textContent())).toBeLessThan(during);
  await page.mouse.up();
  const strength = Number(await value.textContent());

  // GENERATE sends the control image with type and strength.
  let body = null;
  await page.route("**/vnccs/unicanvas/draw", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ images: [FIXTURE_DATA_URL], performance: "stub" }) });
  });
  await page.locator(`${SHELL} textarea[data-setting="positive"]`).fill("a woman in a red hat");
  await page.locator(`${SHELL} button`, { hasText: "GENERATE" }).first().click();
  await expect.poll(() => body !== null, { timeout: 30_000 }).toBe(true);
  expect(body.control).toBeTruthy();
  expect(body.control.type).toBe("canny");
  expect(body.control.strength).toBeCloseTo(strength, 2);
  expect(body.control.image).toMatch(/^data:image\/png;base64,/);
  expect(body.settings.generation_mode).toBe("z_image");

  // Switching to a family without ControlNet keeps the layer, marks it inactive and sends nothing.
  await page.locator(`${SHELL} [title="Discard"]`).first().click().catch(() => {});
  await selectFamily(page, "sdxl");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveClass(/inactive/);
  body = null;
  await page.locator(`${SHELL} button`, { hasText: "GENERATE" }).first().click();
  await expect.poll(() => body !== null, { timeout: 30_000 }).toBe(true);
  expect(body.control).toBeUndefined();
});
