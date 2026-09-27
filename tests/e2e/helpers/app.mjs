import { expect } from "@playwright/test";

export const LAYER_TYPES = { pose: "pose" };

// The standalone sidebar tab is a ComfyUI setting, enabled by default.
export const STANDALONE_SETTING_ID = "VNCCS.UniCanvas.StandaloneSidebar";
const UNICANVAS_TAB =
  '[data-testid="vnccs-unicanvas-standalone-tab-button"], .vnccs-unicanvas-sidebar-icon';
const POSE_TOOL = '.vnccs-uc-layers-section [title="Add pose layer"]';
const POSE_DOCK = ".vnccs-uc-pose-side .vnccs-uc-pose-dock";

export async function setStandaloneSidebar(page, enabled) {
  const response = await page.request.post(`/api/settings/${STANDALONE_SETTING_ID}`, { data: enabled });
  expect(response.ok()).toBeTruthy();
}

// ComfyUI may greet a fresh profile with a modal (templates, release notes) that swallows clicks.
async function dismissComfyDialogs(page) {
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
}

/**
 * Open the standalone Unicanvas sidebar tab and wait for the widget chrome.
 * `navigate: false` skips the page load so a spec can keep the document.
 */
export async function openUnicanvas(page, { navigate = true } = {}) {
  if (navigate) {
    await setStandaloneSidebar(page, true);
    await page.goto("/", { waitUntil: "domcontentloaded" });
  }
  const tab = page.locator(UNICANVAS_TAB).first();
  await expect(tab).toBeVisible({ timeout: 60_000 });
  await dismissComfyDialogs(page);
  await tab.click();
  await expect(page.locator(".vnccs-uc2-standalone-shell .vnccs-uc-left")).toBeVisible({ timeout: 30_000 });
}

/**
 * An "outside" click that closes UniCanvas popovers: an empty stretch of the stage's top bar.
 * Not a page corner - ComfyUI's workflow tab sits there beside the standalone tab, and its
 * hover preview (a ComfyUI popover, above the tab) would then cover the widget. Not the bar's
 * middle either: the New canvas button sits there. The point is the middle of the widest gap
 * between the bar's controls, read from the live layout.
 */
export async function clickOutsidePopovers(page) {
  const point = await page.evaluate(() => {
    const bar = document.querySelector(".vnccs-uc2-standalone-shell .vnccs-uc-bottom");
    const box = bar.getBoundingClientRect();
    const y = box.y + Math.min(6, box.height / 2);
    const spans = [...bar.querySelectorAll("button, select, input, label, [role=button]")]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => [r.left, r.right])
      .sort((a, b) => a[0] - b[0]);
    let best = { from: box.left, to: box.left };
    let cursor = box.left;
    for (const [left, right] of [...spans, [box.right, box.right]]) {
      if (left - cursor > best.to - best.from) best = { from: cursor, to: left };
      cursor = Math.max(cursor, right);
    }
    return { x: (best.from + best.to) / 2, y };
  });
  await page.mouse.click(point.x, point.y);
}

/** Import an image file as a raster layer through the Layers "Import Image" button. */
export async function importImageLayer(page, filePath) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator('button[title="Import image"]').first().click(),
  ]);
  await chooser.setFiles(filePath);
  await expect
    .poll(async () => (await page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers())).length, { timeout: 15_000 })
    .toBeGreaterThan(2);
}

/**
 * Select the Pose Studio tool: it creates a live pose layer over the bbox (or reopens the
 * active one) and waits until the embedded editor has rendered the mannequin once.
 */
export async function openPoseTool(page) {
  await page.locator(POSE_TOOL).click();
  await expect(page.locator(POSE_DOCK)).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => page.evaluate(() => globalThis.__VNCCS_UC_E2E__.getPoseBackdrop()?.distance ?? null), { timeout: 90_000 })
    .not.toBeNull();
}

export async function poseLayer(page) {
  const layers = await page.evaluate(() => globalThis.__VNCCS_UC_E2E__.listLayers());
  return layers.find((layer) => layer.type === LAYER_TYPES.pose) || null;
}

/**
 * Layer naming settings (gear popover, "Layer names" section): `level` is "off" | "rules" |
 * "model", `autoFile` the "Auto-file new layers into folders" checkbox. Specs that count new
 * layers or build their own folders turn auto-filing off first.
 */
export async function setLayerNaming(page, { level, autoFile } = {}) {
  const shell = ".vnccs-uc2-standalone-shell";
  await page.locator(`${shell} .vnccs-uc-gear`).first().click();
  const panel = page.locator(".vnccs-uc-settings-popover");
  await expect(panel).toHaveCount(1);
  const section = panel.locator("details.vnccs-uc-settings-section", { has: page.locator("summary", { hasText: "Layer names" }) });
  if (!(await section.evaluate((details) => details.open))) await section.locator("summary").click();
  if (level) await section.locator('select[data-naming-level]').selectOption(level, { force: true });
  if (autoFile !== undefined) await section.getByLabel("Auto-file new layers into folders").setChecked(autoFile, { force: true });
  await panel.locator('button:has-text("Close")').click();
  await expect(panel).toHaveCount(0);
}

/**
 * Add a mannequin in the embedded Pose Studio: the slot buttons sit in the "Characters" section
 * of the pose side "Scene" tab, which starts collapsed. `slot` is 1-based ("Add Character 2").
 */
export async function addPoseCharacter(page, slot) {
  const side = page.locator(".vnccs-uc-pose-side");
  await side.getByRole("tab", { name: "Scene" }).click();
  const section = side.locator(".vnccs-ps-characters-section");
  if (await section.evaluate((el) => el.classList.contains("collapsed"))) await section.locator(".vnccs-ps-section-header").click();
  await side.locator(`[aria-label="Add Character ${slot}"]`).click();
}
