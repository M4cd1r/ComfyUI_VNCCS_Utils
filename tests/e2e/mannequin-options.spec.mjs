import { test, expect } from "@playwright/test";
import { openUnicanvas, addPoseLayer, cancelPose, savePose } from "./helpers/app.mjs";

test("mannequin options live in the left sidebar during Edit pose only", async ({ page }) => {
  await openUnicanvas(page);
  await addPoseLayer(page); // opens the pose editor
  const section = page.locator(".vnccs-uc-pose-options-section");
  await expect(section).toBeVisible();
  await expect(page.locator(".vnccs-uc-left")).toContainText("Mannequin options");
  await expect(section).toContainText("Mannequin options");
  await expect(page.locator(".vnccs-uc-modal-overlay")).toHaveCount(0);

  // Realtime rule: moving a slider must change the mannequin before pointerup.
  const slider = section.locator('input[type="range"]').first();
  await slider.dispatchEvent("pointerdown", { buttons: 1 });
  await slider.dispatchEvent("pointermove", { buttons: 1 });
  const moved = await slider.evaluate((el) => {
    el.value = String(Math.min(Number(el.max), Number(el.value) + 0.2));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  });
  await expect
    .poll(async () => page.evaluate(() => document.querySelector(".vnccs-uc-pose-edit-canvas") !== null))
    .toBe(true);
  // The paired exact-number field stays synchronized during the gesture.
  await expect(section.locator('input[type="number"]').first()).toHaveValue(moved);
  // Still a sidebar section while morphing - nothing dims the stage.
  await expect(section).toBeVisible();
  await expect(page.locator(".vnccs-uc-modal-overlay")).toHaveCount(0);

  await savePose(page);
  await expect(section).toHaveCount(0); // gone with the edit session
});

test("mannequin options are reachable in the sidebar and unmount on Cancel", async ({ page }) => {
  await openUnicanvas(page);
  await addPoseLayer(page);
  const section = page.locator(".vnccs-uc-pose-options-section");
  await expect(section).toBeVisible();
  // Spec 3.6: the redundant Options button is gone from the edit bar.
  await expect(page.locator('.vnccs-uc-pose-edit-bar button:has-text("Options")')).toHaveCount(0);

  // Every morph control stays reachable: the last slider can be scrolled into
  // the section's own box instead of being clipped by the sidebar.
  const lastControlReachable = await section.evaluate((el) => {
    const ranges = el.querySelectorAll('input[type="range"]');
    const last = ranges[ranges.length - 1];
    if (!last) return false;
    last.scrollIntoView({ block: "nearest" });
    const box = el.getBoundingClientRect();
    const control = last.getBoundingClientRect();
    return control.height > 0 && control.top >= box.top - 1 && control.bottom <= box.bottom + 1;
  });
  expect(lastControlReachable).toBe(true);

  await cancelPose(page);
  await expect(section).toHaveCount(0); // gone with the canceled edit session
});
