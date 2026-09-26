/**
 * VNCCS UniCanvas scene timeline (Plan 06, issue #9): the pure data model and evaluator.
 *
 *  - `widget.timeline = { schemaVersion, fps, frameCount, loop, currentFrame, workArea:
 *    { start, end }, tracks: { [trackId]: { target, property, type, keys } }, effects, markers,
 *    poseClips }` (poseClips: pose layer animation offsets, issue #18).
 *    A track id is `${target}:${property}`; a target is a layer id, a group id or `camera`.
 *  - Layer / group properties: `position` (world-px offset from rest), `scale` and `rotation`
 *    (degrees) around the anchor, `opacity`, `visible` and `spriteVariant` (step), `blur` (px).
 *    Camera properties: `rect` (the export view rect) and `shake` (px amplitude).
 *  - Effects `{ id, target, kind, params, start, end }`: breathe, bob, shake, blink, talk. Every
 *    random choice is seeded from the effect id, so two exports of one timeline match.
 *  - Evaluation per layer and frame: rest placement, scene-state offset, keyed transform,
 *    effects; the widget composes the result into one 2D affine matrix (see composeLayerMatrix).
 *
 * Everything here runs under Node for tests; vnccs_unicanvas_timeline.mjs binds the panel and
 * the render hooks onto the widget. Key math shared with Pose Studio is in vnccs_animation_core.mjs.
 */

import {
  INTERPOLATION_NAMES,
  clamp,
  cloneJSON,
  createKeyId,
  findKeySegment,
  finiteNumber,
} from "./vnccs_animation_core.mjs";
import { stateOffsetMatrix } from "./vnccs_unicanvas_state_offset.mjs";

export const TIMELINE_SCHEMA_VERSION = 1;
export const TIMELINE_HISTORY_KIND = "timeline";
export const CAMERA_TARGET = "camera";
export const DEFAULT_TIMELINE_FPS = 24;
export const DEFAULT_TIMELINE_FRAMES = 72;
export const MIN_TIMELINE_FPS = 1;
export const MAX_TIMELINE_FPS = 60;
export const MIN_TIMELINE_FRAMES = 2;
export const MAX_TIMELINE_FRAMES = 3600;
export const FRAME_LIMITS = Object.freeze({ minFrames: MIN_TIMELINE_FRAMES, maxFrames: MAX_TIMELINE_FRAMES });

/** Property -> { type, camera }. Types: vector2, scalar, step, rect. */
export const TIMELINE_PROPERTIES = Object.freeze({
  position: Object.freeze({ type: "vector2", label: "Position" }),
  scale: Object.freeze({ type: "vector2", label: "Scale" }),
  rotation: Object.freeze({ type: "scalar", label: "Rotation" }),
  opacity: Object.freeze({ type: "scalar", label: "Opacity" }),
  visible: Object.freeze({ type: "step", label: "Visible" }),
  spriteVariant: Object.freeze({ type: "step", label: "Sprite variant" }),
  blur: Object.freeze({ type: "scalar", label: "Blur" }),
  rect: Object.freeze({ type: "rect", label: "View", camera: true }),
  shake: Object.freeze({ type: "scalar", label: "Shake", camera: true }),
});
export const LAYER_PROPERTIES = Object.freeze(["position", "scale", "rotation", "opacity", "visible", "spriteVariant", "blur"]);
export const CAMERA_PROPERTIES = Object.freeze(["rect", "shake"]);

export const EFFECT_KINDS = Object.freeze({
  breathe: Object.freeze({ label: "Breathe", params: Object.freeze({ amount: 0.008, period: 4 }) }),
  bob: Object.freeze({ label: "Bob", params: Object.freeze({ amount: 6, period: 1.2 }) }),
  shake: Object.freeze({ label: "Shake", params: Object.freeze({ amount: 14, decay: 5 }) }),
  blink: Object.freeze({ label: "Blink", params: Object.freeze({ minInterval: 2, maxInterval: 6, variantId: null }) }),
  talk: Object.freeze({ label: "Talk", params: Object.freeze({ rate: 10, openVariantId: null, closedVariantId: null }) }),
});

export const MOTION_PRESETS = Object.freeze([
  { id: "enterLeft", label: "Enter from left" },
  { id: "enterRight", label: "Enter from right" },
  { id: "exitLeft", label: "Exit to left" },
  { id: "exitRight", label: "Exit to right" },
  { id: "fadeIn", label: "Fade in" },
  { id: "fadeOut", label: "Fade out" },
  { id: "popIn", label: "Pop in" },
  { id: "jump", label: "Jump" },
  { id: "nod", label: "Nod" },
  { id: "shake", label: "Shake" },
  { id: "breathe", label: "Breathe" },
  { id: "blink", label: "Blink" },
  { id: "talk", label: "Talk" },
].map(Object.freeze));

export const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 1, 0, 0]);

const newEffectId = () => `fx_${createKeyId()}`;
export const trackIdFor = (target, property) => `${target}:${property}`;

// Construction and normalization ---------------------------------------------------------------

export function createTimeline(overrides = {}) {
  return normalizeTimeline({
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    fps: DEFAULT_TIMELINE_FPS,
    frameCount: DEFAULT_TIMELINE_FRAMES,
    loop: true,
    currentFrame: 0,
    tracks: {},
    effects: [],
    markers: [],
    poseClips: {},
    ...overrides,
  });
}

function normalizeValue(type, value) {
  if (type === "vector2") {
    if (!Array.isArray(value) || value.length < 2) return null;
    const x = Number(value[0]);
    const y = Number(value[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  }
  if (type === "scalar") return Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : null;
  if (type === "rect") {
    const out = {};
    for (const key of ["x", "y", "width", "height"]) {
      const number = Number(value?.[key]);
      if (!Number.isFinite(number)) return null;
      out[key] = number;
    }
    return out.width > 0 && out.height > 0 ? out : null;
  }
  // step: booleans (visible) and strings (sprite variant ids)
  if (typeof value === "boolean" || typeof value === "string") return value;
  return null;
}

function normalizeKey(key, type, lastFrame) {
  const value = normalizeValue(type, key?.value);
  if (value === null) return null;
  return {
    id: typeof key.id === "string" && key.id ? key.id : createKeyId(),
    frame: clamp(Math.round(finiteNumber(key.frame)), 0, lastFrame),
    value,
    interpolation: type === "step" ? "hold" : (INTERPOLATION_NAMES.has(key.interpolation) ? key.interpolation : "linear"),
  };
}

function normalizeEffect(raw, lastFrame) {
  const kind = EFFECT_KINDS[raw?.kind];
  if (!kind || typeof raw.target !== "string" || !raw.target) return null;
  const params = { ...kind.params };
  for (const [name, fallback] of Object.entries(kind.params)) {
    const value = raw.params?.[name];
    if (fallback === null) params[name] = typeof value === "string" && value ? value : null;
    else if (Number.isFinite(Number(value))) params[name] = Number(value);
  }
  const start = clamp(Math.round(finiteNumber(raw.start)), 0, lastFrame);
  const end = raw.end === null || raw.end === undefined ? null : clamp(Math.round(finiteNumber(raw.end, lastFrame)), start, lastFrame);
  return { id: typeof raw.id === "string" && raw.id ? raw.id : newEffectId(), target: raw.target, kind: raw.kind, params, start, end };
}

/** A valid timeline from anything; malformed tracks, keys and effects are dropped. */
export function normalizeTimeline(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const fps = clamp(Math.round(finiteNumber(source.fps, DEFAULT_TIMELINE_FPS)), MIN_TIMELINE_FPS, MAX_TIMELINE_FPS);
  const frameCount = clamp(Math.round(finiteNumber(source.frameCount, DEFAULT_TIMELINE_FRAMES)), MIN_TIMELINE_FRAMES, MAX_TIMELINE_FRAMES);
  const lastFrame = frameCount - 1;
  const tracks = {};
  for (const [id, track] of Object.entries(source.tracks || {})) {
    const property = TIMELINE_PROPERTIES[track?.property];
    if (!property || typeof track.target !== "string" || !track.target) continue;
    if (Boolean(property.camera) !== (track.target === CAMERA_TARGET)) continue;
    const byFrame = new Map();
    for (const key of Array.isArray(track.keys) ? track.keys : []) {
      const normalized = normalizeKey(key, property.type, lastFrame);
      if (normalized) byFrame.set(normalized.frame, normalized);
    }
    const trackId = trackIdFor(track.target, track.property);
    if (id !== trackId && tracks[trackId]) continue;
    tracks[trackId] = { target: track.target, property: track.property, type: property.type, keys: [...byFrame.values()].sort((a, b) => a.frame - b.frame) };
  }
  const effects = (Array.isArray(source.effects) ? source.effects : []).map((effect) => normalizeEffect(effect, lastFrame)).filter(Boolean);
  const markers = (Array.isArray(source.markers) ? source.markers : [])
    .filter((marker) => marker && Number.isFinite(Number(marker.frame)))
    .map((marker) => ({ id: typeof marker.id === "string" && marker.id ? marker.id : createKeyId(), frame: clamp(Math.round(Number(marker.frame)), 0, lastFrame), name: String(marker.name || "Marker").slice(0, 80) }));
  const poseClips = normalizePoseClips(source.poseClips, lastFrame);
  const startRaw = clamp(Math.round(finiteNumber(source.workArea?.start, 0)), 0, lastFrame);
  const endRaw = clamp(Math.round(finiteNumber(source.workArea?.end, lastFrame)), 0, lastFrame);
  return {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    fps,
    frameCount,
    loop: source.loop !== false,
    currentFrame: clamp(Math.round(finiteNumber(source.currentFrame)), 0, lastFrame),
    workArea: { start: Math.min(startRaw, endRaw), end: Math.max(startRaw, endRaw) },
    tracks,
    effects,
    markers,
    poseClips,
  };
}

/**
 * Pose animation clips (issue #18): `{ [poseLayerId]: { offset, enabled } }`, only for layers
 * whose clip differs from the default (studio frame 0 at scene frame 0, enabled). `offset` is the
 * scene frame where the studio animation starts; it may be negative (the clip started earlier).
 */
function normalizePoseClips(raw, lastFrame) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, clip] of Object.entries(raw)) {
    if (!id || !clip || typeof clip !== "object") continue;
    const offset = clamp(Math.round(finiteNumber(clip.offset)), -MAX_TIMELINE_FRAMES, lastFrame);
    const enabled = clip.enabled !== false;
    if (offset !== 0 || !enabled) out[id] = { offset, enabled };
  }
  return out;
}

export function isTimelineEmpty(timeline) {
  if (!timeline) return true;
  const keyed = Object.values(timeline.tracks || {}).some((track) => track.keys?.length);
  return !keyed && !timeline.effects?.length && !timeline.markers?.length && !Object.keys(timeline.poseClips || {}).length;
}

/** The serialized form, or null when there is nothing to keep (old states stay unchanged). */
export function serializeTimeline(timeline) {
  if (!timeline) return null;
  const defaults = timeline.fps === DEFAULT_TIMELINE_FPS && timeline.frameCount === DEFAULT_TIMELINE_FRAMES && timeline.loop !== false;
  if (isTimelineEmpty(timeline) && defaults) return null;
  return cloneJSON(normalizeTimeline(timeline), null);
}

/** A history snapshot (plain JSON). */
export const snapshotTimeline = (timeline) => (timeline ? cloneJSON(timeline, null) : null);

// Key editing -----------------------------------------------------------------------------------

export function ensureTrack(timeline, target, property) {
  const info = TIMELINE_PROPERTIES[property];
  if (!info) return null;
  const id = trackIdFor(target, property);
  if (!timeline.tracks[id]) timeline.tracks[id] = { target, property, type: info.type, keys: [] };
  return timeline.tracks[id];
}

/** Writes (or replaces) the key at `frame`; returns it. */
export function setKey(timeline, target, property, frame, value, interpolation = "linear") {
  const track = ensureTrack(timeline, target, property);
  if (!track) return null;
  const key = normalizeKey({ frame, value, interpolation }, track.type, timeline.frameCount - 1);
  if (!key) return null;
  const existing = track.keys.find((item) => item.frame === key.frame);
  if (existing) {
    existing.value = key.value;
    if (interpolation && track.type !== "step") existing.interpolation = key.interpolation;
    return existing;
  }
  track.keys.push(key);
  track.keys.sort((a, b) => a.frame - b.frame);
  return key;
}

/** Removes the selected keys (`[{ trackName, keyId }]`); returns how many went. */
export function deleteKeys(timeline, selections) {
  let removed = 0;
  for (const { trackName, keyId } of selections || []) {
    const track = timeline.tracks[trackName];
    if (!track) continue;
    const before = track.keys.length;
    track.keys = track.keys.filter((key) => key.id !== keyId);
    removed += before - track.keys.length;
  }
  pruneEmptyTracks(timeline);
  return removed;
}

export function pruneEmptyTracks(timeline) {
  for (const [id, track] of Object.entries(timeline.tracks)) if (!track.keys.length) delete timeline.tracks[id];
}

export function setKeysInterpolation(timeline, selections, interpolation) {
  if (!INTERPOLATION_NAMES.has(interpolation)) return 0;
  let changed = 0;
  for (const { trackName, keyId } of selections || []) {
    const track = timeline.tracks[trackName];
    const key = track?.type !== "step" ? track?.keys.find((item) => item.id === keyId) : null;
    if (key && key.interpolation !== interpolation) { key.interpolation = interpolation; changed++; }
  }
  return changed;
}

/** Copies keys to a clipboard relative to the first selected frame and the first target. */
export function copyKeys(timeline, selections) {
  const items = [];
  for (const { trackName, keyId } of selections || []) {
    const track = timeline.tracks[trackName];
    const key = track?.keys.find((item) => item.id === keyId);
    if (key) items.push({ target: track.target, property: track.property, frame: key.frame, value: cloneJSON(key.value, null), interpolation: key.interpolation });
  }
  if (!items.length) return null;
  const first = Math.min(...items.map((item) => item.frame));
  const targets = [...new Set(items.map((item) => item.target))];
  return { schema: "vnccs.unicanvas.keyframes.v1", keys: items.map((item) => ({ ...item, offset: item.frame - first, sameTarget: targets.length === 1 })) };
}

/**
 * Pastes a clipboard at `frame`. Keys copied from one target land on `target` (so keys can
 * move across layers); keys from several targets keep theirs. Returns the new selections.
 */
export function pasteKeys(timeline, clipboard, frame, target = null) {
  if (clipboard?.schema !== "vnccs.unicanvas.keyframes.v1") return [];
  const pasted = [];
  for (const item of clipboard.keys || []) {
    const destination = item.sameTarget && target ? target : item.target;
    const isCamera = destination === CAMERA_TARGET;
    if (Boolean(TIMELINE_PROPERTIES[item.property]?.camera) !== isCamera) continue;
    const key = setKey(timeline, destination, item.property, clamp(frame + item.offset, 0, timeline.frameCount - 1), item.value, item.interpolation);
    if (key) pasted.push({ trackName: trackIdFor(destination, item.property), keyId: key.id, frame: key.frame });
  }
  return pasted;
}

/** Drops tracks and effects of targets that no longer exist. */
export function pruneTimelineTargets(timeline, targetIds) {
  if (!timeline) return false;
  const keep = new Set([...(targetIds || []), CAMERA_TARGET]);
  let changed = false;
  for (const [id, track] of Object.entries(timeline.tracks)) if (!keep.has(track.target)) { delete timeline.tracks[id]; changed = true; }
  const effects = timeline.effects.filter((effect) => keep.has(effect.target));
  if (effects.length !== timeline.effects.length) { timeline.effects = effects; changed = true; }
  for (const id of Object.keys(timeline.poseClips || {})) if (!keep.has(id)) { delete timeline.poseClips[id]; changed = true; }
  return changed;
}

// Evaluation ------------------------------------------------------------------------------------

function lerp(a, b, t) { return a + (b - a) * t; }

/** The track's value at `frame`, or undefined when the track has no keys. */
export function evaluateTrack(timeline, trackId, frame) {
  const track = timeline?.tracks?.[trackId];
  const segment = findKeySegment(track?.keys, frame);
  if (!segment) return undefined;
  const { left, right, t } = segment;
  if (track.type === "step" || left === right || t === 0) return cloneJSON(left.value, null);
  if (track.type === "scalar") return lerp(left.value, right.value, t);
  if (track.type === "vector2") return [lerp(left.value[0], right.value[0], t), lerp(left.value[1], right.value[1], t)];
  return {
    x: lerp(left.value.x, right.value.x, t),
    y: lerp(left.value.y, right.value.y, t),
    width: lerp(left.value.width, right.value.width, t),
    height: lerp(left.value.height, right.value.height, t),
  };
}

/** Deterministic 32-bit string hash (FNV-1a). */
export function hashString(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Mulberry32: a seeded [0, 1) generator. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const effectActive = (effect, frame) => frame >= effect.start && (effect.end === null || frame <= effect.end);

/** Frames (from the effect start) where a seeded blink closes the eyes: [{ start, length }]. */
export function blinkSchedule(effect, fps, lastFrame) {
  const random = seededRandom(hashString(`blink:${effect.id}`));
  const min = Math.max(0.5, effect.params.minInterval);
  const max = Math.max(min, effect.params.maxInterval);
  const end = effect.end === null ? lastFrame : effect.end;
  const blinks = [];
  let frame = effect.start + Math.round((min + random() * (max - min)) * fps * 0.5);
  while (frame <= end && blinks.length < 10000) {
    const length = random() < 0.5 ? 3 : 4;
    blinks.push({ start: frame, length });
    frame += length + Math.max(1, Math.round((min + random() * (max - min)) * fps));
  }
  return blinks;
}

function effectNoise(effect, frame, channel) {
  return seededRandom(hashString(`shake:${effect.id}:${channel}:${frame}`))() * 2 - 1;
}

/**
 * The combined effect contribution for one target at one frame:
 * `{ dx, dy, scaleY, variantId }` (identity: 0, 0, 1, null).
 */
export function evaluateEffects(timeline, target, frame, fps = timeline?.fps || DEFAULT_TIMELINE_FPS) {
  const out = { dx: 0, dy: 0, scaleY: 1, variantId: null };
  for (const effect of timeline?.effects || []) {
    if (effect.target !== target || !effectActive(effect, frame)) continue;
    const seconds = (frame - effect.start) / fps;
    const params = effect.params;
    if (effect.kind === "breathe") {
      const phase = seededRandom(hashString(`breathe:${effect.id}`))() * Math.PI * 2;
      const amount = clamp(params.amount, 0.004, 0.015);
      const period = clamp(params.period, 3, 5);
      out.scaleY *= 1 + amount * Math.sin((2 * Math.PI * seconds) / period + phase);
    } else if (effect.kind === "bob") {
      out.dy -= params.amount * Math.sin((2 * Math.PI * seconds) / Math.max(0.1, params.period));
    } else if (effect.kind === "shake") {
      const falloff = Math.exp(-Math.max(0, params.decay) * seconds);
      out.dx += params.amount * falloff * effectNoise(effect, frame, "x");
      out.dy += params.amount * falloff * effectNoise(effect, frame, "y");
    } else if (effect.kind === "blink" && params.variantId) {
      const closed = blinkSchedule(effect, fps, timeline.frameCount - 1).some((blink) => frame >= blink.start && frame < blink.start + blink.length);
      if (closed) out.variantId = params.variantId;
    } else if (effect.kind === "talk" && (params.openVariantId || params.closedVariantId)) {
      const rate = clamp(params.rate, 8, 12);
      const open = Math.floor((seconds * rate)) % 2 === 0;
      const id = open ? params.openVariantId : params.closedVariantId;
      if (id) out.variantId = id;
    }
  }
  return out;
}

/**
 * The keyed and effect state of one target at one frame, relative to rest:
 * `{ tx, ty, sx, sy, rotation, opacity, visible, variantId, blur, animated }` where opacity,
 * visible, variantId and blur are undefined when nothing drives them.
 */
export function evaluateTarget(timeline, target, frame) {
  const read = (property) => evaluateTrack(timeline, trackIdFor(target, property), frame);
  const position = read("position") || [0, 0];
  const scale = read("scale") || [1, 1];
  const rotation = read("rotation") ?? 0;
  const fx = evaluateEffects(timeline, target, frame);
  const variantId = fx.variantId ?? read("spriteVariant");
  const result = {
    tx: position[0] + fx.dx,
    ty: position[1] + fx.dy,
    sx: scale[0],
    sy: scale[1] * fx.scaleY,
    rotation,
    opacity: read("opacity"),
    visible: read("visible"),
    variantId: typeof variantId === "string" ? variantId : undefined,
    blur: read("blur"),
  };
  result.animated = Boolean(result.tx || result.ty || result.sx !== 1 || result.sy !== 1 || result.rotation
    || result.opacity !== undefined || result.visible !== undefined || result.variantId !== undefined || result.blur);
  return result;
}

/** True when the target has any keys or effects at all. */
export function targetHasAnimation(timeline, target) {
  if (!timeline) return false;
  return Object.values(timeline.tracks).some((track) => track.target === target && track.keys.length)
    || timeline.effects.some((effect) => effect.target === target);
}

// Matrices (canvas order [a, b, c, d, e, f]) ---------------------------------------------------

export function multiplyMatrices(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invertMatrix(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  return [
    m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export const applyMatrix = (m, p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

export const isTranslationMatrix = (m) => Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[3] - 1) < 1e-9;

/** The axis-aligned bounds of a rect mapped through a matrix. */
export function transformRectBounds(m, rect) {
  const corners = [
    applyMatrix(m, { x: rect.x, y: rect.y }),
    applyMatrix(m, { x: rect.x + rect.width, y: rect.y }),
    applyMatrix(m, { x: rect.x, y: rect.y + rect.height }),
    applyMatrix(m, { x: rect.x + rect.width, y: rect.y + rect.height }),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** translate(anchor + t) * rotate * scale * translate(-anchor). */
export function localMatrix(state, anchor = { x: 0, y: 0 }) {
  const radians = ((state?.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const sx = state?.sx ?? 1;
  const sy = state?.sy ?? 1;
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  const tx = (state?.tx || 0) + anchor.x;
  const ty = (state?.ty || 0) + anchor.y;
  return [a, b, c, d, tx - (a * anchor.x + c * anchor.y), ty - (b * anchor.x + d * anchor.y)];
}

/**
 * The full render matrix of a layer: scene-state offset, then the transforms of its group chain
 * (outermost first, each around its own anchor), then its own keyed transform around its anchor.
 * `chain` is `[{ state, anchor }]` ordered outermost group -> layer.
 */
export function composeLayerMatrix(stateOffset, chain) {
  // The scene-state placement: a move, or a move and a depth scale (vnccs_unicanvas_state_offset.mjs).
  let matrix = stateOffsetMatrix(stateOffset);
  for (const item of chain || []) {
    if (!item?.state) continue;
    matrix = multiplyMatrices(matrix, localMatrix(item.state, item.anchor));
  }
  return matrix;
}

// Presets and state conversion ----------------------------------------------------------------

/**
 * Inserts a motion preset at `frame` for `target` as ordinary keys and effects.
 * `context = { rest: evaluateTarget at frame, restOpacity, distance, height, variants: { blink,
 * mouthOpen, mouthClosed } }`. Returns `{ ok, missing? }` (missing: a sprite variant to create).
 */
export function applyMotionPreset(timeline, target, presetId, frame, context = {}) {
  const fps = timeline.fps;
  const last = timeline.frameCount - 1;
  const at = (seconds) => clamp(frame + Math.round(seconds * fps), 0, last);
  const current = context.rest || evaluateTarget(timeline, target, frame);
  const x = current.tx || 0;
  const y = current.ty || 0;
  const opacity = clamp(finiteNumber(current.opacity ?? context.restOpacity, 1), 0, 1);
  const distance = Math.max(1, finiteNumber(context.distance, 512));
  const height = Math.max(1, finiteNumber(context.height, 512));
  const position = (f, px, py, interpolation) => setKey(timeline, target, "position", f, [px, py], interpolation);
  const fade = (f, value, interpolation) => setKey(timeline, target, "opacity", f, value, interpolation);
  const addEffect = (kind, params = {}, end = null) => {
    const effect = normalizeEffect({ kind, target, params, start: frame, end }, last);
    timeline.effects.push(effect);
    return effect;
  };
  switch (presetId) {
    case "enterLeft":
    case "enterRight": {
      const sign = presetId === "enterLeft" ? -1 : 1;
      position(frame, x + sign * distance, y, "easeOut");
      position(at(0.5), x, y, "linear");
      fade(frame, 0, "easeOut");
      fade(at(0.5), opacity, "linear");
      return { ok: true };
    }
    case "exitLeft":
    case "exitRight": {
      const sign = presetId === "exitLeft" ? -1 : 1;
      position(frame, x, y, "easeIn");
      position(at(0.5), x + sign * distance, y, "linear");
      fade(frame, opacity, "easeIn");
      fade(at(0.5), 0, "linear");
      return { ok: true };
    }
    case "fadeIn":
      fade(frame, 0, "easeInOut");
      fade(at(0.5), opacity, "linear");
      return { ok: true };
    case "fadeOut":
      fade(frame, opacity, "easeInOut");
      fade(at(0.5), 0, "linear");
      return { ok: true };
    case "popIn":
      setKey(timeline, target, "scale", frame, [0.9, 0.9], "easeOut");
      setKey(timeline, target, "scale", at(0.3), [1, 1], "linear");
      return { ok: true };
    case "jump": {
      const lift = Math.round(height * 0.08);
      position(frame, x, y, "easeOut");
      position(at(0.2), x, y - lift, "easeIn");
      position(at(0.4), x, y, "linear");
      return { ok: true };
    }
    case "nod": {
      const dip = Math.max(2, Math.round(height * 0.012));
      position(frame, x, y, "easeInOut");
      position(at(0.15), x, y + dip, "easeInOut");
      position(at(0.3), x, y, "easeInOut");
      position(at(0.45), x, y + dip, "easeInOut");
      position(at(0.6), x, y, "linear");
      return { ok: true };
    }
    case "shake":
      addEffect("shake", {}, at(0.6));
      return { ok: true };
    case "breathe":
      addEffect("breathe");
      return { ok: true };
    case "blink": {
      const variantId = context.variants?.blink || null;
      if (!variantId) return { ok: false, missing: "blink" };
      addEffect("blink", { variantId });
      return { ok: true };
    }
    case "talk": {
      const openVariantId = context.variants?.mouthOpen || null;
      const closedVariantId = context.variants?.mouthClosed || null;
      if (!openVariantId) return { ok: false, missing: "mouth open" };
      addEffect("talk", { openVariantId, closedVariantId }, at(2));
      return { ok: true };
    }
    default:
      return { ok: false };
  }
}

/** Sprite variant ids used by blink / talk, found by name. */
export function findEffectVariants(sprite) {
  const variants = (sprite?.variants || []).filter((variant) => variant?.id && variant.status !== "failed");
  const find = (pattern) => variants.find((variant) => pattern.test(String(variant.name || "")))?.id || null;
  return {
    blink: find(/^(blink|eyes closed)$/i) || find(/blink|eyes? closed|closed eyes/i),
    mouthOpen: find(/mouth open|open mouth/i),
    mouthClosed: find(/mouth closed|closed mouth/i) || find(/^neutral$/i),
  };
}

/**
 * Keys at `frame` that reproduce a scene state. `layers` are the live layers (their stateOffset
 * is the offset of the active state, which evaluation already applies), `state.layers` the
 * stored per-layer properties. Returns the number of keys written.
 */
export function insertStateKeys(timeline, layers, state, frame) {
  let written = 0;
  for (const layer of layers || []) {
    const entry = state?.layers?.[layer.id];
    if (!entry || layer.type === "mask") continue;
    if (typeof entry.visible === "boolean") written += setKey(timeline, layer.id, "visible", frame, entry.visible) ? 1 : 0;
    if (entry.opacity !== undefined) written += setKey(timeline, layer.id, "opacity", frame, clamp(finiteNumber(entry.opacity, 1), 0, 1), "hold") ? 1 : 0;
    if (entry.offset) {
      const live = layer.stateOffset || { x: 0, y: 0 };
      const dx = finiteNumber(entry.offset.x) - finiteNumber(live.x);
      const dy = finiteNumber(entry.offset.y) - finiteNumber(live.y);
      written += setKey(timeline, layer.id, "position", frame, [dx, dy], "hold") ? 1 : 0;
    }
    if (typeof entry.variantId === "string") written += setKey(timeline, layer.id, "spriteVariant", frame, entry.variantId) ? 1 : 0;
  }
  return written;
}

/** Next playback frame: wraps inside the work area when looping, stops at its end otherwise. */
export function advancePlaybackFrame(timeline, startFrame, elapsedFrames) {
  const { start, end } = timeline.workArea;
  const span = end - start + 1;
  const base = clamp(startFrame, start, end) - start;
  const next = base + Math.max(0, Math.floor(elapsedFrames));
  if (timeline.loop) return { frame: start + (next % span), done: false };
  return next >= span - 1 ? { frame: end, done: true } : { frame: start + next, done: false };
}
