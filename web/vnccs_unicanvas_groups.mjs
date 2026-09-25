/**
 * VNCCS UniCanvas layer groups (Plan 05, issue #8).
 *
 *  - Data model: a layer of type "group" has no canvas. Every non-mask layer may carry
 *    `groupId` (its parent group, null at the root); nesting is limited to MAX_GROUP_DEPTH.
 *  - Order invariant: `widget.layers` stays one flat top-to-bottom array. Masks come first,
 *    then the root sequence with every group's subtree expanded right after the group entry.
 *    normalizeGroupedLayerOrder enforces it, so loops over `layers` keep working.
 *  - Rendering: a pass-through group (the default, opacity 1) draws its children in place.
 *    An isolated group (opacity below 1 or another blend mode) composites its children into a
 *    scratch canvas the size of the target surface, then draws it with its opacity and blend.
 *    compositeLayerStack serves the viewport, exports and flatten, so they stay identical.
 *  - History: `groupStructure` (before/after order and parent pairs) and `historyGroup`
 *    (children applied in order, undone in reverse) are entry kinds of the widget's own
 *    applyHistoryEntry; there is no parallel undo stack.
 *  - Panel: folder rows (.vnccs-uc-folder*), 12 px indent per level, drag inside the middle
 *    third of a folder row, Ctrl/Cmd+click and Shift+click multi-selection, group commands.
 *  - Move tool: a group or a multi-selection moves every child as one gesture with the realtime
 *    move preview, committed as one historyGroup of layerPixels entries.
 *
 * The pure helpers at the top run under Node for tests; installUniCanvasGroups binds the rest
 * onto the widget like installUniCanvasLayerTools.
 */

import { createLayerMeta } from "./vnccs_unicanvas_provenance.mjs";

export const GROUP_LAYER_TYPE = "group";
export const PASS_THROUGH = "pass-through";
export const MAX_GROUP_DEPTH = 3;
export const GROUP_INDENT_PX = 12;

export const isGroupLayer = (layer) => layer?.type === GROUP_LAYER_TYPE;

const newId = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);

export function createGroupLayer(fields = {}) {
  return {
    id: fields.id || newId(),
    name: fields.name || "Group",
    type: GROUP_LAYER_TYPE,
    visible: fields.visible !== false,
    locked: fields.locked === true,
    opacity: Number.isFinite(fields.opacity) ? Math.max(0, Math.min(1, fields.opacity)) : 1,
    blendMode: typeof fields.blendMode === "string" && fields.blendMode ? fields.blendMode : PASS_THROUGH,
    collapsed: fields.collapsed === true,
    groupId: typeof fields.groupId === "string" && fields.groupId ? fields.groupId : null,
    nameSource: fields.nameSource || undefined,
    meta: fields.meta || createLayerMeta("paint"),
    canvas: null,
  };
}

export function isIsolatedGroup(group) {
  if (!isGroupLayer(group)) return false;
  return (group.blendMode || PASS_THROUGH) !== PASS_THROUGH || !(Number(group.opacity) >= 0.999);
}

export function groupCompositeOperation(group) {
  const mode = group?.blendMode || PASS_THROUGH;
  return mode === PASS_THROUGH ? "source-over" : mode;
}

function layerIndex(layers) {
  return new Map(layers.map((layer) => [layer.id, layer]));
}

// The group a layer belongs to, or null (missing parent, non-group parent, masks).
export function parentGroupOf(layers, layer, byId = layerIndex(layers)) {
  if (!layer || layer.type === "mask" || !layer.groupId) return null;
  const parent = byId.get(layer.groupId);
  return isGroupLayer(parent) && parent !== layer ? parent : null;
}

// Ancestor groups, nearest first. Stops on a cycle.
export function groupChainOf(layers, layer, byId = layerIndex(layers)) {
  const chain = [];
  const seen = new Set([layer?.id]);
  let parent = parentGroupOf(layers, layer, byId);
  while (parent && !seen.has(parent.id)) {
    chain.push(parent);
    seen.add(parent.id);
    parent = parentGroupOf(layers, parent, byId);
  }
  return chain;
}

// Nesting level of a group (1 at the root) or of a layer's container (0 at the root).
export function groupDepthOf(layers, layer, byId = layerIndex(layers)) {
  return groupChainOf(layers, layer, byId).length + (isGroupLayer(layer) ? 1 : 0);
}

export function isLayerEffectivelyVisible(layers, layer) {
  if (!layer?.visible) return false;
  return groupChainOf(layers, layer).every((group) => group.visible);
}

export function isLayerEffectivelyLocked(layers, layer) {
  if (!layer) return false;
  if (layer.locked) return true;
  return groupChainOf(layers, layer).some((group) => group.locked);
}

export function isDescendantOf(layers, layer, group) {
  if (!layer || !group) return false;
  return groupChainOf(layers, layer).includes(group);
}

// Descendants in stack order (valid once the order is normalized).
export function getGroupDescendants(layers, group) {
  if (!isGroupLayer(group)) return [];
  const byId = layerIndex(layers);
  return layers.filter((layer) => layer !== group && groupChainOf(layers, layer, byId).includes(group));
}

// Group levels a subtree occupies: 0 for a leaf, 1 for a group without subgroups, ...
export function groupSubtreeHeight(layers, layer) {
  if (!isGroupLayer(layer)) return 0;
  const byId = layerIndex(layers);
  let height = 1;
  for (const item of getGroupDescendants(layers, layer)) {
    if (!isGroupLayer(item)) continue;
    const chain = groupChainOf(layers, item, byId);
    height = Math.max(height, chain.indexOf(layer) + 2);
  }
  return height;
}

// Whether `layer` (with its subtree) may live inside `parentId` (null = root).
export function canPlaceInGroup(layers, layer, parentId) {
  if (!layer || layer.type === "mask") return !parentId;
  if (!parentId) return true;
  const byId = layerIndex(layers);
  const parent = byId.get(parentId);
  if (!isGroupLayer(parent) || parent === layer) return false;
  if (isGroupLayer(layer) && groupChainOf(layers, parent, byId).includes(layer)) return false;
  return groupDepthOf(layers, parent, byId) + groupSubtreeHeight(layers, layer) <= MAX_GROUP_DEPTH;
}

/**
 * The layer tree in stack order: [{ layer, children }]. Layers whose parent is not part of
 * `layers` (a subset) sit at the root of the returned tree.
 */
export function buildLayerTree(layers) {
  const byId = layerIndex(layers);
  const nodes = new Map(layers.map((layer) => [layer.id, { layer, children: [] }]));
  const roots = [];
  for (const layer of layers) {
    const parent = parentGroupOf(layers, layer, byId);
    const cyclic = parent && groupChainOf(layers, parent, byId).includes(layer);
    (parent && !cyclic ? nodes.get(parent.id).children : roots).push(nodes.get(layer.id));
  }
  return roots;
}

/**
 * Enforce the order invariant: masks first (never grouped), then every root item followed by
 * its subtree, children in their current relative order. `pinnedLastId` (the panorama base
 * layer) stays last and at the root. A `groupId` whose group is missing (or would close a cycle)
 * places the layer at the root without being cleared, so an undo that re-inserts a group and its
 * children one entry at a time rebuilds the same tree.
 */
export function normalizeGroupedLayerOrder(layers, { pinnedLastId = null } = {}) {
  const masks = [];
  const others = [];
  let pinned = null;
  for (const layer of layers) {
    if (layer.type === "mask") {
      if (layer.groupId) layer.groupId = null;
      masks.push(layer);
    } else if (pinnedLastId && layer.id === pinnedLastId) {
      if (layer.groupId) layer.groupId = null;
      pinned = layer;
    } else others.push(layer);
  }
  const out = [...masks];
  const emit = (nodes) => {
    for (const node of nodes) {
      out.push(node.layer);
      emit(node.children);
    }
  };
  emit(buildLayerTree(others));
  if (pinned) out.push(pinned);
  return out;
}

/** Snapshot of the stack structure for a `groupStructure` history entry. */
export function captureGroupStructure(layers) {
  const others = layers.filter((layer) => layer.type !== "mask");
  return {
    order: others.map((layer) => ({ id: layer.id, groupId: layer.groupId || null })),
    layers: others,
  };
}

/**
 * Rebuild `layers` from a structure snapshot: masks stay, the other layers follow the snapshot
 * order and parents. Current objects win over the snapshot's (a full snapshot restore may have
 * replaced them); layers missing from the snapshot were created after it and are dropped.
 */
export function restoreGroupStructure(layers, snapshot) {
  if (!snapshot?.order) return layers;
  const current = layerIndex(layers);
  const stored = layerIndex(snapshot.layers || []);
  const masks = layers.filter((layer) => layer.type === "mask");
  const rest = [];
  for (const { id, groupId } of snapshot.order) {
    const layer = current.get(id) || stored.get(id);
    if (!layer || layer.type === "mask") continue;
    layer.groupId = groupId || null;
    rest.push(layer);
  }
  return [...masks, ...rest];
}

function acquireScratch(pool, depth, width, height) {
  let canvas = pool[depth];
  if (!canvas) {
    canvas = globalThis.document?.createElement("canvas");
    if (!canvas) return null;
    pool[depth] = canvas;
  }
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return canvas;
}

/**
 * Draw `layers` (top-to-bottom, flat) bottom-up onto ctx with group semantics. drawLeaf(ctx,
 * layer) draws one visible non-group layer and owns its own save/restore, opacity and blend.
 * Isolated groups render into pooled scratch canvases the size of ctx.canvas, drawn with the
 * group's opacity and blend; the scratch shares ctx's transform, so world-space leaf drawing
 * and clipping behave the same as without groups.
 */
export function compositeLayerStack(ctx, layers, drawLeaf, pool = []) {
  const drawNodes = (target, nodes, depth) => {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const { layer, children } = nodes[index];
      if (!layer.visible) continue;
      if (!isGroupLayer(layer)) {
        drawLeaf(target, layer);
        continue;
      }
      if (!children.length) continue;
      if (!isIsolatedGroup(layer)) {
        drawNodes(target, children, depth);
        continue;
      }
      if (!(layer.opacity > 0)) continue;
      const surface = target.canvas;
      const scratch = surface ? acquireScratch(pool, depth, surface.width, surface.height) : null;
      const sctx = scratch?.getContext("2d");
      if (!sctx) {
        drawNodes(target, children, depth);
        continue;
      }
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalAlpha = 1;
      sctx.globalCompositeOperation = "source-over";
      sctx.clearRect(0, 0, scratch.width, scratch.height);
      sctx.setTransform(target.getTransform());
      sctx.imageSmoothingEnabled = target.imageSmoothingEnabled;
      if (target.imageSmoothingQuality) sctx.imageSmoothingQuality = target.imageSmoothingQuality;
      drawNodes(sctx, children, depth + 1);
      target.save();
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.globalAlpha = Math.max(0, Math.min(1, Number(layer.opacity)));
      target.globalCompositeOperation = groupCompositeOperation(layer);
      target.drawImage(scratch, 0, 0);
      target.restore();
    }
  };
  drawNodes(ctx, buildLayerTree(layers), 0);
}

/** Serialized form of a group (no pixel data); the state schema is additive. */
export function serializeGroupLayer(layer) {
  return {
    id: layer.id,
    name: layer.name,
    nameSource: layer.nameSource || null,
    meta: layer.meta,
    type: GROUP_LAYER_TYPE,
    groupId: layer.groupId || null,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
    blendMode: layer.blendMode || PASS_THROUGH,
    collapsed: layer.collapsed === true,
    crop: null,
    dataURL: null,
    hiresRect: null,
    hiresDataURL: null,
  };
}

// Selection helpers ---------------------------------------------------------------------------

// Shift+click range over the rows the panel shows (non-mask stack order).
export function selectionRange(layers, anchorId, targetId) {
  const rows = layers.filter((layer) => layer.type !== "mask");
  const a = rows.findIndex((layer) => layer.id === anchorId);
  const b = rows.findIndex((layer) => layer.id === targetId);
  if (a < 0 || b < 0) return [targetId];
  const [from, to] = a < b ? [a, b] : [b, a];
  return rows.slice(from, to + 1).map((layer) => layer.id);
}

// Selected ids reduced to top-level picks: a layer whose ancestor group is selected goes with it.
export function topLevelSelection(layers, ids) {
  const set = new Set(ids);
  const byId = layerIndex(layers);
  return layers.filter((layer) => set.has(layer.id) && layer.type !== "mask"
    && !groupChainOf(layers, layer, byId).some((group) => set.has(group.id)));
}

// Widget integration --------------------------------------------------------------------------

const GROUP_ICONS = {
  folder: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`,
  open: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`,
  closed: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 10.6A3 3 0 0 0 13.4 13.4"/><path d="M9.9 5.2A9.8 9.8 0 0 1 12 5c6 0 9.5 7 9.5 7a17.4 17.4 0 0 1-2.4 3.2"/><path d="M6.1 6.7C3.8 8.3 2.5 12 2.5 12s3.5 7 9.5 7a9.7 9.7 0 0 0 4-.8"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`,
  unlock: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.2-2.4"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg>`,
};

export const GROUP_MENU_ITEMS = Object.freeze([
  { id: "new-group", label: "New empty group" },
  { id: "group-selected", label: "Group selected (Ctrl+G)" },
  { id: "ungroup", label: "Ungroup (Ctrl+Shift+G)", groupOnly: true },
  { id: "duplicate-group", label: "Duplicate group", groupOnly: true },
  { id: "flatten-group", label: "Flatten group to layer", groupOnly: true },
  { id: "delete-group", label: "Delete group...", groupOnly: true },
]);

const GROUP_CSS = `
.vnccs-uc-layer.selected:not(.active) { border-color:rgba(143,190,255,.45); background:rgba(143,190,255,.08); }
.vnccs-uc-folder { display:grid; grid-template-columns:18px 20px minmax(0,1fr) auto 26px 26px 26px; gap:5px; align-items:center; padding:5px 6px; border:1px solid var(--uc-border); border-radius:8px; background:rgba(255,213,120,.05); cursor:pointer; }
.vnccs-uc-folder.active { border-color:rgba(255,143,163,.55); background:rgba(255,143,163,.12); }
.vnccs-uc-folder.selected:not(.active) { border-color:rgba(143,190,255,.45); background:rgba(143,190,255,.08); }
.vnccs-uc-folder.locked { border-color:rgba(255,193,7,.42); }
.vnccs-uc-folder.hidden-group .vnccs-uc-folder-name { opacity:.55; }
.vnccs-uc-folder.dragging { opacity:.46; }
.vnccs-uc-folder.drop-before { box-shadow:0 -2px 0 var(--uc-accent); }
.vnccs-uc-folder.drop-after { box-shadow:0 2px 0 var(--uc-accent); }
.vnccs-uc-folder.drop-inside { box-shadow:inset 0 0 0 2px var(--uc-accent); }
.vnccs-uc-folder-toggle, .vnccs-uc-folder-icon { display:flex; align-items:center; justify-content:center; padding:0; border:0; background:transparent; color:#ffd57a; cursor:pointer; }
.vnccs-uc-folder-toggle svg, .vnccs-uc-folder-icon svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
.vnccs-uc-folder-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:700; }
.vnccs-uc-folder-opacity { color:var(--uc-muted); font-size:10px; font-variant-numeric:tabular-nums; }
.vnccs-uc-folder .vnccs-uc-icon { width:26px; height:26px; }
.vnccs-uc-group-actions { display:flex; gap:6px; }
.vnccs-uc-group-actions .vnccs-uc-btn { flex:1 1 0; min-width:0; }
`;

function injectGroupStyles(uc) {
  const doc = uc.container?.ownerDocument || globalThis.document;
  if (!doc || doc.getElementById("vnccs-uc-groups-style")) return;
  const style = doc.createElement("style");
  style.id = "vnccs-uc-groups-style";
  style.textContent = GROUP_CSS;
  doc.head.appendChild(style);
}

function transformBusy(uc) {
  if (!uc.transformDraft) return false;
  uc.setStatus("Apply or cancel the active transform first", true);
  return true;
}

function finishStructureChange(uc, before, activeBefore, extraEntries = null) {
  uc.normalizeLayerOrder();
  const entry = {
    kind: "groupStructure",
    before,
    after: captureGroupStructure(uc.layers),
    activeBefore,
    activeAfter: uc.activeLayerId,
  };
  uc.pushHistoryEntry(extraEntries?.length ? { kind: "historyGroup", entries: [...extraEntries, entry] } : entry);
  uc.autoNaming?.onLayerStructureChanged();
  uc.syncPoseToolToActiveLayer?.();
  uc.renderLayerList();
  uc.requestRender();
  uc.syncLightStateToWidget();
  uc.scheduleFullSync?.();
}

function setSelection(uc, ids, activeId = uc.activeLayerId) {
  const known = new Set(uc.layers.map((layer) => layer.id));
  const next = [...new Set(ids)].filter((id) => known.has(id));
  if (activeId && known.has(activeId) && !next.includes(activeId)) next.push(activeId);
  uc.selectedLayerIds = next;
}

function syncSelectionClasses(uc) {
  const selected = new Set(uc.selectedLayerIds || []);
  uc.layerList?.querySelectorAll("[data-layer-id]").forEach((row) => {
    row.classList.toggle("selected", selected.has(row.dataset.layerId));
  });
}

function removeLayerSubtree(layers, layer) {
  const drop = new Set([layer, ...getGroupDescendants(layers, layer)]);
  return layers.filter((item) => !drop.has(item));
}

function insertionIndexAfterSubtree(layers, layer) {
  const index = layers.indexOf(layer);
  return index + 1 + getGroupDescendants(layers, layer).length;
}

/** Move a layer (with its subtree) before/after a target or inside a folder (top). */
export function moveLayerInStack(uc, sourceId, targetId, placement = "before") {
  if (!sourceId || !targetId || sourceId === targetId) return false;
  if (transformBusy(uc)) return false;
  uc.normalizeLayerOrder();
  const source = uc.layers.find((layer) => layer.id === sourceId);
  const target = uc.layers.find((layer) => layer.id === targetId);
  if (!source || !target) return false;
  if ((source.type === "mask") !== (target.type === "mask")) {
    uc.setStatus("Masks and raster layers stay in separate sections", true);
    return false;
  }
  if (source.type === "mask") {
    const before = uc.layers.slice();
    const rest = uc.layers.filter((layer) => layer !== source);
    let to = rest.indexOf(target) + (placement === "after" ? 1 : 0);
    rest.splice(Math.max(0, to), 0, source);
    uc.layers = rest;
    uc.activeLayerId = source.id;
    if (before.some((layer, index) => layer !== uc.layers[index])) {
      uc.renderLayerList();
      uc.requestRender();
      uc.syncLightStateToWidget();
    }
    return true;
  }
  if (isGroupLayer(source) && isDescendantOf(uc.layers, target, source)) {
    uc.setStatus("A group cannot be moved into itself", true);
    return false;
  }
  if (uc.panorama?.settings?.baseLayerId && [source.id].includes(uc.panorama.settings.baseLayerId)) {
    uc.setStatus("The panorama base layer stays at the bottom", true);
    return false;
  }
  // Dropping below an expanded folder's header files the layer at the top of that folder.
  if (placement === "after" && isGroupLayer(target) && !target.collapsed && getGroupDescendants(uc.layers, target).length) {
    placement = "inside";
  }
  const parentId = placement === "inside" ? target.id : (target.groupId || null);
  if (!canPlaceInGroup(uc.layers, source, parentId)) {
    uc.setStatus(`Groups nest at most ${MAX_GROUP_DEPTH} levels deep`, true);
    return false;
  }
  const before = captureGroupStructure(uc.layers);
  const activeBefore = uc.activeLayerId;
  const subtree = [source, ...getGroupDescendants(uc.layers, source)];
  const rest = removeLayerSubtree(uc.layers, source);
  let to;
  if (placement === "inside") to = rest.indexOf(target) + 1;
  else if (placement === "after") to = insertionIndexAfterSubtree(rest, target);
  else to = rest.indexOf(target);
  rest.splice(Math.max(0, to), 0, ...subtree);
  source.groupId = parentId;
  uc.layers = rest;
  uc.activeLayerId = source.id;
  setSelection(uc, [source.id], source.id);
  if (placement === "inside" && target.collapsed) target.collapsed = false;
  finishStructureChange(uc, before, activeBefore);
  return true;
}

/** Up/down buttons: swap with the neighbouring sibling inside the same container. */
function moveLayerAmongSiblings(uc, direction) {
  const layer = uc.activeLayer;
  if (!layer || layer.type === "mask") return false;
  if (transformBusy(uc)) return true;
  uc.normalizeLayerOrder();
  const siblings = uc.layers.filter((item) => item.type !== "mask" && (item.groupId || null) === (layer.groupId || null)
    && item.id !== uc.panorama?.settings?.baseLayerId);
  const index = siblings.indexOf(layer);
  const neighbour = siblings[index + direction];
  if (index < 0 || !neighbour) return true;
  return moveLayerInStack(uc, layer.id, neighbour.id, direction < 0 ? "before" : "after") || true;
}

function nextGroupName(layers) {
  let max = 0;
  for (const layer of layers) {
    const match = String(layer.name || "").match(/^Group (\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Group ${max + 1}`;
}

export function groupSelectedLayers(uc) {
  if (transformBusy(uc)) return null;
  uc.normalizeLayerOrder();
  const ids = (uc.selectedLayerIds?.length ? uc.selectedLayerIds : [uc.activeLayerId]).filter(Boolean);
  const picks = topLevelSelection(uc.layers, ids).filter((layer) => layer.id !== uc.panorama?.settings?.baseLayerId);
  if (!picks.length) {
    uc.setStatus("Select image layers or groups to group (masks stay ungrouped)", true);
    return null;
  }
  const top = picks[0];
  const parentId = top.groupId || null;
  // A user-created group starts as "Group N" and takes an automatic name from its layers.
  const probe = createGroupLayer({ name: nextGroupName(uc.layers), groupId: parentId, nameSource: "auto" });
  // The new group takes one nesting level; every pick must still fit below it.
  const parentDepth = parentId ? groupDepthOf(uc.layers, uc.layers.find((layer) => layer.id === parentId)) : 0;
  if (picks.some((layer) => parentDepth + 1 + groupSubtreeHeight(uc.layers, layer) > MAX_GROUP_DEPTH)) {
    uc.setStatus(`Groups nest at most ${MAX_GROUP_DEPTH} levels deep`, true);
    return null;
  }
  const before = captureGroupStructure(uc.layers);
  const activeBefore = uc.activeLayerId;
  const moved = picks.flatMap((layer) => [layer, ...getGroupDescendants(uc.layers, layer)]);
  const movedSet = new Set(moved);
  const index = uc.layers.indexOf(top);
  const head = uc.layers.slice(0, index).filter((layer) => !movedSet.has(layer));
  const tail = uc.layers.slice(index).filter((layer) => !movedSet.has(layer));
  for (const layer of picks) layer.groupId = probe.id;
  uc.layers = [...head, probe, ...moved, ...tail];
  uc.activeLayerId = probe.id;
  setSelection(uc, [probe.id], probe.id);
  finishStructureChange(uc, before, activeBefore);
  uc.setStatus(`${probe.name}: ${picks.length} item${picks.length === 1 ? "" : "s"} grouped`);
  return probe;
}

export function addEmptyGroup(uc) {
  if (transformBusy(uc)) return null;
  uc.normalizeLayerOrder();
  const active = uc.activeLayer;
  // As in Photoshop, a new folder opens right above the active item, in the same container.
  const anchor = active && active.type !== "mask" && active.id !== uc.panorama?.settings?.baseLayerId ? active : null;
  const group = createGroupLayer({ name: nextGroupName(uc.layers), groupId: anchor?.groupId || null, nameSource: "auto" });
  const before = captureGroupStructure(uc.layers);
  const activeBefore = uc.activeLayerId;
  let index = anchor ? uc.layers.indexOf(anchor) : uc.layers.findIndex((layer) => layer.type !== "mask");
  if (index < 0) index = uc.layers.length;
  uc.layers.splice(index, 0, group);
  uc.activeLayerId = group.id;
  setSelection(uc, [group.id], group.id);
  finishStructureChange(uc, before, activeBefore);
  return group;
}

export function ungroupLayer(uc, group = uc.activeLayer) {
  if (!isGroupLayer(group)) {
    uc.setStatus("Select a group to ungroup", true);
    return false;
  }
  if (transformBusy(uc)) return false;
  uc.normalizeLayerOrder();
  const before = captureGroupStructure(uc.layers);
  const activeBefore = uc.activeLayerId;
  const children = uc.layers.filter((layer) => layer.groupId === group.id);
  for (const child of children) child.groupId = group.groupId || null;
  uc.layers = uc.layers.filter((layer) => layer !== group);
  uc.activeLayerId = children[0]?.id || uc.layers.find((layer) => layer.type !== "mask")?.id || uc.layers[0]?.id || null;
  setSelection(uc, children.map((layer) => layer.id), uc.activeLayerId);
  finishStructureChange(uc, before, activeBefore);
  uc.setStatus(`${group.name} ungrouped`);
  return true;
}

function removeEntriesFor(uc, layers) {
  // Removal order top-down at the recorded index: undo re-inserts in reverse, rebuilding the run.
  const entries = [];
  const previousActiveLayerId = uc.activeLayerId;
  for (const layer of layers) {
    const index = uc.layers.indexOf(layer);
    if (index < 0) continue;
    uc.layers.splice(index, 1);
    entries.push({ kind: "removeLayer", layer, index, groupId: layer.groupId || null, previousActiveLayerId });
  }
  return entries;
}

export function deleteGroup(uc, group, mode = "keep") {
  if (!isGroupLayer(group)) return false;
  if (transformBusy(uc)) return false;
  uc.normalizeLayerOrder();
  if (mode === "keep") {
    const before = captureGroupStructure(uc.layers);
    const activeBefore = uc.activeLayerId;
    for (const child of uc.layers.filter((layer) => layer.groupId === group.id)) child.groupId = group.groupId || null;
    uc.layers = uc.layers.filter((layer) => layer !== group);
    if (uc.activeLayerId === group.id) uc.activeLayerId = uc.layers.find((layer) => layer.type !== "mask")?.id || uc.layers[0]?.id || null;
    setSelection(uc, [uc.activeLayerId]);
    finishStructureChange(uc, before, activeBefore);
    uc.setStatus(`${group.name} deleted, contents kept`);
    return true;
  }
  const doomed = [group, ...getGroupDescendants(uc.layers, group)];
  if (doomed.some((layer) => layer.id === uc.panorama?.settings?.baseLayerId)) {
    uc.setStatus("The panorama base layer cannot be deleted with a group", true);
    return false;
  }
  if (uc.layers.length - doomed.length < 1) {
    uc.setStatus("The canvas needs at least one layer", true);
    return false;
  }
  if (doomed.some((layer) => layer === uc.poseEditor?.layer)) uc.poseEditor.release();
  const entries = removeEntriesFor(uc, doomed);
  if (doomed.some((layer) => layer.id === uc.activeLayerId)) {
    uc.activeLayerId = uc.layers.find((layer) => layer.type !== "mask")?.id || uc.layers[0]?.id || null;
  }
  setSelection(uc, [uc.activeLayerId]);
  uc.pushHistoryEntry({ kind: "historyGroup", entries });
  uc.syncPoseToolToActiveLayer?.();
  uc.renderLayerList();
  uc.requestRender();
  uc.syncLightStateToWidget();
  uc.scheduleFullSync?.();
  uc.setStatus(`${group.name} deleted with its contents`);
  return true;
}

function chooseGroupDelete(uc, group) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div"); overlay.className = "vnccs-uc-modal-overlay";
    const modal = document.createElement("div"); modal.className = "vnccs-uc-modal";
    modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Delete group");
    const title = document.createElement("div"); title.className = "vnccs-uc-modal-title"; title.textContent = `Delete ${group.name}?`;
    const message = document.createElement("div"); message.className = "vnccs-uc-modal-message";
    message.textContent = "Delete the group together with its layers, or delete only the folder and keep its layers in place.";
    const previousFocus = document.activeElement;
    const close = (value) => { overlay.remove(); previousFocus?.focus?.(); resolve(value); };
    const actions = document.createElement("div"); actions.className = "vnccs-uc-modal-actions";
    const buttons = [
      uc._button("Cancel", "vnccs-uc-btn", () => close("cancel")),
      uc._button("Keep contents", "vnccs-uc-btn", () => close("keep")),
      uc._button("Delete contents", "vnccs-uc-btn danger", () => close("all")),
    ];
    buttons[1].dataset.groupDelete = "keep";
    buttons[2].dataset.groupDelete = "all";
    actions.append(...buttons); modal.append(title, message, actions); overlay.append(modal);
    overlay.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); close("cancel"); }
      if (e.key === "Tab") {
        e.preventDefault();
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + (e.shiftKey ? 2 : 1)) % 3].focus();
      }
    });
    uc.container.append(overlay); buttons[1].focus();
  });
}

export async function confirmDeleteGroup(uc, group) {
  if (!isGroupLayer(group) || transformBusy(uc)) return false;
  const hasContent = getGroupDescendants(uc.layers, group).length > 0;
  const choice = hasContent ? await chooseGroupDelete(uc, group) : "keep";
  if (choice === "cancel") return false;
  return deleteGroup(uc, group, choice);
}

function copyLeafLayer(uc, layer, groupId) {
  uc.panorama?.commitLayer?.(layer);
  const copy = {
    id: newId(),
    name: layer.name,
    nameSource: layer.nameSource,
    type: layer.type,
    pose: layer.pose ? JSON.parse(JSON.stringify(layer.pose)) : undefined,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
    blendMode: layer.blendMode || "source-over",
    groupId,
    meta: createLayerMeta("duplicate", { derivedFrom: layer.id, character: layer.meta?.character }),
    canvas: uc.cloneCanvas(layer.canvas),
  };
  if (layer.panoramaCanvas) copy.panoramaCanvas = uc.cloneCanvas(layer.panoramaCanvas);
  if (layer._panoramaBefore) copy._panoramaBefore = uc.cloneCanvas(layer._panoramaBefore);
  if (layer.hiresCanvas && layer.hiresRect) {
    copy.hiresCanvas = uc.cloneCanvas(layer.hiresCanvas);
    copy.hiresRect = { ...layer.hiresRect };
  }
  uc.invalidateLayerCaches(copy);
  if (uc.panorama) copy._panoramaDirty = false;
  return copy;
}

export function duplicateGroup(uc, group = uc.activeLayer) {
  if (!isGroupLayer(group) || transformBusy(uc)) return null;
  uc.poseEditor?.commit?.();
  uc.normalizeLayerOrder();
  const parentId = group.groupId || null;
  const before = captureGroupStructure(uc.layers);
  const activeBefore = uc.activeLayerId;
  const idMap = new Map();
  const copies = [];
  for (const layer of [group, ...getGroupDescendants(uc.layers, group)]) {
    const newParent = layer === group ? parentId : idMap.get(layer.groupId) || null;
    const copy = isGroupLayer(layer)
      ? createGroupLayer({ ...layer, id: undefined, groupId: newParent, name: layer === group ? `${layer.name} copy` : layer.name,
        meta: createLayerMeta("duplicate", { derivedFrom: layer.id }) })
      : copyLeafLayer(uc, layer, newParent);
    idMap.set(layer.id, copy.id);
    copies.push(copy);
  }
  const index = uc.layers.indexOf(group);
  uc.layers.splice(Math.max(0, index), 0, ...copies);
  uc.activeLayerId = copies[0].id;
  setSelection(uc, [copies[0].id], copies[0].id);
  const adds = copies.map((layer) => ({ kind: "addLayer", layer, previousActiveLayerId: activeBefore }));
  finishStructureChange(uc, before, activeBefore, adds);
  return copies[0];
}

export function flattenGroup(uc, group = uc.activeLayer) {
  if (!isGroupLayer(group) || transformBusy(uc)) return null;
  uc.poseEditor?.release?.();
  uc.normalizeLayerOrder();
  const descendants = getGroupDescendants(uc.layers, group);
  if (descendants.some((layer) => layer.id === uc.panorama?.settings?.baseLayerId)) {
    uc.setStatus("The panorama base layer cannot be flattened into a group layer", true);
    return null;
  }
  uc.recordHistoryBefore();
  const layer = {
    id: newId(),
    name: group.name,
    nameSource: group.nameSource,
    type: "raster",
    visible: group.visible,
    locked: false,
    opacity: isIsolatedGroup(group) ? group.opacity : 1,
    blendMode: groupCompositeOperation(group),
    groupId: group.groupId || null,
    meta: createLayerMeta("rasterize"),
    canvas: uc._createCanvas(),
  };
  const ctx = uc.configureImageContext(layer.canvas.getContext("2d"), false);
  // Children render as a pass-through subtree; the group's opacity and blend move to the layer.
  uc.drawFlattenedLayers(ctx, descendants);
  if (uc.panorama) {
    const surface = uc.panorama.ensureLayer(layer);
    const pctx = surface.getContext("2d");
    compositeLayerStack(pctx, descendants, (target, leaf) => {
      if (leaf.type !== "raster" && leaf.type !== "pose") return;
      target.save();
      target.globalAlpha = leaf.opacity;
      target.globalCompositeOperation = leaf.blendMode || "source-over";
      target.drawImage(uc.panorama.ensureLayer(leaf), 0, 0);
      target.restore();
    }, uc._groupScratchPool);
    layer._panoramaDirty = false;
  }
  uc.invalidateLayerCaches(layer);
  const index = uc.layers.indexOf(group);
  const drop = new Set([group, ...descendants]);
  const rest = uc.layers.filter((item) => !drop.has(item));
  rest.splice(Math.max(0, Math.min(rest.length, index)), 0, layer);
  uc.layers = rest;
  uc.normalizeLayerOrder();
  if (uc.panorama) uc.panorama.projectLayer(layer);
  uc.activeLayerId = layer.id;
  setSelection(uc, [layer.id], layer.id);
  uc.syncPoseToolToActiveLayer?.();
  uc.renderLayerList();
  uc.requestRender();
  uc.syncLightStateToWidget();
  uc.scheduleFullSync?.();
  uc.setStatus(`${group.name} flattened to a layer`);
  return layer;
}

function toggleGroupProperty(uc, group, key) {
  if (transformBusy(uc)) return;
  const before = { [key]: group[key] };
  group[key] = !group[key];
  if (key === "collapsed") {
    // Collapse is a persisted UI preference, not history.
    uc.renderLayerList();
    uc.syncLightStateToWidget();
    return;
  }
  uc.pushHistoryEntry({ kind: "layerProps", layerId: group.id, before, after: { [key]: group[key] } });
  if (uc.tool === "pose") void uc.activatePoseTool?.(false);
  uc.renderLayerList();
  uc.requestRender();
  uc.syncLightStateToWidget();
}

// Panel ---------------------------------------------------------------------------------------

export function handleLayerRowClick(uc, layerId, event) {
  const layer = uc.layers.find((item) => item.id === layerId);
  if (!layer) return;
  const current = uc.selectedLayerIds?.length ? uc.selectedLayerIds : [uc.activeLayerId].filter(Boolean);
  if ((event?.ctrlKey || event?.metaKey) && layer.type !== "mask") {
    const set = new Set(current.filter((id) => uc.layers.find((item) => item.id === id)?.type !== "mask"));
    if (set.has(layerId) && set.size > 1) {
      set.delete(layerId);
      uc.selectedLayerIds = [...set];
      // The active layer stays the last clicked one that is still selected.
      if (uc.activeLayerId === layerId) uc.setActiveLayer([...set].pop());
      else syncSelectionClasses(uc);
      return;
    }
    set.add(layerId);
    uc.selectedLayerIds = [...set];
    uc.setActiveLayer(layerId);
    return;
  }
  if (event?.shiftKey && layer.type !== "mask" && uc._selectionAnchorId) {
    uc.selectedLayerIds = selectionRange(uc.layers, uc._selectionAnchorId, layerId);
    uc.setActiveLayer(layerId);
    return;
  }
  uc._selectionAnchorId = layerId;
  uc.selectedLayerIds = [layerId];
  uc.setActiveLayer(layerId);
}

// Indent, selection state and the "inside" drop zone shared by layer and folder rows.
export function decorateLayerRow(uc, row, layer) {
  if (layer.type === "mask") return row;
  const depth = groupChainOf(uc.layers, layer).length;
  row.dataset.groupDepth = String(depth);
  if (depth) row.style.marginLeft = `${depth * GROUP_INDENT_PX}px`;
  row.classList.toggle("selected", (uc.selectedLayerIds || []).includes(layer.id));
  if (!isLayerEffectivelyVisible(uc.layers, layer) && layer.visible) row.classList.add("hidden-by-group");
  return row;
}

export function layerDropPlacement(row, clientY) {
  const rect = row.getBoundingClientRect();
  if (row.classList.contains("vnccs-uc-folder")) {
    const third = rect.height / 3;
    if (clientY < rect.top + third) return "before";
    if (clientY > rect.bottom - third) return "after";
    return "inside";
  }
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

export function createFolderRow(uc, layer) {
  const row = document.createElement("div");
  row.className = `vnccs-uc-folder vnccs-uc-layer-row ${layer.id === uc.activeLayerId ? "active" : ""} ${layer.locked ? "locked" : ""} ${layer.visible ? "" : "hidden-group"}`;
  row.draggable = true;
  row.dataset.layerId = layer.id;
  row.dataset.layerType = GROUP_LAYER_TYPE;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "vnccs-uc-folder-toggle";
  toggle.title = layer.collapsed ? "Expand group" : "Collapse group";
  toggle.innerHTML = layer.collapsed ? GROUP_ICONS.closed : GROUP_ICONS.open;
  toggle.dataset.folderToggle = "";
  const icon = document.createElement("span");
  icon.className = "vnccs-uc-folder-icon";
  icon.innerHTML = GROUP_ICONS.folder;
  const name = document.createElement("div");
  name.className = "vnccs-uc-folder-name";
  name.textContent = layer.name;
  const opacity = document.createElement("span");
  opacity.className = "vnccs-uc-folder-opacity";
  opacity.textContent = `${Math.round((Number(layer.opacity) || 0) * 100)}%`;
  const eye = uc._button(layer.visible ? GROUP_ICONS.eye : GROUP_ICONS.eyeOff, "vnccs-uc-icon", null, layer.visible ? "Hide group" : "Show group");
  eye.dataset.folderEye = "";
  const lock = uc._button(layer.locked ? GROUP_ICONS.lock : GROUP_ICONS.unlock, "vnccs-uc-icon", null, layer.locked ? "Unlock group" : "Lock group");
  lock.dataset.layerLock = "";
  const del = uc._button(GROUP_ICONS.trash, "vnccs-uc-icon danger", null, "Delete group");
  row.append(toggle, icon, name, opacity, eye, lock, del);
  const stop = (el, fn) => {
    el.addEventListener("click", (e) => { e.stopPropagation(); fn(e); });
    el.addEventListener("dblclick", (e) => e.stopPropagation());
  };
  stop(toggle, () => toggleGroupProperty(uc, layer, "collapsed"));
  stop(eye, () => toggleGroupProperty(uc, layer, "visible"));
  stop(lock, () => toggleGroupProperty(uc, layer, "locked"));
  stop(del, () => { void confirmDeleteGroup(uc, layer); });
  row.addEventListener("click", (e) => uc.onLayerRowClick(layer.id, e));
  name.addEventListener("dblclick", async (e) => {
    e.stopPropagation();
    const next = await uc.promptInWidget("Rename Group", "Group name", layer.name);
    if (next === null) return;
    const value = String(next).trim() || layer.name;
    if (value === layer.name) return;
    uc.pushHistoryEntry({ kind: "layerProps", layerId: layer.id, before: { name: layer.name, nameSource: layer.nameSource }, after: { name: value, nameSource: "user" } });
    layer.name = value;
    layer.nameSource = "user";
    name.textContent = value;
    uc.syncLightStateToWidget();
  });
  uc.attachLayerRowDragHandlers(row, layer);
  return decorateLayerRow(uc, row, layer);
}

// The rows the raster section shows: children of collapsed folders are hidden.
export function visibleLayerRows(layers) {
  const byId = layerIndex(layers);
  return layers.filter((layer) => layer.type !== "mask"
    && !groupChainOf(layers, layer, byId).some((group) => group.collapsed));
}

function openGroupMenu(uc, layer, e) {
  uc._vnccsLayerMenu?.remove();
  uc._vnccsLayerMenu = null;
  const menu = document.createElement("div");
  menu.className = "vnccs-uc-layer-menu vnccs-uc-folder-menu";
  menu.style.cssText = "position:absolute; z-index:40; min-width:210px; padding:6px; border-radius:10px; background:rgba(20,16,30,.97); border:1px solid rgba(255,255,255,.12); display:grid; gap:2px; font:11px sans-serif;";
  for (const item of GROUP_MENU_ITEMS) {
    if (item.groupOnly && !isGroupLayer(layer)) continue;
    const entry = document.createElement("button");
    entry.type = "button";
    entry.textContent = item.label;
    entry.dataset.groupAction = item.id;
    entry.style.cssText = "text-align:left; padding:6px 10px; border:0; border-radius:6px; background:transparent; color:#e8e8f0; cursor:pointer;";
    entry.addEventListener("pointerenter", () => { entry.style.background = "rgba(255,255,255,.08)"; });
    entry.addEventListener("pointerleave", () => { entry.style.background = "transparent"; });
    entry.addEventListener("click", () => {
      menu.remove();
      if (uc._vnccsLayerMenu === menu) uc._vnccsLayerMenu = null;
      runGroupAction(uc, item.id, layer);
    });
    menu.appendChild(entry);
  }
  uc.container.appendChild(menu);
  const host = uc.container.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(host.width - menu.offsetWidth - 4, e.clientX - host.left))}px`;
  menu.style.top = `${Math.max(0, Math.min(host.height - menu.offsetHeight - 4, e.clientY - host.top))}px`;
  uc._vnccsLayerMenu = menu;
}

export function runGroupAction(uc, id, layer = uc.activeLayer) {
  if (id === "new-group") return addEmptyGroup(uc);
  if (id === "group-selected") return groupSelectedLayers(uc);
  if (id === "ungroup") return ungroupLayer(uc, layer);
  if (id === "duplicate-group") return duplicateGroup(uc, layer);
  if (id === "flatten-group") return flattenGroup(uc, layer);
  if (id === "delete-group") return confirmDeleteGroup(uc, layer);
  return undefined;
}

// Painting and moving -------------------------------------------------------------------------

const PIXEL_TOOLS = new Set(["brush", "eraser", "rect", "resize"]);

/** Refuse a pixel tool whose target is a group, or is locked or hidden through its groups. */
export function refuseLayerToolTarget(uc, mode) {
  const layer = uc.activeLayer;
  if (!layer || (!PIXEL_TOOLS.has(mode) && mode !== "move")) return false;
  if (isGroupLayer(layer)) {
    if (mode === "move") return false;
    uc.setStatus(mode === "resize" ? "Groups cannot be transformed; select a layer inside it" : `${layer.name} is a group; select a layer to paint`, true);
    return true;
  }
  if (layer.type === "mask") return false;
  if (isLayerEffectivelyLocked(uc.layers, layer)) {
    uc.setStatus(layer.locked ? `${layer.name} is locked` : `${layer.name} is locked by its group`, true);
    return true;
  }
  if (mode !== "move" && !isLayerEffectivelyVisible(uc.layers, layer)) {
    uc.setStatus(layer.visible ? `${layer.name} is hidden by its group` : `${layer.name} is hidden`, true);
    return true;
  }
  return false;
}

function moveTargetsFor(uc) {
  const active = uc.activeLayer;
  if (!active || active.type === "mask") return null;
  const selection = (uc.selectedLayerIds || []).filter((id) => id !== active.id);
  if (!isGroupLayer(active) && !selection.length) return null;
  const picks = topLevelSelection(uc.layers, isGroupLayer(active) && !selection.length ? [active.id] : [active.id, ...selection]);
  const leaves = [];
  for (const pick of picks) {
    for (const layer of [pick, ...getGroupDescendants(uc.layers, pick)]) {
      if (layer.type !== "raster" && layer.type !== "pose") continue;
      if (isLayerEffectivelyLocked(uc.layers, layer)) continue;
      if (layer.id === uc.panorama?.settings?.baseLayerId) continue;
      if (!leaves.includes(layer)) leaves.push(layer);
    }
  }
  return leaves;
}

/**
 * Move tool press on a group or a multi-selection: capture every child's pixels once; the
 * existing move preview offsets them live, pointerup commits them as one history entry.
 */
export function beginMultiLayerMove(uc) {
  const targets = moveTargetsFor(uc);
  if (!targets) return false;
  if (isGroupLayer(uc.activeLayer) && isLayerEffectivelyLocked(uc.layers, uc.activeLayer)) {
    uc.setStatus(`${uc.activeLayer.name} is locked`, true);
    uc.pointerMode = "idle";
    return true;
  }
  const start = uc.dragStart;
  const moveTargets = [];
  for (const layer of targets) {
    const layerBefore = uc.createLayerPixelSnapshot(layer);
    const layerBounds = layerBefore?.crop || null;
    if (!layerBounds && layer.type !== "pose") continue;
    moveTargets.push({
      layerId: layer.id,
      layerBefore,
      layerBounds,
      layerCanvas: layerBounds ? uc.cloneCanvasCrop(layer.canvas, layerBounds) : null,
      hiresRect: layer.hiresRect ? { ...layer.hiresRect } : null,
    });
  }
  if (!moveTargets.length) {
    uc.setStatus("Nothing to move: the selected layers are empty or locked", true);
    uc.pointerMode = "idle";
    return true;
  }
  uc.pointerMode = "layer-move";
  start.layerId = uc.activeLayer.id;
  start.moveTargets = moveTargets;
  start.moveLayerIds = new Set(moveTargets.map((item) => item.layerId));
  start.layerOrigin = { ...uc.origin };
  const own = moveTargets.find((item) => item.layerId === uc.activeLayer.id);
  start.layerBounds = own?.layerBounds || null;
  return true;
}

export function commitMultiLayerMove(uc) {
  const start = uc.dragStart;
  if (!start?.moveTargets) return false;
  const dx = start.previewDx || 0;
  const dy = start.previewDy || 0;
  if (!dx && !dy) return true;
  const sourceOrigin = start.layerOrigin || uc.origin;
  // Grow the backing once for the union, before any layer is redrawn.
  for (const target of start.moveTargets) {
    const crop = target.layerBounds;
    if (!crop) continue;
    if (!uc.ensureWorldBounds(sourceOrigin.x + crop.x + dx, sourceOrigin.y + crop.y + dy, 256, true)) return true;
    if (!uc.ensureWorldBounds(sourceOrigin.x + crop.x + crop.width + dx, sourceOrigin.y + crop.y + crop.height + dy, 256, true)) return true;
  }
  const entries = [];
  for (const target of start.moveTargets) {
    const layer = uc.layers.find((item) => item.id === target.layerId);
    if (!layer) continue;
    uc.commitLayerMoveFrom(layer, { ...target, layerOrigin: sourceOrigin }, dx, dy, true);
    entries.push({ kind: "layerPixels", layerId: layer.id, before: target.layerBefore, after: uc.createLayerPixelSnapshot(layer) });
  }
  if (entries.length) uc.pushHistoryEntry({ kind: "historyGroup", entries });
  for (const entry of entries) uc.refreshLayerRow(entry.layerId);
  return true;
}

// Subhead: groups get "Pass Through" in the blend list and use the same opacity slider.
export function syncGroupSubhead(uc, layer) {
  const select = uc.layerSubhead?.querySelector('[data-layer-control="blendMode"]');
  if (!select) return;
  let option = select.querySelector(`option[value="${PASS_THROUGH}"]`);
  if (!option) {
    option = document.createElement("option");
    option.value = PASS_THROUGH;
    option.textContent = "Pass Through";
    select.prepend(option);
  }
  const group = isGroupLayer(layer);
  option.hidden = !group;
  option.disabled = !group;
  if (group) select.value = layer.blendMode || PASS_THROUGH;
}

export function installUniCanvasGroups(uc) {
  if (!uc || uc._vnccsGroupsInstalled) return uc;
  uc._vnccsGroupsInstalled = true;
  uc.selectedLayerIds = [];
  uc._groupScratchPool = [];
  injectGroupStyles(uc);

  uc.groupSelectedLayers = () => groupSelectedLayers(uc);
  uc.ungroupActiveLayer = () => ungroupLayer(uc, uc.activeLayer);
  uc.addEmptyGroup = () => addEmptyGroup(uc);
  uc.duplicateGroup = (group) => duplicateGroup(uc, group);
  uc.flattenGroup = (group) => flattenGroup(uc, group);
  uc.deleteGroup = (group, mode) => deleteGroup(uc, group, mode);
  uc.confirmDeleteGroup = (group) => confirmDeleteGroup(uc, group);
  uc.moveLayerInStack = (sourceId, targetId, placement) => moveLayerInStack(uc, sourceId, targetId, placement);
  uc.moveLayerAmongSiblings = (direction) => moveLayerAmongSiblings(uc, direction);
  uc.createFolderRow = (layer) => createFolderRow(uc, layer);
  uc.decorateLayerRow = (row, layer) => decorateLayerRow(uc, row, layer);
  uc.onLayerRowClick = (layerId, event) => handleLayerRowClick(uc, layerId, event);
  uc.refuseLayerToolTarget = (mode) => refuseLayerToolTarget(uc, mode);
  uc.beginMultiLayerMove = () => beginMultiLayerMove(uc);
  uc.commitMultiLayerMove = () => commitMultiLayerMove(uc);
  uc.syncGroupSubhead = (layer) => syncGroupSubhead(uc, layer);
  uc.syncLayerSelectionClasses = () => syncSelectionClasses(uc);

  const actions = document.createElement("div");
  actions.className = "vnccs-uc-group-actions";
  actions.append(
    uc._button("New group", "vnccs-uc-btn", () => addEmptyGroup(uc), "New empty group"),
    uc._button("Group", "vnccs-uc-btn", () => groupSelectedLayers(uc), "Group selected layers (Ctrl+G)"),
    uc._button("Ungroup", "vnccs-uc-btn", () => ungroupLayer(uc, uc.activeLayer), "Ungroup the selected group (Ctrl+Shift+G)"),
  );
  uc.layersTopActions?.append(actions);

  // Rows are not focusable; the list takes focus so Ctrl+G works right after a selection click.
  if (uc.layerList) {
    uc.layerList.tabIndex = -1;
    uc.layerList.addEventListener("pointerdown", (e) => {
      if (e.target.closest?.("[data-layer-id]") && !e.target.closest?.("button, input, select")) uc.layerList.focus({ preventScroll: true });
    });
  }

  // Folder rows open the group menu; capture phase so the raster-layer menu does not open too.
  uc.layerList?.addEventListener("contextmenu", (e) => {
    const row = e.target.closest?.("[data-layer-id]");
    const layer = row && uc.layers.find((item) => item.id === row.dataset.layerId);
    if (!isGroupLayer(layer)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openGroupMenu(uc, layer, e);
  }, true);
  return uc;
}
