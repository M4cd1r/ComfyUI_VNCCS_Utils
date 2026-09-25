import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SHADOW_LAYER_HISTORY_KIND,
  alphaExtent,
  applyShadowLayerHistory,
  canCastShadow,
  castShadowMatrix,
  castShadowSquash,
  castShadowStrength,
  contactShadowGeometry,
  defaultShadowParams,
  normalizeShadow,
  previewPoint,
  shadowTint,
  updateShadowLayers,
} from "../web/vnccs_unicanvas_harmonize.mjs";
import { LAYER_MENU_ITEMS } from "../web/vnccs_unicanvas_layer_tools.mjs";

const widget = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const harmonize = readFileSync(new URL("../web/vnccs_unicanvas_harmonize.mjs", import.meta.url), "utf8");

test("shadows normalize old, broken and valid values", () => {
  assert.equal(normalizeShadow(undefined), null);
  assert.equal(normalizeShadow({ kind: "contact" }), null, "a shadow needs its source");
  assert.equal(normalizeShadow({ sourceLayerId: "a", kind: "drop" }), null);
  assert.deepEqual(normalizeShadow({ sourceLayerId: "a", kind: "contact" }), { sourceLayerId: "a", kind: "contact", params: defaultShadowParams("contact") });
  const cast = normalizeShadow({ sourceLayerId: "a", kind: "cast", params: { opacity: 3, blur: "0.2", fade: "x", extra: 1 } });
  assert.deepEqual(cast.params, { opacity: 1, blur: 0.2, fade: defaultShadowParams("cast").fade });
});

test("only plain raster and pose layers cast shadows", () => {
  assert.equal(canCastShadow({ type: "raster" }), true);
  assert.equal(canCastShadow({ type: "pose" }), true);
  assert.equal(canCastShadow({ type: "mask" }), false);
  assert.equal(canCastShadow({ type: "group" }), false);
  assert.equal(canCastShadow({ type: "raster", shadow: { sourceLayerId: "a", kind: "cast" } }), false);
});

test("alpha extent finds the box and the feet rows", () => {
  const width = 10, height = 20;
  const data = new Uint8ClampedArray(width * height * 4);
  const set = (x, y) => { data[(y * width + x) * 4 + 3] = 255; };
  for (let y = 2; y <= 15; y += 1) set(5, y); // body column
  for (let x = 3; x <= 7; x += 1) set(x, 15); // feet row
  set(1, 6); // an arm
  assert.deepEqual(alphaExtent(data, width, height), { left: 1, right: 7, top: 2, bottom: 15, feetLeft: 3, feetRight: 7 });
  assert.equal(alphaExtent(new Uint8ClampedArray(16), 2, 2), null);
});

test("previews move and scale points like the widget's render transform", () => {
  assert.deepEqual(previewPoint(null, { x: 3, y: 4 }), { x: 3, y: 4 });
  assert.deepEqual(previewPoint({ dx: 10, dy: -5 }, { x: 3, y: 4 }), { x: 13, y: -1 });
  assert.deepEqual(previewPoint({ dx: 0, dy: 100, scale: 2, anchor: { x: 50, y: 200 } }, { x: 40, y: 100 }), { x: 30, y: 100 });
});

test("the contact ellipse is 60% of the box width, never narrower than the feet", () => {
  const geometry = contactShadowGeometry({ x: 100, y: 300 }, 200, 50, { height: 0.25, softness: 0.4, opacity: 0.5 });
  assert.equal(geometry.rx, 60);
  assert.equal(geometry.ry, 15);
  assert.equal(geometry.cx, 100);
  assert.ok(geometry.cy < 300 && geometry.cy > 290, "the blob sits on the feet row");
  assert.equal(contactShadowGeometry({ x: 0, y: 0 }, 100, 90, {}).rx, 45);
});

test("the cast shadow falls away from the light and grows as the sun sets", () => {
  // Light on the right: the shadow shears to the left (c > 0 flips negative y to negative x).
  const right = castShadowMatrix({ azimuth: 90, elevation: 45 });
  assert.ok(right.c > 0.99 && right.c < 1.01);
  const left = castShadowMatrix({ azimuth: 270, elevation: 45 });
  assert.ok(left.c < -0.99);
  // Front light: the shadow goes up the image (away from the camera); back light: toward the camera.
  assert.ok(castShadowMatrix({ azimuth: 0, elevation: 45 }).d > 0);
  assert.ok(castShadowMatrix({ azimuth: 180, elevation: 45 }).d < 0);
  const low = castShadowMatrix({ azimuth: 0, elevation: 15 });
  const high = castShadowMatrix({ azimuth: 0, elevation: 70 });
  assert.ok(low.d > high.d, "a lower sun casts a longer shadow");
  assert.ok(Math.abs(right.d) >= 0.06, "a sideways shadow keeps some thickness");
});

test("the squash follows the camera height when a horizon exists", () => {
  assert.equal(castShadowSquash(null, 400, 200), 0.45);
  assert.equal(castShadowSquash({ horizonY: 200 }, 400, 200), 0.45);
  assert.ok(castShadowSquash({ horizonY: 0 }, 400, 200) > 0.45);
  assert.equal(castShadowSquash({ horizonY: 500 }, 400, 200), 0.45, "feet above the horizon fall back to the default");
});

test("shadow color comes from the ambient light", () => {
  assert.deepEqual(shadowTint({ ambientColor: "#ff0000", ambientIntensity: 1 }), [89, 0, 0]);
  assert.deepEqual(shadowTint({ ambientColor: "#ffffff", ambientIntensity: 0 }), [0, 0, 0]);
  assert.ok(castShadowStrength({ intensity: 2, ambientIntensity: 0.1 }) > castShadowStrength({ intensity: 0.5, ambientIntensity: 1 }));
  assert.equal(castShadowStrength({ intensity: 0 }), 0);
});

test("shadow history re-files the layer under its source on redo", () => {
  const source = { id: "src", type: "raster", groupId: "g1" };
  const shadow = { id: "sh", type: "raster", shadow: { sourceLayerId: "src", kind: "contact" } };
  const top = { id: "top", type: "raster" };
  const uc = {
    layers: [top, source, shadow],
    activeLayerId: "sh",
    selectedLayerIds: ["sh"],
    getLayerInsertIndex: () => 0,
    insertLayerByType(layer) { this.layers.unshift(layer); },
    normalizeLayerOrder() {},
    invalidateLayerCaches() {},
  };
  const entry = { kind: SHADOW_LAYER_HISTORY_KIND, layer: shadow, previousActiveLayerId: "src" };
  applyShadowLayerHistory(uc, entry, "undo");
  assert.deepEqual(uc.layers.map((layer) => layer.id), ["top", "src"]);
  assert.equal(uc.activeLayerId, "src");
  applyShadowLayerHistory(uc, entry, "redo");
  assert.deepEqual(uc.layers.map((layer) => layer.id), ["top", "src", "sh"]);
  assert.equal(shadow.groupId, "g1", "the shadow joins its source's group");
  assert.equal(uc.activeLayerId, "sh");
});

test("shadow regeneration skips panorama mode and orphans", () => {
  assert.equal(updateShadowLayers({ panorama: {}, layers: [] }), 0);
  const orphan = { id: "sh", type: "raster", canvas: {}, shadow: { sourceLayerId: "gone", kind: "cast" } };
  assert.equal(updateShadowLayers({ layers: [orphan] }), 0);
});

test("the widget wires shadows through hooks, serialization and history", () => {
  assert.match(widget, /installUniCanvasHarmonize\(this\);/);
  assert.match(widget, /entry\.kind === SHADOW_LAYER_HISTORY_KIND/);
  assert.match(widget, /entry\.kind === SCENE_LIGHT_HISTORY_KIND/);
  assert.equal((widget.match(/shadow: serializeShadow\(layer\.shadow\)/g) || []).length, 3, "both serializeLayer paths and the light sync carry the shadow");
  assert.match(widget, /sceneLight: serializeSceneLight\(this\.sceneLight\)/);
  assert.match(widget, /state\.sceneLight = serializeSceneLight\(this\.sceneLight\)/);
  assert.match(widget, /restoreSceneLight\(this, state\.sceneLight\)/);
  assert.match(widget, /layer\.shadow = normalizeShadow\(item\.shadow\)/);
  assert.match(widget, /shadow: normalizeShadow\(layer\.shadow\),\n\s+canvas: this\.cloneCanvas/, "history clones keep the shadow");
  assert.ok(LAYER_MENU_ITEMS.some((item) => item.id === "add-contact-shadow"));
  assert.ok(LAYER_MENU_ITEMS.some((item) => item.id === "add-cast-shadow"));
  assert.ok(LAYER_MENU_ITEMS.some((item) => item.id === "detach-shadow"));
});

test("shadow sliders are live and commit one entry per gesture", () => {
  assert.match(harmonize, /addEventListener\("input"[\s\S]*?uc\.requestRender\(\)/);
  assert.match(harmonize, /addEventListener\("change"[\s\S]*?kind: "layerProps"/);
  assert.ok(!/layer\.shadow\.params\[[^\]]+\] =/.test(harmonize), "params are replaced, never mutated in place");
});
