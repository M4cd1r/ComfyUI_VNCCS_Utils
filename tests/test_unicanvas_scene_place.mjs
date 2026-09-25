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

test("scene light normalizes old, broken and valid values", async () => {
  const { defaultSceneLight, normalizeSceneLight } = await import("../web/vnccs_unicanvas_scene_place.mjs");
  assert.deepEqual(normalizeSceneLight(undefined), defaultSceneLight());
  assert.deepEqual(normalizeSceneLight({ azimuth: -90, elevation: 120, intensity: -1, color: "red", ambientColor: "#ABCDEF" }),
    { ...defaultSceneLight(), azimuth: 270, elevation: 89, intensity: 0, ambientColor: "#abcdef" });
  assert.equal(normalizeSceneLight({ azimuth: 725 }).azimuth, 5);
});

test("the sun handle round-trips azimuth and elevation", async () => {
  const { lightFromHandle, sunHandlePosition } = await import("../web/vnccs_unicanvas_scene_place.mjs");
  const center = { x: 100, y: 400 };
  for (const light of [{ azimuth: 0, elevation: 30 }, { azimuth: 90, elevation: 60 }, { azimuth: 225, elevation: 10 }]) {
    const handle = sunHandlePosition(center, 120, light);
    const back = lightFromHandle(center, 120, handle);
    assert.ok(Math.abs(back.azimuth - light.azimuth) < 1e-6, `azimuth ${light.azimuth}`);
    assert.ok(Math.abs(back.elevation - light.elevation) < 1e-6, `elevation ${light.elevation}`);
  }
  // Front light sits toward the camera (below the feet), a light on the right to the right.
  assert.ok(sunHandlePosition(center, 120, { azimuth: 0, elevation: 30 }).y > center.y);
  assert.ok(sunHandlePosition(center, 120, { azimuth: 90, elevation: 30 }).x > center.x);
  assert.equal(lightFromHandle(center, 120, center).elevation, 89, "the feet are the zenith");
});

test("shadow direction and length follow the light", async () => {
  const { shadowGroundDirection, shadowLengthFactor } = await import("../web/vnccs_unicanvas_scene_place.mjs");
  const right = shadowGroundDirection({ azimuth: 90 });
  assert.ok(right.x < -0.99, "a light on the right throws the shadow left");
  assert.ok(shadowGroundDirection({ azimuth: 0 }).z > 0.99, "a front light throws it away from the camera");
  assert.ok(Math.abs(shadowLengthFactor({ elevation: 45 }) - 1) < 1e-9);
  assert.ok(shadowLengthFactor({ elevation: 10 }) > shadowLengthFactor({ elevation: 45 }));
});

test("light estimate reads the dominant luminance gradient", async () => {
  const { estimateLightAzimuth } = await import("../web/vnccs_unicanvas_scene_place.mjs");
  const grid = (fn) => {
    const width = 16, height = 16, data = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data[y * width + x] = fn(x / 15, y / 15);
    return [data, width, height];
  };
  assert.ok(Math.abs(estimateLightAzimuth(...grid((x) => x)) - 90) < 1e-6, "brighter right: light on the right");
  assert.ok(Math.abs(estimateLightAzimuth(...grid((x) => 1 - x)) - 270) < 1e-6);
  assert.ok(Math.abs(estimateLightAzimuth(...grid((x, y) => y))) < 1e-6, "brighter toward the camera: front light");
  assert.equal(estimateLightAzimuth(...grid(() => 0.5)), null, "a flat image proposes nothing");
});

test("the light has its own history kind and is serialized", () => {
  const widget = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
  const source = readFileSync(new URL("../web/vnccs_unicanvas_scene_place.mjs", import.meta.url), "utf8");
  assert.match(source, /kind: SCENE_LIGHT_HISTORY_KIND, before, after/);
  assert.match(source, /Object\.assign\(uc\.sceneLight, lightFromHandle/, "the gizmo updates the light on pointermove");
  assert.match(widget, /applySceneLightHistory\(this, entry, direction\)/);
});
