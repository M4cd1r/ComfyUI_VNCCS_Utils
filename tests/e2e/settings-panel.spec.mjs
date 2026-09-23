import { test, expect } from "@playwright/test";
import { openUnicanvas } from "./helpers/app.mjs";

test("settings open as one larger panel anchored under the gear", async ({ page }) => {
  await openUnicanvas(page);
  const gear = page.locator('[title="Settings"]').first();
  const left = page.locator(".vnccs-uc-left");
  await gear.click();
  const panel = page.locator(".vnccs-uc-settings-popover");
  await expect(panel).toHaveCount(1);

  const [gearBox, panelBox, leftBox] = [
    await gear.boundingBox(), await panel.boundingBox(), await left.boundingBox(),
  ];
  expect(panelBox.width).toBeGreaterThanOrEqual(400);
  expect(panelBox.y).toBeGreaterThanOrEqual(gearBox.y + gearBox.height - 1); // below the gear
  const overlapsLeft = panelBox.x < leftBox.x + leftBox.width && panelBox.x + panelBox.width > leftBox.x;
  expect(overlapsLeft).toBe(false); // never over the left sidebar

  await page.mouse.click(2, 2); // outside click closes
  await expect(panel).toHaveCount(0);
  await gear.click();
  await expect(panel).toHaveCount(1);
  await gear.click(); // second gear click closes
  await expect(panel).toHaveCount(0);
});

test("the settings Close button closes the panel and the gear reopens it", async ({ page }) => {
  await openUnicanvas(page);
  const gear = page.locator('[title="Settings"]').first();
  await gear.click();
  const panel = page.locator(".vnccs-uc-settings-popover");
  await expect(panel).toHaveCount(1);

  await panel.locator('button:has-text("Close")').click();
  await expect(panel).toHaveCount(0);

  await gear.click(); // the closed panel must leave no stale outside-click state behind
  await expect(panel).toHaveCount(1);
});

// Spec 4.3: the popover must never land over the left sidebar, not even on a host
// too narrow for the position anchored under the gear. 700/660px viewports really
// used to overlap; 900px documents that a mid-narrow host already clears it.
for (const width of [900, 700, 660]) {
  test(`the settings panel stays off the left sidebar on a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openUnicanvas(page);
    await page.locator('[title="Settings"]').first().click();
    const panel = page.locator(".vnccs-uc-settings-popover");
    await expect(panel).toHaveCount(1);

    const [panelBox, leftBox] = [await panel.boundingBox(), await page.locator(".vnccs-uc-left").boundingBox()];
    const overlapsLeft = panelBox.x < leftBox.x + leftBox.width && panelBox.x + panelBox.width > leftBox.x;
    expect(overlapsLeft).toBe(false); // never over the left sidebar
  });
}
