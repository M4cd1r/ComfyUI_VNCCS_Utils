import { test, expect } from "@playwright/test";
import { openUnicanvas, addPoseLayer, cancelPose, savePose } from "./helpers/app.mjs";

/**
 * Cheap content signature of the mannequin canvas. The pose viewer core keeps
 * `preserveDrawingBuffer`, so the WebGL readback is a real frame; sampling every
 * 7th character keeps the transferred string small while still detecting any
 * repaint. Used to prove spec 7.4's realtime rule: the mannequin changes while
 * the gesture is still open, i.e. before any pointerup.
 */
function mannequinSignature(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector(".vnccs-uc-pose-edit-canvas");
    if (!canvas || typeof canvas.toDataURL !== "function") return null;
    const url = canvas.toDataURL("image/png");
    let hash = 2166136261;
    for (let i = 0; i < url.length; i += 7) {
      hash ^= url.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${canvas.width}x${canvas.height}|${url.length}|${hash >>> 0}`;
  });
}

test("mannequin options live in the left sidebar during Edit pose only", async ({ page }) => {
  await openUnicanvas(page);
  await addPoseLayer(page); // opens the pose editor
  const section = page.locator(".vnccs-uc-pose-options-section");
  await expect(section).toBeVisible();
  await expect(page.locator(".vnccs-uc-left")).toContainText("Mannequin options");
  await expect(section).toContainText("Mannequin options");
  await expect(page.locator(".vnccs-uc-modal-overlay")).toHaveCount(0);

  // Realtime rule: the mannequin must repaint during the gesture itself. Count
  // pointerup events so the assertion provably happens before the release.
  await page.evaluate(() => {
    globalThis.__vnccsPointerUps = 0;
    window.addEventListener("pointerup", () => { globalThis.__vnccsPointerUps += 1; }, true);
  });
  const controlIn = (kind) => section.locator(`label:has-text("Height") input[type="${kind}"]`).first();
  const slider = controlIn("range");

  // Let the initial render settle, then take the baseline the repaint must beat.
  await page.waitForTimeout(300);
  let settled = await mannequinSignature(page);
  expect(settled, "the mannequin canvas must be readable").not.toBeNull();
  await expect
    .poll(async () => {
      const next = await mannequinSignature(page);
      const unchanged = next === settled;
      settled = next;
      return unchanged;
    }, { timeout: 5_000, intervals: [150, 200, 300] })
    .toBe(true);
  const baseline = settled;

  await slider.dispatchEvent("pointerdown", { buttons: 1 });
  await slider.dispatchEvent("pointermove", { buttons: 1 });
  const moved = await slider.evaluate((el) => {
    el.value = String(Number(el.max));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  });
  // The mannequin repaints mid-gesture - no pointerup has been dispatched.
  await expect
    .poll(() => mannequinSignature(page), { timeout: 5_000, intervals: [100, 150, 250] })
    .not.toBe(baseline);
  expect(await page.evaluate(() => globalThis.__vnccsPointerUps), "the repaint must happen before any pointerup").toBe(0);
  // The paired exact-number field stays synchronized during the gesture.
  await expect(controlIn("number")).toHaveValue(moved);
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
