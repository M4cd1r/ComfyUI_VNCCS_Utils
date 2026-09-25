/**
 * VNCCS UniCanvas scene timeline: Pose Studio animation of pose layers (Plan 06.2, issue #18).
 * Pure helpers (they run under Node for tests); vnccs_unicanvas_timeline.mjs uses them for the
 * "Pose animation" row, playback and export.
 *
 *  - A pose layer is animated when a studio character has animation tracks (inline tracks or a
 *    compact cache reference with a track count). Its studio timing comes from the scene schema's
 *    shared `timeline` (fps, frameCount, loop), falling back to the first character's animation.
 *  - The clip maps scene frames to studio frames: studio frame 0 plays at scene frame `offset`,
 *    the studio fps is converted to the scene fps, frames before the clip hold the first frame and
 *    frames after it loop (studio loop on) or hold the last frame.
 *  - Frames are mannequin renders prepared ahead of time (only one pose editor is live at a time)
 *    into PoseFrameCache: LRU with a byte cap, keyed by layer, pose hash and studio frame. A pose
 *    edit changes the hash and drops that layer's frames; lookups fall back to the nearest cached
 *    frame, so playback never shows a blank while frames are missing.
 */

import { clamp, finiteNumber } from "./vnccs_animation_core.mjs";
import { hashString } from "./vnccs_unicanvas_timeline_core.mjs";

export const POSE_FRAME_CACHE_BYTES = 256 * 1024 * 1024;
export const POSE_BAKED_NOTE = "baked characters use 2D motion and sprite variants";
const DEFAULT_CLIP = Object.freeze({ offset: 0, enabled: true });

const trackCountOf = (animation) => {
  if (!animation || typeof animation !== "object") return 0;
  if (Number.isFinite(Number(animation.trackCount))) return Number(animation.trackCount);
  const tracks = animation.tracks?.bones && typeof animation.tracks.bones === "object"
    ? { ...animation.tracks.bones, ...(animation.tracks.model || {}) }
    : animation.tracks;
  return tracks && typeof tracks === "object" ? Object.values(tracks).filter((track) => track?.keys?.length).length : 0;
};

const infoCache = new WeakMap();

/** `{ frameCount, fps, loop }` of an animated pose layer, or null. */
export function poseAnimationInfo(layer) {
  const studio = layer?.type === "pose" ? layer.pose?.studio : null;
  if (!studio || typeof studio !== "object") return null;
  if (infoCache.has(studio)) return infoCache.get(studio);
  const animations = [
    ...(Array.isArray(studio.characters) ? studio.characters.map((character) => character?.animation) : []),
    studio.animation,
  ].filter((animation) => animation && typeof animation === "object");
  let info = null;
  if (animations.some((animation) => trackCountOf(animation) > 0)) {
    const source = studio.timeline && typeof studio.timeline === "object" ? studio.timeline : animations[0];
    const fps = clamp(finiteNumber(source.fps ?? animations[0].fps, 12), 0.001, 120);
    const duration = finiteNumber(source.duration ?? animations[0].duration, 0);
    const frameCount = clamp(Math.round(finiteNumber(source.frameCount ?? animations[0].frameCount, duration > 0 ? duration * fps : 24)), 2, 600);
    info = { frameCount, fps, loop: (source.loop ?? animations[0].loop) !== false };
  }
  infoCache.set(studio, info);
  return info;
}

/** True when the layer has baked characters: its pose animation row is disabled. */
export function isPoseLayerBaked(layer) {
  const characters = layer?.pose?.bake?.characters;
  return Boolean(characters && Object.values(characters).some((entry) => entry?.status === "baked" || entry?.status === "stale"));
}

export function poseClipOf(timeline, layerId) {
  const clip = timeline?.poseClips?.[layerId];
  return clip ? { offset: Math.round(finiteNumber(clip.offset)), enabled: clip.enabled !== false } : { ...DEFAULT_CLIP };
}

/** Writes a clip; the default clip is stored as no entry. */
export function setPoseClip(timeline, layerId, clip) {
  if (!timeline || !layerId) return;
  const next = { ...poseClipOf(timeline, layerId), ...clip };
  next.offset = Math.round(finiteNumber(next.offset));
  next.enabled = next.enabled !== false;
  timeline.poseClips ||= {};
  if (next.offset === 0 && next.enabled) delete timeline.poseClips[layerId];
  else timeline.poseClips[layerId] = next;
}

/** Scene frames the clip spans once: `{ start, end }` (end inclusive). */
export function poseClipSceneRange(info, clip, sceneFps) {
  const length = Math.max(1, Math.ceil((info.frameCount * sceneFps) / info.fps));
  return { start: clip.offset, end: clip.offset + length - 1 };
}

/** The studio frame shown at a scene frame. */
export function studioFrameFor(sceneFrame, info, clip, sceneFps) {
  const local = sceneFrame - clip.offset;
  if (local <= 0) return 0;
  // A tiny epsilon keeps exact ratios (24 -> 12 fps) on whole frames despite float error.
  const frame = Math.floor((local * info.fps) / sceneFps + 1e-6);
  if (frame < info.frameCount) return frame;
  return info.loop ? frame % info.frameCount : info.frameCount - 1;
}

/** The distinct studio frames needed for scene frames start..end (inclusive), ascending. */
export function studioFramesForRange(info, clip, sceneFps, start, end) {
  const frames = new Set();
  for (let frame = start; frame <= end; frame++) {
    frames.add(studioFrameFor(frame, info, clip, sceneFps));
    if (frames.size >= info.frameCount) break;
  }
  return [...frames].sort((a, b) => a - b);
}

const HASH_SKIP = new Set(["currentFrame", "current_frame", "capture_id", "activeTab", "active_character_id", "ui"]);
const hashCache = new WeakMap();

/**
 * A hash of everything that changes the mannequin render: the studio scene (minus the playhead and
 * UI-only fields), the viewport camera and the rect size. Memoized per studio object, which the
 * editor replaces on every change.
 */
export function poseLayerHash(layer) {
  const pose = layer?.pose;
  if (!pose?.studio) return "";
  const width = Math.round(pose.rect?.width || 0);
  const height = Math.round(pose.rect?.height || 0);
  const memo = hashCache.get(pose.studio);
  if (memo && memo.viewport === pose.viewport && memo.width === width && memo.height === height) return memo.hash;
  const text = JSON.stringify([pose.studio, pose.viewport || null, width, height], (key, value) => (HASH_SKIP.has(key) ? undefined : value));
  const hash = `${hashString(text).toString(36)}${text.length.toString(36)}`;
  hashCache.set(pose.studio, { viewport: pose.viewport, width, height, hash });
  return hash;
}

/** LRU cache of prepared pose frames with a byte cap. */
export class PoseFrameCache {
  constructor(maxBytes = POSE_FRAME_CACHE_BYTES) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.entries = new Map(); // key -> { layerId, frame, canvas, bytes }, oldest first
    this.layers = new Map(); // layerId -> { hash, frames: Set }
  }

  static key(layerId, frame) { return `${layerId}\u0000${frame}`; }

  /** Drops a layer's frames when its pose hash changed; returns the layer's record or null. */
  layerRecord(layerId, hash) {
    const record = this.layers.get(layerId);
    if (record && record.hash !== hash) {
      this.invalidateLayer(layerId);
      return null;
    }
    return record || null;
  }

  has(layerId, hash, frame) {
    return Boolean(this.layerRecord(layerId, hash)?.frames.has(frame));
  }

  set(layerId, hash, frame, canvas, bytes = (canvas?.width || 0) * (canvas?.height || 0) * 4) {
    let record = this.layerRecord(layerId, hash);
    if (!record) {
      record = { hash, frames: new Set() };
      this.layers.set(layerId, record);
    }
    const key = PoseFrameCache.key(layerId, frame);
    this.remove(key);
    this.entries.set(key, { layerId, frame, canvas, bytes });
    record.frames.add(frame);
    this.bytes += bytes;
    // Evict least recently used frames, never the one just stored.
    for (const [oldKey] of this.entries) {
      if (this.bytes <= this.maxBytes || oldKey === key) break;
      this.remove(oldKey);
    }
  }

  touch(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.canvas;
  }

  get(layerId, hash, frame) {
    return this.layerRecord(layerId, hash) ? this.touch(PoseFrameCache.key(layerId, frame)) : null;
  }

  /** The exact frame, else the nearest cached frame (earlier wins a tie), else null. */
  nearest(layerId, hash, frame) {
    const record = this.layerRecord(layerId, hash);
    if (!record?.frames.size) return null;
    if (record.frames.has(frame)) return { frame, canvas: this.touch(PoseFrameCache.key(layerId, frame)) };
    let best = null;
    for (const candidate of record.frames) {
      const distance = Math.abs(candidate - frame);
      const bestDistance = best === null ? Infinity : Math.abs(best - frame);
      if (distance < bestDistance || (distance === bestDistance && candidate < best)) best = candidate;
    }
    return { frame: best, canvas: this.touch(PoseFrameCache.key(layerId, best)) };
  }

  remove(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    const record = this.layers.get(entry.layerId);
    record?.frames.delete(entry.frame);
    if (record && !record.frames.size) this.layers.delete(entry.layerId);
  }

  invalidateLayer(layerId) {
    const record = this.layers.get(layerId);
    if (!record) return;
    for (const frame of [...record.frames]) this.remove(PoseFrameCache.key(layerId, frame));
    this.layers.delete(layerId);
  }

  clear() {
    this.entries.clear();
    this.layers.clear();
    this.bytes = 0;
  }
}
