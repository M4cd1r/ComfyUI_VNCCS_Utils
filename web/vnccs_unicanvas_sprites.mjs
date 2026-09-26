/**
 * VNCCS UniCanvas sprite sets (Plan 03, issue #6).
 *
 * A sprite layer (`type: "sprite"`) holds a named set of pixel-aligned variants of one character
 * (expressions, outfits, poses) and shows one of them at a time. Every variant is stored at the
 * size of one shared world rect with one shared anchor, so switching never makes the character
 * jump.
 *
 *  - State: `layer.sprite = { schemaVersion, characterId, characterName, anchor, rect,
 *    activeVariantId, variants[], faceRect, sourceLayerId?, paintAll }`. `rect` is in world
 *    pixels, `anchor` and `faceRect` in rect space. A variant is `{ id, name, kind, prompt, seed,
 *    status, pixels (runtime canvas, rect size), createdAt, meta }`; ready variants serialize as
 *    `dataURL` crops.
 *  - `layer.canvas` is always the active variant drawn at `rect`, so every existing reader
 *    (render, flatten, export, generation composite, thumbnails) works unchanged. Paint lands in
 *    the canvas and is copied into the active variant whenever a pixel snapshot is taken
 *    (`syncFromCanvas`), so every tool that records a `layerPixels` entry edits the variant.
 *  - Variant canvases are never drawn into once stored: an edit replaces the canvas (copy on
 *    write), so history snapshots share them by reference.
 *  - A move only changes `rect`; a transform maps `rect`, `anchor`, `faceRect` and the other
 *    variants through the same frame.
 *  - Generation reuses the draw route with an inpaint mask: expressions repaint `faceRect` over the
 *    neutral variant and keep its alpha, outfits repaint the body and take their alpha from the
 *    background remover, re-anchored on the feet.
 *
 * The pure helpers at the top run under Node for tests; installUniCanvasSprites binds the
 * controller onto the widget like the other install* modules.
 */

import { alphaBounds, dilateAlpha } from "./vnccs_unicanvas_bake.mjs";
import { poseCharacterRef, poseStudioCharacters } from "./vnccs_unicanvas_pose_state.mjs";
import { resolveRemoveBgSelection, removeBgEditSettings } from "./vnccs_unicanvas_remove_bg.mjs";
import { autoAcceptedHistoryItem } from "./vnccs_unicanvas_history_gallery.mjs";
import { captureGroupStructure } from "./vnccs_unicanvas_groups.mjs";
import { installCustomSelects } from "./vnccs_custom_select.mjs";
import { createLayerMeta } from "./vnccs_unicanvas_provenance.mjs";
import { applyHomography, homographyFromUnitSquare, transformDraftBounds } from "./vnccs_unicanvas_transform.mjs";

export const SPRITE_LAYER_TYPE = "sprite";
export const SPRITE_SCHEMA_VERSION = 1;
export const SPRITE_VARIANT_HISTORY_KIND = "spriteVariant";
export const SPRITE_VARIANT_KINDS = Object.freeze(["expression", "outfit", "pose", "custom"]);
export const SPRITE_VARIANT_STATUSES = Object.freeze(["empty", "ready", "failed"]);
export const SPRITE_DRAW_ROUTE = "/vnccs/unicanvas/draw";
export const SPRITE_REMOVE_BG_ROUTE = "/vnccs/unicanvas/remove_bg";
// faceRect margin around a baked headRect, rect margin around the source alpha, and how much
// context around faceRect an expression request sees.
export const SPRITE_FACE_MARGIN = 0.15;
export const SPRITE_RECT_MARGIN = 0.04;
export const SPRITE_FACE_CONTEXT = 0.5;
export const NEUTRAL_VARIANT = "neutral";

export const SPRITE_EXPRESSION_PRESETS = Object.freeze([
  ["neutral", "a neutral, calm"],
  ["happy", "a happy"],
  ["laughing", "a laughing, open-mouthed"],
  ["smile closed eyes", "a gentle smile with closed eyes"],
  ["sad", "a sad"],
  ["crying", "a crying, tearful"],
  ["angry", "an angry"],
  ["annoyed", "an annoyed"],
  ["surprised", "a surprised"],
  ["shocked", "a shocked"],
  ["embarrassed", "an embarrassed, blushing"],
  ["thinking", "a thoughtful, thinking"],
  ["smug", "a smug"],
  ["scared", "a scared"],
  ["sleepy", "a sleepy, drowsy"],
].map(([name, phrase]) => Object.freeze({ name, phrase })));

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));
let idCounter = 0;
export const newVariantId = () => `var_${Date.now().toString(36)}_${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* ----------------------------------------------------------------------------------------------
 * Prompts
 * -------------------------------------------------------------------------------------------- */

export function expressionInstruction(phrase) {
  return `same character, same pose, only change the facial expression to ${phrase} expression, keep hair, clothes and lighting identical`;
}

export function outfitInstruction(text) {
  return `same character, same pose, same face, change the outfit: ${text}, keep the pose, proportions and lighting identical`;
}

/**
 * The positive prompt of one variant request. Edit families read an instruction; other families
 * inpaint, so they get a tag-style description built on the scene prompt.
 */
export function spriteVariantPrompt(sprite, variant, { editModel = false, basePrompt = "" } = {}) {
  const phrase = variant?.meta?.phrase;
  const base = String(basePrompt || "").trim();
  if (editModel) return String(variant?.prompt || (phrase ? expressionInstruction(phrase) : variant?.name || ""));
  const subject = sprite?.characterName ? `${sprite.characterName}, ` : "";
  const what = phrase ? `${phrase} facial expression` : String(variant?.meta?.text || variant?.prompt || variant?.name || "");
  return `${subject}${what}${base ? `, ${base}` : ""}`;
}

/* ----------------------------------------------------------------------------------------------
 * State
 * -------------------------------------------------------------------------------------------- */

const finite = (value) => Number.isFinite(Number(value)) && value !== null && value !== "";
const intRect = (rect) => rect && ["x", "y", "width", "height"].every((key) => finite(rect[key]))
  ? { x: Math.round(Number(rect.x)), y: Math.round(Number(rect.y)), width: Math.max(1, Math.round(Number(rect.width))), height: Math.max(1, Math.round(Number(rect.height))) }
  : null;

export function createSpriteVariant({ id = newVariantId(), name = "variant", kind = "custom", prompt = "", seed = null, status = "empty", pixels = null, createdAt = Date.now(), meta = undefined } = {}) {
  const variant = {
    id: String(id), name: String(name || "variant").slice(0, 80),
    kind: SPRITE_VARIANT_KINDS.includes(kind) ? kind : "custom",
    prompt: String(prompt || "").slice(0, 2000),
    seed: finite(seed) ? Number(seed) : null,
    status: SPRITE_VARIANT_STATUSES.includes(status) ? status : "empty",
    pixels, createdAt: finite(createdAt) ? Number(createdAt) : Date.now(),
  };
  if (meta && typeof meta === "object") variant.meta = clone(meta);
  return variant;
}

/** Additive schema: a malformed sprite reads as one empty neutral variant over a 1x1 rect. */
export function normalizeSpriteState(raw) {
  const rect = intRect(raw?.rect) || { x: 0, y: 0, width: 1, height: 1 };
  const variants = [];
  const seen = new Set();
  for (const item of Array.isArray(raw?.variants) ? raw.variants : []) {
    if (!item || typeof item !== "object" || !item.id || seen.has(String(item.id))) continue;
    seen.add(String(item.id));
    const variant = createSpriteVariant({ ...item, pixels: item.pixels || null });
    if (typeof item.dataURL === "string" && item.dataURL) variant.dataURL = item.dataURL;
    variants.push(variant);
  }
  if (!variants.length) variants.push(createSpriteVariant({ name: NEUTRAL_VARIANT, kind: "expression", meta: { phrase: SPRITE_EXPRESSION_PRESETS[0].phrase } }));
  const anchor = raw?.anchor && finite(raw.anchor.x) && finite(raw.anchor.y)
    ? { x: Number(raw.anchor.x), y: Number(raw.anchor.y) } : { x: rect.width / 2, y: rect.height };
  const active = variants.find((item) => item.id === raw?.activeVariantId) ? String(raw.activeVariantId) : variants[0].id;
  const sprite = {
    schemaVersion: SPRITE_SCHEMA_VERSION,
    characterId: typeof raw?.characterId === "string" && raw.characterId ? raw.characterId : null,
    characterName: String(raw?.characterName || "Character").slice(0, 120),
    anchor, rect, activeVariantId: active, variants,
    faceRect: intRect(raw?.faceRect) ? clampBox(intRect(raw.faceRect), rect.width, rect.height) : null,
    paintAll: raw?.paintAll === true,
  };
  if (typeof raw?.sourceLayerId === "string" && raw.sourceLayerId) sprite.sourceLayerId = raw.sourceLayerId;
  return sprite;
}

/** A copy that shares the variant canvases (they are never drawn into once stored). */
export function snapshotSprite(sprite) {
  if (!sprite) return null;
  return {
    ...sprite,
    rect: { ...sprite.rect }, anchor: { ...sprite.anchor },
    faceRect: sprite.faceRect ? { ...sprite.faceRect } : null,
    variants: sprite.variants.map((variant) => ({ ...variant, meta: variant.meta ? clone(variant.meta) : undefined })),
  };
}

/** Serializable metadata; `dataURLOf(variant)` adds each ready variant's pixels. */
export function serializeSpriteState(sprite, dataURLOf = null) {
  if (!sprite) return null;
  const out = {
    schemaVersion: SPRITE_SCHEMA_VERSION, characterId: sprite.characterId, characterName: sprite.characterName,
    anchor: { ...sprite.anchor }, rect: { ...sprite.rect }, activeVariantId: sprite.activeVariantId,
    faceRect: sprite.faceRect ? { ...sprite.faceRect } : null, paintAll: sprite.paintAll === true,
    variants: sprite.variants.map((variant) => {
      const item = { id: variant.id, name: variant.name, kind: variant.kind, prompt: variant.prompt, seed: variant.seed, status: variant.status, createdAt: variant.createdAt };
      if (variant.meta) item.meta = clone(variant.meta);
      const data = dataURLOf && variant.status === "ready" && variant.pixels ? dataURLOf(variant) : null;
      if (data) item.dataURL = data;
      return item;
    }),
  };
  if (sprite.sourceLayerId) out.sourceLayerId = sprite.sourceLayerId;
  return out;
}

export const readyVariants = (sprite) => (sprite?.variants || []).filter((variant) => variant.status === "ready" && variant.pixels);
export const missingVariants = (sprite) => (sprite?.variants || []).filter((variant) => variant.status !== "ready");
export const neutralVariant = (sprite) => (sprite?.variants || []).find((variant) => variant.name === NEUTRAL_VARIANT && variant.status === "ready" && variant.pixels)
  || readyVariants(sprite)[0] || null;

/** The ready variant `direction` steps from the active one, wrapping; null when there is none. */
export function cycleVariantId(sprite, direction = 1) {
  const list = readyVariants(sprite);
  if (!list.length) return null;
  const index = list.findIndex((variant) => variant.id === sprite.activeVariantId);
  const step = direction < 0 ? -1 : 1;
  return list[((index < 0 ? 0 : index + step) % list.length + list.length) % list.length].id;
}

/** Preset expressions as empty variants; names already in the set are skipped. */
export function presetExpressionVariants(sprite) {
  const names = new Set((sprite?.variants || []).map((variant) => variant.name));
  return SPRITE_EXPRESSION_PRESETS.filter((preset) => !names.has(preset.name)).map((preset) => createSpriteVariant({
    name: preset.name, kind: "expression", prompt: expressionInstruction(preset.phrase), meta: { phrase: preset.phrase },
  }));
}

export function customVariant({ name, kind = "custom", text = "" }) {
  const clean = String(text || "").trim();
  const prompt = kind === "outfit" ? outfitInstruction(clean) : clean;
  return createSpriteVariant({ name: String(name || "").trim() || kind, kind, prompt, meta: { text: clean } });
}

/* ----------------------------------------------------------------------------------------------
 * Geometry and pixels
 * -------------------------------------------------------------------------------------------- */

export function clampBox(box, width, height) {
  const x1 = Math.max(0, Math.min(width, Math.round(box.x))), y1 = Math.max(0, Math.min(height, Math.round(box.y)));
  const x2 = Math.max(x1, Math.min(width, Math.round(box.x + box.width))), y2 = Math.max(y1, Math.min(height, Math.round(box.y + box.height)));
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

export function unionBox(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export function containsBox(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

/**
 * The feet contact point in pixel space: the bottom of the alpha bbox, horizontally centred on
 * the opaque pixels of the lowest rows (`band` of the bbox height, at least 2 rows).
 */
export function detectSpriteAnchor(alpha, width, height, threshold = 16, band = 0.03) {
  const box = alphaBounds(alpha, width, height, threshold);
  if (!box) return { x: width / 2, y: height };
  const rows = Math.max(2, Math.round(box.height * band));
  let x1 = Infinity, x2 = -Infinity;
  for (let y = box.y + box.height - rows; y < box.y + box.height; y++) {
    if (y < 0) continue;
    const row = y * width;
    for (let x = box.x; x < box.x + box.width; x++) {
      if (alpha[row + x] <= threshold) continue;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
    }
  }
  const x = x2 < x1 ? box.x + box.width / 2 : (x1 + x2 + 1) / 2;
  return { x, y: box.y + box.height };
}

/** A baked headRect (world) grown by `margin`, in rect space and clamped to the rect. */
export function faceRectFromHead(headRect, rect, margin = SPRITE_FACE_MARGIN) {
  if (!headRect || !rect) return null;
  const dx = headRect.width * margin, dy = headRect.height * margin;
  const box = clampBox({ x: headRect.x - dx - rect.x, y: headRect.y - dy - rect.y, width: headRect.width + 2 * dx, height: headRect.height + 2 * dy }, rect.width, rect.height);
  return box.width > 1 && box.height > 1 ? box : null;
}

/** The request region around `region`: grown by `context` of its size, clamped to the rect. */
export function spriteWorkRegion(region, size, context = SPRITE_FACE_CONTEXT) {
  const dx = region.width * context, dy = region.height * context;
  return clampBox({ x: region.x - dx, y: region.y - dy, width: region.width + 2 * dx, height: region.height + 2 * dy }, size.width, size.height);
}

/**
 * A soft-edged rectangle mask: 255 deep inside `box`, ramping to 0 over `feather` pixels at its
 * edges, and exactly 0 everywhere outside `box`.
 */
export function featherMaskAlpha(width, height, box, feather = 8) {
  const out = new Uint8ClampedArray(width * height);
  if (!box) return out;
  const clamped = clampBox(box, width, height);
  const f = Math.max(1, feather);
  for (let y = clamped.y; y < clamped.y + clamped.height; y++) {
    const dy = Math.min(y + 0.5 - clamped.y, clamped.y + clamped.height - (y + 0.5));
    for (let x = clamped.x; x < clamped.x + clamped.width; x++) {
      const d = Math.min(dy, x + 0.5 - clamped.x, clamped.x + clamped.width - (x + 0.5));
      out[y * width + x] = Math.round(255 * Math.min(1, d / f));
    }
  }
  return out;
}

export const spriteFeather = (box) => Math.max(2, Math.round(0.12 * Math.min(box.width, box.height)));

/**
 * Expression composite (RGBA arrays of one size): the result's colours blend over the neutral
 * pixels by `mask`; pixels where the mask is 0 stay bit-identical and the alpha is always the
 * neutral alpha, so an expression can never change the silhouette.
 */
export function compositeExpressionPixels(neutral, result, mask) {
  const out = new Uint8ClampedArray(neutral);
  for (let pixel = 0; pixel < mask.length; pixel++) {
    const m = mask[pixel];
    if (!m) continue;
    const t = m / 255, offset = pixel * 4;
    for (let channel = 0; channel < 3; channel++) out[offset + channel] = Math.round(neutral[offset + channel] + (result[offset + channel] - neutral[offset + channel]) * t);
  }
  return out;
}

/**
 * Outfit composite: the result with its own (background-removed) alpha, except that the face
 * (`faceMask`) keeps the neutral pixels and alpha.
 */
export function compositeOutfitPixels(neutral, result, resultAlpha, faceMask = null) {
  const out = new Uint8ClampedArray(result.length);
  for (let pixel = 0; pixel < resultAlpha.length; pixel++) {
    const offset = pixel * 4;
    const t = faceMask ? faceMask[pixel] / 255 : 0;
    for (let channel = 0; channel < 3; channel++) out[offset + channel] = Math.round(result[offset + channel] + (neutral[offset + channel] - result[offset + channel]) * t);
    out[offset + 3] = Math.round(resultAlpha[pixel] + (neutral[offset + 3] - resultAlpha[pixel]) * t);
  }
  return out;
}

/** RGBA pixels moved by whole pixels (dx, dy); uncovered pixels are transparent. */
export function shiftPixels(data, width, height, dx, dy) {
  const sx = Math.round(dx), sy = Math.round(dy);
  if (!sx && !sy) return new Uint8ClampedArray(data);
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    const ty = y + sy;
    if (ty < 0 || ty >= height) continue;
    for (let x = 0; x < width; x++) {
      const tx = x + sx;
      if (tx < 0 || tx >= width) continue;
      const from = (y * width + x) * 4, to = (ty * width + tx) * 4;
      out[to] = data[from]; out[to + 1] = data[from + 1]; out[to + 2] = data[from + 2]; out[to + 3] = data[from + 3];
    }
  }
  return out;
}

export function alphaOf(data) {
  const out = new Uint8ClampedArray(data.length / 4);
  for (let pixel = 0; pixel < out.length; pixel++) out[pixel] = data[pixel * 4 + 3];
  return out;
}

/** Outfit mask: the neutral silhouette grown by `grow` pixels, minus the protected face. */
export function outfitMaskAlpha(neutralAlpha, width, height, faceMask, grow) {
  const body = dilateAlpha(neutralAlpha, width, height, grow);
  if (!faceMask) return body;
  for (let pixel = 0; pixel < body.length; pixel++) body[pixel] = Math.max(0, body[pixel] - faceMask[pixel]);
  return body;
}

/**
 * The world-space map of a transform draft, for points of the layer's stored pixels. Frames
 * without a mesh map exactly; a warp mesh maps through its bounds.
 */
export function transformPointMap(draft) {
  const offset = draft?.stateOffset || { x: 0, y: 0 };
  const sb = { ...draft.sourceBounds, x: draft.sourceBounds.x - offset.x, y: draft.sourceBounds.y - offset.y };
  const matrix = !draft.mesh && homographyFromUnitSquare(draft.quad);
  if (matrix) {
    return (point) => {
      const mapped = applyHomography(matrix, (point.x - sb.x) / Math.max(1e-6, sb.width), (point.y - sb.y) / Math.max(1e-6, sb.height));
      return { x: mapped.x - offset.x, y: mapped.y - offset.y };
    };
  }
  const shown = transformDraftBounds(draft) || draft.sourceBounds;
  const to = { x: shown.x - offset.x, y: shown.y - offset.y, width: shown.width, height: shown.height };
  return (point) => ({
    x: to.x + (point.x - sb.x) * to.width / Math.max(1e-6, sb.width),
    y: to.y + (point.y - sb.y) * to.height / Math.max(1e-6, sb.height),
  });
}

export function mapBox(map, box) {
  const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]].map(([x, y]) => map({ x, y }));
  const xs = corners.map((point) => point.x), ys = corners.map((point) => point.y);
  const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
  return { x, y, width: Math.max(1, Math.ceil(Math.max(...xs)) - x), height: Math.max(1, Math.ceil(Math.max(...ys)) - y) };
}

/** Which layers can become a sprite set, and why not. */
export function spriteSourceIssue(layer, { panorama = false } = {}) {
  if (!layer) return "Pick a layer first.";
  if (panorama) return "Sprite sets are not available in panorama documents.";
  if (layer.locked) return "Unlock the layer first.";
  if (layer.type === "raster") return layer.shadow ? "Shadow layers cannot become sprite sets." : null;
  if (layer.type !== "pose") return "Sprite sets are made from raster or baked pose layers.";
  const characters = poseStudioCharacters(layer.pose);
  if (characters.length !== 1) return "Split the characters to layers first: a sprite set holds one character.";
  const id = characters[0].id;
  const status = layer.pose?.bake?.characters?.[id]?.status;
  if (!layer.bakeParts?.[id]?.surface || !["baked", "stale"].includes(status)) return "Bake the character first (layer menu, Bake characters).";
  return null;
}

/* ----------------------------------------------------------------------------------------------
 * Browser controller
 * -------------------------------------------------------------------------------------------- */

const newSeed = () => Math.floor(Math.random() * 2 ** 32);

const SPRITE_PANEL_CSS = `
.vnccs-uc-sprite-panel { display:flex; flex-direction:column; gap:6px; padding:8px; border:1px solid var(--uc-border, rgba(255,255,255,.12)); border-radius:10px; background:rgba(255,255,255,.03); color:#e8e8f0; font-size:11px; }
.vnccs-uc-sprite-panel[hidden] { display:none; }
.vnccs-uc-sprite-title { display:flex; justify-content:space-between; gap:6px; font-weight:600; }
.vnccs-uc-sprite-title span { opacity:.7; font-weight:400; }
.vnccs-uc-sprite-grid { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:4px; max-height:220px; overflow:auto; }
.vnccs-uc-sprite-thumb { display:flex; flex-direction:column; align-items:center; gap:2px; padding:3px; border:1px solid transparent; border-radius:6px; background:rgba(0,0,0,.25); color:inherit; cursor:pointer; font-size:10px; min-width:0; }
.vnccs-uc-sprite-thumb canvas { width:100%; aspect-ratio:1; background:repeating-conic-gradient(#2a2a33 0% 25%, #1e1e26 0% 50%) 50% / 10px 10px; border-radius:4px; }
.vnccs-uc-sprite-thumb span { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-uc-sprite-thumb.active { border-color:#ff8fa3; }
.vnccs-uc-sprite-thumb.selected { outline:1px dashed rgba(255,255,255,.55); }
.vnccs-uc-sprite-thumb[data-status="empty"] canvas { opacity:.35; }
.vnccs-uc-sprite-thumb[data-status="failed"] span { color:#ff8a8a; }
.vnccs-uc-sprite-row { display:flex; gap:4px; flex-wrap:wrap; align-items:center; }
.vnccs-uc-sprite-row .vnccs-uc-btn { font-size:10px; padding:3px 6px; }
.vnccs-uc-sprite-face { position:relative; width:100%; touch-action:none; cursor:crosshair; }
.vnccs-uc-sprite-face canvas { width:100%; display:block; border-radius:6px; background:repeating-conic-gradient(#2a2a33 0% 25%, #1e1e26 0% 50%) 50% / 10px 10px; }
.vnccs-uc-sprite-custom { display:flex; flex-direction:column; gap:4px; }
.vnccs-uc-sprite-custom textarea { min-height:38px; resize:vertical; }
`;

export function installUniCanvasSprites(uc, { modelModule = () => null } = {}) {
  if (!uc || uc.sprites) return uc;
  let gestureToken = 0;
  let selectedVariantId = null;
  let panel = null;
  let faceDrag = null;
  let faceFrame = 0;
  const busy = new Set(); // variant ids being generated

  const isSprite = (layer) => layer?.type === SPRITE_LAYER_TYPE && Boolean(layer.sprite);
  const variantOf = (layer, id) => layer?.sprite?.variants.find((variant) => variant.id === id) || null;
  const activeVariant = (layer) => variantOf(layer, layer?.sprite?.activeVariantId);
  const createCanvas = (width, height) => uc._createCanvas(width, height);
  const findLayer = (id) => uc.layers.find((layer) => layer.id === id) || null;

  function copyCanvas(source) {
    const canvas = createCanvas(source.width, source.height);
    canvas.getContext("2d").drawImage(source, 0, 0);
    return canvas;
  }

  function readPixels(canvas) {
    return canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  }

  function canvasFromPixels(data, width, height) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(width, height);
    image.data.set(data);
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  function alphaCanvas(alpha, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0; pixel < alpha.length; pixel++) {
      data[pixel * 4] = data[pixel * 4 + 1] = data[pixel * 4 + 2] = 255;
      data[pixel * 4 + 3] = alpha[pixel];
    }
    return canvasFromPixels(data, width, height);
  }

  /** The rect region of the layer canvas (world pixels). */
  function cropRect(layer, rect = layer.sprite.rect) {
    const canvas = createCanvas(rect.width, rect.height);
    canvas.getContext("2d").drawImage(layer.canvas, rect.x - uc.origin.x, rect.y - uc.origin.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    return canvas;
  }

  function drawIntoLayer(layer, pixels) {
    const ctx = layer.canvas.getContext("2d");
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    const rect = layer.sprite.rect;
    if (pixels) ctx.drawImage(pixels, rect.x - uc.origin.x, rect.y - uc.origin.y, rect.width, rect.height);
    layer.hiresCanvas = null;
    layer.hiresRect = null;
  }

  /** Redraws `layer.canvas` from the active variant; the canvas is then in sync. */
  function drawActive(layer) {
    if (!isSprite(layer)) return;
    drawIntoLayer(layer, activeVariant(layer)?.pixels || null);
    uc.invalidateLayerCaches(layer);
    layer.sprite._syncedRevision = layer.pixelRevision;
  }

  function endPreview(layer, { render = true } = {}) {
    if (!layer?.sprite?._previewId) return;
    layer.sprite._previewId = null;
    drawActive(layer);
    if (render) uc.requestRender();
  }

  /** Grows the shared rect so it holds `box` (world); every variant is padded to the new size. */
  function growRect(layer, box) {
    const sprite = layer.sprite;
    const old = sprite.rect;
    const next = unionBox(old, box);
    if (containsBox(old, next)) return;
    const dx = old.x - next.x, dy = old.y - next.y;
    for (const variant of sprite.variants) {
      if (!variant.pixels) continue;
      const canvas = createCanvas(next.width, next.height);
      canvas.getContext("2d").drawImage(variant.pixels, dx, dy);
      variant.pixels = canvas;
    }
    sprite.anchor = { x: sprite.anchor.x + dx, y: sprite.anchor.y + dy };
    if (sprite.faceRect) sprite.faceRect = { ...sprite.faceRect, x: sprite.faceRect.x + dx, y: sprite.faceRect.y + dy };
    sprite.rect = next;
  }

  /**
   * Copies the layer canvas into the active variant when it changed since the last sync (paint,
   * eraser, fill, a transform...). Paint outside the rect grows the rect.
   */
  function syncFromCanvas(layer) {
    if (!isSprite(layer)) return;
    if (layer.sprite._previewId) { endPreview(layer); return; }
    if (layer.sprite._syncedRevision === layer.pixelRevision) return;
    const active = activeVariant(layer);
    if (!active) return;
    const crop = uc.getLayerAlphaBounds(layer);
    if (crop) growRect(layer, { x: crop.x + uc.origin.x, y: crop.y + uc.origin.y, width: crop.width, height: crop.height });
    active.pixels = cropRect(layer);
    active.status = "ready";
    layer.sprite._syncedRevision = layer.pixelRevision;
  }

  function refresh(layer, { sync = true } = {}) {
    uc.refreshLayerRow?.(layer.id);
    renderPanel();
    uc.requestRender();
    if (sync) uc.syncToNode?.();
  }

  /**
   * One undoable change of the sprite state (variants, faceRect, ...): a layerPixels entry.
   * `decorate` may extend the entry (an accepted staged result carries its history item).
   */
  function commitChange(layer, mutate, decorate = (entry) => entry) {
    const before = uc.createLayerPixelSnapshot(layer);
    const result = mutate();
    if (result === false) return false;
    uc.pushHistoryEntry(decorate({ kind: "layerPixels", layerId: layer.id, before, after: uc.createLayerPixelSnapshot(layer) }));
    refresh(layer);
    return true;
  }

  /* ---------------- Switching ---------------- */

  function setActiveVariant(layer, id, { record = true } = {}) {
    if (!isSprite(layer)) return false;
    const variant = variantOf(layer, id);
    if (!variant?.pixels || variant.status !== "ready") {
      uc.setStatus(`${variant?.name || "This variant"} has no pixels yet: generate it first.`, true);
      return false;
    }
    endPreview(layer, { render: false });
    syncFromCanvas(layer);
    const before = layer.sprite.activeVariantId;
    if (before === id) return true;
    layer.sprite.activeVariantId = id;
    drawActive(layer);
    if (record) uc.pushHistoryEntry({ kind: SPRITE_VARIANT_HISTORY_KIND, layerId: layer.id, before, after: id });
    selectedVariantId = id;
    refresh(layer);
    return true;
  }

  function applyVariantHistory(entry, direction) {
    const layer = findLayer(entry.layerId);
    if (!isSprite(layer)) return;
    const id = direction === "undo" ? entry.before : entry.after;
    if (!variantOf(layer, id)?.pixels) return;
    endPreview(layer, { render: false });
    syncFromCanvas(layer);
    layer.sprite.activeVariantId = id;
    drawActive(layer);
    uc.activeLayerId = layer.id;
    renderPanel();
  }

  /** `,` / `.`: the previous / next ready variant of the active sprite layer. */
  function cycleActive(direction) {
    const layer = uc.activeLayer;
    if (!isSprite(layer) || layer.locked) return false;
    const id = cycleVariantId(layer.sprite, direction);
    if (!id) return false;
    if (id !== layer.sprite.activeVariantId) setActiveVariant(layer, id);
    uc.setStatus(`Sprite: ${variantOf(layer, id)?.name}`);
    return true;
  }

  /** Hovering a thumbnail shows that variant on the canvas without changing the active one. */
  function preview(layer, id) {
    if (!isSprite(layer) || uc.drawInProgress || uc.transformDraft || uc.isPointerDown) return;
    const variant = variantOf(layer, id);
    if (!variant?.pixels || variant.status !== "ready") { endPreview(layer); return; }
    if (id === layer.sprite.activeVariantId) { endPreview(layer); return; }
    if (!layer.sprite._previewId) syncFromCanvas(layer);
    layer.sprite._previewId = id;
    drawIntoLayer(layer, variant.pixels);
    uc.invalidateLayerRenderCaches(layer);
    layer._boundsCache = undefined;
    uc.requestRender();
  }

  /* ---------------- Geometry hooks ---------------- */

  /** A move of the layer's pixels (single or group move): only the rect moves. */
  function onMove(layer, source, dx, dy) {
    if (!isSprite(layer)) return;
    source._spriteRect ||= { ...layer.sprite.rect };
    layer.sprite.rect = { ...source._spriteRect, x: source._spriteRect.x + Math.round(dx), y: source._spriteRect.y + Math.round(dy) };
  }

  /** An applied transform: the rect, anchor, faceRect and the other variants follow the frame. */
  function onTransform(layer, draft) {
    if (!isSprite(layer) || !draft?.sourceCanvas || !draft.quad) return;
    const sprite = layer.sprite;
    const old = sprite.rect;
    const map = transformPointMap(draft);
    const next = mapBox(map, old);
    const offset = draft.stateOffset || { x: 0, y: 0 };
    const sb = { ...draft.sourceBounds, x: draft.sourceBounds.x - offset.x, y: draft.sourceBounds.y - offset.y };
    const scale = draft.sourceCanvas.width / Math.max(1, sb.width);
    for (const variant of sprite.variants) {
      if (!variant.pixels || variant.id === sprite.activeVariantId) continue;
      const source = createCanvas(draft.sourceCanvas.width, draft.sourceCanvas.height);
      source.getContext("2d").drawImage(variant.pixels, (old.x - sb.x) * scale, (old.y - sb.y) * scale, old.width * scale, old.height * scale);
      const out = createCanvas(next.width, next.height);
      const ctx = out.getContext("2d");
      ctx.translate(-(next.x + offset.x), -(next.y + offset.y));
      uc.drawTransformDraft(ctx, { ...draft, sourceCanvas: source }, 48);
      variant.pixels = out;
    }
    const anchor = map({ x: old.x + sprite.anchor.x, y: old.y + sprite.anchor.y });
    sprite.anchor = { x: anchor.x - next.x, y: anchor.y - next.y };
    if (sprite.faceRect) {
      const face = mapBox(map, { ...sprite.faceRect, x: old.x + sprite.faceRect.x, y: old.y + sprite.faceRect.y });
      sprite.faceRect = clampBox({ ...face, x: face.x - next.x, y: face.y - next.y }, next.width, next.height);
    }
    sprite.rect = next;
    // The active variant is copied from the transformed canvas by the history snapshot.
    sprite._syncedRevision = null;
  }

  /** "Paint on all variants": brush and eraser strokes replay on every other ready variant. */
  function onStroke(layer, start, end, { size, opacity, color, erase }) {
    if (!isSprite(layer) || !layer.sprite.paintAll) return;
    const sprite = layer.sprite;
    for (const variant of sprite.variants) {
      if (!variant.pixels || variant.status !== "ready" || variant.id === sprite.activeVariantId) continue;
      if (variant._cow !== gestureToken) { variant.pixels = copyCanvas(variant.pixels); variant._cow = gestureToken; }
      const ctx = variant.pixels.getContext("2d");
      ctx.save();
      ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = size; ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
      ctx.strokeStyle = erase ? "#000" : color;
      ctx.beginPath();
      ctx.moveTo(start.x - sprite.rect.x, start.y - sprite.rect.y);
      ctx.lineTo(end.x - sprite.rect.x, end.y - sprite.rect.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ---------------- History and persistence ---------------- */

  function snapshot(layer) {
    if (!isSprite(layer)) return {};
    gestureToken++;
    return { sprite: snapshotSprite(layer.sprite) };
  }

  function restoreSnapshot(layer, stored) {
    if (layer?.type !== SPRITE_LAYER_TYPE || !stored?.sprite) return;
    layer.sprite = snapshotSprite(stored.sprite);
    layer.sprite._previewId = null;
    // The snapshot's canvas crop is the active variant it was taken with.
    layer.sprite._syncedRevision = layer.pixelRevision;
    if (uc.activeLayerId === layer.id) renderPanel();
  }

  function cloneLayerFields(layer) {
    return isSprite(layer) ? { sprite: snapshotSprite(layer.sprite) } : {};
  }

  function serialize(layer, includeData = true) {
    if (!isSprite(layer)) return undefined;
    if (includeData) syncFromCanvas(layer);
    return serializeSpriteState(layer.sprite, includeData ? (variant) => variant.pixels.toDataURL("image/png") : null);
  }

  async function restore(layer, stored) {
    const sprite = normalizeSpriteState(stored);
    for (const variant of sprite.variants) {
      if (variant.dataURL) {
        try {
          const image = await uc.loadImage(variant.dataURL);
          const canvas = createCanvas(sprite.rect.width, sprite.rect.height);
          canvas.getContext("2d").drawImage(image, 0, 0, sprite.rect.width, sprite.rect.height);
          variant.pixels = canvas;
        } catch (_) { variant.pixels = null; }
        delete variant.dataURL;
      }
    }
    layer.sprite = sprite;
    const active = activeVariant(layer);
    // Metadata-only states (the node widget) take the active variant from the saved layer pixels.
    if (active && !active.pixels) active.pixels = cropRect(layer);
    for (const variant of sprite.variants) if (variant.status === "ready" && !variant.pixels) variant.status = "empty";
    sprite._syncedRevision = null;
  }

  /* ---------------- Creation ---------------- */

  function sourcePixels(layer) {
    if (layer.type === "pose") {
      const [character] = poseStudioCharacters(layer.pose);
      const part = layer.bakeParts[character.id];
      const entry = layer.pose.bake.characters[character.id] || {};
      const rect = layer.pose.rect;
      const dx = rect.x - part.anchor.x, dy = rect.y - part.anchor.y;
      const at = { x: part.rect.x + dx, y: part.rect.y + dy, width: part.rect.width, height: part.rect.height };
      const box = { x: Math.floor(at.x), y: Math.floor(at.y), width: Math.max(1, Math.round(at.width)), height: Math.max(1, Math.round(at.height)) };
      const canvas = createCanvas(box.width, box.height);
      canvas.getContext("2d").drawImage(part.surface, at.x - box.x, at.y - box.y, at.width, at.height);
      const shift = (value) => value && { ...value, x: value.x + dx, y: value.y + dy };
      return {
        canvas, box, character,
        headRect: shift(entry.headRect), feetPoint: shift(entry.feetPoint),
        ref: poseCharacterRef(layer, character.id),
      };
    }
    const crop = uc.getLayerAlphaBounds(layer);
    if (!crop) return null;
    const canvas = createCanvas(crop.width, crop.height);
    canvas.getContext("2d").drawImage(layer.canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return { canvas, box: { x: crop.x + uc.origin.x, y: crop.y + uc.origin.y, width: crop.width, height: crop.height }, character: null };
  }

  /** Layer menu "Create sprite set": raster or baked single-character pose layer. */
  function createFromLayer(layer) {
    const issue = spriteSourceIssue(layer, { panorama: Boolean(uc.panorama) });
    if (issue) { uc.setStatus(issue, true); return null; }
    if (uc.transformDraft) { uc.setStatus("Apply or cancel the active transform first", true); return null; }
    uc.poseEditor?.commit?.();
    if (uc.tool === "pose") uc.finishPoseEdit?.(true);
    const source = sourcePixels(layer);
    const alpha = source && alphaOf(readPixels(source.canvas));
    const tight = source && alphaBounds(alpha, source.canvas.width, source.canvas.height);
    if (!tight) { uc.setStatus("The layer has no visible pixels.", true); return null; }
    const mx = Math.round(tight.width * SPRITE_RECT_MARGIN), my = Math.round(tight.height * SPRITE_RECT_MARGIN);
    const rect = { x: source.box.x + tight.x - mx, y: source.box.y + tight.y - my, width: tight.width + 2 * mx, height: tight.height + 2 * my };
    if (!uc.ensureWorldBounds(rect.x, rect.y, 0, true) || !uc.ensureWorldBounds(rect.x + rect.width, rect.y + rect.height, 0, true)) {
      uc.setStatus("The sprite does not fit the canvas.", true);
      return null;
    }
    const neutral = createCanvas(rect.width, rect.height);
    neutral.getContext("2d").drawImage(source.canvas, source.box.x - rect.x, source.box.y - rect.y);
    const anchor = source.feetPoint
      ? { x: source.feetPoint.x - rect.x, y: source.feetPoint.y - rect.y }
      : detectSpriteAnchor(alphaOf(readPixels(neutral)), rect.width, rect.height);
    const name = source.character?.name || layer.meta?.character?.name || layer.name || "Character";
    const variant = createSpriteVariant({ name: NEUTRAL_VARIANT, kind: "expression", status: "ready", pixels: neutral,
      prompt: expressionInstruction(SPRITE_EXPRESSION_PRESETS[0].phrase), meta: { phrase: SPRITE_EXPRESSION_PRESETS[0].phrase } });
    const sprite = normalizeSpriteState({
      characterId: source.character?.id || layer.meta?.character?.id || null, characterName: name,
      anchor, rect, activeVariantId: variant.id, variants: [], sourceLayerId: layer.id,
      faceRect: source.headRect ? faceRectFromHead(source.headRect, rect) : null,
    });
    sprite.variants = [variant];
    sprite.activeVariantId = variant.id;
    if (source.ref) sprite._ref = source.ref;

    const structureBefore = captureGroupStructure(uc.layers);
    const activeBefore = uc.activeLayerId;
    const character = source.character ? { id: source.character.id, name } : layer.meta?.character;
    const spriteLayer = uc.addLayer(SPRITE_LAYER_TYPE, `${name} sprites`, false, true,
      createLayerMeta("sprite", { derivedFrom: layer.id, ...(character ? { character } : {}) }));
    spriteLayer.sprite = sprite;
    spriteLayer.groupId = layer.groupId || null;
    // The sprite lands right above its source, in the source's group.
    uc.layers = uc.layers.filter((item) => item !== spriteLayer);
    uc.layers.splice(Math.max(0, uc.layers.indexOf(layer)), 0, spriteLayer);
    uc.normalizeLayerOrder();
    drawActive(spriteLayer);
    const hide = layer.visible !== false;
    layer.visible = false;
    uc.pushHistoryEntry({ kind: "historyGroup", entries: [
      { kind: "groupStructure", before: structureBefore, after: captureGroupStructure(uc.layers), activeBefore, activeAfter: spriteLayer.id },
      ...(hide ? [{ kind: "layerProps", layerId: layer.id, before: { visible: true }, after: { visible: false } }] : []),
    ] });
    uc.activeLayerId = spriteLayer.id;
    uc.selectedLayerIds = [spriteLayer.id];
    selectedVariantId = variant.id;
    uc.syncActiveLayerControls?.();
    uc.renderLayerList();
    uc.requestRender();
    uc.syncToNode?.();
    uc.setStatus(sprite.faceRect ? `Sprite set created for ${name}.` : `Sprite set created for ${name}: drag the face area in the sprite panel before generating expressions.`);
    return spriteLayer;
  }

  /** Layer menu "Split variant to layer": the active variant as a new raster layer. */
  function splitVariantToLayer(layer) {
    if (!isSprite(layer)) return null;
    syncFromCanvas(layer);
    const variant = activeVariant(layer);
    if (!variant?.pixels) return null;
    const structureBefore = captureGroupStructure(uc.layers);
    const activeBefore = uc.activeLayerId;
    const copy = uc.addLayer("raster", `${layer.sprite.characterName} ${variant.name}`, false, true,
      createLayerMeta("split", { derivedFrom: layer.id, ...(layer.meta?.character ? { character: layer.meta.character } : {}) }));
    copy.groupId = layer.groupId || null;
    uc.layers = uc.layers.filter((item) => item !== copy);
    uc.layers.splice(Math.max(0, uc.layers.indexOf(layer)), 0, copy);
    uc.normalizeLayerOrder();
    const rect = layer.sprite.rect;
    copy.canvas.getContext("2d").drawImage(variant.pixels, rect.x - uc.origin.x, rect.y - uc.origin.y);
    uc.invalidateLayerCaches(copy);
    uc.pushHistoryEntry({ kind: "groupStructure", before: structureBefore, after: captureGroupStructure(uc.layers), activeBefore, activeAfter: copy.id });
    uc.activeLayerId = copy.id;
    uc.selectedLayerIds = [copy.id];
    uc.syncActiveLayerControls?.();
    uc.renderLayerList();
    uc.requestRender();
    uc.syncToNode?.();
    uc.setStatus(`Copied ${variant.name} to a new layer.`);
    return copy;
  }

  /* ---------------- Generation ---------------- */

  function referenceImage(layer) {
    const ref = layer.sprite._ref || (() => {
      const source = findLayer(layer.sprite.sourceLayerId);
      return source?.type === "pose" ? poseCharacterRef(source, layer.sprite.characterId) : null;
    })();
    if (ref?.source === "upload" && typeof ref.dataURL === "string") return ref.dataURL;
    if (ref?.source === "layer") {
      const target = findLayer(ref.layerId);
      const crop = target?.canvas ? uc.getLayerAlphaBounds(target) : null;
      if (crop) return uc.cloneCanvasCrop(target.canvas, crop).toDataURL("image/png");
    }
    return null;
  }

  async function removeBackground(canvas) {
    const { method, editModel } = resolveRemoveBgSelection(uc.settings);
    const resolved = method === "sam3" ? "birefnet" : method;
    const res = await fetch(SPRITE_REMOVE_BG_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: resolved, edit_model: editModel, edit_settings: resolved === "edit" ? removeBgEditSettings(uc.settings, editModel) : undefined, image: canvas.toDataURL("image/png") }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Remove background HTTP ${res.status}`);
    const image = await uc.loadImage(data.alpha || data.image);
    const out = createCanvas(canvas.width, canvas.height);
    out.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = readPixels(out);
    const alpha = alphaOf(pixels);
    if (alpha.every((value) => value >= 250)) for (let pixel = 0; pixel < alpha.length; pixel++) alpha[pixel] = pixels[pixel * 4];
    return alpha;
  }

  /** One variant request (batch results), composited over neutral. Nothing is applied yet. */
  async function requestVariant(layer, variantId, { seed = newSeed(), batch = 1 } = {}) {
    const sprite = layer.sprite;
    const variant = variantOf(layer, variantId);
    if (!variant) throw new Error("The variant no longer exists.");
    const neutral = neutralVariant(sprite);
    if (!neutral?.pixels) throw new Error("The sprite set has no neutral variant.");
    const size = { width: sprite.rect.width, height: sprite.rect.height };
    const outfit = variant.kind === "outfit" || variant.kind === "pose";
    if (!outfit && !sprite.faceRect) throw new Error("Drag the face area in the sprite panel first.");
    const region = outfit ? { x: 0, y: 0, ...size } : sprite.faceRect;
    const work = outfit ? region : spriteWorkRegion(region, size);
    const world = { x: sprite.rect.x + work.x, y: sprite.rect.y + work.y, width: work.width, height: work.height };
    const inference = uc.getInferenceSize(world);
    const neutralData = readPixels(neutral.pixels);
    const neutralAlpha = alphaOf(neutralData);
    const face = sprite.faceRect ? featherMaskAlpha(size.width, size.height, sprite.faceRect, spriteFeather(sprite.faceRect)) : null;
    const mask = outfit
      ? outfitMaskAlpha(neutralAlpha, size.width, size.height, face, Math.max(2, Math.round(0.03 * Math.max(size.width, size.height))))
      : featherMaskAlpha(size.width, size.height, region, spriteFeather(region));
    const image = createCanvas(inference.width, inference.height);
    const imageCtx = image.getContext("2d");
    imageCtx.fillStyle = "#ffffff";
    imageCtx.fillRect(0, 0, image.width, image.height);
    imageCtx.drawImage(neutral.pixels, work.x, work.y, work.width, work.height, 0, 0, image.width, image.height);
    const maskImage = createCanvas(inference.width, inference.height);
    maskImage.getContext("2d").drawImage(alphaCanvas(mask, size.width, size.height), work.x, work.y, work.width, work.height, 0, 0, maskImage.width, maskImage.height);
    const module = modelModule(uc.settings.generation_mode) || null;
    const editModel = Boolean(module?.isEditModel);
    const settings = uc.makeSettingsPayload();
    settings.positive = spriteVariantPrompt(sprite, variant, { editModel, basePrompt: uc.settings.positive });
    settings.seed = seed;
    settings.seed_mode = "fixed";
    settings.batch_size = Math.max(1, Math.min(8, Math.round(Number(batch) || 1)));
    if (editModel) {
      settings.denoise = 1;
      const ref = referenceImage(layer);
      // The working image is Picture 1; the character reference goes in as Picture 2.
      if (ref) settings.edit_reference_images = [ref];
    }
    delete settings.queued_draw;
    delete settings.draw_id;
    // History (vnccs_unicanvas_history_gallery.mjs): the caller finishes the run with its results.
    const historyRun = uc.generationHistory?.beginRun("sprite", {
      settings, bbox: world, mode: "sprite", inferenceSize: inference, outputSize: { width: Math.max(64, work.width), height: Math.max(64, work.height) },
      targetLayerId: layer.id, imageCanvas: image, maskCanvas: maskImage,
      params: { variantId: String(variantId), variant: variant.name, kind: variant.kind, batch: settings.batch_size },
    }) || null;
    try {
      const res = await fetch(SPRITE_DRAW_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "inpaint", image: image.toDataURL("image/png"), mask: maskImage.toDataURL("image/png"), source_empty: false,
          bbox: world, inference_size: inference, output_size: { width: Math.max(64, work.width), height: Math.max(64, work.height) },
          debug_id: `sprite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, settings,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      const images = Array.isArray(data.images) && data.images.length ? data.images : [data.image].filter(Boolean);
      if (!images.length) throw new Error("The generation returned no images.");
      if (!uc.layers.includes(layer) || !variantOf(layer, variantId)) throw new Error("The sprite layer changed while generating.");
      const results = [];
      for (const item of images) {
        const loaded = await uc.loadImage(uc.resultImageURL(item));
        const full = copyCanvas(neutral.pixels);
        const fullCtx = full.getContext("2d");
        fullCtx.clearRect(work.x, work.y, work.width, work.height);
        if (outfit) { fullCtx.fillStyle = "#ffffff"; fullCtx.fillRect(work.x, work.y, work.width, work.height); }
        fullCtx.drawImage(loaded, work.x, work.y, work.width, work.height);
        let pixels;
        if (outfit) {
          // Remove background switched off (Settings > VNCCS > UniCanvas): the outfit mask (the neutral
          // silhouette grown a little) cuts instead.
          const alpha = (await removeBackground(full)) ?? mask;
          pixels = compositeOutfitPixels(neutralData, readPixels(full), alpha, face);
          const anchor = detectSpriteAnchor(alphaOf(pixels), size.width, size.height);
          pixels = shiftPixels(pixels, size.width, size.height, sprite.anchor.x - anchor.x, sprite.anchor.y - anchor.y);
        } else {
          pixels = compositeExpressionPixels(neutralData, readPixels(full), mask);
        }
        results.push({ pixels: canvasFromPixels(pixels, size.width, size.height), seed: Number.isFinite(item?.seed) ? item.seed : seed });
      }
      return { results, rect: { ...sprite.rect }, inference, prompt: settings.positive, historyRun };
    } catch (error) {
      historyRun?.fail(error);
      throw error;
    }
  }

  function applyVariant(layer, variantId, result, prompt) {
    const variant = variantOf(layer, variantId);
    if (!variant) return false;
    if (result.pixels.width !== layer.sprite.rect.width || result.pixels.height !== layer.sprite.rect.height) return false;
    variant.pixels = result.pixels;
    variant.status = "ready";
    variant.seed = result.seed;
    if (variant.meta?.error) delete variant.meta.error;
    if (prompt) variant.meta = { ...(variant.meta || {}), lastPrompt: String(prompt).slice(0, 2000) };
    if (variant.id === layer.sprite.activeVariantId) drawActive(layer);
    return true;
  }

  function markFailed(layer, variantId, error) {
    const variant = variantOf(layer, variantId);
    if (!variant) return;
    if (variant.status !== "ready") variant.status = "failed";
    variant.meta = { ...(variant.meta || {}), error: String(error?.message || error).slice(0, 400) };
  }

  function progress(message, value) {
    uc.updateGenerationProgress?.({ progress: value, message }, true);
  }

  function lockDraw(on) {
    uc.drawInProgress = on;
    if (uc.drawBtn) uc.drawBtn.disabled = on;
  }

  /** Per-variant Generate / Regenerate: batch results are staged in place over the sprite. */
  async function stageVariant(layer, variantId, { regenerate = false } = {}) {
    if (!isSprite(layer) || uc.drawInProgress || busy.has(variantId)) return;
    if (layer.locked) { uc.setStatus("Unlock the sprite layer first.", true); return; }
    const variant = variantOf(layer, variantId);
    if (!variant) return;
    endPreview(layer);
    syncFromCanvas(layer);
    const randomize = regenerate || (uc.settings.seed_mode || "fixed") === "randomize";
    const seed = randomize ? newSeed() : Number(uc.settings.seed) || newSeed();
    const batch = Math.max(1, Math.min(8, Math.round(Number(uc.settings.batch_size) || 1)));
    busy.add(variantId);
    lockDraw(true);
    renderPanel();
    progress(`Generating sprite ${variant.name}`, 0.05);
    try {
      const out = await api.requestVariant(layer, variantId, { seed, batch });
      const staged = out.results.map((result) => ({
        url: result.pixels.toDataURL("image/png"), img: result.pixels, bbox: { ...out.rect },
        displaySize: { width: out.rect.width, height: out.rect.height }, inferenceSize: out.inference,
        visible: true, mode: "img2img", maskCanvas: null, userMaskCanvas: null, resultMaskCanvas: null,
        panoramaCamera: null, snapshot: { seed: result.seed, mode: "sprite" },
        sprite: { layerId: layer.id, variantId, result, prompt: out.prompt },
      }));
      for (const item of staged) uc.addStagingItem(item);
      out.historyRun?.finish(staged);
      progress(`Sprite ${variant.name} staged`, 1);
      uc.setStatus(`Sprite ${variant.name} staged: accept, discard or pick another result.`);
    } catch (error) {
      markFailed(layer, variantId, error);
      progress(`Sprite ${variant.name} failed: ${error.message || error}`, 1);
      uc.setStatus(`Sprite ${variant.name} failed: ${error.message || error}`, true);
    } finally {
      busy.delete(variantId);
      lockDraw(false);
      uc.render?.();
      renderPanel();
    }
  }

  /** Accepting a staged variant stores it (and shows it) as one history entry. */
  function acceptStaged(staging) {
    const info = staging?.sprite;
    const layer = findLayer(info?.layerId);
    uc.stagingItems = [];
    uc.activeStagingIndex = -1;
    if (!isSprite(layer) || !variantOf(layer, info.variantId)) {
      uc.setStatus("The sprite layer of this result no longer exists.", true);
      uc.requestRender();
      return;
    }
    const applied = commitChange(layer, () => {
      if (!applyVariant(layer, info.variantId, info.result, info.prompt)) return false;
      layer.sprite.activeVariantId = info.variantId;
      drawActive(layer);
      selectedVariantId = info.variantId;
      return true;
    }, (entry) => uc.generationHistory?.acceptIntoLayer(entry, staging, layer) ?? entry);
    uc.setStatus(applied ? "Sprite variant accepted." : "The sprite changed size since this result was generated: generate it again.", !applied);
    uc.requestRender();
  }

  /** Generate missing: every empty or failed variant in order, auto-accepted, one undo step. */
  async function generateMissing(layer) {
    if (!isSprite(layer) || uc.drawInProgress) return;
    if (layer.locked) { uc.setStatus("Unlock the sprite layer first.", true); return; }
    endPreview(layer);
    const list = missingVariants(layer.sprite);
    if (!list.length) { uc.setStatus("Every variant is already generated."); return; }
    const before = uc.createLayerPixelSnapshot(layer);
    let done = 0, error = null;
    lockDraw(true);
    try {
      for (const [index, variant] of list.entries()) {
        if (!uc.layers.includes(layer) || !variantOf(layer, variant.id)) continue;
        progress(`Generating sprite ${variant.name} (${index + 1}/${list.length})`, index / list.length);
        busy.add(variant.id);
        renderPanel();
        try {
          const out = await api.requestVariant(layer, variant.id, { seed: newSeed(), batch: 1 });
          if (applyVariant(layer, variant.id, out.results[0], out.prompt)) {
            done++;
            out.historyRun?.finish([autoAcceptedHistoryItem({ img: out.results[0].pixels, seed: out.results[0].seed, rect: out.rect, layerId: layer.id })]);
          } else {
            out.historyRun?.fail(new Error("The sprite changed size while generating."));
          }
        } catch (failure) {
          markFailed(layer, variant.id, failure);
          error = new Error(`${variant.name}: ${failure.message || failure}`);
        } finally {
          busy.delete(variant.id);
        }
        if (error) break;
      }
    } finally {
      lockDraw(false);
    }
    if (uc.layers.includes(layer)) {
      uc.pushHistoryEntry({ kind: "historyGroup", entries: [{ kind: "layerPixels", layerId: layer.id, before, after: uc.createLayerPixelSnapshot(layer) }] });
      refresh(layer);
    }
    progress(error ? `Sprite generation failed: ${error.message}` : "Sprites complete", 1);
    uc.setStatus(error ? `Generated ${done} of ${list.length}; ${error.message}` : `Generated ${done} sprite variant${done === 1 ? "" : "s"}.`, Boolean(error));
  }

  function addPresets(layer) {
    if (!isSprite(layer)) return;
    const added = presetExpressionVariants(layer.sprite);
    if (!added.length) { uc.setStatus("Every preset expression is already in the set."); return; }
    commitChange(layer, () => { layer.sprite.variants = [...layer.sprite.variants, ...added]; });
    uc.setStatus(`Added ${added.length} expression${added.length === 1 ? "" : "s"}.`);
  }

  function addCustom(layer, fields) {
    if (!isSprite(layer)) return null;
    const variant = customVariant(fields);
    if (!variant.meta?.text) { uc.setStatus("Describe the variant first.", true); return null; }
    commitChange(layer, () => { layer.sprite.variants = [...layer.sprite.variants, variant]; });
    selectedVariantId = variant.id;
    renderPanel();
    return variant;
  }

  function removeVariant(layer, id) {
    const variant = variantOf(layer, id);
    if (!variant) return;
    if (id === layer.sprite.activeVariantId) { uc.setStatus("Switch to another variant before deleting this one.", true); return; }
    if (variant === neutralVariant(layer.sprite)) { uc.setStatus("The neutral variant is the base of every other one.", true); return; }
    commitChange(layer, () => { layer.sprite.variants = layer.sprite.variants.filter((item) => item.id !== id); });
    if (selectedVariantId === id) selectedVariantId = layer.sprite.activeVariantId;
    renderPanel();
  }

  function setPaintAll(layer, on) {
    if (!isSprite(layer)) return;
    // A tool option, not an edit: no history entry.
    layer.sprite.paintAll = Boolean(on);
    uc.syncToNode?.();
  }

  /* ---------------- Panel ---------------- */

  function button(label, action, title) {
    const element = uc._button(label, "vnccs-uc-btn", null, title);
    element.dataset.spriteAction = action;
    return element;
  }

  function drawThumb(canvas, pixels) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!pixels) return;
    const scale = Math.min(canvas.width / pixels.width, canvas.height / pixels.height);
    const width = pixels.width * scale, height = pixels.height * scale;
    ctx.drawImage(pixels, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  }

  function buildPanel() {
    if (panel || !uc.left || typeof document === "undefined") return panel;
    const style = document.createElement("style");
    style.textContent = SPRITE_PANEL_CSS;
    panel = document.createElement("section");
    panel.className = "vnccs-uc-sprite-panel";
    panel.dataset.spritePanel = "";
    panel.hidden = true;
    panel.append(style);
    const anchor = uc.denoiseControl?.nextSibling || null;
    if (anchor && anchor.parentNode === uc.left) uc.left.insertBefore(panel, anchor);
    else uc.left.appendChild(panel);
    panel.addEventListener("pointerdown", (event) => event.stopPropagation());
    // The custom variant kind picker uses the shared selector like every other select.
    installCustomSelects(panel);
    return panel;
  }

  function faceEditor(layer) {
    const sprite = layer.sprite;
    const wrap = document.createElement("div");
    wrap.className = "vnccs-uc-sprite-face";
    wrap.dataset.spriteFace = "";
    wrap.title = "Drag to set the face area that expressions repaint";
    const neutral = neutralVariant(sprite);
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 260 / Math.max(sprite.rect.width, sprite.rect.height));
    canvas.width = Math.max(1, Math.round(sprite.rect.width * scale));
    canvas.height = Math.max(1, Math.round(sprite.rect.height * scale));
    const draw = () => {
      faceFrame = 0;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (neutral?.pixels) ctx.drawImage(neutral.pixels, 0, 0, canvas.width, canvas.height);
      const box = faceDrag?.box || sprite.faceRect;
      if (box) {
        ctx.save();
        ctx.strokeStyle = "#ff8fa3"; ctx.lineWidth = 2; ctx.setLineDash([5, 3]);
        ctx.strokeRect(box.x * scale, box.y * scale, box.width * scale, box.height * scale);
        ctx.restore();
      }
      const anchorPoint = sprite.anchor;
      ctx.fillStyle = "#7be07b";
      ctx.fillRect(anchorPoint.x * scale - 3, anchorPoint.y * scale - 3, 6, 6);
    };
    const point = (event) => {
      const bounds = canvas.getBoundingClientRect();
      const k = sprite.rect.width / Math.max(1, bounds.width);
      return { x: Math.max(0, Math.min(sprite.rect.width, (event.clientX - bounds.left) * k)), y: Math.max(0, Math.min(sprite.rect.height, (event.clientY - bounds.top) * (sprite.rect.height / Math.max(1, bounds.height)))) };
    };
    canvas.addEventListener("pointerdown", (event) => {
      if (layer.locked) return;
      event.preventDefault();
      canvas.setPointerCapture?.(event.pointerId);
      const start = point(event);
      faceDrag = { start, box: { x: start.x, y: start.y, width: 0, height: 0 }, before: uc.createLayerPixelSnapshot(layer) };
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!faceDrag) return;
      const current = point(event);
      faceDrag.box = { x: Math.min(faceDrag.start.x, current.x), y: Math.min(faceDrag.start.y, current.y), width: Math.abs(current.x - faceDrag.start.x), height: Math.abs(current.y - faceDrag.start.y) };
      // Realtime: the rectangle follows the pointer, coalesced to one draw per frame.
      if (!faceFrame) faceFrame = requestAnimationFrame(draw);
    });
    const finish = () => {
      if (!faceDrag) return;
      const drag = faceDrag;
      faceDrag = null;
      const box = clampBox(drag.box, sprite.rect.width, sprite.rect.height);
      if (box.width < 4 || box.height < 4 || !uc.layers.includes(layer)) { draw(); return; }
      layer.sprite.faceRect = box;
      uc.pushHistoryEntry({ kind: "layerPixels", layerId: layer.id, before: drag.before, after: uc.createLayerPixelSnapshot(layer) });
      refresh(layer);
    };
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", finish);
    wrap.appendChild(canvas);
    draw();
    return wrap;
  }

  function renderPanel() {
    const layer = uc.activeLayer;
    if (!buildPanel()) return;
    if (!isSprite(layer)) { panel.hidden = true; return; }
    if (faceDrag) return;
    const sprite = layer.sprite;
    if (!variantOf(layer, selectedVariantId)) selectedVariantId = sprite.activeVariantId;
    const style = panel.querySelector("style");
    panel.replaceChildren(style);
    panel.hidden = false;
    const ready = readyVariants(sprite).length;
    const title = document.createElement("div");
    title.className = "vnccs-uc-sprite-title";
    title.innerHTML = `<div>Sprite set · ${uc._escape(sprite.characterName)}</div><span>${ready}/${sprite.variants.length} ready</span>`;
    const grid = document.createElement("div");
    grid.className = "vnccs-uc-sprite-grid";
    grid.dataset.spriteGrid = "";
    for (const variant of sprite.variants) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `vnccs-uc-sprite-thumb${variant.id === sprite.activeVariantId ? " active" : ""}${variant.id === selectedVariantId ? " selected" : ""}`;
      item.dataset.spriteVariant = variant.id;
      item.dataset.status = busy.has(variant.id) ? "busy" : variant.status;
      item.title = `${variant.name} (${busy.has(variant.id) ? "generating" : variant.status})${variant.meta?.error ? `: ${variant.meta.error}` : ""}`;
      const thumb = document.createElement("canvas");
      thumb.width = 56; thumb.height = 56;
      drawThumb(thumb, variant.pixels || neutralVariant(sprite)?.pixels || null);
      const label = document.createElement("span");
      label.textContent = busy.has(variant.id) ? `${variant.name}…` : variant.name;
      item.append(thumb, label);
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectedVariantId = variant.id;
        if (variant.status === "ready" && variant.pixels) setActiveVariant(layer, variant.id);
        else renderPanel();
      });
      item.addEventListener("pointerenter", () => preview(layer, variant.id));
      item.addEventListener("pointerleave", () => endPreview(layer));
      grid.appendChild(item);
    }
    grid.addEventListener("pointerleave", () => endPreview(layer));
    const actions = document.createElement("div");
    actions.className = "vnccs-uc-sprite-row";
    const presets = button("Add expressions", "add-presets", "Add the preset expressions as empty variants");
    presets.addEventListener("click", () => addPresets(layer));
    const missing = missingVariants(sprite).length;
    const generate = button(missing ? `Generate missing (${missing})` : "Generate missing", "generate-missing", "Generate every empty variant from the neutral one, one undo step");
    generate.disabled = !missing || uc.drawInProgress || layer.locked;
    generate.addEventListener("click", () => void generateMissing(layer));
    actions.append(presets, generate);
    const selected = variantOf(layer, selectedVariantId);
    const row = document.createElement("div");
    row.className = "vnccs-uc-sprite-row";
    if (selected) {
      const name = document.createElement("span");
      name.textContent = `${selected.name}:`;
      const again = selected.status === "ready";
      const one = button(again ? "Regenerate" : "Generate", "generate-variant", again ? "Generate this variant again with a new seed" : "Generate this variant from the neutral one");
      one.disabled = uc.drawInProgress || busy.has(selected.id) || layer.locked || selected === neutralVariant(sprite);
      one.addEventListener("click", () => void stageVariant(layer, selected.id, { regenerate: again }));
      const remove = button("Delete", "delete-variant", "Delete this variant");
      remove.disabled = selected.id === sprite.activeVariantId || layer.locked;
      remove.addEventListener("click", () => removeVariant(layer, selected.id));
      row.append(name, one, remove);
    }
    const paint = document.createElement("label");
    paint.className = "vnccs-uc-sprite-row";
    paint.title = "Brush and eraser strokes also land on every other ready variant (body fixes)";
    const paintBox = document.createElement("input");
    paintBox.type = "checkbox";
    paintBox.checked = sprite.paintAll === true;
    paintBox.dataset.spritePaintAll = "";
    paintBox.addEventListener("change", () => setPaintAll(layer, paintBox.checked));
    paint.append(paintBox, document.createTextNode("Paint on all variants"));
    const custom = document.createElement("details");
    custom.className = "vnccs-uc-sprite-custom";
    custom.innerHTML = `<summary>Custom variant</summary>`;
    const customName = document.createElement("input");
    customName.className = "vnccs-uc-input"; customName.placeholder = "Name"; customName.dataset.spriteCustomName = "";
    const customKind = document.createElement("select");
    customKind.className = "vnccs-uc-select"; customKind.dataset.spriteCustomKind = "";
    for (const kind of ["expression", "outfit", "pose", "custom"]) {
      const option = document.createElement("option");
      option.value = kind; option.textContent = kind;
      customKind.appendChild(option);
    }
    const customText = document.createElement("textarea");
    customText.className = "vnccs-uc-input"; customText.placeholder = "Instruction, e.g. winking with the tongue out"; customText.dataset.spriteCustomText = "";
    const add = button("Add variant", "add-custom", "Add this variant as empty");
    add.addEventListener("click", () => {
      if (addCustom(layer, { name: customName.value, kind: customKind.value, text: customText.value })) { customName.value = ""; customText.value = ""; }
    });
    const customBody = document.createElement("div");
    customBody.className = "vnccs-uc-sprite-custom";
    customBody.append(customName, customKind, customText, add);
    custom.appendChild(customBody);
    const faceLabel = document.createElement("div");
    faceLabel.style.opacity = ".75";
    faceLabel.textContent = sprite.faceRect ? "Face area (drag to redraw); green: anchor" : "Drag the face area that expressions repaint";
    panel.append(title, grid, actions, row, paint, faceLabel, faceEditor(layer), custom);
  }

  /* ---------------- Wiring ---------------- */

  uc.layerMenuExtensions = [...(uc.layerMenuExtensions || []),
    { id: "create-sprite-set", label: "Create sprite set", visible: (layer) => layer?.type === "raster" || layer?.type === "pose", run: (layer) => createFromLayer(layer) },
    { id: "split-variant-to-layer", label: "Split variant to layer", visible: (layer) => isSprite(layer), run: (layer) => splitVariantToLayer(layer) },
  ];

  const api = {
    isSprite, syncFromCanvas, snapshot, restoreSnapshot, cloneLayerFields, serialize, restore, onMove, onTransform, onStroke,
    setActiveVariant, applyVariantHistory, cycleActive, preview, endPreview, createFromLayer, splitVariantToLayer,
    addPresets, addCustom, removeVariant, setPaintAll, stageVariant, generateMissing, acceptStaged, renderPanel,
    describe(layerId) {
      const layer = findLayer(layerId);
      if (!isSprite(layer)) return null;
      return serializeSpriteState(layer.sprite);
    },
    variantDataURL(layerId, variantId) {
      const variant = variantOf(findLayer(layerId), variantId);
      return variant?.pixels ? variant.pixels.toDataURL("image/png") : null;
    },
    // The pipeline steps, called through this object so tests can replace them.
    requestVariant, applyVariant,
  };
  uc.sprites = api;
  return uc;
}
