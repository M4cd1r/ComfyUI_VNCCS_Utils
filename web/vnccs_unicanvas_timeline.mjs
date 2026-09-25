/**
 * VNCCS UniCanvas scene timeline (Plan 06, issue #9): the bottom dock, playback and the render
 * hooks. The data model and the evaluator live in vnccs_unicanvas_timeline_core.mjs.
 *
 *  - Standalone only, like scene states, the project / scene selector and the VN preview: the
 *    timeline animates a scene, so the node widget never shows the dock or its button.
 *  - Timeline mode is on while the dock is open: every viewport render shows the evaluated frame
 *    (`withFrame("view", ...)` sets the frame's visibility and opacity on the layers for that
 *    render only and gives each layer a `_timelineFrame` with its matrix, variant and blur).
 *    Generation, flatten and save use the rest scene unless the dock's "Generate at frame" runs
 *    the draw with `_timelineCompositeFrame` set.
 *  - Auto-key (default on): a move-tool drag, the dock's value fields and the layer opacity slider
 *    write keys at the playhead. With auto-key off the move tool and opacity edit the rest scene
 *    as before and a chip says so.
 *  - History: every key gesture, preset insert, effect change or setting change is one `timeline`
 *    entry (the whole timeline before / after; it is small JSON). Scrubbing and playback add none.
 *  - Pose layers (issue #18): an animated pose layer gets a "Pose animation" row (drag it to move
 *    its time offset). Playback shows prepared mannequin frames from `poseFrames`
 *    (vnccs_unicanvas_timeline_pose.mjs); "Prepare pose frames" (also run before an export) steps
 *    the studio animation in a hidden pose editor. Baked layers keep 2D motion only.
 *  - "Export animation" (vnccs_unicanvas_animation_export.mjs) renders each frame offscreen through
 *    the composite path and streams it to the backend encoder.
 */

import {
  INTERPOLATION_PRESETS,
  adjacentKeyFrame,
  clamp,
  findKeyframesInRange,
  framesForElapsed,
  moveKeyframeSelection,
  niceTickStep,
  resizeFrameCount,
} from "./vnccs_animation_core.mjs";
import {
  CAMERA_TARGET,
  EFFECT_KINDS,
  FRAME_LIMITS,
  LAYER_PROPERTIES,
  MAX_TIMELINE_FPS,
  MIN_TIMELINE_FPS,
  MOTION_PRESETS,
  TIMELINE_HISTORY_KIND,
  TIMELINE_PROPERTIES,
  advancePlaybackFrame,
  applyMatrix,
  applyMotionPreset,
  composeLayerMatrix,
  copyKeys,
  createTimeline,
  deleteKeys,
  evaluateTarget,
  evaluateTrack,
  findEffectVariants,
  insertStateKeys,
  invertMatrix,
  isTimelineEmpty,
  isTranslationMatrix,
  normalizeTimeline,
  pasteKeys,
  pruneEmptyTracks,
  pruneTimelineTargets,
  serializeTimeline,
  setKey,
  setKeysInterpolation,
  snapshotTimeline,
  targetHasAnimation,
  trackIdFor,
} from "./vnccs_unicanvas_timeline_core.mjs";
import { getGroupDescendants, groupChainOf, isGroupLayer, visibleLayerRows } from "./vnccs_unicanvas_groups.mjs";
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
} from "./vnccs_unicanvas_timeline_pose.mjs";
import { openAnimationExportDialog } from "./vnccs_unicanvas_animation_export.mjs";

const STYLE_ID = "vnccs-uc-timeline-styles";
const LABEL_WIDTH = 180;
const ROW_HEIGHT = 22;
const RULER_HEIGHT = 24;
const COLLAPSED_HEIGHT = 32;
const MIN_DOCK_HEIGHT = 120;
const MAX_DOCK_HEIGHT = 520;
const TIMELINE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M8 5v5M13 5v5M18 5v5"/><path d="M10 13.5v3l3-1.5z" fill="currentColor"/></svg>`;

const STYLES = `
.vnccs-uc-tl-dock { position:absolute; left:0; right:0; bottom:0; z-index:6; display:flex; flex-direction:column; background:rgba(14,11,20,.97); border-top:1px solid rgba(255,255,255,.12); font:11px sans-serif; color:#e8e8f0; user-select:none; }
.vnccs-uc-tl-dock[hidden] { display:none; }
.vnccs-uc-tl-grip { height:5px; cursor:ns-resize; flex:0 0 auto; }
.vnccs-uc-tl-grip:hover { background:rgba(157,122,255,.35); }
.vnccs-uc-tl-head { display:flex; align-items:center; gap:4px; padding:2px 6px; flex:0 0 auto; min-height:26px; flex-wrap:wrap; }
.vnccs-uc-tl-head button, .vnccs-uc-tl-menu button { background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.1); color:#e8e8f0; border-radius:5px; padding:2px 7px; cursor:pointer; font:11px sans-serif; }
.vnccs-uc-tl-head button[aria-pressed="true"] { background:rgba(157,122,255,.35); border-color:rgba(157,122,255,.8); }
.vnccs-uc-tl-head input { width:52px; background:rgba(0,0,0,.35); border:1px solid rgba(255,255,255,.12); color:#e8e8f0; border-radius:4px; padding:1px 4px; font:11px sans-serif; }
.vnccs-uc-tl-head label { display:inline-flex; align-items:center; gap:3px; opacity:.9; }
.vnccs-uc-tl-title { font-weight:600; margin-right:4px; }
.vnccs-uc-tl-spacer { flex:1 1 auto; }
.vnccs-uc-tl-chip { padding:1px 7px; border-radius:9px; background:rgba(157,122,255,.3); }
.vnccs-uc-tl-chip.warn { background:rgba(255,170,60,.3); }
.vnccs-uc-tl-chip[hidden] { display:none; }
.vnccs-uc-tl-inspector { display:flex; align-items:center; gap:6px; padding:2px 6px 4px; flex:0 0 auto; }
.vnccs-uc-tl-inspector input { width:54px; background:rgba(0,0,0,.35); border:1px solid rgba(255,255,255,.12); color:#e8e8f0; border-radius:4px; padding:1px 4px; font:11px sans-serif; }
.vnccs-uc-tl-inspector input:disabled { opacity:.45; }
.vnccs-uc-tl-body { position:relative; flex:1 1 auto; overflow-y:auto; overflow-x:hidden; min-height:0; }
.vnccs-uc-tl-ruler { position:sticky; top:0; z-index:3; height:${RULER_HEIGHT}px; margin-left:${LABEL_WIDTH}px; background:rgba(24,20,34,1); border-bottom:1px solid rgba(255,255,255,.1); cursor:ew-resize; }
.vnccs-uc-tl-tick { position:absolute; top:0; bottom:0; border-left:1px solid rgba(255,255,255,.14); padding-left:2px; font-size:9px; opacity:.7; pointer-events:none; }
.vnccs-uc-tl-work { position:absolute; top:0; height:5px; background:rgba(157,122,255,.55); }
.vnccs-uc-tl-work-handle { position:absolute; top:0; width:8px; height:10px; margin-left:-4px; background:#9d7aff; border-radius:2px; cursor:ew-resize; }
.vnccs-uc-tl-marker { position:absolute; bottom:0; width:0; height:0; margin-left:-5px; border:5px solid transparent; border-bottom-color:#ffd166; cursor:pointer; }
.vnccs-uc-tl-rows { position:relative; }
.vnccs-uc-tl-row { position:relative; height:${ROW_HEIGHT}px; border-bottom:1px solid rgba(255,255,255,.04); }
.vnccs-uc-tl-row.active > .vnccs-uc-tl-label { background:rgba(157,122,255,.18); }
.vnccs-uc-tl-label { position:absolute; left:0; top:0; bottom:0; width:${LABEL_WIDTH}px; box-sizing:border-box; display:flex; align-items:center; gap:3px; padding-right:4px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; border-right:1px solid rgba(255,255,255,.08); cursor:pointer; }
.vnccs-uc-tl-label.sub { opacity:.75; }
.vnccs-uc-tl-expand { width:14px; text-align:center; opacity:.8; flex:0 0 auto; }
.vnccs-uc-tl-lane { position:absolute; left:${LABEL_WIDTH}px; right:0; top:0; bottom:0; }
.vnccs-uc-tl-key { position:absolute; top:50%; width:9px; height:9px; margin:-5px 0 0 -5px; background:#c9b8ff; transform:rotate(45deg); border:1px solid rgba(0,0,0,.6); cursor:pointer; box-sizing:border-box; }
.vnccs-uc-tl-key.hold { background:#8fd3ff; border-radius:0; }
.vnccs-uc-tl-key.agg { background:#9a9aad; }
.vnccs-uc-tl-key.selected { background:#ffd166; }
.vnccs-uc-tl-effect { position:absolute; top:5px; bottom:5px; border-radius:4px; background:rgba(120,220,160,.3); border:1px solid rgba(120,220,160,.6); font-size:9px; padding-left:3px; overflow:hidden; white-space:nowrap; }
.vnccs-uc-tl-playhead { position:absolute; top:0; bottom:0; width:0; border-left:1px solid #ff5f7e; pointer-events:none; z-index:4; }
.vnccs-uc-tl-box { position:absolute; border:1px dashed #ffd166; background:rgba(255,209,102,.08); pointer-events:none; z-index:5; }
.vnccs-uc-tl-menu { position:absolute; z-index:50; min-width:190px; max-height:360px; overflow:auto; padding:5px; border-radius:9px; background:rgba(20,16,30,.98); border:1px solid rgba(255,255,255,.12); display:grid; gap:2px; font:11px sans-serif; }
.vnccs-uc-tl-menu button { text-align:left; background:transparent; border:0; padding:5px 9px; }
.vnccs-uc-tl-menu button:hover { background:rgba(255,255,255,.08); }
.vnccs-uc-tl-menu .sep { height:1px; background:rgba(255,255,255,.1); margin:3px 0; }
.vnccs-uc-tl-menu .head { opacity:.6; padding:3px 9px; }
.vnccs-uc-tl-camera-frame { position:absolute; pointer-events:none; }
.vnccs-uc-tl-pose { position:absolute; top:4px; bottom:4px; border-radius:4px; background:rgba(120,170,255,.3); border:1px solid rgba(120,170,255,.7); font-size:9px; padding-left:3px; overflow:hidden; white-space:nowrap; cursor:ew-resize; box-sizing:border-box; }
.vnccs-uc-tl-pose.off { opacity:.4; }
.vnccs-uc-tl-pose.baked { left:5px !important; right:5px; width:auto !important; background:rgba(255,255,255,.05); border-color:rgba(255,255,255,.2); cursor:default; font-style:italic; }
`;

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

const isTextTarget = (target) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

class TimelineController {
  constructor(uc) {
    this.uc = uc;
    this.open = false;
    this.collapsed = false;
    this.height = 220;
    this.autoKey = true;
    this.playing = false;
    this.playRaf = 0;
    this.selected = new Map(); // keyId -> { trackName, keyId }
    this.expanded = new Set();
    this.clipboard = null;
    this.gesture = null;
    this.fieldGesture = null;
    this.menu = null;
    this.dock = null;
    this.button = null;
    this.poseFrames = new PoseFrameCache();
    this.preparing = null;
    this.exportDialog = null;
    this.createPoseEditor = null;
  }

  // Availability and data ---------------------------------------------------------------------

  get data() { return this.uc.timeline; }

  isAvailable() { return this.uc.standalone === true; }

  isOpen() { return this.open && this.isAvailable() && !this.uc.panorama; }

  ensureData() {
    if (!this.uc.timeline) this.uc.timeline = createTimeline();
    return this.uc.timeline;
  }

  syncAvailability() {
    if (this.button) this.button.hidden = !this.isAvailable();
    if (!this.isAvailable() && this.open) this.close();
  }

  // Frames and evaluation ---------------------------------------------------------------------

  viewFrame() {
    return this.isOpen() && this.data ? this.data.currentFrame : null;
  }

  frameFor(kind) {
    if (kind === "composite") return Number.isInteger(this.uc._timelineCompositeFrame) && this.data ? this.uc._timelineCompositeFrame : null;
    return this.viewFrame();
  }

  restBounds(layer) {
    return this.uc.getLayerRestBounds?.(layer) || null;
  }

  anchorOf(layer) {
    if (layer?.type === "sprite" && layer.sprite?.rect && layer.sprite.anchor) {
      return { x: layer.sprite.rect.x + layer.sprite.anchor.x, y: layer.sprite.rect.y + layer.sprite.anchor.y };
    }
    let bounds = null;
    if (isGroupLayer(layer)) {
      for (const child of getGroupDescendants(this.uc.layers, layer)) {
        if (isGroupLayer(child) || child.type === "mask") continue;
        const rect = this.restBounds(child);
        if (!rect) continue;
        bounds = bounds
          ? { x: Math.min(bounds.x, rect.x), y: Math.min(bounds.y, rect.y), right: Math.max(bounds.right, rect.x + rect.width), bottom: Math.max(bounds.bottom, rect.y + rect.height) }
          : { x: rect.x, y: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
      }
      return bounds ? { x: (bounds.x + bounds.right) / 2, y: bounds.bottom } : { x: 0, y: 0 };
    }
    const rect = this.restBounds(layer);
    return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height } : { x: 0, y: 0 };
  }

  /** The evaluated frame of one layer: { matrix, opacity, visible, variant, blur, animated } or null. */
  evaluateLayer(layer, frame) {
    const timeline = this.data;
    if (!timeline || frame === null || frame === undefined || !layer || layer.type === "mask") return null;
    // Outermost group first, the layer itself last.
    const chain = [...groupChainOf(this.uc.layers, layer)].reverse();
    chain.push(layer);
    let any = false;
    const items = [];
    let own = null;
    for (const item of chain) {
      if (!targetHasAnimation(timeline, item.id)) continue;
      const state = evaluateTarget(timeline, item.id, frame);
      if (item === layer) own = state;
      if (!state.animated) continue;
      any = true;
      const needsAnchor = state.sx !== 1 || state.sy !== 1 || state.rotation;
      items.push({ state, anchor: needsAnchor ? this.anchorOf(item) : { x: 0, y: 0 } });
    }
    const pose = this.poseFrame(layer, frame);
    if (pose) any = true;
    if (!any) return null;
    const offset = this.uc.getLayerStateOffset(layer);
    const matrix = isGroupLayer(layer) ? null : composeLayerMatrix(offset, items);
    let variant = null;
    if (own?.variantId && layer.type === "sprite") {
      const found = layer.sprite?.variants?.find((item) => item.id === own.variantId);
      if (found?.pixels && found.id !== layer.sprite.activeVariantId) variant = { canvas: found.pixels, rect: { ...layer.sprite.rect } };
    }
    if (pose) variant = { canvas: pose.canvas, rect: { ...layer.pose.rect }, poseFrame: pose.frame, exact: pose.exact };
    return {
      matrix,
      opacity: own?.opacity,
      visible: own?.visible,
      variant,
      blur: own?.blur > 0 ? own.blur : 0,
      animated: true,
    };
  }

  /** The render matrix of a layer at the displayed frame (null: rest scene). */
  layerMatrix(layer, frame = this.viewFrame()) {
    if (this.uc._timelineRestPass) return null;
    return this.evaluateLayer(layer, frame)?.matrix || null;
  }

  /** Runs fn with the frame of `kind` applied to the layers (visibility, opacity, matrices). */
  withFrame(kind, fn) {
    const frame = this.frameFor(kind);
    if (frame === null || !this.data || (isTimelineEmpty(this.data) && !this.hasPoseAnimation())) {
      if (kind !== "composite" || this.uc._timelineRestPass) return fn();
      // Composites (generation, flatten, save) show the rest scene even while the dock is open.
      this.uc._timelineRestPass = true;
      try {
        return fn();
      } finally {
        this.uc._timelineRestPass = false;
      }
    }
    const saved = [];
    for (const layer of this.uc.layers) {
      const ev = this.evaluateLayer(layer, frame);
      if (!ev) continue;
      saved.push({ layer, visible: layer.visible, opacity: layer.opacity });
      if (typeof ev.visible === "boolean") layer.visible = ev.visible;
      if (Number.isFinite(ev.opacity)) layer.opacity = clamp(ev.opacity, 0, 1);
      layer._timelineFrame = ev;
    }
    try {
      return fn();
    } finally {
      for (const item of saved) {
        item.layer.visible = item.visible;
        item.layer.opacity = item.opacity;
        delete item.layer._timelineFrame;
      }
    }
  }

  // Pose animation -----------------------------------------------------------------------------

  /** `{ info, clip, baked }` for an animated pose layer, else null. */
  poseClip(layer) {
    const info = poseAnimationInfo(layer);
    if (!info) return null;
    return { info, clip: poseClipOf(this.data, layer.id), baked: isPoseLayerBaked(layer) };
  }

  hasPoseAnimation() {
    return this.uc.layers.some((layer) => {
      const entry = this.poseClip(layer);
      return entry && entry.clip.enabled && !entry.baked;
    });
  }

  /**
   * The prepared mannequin frame of a pose layer at a scene frame: the exact studio frame, else the
   * nearest cached one (never a blank); null without frames (the layer shows its still).
   */
  poseFrame(layer, frame) {
    if (layer?.type !== "pose" || !layer.pose?.rect) return null;
    const entry = this.poseClip(layer);
    if (!entry || entry.baked || !entry.clip.enabled) return null;
    const studioFrame = studioFrameFor(frame, entry.info, entry.clip, this.data.fps);
    const found = this.poseFrames.nearest(layer.id, poseLayerHash(layer), studioFrame);
    if (!found?.canvas) return null;
    return { canvas: found.canvas, frame: found.frame, exact: found.frame === studioFrame };
  }

  /** Studio frames still missing for scene frames start..end, per animated pose layer. */
  missingPoseFrames(start, end) {
    const work = [];
    for (const layer of this.uc.layers) {
      const entry = this.poseClip(layer);
      if (!entry || entry.baked || !entry.clip.enabled) continue;
      const hash = poseLayerHash(layer);
      const frames = studioFramesForRange(entry.info, entry.clip, this.data.fps, start, end)
        .filter((frame) => !this.poseFrames.has(layer.id, hash, frame));
      if (frames.length) work.push({ layer, hash, frames });
    }
    return work;
  }

  /**
   * "Prepare pose frames": renders the studio frames the scene range needs into the frame cache,
   * one layer at a time in a hidden pose editor. Resolves with the number of frames rendered.
   */
  async preparePoseFrames({ start = null, end = null, cancelled, onProgress } = {}) {
    const timeline = this.ensureData();
    if (this.preparing) return this.preparing;
    const range = { start: start ?? 0, end: end ?? timeline.frameCount - 1 };
    const work = this.missingPoseFrames(range.start, range.end);
    const total = work.reduce((sum, item) => sum + item.frames.length, 0);
    if (!total) { onProgress?.(0, 0); return 0; }
    const uc = this.uc;
    if (uc.poseEditSession || uc.tool === "pose") {
      throw new Error("Save or cancel the pose edit before preparing pose frames");
    }
    const editor = (uc.poseEditor ||= this.createPoseEditor?.());
    if (!editor?.captureAnimationFrames) throw new Error("The pose editor is not available");
    this.pause();
    let done = 0;
    this.preparing = (async () => {
      try {
        for (const { layer, hash, frames } of work) {
          if (cancelled?.()) break;
          await editor.captureAnimationFrames(layer, frames, {
            cancelled,
            onFrame: (frame, canvas) => {
              this.poseFrames.set(layer.id, hash, frame, canvas);
              done += 1;
              onProgress?.(done, total);
              uc.setStatus?.(`Preparing pose frames ${done}/${total}`);
            },
          });
        }
        uc.setStatus?.(`Prepared ${done} pose frame${done === 1 ? "" : "s"}`);
        return done;
      } finally {
        this.preparing = null;
        this.renderDock();
        uc.requestRender();
      }
    })();
    return this.preparing;
  }

  async prepareFromDock() {
    try {
      await this.preparePoseFrames();
    } catch (error) {
      this.uc.setStatus?.(`Prepare pose frames: ${error?.message || error}`, true);
    }
  }

  setPoseClipEnabled(layerId, enabled) {
    this.edit((timeline) => setPoseClip(timeline, layerId, { enabled }), enabled ? "Pose animation on" : "Pose animation off");
  }

  setPoseClipOffset(layerId, offset) {
    this.edit((timeline) => setPoseClip(timeline, layerId, { offset }), `Pose animation starts at frame ${offset}`);
  }

  /** Dragging the pose bar moves its time offset live; one history entry on release. */
  beginPoseDrag(e, layerId) {
    const before = this.snapshot();
    const startFrame = this.frameAtClientX(e.clientX);
    const startOffset = poseClipOf(this.data, layerId).offset;
    let last = startOffset;
    this.pause();
    this.capture(e, (event) => {
      const offset = startOffset + this.frameAtClientX(event.clientX) - startFrame;
      if (offset === last) return;
      last = offset;
      setPoseClip(this.data, layerId, { offset });
      this.renderBody();
      this.uc.requestRender();
    }, () => {
      if (last !== startOffset) this.commit(before, `Pose animation starts at frame ${last}`);
    });
  }

  openExport() {
    return openAnimationExportDialog(this);
  }

  /** Keeps the dock's rows in step with the layer stack and the active layer. */
  afterRender() {
    if (!this.dock || this.dock.hidden || this.gesture) return;
    const signature = `${this.uc.activeLayerId}|${this.uc.layers.map((layer) => `${layer.id}:${layer.name}:${layer.groupId || ""}:${layer.collapsed ? 1 : 0}${layer.type === "pose" ? `:${poseLayerHash(layer)}:${isPoseLayerBaked(layer) ? 1 : 0}` : ""}`).join(",")}`;
    if (signature === this._signature) return;
    this._signature = signature;
    this.renderDock();
  }

  /** True when the displayed frame differs from the rest scene. */
  frameIsAnimated(frame = this.viewFrame()) {
    if (frame === null || !this.data) return false;
    if (this.uc.layers.some((layer) => this.evaluateLayer(layer, frame))) return true;
    return evaluateTrack(this.data, trackIdFor(CAMERA_TARGET, "rect"), frame) !== undefined
      || Boolean(evaluateTrack(this.data, trackIdFor(CAMERA_TARGET, "shake"), frame));
  }

  /** The camera view rect at a frame (bbox when unkeyed), with shake. */
  cameraRect(frame = this.viewFrame()) {
    if (frame === null || !this.data) return null;
    const rect = evaluateTrack(this.data, trackIdFor(CAMERA_TARGET, "rect"), frame);
    const shake = evaluateTrack(this.data, trackIdFor(CAMERA_TARGET, "shake"), frame) || 0;
    if (!rect && !shake) return null;
    const base = rect || { ...this.uc.bbox };
    if (!shake) return base;
    const angle = frame * 2.399963;
    return { ...base, x: base.x + Math.cos(angle) * shake, y: base.y + Math.sin(angle * 1.7) * shake };
  }

  /** Pixel tools keep working on rest pixels; a free transform on a moved frame would not. */
  blocksPixelTransform(layer) {
    return Boolean(this.isOpen() && layer && this.evaluateLayer(layer, this.viewFrame()));
  }

  /** World point -> the layer's rest pixels (inverse frame transform). */
  layerPoint(layer, point) {
    const matrix = this.layerMatrix(layer);
    if (!matrix) return null;
    const inverse = invertMatrix(matrix);
    return inverse ? applyMatrix(inverse, point) : null;
  }

  // Frame and playback ------------------------------------------------------------------------

  setFrame(frame, { render = true } = {}) {
    const timeline = this.ensureData();
    const next = clamp(Math.round(frame), 0, timeline.frameCount - 1);
    if (next === timeline.currentFrame && !render) return;
    timeline.currentFrame = next;
    this.updatePlayhead();
    if (render) this.uc.requestRender();
  }

  play() {
    const timeline = this.ensureData();
    if (this.playing) return;
    this.playing = true;
    const startFrame = timeline.currentFrame >= timeline.workArea.end && !timeline.loop ? timeline.workArea.start : timeline.currentFrame;
    const startedAt = performance.now();
    const step = (now) => {
      if (!this.playing) return;
      const { frame, done } = advancePlaybackFrame(timeline, startFrame, framesForElapsed(now - startedAt, timeline.fps, { fallbackFps: timeline.fps, minFps: MIN_TIMELINE_FPS, maxFps: MAX_TIMELINE_FPS }));
      if (frame !== timeline.currentFrame) {
        timeline.currentFrame = frame;
        this.updatePlayhead();
        this.uc.render();
      }
      if (done) { this.pause(); return; }
      this.playRaf = requestAnimationFrame(step);
    };
    this.playRaf = requestAnimationFrame(step);
    this.syncHeader();
  }

  pause() {
    this.playing = false;
    if (this.playRaf) cancelAnimationFrame(this.playRaf);
    this.playRaf = 0;
    this.syncHeader();
  }

  togglePlay() {
    if (!this.isOpen()) return false;
    if (this.playing) this.pause();
    else this.play();
    return true;
  }

  jumpKey(direction) {
    const timeline = this.ensureData();
    const target = this.uc.activeLayer?.id;
    const tracks = Object.keys(timeline.tracks).filter((id) => !target || timeline.tracks[id].target === target);
    const frame = adjacentKeyFrame(timeline, tracks.length ? tracks : null, timeline.currentFrame, direction);
    if (frame !== null) this.setFrame(frame);
  }

  // History -----------------------------------------------------------------------------------

  snapshot() { return snapshotTimeline(this.data); }

  commit(before, status = "") {
    const after = this.snapshot();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.uc.pushHistoryEntry?.({ kind: TIMELINE_HISTORY_KIND, before, after });
    if (status) this.uc.setStatus?.(status);
    this.afterChange();
  }

  /** One history entry around a synchronous edit. */
  edit(fn, status = "") {
    this.ensureData();
    const before = this.snapshot();
    const result = fn(this.data);
    this.commit(before, status);
    return result;
  }

  applyHistory(entry, direction) {
    const snapshot = direction === "undo" ? entry.before : entry.after;
    const frame = this.data?.currentFrame ?? 0;
    this.uc.timeline = snapshot ? normalizeTimeline({ ...snapshot, currentFrame: frame }) : null;
    this.pruneSelection();
    this.afterChange();
  }

  afterChange() {
    this.renderDock();
    this.uc.requestRender();
    this.uc.scheduleFullSync?.();
  }

  pruneSelection() {
    for (const [id, item] of this.selected) {
      if (!this.data?.tracks?.[item.trackName]?.keys.some((key) => key.id === id)) this.selected.delete(id);
    }
  }

  // Persistence -------------------------------------------------------------------------------

  serialize() {
    if (!this.data) return null;
    pruneTimelineTargets(this.data, this.uc.layers.map((layer) => layer.id));
    return serializeTimeline(this.data);
  }

  restore(raw) {
    this.pause();
    this.selected.clear();
    this.uc.timeline = raw ? normalizeTimeline(raw) : null;
    this.renderDock();
  }

  // Auto-key gestures -------------------------------------------------------------------------

  keyTarget() {
    const layer = this.uc.activeLayer;
    if (!layer || layer.type === "mask" || layer.locked) return null;
    return layer;
  }

  /** Move tool with auto-key: the drag previews on top of the frame and commits a position key. */
  beginMove() {
    const uc = this.uc;
    if (!this.isOpen() || !this.autoKey || !uc.dragStart) return false;
    const layer = this.keyTarget();
    if (!layer) return false;
    this.pause();
    const ids = new Set([layer.id]);
    if (isGroupLayer(layer)) for (const child of getGroupDescendants(uc.layers, layer)) ids.add(child.id);
    uc.pointerMode = "layer-move";
    uc.dragStart.timelineMove = { target: layer.id };
    uc.dragStart.layerId = layer.id;
    uc.dragStart.moveLayerIds = ids;
    uc.dragStart.depthScale = null;
    return true;
  }

  commitMove(dragStart) {
    const dx = Math.round(dragStart?.previewDx || 0);
    const dy = Math.round(dragStart?.previewDy || 0);
    const target = dragStart?.timelineMove?.target;
    if (!target || (!dx && !dy)) return;
    this.edit((timeline) => {
      const frame = timeline.currentFrame;
      const current = evaluateTrack(timeline, trackIdFor(target, "position"), frame) || [0, 0];
      setKey(timeline, target, "position", frame, [current[0] + dx, current[1] + dy], "linear");
    }, `Position key at frame ${this.data.currentFrame}`);
  }

  /** Layer opacity slider with auto-key: writes an opacity key instead of the rest value. */
  keyOpacity(layer, value, final) {
    if (!this.isOpen() || !this.autoKey || !layer || layer.type === "mask") return false;
    this.ensureData();
    if (!this.fieldGesture || this.fieldGesture.field !== "layer-opacity") this.fieldGesture = { field: "layer-opacity", before: this.snapshot() };
    setKey(this.data, layer.id, "opacity", this.data.currentFrame, clamp(Number(value), 0, 1), "linear");
    this.uc.requestRender();
    if (final) {
      const { before } = this.fieldGesture;
      this.fieldGesture = null;
      this.commit(before, `Opacity key at frame ${this.data.currentFrame}`);
    }
    return true;
  }

  // Presets, effects and states ---------------------------------------------------------------

  applyPreset(target, presetId) {
    const uc = this.uc;
    const layer = uc.layers.find((item) => item.id === target);
    if (!layer) return;
    const timeline = this.ensureData();
    const frame = timeline.currentFrame;
    const bounds = this.restBounds(layer);
    const context = {
      rest: evaluateTarget(timeline, target, frame),
      restOpacity: layer.opacity,
      distance: Math.max(uc.bbox?.width || 0, bounds?.width || 0) * 0.6 + (bounds?.width || 0) * 0.5,
      height: bounds?.height || uc.bbox?.height || 512,
      variants: findEffectVariants(layer.sprite),
    };
    const before = this.snapshot();
    const result = applyMotionPreset(timeline, target, presetId, frame, context);
    if (!result.ok) {
      if (result.missing) this.offerMissingVariant(layer, result.missing);
      return;
    }
    this.expanded.add(target);
    this.commit(before, `${MOTION_PRESETS.find((item) => item.id === presetId)?.label || presetId} at frame ${frame}`);
  }

  offerMissingVariant(layer, name) {
    const uc = this.uc;
    if (layer?.type !== "sprite" || !uc.sprites?.addCustom) {
      uc.setStatus?.(`"${name}" needs a sprite set with a "${name}" variant (Create sprite set from the layer menu)`, true);
      return;
    }
    const text = name === "blink" ? "eyes closed, blinking" : name === "mouth open" ? "mouth open, talking" : "mouth closed";
    uc.sprites.addCustom(layer, { name, kind: "expression", text });
    uc.setStatus?.(`Added an empty "${name}" variant: generate it in the sprite panel, then add the effect again`);
  }

  removeEffects(target) {
    this.edit((timeline) => { timeline.effects = timeline.effects.filter((effect) => effect.target !== target); }, "Effects removed");
  }

  removeEffect(effectId) {
    this.edit((timeline) => { timeline.effects = timeline.effects.filter((effect) => effect.id !== effectId); }, "Effect removed");
  }

  insertState(stateId) {
    const state = this.uc.sceneStates?.states?.find((item) => item.id === stateId);
    if (!state) return;
    this.edit((timeline) => insertStateKeys(timeline, this.uc.layers, state, timeline.currentFrame), `State "${state.name}" inserted as keys`);
  }

  keyCameraFromBbox() {
    this.edit((timeline) => setKey(timeline, CAMERA_TARGET, "rect", timeline.currentFrame, { ...this.uc.bbox }, "easeInOut"), "Camera key from the bbox");
  }

  addMarker() {
    this.edit((timeline) => {
      timeline.markers.push({ id: `mk_${Date.now().toString(36)}`, frame: timeline.currentFrame, name: `Marker ${timeline.markers.length + 1}` });
    }, "Marker added");
  }

  // Key selection and editing -----------------------------------------------------------------

  selectionList() { return [...this.selected.values()]; }

  selectKeys(list, additive = false) {
    if (!additive) this.selected.clear();
    for (const item of list) this.selected.set(item.keyId, { trackName: item.trackName, keyId: item.keyId });
    this.renderDock();
  }

  keysAt(target, frame) {
    const out = [];
    for (const [trackName, track] of Object.entries(this.data?.tracks || {})) {
      if (track.target !== target) continue;
      for (const key of track.keys) if (key.frame === frame) out.push({ trackName, keyId: key.id });
    }
    return out;
  }

  deleteSelected() {
    if (!this.selected.size) return false;
    const list = this.selectionList();
    this.selected.clear();
    this.edit((timeline) => deleteKeys(timeline, list), "Keys deleted");
    return true;
  }

  copySelected() {
    this.clipboard = copyKeys(this.data, this.selectionList());
    if (this.clipboard) this.uc.setStatus?.(`Copied ${this.clipboard.keys.length} key(s)`);
    return Boolean(this.clipboard);
  }

  pasteAtPlayhead() {
    if (!this.clipboard) return false;
    const target = this.uc.activeLayer?.id || null;
    const pasted = this.edit((timeline) => pasteKeys(timeline, this.clipboard, timeline.currentFrame, target), "Keys pasted");
    if (pasted?.length) this.selectKeys(pasted);
    return true;
  }

  setInterpolation(interpolation) {
    const list = this.selectionList();
    this.edit((timeline) => setKeysInterpolation(timeline, list, interpolation), "Interpolation changed");
  }

  // Settings ----------------------------------------------------------------------------------

  setFps(value) {
    const fps = clamp(Math.round(Number(value) || 0), MIN_TIMELINE_FPS, MAX_TIMELINE_FPS);
    if (fps === this.ensureData().fps) return;
    this.edit((timeline) => { timeline.fps = fps; }, `${fps} fps`);
  }

  setLength(value) {
    const frames = Math.round(Number(value) || 0);
    if (!frames) return;
    this.edit((timeline) => {
      const previousEnd = timeline.workArea.end;
      const wasFull = previousEnd === timeline.frameCount - 1;
      resizeFrameCount(timeline, frames, FRAME_LIMITS);
      const last = timeline.frameCount - 1;
      timeline.workArea.end = wasFull ? last : Math.min(previousEnd, last);
      timeline.workArea.start = Math.min(timeline.workArea.start, timeline.workArea.end);
    }, "Timeline length changed");
  }

  toggleLoop() {
    this.edit((timeline) => { timeline.loop = !timeline.loop; });
  }

  // Dock --------------------------------------------------------------------------------------

  toggle() {
    if (this.open) this.close();
    else this.openDock();
  }

  openDock() {
    if (!this.isAvailable()) return;
    if (this.uc.panorama) {
      this.uc.setStatus?.("The timeline animates a 2D scene; leave panorama mode first", true);
      return;
    }
    this.ensureData();
    this.open = true;
    this.buildDock();
    this.dock.hidden = false;
    this.renderDock();
    this.syncButton();
    this.uc.requestRender();
  }

  close() {
    this.pause();
    this.open = false;
    this.closeMenu();
    if (this.dock) this.dock.hidden = true;
    this.syncButton();
    this.uc.requestRender();
  }

  syncButton() {
    if (!this.button) return;
    this.button.setAttribute("aria-pressed", this.open ? "true" : "false");
    this.button.classList.toggle("active", this.open);
  }

  buildDock() {
    if (this.dock) return;
    ensureStyles();
    const dock = document.createElement("div");
    dock.className = "vnccs-uc-tl-dock";
    dock.dataset.timelineDock = "";
    dock.tabIndex = 0;
    dock.hidden = true;
    const grip = document.createElement("div");
    grip.className = "vnccs-uc-tl-grip";
    grip.title = "Drag to resize the timeline";
    grip.addEventListener("pointerdown", (e) => this.beginResize(e));
    const head = document.createElement("div");
    head.className = "vnccs-uc-tl-head";
    const inspector = document.createElement("div");
    inspector.className = "vnccs-uc-tl-inspector";
    const body = document.createElement("div");
    body.className = "vnccs-uc-tl-body";
    dock.append(grip, head, inspector, body);
    for (const type of ["pointerdown", "wheel", "contextmenu", "keydown", "click", "dblclick"]) {
      dock.addEventListener(type, (e) => e.stopPropagation(), type === "wheel" ? { passive: true } : undefined);
    }
    dock.addEventListener("keydown", (e) => this.onKeyDown(e));
    body.addEventListener("pointerdown", (e) => this.onBodyPointerDown(e));
    body.addEventListener("contextmenu", (e) => this.onBodyContextMenu(e));
    this.dock = dock;
    this.head = head;
    this.inspector = inspector;
    this.body = body;
    this.buildHead();
    this.buildInspector();
    (this.uc.stageWrap || this.uc.container).appendChild(dock);
  }

  headButton(label, title, onClick, data) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    if (data) button.dataset.tl = data;
    button.addEventListener("click", (e) => { e.preventDefault(); onClick(e); });
    return button;
  }

  numberField(label, data, { min, max, step = 1, title = "" } = {}) {
    const wrap = document.createElement("label");
    wrap.title = title;
    const input = document.createElement("input");
    input.type = "number";
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    input.step = String(step);
    input.dataset.tl = data;
    wrap.append(document.createTextNode(label), input);
    return { wrap, input };
  }

  buildHead() {
    const head = this.head;
    this.collapseBtn = this.headButton("▾", "Collapse the timeline", () => { this.collapsed = !this.collapsed; this.renderDock(); }, "collapse");
    const title = document.createElement("span");
    title.className = "vnccs-uc-tl-title";
    title.textContent = "Timeline";
    this.startBtn = this.headButton("⏮", "Go to the work area start", () => this.setFrame(this.data.workArea.start), "start");
    this.prevBtn = this.headButton("◆◀", "Previous key", () => this.jumpKey(-1), "prev-key");
    this.playBtn = this.headButton("▶", "Play / pause (Space)", () => (this.playing ? this.pause() : this.play()), "play");
    this.nextBtn = this.headButton("▶◆", "Next key", () => this.jumpKey(1), "next-key");
    this.endBtn = this.headButton("⏭", "Go to the work area end", () => this.setFrame(this.data.workArea.end), "end");
    this.loopBtn = this.headButton("⟲", "Loop playback", () => this.toggleLoop(), "loop");
    const frame = this.numberField("Frame", "frame", { min: 0, title: "Current frame" });
    this.frameInput = frame.input;
    this.frameInput.addEventListener("input", () => this.setFrame(Number(this.frameInput.value) || 0));
    const fps = this.numberField("fps", "fps", { min: MIN_TIMELINE_FPS, max: MAX_TIMELINE_FPS, title: "Frames per second (1-60)" });
    this.fpsInput = fps.input;
    this.fpsInput.addEventListener("change", () => this.setFps(this.fpsInput.value));
    const length = this.numberField("Length", "length", { min: FRAME_LIMITS.minFrames, max: FRAME_LIMITS.maxFrames, title: "Timeline length in frames (2-3600)" });
    this.lengthInput = length.input;
    this.lengthInput.addEventListener("change", () => this.setLength(this.lengthInput.value));
    this.autoKeyBtn = this.headButton("● Auto-key", "Auto-key: moves and value changes write keys at the playhead", () => { this.autoKey = !this.autoKey; this.syncHeader(); }, "auto-key");
    this.markerBtn = this.headButton("+ Marker", "Add a marker at the playhead", () => this.addMarker(), "marker");
    this.cameraBtn = this.headButton("Key camera", "Key the camera view rect from the current bbox", () => this.keyCameraFromBbox(), "camera-key");
    this.prepareBtn = this.headButton("Prepare pose frames", "Render the pose layers' studio animation frames for playback (also runs before an export)", () => void this.prepareFromDock(), "prepare-pose");
    this.exportBtn = this.headButton("Export...", "Export the timeline as WebM, MP4, GIF or a PNG sequence", () => this.openExport(), "export");
    this.generateBtn = this.headButton("Generate at frame", "GENERATE with the scene at the current frame instead of the rest scene", () => void this.generateAtFrame(), "generate-frame");
    this.animatedChip = document.createElement("span");
    this.animatedChip.className = "vnccs-uc-tl-chip";
    this.animatedChip.textContent = "animated";
    this.animatedChip.title = "The displayed frame differs from the rest scene";
    this.animatedChip.dataset.tl = "animated-chip";
    this.autoKeyChip = document.createElement("span");
    this.autoKeyChip.className = "vnccs-uc-tl-chip warn";
    this.autoKeyChip.textContent = "Auto-key off: edits change the rest scene";
    this.autoKeyChip.dataset.tl = "auto-key-warning";
    const spacer = document.createElement("span");
    spacer.className = "vnccs-uc-tl-spacer";
    const closeBtn = this.headButton("✕", "Close the timeline (the canvas returns to the rest scene)", () => this.close(), "close");
    head.append(this.collapseBtn, title, this.startBtn, this.prevBtn, this.playBtn, this.nextBtn, this.endBtn, this.loopBtn,
      frame.wrap, fps.wrap, length.wrap, this.autoKeyBtn, this.animatedChip, this.autoKeyChip, spacer,
      this.markerBtn, this.cameraBtn, this.prepareBtn, this.exportBtn, this.generateBtn, closeBtn);
  }

  buildInspector() {
    const fields = [
      ["X", "x", 1], ["Y", "y", 1], ["Scale %", "scale", 1], ["Rotation", "rotation", 0.5], ["Opacity %", "opacity", 1], ["Blur", "blur", 0.5],
    ];
    this.inspectorLabel = document.createElement("span");
    this.inspectorLabel.style.opacity = ".8";
    this.inspector.appendChild(this.inspectorLabel);
    this.fields = {};
    for (const [label, name, step] of fields) {
      const { wrap, input } = this.numberField(label, `field-${name}`, { step });
      input.addEventListener("input", () => this.onFieldInput(name, input, false));
      input.addEventListener("change", () => this.onFieldInput(name, input, true));
      this.fields[name] = input;
      this.inspector.appendChild(wrap);
    }
  }

  /** Inspector fields: live keys at the playhead, one history entry per gesture. */
  onFieldInput(name, input, final) {
    const layer = this.keyTarget();
    const value = Number(input.value);
    if (!layer || !Number.isFinite(value)) return;
    const timeline = this.ensureData();
    if (!this.autoKey) {
      if (name === "opacity" && final) {
        const before = { opacity: layer.opacity };
        layer.opacity = clamp(value / 100, 0, 1);
        this.uc.pushHistoryEntry?.({ kind: "layerProps", layerId: layer.id, before, after: { opacity: layer.opacity } });
        this.uc.syncActiveLayerControls?.();
        this.uc.requestRender();
      }
      return;
    }
    if (!this.fieldGesture || this.fieldGesture.field !== name) this.fieldGesture = { field: name, before: this.snapshot() };
    const frame = timeline.currentFrame;
    const read = (property, fallback) => evaluateTrack(timeline, trackIdFor(layer.id, property), frame) ?? fallback;
    if (name === "x" || name === "y") {
      const position = read("position", [0, 0]);
      setKey(timeline, layer.id, "position", frame, name === "x" ? [value, position[1]] : [position[0], value]);
    } else if (name === "scale") {
      const factor = Math.max(0.01, value / 100);
      setKey(timeline, layer.id, "scale", frame, [factor, factor]);
    } else if (name === "rotation") {
      setKey(timeline, layer.id, "rotation", frame, value);
    } else if (name === "opacity") {
      setKey(timeline, layer.id, "opacity", frame, clamp(value / 100, 0, 1));
    } else if (name === "blur") {
      setKey(timeline, layer.id, "blur", frame, Math.max(0, value));
    }
    this.uc.requestRender();
    if (final) {
      const { before } = this.fieldGesture;
      this.fieldGesture = null;
      this.commit(before, `Key at frame ${frame}`);
    } else {
      this.syncAnimatedChip();
    }
  }

  syncInspector() {
    if (!this.inspector) return;
    const layer = this.keyTarget();
    const timeline = this.data;
    this.inspector.hidden = this.collapsed;
    this.inspectorLabel.textContent = layer ? `${layer.name || "Layer"} @ ${timeline?.currentFrame ?? 0}:` : "Select a layer to key it";
    const frame = timeline?.currentFrame ?? 0;
    const read = (property, fallback) => (layer && timeline ? evaluateTrack(timeline, trackIdFor(layer.id, property), frame) ?? fallback : fallback);
    const position = read("position", [0, 0]);
    const scale = read("scale", [1, 1]);
    const values = {
      x: round(position[0], 1),
      y: round(position[1], 1),
      scale: round(scale[1] * 100, 1),
      rotation: round(read("rotation", 0), 1),
      opacity: round(read("opacity", layer?.opacity ?? 1) * 100, 0),
      blur: round(read("blur", 0), 1),
    };
    for (const [name, input] of Object.entries(this.fields)) {
      if (document.activeElement !== input) input.value = String(values[name]);
      input.disabled = !layer || (!this.autoKey && name !== "opacity");
      input.title = !this.autoKey && name !== "opacity" ? "Auto-key is off: use the Move / Transform tools to edit the rest scene" : "";
    }
  }

  syncHeader() {
    if (!this.head) return;
    const timeline = this.data;
    if (!timeline) return;
    this.playBtn.textContent = this.playing ? "⏸" : "▶";
    this.loopBtn.setAttribute("aria-pressed", timeline.loop ? "true" : "false");
    this.autoKeyBtn.setAttribute("aria-pressed", this.autoKey ? "true" : "false");
    this.autoKeyChip.hidden = this.autoKey;
    this.collapseBtn.textContent = this.collapsed ? "▴" : "▾";
    if (document.activeElement !== this.frameInput) this.frameInput.value = String(timeline.currentFrame);
    this.frameInput.max = String(timeline.frameCount - 1);
    if (document.activeElement !== this.fpsInput) this.fpsInput.value = String(timeline.fps);
    if (document.activeElement !== this.lengthInput) this.lengthInput.value = String(timeline.frameCount);
    this.generateBtn.disabled = Boolean(this.uc.drawInProgress);
    this.prepareBtn.hidden = !this.uc.layers.some((layer) => poseAnimationInfo(layer));
    this.prepareBtn.disabled = Boolean(this.preparing);
    this.syncAnimatedChip();
  }

  syncAnimatedChip() {
    if (this.animatedChip) this.animatedChip.hidden = !this.frameIsAnimated();
  }

  renderDock() {
    if (!this.dock || this.dock.hidden) return;
    const height = this.collapsed ? COLLAPSED_HEIGHT : this.height;
    this.dock.style.height = `${height}px`;
    this.body.hidden = this.collapsed;
    this.syncHeader();
    this.syncInspector();
    if (!this.collapsed) this.renderBody();
  }

  laneWidth() {
    return Math.max(50, (this.body?.clientWidth || 600) - LABEL_WIDTH);
  }

  xForFrame(frame) {
    const last = Math.max(1, this.data.frameCount - 1);
    return (frame / last) * (this.laneWidth() - 10) + 5;
  }

  frameAtClientX(clientX) {
    const rect = this.body.getBoundingClientRect();
    const x = clientX - rect.left - LABEL_WIDTH - 5;
    const last = Math.max(1, this.data.frameCount - 1);
    return clamp(Math.round((x / (this.laneWidth() - 10)) * last), 0, last);
  }

  rows() {
    const uc = this.uc;
    const timeline = this.data;
    const rows = [{ target: CAMERA_TARGET, label: "Camera", depth: 0, kind: "target" }];
    if (this.expanded.has(CAMERA_TARGET)) {
      for (const property of ["rect", "shake"]) {
        if (timeline.tracks[trackIdFor(CAMERA_TARGET, property)]) rows.push({ target: CAMERA_TARGET, property, label: TIMELINE_PROPERTIES[property].label, depth: 1, kind: "property" });
      }
    }
    for (const layer of visibleLayerRows(uc.layers)) {
      const depth = groupChainOf(uc.layers, layer).length;
      rows.push({ target: layer.id, label: `${isGroupLayer(layer) ? "▸ " : ""}${layer.name || "Layer"}`, depth, kind: "target", layer });
      const pose = this.poseClip(layer);
      if (pose) rows.push({ target: layer.id, label: "Pose animation", depth: depth + 1, kind: "pose", layer, pose });
      if (!this.expanded.has(layer.id)) continue;
      for (const property of LAYER_PROPERTIES) {
        if (timeline.tracks[trackIdFor(layer.id, property)]) rows.push({ target: layer.id, property, label: TIMELINE_PROPERTIES[property].label, depth: depth + 1, kind: "property" });
      }
      for (const effect of timeline.effects.filter((item) => item.target === layer.id)) {
        rows.push({ target: layer.id, effect, label: `${EFFECT_KINDS[effect.kind].label} (effect)`, depth: depth + 1, kind: "effect" });
      }
    }
    return rows;
  }

  renderBody() {
    const timeline = this.data;
    const body = this.body;
    const scrollTop = body.scrollTop;
    body.textContent = "";
    const ruler = document.createElement("div");
    ruler.className = "vnccs-uc-tl-ruler";
    ruler.dataset.tl = "ruler";
    const step = niceTickStep(timeline.frameCount);
    for (let frame = 0; frame < timeline.frameCount; frame += step) {
      const tick = document.createElement("div");
      tick.className = "vnccs-uc-tl-tick";
      tick.style.left = `${this.xForFrame(frame)}px`;
      tick.textContent = String(frame);
      ruler.appendChild(tick);
    }
    const work = document.createElement("div");
    work.className = "vnccs-uc-tl-work";
    work.style.left = `${this.xForFrame(timeline.workArea.start)}px`;
    work.style.width = `${Math.max(1, this.xForFrame(timeline.workArea.end) - this.xForFrame(timeline.workArea.start))}px`;
    ruler.appendChild(work);
    for (const side of ["start", "end"]) {
      const handle = document.createElement("div");
      handle.className = "vnccs-uc-tl-work-handle";
      handle.dataset.workHandle = side;
      handle.title = side === "start" ? "Work area start" : "Work area end";
      handle.style.left = `${this.xForFrame(timeline.workArea[side])}px`;
      ruler.appendChild(handle);
    }
    for (const marker of timeline.markers) {
      const element = document.createElement("div");
      element.className = "vnccs-uc-tl-marker";
      element.dataset.markerId = marker.id;
      element.title = `${marker.name} (frame ${marker.frame}); right-click to remove`;
      element.style.left = `${this.xForFrame(marker.frame)}px`;
      ruler.appendChild(element);
    }
    const rowsEl = document.createElement("div");
    rowsEl.className = "vnccs-uc-tl-rows";
    const activeId = this.uc.activeLayerId;
    this._rows = this.rows();
    this._rows.forEach((row, index) => {
      const element = document.createElement("div");
      element.className = "vnccs-uc-tl-row";
      element.dataset.rowIndex = String(index);
      element.dataset.target = row.target;
      if (row.kind === "target" && row.target === activeId) element.classList.add("active");
      const label = document.createElement("div");
      label.className = `vnccs-uc-tl-label${row.kind === "target" ? "" : " sub"}`;
      label.style.paddingLeft = `${4 + row.depth * 12}px`;
      label.dataset.rowLabel = String(index);
      if (row.kind === "target") {
        const expand = document.createElement("span");
        expand.className = "vnccs-uc-tl-expand";
        expand.dataset.expand = row.target;
        expand.textContent = this.expanded.has(row.target) ? "▾" : "▸";
        label.appendChild(expand);
      }
      label.appendChild(document.createTextNode(row.label));
      label.title = row.kind === "target" ? `${row.label}: click to select, right-click for motion presets` : row.label;
      const lane = document.createElement("div");
      lane.className = "vnccs-uc-tl-lane";
      lane.dataset.lane = String(index);
      if (row.kind === "property") {
        const trackName = trackIdFor(row.target, row.property);
        for (const key of timeline.tracks[trackName]?.keys || []) lane.appendChild(this.keyElement(trackName, key));
      } else if (row.kind === "pose") {
        lane.appendChild(this.poseBar(row));
      } else if (row.kind === "effect") {
        const bar = document.createElement("div");
        bar.className = "vnccs-uc-tl-effect";
        bar.dataset.effectId = row.effect.id;
        const end = row.effect.end === null ? timeline.frameCount - 1 : row.effect.end;
        bar.style.left = `${this.xForFrame(row.effect.start)}px`;
        bar.style.width = `${Math.max(4, this.xForFrame(end) - this.xForFrame(row.effect.start))}px`;
        bar.textContent = EFFECT_KINDS[row.effect.kind].label;
        bar.title = `${EFFECT_KINDS[row.effect.kind].label}: frames ${row.effect.start}-${end}; right-click to remove`;
        lane.appendChild(bar);
      } else {
        const frames = new Map();
        for (const [trackName, track] of Object.entries(timeline.tracks)) {
          if (track.target !== row.target) continue;
          for (const key of track.keys) {
            if (!frames.has(key.frame)) frames.set(key.frame, []);
            frames.get(key.frame).push({ trackName, key });
          }
        }
        for (const [frame, keys] of frames) {
          const element = document.createElement("div");
          element.className = "vnccs-uc-tl-key agg";
          if (keys.every(({ key }) => this.selected.has(key.id))) element.classList.add("selected");
          element.dataset.aggTarget = row.target;
          element.dataset.frame = String(frame);
          element.style.left = `${this.xForFrame(frame)}px`;
          element.title = `Frame ${frame}: ${keys.map(({ trackName }) => timeline.tracks[trackName].property).join(", ")}`;
          lane.appendChild(element);
        }
        const effects = timeline.effects.filter((effect) => effect.target === row.target);
        if (effects.length && !this.expanded.has(row.target)) {
          const start = Math.min(...effects.map((effect) => effect.start));
          const bar = document.createElement("div");
          bar.className = "vnccs-uc-tl-effect";
          bar.style.opacity = ".5";
          bar.style.pointerEvents = "none";
          bar.style.left = `${this.xForFrame(start)}px`;
          bar.style.right = "0";
          bar.textContent = effects.map((effect) => EFFECT_KINDS[effect.kind].label).join(", ");
          lane.appendChild(bar);
        }
      }
      element.append(label, lane);
      rowsEl.appendChild(element);
    });
    const playhead = document.createElement("div");
    playhead.className = "vnccs-uc-tl-playhead";
    playhead.dataset.tl = "playhead";
    this.playhead = playhead;
    body.append(ruler, rowsEl, playhead);
    this.updatePlayhead();
    body.scrollTop = scrollTop;
  }

  poseBar(row) {
    const { info, clip, baked } = row.pose;
    const bar = document.createElement("div");
    bar.className = "vnccs-uc-tl-pose";
    bar.dataset.poseClip = row.target;
    if (baked) {
      bar.classList.add("baked");
      bar.dataset.poseBaked = "";
      bar.textContent = `Pose animation disabled: ${POSE_BAKED_NOTE}`;
      bar.title = bar.textContent;
      return bar;
    }
    const range = poseClipSceneRange(info, clip, this.data.fps);
    const last = this.data.frameCount - 1;
    const from = clamp(range.start, 0, last);
    const to = clamp(range.end, 0, last);
    bar.style.left = `${this.xForFrame(from)}px`;
    bar.style.width = `${Math.max(6, this.xForFrame(to) - this.xForFrame(from))}px`;
    if (!clip.enabled) bar.classList.add("off");
    const hash = poseLayerHash(row.layer);
    const cached = [...(this.poseFrames.layers.get(row.target)?.hash === hash ? this.poseFrames.layers.get(row.target).frames : [])].length;
    bar.textContent = `Pose ${info.frameCount}f @ ${round(info.fps, 2)}fps${clip.offset ? ` +${clip.offset}` : ""}${clip.enabled ? "" : " (off)"} · ${cached}/${info.frameCount} ready`;
    bar.title = `Studio frames 0-${info.frameCount - 1} at ${round(info.fps, 2)} fps play from scene frame ${clip.offset}${info.loop ? " and loop" : ""}. Drag to move; right-click for options.`;
    return bar;
  }

  keyElement(trackName, key) {
    const element = document.createElement("div");
    element.className = `vnccs-uc-tl-key${key.interpolation === "hold" ? " hold" : ""}${this.selected.has(key.id) ? " selected" : ""}`;
    element.dataset.track = trackName;
    element.dataset.key = key.id;
    element.style.left = `${this.xForFrame(key.frame)}px`;
    element.title = `Frame ${key.frame} (${key.interpolation}); drag to move, Alt-drag to duplicate, right-click for interpolation`;
    return element;
  }

  updatePlayhead() {
    if (!this.data) return;
    if (this.playhead) {
      this.playhead.style.left = `${LABEL_WIDTH + this.xForFrame(this.data.currentFrame)}px`;
      this.playhead.style.height = `${Math.max(this.body.scrollHeight, this.body.clientHeight)}px`;
    }
    if (this.frameInput && document.activeElement !== this.frameInput) this.frameInput.value = String(this.data.currentFrame);
    this.syncAnimatedChip();
    if (this.inspector && !this.fieldGesture) this.syncInspector();
  }

  // Body gestures -----------------------------------------------------------------------------

  capture(e, move, up) {
    // The body survives re-renders (only its children are rebuilt), so it holds the capture.
    const target = this.body?.contains(e.target) ? this.body : e.target;
    try { target.setPointerCapture?.(e.pointerId); } catch (_) { /* synthetic events */ }
    const onMove = (event) => move(event);
    const onUp = (event) => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      up(event);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  onBodyPointerDown(e) {
    if (e.button !== 0) return;
    this.closeMenu();
    this.dock.focus({ preventScroll: true });
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (!target || !this.data) return;
    if (target.dataset.workHandle) { this.beginWorkDrag(e, target.dataset.workHandle); return; }
    if (target.dataset.markerId) {
      const marker = this.data.markers.find((item) => item.id === target.dataset.markerId);
      if (marker) this.setFrame(marker.frame);
      return;
    }
    if (target.closest("[data-tl='ruler']")) { this.beginScrub(e); return; }
    if (target.dataset.expand) {
      if (this.expanded.has(target.dataset.expand)) this.expanded.delete(target.dataset.expand);
      else this.expanded.add(target.dataset.expand);
      this.renderDock();
      return;
    }
    const labelIndex = target.closest("[data-row-label]")?.dataset.rowLabel;
    if (labelIndex !== undefined) {
      const row = this._rows?.[Number(labelIndex)];
      if (row?.layer) {
        this.uc.setActiveLayer?.(row.layer.id);
        this.renderDock();
      }
      return;
    }
    if (target.dataset.key || target.dataset.aggTarget) { this.beginKeyDrag(e, target); return; }
    if (target.dataset.poseClip && !("poseBaked" in target.dataset)) { this.beginPoseDrag(e, target.dataset.poseClip); return; }
    if (target.closest("[data-lane]")) this.beginBoxSelect(e);
  }

  beginScrub(e) {
    this.pause();
    this.setFrame(this.frameAtClientX(e.clientX));
    this.capture(e, (event) => this.setFrame(this.frameAtClientX(event.clientX)), () => this.renderDock());
  }

  beginWorkDrag(e, side) {
    const before = this.snapshot();
    const timeline = this.data;
    this.capture(e, (event) => {
      const frame = this.frameAtClientX(event.clientX);
      if (side === "start") timeline.workArea.start = Math.min(frame, timeline.workArea.end);
      else timeline.workArea.end = Math.max(frame, timeline.workArea.start);
      this.renderBody();
    }, () => this.commit(before));
  }

  beginKeyDrag(e, element) {
    let list;
    if (element.dataset.key) list = [{ trackName: element.dataset.track, keyId: element.dataset.key }];
    else list = this.keysAt(element.dataset.aggTarget, Number(element.dataset.frame));
    const alreadySelected = list.every((item) => this.selected.has(item.keyId));
    if (e.shiftKey) {
      const allSelected = alreadySelected;
      for (const item of list) {
        if (allSelected) this.selected.delete(item.keyId);
        else this.selected.set(item.keyId, item);
      }
      this.renderDock();
      return;
    }
    if (!alreadySelected) this.selectKeys(list);
    const before = this.snapshot();
    const selection = this.selectionList();
    const startFrame = this.frameAtClientX(e.clientX);
    const duplicate = e.altKey;
    const clipboard = duplicate ? copyKeys(this.data, selection) : null;
    const firstFrame = Math.min(...selection.map((item) => this.data.tracks[item.trackName]?.keys.find((key) => key.id === item.keyId)?.frame ?? 0));
    let lastDelta = 0;
    this.pause();
    this.capture(e, (event) => {
      const delta = this.frameAtClientX(event.clientX) - startFrame;
      if (delta === lastDelta) return;
      lastDelta = delta;
      // Live: every move starts again from the gesture's snapshot.
      this.uc.timeline = normalizeTimeline({ ...before, currentFrame: this.data.currentFrame });
      if (duplicate) {
        const pasted = pasteKeys(this.uc.timeline, clipboard, firstFrame + delta);
        this.selected.clear();
        for (const item of pasted) this.selected.set(item.keyId, item);
      } else {
        const moved = moveKeyframeSelection(this.uc.timeline, selection, delta);
        this.selected.clear();
        for (const item of moved.selections) this.selected.set(item.keyId, item);
      }
      this.renderBody();
      this.uc.requestRender();
    }, () => {
      if (lastDelta) this.commit(before, duplicate ? "Keys duplicated" : "Keys moved");
    });
  }

  beginBoxSelect(e) {
    const bodyRect = this.body.getBoundingClientRect();
    const box = document.createElement("div");
    box.className = "vnccs-uc-tl-box";
    this.body.appendChild(box);
    const start = { x: e.clientX, y: e.clientY + 0 };
    const startScroll = this.body.scrollTop;
    const additive = e.shiftKey;
    const update = (event) => {
      const left = Math.min(start.x, event.clientX) - bodyRect.left;
      const top = Math.min(start.y, event.clientY) - bodyRect.top + startScroll;
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${Math.abs(event.clientX - start.x)}px`;
      box.style.height = `${Math.abs(event.clientY - start.y)}px`;
    };
    update(e);
    this.capture(e, update, (event) => {
      box.remove();
      const rowAt = (clientY) => Math.floor((clientY - bodyRect.top + this.body.scrollTop - RULER_HEIGHT) / ROW_HEIGHT);
      const first = rowAt(Math.min(start.y, event.clientY));
      const last = rowAt(Math.max(start.y, event.clientY));
      const startFrame = this.frameAtClientX(Math.min(start.x, event.clientX));
      const endFrame = this.frameAtClientX(Math.max(start.x, event.clientX));
      if (Math.abs(event.clientX - start.x) < 3 && Math.abs(event.clientY - start.y) < 3) {
        if (!additive) this.selectKeys([]);
        this.setFrame(this.frameAtClientX(event.clientX));
        return;
      }
      const trackNames = [];
      for (let index = Math.max(0, first); index <= Math.min(last, (this._rows?.length || 0) - 1); index++) {
        const row = this._rows[index];
        if (row.kind === "property") trackNames.push(trackIdFor(row.target, row.property));
        else if (row.kind === "target") {
          for (const [name, track] of Object.entries(this.data.tracks)) if (track.target === row.target) trackNames.push(name);
        }
      }
      const found = findKeyframesInRange(this.data, trackNames, { startTrack: 0, endTrack: trackNames.length - 1, startFrame, endFrame });
      this.selectKeys(found, additive);
    });
  }

  beginResize(e) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = this.height;
    this.collapsed = false;
    this.capture(e, (event) => {
      this.height = clamp(startHeight + (startY - event.clientY), MIN_DOCK_HEIGHT, MAX_DOCK_HEIGHT);
      this.dock.style.height = `${this.height}px`;
    }, () => this.renderDock());
  }

  /** Keys aimed at the dock, also when a fullscreen key shield sees them first. */
  handleKey(e) {
    if (!this.dock || this.dock.hidden || !this.dock.contains(e.target)) return false;
    this.onKeyDown(e);
    return e.defaultPrevented;
  }

  onKeyDown(e) {
    if (e.defaultPrevented || isTextTarget(e.target)) return;
    const key = e.key;
    const modifier = e.ctrlKey || e.metaKey;
    let handled = false;
    if (key === " ") handled = this.togglePlay();
    else if (key === "Delete" || key === "Backspace") handled = this.deleteSelected();
    else if (modifier && key.toLowerCase() === "c") handled = this.copySelected();
    else if (modifier && key.toLowerCase() === "v") handled = this.pasteAtPlayhead();
    else if (modifier && (key.toLowerCase() === "z" || key.toLowerCase() === "y")) {
      if (key.toLowerCase() === "y" || e.shiftKey) this.uc.redo();
      else this.uc.undo();
      handled = true;
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      this.setFrame(this.data.currentFrame + (key === "ArrowLeft" ? -1 : 1));
      handled = true;
    }
    if (handled) e.preventDefault();
  }

  // Menus -------------------------------------------------------------------------------------

  closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }

  showMenu(e, build) {
    this.closeMenu();
    ensureStyles();
    const menu = document.createElement("div");
    menu.className = "vnccs-uc-tl-menu";
    menu.dataset.tlMenu = "";
    const add = (label, run, data) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      if (data) button.dataset.tlAction = data;
      button.addEventListener("click", (event) => { event.stopPropagation(); this.closeMenu(); run(); });
      menu.appendChild(button);
    };
    const heading = (text) => {
      const element = document.createElement("div");
      element.className = "head";
      element.textContent = text;
      menu.appendChild(element);
    };
    const separator = () => {
      const element = document.createElement("div");
      element.className = "sep";
      menu.appendChild(element);
    };
    build({ add, heading, separator });
    if (!menu.childElementCount) return;
    menu.addEventListener("pointerdown", (event) => event.stopPropagation());
    this.uc.container.appendChild(menu);
    const host = this.uc.container.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(host.width - menu.offsetWidth - 4, e.clientX - host.left))}px`;
    menu.style.top = `${Math.max(0, Math.min(host.height - menu.offsetHeight - 4, e.clientY - host.top))}px`;
    this.menu = menu;
    const dismiss = (event) => {
      if (menu.contains(event.target)) return;
      this.closeMenu();
      document.removeEventListener("pointerdown", dismiss, true);
    };
    document.addEventListener("pointerdown", dismiss, true);
  }

  onBodyContextMenu(e) {
    e.preventDefault();
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (!target || !this.data) return;
    if (target.dataset.markerId) {
      const id = target.dataset.markerId;
      this.edit((timeline) => { timeline.markers = timeline.markers.filter((marker) => marker.id !== id); }, "Marker removed");
      return;
    }
    if (target.dataset.effectId) {
      const id = target.dataset.effectId;
      this.showMenu(e, ({ add }) => add("Remove effect", () => this.removeEffect(id), "remove-effect"));
      return;
    }
    if (target.dataset.key || target.dataset.aggTarget) {
      const list = target.dataset.key ? [{ trackName: target.dataset.track, keyId: target.dataset.key }] : this.keysAt(target.dataset.aggTarget, Number(target.dataset.frame));
      if (!list.every((item) => this.selected.has(item.keyId))) this.selectKeys(list);
      this.showMenu(e, ({ add, heading, separator }) => {
        heading("Interpolation");
        for (const preset of INTERPOLATION_PRESETS) add(preset.label, () => this.setInterpolation(preset.value), `interp-${preset.value}`);
        separator();
        add("Copy keys", () => this.copySelected(), "copy");
        add("Delete keys", () => this.deleteSelected(), "delete");
      });
      return;
    }
    const rowIndex = target.closest("[data-row-index]")?.dataset.rowIndex;
    const row = rowIndex !== undefined ? this._rows?.[Number(rowIndex)] : null;
    if (!row) return;
    if (row.kind === "pose") {
      if (row.pose.baked) return;
      const id = row.target;
      this.showMenu(e, ({ add }) => {
        add("Prepare pose frames", () => void this.prepareFromDock(), "pose-prepare");
        add(row.pose.clip.enabled ? "Turn pose animation off" : "Turn pose animation on", () => this.setPoseClipEnabled(id, !row.pose.clip.enabled), "pose-toggle");
        add("Start at the playhead", () => this.setPoseClipOffset(id, this.data.currentFrame), "pose-offset-playhead");
        if (row.pose.clip.offset) add("Start at frame 0", () => this.setPoseClipOffset(id, 0), "pose-offset-reset");
      });
      return;
    }
    if (row.target === CAMERA_TARGET) {
      this.showMenu(e, ({ add }) => {
        add("Key camera from bbox", () => this.keyCameraFromBbox(), "camera-key");
        add("Camera shake here", () => this.edit((timeline) => {
          setKey(timeline, CAMERA_TARGET, "shake", timeline.currentFrame, 12, "easeOut");
          setKey(timeline, CAMERA_TARGET, "shake", Math.min(timeline.frameCount - 1, timeline.currentFrame + Math.round(timeline.fps * 0.5)), 0);
        }, "Camera shake"), "camera-shake");
      });
      return;
    }
    if (row.layer) this.uc.setActiveLayer?.(row.layer.id);
    this.showMenu(e, ({ add, heading, separator }) => {
      heading("Add motion");
      for (const preset of MOTION_PRESETS) add(preset.label, () => this.applyPreset(row.target, preset.id), `preset-${preset.id}`);
      const states = this.uc.sceneStates?.states || [];
      if (states.length) {
        separator();
        heading("Insert state as keys");
        for (const state of states) add(state.name, () => this.insertState(state.id), `state-${state.id}`);
      }
      if (this.data.effects.some((effect) => effect.target === row.target)) {
        separator();
        add("Remove effects", () => this.removeEffects(row.target), "remove-effects");
      }
      if (this.clipboard) {
        separator();
        add("Paste keys at playhead", () => this.pasteAtPlayhead(), "paste");
      }
    });
  }

  // Generation --------------------------------------------------------------------------------

  async generateAtFrame() {
    const uc = this.uc;
    if (uc.drawInProgress || !this.data) return;
    this.pause();
    uc._timelineCompositeFrame = this.data.currentFrame;
    try {
      await uc.draw();
    } finally {
      uc._timelineCompositeFrame = null;
      this.syncHeader();
    }
  }

  // Overlay -----------------------------------------------------------------------------------

  /** The camera frame (dashed) while it differs from the bbox; drawn in world space. */
  drawCameraOverlay(ctx) {
    const rect = this.cameraRect();
    if (!rect) return;
    ctx.save();
    ctx.setLineDash([10 / this.uc.view.scale, 6 / this.uc.view.scale]);
    ctx.lineWidth = 2 / this.uc.view.scale;
    ctx.strokeStyle = "rgba(255,209,102,.9)";
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
  }

  describe() {
    return {
      open: this.isOpen(),
      available: this.isAvailable(),
      autoKey: this.autoKey,
      playing: this.playing,
      animated: this.frameIsAnimated(),
      timeline: this.data ? snapshotTimeline(this.data) : null,
      selected: this.selectionList(),
      poseFrames: {
        bytes: this.poseFrames.bytes,
        layers: Object.fromEntries([...this.poseFrames.layers].map(([id, record]) => [id, [...record.frames].sort((a, b) => a - b)])),
      },
      preparing: Boolean(this.preparing),
      // Per animated pose layer: the studio frame the view frame needs and the one it shows.
      poseDisplay: Object.fromEntries(this.uc.layers.filter((layer) => this.poseClip(layer)).map((layer) => {
        const entry = this.poseClip(layer);
        const frame = this.data ? this.data.currentFrame : 0;
        const shown = this.data && !entry.baked && entry.clip.enabled ? this.poseFrame(layer, frame) : null;
        return [layer.id, {
          baked: entry.baked,
          enabled: entry.clip.enabled,
          offset: entry.clip.offset,
          studioFrame: this.data ? studioFrameFor(frame, entry.info, entry.clip, this.data.fps) : 0,
          shownFrame: shown ? shown.frame : null,
          frameCount: entry.info.frameCount,
        }];
      })),
    };
  }

  dispose() {
    this.pause();
    this.closeMenu();
    this.exportDialog?.remove();
    this.poseFrames.clear();
    this.dock?.remove();
  }
}

/** Installs the timeline dock and its render hooks on a UniCanvas widget. */
export function installUniCanvasTimeline(uc, { createPoseEditor } = {}) {
  if (!uc || uc.timelinePanel) return uc?.timelinePanel;
  const controller = new TimelineController(uc);
  controller.createPoseEditor = createPoseEditor || null;
  uc.timelinePanel = controller;
  if (uc.timeline === undefined) uc.timeline = null;

  if (uc.settingsBar && typeof uc._button === "function") {
    controller.button = uc._button(TIMELINE_ICON, "vnccs-uc-icon vnccs-uc-timeline-toggle", () => controller.toggle(), "Timeline (standalone)");
    controller.button.dataset.timelineToggle = "";
    controller.button.setAttribute("aria-pressed", "false");
    controller.button.hidden = true;
    const anchor = uc.snapBtn?.nextSibling || uc.gearBtn || null;
    uc.settingsBar.insertBefore(controller.button, anchor);
  }
  // `standalone` is set right after construction (vnccs_unicanvas_modes.mjs).
  Promise.resolve().then(() => controller.syncAvailability());

  // The viewport shows the evaluated frame; composites stay at rest unless "Generate at frame".
  const render = uc.render;
  uc.render = (...args) => {
    const result = controller.withFrame("view", () => render.apply(uc, args));
    controller.afterRender();
    return result;
  };
  for (const name of ["makeExportCanvas", "getRasterContentInBboxStats", "drawFlattenedLayers"]) {
    const original = uc[name];
    if (typeof original !== "function") continue;
    uc[name] = (...args) => controller.withFrame("composite", () => original.apply(uc, args));
  }
  return controller;
}
