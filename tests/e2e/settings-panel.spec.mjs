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
