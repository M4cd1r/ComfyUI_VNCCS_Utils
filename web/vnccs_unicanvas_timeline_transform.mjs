/**
 * VNCCS UniCanvas timeline transforms (issue #9): Free Transform and canvas handles that write
 * position / scale / rotation keys at the playhead instead of resampling pixels.
 *
 *  - Free Transform on a frame where the layer is keyed away from rest (auto-key on): the draft
 *    starts from the frame the layer shows at (vnccs_unicanvas.js `beginTransformDraft`), and
 *    Apply fits move / scale / rotation to the final frame and writes them as keys on the current
 *    frame - one `timeline` history entry. Skew, distort, perspective and warp have no key, so
 *    they are dropped with a status message. With auto-key off the draft edits the rest pixels
 *    through the inverse frame matrix like any other placement.
 *  - Key handles (Move tool, dock open, auto-key on): four corner handles scale and a knob above
 *    the frame rotates the active layer around its key anchor (the feet). Every pointermove writes
 *    the key at the playhead and renders (realtime rule); the release commits one history entry.
 *
 * The math is pure and exported for tests; `TimelineKeyHandles` owns the pointer gesture and the
 * overlay and talks to the timeline controller (vnccs_unicanvas_timeline.mjs) only.
 */

import {
  applyMatrix,
  composeLayerMatrix,
  evaluateEffects,
  evaluateTrack,
  invertMatrix,
  multiplyMatrices,
  setKey,
  trackIdFor,
} from "./vnccs_unicanvas_timeline_core.mjs?v=1790499067345";
import { placedQuad, QUAD_KEYS } from "./vnccs_unicanvas_transform.mjs?v=1790499067345";

const DEGREES = 180 / Math.PI;
const MIN_SCALE = 0.01;
const KEY_EPSILON = { position: 0.01, scale: 1e-4, rotation: 1e-3 };
const HANDLE_COLOR = "#9d7aff";

// Pure math ------------------------------------------------------------------------------------

/**
 * The affine matrix that best maps `rect` onto `quad` (averaged opposite edges, centers matched):
 * exact for a parallelogram, the closest move / scale / rotate / skew for any other frame.
 */
export function quadToAffine(quad, rect) {
  const w = Math.max(1e-9, rect.width), h = Math.max(1e-9, rect.height);
  const { nw, ne, se, sw } = quad;
  const u = { x: (ne.x - nw.x + se.x - sw.x) / (2 * w), y: (ne.y - nw.y + se.y - sw.y) / (2 * w) };
  const v = { x: (sw.x - nw.x + se.x - ne.x) / (2 * h), y: (sw.y - nw.y + se.y - ne.y) / (2 * h) };
  const center = { x: (nw.x + ne.x + se.x + sw.x) / 4, y: (nw.y + ne.y + se.y + sw.y) / 4 };
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  return [u.x, u.y, v.x, v.y, center.x - (u.x * cx + v.x * cy), center.y - (u.y * cx + v.y * cy)];
}

/** Whether a frame is a parallelogram (an affine image of the source rectangle). */
export function isAffineQuad(quad, tolerance = 0.5) {
  return Math.abs(quad.nw.x + quad.se.x - quad.ne.x - quad.sw.x) <= tolerance
    && Math.abs(quad.nw.y + quad.se.y - quad.ne.y - quad.sw.y) <= tolerance;
}

/**
 * A layer-local matrix as the keyed state of `localMatrix` (vnccs_unicanvas_timeline_core.mjs):
 * `{ tx, ty, sx, sy, rotation, skew }`. A mirror lands in `sy`; the rotation takes the turn
 * closest to `nearRotation` so keys never spin through 360; `skew` is the dropped remainder.
 */
export function decomposeLocalMatrix(matrix, anchor = { x: 0, y: 0 }, nearRotation = 0) {
  const [a, b, c, d] = matrix;
  const sx = Math.hypot(a, b);
  const radians = Math.atan2(b, a);
  let rotation = radians * DEGREES;
  rotation += 360 * Math.round((nearRotation - rotation) / 360);
  const sy = sx > 1e-12 ? (a * d - b * c) / sx : 0;
  const skew = Math.abs(c + Math.sin(radians) * sy) + Math.abs(d - Math.cos(radians) * sy);
  // localMatrix maps the anchor to anchor + t, whatever the linear part.
  const pivot = applyMatrix(matrix, anchor);
  return { tx: pivot.x - anchor.x, ty: pivot.y - anchor.y, sx, sy, rotation, skew };
}

/**
 * Keys for the final Free Transform frame of a keyed layer. `context` is the layer's frame at the
 * playhead (`TimelineController.transformKeyFrame`): `{ rest, parent, anchor, effects, current }`.
 * Returns `{ position, scale, rotation, lossy }`: effect offsets (bob, shake, breathe) are taken
 * out, so the keys reproduce the frame together with the effects.
 */
export function transformKeysFromFrame(frame, context) {
  const target = quadToAffine(frame.quad, context.rest);
  const inverseParent = invertMatrix(context.parent);
  if (!inverseParent) return null;
  const local = decomposeLocalMatrix(multiplyMatrices(inverseParent, target), context.anchor, context.current.rotation);
  const effects = context.effects || { dx: 0, dy: 0, scaleY: 1 };
  const scale = Math.max(1e-9, Math.hypot(local.sx, local.sy));
  return {
    position: [local.tx - effects.dx, local.ty - effects.dy],
    scale: [local.sx, local.sy / (effects.scaleY || 1)],
    rotation: local.rotation,
    lossy: Boolean(frame.mesh) || !isAffineQuad(frame.quad) || local.skew / scale > 1e-3,
  };
}

/** The keyed values `keys` changes against `current` (`{ position, scale, rotation }`). */
export function changedTransformKeys(keys, current) {
  const differs = (name, a, b) => (Array.isArray(a) ? a.some((value, index) => Math.abs(value - b[index]) > KEY_EPSILON[name]) : Math.abs(a - b) > KEY_EPSILON[name]);
  return ["position", "scale", "rotation"].filter((name) => keys[name] !== undefined && differs(name, keys[name], current[name]));
}

/** Uniform scale from a corner drag around `pivot`, never collapsing to zero. */
export function scaleFromDrag(pivot, start, point, startScale) {
  const from = Math.hypot(start.x - pivot.x, start.y - pivot.y);
  if (from < 1e-6) return [...startScale];
  const factor = Math.hypot(point.x - pivot.x, point.y - pivot.y) / from;
  const floor = MIN_SCALE / Math.max(MIN_SCALE, Math.min(Math.abs(startScale[0]), Math.abs(startScale[1])));
  const f = Math.max(floor, factor);
  return [startScale[0] * f, startScale[1] * f];
}

/**
 * Rotation (degrees) from a knob drag around `pivot`. `direction` is -1 under a mirrored parent
 * placement; Shift snaps the result to 15 degrees.
 */
export function rotationFromDrag(pivot, start, point, startRotation, { direction = 1, snap = false } = {}) {
  const angle = (p) => Math.atan2(p.y - pivot.y, p.x - pivot.x);
  let delta = (angle(point) - angle(start)) * DEGREES;
  delta -= 360 * Math.round(delta / 360);
  const value = startRotation + direction * delta;
  return snap ? Math.round(value / 15) * 15 : value;
}

/** The handle points of a keyed frame: corners, the knob above the top edge and the pivot. */
export function keyHandleGeometry(rest, matrix, anchor, knobOffset) {
  const quad = placedQuad(rest, matrix);
  const center = { x: (quad.nw.x + quad.se.x) / 2, y: (quad.nw.y + quad.se.y) / 2 };
  const top = { x: (quad.nw.x + quad.ne.x) / 2, y: (quad.nw.y + quad.ne.y) / 2 };
  const out = { x: top.x - center.x, y: top.y - center.y };
  const length = Math.hypot(out.x, out.y) || 1;
  const knob = { x: top.x + (out.x / length) * knobOffset, y: top.y + (out.y / length) * knobOffset };
  return { quad, top, knob, pivot: applyMatrix(matrix, anchor) };
}

/** Which handle of `geometry` is under `point` (`{ kind: "scale", corner } | { kind: "rotate" }`). */
export function hitKeyHandle(geometry, point, threshold) {
  const near = (p) => Math.hypot(point.x - p.x, point.y - p.y) <= threshold;
  if (near(geometry.knob)) return { kind: "rotate" };
  const corner = QUAD_KEYS.find((key) => near(geometry.quad[key]));
  return corner ? { kind: "scale", corner } : null;
}

// Controller-side ------------------------------------------------------------------------------

/** The keyed transform values of `target` at `frame` (identity where nothing is keyed). */
export function currentTransformKeys(timeline, target, frame) {
  return {
    position: evaluateTrack(timeline, trackIdFor(target, "position"), frame) || [0, 0],
    scale: evaluateTrack(timeline, trackIdFor(target, "scale"), frame) || [1, 1],
    rotation: evaluateTrack(timeline, trackIdFor(target, "rotation"), frame) ?? 0,
  };
}

/**
 * Everything a keyed edit of `layer` at `frame` needs: its rest rect, the parent placement (the
 * scene-state offset and the group chain), the key anchor, the effect offsets and the current
 * keys, all at `frame`. Null for a layer without stored pixels.
 */
export function layerKeyContext(panel, layer, frame) {
  const rest = panel.restBounds(layer);
  if (!rest || !panel.data) return null;
  const parents = panel.chainTransforms(layer, frame).filter((entry) => entry.item !== layer);
  const parent = composeLayerMatrix(panel.uc.getLayerStateOffset(layer), parents.map((entry) => entry.transform));
  return {
    frame,
    rest,
    parent,
    anchor: panel.anchorOf(layer),
    effects: evaluateEffects(panel.data, layer.id, frame),
    current: currentTransformKeys(panel.data, layer.id, frame),
  };
}

/** Writes the keys of an applied keyed Free Transform: one history entry, or none unchanged. */
export function commitTransformKeys(panel, layer, frame, context) {
  const keys = transformKeysFromFrame(frame, context);
  if (!keys) return null;
  const changed = changedTransformKeys(keys, context.current);
  if (changed.length) {
    panel.edit((timeline) => {
      // The frame the draft started on, even if the playhead moved while it was open.
      for (const name of changed) setKey(timeline, layer.id, name, context.frame, keys[name], "linear");
    }, `Transform keys at frame ${context.frame}`);
  }
  if (keys.lossy) panel.uc.setStatus?.("Timeline keys hold move, scale and rotation: the skew / distortion was dropped", true);
  return { keys, changed };
}

/** Scale / rotate handles on the active layer at the playhead (Move tool, auto-key on). */
export class TimelineKeyHandles {
  constructor(panel) {
    this.panel = panel;
    this.drag = null;
  }

  get uc() { return this.panel.uc; }

  /** The layer the handles act on, or null when they are not shown. */
  target() {
    const { panel, uc } = this;
    if (!panel.isOpen() || !panel.autoKey || uc.tool !== "move" || uc.transformDraft) return null;
    const layer = panel.keyTarget();
    return layer && layer.type !== "group" && panel.restBounds(layer) ? layer : null;
  }

  geometry(layer) {
    const scale = this.uc.view?.scale || 1;
    return keyHandleGeometry(this.panel.restBounds(layer), this.uc.getLayerRenderTransform(layer), this.panel.anchorOf(layer), 28 / scale);
  }

  hit(point) {
    const layer = this.target();
    if (!layer || !point) return null;
    const hit = hitKeyHandle(this.geometry(layer), point, 9 / (this.uc.view?.scale || 1));
    return hit ? { layer, hit } : null;
  }

  /** Pointerdown with the Move tool: grabs a handle (true) or leaves the press to the move. */
  begin(point, event = null) {
    const found = this.hit(point);
    if (!found) return false;
    const { panel, uc } = this;
    panel.pause();
    const timeline = panel.ensureData();
    const frame = timeline.currentFrame;
    const context = layerKeyContext(panel, found.layer, frame);
    const det = context.parent[0] * context.parent[3] - context.parent[1] * context.parent[2];
    this.drag = {
      ...found.hit,
      layerId: found.layer.id,
      before: panel.snapshot(),
      start: { x: point.x, y: point.y },
      pivot: this.geometry(found.layer).pivot,
      current: context.current,
      direction: det < 0 ? -1 : 1,
    };
    uc.pointerMode = "timeline-key-handle";
    this.update(point, event);
    return true;
  }

  /** Pointermove: the key at the playhead follows the pointer and the view renders it now. */
  update(point, event = null) {
    const drag = this.drag;
    if (!drag || !point) return;
    const timeline = this.panel.ensureData();
    if (drag.kind === "scale") {
      setKey(timeline, drag.layerId, "scale", timeline.currentFrame, scaleFromDrag(drag.pivot, drag.start, point, drag.current.scale), "linear");
    } else {
      const rotation = rotationFromDrag(drag.pivot, drag.start, point, drag.current.rotation, { direction: drag.direction, snap: Boolean(event?.shiftKey) });
      setKey(timeline, drag.layerId, "rotation", timeline.currentFrame, rotation, "linear");
    }
    this.panel.syncInspector?.();
    this.uc.requestRender();
  }

  /** Pointerup: the whole gesture is one timeline history entry. */
  end() {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    this.panel.commit(drag.before, `${drag.kind === "scale" ? "Scale" : "Rotation"} key at frame ${this.panel.data?.currentFrame ?? 0}`);
  }

  cursor(point) {
    if (this.drag) return this.drag.kind === "rotate" ? "grabbing" : "nwse-resize";
    const found = this.hit(point);
    if (!found) return null;
    return found.hit.kind === "rotate" ? "grab" : "nwse-resize";
  }

  /** The overlay, drawn in world space after the layers. */
  draw(ctx) {
    const layer = this.target();
    if (!layer) return;
    const { quad, top, knob, pivot } = this.geometry(layer);
    const unit = 1 / (this.uc.view?.scale || 1);
    ctx.save();
    ctx.lineWidth = 1.5 * unit;
    ctx.strokeStyle = HANDLE_COLOR;
    ctx.setLineDash([6 * unit, 4 * unit]);
    ctx.beginPath();
    QUAD_KEYS.forEach((key, index) => (index ? ctx.lineTo(quad[key].x, quad[key].y) : ctx.moveTo(quad[key].x, quad[key].y)));
    ctx.closePath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(knob.x, knob.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#fff";
    const half = 4.5 * unit;
    for (const key of QUAD_KEYS) {
      ctx.fillRect(quad[key].x - half, quad[key].y - half, half * 2, half * 2);
      ctx.strokeRect(quad[key].x - half, quad[key].y - half, half * 2, half * 2);
    }
    ctx.beginPath();
    ctx.arc(knob.x, knob.y, 5.5 * unit, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, 3 * unit, 0, Math.PI * 2);
    ctx.fillStyle = HANDLE_COLOR;
    ctx.fill();
    ctx.restore();
  }
}
