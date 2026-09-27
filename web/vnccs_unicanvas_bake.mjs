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
 *
 * The Bake model comes from the settings' Character bake group: the current engine, a preset of a
 * bake family (Automatic picks the first ready one), or the Custom (installed files) source
 * (`bake_custom`, validated against the loader definitions the main Custom panel exposes through
 * `uc.modelLoaderFields`). Every bake family needs its Pose Studio LoRA (the family's highest
 * installed version, `pose_studio_lora_name`, with `pose_studio_lora_strength`): the settings row
 * reports the installed version, downloads a missing one through the shared preset queue, and
 * offers Update / Skip this version when the backend knows a newer one. An offline status check
 * never blocks a bake.
 */

import { getPoseCharacterMask, isImageRef, poseAtPanoramaCamera, poseCharacterIssues, poseCharacterPrompt,
  poseCharacterRef, poseStudioCharacters } from "./vnccs_unicanvas_pose_state.mjs";
import { studioCharacterList } from "./vnccs_unicanvas_pose_scene.mjs";
import { UNICANVAS_PRESET_MODEL_SETTING_KEYS, forceUniCanvasPresetModelSettings } from "./vnccs_unicanvas_presets.mjs";
import { isLayerEffectivelyVisible } from "./vnccs_unicanvas_groups.mjs";
import { automaticRemoveBgRequest } from "./vnccs_unicanvas_remove_bg.mjs";
import { autoAcceptedHistoryItem } from "./vnccs_unicanvas_history_gallery.mjs";
import { filterUniCanvasChoices, isUniCanvasEnabled, isUniCanvasFamilyEnabled } from "./vnccs_unicanvas_feature_toggles.mjs";
import { installCustomSelects } from "./vnccs_custom_select.mjs";
import { cloneJson, fnv1aHex } from "./vnccs_unicanvas_util.mjs";
import { UNICANVAS_DRAW_ROUTE, drawDebugId, requestDirectDraw, runExclusiveGeneration } from "./vnccs_unicanvas_draw_client.mjs";

// Offline fallback for the bake families (the families whose backend descriptor sets
// capabilities.supports_pose_edit) until /assets has loaded; it also gives the known families
// their short display names and their order.
export const BAKE_FAMILIES = Object.freeze([
  ["qwen_image_edit", "QiE2511"], ["flux_klein", "Klein9b"], ["minimax_h3", "H3"], ["qwen_image21", "QI2.1"],
]);
export const BAKE_STATUSES = Object.freeze(["none", "baked", "stale", "failed"]);
export const BAKE_DRAW_ROUTE = UNICANVAS_DRAW_ROUTE;
export const BAKE_REMOVE_BG_ROUTE = "/vnccs/unicanvas/remove_bg";
// Working rect margin around the pose rect, and crop margin around the solo silhouette.
export const BAKE_WORK_MARGIN = 0.1;
export const BAKE_CROP_MARGIN = 0.15;
// Pose Studio LoRA (the pose edit requirement of every bake family): status from the backend
// (which caches HuggingFace behind its own TTL), downloads through the shared preset queue.
const BAKE_POSE_STUDIO_LORAS_ROUTE = "/vnccs/unicanvas/pose_studio_loras";
const BAKE_POSE_STUDIO_LORA_DOWNLOAD_ROUTE = "/vnccs/unicanvas/pose_studio_loras/download";
// Frontend guard so a settings open or a bake does not hammer the route; the automatic paths
// re-check at most once per TTL, and a failed (offline) check backs off before retrying.
const POSE_STUDIO_LORAS_TTL = 5 * 60 * 1000;
const POSE_STUDIO_LORAS_RETRY = 60 * 1000;
const POSE_STUDIO_LORA_POLL_MS = 2000;
// Watched download statuses frozen for this many polls (30 s at the 2 s cadence) end the wait.
const POSE_STUDIO_LORA_STALL_LIMIT = 15;

const clone = cloneJson;

export const hashText = fnv1aHex;

/* ----------------------------------------------------------------------------------------------
 * State and staleness
 * -------------------------------------------------------------------------------------------- */

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const status = BAKE_STATUSES.includes(entry.status) ? entry.status : "none";
  const result = { status };
  for (const key of ["poseHash", "refHash", "model", "error"]) if (typeof entry[key] === "string" && entry[key]) result[key] = entry[key];
  for (const key of ["seed", "bakedAt", "depth"]) if (Number.isFinite(Number(entry[key])) && entry[key] !== null && entry[key] !== "") result[key] = Number(entry[key]);
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
  } else if (isImageRef(ref)) source = `upload:${uploadHash(ref.dataURL || ref.name)}`;
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
 * The bake families as [key, label] pairs: every backend family descriptor that declares
 * capabilities.supports_pose_edit (a descriptor index may list one descriptor under several
 * aliases). Known families keep their fallback label and order; others follow with their own
 * label. Without descriptors (before /assets loads) the fallback list is used.
 */
export function bakeFamilies(descriptors) {
  const values = descriptors instanceof Map ? [...descriptors.values()] : Array.isArray(descriptors) ? descriptors : Object.values(descriptors || {});
  const seen = new Set();
  const found = [];
  for (const descriptor of values) {
    const key = descriptor?.key ? String(descriptor.key) : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (descriptor.capabilities?.supports_pose_edit) found.push([key, String(descriptor.capabilities?.label || key)]);
  }
  if (!found.length) return BAKE_FAMILIES;
  const rank = (key) => {
    const index = BAKE_FAMILIES.findIndex(([known]) => known === key);
    return index < 0 ? BAKE_FAMILIES.length : index;
  };
  const fallbackLabel = new Map(BAKE_FAMILIES);
  return found
    .map(([key, label], index) => ({ key, label: fallbackLabel.get(key) || label, order: rank(key), index }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ key, label }) => [key, label]);
}

/** "A or B" / "A / B" text for the bake family labels. */
export function bakeFamilyLabels(families = BAKE_FAMILIES, separator = " or ") {
  return families.map(([, label]) => label).join(separator);
}

/**
 * The model a bake runs with: the current engine when it is a bake family; otherwise the Bake
 * model from settings — the Presets source (Automatic = first ready preset, or the picked
 * preset), or the Custom (installed files) source (`bake_model_source: "custom"`, files from
 * `bake_custom`, validated against the shared loader definitions passed as `loaders`).
 */
export function resolveBakeModel(settings, { currentBase, presets = [], presetReady = () => true, baseOf = (mode) => mode, families: bakeList = BAKE_FAMILIES, loaders = null } = {}) {
  const families = bakeList.map(([key]) => key);
  if (families.includes(currentBase)) return { useCurrent: true, family: currentBase };
  if (settings?.bake_model_source === "custom") return resolveCustomBakeModel(settings, bakeList, loaders);
  const wanted = families.includes(settings?.bake_model_family) ? settings.bake_model_family : null;
  const ofFamily = (family) => presets.filter((preset) => baseOf(preset?.settings?.generation_mode || preset?.id) === family);
  // "Automatic" ignores a stored preset pick; a missing source keeps the older preset behavior.
  const chosen = settings?.bake_model_source === "auto" ? null : presets.find((preset) => preset.id === settings?.bake_preset_id);
  if (chosen && (!wanted || baseOf(chosen.settings?.generation_mode || chosen.id) === wanted)) {
    return { preset: chosen, family: baseOf(chosen.settings?.generation_mode || chosen.id), ready: presetReady(chosen) };
  }
  for (const family of wanted ? [wanted] : families) {
    const list = ofFamily(family);
    const ready = list.find((preset) => presetReady(preset));
    if (ready) return { preset: ready, family, ready: true };
    if (wanted && list.length) return { preset: list[0], family, ready: false };
  }
  return { error: `Character bake needs ${bakeFamilyLabels(bakeList)}: choose the Bake model in UniCanvas settings (Character bake).` };
}

const BAKE_CUSTOM_MODEL_FILE_KEYS = Object.freeze(["ckpt_name", "diffusion_model_name", "gguf_model_name"]);

/** Short label of the custom pick's main model file, for the picker head and the history entry. */
function bakeCustomLabel(custom) {
  for (const key of BAKE_CUSTOM_MODEL_FILE_KEYS) {
    const name = String(custom?.[key] || "").replace(/\\/g, "/").split("/").pop() || "";
    if (name) return name.replace(/\.(?:safetensors|gguf|ckpt|pt|pth|bin)$/i, "") || key;
  }
  return "";
}

/**
 * The Custom (installed files) source: the picked files of `settings.bake_custom`, valid only for
 * a bake family and complete for its loader. `loaders` are the shared definitions via
 * `uc.modelLoaderFields()`; without them (or with a wrong family or an incomplete pick) the
 * source reads as an error message, never as a crash.
 */
function resolveCustomBakeModel(settings, bakeList, loaders) {
  const custom = settings?.bake_custom && typeof settings.bake_custom === "object" ? settings.bake_custom : null;
  const families = bakeList.map(([key]) => key);
  const family = families.includes(custom?.generation_mode) ? custom.generation_mode : null;
  if (!family) return { error: "Choose the family of the Custom (installed files) Bake model in UniCanvas settings (Character bake)." };
  const loader = (Array.isArray(loaders) ? loaders : []).find((item) => item?.key === custom.model_loader) || null;
  if (!loader) return { error: "Choose a loader for the Custom (installed files) Bake model in UniCanvas settings (Character bake)." };
  const problem = loader.validate ? loader.validate(custom) : null;
  if (problem) return { error: `The Custom (installed files) Bake model is incomplete: ${problem}` };
  const model = {};
  // The same keys a preset forces (plus the GGUF architecture hint) ride along from the pick.
  for (const key of [...UNICANVAS_PRESET_MODEL_SETTING_KEYS, "gguf_arch"]) {
    if (Object.prototype.hasOwnProperty.call(custom, key)) model[key] = clone(custom[key]);
  }
  return { custom: model, family, ready: true, label: bakeCustomLabel(custom) || family };
}

/**
 * The Bake model picker's menu: one group per bake family that is switched on (the chosen one is
 * kept even when switched off, so the setting stays visible), each with the family's presets.
 */
export function bakePickerGroups(presets, { baseOf = (mode) => mode, familyEnabled = () => true, current = null, families = BAKE_FAMILIES } = {}) {
  return families
    .filter(([family]) => family === current || familyEnabled(family))
    .map(([family, label]) => ({ family, label, presets: (presets || []).filter((preset) => baseOf(preset?.settings?.generation_mode || preset?.id) === family) }))
    .filter((group) => group.presets.length);
}

/** Settings for one bake request, built on the scene settings payload. */
export function bakeSettingsPayload(base, { model, defaults = {}, positive, seed, batch = 1, poseStudioLora = null } = {}) {
  const settings = { ...base };
  if (!model.useCurrent && model.preset) {
    Object.assign(settings, clone(defaults));
    forceUniCanvasPresetModelSettings(settings, model.preset);
    // The scene's LoRAs belong to another family.
    settings.lora_stack = [];
  } else if (model.custom) {
    // The Custom (installed files) pick overrides the family defaults the same way a preset does.
    Object.assign(settings, clone(defaults));
    for (const key of [...UNICANVAS_PRESET_MODEL_SETTING_KEYS, "gguf_arch"]) {
      if (Object.prototype.hasOwnProperty.call(model.custom, key)) settings[key] = model.custom[key];
    }
    settings.model_selection_mode = "custom";
    settings.generation_mode = model.family;
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
  // Pose edit always needs the family's Pose Studio LoRA: the highest installed version (the
  // controller resolves it per family) and the strength from the settings row. While the status
  // is unknown (offline, not checked yet) a name kept in the settings still rides along.
  const loraName = poseStudioLora?.name ?? base?.pose_studio_lora_name;
  if (loraName) settings.pose_studio_lora_name = String(loraName);
  const strength = Number(poseStudioLora?.strength ?? base?.pose_studio_lora_strength ?? 1);
  settings.pose_studio_lora_strength = Number.isFinite(strength) ? Math.min(1.5, Math.max(0, strength)) : 1;
  delete settings.queued_draw;
  delete settings.draw_id;
  return settings;
}

/**
 * The Pose Studio LoRA update banner decision: the backend says a newer version exists
 * (`update_available`), the family has one installed, and the latest version was not skipped.
 * Skipping pins exactly one version string, so the next higher version asks again. Null when
 * nothing should be shown (nothing installed is the Download row, not an update banner).
 */
export function poseStudioLoraBanner(entry, skipped = {}, family = "") {
  const installed = entry?.installed && typeof entry.installed === "object" ? entry.installed : null;
  const latest = entry?.latest && typeof entry.latest === "object" ? entry.latest : null;
  if (!installed?.version || !latest?.version || latest.version === installed.version) return null;
  if (entry.update_available !== true) return null;
  if (family && skipped?.[family] === latest.version) return null;
  return { installed: String(installed.version), latest: String(latest.version), name: String(latest.name || installed.name || "") };
}

/** Skip one version: a copy of `pose_studio_lora_skipped` with `family → version` added. */
export function skipPoseStudioLoraVersion(skipped, family, version) {
  const map = skipped && typeof skipped === "object" && !Array.isArray(skipped) ? { ...skipped } : {};
  if (family && version != null && version !== "") map[String(family)] = String(version);
  return map;
}

/**
 * Remove-background method for bakes: SAM 3 is interactive, so it falls back to BiRefNet (or the
 * next enabled backend). Null when Remove background is switched off: the bake then cuts the
 * character out along its mannequin silhouette.
 */
export function bakeRemoveBgRequest(settings) {
  return automaticRemoveBgRequest(settings);
}

/**
 * Parts drawn back to front. With a camera depth for every part (the distance of the character
 * from the Pose Studio camera at bake time) farther characters come first; bakes made before the
 * depth was recorded fall back to the feet position (feet higher on screen first).
 */
export function orderBakeParts(entries) {
  const list = [...entries];
  if (list.every((entry) => Number.isFinite(entry.depth))) return list.sort((a, b) => b.depth - a.depth);
  return list.sort((a, b) => (a.feetY ?? 0) - (b.feetY ?? 0));
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  uc.onDispose?.(() => {
    if (labelTimer) clearTimeout(labelTimer);
    labelTimer = 0;
  });
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

  /**
   * The character whose staged bake result is on screen (the active, visible staging item of a
   * card Bake): its mannequin and old baked part are hidden under the staged pixels.
   */
  function stagedCharacter(layer) {
    const item = uc.stagingItems?.[uc.activeStagingIndex];
    const bake = item?.visible !== false ? item?.bake : null;
    return bake && layer && bake.layerId === layer.id ? String(bake.characterId) : null;
  }

  function showsBakedView(layer) {
    if (layer?.type !== "pose" || !layer.pose?.rect || editingLayer(layer)) return false;
    if (stagedCharacter(layer)) return true;
    if (layer.pose.bake?.showMannequin) return false;
    return shownParts(layer).length > 0;
  }

  let stagedViewKey = "";
  /**
   * Called on every render: when the staged bake on screen changes (staged, switched, hidden,
   * accepted or discarded), the pose layers involved rebuild their view.
   */
  function syncStagingView() {
    const item = uc.stagingItems?.[uc.activeStagingIndex];
    const bake = item?.visible !== false ? item?.bake : null;
    const key = bake ? `${bake.layerId}\n${bake.characterId}` : "";
    if (key === stagedViewKey) return;
    const layerIds = new Set([stagedViewKey, key].filter(Boolean).map((value) => value.split("\n")[0]));
    stagedViewKey = key;
    for (const layer of uc.layers || []) if (layerIds.has(layer.id)) rebuildView(layer);
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
    const hidden = stagedCharacter(layer);
    const visibleParts = layer.pose.bake?.showMannequin ? [] : shownParts(layer).filter(([id]) => id !== hidden);
    const parts = orderBakeParts(visibleParts.map(([id, part]) => {
      const dx = rect.x - part.anchor.x, dy = rect.y - part.anchor.y;
      const entry = layer.pose.bake.characters[id];
      return { id, part, at: { ...part.rect, x: part.rect.x + dx, y: part.rect.y + dy },
        feetY: entry?.feetPoint?.y, depth: entry?.depth };
    }));
    let union = { ...rect };
    for (const entry of parts) union = unionRect(union, entry.at);
    const density = mannequin ? mannequin.width / Math.max(1, rect.width)
      : parts.length ? parts[0].part.surface.width / Math.max(1, parts[0].part.rect.width) : 1;
    const scale = Math.min(density, 2048 / Math.max(union.width, union.height));
    const out = uc._createCanvas(Math.max(1, Math.round(union.width * scale)), Math.max(1, Math.round(union.height * scale)));
    const ctx = out.getContext("2d");
    const place = (world) => ({ x: (world.x - union.x) * scale, y: (world.y - union.y) * scale, width: world.width * scale, height: world.height * scale });
    const baked = new Set(parts.map((entry) => entry.id));
    const unbaked = poseStudioCharacters(layer.pose).filter((item) => !baked.has(item.id) && item.id !== hidden);
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

  /* ---------------- Pose Studio LoRA (the pose edit requirement) ---------------- */

  // Per-widget state: the backend's family report, when it was fetched, the download keys of the
  // running LoRA job and the render hook of the settings row (set while the popover is open).
  const poseLora = { byFamily: null, fetchedAt: 0, failedAt: 0, pending: null };
  let renderPoseLoraRow = null;
  let loraDownloadKeys = [];

  /** The loader definitions of the main Custom panel, read through the hook — never copied. */
  const modelLoaderDefs = () => uc.modelLoaderFields?.()?.loaders || null;
  const detectBakeFamily = (name) => uc.modelLoaderFields?.()?.detectFamily?.(name) || "";
  const bakeFamilyLabel = (family) => bakeFamilies(uc.modelDescriptors).find(([key]) => key === family)?.[1] || String(family || "");

  /** One family's normalized report from the backend, or null while nothing is known. */
  function poseLoraEntry(family) {
    const entry = poseLora.byFamily?.[family];
    if (!entry || typeof entry !== "object") return null;
    return {
      installed: entry.installed && typeof entry.installed === "object" ? entry.installed : null,
      latest: entry.latest && typeof entry.latest === "object" ? entry.latest : null,
      updateAvailable: entry.update_available === true,
    };
  }

  /** The LoRA of `family`: highest installed version (the backend resolves it) and the strength. */
  function poseStudioLoraForFamily(family) {
    const entry = poseLoraEntry(family);
    const raw = uc.settings?.pose_studio_lora_strength;
    const strength = Number.isFinite(Number(raw)) ? Math.min(1.5, Math.max(0, Number(raw))) : 1;
    return {
      name: String(entry?.installed?.name || uc.settings?.pose_studio_lora_name || ""),
      strength,
      installed: Boolean(entry?.installed?.name || entry?.installed?.version),
    };
  }

  /** Keeps `pose_studio_lora_name` on the highest installed version of the chosen family. */
  function syncPoseStudioLoraSetting() {
    const family = bakeModel().family;
    const entry = family ? poseLoraEntry(family) : null;
    if (!entry) return; // nothing known about this family: keep the stored name
    uc.settings.pose_studio_lora_name = String(entry.installed?.name || "");
  }

  function rerenderPoseLoraRow() {
    if (!renderPoseLoraRow) return;
    try { renderPoseLoraRow(); } catch (_) { /* a closed popover never breaks the refresh */ }
  }

  /**
   * Fetches the family report. Automatic calls (settings open, first bake) respect the TTL and
   * back off after a failure; a network error leaves the state unknown — it never blocks a bake.
   */
  function refreshPoseStudioLoras({ force = false } = {}) {
    if (poseLora.pending) return poseLora.pending;
    if (!force && (Date.now() - poseLora.fetchedAt < POSE_STUDIO_LORAS_TTL || Date.now() - poseLora.failedAt < POSE_STUDIO_LORAS_RETRY)) {
      return Promise.resolve(poseLora.byFamily);
    }
    poseLora.pending = (async () => {
      try {
        const data = await api.fetchPoseStudioLoras();
        poseLora.byFamily = data && typeof data === "object" && !Array.isArray(data) ? data : {};
        poseLora.fetchedAt = Date.now();
        poseLora.failedAt = 0;
      } catch (_) {
        poseLora.failedAt = Date.now();
      } finally {
        poseLora.pending = null;
      }
      syncPoseStudioLoraSetting();
      rerenderPoseLoraRow();
      return poseLora.byFamily;
    })();
    return poseLora.pending;
  }

  /**
   * The bake gate: blocks only when the backend report says the family's LoRA is not installed;
   * offline or not checked yet, the bake runs (unknown never blocks).
   */
  async function ensurePoseStudioLora(family) {
    if (!poseLora.byFamily && Date.now() - poseLora.fetchedAt >= POSE_STUDIO_LORAS_TTL && Date.now() - poseLora.failedAt >= POSE_STUDIO_LORAS_RETRY) {
      await refreshPoseStudioLoras();
    }
    const entry = poseLoraEntry(family);
    if (entry) uc.settings.pose_studio_lora_name = String(entry.installed?.name || "");
    const lora = poseStudioLoraForFamily(family);
    const known = Boolean(entry);
    return { ...lora, known, blocked: known && !lora.installed };
  }

  /** The row's Download / Update: enqueue through the shared queue, poll the shared status. */
  async function downloadPoseStudioLora(family, version) {
    if (!family) return;
    try {
      const keys = await api.startPoseStudioLoraDownload(family, version);
      loraDownloadKeys = Array.isArray(keys) ? keys.map(String) : [];
      rerenderPoseLoraRow();
      // Same cadence as the preset card downloads; the row re-renders with every poll.
      // refreshPresetDownloadStatus swallows its own errors, so a dead backend (or a lost job)
      // leaves the watched entries frozen instead of failing: a snapshot that stays unchanged
      // for `poseLoraStallLimit` polls ends the wait — the row re-enables with a message instead
      // of a frozen progress and a disabled button until reload. The snapshot covers status,
      // message AND progress: a healthy download keeps `status: "downloading"` for minutes while
      // only the percentage climbs, and that movement must reset the stall.
      const watched = () => JSON.stringify(loraDownloadKeys.map((key) => {
        const status = uc.presetDownloads?.[key] || {};
        return [status.status ?? "", status.message ?? "", Number(status.progress) || 0];
      }));
      let stall = 0;
      let snapshot = watched();
      while (loraDownloadKeys.some((key) => ["queued", "downloading"].includes(String(uc.presetDownloads?.[key]?.status)))) {
        await sleep(api.poseLoraPollMs ?? POSE_STUDIO_LORA_POLL_MS);
        if (uc._disposed) return;
        try { await uc.refreshPresetDownloadStatus?.(); } catch (_) { /* the callee never rejects */ }
        rerenderPoseLoraRow();
        const next = watched();
        if (next !== snapshot) {
          snapshot = next;
          stall = 0;
          continue;
        }
        if (++stall >= (api.poseLoraStallLimit ?? POSE_STUDIO_LORA_STALL_LIMIT)) {
          await refreshPoseStudioLoras({ force: true });
          loraDownloadKeys = [];
          rerenderPoseLoraRow();
          uc.setStatus(`The Pose Studio LoRA download for ${bakeFamilyLabel(family)} shows no progress. Check for updates or start the download again.`, true);
          return;
        }
      }
      await refreshPoseStudioLoras({ force: true });
    } catch (error) {
      uc.setStatus(`Pose Studio LoRA download failed: ${error?.message || error}`, true);
      rerenderPoseLoraRow();
    }
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
    return resolveBakeModel(uc.settings, {
      currentBase: uc.getModelBase(), presets: uc.presets || [], presetReady, baseOf,
      families: bakeFamilies(uc.modelDescriptors), loaders: modelLoaderDefs(),
    });
  }

  /** The cut-out alpha of `crop`, or null when Remove background is switched off. */
  async function removeBackground(crop) {
    const request = bakeRemoveBgRequest(uc.settings);
    if (!request) return null;
    const res = await fetch(BAKE_REMOVE_BG_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, image: crop.toDataURL("image/png") }),
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
    const silCrop = dilateAlpha(subAlpha(silAlpha, size.width, cropBox), cropBox.width, cropBox.height,
      Math.max(1, Math.round(0.01 * Math.max(cropBox.width, cropBox.height))));
    // Remove background switched off (Settings > VNCCS > UniCanvas): the mannequin silhouette cuts.
    const alpha = (await removeBackground(crop)) ?? silCrop;
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
    // Pose edit needs the family's Pose Studio LoRA: checked before the first bake of a session
    // (the backend caches), blocking only on a known-missing install, never while offline.
    const lora = await ensurePoseStudioLora(model.family);
    if (lora.blocked) throw new Error(`The Pose Studio LoRA for ${bakeFamilyLabel(model.family)} is not installed. Download it in UniCanvas settings (Character bake).`);
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
    const settings = bakeSettingsPayload(uc.makeSettingsPayload(), {
      model, defaults, positive: inputs.positive, seed, batch,
      poseStudioLora: { name: lora.name, strength: lora.strength },
    });
    const debugId = drawDebugId("bake");
    // History (vnccs_unicanvas_history_gallery.mjs): the caller finishes the run with its results.
    const historyRun = uc.generationHistory?.beginRun("bake", {
      settings, bbox: work, mode: "bake", inferenceSize: size, outputSize: output, targetLayerId: layer.id,
      params: { characterId: String(characterId), batch },
    }) || null;
    try {
      return { ...(await requestBake({ layer, characterId, settings, inputs, work, size, output, rect, anchors, model, seed, debugId, poseHash, refHash })), historyRun };
    } catch (error) {
      historyRun?.fail(error);
      throw error;
    }
  }

  /** The bake request and the extraction of each returned image. */
  async function requestBake({ layer, characterId, settings, inputs, work, size, output, rect, anchors, model, seed, debugId, poseHash, refHash }) {
    const { images } = await requestDirectDraw({
      mode: "img2img", pose_edit: { image1: inputs.image1, image2: inputs.image2 }, source_empty: false,
      bbox: work, inference_size: size, output_size: output, debug_id: debugId, settings,
    }, { route: BAKE_DRAW_ROUTE });
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
    return { results, work, size, meta: { poseHash, refHash, model: String(label || ""), headRect, feetPoint: feet,
      ...(Number.isFinite(anchors?.depth) ? { depth: anchors.depth } : {}) } };
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
      const staged = out.results.map((result) => ({
        url: result.surface.toDataURL("image/png"), img: result.surface, bbox: { ...out.work },
        displaySize: { width: out.work.width, height: out.work.height }, inferenceSize: out.size,
        visible: true, mode: "img2img", maskCanvas: null, userMaskCanvas: null, resultMaskCanvas: null,
        panoramaCamera: null, snapshot: { seed: result.seed, mode: "bake" },
        bake: { layerId: layer.id, characterId: String(characterId), result, meta: out.meta },
      }));
      for (const item of staged) uc.addStagingItem(item);
      out.historyRun?.finish(staged);
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
    const entry = { kind: "layerPixels", layerId: layer.id, before, after: uc.createLayerPixelSnapshot(layer) };
    uc.pushHistoryEntry(uc.generationHistory?.acceptIntoLayer(entry, staging, layer) ?? entry);
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
        out.historyRun?.finish([autoAcceptedHistoryItem({ img: out.results[0].surface, seed: out.results[0].seed, rect: out.work, layerId: layer.id })]);
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
    const result = await runExclusiveGeneration(uc, () => bakeSequence(candidates));
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
    const result = await runExclusiveGeneration(uc, () => bakeSequence(candidates));
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
      // A mannequin saved without parts: the saved pixels were a staged-bake view, so the next
      // rebuild (afterStateRestore) redraws the mannequin.
      layer._bakeViewBaked = (Object.keys(parts).length > 0 && layer.pose?.bake?.showMannequin !== true)
        || (Boolean(stored.mannequinDataURL) && !Object.keys(parts).length);
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
      if (layer._bakeViewBaked && layer.mannequinSurface && !showsBakedView(layer)) rebuildView(layer);
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
    const showing = () => layer.pose?.bake?.showMannequin === true;
    const toggle = uc._button("Show mannequin", "vnccs-uc-btn vnccs-uc-bake-toggle", null);
    toggle.dataset.bakeToggle = "";
    toggle.style.cssText = "font-size:10px; padding:2px 6px;";
    // The row is updated in place (refreshLayerRow), not rebuilt: the button reads the live state
    // on every click and relabels itself, or its second click would repeat the first.
    const sync = () => {
      const show = showing();
      toggle.textContent = show ? "Show baked" : "Show mannequin";
      toggle.title = show ? "Show the baked characters" : "Show the mannequins instead of the baked characters";
      toggle.setAttribute?.("aria-pressed", String(show));
    };
    sync();
    toggle.addEventListener("click", (event) => { event.stopPropagation(); setShowMannequin(layer, !showing()); sync(); });
    toggle.addEventListener("dblclick", (event) => event.stopPropagation());
    const lock = row.querySelector?.("[data-layer-lock]");
    if (lock) row.insertBefore(toggle, lock); else row.appendChild(toggle);
  }

  function onToolChanged(previous, next) {
    if (previous !== "pose" && next !== "pose") return;
    for (const layer of uc.layers) if (layer.type === "pose" && (layer._bakeViewBaked || showsBakedView(layer))) rebuildView(layer);
  }

  /**
   * Seeds an empty Custom (installed files) pick from the chosen family's module defaults, so the
   * panel is usable immediately; keys the user already picked are never overwritten.
   */
  function seedBakeCustom() {
    const s = uc.settings;
    const families = bakeFamilies(uc.modelDescriptors);
    const custom = s.bake_custom && typeof s.bake_custom === "object" ? s.bake_custom : (s.bake_custom = {});
    if (!families.some(([key]) => key === custom.generation_mode)) custom.generation_mode = families[0]?.[0] || "";
    const defaults = modelModule(custom.generation_mode)?.defaults || {};
    const loaderKeys = (modelLoaderDefs() || []).map((loader) => loader.key);
    if (!loaderKeys.includes(custom.model_loader)) {
      custom.model_loader = loaderKeys.includes(defaults.model_loader) ? defaults.model_loader : (loaderKeys[0] || "");
    }
    for (const key of ["ckpt_name", "diffusion_model_name", "gguf_model_name", "clip_name", "vae_name"]) {
      if (custom[key] == null || custom[key] === "") {
        const value = defaults[key];
        if (value != null && value !== "") custom[key] = value;
      }
    }
    if (custom.gguf_arch == null || custom.gguf_arch === "") custom.gguf_arch = "auto";
    return custom;
  }

  /**
   * The Custom (installed files) editor: the family (only bake families), the loader and the
   * loader's file selects, built from the same loader definitions as the main Custom panel
   * (`uc.modelLoaderFields`) with the option lists from `uc.assets`. Picking a model file suggests
   * its family, the way the main panel's file detection does.
   */
  function buildCustomBakePanel(commit, render) {
    const s = uc.settings;
    const families = bakeFamilies(uc.modelDescriptors);
    const defs = modelLoaderDefs() || [];
    const box = document.createElement("div");
    box.className = "vnccs-uc-model-picker-group vnccs-uc-bake-custom";
    box.dataset.bakeCustom = "";
    const title = document.createElement("div");
    title.className = "vnccs-uc-model-picker-group-title";
    title.textContent = "Custom (installed files)";
    box.appendChild(title);
    const rowOf = (labelText, control) => {
      const label = document.createElement("label");
      label.style.cssText = "display:grid; gap:2px; font-size:11px;";
      label.append(document.createTextNode(labelText), control);
      return label;
    };
    const selectOf = (pairs, current, onChange) => {
      const select = document.createElement("select");
      select.className = "vnccs-uc-select";
      if (!pairs.some(([value]) => value === current)) {
        const blank = document.createElement("option");
        blank.value = ""; blank.textContent = "Choose…";
        select.appendChild(blank);
      }
      for (const [value, text] of pairs) {
        const option = document.createElement("option");
        option.value = String(value); option.textContent = String(text);
        select.appendChild(option);
      }
      select.value = current != null && current !== "" ? String(current) : "";
      select.addEventListener("change", () => { onChange(String(select.value)); render(); commit(); });
      return select;
    };
    const custom = () => (s.bake_custom && typeof s.bake_custom === "object" ? s.bake_custom : (s.bake_custom = {}));
    box.appendChild(rowOf("Family", selectOf(families.map(([key, label]) => [key, label]), custom().generation_mode,
      (value) => { custom().generation_mode = value; })));
    if (!defs.length) {
      const note = document.createElement("div");
      note.style.cssText = "opacity:.75; font-size:11px;";
      note.textContent = "The loader definitions are not loaded yet.";
      box.appendChild(note);
      return box;
    }
    const loaderKey = defs.some((loader) => loader.key === custom().model_loader) ? custom().model_loader : seedBakeCustom().model_loader;
    box.appendChild(rowOf("Loader", selectOf(defs.map((loader) => [loader.key, loader.label]), loaderKey,
      (value) => { custom().model_loader = value; })));
    const loader = defs.find((item) => item.key === loaderKey);
    for (const field of loader?.fields || []) {
      const onChange = (value) => {
        custom()[field.setting] = value;
        // A picked model file suggests its family (longest matching token wins); the loader and
        // the other picks stay, the way the main Custom panel keeps them.
        if (BAKE_CUSTOM_MODEL_FILE_KEYS.includes(field.setting)) {
          const detected = detectBakeFamily(value);
          if (detected && detected !== custom().generation_mode && families.some(([key]) => key === detected)) {
            custom().generation_mode = detected;
          }
        }
      };
      box.appendChild(rowOf(field.label, selectOf((uc.assets?.[field.asset] || []).map((name) => [name, name]), custom()[field.setting], onChange)));
    }
    return box;
  }

  /**
   * The Bake model picker: the main model picker's preset cards (status, Download), a head card
   * showing the model bakes use and a menu with the Automatic and Custom (installed files)
   * sources plus one group per bake family. Its own click handler keeps the cards from selecting
   * the scene preset.
   */
  function buildModelPicker(commit) {
    const s = uc.settings;
    const baseOf = (mode) => modelModule(mode)?.base || mode;
    const root = document.createElement("div");
    root.className = "vnccs-uc-model-picker";
    root.dataset.bakeModelPicker = "";
    const note = document.createElement("div");
    note.style.cssText = "opacity:.75; line-height:1.35;";
    const plainButton = (label, className) => {
      const button = document.createElement("button");
      button.type = "button"; button.className = className; button.textContent = label;
      return button;
    };
    const card = (preset, attrs) => {
      const node = uc.buildPresetCard(preset, false, attrs.head === true);
      delete node.dataset.presetId;
      delete node.dataset.presetPickerToggle;
      Object.assign(node.dataset, attrs.data);
      node.classList.toggle("selected", attrs.selected === true);
      return node;
    };
    const render = () => {
      const model = bakeModel();
      const automatic = s.bake_model_source !== "custom" && !s.bake_preset_id;
      root.replaceChildren();
      if (model.preset && typeof uc.buildPresetCard === "function") root.appendChild(card(model.preset, { head: true, data: { bakePickerToggle: "1" } }));
      else {
        const head = plainButton(
          model.useCurrent ? `Current engine (${bakeFamilyLabels(bakeFamilies(uc.modelDescriptors), " / ")})`
            : model.custom ? `Custom (installed files) (${model.label || model.family})`
              : "Choose a Bake model",
          "vnccs-uc-btn");
        head.dataset.bakePickerToggle = "1";
        root.appendChild(head);
      }
      const menu = document.createElement("div");
      menu.className = "vnccs-uc-model-picker-menu";
      const customSource = s.bake_model_source === "custom";
      const auto = plainButton("Automatic: first ready preset", `vnccs-uc-btn${automatic ? " active" : ""}`);
      auto.dataset.bakeSource = "auto";
      menu.appendChild(auto);
      const customButton = plainButton("Custom (installed files)", `vnccs-uc-btn${customSource ? " active" : ""}`);
      customButton.dataset.bakeSource = "custom";
      customButton.title = "Bake with the model files picked below (the main panel's Custom model)";
      menu.appendChild(customButton);
      if (customSource) {
        menu.appendChild(buildCustomBakePanel(commit, render));
      } else {
        const groups = bakePickerGroups(uc.presets || [], { baseOf, familyEnabled: isUniCanvasFamilyEnabled, current: s.bake_model_family || null, families: bakeFamilies(uc.modelDescriptors) });
        for (const group of groups) {
          const box = document.createElement("div");
          box.className = "vnccs-uc-model-picker-group";
          const title = document.createElement("div");
          title.className = "vnccs-uc-model-picker-group-title";
          title.textContent = group.label;
          box.appendChild(title);
          for (const preset of group.presets) {
            if (typeof uc.buildPresetCard !== "function") continue;
            box.appendChild(card(preset, { data: { bakePreset: preset.id, bakeFamily: group.family }, selected: !automatic && s.bake_preset_id === preset.id }));
          }
          menu.appendChild(box);
        }
      }
      root.append(menu, note);
      note.textContent = model.useCurrent ? `The current engine bakes (it is ${bakeFamilyLabels(bakeFamilies(uc.modelDescriptors))}).`
        : model.error ? model.error
          : model.custom ? `Bakes use ${model.label || model.family} (Custom, installed files).`
            : `Bakes use ${model.preset?.label || model.preset?.id}${model.ready ? "" : " (download it first)"}.`;
    };
    root.addEventListener("click", (event) => {
      const target = event.target?.closest?.("[data-preset-download], [data-bake-preset], [data-bake-picker-toggle], [data-bake-source]");
      if (!(target instanceof HTMLElement) || !root.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (target.dataset.presetDownload) {
        uc.downloadPreset?.(target.dataset.presetDownload, "assets");
        return;
      }
      if (target.dataset.bakePickerToggle) {
        root.classList.toggle("open");
        return;
      }
      if (target.dataset.bakeSource) {
        s.bake_model_source = target.dataset.bakeSource;
        if (s.bake_model_source === "auto") s.bake_preset_id = "";
        if (s.bake_model_source === "custom") seedBakeCustom();
        render();
        root.classList.remove("open");
        commit();
        return;
      }
      s.bake_model_source = "preset";
      s.bake_preset_id = target.dataset.bakePreset || "";
      s.bake_model_family = target.dataset.bakeFamily || "";
      render();
      root.classList.remove("open");
      commit();
    });
    render();
    // The custom panel's native selects (family, loader, files) go through the shared custom
    // selector like every first-party select; re-renders are covered by its observer.
    installCustomSelects(root, { theme: "unicanvas" });
    return root;
  }

  /**
   * "Character bake" group of the settings popover.
   */
  function buildSettings(ui) {
    const { bind, checkboxRow, commit } = ui;
    const s = uc.settings;
    // A div, not the label `bind` makes: a click on a card inside a label would activate the
    // label's first button.
    const row = bind("Bake model", buildModelPicker(commit));
    const block = document.createElement("div");
    block.style.cssText = row.style.cssText;
    block.append(...row.childNodes);
    row.replaceWith(block);
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
    buildPoseStudioLoraRow(ui);
  }

  /**
   * The Pose Studio LoRA row of the chosen bake family: installed version, strength (0–1.5,
   * default 1), Check for updates, a Download row while the family has none (bakes stay blocked
   * until it is installed) and the Update / Skip-this-version banner while a newer version is
   * available and not skipped. Opened settings and finished refreshes re-render it in place.
   */
  function buildPoseStudioLoraRow(ui) {
    const { bind, commit } = ui;
    const s = uc.settings;
    const row = document.createElement("div");
    row.className = "vnccs-uc-bake-lora-row";
    row.dataset.poseStudioLora = "";
    row.style.cssText = "display:grid; gap:4px;";
    // A div, not the label `bind` makes: the row holds its own labels (the strength slider), and
    // a label inside a label is invalid.
    const wrap = bind("Pose Studio LoRA", row);
    const block = document.createElement("div");
    block.style.cssText = wrap.style.cssText;
    block.append(...wrap.childNodes);
    wrap.replaceWith(block);
    const progressOf = () => {
      for (const key of loraDownloadKeys) {
        const status = uc.presetDownloads?.[key];
        if (status && ["queued", "downloading"].includes(String(status.status))) {
          return { percent: Math.round(Number(status.progress) * 100) || 0, message: status.message || "Downloading" };
        }
      }
      return null;
    };
    const startDownload = (family, version, button) => {
      if (button) button.disabled = true;
      void downloadPoseStudioLora(family, version);
    };
    renderPoseLoraRow = () => {
      const model = bakeModel();
      const family = model.family || null;
      row.replaceChildren();
      if (!family) return; // no resolvable bake family: nothing to show the LoRA of
      const label = bakeFamilyLabel(family);
      const entry = poseLoraEntry(family);
      const known = Boolean(entry);
      const installed = entry?.installed || null;
      const progress = progressOf();
      const status = document.createElement("div");
      status.style.cssText = "font-size:11px; opacity:.85;";
      status.textContent = known
        ? (installed ? `${label}: installed ${installed.version || installed.name || "?"}` : `${label}: not installed`)
        : `${label}: version unknown`;
      row.appendChild(status);
      if (known && !installed) {
        const note = document.createElement("div");
        note.style.cssText = "font-size:11px; color:#f0c060;";
        note.textContent = "Bakes stay blocked until the LoRA is installed.";
        row.appendChild(note);
      }
      // Strength 0–1.5, default 1: the value and the stored setting follow the drag live
      // (input), the settings persistence commits once per gesture (change).
      const strengthRow = document.createElement("label");
      strengthRow.style.cssText = "display:flex; gap:6px; align-items:center; font-size:11px;";
      const strengthLabel = document.createElement("span");
      const strength = document.createElement("input");
      strength.type = "range"; strength.className = "vnccs-uc-range";
      strength.min = "0"; strength.max = "1.5"; strength.step = "0.05";
      strength.value = String(poseStudioLoraForFamily(family).strength);
      strength.dataset.poseStudioLoraStrength = "";
      const showStrength = () => { strengthLabel.textContent = `Strength ${Number(strength.value).toFixed(2)}`; };
      showStrength();
      strength.addEventListener("input", () => {
        s.pose_studio_lora_strength = Number(strength.value);
        showStrength();
      });
      strength.addEventListener("change", () => commit());
      strengthRow.append(strengthLabel, strength);
      row.appendChild(strengthRow);
      if (progress) {
        const progressNote = document.createElement("div");
        progressNote.style.cssText = "font-size:11px; opacity:.85;";
        progressNote.textContent = `${progress.message} ${progress.percent}%`;
        row.appendChild(progressNote);
      }
      const skipped = s.pose_studio_lora_skipped && typeof s.pose_studio_lora_skipped === "object" ? s.pose_studio_lora_skipped : {};
      const banner = poseStudioLoraBanner(entry, skipped, family);
      if (banner) {
        const bannerBox = document.createElement("div");
        bannerBox.className = "vnccs-uc-bake-lora-update";
        bannerBox.dataset.poseStudioLoraUpdate = "";
        bannerBox.style.cssText = "display:grid; gap:4px; font-size:11px; color:#f0c060;";
        bannerBox.textContent = `Pose Studio LoRA ${label} ${banner.latest} is available (installed ${banner.installed}).`;
        const actions = document.createElement("div");
        actions.style.cssText = "display:flex; gap:6px;";
        const update = uc._button("Update", "vnccs-uc-btn", () => startDownload(family, banner.latest, update),
          "Download the newer version (the installed file stays on disk) and use it right away");
        update.dataset.poseStudioLoraUpdateButton = "";
        const skip = uc._button("Skip this version", "vnccs-uc-btn", () => {
          s.pose_studio_lora_skipped = skipPoseStudioLoraVersion(s.pose_studio_lora_skipped, family, banner.latest);
          commit();
          renderPoseLoraRow();
        }, "Stay on the installed version; the next higher version asks again");
        skip.dataset.poseStudioLoraSkip = "";
        actions.append(update, skip);
        bannerBox.appendChild(actions);
        row.appendChild(bannerBox);
      } else if (known && !installed && entry.latest?.version) {
        const actions = document.createElement("div");
        const download = uc._button("Download", "vnccs-uc-btn", () => startDownload(family, entry.latest.version, download),
          "Download the newest Pose Studio LoRA of this family");
        download.disabled = Boolean(progress);
        actions.appendChild(download);
        row.appendChild(actions);
      }
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex; gap:6px;";
      const check = uc._button("Check for updates", "vnccs-uc-btn", () => {
        check.disabled = true;
        void refreshPoseStudioLoras({ force: true });
      }, "Ask the backend for the newest Pose Studio LoRA versions");
      check.dataset.poseStudioLoraCheck = "";
      check.disabled = Boolean(progress);
      actions.appendChild(check);
      row.appendChild(actions);
    };
    renderPoseLoraRow();
    void refreshPoseStudioLoras();
  }

  const api = {
    showsBakedView, rebuildView, afterCommit, beforeScenePass, stageBake, bakeLayer, acceptStaged,
    wrapHistoryEntry, flushPendingHistory, snapshot, restoreSnapshot, serialize, restore, afterStateRestore, syncStagingView,
    renderCardChips, decorateLayerRow, setShowMannequin, onDepthScale, onToolChanged, buildSettings, scheduleGenerateLabel,
    updateGenerateLabel, candidates: () => collectBakeCandidates(uc, { includeStale: uc.settings?.rebake_stale_on_generate !== false, hasPart }),
    status: (layer, id) => statusOf(layer, id),
    get pending() { return pending; },
    // Pose Studio LoRA: the status for the settings row and the bake gate, the network steps as
    // replaceable hooks so tests can stub them.
    ensurePoseStudioLora, refreshPoseStudioLoras, downloadPoseStudioLora,
    poseLoraStatus: () => poseLora.byFamily,
    // Poll cadence and stall threshold of the LoRA download wait (overridable in tests).
    poseLoraPollMs: POSE_STUDIO_LORA_POLL_MS,
    poseLoraStallLimit: POSE_STUDIO_LORA_STALL_LIMIT,
    fetchPoseStudioLoras: async () => {
      const res = await fetch(BAKE_POSE_STUDIO_LORAS_ROUTE, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error || `Pose Studio LoRA status HTTP ${res.status}`);
      return data;
    },
    startPoseStudioLoraDownload: async (family, version) => {
      const res = await fetch(BAKE_POSE_STUDIO_LORA_DOWNLOAD_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ family, version }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error || `Pose Studio LoRA download HTTP ${res.status}`);
      for (const key of data.queued || []) uc.presetDownloads[key] = { status: "queued", message: "Queued", progress: 0 };
      return Array.isArray(data.queued) ? data.queued : [];
    },
    // The pipeline steps, called through this object so tests can replace them.
    runBake, applyBake,
  };
  uc.poseBake = api;
  uc.bakePoseCharacters = (layer = uc.activeLayer) => bakeLayer(layer);
  return uc;
}

