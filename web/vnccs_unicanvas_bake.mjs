/**
 * VNCCS UniCanvas character bake and scene Generate (Plan 02, issue #5).
 *
 * A mannequin with a bound character reference can be baked: the character is generated in the
 * same pose and placement (the `pose_edit` contract of one pose layer, now per character), cut out
 * with the configured background remover and kept as that character's baked pixels. The 3D scene
 * stays editable; the layer shows the baked characters over the mannequins that are not baked.
 *
 *  - State: `layer.pose.bake = { characters: { [id]: { status, poseHash, refHash, seed, model,
 *    bakedAt, headRect?, feetPoint?, error? } }, showMannequin }` (serialized with the pose).
 *  - Pixels (runtime; state cache only): `layer.mannequinSurface` (what the pose editor renders
 *    over `pose.rect`), `layer.bakeParts[id] = { surface, rect, anchor }` (one baked character in
 *    its working rect), and `layer.canvas` / `hiresCanvas` as the composite view, rebuilt only
 *    when an input changes.
 *  - GENERATE: every bound character that is unbaked, failed or stale (setting
 *    `rebake_stale_on_generate`) bakes first, auto-accepted; the scene pass then runs the normal
 *    draw over the composite, and one undo reverts the bakes together with the accepted result.
 *
 * The pure helpers at the top run under Node for tests; installUniCanvasCharacterBake binds the
 * controller onto the widget like the other install* modules.
 */

import { getPoseCharacterMask, poseAtPanoramaCamera, poseCharacterIssues, poseCharacterPrompt,
  poseCharacterRef, poseStudioCharacters } from "./vnccs_unicanvas_pose_state.mjs";
import { studioCharacterList } from "./vnccs_unicanvas_pose_scene.mjs";
import { forceUniCanvasPresetModelSettings } from "./vnccs_unicanvas_presets.mjs";
import { isLayerEffectivelyVisible } from "./vnccs_unicanvas_groups.mjs";
import { resolveRemoveBgSelection, removeBgEditSettings } from "./vnccs_unicanvas_remove_bg.mjs";
import { filterUniCanvasChoices, isUniCanvasEnabled, isUniCanvasFamilyEnabled } from "./vnccs_unicanvas_feature_toggles.mjs";

export const BAKE_FAMILIES = Object.freeze([["qwen_image_edit", "QiE2511"], ["flux_klein", "Klein9b"]]);
export const BAKE_STATUSES = Object.freeze(["none", "baked", "stale", "failed"]);
export const BAKE_DRAW_ROUTE = "/vnccs/unicanvas/draw";
export const BAKE_REMOVE_BG_ROUTE = "/vnccs/unicanvas/remove_bg";
// Working rect margin around the pose rect, and crop margin around the solo silhouette.
export const BAKE_WORK_MARGIN = 0.1;
export const BAKE_CROP_MARGIN = 0.15;

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

export function hashText(text) {
  let hash = 0x811c9dc5;
  const value = String(text);
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/* ----------------------------------------------------------------------------------------------
 * State and staleness
 * -------------------------------------------------------------------------------------------- */

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const status = BAKE_STATUSES.includes(entry.status) ? entry.status : "none";
  const result = { status };
  for (const key of ["poseHash", "refHash", "model", "error"]) if (typeof entry[key] === "string" && entry[key]) result[key] = entry[key];
  for (const key of ["seed", "bakedAt"]) if (Number.isFinite(Number(entry[key])) && entry[key] !== null && entry[key] !== "") result[key] = Number(entry[key]);
  const rect = entry.headRect;
  if (rect && ["x", "y", "width", "height"].every((key) => Number.isFinite(Number(rect[key])))) {
    result.headRect = { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) };
  }
  const point = entry.feetPoint;
  if (point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))) result.feetPoint = { x: Number(point.x), y: Number(point.y) };
  return result;
}

/** Additive schema: missing or malformed bake state reads as "nothing baked". */
export function normalizePoseBake(value) {
  const characters = {};
  for (const [id, entry] of Object.entries(value?.characters || {})) {
    const normalized = normalizeEntry(entry);
    if (normalized) characters[String(id)] = normalized;
  }
  return { characters, showMannequin: value?.showMannequin === true };
}

export function ensurePoseBake(pose) {
  if (!pose) return null;
  pose.bake = normalizePoseBake(pose.bake);
  return pose.bake;
}

const hashCache = new WeakMap();

/**
 * Everything the baked pixels of one character depend on in the 3D scene: its own studio entry
 * (pose, mesh, transform, animation), the active frame, the shared camera, the rect size and lights.
 */
export function bakePoseHash(pose, characterId) {
  if (!pose) return "";
  const studio = pose.studio || {};
  const id = String(characterId);
  const cached = hashCache.get(studio);
  const key = JSON.stringify([id, pose.viewport ?? null, pose.rect?.width ?? 0, pose.rect?.height ?? 0]);
  if (cached?.has(key)) return cached.get(key);
  const character = studioCharacterList(pose).find((item) => String(item.id) === id) || null;
  const { name: _name, color: _color, slot: _slot, ...shape } = character || {};
  const frame = [studio.activeTab ?? 0, studio.animation?.current_frame ?? studio.animation?.frame ?? null];
  const hash = hashText(JSON.stringify([shape, frame, pose.viewport ?? null,
    [Math.round(pose.rect?.width || 0), Math.round(pose.rect?.height || 0)], studio.lights ?? null]));
  const map = cached || new Map();
  if (map.size > 32) map.clear();
  map.set(key, hash);
  hashCache.set(studio, map);
  return hash;
}

const uploadHashes = new Map();
function uploadHash(dataURL) {
  const text = String(dataURL || "");
  if (uploadHashes.has(text)) return uploadHashes.get(text);
  const hash = hashText(text);
  if (uploadHashes.size > 16) uploadHashes.clear();
  uploadHashes.set(text, hash);
  return hash;
}

/** The bound reference (layer id + pixel revision, or the upload's data hash) and identity prompt. */
export function bakeRefHash(layers, layer, characterId) {
  const ref = poseCharacterRef(layer, characterId);
  const prompt = poseCharacterPrompt(layer, characterId);
  let source = "none";
  if (ref?.source === "layer") {
    const target = (layers || []).find((item) => item.id === ref.layerId);
    source = `layer:${ref.layerId}:${target?.pixelRevision ?? "missing"}`;
  } else if (ref?.source === "upload") source = `upload:${uploadHash(ref.dataURL || ref.name)}`;
  return hashText(JSON.stringify([source, prompt]));
}

/** "none" | "baked" | "stale" | "failed", with baked/stale derived from the stored hashes. */
export function bakeStatus(layers, layer, characterId, { hasPart = true } = {}) {
  const entry = layer?.pose?.bake?.characters?.[String(characterId)];
  if (!entry) return "none";
  if (entry.status === "failed") return "failed";
  if (entry.status !== "baked" && entry.status !== "stale") return "none";
  if (!hasPart) return "none";
  return entry.poseHash === bakePoseHash(layer.pose, characterId) && entry.refHash === bakeRefHash(layers, layer, characterId)
    ? "baked" : "stale";
}

/**
 * Brings stored statuses in line with the scene after a commit: baked entries whose hashes
 * changed become stale (and back, e.g. after an undo), entries of removed mannequins are dropped.
 * Returns true when anything changed.
 */
export function refreshBakeStatuses(layers, layer) {
  const bake = layer?.pose?.bake;
  if (!bake?.characters) return false;
  const ids = new Set(poseStudioCharacters(layer.pose).map((item) => item.id));
  let changed = false;
  for (const [id, entry] of Object.entries(bake.characters)) {
    if (!ids.has(id)) {
      delete bake.characters[id];
      if (layer.bakeParts) delete layer.bakeParts[id];
      changed = true;
      continue;
    }
    if (entry.status !== "baked" && entry.status !== "stale") continue;
    const next = bakeStatus(layers, layer, id);
    if (next !== entry.status) { entry.status = next; changed = true; }
  }
  return changed;
}

/* ----------------------------------------------------------------------------------------------
 * Geometry and alpha helpers
 * -------------------------------------------------------------------------------------------- */

export function intersectsRect(a, b) {
  return Boolean(a && b) && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** The pose rect grown by `margin` on every side, clamped to the world (document) rect. */
export function bakeWorkingRect(rect, world = null, margin = BAKE_WORK_MARGIN) {
  const dx = rect.width * margin, dy = rect.height * margin;
  let x1 = rect.x - dx, y1 = rect.y - dy, x2 = rect.x + rect.width + dx, y2 = rect.y + rect.height + dy;
  if (world) {
    x1 = Math.max(x1, world.x); y1 = Math.max(y1, world.y);
    x2 = Math.min(x2, world.x + world.width); y2 = Math.min(y2, world.y + world.height);
    // Never smaller than the pose rect itself.
    x1 = Math.min(x1, rect.x); y1 = Math.min(y1, rect.y);
    x2 = Math.max(x2, rect.x + rect.width); y2 = Math.max(y2, rect.y + rect.height);
  }
  x1 = Math.floor(x1); y1 = Math.floor(y1); x2 = Math.ceil(x2); y2 = Math.ceil(y2);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function unionRect(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width), y2 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Pixel box of every alpha above `threshold`, or null. */
export function alphaBounds(alpha, width, height, threshold = 16) {
  let x1 = width, y1 = height, x2 = -1, y2 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (alpha[row + x] <= threshold) continue;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
    }
  }
  return x2 < 0 ? null : { x: x1, y: y1, width: x2 - x1 + 1, height: y2 - y1 + 1 };
}

/** A box grown by `fraction` of its size on every side, clamped to width x height. */
export function expandBox(box, fraction, width, height) {
  const dx = Math.round(box.width * fraction), dy = Math.round(box.height * fraction);
  const x1 = Math.max(0, box.x - dx), y1 = Math.max(0, box.y - dy);
  const x2 = Math.min(width, box.x + box.width + dx), y2 = Math.min(height, box.y + box.height + dy);
  return { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
}

/** Binary (0 / 255) square dilation of every alpha above `threshold` by `radius` pixels. */
export function dilateAlpha(alpha, width, height, radius, threshold = 16) {
  let out = new Uint8ClampedArray(width * height);
  for (let index = 0; index < out.length; index++) if (alpha[index] > threshold) out[index] = 255;
  const r = Math.max(0, Math.round(radius));
  if (!r) return out;
  const pass = (source, horizontal) => {
    const next = new Uint8ClampedArray(source.length);
    const outer = horizontal ? height : width, inner = horizontal ? width : height;
    for (let a = 0; a < outer; a++) {
      for (let b = 0; b < inner; b++) {
        if (!source[horizontal ? a * width + b : b * width + a]) continue;
        const from = Math.max(0, b - r), to = Math.min(inner - 1, b + r);
        for (let c = from; c <= to; c++) next[horizontal ? a * width + c : c * width + a] = 255;
      }
    }
    return next;
  };
  out = pass(pass(out, true), false);
  return out;
}

/**
 * The generated alpha keeps only its connected components (4-neighbour, alpha > threshold) that
 * overlap the mannequin silhouette: hair and clothes past the silhouette survive because they are
 * connected to the body, while separate objects or a second figure are dropped. Soft alpha values
 * of kept pixels are preserved.
 */
export function keepOverlappingComponents(alpha, silhouette, width, height, threshold = 16) {
  const size = width * height;
  const labels = new Int32Array(size).fill(-1);
  const keep = [];
  const stack = new Int32Array(size);
  let next = 0;
  for (let start = 0; start < size; start++) {
    if (labels[start] !== -1 || alpha[start] <= threshold) continue;
    const label = next++;
    let overlaps = false, top = 0;
    stack[top++] = start; labels[start] = label;
    while (top) {
      const pixel = stack[--top];
      if (silhouette[pixel] > threshold) overlaps = true;
      const x = pixel % width;
      const neighbours = [x > 0 ? pixel - 1 : -1, x < width - 1 ? pixel + 1 : -1, pixel - width, pixel + width];
      for (const neighbour of neighbours) {
        if (neighbour < 0 || neighbour >= size || labels[neighbour] !== -1 || alpha[neighbour] <= threshold) continue;
        labels[neighbour] = label;
        stack[top++] = neighbour;
      }
    }
    keep[label] = overlaps;
  }
  const out = new Uint8ClampedArray(size);
  for (let pixel = 0; pixel < size; pixel++) {
    const label = labels[pixel];
    if (label >= 0 && keep[label]) out[pixel] = alpha[pixel];
  }
  return out;
}

/** How far `box` reaches past `inner` on its farthest side (0 when it stays inside). */
export function extentBeyond(inner, box) {
  if (!inner || !box) return 0;
  return Math.max(0, inner.x - box.x, inner.y - box.y,
    box.x + box.width - (inner.x + inner.width), box.y + box.height - (inner.y + inner.height));
}

/** `alpha` with every pixel that another mask covers cleared (the visible masks of other characters). */
export function subtractAlpha(alpha, others = []) {
  const out = new Uint8ClampedArray(alpha);
  for (const other of others) {
    if (!other) continue;
    for (let pixel = 0; pixel < out.length; pixel++) if (other[pixel] > 127) out[pixel] = 0;
  }
  return out;
}

/** Whether `inner` stays within `fraction` of `outer`'s size on every side (bake placement check). */
export function boxWithin(inner, outer, fraction = 0.05) {
  if (!inner || !outer) return false;
  const dx = outer.width * fraction, dy = outer.height * fraction;
  return Math.abs(inner.x - outer.x) <= dx && Math.abs(inner.y - outer.y) <= dy
    && Math.abs(inner.x + inner.width - (outer.x + outer.width)) <= dx && Math.abs(inner.y + inner.height - (outer.y + outer.height)) <= dy;
}

/* ----------------------------------------------------------------------------------------------
 * Candidates, labels and model
 * -------------------------------------------------------------------------------------------- */

export const BAKE_CHIP_LABELS = Object.freeze({ none: "mannequin", baked: "baked", stale: "stale", failed: "failed", baking: "baking…" });

export function bakeChipLabel(status) {
  return BAKE_CHIP_LABELS[status] || BAKE_CHIP_LABELS.none;
}

export function generateBakeLabel(count) {
  return count > 0 ? `+${count} bake${count === 1 ? "" : "s"}` : "";
}

/**
 * Bound characters of visible, unlocked pose layers intersecting the bbox that GENERATE bakes
 * first: unbaked or failed ones, and stale ones unless `includeStale` is false. Mannequins
 * without a valid reference are never candidates: they reach the scene pass as mannequins.
 */
export function collectBakeCandidates(host, { includeStale = true, hasPart = null } = {}) {
  const layers = host.layers || [];
  const out = [];
  for (const layer of layers) {
    if (layer?.type !== "pose" || !layer.pose?.rect || layer.locked) continue;
    if (!isLayerEffectivelyVisible(layers, layer) || !intersectsRect(layer.pose.rect, host.bbox)) continue;
    const unbound = new Set(poseCharacterIssues(host, layer).map((item) => item.characterId));
    for (const character of poseStudioCharacters(layer.pose)) {
      if (unbound.has(character.id)) continue;
      const part = hasPart ? hasPart(layer, character.id) : Boolean(layer.bakeParts?.[character.id]);
      const status = bakeStatus(layers, layer, character.id, { hasPart: part });
      if (status === "none" || status === "failed" || (status === "stale" && includeStale)) {
        out.push({ layer, characterId: character.id, name: character.name, status });
      }
    }
  }
  return out;
}

/**
 * The model a bake runs with: the current engine when it is a bake family, otherwise the Bake
 * model from settings (family, preset, steps / cfg overrides), defaulting to the first ready
 * preset of a bake family.
 */
export function resolveBakeModel(settings, { currentBase, presets = [], presetReady = () => true, baseOf = (mode) => mode } = {}) {
  const families = BAKE_FAMILIES.map(([key]) => key);
  if (families.includes(currentBase)) return { useCurrent: true, family: currentBase };
  const wanted = families.includes(settings?.bake_model_family) ? settings.bake_model_family : null;
  const ofFamily = (family) => presets.filter((preset) => baseOf(preset?.settings?.generation_mode || preset?.id) === family);
  const chosen = presets.find((preset) => preset.id === settings?.bake_preset_id);
  if (chosen && (!wanted || baseOf(chosen.settings?.generation_mode || chosen.id) === wanted)) {
    return { preset: chosen, family: baseOf(chosen.settings?.generation_mode || chosen.id), ready: presetReady(chosen) };
  }
  for (const family of wanted ? [wanted] : families) {
    const list = ofFamily(family);
    const ready = list.find((preset) => presetReady(preset));
    if (ready) return { preset: ready, family, ready: true };
    if (wanted && list.length) return { preset: list[0], family, ready: false };
  }
  return { error: "Character bake needs QiE2511 or Klein9b: choose the Bake model in UniCanvas settings (Character bake)." };
}

/** Settings for one bake request, built on the scene settings payload. */
export function bakeSettingsPayload(base, { model, defaults = {}, positive, seed, batch = 1 }) {
  const settings = { ...base };
  if (!model.useCurrent && model.preset) {
    Object.assign(settings, clone(defaults));
    forceUniCanvasPresetModelSettings(settings, model.preset);
    // The scene's LoRAs belong to another family.
    settings.lora_stack = [];
  }
  const steps = Number(base?.bake_steps), cfg = Number(base?.bake_cfg);
  if (!model.useCurrent && Number.isFinite(steps) && steps > 0) settings.steps = Math.round(steps);
  if (!model.useCurrent && Number.isFinite(cfg) && cfg > 0) settings.cfg = cfg;
  settings.positive = positive;
  settings.denoise = 1;
  settings.batch_size = Math.max(1, Math.min(8, Math.round(Number(batch) || 1)));
  if (Number.isFinite(Number(seed))) settings.seed = Number(seed);
  settings.seed_mode = "fixed";
  delete settings.queued_draw;
  delete settings.draw_id;
  return settings;
}

/** Remove-background method for bakes: SAM 3 is interactive, so it falls back to BiRefNet. */
export function bakeRemoveBgRequest(settings) {
  const { method, editModel } = resolveRemoveBgSelection(settings);
  const resolved = method === "sam3" ? "birefnet" : method;
  return { method: resolved, edit_model: editModel, edit_settings: resolved === "edit" ? removeBgEditSettings(settings, editModel) : undefined };
}

/** Parts drawn back to front: farther characters (feet higher on screen) first. */
export function orderBakeParts(entries) {
  return [...entries].sort((a, b) => (a.feetY ?? 0) - (b.feetY ?? 0));
}

/**
 * A depth-scaled move of a baked pose layer: `layer.pose.rect` already holds the placed rect,
 * `previousRect` the rect before. Every baked part and the head / feet anchors follow `map` (a
 * scale around the feet plus a move), and a bake that matched the scene before the move stays
 * baked: a placement is not a pose edit. Part and entry objects are replaced, never mutated,
 * because history snapshots share them.
 */
export function scaleBakeWithPlacement(layer, map, previousRect) {
  const pose = layer?.pose;
  if (!pose?.rect || !previousRect || !map) return;
  const anchor = { x: pose.rect.x, y: pose.rect.y };
  const parts = {};
  const shifts = {};
  for (const [id, part] of Object.entries(layer.bakeParts || {})) {
    if (!part?.rect || !part.anchor) { parts[id] = part; continue; }
    const dx = previousRect.x - part.anchor.x, dy = previousRect.y - part.anchor.y;
    shifts[id] = { dx, dy };
    parts[id] = { ...part, rect: map.rect({ ...part.rect, x: part.rect.x + dx, y: part.rect.y + dy }), anchor: { ...anchor } };
  }
  if (layer.bakeParts) layer.bakeParts = parts;
  const bake = pose.bake;
  if (!bake?.characters) return;
  const before = { ...pose, rect: { ...previousRect } };
  const characters = {};
  for (const [id, entry] of Object.entries(bake.characters)) {
    const next = { ...entry };
    const shift = shifts[id] || { dx: 0, dy: 0 };
    if (entry.headRect) next.headRect = map.rect({ ...entry.headRect, x: entry.headRect.x + shift.dx, y: entry.headRect.y + shift.dy });
    if (entry.feetPoint) next.feetPoint = map.point({ x: entry.feetPoint.x + shift.dx, y: entry.feetPoint.y + shift.dy });
    if ((entry.status === "baked" || entry.status === "stale") && entry.poseHash && entry.poseHash === bakePoseHash(before, id)) {
      next.poseHash = bakePoseHash(pose, id);
    }
    characters[id] = next;
  }
  pose.bake = { ...bake, characters };
}

/* ----------------------------------------------------------------------------------------------
 * Browser controller
 * -------------------------------------------------------------------------------------------- */

const newSeed = () => Math.floor(Math.random() * 2 ** 32);

function readAlpha(canvas) {
  const data = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const alpha = new Uint8ClampedArray(canvas.width * canvas.height);
  let opaque = true;
  for (let pixel = 0, offset = 3; pixel < alpha.length; pixel++, offset += 4) {
    alpha[pixel] = data[offset];
    if (data[offset] < 250) opaque = false;
  }
  if (!opaque) return alpha;
  // An opaque grayscale mask: luminance is the alpha.
  for (let pixel = 0, offset = 0; pixel < alpha.length; pixel++, offset += 4) alpha[pixel] = data[offset];
  return alpha;
}

function alphaCanvas(uc, alpha, width, height) {
  const canvas = uc._createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  for (let pixel = 0; pixel < alpha.length; pixel++) {
    const offset = pixel * 4;
    image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = 255;
    image.data[offset + 3] = alpha[pixel];
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function subAlpha(alpha, width, box) {
  const out = new Uint8ClampedArray(box.width * box.height);
  for (let y = 0; y < box.height; y++) {
    const from = (box.y + y) * width + box.x;
    out.set(alpha.subarray(from, from + box.width), y * box.width);
  }
  return out;
}

export function installUniCanvasCharacterBake(uc, { createEditor, modelModule = () => null } = {}) {
  if (!uc || uc.poseBake) return uc;
  let pending = null;
  let labelTimer = 0;
  const busy = new Map(); // layerId -> Set(characterId)

  const editingLayer = (layer) => uc.tool === "pose" && uc.poseEditSession?.layerId === layer?.id;
  const partsOf = (layer) => layer?.bakeParts || {};
  const hasPart = (layer, id) => Boolean(layer?.bakeParts?.[id]?.surface);
  const statusOf = (layer, id) => (busy.get(layer.id)?.has(id) ? "baking" : bakeStatus(uc.layers, layer, id, { hasPart: hasPart(layer, id) }));
  const worldRect = () => ({ x: uc.origin.x, y: uc.origin.y, width: uc.size.width, height: uc.size.height });
  const ensureEditor = () => (uc.poseEditor ||= createEditor?.());

  function shownParts(layer) {
    const ids = new Set(poseStudioCharacters(layer.pose).map((item) => item.id));
    return Object.entries(partsOf(layer)).filter(([id, part]) => ids.has(id) && part?.surface
      && ["baked", "stale"].includes(layer.pose?.bake?.characters?.[id]?.status));
  }

  function showsBakedView(layer) {
    if (layer?.type !== "pose" || !layer.pose?.rect) return false;
    if (layer.pose.bake?.showMannequin || editingLayer(layer)) return false;
    return shownParts(layer).length > 0;
  }

  function commitView(layer) {
    uc.invalidateLayerCaches(layer);
    if (uc.panorama && poseAtPanoramaCamera(layer, uc.panorama)) uc.panorama.commitLayer?.(layer);
    uc.requestRender();
  }

  /** Rebuilds `layer.canvas` / `hiresCanvas` from the mannequin and the baked parts. */
  function rebuildView(layer) {
    if (layer?.type !== "pose" || !layer.pose?.rect) return;
    const rect = layer.pose.rect;
    const mannequin = layer.mannequinSurface || null;
    if (!showsBakedView(layer)) {
      if (!layer._bakeViewBaked) return;
      layer._bakeViewBaked = false;
      if (!mannequin) return;
      const ctx = layer.canvas.getContext("2d");
      ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      ctx.drawImage(mannequin, rect.x - uc.origin.x, rect.y - uc.origin.y, rect.width, rect.height);
      layer.hiresCanvas = mannequin;
      layer.hiresRect = { ...rect };
      commitView(layer);
      return;
    }
    const parts = orderBakeParts(shownParts(layer).map(([id, part]) => {
      const dx = rect.x - part.anchor.x, dy = rect.y - part.anchor.y;
      return { id, part, at: { ...part.rect, x: part.rect.x + dx, y: part.rect.y + dy },
        feetY: layer.pose.bake.characters[id]?.feetPoint?.y };
    }));
    let union = { ...rect };
    for (const entry of parts) union = unionRect(union, entry.at);
    const density = mannequin ? mannequin.width / Math.max(1, rect.width) : parts[0].part.surface.width / Math.max(1, parts[0].part.rect.width);
    const scale = Math.min(density, 2048 / Math.max(union.width, union.height));
    const out = uc._createCanvas(Math.max(1, Math.round(union.width * scale)), Math.max(1, Math.round(union.height * scale)));
    const ctx = out.getContext("2d");
    const place = (world) => ({ x: (world.x - union.x) * scale, y: (world.y - union.y) * scale, width: world.width * scale, height: world.height * scale });
    const baked = new Set(parts.map((entry) => entry.id));
    const unbaked = poseStudioCharacters(layer.pose).filter((item) => !baked.has(item.id));
    if (mannequin && unbaked.length) {
      const target = place(rect);
      const masks = unbaked.map((item) => getPoseCharacterMask(layer, item.id, { createCanvas: (w, h) => uc._createCanvas(w, h) }));
      if (masks.every(Boolean)) {
        // Unbaked mannequins keep only their visible pixels (their ID masks).
        const cut = uc._createCanvas(Math.max(1, Math.round(target.width)), Math.max(1, Math.round(target.height)));
        const cutCtx = cut.getContext("2d");
        cutCtx.drawImage(mannequin, 0, 0, cut.width, cut.height);
        const maskCanvas = uc._createCanvas(cut.width, cut.height);
        const maskCtx = maskCanvas.getContext("2d");
        for (const mask of masks) maskCtx.drawImage(mask.canvas, 0, 0, cut.width, cut.height);
        cutCtx.globalCompositeOperation = "destination-in";
        cutCtx.drawImage(maskCanvas, 0, 0);
        cutCtx.globalCompositeOperation = "source-over";
        ctx.drawImage(cut, target.x, target.y, target.width, target.height);
      } else ctx.drawImage(mannequin, target.x, target.y, target.width, target.height);
    }
    for (const entry of parts) {
      const target = place(entry.at);
      ctx.drawImage(entry.part.surface, target.x, target.y, target.width, target.height);
    }
    const layerCtx = layer.canvas.getContext("2d");
    layerCtx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    layerCtx.drawImage(out, union.x - uc.origin.x, union.y - uc.origin.y, union.width, union.height);
    layer.hiresCanvas = out;
    layer.hiresRect = union;
    layer._bakeViewBaked = true;
    commitView(layer);
  }

  function refreshLayer(layer) {
    uc.refreshLayerRow?.(layer.id);
    if (uc.poseEditor?.layer === layer) renderCardChips(uc.poseEditor);
    scheduleGenerateLabel();
  }

  function afterCommit(layer) {
    if (layer?.type !== "pose" || !layer.pose) return;
    const changed = refreshBakeStatuses(uc.layers, layer);
    rebuildView(layer);
    if (changed) refreshLayer(layer);
    else scheduleGenerateLabel();
  }

  /* ---------------- Pipeline ---------------- */

  async function prepareEditor(layer) {
    const editor = ensureEditor();
    if (!editor) throw new Error("The pose editor is not available.");
    if (uc.panorama && layer.pose.panoramaCamera && !poseAtPanoramaCamera(layer, uc.panorama)) {
      // Bakes run in the pose layer's own camera.
      uc.panorama.commit();
      const { yaw, pitch, roll, fov } = layer.pose.panoramaCamera;
      uc.panorama.setCamera({ yaw, pitch, roll, fov });
      uc.panorama.flushCamera();
    }
    await editor.activate(layer, { show: editingLayer(layer) });
    await editor.flush();
    if (editor.layer !== layer || !uc.layers.includes(layer)) throw new Error("The pose layer changed. Bake again.");
    return editor;
  }

  function bakeModel() {
    const presetReady = (preset) => Boolean(uc.presetStatus?.(preset)?.installed);
    const baseOf = (mode) => modelModule(mode)?.base || mode;
    return resolveBakeModel(uc.settings, { currentBase: uc.getModelBase(), presets: uc.presets || [], presetReady, baseOf });
  }

  async function removeBackground(crop) {
    const res = await fetch(BAKE_REMOVE_BG_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...bakeRemoveBgRequest(uc.settings), image: crop.toDataURL("image/png") }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Remove background HTTP ${res.status}`);
    const image = await uc.loadImage(data.alpha || data.image);
    const canvas = uc._createCanvas(crop.width, crop.height);
    canvas.getContext("2d").drawImage(image, 0, 0, crop.width, crop.height);
    return readAlpha(canvas);
  }

  /** Visible ID mask of one character grown by `extent`, minus the others' visible pixels, in work space. */
  function clipCanvas(layer, characterId, rect, work, size, extent) {
    const createCanvas = (w, h) => uc._createCanvas(w, h);
    const own = getPoseCharacterMask(layer, characterId, { dilate: extent, createCanvas });
    if (!own) return null;
    const others = poseStudioCharacters(layer.pose).filter((item) => item.id !== String(characterId))
      .map((item) => getPoseCharacterMask(layer, item.id, { createCanvas })?.alpha).filter(Boolean);
    const allowed = alphaCanvas(uc, subtractAlpha(own.alpha, others), own.width, own.height);
    const k = size.width / work.width;
    const clip = uc._createCanvas(size.width, size.height);
    const ctx = clip.getContext("2d");
    // Outside the pose rect no other character is visible, so generated hair may stay there.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size.width, size.height);
    const x = (rect.x - work.x) * k, y = (rect.y - work.y) * k;
    ctx.clearRect(x, y, rect.width * k, rect.height * k);
    ctx.drawImage(allowed, x, y, rect.width * k, rect.height * k);
    return clip;
  }

  async function extractCharacter(layer, characterId, image, work, rect, solo) {
    const size = { width: Math.max(1, image.naturalWidth || image.width), height: Math.max(1, image.naturalHeight || image.height) };
    const k = size.width / work.width;
    const generated = uc._createCanvas(size.width, size.height);
    const genCtx = generated.getContext("2d", { willReadFrequently: true });
    genCtx.drawImage(image, 0, 0, size.width, size.height);
    const silhouette = uc._createCanvas(size.width, size.height);
    silhouette.getContext("2d").drawImage(solo, (rect.x - work.x) * k, (rect.y - work.y) * k, rect.width * k, rect.height * k);
    const silAlpha = readAlpha(silhouette);
    const silBox = alphaBounds(silAlpha, size.width, size.height);
    if (!silBox) throw new Error("The mannequin is not visible in its pose layer.");
    const cropBox = expandBox(silBox, BAKE_CROP_MARGIN, size.width, size.height);
    const crop = uc._createCanvas(cropBox.width, cropBox.height);
    crop.getContext("2d").drawImage(generated, cropBox.x, cropBox.y, cropBox.width, cropBox.height, 0, 0, cropBox.width, cropBox.height);
    const alpha = await removeBackground(crop);
    const silCrop = dilateAlpha(subAlpha(silAlpha, size.width, cropBox), cropBox.width, cropBox.height,
      Math.max(1, Math.round(0.01 * Math.max(cropBox.width, cropBox.height))));
    const kept = keepOverlappingComponents(alpha, silCrop, cropBox.width, cropBox.height);
    const keptBox = alphaBounds(kept, cropBox.width, cropBox.height);
    if (!keptBox) throw new Error("The bake produced no character pixels over the mannequin.");
    const localSil = { ...silBox, x: silBox.x - cropBox.x, y: silBox.y - cropBox.y };
    const extent = extentBeyond(localSil, keptBox) / k;
    const cutData = crop.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cropBox.width, cropBox.height);
    for (let pixel = 0; pixel < kept.length; pixel++) cutData.data[pixel * 4 + 3] = kept[pixel];
    const surface = uc._createCanvas(size.width, size.height);
    const ctx = surface.getContext("2d");
    const cut = uc._createCanvas(cropBox.width, cropBox.height);
    cut.getContext("2d").putImageData(cutData, 0, 0);
    ctx.drawImage(cut, cropBox.x, cropBox.y);
    const clip = clipCanvas(layer, characterId, rect, work, size, extent);
    if (clip) {
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(clip, 0, 0);
      ctx.globalCompositeOperation = "source-over";
    }
    const toWorld = (box) => ({ x: work.x + (box.x + cropBox.x) / k, y: work.y + (box.y + cropBox.y) / k, width: box.width / k, height: box.height / k });
    return {
      surface, rect: { ...work }, anchor: { x: rect.x, y: rect.y },
      silhouetteBox: toWorld({ ...localSil }), alphaBox: toWorld(keptBox),
    };
  }

  /** Generates one character (batch variants) and extracts each result. Nothing is applied yet. */
  async function runBake(layer, characterId, { seed = newSeed(), batch = 1 } = {}) {
    const model = bakeModel();
    if (model.error) throw new Error(model.error);
    if (model.ready === false) throw new Error(`The Bake model ${model.preset?.label || model.preset?.id} is not downloaded yet. Download it in the model list first.`);
    const editor = await prepareEditor(layer);
    const rect = { ...layer.pose.rect };
    const work = bakeWorkingRect(rect, worldRect());
    const size = uc.getInferenceSize(work);
    const output = { width: Math.max(64, Math.round(work.width)), height: Math.max(64, Math.round(work.height)) };
    const poseHash = bakePoseHash(layer.pose, characterId);
    const refHash = bakeRefHash(uc.layers, layer, characterId);
    const inputs = await editor.bakeInputs(layer, characterId, work, size);
    const anchors = editor.characterAnchors?.(characterId) || null;
    const defaults = model.useCurrent ? {} : (modelModule(model.family)?.defaults || {});
    const settings = bakeSettingsPayload(uc.makeSettingsPayload(), { model, defaults, positive: inputs.positive, seed, batch });
    const debugId = `bake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(BAKE_DRAW_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "img2img", pose_edit: { image1: inputs.image1, image2: inputs.image2 }, source_empty: false,
        bbox: work, inference_size: size, output_size: output, debug_id: debugId, settings,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    const images = Array.isArray(data.images) && data.images.length ? data.images : [data.image].filter(Boolean);
    if (!images.length) throw new Error("The bake returned no images.");
    if (!uc.layers.includes(layer)) throw new Error("The pose layer was removed while baking.");
    const results = [];
    for (const image of images) {
      const loaded = await uc.loadImage(uc.resultImageURL(image));
      const result = await extractCharacter(layer, characterId, loaded, work, rect, inputs.solo);
      result.seed = Number.isFinite(image?.seed) ? image.seed : seed;
      results.push(result);
    }
    const toWorld = (box) => box && ({ x: rect.x + box.x * rect.width, y: rect.y + box.y * rect.height, width: (box.width || 0) * rect.width, height: (box.height || 0) * rect.height });
    const headRect = toWorld(anchors?.head) || (() => {
      const box = results[0].silhouetteBox;
      return { x: box.x, y: box.y, width: box.width, height: box.height * 0.18 };
    })();
    const feet = anchors?.feet ? { x: rect.x + anchors.feet.x * rect.width, y: rect.y + anchors.feet.y * rect.height } : (() => {
      const box = results[0].silhouetteBox;
      return { x: box.x + box.width / 2, y: box.y + box.height };
    })();
    const label = model.useCurrent ? (uc.settings.selected_preset_id || uc.settings.generation_mode) : (model.preset?.id || model.family);
    return { results, work, size, meta: { poseHash, refHash, model: String(label || ""), headRect, feetPoint: feet } };
  }

  function applyBake(layer, characterId, result, meta) {
    const bake = ensurePoseBake(layer.pose);
    layer.bakeParts = { ...partsOf(layer), [characterId]: { surface: result.surface, rect: { ...result.rect }, anchor: { ...result.anchor } } };
    bake.characters[characterId] = normalizeEntry({ status: "baked", ...meta, seed: result.seed, bakedAt: Date.now() });
    // The entry's hashes describe the scene the bake was generated from; a later edit is stale.
    bake.characters[characterId].status = bakeStatus(uc.layers, layer, characterId);
    rebuildView(layer);
    uc.markLayerPixelsChanged?.(layer);
    refreshLayer(layer);
  }

  // A failed re-bake keeps the pixels of the previous bake; only the error is new.
  function markFailed(layer, characterId, error) {
    const bake = ensurePoseBake(layer.pose);
    const previous = bake.characters[characterId] || {};
    const kept = hasPart(layer, characterId) && ["baked", "stale"].includes(previous.status);
    bake.characters[characterId] = normalizeEntry({ ...previous, status: kept ? previous.status : "failed", error: String(error?.message || error) });
    refreshLayer(layer);
  }

  const setBusy = (layer, id, on) => {
    const set = busy.get(layer.id) || new Set();
    if (on) set.add(id); else set.delete(id);
    if (set.size) busy.set(layer.id, set); else busy.delete(layer.id);
    refreshLayer(layer);
  };

  function progress(message, value) {
    uc.updateGenerationProgress?.({ progress: value, message }, true);
  }

  /** Card Bake / Re-bake: the result is staged in place (accept / discard / next, batch variants). */
  async function stageBake(layer, characterId, { rebake = false } = {}) {
    if (uc.drawInProgress || busy.get(layer.id)?.has(characterId)) return;
    if (layer.locked) { uc.setStatus("Unlock the pose layer to bake it.", true); return; }
    const character = poseStudioCharacters(layer.pose).find((item) => item.id === String(characterId));
    const issue = poseCharacterIssues(uc, layer).find((item) => item.characterId === String(characterId));
    if (issue) { uc.setStatus(`${character?.name || "Character"}: ${issue.issue}`, true); return; }
    const randomize = rebake || (uc.settings.seed_mode || "fixed") === "randomize";
    const seed = randomize ? newSeed() : Number(uc.settings.seed) || newSeed();
    const batch = Math.max(1, Math.min(8, Math.round(Number(uc.settings.batch_size) || 1)));
    setBusy(layer, characterId, true);
    uc.setStatus(`Baking ${character?.name || "character"}...`);
    try {
      const out = await api.runBake(layer, characterId, { seed, batch });
      for (const result of out.results) {
        uc.addStagingItem({
          url: result.surface.toDataURL("image/png"), img: result.surface, bbox: { ...out.work },
          displaySize: { width: out.work.width, height: out.work.height }, inferenceSize: out.size,
          visible: true, mode: "img2img", maskCanvas: null, userMaskCanvas: null, resultMaskCanvas: null,
          panoramaCamera: null, snapshot: { seed: result.seed, mode: "bake" },
          bake: { layerId: layer.id, characterId: String(characterId), result, meta: out.meta },
        });
      }
      uc.render?.();
      uc.setStatus(`Bake of ${character?.name || "character"} staged: accept, discard or pick another variant.`);
    } catch (error) {
      markFailed(layer, characterId, error);
      uc.setStatus(`Bake failed: ${error.message || error}`, true);
    } finally {
      setBusy(layer, characterId, false);
    }
  }

  /** Accepting a staged bake writes it as one history entry and discards the other variants. */
  function acceptStaged(staging) {
    const info = staging?.bake;
    const layer = uc.layers.find((item) => item.id === info?.layerId);
    uc.stagingItems = [];
    uc.activeStagingIndex = -1;
    if (!layer || layer.type !== "pose") {
      uc.setStatus("The pose layer of this bake no longer exists.", true);
      uc.requestRender();
      return;
    }
    const before = uc.createLayerPixelSnapshot(layer);
    api.applyBake(layer, info.characterId, info.result, info.meta);
    uc.pushHistoryEntry({ kind: "layerPixels", layerId: layer.id, before, after: uc.createLayerPixelSnapshot(layer) });
    uc.syncToNode?.();
    uc.renderLayerList();
    uc.setStatus("Bake accepted.");
  }

  /** Bakes a list of candidates in order, auto-accepted. Returns { entries, error }. */
  async function bakeSequence(candidates) {
    const befores = new Map();
    let error = null;
    for (const [index, candidate] of candidates.entries()) {
      const { layer, characterId, name } = candidate;
      if (!uc.layers.includes(layer)) continue;
      progress(`Baking ${name} (${index + 1}/${candidates.length})`, index / candidates.length);
      if (!befores.has(layer)) befores.set(layer, uc.createLayerPixelSnapshot(layer));
      setBusy(layer, characterId, true);
      try {
        const out = await api.runBake(layer, characterId, { seed: newSeed(), batch: 1 });
        api.applyBake(layer, characterId, out.results[0], out.meta);
      } catch (failure) {
        markFailed(layer, characterId, failure);
        error = new Error(`${name}: ${failure.message || failure}`);
      } finally {
        setBusy(layer, characterId, false);
      }
      if (error) break;
    }
    const entries = [];
    for (const [layer, before] of befores) {
      if (uc.layers.includes(layer)) entries.push({ kind: "layerPixels", layerId: layer.id, before, after: uc.createLayerPixelSnapshot(layer) });
    }
    return { entries, error };
  }

  /** Layer menu "Bake characters": every bound, unbaked or stale character of that layer, one undo step. */
  async function bakeLayer(layer) {
    if (uc.drawInProgress) return;
    if (layer?.type !== "pose") return;
    if (layer.locked) { uc.setStatus("Unlock the pose layer to bake it.", true); return; }
    const candidates = collectBakeCandidates({ layers: uc.layers, bbox: layer.pose.rect }, { includeStale: true, hasPart })
      .filter((item) => item.layer === layer);
    if (!candidates.length) {
      uc.setStatus(poseCharacterIssues(uc, layer).length ? "Bind a character reference to a mannequin to bake it." : "Every character of this layer is already baked.");
      return;
    }
    uc.drawInProgress = true;
    if (uc.drawBtn) uc.drawBtn.disabled = true;
    let result;
    try { result = await bakeSequence(candidates); }
    finally {
      uc.drawInProgress = false;
      if (uc.drawBtn) uc.drawBtn.disabled = false;
    }
    if (result.entries.length) uc.pushHistoryEntry(result.entries.length === 1 ? result.entries[0] : { kind: "historyGroup", entries: result.entries });
    uc.syncToNode?.();
    uc.renderLayerList();
    progress(result.error ? `Bake failed: ${result.error.message}` : "Bake complete", 1);
    uc.setStatus(result.error ? `Bake failed: ${result.error.message}` : `Baked ${candidates.length} character${candidates.length === 1 ? "" : "s"}.`, Boolean(result.error));
  }

  /**
   * GENERATE pre-pass. Returns false when the scene pass must not run (a bake failed or the
   * canvas is busy). Successful bakes wait for the scene result's acceptance, so that the bakes
   * and the accepted result are one undo step.
   */
  async function beforeScenePass() {
    if (uc.drawInProgress) return false;
    // The scene pass reads the composite view, which shows mannequins while a pose is edited.
    if (uc.tool === "pose") uc.finishPoseEdit?.(true);
    const editor = uc.poseEditor;
    if (editor?.layer && editor.initialized) {
      try { await editor.flush(); } catch (_) { /* The scene pass uses the last committed pixels. */ }
    }
    flushPendingHistory();
    // Scene Generate switched off (Settings > VNCCS > UniCanvas): GENERATE runs the scene only.
    const candidates = isUniCanvasEnabled("sceneGenerate") ? collectBakeCandidates(uc, { includeStale: uc.settings.rebake_stale_on_generate !== false, hasPart }) : [];
    if (!candidates.length) return true;
    uc.drawInProgress = true;
    if (uc.drawBtn) uc.drawBtn.disabled = true;
    let result;
    try { result = await bakeSequence(candidates); }
    finally {
      uc.drawInProgress = false;
      if (uc.drawBtn) uc.drawBtn.disabled = false;
    }
    uc.syncToNode?.();
    uc.renderLayerList();
    if (result.error) {
      if (result.entries.length) uc.pushHistoryEntry({ kind: "historyGroup", entries: result.entries });
      uc.setStatus(`Bake failed, the scene was not generated. ${result.error.message}`, true);
      progress(`Bake failed: ${result.error.message}`, 1);
      return false;
    }
    pending = result.entries.length ? result.entries : null;
    return true;
  }

  /* ---------------- History ---------------- */

  function flushPendingHistory() {
    if (!pending) return;
    const entries = pending;
    pending = null;
    uc.pushHistoryEntry({ kind: "historyGroup", entries });
  }

  /** Called by pushHistoryEntry: the scene result's acceptance absorbs the pending bakes. */
  function wrapHistoryEntry(entry) {
    if (!pending) return entry;
    const entries = pending;
    pending = null;
    if (entry?.kind === "acceptStaging") return { kind: "historyGroup", entries: [...entries, entry] };
    uc.pushHistoryEntry({ kind: "historyGroup", entries });
    return entry;
  }

  function snapshot(layer) {
    if (layer?.type !== "pose") return {};
    return {
      bakeParts: layer.bakeParts ? { ...layer.bakeParts } : null,
      mannequinSurface: layer.mannequinSurface ? (uc.cloneCanvas ? uc.cloneCanvas(layer.mannequinSurface) : layer.mannequinSurface) : null,
    };
  }

  function restoreSnapshot(layer, stored, { rebuild = true } = {}) {
    if (layer?.type !== "pose" || !stored || !("bakeParts" in stored)) return;
    const had = Object.keys(partsOf(layer)).length > 0;
    layer.bakeParts = stored.bakeParts ? { ...stored.bakeParts } : undefined;
    if (stored.mannequinSurface) layer.mannequinSurface = uc.cloneCanvas ? uc.cloneCanvas(stored.mannequinSurface) : stored.mannequinSurface;
    if (!rebuild) { layer._bakeViewBaked = Boolean(stored.bakeParts); refreshLayer(layer); return; }
    if (!had && !stored.bakeParts) return;
    // The restored canvas shows whichever view was current then; rebuild it for the current state.
    layer._bakeViewBaked = true;
    rebuildView(layer);
    refreshLayer(layer);
  }

  /* ---------------- Persistence (state cache only) ---------------- */

  function serialize(layer) {
    if (layer?.type !== "pose") return null;
    const parts = {};
    for (const [id, part] of Object.entries(partsOf(layer))) {
      if (part?.surface) parts[id] = { rect: { ...part.rect }, anchor: { ...part.anchor }, dataURL: part.surface.toDataURL("image/png") };
    }
    const mannequin = layer.mannequinSurface && layer._bakeViewBaked ? layer.mannequinSurface.toDataURL("image/png") : null;
    if (!Object.keys(parts).length && !mannequin) return null;
    return { mannequinDataURL: mannequin, parts };
  }

  async function restore(layer, stored) {
    if (layer?.type !== "pose" || !stored) return;
    const toCanvas = async (url) => {
      const image = await uc.loadImage(url);
      const canvas = uc._createCanvas(Math.max(1, image.naturalWidth || image.width), Math.max(1, image.naturalHeight || image.height));
      canvas.getContext("2d").drawImage(image, 0, 0);
      return canvas;
    };
    try {
      if (stored.mannequinDataURL) layer.mannequinSurface = await toCanvas(stored.mannequinDataURL);
      const parts = {};
      for (const [id, part] of Object.entries(stored.parts || {})) {
        if (!part?.dataURL || !part.rect || !part.anchor) continue;
        parts[id] = { surface: await toCanvas(part.dataURL), rect: { ...part.rect }, anchor: { ...part.anchor } };
      }
      if (Object.keys(parts).length) layer.bakeParts = parts;
      // The saved layer pixels are the composite view unless the mannequins were shown.
      layer._bakeViewBaked = Object.keys(parts).length > 0 && layer.pose?.bake?.showMannequin !== true;
    } catch (_) { /* Missing bake pixels read as unbaked. */ }
  }

  /** Pixel revisions restart on load: saved "baked" entries of layer references stay baked. */
  function afterStateRestore() {
    for (const layer of uc.layers) {
      if (layer.type !== "pose" || !layer.pose?.bake) continue;
      layer.pose.bake = normalizePoseBake(layer.pose.bake);
      for (const [id, entry] of Object.entries(layer.pose.bake.characters)) {
        if (entry.status === "baked") entry.refHash = bakeRefHash(uc.layers, layer, id);
        else if (entry.status === "stale") entry.refHash = "stale";
      }
      if (!layer.mannequinSurface && !layer._bakeViewBaked && layer.hiresCanvas) layer.mannequinSurface = layer.hiresCanvas;
    }
    scheduleGenerateLabel();
  }

  /* ---------------- UI ---------------- */

  function scheduleGenerateLabel() {
    if (labelTimer) return;
    labelTimer = setTimeout(() => {
      labelTimer = 0;
      updateGenerateLabel();
    }, 150);
  }

  function updateGenerateLabel() {
    const button = uc.drawBtn;
    if (!button || typeof button.appendChild !== "function") return;
    let count = 0;
    try { count = isUniCanvasEnabled("sceneGenerate") ? collectBakeCandidates(uc, { includeStale: uc.settings?.rebake_stale_on_generate !== false, hasPart }).length : 0; }
    catch (_) { count = 0; }
    let badge = button.querySelector?.(".vnccs-uc-bake-count");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "vnccs-uc-bake-count";
      badge.style.cssText = "margin-left:6px; font-size:10px; font-weight:600; opacity:.85;";
      button.appendChild(badge);
    }
    badge.textContent = generateBakeLabel(count);
    badge.hidden = !count;
    button.title = count ? `Generate: bakes ${count} character${count === 1 ? "" : "s"} first, then the scene` : "Generate";
  }

  function chip(status) {
    const element = document.createElement("span");
    element.className = `vnccs-uc-bake-chip ${status}`;
    element.dataset.bakeStatus = status;
    element.textContent = bakeChipLabel(status);
    const colors = { baked: "#7be07b", stale: "#f0c060", failed: "#ff8a8a", baking: "#8fb8ff", none: "rgba(232,232,240,.6)" };
    element.style.cssText = `display:inline-block; padding:1px 6px; border-radius:8px; border:1px solid currentColor; font-size:10px; color:${colors[status] || colors.none};`;
    return element;
  }

  function bakeRow(layer, characterId) {
    const status = statusOf(layer, characterId);
    const row = document.createElement("div");
    row.className = "vnccs-uc-bake-row";
    row.dataset.characterId = characterId;
    row.style.cssText = "display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:4px;";
    row.appendChild(chip(status));
    const baked = status === "baked" || status === "stale";
    const button = uc._button(baked ? "Re-bake" : "Bake", "vnccs-uc-btn", () => void stageBake(layer, characterId, { rebake: baked }),
      baked ? "Bake again with a new seed" : "Generate this character in its pose and placement");
    button.dataset.bakeAction = baked ? "rebake" : "bake";
    button.disabled = status === "baking" || layer.locked || poseCharacterIssues(uc, layer).some((item) => item.characterId === characterId);
    row.appendChild(button);
    const error = layer.pose?.bake?.characters?.[characterId]?.error;
    if (status === "failed" && error) {
      const note = document.createElement("div");
      note.className = "vnccs-uc-bake-error";
      note.style.cssText = "flex-basis:100%; color:#ff8a8a; font-size:10px;";
      note.textContent = error;
      row.appendChild(note);
    }
    return row;
  }

  /** Bake chip and Bake / Re-bake per character row of the pose editor's reference card. */
  function renderCardChips(editor) {
    const layer = editor?.layer;
    if (!layer || layer.type !== "pose" || !editor.characterMenu) return;
    const mannequins = poseStudioCharacters(layer.pose);
    if (mannequins.length > 1) {
      editor.characterBakeSlot?.replaceChildren?.();
      for (const item of editor.characterList?.children || []) {
        const id = item.getAttribute?.("data-character-id") ?? item.attrs?.["data-character-id"];
        if (id == null) continue;
        item.querySelector?.(".vnccs-uc-bake-row")?.remove?.();
        item.appendChild(bakeRow(layer, String(id)));
      }
      return;
    }
    if (!editor.characterBakeSlot) {
      editor.characterBakeSlot = document.createElement("div");
      editor.characterBakeSlot.className = "vnccs-uc-bake-slot";
      editor.characterMenu.appendChild(editor.characterBakeSlot);
    }
    editor.characterBakeSlot.replaceChildren(bakeRow(layer, mannequins[0].id));
  }

  /** A depth-scaled move (vnccs_unicanvas_scene_place.mjs): the baked characters scale along. */
  function onDepthScale(layer, map, previousRect) {
    if (layer?.type !== "pose" || !layer.pose?.rect || !previousRect) return;
    scaleBakeWithPlacement(layer, map, previousRect);
    rebuildView(layer);
  }

  function setShowMannequin(layer, show) {
    if (layer?.type !== "pose") return;
    // A view toggle, not an edit: no history entry.
    ensurePoseBake(layer.pose).showMannequin = Boolean(show);
    rebuildView(layer);
    uc.refreshLayerRow?.(layer.id);
    uc.syncToNode?.();
  }

  /** Layer row: a short bake summary and the Show mannequin toggle once anything is baked. */
  function decorateLayerRow(row, layer) {
    if (layer?.type !== "pose" || !row) return;
    const statuses = poseStudioCharacters(layer.pose).map((item) => statusOf(layer, item.id));
    const baked = statuses.filter((status) => status === "baked" || status === "stale").length;
    const stale = statuses.filter((status) => status === "stale").length;
    const type = row.querySelector?.(".vnccs-uc-layer-type");
    if (type && baked) type.textContent = `${type.textContent} · ${baked}/${statuses.length} baked${stale ? `, ${stale} stale` : ""}`;
    if (!Object.keys(partsOf(layer)).length) return;
    const show = layer.pose?.bake?.showMannequin === true;
    const toggle = uc._button(show ? "Show baked" : "Show mannequin", "vnccs-uc-btn vnccs-uc-bake-toggle", null,
      show ? "Show the baked characters" : "Show the mannequins instead of the baked characters");
    toggle.dataset.bakeToggle = "";
    toggle.setAttribute?.("aria-pressed", String(show));
    toggle.style.cssText = "font-size:10px; padding:2px 6px;";
    toggle.addEventListener("click", (event) => { event.stopPropagation(); setShowMannequin(layer, !show); });
    toggle.addEventListener("dblclick", (event) => event.stopPropagation());
    const lock = row.querySelector?.("[data-layer-lock]");
    if (lock) row.insertBefore(toggle, lock); else row.appendChild(toggle);
  }

  function onToolChanged(previous, next) {
    if (previous !== "pose" && next !== "pose") return;
    for (const layer of uc.layers) if (layer.type === "pose" && (layer._bakeViewBaked || showsBakedView(layer))) rebuildView(layer);
  }

  /** "Character bake" group of the settings popover. */
  function buildSettings(ui) {
    const { bind, makeSelect, checkboxRow, commit } = ui;
    const s = uc.settings;
    const familyValue = BAKE_FAMILIES.some(([key]) => key === s.bake_model_family) ? s.bake_model_family : BAKE_FAMILIES[0][0];
    const family = makeSelect(filterUniCanvasChoices(BAKE_FAMILIES, isUniCanvasFamilyEnabled, familyValue), familyValue);
    const presetSelect = makeSelect([["", "First ready preset"]], "");
    const note = document.createElement("div");
    note.style.cssText = "opacity:.75; line-height:1.35;";
    const fillPresets = () => {
      const baseOf = (mode) => modelModule(mode)?.base || mode;
      const list = (uc.presets || []).filter((preset) => baseOf(preset?.settings?.generation_mode || preset?.id) === family.value);
      presetSelect.replaceChildren();
      for (const [value, label] of [["", "First ready preset"], ...list.map((preset) => [preset.id,
        `${preset.label || preset.name || preset.id}${uc.presetStatus?.(preset)?.installed ? "" : " (not downloaded)"}`])]) {
        const option = document.createElement("option");
        option.value = value; option.textContent = label;
        if (value === (s.bake_preset_id || "")) option.selected = true;
        presetSelect.appendChild(option);
      }
      const model = bakeModel();
      note.textContent = model.useCurrent ? "The current engine bakes (it is QiE2511 or Klein9b)."
        : model.error ? model.error : `Bakes use ${model.preset?.label || model.preset?.id}${model.ready ? "" : " (download it first)"}.`;
    };
    family.addEventListener("input", () => { s.bake_model_family = family.value; s.bake_preset_id = ""; fillPresets(); commit(); });
    presetSelect.addEventListener("input", () => { s.bake_preset_id = presetSelect.value; fillPresets(); commit(); });
    bind("Bake model family", family);
    bind("Bake preset", presetSelect);
    const number = (key, label, step) => {
      const input = document.createElement("input");
      input.type = "number"; input.className = "vnccs-uc-input"; input.step = step; input.min = "0";
      input.placeholder = "family default";
      input.value = Number(s[key]) > 0 ? String(s[key]) : "";
      input.addEventListener("input", () => { const value = Number(input.value); s[key] = value > 0 ? value : null; commit(); });
      bind(label, input);
    };
    number("bake_steps", "Bake steps (optional)", "1");
    number("bake_cfg", "Bake CFG (optional)", "0.1");
    checkboxRow("Re-bake stale characters on Generate", s.rebake_stale_on_generate !== false, (checked) => {
      s.rebake_stale_on_generate = checked; commit(); scheduleGenerateLabel();
    });
    bind("", note);
    fillPresets();
  }

  const api = {
    showsBakedView, rebuildView, afterCommit, beforeScenePass, stageBake, bakeLayer, acceptStaged,
    wrapHistoryEntry, flushPendingHistory, snapshot, restoreSnapshot, serialize, restore, afterStateRestore,
    renderCardChips, decorateLayerRow, setShowMannequin, onDepthScale, onToolChanged, buildSettings, scheduleGenerateLabel,
    updateGenerateLabel, candidates: () => collectBakeCandidates(uc, { includeStale: uc.settings?.rebake_stale_on_generate !== false, hasPart }),
    status: (layer, id) => statusOf(layer, id),
    get pending() { return pending; },
    // The pipeline steps, called through this object so tests can replace them.
    runBake, applyBake,
  };
  uc.poseBake = api;
  uc.bakePoseCharacters = (layer = uc.activeLayer) => bakeLayer(layer);
  return uc;
}

