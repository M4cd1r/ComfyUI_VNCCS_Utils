/**
 * VNCCS UniCanvas - shadow layers (Plan 08.2, #19).
 *
 * - A shadow layer is a raster layer with `shadow = { sourceLayerId, kind, params }`, filed right
 *   under its source inside the same group, with `meta.origin = "shadow"` and a multiply blend.
 * - Its pixels are derived: before every frame (`uc.render`, called from the widget's rAF) each
 *   shadow compares a key of its source's pixel revision, the source's live move preview (plain
 *   and depth-scaled drags), its params, the scene light and the horizon, and redraws on a 2D
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
 * The scene light and its gizmo live in vnccs_unicanvas_scene_place.mjs. The widget only calls
 * `installUniCanvasHarmonize` and the serialize / history hooks exported here.
 */

import { createLayerMeta } from "./vnccs_unicanvas_provenance.mjs";
import {
  normalizeSceneLight,
  renderSceneLightControls,
  shadowGroundDirection,
  shadowLengthFactor,
} from "./vnccs_unicanvas_scene_place.mjs";

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

function sourceLayerOf(uc, layer) {
  const id = layer?.shadow?.sourceLayerId;
  if (!id) return null;
  const source = uc.layers.find((item) => item.id === id);
  return source && source !== layer && !source.shadow ? source : null;
}

/** The source's black silhouette on a small canvas, its alpha rect, feet and feet width (world). */
function buildSilhouette(uc, source) {
  const bounds = uc.getLayerWorldBounds(source);
  if (!bounds || bounds.width < 1 || bounds.height < 1) return null;
  const scale = Math.min(1, SILHOUETTE_MAX_SIDE / Math.max(bounds.width, bounds.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bounds.width * scale));
  canvas.height = Math.max(1, Math.round(bounds.height * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  uc.drawRasterLayerToWorldRect(ctx, source, bounds, { x: 0, y: 0, width: canvas.width, height: canvas.height }, true, false);
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
  const key = `${source.id}:${source.pixelRevision ?? 0}`;
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

function drawContactShadow(uc, ctx, placed, params) {
  const geometry = contactShadowGeometry(placed.feet, placed.rect.width, placed.feetWidth, params);
  const [r, g, b] = shadowTint(uc.sceneLight);
  ctx.save();
  ctx.translate(geometry.cx - uc.origin.x, geometry.cy - uc.origin.y);
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

function drawCastShadow(uc, ctx, placed, params) {
  const light = uc.sceneLight;
  const squash = castShadowSquash(uc.scenePerspective, placed.feet.y, placed.rect.height);
  const { c, d } = castShadowMatrix(light, squash);
  const maxBlur = params.blur * placed.rect.height * 0.06;
  const pad = Math.ceil(maxBlur * 2 + 2);
  // Bounds of the flattened silhouette in layer canvas pixels.
  const fx = placed.feet.x - uc.origin.x, fy = placed.feet.y - uc.origin.y;
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
    const placed = placedSilhouette(silhouette, uc.getLayerMovePreview(source));
    if (shadow.kind === "contact") drawContactShadow(uc, ctx, placed, shadow.params);
    else drawCastShadow(uc, ctx, placed, shadow.params);
  }
  uc.invalidateLayerRenderCaches(layer);
  layer._boundsCache = undefined;
  return true;
}

function shadowKey(uc, layer, source) {
  const preview = uc.getLayerMovePreview(source);
  return JSON.stringify([
    source.id, source.pixelRevision ?? 0,
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
    uc.activeLayerId = previous || uc.layers.find((item) => item.type !== "mask")?.id || uc.layers[0]?.id || null;
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

export function installUniCanvasHarmonize(uc) {
  if (!uc || uc._harmonize) return uc;
  uc._harmonize = { paramGesture: null };
  uc.addShadowLayer = (source, kind) => addShadowLayer(uc, source, kind);
  uc.detachShadowLayer = (layer) => detachShadowLayer(uc, layer);

  // Shadows are regenerated inside the frame that draws them.
  const originalRender = uc.render;
  uc.render = (...args) => {
    try {
      updateShadowLayers(uc);
    } catch (err) {
      console.warn("[VNCCS UniCanvas] Shadow update failed", err);
    }
    return Reflect.apply(originalRender, uc, args);
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
