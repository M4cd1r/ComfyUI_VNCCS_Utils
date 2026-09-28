import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installUniCanvasSprites, normalizeSpriteState } from "../web/vnccs_unicanvas_sprites.mjs";
import { LAYER_MENU_ITEMS, layerMenuItemAvailable, runLayerMenuAction } from "../web/vnccs_unicanvas_layer_tools.mjs";
import { restoreGroupStructure } from "../web/vnccs_unicanvas_groups.mjs";
import { normalizeSceneStates } from "../web/vnccs_unicanvas_states.mjs";
import { createTimeline, normalizeTimeline, setKey } from "../web/vnccs_unicanvas_timeline_core.mjs";
import { isUniCanvasLayerMenuItemEnabled, resetUniCanvasToggles, setUniCanvasToggleValue } from "../web/vnccs_unicanvas_feature_toggles.mjs";

const widget = fs.readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const spritesSource = fs.readFileSync(new URL("../web/vnccs_unicanvas_sprites.mjs", import.meta.url), "utf8");

/* ------------------------------------------------------------------------------------------------
 * The software canvas and controller harness of the sprite suite, reduced to what rasterize needs.
 * ---------------------------------------------------------------------------------------------- */

class FakeCanvas {
  constructor(width = 1, height = 1) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.data = new Uint8ClampedArray(this.width * this.height * 4);
  }
  getContext() {
    const canvas = this;
    return {
      canvas, fillStyle: "#000000", globalCompositeOperation: "source-over",
      save() {}, restore() {}, translate() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {},
      clearRect(x, y, w, h) { canvas.fill(x, y, w, h, [0, 0, 0, 0]); },
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
      if (source.data[from + 3] === 255) this.data.set(source.data.subarray(from, from + 4), to);
    }
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

function characterCanvas() {
  const canvas = new FakeCanvas(256, 256);
  canvas.getContext().fillStyle = "#3050c0";
  canvas.fill(100, 100, 40, 80, [48, 80, 192, 255]);
  return canvas;
}

function harness() {
  let revision = 0;
  let id = 0;
  const history = [];
  const statuses = [];
  const source = { id: "src", name: "Hero", type: "raster", visible: true, locked: false, opacity: 1, groupId: "g1", meta: { origin: "paint" }, canvas: characterCanvas(), pixelRevision: ++revision };
  const group = { id: "g1", type: "group", name: "Characters", visible: true, groupId: null };
  const uc = {
    layers: [group, source], activeLayerId: "src", selectedLayerIds: ["src"], origin: { x: 0, y: 0 }, size: { width: 256, height: 256 },
    settings: { generation_mode: "qwen_image_edit", positive: "", seed: 5, seed_mode: "fixed", batch_size: 1 }, tool: "move",
    timeline: null, sceneStates: { activeStateId: null, moveScope: null, newLayersHidden: false, states: [] },
    stagingItems: [], activeStagingIndex: -1,
    get activeLayer() { return this.layers.find((layer) => layer.id === this.activeLayerId) || null; },
    _createCanvas: (w, h) => new FakeCanvas(w, h),
    _escape: (value) => String(value),
    getLayerAlphaBounds(layer) {
      if (layer._boundsCache !== undefined) return layer._boundsCache;
      layer._boundsCache = alphaBox(layer.canvas);
      return layer._boundsCache;
    },
    invalidateLayerCaches(layer) { layer.pixelRevision = ++revision; layer._boundsCache = undefined; },
    invalidateLayerRenderCaches(layer) { layer.pixelRevision = ++revision; },
    createLayerPixelSnapshot(layer) { return { id: layer.id }; },
    restoreLayerPixelSnapshot() {},
    pushHistoryEntry: (entry) => history.push(entry),
    addLayer(type, name, _record, _defer, meta) {
      const layer = { id: `l${++id}`, name, type, visible: true, locked: false, opacity: 1, blendMode: "source-over", meta, canvas: new FakeCanvas(256, 256), pixelRevision: ++revision };
      uc.layers.unshift(layer);
      uc.activeLayerId = layer.id;
      return layer;
    },
    normalizeLayerOrder() {}, ensureWorldBounds: () => true, setStatus: (text, error) => statuses.push([text, Boolean(error)]),
    requestRender() {}, render() {}, renderLayerList() {}, syncActiveLayerControls() {}, refreshLayerRow() {}, syncToNode() {},
  };
  installUniCanvasSprites(uc, { modelModule: () => null });
  return { uc, source, history, statuses };
}

/** A sprite set over the source: the ready neutral, a ready "red" and an empty "armor". */
function spriteSet(uc, source) {
  const layer = uc.sprites.createFromLayer(source);
  const neutral = layer.sprite.variants[0];
  const red = { ...neutral, id: "var_red", name: "red", pixels: new FakeCanvas(neutral.pixels.width, neutral.pixels.height) };
  red.pixels.fill(0, 0, red.pixels.width, red.pixels.height, [255, 0, 0, 255]);
  layer.sprite.variants.push(red);
  uc.sprites.addCustom(layer, { name: "armor", kind: "outfit", text: "plate armor" });
  return layer;
}

/** Applies the entries the widget's applyHistoryEntry would apply (the real restore helpers). */
function applyEntry(uc, entry, direction) {
  if (entry.kind === "historyGroup") {
    const children = direction === "undo" ? [...entry.entries].reverse() : entry.entries;
    for (const child of children) applyEntry(uc, child, direction);
    return;
  }
  if (entry.kind === "groupStructure") {
    uc.layers = restoreGroupStructure(uc.layers, direction === "undo" ? entry.before : entry.after);
    uc.normalizeLayerOrder();
    uc.activeLayerId = direction === "undo" ? entry.activeBefore : entry.activeAfter;
  }
  if (entry.kind === "sceneStates") uc.sceneStates = normalizeSceneStates(direction === "undo" ? entry.before : entry.after);
  if (entry.kind === "timeline") uc.timeline = normalizeTimeline(direction === "undo" ? entry.before : entry.after);
}

/* ------------------------------------------------------------------------------------------------
 * The rasterize operation
 * ---------------------------------------------------------------------------------------------- */

test("Rasterize turns the sprite set into a group in its place: one raster layer per ready variant", async () => {
  const { uc, source, history, statuses } = harness();
  const layer = spriteSet(uc, source);
  const place = uc.layers.indexOf(layer);
  const recorded = history.length;
  const activeId = layer.sprite.activeVariantId;
  const rect = { ...layer.sprite.rect };
  const result = await uc.sprites.rasterizeSpriteSet(layer);

  assert.equal(result.type, "group", "the group is the result");
  assert.equal(result.name, layer.name, "the group takes the sprite layer's name");
  assert.equal(result.groupId, "g1", "the group takes the sprite layer's parent");
  assert.equal(uc.layers.includes(layer), false, "the sprite layer disappears");
  assert.equal(uc.layers.indexOf(result), place, "at the sprite layer's stack place");
  assert.equal(uc.layers.indexOf(uc.layers.filter((item) => item.groupId === result.id).at(-1)), uc.layers.indexOf(source) - 1, "the bottom child sits right above the source");
  assert.equal(uc.activeLayerId, result.id);

  const kids = uc.layers.filter((item) => item.groupId === result.id);
  assert.equal(kids.length, 2, "empty and failed variants are skipped");
  assert.deepEqual(kids.map((kid) => kid.name), ["Hero red", "Hero neutral"], "the base variant sits at the bottom");
  assert.deepEqual(kids.map((kid) => kid.visible), [false, true], "the active variant is the visible one");
  for (const kid of kids) {
    assert.equal(kid.type, "raster");
    assert.equal(kid.meta.origin, "rasterize");
    assert.equal(kid.meta.derivedFrom, layer.id);
    assert.equal(kid.groupId, result.id);
  }
  const redKid = kids.find((kid) => kid.name === "Hero red");
  const neutralKid = kids.find((kid) => kid.name === "Hero neutral");
  const at = ((rect.y + 5) * redKid.canvas.width + (rect.x + 5)) * 4;
  assert.deepEqual([...redKid.canvas.data.subarray(at, at + 4)], [255, 0, 0, 255], "the red variant carries its own pixels");
  assert.deepEqual(alphaBox(redKid.canvas), rect, "the red pixels cover the whole shared rect");
  assert.deepEqual(alphaBox(neutralKid.canvas), { x: 100, y: 100, width: 40, height: 80 }, "the neutral pixels keep the character's bounds");

  assert.equal(source.visible, false, "the hidden source layer stays untouched");
  assert.equal(source.type, "raster");
  assert.ok(uc.layers.includes(source));

  assert.equal(history.length, recorded + 1, "one undo step for the whole operation");
  assert.equal(history.at(-1).kind, "historyGroup");
  assert.deepEqual(history.at(-1).entries.map((entry) => entry.kind), ["groupStructure"]);
  assert.match(statuses.at(-1)[0], /group with 2 layers/);
  assert.match(statuses.at(-1)[0], /1 empty or failed variant skipped/);
});

test("the group takes over opacity, blend, visibility and lock of the sprite layer", async () => {
  const { uc, source } = harness();
  const layer = spriteSet(uc, source);
  layer.opacity = 0.5;
  layer.blendMode = "multiply";
  layer.visible = false;
  const result = await uc.sprites.rasterizeSpriteSet(layer);
  assert.equal(result.opacity, 0.5);
  assert.equal(result.blendMode, "multiply");
  assert.equal(result.visible, false);
  const kids = uc.layers.filter((item) => item.groupId === result.id);
  assert.deepEqual(kids.map((kid) => kid.visible), [false, true], "children keep their flags; the hidden group hides them all");
});

test("scene states switching the variant show exactly that child layer afterwards", async () => {
  const { uc, source, history } = harness();
  const layer = spriteSet(uc, source);
  const red = layer.sprite.variants.find((variant) => variant.name === "red");
  uc.sceneStates = { activeStateId: "s1", moveScope: null, newLayersHidden: false, states: [
    { id: "s1", name: "Red", layers: { [layer.id]: { visible: true, opacity: 0.8, blendMode: "source-over", offset: null, spriteVariantId: red.id } } },
    { id: "s2", name: "Hidden", layers: { [layer.id]: { visible: false, opacity: 1, blendMode: "source-over", offset: null } } },
    { id: "s3", name: "Other", layers: { src: { visible: true, opacity: 1, blendMode: "source-over", offset: null } } },
  ] };
  const recorded = history.length;
  const result = await uc.sprites.rasterizeSpriteSet(layer);
  const [redKid, neutralKid] = uc.layers.filter((item) => item.groupId === result.id);
  const states = uc.sceneStates.states;

  assert.equal(states[0].layers[layer.id], undefined, "the sprite layer's entry is gone");
  assert.equal(states[0].layers[redKid.id].visible, true, "the state that switched to red shows the red layer");
  assert.equal(states[0].layers[neutralKid.id].visible, false, "and hides the others");
  assert.equal(states[1].layers[result.id].visible, false, "a state that hid the sprite hides the group");
  assert.equal(states[2].layers.src.visible, true, "unrelated states stay untouched");
  assert.deepEqual(history.at(-1).entries.map((entry) => entry.kind), ["groupStructure", "sceneStates"]);
  assert.equal(history.length, recorded + 1);
});

test("timeline: the spriteVariant track becomes visible keys, variant effects are dropped with a warning", async () => {
  const { uc, source, history, statuses } = harness();
  const layer = spriteSet(uc, source);
  const red = layer.sprite.variants.find((variant) => variant.name === "red");
  uc.timeline = createTimeline();
  setKey(uc.timeline, layer.id, "spriteVariant", 0, layer.sprite.activeVariantId);
  setKey(uc.timeline, layer.id, "spriteVariant", 12, red.id);
  uc.timeline = normalizeTimeline({ ...uc.timeline, effects: [
    { id: "fx_blink", target: layer.id, kind: "blink", params: { minInterval: 2, maxInterval: 6, variantId: red.id }, start: 0, end: null },
    { id: "fx_bob", target: layer.id, kind: "bob", params: { amount: 6, period: 1.2 }, start: 0, end: null },
  ] });

  let seenRefs = null;
  const recorded = history.length;
  const result = await uc.sprites.rasterizeSpriteSet(layer, { confirm: async (_confirmLayer, refs) => { seenRefs = refs; return true; } });
  const [redKid, neutralKid] = uc.layers.filter((item) => item.groupId === result.id);

  assert.ok(seenRefs, "the confirmation dialog received the reference list");
  assert.deepEqual(seenRefs.filter((ref) => ref.kind === "key").map((ref) => [ref.frame, ref.variantId]), [[0, layer.sprite.activeVariantId], [12, red.id]]);
  assert.deepEqual(seenRefs.filter((ref) => ref.kind === "effect").map((ref) => ref.effect), ["blink"]);

  assert.equal(uc.timeline.tracks[`${layer.id}:spriteVariant`], undefined, "the sprite track is gone");
  const visibleKeys = (kid) => uc.timeline.tracks[`${kid.id}:visible`].keys.map((key) => [key.frame, key.value]);
  assert.deepEqual(visibleKeys(redKid), [[0, false], [12, true]], "red shows from frame 12");
  assert.deepEqual(visibleKeys(neutralKid), [[0, true], [12, false]], "neutral shows until frame 12");
  assert.deepEqual(uc.timeline.effects.map((effect) => effect.id), ["fx_bob"], "the blink effect is removed, plain effects stay");
  assert.match(statuses.at(-1)[0], /Blink effect removed/);
  assert.deepEqual(history.at(-1).entries.map((entry) => entry.kind), ["groupStructure", "timeline"]);
  assert.equal(history.length, recorded + 1);
});

test("references require the confirmation dialog, and canceling changes nothing", async () => {
  const { uc, source, history, statuses } = harness();
  const layer = spriteSet(uc, source);
  const red = layer.sprite.variants.find((variant) => variant.name === "red");
  uc.sceneStates = { activeStateId: null, moveScope: null, newLayersHidden: false, states: [
    { id: "s1", name: "Red", layers: { [layer.id]: { visible: true, opacity: 1, blendMode: "source-over", offset: null, spriteVariantId: red.id } } },
  ] };
  const recorded = history.length;
  const canceled = await uc.sprites.rasterizeSpriteSet(layer, { confirm: async () => false });
  assert.equal(canceled, null);
  assert.ok(uc.layers.includes(layer), "the sprite layer stays");
  assert.deepEqual(uc.layers.filter((item) => item.type === "group").map((item) => item.id), ["g1"], "no group was created");
  assert.equal(uc.sceneStates.states[0].layers[layer.id].spriteVariantId, red.id, "the states keep their references");
  assert.equal(history.length, recorded, "no history entry for a canceled rasterize");
  assert.equal(statuses.at(-1)[1], false);

  // Without references no dialog is needed: the default path (no browser in the tests) proceeds.
  delete uc.sceneStates.states[0].layers[layer.id];
  const result = await uc.sprites.rasterizeSpriteSet(layer);
  assert.equal(result.type, "group");
  assert.equal(history.length, recorded + 1, "still one new entry for the whole operation");
});

test("guards: locked layer, active transform, staged results and sets without ready variants refuse", async () => {
  const { uc, source, history, statuses } = harness();
  const layer = spriteSet(uc, source);
  const recorded = history.length;

  layer.locked = true;
  assert.equal(await uc.sprites.rasterizeSpriteSet(layer), null);
  assert.match(statuses.at(-1)[0], /Unlock the sprite layer first/);
  layer.locked = false;

  uc.transformDraft = { quad: {} };
  assert.equal(await uc.sprites.rasterizeSpriteSet(layer), null);
  assert.match(statuses.at(-1)[0], /Apply or cancel the active transform first/);
  uc.transformDraft = null;

  uc.stagingItems = [{ sprite: {} }];
  assert.equal(await uc.sprites.rasterizeSpriteSet(layer), null);
  assert.match(statuses.at(-1)[0], /staged sprite results|Accept or discard/);
  uc.stagingItems = [];

  const empty = { id: "sp_empty", name: "Empty", type: "sprite", visible: true, locked: false, opacity: 1, groupId: null, canvas: new FakeCanvas(256, 256), sprite: normalizeSpriteState({ variants: [] }) };
  uc.layers = [empty];
  assert.equal(await uc.sprites.rasterizeSpriteSet(empty), null);
  assert.match(statuses.at(-1)[0], /no generated variant/);
  assert.equal(history.length, recorded, "a refusal records no history");
});

test("one undo step restores layers, states and timeline; redo rebuilds the rasterized group", async () => {
  const { uc, source, history } = harness();
  const layer = spriteSet(uc, source);
  const red = layer.sprite.variants.find((variant) => variant.name === "red");
  uc.sceneStates = { activeStateId: null, moveScope: null, newLayersHidden: false, states: [
    { id: "s1", name: "Red", layers: { [layer.id]: { visible: true, opacity: 1, blendMode: "source-over", offset: null, spriteVariantId: red.id } } },
  ] };
  uc.timeline = createTimeline();
  setKey(uc.timeline, layer.id, "spriteVariant", 5, red.id);
  const before = {
    order: uc.layers.map((item) => item.id),
    variants: layer.sprite.variants.length,
    states: JSON.stringify(uc.sceneStates),
    track: Object.keys(uc.timeline.tracks),
    effects: uc.timeline.effects.length,
  };
  const result = await uc.sprites.rasterizeSpriteSet(layer);
  assert.deepEqual(history.at(-1).entries.map((entry) => entry.kind), ["groupStructure", "sceneStates", "timeline"]);

  applyEntry(uc, history.at(-1), "undo");
  assert.deepEqual(uc.layers.map((item) => item.id), before.order, "undo restores the stack with the sprite layer");
  const restored = uc.layers.find((item) => item.id === layer.id);
  assert.equal(restored.sprite.variants.length, before.variants, "the sprite set comes back complete");
  assert.equal(uc.activeLayerId, layer.id);
  assert.equal(uc.sceneStates.states[0].layers[layer.id].spriteVariantId, red.id, "the state keeps its variant switch");
  assert.deepEqual(Object.keys(uc.timeline.tracks), before.track, "the spriteVariant track comes back");
  assert.equal(uc.timeline.effects.length, before.effects);

  applyEntry(uc, history.at(-1), "redo");
  assert.equal(uc.layers.includes(layer), false, "redo removes the sprite layer again");
  const kids = uc.layers.filter((item) => item.groupId === result.id);
  assert.equal(kids.length, 2);
  assert.equal(uc.sceneStates.states[0].layers[layer.id], undefined);
  const redChild = uc.layers.find((item) => item.groupId === result.id);
  assert.ok(uc.timeline.tracks[`${redChild.id}:visible`], "the visible keys come back");
  applyEntry(uc, history.at(-1), "undo");
  assert.equal(uc.layers.includes(layer), true);
});

test("a panorama sprite set rasterizes onto the sphere at the sprite's place", async () => {
  const { uc, source } = harness();
  const offset = (camera) => 128 + Math.round(camera.yaw);
  const toSphere = (view, camera) => { const sphere = new FakeCanvas(512, 256); sphere.getContext().drawImage(view, offset(camera), 0); return sphere; };
  const fromSphere = (sphere, camera) => { const view = new FakeCanvas(256, 256); if (sphere) view.getContext().drawImage(sphere, -offset(camera), 0); return view; };
  const doc = {
    settings: { yaw: 0, pitch: 0, roll: 0, fov: 90 },
    commitLayer(layer) {
      if (!layer._panoramaDirty) return;
      layer.panoramaCanvas = toSphere(layer.canvas, doc.settings);
      layer.panoramaRevision = (layer.panoramaRevision || 0) + 1;
      layer._panoramaDirty = false;
    },
    projectLayer(layer) { layer.canvas = fromSphere(layer.panoramaCanvas, doc.settings); uc.invalidateLayerCaches(layer); layer._panoramaDirty = false; },
    replaceLayerFromView(layer, view, camera) {
      layer.panoramaCanvas = toSphere(view, camera);
      layer.panoramaRevision = (layer.panoramaRevision || 0) + 1;
      doc.projectLayer(layer);
    },
    reprojectView: (view, from, to) => fromSphere(toSphere(view, from), to),
  };
  const originalInvalidate = uc.invalidateLayerCaches;
  uc.invalidateLayerCaches = (layer) => { originalInvalidate(layer); layer._panoramaDirty = true; };
  uc.panorama = doc;
  const layer = spriteSet(uc, source);
  const rect = { ...layer.sprite.rect };
  assert.deepEqual(layer.sprite.panoramaCamera, { yaw: 0, pitch: 0, roll: 0, fov: 90 });
  const result = await uc.sprites.rasterizeSpriteSet(layer);
  const [redKid, neutralKid] = uc.layers.filter((item) => item.groupId === result.id);
  assert.deepEqual(alphaBox(redKid.panoramaCanvas), { x: 128 + rect.x, y: rect.y, width: rect.width, height: rect.height }, "the red variant lands on the sphere");
  assert.deepEqual(alphaBox(neutralKid.panoramaCanvas), { x: 228, y: 100, width: 40, height: 80 }, "the neutral variant keeps the character's bounds");
});

/* ------------------------------------------------------------------------------------------------
 * Layer menu, feature toggles and wiring
 * ---------------------------------------------------------------------------------------------- */

test("the one Rasterize menu entry covers pose layers and sprite sets", () => {
  const item = LAYER_MENU_ITEMS.find((entry) => entry.id === "rasterize");
  assert.ok(item, "the common Rasterize entry exists");
  assert.equal(item.rasterizable, true);
  assert.equal(item.label, "Rasterize", "the shared label stays");
  const uc = { selectedLayerIds: [] };
  assert.equal(layerMenuItemAvailable(uc, { type: "sprite", sprite: { variants: [] } }, item), true);
  assert.equal(layerMenuItemAvailable(uc, { type: "pose", pose: {} }, item), true);
  assert.equal(layerMenuItemAvailable(uc, { type: "raster", canvas: {} }, item), false);
  assert.equal(layerMenuItemAvailable(uc, { type: "group" }, item), false);
  assert.equal(layerMenuItemAvailable(uc, { type: "sprite" }, item), false, "a sprite entry without state is not a sprite set");
  assert.equal(item.multiselectLabel(uc, { type: "sprite", sprite: {} }), "Rasterize to layers (group)");
  assert.equal(item.multiselectLabel(uc, { type: "pose" }), "Rasterize");
});

test("runLayerMenuAction routes Rasterize to the sprite or the pose path", () => {
  const item = LAYER_MENU_ITEMS.find((entry) => entry.id === "rasterize");
  const routed = [];
  const widget = {
    rasterizeSpriteLayer: (layer) => routed.push(["sprite", layer]),
    rasterizePoseLayer: (layer) => routed.push(["pose", layer]),
  };
  const sprite = { id: "s", type: "sprite", sprite: { variants: [] } };
  const pose = { id: "p", type: "pose" };
  runLayerMenuAction(widget, sprite, item);
  runLayerMenuAction(widget, pose, item);
  assert.deepEqual(routed, [["sprite", sprite], ["pose", pose]]);
  const bare = { setStatus: () => {} };
  assert.equal(runLayerMenuAction(bare, sprite, item), undefined, "without the widget hook it degrades to a status");
});

test("feature toggles never gate Rasterize: the group is the result, not a tool", () => {
  setUniCanvasToggleValue("groups", false, { notify: false });
  setUniCanvasToggleValue("sprites", false, { notify: false });
  assert.equal(isUniCanvasLayerMenuItemEnabled("rasterize"), true, "existing sprite sets stay rasterizable");
  assert.equal(isUniCanvasLayerMenuItemEnabled("create-sprite-set"), false, "creating new sets stays gated");
  resetUniCanvasToggles();
  assert.equal(isUniCanvasLayerMenuItemEnabled("rasterize"), true);
});

test("row caption, panel button and the widget exposure are wired", () => {
  const { uc, source } = harness();
  const layer = spriteSet(uc, source);
  const html = uc.sprites.rowTypeHTML(layer);
  assert.match(html, /vnccs-uc-sprite-type-icon/);
  assert.match(html, /Sprite set · neutral · 3 variants/);
  layer.sprite.activeVariantId = "var_red";
  assert.match(uc.sprites.rowTypeHTML(layer), /Sprite set · red · 3 variants/);
  layer.visible = false;
  assert.match(uc.sprites.rowTypeHTML(layer), / hidden$/);
  assert.equal(uc.sprites.rowTypeHTML(source), null, "other layers keep the plain type caption");
  assert.equal(uc.sprites.rowTypeHTML({ type: "sprite" }), null);

  assert.match(widget, /rasterizeSpriteLayer\(layer\) \{\s*return this\.sprites\?\.rasterizeSpriteSet\?\.\(layer\);/, "the widget exposes uc.rasterizeSpriteLayer next to the pose one");
  assert.match(widget, /this\.sprites\?\.rowTypeHTML\?\.\(layer\)/, "the row caption comes from the sprite module");
  assert.match(widget, /vnccs-uc-layer-sprite-panel/, "the row carries the show-panel button");
  assert.match(spritesSource, /Rasterize to layers/, "the panel header carries the Rasterize button");
  assert.match(spritesSource, /data-sprite-toast/, "creating a set announces itself next to the row");
  assert.match(spritesSource, /focusPanel/, "the panel can be focused from the row");
});
