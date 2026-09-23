import { expect } from "@playwright/test";

export const LAYER_TYPES = { pose: "pose" };

const POSE_EDIT_BAR = ".vnccs-uc-pose-edit-bar";
// The widget status line lives in the generation-progress element, which is
// visibility-hidden unless it is showing generation progress, so readiness is
// polled through textContent rather than a visibility assertion.
const PROGRESS_LABEL = ".vnccs-uc-generation-progress .vnccs-uc-progress-label";
const UNICANVAS_TAB =
  '[data-testid="vnccs-unicanvas-standalone-tab-button"], [data-label="Unicanvas"], button[title="Unicanvas"]';

/** Open the standalone Unicanvas sidebar tab and wait for the widget chrome. */
export async function openUnicanvas(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const tab = page.locator(UNICANVAS_TAB).first();
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await tab.click();
  await expect(page.locator(".vnccs-uc-left")).toBeVisible({ timeout: 30_000 });
}

/**
 * The pose editor loads its viewer and morph pack asynchronously and reports
 * readiness in the widget status line; Save pose only captures once that has
 * happened, so every edit-entry helper waits for the ready status.
 */
async function waitForPoseEditorReady(page) {
  await expect(page.locator(POSE_EDIT_BAR)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.locator(PROGRESS_LABEL).textContent(), { timeout: 60_000 })
    .toContain("drag the mannequin");
}

/** Add a pose layer; this opens the mannequin editor right away. */
export async function addPoseLayer(page) {
  await page.locator('[title="Add pose layer"]').first().click();
  await waitForPoseEditorReady(page);
}

/**
 * Make sure the pose layer is being edited. Adding the layer already opens the
 * editor, so this is a re-entry helper.
 */
export async function enterPoseEdit(page) {
  if (await page.locator(POSE_EDIT_BAR).isVisible()) {
    await waitForPoseEditorReady(page);
    return;
  }
  // Layer rows expose "Edit pose" either through the row's overflow ("More")
  // control or through the row context menu (vnccs_unicanvas_layer_tools.mjs).
  const more = page.locator('[title="More"]').first();
  if (await more.isVisible().catch(() => false)) {
    await more.click({ timeout: 5_000 }).catch(() => {});
  }
  const entry = page.locator('[title="Edit pose"], button:has-text("Edit pose")').first();
  if (!(await entry.isVisible().catch(() => false))) {
    await page.locator("[data-layer-id]").first().click({ button: "right" });
  }
  await entry.click();
  await waitForPoseEditorReady(page);
}

export async function savePose(page) {
  await page.locator(`${POSE_EDIT_BAR} button:has-text("Save pose")`).click();
  await expect(page.locator(POSE_EDIT_BAR)).toBeHidden({ timeout: 30_000 });
}

export async function cancelPose(page) {
  await page.locator(`${POSE_EDIT_BAR} button:has-text("Cancel")`).click();
  await expect(page.locator(POSE_EDIT_BAR)).toBeHidden({ timeout: 30_000 });
}

export async function runEditSaveCycle(page) {
  await enterPoseEdit(page);
  await savePose(page);
}
