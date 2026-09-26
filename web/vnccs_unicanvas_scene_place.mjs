/**
 * VNCCS UniCanvas - scene placement: horizon, ground plane and depth-correct scaling (Plan 08, #11).
 *
 * - `widget.scenePerspective = { enabled, horizonY, vanishX, referenceHeight, groundTint }` is
 *   serialized with the state. `horizonY` is a world y; `vanishX` only centers the guide grid;
 *   `referenceHeight = { feetY, heightPx, x }` reads "a standard character with feet at feetY is
 *   heightPx tall" (`x` only places the calibration figure); `enabled` is the depth-scale toggle.
 * - Flat ground: the expected height at feet y is
 *   heightPx * (y - horizonY) / (feetY - horizonY) * the layer's height factor.
 * - The Perspective tool (G) drags the horizon, the vanishing point and the calibration figure,
 *   calibrates from the selected character and proposes a horizon from a depth map of the
 *   background (`POST /vnccs/unicanvas/depth`, cached per background pixel revision).
 * - Depth-scale (corner bar, next to Snap to grid) makes the move tool rescale a character layer
 *   around its feet during the drag. Pixels are always resampled from the layer's source
 *   (`hiresCanvas` when present), so repeated moves never degrade; the drag stays one history
 *   entry of the move tool. It covers pose layers (baked characters scale with them), sprite
 *   sets, raster layers in a `Characters` folder and raster layers above the background.
 * - Scene light (Plan 08.2, #19): `widget.sceneLight = { azimuth, elevation, color, intensity,
 *   ambientColor, ambientIntensity }` is serialized with the state and drives the shadow layers
 *   (vnccs_unicanvas_harmonize.mjs). Azimuth is measured around the vertical axis: 0 is a light on
 *   the camera side, 90 on the right, 180 behind the scene. The light gizmo is a sun handle on an
 *   ellipse around the selected character's feet: its angle is the azimuth, its distance from the
 *   feet the elevation (closer is higher). It shows in the Perspective tool and in the shadow
 *   controls, updates live while dragged and records one history entry per gesture. Estimate
 *   proposes an azimuth from the dominant luminance gradient of the blurred background around the
 *   character (a heuristic), with Accept / Ignore.
 * Neither works in panorama mode. The widget only calls `installUniCanvasScenePlace` and the
 * serialize / history hooks exported here.
 */

import { groupChainOf, isGroupLayer, isLayerEffectivelyLocked, isLayerEffectivelyVisible } from "./vnccs_unicanvas_groups.mjs";
import { isUniCanvasEnabled } from "./vnccs_unicanvas_feature_toggles.mjs";

export const DEPTH_ROUTE = "/vnccs/unicanvas/depth";
export const PERSPECTIVE_TOOL = "perspective";
export const SCENE_PERSPECTIVE_HISTORY_KIND = "scenePerspective";
export const SCENE_LIGHT_HISTORY_KIND = "sceneLight";
/** Vertical squash of the gizmo's ground ellipse (the ground seen at an angle). */
export const LIGHT_GIZMO_SQUASH = 0.35;
const LIGHT_MIN_ELEVATION = 5;
const LIGHT_MAX_ELEVATION = 89;
const LIGHT_HANDLE_INNER = 0.12;
const LIGHT_ESTIMATE_SIDE = 64;
export const DEFAULT_GROUND_TINT = "#4cc9f0";
export const MIN_CHARACTER_HEIGHT = 4;
const DEPTH_MAX_SIDE = 1024;
const PANORAMA_TOOLTIP = "Not available in panorama mode";

const PERSPECTIVE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 9h20"/><path d="M12 9 3 21"/><path d="M12 9 21 21"/><path d="M12 9v12"/><path d="M6.5 15h11"/><circle cx="18" cy="4.5" r="1.6"/><path d="M18 6.1v2"/></svg>`;
const DEPTH_SCALE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 7h20"/><circle cx="7" cy="9.6" r="1"/><path d="M7 10.6v2.2"/><circle cx="16" cy="12.4" r="2"/><path d="M16 14.4v5.4"/><path d="M4 21h16"/></svg>`;

function finite(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function defaultScenePerspective() {
  return { enabled: false, horizonY: null, vanishX: null, referenceHeight: null, groundTint: DEFAULT_GROUND_TINT };
}

/** Normalizes a saved / history / UI value. Missing or broken fields fall back to the defaults. */
export function normalizeScenePerspective(raw) {
  const result = defaultScenePerspective();
  if (!raw || typeof raw !== "object") return result;
  result.enabled = raw.enabled === true;
  result.horizonY = finite(raw.horizonY);
  result.vanishX = finite(raw.vanishX);
  const ref = raw.referenceHeight;
  if (ref && typeof ref === "object") {
    const feetY = finite(ref.feetY), heightPx = finite(ref.heightPx), x = finite(ref.x);
    if (feetY !== null && heightPx !== null && heightPx > 0) result.referenceHeight = { feetY, heightPx, ...(x !== null ? { x } : {}) };
  }
  if (typeof raw.groundTint === "string" && /^#[0-9a-f]{6}$/i.test(raw.groundTint)) result.groundTint = raw.groundTint;
  return result;
}

export function serializeScenePerspective(value) {
  return normalizeScenePerspective(value);
}

// ---------------------------------------------------------------------------
// Scene light model (Plan 08.2).
// ---------------------------------------------------------------------------

export function defaultSceneLight() {
  return { azimuth: 45, elevation: 40, color: "#fff4e0", intensity: 1, ambientColor: "#5a6478", ambientIntensity: 0.6 };
}

function hexColor(value, fallback) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = finite(value);
  return number === null ? fallback : Math.min(max, Math.max(min, number));
}

/** Normalizes a saved / history / UI light. Azimuth wraps into [0, 360); the rest is clamped. */
export function normalizeSceneLight(raw) {
  const result = defaultSceneLight();
  if (!raw || typeof raw !== "object") return result;
  const azimuth = finite(raw.azimuth);
  if (azimuth !== null) result.azimuth = ((azimuth % 360) + 360) % 360;
  result.elevation = clampNumber(raw.elevation, LIGHT_MIN_ELEVATION, LIGHT_MAX_ELEVATION, result.elevation);
  result.intensity = clampNumber(raw.intensity, 0, 2, result.intensity);
  result.ambientIntensity = clampNumber(raw.ambientIntensity, 0, 2, result.ambientIntensity);
  result.color = hexColor(raw.color, result.color);
  result.ambientColor = hexColor(raw.ambientColor, result.ambientColor);
  return result;
}

export function serializeSceneLight(value) {
  return normalizeSceneLight(value);
}

const DEG = Math.PI / 180;

/** Unit direction on the ground in which shadows fall: x to the right, z away from the camera. */
export function shadowGroundDirection(light) {
  const azimuth = normalizeSceneLight(light).azimuth * DEG;
  return { x: -Math.sin(azimuth), z: Math.cos(azimuth) };
}

/** Shadow length per unit of height: 1 / tan(elevation), capped for grazing light. */
export function shadowLengthFactor(light) {
  return Math.min(6, 1 / Math.tan(normalizeSceneLight(light).elevation * DEG));
}

/** World position of the sun handle for a gizmo centered on `center` with ground radius `radius`. */
export function sunHandlePosition(center, radius, light) {
  const { azimuth, elevation } = normalizeSceneLight(light);
  const reach = radius * (LIGHT_HANDLE_INNER + (1 - LIGHT_HANDLE_INNER) * (1 - elevation / 90));
  return {
    x: center.x + Math.sin(azimuth * DEG) * reach,
    y: center.y + Math.cos(azimuth * DEG) * reach * LIGHT_GIZMO_SQUASH,
  };
}

/** Inverse of sunHandlePosition: the azimuth and elevation of a handle dragged to `point`. */
export function lightFromHandle(center, radius, point) {
  const dx = point.x - center.x;
  const dz = (point.y - center.y) / LIGHT_GIZMO_SQUASH;
  const azimuth = ((Math.atan2(dx, dz) / DEG) + 360) % 360;
  const t = Math.min(1, Math.hypot(dx, dz) / Math.max(1, radius));
  const elevation = 90 * (1 - Math.max(0, t - LIGHT_HANDLE_INNER) / (1 - LIGHT_HANDLE_INNER));
  return { azimuth, elevation: Math.min(LIGHT_MAX_ELEVATION, Math.max(LIGHT_MIN_ELEVATION, elevation)) };
}

/**
 * Heuristic light azimuth from a (blurred) luminance grid: the mean gradient points toward the
 * brighter side, which is taken as the side of the light. Brighter right is 90, brighter toward
 * the camera (the bottom) is 0. The vertical term is halved because skies bias it upward.
 * Returns null for a flat image.
 */
export function estimateLightAzimuth(luminance, width, height) {
  if (!luminance || width < 3 || height < 3) return null;
  let gx = 0, gy = 0, total = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      gx += (luminance[i + 1] - luminance[i - 1]) / 2;
      gy += (luminance[i + width] - luminance[i - width]) / 2;
      total += 1;
    }
  }
  gx /= total;
  gy = gy / total / 2;
  if (Math.hypot(gx, gy) < 1e-3) return null;
  return ((Math.atan2(gx, gy) / DEG) + 360) % 360;
}

/** True when a horizon and a reference below it are set. */
export function isPerspectiveCalibrated(perspective) {
  const p = perspective;
  return Boolean(p && p.horizonY !== null && p.referenceHeight && p.referenceHeight.feetY > p.horizonY);
}

/** Expected height of a character whose feet stand at `feetY`, or null (uncalibrated / above the horizon). */
export function expectedHeightAt(perspective, feetY, heightFactor = 1) {
  if (!isPerspectiveCalibrated(perspective) || !Number.isFinite(feetY) || feetY <= perspective.horizonY) return null;
  const { horizonY, referenceHeight: ref } = perspective;
  return ref.heightPx * (feetY - horizonY) / (ref.feetY - horizonY) * (heightFactor > 0 ? heightFactor : 1);
}

/** The feet y for which the expected height is `height` (inverse of expectedHeightAt). */
export function feetYForHeight(perspective, height, heightFactor = 1) {
  if (!isPerspectiveCalibrated(perspective) || !(height > 0)) return null;
  const { horizonY, referenceHeight: ref } = perspective;
  return horizonY + height / (heightFactor > 0 ? heightFactor : 1) / ref.heightPx * (ref.feetY - horizonY);
}

/**
 * How tall this character is relative to the standard one: `meta.heightFactor` when set, else a
 * pose character's mesh `height` morph (0.5 is the standard, 0..1 maps to 0.75..1.25), else 1.
 */
export function layerHeightFactor(layer) {
  const own = finite(layer?.meta?.heightFactor);
  if (own !== null && own > 0) return own;
  if (layer?.type === "pose") {
    const studio = layer.pose?.studio;
    const mesh = Array.isArray(studio?.characters) ? studio.characters[0]?.mesh : studio?.mesh;
    const morph = finite(mesh?.height);
    if (morph !== null) return Math.min(1.5, Math.max(0.5, 0.75 + 0.5 * morph));
  }
  return 1;
}

/** Tight alpha box of a canvas in its own pixels, or null when fully transparent. */
export function canvasAlphaBounds(canvas) {
  if (!canvas?.width || !canvas?.height) return null;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] <= 8) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** The pixels a layer's depth scale resamples from: its hi-res canvas, else a crop of its canvas. */
function layerSource(uc, layer) {
  if (!layer) return null;
  if (layer.hiresCanvas && layer.hiresRect) {
    return { canvas: layer.hiresCanvas, rect: uc.normalizeLayerWorldRect(layer.hiresRect), fromHires: true };
  }
  const crop = uc.getLayerAlphaBounds(layer);
  if (!crop) return null;
  return {
    canvas: uc.cloneCanvasCrop(layer.canvas, crop),
    rect: { x: uc.origin.x + crop.x, y: uc.origin.y + crop.y, width: crop.width, height: crop.height },
    fromHires: false,
  };
}

/** World rect of the character's visible pixels and its feet anchor (bottom center of that rect). */
function measureSource(source) {
  const alpha = canvasAlphaBounds(source?.canvas);
  if (!alpha) return null;
  const sx = source.rect.width / source.canvas.width, sy = source.rect.height / source.canvas.height;
  const rect = { x: source.rect.x + alpha.x * sx, y: source.rect.y + alpha.y * sy, width: alpha.width * sx, height: alpha.height * sy };
  return { rect, feet: { x: rect.x + rect.width / 2, y: rect.y + rect.height } };
}

export function measureLayerCharacter(uc, layer) {
  return measureSource(layerSource(uc, layer));
}

/** The lowest visible raster layer that has pixels: what "the background" means for depth. */
export function backgroundLayer(uc) {
  for (let index = uc.layers.length - 1; index >= 0; index -= 1) {
    const layer = uc.layers[index];
    if (layer.type !== "raster" && layer.type !== "panorama") continue;
    if (isLayerEffectivelyVisible(uc.layers, layer) && !isInCharactersFolder(uc.layers, layer) && uc.getLayerAlphaBounds(layer)) return layer;
  }
  return null;
}

/** The auto-filing folder of character layers (vnccs_unicanvas_filing.mjs), matched case-insensitively. */
export const CHARACTERS_FOLDER = "Characters";

/** True when the layer sits in a `Characters` folder, directly or in a character subfolder. */
export function isInCharactersFolder(layers, layer) {
  const name = CHARACTERS_FOLDER.toLowerCase();
  return groupChainOf(layers, layer).some((group) => String(group.name || "").trim().toLowerCase() === name);
}

/**
 * Layers the depth scale applies to: pose layers (baked or not), sprite sets, anything in a
 * `Characters` folder, and raster layers above the background.
 */
export function isDepthScaleLayer(uc, layer) {
  if (!layer || layer.type === "mask" || isGroupLayer(layer) || isLayerEffectivelyLocked(uc.layers, layer)) return false;
  if (layer.type === "pose" || layer.type === "sprite") return true;
  if (layer.type !== "raster") return false;
  // A character raster is never "the background", even when it is the lowest raster layer.
  return isInCharactersFolder(uc.layers, layer) || layer !== backgroundLayer(uc);
}

function scaleAround(rect, from, to, scale) {
  return {
    x: to.x + (rect.x - from.x) * scale,
    y: to.y + (rect.y - from.y) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/** The depth-scaled placement for a drag of the feet anchor to `point`. */
export function depthScalePlacement(perspective, drag, point, startPoint) {
  const horizon = perspective.horizonY;
  // Feet snap onto the horizontal line under the cursor, never at or above the horizon.
  const minFeet = feetYForHeight(perspective, MIN_CHARACTER_HEIGHT, drag.factor) ?? horizon + 1;
  const feetY = Math.max(point.y, minFeet, horizon + 1);
  const feetX = drag.feet.x + (point.x - startPoint.x);
  const height = Math.max(MIN_CHARACTER_HEIGHT, expectedHeightAt(perspective, feetY, drag.factor) || MIN_CHARACTER_HEIGHT);
  const scale = height / drag.character.height;
  return { dx: feetX - drag.feet.x, dy: feetY - drag.feet.y, scale, anchor: { ...drag.feet }, height, feet: { x: feetX, y: feetY } };
}

function perspectiveState(uc) {
  if (!uc.scenePerspective) uc.scenePerspective = defaultScenePerspective();
  return uc.scenePerspective;
}

function depthScaleActive(uc) {
  return Boolean(!uc.panorama && perspectiveState(uc).enabled && isUniCanvasEnabled("groundPlane"));
}

function beginDepthScale(uc, layer, start) {
  if (!isDepthScaleLayer(uc, layer)) return null;
  const perspective = perspectiveState(uc);
  if (!isPerspectiveCalibrated(perspective)) {
    uc.setStatus("Depth-scale: set the horizon and calibrate first (Perspective tool, G).", true);
    return null;
  }
  let source;
  if (layer.hiresCanvas && layer.hiresRect) source = layerSource(uc, layer);
  else if (start.layerCanvas && start.layerBounds) {
    const origin = start.layerOrigin || uc.origin;
    const crop = start.layerBounds;
    source = { canvas: start.layerCanvas, rect: { x: origin.x + crop.x, y: origin.y + crop.y, width: crop.width, height: crop.height }, fromHires: false };
  }
  const measured = measureSource(source);
  if (!measured || measured.rect.height < 2) return null;
  return {
    source,
    character: measured.rect,
    feet: measured.feet,
    factor: layerHeightFactor(layer),
    poseRect: layer.pose?.rect ? { ...layer.pose.rect } : null,
  };
}

/** Rect of `rect` after the placement; snapped to whole pixels, and to the source size when unscaled. */
function placedRect(rect, placement, source) {
  const next = scaleAround(rect, placement.anchor, { x: placement.anchor.x + placement.dx, y: placement.anchor.y + placement.dy }, placement.scale);
  next.x = Math.round(next.x);
  next.y = Math.round(next.y);
  if (source && Math.abs(next.width - source.canvas.width) < 0.5 && Math.abs(next.height - source.canvas.height) < 0.5) {
    next.width = source.canvas.width;
    next.height = source.canvas.height;
  }
  return next;
}

function commitDepthScale(uc, layer, drag, placement, allowExpand) {
  const rect = placedRect(drag.source.rect, placement, drag.source);
  if (!uc.ensureWorldBounds(rect.x, rect.y, 256, allowExpand)) return false;
  if (!uc.ensureWorldBounds(rect.x + rect.width, rect.y + rect.height, 256, allowExpand)) return false;
  const ctx = uc.configureImageContext(layer.canvas.getContext("2d"), true);
  ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  ctx.drawImage(drag.source.canvas, rect.x - uc.origin.x, rect.y - uc.origin.y, rect.width, rect.height);
  const unscaled = rect.width === drag.source.canvas.width && rect.height === drag.source.canvas.height;
  if (drag.source.fromHires || !unscaled) {
    // The pristine source stays the layer's hi-res pixels: the next move resamples from it again.
    layer.hiresCanvas = drag.source.canvas;
    layer.hiresRect = { ...rect };
  }
  if (layer.pose && drag.poseRect) layer.pose.rect = placedRect(drag.poseRect, placement, null);
  // Layer kinds with their own geometry follow the same placement: baked characters
  // (vnccs_unicanvas_bake.mjs) and sprite sets (vnccs_unicanvas_sprites.mjs).
  const map = placementMap(placement);
  uc.poseBake?.onDepthScale?.(layer, map, drag.poseRect);
  uc.sprites?.onDepthScale?.(layer, map);
  uc.invalidateLayerRenderCaches(layer);
  layer._boundsCache = undefined;
  return true;
}

/** A depth-scale placement as world-point and world-rect maps (scale around the feet, then move). */
export function placementMap(placement) {
  const { anchor, dx, dy, scale } = placement;
  const point = (p) => ({ x: anchor.x + dx + (p.x - anchor.x) * scale, y: anchor.y + dy + (p.y - anchor.y) * scale });
  const rect = (r) => ({ ...point(r), width: r.width * scale, height: r.height * scale });
  return { point, rect, scale };
}

// ---------------------------------------------------------------------------
// Overlay: horizon, perspective ground grid, calibration figure, proposed horizon.
// ---------------------------------------------------------------------------

function figureOf(uc, perspective) {
  const ref = perspective.referenceHeight;
  if (!ref) return null;
  const x = ref.x ?? (uc.bbox.x + uc.bbox.width / 2);
  const width = Math.max(6, ref.heightPx * 0.28);
  return { x, feetY: ref.feetY, headY: ref.feetY - ref.heightPx, width };
}

function vanishXOf(uc, perspective) {
  return perspective.vanishX ?? (uc.bbox.x + uc.bbox.width / 2);
}

function hexToRgba(hex, alpha) {
  const value = parseInt(String(hex || DEFAULT_GROUND_TINT).slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}

function drawGround(uc, ctx, perspective, visible) {
  const horizon = perspective.horizonY;
  const bottom = visible.y + visible.height;
  if (bottom <= horizon) return;
  const left = visible.x, right = visible.x + visible.width;
  const px = 1 / uc.view.scale;
  const tint = perspective.groundTint;
  const vx = vanishXOf(uc, perspective);
  const depthSpan = (perspective.referenceHeight?.feetY ?? horizon + (bottom - horizon) / 2) - horizon;
  ctx.save();
  ctx.lineWidth = px;
  // Rows at depths 1/8 .. 8 of the reference distance: denser toward the horizon, fading with distance.
  for (let k = -12; k <= 12; k += 1) {
    const y = horizon + depthSpan * 2 ** (k / 4);
    if (y <= horizon || y > bottom) continue;
    const near = Math.min(1, (y - horizon) / Math.max(1, bottom - horizon));
    ctx.strokeStyle = hexToRgba(tint, 0.08 + 0.4 * near);
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
  }
  // Rays from the vanishing point, evenly spaced along the reference feet line.
  const feetLine = horizon + depthSpan;
  const spacing = Math.max(8, (perspective.referenceHeight?.heightPx ?? depthSpan) * 0.5);
  const spread = (right - left) + Math.abs(vx - (left + right) / 2) * 2;
  const reach = (bottom - horizon) / Math.max(1, feetLine - horizon);
  for (let i = -Math.ceil(spread / spacing); i <= Math.ceil(spread / spacing); i += 1) {
    const endX = vx + i * spacing * reach;
    const gradient = ctx.createLinearGradient(vx, horizon, vx, bottom);
    gradient.addColorStop(0, hexToRgba(tint, 0));
    gradient.addColorStop(1, hexToRgba(tint, 0.45));
    ctx.strokeStyle = gradient;
    ctx.beginPath(); ctx.moveTo(vx, horizon); ctx.lineTo(endX, bottom); ctx.stroke();
  }
  ctx.restore();
}

function drawFigure(uc, ctx, figure, tint) {
  const px = 1 / uc.view.scale;
  const height = figure.feetY - figure.headY;
  const head = height * 0.12;
  ctx.save();
  ctx.lineWidth = 2 * px;
  ctx.strokeStyle = tint;
  ctx.fillStyle = hexToRgba(tint, 0.18);
  ctx.beginPath();
  ctx.arc(figure.x, figure.headY + head, head, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
  const shoulder = figure.headY + head * 2.2;
  const hip = figure.headY + height * 0.52;
  const half = figure.width / 2;
  ctx.beginPath();
  ctx.moveTo(figure.x - half * 0.8, shoulder); ctx.lineTo(figure.x + half * 0.8, shoulder);
  ctx.lineTo(figure.x + half * 0.5, hip); ctx.lineTo(figure.x + half * 0.45, figure.feetY);
  ctx.lineTo(figure.x - half * 0.45, figure.feetY); ctx.lineTo(figure.x - half * 0.5, hip);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  const handle = Math.max(4 * px, 5 / uc.view.scale);
  ctx.fillStyle = "#ffffff";
  for (const y of [figure.headY, figure.feetY]) {
    ctx.fillRect(figure.x - handle, y - handle, handle * 2, handle * 2);
    ctx.strokeRect(figure.x - handle, y - handle, handle * 2, handle * 2);
  }
  ctx.font = `${12 * px}px sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(`${Math.round(height)} px`, figure.x + half + 4 * px, figure.headY + 12 * px);
  ctx.restore();
}

function drawHorizonLine(uc, ctx, y, visible, { color, dashed = false, label = "" } = {}) {
  const px = 1 / uc.view.scale;
  ctx.save();
  ctx.lineWidth = 2 * px;
  ctx.strokeStyle = color;
  if (dashed) ctx.setLineDash([8 * px, 6 * px]);
  ctx.beginPath(); ctx.moveTo(visible.x, y); ctx.lineTo(visible.x + visible.width, y); ctx.stroke();
  if (label) {
    ctx.setLineDash([]);
    ctx.font = `${12 * px}px sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(label, visible.x + 8 * px, y - 6 * px);
  }
  ctx.restore();
}

export function drawScenePlaceOverlay(uc, ctx) {
  if (uc.panorama) return;
  drawPerspectiveOverlay(uc, ctx);
  if (isLightGizmoVisible(uc)) drawLightGizmo(uc, ctx);
}

function drawPerspectiveOverlay(uc, ctx) {
  const state = uc._scenePlace;
  const perspective = perspectiveState(uc);
  const dragging = uc.pointerMode === "layer-move" && uc.dragStart?.depthScale;
  if (uc.tool !== PERSPECTIVE_TOOL && !dragging) return;
  const visible = uc.visibleWorldRect();
  if (perspective.horizonY !== null) {
    if (uc.tool === PERSPECTIVE_TOOL) drawGround(uc, ctx, perspective, visible);
    drawHorizonLine(uc, ctx, perspective.horizonY, visible, { color: "#ffd166", label: uc.tool === PERSPECTIVE_TOOL ? "Horizon" : "" });
    if (uc.tool === PERSPECTIVE_TOOL) {
      const px = 1 / uc.view.scale;
      ctx.save();
      ctx.fillStyle = "#ffd166";
      ctx.beginPath(); ctx.arc(vanishXOf(uc, perspective), perspective.horizonY, 5 * px, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
  const figure = uc.tool === PERSPECTIVE_TOOL ? figureOf(uc, perspective) : null;
  if (figure) drawFigure(uc, ctx, figure, perspective.groundTint);
  if (state?.ghostY !== null && state?.ghostY !== undefined && uc.tool === PERSPECTIVE_TOOL) {
    drawHorizonLine(uc, ctx, state.ghostY, visible, { color: "#ff8fa3", dashed: true, label: "Proposed horizon" });
  }
}

// ---------------------------------------------------------------------------
// Scene light: gizmo, panel section and estimate (Plan 08.2).
// ---------------------------------------------------------------------------

function lightState(uc) {
  if (!uc.sceneLight) uc.sceneLight = defaultSceneLight();
  return uc.sceneLight;
}

/**
 * The light gizmo shows in the Perspective tool, with the shadow controls (move tool on a shadow
 * layer) and while the Harmonize panel is open (vnccs_unicanvas_harmonize.mjs).
 */
export function isLightGizmoVisible(uc) {
  if (!uc || uc.panorama || !isUniCanvasEnabled("shadowsLight")) return false;
  if (uc.harmonizeLightTarget?.()) return true;
  return uc.tool === PERSPECTIVE_TOOL || (uc.tool === "move" && Boolean(uc.activeLayer?.shadow));
}

/** The character the gizmo orbits: the Harmonize panel's layer, the active layer, or the source of an active shadow layer. */
function lightTargetLayer(uc) {
  const harmonized = uc.harmonizeLightTarget?.();
  if (harmonized) return harmonized;
  const active = uc.activeLayer;
  if (!active || active.type === "mask" || active.type === "group") return null;
  if (active.shadow?.sourceLayerId) return uc.layers.find((layer) => layer.id === active.shadow.sourceLayerId) || null;
  return active === backgroundLayer(uc) ? null : active;
}

/** Feet and radius of the gizmo, following a running move preview of the character. */
function lightGizmoGeometry(uc) {
  const layer = lightTargetLayer(uc);
  if (!layer) return null;
  const state = uc._scenePlace;
  const key = `${layer.id}:${layer.pixelRevision ?? 0}`;
  if (state.gizmoMeasure?.key !== key) state.gizmoMeasure = { key, measured: measureLayerCharacter(uc, layer) };
  const measured = state.gizmoMeasure.measured;
  if (!measured) return null;
  // Where the character shows: its scene-state offset (vnccs_unicanvas_states.mjs) included.
  const offset = typeof uc.getLayerStateOffset === "function" ? uc.getLayerStateOffset(layer) : null;
  let center = { x: measured.feet.x + (offset?.x || 0), y: measured.feet.y + (offset?.y || 0) };
  let height = measured.rect.height;
  const preview = uc.getLayerMovePreview(layer);
  if (preview) {
    const scale = preview.scale || 1;
    const anchor = preview.anchor || { x: 0, y: 0 };
    center = { x: anchor.x + (center.x - anchor.x) * scale + preview.dx, y: anchor.y + (center.y - anchor.y) * scale + preview.dy };
    height *= scale;
  }
  return { layer, center, radius: Math.max(24, height * 0.6) };
}

function drawSun(ctx, point, radius, fill, stroke, px) {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2 * px;
  ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < 8; i += 1) {
    const angle = i * Math.PI / 4;
    ctx.moveTo(point.x + Math.cos(angle) * radius * 1.45, point.y + Math.sin(angle) * radius * 1.45);
    ctx.lineTo(point.x + Math.cos(angle) * radius * 2, point.y + Math.sin(angle) * radius * 2);
  }
  ctx.stroke();
}

function drawLightGizmo(uc, ctx) {
  const geometry = lightGizmoGeometry(uc);
  if (!geometry) return;
  const { center, radius } = geometry;
  const light = lightState(uc);
  const px = 1 / uc.view.scale;
  const handle = sunHandlePosition(center, radius, light);
  ctx.save();
  ctx.lineWidth = 1.5 * px;
  ctx.strokeStyle = "rgba(255,209,102,.55)";
  ctx.setLineDash([6 * px, 5 * px]);
  ctx.beginPath(); ctx.ellipse(center.x, center.y, radius, radius * LIGHT_GIZMO_SQUASH, 0, 0, Math.PI * 2); ctx.stroke();
  const ghost = uc._scenePlace.lightGhost;
  if (ghost !== null && ghost !== undefined) {
    const proposed = sunHandlePosition(center, radius, { ...light, azimuth: ghost });
    ctx.strokeStyle = "#ff8fa3";
    ctx.beginPath(); ctx.arc(proposed.x, proposed.y, 9 * px, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.setLineDash([]);
  // The line from the sun's footprint through the feet is the direction shadows fall.
  ctx.strokeStyle = "#ffd166";
  ctx.beginPath(); ctx.moveTo(handle.x, handle.y); ctx.lineTo(center.x, center.y); ctx.stroke();
  drawSun(ctx, handle, 7 * px, light.color, "#ffd166", px);
  ctx.font = `${12 * px}px sans-serif`;
  ctx.fillStyle = "#ffd166";
  ctx.fillText(`${Math.round(light.azimuth)}° · ${Math.round(light.elevation)}°`, handle.x + 16 * px, handle.y - 8 * px);
  ctx.restore();
}

function hitLightHandle(uc, point) {
  const geometry = lightGizmoGeometry(uc);
  if (!geometry) return null;
  const handle = sunHandlePosition(geometry.center, geometry.radius, lightState(uc));
  return Math.hypot(point.x - handle.x, point.y - handle.y) <= Math.max(8, 14 / uc.view.scale) ? geometry : null;
}

function pushLightEdit(uc, before) {
  const after = clone(normalizeSceneLight(uc.sceneLight));
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  uc.pushHistoryEntry({ kind: SCENE_LIGHT_HISTORY_KIND, before, after });
  uc.syncLightStateToWidget();
  return true;
}

/** Applies a whole-value light edit as one history entry. */
export function editSceneLight(uc, mutate) {
  const before = clone(normalizeSceneLight(lightState(uc)));
  const next = clone(before);
  mutate(next);
  uc.sceneLight = normalizeSceneLight(next);
  const changed = pushLightEdit(uc, before);
  uc.renderToolSettings();
  uc.requestRender();
  return changed;
}

const LIGHT_SLIDERS = [
  { key: "azimuth", label: "Light azimuth", min: 0, max: 359, step: 1, unit: "°" },
  { key: "elevation", label: "Light elevation", min: LIGHT_MIN_ELEVATION, max: LIGHT_MAX_ELEVATION, step: 1, unit: "°" },
  { key: "intensity", label: "Light intensity", min: 0, max: 2, step: 0.01 },
  { key: "ambientIntensity", label: "Ambient intensity", min: 0, max: 2, step: 0.01 },
];
const LIGHT_COLORS = [
  { key: "color", label: "Light color" },
  { key: "ambientColor", label: "Ambient color" },
];

function formatLightValue(spec, value) {
  return spec.unit ? `${Math.round(value)}${spec.unit}` : Number(value).toFixed(2);
}

/** The scene light section of a tool-settings panel (Perspective tool and shadow controls). */
export function renderSceneLightControls(uc) {
  if (!isUniCanvasEnabled("shadowsLight")) return "";
  const light = lightState(uc);
  const state = uc._scenePlace;
  const html = [`<div class="vnccs-uc-tool-settings-title">Scene light</div>`];
  for (const spec of LIGHT_SLIDERS) {
    html.push(`<label class="vnccs-uc-tool-setting"><span class="vnccs-uc-tool-setting-label">${spec.label}</span><input class="vnccs-uc-range" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${light[spec.key]}" data-light-control="${spec.key}"><span class="vnccs-uc-tool-setting-value" data-light-value="${spec.key}">${formatLightValue(spec, light[spec.key])}</span></label>`);
  }
  for (const spec of LIGHT_COLORS) {
    html.push(`<label class="vnccs-uc-tool-setting"><span class="vnccs-uc-tool-setting-label">${spec.label}</span><input class="vnccs-uc-input" type="color" value="${light[spec.key]}" data-light-control="${spec.key}"></label>`);
  }
  html.push(`<div class="vnccs-uc-transform-actions"><button class="vnccs-uc-btn" type="button" data-scene-action="estimate-light" title="Propose the light azimuth from the brightness of the background around the character">Estimate light</button></div>`);
  if (state?.lightGhost !== null && state?.lightGhost !== undefined) {
    html.push(`<div class="vnccs-uc-transform-hint">Proposed light azimuth ${Math.round(state.lightGhost)}°</div>`);
    html.push(`<div class="vnccs-uc-transform-actions"><button class="vnccs-uc-btn" type="button" data-scene-action="accept-light" title="Use the proposed azimuth">Accept</button><button class="vnccs-uc-btn" type="button" data-scene-action="ignore-light" title="Keep the current light">Ignore</button></div>`);
  }
  html.push(`<div class="vnccs-uc-transform-hint">Drag the sun around the character: its angle sets the azimuth, closer to the feet is a higher sun</div>`);
  return html.join("");
}

/** Refreshes the light readouts (and the sliders not being dragged) without rebuilding the panel. */
function updateLightReadouts(uc, activeInput = null) {
  const panel = uc.toolSettings;
  if (!panel) return;
  const light = lightState(uc);
  for (const spec of LIGHT_SLIDERS) {
    const value = panel.querySelector(`[data-light-value="${spec.key}"]`);
    if (value) value.textContent = formatLightValue(spec, light[spec.key]);
    const input = panel.querySelector(`[data-light-control="${spec.key}"]`);
    if (input && input !== activeInput) input.value = String(light[spec.key]);
  }
}

/** Luminance of the blurred background around the character, on a small grid. */
function backgroundLuminance(uc, background, rect) {
  const region = { x: rect.x - rect.height, y: rect.y - rect.height * 0.5, width: rect.width + rect.height * 2, height: rect.height * 2 };
  const scale = LIGHT_ESTIMATE_SIDE / Math.max(region.width, region.height);
  const width = Math.max(3, Math.round(region.width * scale));
  const height = Math.max(3, Math.round(region.height * scale));
  const small = document.createElement("canvas");
  small.width = width; small.height = height;
  const smallCtx = small.getContext("2d");
  smallCtx.imageSmoothingQuality = "high";
  uc.drawRasterLayerToWorldRect(smallCtx, background, region, { x: 0, y: 0, width, height }, true, false);
  const blurred = document.createElement("canvas");
  blurred.width = width; blurred.height = height;
  const blurredCtx = blurred.getContext("2d", { willReadFrequently: true });
  blurredCtx.filter = "blur(2px)";
  blurredCtx.drawImage(small, 0, 0);
  const { data } = blurredCtx.getImageData(0, 0, width, height);
  const luminance = new Float32Array(width * height);
  for (let i = 0; i < luminance.length; i += 1) {
    const alpha = data[i * 4 + 3] / 255;
    luminance[i] = alpha * (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
  }
  return { luminance, width, height };
}

function estimateLight(uc) {
  const target = lightTargetLayer(uc);
  const measured = target ? measureLayerCharacter(uc, target) : null;
  if (!measured) {
    uc.setStatus("Estimate light: select a character layer with visible pixels.", true);
    return;
  }
  const background = backgroundLayer(uc);
  if (!background || background === target) {
    uc.setStatus("Estimate light: there is no background layer below the character.", true);
    return;
  }
  const grid = backgroundLuminance(uc, background, measured.rect);
  const azimuth = estimateLightAzimuth(grid.luminance, grid.width, grid.height);
  if (azimuth === null) {
    uc.setStatus("Estimate light: the background shows no dominant light direction; set it by hand.", true);
    return;
  }
  uc._scenePlace.lightGhost = azimuth;
  uc.setStatus(`Proposed light azimuth ${Math.round(azimuth)}°: Accept or Ignore.`);
  uc.renderToolSettings();
  uc.requestRender();
}

function startLightGesture(uc, e, geometry) {
  uc._scenePlace.lightGesture = {
    pointerId: e.pointerId,
    before: clone(normalizeSceneLight(lightState(uc))),
    center: { ...geometry.center },
    radius: geometry.radius,
  };
  uc.canvas.setPointerCapture?.(e.pointerId);
  uc.requestRender();
}

function installSceneLightControls(uc) {
  const state = uc._scenePlace;
  uc.toolSettings.addEventListener("input", (e) => {
    const target = e.target;
    const key = target?.dataset?.lightControl;
    if (!key) return;
    e.stopPropagation();
    // The first input of a gesture remembers the value before it; change commits one entry.
    if (!state.lightSlider) state.lightSlider = { before: clone(normalizeSceneLight(lightState(uc))) };
    const value = LIGHT_COLORS.some((spec) => spec.key === key) ? target.value : Number(target.value);
    uc.sceneLight = normalizeSceneLight({ ...lightState(uc), [key]: value });
    updateLightReadouts(uc, target);
    uc.requestRender();
  });
  uc.toolSettings.addEventListener("change", (e) => {
    if (!e.target?.dataset?.lightControl || !state.lightSlider) return;
    const { before } = state.lightSlider;
    state.lightSlider = null;
    pushLightEdit(uc, before);
  });
}

// ---------------------------------------------------------------------------
// Perspective tool gestures and panel.
// ---------------------------------------------------------------------------

function pushPerspectiveEdit(uc, before) {
  const after = clone(normalizeScenePerspective(uc.scenePerspective));
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  uc.pushHistoryEntry({ kind: SCENE_PERSPECTIVE_HISTORY_KIND, before, after });
  uc.syncLightStateToWidget();
  return true;
}

/** Applies a whole-value perspective edit as one history entry. */
export function editScenePerspective(uc, mutate) {
  const before = clone(normalizeScenePerspective(perspectiveState(uc)));
  const next = clone(before);
  mutate(next);
  uc.scenePerspective = normalizeScenePerspective(next);
  const changed = pushPerspectiveEdit(uc, before);
  refreshScenePlaceUi(uc);
  uc.requestRender();
  return changed;
}

/** A calibration figure standing at `feetY` whose head touches the horizon (an eye-level camera). */
function defaultReference(uc, horizonY) {
  const bottom = uc.bbox.y + uc.bbox.height;
  const feetY = Math.max(horizonY + 24, bottom - uc.bbox.height * 0.1);
  return { feetY, heightPx: feetY - horizonY, x: uc.bbox.x + uc.bbox.width / 2 };
}

function hitPerspective(uc, point) {
  const perspective = perspectiveState(uc);
  const threshold = Math.max(6, 10 / uc.view.scale);
  const figure = figureOf(uc, perspective);
  if (figure && Math.abs(point.x - figure.x) <= Math.max(threshold, figure.width / 2)) {
    if (Math.abs(point.y - figure.headY) <= threshold) return "figure-height";
    if (point.y >= figure.headY - threshold && point.y <= figure.feetY + threshold) return "figure-move";
  }
  if (perspective.horizonY !== null) {
    if (Math.hypot(point.x - vanishXOf(uc, perspective), point.y - perspective.horizonY) <= threshold * 1.2) return "vanish";
    if (Math.abs(point.y - perspective.horizonY) <= threshold) return "horizon";
  }
  return perspective.horizonY === null ? "create-horizon" : null;
}

function applyGesture(uc, gesture, point) {
  const p = uc.scenePerspective;
  const start = gesture.start;
  if (gesture.kind === "horizon" || gesture.kind === "create-horizon") {
    const limit = p.referenceHeight ? p.referenceHeight.feetY - 2 : Infinity;
    p.horizonY = Math.min(point.y, limit);
  } else if (gesture.kind === "vanish") {
    p.vanishX = point.x;
  } else if (gesture.kind === "figure-height") {
    p.referenceHeight = { ...p.referenceHeight, heightPx: Math.max(MIN_CHARACTER_HEIGHT, p.referenceHeight.feetY - point.y) };
  } else if (gesture.kind === "figure-move") {
    // Walking the figure keeps the calibration: its height follows the ground plane.
    const feetY = Math.max(point.y + gesture.grabOffsetY, p.horizonY + 2);
    const heightPx = expectedHeightAt(start, feetY) ?? start.referenceHeight.heightPx;
    p.referenceHeight = { feetY, heightPx: Math.max(MIN_CHARACTER_HEIGHT, heightPx), x: gesture.startFigureX + (point.x - gesture.startPoint.x) };
  }
}

function startPerspectiveGesture(uc, e) {
  const point = uc.worldFromEvent(e);
  const kind = hitPerspective(uc, point);
  if (!kind) return;
  const start = clone(normalizeScenePerspective(perspectiveState(uc)));
  const figure = figureOf(uc, start);
  const gesture = { kind, start, pointerId: e.pointerId, startPoint: point, startFigureX: figure?.x ?? point.x, grabOffsetY: figure ? figure.feetY - point.y : 0 };
  if (kind === "create-horizon") {
    uc.scenePerspective.horizonY = point.y;
    if (!uc.scenePerspective.referenceHeight) uc.scenePerspective.referenceHeight = defaultReference(uc, point.y);
    if (uc.scenePerspective.referenceHeight.feetY <= point.y) uc.scenePerspective.referenceHeight = defaultReference(uc, point.y);
  }
  uc._scenePlace.gesture = gesture;
  uc.canvas.setPointerCapture?.(e.pointerId);
  uc.requestRender();
}

function refreshScenePlaceUi(uc) {
  if (uc.tool === PERSPECTIVE_TOOL) uc.renderToolSettings();
  updateDepthScaleButton(uc);
}

function formatNumber(value) {
  return value === null || value === undefined ? "not set" : `${Math.round(value)}`;
}

function renderPerspectivePanel(uc) {
  const panel = uc.toolSettings;
  const perspective = perspectiveState(uc);
  const state = uc._scenePlace;
  const ref = perspective.referenceHeight;
  const button = (action, label, title, extra = "") => `<button class="vnccs-uc-btn" type="button" data-scene-action="${action}" title="${title}" ${extra}>${label}</button>`;
  const html = [
    `<div class="vnccs-uc-tool-settings-title">Perspective Settings</div>`,
    `<div class="vnccs-uc-transform-hint" data-scene-info>Horizon y: ${formatNumber(perspective.horizonY)} · Reference: ${ref ? `${Math.round(ref.heightPx)} px at y ${Math.round(ref.feetY)}` : "not set"}</div>`,
    `<div class="vnccs-uc-transform-actions">${[
      button("calibrate", "Calibrate from selected character", "Use the selected character's feet and height as the reference"),
      button("estimate", state.busy ? "Estimating..." : "Estimate from background", "Propose a horizon from a depth map of the background layer", state.busy ? "disabled" : ""),
      button("reset", "Reset", "Clear the horizon and the calibration"),
    ].join("")}</div>`,
  ];
  if (state.ghostY !== null && state.ghostY !== undefined) {
    html.push(`<div class="vnccs-uc-transform-hint">Proposed horizon at y ${Math.round(state.ghostY)}</div>`);
    html.push(`<div class="vnccs-uc-transform-actions">${button("accept", "Accept", "Use the proposed horizon")}${button("discard", "Discard", "Keep the current horizon")}</div>`);
  }
  html.push(`<div class="vnccs-uc-transform-hint">Drag the horizon line · the dot moves the vanishing point · figure feet: walk it along the ground · figure head: set its height</div>`);
  html.push(renderSceneLightControls(uc));
  panel.innerHTML = html.join("");
  panel.classList.add("visible");
}

function calibrateFromSelected(uc) {
  const layer = uc.activeLayer;
  const measured = layer && layer.type !== "mask" ? measureLayerCharacter(uc, layer) : null;
  if (!measured) {
    uc.setStatus("Calibrate: select a character layer with visible pixels.", true);
    return;
  }
  const heightPx = measured.rect.height / layerHeightFactor(layer);
  editScenePerspective(uc, (p) => {
    p.referenceHeight = { feetY: measured.feet.y, heightPx, x: measured.feet.x };
    // Without a horizon above the feet, assume an eye-level camera: the horizon at head height.
    if (p.horizonY === null || p.horizonY >= measured.feet.y - 1) p.horizonY = measured.feet.y - heightPx;
  });
  uc.setStatus(`Perspective calibrated: ${Math.round(heightPx)} px at y ${Math.round(measured.feet.y)}.`);
}

async function loadImage(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

/** The background layer's pixels (at most 1024 px on the long side) and their world rect. */
function backgroundImage(uc, layer) {
  const source = layerSource(uc, layer);
  if (!source) return null;
  const scale = Math.min(1, DEPTH_MAX_SIDE / Math.max(source.canvas.width, source.canvas.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.canvas.width * scale));
  canvas.height = Math.max(1, Math.round(source.canvas.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source.canvas, 0, 0, canvas.width, canvas.height);
  return { dataURL: canvas.toDataURL("image/png"), rect: source.rect, width: canvas.width, height: canvas.height };
}

/** Depth of the background layer, from the cache when its pixels did not change. */
export async function backgroundDepth(uc, layer) {
  const state = uc._scenePlace;
  const key = `${layer.id}:${layer.pixelRevision ?? 0}`;
  if (state.depthCache.has(key)) return state.depthCache.get(key);
  const image = backgroundImage(uc, layer);
  if (!image) throw new Error("the background layer is empty");
  const res = await fetch(DEPTH_ROUTE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: image.dataURL }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  const horizonY = finite(data.horizonY);
  const result = {
    depth: data.depth,
    width: data.width || image.width,
    height: data.height || image.height,
    rect: image.rect,
    horizonY: horizonY === null ? null : image.rect.y + horizonY * image.rect.height / (data.height || image.height),
  };
  for (const cached of state.depthCache.keys()) if (cached.startsWith(`${layer.id}:`)) state.depthCache.delete(cached);
  state.depthCache.set(key, result);
  return result;
}

/**
 * The cached depth of a layer's current pixels in rect-relative form, for a background asset
 * (vnccs_unicanvas_library.mjs): `{ depthDataURL, width, height, horizon }` with `horizon` a
 * fraction of the rect height (or null). Null when nothing is cached for these pixels.
 */
export function cachedBackgroundDepth(uc, layer) {
  const cached = layer && uc._scenePlace?.depthCache.get(`${layer.id}:${layer.pixelRevision ?? 0}`);
  if (!cached?.depth || !(cached.rect?.height > 0)) return null;
  return {
    depthDataURL: cached.depth, width: cached.width, height: cached.height,
    horizon: cached.horizonY === null ? null : (cached.horizonY - cached.rect.y) / cached.rect.height,
  };
}

/**
 * Seeds the depth cache of a layer's current pixels from a stored depth (see
 * cachedBackgroundDepth), so "Estimate from background" and occluders reuse it. `depthURL` is
 * where the stored depth PNG loads from. Returns true when the cache was seeded.
 */
export function seedBackgroundDepth(uc, layer, stored, depthURL) {
  const state = uc._scenePlace;
  const source = state && layerSource(uc, layer);
  const width = Number(stored?.width), height = Number(stored?.height), horizon = finite(stored?.horizon);
  if (!source || !depthURL || !(width > 0) || !(height > 0)) return false;
  for (const key of state.depthCache.keys()) if (key.startsWith(`${layer.id}:`)) state.depthCache.delete(key);
  state.depthCache.set(`${layer.id}:${layer.pixelRevision ?? 0}`, {
    depth: depthURL, width, height, rect: source.rect,
    horizonY: horizon === null ? null : source.rect.y + horizon * source.rect.height,
  });
  return true;
}

async function estimateFromBackground(uc) {
  const state = uc._scenePlace;
  const layer = backgroundLayer(uc);
  if (!layer) {
    uc.setStatus("Estimate: there is no visible background layer with pixels.", true);
    return;
  }
  const token = (state.estimateToken = Symbol("estimate"));
  state.busy = true;
  refreshScenePlaceUi(uc);
  uc.setStatus("[VNCCS UniCanvas] Estimating depth with Depth Anything V2 Small (first use downloads ~100 MB)...");
  try {
    const result = await backgroundDepth(uc, layer);
    if (state.estimateToken !== token) return; // a newer request owns the answer
    if (result.horizonY === null) {
      uc.setStatus("Estimate: the background shows no receding ground; set the horizon by hand.", true);
      return;
    }
    state.ghostY = result.horizonY;
    uc.setStatus(`Proposed horizon at y ${Math.round(result.horizonY)}: Accept or Discard.`);
  } catch (err) {
    if (state.estimateToken === token) uc.setStatus(`Estimate from background failed: ${err.message || err}`, true);
  } finally {
    if (state.estimateToken === token) {
      state.busy = false;
      refreshScenePlaceUi(uc);
      uc.requestRender();
    }
  }
}

function runSceneAction(uc, action) {
  const state = uc._scenePlace;
  if (action === "calibrate") calibrateFromSelected(uc);
  else if (action === "estimate") void estimateFromBackground(uc);
  else if (action === "reset") editScenePerspective(uc, (p) => Object.assign(p, { horizonY: null, vanishX: null, referenceHeight: null }));
  else if (action === "accept" && state.ghostY !== null && state.ghostY !== undefined) {
    const horizonY = state.ghostY;
    state.ghostY = null;
    editScenePerspective(uc, (p) => {
      p.horizonY = horizonY;
      if (!p.referenceHeight || p.referenceHeight.feetY <= horizonY + 2) p.referenceHeight = defaultReference(uc, horizonY);
    });
  } else if (action === "discard") {
    state.ghostY = null;
    refreshScenePlaceUi(uc);
    uc.requestRender();
  } else if (action === "estimate-light") estimateLight(uc);
  else if (action === "accept-light" && state.lightGhost !== null && state.lightGhost !== undefined) {
    const azimuth = state.lightGhost;
    state.lightGhost = null;
    editSceneLight(uc, (light) => { light.azimuth = azimuth; });
  } else if (action === "ignore-light") {
    state.lightGhost = null;
    uc.renderToolSettings();
    uc.requestRender();
  }
}

function updateDepthScaleButton(uc) {
  const button = uc._scenePlace?.depthButton;
  if (!button) return;
  const on = perspectiveState(uc).enabled;
  button.classList.toggle("active", on && !uc.panorama);
  button.setAttribute("aria-pressed", on && !uc.panorama ? "true" : "false");
  button.disabled = Boolean(uc.panorama);
  button.title = uc.panorama ? `Depth-scale: ${PANORAMA_TOOLTIP}` : "Depth-scale moves (characters rescale with the ground plane)";
}

function updatePanoramaAvailability(uc) {
  const tool = uc.tools?.querySelector(`[data-tool="${PERSPECTIVE_TOOL}"]`);
  if (tool) {
    tool.disabled = Boolean(uc.panorama);
    tool.title = uc.panorama ? `Perspective: ${PANORAMA_TOOLTIP}` : "Perspective (G)";
  }
  updateDepthScaleButton(uc);
  if (uc.panorama && uc.tool === PERSPECTIVE_TOOL) uc.setTool("move");
}

export function installUniCanvasScenePlace(uc) {
  if (!uc || uc._scenePlace) return uc;
  uc.scenePerspective = normalizeScenePerspective(uc.scenePerspective);
  uc.sceneLight = normalizeSceneLight(uc.sceneLight);
  uc._scenePlace = {
    gesture: null, ghostY: null, busy: false, depthCache: new Map(), estimateToken: null, depthButton: null,
    lightGesture: null, lightSlider: null, lightGhost: null, gizmoMeasure: null,
  };

  const toolButton = uc._toolButton(PERSPECTIVE_TOOL, "Perspective (G)");
  toolButton.innerHTML = PERSPECTIVE_ICON;
  const resizeButton = uc.tools.querySelector('[data-tool="resize"]');
  if (resizeButton) resizeButton.after(toolButton);
  else uc.tools.appendChild(toolButton);

  const depthButton = uc._button(DEPTH_SCALE_ICON, "vnccs-uc-icon vnccs-uc-depth-scale", () => {
    if (uc.panorama) return;
    const perspective = perspectiveState(uc);
    perspective.enabled = !perspective.enabled;
    if (perspective.enabled && !isPerspectiveCalibrated(perspective)) {
      uc.setStatus("Depth-scale is on: set the horizon and calibrate with the Perspective tool (G).");
    }
    updateDepthScaleButton(uc);
    uc.syncLightStateToWidget();
  }, "Depth-scale moves (characters rescale with the ground plane)");
  depthButton.dataset.sceneDepthScale = "true";
  uc._scenePlace.depthButton = depthButton;
  if (uc.snapBtn?.parentNode) uc.snapBtn.before(depthButton);
  updateDepthScaleButton(uc);

  const originalSetTool = uc.setTool;
  uc.setTool = (tool, ...rest) => {
    if (tool === PERSPECTIVE_TOOL && uc.panorama) {
      uc.setStatus(`Perspective: ${PANORAMA_TOOLTIP}.`, true);
      return [];
    }
    return Reflect.apply(originalSetTool, uc, [tool, ...rest]);
  };

  const originalRenderToolSettings = uc.renderToolSettings;
  uc.renderToolSettings = () => {
    Reflect.apply(originalRenderToolSettings, uc, []);
    if (uc.tool === PERSPECTIVE_TOOL && uc.toolSettings) renderPerspectivePanel(uc);
  };

  const originalUpdatePanoramaControls = uc.updatePanoramaControls;
  uc.updatePanoramaControls = (...args) => {
    Reflect.apply(originalUpdatePanoramaControls, uc, args);
    updatePanoramaAvailability(uc);
  };

  const originalDrawResizeOverlay = uc.drawResizeOverlay;
  uc.drawResizeOverlay = (ctx) => {
    Reflect.apply(originalDrawResizeOverlay, uc, [ctx]);
    drawScenePlaceOverlay(uc, ctx);
  };

  // Move tool: a depth-scaled drag replaces the plain offset preview and commit.
  const originalUpdateLayerMovePreview = uc.updateLayerMovePreview;
  uc.updateLayerMovePreview = (point) => {
    const start = uc.dragStart;
    // A group or multi-selection move (vnccs_unicanvas_groups.mjs) keeps its plain offset.
    if (start && start.depthScale === undefined) start.depthScale = depthScaleActive(uc) && !start.moveTargets ? beginDepthScale(uc, uc.activeLayer, start) : null;
    if (!start?.depthScale) return Reflect.apply(originalUpdateLayerMovePreview, uc, [point]);
    const placement = depthScalePlacement(perspectiveState(uc), start.depthScale, point, start.point);
    start.previewDx = placement.dx;
    start.previewDy = placement.dy;
    start.depthPlacement = placement;
  };
  const originalGetLayerMovePreview = uc.getLayerMovePreview;
  uc.getLayerMovePreview = (layer) => {
    const preview = Reflect.apply(originalGetLayerMovePreview, uc, [layer]);
    const placement = preview && uc.dragStart?.depthPlacement;
    return placement ? { ...preview, scale: placement.scale, anchor: placement.anchor } : preview;
  };
  const originalCommitActiveLayerMove = uc.commitActiveLayerMove;
  uc.commitActiveLayerMove = (dx, dy, allowExpand = true) => {
    const start = uc.dragStart;
    const layer = uc.activeLayer;
    if (start?.depthScale && start.depthPlacement && layer) return commitDepthScale(uc, layer, start.depthScale, start.depthPlacement, allowExpand);
    return Reflect.apply(originalCommitActiveLayerMove, uc, [dx, dy, allowExpand]);
  };

  // Perspective tool gestures run before the widget's own canvas handlers (capture on the stage).
  // The sun handle of the light gizmo wins over the perspective handles and the move tool.
  uc.stageWrap.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target !== uc.canvas || uc.panorama) return;
    const lightHit = isLightGizmoVisible(uc) ? hitLightHandle(uc, uc.worldFromEvent(e)) : null;
    if (!lightHit && uc.tool !== PERSPECTIVE_TOOL) return;
    e.preventDefault();
    e.stopPropagation();
    uc.canvas.focus?.({ preventScroll: true });
    if (lightHit) startLightGesture(uc, e, lightHit);
    else startPerspectiveGesture(uc, e);
  }, true);
  const onMove = (e) => {
    const light = uc._scenePlace.lightGesture;
    if (light && light.pointerId === e.pointerId) {
      e.preventDefault();
      e.stopPropagation();
      Object.assign(uc.sceneLight, lightFromHandle(light.center, light.radius, uc.worldFromEvent(e)));
      updateLightReadouts(uc);
      uc.requestRender();
      return;
    }
    const gesture = uc._scenePlace.gesture;
    if (!gesture || gesture.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    applyGesture(uc, gesture, uc.worldFromEvent(e));
    uc.requestRender();
    const info = uc.toolSettings?.querySelector("[data-scene-info]");
    if (info) {
      const p = uc.scenePerspective, ref = p.referenceHeight;
      info.textContent = `Horizon y: ${formatNumber(p.horizonY)} · Reference: ${ref ? `${Math.round(ref.heightPx)} px at y ${Math.round(ref.feetY)}` : "not set"}`;
    }
  };
  const onUp = (e) => {
    const light = uc._scenePlace.lightGesture;
    if (light && light.pointerId === e.pointerId) {
      e.preventDefault();
      e.stopPropagation();
      uc._scenePlace.lightGesture = null;
      uc.sceneLight = normalizeSceneLight(uc.sceneLight);
      pushLightEdit(uc, light.before);
      uc.requestRender();
      return;
    }
    const gesture = uc._scenePlace.gesture;
    if (!gesture || gesture.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    uc._scenePlace.gesture = null;
    uc.scenePerspective = normalizeScenePerspective(uc.scenePerspective);
    pushPerspectiveEdit(uc, gesture.start);
    refreshScenePlaceUi(uc);
    uc.requestRender();
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
  uc._scenePlaceDispose = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onUp, true);
  };

  uc.toolSettings.addEventListener("click", (e) => {
    const button = e.target?.closest?.("[data-scene-action]");
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    runSceneAction(uc, button.dataset.sceneAction);
  });
  installSceneLightControls(uc);
  return uc;
}

/** History hook: restores the perspective of a `scenePerspective` entry. */
export function applyScenePerspectiveHistory(uc, entry, direction) {
  uc.scenePerspective = normalizeScenePerspective(direction === "undo" ? entry.before : entry.after);
  if (uc._scenePlace) uc._scenePlace.ghostY = null;
  refreshScenePlaceUi(uc);
}

/** Serialize hook: the value restored from a saved state (old states get the defaults). */
export function restoreScenePerspective(uc, raw) {
  uc.scenePerspective = normalizeScenePerspective(raw);
  if (uc._scenePlace) {
    uc._scenePlace.ghostY = null;
    uc._scenePlace.depthCache.clear();
  }
  refreshScenePlaceUi(uc);
}

/** History hook: restores the light of a `sceneLight` entry. */
export function applySceneLightHistory(uc, entry, direction) {
  uc.sceneLight = normalizeSceneLight(direction === "undo" ? entry.before : entry.after);
  if (uc._scenePlace) uc._scenePlace.lightGhost = null;
  uc.renderToolSettings();
}

/** Serialize hook: the light restored from a saved state (old states get the default light). */
export function restoreSceneLight(uc, raw) {
  uc.sceneLight = normalizeSceneLight(raw);
  if (uc._scenePlace) uc._scenePlace.lightGhost = null;
}

/** Read-only view of the running depth-scaled drag for the E2E hook. */
export function describeDepthScaleDrag(uc) {
  const placement = uc.pointerMode === "layer-move" ? uc.dragStart?.depthPlacement : null;
  return placement ? { height: placement.height, scale: placement.scale, feet: { ...placement.feet } } : null;
}
