import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createTimeline, isTimelineEmpty, normalizeTimeline, pruneTimelineTargets, serializeTimeline } from "../web/vnccs_unicanvas_timeline_core.mjs";
import {
  POSE_BAKED_NOTE,
  PoseFrameCache,
  isPoseLayerBaked,
  poseAnimationInfo,
  poseClipOf,
  poseClipSceneRange,
  poseLayerHash,
  setPoseClip,
  studioFrameFor,
  studioFramesForRange,
} from "../web/vnccs_unicanvas_timeline_pose.mjs";
import {
  FrameBatcher,
  exportFrameRange,
  exportOutputSize,
  exportSourceRect,
  fitRect,
} from "../web/vnccs_unicanvas_animation_export.mjs";
import { installUniCanvasTimeline } from "../web/vnccs_unicanvas_timeline.mjs";

// Issue #18: Pose Studio animation in the scene timeline, and the animation export helpers.

const animation = (frameCount = 12, fps = 12, extra = {}) => ({
  schemaVersion: 2, fps, duration: frameCount / fps, frameCount, loop: true,
  tracks: { "@characterPosition": { keys: [{ frame: 0, value: [0, 0, 0] }, { frame: frameCount - 1, value: [1, 0, 0] }] } },
  ...extra,
});

function poseLayer(id = "P", anim = animation()) {
  return {
    id, type: "pose", visible: true, opacity: 1, name: "Pose",
    pose: {
      rect: { x: 10, y: 20, width: 100, height: 200 },
      viewport: { position: [0, 1, 5], target: [0, 1, 0], fov: 35, zoom: 1 },
      studio: { characters: [{ id: 0, animation: anim }], timeline: anim ? { fps: anim.fps, duration: anim.duration, frameCount: anim.frameCount, loop: true } : undefined },
    },
  };
}

const canvas = (tag, width = 100, height = 200) => ({ tag, width, height });

test("an animated pose layer reports its studio timing; a static one is not animated", () => {
  assert.deepEqual(poseAnimationInfo(poseLayer()), { frameCount: 12, fps: 12, loop: true });
  const still = poseLayer("S", null);
  assert.equal(poseAnimationInfo(still), null);
  const empty = poseLayer("E", { ...animation(), tracks: {} });
  assert.equal(poseAnimationInfo(empty), null);
  // A compact cache reference counts by its track count.
  const cached = poseLayer("C", { storage: "server_cache", cacheId: "x", trackCount: 3, fps: 24, frameCount: 48, duration: 2 });
  cached.pose.studio.timeline = undefined;
  assert.deepEqual(poseAnimationInfo(cached), { frameCount: 48, fps: 24, loop: true });
  assert.equal(poseAnimationInfo({ id: "R", type: "raster" }), null);
});

test("scene frames map to studio frames with the fps ratio, the offset, hold and loop", () => {
  const info = { frameCount: 12, fps: 12, loop: false };
  const clip = { offset: 10, enabled: true };
  // Scene 24 fps, studio 12 fps: every studio frame shows for two scene frames.
  assert.equal(studioFrameFor(0, info, clip, 24), 0);
  assert.equal(studioFrameFor(10, info, clip, 24), 0);
  assert.equal(studioFrameFor(11, info, clip, 24), 0);
  assert.equal(studioFrameFor(12, info, clip, 24), 1);
  assert.equal(studioFrameFor(33, info, clip, 24), 11);
  assert.equal(studioFrameFor(200, info, clip, 24), 11);
  assert.equal(studioFrameFor(34, { ...info, loop: true }, clip, 24), 0);
  assert.deepEqual(poseClipSceneRange(info, clip, 24), { start: 10, end: 33 });
  // Scene slower than the studio: frames are skipped, never repeated.
  assert.deepEqual(studioFramesForRange({ frameCount: 24, fps: 24, loop: false }, { offset: 0 }, 12, 0, 5), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(studioFramesForRange(info, clip, 24, 0, 15), [0, 1, 2]);
});

test("pose clips persist only when they differ from the default and follow the layers", () => {
  const timeline = createTimeline();
  assert.deepEqual(poseClipOf(timeline, "P"), { offset: 0, enabled: true });
  setPoseClip(timeline, "P", { offset: 6 });
  setPoseClip(timeline, "Q", { enabled: false });
  assert.deepEqual(timeline.poseClips, { P: { offset: 6, enabled: true }, Q: { offset: 0, enabled: false } });
  assert.equal(isTimelineEmpty(timeline), false);
  const restored = normalizeTimeline(JSON.parse(JSON.stringify(serializeTimeline(timeline))));
  assert.deepEqual(restored.poseClips, timeline.poseClips);
  setPoseClip(timeline, "P", { offset: 0 });
  assert.equal("P" in timeline.poseClips, false);
  pruneTimelineTargets(timeline, ["X"]);
  assert.deepEqual(timeline.poseClips, {});
  // Old timelines have no clips; junk is dropped.
  assert.deepEqual(normalizeTimeline({}).poseClips, {});
  assert.deepEqual(normalizeTimeline({ poseClips: { A: { offset: "x" }, B: null, C: { offset: 2.6 } } }).poseClips, { C: { offset: 3, enabled: true } });
});

test("the pose hash ignores the playhead but changes with the pose, camera and size", () => {
  const layer = poseLayer();
  const hash = poseLayerHash(layer);
  layer.pose.studio = { ...layer.pose.studio, timeline: { ...layer.pose.studio.timeline, currentFrame: 7 }, capture_id: "abc" };
  assert.equal(poseLayerHash(layer), hash);
  layer.pose.studio = { ...layer.pose.studio, characters: [{ id: 0, animation: animation(24) }] };
  const edited = poseLayerHash(layer);
  assert.notEqual(edited, hash);
  layer.pose.viewport = { ...layer.pose.viewport, fov: 50 };
  assert.notEqual(poseLayerHash(layer), edited);
});

test("baked layers are recognized and carry the note", () => {
  const layer = poseLayer();
  assert.equal(isPoseLayerBaked(layer), false);
  layer.pose.bake = { characters: { 0: { status: "failed" } } };
  assert.equal(isPoseLayerBaked(layer), false);
  layer.pose.bake.characters[0].status = "stale";
  assert.equal(isPoseLayerBaked(layer), true);
  assert.match(POSE_BAKED_NOTE, /2D motion and sprite variants/);
});

test("the frame cache is an LRU with a byte cap, finds the nearest frame and drops edited poses", () => {
  const cache = new PoseFrameCache(100 * 200 * 4 * 3);
  cache.set("P", "h1", 0, canvas("0"));
  cache.set("P", "h1", 5, canvas("5"));
  cache.set("P", "h1", 9, canvas("9"));
  assert.equal(cache.nearest("P", "h1", 3).frame, 5);
  assert.equal(cache.nearest("P", "h1", 7).frame, 5); // tie: the earlier frame
  assert.equal(cache.nearest("P", "h1", 20).frame, 9);
  // Frame 0 is now the least recently used: a fourth frame evicts it.
  cache.set("P", "h1", 11, canvas("11"));
  assert.equal(cache.has("P", "h1", 0), false);
  assert.equal(cache.bytes, 100 * 200 * 4 * 3);
  // A changed pose hash drops the layer's frames: nothing stale is shown.
  assert.equal(cache.nearest("P", "h2", 5), null);
  assert.equal(cache.bytes, 0);
  cache.set("Q", "h", 1, canvas("q"));
  cache.invalidateLayer("Q");
  assert.equal(cache.get("Q", "h", 1), null);
});

// Controller -----------------------------------------------------------------------------------

function fakeWidget(layers) {
  const uc = {
    standalone: true,
    layers,
    activeLayerId: layers[0].id,
    get activeLayer() { return this.layers.find((item) => item.id === this.activeLayerId); },
    bbox: { x: 0, y: 0, width: 512, height: 512 },
    undoStack: [],
    statuses: [],
    pushHistoryEntry(entry) { this.undoStack.push(entry); },
    requestRender() {},
    setStatus(text) { this.statuses.push(text); },
    render() { return this.layers.map((item) => ({ id: item.id, variant: item._timelineFrame?.variant?.canvas?.tag ?? null, rect: item._timelineFrame?.variant?.rect ?? null })); },
    makeExportCanvas() { return this.layers.map((item) => item._timelineFrame?.variant?.canvas?.tag ?? null); },
    getLayerStateOffset: () => ({ x: 0, y: 0 }),
    getLayerRestBounds: () => ({ x: 0, y: 0, width: 10, height: 10 }),
  };
  const captured = [];
  const editor = {
    async captureAnimationFrames(layer, frames, { onFrame, cancelled }) {
      captured.push({ id: layer.id, frames: [...frames] });
      for (const frame of frames) {
        if (cancelled?.()) break;
        onFrame(frame, canvas(`${layer.id}${frame}`));
      }
    },
  };
  installUniCanvasTimeline(uc, { createPoseEditor: () => editor });
  return { uc, panel: uc.timelinePanel, captured };
}

test("an animated pose layer plays prepared frames and never goes blank while frames are missing", async () => {
  const layer = poseLayer();
  const { uc, panel, captured } = fakeWidget([layer]);
  panel.open = true;
  const timeline = panel.ensureData();
  timeline.fps = 12;
  // No frames yet: the layer shows its still (no variant), never a blank.
  assert.equal(uc.render()[0].variant, null);
  // Prepare only scene frames 0..3: studio frames 0..3.
  assert.equal(await panel.preparePoseFrames({ start: 0, end: 3 }), 4);
  assert.deepEqual(captured, [{ id: "P", frames: [0, 1, 2, 3] }]);
  panel.setFrame(2, { render: false });
  assert.deepEqual(uc.render()[0], { id: "P", variant: "P2", rect: { x: 10, y: 20, width: 100, height: 200 } });
  // Frame 9 is missing: the nearest cached frame (the last prepared one) shows.
  panel.setFrame(9, { render: false });
  assert.equal(uc.render()[0].variant, "P3");
  assert.deepEqual(panel.describe().poseDisplay.P, { baked: false, enabled: true, offset: 0, studioFrame: 9, shownFrame: 3, frameCount: 12 });
  // Preparing again only renders what is missing.
  await panel.preparePoseFrames();
  assert.deepEqual(captured[1].frames, [4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(uc.render()[0].variant, "P9");
  // Composites (export, Generate at frame) use the same frames; the rest scene stays still.
  assert.deepEqual(uc.makeExportCanvas(), [null]);
  uc._timelineCompositeFrame = 5;
  assert.deepEqual(uc.makeExportCanvas(), ["P5"]);
  uc._timelineCompositeFrame = null;
  // A pose edit invalidates the layer's frames: the still shows until they are prepared again.
  layer.pose.studio = { ...layer.pose.studio, characters: [{ id: 0, animation: animation(12, 12, { loop: false }) }] };
  assert.equal(uc.render()[0].variant, null);
  assert.equal(panel.poseFrames.bytes, 0);
});

test("the pose clip offset, the off switch and baking change what plays", async () => {
  const layer = poseLayer();
  const { uc, panel } = fakeWidget([layer]);
  panel.open = true;
  panel.ensureData().fps = 12;
  await panel.preparePoseFrames();
  panel.setPoseClipOffset("P", 4);
  panel.setFrame(6, { render: false });
  assert.equal(uc.render()[0].variant, "P2");
  assert.equal(uc.undoStack.length, 1);
  panel.setPoseClipEnabled("P", false);
  assert.equal(uc.render()[0].variant, null);
  panel.setPoseClipEnabled("P", true);
  layer.pose.bake = { characters: { 0: { status: "baked" } } };
  assert.equal(uc.render()[0].variant, null);
  assert.equal(panel.describe().poseDisplay.P.baked, true);
  // Baked layers are not prepared.
  assert.equal(await panel.preparePoseFrames(), 0);
});

test("preparing refuses during a pose edit session", async () => {
  const { uc, panel } = fakeWidget([poseLayer()]);
  panel.open = true;
  uc.poseEditSession = { layerId: "P" };
  await assert.rejects(panel.preparePoseFrames(), /Save or cancel the pose edit/);
});

// Export helpers --------------------------------------------------------------------------------

test("export ranges, sizes and the contain fit", () => {
  const timeline = createTimeline({ frameCount: 40, workArea: { start: 5, end: 20 } });
  assert.deepEqual(exportFrameRange(timeline, "work"), { start: 5, end: 20 });
  assert.deepEqual(exportFrameRange(timeline, "full"), { start: 0, end: 39 });
  const bbox = { x: 0, y: 0, width: 640, height: 360 };
  const camera = { x: 10, y: 10, width: 320, height: 180 };
  assert.deepEqual(exportSourceRect("bbox", bbox, camera), bbox);
  assert.deepEqual(exportSourceRect("camera", bbox, camera), camera);
  assert.deepEqual(exportSourceRect("camera", bbox, null), bbox);
  assert.deepEqual(exportOutputSize({ frameMode: "bbox", bbox, scale: 1 }), { width: 640, height: 360 });
  assert.deepEqual(exportOutputSize({ frameMode: "camera", bbox, startCameraRect: camera, scale: 0.5 }), { width: 160, height: 90 });
  assert.deepEqual(exportOutputSize({ frameMode: "custom", bbox, custom: { width: 9000, height: 101 }, scale: 0.5 }), { width: 4096, height: 51 });
  assert.deepEqual(fitRect({ width: 640, height: 360 }, { width: 640, height: 360 }), { x: 0, y: 0, width: 640, height: 360 });
  assert.deepEqual(fitRect({ width: 640, height: 360 }, { width: 400, height: 400 }), { x: 0, y: 87, width: 400, height: 225 });
});

test("frames upload in ordered batches by count and size", () => {
  const batcher = new FrameBatcher({ maxFrames: 3, maxBytes: 10 });
  assert.equal(batcher.push("aa"), false);
  assert.equal(batcher.push("bb"), false);
  assert.equal(batcher.push("cc"), true);
  assert.deepEqual(batcher.take(), { start: 0, frames: ["aa", "bb", "cc"] });
  assert.equal(batcher.push("0123456789"), true);
  assert.deepEqual(batcher.take(), { start: 3, frames: ["0123456789"] });
  assert.equal(batcher.take(), null);
});

test("the widget installs the timeline with a pose editor factory and the backend routes are registered", () => {
  const widget = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
  assert.match(widget, /installUniCanvasTimeline\(this, \{ createPoseEditor: \(\) => new UniCanvasPoseEditor\(this\) \}\)/);
  const routes = readFileSync(new URL("../nodes/unicanvas/routes.py", import.meta.url), "utf8");
  assert.match(routes, /animation_export_routes\(web, _content_length_ok\)/);
  const pose = readFileSync(new URL("../web/vnccs_unicanvas_pose.mjs", import.meta.url), "utf8");
  assert.match(pose, /async captureAnimationFrames\(layer, frames/);
});
