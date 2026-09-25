import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  INTERPOLATION_PRESETS as CORE_PRESETS,
  adjacentKeyFrame,
  applyInterpolation,
  findKeySegment,
  framesForElapsed,
  retimeFrameCount,
} from "../web/vnccs_animation_core.mjs";
import { INTERPOLATION_PRESETS as POSE_PRESETS, applyInterpolation as poseApplyInterpolation, playbackFrameForElapsed } from "../web/vnccs_pose_animation.mjs";
import {
  CAMERA_TARGET,
  TIMELINE_HISTORY_KIND,
  advancePlaybackFrame,
  applyMatrix,
  applyMotionPreset,
  blinkSchedule,
  composeLayerMatrix,
  copyKeys,
  createTimeline,
  deleteKeys,
  evaluateEffects,
  evaluateTarget,
  evaluateTrack,
  findEffectVariants,
  insertStateKeys,
  invertMatrix,
  isTimelineEmpty,
  localMatrix,
  normalizeTimeline,
  pasteKeys,
  pruneTimelineTargets,
  serializeTimeline,
  setKey,
  trackIdFor,
  transformRectBounds,
} from "../web/vnccs_unicanvas_timeline_core.mjs";
import { installUniCanvasTimeline } from "../web/vnccs_unicanvas_timeline.mjs";

const near = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

// Shared animation core ---------------------------------------------------------------------------

test("Pose Studio imports the shared core instead of forking it", () => {
  assert.equal(POSE_PRESETS, CORE_PRESETS);
  assert.equal(poseApplyInterpolation, applyInterpolation);
  assert.equal(playbackFrameForElapsed(1000, 12), 12);
  assert.equal(framesForElapsed(500, 24, { minFps: 1, maxFps: 60 }), 12);
  const source = readFileSync(new URL("../web/vnccs_pose_animation.mjs", import.meta.url), "utf8");
  assert.match(source, /from "\.\/vnccs_animation_core\.mjs"/);
  assert.doesNotMatch(source, /function applyInterpolation\(/);
  assert.doesNotMatch(source, /function resolveKeyframeSelections\(/);
});

test("findKeySegment applies the left key's interpolation and clamps outside the keys", () => {
  const keys = [{ frame: 0, interpolation: "linear" }, { frame: 10, interpolation: "hold" }, { frame: 20, interpolation: "linear" }];
  assert.equal(findKeySegment([], 3), null);
  near(findKeySegment(keys, 5).t, 0.5);
  assert.equal(findKeySegment(keys, 15).t, 0);
  assert.equal(findKeySegment(keys, 30).left, keys[2]);
  assert.equal(findKeySegment(keys, -2).right, keys[0]);
});

test("retime and adjacent keys work on any track shape", () => {
  const state = { frameCount: 11, currentFrame: 10, tracks: { a: { keys: [{ id: "1", frame: 0 }, { id: "2", frame: 10 }] } } };
  retimeFrameCount(state, 21, { minFrames: 2, maxFrames: 100 });
  assert.deepEqual(state.tracks.a.keys.map((key) => key.frame), [0, 20]);
  assert.equal(state.currentFrame, 20);
  assert.equal(adjacentKeyFrame(state, null, 5, 1), 20);
  assert.equal(adjacentKeyFrame(state, ["a"], 5, -1), 0);
  assert.equal(adjacentKeyFrame(state, ["a"], 0, -1), null);
});

// Data model -----------------------------------------------------------------------------------

test("defaults, limits and normalization of a timeline", () => {
  const timeline = createTimeline();
  assert.equal(timeline.fps, 24);
  assert.equal(timeline.frameCount, 72);
  assert.equal(timeline.loop, true);
  assert.deepEqual(timeline.workArea, { start: 0, end: 71 });
  const clamped = normalizeTimeline({ fps: 500, frameCount: 99999, currentFrame: -4 });
  assert.equal(clamped.fps, 60);
  assert.equal(clamped.frameCount, 3600);
  assert.equal(clamped.currentFrame, 0);
  assert.equal(normalizeTimeline({ fps: 0, frameCount: 1 }).fps, 1);
  assert.equal(normalizeTimeline({ fps: 0, frameCount: 1 }).frameCount, 2);
  const dropped = normalizeTimeline({
    tracks: {
      bad: { target: "L", property: "nope", keys: [] },
      camOnLayer: { target: "L", property: "rect", keys: [] },
      ok: { target: "L", property: "position", keys: [{ frame: 3, value: [1, 2] }, { frame: 4, value: "x" }] },
    },
    effects: [{ kind: "breathe", target: "L" }, { kind: "unknown", target: "L" }],
  });
  assert.deepEqual(Object.keys(dropped.tracks), ["L:position"]);
  assert.equal(dropped.tracks["L:position"].keys.length, 1);
  assert.equal(dropped.effects.length, 1);
});

test("an empty default timeline serializes to nothing so old states stay unchanged", () => {
  assert.equal(serializeTimeline(null), null);
  assert.equal(serializeTimeline(createTimeline()), null);
  assert.ok(isTimelineEmpty(createTimeline()));
  assert.ok(serializeTimeline(createTimeline({ fps: 12 })));
  const timeline = createTimeline();
  setKey(timeline, "L", "position", 10, [5, 0]);
  const saved = serializeTimeline(timeline);
  assert.deepEqual(normalizeTimeline(JSON.parse(JSON.stringify(saved))).tracks, timeline.tracks);
});

test("two position keys interpolate linearly and hold steps", () => {
  const timeline = createTimeline();
  setKey(timeline, "L", "position", 0, [0, 0], "linear");
  setKey(timeline, "L", "position", 20, [200, -40], "linear");
  assert.deepEqual(evaluateTrack(timeline, "L:position", 10), [100, -20]);
  setKey(timeline, "L", "position", 0, [0, 0], "hold");
  assert.deepEqual(evaluateTrack(timeline, "L:position", 19), [0, 0]);
  assert.deepEqual(evaluateTrack(timeline, "L:position", 20), [200, -40]);
  setKey(timeline, "L", "visible", 5, false);
  assert.equal(evaluateTrack(timeline, "L:visible", 4), false);
  assert.equal(evaluateTrack(timeline, "L:visible", 50), false);
  assert.equal(evaluateTrack(timeline, "L:opacity", 3), undefined);
});

test("copy / paste moves keys across layers and delete prunes empty tracks", () => {
  const timeline = createTimeline();
  const a = setKey(timeline, "A", "position", 2, [1, 1]);
  const b = setKey(timeline, "A", "opacity", 6, 0.5);
  const clipboard = copyKeys(timeline, [{ trackName: "A:position", keyId: a.id }, { trackName: "A:opacity", keyId: b.id }]);
  const pasted = pasteKeys(timeline, clipboard, 30, "B");
  assert.deepEqual(pasted.map((item) => [item.trackName, item.frame]), [["B:position", 30], ["B:opacity", 34]]);
  deleteKeys(timeline, [{ trackName: "A:position", keyId: a.id }]);
  assert.equal(timeline.tracks["A:position"], undefined);
  pruneTimelineTargets(timeline, ["B"]);
  assert.deepEqual(Object.keys(timeline.tracks).sort(), ["B:opacity", "B:position"]);
});

// Effects --------------------------------------------------------------------------------------

test("a seeded blink switches the variant on the same frames across runs", () => {
  const raw = { effects: [{ id: "fx-1", kind: "blink", target: "S", params: { variantId: "closed" }, start: 0, end: null }], frameCount: 600 };
  const first = normalizeTimeline(raw);
  const second = normalizeTimeline(JSON.parse(JSON.stringify(raw)));
  const closedFrames = (timeline) => Array.from({ length: 600 }, (_, frame) => frame).filter((frame) => evaluateEffects(timeline, "S", frame).variantId === "closed");
  const a = closedFrames(first);
  assert.deepEqual(a, closedFrames(second));
  assert.ok(a.length > 0);
  for (const blink of blinkSchedule(first.effects[0], 24, 599)) assert.ok(blink.length === 3 || blink.length === 4);
  const gaps = blinkSchedule(first.effects[0], 24, 599).slice(1).map((blink, index, list) => blink.start - (index ? list[index - 1].start : blinkSchedule(first.effects[0], 24, 599)[0].start));
  for (const gap of gaps) assert.ok(gap >= 2 * 24 && gap <= 6 * 24 + 4, `gap ${gap}`);
});

test("breathe stays inside its range, talk alternates, shake decays", () => {
  const timeline = normalizeTimeline({
    frameCount: 240,
    effects: [
      { id: "b", kind: "breathe", target: "L", params: { amount: 0.01, period: 4 }, start: 0 },
      { id: "t", kind: "talk", target: "T", params: { rate: 10, openVariantId: "open", closedVariantId: "shut" }, start: 0, end: 48 },
      { id: "s", kind: "shake", target: "K", params: { amount: 10, decay: 5 }, start: 0, end: 48 },
    ],
  });
  for (let frame = 0; frame < 240; frame += 7) {
    const { scaleY } = evaluateEffects(timeline, "L", frame);
    assert.ok(scaleY >= 0.99 - 1e-9 && scaleY <= 1.01 + 1e-9);
  }
  const variants = new Set(Array.from({ length: 48 }, (_, frame) => evaluateEffects(timeline, "T", frame).variantId));
  assert.deepEqual([...variants].sort(), ["open", "shut"]);
  assert.equal(evaluateEffects(timeline, "T", 60).variantId, null);
  const early = Math.hypot(...Object.values(evaluateEffects(timeline, "K", 1)).slice(0, 2));
  assert.ok(early <= 10 * Math.SQRT2);
  const late = evaluateEffects(timeline, "K", 47);
  assert.ok(Math.abs(late.dx) < 1 && Math.abs(late.dy) < 1);
});

// Matrices -------------------------------------------------------------------------------------

test("render matrices: state offset, group chain, anchor scale and rotation", () => {
  const scale = localMatrix({ tx: 0, ty: 0, sx: 2, sy: 2, rotation: 0 }, { x: 10, y: 10 });
  assert.deepEqual(applyMatrix(scale, { x: 10, y: 10 }), { x: 10, y: 10 });
  assert.deepEqual(applyMatrix(scale, { x: 12, y: 10 }), { x: 14, y: 10 });
  const rotate = localMatrix({ rotation: 90 }, { x: 0, y: 0 });
  const point = applyMatrix(rotate, { x: 1, y: 0 });
  near(point.x, 0); near(point.y, 1);
  const composed = composeLayerMatrix({ x: 5, y: 0 }, [{ state: { tx: 10, ty: 0 }, anchor: { x: 0, y: 0 } }, { state: { tx: 0, ty: 3 }, anchor: { x: 0, y: 0 } }]);
  assert.deepEqual(applyMatrix(composed, { x: 0, y: 0 }), { x: 15, y: 3 });
  const inverse = invertMatrix(composeLayerMatrix({ x: 0, y: 0 }, [{ state: { sx: 2, sy: 2, rotation: 30, tx: 4, ty: 7 }, anchor: { x: 3, y: 9 } }]));
  const forward = composeLayerMatrix({ x: 0, y: 0 }, [{ state: { sx: 2, sy: 2, rotation: 30, tx: 4, ty: 7 }, anchor: { x: 3, y: 9 } }]);
  const round = applyMatrix(inverse, applyMatrix(forward, { x: 17, y: -5 }));
  near(round.x, 17); near(round.y, -5);
  assert.deepEqual(transformRectBounds([2, 0, 0, 2, 1, 1], { x: 0, y: 0, width: 10, height: 5 }), { x: 1, y: 1, width: 20, height: 10 });
});

// Presets and states ---------------------------------------------------------------------------

test("motion presets insert ordinary keys and effects at the playhead", () => {
  const timeline = createTimeline();
  assert.ok(applyMotionPreset(timeline, "L", "enterLeft", 10, { distance: 300, restOpacity: 1 }).ok);
  assert.deepEqual(evaluateTrack(timeline, "L:position", 10), [-300, 0]);
  assert.deepEqual(evaluateTrack(timeline, "L:position", 22), [0, 0]);
  assert.equal(evaluateTrack(timeline, "L:opacity", 10), 0);
  assert.equal(evaluateTrack(timeline, "L:opacity", 22), 1);
  assert.ok(applyMotionPreset(timeline, "P", "popIn", 0).ok);
  assert.deepEqual(evaluateTrack(timeline, "P:scale", 0), [0.9, 0.9]);
  assert.ok(applyMotionPreset(timeline, "P", "breathe", 0).ok);
  assert.equal(timeline.effects.length, 1);
  assert.deepEqual(applyMotionPreset(timeline, "P", "blink", 0, { variants: {} }), { ok: false, missing: "blink" });
  assert.ok(applyMotionPreset(timeline, "P", "blink", 0, { variants: { blink: "v1" } }).ok);
  assert.deepEqual(findEffectVariants({ variants: [{ id: "n", name: "neutral" }, { id: "b", name: "Eyes closed" }, { id: "m", name: "mouth open" }] }), { blink: "b", mouthOpen: "m", mouthClosed: "n" });
});

test("insert state as keys reproduces a scene state relative to the live offsets", () => {
  const timeline = createTimeline();
  const layers = [{ id: "A", type: "raster", stateOffset: { x: 10, y: 0 } }, { id: "M", type: "mask" }];
  const written = insertStateKeys(timeline, layers, { layers: { A: { visible: false, opacity: 0.4, offset: { x: 30, y: 5 } }, M: { visible: true } } }, 12);
  assert.equal(written, 3);
  assert.equal(evaluateTrack(timeline, "A:visible", 12), false);
  assert.equal(evaluateTrack(timeline, "A:opacity", 12), 0.4);
  assert.deepEqual(evaluateTrack(timeline, "A:position", 12), [20, 5]);
});

test("playback wraps inside the work area when looping and stops otherwise", () => {
  const timeline = createTimeline({ frameCount: 20, workArea: { start: 5, end: 9 } });
  assert.deepEqual(advancePlaybackFrame(timeline, 5, 7), { frame: 7, done: false });
  timeline.loop = false;
  assert.deepEqual(advancePlaybackFrame(timeline, 5, 7), { frame: 9, done: true });
  assert.deepEqual(advancePlaybackFrame(timeline, 5, 2), { frame: 7, done: false });
});

// Widget controller (no DOM) -------------------------------------------------------------------

function fakeWidget() {
  const layer = { id: "L", type: "raster", visible: true, opacity: 1, name: "Hero" };
  const group = { id: "G", type: "group", visible: true, opacity: 1, name: "Folder" };
  layer.groupId = "G";
  const uc = {
    standalone: true,
    layers: [layer, group],
    activeLayerId: "L",
    get activeLayer() { return this.layers.find((item) => item.id === this.activeLayerId); },
    bbox: { x: 0, y: 0, width: 512, height: 512 },
    undoStack: [],
    renders: 0,
    pushHistoryEntry(entry) { this.undoStack.push(entry); },
    requestRender() { this.renders++; },
    render() { return this.layers.map((item) => ({ id: item.id, visible: item.visible, opacity: item.opacity, matrix: item._timelineFrame?.matrix || null })); },
    makeExportCanvas() { return this.layers.map((item) => item._timelineFrame?.matrix || null); },
    getLayerStateOffset: () => ({ x: 0, y: 0 }),
    getLayerRestBounds: () => ({ x: 100, y: 100, width: 50, height: 100 }),
  };
  installUniCanvasTimeline(uc);
  return { uc, layer, group };
}

test("the timeline controller is standalone only and leaves the rest scene alone when closed", async () => {
  const { uc } = fakeWidget();
  const panel = uc.timelinePanel;
  const node = { layers: [], standalone: false };
  installUniCanvasTimeline(node);
  assert.equal(node.timelinePanel.isAvailable(), false);
  panel.ensureData();
  setKey(uc.timeline, "L", "position", 0, [40, 0]);
  assert.equal(panel.viewFrame(), null);
  assert.equal(uc.render()[0].matrix, null);
  panel.open = true;
  assert.deepEqual(uc.render()[0].matrix, [1, 0, 0, 1, 40, 0]);
  // Composites keep the rest scene while the dock is open.
  assert.deepEqual(uc.makeExportCanvas(), [null, null]);
  assert.equal(panel.layerMatrix(uc.layers[0]) !== null, true);
  uc._timelineCompositeFrame = 0;
  assert.deepEqual(uc.makeExportCanvas()[0], [1, 0, 0, 1, 40, 0]);
});

test("frame visibility and opacity apply for one render only, groups move their children", () => {
  const { uc, layer } = fakeWidget();
  const panel = uc.timelinePanel;
  panel.open = true;
  const timeline = panel.ensureData();
  setKey(timeline, "L", "opacity", 0, 0.25);
  setKey(timeline, "G", "visible", 0, false);
  setKey(timeline, "G", "position", 0, [0, 30]);
  const drawn = uc.render();
  assert.deepEqual(drawn.find((item) => item.id === "L"), { id: "L", visible: true, opacity: 0.25, matrix: [1, 0, 0, 1, 0, 30] });
  assert.equal(drawn.find((item) => item.id === "G").visible, false);
  assert.equal(layer.opacity, 1);
  assert.equal(uc.layers[1].visible, true);
  assert.equal(layer._timelineFrame, undefined);
});

test("auto-key: a move writes one position key entry, undo reverts it, auto-key off writes none", () => {
  const { uc } = fakeWidget();
  const panel = uc.timelinePanel;
  panel.open = true;
  panel.ensureData();
  panel.setFrame(12, { render: false });
  uc.dragStart = {};
  assert.ok(panel.beginMove());
  assert.equal(uc.pointerMode, "layer-move");
  uc.dragStart.previewDx = 30;
  uc.dragStart.previewDy = -4;
  panel.commitMove(uc.dragStart);
  assert.deepEqual(evaluateTrack(uc.timeline, trackIdFor("L", "position"), 12), [30, -4]);
  assert.equal(uc.undoStack.length, 1);
  assert.equal(uc.undoStack[0].kind, TIMELINE_HISTORY_KIND);
  panel.applyHistory(uc.undoStack[0], "undo");
  assert.equal(uc.timeline.tracks["L:position"], undefined);
  assert.equal(uc.timeline.currentFrame, 12);
  panel.applyHistory(uc.undoStack[0], "redo");
  assert.ok(uc.timeline.tracks["L:position"]);
  panel.autoKey = false;
  uc.dragStart = {};
  assert.equal(panel.beginMove(), false);
  assert.equal(panel.keyOpacity(uc.layers[0], 0.5, true), false);
  panel.autoKey = true;
  assert.equal(panel.keyOpacity(uc.layers[0], 0.5, false), true);
  assert.equal(panel.keyOpacity(uc.layers[0], 0.3, true), true);
  assert.equal(uc.undoStack.length, 2);
  assert.equal(evaluateTrack(uc.timeline, "L:opacity", 12), 0.3);
  assert.equal(uc.layers[0].opacity, 1);
});

test("serialize prunes deleted layers and restore round-trips", () => {
  const { uc } = fakeWidget();
  const panel = uc.timelinePanel;
  panel.ensureData();
  setKey(uc.timeline, "L", "position", 3, [1, 2]);
  setKey(uc.timeline, "gone", "position", 3, [1, 2]);
  setKey(uc.timeline, CAMERA_TARGET, "rect", 3, { x: 0, y: 0, width: 100, height: 100 });
  const saved = panel.serialize();
  assert.deepEqual(Object.keys(saved.tracks).sort(), ["L:position", "camera:rect"]);
  panel.restore(null);
  assert.equal(uc.timeline, null);
  panel.restore(saved);
  assert.deepEqual(evaluateTrack(uc.timeline, "L:position", 3), [1, 2]);
  assert.equal(evaluateTarget(uc.timeline, "L", 3).animated, true);
});

// Widget wiring (source guards) ----------------------------------------------------------------

test("the widget routes render, bounds, paint, history and persistence through the timeline", () => {
  const widget = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
  for (const pattern of [
    /installUniCanvasTimeline\(this\);/,
    /getLayerRenderTransform\(layer\) \{/,
    /const start = this\.alignCoordForTool\(this\.layerPointFromWorld\(layer, a\), this\.brushSize\);/,
    /entry\.kind === TIMELINE_HISTORY_KIND/,
    /this\.timelinePanel\?\.restore\(state\.timeline\)/,
    /this\.timelinePanel\?\.beginMove\(\)/,
    /this\.timelinePanel\?\.commitMove\(this\.dragStart\)/,
    /this\.timelinePanel\?\.keyOpacity\(layer, target\.value, e\.type === "change"\)/,
    /this\.timelinePanel\?\.blocksPixelTransform\(layer\)/,
  ]) assert.match(widget, pattern);
  const modes = readFileSync(new URL("../web/vnccs_unicanvas_modes.mjs", import.meta.url), "utf8");
  assert.match(modes, /key === " " && widget\.timelinePanel\?\.togglePlay\(\)/);
  assert.match(modes, /getTimeline:/);
});
