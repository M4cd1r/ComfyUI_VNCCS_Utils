import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AI_BBOX_TOLERANCE,
  HARMONIZE_DEFAULT_PROMPT,
  HARMONIZE_PROMPT_SETTING,
  OCCLUDER_LAYER_HISTORY_KIND,
  SHADOW_LAYER_HISTORY_KIND,
  alphaBoxDrift,
  alphaExtent,
  applyOccluderLayerHistory,
  dilateRect,
  featherAlpha,
  harmonizeCandidate,
  harmonizeKeepsSilhouette,
  isHarmonizeCharacter,
  lightDirection,
  medianDepthAt,
  occluderAlpha,
  relightPixels,
  resolveHarmonizePrompt,
  shadeChannel,
  applyShadowLayerHistory,
  canCastShadow,
  castShadowMatrix,
  castShadowSquash,
  castShadowStrength,
  contactShadowGeometry,
  defaultShadowParams,
  normalizeShadow,
  previewPoint,
  shadowSilhouetteKey,
  shadowTint,
  updateShadowLayers,
} from "../web/vnccs_unicanvas_harmonize.mjs";
import { LAYER_MENU_ITEMS } from "../web/vnccs_unicanvas_layer_tools.mjs";

const widget = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const harmonize = readFileSync(new URL("../web/vnccs_unicanvas_harmonize.mjs", import.meta.url), "utf8");
const poseEditor = readFileSync(new URL("../web/vnccs_unicanvas_pose.mjs", import.meta.url), "utf8");
const scenePlace = readFileSync(new URL("../web/vnccs_unicanvas_scene_place.mjs", import.meta.url), "utf8");

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

test("a shadow follows its source's live Free Transform preview, before Apply (#19)", () => {
  // A 2D context stub: every call is a no-op, reads return empty pixels.
  const context = () => new Proxy({ canvas: null }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "getImageData") return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const canvas = () => { const c = { width: 64, height: 64 }; c.getContext = () => { const ctx = context(); ctx.canvas = c; return ctx; }; return c; };
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => canvas() };
  try {
    const source = { id: "src", type: "raster", pixelRevision: 3, canvas: canvas() };
    const shadow = { id: "sh", type: "raster", pixelRevision: 0, canvas: canvas(), shadow: { sourceLayerId: "src", kind: "cast" } };
    const drawn = [];
    let draft = null;
    const uc = {
      layers: [source, shadow], origin: { x: 0, y: 0 }, sceneLight: {}, scenePerspective: null, _harmonize: {},
      getLayerTransformDraft: (layer) => (layer === source ? draft : null),
      getLayerMovePreview: () => null,
      getLayerWorldBounds: () => ({ x: 0, y: 0, width: 32, height: 64 }),
      drawRasterLayerToWorldRect: () => drawn.push("pixels"),
      drawTransformDraft: (ctx, item) => drawn.push(item),
      invalidateLayerRenderCaches() {},
    };
    assert.equal(updateShadowLayers(uc), 1, "first frame draws the shadow");
    assert.equal(updateShadowLayers(uc), 0, "nothing changed");
    const restKey = shadowSilhouetteKey(uc, source);
    draft = { quad: { tl: { x: 0, y: 0 }, tr: { x: 32, y: 0 }, br: { x: 32, y: 64 }, bl: { x: 0, y: 64 } }, bounds: { x: 0, y: 0, width: 32, height: 64 } };
    assert.notEqual(shadowSilhouetteKey(uc, source), restKey, "an open transform is its own silhouette");
    assert.equal(updateShadowLayers(uc), 1, "opening the transform redraws the shadow");
    assert.equal(drawn.at(-1), draft, "the silhouette comes from the draft, not the committed pixels");
    draft = { ...draft, quad: { ...draft.quad, tr: { x: 60, y: 10 } }, bounds: { x: 0, y: 0, width: 60, height: 64 } };
    assert.equal(updateShadowLayers(uc), 1, "every frame of the gesture moves the shadow");
    assert.equal(updateShadowLayers(uc), 0);
    draft = null;
    source.pixelRevision += 1;
    assert.equal(updateShadowLayers(uc), 1, "Apply (or Cancel) goes back to the pixels");
    assert.equal(drawn.at(-1), "pixels");
  } finally {
    globalThis.document = previousDocument;
  }
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
  assert.match(widget, /meta: cloneLayerMeta\(layer\.meta\),\n\s+shadow: normalizeShadow\(layer\.shadow\),/, "history clones keep the shadow");
  assert.ok(LAYER_MENU_ITEMS.some((item) => item.id === "add-contact-shadow"));
  assert.ok(LAYER_MENU_ITEMS.some((item) => item.id === "add-cast-shadow"));
  assert.ok(LAYER_MENU_ITEMS.some((item) => item.id === "detach-shadow"));
});

test("shadow sliders are live and commit one entry per gesture", () => {
  assert.match(harmonize, /addEventListener\("input"[\s\S]*?uc\.requestRender\(\)/);
  assert.match(harmonize, /addEventListener\("change"[\s\S]*?kind: "layerProps"/);
  assert.ok(!/layer\.shadow\.params\[[^\]]+\] =/.test(harmonize), "params are replaced, never mutated in place");
});

// ---------------------------------------------------------------------------
// Harmonize panel (Plan 08.3, #20).
// ---------------------------------------------------------------------------

/** A w x h sphere-like normal pass: the normal points left on the left half, right on the right. */
function sphereNormals(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = (x + 0.5) / width * 2 - 1;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx));
      const offset = (y * width + x) * 4;
      data[offset] = Math.round((nx * 0.5 + 0.5) * 255);
      data[offset + 1] = 128;
      data[offset + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[offset + 3] = 255;
    }
  }
  return data;
}

function flat(width, height, value = 128) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255; }
  return data;
}

function meanRed(data, width, height, from, to) {
  let sum = 0, count = 0;
  for (let y = 0; y < height; y += 1) for (let x = from; x < to; x += 1) { sum += data[(y * width + x) * 4]; count += 1; }
  return sum / count;
}

test("the light direction follows the gizmo: 90 is right, 270 left, 0 toward the camera", () => {
  const right = lightDirection({ azimuth: 90, elevation: 0.0001 });
  assert.ok(right.x > 0.99 && Math.abs(right.z) < 1e-6);
  const left = lightDirection({ azimuth: 270, elevation: 30 });
  assert.ok(left.x < -0.8 && left.y > 0.49 && left.y < 0.51);
  const front = lightDirection({ azimuth: 0, elevation: 45 });
  assert.ok(front.z > 0.7 && Math.abs(front.x) < 1e-9);
});

test("shading multiplies below 1 and screens above 1", () => {
  assert.equal(shadeChannel(0.5, 0.5), 0.25);
  assert.equal(shadeChannel(0.5, 1), 0.5);
  assert.equal(shadeChannel(0.5, 1.5), 0.75);
  assert.equal(shadeChannel(0.5, 9), 1, "the screen part is capped");
});

test("relight with a light from the left brightens the left half more than the right", () => {
  const width = 16, height = 4;
  const src = flat(width, height);
  const light = { azimuth: 270, elevation: 20, intensity: 1, ambientIntensity: 0.6, color: "#ffffff", ambientColor: "#808080" };
  const out = relightPixels(src, sphereNormals(width, height), width, height, light, 1);
  const leftMean = meanRed(out, width, height, 0, width / 2), rightMean = meanRed(out, width, height, width / 2, width);
  assert.ok(leftMean > rightMean + 20, `left ${leftMean} vs right ${rightMean}`);
  for (let i = 3; i < out.length; i += 4) assert.equal(out[i], 255, "alpha never changes");
});

test("relight strength 0, missing normals and transparent pixels keep the original", () => {
  const width = 4, height = 2;
  const src = flat(width, height, 90);
  const light = { azimuth: 90, elevation: 40 };
  assert.deepEqual(relightPixels(src, sphereNormals(width, height), width, height, light, 0), src);
  assert.deepEqual(relightPixels(src, new Uint8ClampedArray(src.length), width, height, light, 1), src, "normal alpha 0: no effect");
  const hole = flat(width, height, 90);
  hole[3] = 0;
  const out = relightPixels(hole, sphereNormals(width, height), width, height, light, 1);
  assert.deepEqual([...out.slice(0, 4)], [90, 90, 90, 0]);
});

test("the AI mask is the alpha dilated 12 px with an 8 px soft band", () => {
  const width = 60, height = 5;
  const alpha = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) alpha[y * width + 10] = 255;
  const mask = featherAlpha(alpha, width, height, 12, 8);
  const at = (x) => mask[2 * width + x];
  assert.equal(at(10), 255);
  assert.equal(at(22), 255, "12 px out is still fully masked");
  assert.ok(at(26) > 0 && at(26) < 255, "inside the soft band");
  assert.equal(at(30), 0, "20 px out is outside the band");
  assert.ok(at(24) > at(28), "the band falls off with distance");
});

test("rects dilate by a share of their size per side", () => {
  assert.deepEqual(dilateRect({ x: 100, y: 50, width: 40, height: 100 }, 0.25), { x: 90, y: 25, width: 60, height: 150 });
  assert.deepEqual(dilateRect({ x: 0, y: 0, width: 100, height: 100 }, 0.15), { x: -15, y: -15, width: 130, height: 130 });
});

test("an AI result is rejected when its alpha box drifts more than 5%", () => {
  const original = { left: 100, right: 199, top: 0, bottom: 199 };
  assert.equal(alphaBoxDrift(original, original), 0);
  assert.ok(harmonizeKeepsSilhouette(original, { left: 104, right: 199, top: 0, bottom: 208 }), "4% and 4.5% stay");
  assert.ok(!harmonizeKeepsSilhouette(original, { left: 94, right: 199, top: 0, bottom: 199 }), "6% of the width is too much");
  assert.ok(!harmonizeKeepsSilhouette(original, null), "an empty result is rejected");
  assert.equal(AI_BBOX_TOLERANCE, 0.05);
});

test("an opaque AI result takes the character's alpha; a transparent one its own within the mask", () => {
  const width = 2, height = 1;
  const opaque = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
  const characterAlpha = new Uint8ClampedArray([255, 0]);
  const mask = new Uint8ClampedArray([255, 128]);
  assert.deepEqual([...harmonizeCandidate(opaque, characterAlpha, mask, width, height)], [10, 20, 30, 255, 40, 50, 60, 0]);
  const transparent = new Uint8ClampedArray([10, 20, 30, 0, 40, 50, 60, 255]);
  assert.deepEqual([...harmonizeCandidate(transparent, characterAlpha, mask, width, height)], [10, 20, 30, 0, 40, 50, 60, 128]);
});

test("the occluder keeps the background nearer than the feet plus the margin", () => {
  const values = [0.2, 0.2, 0.2, 0.3, 0.9, 0.3, 0.2, 0.2, 0.2];
  assert.equal(medianDepthAt(values, 3, 3, 1, 1, 1), 0.2, "the median ignores the one near pixel");
  assert.equal(medianDepthAt(values, 3, 3, 10, 10, 0), null);
  assert.deepEqual([...occluderAlpha(new Float32Array([0.5, 0.52, 0.54, 0.9, -1]), 0.5, 0.03)], [0, 0, 255, 255, 0]);
});

test("harmonize works on character layers only", () => {
  const background = { id: "bg", type: "raster", visible: true };
  const figure = { id: "fig", type: "raster", visible: true };
  const uc = { layers: [figure, background], getLayerAlphaBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }) };
  assert.equal(isHarmonizeCharacter(uc, figure), true);
  assert.equal(isHarmonizeCharacter(uc, background), false, "the background is not a character");
  assert.equal(isHarmonizeCharacter(uc, { type: "raster", meta: { origin: "occluder" } }), false);
  assert.equal(isHarmonizeCharacter(uc, { type: "raster", shadow: { sourceLayerId: "fig", kind: "cast" } }), false);
  assert.equal(isHarmonizeCharacter(uc, { type: "pose" }), true);
  assert.equal(isHarmonizeCharacter(null, { type: "mask" }), false);
});

test("the harmonize instruction comes from the settings, else the default", () => {
  assert.equal(resolveHarmonizePrompt({}), HARMONIZE_DEFAULT_PROMPT);
  assert.equal(resolveHarmonizePrompt({ [HARMONIZE_PROMPT_SETTING]: "  " }), HARMONIZE_DEFAULT_PROMPT);
  assert.equal(resolveHarmonizePrompt({ [HARMONIZE_PROMPT_SETTING]: " Warm it up " }), "Warm it up");
  assert.match(HARMONIZE_DEFAULT_PROMPT, /^Relight the character to match the scene lighting/);
});

test("occluder history re-files the layer above its character on redo", () => {
  const figure = { id: "fig", type: "raster", groupId: "g1" };
  const occluder = { id: "occ", type: "raster", meta: { origin: "occluder" } };
  const background = { id: "bg", type: "raster" };
  const uc = {
    layers: [occluder, figure, background],
    activeLayerId: "occ",
    selectedLayerIds: ["occ"],
    getLayerInsertIndex: () => 0,
    insertLayerByType(layer) { this.layers.unshift(layer); },
    normalizeLayerOrder() {},
    invalidateLayerCaches() {},
  };
  const entry = { kind: OCCLUDER_LAYER_HISTORY_KIND, layer: occluder, sourceLayerId: "fig", previousActiveLayerId: "fig" };
  applyOccluderLayerHistory(uc, entry, "undo");
  assert.deepEqual(uc.layers.map((layer) => layer.id), ["fig", "bg"]);
  assert.equal(uc.activeLayerId, "fig");
  applyOccluderLayerHistory(uc, entry, "redo");
  assert.deepEqual(uc.layers.map((layer) => layer.id), ["occ", "fig", "bg"], "right above the character");
  assert.equal(occluder.groupId, "g1");
  assert.equal(uc.activeLayerId, "occ");
});

test("the widget, pose editor and light gizmo are wired for harmonize", () => {
  assert.match(widget, /entry\.kind === OCCLUDER_LAYER_HISTORY_KIND\) applyOccluderLayerHistory\(this, entry, direction\)/);
  assert.match(widget, /isEditModelSelected\(\) \{/);
  assert.match(widget, /section\("harmonize", "Harmonize"\)/);
  assert.match(widget, /payload\.poseNormal = poseNormal/);
  assert.match(widget, /restorePoseNormal\(layer, item\.poseNormal/);
  assert.match(widget, /delete layer\.poseNormalCanvas; delete layer\.poseNormalMeta;/, "rasterize drops the normal pass with the ID pass");
  assert.match(poseEditor, /captureNormalPass\(size\) \{/);
  assert.match(poseEditor, /MeshNormalMaterial/);
  assert.match(poseEditor, /this\.updateIdPass\(\);\n\s+this\.updateNormalPass\(\);/, "commit captures the normal pass next to the ID pass");
  assert.match(scenePlace, /uc\.harmonizeLightTarget\?\.\(\)/, "the light gizmo shows while the panel is open");
  assert.ok(LAYER_MENU_ITEMS.some((item) => item.id === "harmonize" && item.characterOnly));
  assert.ok(LAYER_MENU_ITEMS.some((item) => item.id === "create-occluder" && item.characterOnly));
  // Realtime: the relight preview is computed in the render hook and on input, full quality on release.
  assert.match(harmonize, /updateHarmonizePreview\(uc\)/);
  assert.match(harmonize, /input\.addEventListener\("input", \(\) => \{ onInput\(Number\(input\.value\)\); scheduleHarmonize\(uc, panel, false\); \}\)/);
  assert.match(harmonize, /if \(staging\?\.harmonize\) return acceptHarmonizeStaging\(uc, staging\)/);
});
