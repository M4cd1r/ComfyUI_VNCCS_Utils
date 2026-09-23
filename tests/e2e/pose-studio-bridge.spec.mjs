import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { openUnicanvas, addPoseLayer, savePose } from "./helpers/app.mjs";
import { measureAlphaBBoxInPage } from "./helpers/measure.mjs";

// Task 8 regression (spec 5.1b on the bridge path): Pose Studio pushes must
// land 1:1. Before the fix every "capture now" squeezed the fresh render into
// the layer's previous alpha bounds, shrinking the mannequin ~4x per push
// (measured live: 142x355 -> 52x207 -> 20x121 -> 8x71).

const TOLERANCE = 0.05; // width, height and area stay within 5% of the baseline

async function loadPoseStudioOnly(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !!(window.app?.loadGraphData || window.comfyAPI?.app?.app?.loadGraphData),
    null,
    { timeout: 90_000 },
  );
  await page.waitForFunction(() => {
    const app = window.app || window.comfyAPI?.app?.app;
    return !!(app && app.graph && app.canvas);
  }, null, { timeout: 120_000 });
  // Let the extension bundles finish registering custom node types before
  // loadGraphData (same settle delay as the controller's probe).
  await page.waitForTimeout(1_500);
  const workflow = JSON.parse(
    await readFile(resolve(import.meta.dirname, "fixtures", "unicanvas-pose-studio-wf.json"), "utf8"),
  );
  const poseOnly = {
    ...workflow,
    nodes: workflow.nodes.filter((node) => node.type === "VNCCS_PoseStudio"),
    links: [],
  };
  await page.evaluate((wf) => {
    const app = window.app || window.comfyAPI?.app?.app;
    app.loadGraphData(wf);
  }, poseOnly);
  // Center the canvas on the node so the studio's 3D viewer initializes.
  await page.evaluate(() => {
    const app = window.app || window.comfyAPI?.app?.app;
    const node = (app.graph?._nodes || []).find((n) => n.type === "VNCCS_PoseStudio");
    if (node && app.canvas?.centerOnNode) app.canvas.centerOnNode(node);
  });
  await page.waitForFunction(
    () => !!window.__vnccsPoseStudioPoseLayerBridge?.pickStudio?.(),
    null,
    { timeout: 120_000 },
  );
}

async function measurePoseLayer(page) {
  const bbox = await page.evaluate(async () => {
    const layers = window.__VNCCS_UC_E2E__.listLayers();
    const pose = layers.find((layer) => layer.type === "pose");
    if (!pose) return null;
    const pixels = window.__VNCCS_UC_E2E__.getLayerPixels(pose.id);
    if (!pixels) return null;
    return pixels.dataURL;
  });
  expect(bbox, "the pose layer must have rendered pixels").not.toBeNull();
  return measureAlphaBBoxInPage(page, bbox);
}

async function clickCaptureNow(page) {
  await page.locator("button").filter({ hasText: /capture now/i }).first().click({ timeout: 10_000 });
  // The bridge answers capture-request with a final-quality render.
  await page.waitForTimeout(3_000);
}

test.describe("Pose Studio bridge render path", () => {
  test("capture now pushes keep the mannequin size and placement (no scaling)", async ({ page }) => {
    await loadPoseStudioOnly(page);
    await openUnicanvas(page);
    await addPoseLayer(page);
    // Adding the layer opens the mannequin editor; save once so the layer has
    // real pixels (the baseline footprint).
    await savePose(page);
    const baseline = await measurePoseLayer(page);
    expect(baseline.area).toBeGreaterThan(0);

    // Three "capture now" pushes through the live bridge: the bbox must not
    // shrink (RED before the fix: ~22-25% of the previous area per push).
    const bboxes = [baseline];
    for (let push = 1; push <= 3; push += 1) {
      await clickCaptureNow(page);
      const current = await measurePoseLayer(page);
      bboxes.push(current);
      for (const [key, value] of Object.entries(current)) {
        const reference = baseline[key];
        expect(
          Math.abs(value / reference - 1),
          `capture now #${push}: ${key} ${value} vs baseline ${reference}`,
        ).toBeLessThan(TOLERANCE);
      }
    }

    // Placement stability (spec 5.1b): move the layer with the move tool,
    // push once more, and the content must not jump back to the canvas centre.
    const moved = { dx: 170, dy: 130 };
    const stage = page.locator("canvas.vnccs-uc-stage").first();
    const box = await stage.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + moved.dx, box.y + box.height / 2 + moved.dy, { steps: 12 });
    await page.mouse.up();
    const afterMove = await measurePoseLayer(page);
    // The move tool bakes the placement into the bitmap: the content really moved.
    expect(Math.abs(afterMove.centroidX - bboxes[3].centroidX)).toBeGreaterThan(5);
    expect(Math.abs(afterMove.centroidY - bboxes[3].centroidY)).toBeGreaterThan(5);
    await clickCaptureNow(page);
    const afterPush = await measurePoseLayer(page);
    // Same size (1:1 draw)...
    for (const [key, value] of Object.entries(afterPush)) {
      expect(
        Math.abs(value / afterMove[key] - 1),
        `push after move: ${key} ${value} vs moved ${afterMove[key]}`,
      ).toBeLessThan(TOLERANCE);
    }
    // ...and the content stayed where the move tool put it (no jump to centre).
    expect(Math.abs(afterPush.centroidX - afterMove.centroidX)).toBeLessThanOrEqual(
      Math.max(8, afterMove.width * 0.05),
    );
    expect(Math.abs(afterPush.centroidY - afterMove.centroidY)).toBeLessThanOrEqual(
      Math.max(8, afterMove.height * 0.05),
    );

    // Keep the measured numbers next to the screenshots (report evidence).
    const outDir = resolve(import.meta.dirname, "evidence", "pose-studio-bridge");
    await mkdir(outDir, { recursive: true });
    await writeFile(
      resolve(outDir, "probe.json"),
      JSON.stringify(
        {
          baseline: round(baseline),
          push1: round(bboxes[1]),
          push2: round(bboxes[2]),
          push3: round(bboxes[3]),
          afterMove: round(afterMove),
          afterPushAfterMove: round(afterPush),
        },
        null,
        2,
      ),
    );
  });
});

const round = (bbox) => ({
  x: Math.round(bbox.minX),
  y: Math.round(bbox.minY),
  w: bbox.width,
  h: bbox.height,
  area: bbox.area,
  centroidX: Math.round(bbox.centroidX),
  centroidY: Math.round(bbox.centroidY),
});

