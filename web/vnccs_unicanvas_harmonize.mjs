/**
 * VNCCS UniCanvas - shadow layers (Plan 08.2, #19).
 *
 * - A shadow layer is a raster layer with `shadow = { sourceLayerId, kind, params }`, filed right
 *   under its source inside the same group, with `meta.origin = "shadow"` and a multiply blend.
 * - Its pixels are derived: before every frame (`uc.render`, called from the widget's rAF) each
 *   shadow compares a key of its source's pixel revision, the source's live move preview (plain
 *   and depth-scaled drags), the scene-state offsets of the source and of the shadow
 *   (vnccs_unicanvas_states.mjs), its params, the scene light and the horizon, and redraws on a 2D
 *   canvas when the key changed. A shadow therefore follows its character during a drag, before
 *   the pointer is released, and never needs its own move preview.
 * - Contact (`kind: "contact"`): a soft ellipse under the feet anchor, 60% of the character's alpha
 *   box width (never narrower than the feet rows); height, softness and opacity are params.
 * - Cast (`kind: "cast"`): the silhouette flattened onto the ground along the light: an affine
 *   shear / squash around the feet anchor (azimuth sets the direction, elevation the length),
 *   three copies blurred more with distance from the feet, faded with length. Without a
 *   perspective model the ground is the horizontal line through the feet; with a horizon the
 *   vertical squash follows the camera height (`castShadowSquash`).
 * - Both are tinted by the scene ambient (`shadowTint`); the cast shadow is weaker when the
 *   ambient light is strong compared with the key light.
 * - Commands: Add contact shadow / Add cast shadow (a `shadowLayer` history entry that re-files the
 *   layer under its source on redo), Detach shadow (a `layerProps` entry; the pixels stay as a
 *   plain raster layer). The param sliders update live and commit one `layerProps` entry per
 *   gesture; `layer.shadow` is always replaced, never mutated, so history entries stay intact.
 * Harmonize (Plan 08.3, #20), "Harmonize..." on a character layer:
 * - 1. Color: the color_match route against the area around the character (its box dilated by
 *   25% per side, the character cut out), blended live with the strength slider.
 * - 2. Relight: the layer's normal pass (pose layers; UniCanvasPoseEditor.captureNormalPass next
 *   to the ID pass) shaded with the scene light, ambient + key × max(0, N·L), as a multiply /
 *   screen mix at `strength`, in a WebGL fragment pass (2D loop fallback: half resolution while
 *   a slider or the sun is dragged, full resolution on release). Stages 1 and 2 preview over the
 *   untouched pixels; Apply is one layerPixels entry, Cancel restores.
 * - 3. AI harmonize: an inpaint run of the selected edit model over the character box plus 15%
 *   (mask: the alpha dilated 12 px with an 8 px soft band, instruction from the settings).
 *   Results are staged; Accept replaces the character's pixels as one entry. A result whose
 *   alpha box drifts more than 5% is rejected.
 * - Create foreground occluder: the background pixels in the character's box nearer than its
 *   feet (Plan 08's cached depth map, optional SAM refinement) as a raster layer right above it
 *   (`meta.origin = "occluder"`, an `occluderLayer` history entry).
 * The scene light and its gizmo live in vnccs_unicanvas_scene_place.mjs. The widget only calls
 * `installUniCanvasHarmonize` and the serialize / history hooks exported here.
 */

import { isMaskSectionLayer } from "./vnccs_unicanvas_control.mjs";
import { buildStagingSnapshot, createLayerMeta } from "./vnccs_unicanvas_provenance.mjs";
import {
  SCENE_LIGHT_HISTORY_KIND,
  backgroundDepth,
  backgroundLayer,
  measureLayerCharacter,
  normalizeSceneLight,
  renderSceneLightControls,
  shadowGroundDirection,
  shadowLengthFactor,
} from "./vnccs_unicanvas_scene_place.mjs";
import { isLayerEffectivelyVisible } from "./vnccs_unicanvas_groups.mjs";
import { normalizeStateOffset, stateOffsetPoint, stateOffsetRect, stateOffsetRestRect } from "./vnccs_unicanvas_state_offset.mjs";
import { currentNormalPass, isImageLayer } from "./vnccs_unicanvas_pose_state.mjs";
import { installCustomSelects } from "./vnccs_custom_select.mjs";
// Import cycle with the layer tools (they list this module's menu entries): only functions and
// constants read at call time cross it.
import { COLOR_MATCH_METHODS, COLOR_MATCH_ROUTE, COLOR_MATCH_STRENGTH_MAX, placeInHost } from "./vnccs_unicanvas_layer_tools.mjs";

export const SHADOW_KINDS = Object.freeze(["contact", "cast"]);
export const SHADOW_LAYER_HISTORY_KIND = "shadowLayer";
const SILHOUETTE_MAX_SIDE = 768;
const DEFAULT_CAST_SQUASH = 0.45;
const MIN_CAST_SQUASH = 0.06;
const PANORAMA_MESSAGE = "Shadows are not available in panorama mode.";

export const SHADOW_PARAM_SPECS = Object.freeze({
  contact: Object.freeze([
    { key: "height", label: "Height", min: 0.05, max: 1, step: 0.01, value: 0.25 },
    { key: "softness", label: "Softness", min: 0, max: 1, step: 0.01, value: 0.6 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01, value: 0.75 },
  ]),
  cast: Object.freeze([
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01, value: 0.8 },
    { key: "blur", label: "Blur", min: 0, max: 1, step: 0.01, value: 0.5 },
    { key: "fade", label: "Fade", min: 0, max: 1, step: 0.01, value: 0.7 },
  ]),
});

function finite(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function defaultShadowParams(kind) {
  return Object.fromEntries((SHADOW_PARAM_SPECS[kind] || []).map((spec) => [spec.key, spec.value]));
}

/** Normalizes a saved / history value; anything without a source or a known kind is no shadow. */
export function normalizeShadow(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.sourceLayerId !== "string" || !raw.sourceLayerId || !SHADOW_KINDS.includes(raw.kind)) return null;
  const params = defaultShadowParams(raw.kind);
  for (const spec of SHADOW_PARAM_SPECS[raw.kind]) {
    const value = finite(raw.params?.[spec.key]);
    if (value !== null) params[spec.key] = Math.min(spec.max, Math.max(spec.min, value));
  }
  return { sourceLayerId: raw.sourceLayerId, kind: raw.kind, params };
}

export function serializeShadow(value) {
  return normalizeShadow(value);
}

/** Layers that can cast a shadow: raster and pose layers that are not shadows themselves. */
export function canCastShadow(layer) {
  return Boolean(layer && (layer.type === "raster" || layer.type === "pose") && !layer.shadow);
}

/**
 * Alpha extent of RGBA pixels: the tight box and the horizontal span of the feet rows (the bottom
 * `feetBand` of the box). Null when fully transparent.
 */
export function alphaExtent(data, width, height, threshold = 8, feetBand = 0.04) {
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] <= threshold) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return null;
  const band = Math.max(1, Math.round((bottom - top + 1) * feetBand));
  let feetLeft = width, feetRight = -1;
  for (let y = bottom - band + 1; y <= bottom; y += 1) {
    const row = y * width * 4;
    for (let x = left; x <= right; x += 1) {
      if (data[row + x * 4 + 3] <= threshold) continue;
      if (x < feetLeft) feetLeft = x;
      if (x > feetRight) feetRight = x;
    }
  }
  return { left, right, top, bottom, feetLeft, feetRight };
}

/** A world point under a move preview `{ dx, dy, scale, anchor }` (the widget's render transform). */
export function previewPoint(preview, point) {
  if (!preview) return { x: point.x, y: point.y };
  const scale = preview.scale || 1;
  const anchor = preview.anchor || { x: 0, y: 0 };
  return {
    x: anchor.x + (point.x - anchor.x) * scale + (preview.dx || 0),
    y: anchor.y + (point.y - anchor.y) * scale + (preview.dy || 0),
  };
}

/** The contact ellipse for a character with alpha box width `boxWidth` and feet span `feetWidth`. */
export function contactShadowGeometry(feet, boxWidth, feetWidth, params) {
  const p = normalizeShadow({ sourceLayerId: "x", kind: "contact", params }).params;
  const rx = Math.max(1, Math.max(boxWidth * 0.6, feetWidth) / 2);
  const ry = Math.max(1, rx * p.height);
  return { cx: feet.x, cy: feet.y - ry * 0.2, rx, ry, softness: p.softness, opacity: p.opacity };
}

/**
 * Vertical squash of the flattened silhouette: how much of a ground distance shows vertically.
 * With a horizon it grows with the camera height (the feet far below the horizon relative to the
 * character's height read as a camera looking down).
 */
export function castShadowSquash(perspective, feetY, characterHeight) {
  const horizon = finite(perspective?.horizonY);
  if (horizon === null || !(characterHeight > 0) || feetY <= horizon) return DEFAULT_CAST_SQUASH;
  return Math.min(0.9, Math.max(0.12, DEFAULT_CAST_SQUASH * (feetY - horizon) / characterHeight));
}

/**
 * The shear / squash that flattens the silhouette onto the ground, in coordinates relative to the
 * feet anchor: x' = x + c * y, y' = d * y (y is negative above the feet).
 */
export function castShadowMatrix(light, squash = DEFAULT_CAST_SQUASH) {
  const direction = shadowGroundDirection(light);
  const length = shadowLengthFactor(light);
  const c = -direction.x * length;
  let d = direction.z * length * squash;
  // A shadow that falls sideways still has the thickness of the character's depth.
  if (Math.abs(d) < MIN_CAST_SQUASH) d = direction.z < 0 ? -MIN_CAST_SQUASH : MIN_CAST_SQUASH;
  return { c, d };
}

function hexToRgb(hex) {
  const value = parseInt(String(hex).slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Shadow color: the ambient color, darkened (shadows are lit by the ambient only). */
export function shadowTint(light) {
  const { ambientColor, ambientIntensity } = normalizeSceneLight(light);
  const level = 0.35 * Math.min(1, ambientIntensity);
  return hexToRgb(ambientColor).map((channel) => Math.round(channel * level));
}

/** How dark the cast shadow is: the key light's share of the total light. */
export function castShadowStrength(light) {
  const { intensity, ambientIntensity } = normalizeSceneLight(light);
  return intensity <= 0 ? 0 : intensity / (intensity + ambientIntensity * 0.6);
}

// ---------------------------------------------------------------------------
// Runtime: silhouettes and per-frame regeneration.
// ---------------------------------------------------------------------------

/** A layer's live scene-state offset (vnccs_unicanvas_states.mjs); render time only. */
function stateOffsetOf(uc, layer) {
  const offset = typeof uc.getLayerStateOffset === "function" ? uc.getLayerStateOffset(layer) : null;
  return normalizeStateOffset(offset);
}

/** A cache key part for a state placement (move and depth scale). */
const offsetKey = (offset) => [offset.x, offset.y, offset.scale ?? 1, offset.ax ?? 0, offset.ay ?? 0].join(":");

function sourceLayerOf(uc, layer) {
  const id = layer?.shadow?.sourceLayerId;
  if (!id) return null;
  const source = uc.layers.find((item) => item.id === id);
  return source && source !== layer && !source.shadow ? source : null;
}

/** The source's open Free Transform draft (the widget's live preview), if any. */
function transformDraftOf(uc, source) {
  return typeof uc.getLayerTransformDraft === "function" ? uc.getLayerTransformDraft(source) : null;
}

/**
 * What the source's silhouette depends on: its pixels and scene-state offset (move and depth
 * scale), or, while a Free Transform is open on it, the draft's frame (so the shadow follows the
 * live preview, #19).
 */
export function shadowSilhouetteKey(uc, source) {
  const draft = transformDraftOf(uc, source);
  if (draft?.quad) return JSON.stringify([source.id, "transform", draft.quad, draft.mesh || null, draft.sourceBounds || null]);
  const offset = stateOffsetOf(uc, source);
  return `${source.id}:${source.pixelRevision ?? 0}:${offsetKey(offset)}`;
}

/**
 * The source's black silhouette on a small canvas, its alpha rect, feet and feet width, in world
 * pixels where the source shows (its scene-state offset included). An open Free Transform draft
 * is drawn through its frame instead of the committed pixels.
 */
function buildSilhouette(uc, source) {
  const draft = transformDraftOf(uc, source);
  const bounds = draft?.quad ? draft.bounds : uc.getLayerWorldBounds(source);
  if (!bounds || bounds.width < 1 || bounds.height < 1) return null;
  const scale = Math.min(1, SILHOUETTE_MAX_SIDE / Math.max(bounds.width, bounds.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bounds.width * scale));
  canvas.height = Math.max(1, Math.round(bounds.height * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (draft?.quad) {
    // The cheap preview mesh is enough for a silhouette; Apply redraws from the committed pixels.
    ctx.setTransform(canvas.width / bounds.width, 0, 0, canvas.height / bounds.height, -bounds.x * canvas.width / bounds.width, -bounds.y * canvas.height / bounds.height);
    uc.drawTransformDraft(ctx, draft, 8);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    uc.drawRasterLayerToWorldRect(ctx, source, bounds, { x: 0, y: 0, width: canvas.width, height: canvas.height }, true, false);
  }
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const extent = alphaExtent(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  if (!extent) return null;
  const sx = bounds.width / canvas.width, sy = bounds.height / canvas.height;
  const rect = {
    x: bounds.x + extent.left * sx,
    y: bounds.y + extent.top * sy,
    width: (extent.right - extent.left + 1) * sx,
    height: (extent.bottom - extent.top + 1) * sy,
  };
  return {
    canvas,
    canvasRect: { ...bounds },
    rect,
    feet: { x: rect.x + rect.width / 2, y: rect.y + rect.height },
    feetWidth: (extent.feetRight - extent.feetLeft + 1) * sx,
  };
}

function sourceSilhouette(uc, source) {
  const key = shadowSilhouetteKey(uc, source);
  if (source._shadowSilhouette?.key !== key) source._shadowSilhouette = { key, value: buildSilhouette(uc, source) };
  return source._shadowSilhouette.value;
}

/** The silhouette placed by the source's live move preview. */
function placedSilhouette(silhouette, preview) {
  const scale = preview?.scale || 1;
  const topLeft = previewPoint(preview, silhouette.canvasRect);
  const rectTopLeft = previewPoint(preview, silhouette.rect);
  return {
    canvas: silhouette.canvas,
    canvasRect: { x: topLeft.x, y: topLeft.y, width: silhouette.canvasRect.width * scale, height: silhouette.canvasRect.height * scale },
    rect: { x: rectTopLeft.x, y: rectTopLeft.y, width: silhouette.rect.width * scale, height: silhouette.rect.height * scale },
    feet: previewPoint(preview, silhouette.feet),
    feetWidth: silhouette.feetWidth * scale,
  };
}

function scratch(uc, name, width, height) {
  const state = uc._harmonize;
  if (!state[name]) state[name] = document.createElement("canvas");
  const canvas = state[name];
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.clearRect(0, 0, width, height);
  return { canvas, ctx };
}

function drawContactShadow(uc, ctx, base, placed, params) {
  const geometry = contactShadowGeometry(placed.feet, placed.rect.width, placed.feetWidth, params);
  const [r, g, b] = shadowTint(uc.sceneLight);
  ctx.save();
  ctx.translate(geometry.cx - base.x, geometry.cy - base.y);
  ctx.scale(1, geometry.ry / geometry.rx);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, geometry.rx);
  // Softness moves the start of the falloff toward the center.
  const solid = Math.max(0, Math.min(0.98, 1 - geometry.softness));
  gradient.addColorStop(0, `rgba(${r},${g},${b},${geometry.opacity})`);
  gradient.addColorStop(solid, `rgba(${r},${g},${b},${geometry.opacity})`);
  gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, geometry.rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

const BLUR_LEVELS = [
  { blur: 0, stops: [[0, 1], [0.5, 0], [1, 0]] },
  { blur: 0.5, stops: [[0, 0], [0.5, 1], [1, 0]] },
  { blur: 1, stops: [[0, 0], [0.5, 0], [1, 1]] },
];

function drawCastShadow(uc, ctx, base, placed, params) {
  const light = uc.sceneLight;
  const squash = castShadowSquash(uc.scenePerspective, placed.feet.y, placed.rect.height);
  const { c, d } = castShadowMatrix(light, squash);
  const maxBlur = params.blur * placed.rect.height * 0.06;
  const pad = Math.ceil(maxBlur * 2 + 2);
  // Bounds of the flattened silhouette in layer canvas pixels.
  const fx = placed.feet.x - base.x, fy = placed.feet.y - base.y;
  const corners = [];
  for (const x of [placed.canvasRect.x, placed.canvasRect.x + placed.canvasRect.width]) {
    for (const y of [placed.canvasRect.y, placed.canvasRect.y + placed.canvasRect.height]) {
      const rx = x - placed.feet.x, ry = y - placed.feet.y;
      corners.push({ x: fx + rx + c * ry, y: fy + d * ry });
    }
  }
  const left = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.x)) - pad));
  const top = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.y)) - pad));
  const right = Math.min(ctx.canvas.width, Math.ceil(Math.max(...corners.map((p) => p.x)) + pad));
  const bottom = Math.min(ctx.canvas.height, Math.ceil(Math.max(...corners.map((p) => p.y)) + pad));
  if (right <= left || bottom <= top) return;
  const width = right - left, height = bottom - top;
  // Tip of the shadow (where the head lands), for the distance gradients.
  let vx = c * -placed.rect.height, vy = d * -placed.rect.height;
  if (Math.hypot(vx, vy) < 1) { vx = 0; vy = -1; }
  const ox = fx - left, oy = fy - top;
  const gradientOf = (target, stops) => {
    const gradient = target.createLinearGradient(ox, oy, ox + vx, oy + vy);
    for (const [at, alpha] of stops) gradient.addColorStop(at, `rgba(0,0,0,${alpha})`);
    return gradient;
  };
  const accum = scratch(uc, "castAccum", width, height);
  const hasFilter = "filter" in accum.ctx;
  for (const level of BLUR_LEVELS) {
    const layer = scratch(uc, "castLevel", width, height);
    const blur = maxBlur * level.blur;
    if (hasFilter && blur >= 0.5) layer.ctx.filter = `blur(${blur.toFixed(2)}px)`;
    layer.ctx.setTransform(1, 0, c, d, ox, oy);
    layer.ctx.drawImage(placed.canvas, placed.canvasRect.x - placed.feet.x, placed.canvasRect.y - placed.feet.y, placed.canvasRect.width, placed.canvasRect.height);
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.filter = "none";
    layer.ctx.globalCompositeOperation = "destination-in";
    layer.ctx.fillStyle = gradientOf(layer.ctx, level.stops);
    layer.ctx.fillRect(0, 0, width, height);
    accum.ctx.globalCompositeOperation = "lighter";
    accum.ctx.drawImage(layer.canvas, 0, 0);
  }
  accum.ctx.globalCompositeOperation = "destination-in";
  accum.ctx.fillStyle = gradientOf(accum.ctx, [[0, 1], [1, 1 - params.fade]]);
  accum.ctx.fillRect(0, 0, width, height);
  const [r, g, b] = shadowTint(light);
  accum.ctx.globalCompositeOperation = "source-in";
  accum.ctx.fillStyle = `rgb(${r},${g},${b})`;
  accum.ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, params.opacity * castShadowStrength(light)));
  ctx.drawImage(accum.canvas, left, top);
  ctx.restore();
}

/** Redraws one shadow layer from its source (placed by the source's live move preview). */
export function renderShadowLayer(uc, layer, source = sourceLayerOf(uc, layer)) {
  const shadow = normalizeShadow(layer?.shadow);
  if (!shadow || !source) return false;
  const ctx = layer.canvas.getContext("2d");
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  ctx.restore();
  delete layer.hiresCanvas;
  delete layer.hiresRect;
  const silhouette = sourceSilhouette(uc, source);
  if (silhouette) {
    // A transform draft already places the silhouette; a move preview never runs at the same time.
    const preview = transformDraftOf(uc, source) ? null : uc.getLayerMovePreview(source);
    const placed = placedSilhouette(silhouette, preview);
    // Canvas pixel = world - origin - the shadow's own state offset, so it lands where it shows.
    const own = stateOffsetOf(uc, layer);
    const base = { x: uc.origin.x + own.x, y: uc.origin.y + own.y };
    if (shadow.kind === "contact") drawContactShadow(uc, ctx, base, placed, shadow.params);
    else drawCastShadow(uc, ctx, base, placed, shadow.params);
  }
  uc.invalidateLayerRenderCaches(layer);
  layer._boundsCache = undefined;
  return true;
}

function shadowKey(uc, layer, source) {
  const preview = uc.getLayerMovePreview(source);
  const ownOffset = stateOffsetOf(uc, layer);
  return JSON.stringify([
    shadowSilhouetteKey(uc, source), offsetKey(ownOffset),
    preview ? [preview.dx || 0, preview.dy || 0, preview.scale || 1, preview.anchor?.x ?? 0, preview.anchor?.y ?? 0] : null,
    normalizeShadow(layer.shadow), normalizeSceneLight(uc.sceneLight), uc.scenePerspective?.horizonY ?? null,
    uc.origin.x, uc.origin.y, layer.canvas.width, layer.canvas.height,
  ]);
}

/** Regenerates every shadow layer whose inputs changed. Returns how many were redrawn. */
export function updateShadowLayers(uc) {
  if (!uc || uc.panorama || !Array.isArray(uc.layers)) return 0;
  let count = 0;
  for (const layer of uc.layers) {
    if (!layer.shadow || layer.type !== "raster" || !layer.canvas) continue;
    const source = sourceLayerOf(uc, layer);
    if (!source) continue; // an orphaned shadow keeps its last pixels
    const key = shadowKey(uc, layer, source);
    // Pixels edited by hand (paint, a move of the shadow itself) are derived again too.
    if (layer._shadowKey === key && layer._shadowRevision === layer.pixelRevision) continue;
    layer._shadowKey = key;
    if (renderShadowLayer(uc, layer, source)) count += 1;
    layer._shadowRevision = layer.pixelRevision;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Commands and history.
// ---------------------------------------------------------------------------

/** Files `layer` right under `source` (the next stack index) inside the source's group. */
function fileUnderSource(uc, layer, source) {
  uc.layers = uc.layers.filter((item) => item !== layer && item.id !== layer.id);
  layer.groupId = source.groupId || null;
  const index = uc.layers.indexOf(source);
  uc.layers.splice(index < 0 ? uc.getLayerInsertIndex(layer.type) : index + 1, 0, layer);
  uc.normalizeLayerOrder();
}

function refreshAfterShadowChange(uc) {
  uc.renderLayerList();
  uc.syncActiveLayerControls();
  uc.requestRender();
  uc.syncLightStateToWidget();
  uc.scheduleFullSync();
}

export function addShadowLayer(uc, source, kind) {
  if (uc.panorama) {
    uc.setStatus(PANORAMA_MESSAGE, true);
    return null;
  }
  if (!SHADOW_KINDS.includes(kind) || !canCastShadow(source)) {
    uc.setStatus("Shadows: pick a raster or pose layer that is not a shadow.", true);
    return null;
  }
  const previousActiveLayerId = uc.activeLayerId;
  const label = kind === "cast" ? "Cast shadow" : "Contact shadow";
  const layer = uc.addLayer("raster", `${source.name} ${label.toLowerCase()}`, false, true, createLayerMeta("shadow", { derivedFrom: source.id }));
  layer.blendMode = "multiply";
  layer.shadow = { sourceLayerId: source.id, kind, params: defaultShadowParams(kind) };
  fileUnderSource(uc, layer, source);
  uc.activeLayerId = layer.id;
  if (Array.isArray(uc.selectedLayerIds)) uc.selectedLayerIds = [layer.id];
  uc.pushHistoryEntry({ kind: SHADOW_LAYER_HISTORY_KIND, layer, previousActiveLayerId });
  updateShadowLayers(uc);
  refreshAfterShadowChange(uc);
  uc.setStatus(`${label} added under ${source.name}.`);
  return layer;
}

/** Turns a shadow layer into a plain raster layer that keeps its current pixels. */
export function detachShadowLayer(uc, layer) {
  if (!layer?.shadow) return false;
  const before = { shadow: clone(normalizeShadow(layer.shadow)) };
  layer.shadow = null;
  layer._shadowKey = null;
  uc.pushHistoryEntry({ kind: "layerProps", layerId: layer.id, before, after: { shadow: null } });
  refreshAfterShadowChange(uc);
  uc.setStatus(`${layer.name} is now a plain raster layer.`);
  return true;
}

/** History hook for `shadowLayer` entries: undo removes the shadow, redo files it under its source again. */
export function applyShadowLayerHistory(uc, entry, direction) {
  const layer = entry.layer;
  if (!layer) return;
  if (direction === "undo") {
    uc.layers = uc.layers.filter((item) => item.id !== layer.id);
    const previous = uc.layers.some((item) => item.id === entry.previousActiveLayerId) ? entry.previousActiveLayerId : null;
    uc.activeLayerId = previous || uc.layers.find((item) => !isMaskSectionLayer(item))?.id || uc.layers[0]?.id || null;
  } else {
    if (!uc.layers.some((item) => item.id === layer.id)) {
      const source = sourceLayerOf(uc, layer);
      if (source) fileUnderSource(uc, layer, source);
      else uc.insertLayerByType(layer);
    }
    uc.activeLayerId = layer.id;
  }
  if (Array.isArray(uc.selectedLayerIds)) uc.selectedLayerIds = uc.activeLayerId ? [uc.activeLayerId] : [];
  layer._shadowKey = null;
  uc.invalidateLayerCaches(layer);
}

// ---------------------------------------------------------------------------
// Shadow controls (move tool on a shadow layer).
// ---------------------------------------------------------------------------

function shadowControlsVisible(uc) {
  return !uc.panorama && uc.tool === "move" && Boolean(uc.activeLayer?.shadow);
}

function renderShadowPanel(uc) {
  const layer = uc.activeLayer;
  const shadow = normalizeShadow(layer.shadow);
  if (!shadow) return;
  const source = sourceLayerOf(uc, layer);
  const escape = (text) => uc._escape ? uc._escape(text) : String(text);
  const html = [
    `<div class="vnccs-uc-tool-settings-title">${shadow.kind === "cast" ? "Cast" : "Contact"} Shadow Settings</div>`,
    `<div class="vnccs-uc-transform-hint">${source ? `Follows ${escape(source.name)}` : "The source layer is gone: this shadow keeps its last pixels"}</div>`,
  ];
  for (const spec of SHADOW_PARAM_SPECS[shadow.kind]) {
    const value = shadow.params[spec.key];
    html.push(`<label class="vnccs-uc-tool-setting"><span class="vnccs-uc-tool-setting-label">${spec.label}</span><input class="vnccs-uc-range" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${value}" data-shadow-param="${spec.key}"><span class="vnccs-uc-tool-setting-value" data-shadow-value="${spec.key}">${Math.round(value * 100)}%</span></label>`);
  }
  html.push(`<div class="vnccs-uc-transform-actions"><button class="vnccs-uc-btn" type="button" data-shadow-action="detach" title="Keep the pixels as a plain raster layer">Detach shadow</button></div>`);
  html.push(renderSceneLightControls(uc));
  uc.toolSettings.innerHTML = html.join("");
  uc.toolSettings.classList.add("visible");
}

function installShadowControls(uc) {
  const state = uc._harmonize;
  uc.toolSettings.addEventListener("input", (e) => {
    const key = e.target?.dataset?.shadowParam;
    const layer = uc.activeLayer;
    if (!key || !layer?.shadow) return;
    e.stopPropagation();
    const shadow = normalizeShadow(layer.shadow);
    if (!state.paramGesture || state.paramGesture.layerId !== layer.id) state.paramGesture = { layerId: layer.id, before: clone(shadow) };
    const next = normalizeShadow({ ...shadow, params: { ...shadow.params, [key]: Number(e.target.value) } });
    // Replaced, never mutated: history entries may hold the previous object.
    layer.shadow = next;
    const readout = uc.toolSettings.querySelector(`[data-shadow-value="${key}"]`);
    if (readout) readout.textContent = `${Math.round(next.params[key] * 100)}%`;
    uc.requestRender();
  });
  uc.toolSettings.addEventListener("change", (e) => {
    if (!e.target?.dataset?.shadowParam || !state.paramGesture) return;
    const { layerId, before } = state.paramGesture;
    state.paramGesture = null;
    const layer = uc.layers.find((item) => item.id === layerId);
    if (!layer?.shadow) return;
    const after = clone(normalizeShadow(layer.shadow));
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    uc.pushHistoryEntry({ kind: "layerProps", layerId, before: { shadow: before }, after: { shadow: after } });
    uc.syncLightStateToWidget();
    uc.scheduleFullSync();
  });
  uc.toolSettings.addEventListener("click", (e) => {
    const button = e.target?.closest?.("[data-shadow-action]");
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    if (button.dataset.shadowAction === "detach") detachShadowLayer(uc, uc.activeLayer);
  });
}


// ---------------------------------------------------------------------------
// Harmonize panel (Plan 08.3): color, relight, AI harmonize and the foreground occluder.
// ---------------------------------------------------------------------------

export const OCCLUDER_LAYER_HISTORY_KIND = "occluderLayer";
export const HARMONIZE_PROMPT_SETTING = "harmonize_prompt";
export const HARMONIZE_DEFAULT_PROMPT = "Relight the character to match the scene lighting and colors, blend the edges naturally, keep the identity, pose, outfit and silhouette unchanged.";
// Each side of the character's alpha box grows by this share of its size.
export const HARMONIZE_REFERENCE_DILATE = 0.25;
export const AI_HARMONIZE_PAD = 0.15;
export const AI_MASK_DILATE = 12;
export const AI_MASK_BAND = 8;
export const AI_BBOX_TOLERANCE = 0.05;
export const OCCLUDER_DEFAULT_MARGIN = 0.03;
export const RELIGHT_DEFAULT_STRENGTH = 0.6;
const DRAW_ROUTE = "/vnccs/unicanvas/draw";
const SEGMENT_ROUTE = "/vnccs/unicanvas/segment";
const AI_LONG_SIDE = 1024;

/** The instruction an AI harmonize run sends (UniCanvas settings, "Harmonize" section). */
export function resolveHarmonizePrompt(settings) {
  const value = settings?.[HARMONIZE_PROMPT_SETTING];
  return typeof value === "string" && value.trim() ? value.trim() : HARMONIZE_DEFAULT_PROMPT;
}

/** `rect` with each side moved out by `fraction` of the rect's width / height, in whole pixels. */
export function dilateRect(rect, fraction) {
  const dx = rect.width * fraction, dy = rect.height * fraction;
  const x = Math.floor(rect.x - dx), y = Math.floor(rect.y - dy);
  return { x, y, width: Math.ceil(rect.x + rect.width + dx) - x, height: Math.ceil(rect.y + rect.height + dy) - y };
}

/**
 * Direction toward the scene light in camera space (x right, y up, z toward the viewer), the space
 * of the normal pass. Azimuth 0 is a light in front of the character (toward the camera), 90 on
 * its right, as in the light gizmo (vnccs_unicanvas_scene_place.mjs).
 */
export function lightDirection(light) {
  const { azimuth, elevation } = normalizeSceneLight(light);
  const a = azimuth * Math.PI / 180, e = elevation * Math.PI / 180;
  return { x: Math.sin(a) * Math.cos(e), y: Math.sin(e), z: Math.cos(a) * Math.cos(e) };
}

/** Per-channel ambient and key light terms: shading = ambient + key × max(0, N·L). */
export function relightTerms(light) {
  const l = normalizeSceneLight(light);
  const ambient = hexToRgb(l.ambientColor).map((channel) => channel / 255 * l.ambientIntensity);
  const key = hexToRgb(l.color).map((channel) => channel / 255 * l.intensity);
  return { ambient, key, direction: lightDirection(l) };
}

/** Multiply below 1, screen above 1: the shading of one channel value in 0..1. */
export function shadeChannel(value, factor) {
  return factor <= 1 ? value * factor : value + (1 - value) * Math.min(1, factor - 1);
}

/**
 * Relights RGBA pixels with a normal pass of the same size (packed n * 0.5 + 0.5; its alpha weighs
 * the effect, so pixels without a normal stay as they are). `strength` 0..1 mixes the shaded
 * color over the original; alpha never changes. The WebGL pass computes the same formula.
 */
export function relightPixels(src, normals, width, height, light, strength = RELIGHT_DEFAULT_STRENGTH, out = null) {
  const result = out || new Uint8ClampedArray(src.length);
  const { ambient, key, direction } = relightTerms(light);
  const mix = Math.max(0, Math.min(1, Number(strength) || 0));
  for (let offset = 0; offset < width * height * 4; offset += 4) {
    const weight = mix * normals[offset + 3] / 255;
    result[offset + 3] = src[offset + 3];
    if (weight <= 0 || src[offset + 3] === 0) {
      result[offset] = src[offset]; result[offset + 1] = src[offset + 1]; result[offset + 2] = src[offset + 2];
      continue;
    }
    let nx = normals[offset] / 127.5 - 1, ny = normals[offset + 1] / 127.5 - 1, nz = normals[offset + 2] / 127.5 - 1;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length; ny /= length; nz /= length;
    const lambert = Math.max(0, nx * direction.x + ny * direction.y + nz * direction.z);
    for (let channel = 0; channel < 3; channel += 1) {
      const value = src[offset + channel] / 255;
      const shaded = shadeChannel(value, ambient[channel] + key[channel] * lambert);
      result[offset + channel] = Math.round((value + (shaded - value) * weight) * 255);
    }
  }
  return result;
}

/**
 * Soft mask of an alpha channel (0..255 per pixel): 255 up to `dilate` pixels outside the shape,
 * then a linear falloff over `band` pixels (chamfer distances, so a little rounder than exact).
 */
export function featherAlpha(alpha, width, height, dilate = AI_MASK_DILATE, band = AI_MASK_BAND, threshold = 127) {
  const distance = new Float32Array(width * height);
  for (let i = 0; i < distance.length; i += 1) distance[i] = alpha[i] > threshold ? 0 : Infinity;
  const diagonal = Math.SQRT2;
  const relax = (i, j, cost) => { if (distance[j] + cost < distance[i]) distance[i] = distance[j] + cost; };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (x > 0) relax(i, i - 1, 1);
      if (y > 0) {
        relax(i, i - width, 1);
        if (x > 0) relax(i, i - width - 1, diagonal);
        if (x < width - 1) relax(i, i - width + 1, diagonal);
      }
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      if (x < width - 1) relax(i, i + 1, 1);
      if (y < height - 1) {
        relax(i, i + width, 1);
        if (x < width - 1) relax(i, i + width + 1, diagonal);
        if (x > 0) relax(i, i + width - 1, diagonal);
      }
    }
  }
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0; i < out.length; i += 1) {
    const d = distance[i];
    out[i] = d <= dilate ? 255 : band > 0 && d < dilate + band ? Math.round(255 * (1 - (d - dilate) / band)) : 0;
  }
  return out;
}

/** Largest relative move of a box edge (left / right by width, top / bottom by height). */
export function alphaBoxDrift(original, candidate) {
  if (!original || !candidate) return Infinity;
  const width = Math.max(1, original.right - original.left + 1), height = Math.max(1, original.bottom - original.top + 1);
  return Math.max(
    Math.abs(candidate.left - original.left) / width, Math.abs(candidate.right - original.right) / width,
    Math.abs(candidate.top - original.top) / height, Math.abs(candidate.bottom - original.bottom) / height,
  );
}

/** True when an AI result keeps the silhouette: its alpha box drifts at most `tolerance`. */
export function harmonizeKeepsSilhouette(original, candidate, tolerance = AI_BBOX_TOLERANCE) {
  return alphaBoxDrift(original, candidate) <= tolerance + 1e-9;
}

/** Median of the depth values (0..1, near is high) in a square window around (x, y). */
export function medianDepthAt(values, width, height, x, y, radius = 2) {
  const samples = [];
  const cx = Math.round(x), cy = Math.round(y);
  for (let v = Math.max(0, cy - radius); v <= Math.min(height - 1, cy + radius); v += 1) {
    for (let u = Math.max(0, cx - radius); u <= Math.min(width - 1, cx + radius); u += 1) samples.push(values[v * width + u]);
  }
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

/** Occluder alpha: 255 where the background is nearer than the feet by more than `margin`. */
export function occluderAlpha(depths, feetDepth, margin = OCCLUDER_DEFAULT_MARGIN) {
  const out = new Uint8ClampedArray(depths.length);
  const limit = feetDepth + margin;
  for (let i = 0; i < depths.length; i += 1) if (depths[i] > limit) out[i] = 255;
  return out;
}

/** Character layers the Harmonize panel works on: raster or pose, not a shadow, occluder or the background. */
export function isHarmonizeCharacter(uc, layer) {
  if (!canCastShadow(layer) || layer.meta?.origin === "occluder") return false;
  if (!uc || !Array.isArray(uc.layers) || typeof uc.getLayerAlphaBounds !== "function") return true;
  return layer !== backgroundLayer(uc);
}

// ---------------------------------------------------------------------------
// Harmonize runtime.
// ---------------------------------------------------------------------------

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/** The character's alpha box and feet where it shows (its scene-state offset included), in world pixels. */
function characterPlacement(uc, layer) {
  const measured = measureLayerCharacter(uc, layer);
  if (!measured) return null;
  const offset = stateOffsetOf(uc, layer);
  const r = stateOffsetRect(offset, measured.rect);
  const x = Math.floor(r.x), y = Math.floor(r.y);
  return {
    rect: { x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y },
    feet: stateOffsetPoint(offset, measured.feet),
  };
}

/** A layer's pixels (render semantics: hi-res source, state offset) over a world rect, at `size`. */
function layerPixelsIn(uc, layer, rect, size = rect) {
  const canvas = makeCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  uc.drawRasterLayerToWorldRect(ctx, layer, rect, { x: 0, y: 0, width: canvas.width, height: canvas.height }, true, false);
  return canvas;
}

/** Fills transparent holes with ever finer local averages, so a hole reads as its surroundings. */
function fillHoles(canvas) {
  const out = makeCanvas(canvas.width, canvas.height);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  const one = makeCanvas(1, 1);
  const oneCtx = one.getContext("2d", { willReadFrequently: true });
  oneCtx.drawImage(canvas, 0, 0, 1, 1);
  const [r, g, b, a] = oneCtx.getImageData(0, 0, 1, 1).data;
  ctx.fillStyle = a ? `rgb(${r},${g},${b})` : "#808080";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = true;
  for (const divisor of [64, 16, 4]) {
    const small = makeCanvas(Math.max(1, out.width / divisor), Math.max(1, out.height / divisor));
    const smallCtx = small.getContext("2d");
    smallCtx.imageSmoothingEnabled = true;
    smallCtx.imageSmoothingQuality = "high";
    smallCtx.drawImage(canvas, 0, 0, small.width, small.height);
    ctx.drawImage(small, 0, 0, out.width, out.height);
  }
  ctx.drawImage(canvas, 0, 0);
  return out;
}

/**
 * Color reference "area around the character": the composite of the other visible image layers
 * in the character's box dilated by 25% per side, with the character's own pixels cut out (the
 * hole is filled from its surroundings, since the color_match route reads the reference as RGB).
 */
export function buildSurroundReference(uc, layer) {
  const placement = characterPlacement(uc, layer);
  if (!placement) return null;
  const region = dilateRect(placement.rect, HARMONIZE_REFERENCE_DILATE);
  const canvas = makeCanvas(region.width, region.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const dest = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  let drawn = 0;
  for (const item of [...uc.layers].reverse()) {
    if (item === layer || item.shadow?.sourceLayerId === layer.id || !item.canvas || !isImageLayer(item)) continue;
    if (!isLayerEffectivelyVisible(uc.layers, item)) continue;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, Number(item.opacity ?? 1)));
    ctx.globalCompositeOperation = item.blendMode || "source-over";
    uc.drawRasterLayerToWorldRect(ctx, item, region, dest);
    ctx.restore();
    drawn += 1;
  }
  if (!drawn) return null;
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  uc.drawRasterLayerToWorldRect(ctx, layer, region, dest, true, false);
  ctx.restore();
  return fillHoles(canvas);
}

async function fetchColorMatch(target, reference, method) {
  const res = await fetch(COLOR_MATCH_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: target.toDataURL("image/png"), reference: reference.toDataURL("image/png"), method, strength: COLOR_MATCH_STRENGTH_MAX }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data.image;
}

/** Hi-res pixels go into the layer canvas before the canvas is edited (render semantics stay). */
function prepareLayerPixels(uc, layer) {
  if (layer.type === "raster") {
    uc.materializeRasterLayerForEditing(layer);
    return;
  }
  if (layer.hiresCanvas && layer.hiresRect) {
    const rect = uc.normalizeLayerWorldRect(layer.hiresRect);
    const ctx = uc.configureImageContext(layer.canvas.getContext("2d"), true);
    ctx.clearRect(rect.x - uc.origin.x, rect.y - uc.origin.y, rect.width, rect.height);
    ctx.drawImage(layer.hiresCanvas, rect.x - uc.origin.x, rect.y - uc.origin.y, rect.width, rect.height);
    layer.hiresCanvas = null;
    layer.hiresRect = null;
    uc.invalidateLayerRenderCaches(layer);
  }
}

// --- Relight: a WebGL fragment pass, with a 2D per-pixel fallback. ---

const RELIGHT_VERTEX = "attribute vec2 p; varying vec2 v; void main() { v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }";
const RELIGHT_FRAGMENT = `precision mediump float;
uniform sampler2D uSrc; uniform sampler2D uNrm; uniform vec3 uL; uniform vec3 uKey; uniform vec3 uAmb; uniform float uStrength;
varying vec2 v;
void main() {
  vec4 c = texture2D(uSrc, v); vec4 n = texture2D(uNrm, v);
  vec3 N = normalize(n.rgb * 2.0 - 1.0 + vec3(1e-6));
  vec3 f = uAmb + uKey * max(dot(N, uL), 0.0);
  vec3 lit = mix(c.rgb * f, c.rgb + (1.0 - c.rgb) * clamp(f - 1.0, 0.0, 1.0), step(vec3(1.0), f));
  gl_FragColor = vec4(mix(c.rgb, lit, uStrength * n.a), c.a);
}`;

function createRelightGL() {
  try {
    const canvas = makeCanvas(1, 1);
    const gl = canvas.getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: true });
    if (!gl) return null;
    const shader = (type, source) => {
      const item = gl.createShader(type);
      gl.shaderSource(item, source);
      gl.compileShader(item);
      if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(item) || "shader");
      return item;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, RELIGHT_VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, RELIGHT_FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const texture = (unit, name) => {
      const item = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, item);
      for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
      gl.uniform1i(gl.getUniformLocation(program, name), unit);
      return item;
    };
    const textures = [texture(0, "uSrc"), texture(1, "uNrm")];
    const uniforms = Object.fromEntries(["uL", "uKey", "uAmb", "uStrength"].map((name) => [name, gl.getUniformLocation(program, name)]));
    return {
      canvas,
      /** Relights `source` with `normals` (same size); the result is `canvas`, or null on failure. */
      run(source, normals, light, strength) {
        if (gl.isContextLost()) return null;
        canvas.width = source.width;
        canvas.height = source.height;
        gl.viewport(0, 0, source.width, source.height);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        [source, normals].forEach((image, unit) => {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, textures[unit]);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        });
        const { ambient, key, direction } = relightTerms(light);
        gl.uniform3f(uniforms.uL, direction.x, direction.y, direction.z);
        gl.uniform3f(uniforms.uKey, ...key);
        gl.uniform3f(uniforms.uAmb, ...ambient);
        gl.uniform1f(uniforms.uStrength, Math.max(0, Math.min(1, strength)));
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return gl.getError() === gl.NO_ERROR ? canvas : null;
      },
    };
  } catch (err) {
    console.warn("[VNCCS UniCanvas] WebGL relight unavailable, using the 2D fallback", err);
    return null;
  }
}

/** The layer's normal pass drawn over its canvas crop (canvas pixels), or null without one. */
function alignedNormals(uc, layer, crop) {
  const pass = currentNormalPass(layer);
  if (!pass) return null;
  const canvas = makeCanvas(crop.width, crop.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rect = pass.meta.rect;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(pass.canvas, rect.x - uc.origin.x - crop.x, rect.y - uc.origin.y - crop.y, rect.width, rect.height);
  return canvas;
}

/** Relights `work` in place. Interaction without WebGL runs the 2D loop at half resolution. */
function relightWork(panel, work, normals, light, strength, final) {
  if (panel.gl === undefined) panel.gl = panel.forceCpu ? null : createRelightGL();
  const ctx = work.getContext("2d", { willReadFrequently: true });
  const result = panel.gl?.run(work, normals, light, strength);
  if (result) {
    ctx.clearRect(0, 0, work.width, work.height);
    ctx.drawImage(result, 0, 0);
    return;
  }
  if (final) {
    const image = ctx.getImageData(0, 0, work.width, work.height);
    const normalData = normals.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, work.width, work.height).data;
    relightPixels(image.data, normalData, work.width, work.height, light, strength, image.data);
    ctx.putImageData(image, 0, 0);
    return;
  }
  const width = Math.max(1, Math.round(work.width / 2)), height = Math.max(1, Math.round(work.height / 2));
  const small = makeCanvas(width, height), smallNormals = makeCanvas(width, height);
  const smallCtx = small.getContext("2d", { willReadFrequently: true });
  smallCtx.drawImage(work, 0, 0, width, height);
  const normalCtx = smallNormals.getContext("2d", { willReadFrequently: true });
  normalCtx.drawImage(normals, 0, 0, width, height);
  const image = smallCtx.getImageData(0, 0, width, height);
  relightPixels(image.data, normalCtx.getImageData(0, 0, width, height).data, width, height, light, strength, image.data);
  smallCtx.putImageData(image, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = "source-atop"; // the full-resolution alpha stays
  ctx.drawImage(small, 0, 0, work.width, work.height);
  ctx.restore();
}

function lightKey(uc) {
  return JSON.stringify(normalizeSceneLight(uc.sceneLight));
}

function lightInteractionActive(uc, panel) {
  return Boolean(panel.dragging || uc._scenePlace?.lightGesture);
}

/** Writes stage 1 (color) and stage 2 (relight) over the untouched pixels into the layer. */
function composeHarmonize(uc, panel, final = true) {
  if (panel.closed) return;
  const { layer, crop } = panel;
  const work = panel.work || (panel.work = makeCanvas(crop.width, crop.height));
  const ctx = work.getContext("2d", { willReadFrequently: true });
  ctx.save();
  ctx.clearRect(0, 0, work.width, work.height);
  ctx.drawImage(panel.targetBase, 0, 0);
  const matched = panel.color.on ? panel.color.matched.get(panel.color.method) : null;
  if (matched) {
    ctx.globalAlpha = Math.max(0, Math.min(1, panel.color.strength / COLOR_MATCH_STRENGTH_MAX));
    ctx.globalCompositeOperation = "source-atop";
    ctx.drawImage(matched, 0, 0, work.width, work.height);
  }
  ctx.restore();
  if (panel.relight.on && panel.normals) relightWork(panel, work, panel.normals, uc.sceneLight, panel.relight.strength, final);
  prepareLayerPixels(uc, layer);
  const layerCtx = uc.configureImageContext(layer.canvas.getContext("2d"));
  layerCtx.save();
  layerCtx.clearRect(crop.x, crop.y, crop.width, crop.height);
  layerCtx.drawImage(work, crop.x, crop.y);
  layerCtx.restore();
  panel.changed = true;
  panel.preview = !final;
  panel.lightKey = lightKey(uc);
  uc.markLayerPixelsChanged(layer, crop, false);
  uc.refreshLayerRow?.(layer.id);
  uc.requestRender();
}

function scheduleHarmonize(uc, panel, final = false) {
  panel.wantFinal = panel.wantFinal || final;
  if (panel.rafId) return;
  // Coalesced per frame; the newest control value always wins.
  panel.rafId = requestAnimationFrame(() => {
    panel.rafId = 0;
    const wantFinal = panel.wantFinal;
    panel.wantFinal = false;
    composeHarmonize(uc, panel, wantFinal);
  });
}

/** Per frame (render hook): a light change relights live; the end of a light gesture renders full quality. */
function updateHarmonizePreview(uc) {
  const panel = uc._harmonizePanel;
  if (!panel || panel.closed) return;
  if (!uc.layers.includes(panel.layer)) {
    closeHarmonizePanel(uc, false, { restore: false });
    return;
  }
  if (!panel.relight.on || !panel.normals) return;
  const interactive = lightInteractionActive(uc, panel);
  if (panel.lightKey !== lightKey(uc)) composeHarmonize(uc, panel, !interactive);
  else if (panel.preview && !interactive && !panel.rafId) composeHarmonize(uc, panel, true);
  if (panel.element) updateLightReadouts(panel);
}

async function loadHarmonizeColor(uc, panel) {
  const stage = panel.color;
  if (!stage.on) return scheduleHarmonize(uc, panel, true);
  if (stage.matched.has(stage.method)) return scheduleHarmonize(uc, panel, true);
  if (!panel.reference) panel.reference = buildSurroundReference(uc, panel.layer);
  if (!panel.reference) {
    panel.setNote("Color: there is nothing visible around the character to match.", true);
    return undefined;
  }
  stage.seq += 1;
  const seq = stage.seq, method = stage.method;
  panel.setNote("Computing the color match…");
  try {
    const image = await uc.loadImage(await fetchColorMatch(panel.targetBase, panel.reference, method));
    if (panel.closed || seq !== stage.seq) return undefined; // stale: the newest request wins
    stage.matched.set(method, image);
    panel.setNote("");
    scheduleHarmonize(uc, panel, true);
  } catch (err) {
    if (panel.closed || seq !== stage.seq) return undefined;
    panel.setNote(`Color match failed: ${err.message || err}`, true);
  }
  return undefined;
}

/** Apply: stages 1 and 2 as one layerPixels entry. Cancel: back to the pixels from before. */
export function closeHarmonizePanel(uc, commit, { restore = true } = {}) {
  const panel = uc._harmonizePanel;
  if (!panel) return;
  uc._harmonizePanel = null;
  if (panel.rafId) cancelAnimationFrame(panel.rafId);
  panel.rafId = 0;
  const staged = panel.color.on || panel.relight.on;
  if (commit && panel.changed && staged && uc.layers.includes(panel.layer)) {
    if (panel.preview) composeHarmonize(uc, panel, true);
    panel.closed = true;
    uc.pushHistoryEntry({ kind: "layerPixels", layerId: panel.layer.id, before: panel.openedBefore, after: uc.createLayerPixelSnapshot(panel.layer) });
    uc.autoNaming?.onLayerPixelsCommitted?.(panel.layer);
    uc.setStatus(`Harmonize applied to ${panel.layer.name}.`);
  } else {
    panel.closed = true;
    if (restore && panel.changed && uc.layers.includes(panel.layer)) {
      uc.restoreLayerPixelSnapshot(panel.layer, panel.openedBefore);
      uc.refreshLayerRow?.(panel.layer.id);
    }
  }
  panel.color.seq += 1;
  panel.element?.remove();
  uc.renderToolSettings?.();
  uc.requestRender();
  uc.syncLightStateToWidget();
  uc.scheduleFullSync();
}

// --- AI harmonize (staged). ---

function inferenceSizeFor(region) {
  const scale = AI_LONG_SIDE / Math.max(region.width, region.height);
  const round = (value) => Math.max(64, Math.round(value * scale / 16) * 16);
  return { width: round(region.width), height: round(region.height) };
}

/** The composite over `region` at `size`, through the widget's own export path. */
function exportRegion(uc, region, size) {
  const saved = uc.bbox;
  uc.bbox = { ...region };
  try {
    return uc.makeExportCanvas("image", size);
  } finally {
    uc.bbox = saved;
  }
}

function alphaOf(canvas) {
  const data = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const alpha = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = data[i * 4 + 3];
  return alpha;
}

function alphaCanvas(alpha, width, height) {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < alpha.length; i += 1) {
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = 255;
    image.data[i * 4 + 3] = alpha[i];
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * The character pixels an AI result proposes, over the region at world size: the result's color;
 * its own alpha (limited to the soft mask) when it came back with transparency, else the
 * character's current alpha, so the silhouette cannot move.
 */
export function harmonizeCandidate(resultData, characterAlpha, maskAlpha, width, height) {
  let transparent = false;
  for (let i = 3; i < resultData.length; i += 4) if (resultData[i] < 250) { transparent = true; break; }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    out[i * 4] = resultData[i * 4];
    out[i * 4 + 1] = resultData[i * 4 + 1];
    out[i * 4 + 2] = resultData[i * 4 + 2];
    out[i * 4 + 3] = transparent ? Math.min(resultData[i * 4 + 3], maskAlpha[i]) : characterAlpha[i];
  }
  return out;
}

function worldBox(extent, region) {
  return extent ? { left: region.x + extent.left, right: region.x + extent.right, top: region.y + extent.top, bottom: region.y + extent.bottom } : null;
}

function placementBox(placement) {
  const { rect } = placement;
  return { left: rect.x, right: rect.x + rect.width - 1, top: rect.y, bottom: rect.y + rect.height - 1 };
}

export async function runAiHarmonize(uc, layer) {
  const label = "AI harmonize";
  if (uc.panorama) return uc.setStatus(`${label} is not available in panorama mode.`, true);
  if (uc.drawInProgress) return uc.setStatus(`${label}: a generation is already running.`, true);
  if (!isHarmonizeCharacter(uc, layer)) return uc.setStatus(`${label}: pick a character layer.`, true);
  if (typeof uc._isConfigLinked === "function" && uc._isConfigLinked()) return uc.setStatus(`${label} runs the UniCanvas model directly; unlink VNCSS Config to use it.`, true);
  if (typeof uc.isEditModelSelected === "function" && !uc.isEditModelSelected()) {
    return uc.setStatus(`${label} needs an edit model (Qwen Image Edit, Flux Klein, Krea2 Edit, Qwen Image 2.1). Pick one in the model settings.`, true);
  }
  const placement = characterPlacement(uc, layer);
  if (!placement) return uc.setStatus(`${label}: the layer is empty.`, true);
  const region = dilateRect(placement.rect, AI_HARMONIZE_PAD);
  const size = inferenceSizeFor(region);
  const character = layerPixelsIn(uc, layer, region);
  const characterAlpha = alphaOf(character);
  const maskAlpha = featherAlpha(characterAlpha, region.width, region.height, AI_MASK_DILATE, AI_MASK_BAND);
  const maskCanvas = makeCanvas(size.width, size.height);
  maskCanvas.getContext("2d").drawImage(alphaCanvas(maskAlpha, region.width, region.height), 0, 0, size.width, size.height);
  const imageCanvas = exportRegion(uc, region, size);
  const prompt = resolveHarmonizePrompt(uc.settings);
  const settings = { ...uc.makeSettingsPayload(), positive: prompt, denoise: 1 };
  const debugId = `harmonize-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const original = placementBox(placement);
  uc.drawInProgress = true;
  if (uc.drawBtn) uc.drawBtn.disabled = true;
  uc.startDrawProgressPolling?.(debugId);
  uc.setStatus(`${label} running on ${layer.name}...`);
  const snapshot = buildStagingSnapshot(settings, { mode: "harmonize", bbox: region });
  // History (vnccs_unicanvas_history_gallery.mjs): one record per run with every staged result.
  const historyRun = uc.generationHistory?.beginRun("harmonize", {
    settings, snapshot, bbox: region, mode: "harmonize", inferenceSize: size, outputSize: { width: region.width, height: region.height },
    targetLayerId: layer.id, imageCanvas, maskCanvas,
  }) || null;
  try {
    const res = await fetch(DRAW_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "inpaint", image: imageCanvas.toDataURL("image/png"), mask: maskCanvas.toDataURL("image/png"), source_empty: false,
        bbox: region, inference_size: size, output_size: { width: region.width, height: region.height }, debug_id: debugId, settings,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    const images = Array.isArray(data.images) && data.images.length ? data.images : [data.image].filter(Boolean);
    if (!images.length) throw new Error("the model returned no image");
    const stagedItems = [];
    let rejected = 0;
    for (const image of images) {
      const img = await uc.loadImage(uc.resultImageURL(image));
      if (uc._disposed || !uc.layers.includes(layer)) throw new Error(`${layer.name} was removed while harmonizing`);
      const result = makeCanvas(region.width, region.height);
      const resultCtx = result.getContext("2d", { willReadFrequently: true });
      resultCtx.drawImage(img, 0, 0, result.width, result.height);
      const pixels = harmonizeCandidate(resultCtx.getImageData(0, 0, result.width, result.height).data, characterAlpha, maskAlpha, result.width, result.height);
      const box = worldBox(alphaExtent(pixels, result.width, result.height), region);
      if (!harmonizeKeepsSilhouette(original, box)) { rejected += 1; continue; }
      const candidate = makeCanvas(region.width, region.height);
      candidate.getContext("2d").putImageData(new ImageData(pixels, region.width, region.height), 0, 0);
      const item = {
        url: candidate.toDataURL("image/png"), img: candidate, bbox: { ...region },
        displaySize: { width: region.width, height: region.height }, inferenceSize: size, image: null,
        visible: true, mode: "img2img", maskCanvas: null, userMaskCanvas: null, resultMaskCanvas: null,
        snapshot: { ...snapshot, seed: Number.isFinite(image?.seed) ? image.seed : snapshot.seed },
        harmonize: { layerId: layer.id, region: { ...region }, box },
      };
      uc.addStagingItem(item);
      stagedItems.push(item);
    }
    historyRun?.finish(stagedItems);
    const staged = stagedItems.length;
    uc.requestRender();
    const rejectedText = rejected ? ` ${rejected} result${rejected === 1 ? "" : "s"} rejected: the silhouette moved more than ${Math.round(AI_BBOX_TOLERANCE * 100)}%.` : "";
    uc.setStatus(staged ? `${label}: ${staged} result${staged === 1 ? "" : "s"} staged; accept replaces ${layer.name}'s pixels.${rejectedText}` : `${label}:${rejectedText || " no usable result."}`, !staged);
  } catch (err) {
    historyRun?.fail(err);
    if (!uc._disposed) uc.setStatus(`${label} failed: ${err.message || err}`, true);
  } finally {
    uc.stopDrawProgressPolling?.();
    uc.drawInProgress = false;
    if (uc.drawBtn) uc.drawBtn.disabled = false;
  }
  return undefined;
}

/** Accepting a harmonize result replaces the character layer's pixels as one layerPixels entry. */
export function acceptHarmonizeStaging(uc, staging) {
  const { layerId, region, box } = staging.harmonize;
  const layer = uc.layers.find((item) => item.id === layerId);
  const drop = (message) => {
    uc.removeActiveStagingItem();
    uc.requestRender();
    uc.setStatus(message, true);
  };
  if (!layer) return drop("AI harmonize: the character layer is gone; result discarded.");
  const placement = characterPlacement(uc, layer);
  if (!placement || !harmonizeKeepsSilhouette(placementBox(placement), box)) {
    return drop(`AI harmonize: ${layer.name} moved or changed since the run; result rejected, run it again.`);
  }
  if (uc._harmonizePanel?.layer === layer) closeHarmonizePanel(uc, true);
  const before = uc.createLayerPixelSnapshot(layer);
  prepareLayerPixels(uc, layer);
  // The shown region back in the layer's stored pixels (state move and depth scale undone).
  const rest = stateOffsetRestRect(stateOffsetOf(uc, layer), region);
  const target = { x: rest.x - uc.origin.x, y: rest.y - uc.origin.y, width: rest.width, height: rest.height };
  const ctx = uc.configureImageContext(layer.canvas.getContext("2d"));
  ctx.save();
  ctx.clearRect(target.x, target.y, target.width, target.height);
  ctx.drawImage(staging.img, target.x, target.y, target.width, target.height);
  ctx.restore();
  uc.markLayerPixelsChanged(layer, uc.clampCanvasBounds ? uc.clampCanvasBounds(target, layer.canvas) : target, false);
  const entry = { kind: "layerPixels", layerId: layer.id, before, after: uc.createLayerPixelSnapshot(layer) };
  uc.pushHistoryEntry(uc.generationHistory?.acceptIntoLayer(entry, staging, layer) ?? entry);
  uc.stagingItems = [];
  uc.activeStagingIndex = -1;
  uc.refreshLayerRow?.(layer.id);
  uc.requestRender();
  uc.renderLayerList();
  uc.syncLightStateToWidget();
  uc.scheduleFullSync();
  uc.setStatus(`AI harmonize applied to ${layer.name}; remaining results discarded.`);
  return layer;
}

// --- Foreground occluder. ---

async function depthValues(uc, depth) {
  if (!depth._values) {
    const image = await uc.loadImage(depth.depth);
    const canvas = makeCanvas(depth.width, depth.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const values = new Float32Array(canvas.width * canvas.height);
    for (let i = 0; i < values.length; i += 1) values[i] = data[i * 4] / 255;
    depth._values = values;
  }
  return depth._values;
}

async function refineWithSam(uc, background, alpha, feetLocal, width, height) {
  const positives = [];
  let sx = 0, sy = 0, count = 0;
  for (let i = 0; i < alpha.length; i += 1) if (alpha[i]) { sx += i % width; sy += Math.floor(i / width); count += 1; }
  const centroid = { x: sx / count, y: sy / count };
  // The near pixel closest to the centroid, then the topmost and the lowest near pixels.
  let best = -1, bestDistance = Infinity, top = -1, bottom = -1;
  for (let i = 0; i < alpha.length; i += 1) {
    if (!alpha[i]) continue;
    const d = Math.hypot(i % width - centroid.x, Math.floor(i / width) - centroid.y);
    if (d < bestDistance) { bestDistance = d; best = i; }
    if (top < 0) top = i;
    bottom = i;
  }
  for (const index of new Set([best, top, bottom])) positives.push({ x: index % width, y: Math.floor(index / width), label: 1 });
  const points = [...positives, { x: Math.round(feetLocal.x), y: Math.max(0, Math.round(feetLocal.y) - 1), label: 0 }];
  const res = await fetch(SEGMENT_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: uc.sam?.model || "sam2_large", image: background.toDataURL("image/png"), points }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  const mask = makeCanvas(width, height);
  mask.getContext("2d", { willReadFrequently: true }).drawImage(await uc.loadImage(data.mask), 0, 0, width, height);
  const maskData = mask.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  // SAM decides the outline; it may not reach beyond a few pixels around the near region.
  const near = featherAlpha(alpha, width, height, 6, 0);
  const out = new Uint8ClampedArray(alpha.length);
  for (let i = 0; i < out.length; i += 1) {
    const value = Math.max(maskData[i * 4], maskData[i * 4 + 3] < 255 ? maskData[i * 4 + 3] : 0);
    out[i] = near[i] && value > 127 ? 255 : 0;
  }
  return out;
}

/** Files `layer` right above `source` inside the source's group. */
function fileAboveSource(uc, layer, source) {
  uc.layers = uc.layers.filter((item) => item !== layer && item.id !== layer.id);
  layer.groupId = source.groupId || null;
  const index = uc.layers.indexOf(source);
  uc.layers.splice(index < 0 ? uc.getLayerInsertIndex(layer.type) : index, 0, layer);
  uc.normalizeLayerOrder();
}

/**
 * Create foreground occluder: the background pixels in the character's box whose depth (Plan 08's
 * cached depth map) is nearer than the feet by more than `margin`, optionally refined with SAM,
 * as a raster layer right above the character. Plain stacking: moving the character later leaves
 * it where it is.
 */
export async function createForegroundOccluder(uc, layer, { margin = OCCLUDER_DEFAULT_MARGIN, sam = false } = {}) {
  const label = "Create foreground occluder";
  if (uc.panorama) return uc.setStatus(`${label} is not available in panorama mode.`, true);
  if (!isHarmonizeCharacter(uc, layer)) return uc.setStatus(`${label}: pick a character layer above the background.`, true);
  const placement = characterPlacement(uc, layer);
  if (!placement) return uc.setStatus(`${label}: the layer is empty.`, true);
  const background = backgroundLayer(uc);
  if (!background || background === layer) return uc.setStatus(`${label}: there is no background layer below the character.`, true);
  const state = uc._harmonize;
  if (state.occluderBusy) return uc.setStatus(`${label}: already running.`, true);
  state.occluderBusy = true;
  uc.setStatus(`${label}: reading the depth of ${background.name}...`);
  try {
    const depth = await backgroundDepth(uc, background);
    const values = await depthValues(uc, depth);
    const { rect, feet } = placement;
    const toDepth = (x, y) => ({ u: (x - depth.rect.x) / depth.rect.width * depth.width, v: (y - depth.rect.y) / depth.rect.height * depth.height });
    const feetAt = toDepth(feet.x, feet.y - 1);
    const feetDepth = medianDepthAt(values, depth.width, depth.height, feetAt.u, feetAt.v, 2);
    if (feetDepth === null) throw new Error("the character's feet are outside the background");
    const width = rect.width, height = rect.height;
    const depths = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const { u, v } = toDepth(rect.x + x + 0.5, rect.y + y + 0.5);
        const iu = Math.floor(u), iv = Math.floor(v);
        depths[y * width + x] = iu < 0 || iv < 0 || iu >= depth.width || iv >= depth.height ? -1 : values[iv * depth.width + iu];
      }
    }
    const pixels = layerPixelsIn(uc, background, rect);
    let alpha = occluderAlpha(depths, feetDepth, margin);
    if (!alpha.some(Boolean)) {
      uc.setStatus(`${label}: nothing in the background is in front of ${layer.name}.`, true);
      return null;
    }
    if (sam) {
      uc.setStatus(`${label}: refining with SAM (first use loads the model)...`);
      alpha = await refineWithSam(uc, pixels, alpha, { x: feet.x - rect.x, y: feet.y - rect.y }, width, height);
      if (!alpha.some(Boolean)) {
        uc.setStatus(`${label}: SAM found nothing in front of ${layer.name}.`, true);
        return null;
      }
    }
    if (!uc.layers.includes(layer) || !uc.layers.includes(background)) return null;
    const ctx = pixels.getContext("2d", { willReadFrequently: true });
    const image = ctx.getImageData(0, 0, width, height);
    for (let i = 0; i < alpha.length; i += 1) image.data[i * 4 + 3] = Math.min(image.data[i * 4 + 3], alpha[i]);
    ctx.putImageData(image, 0, 0);
    const previousActiveLayerId = uc.activeLayerId;
    const occluder = uc.addLayer("raster", "Occluder - foreground", false, true, createLayerMeta("occluder", { derivedFrom: layer.id }));
    uc.configureImageContext(occluder.canvas.getContext("2d")).drawImage(pixels, rect.x - uc.origin.x, rect.y - uc.origin.y);
    fileAboveSource(uc, occluder, layer);
    uc.invalidateLayerCaches(occluder);
    uc.activeLayerId = occluder.id;
    if (Array.isArray(uc.selectedLayerIds)) uc.selectedLayerIds = [occluder.id];
    uc.pushHistoryEntry({ kind: OCCLUDER_LAYER_HISTORY_KIND, layer: occluder, sourceLayerId: layer.id, previousActiveLayerId });
    uc.autoNaming?.onLayerCreated?.(occluder);
    uc.renderLayerList();
    uc.syncActiveLayerControls?.();
    uc.requestRender();
    uc.syncLightStateToWidget();
    uc.scheduleFullSync();
    uc.setStatus(`${occluder.name} created above ${layer.name}.`);
    return occluder;
  } catch (err) {
    uc.setStatus(`${label} failed: ${err.message || err}`, true);
    return null;
  } finally {
    state.occluderBusy = false;
  }
}

/** History hook for `occluderLayer` entries: undo removes it, redo files it above its character again. */
export function applyOccluderLayerHistory(uc, entry, direction) {
  const layer = entry.layer;
  if (!layer) return;
  if (direction === "undo") {
    uc.layers = uc.layers.filter((item) => item.id !== layer.id);
    const previous = uc.layers.some((item) => item.id === entry.previousActiveLayerId) ? entry.previousActiveLayerId : null;
    uc.activeLayerId = previous || uc.layers.find((item) => !isMaskSectionLayer(item))?.id || uc.layers[0]?.id || null;
  } else {
    if (!uc.layers.some((item) => item.id === layer.id)) {
      const source = uc.layers.find((item) => item.id === entry.sourceLayerId);
      if (source) fileAboveSource(uc, layer, source);
      else uc.insertLayerByType(layer);
    }
    uc.activeLayerId = layer.id;
  }
  if (Array.isArray(uc.selectedLayerIds)) uc.selectedLayerIds = uc.activeLayerId ? [uc.activeLayerId] : [];
  uc.invalidateLayerCaches(layer);
}

// --- The panel. ---

const HARMONIZE_LIGHT_SLIDERS = [
  { key: "azimuth", label: "Light azimuth", min: 0, max: 359, step: 1, unit: "°" },
  { key: "elevation", label: "Light elevation", min: 5, max: 89, step: 1, unit: "°" },
  { key: "intensity", label: "Light intensity", min: 0, max: 2, step: 0.01 },
];
const COLOR_METHOD_LABELS = { local_lab: "Local (follows the colors around each part)", reinhard_lab_gpu: "Global LAB mean / contrast" };

function escapeHtml(value) {
  return String(value ?? "").replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[ch]);
}

function formatLight(spec, value) {
  return spec.unit ? `${Math.round(value)}${spec.unit}` : Number(value).toFixed(2);
}

function updateLightReadouts(panel, active = null) {
  const light = normalizeSceneLight(panel.uc.sceneLight);
  for (const spec of HARMONIZE_LIGHT_SLIDERS) {
    const input = panel.element.querySelector(`[data-harmonize-light="${spec.key}"]`);
    if (input && input !== active && document.activeElement !== input) input.value = String(light[spec.key]);
    const readout = panel.element.querySelector(`[data-harmonize-light-value="${spec.key}"]`);
    if (readout) readout.textContent = formatLight(spec, light[spec.key]);
  }
}

function shadowsOf(uc, layer) {
  return uc.layers.filter((item) => item.shadow?.sourceLayerId === layer.id);
}

function panelHtml(uc, panel) {
  const { layer } = panel;
  const light = normalizeSceneLight(uc.sceneLight);
  const relightAvailable = Boolean(panel.normals);
  const relightTitle = relightAvailable ? "Shade the character from its normal pass with the scene light" : "Needs a normal pass: only pose characters have one (it is captured when the pose is committed)";
  const methods = COLOR_MATCH_METHODS.map((method) => `<option value="${method}">${escapeHtml(COLOR_METHOD_LABELS[method] || method)}</option>`).join("");
  const lightRows = HARMONIZE_LIGHT_SLIDERS.map((spec) => `<label style="display:grid; grid-template-columns:96px 1fr 40px; gap:6px; align-items:center;"><span>${spec.label}</span><input class="vnccs-uc-range" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${light[spec.key]}" data-harmonize-light="${spec.key}"><span data-harmonize-light-value="${spec.key}">${formatLight(spec, light[spec.key])}</span></label>`).join("");
  const shadows = shadowsOf(uc, layer);
  const shadowButtons = shadows.length
    ? shadows.map((shadow) => `<button class="vnccs-uc-btn" type="button" data-harmonize-shadow="${escapeHtml(shadow.id)}" title="Select the shadow and show its controls">Edit ${shadow.shadow.kind} shadow</button>`).join("")
    : `<button class="vnccs-uc-btn" type="button" data-harmonize-action="add-contact-shadow">Add contact shadow</button><button class="vnccs-uc-btn" type="button" data-harmonize-action="add-cast-shadow">Add cast shadow</button>`;
  const section = "border-top:1px solid rgba(255,255,255,.1); padding-top:8px; display:grid; gap:6px;";
  return `
    <div style="font-weight:600;">Harmonize – ${escapeHtml(layer.name || "layer")}</div>
    <div style="opacity:.75; line-height:1.35;">Color and Relight preview live over the untouched pixels. Apply keeps them as one undo step, Cancel restores the layer.</div>
    <label style="display:flex; gap:6px; align-items:center; font-weight:600;"><input type="checkbox" data-harmonize="color"> 1. Color: match the area around the character</label>
    <label style="display:grid; gap:4px;">Method<select class="vnccs-uc-select" data-harmonize="colorMethod">${methods}</select></label>
    <label style="display:grid; gap:4px;"><span>Strength <span data-harmonize-readout="colorStrength">${panel.color.strength.toFixed(1)}</span></span><input class="vnccs-uc-range" type="range" min="0" max="${COLOR_MATCH_STRENGTH_MAX}" step="0.1" value="${panel.color.strength}" data-harmonize="colorStrength"></label>
    <label style="display:flex; gap:6px; align-items:center; font-weight:600;" title="${escapeHtml(relightTitle)}"><input type="checkbox" data-harmonize="relight" ${relightAvailable ? "" : "disabled"} title="${escapeHtml(relightTitle)}"> 2. Relight with the scene light</label>
    <label style="display:grid; gap:4px;"><span>Relight strength <span data-harmonize-readout="relightStrength">${Math.round(panel.relight.strength * 100)}%</span></span><input class="vnccs-uc-range" type="range" min="0" max="1" step="0.01" value="${panel.relight.strength}" data-harmonize="relightStrength" ${relightAvailable ? "" : "disabled"}></label>
    ${lightRows}
    <div style="opacity:.7;">Drag the sun around the character on the canvas, or use the sliders.</div>
    <div data-harmonize-note style="min-height:14px; opacity:.85;"></div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
      <button class="vnccs-uc-btn" type="button" data-harmonize-action="cancel">Cancel</button>
      <button class="vnccs-uc-btn primary" type="button" data-harmonize-action="apply">Apply</button>
    </div>
    <div style="${section}">
      <div style="font-weight:600;">3. AI harmonize</div>
      <div style="opacity:.75; line-height:1.35;">Runs the selected edit model over the character plus 15% with the instruction from UniCanvas settings (Harmonize). Results go to staging; Accept replaces the layer's pixels.</div>
      <button class="vnccs-uc-btn" type="button" data-harmonize-action="ai">Run AI harmonize</button>
    </div>
    <div style="${section}">
      <div style="font-weight:600;">Foreground occluder</div>
      <label style="display:grid; gap:4px;"><span>Depth margin <span data-harmonize-readout="occluderMargin">${panel.occluder.margin.toFixed(2)}</span></span><input class="vnccs-uc-range" type="range" min="0" max="0.3" step="0.01" value="${panel.occluder.margin}" data-harmonize="occluderMargin"></label>
      <label style="display:flex; gap:6px; align-items:center;"><input type="checkbox" data-harmonize="occluderSam"> Refine with SAM</label>
      <button class="vnccs-uc-btn" type="button" data-harmonize-action="occluder" title="Lift the background in front of the character into a layer above it">Create foreground occluder</button>
    </div>
    <div style="${section}">
      <div style="font-weight:600;">Shadows</div>
      <div style="display:flex; flex-wrap:wrap; gap:6px;">${shadowButtons}</div>
    </div>`;
}

function bindPanel(uc, panel) {
  const { element } = panel;
  const control = (name) => element.querySelector(`[data-harmonize="${name}"]`);
  const readout = (name) => element.querySelector(`[data-harmonize-readout="${name}"]`);
  control("colorMethod").value = panel.color.method;
  control("color").addEventListener("change", (e) => { panel.color.on = e.target.checked; void loadHarmonizeColor(uc, panel); });
  control("colorMethod").addEventListener("change", (e) => { panel.color.method = e.target.value; void loadHarmonizeColor(uc, panel); });
  const gesture = (input, onInput) => {
    input.addEventListener("pointerdown", () => { panel.dragging = true; });
    input.addEventListener("input", () => { onInput(Number(input.value)); scheduleHarmonize(uc, panel, false); });
    const end = () => { panel.dragging = false; scheduleHarmonize(uc, panel, true); };
    input.addEventListener("pointerup", end);
    input.addEventListener("change", end); // keyboard adjustments fire no pointerup
  };
  gesture(control("colorStrength"), (value) => {
    panel.color.strength = Math.max(0, Math.min(COLOR_MATCH_STRENGTH_MAX, value));
    readout("colorStrength").textContent = panel.color.strength.toFixed(1);
  });
  control("relight").addEventListener("change", (e) => { panel.relight.on = e.target.checked && Boolean(panel.normals); scheduleHarmonize(uc, panel, true); });
  gesture(control("relightStrength"), (value) => {
    panel.relight.strength = Math.max(0, Math.min(1, value));
    readout("relightStrength").textContent = `${Math.round(panel.relight.strength * 100)}%`;
  });
  control("occluderMargin").addEventListener("input", (e) => {
    panel.occluder.margin = Math.max(0, Math.min(0.3, Number(e.target.value)));
    readout("occluderMargin").textContent = panel.occluder.margin.toFixed(2);
  });
  control("occluderSam").addEventListener("change", (e) => { panel.occluder.sam = e.target.checked; });
  // Scene light sliders: live on input, one sceneLight history entry per gesture.
  for (const spec of HARMONIZE_LIGHT_SLIDERS) {
    const input = element.querySelector(`[data-harmonize-light="${spec.key}"]`);
    input.addEventListener("pointerdown", () => { panel.dragging = true; });
    input.addEventListener("input", () => {
      if (!panel.lightBefore) panel.lightBefore = clone(normalizeSceneLight(uc.sceneLight));
      uc.sceneLight = normalizeSceneLight({ ...normalizeSceneLight(uc.sceneLight), [spec.key]: Number(input.value) });
      updateLightReadouts(panel, input);
      uc.requestRender(); // the render hook relights in the same frame
    });
    const end = () => {
      panel.dragging = false;
      const before = panel.lightBefore;
      panel.lightBefore = null;
      uc.requestRender();
      if (!before) return;
      const after = clone(normalizeSceneLight(uc.sceneLight));
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      uc.pushHistoryEntry({ kind: SCENE_LIGHT_HISTORY_KIND, before, after });
      uc.syncLightStateToWidget();
    };
    input.addEventListener("pointerup", end);
    input.addEventListener("change", end);
  }
  element.addEventListener("click", (e) => {
    const shadowButton = e.target.closest?.("[data-harmonize-shadow]");
    if (shadowButton) {
      const id = shadowButton.dataset.harmonizeShadow;
      closeHarmonizePanel(uc, true);
      uc.setActiveLayer?.(id);
      uc.setTool?.("move");
      return;
    }
    const action = e.target.closest?.("[data-harmonize-action]")?.dataset.harmonizeAction;
    if (!action) return;
    const layer = panel.layer;
    if (action === "apply") closeHarmonizePanel(uc, true);
    else if (action === "cancel") closeHarmonizePanel(uc, false);
    else if (action === "ai") void runAiHarmonize(uc, layer);
    else if (action === "occluder") void createForegroundOccluder(uc, layer, { margin: panel.occluder.margin, sam: panel.occluder.sam });
    else if (action === "add-contact-shadow" || action === "add-cast-shadow") {
      closeHarmonizePanel(uc, true);
      addShadowLayer(uc, layer, action === "add-cast-shadow" ? "cast" : "contact");
    }
  });
  element.addEventListener("keydown", (e) => {
    e.stopPropagation(); // typing in the panel must not trigger canvas shortcuts
    if (e.key === "Escape") closeHarmonizePanel(uc, false);
  });
}

/** Harmonize... (layer context menu on a character layer). */
export function openHarmonizePanel(uc, layer, point = null) {
  closeHarmonizePanel(uc, true);
  if (uc.panorama) return uc.setStatus("Harmonize is not available in panorama mode.", true);
  if (!isHarmonizeCharacter(uc, layer)) return uc.setStatus("Harmonize: pick a character layer above the background.", true);
  if (layer.locked) return uc.setStatus("Harmonize: the layer is locked.", true);
  const crop = uc.getLayerAlphaBounds(layer);
  if (!crop) return uc.setStatus("Harmonize: the layer is empty.", true);
  const element = document.createElement("div");
  element.className = "vnccs-uc-harmonize-panel";
  element.dataset.harmonizePanel = layer.id;
  element.style.cssText = "position:absolute; z-index:30; width:300px; max-height:calc(100% - 16px); overflow:auto; padding:10px; border-radius:10px; background:rgba(20,16,30,.97); border:1px solid rgba(255,255,255,.14); color:#e8e8f0; font:11px sans-serif; display:grid; gap:8px; box-shadow:0 8px 24px rgba(0,0,0,.45);";
  const panel = {
    uc, layer, element, crop,
    targetBase: uc.cloneCanvasCrop(layer.canvas, crop),
    openedBefore: uc.createLayerPixelSnapshot(layer),
    normals: alignedNormals(uc, layer, crop),
    color: { on: false, method: COLOR_MATCH_METHODS[0], strength: COLOR_MATCH_STRENGTH_MAX, matched: new Map(), seq: 0 },
    relight: { on: false, strength: RELIGHT_DEFAULT_STRENGTH },
    occluder: { margin: OCCLUDER_DEFAULT_MARGIN, sam: false },
    reference: null, work: null, rafId: 0, wantFinal: false, dragging: false, lightBefore: null,
    changed: false, preview: false, closed: false, lightKey: lightKey(uc),
    forceCpu: Boolean(uc._harmonize?.forceCpuRelight),
    setNote(text, isError = false) {
      const note = element.querySelector("[data-harmonize-note]");
      if (!note) return;
      note.textContent = text;
      note.style.color = isError ? "#ff8a8a" : "";
    },
  };
  element.innerHTML = panelHtml(uc, panel);
  uc.container.appendChild(element);
  installCustomSelects(element);
  if (point) placeInHost(uc.container, element, point.x - (element.offsetWidth || 300) - 12, point.y - 20);
  else { element.style.right = "24px"; element.style.top = "48px"; }
  uc._harmonizePanel = panel;
  bindPanel(uc, panel);
  if (!panel.normals) panel.setNote("Relight needs a normal pass (pose characters only).");
  uc.requestRender(); // shows the light gizmo around the character
  return panel;
}

/** Read-only view of the open Harmonize panel for the E2E hook. */
export function describeHarmonize(uc) {
  const panel = uc?._harmonizePanel;
  if (!panel) return null;
  return {
    layerId: panel.layer.id,
    color: { on: panel.color.on, method: panel.color.method, strength: panel.color.strength, loaded: [...panel.color.matched.keys()] },
    relight: { on: panel.relight.on, available: Boolean(panel.normals), strength: panel.relight.strength, preview: panel.preview, gl: Boolean(panel.gl) },
    changed: panel.changed,
  };
}

/** The layer whose light gizmo the open Harmonize panel shows (vnccs_unicanvas_scene_place.mjs). */
export function harmonizeLightTarget(uc) {
  const panel = uc?._harmonizePanel;
  return panel && !panel.closed && uc.layers.includes(panel.layer) ? panel.layer : null;
}

export function installUniCanvasHarmonize(uc) {
  if (!uc || uc._harmonize) return uc;
  uc._harmonize = { paramGesture: null, occluderBusy: false, forceCpuRelight: false };
  uc.addShadowLayer = (source, kind) => addShadowLayer(uc, source, kind);
  uc.detachShadowLayer = (layer) => detachShadowLayer(uc, layer);
  uc.openHarmonizePanel = (layer, point) => openHarmonizePanel(uc, layer, point);
  uc.closeHarmonizePanel = (commit) => closeHarmonizePanel(uc, commit);
  uc.createForegroundOccluder = (layer, options) => createForegroundOccluder(uc, layer, options);
  uc.runAiHarmonize = (layer) => runAiHarmonize(uc, layer);
  uc.harmonizeLightTarget = () => harmonizeLightTarget(uc);

  // Shadows are regenerated, and the relight preview follows the light, inside the frame that draws them.
  const originalRender = uc.render;
  uc.render = (...args) => {
    try {
      updateShadowLayers(uc);
    } catch (err) {
      console.warn("[VNCCS UniCanvas] Shadow update failed", err);
    }
    try {
      updateHarmonizePreview(uc);
    } catch (err) {
      console.warn("[VNCCS UniCanvas] Harmonize preview failed", err);
    }
    return Reflect.apply(originalRender, uc, args);
  };

  // An AI harmonize result replaces its character's pixels instead of becoming a new layer.
  const originalAcceptStaging = uc.acceptStaging;
  uc.acceptStaging = (...args) => {
    const staging = uc.activeStaging;
    if (staging?.harmonize) return acceptHarmonizeStaging(uc, staging);
    return Reflect.apply(originalAcceptStaging, uc, args);
  };

  // A shadow is placed by its source's preview when it is redrawn, so it never gets its own
  // (a group move would otherwise offset it twice).
  const originalGetLayerMovePreview = uc.getLayerMovePreview;
  uc.getLayerMovePreview = (layer) => {
    if (layer?.shadow && sourceLayerOf(uc, layer)) return null;
    return Reflect.apply(originalGetLayerMovePreview, uc, [layer]);
  };

  const originalRenderToolSettings = uc.renderToolSettings;
  uc.renderToolSettings = () => {
    Reflect.apply(originalRenderToolSettings, uc, []);
    if (uc.toolSettings && shadowControlsVisible(uc)) renderShadowPanel(uc);
  };

  installShadowControls(uc);
  return uc;
}

/** Read-only view of a shadow layer for the E2E hook. */
export function describeShadow(layer) {
  const shadow = normalizeShadow(layer?.shadow);
  return shadow ? clone(shadow) : null;
}
