import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as THREE from "../web/three.module.js";
import { applyPose, buildRig } from "../scripts/interaction_presets/rig.mjs";
import { controlSourceRect, defaultControlState, resolveControlNetSupport } from "../web/vnccs_unicanvas_control.mjs";
import {
  COCO18_KEYPOINTS, CONTROL_SCENE_TYPES, OPENPOSE_COLORS, OPENPOSE_LIMBS, adjustDepth, adjustLineart, cannyEdges,
  controlPlacementRect, controlSourceSize, downscaleGray, drawOpenPose, installUniCanvasControlScene, isSceneControlType,
  luminance, normalizeControlSource, normalizeSceneParams, openPoseFromRig, placeOpenPosePeople, poseLayersUnder,
  poseLinkSignature, sceneTypesFor,
} from "../web/vnccs_unicanvas_control_scene.mjs";

const widgetSource = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const controlSource = readFileSync(new URL("../web/vnccs_unicanvas_control.mjs", import.meta.url), "utf8");
const poseSource = readFileSync(new URL("../web/vnccs_unicanvas_pose.mjs", import.meta.url), "utf8");

const zImage = { key: "z_image", capabilities: { label: "Z-image", control_net: {
  types: ["canny", "depth", "pose", "lineart", "mlsd", "scribble", "gray"].map((key) => ({ key, label: key })), max_strength: 2,
} } };
const h3 = { key: "minimax_h3", capabilities: { label: "MiniMax H3", control_net: { types: ["depth", "canny", "pose", "mlsd"], supports_range: true } } };
const descriptors = new Map([["z_image", zImage], ["minimax_h3", h3]]);

// --- types and state ---------------------------------------------------------------------------

test("the type menu offers only the scene types the selected family accepts", () => {
  assert.deepEqual(sceneTypesFor(resolveControlNetSupport(descriptors, "z_image")).map((item) => item.key), ["canny", "depth", "pose", "lineart"]);
  assert.deepEqual(sceneTypesFor(resolveControlNetSupport(descriptors, "minimax_h3")).map((item) => item.key), ["depth", "canny", "pose"]);
  assert.deepEqual(sceneTypesFor(null), []);
  assert.equal(isSceneControlType("mlsd"), false);
});

test("the stored source is sanitized: old states have none, params are clamped", () => {
  assert.equal(normalizeControlSource(null), null);
  assert.equal(normalizeControlSource({ type: "scribble", bbox: { x: 0, y: 0, width: 8, height: 8 } }), null);
  assert.equal(normalizeControlSource({ type: "depth", bbox: { x: 0, y: 0, width: 0, height: 8 } }), null);
  const source = normalizeControlSource({
    id: "s1", type: "depth", bbox: { x: 10, y: 20, width: 300, height: 200 }, image: "data:image/png;base64,AAA",
    params: { depth: { gamma: 99, invert: 1 }, canny: { low: -5 } },
  });
  assert.equal(source.id, "s1");
  assert.deepEqual(source.params.depth, { near: 1, far: 0, gamma: 3, invert: true });
  assert.equal(source.params.canny.low, 0);
  assert.deepEqual(source.params.pose, CONTROL_SCENE_TYPES.pose.defaults);
  assert.equal(source.linked, false, "only pose sources link");
  assert.equal(normalizeControlSource({ type: "pose", bbox: { x: 0, y: 0, width: 4, height: 4 } }).linked, true);
  assert.equal(normalizeControlSource({ type: "depth", bbox: source.bbox, image: "javascript:alert(1)" }).image, null);
  // A saved source round-trips through JSON (the state cache) unchanged.
  assert.deepEqual(normalizeControlSource(JSON.parse(JSON.stringify(source))), source);
});

test("the result lands on the layer exactly where the draw crops it (pixel-for-pixel)", () => {
  const origin = { x: -200, y: -100 };
  const bbox = { x: 100, y: 50, width: 512, height: 256 };
  assert.deepEqual(controlPlacementRect(bbox, origin), controlSourceRect(bbox, origin));
  assert.deepEqual(controlPlacementRect(bbox, origin), { x: 300, y: 150, width: 512, height: 256 });
  assert.deepEqual(controlSourceSize(bbox), { width: 512, height: 256 });
  // Big bboxes are captured at a capped size and drawn back scaled to the same rect.
  assert.deepEqual(controlSourceSize({ x: 0, y: 0, width: 4096, height: 1024 }), { width: 2048, height: 512 });
});

// --- pixel operations --------------------------------------------------------------------------

test("depth: near/far clip, gamma and invert work on the raw map", () => {
  const raw = Uint8Array.from([0, 64, 128, 191, 255]);
  assert.deepEqual([...adjustDepth(raw, {})], [0, 64, 128, 191, 255]);
  assert.deepEqual([...adjustDepth(raw, { invert: true })], [255, 191, 127, 64, 0]);
  const clipped = adjustDepth(raw, { near: 0.75, far: 0.25 });
  assert.equal(clipped[0], 0);
  assert.equal(clipped[4], 255);
  assert.ok(Math.abs(clipped[2] - 128) <= 2);
  assert.ok(adjustDepth(raw, { gamma: 2 })[2] < 70, "gamma darkens the mid tones");
});

function squareImage(size = 32, from = 8, to = 24) {
  const gray = new Uint8Array(size * size);
  for (let y = from; y < to; y += 1) for (let x = from; x < to; x += 1) gray[y * size + x] = 200;
  return gray;
}

test("canny finds the outline of a square and nothing inside it", () => {
  const size = 32;
  const edges = cannyEdges(squareImage(), size, size, { low: 50, high: 150, blur: 1 });
  const at = (x, y) => edges[y * size + x];
  assert.equal(at(16, 16), 0, "flat inside");
  assert.equal(at(2, 2), 0, "flat outside");
  const border = [7, 8, 23, 24].some((x) => at(x, 16) === 255);
  assert.ok(border, "an edge on the left or right side");
  assert.ok([7, 8, 23, 24].some((y) => at(16, y) === 255), "an edge on the top or bottom side");
  const strict = cannyEdges(squareImage(), size, size, { low: 490, high: 500, blur: 1 });
  assert.ok(strict.reduce((a, b) => a + b, 0) < edges.reduce((a, b) => a + b, 0), "higher thresholds keep fewer edges");
});

test("lineart: threshold binarizes, thickness dilates, invert flips", () => {
  const width = 5, height = 5;
  const raw = new Uint8Array(25);
  raw[12] = 200; raw[0] = 40;
  assert.deepEqual([...adjustLineart(raw, width, height, {})], [...raw]);
  const binary = adjustLineart(raw, width, height, { threshold: 0.5 });
  assert.equal(binary[12], 255);
  assert.equal(binary[0], 0);
  const thick = adjustLineart(raw, width, height, { threshold: 0.5, thickness: 1 });
  assert.equal([...thick].filter((v) => v === 255).length, 9);
  assert.equal(adjustLineart(raw, width, height, { threshold: 0.5, invert: true })[12], 0);
});

test("preview helpers: luminance ignores transparent pixels and previews downscale", () => {
  assert.deepEqual([...luminance(Uint8ClampedArray.from([255, 255, 255, 255, 255, 255, 255, 0]), 2, 1)], [255, 0]);
  const small = downscaleGray(new Uint8Array(1024 * 1024), 1024, 1024, 512 * 512);
  assert.deepEqual([small.width, small.height], [512, 512]);
  assert.equal(downscaleGray(new Uint8Array(4), 2, 2, 100).width, 2);
});

// --- pose ---------------------------------------------------------------------------------------

test("the mannequin's joints map to OpenPose COCO-18 (front view, headless rig)", () => {
  const rig = buildRig();
  applyPose(rig, {});
  rig.root.updateMatrixWorld(true);
  const worldOf = (name, offset) => {
    const bone = rig.bones[name];
    if (!bone) return null;
    return offset ? bone.localToWorld(new THREE.Vector3(...offset)) : bone.getWorldPosition(new THREE.Vector3());
  };
  // A camera in front of the mannequin (+Z) looking back: the character's right is image left.
  const points = openPoseFromRig(worldOf, (p) => ({ x: (p.x + 10) / 20, y: (10 - p.y) / 20 }));
  const at = Object.fromEntries(COCO18_KEYPOINTS.map((name, index) => [name, points[index]]));
  assert.equal(points.length, 18);
  assert.ok(points.every(Boolean), "every joint is found");
  assert.ok(at.r_shoulder.x < at.neck.x && at.neck.x < at.l_shoulder.x);
  assert.ok(Math.abs(at.neck.y - at.r_shoulder.y) < 0.01, "the OpenPose neck sits between the shoulders");
  assert.ok(at.r_eye.y < at.nose.y && at.nose.y < at.neck.y, "eyes above the nose above the neck");
  assert.ok(at.r_ear.x < at.r_eye.x && at.l_eye.x < at.l_ear.x, "ears outside the eyes");
  assert.ok(at.r_hip.y < at.r_knee.y && at.r_knee.y < at.r_ankle.y);
  // A joint behind the camera is left out.
  assert.equal(openPoseFromRig(worldOf, () => null).filter(Boolean).length, 0);
});

test("pose people are placed from the pose rect into the source bbox", () => {
  const entries = [{ rect: { x: 100, y: 0, width: 200, height: 400 }, offset: { x: 10, y: 0 }, people: [{ points: [{ x: 0.5, y: 0.25 }, null] }] }];
  const [person] = placeOpenPosePeople(entries, { x: 0, y: 0, width: 400, height: 400 }, { width: 200, height: 200 });
  assert.deepEqual(person, [{ x: 105, y: 50 }, null]);
});

test("the OpenPose skeleton is drawn on black in the standard colors", () => {
  const fills = [];
  const ctx = {
    save() {}, restore() {}, beginPath() {}, fill() { fills.push(this.fillStyle); }, fillRect() { fills.push(`rect:${this.fillStyle}`); },
    ellipse() {}, arc() {}, fillStyle: "", globalAlpha: 1, globalCompositeOperation: "",
  };
  const points = COCO18_KEYPOINTS.map((_, index) => ({ x: index, y: index }));
  drawOpenPose(ctx, [points], { width: 64, height: 64 }, {});
  assert.equal(fills[0], "rect:#000");
  assert.equal(fills.length, 1 + OPENPOSE_LIMBS.length + COCO18_KEYPOINTS.length);
  assert.equal(fills[1], "rgb(153,0,0)", "limbs at 60 % of their color");
  assert.equal(fills.at(-1), `rgb(${OPENPOSE_COLORS[17].join(",")})`);
});

test("pose links track the pose layers under the bbox and their joints", () => {
  const pose = { id: "p", type: "pose", visible: true, pose: { rect: { x: 0, y: 0, width: 100, height: 100 }, openpose: { people: [] } } };
  const other = { id: "q", type: "pose", visible: true, pose: { rect: { x: 500, y: 500, width: 10, height: 10 } } };
  assert.deepEqual(poseLayersUnder([pose, other], { x: 50, y: 50, width: 100, height: 100 }).map((l) => l.id), ["p"]);
  const first = poseLinkSignature([pose], ["p"]);
  pose.pose.openpose = { people: [{ points: [{ x: 0.1, y: 0.1 }] }] };
  const moved = poseLinkSignature([pose], ["p"]);
  assert.notEqual(first, moved, "a mannequin edit changes the link");
  pose.pose.rect = { ...pose.pose.rect, x: 20 };
  assert.notEqual(poseLinkSignature([pose], ["p"]), moved, "moving the pose layer changes the link");
});

// --- installed behaviour --------------------------------------------------------------------------

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {}; this.events = {};
    this.classList = { add() {}, toggle() {} };
    this.textContent = ""; this.value = ""; this.checked = false; this.type = "";
  }
  append(...nodes) { this.children.push(...nodes); }
  addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
  fire(name) { for (const callback of this.events[name] || []) callback({}); }
  querySelectorAll(selector) {
    const match = selector.match(/^\[data-([a-z-]+)(?:="([^"]*)")?\]$/);
    const key = match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const out = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (child.dataset && key in child.dataset && (match[2] === undefined || child.dataset[key] === match[2])) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function install(layers) {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  const frames = [];
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  const history = [];
  const support = resolveControlNetSupport(descriptors, "z_image");
  const uc = {
    layers, container: new FakeElement(), bbox: { x: 0, y: 0, width: 64, height: 64 }, origin: { x: 0, y: 0 },
    controlLayers: { support: () => support, panel: new FakeElement(), renderPanel() {} },
    pushHistoryEntry: (entry) => history.push(entry), setStatus: (text) => { uc.status = text; },
    createLayerPixelSnapshot: (layer) => ({ id: layer.id, painted: layer.painted }), syncLightStateToWidget() {}, refreshLayerRow() {},
    getLayerStateOffset: () => ({ x: 0, y: 0 }),
  };
  const api = installUniCanvasControlScene(uc);
  const painted = [];
  // Pixels are not the point here: record what is painted with which params.
  api.raw = async () => ({ gray: new Uint8Array(4), width: 2, height: 2 });
  api.renderResult = (source, type, raw, params, options = {}) => ({ type, params, preview: Boolean(options.preview) });
  api.paint = (layer, source, result) => { layer.painted = result; painted.push(result); };
  return { uc, api, history, painted, frames, support };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a slider re-renders while dragging and commits one history entry on release", async () => {
  const source = normalizeControlSource({ id: "s", type: "depth", bbox: { x: 0, y: 0, width: 64, height: 64 }, image: "data:image/png;base64,AA" });
  const layer = { id: "c", name: "ControlNet", type: "control", control: defaultControlState(null, "depth"), controlSource: source };
  const { api, history, painted, frames } = install([layer]);
  api.renderSection(api.support() && new FakeElement(), layer);
  for (const value of [0.9, 0.8, 0.7]) api.setParam(layer, "near", value);
  assert.equal(frames.length, 1, "one frame per burst of input events");
  frames.shift()();
  await flush();
  assert.equal(painted.length, 1, "the layer changes before the pointer is released");
  assert.equal(painted[0].params.near, 0.7, "the newest value wins");
  assert.equal(history.length, 0, "no history while dragging");
  api.setParam(layer, "near", 0.6, { commit: true });
  await flush();
  assert.equal(history.length, 1);
  assert.equal(history[0].kind, "historyGroup");
  assert.deepEqual(history[0].entries.map((entry) => entry.kind), ["layerProps", "layerPixels"]);
  assert.equal(history[0].entries[0].before.controlSource, source);
  assert.equal(layer.controlSource.params.depth.near, 0.6);
  assert.notEqual(layer.controlSource, source, "the source is replaced, never mutated");
});

test("changing the type re-runs the preprocessor on the stored source as one step", async () => {
  const source = normalizeControlSource({ id: "s", type: "depth", bbox: { x: 0, y: 0, width: 64, height: 64 }, image: "data:image/png;base64,AA" });
  const layer = { id: "c", name: "ControlNet", type: "control", control: defaultControlState(null, "depth"), controlSource: source };
  const { api, history, painted } = install([layer]);
  assert.equal(await api.changeType(layer, "canny"), true);
  await flush();
  assert.equal(painted.at(-1).type, "canny");
  assert.equal(layer.control.type, "canny");
  assert.equal(layer.controlSource.image, source.image, "the same source");
  assert.equal(history.length, 1);
  assert.equal(await api.changeType({ ...layer, controlSource: null }, "canny"), false, "layers without a source keep #45 behaviour");
});

test("hand edits are remembered, detach a pose link, and re-runs ask first", async () => {
  const source = normalizeControlSource({ id: "s", type: "pose", bbox: { x: 0, y: 0, width: 64, height: 64 }, poseLayerIds: ["p"] });
  const layer = { id: "c", name: "ControlNet", type: "control", control: defaultControlState(null, "pose"), controlSource: source };
  const { api, history } = install([layer]);
  const wrapped = api.wrapHistoryEntry({ kind: "layerPixels", layerId: "c", before: {}, after: {} });
  assert.equal(wrapped.kind, "historyGroup", "the brush stroke and the detach are one undo step");
  assert.equal(layer.controlSource.linked, false);
  assert.equal(layer.controlSource.handEdited, true);
  assert.equal(api.wrapHistoryEntry({ kind: "layerPixels", layerId: "c" }), null, "already detached");
  let ran = 0;
  api.guard(layer, "Relink", () => { ran += 1; });
  assert.equal(ran, 0, "waits for the answer");
  assert.equal(api.pending.layerId, "c");
  const panel = new FakeElement();
  api.renderSection(panel, layer);
  panel.querySelector("[data-scene-confirm]").fire("click");
  assert.equal(ran, 1);
  api.relink(layer);
  assert.equal(layer.controlSource.linked, true);
  assert.equal(history.at(-1).kind, "historyGroup");
});

test("a linked pose control follows its pose layer until it is detached", () => {
  const pose = { id: "p", type: "pose", visible: true, pose: { rect: { x: 0, y: 0, width: 64, height: 64 }, openpose: { people: [] } } };
  const source = normalizeControlSource({ id: "s", type: "pose", bbox: { x: 0, y: 0, width: 64, height: 64 }, poseLayerIds: ["p"] });
  const layer = { id: "c", name: "ControlNet", type: "control", control: defaultControlState(null, "pose"), controlSource: source };
  const { api, painted, frames } = install([layer, pose]);
  api.syncLinked(layer);
  assert.equal(frames.length, 0, "first sight only records the state");
  pose.pose.openpose = { people: [{ points: [{ x: 0.5, y: 0.5 }] }] };
  api.syncLinked(layer);
  frames.shift()();
  assert.equal(painted.length, 1, "the mannequin edit redraws the control layer");
  api.wrapHistoryEntry({ kind: "layerPixels", layerId: "c" });
  pose.pose.openpose = { people: [] };
  api.syncLinked(layer);
  assert.equal(frames.length, 0, "a detached layer keeps its hand edits");
});

test("the panel offers From scene, Refresh from scene and the live sliders", () => {
  const layer = { id: "c", name: "ControlNet", type: "control", control: defaultControlState(null, "depth") };
  const { api } = install([layer]);
  let panel = new FakeElement();
  api.renderSection(panel, layer);
  assert.equal(panel.querySelector("[data-control-from-scene]").textContent, "From scene");
  layer.controlSource = normalizeControlSource({ id: "s", type: "lineart", bbox: { x: 0, y: 0, width: 8, height: 8 }, image: "data:image/png;base64,AA" });
  panel = new FakeElement();
  api.renderSection(panel, layer);
  assert.equal(panel.querySelector("[data-control-from-scene]").textContent, "Refresh from scene");
  assert.deepEqual(panel.querySelectorAll("[data-scene-param]").map((input) => input.dataset.sceneParam), ["threshold", "thickness", "invert"]);
});

test("From scene refuses a type the family does not accept", async () => {
  const layer = { id: "c", name: "ControlNet", type: "control", control: defaultControlState(null, "depth") };
  const { api, uc } = install([layer]);
  uc.controlLayers.support = () => resolveControlNetSupport(descriptors, "minimax_h3");
  await api.fromScene(layer, "lineart");
  assert.match(uc.status, /does not accept lineart/);
});

test("params outside the slider ranges are clamped", () => {
  assert.deepEqual(normalizeSceneParams("pose", { lineWidth: 100, jointSize: -1 }), { lineWidth: 16, jointSize: 1 });
  assert.deepEqual(normalizeSceneParams("mlsd", {}), {});
});

// --- widget and module hooks ---------------------------------------------------------------------

test("the widget, the control panel and the pose editor are wired to the scene module", () => {
  assert.match(widgetSource, /installUniCanvasControlScene\(this\);/);
  assert.match(widgetSource, /entry = this\.controlScene\?\.wrapHistoryEntry\(entry\) \?\? entry;/);
  assert.match(widgetSource, /fields\.controlSource = this\.controlScene\?\.serialize\(layer\);/);
  assert.match(widgetSource, /layer\.controlSource = normalizeControlSource\(item\.controlSource\)/);
  assert.match(widgetSource, /async projectPoseLayer\(layer\)/);
  assert.match(controlSource, /uc\.controlScene\?\.renderSection\(panel, layer\);/);
  assert.match(controlSource, /uc\.controlScene\?\.changeType\(layer, select\.value\)/);
  assert.match(controlSource, /uc\.controlScene\?\.syncLinked\(layer\);/);
  assert.match(poseSource, /this\.updateOpenPose\(\);/);
  assert.match(poseSource, /layer\.pose\.openpose = \{ key: poseIdKey\(layer\.pose\), people \};/);
});
