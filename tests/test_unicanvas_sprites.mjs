import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  SPRITE_EXPRESSION_PRESETS, SPRITE_VARIANT_HISTORY_KIND, clampBox, compositeExpressionPixels, compositeOutfitPixels,
  customVariant, cycleVariantId, detectSpriteAnchor, expressionInstruction, faceRectFromHead, featherMaskAlpha,
  installUniCanvasSprites, mapBox, normalizeSpriteState, presetExpressionVariants, serializeSpriteState, shiftPixels,
  snapshotSprite, spriteSourceIssue, spriteVariantPrompt, spriteWorkRegion, transformPointMap,
} from "../web/vnccs_unicanvas_sprites.mjs";
import { isImageLayer } from "../web/vnccs_unicanvas_pose_state.mjs";

const widget = fs.readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const modes = fs.readFileSync(new URL("../web/vnccs_unicanvas_modes.mjs", import.meta.url), "utf8");

/* ------------------------------------------------------------------------------------------------
 * A small software canvas: nearest sampling, source-over for opaque / transparent pixels.
 * ---------------------------------------------------------------------------------------------- */

const registry = new Map();
let urlCounter = 0;

class FakeCanvas {
  constructor(width = 1, height = 1) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.data = new Uint8ClampedArray(this.width * this.height * 4);
    this.strokes = 0;
  }
  getContext() {
    const canvas = this;
    return {
      canvas, fillStyle: "#000000", globalCompositeOperation: "source-over",
      save() {}, restore() {}, translate() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {},
      stroke() { canvas.strokes += 1; }, strokeRect() {},
      clearRect(x, y, w, h) { canvas.fill(x, y, w, h, [0, 0, 0, 0]); },
      fillRect(x, y, w, h) {
        const hex = String(this.fillStyle).replace("#", "");
        canvas.fill(x, y, w, h, [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255]);
      },
      drawImage(source, ...args) { canvas.draw(source, args); },
      getImageData(x, y, w, h) {
        const out = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
          const from = canvas.index(x + col, y + row);
          if (from < 0) continue;
          out.set(canvas.data.subarray(from, from + 4), (row * w + col) * 4);
        }
        return { data: out, width: w, height: h };
      },
      createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; },
      putImageData(image, x, y) {
        for (let row = 0; row < image.height; row++) for (let col = 0; col < image.width; col++) {
          const to = canvas.index(x + col, y + row);
          if (to >= 0) canvas.data.set(image.data.subarray((row * image.width + col) * 4, (row * image.width + col) * 4 + 4), to);
        }
      },
    };
  }
  index(x, y) { return x < 0 || y < 0 || x >= this.width || y >= this.height ? -1 : (y * this.width + x) * 4; }
  fill(x, y, w, h, rgba) {
    for (let row = Math.max(0, Math.round(y)); row < Math.min(this.height, Math.round(y + h)); row++) {
      for (let col = Math.max(0, Math.round(x)); col < Math.min(this.width, Math.round(x + w)); col++) this.data.set(rgba, this.index(col, row));
    }
  }
  draw(source, args) {
    let sx = 0, sy = 0, sw = source.width, sh = source.height, dx, dy, dw, dh;
    if (args.length === 2) [dx, dy] = args;
    else if (args.length === 4) [dx, dy, dw, dh] = args;
    else [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    dw ??= sw; dh ??= sh;
    dx = Math.round(dx); dy = Math.round(dy); dw = Math.round(dw); dh = Math.round(dh);
    for (let row = 0; row < dh; row++) for (let col = 0; col < dw; col++) {
      const to = this.index(dx + col, dy + row);
      if (to < 0) continue;
      const from = source.index(Math.floor(sx + (col + 0.5) * sw / dw), Math.floor(sy + (row + 0.5) * sh / dh));
      if (from < 0) continue;
      const alpha = source.data[from + 3];
      if (alpha === 255) this.data.set(source.data.subarray(from, from + 4), to);
      else if (alpha) {
        const a = alpha / 255;
        for (let channel = 0; channel < 3; channel++) this.data[to + channel] = source.data[from + channel] * a + this.data[to + channel] * (1 - a);
        this.data[to + 3] = alpha + this.data[to + 3] * (1 - a);
      }
    }
  }
  toDataURL() {
    const url = `fake:${urlCounter++}`;
    const copy = new FakeCanvas(this.width, this.height);
    copy.data.set(this.data);
    registry.set(url, copy);
    return url;
  }
}

function alphaBox(canvas) {
  let x1 = Infinity, y1 = Infinity, x2 = -1, y2 = -1;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (canvas.data[(y * canvas.width + x) * 4 + 3] <= 16) continue;
    x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y);
  }
  return x2 < 0 ? null : { x: x1, y: y1, width: x2 - x1 + 1, height: y2 - y1 + 1 };
}

/** A 40x80 character on a 256x256 document: blue body, skin head at the top. */
function characterCanvas() {
  const canvas = new FakeCanvas(256, 256);
  const ctx = canvas.getContext();
  ctx.fillStyle = "#3050c0"; ctx.fillRect(100, 100, 40, 80);
  ctx.fillStyle = "#f0c8a0"; ctx.fillRect(108, 100, 24, 20);
  return canvas;
}

function harness() {
  let revision = 0;
  let id = 0;
  const history = [];
  const statuses = [];
  const staged = [];
  const source = { id: "src", name: "Hero", type: "raster", visible: true, locked: false, opacity: 1, groupId: "g1", meta: { origin: "paint" }, canvas: characterCanvas(), pixelRevision: ++revision };
  const group = { id: "g1", type: "group", name: "Characters", visible: true, groupId: null };
  const uc = {
    layers: [group, source], activeLayerId: "src", selectedLayerIds: ["src"], origin: { x: 0, y: 0 }, size: { width: 256, height: 256 },
    settings: { generation_mode: "qwen_image_edit", positive: "", seed: 5, seed_mode: "fixed", batch_size: 1 }, tool: "move",
    get activeLayer() { return this.layers.find((layer) => layer.id === this.activeLayerId) || null; },
    _createCanvas: (w, h) => new FakeCanvas(w, h),
    getLayerAlphaBounds(layer) {
      if (layer._boundsCache !== undefined) return layer._boundsCache;
      layer._boundsCache = alphaBox(layer.canvas);
      return layer._boundsCache;
    },
    invalidateLayerCaches(layer) { layer.pixelRevision = ++revision; layer._boundsCache = undefined; },
    invalidateLayerRenderCaches(layer) { layer.pixelRevision = ++revision; },
    createLayerPixelSnapshot(layer) {
      uc.sprites.syncFromCanvas(layer);
      const canvas = new FakeCanvas(layer.canvas.width, layer.canvas.height);
      canvas.data.set(layer.canvas.data);
      return { id: layer.id, canvas, ...uc.sprites.snapshot(layer) };
    },
    restoreLayerPixelSnapshot(layer, snapshot) {
      layer.canvas.data.set(snapshot.canvas.data);
      uc.invalidateLayerCaches(layer);
      uc.sprites.restoreSnapshot(layer, snapshot);
    },
    pushHistoryEntry: (entry) => history.push(entry),
    addLayer(type, name, _record, _defer, meta) {
      const layer = { id: `l${++id}`, name, type, visible: true, locked: false, opacity: 1, meta, canvas: new FakeCanvas(256, 256), pixelRevision: ++revision };
      uc.layers.unshift(layer);
      uc.activeLayerId = layer.id;
      return layer;
    },
    normalizeLayerOrder() {}, ensureWorldBounds: () => true, setStatus: (text, error) => statuses.push([text, Boolean(error)]),
    requestRender() {}, render() {}, renderLayerList() {}, syncActiveLayerControls() {}, refreshLayerRow() {}, syncToNode() {},
    updateGenerationProgress() {}, getInferenceSize: (rect) => ({ width: Math.max(64, rect.width), height: Math.max(64, rect.height) }),
    makeSettingsPayload: () => JSON.parse(JSON.stringify(uc.settings)),
    loadImage: async (url) => registry.get(url),
    resultImageURL: (image) => image,
    cloneCanvasCrop: (canvas) => canvas,
    addStagingItem: (item) => staged.push(item),
    stagingItems: [], activeStagingIndex: -1,
  };
  installUniCanvasSprites(uc, { modelModule: (mode) => ({ isEditModel: mode === "qwen_image_edit" }) });
  return { uc, source, history, statuses, staged };
}

/** Undo / redo of the entries the controller pushes (the widget's applyHistoryEntry, reduced). */
function undo(uc, entry) {
  if (entry.kind === "historyGroup") { for (const child of [...entry.entries].reverse()) undo(uc, child); return; }
  if (entry.kind === "layerPixels") uc.restoreLayerPixelSnapshot(uc.layers.find((layer) => layer.id === entry.layerId), entry.before);
  if (entry.kind === SPRITE_VARIANT_HISTORY_KIND) uc.sprites.applyVariantHistory(entry, "undo");
}

function stubDraw(patchColor = [220, 40, 40, 255]) {
  const requests = [];
  globalThis.fetch = async (_route, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const out = new FakeCanvas(body.output_size.width, body.output_size.height);
    out.fill(0, 0, out.width, out.height, patchColor);
    return { ok: true, json: async () => ({ images: [out.toDataURL()] }) };
  };
  return requests;
}

/* ------------------------------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------------------------- */

test("the preset list has the 15 expressions of the plan, each with an edit instruction", () => {
  assert.equal(SPRITE_EXPRESSION_PRESETS.length, 15);
  assert.deepEqual(SPRITE_EXPRESSION_PRESETS.slice(0, 4).map((preset) => preset.name), ["neutral", "happy", "laughing", "smile closed eyes"]);
  assert.match(expressionInstruction("a happy"), /same character, same pose, only change the facial expression to a happy expression, keep hair, clothes and lighting identical/);
  const variants = presetExpressionVariants({ variants: [{ name: "neutral" }] });
  assert.equal(variants.length, 14, "names already in the set are skipped");
  assert.ok(variants.every((variant) => variant.status === "empty" && variant.kind === "expression"));
});

test("prompts: edit families get the instruction, other families a description on the scene prompt", () => {
  const sprite = { characterName: "Aoi" };
  const [happy] = presetExpressionVariants({ variants: [{ name: "neutral" }] });
  assert.match(spriteVariantPrompt(sprite, happy, { editModel: true }), /only change the facial expression/);
  assert.equal(spriteVariantPrompt(sprite, happy, { editModel: false, basePrompt: "school uniform" }), "Aoi, a happy facial expression, school uniform");
  const outfit = customVariant({ name: "swimsuit", kind: "outfit", text: "a blue swimsuit" });
  assert.match(outfit.prompt, /change the outfit: a blue swimsuit/);
  assert.equal(spriteVariantPrompt(sprite, outfit, { editModel: false }), "Aoi, a blue swimsuit");
});

test("sprite state is additive: malformed input normalizes, duplicates drop, the active id falls back", () => {
  const empty = normalizeSpriteState(undefined);
  assert.equal(empty.variants.length, 1);
  assert.equal(empty.variants[0].name, "neutral");
  assert.equal(empty.activeVariantId, empty.variants[0].id);
  const state = normalizeSpriteState({
    rect: { x: 10.4, y: 20, width: 100, height: 200 }, activeVariantId: "missing", faceRect: { x: -5, y: 10, width: 400, height: 20 },
    variants: [{ id: "a", name: "neutral", status: "ready", kind: "weird" }, { id: "a", name: "dup" }, "junk", { id: "b", name: "happy", status: "nope" }],
  });
  assert.deepEqual(state.rect, { x: 10, y: 20, width: 100, height: 200 });
  assert.deepEqual(state.variants.map((variant) => [variant.id, variant.kind, variant.status]), [["a", "custom", "ready"], ["b", "custom", "empty"]]);
  assert.equal(state.activeVariantId, "a");
  assert.deepEqual(state.faceRect, { x: 0, y: 10, width: 100, height: 20 }, "faceRect is clamped to the rect");
  assert.deepEqual(state.anchor, { x: 50, y: 200 }, "the default anchor is the bottom centre");
});

test("the anchor is the feet contact point: bottom of the alpha, centred on the lowest rows", () => {
  const width = 20, height = 30;
  const alpha = new Uint8ClampedArray(width * height);
  for (let y = 2; y < 25; y++) for (let x = 4; x < 16; x++) alpha[y * width + x] = 255;
  // The lowest rows are only the right foot.
  for (let y = 25; y < 28; y++) for (let x = 10; x < 14; x++) alpha[y * width + x] = 255;
  assert.deepEqual(detectSpriteAnchor(alpha, width, height), { x: 12, y: 28 });
  assert.deepEqual(detectSpriteAnchor(new Uint8ClampedArray(width * height), width, height), { x: 10, y: 30 });
});

test("faceRect comes from the baked head with a 15% margin, in rect space", () => {
  assert.deepEqual(faceRectFromHead({ x: 120, y: 110, width: 40, height: 40 }, { x: 100, y: 100, width: 200, height: 300 }), { x: 14, y: 4, width: 52, height: 52 });
  assert.deepEqual(spriteWorkRegion({ x: 10, y: 10, width: 20, height: 20 }, { width: 100, height: 100 }), { x: 0, y: 0, width: 40, height: 40 });
  assert.deepEqual(clampBox({ x: -3, y: 2, width: 10, height: 200 }, 50, 50), { x: 0, y: 2, width: 7, height: 48 });
});

test("the feather mask is exactly zero outside its box and full deep inside", () => {
  const mask = featherMaskAlpha(40, 40, { x: 10, y: 10, width: 20, height: 20 }, 4);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
    const inside = x >= 10 && x < 30 && y >= 10 && y < 30;
    if (!inside) assert.equal(mask[y * 40 + x], 0);
  }
  assert.equal(mask[20 * 40 + 20], 255);
  assert.ok(mask[10 * 40 + 20] > 0 && mask[10 * 40 + 20] < 255, "the edge is soft");
});

test("expression composite keeps the alpha and every pixel outside the mask bit-identical", () => {
  const neutral = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 0]);
  const result = new Uint8ClampedArray([200, 200, 200, 255, 200, 200, 200, 255, 200, 200, 200, 255]);
  const out = compositeExpressionPixels(neutral, result, new Uint8ClampedArray([0, 255, 128]));
  assert.deepEqual([...out.slice(0, 4)], [10, 20, 30, 255]);
  assert.deepEqual([...out.slice(4, 8)], [200, 200, 200, 128], "the colour changes, the alpha stays");
  assert.equal(out[11], 0);
  const outfit = compositeOutfitPixels(neutral, result, new Uint8ClampedArray([255, 0, 255]), new Uint8ClampedArray([255, 0, 0]));
  assert.deepEqual([...outfit.slice(0, 4)], [10, 20, 30, 255], "the face keeps neutral");
  assert.deepEqual([...outfit.slice(4, 8)], [200, 200, 200, 0], "the body takes the result's alpha");
  const shifted = shiftPixels(new Uint8ClampedArray([1, 1, 1, 255, 2, 2, 2, 255]), 2, 1, 1, 0);
  assert.deepEqual([...shifted], [0, 0, 0, 0, 1, 1, 1, 255]);
});

test("cycling steps through ready variants only and wraps", () => {
  const sprite = { activeVariantId: "a", variants: [{ id: "a", status: "ready", pixels: {} }, { id: "b", status: "empty" }, { id: "c", status: "ready", pixels: {} }] };
  assert.equal(cycleVariantId(sprite, 1), "c");
  sprite.activeVariantId = "c";
  assert.equal(cycleVariantId(sprite, 1), "a");
  assert.equal(cycleVariantId(sprite, -1), "a");
  assert.equal(cycleVariantId({ variants: [] }, 1), null);
});

test("a transform frame maps the rect and anchor of the stored pixels", () => {
  const draft = { sourceBounds: { x: 10, y: 10, width: 20, height: 40 }, quad: { nw: { x: 110, y: 10 }, ne: { x: 150, y: 10 }, se: { x: 150, y: 90 }, sw: { x: 110, y: 90 } }, mesh: null, stateOffset: { x: 0, y: 0 } };
  const map = transformPointMap(draft);
  assert.deepEqual(map({ x: 20, y: 50 }), { x: 130, y: 90 });
  assert.deepEqual(mapBox(map, { x: 10, y: 10, width: 20, height: 40 }), { x: 110, y: 10, width: 40, height: 80 });
});

test("only raster layers and baked single-character pose layers become sprite sets", () => {
  assert.equal(spriteSourceIssue({ type: "raster" }), null);
  assert.match(spriteSourceIssue({ type: "mask" }), /raster or baked pose/);
  const pose = { type: "pose", pose: { studio: { characters: [{ id: "a", name: "A" }, { id: "b", name: "B" }] } } };
  assert.match(spriteSourceIssue(pose), /Split the characters/);
  pose.pose.studio.characters.pop();
  assert.match(spriteSourceIssue(pose), /Bake the character/);
  pose.pose.bake = { characters: { a: { status: "baked" } } };
  pose.bakeParts = { a: { surface: {} } };
  assert.equal(spriteSourceIssue(pose), null);
  assert.equal(isImageLayer({ type: "sprite" }), true, "render, flatten and export read sprite layers");
});

/* ------------------------------------------------------------------------------------------------
 * Controller
 * ---------------------------------------------------------------------------------------------- */

test("Create sprite set: neutral from the raster pixels, anchor at the feet, above the source in its group", () => {
  const { uc, source, history } = harness();
  const layer = uc.sprites.createFromLayer(source);
  assert.equal(layer.type, "sprite");
  assert.equal(layer.groupId, "g1");
  assert.equal(uc.layers.indexOf(layer), uc.layers.indexOf(source) - 1, "right above its source");
  assert.equal(source.visible, false, "the source stays, hidden and linked");
  assert.equal(layer.sprite.sourceLayerId, "src");
  assert.equal(layer.sprite.characterName, "Hero");
  assert.equal(layer.sprite.variants.length, 1);
  const [neutral] = layer.sprite.variants;
  assert.equal(neutral.name, "neutral");
  assert.equal(neutral.status, "ready");
  const { rect, anchor } = layer.sprite;
  assert.ok(rect.x <= 100 && rect.y <= 100 && rect.x + rect.width >= 140 && rect.y + rect.height >= 180);
  assert.ok(Math.abs(rect.x + anchor.x - 120) <= 2 && Math.abs(rect.y + anchor.y - 180) <= 2, "anchor at the alpha's bottom centre");
  assert.deepEqual(alphaBox(layer.canvas), { x: 100, y: 100, width: 40, height: 80 }, "the canvas shows the neutral variant in place");
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].entries.map((entry) => entry.kind), ["groupStructure", "layerProps"]);
});

test("Generate missing: every variant ready in one undo step, alpha and pixels outside faceRect identical", async () => {
  const { uc, source, history } = harness();
  const layer = uc.sprites.createFromLayer(source);
  uc.sprites.addPresets(layer);
  assert.equal(layer.sprite.variants.length, 15);
  assert.equal(layer.sprite.variants.filter((variant) => variant.status === "empty").length, 14);
  const { rect } = layer.sprite;
  // The head: 108..132 x 100..120 in the world.
  layer.sprite.faceRect = { x: 108 - rect.x, y: 100 - rect.y, width: 24, height: 20 };
  const requests = stubDraw();
  const before = history.length;
  await uc.sprites.generateMissing(layer);
  assert.equal(requests.length, 14, "one request per empty variant");
  assert.equal(requests[0].mode, "inpaint");
  assert.match(requests[0].settings.positive, /only change the facial expression/);
  assert.equal(history.length, before + 1, "one undo step");
  assert.ok(layer.sprite.variants.every((variant) => variant.status === "ready"));
  const neutral = layer.sprite.variants[0].pixels;
  const face = layer.sprite.faceRect;
  for (const variant of layer.sprite.variants.slice(1)) {
    let changed = 0;
    for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
      const offset = (y * rect.width + x) * 4;
      assert.equal(variant.pixels.data[offset + 3], neutral.data[offset + 3], "the alpha is bit-identical");
      const inside = x >= face.x && x < face.x + face.width && y >= face.y && y < face.y + face.height;
      const same = [0, 1, 2].every((channel) => variant.pixels.data[offset + channel] === neutral.data[offset + channel]);
      if (!inside) assert.ok(same, `pixel ${x},${y} outside faceRect is unchanged`);
      else if (!same) changed++;
    }
    assert.ok(changed > 0, `${variant.name} repainted its face`);
  }
  assert.equal(uc.drawInProgress, false);
  undo(uc, history.at(-1));
  assert.equal(layer.sprite.variants.filter((variant) => variant.status === "empty").length, 14, "one undo restores the empty variants");
});

test("an expression without a face area fails with a clear message and is marked failed", async () => {
  const { uc, source, statuses } = harness();
  const layer = uc.sprites.createFromLayer(source);
  uc.sprites.addPresets(layer);
  stubDraw();
  await uc.sprites.generateMissing(layer);
  assert.equal(layer.sprite.variants[1].status, "failed");
  assert.match(statuses.at(-1)[0], /Drag the face area/);
});

test("switching variants keeps the alpha bbox and records one small history entry; undo switches back", async () => {
  const { uc, source, history } = harness();
  const layer = uc.sprites.createFromLayer(source);
  uc.sprites.addPresets(layer);
  const { rect } = layer.sprite;
  layer.sprite.faceRect = { x: 108 - rect.x, y: 100 - rect.y, width: 24, height: 20 };
  stubDraw();
  await uc.sprites.generateMissing(layer);
  const bbox = alphaBox(layer.canvas);
  const happy = layer.sprite.variants.find((variant) => variant.name === "happy");
  assert.equal(uc.sprites.setActiveVariant(layer, happy.id), true);
  assert.equal(layer.sprite.activeVariantId, happy.id);
  assert.deepEqual(alphaBox(layer.canvas), bbox);
  assert.equal(history.at(-1).kind, SPRITE_VARIANT_HISTORY_KIND);
  uc.activeLayerId = layer.id;
  assert.equal(uc.sprites.cycleActive(1), true);
  assert.equal(layer.sprite.activeVariantId, layer.sprite.variants[2].id, "`.` steps to the next ready variant");
  assert.deepEqual(alphaBox(layer.canvas), bbox);
  undo(uc, history.at(-1));
  assert.equal(layer.sprite.activeVariantId, happy.id);
  // An empty variant cannot be shown.
  uc.sprites.addCustom(layer, { name: "wink", kind: "expression", text: "winking" });
  const wink = layer.sprite.variants.at(-1);
  assert.equal(uc.sprites.setActiveVariant(layer, wink.id), false);
});

test("hover preview shows a variant without changing the active one or its pixels", () => {
  const { uc, source } = harness();
  const layer = uc.sprites.createFromLayer(source);
  const neutral = layer.sprite.variants[0];
  const other = { ...neutral, id: "other", name: "other", pixels: new FakeCanvas(layer.sprite.rect.width, layer.sprite.rect.height) };
  other.pixels.fill(0, 0, 10, 10, [255, 0, 0, 255]);
  layer.sprite.variants.push(other);
  uc.sprites.preview(layer, "other");
  assert.deepEqual(alphaBox(layer.canvas), { x: layer.sprite.rect.x, y: layer.sprite.rect.y, width: 10, height: 10 });
  const snapshot = uc.createLayerPixelSnapshot(layer);
  assert.equal(snapshot.sprite.activeVariantId, neutral.id);
  assert.equal(layer.sprite.variants[0].pixels, neutral.pixels, "a snapshot during a preview ends it without copying the preview");
  assert.deepEqual(alphaBox(layer.canvas), { x: 100, y: 100, width: 40, height: 80 });
});

test("moving the layer moves every variant: only the shared rect changes", () => {
  const { uc, source } = harness();
  const layer = uc.sprites.createFromLayer(source);
  const rect = { ...layer.sprite.rect };
  const pixels = layer.sprite.variants[0].pixels;
  const drag = {};
  uc.sprites.onMove(layer, drag, 10.4, -5);
  uc.sprites.onMove(layer, drag, 20, -5);
  assert.deepEqual(layer.sprite.rect, { ...rect, x: rect.x + 20, y: rect.y - 5 }, "moves are relative to the gesture start");
  assert.equal(layer.sprite.variants[0].pixels, pixels);
});

test("paint lands in the active variant only, paint-all replays strokes with copy on write", () => {
  const { uc, source } = harness();
  const layer = uc.sprites.createFromLayer(source);
  const neutral = layer.sprite.variants[0];
  const other = { ...neutral, id: "other", name: "other", pixels: new FakeCanvas(layer.sprite.rect.width, layer.sprite.rect.height) };
  layer.sprite.variants.push(other);
  const before = uc.createLayerPixelSnapshot(layer);
  layer.canvas.fill(100, 100, 4, 4, [0, 255, 0, 255]);
  uc.invalidateLayerCaches(layer);
  const after = uc.createLayerPixelSnapshot(layer);
  assert.notEqual(after.sprite.variants[0].pixels, before.sprite.variants[0].pixels, "the active variant got a new canvas");
  assert.equal(after.sprite.variants[1].pixels, other.pixels, "the others are untouched");
  const x = 100 - layer.sprite.rect.x, y = 100 - layer.sprite.rect.y;
  assert.equal(layer.sprite.variants[0].pixels.data[(y * layer.sprite.rect.width + x) * 4 + 1], 255);
  uc.sprites.setPaintAll(layer, true);
  const shared = layer.sprite.variants[1].pixels;
  uc.sprites.onStroke(layer, { x: 110, y: 110 }, { x: 112, y: 112 }, { size: 4, opacity: 1, color: "#ff0000", erase: false });
  uc.sprites.onStroke(layer, { x: 112, y: 112 }, { x: 114, y: 114 }, { size: 4, opacity: 1, color: "#ff0000", erase: false });
  assert.notEqual(layer.sprite.variants[1].pixels, shared, "copied before the first stroke of the gesture");
  assert.equal(layer.sprite.variants[1].pixels.strokes, 2, "one copy per gesture");
  assert.equal(shared.strokes, 0, "the history snapshot's canvas is never drawn into");
});

test("paint outside the rect grows it and pads every variant", () => {
  const { uc, source } = harness();
  const layer = uc.sprites.createFromLayer(source);
  const rect = { ...layer.sprite.rect };
  const anchor = { ...layer.sprite.anchor };
  layer.canvas.fill(20, 20, 4, 4, [0, 255, 0, 255]);
  uc.invalidateLayerCaches(layer);
  uc.createLayerPixelSnapshot(layer);
  assert.deepEqual(layer.sprite.rect, { x: 20, y: 20, width: rect.x + rect.width - 20, height: rect.y + rect.height - 20 });
  assert.deepEqual(layer.sprite.anchor, { x: anchor.x + rect.x - 20, y: anchor.y + rect.y - 20 }, "the anchor stays on the feet");
});

test("variants and the active variant survive a save and reload", async () => {
  const { uc, source } = harness();
  const layer = uc.sprites.createFromLayer(source);
  uc.sprites.addCustom(layer, { name: "armor", kind: "outfit", text: "plate armor" });
  const extra = { ...layer.sprite.variants[0], id: "red", name: "red", pixels: new FakeCanvas(layer.sprite.rect.width, layer.sprite.rect.height) };
  extra.pixels.fill(0, 0, 5, 5, [255, 0, 0, 255]);
  layer.sprite.variants.push(extra);
  uc.sprites.setActiveVariant(layer, "red");
  const saved = JSON.parse(JSON.stringify(uc.sprites.serialize(layer, true)));
  assert.ok(saved.variants.find((variant) => variant.id === "red").dataURL);
  assert.equal(saved.variants.find((variant) => variant.name === "armor").dataURL, undefined, "empty variants carry no pixels");
  assert.equal(uc.sprites.serialize(layer, false).variants[0].dataURL, undefined, "metadata-only for the node widget");
  const restored = { id: layer.id, type: "sprite", canvas: new FakeCanvas(256, 256) };
  await uc.sprites.restore(restored, saved);
  assert.equal(restored.sprite.activeVariantId, "red");
  assert.equal(restored.sprite.variants.length, 3);
  assert.equal(restored.sprite.variants.find((variant) => variant.name === "armor").status, "empty");
  assert.deepEqual([...restored.sprite.variants.find((variant) => variant.id === "red").pixels.data], [...extra.pixels.data]);
  assert.deepEqual(serializeSpriteState(snapshotSprite(restored.sprite)).rect, saved.rect);
});

test("a staged variant is accepted into its variant as one undo step", async () => {
  const { uc, source, history, staged } = harness();
  const layer = uc.sprites.createFromLayer(source);
  uc.sprites.addPresets(layer);
  const { rect } = layer.sprite;
  layer.sprite.faceRect = { x: 108 - rect.x, y: 100 - rect.y, width: 24, height: 20 };
  stubDraw();
  const happy = layer.sprite.variants.find((variant) => variant.name === "happy");
  uc.settings.batch_size = 2;
  await uc.sprites.stageVariant(layer, happy.id);
  assert.equal(staged.length, 1, "the stub returns one image per request");
  assert.equal(happy.status, "empty", "staging applies nothing");
  const count = history.length;
  uc.sprites.acceptStaged(staged[0]);
  assert.equal(happy.status, "ready");
  assert.equal(layer.sprite.activeVariantId, happy.id);
  assert.equal(history.length, count + 1);
  undo(uc, history.at(-1));
  assert.equal(layer.sprite.variants.find((variant) => variant.name === "happy").status, "empty");
});

test("Split variant to layer copies the active variant into a raster layer above the sprite", () => {
  const { uc, source } = harness();
  const layer = uc.sprites.createFromLayer(source);
  const copy = uc.sprites.splitVariantToLayer(layer);
  assert.equal(copy.type, "raster");
  assert.equal(copy.groupId, "g1");
  assert.deepEqual(alphaBox(copy.canvas), { x: 100, y: 100, width: 40, height: 80 });
  assert.equal(uc.layers.indexOf(copy), uc.layers.indexOf(layer) - 1);
});

test("the widget only receives hook calls", () => {
  assert.match(widget, /installUniCanvasSprites\(this, \{ modelModule: getUniCanvasModelModule \}\)/);
  assert.match(widget, /this\.sprites\?\.syncFromCanvas\(layer\);\n    const crop = this\.getLayerAlphaBounds\(layer\)/);
  assert.match(widget, /\.\.\.this\.sprites\?\.snapshot\(layer\)/);
  assert.match(widget, /this\.sprites\?\.restoreSnapshot\(layer, snapshot\)/);
  assert.match(widget, /Object\.assign\(clone, this\.sprites\?\.cloneLayerFields\(layer\)\)/);
  assert.match(widget, /if \(entry\.kind === SPRITE_VARIANT_HISTORY_KIND\) this\.sprites\?\.applyVariantHistory\(entry, direction\)/);
  assert.match(widget, /this\.sprites\?\.onMove\(layer, source, dx, dy\)/);
  assert.match(widget, /this\.sprites\?\.onTransform\(layer, draft\)/);
  assert.match(widget, /this\.sprites\?\.onStroke\(layer, start, end,/);
  assert.match(widget, /if \(staging\.sprite\) return this\.sprites\?\.acceptStaged\(staging\)/);
  assert.match(widget, /fields\.sprite = this\.sprites\?\.serialize\(layer, includeData\)/);
  assert.match(widget, /if \(layer\.type === "sprite"\) await this\.sprites\?\.restore\(layer, item\.sprite\)/);
  assert.match(modes, /widget\.sprites\?\.cycleActive\(key === "\." \? 1 : -1\)/);
});

/* ------------------------------------------------------------------------------------------------
 * Panorama documents (#6, #33): a stand-in sphere where turning the camera by `yaw` degrees
 * slides the 256px editing window along a 512px strip by `yaw` pixels.
 * ---------------------------------------------------------------------------------------------- */

function withPanorama(uc, yaw = 0) {
  const offset = (camera) => 128 + Math.round(camera.yaw);
  const toSphere = (view, camera) => { const sphere = new FakeCanvas(512, 256); sphere.getContext().drawImage(view, offset(camera), 0); return sphere; };
  const fromSphere = (sphere, camera) => { const view = new FakeCanvas(256, 256); if (sphere) view.getContext().drawImage(sphere, -offset(camera), 0); return view; };
  const doc = {
    settings: { yaw, pitch: 0, roll: 0, fov: 90 },
    commitLayer(layer) {
      if (!layer._panoramaDirty) return;
      layer.panoramaCanvas = toSphere(layer.canvas, doc.settings);
      layer.panoramaRevision = (layer.panoramaRevision || 0) + 1;
      layer._panoramaDirty = false;
    },
    projectLayer(layer) { layer.canvas = fromSphere(layer.panoramaCanvas, doc.settings); uc.invalidateLayerCaches(layer); layer._panoramaDirty = false; },
    viewOfLayer(layer, camera) { doc.commitLayer(layer); return fromSphere(layer.panoramaCanvas, camera); },
    replaceLayerFromView(layer, view, camera) {
      layer.panoramaCanvas = toSphere(view, camera);
      layer.panoramaRevision = (layer.panoramaRevision || 0) + 1;
      doc.projectLayer(layer);
    },
    reprojectView: (view, from, to) => fromSphere(toSphere(view, from), to),
    turn(next) {
      for (const layer of uc.layers) if (layer.canvas) doc.commitLayer(layer);
      doc.settings = { ...doc.settings, yaw: next };
      for (const layer of uc.layers) if (layer.panoramaCanvas) doc.projectLayer(layer);
    },
  };
  for (const name of ["invalidateLayerCaches", "invalidateLayerRenderCaches"]) {
    const original = uc[name];
    uc[name] = (layer) => { original(layer); layer._panoramaDirty = true; };
  }
  uc.panorama = doc;
  uc.bbox = { x: 0, y: 0, width: 256, height: 256 };
  return doc;
}

function redVariant(layer, id = "red") {
  const variant = { ...layer.sprite.variants[0], id, name: id, pixels: new FakeCanvas(layer.sprite.rect.width, layer.sprite.rect.height) };
  variant.pixels.fill(0, 0, 10, 10, [255, 0, 0, 255]);
  layer.sprite.variants.push(variant);
  return variant;
}

test("a panorama sprite set remembers its camera and survives save and reload with it", () => {
  const { uc, source } = harness();
  withPanorama(uc, 0);
  assert.equal(spriteSourceIssue(source), null, "sprite sets are no longer refused in panoramas");
  const layer = uc.sprites.createFromLayer(source);
  assert.deepEqual(layer.sprite.panoramaCamera, { yaw: 0, pitch: 0, roll: 0, fov: 90 });
  assert.deepEqual(alphaBox(layer.panoramaCanvas), { x: 228, y: 100, width: 40, height: 80 }, "the sphere holds the neutral variant");
  const saved = serializeSpriteState(layer.sprite);
  assert.deepEqual(normalizeSpriteState(saved).panoramaCamera, layer.sprite.panoramaCamera);
  assert.equal(normalizeSpriteState({ ...saved, panoramaCamera: { yaw: "x" } }).panoramaCamera, undefined);
  assert.deepEqual(snapshotSprite(layer.sprite).panoramaCamera, layer.sprite.panoramaCamera);
});

test("switching variants from another view lands at the sprite's place on the sphere", () => {
  const { uc, source } = harness();
  const doc = withPanorama(uc, 0);
  const layer = uc.sprites.createFromLayer(source);
  const rect = { ...layer.sprite.rect };
  redVariant(layer);
  doc.turn(30);
  const neutral = layer.sprite.variants[0].pixels;
  uc.createLayerPixelSnapshot(layer);
  assert.equal(layer.sprite.variants[0].pixels, neutral, "turning the camera does not re-copy the active variant");
  assert.equal(uc.sprites.setActiveVariant(layer, "red"), true);
  assert.deepEqual(alphaBox(layer.panoramaCanvas), { x: 128 + rect.x, y: rect.y, width: 10, height: 10 });
  assert.deepEqual(alphaBox(layer.canvas), { x: rect.x - 30, y: rect.y, width: 10, height: 10 }, "seen from the current view");
  assert.deepEqual(layer.sprite.rect, rect, "the rect stays in the sprite's own view");
});

test("paint in another view reaches the active variant in the sprite's own view", () => {
  const { uc, source } = harness();
  const doc = withPanorama(uc, 0);
  const layer = uc.sprites.createFromLayer(source);
  const rect = { ...layer.sprite.rect };
  doc.turn(30);
  layer.canvas.fill(80, 150, 2, 2, [0, 255, 0, 255]);
  uc.invalidateLayerCaches(layer);
  uc.createLayerPixelSnapshot(layer);
  const active = layer.sprite.variants[0].pixels;
  const at = ((150 - rect.y) * active.width + (110 - rect.x)) * 4;
  assert.deepEqual([...active.data.subarray(at, at + 4)], [0, 255, 0, 255]);
});

test("a move in another view re-anchors the set to that view first", () => {
  const { uc, source } = harness();
  const doc = withPanorama(uc, 0);
  const layer = uc.sprites.createFromLayer(source);
  const rect = { ...layer.sprite.rect };
  const red = redVariant(layer);
  doc.turn(30);
  uc.sprites.onMove(layer, {}, 10, 0);
  assert.deepEqual(layer.sprite.panoramaCamera, { yaw: 30, pitch: 0, roll: 0, fov: 90 });
  assert.deepEqual(layer.sprite.rect, { ...rect, x: rect.x - 30 + 10 });
  assert.deepEqual(alphaBox(red.pixels), { x: 0, y: 0, width: 10, height: 10 }, "every variant keeps its pixels");
  assert.ok(layer.sprite.anchor.x >= 0 && layer.sprite.anchor.x <= layer.sprite.rect.width);
  const again = { ...layer.sprite.rect };
  uc.sprites.onMove(layer, {}, 0, 0);
  assert.deepEqual(layer.sprite.rect, again, "an anchored set is not re-projected again");
});

test("Split variant to layer in a panorama puts the variant on the sphere at the sprite's place", () => {
  const { uc, source } = harness();
  const doc = withPanorama(uc, 0);
  const layer = uc.sprites.createFromLayer(source);
  doc.turn(-20);
  const copy = uc.sprites.splitVariantToLayer(layer);
  assert.deepEqual(alphaBox(copy.panoramaCanvas), { x: 228, y: 100, width: 40, height: 80 });
  assert.deepEqual(alphaBox(copy.canvas), { x: 120, y: 100, width: 40, height: 80 });
});

test("view points map between panorama cameras through the sphere", async () => {
  const { mapViewPoint, normalizeSpriteCamera, sameSpriteCamera } = await import("../web/vnccs_unicanvas_sprites_panorama.mjs");
  const frame = { x: 0, y: 0, width: 1024, height: 1024 };
  const front = { yaw: 0, pitch: 0, roll: 0, fov: 90 };
  const same = mapViewPoint({ x: 300, y: 700 }, frame, front, front);
  assert.ok(Math.abs(same.x - 300) < 1e-6 && Math.abs(same.y - 700) < 1e-6);
  const turned = mapViewPoint({ x: 512, y: 512 }, frame, front, { ...front, yaw: 30 });
  assert.ok(Math.abs(turned.y - 512) < 1e-6 && Math.abs(Math.abs(turned.x - 512) - 512 * Math.tan(Math.PI / 6)) < 1e-6, "the centre slides by tan(30°)");
  assert.equal(mapViewPoint({ x: 512, y: 512 }, frame, front, { ...front, yaw: 180 }), null, "behind the camera");
  assert.deepEqual(normalizeSpriteCamera({ yaw: 10, pitch: 5 }), { yaw: 10, pitch: 5, roll: 0, fov: 90 });
  assert.equal(normalizeSpriteCamera({ yaw: NaN }), null);
  assert.equal(sameSpriteCamera(front, { ...front, fov: 90.0000001 }), true);
  assert.equal(sameSpriteCamera(front, null), false);
});
