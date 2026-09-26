/**
 * VNCCS UniCanvas scene-state placement of one layer (issue #7, depth scale #11).
 *
 * `layer.stateOffset = { x, y, scale?, ax?, ay? }` places the layer's stored pixels at render
 * time: a uniform `scale` around the rest-space anchor (ax, ay) - the character's feet - then a
 * move by (x, y). Without `scale` it is the plain integer offset states always had, so older
 * states load unchanged. A per-state depth-scaled move (vnccs_unicanvas_scene_place.mjs) writes
 * the scale; nothing ever resamples the pixels for it.
 *
 * Pure helpers shared by the widget, the states module, the timeline, the pose ControlNet scene
 * and harmonize; nodes/unicanvas/render.py applies the same placement on the server.
 */

const finite = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : null);

/** An integer world-pixel offset plus an optional scale around its anchor; malformed parts drop. */
export function normalizeStateOffset(value) {
  const x = finite(value?.x);
  const y = finite(value?.y);
  const out = { x: x === null ? 0 : Math.round(x), y: y === null ? 0 : Math.round(y) };
  const scale = finite(value?.scale);
  const ax = finite(value?.ax), ay = finite(value?.ay);
  if (scale !== null && scale > 0 && Math.abs(scale - 1) > 1e-6 && ax !== null && ay !== null) {
    out.scale = Math.min(64, Math.max(1 / 64, scale));
    out.ax = ax;
    out.ay = ay;
  }
  return out;
}

export const isZeroStateOffset = (offset) => !offset || (!offset.x && !offset.y && !(offset.scale && offset.scale !== 1));

export const sameStateOffset = (a, b) => {
  const left = normalizeStateOffset(a), right = normalizeStateOffset(b);
  return left.x === right.x && left.y === right.y && (left.scale ?? 1) === (right.scale ?? 1)
    && (left.ax ?? 0) === (right.ax ?? 0) && (left.ay ?? 0) === (right.ay ?? 0);
};

/** The placement as a 2D affine matrix [a, b, c, d, e, f] (a translation without a scale). */
export function stateOffsetMatrix(offset) {
  const x = offset?.x || 0, y = offset?.y || 0;
  const scale = offset?.scale;
  if (!(scale > 0) || scale === 1) return [1, 0, 0, 1, x, y];
  const ax = offset.ax || 0, ay = offset.ay || 0;
  return [scale, 0, 0, scale, x + ax * (1 - scale), y + ay * (1 - scale)];
}

export function stateOffsetPoint(offset, point) {
  const m = stateOffsetMatrix(offset);
  return { x: m[0] * point.x + m[4], y: m[3] * point.y + m[5] };
}

export function stateOffsetRect(offset, rect) {
  const topLeft = stateOffsetPoint(offset, rect);
  const scale = offset?.scale > 0 ? offset.scale : 1;
  return { x: topLeft.x, y: topLeft.y, width: rect.width * scale, height: rect.height * scale };
}

/** The rest-space rect a shown world rect comes from (the inverse placement). */
export function stateOffsetRestRect(offset, rect) {
  const m = stateOffsetMatrix(offset);
  return { x: (rect.x - m[4]) / m[0], y: (rect.y - m[5]) / m[3], width: rect.width / m[0], height: rect.height / m[3] };
}

/**
 * The placement that shows the rest-space feet `restFeet` at `feet` with `scale`: anchored on
 * the feet, so the next depth-scaled move only changes the move and the scale.
 */
export function feetPlacement(restFeet, feet, scale) {
  return normalizeStateOffset({ x: feet.x - restFeet.x, y: feet.y - restFeet.y, scale, ax: restFeet.x, ay: restFeet.y });
}
