/**
 * VNCCS UniCanvas scene states (Plan 04, issue #7): Photoshop-style layer comps.
 *
 *  - Data model: `widget.sceneStates = { activeStateId, moveScope, newLayersHidden, states }`.
 *    A state stores per-layer properties keyed by layer id, never pixels: raster and pose
 *    layers keep { visible, opacity, blendMode, offset }, groups keep { visible, opacity }; pose
 *    layers add `showMannequin` and sprite layers `spriteVariantId` (VIEW_PARTS, additive).
 *    Layers a state does not know keep their current properties when it is applied.
 *  - Offsets: the live offset of a layer is `layer.stateOffset` (world pixels). It is applied
 *    at render time through widget.getLayerStateOffset (viewport, flatten, export, generation
 *    composite, bounds, move and transform tools) and never baked into pixels. The backend
 *    compositor (nodes/unicanvas/render.py) honours the serialized `stateOffset` too.
 *  - History: `applySceneState` (previous and applied per-layer properties), `sceneStates`
 *    (state list before / after, thumbnails stripped and regenerated) and `sceneStateOffset`
 *    (a move with "Move affects: this state") are entry kinds of the widget's own
 *    applyHistoryEntry; there is no parallel undo stack.
 *  - Panel: a collapsible States section under Layers with thumbnails, drag to reorder,
 *    hover preview, a "differs" dot, and New / Update / Duplicate / Rename / Note / Delete /
 *    Revert / Export states. Alt+1..9 applies states 1-9 (vnccs_unicanvas_modes.mjs).
 *
 * The pure helpers at the top run under Node for tests; installUniCanvasSceneStates binds the
 * rest onto the widget like installUniCanvasGroups.
 */

import { getGroupDescendants, isGroupLayer, isLayerEffectivelyLocked, isLayerEffectivelyVisible, topLevelSelection } from "./vnccs_unicanvas_groups.mjs";

export const SCENE_STATE_HISTORY_KINDS = new Set(["applySceneState", "sceneStates", "sceneStateOffset"]);
export const MOVE_SCOPE_STATE = "state";
export const MOVE_SCOPE_ALL = "all";
export const MAX_STATE_SHORTCUTS = 9;
export const STATE_THUMBNAIL_SIDE = 112;
export const SAVE_OUTPUT_ROUTE = "/vnccs/unicanvas/save_output";

const newId = () => (globalThis.crypto?.randomUUID?.() || `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
const clamp01 = (value, fallback = 1) => (Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : fallback);

// Pure helpers ---------------------------------------------------------------------------------

/** An integer world-pixel offset; anything malformed is { x: 0, y: 0 }. */
export function normalizeStateOffset(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  return { x: Number.isFinite(x) ? Math.round(x) : 0, y: Number.isFinite(y) ? Math.round(y) : 0 };
}

const isZeroOffset = (offset) => !offset || (!offset.x && !offset.y);

/** Layers a state can capture: everything but masks. */
export const isStateLayer = (layer) => Boolean(layer && layer.id && layer.type !== "mask");

/**
 * View parts a state switches on top of the shared properties: a pose layer's "Show
 * mannequin" (character bake, #5) and a sprite layer's active variant (#6). Each part owns one
 * key of the state entry; `apply` returns true when the layer's view changed, so the widget
 * rebuilds that layer's pixels. Entries saved before a part existed simply lack its key.
 */
const VIEW_PARTS = Object.freeze([
  {
    key: "showMannequin",
    applies: (layer) => layer?.type === "pose" && Boolean(layer.pose),
    read: (layer) => layer.pose?.bake?.showMannequin === true,
    normalize: (value) => (typeof value === "boolean" ? value : undefined),
    apply(layer, value) {
      if ((layer.pose.bake?.showMannequin === true) === value) return false;
      layer.pose.bake = { characters: {}, ...(layer.pose.bake || {}), showMannequin: value };
      return true;
    },
  },
  {
    key: "spriteVariantId",
    applies: (layer) => layer?.type === "sprite" && Boolean(layer.sprite),
    read: (layer) => layer.sprite?.activeVariantId || undefined,
    normalize: (value) => (typeof value === "string" && value ? value : undefined),
    apply(layer, value) {
      const sprite = layer.sprite;
      if (sprite.activeVariantId === value) return false;
      // Only a ready variant can show: a deleted or empty one keeps the current variant.
      if (!sprite.variants?.some((variant) => variant.id === value && variant.status === "ready")) return false;
      sprite.activeVariantId = value;
      return true;
    },
  },
]);
export const SCENE_STATE_VIEW_KEYS = Object.freeze(VIEW_PARTS.map((part) => part.key));

/** The properties one state stores for one layer. */
export function captureLayerState(layer) {
  if (isGroupLayer(layer)) return { visible: layer.visible !== false, opacity: clamp01(layer.opacity) };
  const entry = {
    visible: layer.visible !== false,
    opacity: clamp01(layer.opacity),
    blendMode: typeof layer.blendMode === "string" && layer.blendMode ? layer.blendMode : "source-over",
    offset: normalizeStateOffset(layer.stateOffset),
  };
  for (const part of VIEW_PARTS) {
    const value = part.applies(layer) ? part.read(layer) : undefined;
    if (value !== undefined) entry[part.key] = value;
  }
  return entry;
}

export function captureSceneLayers(layers) {
  const out = {};
  for (const layer of layers || []) if (isStateLayer(layer)) out[layer.id] = captureLayerState(layer);
  return out;
}

function normalizeLayerEntry(entry, group) {
  if (!entry || typeof entry !== "object") return null;
  const out = {};
  if (typeof entry.visible === "boolean") out.visible = entry.visible;
  if (entry.opacity !== undefined && Number.isFinite(Number(entry.opacity))) out.opacity = clamp01(entry.opacity);
  if (!group) {
    if (typeof entry.blendMode === "string" && entry.blendMode) out.blendMode = entry.blendMode;
    if (entry.offset !== undefined) out.offset = normalizeStateOffset(entry.offset);
    for (const part of VIEW_PARTS) {
      const value = part.normalize(entry[part.key]);
      if (value !== undefined) out[part.key] = value;
    }
  }
  return out;
}

/** True when applying `entry` would switch a view part (bake view, sprite variant) of the layer. */
export function layerStateChangesView(layer, entry) {
  if (!layer || !entry || isGroupLayer(layer)) return false;
  return VIEW_PARTS.some((part) => {
    const value = part.applies(layer) ? part.normalize(entry[part.key]) : undefined;
    return value !== undefined && value !== part.read(layer);
  });
}

/**
 * Sets the stored properties on one layer (only the keys the entry has). Returns true when a
 * view part changed, so the caller rebuilds that layer's pixels.
 */
export function applyLayerState(layer, entry) {
  const props = normalizeLayerEntry(entry, isGroupLayer(layer));
  if (!layer || !props) return false;
  if ("visible" in props) layer.visible = props.visible;
  if ("opacity" in props) layer.opacity = props.opacity;
  if ("blendMode" in props) layer.blendMode = props.blendMode;
  if ("offset" in props) {
    if (isZeroOffset(props.offset)) delete layer.stateOffset;
    else layer.stateOffset = { ...props.offset };
  }
  let viewChanged = false;
  for (const part of VIEW_PARTS) {
    if (part.key in props && part.applies(layer) && part.apply(layer, props[part.key])) viewChanged = true;
  }
  return viewChanged;
}

/**
 * Applies a { [layerId]: entry } map to the layers it names and returns the previous
 * properties of exactly those layers (the undo half of an applySceneState entry).
 * `view.before(layer)` runs before a view part of the layer switches (sprites keep unsynced
 * paint), `view.after(layer)` once it switched (the layer's pixels are rebuilt).
 */
export function applySceneLayers(layers, map, view = null) {
  const previous = {};
  if (!map) return previous;
  for (const layer of layers || []) {
    if (!isStateLayer(layer) || !map[layer.id]) continue;
    previous[layer.id] = captureLayerState(layer);
    if (view?.before && layerStateChangesView(layer, map[layer.id])) view.before(layer);
    if (applyLayerState(layer, map[layer.id])) view?.after?.(layer);
  }
  return previous;
}

export function sameLayerState(a, b) {
  if (!a || !b) return false;
  for (const key of ["visible", "opacity", "blendMode", ...SCENE_STATE_VIEW_KEYS]) {
    if (key in a && key in b && (key === "opacity" ? Math.abs(a[key] - b[key]) > 1e-4 : a[key] !== b[key])) return false;
  }
  const ao = normalizeStateOffset(a.offset);
  const bo = normalizeStateOffset(b.offset);
  return ("offset" in a && "offset" in b) ? ao.x === bo.x && ao.y === bo.y : true;
}

/** True when the live layers differ from what the state stores for them. */
export function sceneLayersDiffer(layers, state) {
  if (!state?.layers) return false;
  for (const layer of layers || []) {
    const entry = state.layers[layer.id];
    if (!isStateLayer(layer) || !entry) continue;
    if (!sameLayerState(captureLayerState(layer), entry)) return true;
  }
  return false;
}

/** True when the layer is shown in some states and hidden in others. */
export function layerVariesAcrossStates(scene, layerId) {
  const values = new Set();
  for (const state of scene?.states || []) {
    const entry = state.layers?.[layerId];
    if (entry && typeof entry.visible === "boolean") values.add(entry.visible);
  }
  return values.size > 1;
}

export function nextStateName(states) {
  const used = new Set((states || []).map((state) => state.name));
  let index = (states || []).length + 1;
  while (used.has(`State ${index}`)) index += 1;
  return `State ${index}`;
}

export function createSceneState(fields = {}) {
  const now = Date.now();
  return {
    id: fields.id || newId(),
    name: String(fields.name || "State").slice(0, 120),
    order: Number.isFinite(fields.order) ? fields.order : 0,
    note: typeof fields.note === "string" ? fields.note : "",
    layers: fields.layers || {},
    thumbnailDataURL: typeof fields.thumbnailDataURL === "string" ? fields.thumbnailDataURL : null,
    createdAt: Number.isFinite(fields.createdAt) ? fields.createdAt : now,
    updatedAt: Number.isFinite(fields.updatedAt) ? fields.updatedAt : now,
  };
}

export function emptySceneStates() {
  return { activeStateId: null, moveScope: null, newLayersHidden: false, states: [] };
}

/** Restores a serialized `sceneStates` value; old documents without it load an empty list. */
export function normalizeSceneStates(raw) {
  const scene = emptySceneStates();
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.states)) return scene;
  const seen = new Set();
  const states = [];
  raw.states.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const id = typeof item.id === "string" && item.id && !seen.has(item.id) ? item.id : newId();
    seen.add(id);
    const layers = {};
    if (item.layers && typeof item.layers === "object") {
      for (const [layerId, entry] of Object.entries(item.layers)) {
        const normalized = normalizeLayerEntry(entry, !entry || !("blendMode" in entry || "offset" in entry));
        if (normalized) layers[layerId] = normalized;
      }
    }
    states.push(createSceneState({
      ...item,
      id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : `State ${index + 1}`,
      order: Number.isFinite(item.order) ? item.order : index,
      layers,
    }));
  });
  states.sort((a, b) => a.order - b.order);
  states.forEach((state, index) => { state.order = index; });
  scene.states = states;
  scene.activeStateId = states.some((state) => state.id === raw.activeStateId) ? raw.activeStateId : null;
  scene.moveScope = raw.moveScope === MOVE_SCOPE_STATE || raw.moveScope === MOVE_SCOPE_ALL ? raw.moveScope : null;
  scene.newLayersHidden = raw.newLayersHidden === true;
  return scene;
}

/** A copy without keys for layers that no longer exist. */
export function pruneSceneStates(scene, layerIds) {
  const known = layerIds instanceof Set ? layerIds : new Set(layerIds || []);
  return {
    ...scene,
    states: (scene?.states || []).map((state) => ({
      ...state,
      layers: Object.fromEntries(Object.entries(state.layers || {}).filter(([id]) => known.has(id))),
    })),
  };
}

/** "Hidden in other states": a new layer shows in the active state only. */
export function hideLayerInOtherStates(scene, layer) {
  if (!isStateLayer(layer)) return;
  for (const state of scene?.states || []) {
    state.layers = state.layers || {};
    state.layers[layer.id] = state.id === scene.activeStateId
      ? captureLayerState(layer)
      : { ...captureLayerState(layer), visible: false };
  }
}

export const isLayerReferenced = (scene, layerId) => (scene?.states || []).some((state) => state.layers && layerId in state.layers);

/** The effective move scope: explicit, else "this state" once more than one state exists. */
export function resolveMoveScope(scene) {
  if (scene?.moveScope === MOVE_SCOPE_STATE || scene?.moveScope === MOVE_SCOPE_ALL) return scene.moveScope;
  return (scene?.states?.length || 0) > 1 ? MOVE_SCOPE_STATE : MOVE_SCOPE_ALL;
}

/** State list for history: deep copies without thumbnails (they are regenerated). */
export function snapshotSceneStates(scene) {
  return {
    activeStateId: scene?.activeStateId || null,
    moveScope: scene?.moveScope || null,
    newLayersHidden: scene?.newLayersHidden === true,
    states: (scene?.states || []).map((state) => ({
      ...state,
      thumbnailDataURL: null,
      layers: JSON.parse(JSON.stringify(state.layers || {})),
    })),
  };
}

/** Safe, unique PNG base names from state names (the backend sanitizes again). */
export function exportFileNames(names) {
  const used = new Map();
  return (names || []).map((name, index) => {
    let base = String(name || "").replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").trim().replace(/^\.+|\.+$/g, "").trim().slice(0, 120);
    if (!base) base = `state-${index + 1}`;
    const key = base.toLowerCase();
    const count = (used.get(key) || 0) + 1;
    used.set(key, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

// Widget binding ---------------------------------------------------------------------------------

const STATES_CSS = `
.vnccs-uc-states { flex:0 1 auto; min-height:0; max-height:46%; display:flex; flex-direction:column; }
.vnccs-uc-states .vnccs-uc-section-head { cursor:pointer; user-select:none; }
.vnccs-uc-states.collapsed > :not(.vnccs-uc-section-head) { display:none !important; }
.vnccs-uc-states-body { min-height:0; display:flex; flex-direction:column; }
.vnccs-uc-states-actions { padding:6px; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:5px; border-bottom:1px solid var(--uc-border); }
.vnccs-uc-states-actions .vnccs-uc-btn { width:100%; padding-left:4px; padding-right:4px; }
.vnccs-uc-states-options { padding:6px 8px; display:flex; flex-direction:column; gap:5px; border-bottom:1px solid var(--uc-border); color:var(--uc-muted); font-weight:700; font-size:11px; }
.vnccs-uc-states-options label { display:flex; gap:6px; align-items:center; cursor:pointer; }
.vnccs-uc-states-options .vnccs-uc-btn { width:100%; }
.vnccs-uc-states-list { min-height:0; overflow-y:auto; padding:6px; display:flex; flex-direction:column; gap:5px; }
.vnccs-uc-states-empty { padding:7px 8px; border:1px dashed rgba(255,255,255,.10); border-radius:8px; color:var(--uc-muted); }
.vnccs-uc-state { display:grid; grid-template-columns:52px minmax(0,1fr) auto; gap:7px; align-items:center; padding:5px; border:1px solid var(--uc-border); border-radius:8px; background:rgba(255,255,255,.035); cursor:pointer; }
.vnccs-uc-state.active { border-color:rgba(255,143,163,.55); background:rgba(255,143,163,.12); }
.vnccs-uc-state.dragging { opacity:.46; }
.vnccs-uc-state.drop-before { box-shadow:0 -2px 0 var(--uc-accent); }
.vnccs-uc-state.drop-after { box-shadow:0 2px 0 var(--uc-accent); }
.vnccs-uc-state-thumb { width:52px; height:36px; object-fit:contain; border-radius:5px; background:repeating-conic-gradient(#2a2433 0 25%, #1c1822 0 50%) 0 0 / 10px 10px; }
.vnccs-uc-state-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:700; }
.vnccs-uc-state-note { display:block; color:var(--uc-muted); font-weight:500; font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-uc-state-name input { width:100%; box-sizing:border-box; }
.vnccs-uc-state-meta { display:flex; align-items:center; gap:5px; color:var(--uc-muted); font-size:10px; }
.vnccs-uc-state-dirty { width:7px; height:7px; border-radius:50%; background:#ffd45c; visibility:hidden; }
.vnccs-uc-state.dirty .vnccs-uc-state-dirty { visibility:visible; }
.vnccs-uc-state-varies { display:inline-block; margin-left:4px; padding:0 4px; border-radius:6px; font-size:9px; font-weight:800; color:#ffd45c; border:1px solid rgba(255,212,92,.45); vertical-align:middle; }
.vnccs-uc-states-export-list { display:flex; flex-direction:column; gap:4px; max-height:220px; overflow:auto; margin:6px 0; }
.vnccs-uc-states-export-list label, .vnccs-uc-states-export-bounds label { display:flex; gap:6px; align-items:center; }
.vnccs-uc-states-export-bounds { display:flex; gap:12px; margin:6px 0; }
`;

function injectStyles(uc) {
  const doc = uc.container?.ownerDocument || globalThis.document;
  if (!doc || doc.getElementById("vnccs-uc-states-style")) return;
  const style = doc.createElement("style");
  style.id = "vnccs-uc-states-style";
  style.textContent = STATES_CSS;
  doc.head.appendChild(style);
}

const scene = (uc) => uc.sceneStates;
const findState = (uc, id) => scene(uc).states.find((state) => state.id === id) || null;
const activeState = (uc) => findState(uc, scene(uc).activeStateId);

function busy(uc) {
  if (uc.transformDraft) {
    uc.setStatus?.("Apply or cancel the active transform first", true);
    return true;
  }
  if (uc.isPointerDown) return true;
  return false;
}

// How the widget rebuilds a layer whose view part a state switched (see VIEW_PARTS).
function layerView(uc) {
  return {
    before(layer) {
      // A sprite copies unsynced paint into the variant that is still active.
      if (layer.type === "sprite") uc.sprites?.syncFromCanvas?.(layer);
    },
    after(layer) {
      if (layer.type === "pose") uc.poseBake?.rebuildView?.(layer);
      else if (layer.type === "sprite") uc.sprites?.redraw?.(layer);
      uc.refreshLayerRow?.(layer.id);
    },
  };
}

function applyToLayers(uc, map) {
  return applySceneLayers(uc.layers, map, layerView(uc));
}

function afterPropertyChange(uc) {
  uc.renderLayerList?.();
  uc.syncActiveLayerControls?.();
  uc.requestRender?.();
  uc.syncLightStateToWidget?.();
  uc.scheduleFullSync?.(); // the server cache or project scene gets the new properties
}

function afterListChange(uc) {
  renderStatesPanel(uc);
  uc.syncLightStateToWidget?.();
  uc.scheduleFullSync?.();
}

// Runs `fn` with the state's properties applied to the layers, then restores the live ones.
// Synchronous: nothing renders in between, so the viewport never shows the temporary state.
export function withSceneStateApplied(uc, state, fn) {
  const previous = applyToLayers(uc, state?.layers);
  try {
    return fn();
  } finally {
    applyToLayers(uc, previous);
  }
}

function renderThumbnailCanvas(uc) {
  const bbox = uc.bbox || { width: 1, height: 1 };
  const scale = STATE_THUMBNAIL_SIDE / Math.max(1, bbox.width, bbox.height);
  const width = Math.max(1, Math.round(bbox.width * scale));
  const height = Math.max(1, Math.round(bbox.height * scale));
  const source = uc.panorama ? uc.panorama.composite?.("raster") : uc.makeExportCanvas?.("image", { width, height });
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  if (source) out.getContext("2d").drawImage(source, 0, 0, width, height);
  return out;
}

function makeThumbnail(uc, state = null) {
  if (typeof document === "undefined") return null;
  try {
    const canvas = state ? withSceneStateApplied(uc, state, () => renderThumbnailCanvas(uc)) : renderThumbnailCanvas(uc);
    return canvas.toDataURL("image/webp", 0.82);
  } catch (err) {
    console.warn("[VNCCS UniCanvas] Scene state thumbnail failed", err);
    return null;
  }
}

function setThumbnail(uc, state, url) {
  state.thumbnailDataURL = url;
  if (url) uc._sceneThumbCache.set(state.id, { updatedAt: state.updatedAt, url });
}

function recordListChange(uc, before) {
  uc.pushHistoryEntry?.({ kind: "sceneStates", before, after: snapshotSceneStates(scene(uc)) });
}

// Actions ---------------------------------------------------------------------------------------

export function newStateFromCurrent(uc) {
  if (busy(uc)) return null;
  endPreview(uc);
  const before = snapshotSceneStates(scene(uc));
  const state = createSceneState({ name: nextStateName(scene(uc).states), order: scene(uc).states.length, layers: captureSceneLayers(uc.layers) });
  setThumbnail(uc, state, makeThumbnail(uc));
  scene(uc).states.push(state);
  scene(uc).activeStateId = state.id;
  recordListChange(uc, before);
  uc._statesCollapsed = false;
  afterListChange(uc);
  uc.setStatus?.(`Scene state "${state.name}" created`);
  return state;
}

export function updateState(uc, id = scene(uc).activeStateId) {
  const state = findState(uc, id);
  if (!state || busy(uc)) return;
  endPreview(uc);
  const before = snapshotSceneStates(scene(uc));
  state.layers = captureSceneLayers(uc.layers);
  state.updatedAt = Date.now();
  setThumbnail(uc, state, makeThumbnail(uc));
  scene(uc).activeStateId = state.id;
  recordListChange(uc, before);
  afterListChange(uc);
  uc.setStatus?.(`Scene state "${state.name}" updated`);
}

export function duplicateState(uc, id = scene(uc).activeStateId) {
  const source = findState(uc, id);
  if (!source || busy(uc)) return null;
  endPreview(uc);
  const before = snapshotSceneStates(scene(uc));
  const copy = createSceneState({
    name: `${source.name} copy`,
    note: source.note,
    layers: JSON.parse(JSON.stringify(source.layers || {})),
  });
  setThumbnail(uc, copy, source.thumbnailDataURL);
  const states = scene(uc).states;
  states.splice(states.indexOf(source) + 1, 0, copy);
  states.forEach((state, index) => { state.order = index; });
  recordListChange(uc, before);
  afterListChange(uc);
  return copy;
}

export function renameState(uc, id, name) {
  const state = findState(uc, id);
  const next = String(name ?? "").trim().slice(0, 120);
  if (!state || !next || next === state.name) return;
  const before = snapshotSceneStates(scene(uc));
  state.name = next;
  recordListChange(uc, before);
  afterListChange(uc);
}

export function setStateNote(uc, id, note) {
  const state = findState(uc, id);
  if (!state || note === null || note === undefined || String(note) === state.note) return;
  const before = snapshotSceneStates(scene(uc));
  state.note = String(note).slice(0, 2000);
  recordListChange(uc, before);
  afterListChange(uc);
}

export function deleteState(uc, id = scene(uc).activeStateId) {
  const state = findState(uc, id);
  if (!state || busy(uc)) return;
  endPreview(uc);
  const before = snapshotSceneStates(scene(uc));
  scene(uc).states = scene(uc).states.filter((item) => item !== state);
  scene(uc).states.forEach((item, index) => { item.order = index; });
  if (scene(uc).activeStateId === state.id) scene(uc).activeStateId = null;
  recordListChange(uc, before);
  afterListChange(uc);
  uc.setStatus?.(`Scene state "${state.name}" deleted`);
}

export function moveState(uc, id, targetIndex) {
  const states = scene(uc).states;
  const from = states.findIndex((state) => state.id === id);
  if (from < 0) return;
  const to = Math.max(0, Math.min(states.length - 1, targetIndex));
  if (to === from) return;
  const before = snapshotSceneStates(scene(uc));
  const [state] = states.splice(from, 1);
  states.splice(to, 0, state);
  states.forEach((item, index) => { item.order = index; });
  recordListChange(uc, before);
  afterListChange(uc);
}

/** Applies a state: properties only, no pixels moved, one history entry and one render. */
export function applySceneState(uc, id, { record = true } = {}) {
  const state = findState(uc, id);
  if (!state || busy(uc)) return false;
  endPreview(uc);
  const previousStateId = scene(uc).activeStateId;
  const before = applyToLayers(uc, state.layers);
  const after = {};
  for (const layerId of Object.keys(before)) after[layerId] = { ...state.layers[layerId] };
  scene(uc).activeStateId = state.id;
  if (record) uc.pushHistoryEntry?.({ kind: "applySceneState", stateId: state.id, previousStateId, before, after });
  afterPropertyChange(uc);
  renderStatesPanel(uc);
  uc.setStatus?.(`Scene state "${state.name}"`);
  return true;
}

export function applySceneStateByIndex(uc, index) {
  const state = scene(uc).states[index];
  return state ? applySceneState(uc, state.id) : false;
}

// Hover preview: realtime, reverted on leave, never recorded or synced.
export function previewSceneState(uc, id) {
  if (uc.isPointerDown || uc.transformDraft || uc._stateDragId) return;
  if (uc._scenePreview?.id === id) return;
  endPreview(uc, false);
  const state = findState(uc, id);
  if (!state) return;
  uc._scenePreview = { id, previous: applyToLayers(uc, state.layers) };
  uc.requestRender?.();
}

export function endPreview(uc, render = true) {
  const preview = uc._scenePreview;
  if (!preview) return;
  uc._scenePreview = null;
  applyToLayers(uc, preview.previous);
  if (render) uc.requestRender?.();
}

// Move with "this state" ---------------------------------------------------------------------------

function stateMoveTargets(uc) {
  const layers = uc.layers;
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const ids = uc.selectedLayerIds?.length > 1 ? topLevelSelection(layers, uc.selectedLayerIds) : [uc.activeLayerId];
  const targets = [];
  for (const id of ids) {
    const layer = byId.get(id);
    if (!layer) continue;
    const leaves = isGroupLayer(layer) ? getGroupDescendants(layers, layer).filter((item) => !isGroupLayer(item)) : [layer];
    for (const leaf of leaves) {
      if (!isStateLayer(leaf) || isLayerEffectivelyLocked(layers, leaf) || targets.includes(leaf)) continue;
      targets.push(leaf);
    }
  }
  return targets;
}

export function getSceneStateMoveScope(uc) {
  if (uc.panorama || !activeState(uc)) return MOVE_SCOPE_ALL;
  return resolveMoveScope(scene(uc));
}

export function beginSceneStateMove(uc) {
  if (!uc.dragStart) return false;
  // Depth scaling (vnccs_unicanvas_scene_place.mjs) measures the stored pixels and states have
  // no per-state scale, so a state move, or a move of an offset layer, stays a plain move.
  const plain = () => { uc.dragStart.depthScale = null; };
  if (getSceneStateMoveScope(uc) !== MOVE_SCOPE_STATE) {
    if (!uc.panorama && !isZeroOffset(normalizeStateOffset(uc.activeLayer?.stateOffset))) plain();
    return false;
  }
  const targets = stateMoveTargets(uc);
  if (!targets.length) return false;
  endPreview(uc, false);
  plain();
  uc.pointerMode = "layer-move";
  uc.dragStart.stateMove = true;
  uc.dragStart.layerId = uc.activeLayerId;
  uc.dragStart.moveLayerIds = new Set(targets.map((layer) => layer.id));
  uc.dragStart.stateMoveLayerIds = targets.map((layer) => layer.id);
  return true;
}

function applyOffsetChanges(uc, stateId, changes, side) {
  const state = findState(uc, stateId);
  for (const [layerId, change] of Object.entries(changes || {})) {
    const layer = uc.layers.find((item) => item.id === layerId);
    if (layer) applyLayerState(layer, { offset: change[`live${side}`] });
    if (!state) continue;
    const entry = change[`entry${side}`];
    if (entry) state.layers[layerId] = { ...entry, offset: { ...entry.offset } };
    else delete state.layers[layerId];
  }
  if (state) {
    const url = uc._sceneThumbCache.get(state.id)?.url;
    state.updatedAt = Date.now();
    setThumbnail(uc, state, url || null);
  }
}

export function commitSceneStateMove(uc, dragStart) {
  const state = activeState(uc);
  const dx = Math.round(dragStart?.previewDx || 0);
  const dy = Math.round(dragStart?.previewDy || 0);
  if (!state || (!dx && !dy)) return;
  const changes = {};
  for (const layerId of dragStart.stateMoveLayerIds || []) {
    const layer = uc.layers.find((item) => item.id === layerId);
    if (!layer) continue;
    const liveBefore = normalizeStateOffset(layer.stateOffset);
    const liveAfter = { x: liveBefore.x + dx, y: liveBefore.y + dy };
    const existing = state.layers[layerId];
    const entryBefore = existing ? JSON.parse(JSON.stringify(existing)) : null;
    const base = entryBefore ? { ...captureLayerState(layer), ...entryBefore } : captureLayerState(layer);
    changes[layerId] = { liveBefore, liveAfter, entryBefore, entryAfter: { ...base, offset: liveAfter } };
  }
  if (!Object.keys(changes).length) return;
  applyOffsetChanges(uc, state.id, changes, "After");
  setThumbnail(uc, state, makeThumbnail(uc, state));
  uc.pushHistoryEntry?.({ kind: "sceneStateOffset", stateId: state.id, changes });
  renderStatesPanel(uc);
  uc.setStatus?.(`Moved in scene state "${state.name}"`);
}

// History ---------------------------------------------------------------------------------------

function restoreListSnapshot(uc, snapshot) {
  const restored = normalizeSceneStates(snapshot);
  for (const state of restored.states) {
    const cached = uc._sceneThumbCache.get(state.id);
    if (cached && cached.updatedAt === state.updatedAt) state.thumbnailDataURL = cached.url;
    else setThumbnail(uc, state, makeThumbnail(uc, state));
  }
  uc.sceneStates = restored;
}

export function applySceneStateHistory(uc, entry, direction) {
  endPreview(uc, false);
  const undo = direction === "undo";
  if (entry.kind === "applySceneState") {
    applyToLayers(uc, undo ? entry.before : entry.after);
    const id = undo ? entry.previousStateId : entry.stateId;
    scene(uc).activeStateId = findState(uc, id) ? id : null;
    afterPropertyChange(uc);
  } else if (entry.kind === "sceneStates") {
    restoreListSnapshot(uc, undo ? entry.before : entry.after);
    uc.syncLightStateToWidget?.();
    uc.scheduleFullSync?.();
  } else if (entry.kind === "sceneStateOffset") {
    applyOffsetChanges(uc, entry.stateId, entry.changes, undo ? "Before" : "After");
    const state = findState(uc, entry.stateId);
    if (state) setThumbnail(uc, state, makeThumbnail(uc, state));
    afterPropertyChange(uc);
  }
  renderStatesPanel(uc);
}

// Persistence -----------------------------------------------------------------------------------

export function serializeSceneStates(uc) {
  const current = scene(uc);
  if (!current?.states?.length) return null;
  const ids = new Set(uc.layers.filter(isStateLayer).map((layer) => layer.id));
  const pruned = pruneSceneStates(current, ids);
  return {
    activeStateId: pruned.activeStateId,
    moveScope: pruned.moveScope,
    newLayersHidden: pruned.newLayersHidden === true,
    states: pruned.states.map((state, index) => ({
      id: state.id,
      name: state.name,
      order: index,
      note: state.note || "",
      layers: state.layers,
      thumbnailDataURL: state.thumbnailDataURL || null,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    })),
  };
}

export function restoreSceneStates(uc, raw) {
  endPreview(uc, false);
  uc.sceneStates = normalizeSceneStates(raw);
  uc._sceneThumbCache = new Map();
  for (const state of uc.sceneStates.states) if (state.thumbnailDataURL) uc._sceneThumbCache.set(state.id, { updatedAt: state.updatedAt, url: state.thumbnailDataURL });
  uc._sceneKnownLayerIds = new Set(uc.layers.filter(isStateLayer).map((layer) => layer.id));
  uc._statesCollapsed = !uc.sceneStates.states.length;
  renderStatesPanel(uc);
}

// Always written for image layers (null when zero): the backend merges live layers over the
// cached ones, so an omitted field would let a stale cached offset survive.
export function serializeStateOffset(uc, layer) {
  if (!isStateLayer(layer) || isGroupLayer(layer)) return {};
  const offset = normalizeStateOffset(layer.stateOffset);
  return { stateOffset: uc.panorama || isZeroOffset(offset) ? null : offset };
}

// New layers: "hidden in other states" -----------------------------------------------------------

function trackNewLayers(uc) {
  const ids = uc.layers.filter(isStateLayer).map((layer) => layer.id);
  const known = uc._sceneKnownLayerIds;
  if (known && !uc._isRestoring && !uc.historyRestoring && scene(uc).newLayersHidden && scene(uc).states.length) {
    for (const layer of uc.layers) {
      if (!isStateLayer(layer) || known.has(layer.id) || isLayerReferenced(scene(uc), layer.id)) continue;
      hideLayerInOtherStates(scene(uc), layer);
    }
  }
  uc._sceneKnownLayerIds = new Set(ids);
}

// Panel -----------------------------------------------------------------------------------------

export function sceneStateDiffers(uc) {
  const state = activeState(uc);
  return Boolean(state && !uc._scenePreview && sceneLayersDiffer(uc.layers, state));
}

function refreshIndicators(uc) {
  uc._stateIndicatorQueued = false;
  if (uc._scenePreview || !uc.statesList) return;
  const differs = sceneStateDiffers(uc);
  for (const row of uc.statesList.querySelectorAll("[data-state-id]")) {
    row.classList.toggle("dirty", differs && row.dataset.stateId === scene(uc).activeStateId);
  }
  const rows = uc.layerList?.querySelectorAll?.("[data-layer-id]") || [];
  for (const row of rows) {
    const varies = layerVariesAcrossStates(scene(uc), row.dataset.layerId);
    let marker = row.querySelector(".vnccs-uc-state-varies");
    if (varies && !marker) {
      marker = document.createElement("span");
      marker.className = "vnccs-uc-state-varies";
      marker.textContent = "varies";
      marker.title = "Visibility differs across scene states";
      const name = row.querySelector(".vnccs-uc-layer-name, .vnccs-uc-folder-name") || row.querySelector("span") || row;
      name.appendChild(marker);
    } else if (!varies && marker) {
      marker.remove();
    }
  }
}

function queueIndicators(uc) {
  if (uc._stateIndicatorQueued || !scene(uc)?.states?.length) return;
  uc._stateIndicatorQueued = true;
  (globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 16)))(() => refreshIndicators(uc));
}

function startRename(uc, state, nameEl) {
  const input = document.createElement("input");
  input.className = "vnccs-uc-input";
  input.value = state.name;
  input.setAttribute("aria-label", "State name");
  nameEl.textContent = "";
  nameEl.appendChild(input);
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) renameState(uc, state.id, input.value);
    renderStatesPanel(uc);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("pointerdown", (e) => e.stopPropagation());
  input.focus();
  input.select();
}

function createStateRow(uc, state, index) {
  const row = document.createElement("div");
  row.className = "vnccs-uc-state";
  row.dataset.stateId = state.id;
  row.draggable = true;
  row.classList.toggle("active", state.id === scene(uc).activeStateId);
  row.title = `${state.name}${index < MAX_STATE_SHORTCUTS ? ` (Alt+${index + 1})` : ""}${state.note ? `\n${state.note}` : ""}`;
  const thumb = document.createElement("img");
  thumb.className = "vnccs-uc-state-thumb";
  thumb.alt = "";
  thumb.draggable = false;
  if (state.thumbnailDataURL) thumb.src = state.thumbnailDataURL;
  const name = document.createElement("div");
  name.className = "vnccs-uc-state-name";
  const label = document.createElement("span");
  label.className = "vnccs-uc-state-label";
  label.textContent = state.name;
  name.appendChild(label);
  if (state.note) {
    const note = document.createElement("span");
    note.className = "vnccs-uc-state-note";
    note.textContent = state.note;
    name.appendChild(note);
  }
  const meta = document.createElement("div");
  meta.className = "vnccs-uc-state-meta";
  const dirty = document.createElement("span");
  dirty.className = "vnccs-uc-state-dirty";
  dirty.title = "The canvas differs from this state";
  const key = document.createElement("span");
  key.textContent = index < MAX_STATE_SHORTCUTS ? `Alt+${index + 1}` : "";
  meta.append(dirty, key);
  row.append(thumb, name, meta);

  row.addEventListener("click", (e) => {
    e.preventDefault();
    applySceneState(uc, state.id);
  });
  name.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startRename(uc, state, name);
  });
  row.addEventListener("pointerenter", () => previewSceneState(uc, state.id));
  row.addEventListener("pointerleave", () => endPreview(uc));
  row.addEventListener("dragstart", (e) => {
    endPreview(uc);
    uc._stateDragId = state.id;
    row.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", state.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragend", () => {
    uc._stateDragId = null;
    row.classList.remove("dragging");
    for (const item of uc.statesList.querySelectorAll(".drop-before, .drop-after")) item.classList.remove("drop-before", "drop-after");
  });
  row.addEventListener("dragover", (e) => {
    if (!uc._stateDragId) return;
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    row.classList.toggle("drop-before", !after);
    row.classList.toggle("drop-after", after);
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
  row.addEventListener("drop", (e) => {
    const dragged = uc._stateDragId;
    if (!dragged) return;
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    const states = scene(uc).states;
    const from = states.findIndex((item) => item.id === dragged);
    let to = states.findIndex((item) => item.id === state.id) + (after ? 1 : 0);
    if (from < to) to -= 1;
    uc._stateDragId = null;
    moveState(uc, dragged, to);
  });
  return row;
}

export function renderStatesPanel(uc) {
  if (!uc.statesSection || !uc.statesList) return;
  endPreview(uc); // the hovered row is replaced, so its pointerleave never fires
  uc.statesSection.classList.toggle("collapsed", uc._statesCollapsed === true);
  const count = scene(uc).states.length;
  if (uc.statesTitle) uc.statesTitle.textContent = count ? `States (${count})` : "States";
  uc.statesList.textContent = "";
  scene(uc).states.forEach((state, index) => uc.statesList.appendChild(createStateRow(uc, state, index)));
  if (!count) {
    const empty = document.createElement("div");
    empty.className = "vnccs-uc-states-empty";
    empty.textContent = "No states. Set up the scene, then New state.";
    uc.statesList.appendChild(empty);
  }
  const hasActive = Boolean(activeState(uc));
  for (const [key, button] of Object.entries(uc.stateButtons || {})) {
    button.disabled = key === "export" ? !count : !hasActive;
  }
  if (uc.stateMoveScopeBtn) {
    const scope = getSceneStateMoveScope(uc);
    uc.stateMoveScopeBtn.textContent = `Move affects: ${scope === MOVE_SCOPE_STATE ? "this state" : "all states"}`;
    uc.stateMoveScopeBtn.setAttribute("aria-pressed", scope === MOVE_SCOPE_STATE ? "true" : "false");
    uc.stateMoveScopeBtn.disabled = Boolean(uc.panorama) || !hasActive;
  }
  if (uc.stateNewHiddenInput) uc.stateNewHiddenInput.checked = scene(uc).newLayersHidden === true;
  refreshIndicators(uc);
}

function toggleMoveScope(uc) {
  const current = getSceneStateMoveScope(uc);
  scene(uc).moveScope = current === MOVE_SCOPE_STATE ? MOVE_SCOPE_ALL : MOVE_SCOPE_STATE;
  renderStatesPanel(uc);
  uc.syncLightStateToWidget?.();
  uc.scheduleFullSync?.();
}

// Export ----------------------------------------------------------------------------------------

function contentBounds(uc) {
  let rect = null;
  for (const layer of uc.layers) {
    if (!isStateLayer(layer) || isGroupLayer(layer) || !isLayerEffectivelyVisible(uc.layers, layer) || !(layer.opacity > 0)) continue;
    const bounds = uc.getLayerWorldBounds?.(layer);
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) continue;
    rect = rect
      ? {
        x: Math.min(rect.x, bounds.x),
        y: Math.min(rect.y, bounds.y),
        right: Math.max(rect.right, bounds.x + bounds.width),
        bottom: Math.max(rect.bottom, bounds.y + bounds.height),
      }
      : { x: bounds.x, y: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height };
  }
  if (!rect) return null;
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  return { x, y, width: Math.ceil(rect.right) - x, height: Math.ceil(rect.bottom) - y };
}

/** The flattened composite of the live layers over the bbox or the full content bounds. */
export function renderSceneComposite(uc, boundsMode = "bbox") {
  if (uc.panorama) return uc.panorama.composite?.("raster") || null;
  const rect = boundsMode === "content" ? contentBounds(uc) : { ...uc.bbox };
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const savedBbox = uc.bbox;
  uc.bbox = { x: rect.x, y: rect.y, width, height };
  try {
    const canvas = uc.makeExportCanvas("image", { width, height });
    if (canvas.width === width && canvas.height === height) return canvas;
    const exact = document.createElement("canvas");
    exact.width = width;
    exact.height = height;
    exact.getContext("2d").drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, width, height);
    return exact;
  } finally {
    uc.bbox = savedBbox;
  }
}

async function postSaveOutput(payload) {
  const res = await fetch(SAVE_OUTPUT_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let data = {};
  try { data = await res.json(); } catch (_) { data = {}; }
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Writes one PNG per state into output/<subfolder>/, named from the state names. */
export async function exportSceneStates(uc, { stateIds, boundsMode = "bbox", subfolder = "" } = {}) {
  endPreview(uc, false);
  const states = scene(uc).states.filter((state) => !stateIds || stateIds.includes(state.id));
  const names = exportFileNames(states.map((state) => state.name));
  const saved = [];
  for (let index = 0; index < states.length; index += 1) {
    const canvas = withSceneStateApplied(uc, states[index], () => renderSceneComposite(uc, boundsMode));
    if (!canvas) continue;
    const data = await postSaveOutput({ image: canvas.toDataURL("image/png"), subfolder, name: names[index] });
    saved.push(data.path);
  }
  return saved;
}

function defaultSceneFolder(uc) {
  const title = String(uc.node?.title || "").trim();
  return exportFileNames([title && title !== "VNCCS UniCanvas" ? title : "unicanvas-scene"])[0];
}

export function openExportStatesDialog(uc) {
  const states = scene(uc).states;
  if (!states.length || busy(uc)) return;
  endPreview(uc);
  const overlay = document.createElement("div");
  overlay.className = "vnccs-uc-modal-overlay";
  const modal = document.createElement("div");
  modal.className = "vnccs-uc-modal vnccs-uc-states-export";
  modal.innerHTML = `
    <div class="vnccs-uc-modal-title">Export states</div>
    <div class="vnccs-uc-modal-message">One PNG per selected state, written to output/&lt;folder&gt;/.</div>
    <div class="vnccs-uc-states-export-list"></div>
    <div class="vnccs-uc-states-export-bounds">
      <label><input type="radio" name="vnccs-uc-states-bounds" value="bbox" checked> Bbox</label>
      <label><input type="radio" name="vnccs-uc-states-bounds" value="content"> Full content bounds</label>
    </div>
    <label class="vnccs-uc-field">Folder under output/<input class="vnccs-uc-input" data-states-export-folder></label>
    <div class="vnccs-uc-modal-actions"></div>`;
  const list = modal.querySelector(".vnccs-uc-states-export-list");
  for (const state of states) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.value = state.id;
    label.append(box, document.createTextNode(` ${state.name}`));
    list.appendChild(label);
  }
  const folder = modal.querySelector("[data-states-export-folder]");
  folder.value = defaultSceneFolder(uc);
  const close = () => overlay.remove();
  const run = async () => {
    const stateIds = [...list.querySelectorAll("input:checked")].map((input) => input.value);
    const boundsMode = modal.querySelector("input[name='vnccs-uc-states-bounds']:checked")?.value || "bbox";
    close();
    if (!stateIds.length) return;
    try {
      uc.setStatus?.("Exporting scene states...");
      const saved = await exportSceneStates(uc, { stateIds, boundsMode, subfolder: folder.value.trim() });
      uc.setStatus?.(`Exported ${saved.length} scene state${saved.length === 1 ? "" : "s"} to output/${folder.value.trim()}`);
    } catch (err) {
      uc.setStatus?.(`Export states failed: ${String(err?.message || err).replace(/^\[VNCCS UniCanvas\]\s*/, "")}`, true);
    }
  };
  const actions = modal.querySelector(".vnccs-uc-modal-actions");
  const ok = uc._button("Export", "vnccs-uc-btn", () => void run(), "Export the selected states");
  ok.dataset.statesExportConfirm = "";
  actions.append(uc._button("Cancel", "vnccs-uc-btn", close, "Cancel"), ok);
  overlay.appendChild(modal);
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  uc.container.appendChild(overlay);
  requestAnimationFrame(() => ok.focus());
}

// Install ---------------------------------------------------------------------------------------

function buildStatesSection(uc) {
  if (!uc.side || typeof uc._section !== "function") return;
  const body = document.createElement("div");
  body.className = "vnccs-uc-states-body";
  const actions = document.createElement("div");
  actions.className = "vnccs-uc-states-actions";
  const button = (key, label, title, fn) => {
    const btn = uc._button(label, "vnccs-uc-btn", fn, title);
    btn.dataset.stateAction = key;
    uc.stateButtons[key] = btn;
    return btn;
  };
  uc.stateButtons = {};
  actions.append(
    button("update", "Update", "Update the active state from the canvas", () => updateState(uc)),
    button("duplicate", "Duplicate", "Duplicate the active state", () => duplicateState(uc)),
    button("revert", "Revert", "Revert the canvas to the active state", () => { const s = activeState(uc); if (s) applySceneState(uc, s.id); }),
    button("rename", "Rename", "Rename the active state", () => {
      const row = uc.statesList?.querySelector(`[data-state-id="${scene(uc).activeStateId}"] .vnccs-uc-state-name`);
      const state = activeState(uc);
      if (row && state) startRename(uc, state, row);
    }),
    button("note", "Note", "Edit the active state's note", async () => {
      const state = activeState(uc);
      if (!state) return;
      const note = await uc.promptInWidget?.("State note", "Note", state.note || "");
      setStateNote(uc, state.id, note);
    }),
    button("delete", "Delete", "Delete the active state", () => deleteState(uc)),
  );
  uc.stateButtons.delete.classList.add("danger");
  const options = document.createElement("div");
  options.className = "vnccs-uc-states-options";
  uc.stateMoveScopeBtn = uc._button("Move affects: all states", "vnccs-uc-btn", () => toggleMoveScope(uc), "Whether the Move tool changes the active state's offset or the layer pixels (all states)");
  uc.stateMoveScopeBtn.dataset.stateAction = "move-scope";
  const hidden = document.createElement("label");
  uc.stateNewHiddenInput = document.createElement("input");
  uc.stateNewHiddenInput.type = "checkbox";
  uc.stateNewHiddenInput.dataset.stateOption = "new-layers-hidden";
  uc.stateNewHiddenInput.addEventListener("change", () => {
    scene(uc).newLayersHidden = uc.stateNewHiddenInput.checked;
    uc.syncLightStateToWidget?.();
    uc.scheduleFullSync?.();
  });
  hidden.append(uc.stateNewHiddenInput, document.createTextNode("New layers hidden in other states"));
  options.append(uc.stateMoveScopeBtn, hidden, button("export", "Export states...", "Export one PNG per state to output/", () => openExportStatesDialog(uc)));
  uc.statesList = document.createElement("div");
  uc.statesList.className = "vnccs-uc-states-list";
  body.append(actions, options, uc.statesList);
  const section = uc._section("States", body, [["+", "New state from current", () => newStateFromCurrent(uc)]]);
  section.classList.add("vnccs-uc-states");
  section.dataset.sceneStates = "";
  const head = section.querySelector(".vnccs-uc-section-head");
  uc.statesTitle = section.querySelector(".vnccs-uc-section-title");
  head?.querySelector("button")?.setAttribute("data-state-action", "new");
  head?.addEventListener("click", (e) => {
    if (e.target.closest?.("button")) return;
    uc._statesCollapsed = !uc._statesCollapsed;
    renderStatesPanel(uc);
  });
  uc.statesSection = section;
  uc.side.appendChild(section);
}

export function installUniCanvasSceneStates(uc) {
  if (!uc || uc._vnccsSceneStatesInstalled) return uc;
  uc._vnccsSceneStatesInstalled = true;
  uc.sceneStates = emptySceneStates();
  uc._sceneThumbCache = new Map();
  uc._sceneKnownLayerIds = null;
  uc._statesCollapsed = true;
  injectStyles(uc);

  uc.serializeSceneStates = () => serializeSceneStates(uc);
  uc.restoreSceneStates = (raw) => restoreSceneStates(uc, raw);
  uc.serializeStateOffset = (layer) => serializeStateOffset(uc, layer);
  uc.applySceneStateHistory = (entry, direction) => applySceneStateHistory(uc, entry, direction);
  uc.beginSceneStateMove = () => beginSceneStateMove(uc);
  uc.commitSceneStateMove = (dragStart) => commitSceneStateMove(uc, dragStart);
  uc.getSceneStateMoveScope = () => getSceneStateMoveScope(uc);
  uc.sceneStateDiffers = () => sceneStateDiffers(uc);
  uc.newSceneState = () => newStateFromCurrent(uc);
  uc.updateSceneState = (id) => updateState(uc, id);
  uc.applySceneState = (id) => applySceneState(uc, id);
  uc.applySceneStateByIndex = (index) => applySceneStateByIndex(uc, index);
  uc.exportSceneStates = (options) => exportSceneStates(uc, options);

  buildStatesSection(uc);

  // Hook the widget's list render (new-layer rule, "varies" markers) and render requests
  // (the "differs" dot), both coalesced to one refresh per frame.
  const renderLayerList = uc.renderLayerList;
  if (typeof renderLayerList === "function") {
    uc.renderLayerList = (...args) => {
      const result = renderLayerList.apply(uc, args);
      trackNewLayers(uc);
      queueIndicators(uc);
      return result;
    };
  }
  const requestRender = uc.requestRender;
  if (typeof requestRender === "function") {
    uc.requestRender = (...args) => {
      const result = requestRender.apply(uc, args);
      queueIndicators(uc);
      return result;
    };
  }
  uc.canvas?.addEventListener("pointerdown", () => endPreview(uc), true);
  renderStatesPanel(uc);
  return uc;
}
