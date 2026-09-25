import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  defaultScenePerspective,
  depthScalePlacement,
  expectedHeightAt,
  feetYForHeight,
  isPerspectiveCalibrated,
  layerHeightFactor,
  normalizeScenePerspective,
} from "../web/vnccs_unicanvas_scene_place.mjs";

const calibrated = normalizeScenePerspective({
  enabled: true,
  horizonY: 100,
  referenceHeight: { feetY: 400, heightPx: 200, x: 50 },
});

test("scene perspective normalizes old, broken and valid states", () => {
  assert.deepEqual(normalizeScenePerspective(undefined), defaultScenePerspective());
  assert.deepEqual(normalizeScenePerspective({ horizonY: "x", referenceHeight: { feetY: 1, heightPx: -3 }, groundTint: "red" }), defaultScenePerspective());
  assert.deepEqual(calibrated, { enabled: true, horizonY: 100, vanishX: null, referenceHeight: { feetY: 400, heightPx: 200, x: 50 }, groundTint: "#4cc9f0" });
  assert.equal(isPerspectiveCalibrated(calibrated), true);
  assert.equal(isPerspectiveCalibrated({ ...calibrated, horizonY: 450 }), false);
});

test("flat-ground rule scales height with the distance below the horizon", () => {
  assert.equal(expectedHeightAt(calibrated, 400), 200);
  assert.equal(expectedHeightAt(calibrated, 250), 100);
  assert.equal(expectedHeightAt(calibrated, 600, 0.8), 200 * (500 / 300) * 0.8);
  assert.equal(expectedHeightAt(calibrated, 100), null, "nothing stands on the horizon");
  assert.equal(expectedHeightAt(defaultScenePerspective(), 300), null);
  assert.equal(feetYForHeight(calibrated, 100), 250);
});

test("height factor comes from meta, then from the pose mesh height morph", () => {
  assert.equal(layerHeightFactor({ meta: { heightFactor: 0.8 } }), 0.8);
  assert.equal(layerHeightFactor({ type: "pose", pose: { studio: { characters: [{ mesh: { height: 0.5 } }] } } }), 1);
  assert.equal(layerHeightFactor({ type: "pose", pose: { studio: { mesh: { height: 1 } } } }), 1.25);
  assert.equal(layerHeightFactor({ type: "raster" }), 1);
});

test("a depth-scaled drag puts the feet on the cursor line and never above the horizon", () => {
  const drag = { feet: { x: 50, y: 400 }, character: { x: 30, y: 200, width: 40, height: 200 }, factor: 1 };
  const down = depthScalePlacement(calibrated, drag, { x: 70, y: 600 }, { x: 50, y: 400 });
  assert.deepEqual(down.feet, { x: 70, y: 600 });
  assert.ok(Math.abs(down.height - 200 * 500 / 300) < 1e-9);
  assert.ok(Math.abs(down.scale - down.height / 200) < 1e-9);
  const back = depthScalePlacement(calibrated, drag, { x: 50, y: 400 }, { x: 50, y: 400 });
  assert.equal(back.scale, 1);
  const above = depthScalePlacement(calibrated, drag, { x: 50, y: 20 }, { x: 50, y: 400 });
  assert.ok(above.feet.y > calibrated.horizonY);
  assert.ok(above.height >= 4);
});

test("the widget only hooks scene placement in", () => {
  const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
  assert.match(source, /installUniCanvasScenePlace\(this\)/);
  assert.match(source, /scenePerspective: serializeScenePerspective\(this\.scenePerspective\)/);
  assert.match(source, /entry\.kind === SCENE_PERSPECTIVE_HISTORY_KIND/);
  const modes = readFileSync(new URL("../web/vnccs_unicanvas_modes.mjs", import.meta.url), "utf8");
  assert.match(modes, /g: "perspective"/);
});
