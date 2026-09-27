/**
 * VNCCS UniCanvas - automatic layer names and categories (issue #17).
 *
 * - Rules first (vnccs_unicanvas_naming_rules.mjs): on creation a layer gets its provenance name
 *   right away ("Eileen", "Paint 3", the first prompt words, the file stem).
 * - The local VLM (backend describe_layers route; Qwen3-VL 2B by default, SmolVLM 256M as the
 *   light option) refines generated and painted layers in the background and returns a
 *   category. Requests are debounced (800 ms) and batched (16 layers). A reply is dropped when
 *   its layer was deleted, renamed by the user, renamed again or regenerated meanwhile.
 * - Naming never blocks the UI and never creates history entries. Auto-filing
 *   (vnccs_unicanvas_filing.mjs) joins the layer's creation entry.
 * - "Auto-name" in the layer context menu resets a layer to nameSource "auto" and names it again
 *   with the model. nameSource "user" and "import" names are never replaced automatically.
 * - Groups with nameSource "auto" take the character all their layers share, else the model
 *   names them from their children's names.
 * The first model use downloads it and the status line says so. "Auto naming" in the settings is
 * Off / Rules only / Rules + model; nothing is downloaded unless the level needs the model.
 */

import { isMaskSectionLayer } from "./vnccs_unicanvas_control.mjs";
import { autoFileLayer } from "./vnccs_unicanvas_filing.mjs";
import { isGroupLayer } from "./vnccs_unicanvas_groups.mjs";
import { isUniCanvasAutoNameModelEnabled, isUniCanvasEnabled, isUniCanvasNamingModelAvailable, pickEnabledUniCanvasChoice } from "./vnccs_unicanvas_feature_toggles.mjs";
import { groupCharacterName, modelLayerName, nameSourceForOrigin, normalizeLayerCategory, rulesCategory, rulesLayerName } from "./vnccs_unicanvas_naming_rules.mjs";

export const DESCRIBE_LAYERS_ROUTE = "/vnccs/unicanvas/describe_layers";
export const AUTO_NAME_SETTING = "auto_name_layers"; // legacy boolean: true reads as "model"
export const AUTO_NAMING_SETTING = "auto_naming";
export const AUTO_NAMING_LEVELS = [
  ["off", "Off"],
  ["rules", "Rules only"],
  ["model", "Rules + model"],
];
export const AUTO_NAME_MODEL_SETTING = "auto_name_model";
export const AUTO_NAME_MODELS = [
  ["qwen3vl_2b", "Qwen3-VL 2B (recognizes what it sees, ~4 GB)"],
  ["smolvlm_256m", "SmolVLM 256M (fast, vague, ~500 MB)"],
];
export const NAMING_DEBOUNCE_MS = 800;
export const MAX_NAMING_BATCH = 16;
const AUTO_NAME_DOWNLOAD = { qwen3vl_2b: "~4 GB", smolvlm_256m: "~500 MB" };

export function resolveAutoNameModel(settings) {
  const value = settings?.[AUTO_NAME_MODEL_SETTING];
  const saved = AUTO_NAME_MODELS.some(([key]) => key === value) ? value : AUTO_NAME_MODELS[0][0];
  // A model switched off in Settings > VNCCS > UniCanvas is replaced by an allowed one.
  return pickEnabledUniCanvasChoice(saved, AUTO_NAME_MODELS, isUniCanvasAutoNameModelEnabled);
}

/** "off" | "rules" | "model". States saved before the setting existed read the old checkbox. */
export function resolveAutoNamingLevel(settings) {
  const value = settings?.[AUTO_NAMING_SETTING];
  const level = AUTO_NAMING_LEVELS.some(([key]) => key === value) ? value
    : settings?.[AUTO_NAME_SETTING] === true ? "model" : "rules";
  // Settings > VNCCS > UniCanvas: naming switched off, or no naming model allowed to download.
  if (!isUniCanvasEnabled("autoLayerNames")) return "off";
  if (level === "model" && !isUniCanvasNamingModelAvailable()) return "rules";
  return level;
}

function layerImageDataURL(uc, layer) {
  const crop = uc.getLayerAlphaBounds?.(layer);
  if (!crop) return null;
  return uc.cloneCanvasCrop(layer.canvas, crop).toDataURL("image/png");
}

const findLayer = (uc, id) => uc.layers.find((layer) => layer.id === id) || null;

function newToken(layer) {
  layer._nameToken = (layer._nameToken || 0) + 1;
  return layer._nameToken;
}

async function postDescribe(uc, body) {
  const model = resolveAutoNameModel(uc.settings);
  const label = AUTO_NAME_MODELS.find(([key]) => key === model)[1].split(" (")[0];
  uc.setStatus(`[VNCCS UniCanvas] Naming layers with ${label} (first use downloads ${AUTO_NAME_DOWNLOAD[model]})...`);
  const res = await fetch(DESCRIBE_LAYERS_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, model }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/**
 * Asks the model about `layers` (at most MAX_NAMING_BATCH) and `groups`. Applies what still fits:
 * the layer exists, carries the same name token and pixel revision, and (for names) is "auto".
 * Returns the number of renamed layers and groups.
 */
async function requestNames(uc, layers, groups = [], { manual = false } = {}) {
  const items = [];
  const sent = new Map();
  for (const layer of layers.slice(0, MAX_NAMING_BATCH)) {
    const image = layerImageDataURL(uc, layer);
    if (!image) continue;
    sent.set(layer.id, { token: layer._nameToken, revision: layer.pixelRevision, nameSource: layer.nameSource });
    items.push({ id: layer.id, image, prompt: layer.meta?.prompt || undefined, fallback: layer.name });
  }
  const groupItems = groups.map((group) => ({ id: group.id, children: uc.layers.filter((layer) => layer.groupId === group.id).map((layer) => layer.name) }))
    .filter((item) => item.children.length);
  const groupTokens = new Map(groups.map((group) => [group.id, group._nameToken]));
  if (!items.length && !groupItems.length) {
    if (manual) uc.setStatus("[VNCCS UniCanvas] Auto-name: the layer is empty.", true);
    return 0;
  }
  // No naming model may download (Settings > VNCCS > UniCanvas): the rules name stays.
  if (!isUniCanvasNamingModelAvailable()) return 0;
  let data;
  try {
    data = await postDescribe(uc, { layers: items, groups: groupItems });
  } catch (err) {
    uc.setStatus(`[VNCCS UniCanvas] Auto-name failed: ${err.message || err}`, true);
    return 0;
  }
  if (uc._disposed) return 0;
  let renamed = 0;
  const touchedGroups = new Set();
  for (const entry of data.names || []) {
    const layer = findLayer(uc, entry.id);
    const before = sent.get(entry.id);
    // Deleted, renamed, re-requested or regenerated since the request: the answer is stale.
    if (!layer || !before || layer._nameToken !== before.token || layer.pixelRevision !== before.revision) continue;
    const category = entry.parsed === false ? null : normalizeLayerCategory(entry.category);
    if (category && layer.meta) layer.meta.category = category;
    layer._modelNamed = true;
    const answer = typeof entry.name === "string" ? modelLayerName(layer, entry.name) : "";
    if (layer.nameSource === "auto" && entry.parsed !== false && answer && answer !== layer.name) {
      layer.name = answer.slice(0, 80);
      newToken(layer);
      uc.refreshLayerRow?.(layer.id);
      renamed += 1;
    }
    if (layer.groupId) touchedGroups.add(layer.groupId);
    if (category) autoFileLayer(uc, layer);
  }
  for (const entry of data.groups || []) {
    const group = findLayer(uc, entry.id);
    if (!isGroupLayer(group) || group.nameSource !== "auto" || group._nameToken !== groupTokens.get(entry.id)) continue;
    if (typeof entry.name === "string" && entry.name.trim() && entry.name !== group.name) {
      group.name = entry.name.trim().slice(0, 80);
      newToken(group);
      renamed += 1;
    }
  }
  if (renamed) {
    uc.renderLayerList?.();
    uc.syncLightStateToWidget?.();
  }
  uc.setStatus(renamed ? `[VNCCS UniCanvas] Named ${renamed} layer${renamed === 1 ? "" : "s"}.` : manual ? "[VNCCS UniCanvas] Auto-name found no name." : "[VNCCS UniCanvas] Layer names checked.");
  for (const id of touchedGroups) scheduleGroupNaming(uc, findLayer(uc, id));
  return renamed;
}

/** Applies the rules name (nameSource "auto" only). Returns true when the name changed. */
export function applyRulesName(uc, layer) {
  if (!layer || layer.nameSource !== "auto" || isGroupLayer(layer)) return false;
  const { name } = rulesLayerName(layer, uc.layers);
  if (!name || name === layer.name) return false;
  layer.name = name;
  newToken(layer);
  return true;
}

function queueOf(uc) {
  return (uc._vnccsNaming ||= { layers: new Set(), groups: new Set(), timer: null });
}

function scheduleFlush(uc) {
  const queue = queueOf(uc);
  if (queue.timer) clearTimeout(queue.timer);
  queue.timer = setTimeout(() => {
    queue.timer = null;
    void flushNaming(uc);
  }, NAMING_DEBOUNCE_MS);
}

async function flushNaming(uc) {
  const queue = queueOf(uc);
  if (uc._disposed) return;
  const layers = [...queue.layers].map((id) => findLayer(uc, id)).filter(Boolean).slice(0, MAX_NAMING_BATCH);
  for (const layer of layers) queue.layers.delete(layer.id);
  const groups = [...queue.groups].map((id) => findLayer(uc, id)).filter((group) => isGroupLayer(group) && group.nameSource === "auto");
  queue.groups.clear();
  if (queue.layers.size) scheduleFlush(uc); // more than one batch waiting
  if (layers.length || groups.length) await requestNames(uc, layers, groups);
}

function enqueueLayer(uc, layer) {
  if (resolveAutoNamingLevel(uc.settings) !== "model" || !layer) return;
  queueOf(uc).layers.add(layer.id);
  scheduleFlush(uc);
}

/** Names an "auto" group: the shared character by rules, else the model from its children. */
export function scheduleGroupNaming(uc, group) {
  if (!isGroupLayer(group) || group.nameSource !== "auto") return;
  const level = resolveAutoNamingLevel(uc.settings);
  if (level === "off") return;
  const character = groupCharacterName(group, uc.layers);
  if (character) {
    if (character !== group.name) {
      group.name = character;
      newToken(group);
      uc.renderLayerList?.();
      uc.syncLightStateToWidget?.();
    }
    return;
  }
  if (level !== "model" || !uc.layers.some((layer) => layer.groupId === group.id)) return;
  newToken(group);
  queueOf(uc).groups.add(group.id);
  scheduleFlush(uc);
}

/**
 * Creation hook, called by every layer creation site after its history entry is pushed: rules
 * name, auto-filing into the creation entry, and a background model request when useful.
 */
export function onLayerCreated(uc, layer) {
  if (!layer || isMaskSectionLayer(layer) || isGroupLayer(layer)) return;
  const level = resolveAutoNamingLevel(uc.settings);
  if (layer.nameSource !== "user") layer.nameSource = nameSourceForOrigin(layer.meta?.origin);
  newToken(layer);
  if (level !== "off") {
    if (applyRulesName(uc, layer)) uc.refreshLayerRow?.(layer.id);
    const { model } = rulesLayerName(layer, uc.layers);
    // Imported names stay; the model is still asked for the category when rules have none.
    const ask = level === "model" && (model || (layer.nameSource === "import" && !rulesCategory(layer)));
    // A layer the model will categorize is filed when its answer arrives (same creation entry).
    if (ask) enqueueLayer(uc, layer);
    else autoFileLayer(uc, layer);
  }
  if (layer.groupId) scheduleGroupNaming(uc, findLayer(uc, layer.groupId));
}

/**
 * Pixel-commit hook (layerPixels entries): a pose edit may have bound a character, so pose names
 * follow their rules; other layers still carrying their rules name ask the model once.
 */
export function onLayerPixelsCommitted(uc, layer) {
  if (!layer || isMaskSectionLayer(layer) || isGroupLayer(layer)) return;
  const level = resolveAutoNamingLevel(uc.settings);
  if (level === "off" || layer.nameSource !== "auto") return;
  if (layer.type === "pose") {
    if (applyRulesName(uc, layer)) {
      uc.refreshLayerRow?.(layer.id);
      uc.syncLightStateToWidget?.();
      if (layer.groupId) scheduleGroupNaming(uc, findLayer(uc, layer.groupId));
    }
    return;
  }
  const rules = rulesLayerName(layer, uc.layers);
  if (rules.model && rules.name === layer.name && !layer._modelNamed) {
    newToken(layer);
    enqueueLayer(uc, layer);
  }
}

/** After a structure change: auto groups whose children changed get named again. */
export function onLayerStructureChanged(uc) {
  for (const group of uc.layers.filter((layer) => isGroupLayer(layer) && layer.nameSource === "auto")) scheduleGroupNaming(uc, group);
}

/** Inline rename: the user's name wins from now on and pending replies for it are dropped. */
export function onLayerRenamedByUser(uc, layer) {
  if (!layer) return;
  layer.nameSource = "user";
  newToken(layer);
}

/** Organize: ask the model for the categories of unfiled layers that have none yet. */
export async function categorizeUnfiled(uc) {
  if (resolveAutoNamingLevel(uc.settings) !== "model") return;
  const pinnedId = uc.panorama?.settings?.baseLayerId || null;
  const layers = uc.layers.filter((layer) => !isMaskSectionLayer(layer) && !isGroupLayer(layer) && !layer.groupId && layer.id !== pinnedId
    && !normalizeLayerCategory(layer.meta?.category) && !rulesCategory(layer));
  for (let index = 0; index < layers.length; index += MAX_NAMING_BATCH) {
    await requestNames(uc, layers.slice(index, index + MAX_NAMING_BATCH));
  }
}

/** "Auto-name" (layer context menu): back to "auto", rules name, then the model right away. */
export async function autoNameLayers(uc, layers) {
  const targets = layers.filter((layer) => layer && !isMaskSectionLayer(layer));
  for (const layer of targets) {
    if (isGroupLayer(layer)) {
      layer.nameSource = "auto";
      scheduleGroupNaming(uc, layer);
      continue;
    }
    layer.nameSource = "auto";
    layer._modelNamed = false;
    newToken(layer);
    if (applyRulesName(uc, layer)) uc.refreshLayerRow?.(layer.id);
  }
  uc.syncLightStateToWidget?.();
  const leaves = targets.filter((layer) => !isGroupLayer(layer));
  if (leaves.length) await requestNames(uc, leaves, [], { manual: true });
}

export function installUniCanvasAutoNaming(uc) {
  if (!uc || uc._vnccsAutoNamingInstalled) return uc;
  uc._vnccsAutoNamingInstalled = true;
  uc.autoNaming = {
    onLayerCreated: (layer) => onLayerCreated(uc, layer),
    onLayerPixelsCommitted: (layer) => onLayerPixelsCommitted(uc, layer),
    onLayerStructureChanged: () => onLayerStructureChanged(uc),
    onLayerRenamedByUser: (layer) => onLayerRenamedByUser(uc, layer),
    categorizeUnfiled: () => categorizeUnfiled(uc),
    autoName: (layers) => autoNameLayers(uc, layers),
  };
  return uc;
}
