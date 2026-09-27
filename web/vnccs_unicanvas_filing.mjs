/**
 * VNCCS UniCanvas - filing layers into category folders (issue #17).
 *
 *  - Categories: Background, Characters, Props, Effects, Lighting, Overlays, Other. Character-
 *    linked layers go to "Characters / <Character name>".
 *  - Auto-file (setting, default on): a new root-level layer goes into its category folder,
 *    created on demand. The move joins the layer's creation history entry, so undoing the add
 *    also removes a folder created for it.
 *  - Organize layers (Layers header): a preview of `layer -> folder` for every root-level
 *    unfiled layer, with checkboxes; the checked moves apply as one `groupStructure` entry.
 *  - Existing folders are reused by name and never renamed or dissolved; layers already inside
 *    a folder are never moved. New category folders follow the canonical order (top to bottom)
 *    relative to the category folders already present, so a user's reordering is respected.
 *
 * planFiling / applyFilingPlan are pure (Node tests); the rest binds onto the widget.
 */

import { isMaskSectionLayer } from "./vnccs_unicanvas_control.mjs";
import { captureGroupStructure, createGroupLayer, getGroupDescendants, isGroupLayer, normalizeGroupedLayerOrder } from "./vnccs_unicanvas_groups.mjs";
import { isUniCanvasEnabled } from "./vnccs_unicanvas_feature_toggles.mjs";
import { applyRulesName, resolveAutoNamingLevel } from "./vnccs_unicanvas_naming.mjs";
import { CATEGORY_CHARACTERS, CATEGORY_OTHER, LAYER_CATEGORIES, layerCategory, layerCharacterName } from "./vnccs_unicanvas_naming_rules.mjs";

export const AUTO_FILE_SETTING = "auto_file_layers";
export const CANONICAL_FOLDER_ORDER = Object.freeze(["Overlays", "Effects", "Lighting", "Characters", "Props", "Background", "Other"]);

export const resolveAutoFile = (settings) => settings?.[AUTO_FILE_SETTING] !== false && isUniCanvasEnabled("autoFiling");

const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
const rankOf = (name) => CANONICAL_FOLDER_ORDER.findIndex((item) => sameName(item, name));

/** Where a layer would be filed: { category, character, path } or null when it has no category. */
export function filingTarget(layer, layers = [], { fallbackOther = false } = {}) {
  const category = layerCategory(layer) || (fallbackOther ? CATEGORY_OTHER : null);
  if (!category) return null;
  const character = category === CATEGORY_CHARACTERS ? layerCharacterName(layer, layers) : null;
  return { category, character, path: character ? `${category} / ${character}` : category };
}

/** Root-level leaf layers that no folder holds yet (masks and the pinned panorama base excluded). */
export function isUnfiledLayer(layer, { pinnedId = null } = {}) {
  return Boolean(layer) && !isMaskSectionLayer(layer) && !isGroupLayer(layer) && !layer.groupId && layer.id !== pinnedId;
}

/** The Organize plan: every unfiled root-level layer with its target folder path. */
export function planFiling(layers, { pinnedId = null, fallbackOther = true } = {}) {
  const plan = [];
  for (const layer of layers) {
    if (!isUnfiledLayer(layer, { pinnedId })) continue;
    if (layer.shadow) continue; // shadow layers stay filed under their source (harmonize)
    const target = filingTarget(layer, layers, { fallbackOther });
    if (target) plan.push({ layerId: layer.id, name: layer.name, ...target });
  }
  return plan;
}

function findRootFolder(layers, name) {
  return layers.find((layer) => isGroupLayer(layer) && !layer.groupId && sameName(layer.name, name)) || null;
}

function findChildFolder(layers, parent, name) {
  return layers.find((layer) => isGroupLayer(layer) && layer.groupId === parent.id && sameName(layer.name, name)) || null;
}

function indexAfterSubtree(layers, layer) {
  return layers.indexOf(layer) + 1 + getGroupDescendants(layers, layer).length;
}

// Index for a new root category folder: before the first present category folder that ranks
// below it, else after the last one that ranks above it, else where the filed layer sits.
function newRootFolderIndex(layers, category, anchor) {
  const rank = rankOf(category);
  const present = layers.filter((layer) => isGroupLayer(layer) && !layer.groupId && rankOf(layer.name) >= 0);
  const below = present.find((layer) => rankOf(layer.name) > rank);
  if (below) return layers.indexOf(below);
  const above = present.filter((layer) => rankOf(layer.name) < rank).pop();
  if (above) return indexAfterSubtree(layers, above);
  const at = layers.indexOf(anchor);
  return at >= 0 ? at : layers.findIndex((layer) => !isMaskSectionLayer(layer));
}

/**
 * Applies `plan` ([{ layerId, category, character }]) to a copy of the stack order. Mutates the
 * moved layers' `groupId` only. Returns { layers, created } with the new ordered stack and the
 * folders created on demand; `makeGroup(fields)` builds a folder (default createGroupLayer).
 */
export function applyFilingPlan(layers, plan, { pinnedId = null, makeGroup = createGroupLayer } = {}) {
  let stack = layers.slice();
  const created = [];
  for (const step of plan) {
    const layer = stack.find((item) => item.id === step.layerId);
    if (!isUnfiledLayer(layer, { pinnedId }) || !LAYER_CATEGORIES.includes(step.category)) continue;
    let folder = findRootFolder(stack, step.category);
    if (!folder) {
      folder = makeGroup({ name: step.category, groupId: null });
      stack.splice(Math.max(0, newRootFolderIndex(stack, step.category, layer)), 0, folder);
      created.push(folder);
    }
    if (step.character) {
      let sub = findChildFolder(stack, folder, step.character);
      if (!sub) {
        sub = makeGroup({ name: step.character, groupId: folder.id });
        stack.splice(stack.indexOf(folder) + 1, 0, sub);
        created.push(sub);
      }
      folder = sub;
    }
    stack = stack.filter((item) => item !== layer);
    layer.groupId = folder.id;
    // New arrivals go on top of the folder.
    stack.splice(stack.indexOf(folder) + 1, 0, layer);
  }
  return { layers: normalizeGroupedLayerOrder(stack, { pinnedLastId: pinnedId }), created };
}

const pinnedIdOf = (uc) => uc.panorama?.settings?.baseLayerId || null;

/** Files `plan` on the widget and returns the groupStructure entry (not pushed), or null. */
export function fileLayers(uc, plan) {
  if (!plan?.length) return null;
  uc.normalizeLayerOrder();
  const before = captureGroupStructure(uc.layers);
  const activeBefore = uc.activeLayerId;
  const { layers, created } = applyFilingPlan(uc.layers, plan, { pinnedId: pinnedIdOf(uc) });
  const moved = plan.some((step) => (layers.find((layer) => layer.id === step.layerId)?.groupId || null) !== null);
  if (!moved && !created.length) return null;
  uc.layers = layers;
  uc.normalizeLayerOrder();
  return { kind: "groupStructure", before, after: captureGroupStructure(uc.layers), activeBefore, activeAfter: uc.activeLayerId };
}

// Organize renames layers and files them as ONE undo step (owner decision): the name changes
// ride the same groupStructure entry as the structure, applied by the registered history kind.

const nameRecordOf = (layer) => ({ id: layer.id, name: layer.name, nameSource: layer.nameSource || null });

function captureLayerNames(layers) {
  return layers.filter((layer) => !isMaskSectionLayer(layer)).map(nameRecordOf);
}

/** The (name, nameSource) changes since `before`, as [{ id, before, after }] records. */
function collectNameChanges(before, layers) {
  const previous = new Map(before.map((record) => [record.id, record]));
  const changes = [];
  for (const layer of layers) {
    if (isMaskSectionLayer(layer)) continue;
    const was = previous.get(layer.id);
    if (!was || (was.name === layer.name && (was.nameSource || null) === (layer.nameSource || null))) continue;
    changes.push({ id: layer.id, before: { name: was.name, nameSource: was.nameSource || null }, after: nameRecordOf(layer) });
  }
  return changes;
}

/** Applies the recorded name changes of one Organize entry ("undo" restores, "redo" reapplies). */
function applyNameChanges(uc, changes, direction) {
  for (const change of changes || []) {
    const layer = uc.layers.find((item) => item.id === change.id);
    if (!layer) continue;
    const value = direction === "undo" ? change.before : change.after;
    layer.name = value.name;
    layer.nameSource = value.nameSource;
  }
}

function revertNameChanges(uc, changes) {
  applyNameChanges(uc, changes, "undo");
  for (const change of changes) uc.refreshLayerRow?.(change.id);
}

/** Organize's auto-name pass: rules names for unfiled layers named "auto" (user/import stay). */
function applyAutoNames(uc) {
  if (resolveAutoNamingLevel(uc.settings) === "off") return;
  const pinnedId = pinnedIdOf(uc);
  for (const layer of uc.layers) {
    if (layer.nameSource !== "auto" || layer.shadow || !isUnfiledLayer(layer, { pinnedId })) continue;
    applyRulesName(uc, layer);
  }
}

function entryCreates(entry, layerId) {
  if (!entry) return false;
  if (entry.kind === "historyGroup") return (entry.entries || []).some((child) => entryCreates(child, layerId));
  return ["addLayer", "acceptStaging"].includes(entry.kind) && entry.layer?.id === layerId;
}

/**
 * Auto-files a new layer when the setting is on and its category is known. The move joins the
 * newest undo entry when that entry created the layer; otherwise nothing moves (Organize can
 * file it later), so filing never adds an undo step of its own.
 */
export function autoFileLayer(uc, layer) {
  if (!resolveAutoFile(uc.settings) || !layer || !uc.layers.includes(layer)) return false;
  if (!isUnfiledLayer(layer, { pinnedId: pinnedIdOf(uc) })) return false;
  const last = uc.undoStack?.[uc.undoStack.length - 1];
  if (!entryCreates(last, layer.id) || uc.transformDraft) return false;
  const target = filingTarget(layer, uc.layers);
  if (!target) return false;
  const structure = fileLayers(uc, [{ layerId: layer.id, ...target }]);
  if (!structure) return false;
  uc.undoStack[uc.undoStack.length - 1] = last.kind === "historyGroup"
    ? { ...last, entries: [...last.entries, structure] }
    : { kind: "historyGroup", entries: [last, structure] };
  uc.renderLayerList?.();
  uc.requestRender?.();
  uc.syncLightStateToWidget?.();
  return true;
}

// Folder with a sparkle at its corner: Organize = auto-name + file into folders.
const ORGANIZE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 11a1.5 1.5 0 0 1 1.5-1.5h3.5l1.5 1.5h6a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5Z"/><path d="m18.5 3 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>`;

const ORGANIZE_CSS = `
.vnccs-uc-organize-list { display:flex; flex-direction:column; gap:4px; max-height:320px; overflow:auto; margin:8px 0; }
.vnccs-uc-organize-row { display:flex; align-items:center; gap:8px; font-size:12px; }
.vnccs-uc-organize-row span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-uc-organize-row .vnccs-uc-organize-target { color:var(--uc-muted, #9aa); margin-left:auto; }
.vnccs-uc-organize-rename { display:flex; align-items:center; gap:6px; font-size:12px; margin:0 0 8px; }
`;

function injectOrganizeStyles(uc) {
  const doc = uc.container?.ownerDocument || globalThis.document;
  if (!doc || doc.getElementById("vnccs-uc-organize-style")) return;
  const style = doc.createElement("style");
  style.id = "vnccs-uc-organize-style";
  style.textContent = ORGANIZE_CSS;
  doc.head.appendChild(style);
}

/** The preview dialog: resolves to the checked moves plus the rename choice, or null on cancel. */
function chooseFilingPlan(uc, plan, renames = []) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div"); overlay.className = "vnccs-uc-modal-overlay";
    const modal = document.createElement("div"); modal.className = "vnccs-uc-modal vnccs-uc-organize";
    modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Organize layers");
    const title = document.createElement("div"); title.className = "vnccs-uc-modal-title"; title.textContent = "Organize layers";
    const message = document.createElement("div"); message.className = "vnccs-uc-modal-message";
    message.textContent = renames.length
      ? "Rename these layers to their automatic names and move them into folders. Folders you made and layers already in a folder stay as they are."
      : "Move these layers into folders. Folders you made and layers already in a folder stay as they are.";
    const list = document.createElement("div"); list.className = "vnccs-uc-organize-list";
    const nameBefore = new Map(renames.map((change) => [change.id, change.before.name]));
    const boxes = plan.map((step) => {
      const row = document.createElement("label"); row.className = "vnccs-uc-organize-row";
      row.dataset.organizeLayer = step.layerId;
      const box = document.createElement("input"); box.type = "checkbox"; box.checked = true;
      const was = nameBefore.get(step.layerId);
      const name = document.createElement("span"); name.textContent = was ? `${was} → ${step.name}` : step.name;
      if (was) name.title = `${was} → ${step.name}`;
      const target = document.createElement("span"); target.className = "vnccs-uc-organize-target"; target.textContent = `-> ${step.path}`;
      row.append(box, name, target); list.append(row);
      return box;
    });
    const previousFocus = document.activeElement;
    const close = (value) => { overlay.remove(); previousFocus?.focus?.(); resolve(value); };
    const actions = document.createElement("div"); actions.className = "vnccs-uc-modal-actions";
    const cancel = uc._button("Cancel", "vnccs-uc-btn", () => close(null));
    const apply = uc._button("Move", "vnccs-uc-btn primary", () => close({
      steps: plan.filter((_, index) => boxes[index].checked),
      rename: renameBox?.checked === true,
    }));
    apply.dataset.organizeApply = "";
    let renameBox = null;
    if (renames.length) {
      const renameLabel = document.createElement("label"); renameLabel.className = "vnccs-uc-organize-rename";
      renameBox = document.createElement("input"); renameBox.type = "checkbox"; renameBox.checked = true;
      renameBox.dataset.organizeRename = "";
      renameLabel.append(renameBox, document.createTextNode("Rename layers"));
      modal.append(title, message, list, renameLabel, actions);
    } else {
      modal.append(title, message, list, actions);
    }
    actions.append(cancel, apply);
    overlay.append(modal);
    overlay.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); close(null); }
    });
    uc.container.append(overlay); apply.focus();
  });
}

/**
 * Layers header "Organize": auto-name the unfiled "auto" layers, preview, then apply the checked
 * moves and the renames as ONE groupStructure entry (owner decision: one undo step for both).
 */
export async function organizeLayers(uc) {
  if (uc.transformDraft) {
    uc.setStatus("Apply or cancel the active transform first", true);
    return false;
  }
  const namesBefore = captureLayerNames(uc.layers);
  applyAutoNames(uc);
  await uc.autoNaming?.categorizeUnfiled?.();
  uc.normalizeLayerOrder();
  const renames = collectNameChanges(namesBefore, uc.layers);
  for (const change of renames) uc.refreshLayerRow?.(change.id);
  const plan = planFiling(uc.layers, { pinnedId: pinnedIdOf(uc) });
  if (!plan.length) {
    revertNameChanges(uc, renames);
    uc.setStatus("Organize: every layer is already in a folder");
    return false;
  }
  const chosen = await chooseFilingPlan(uc, plan, renames);
  if (!chosen?.steps.length) {
    revertNameChanges(uc, renames);
    return false;
  }
  if (!chosen.rename) revertNameChanges(uc, renames);
  const entry = fileLayers(uc, chosen.steps);
  if (!entry) {
    if (chosen.rename) revertNameChanges(uc, renames);
    return false;
  }
  const renamed = chosen.rename ? renames.length : 0;
  if (renamed) entry.names = renames;
  uc.pushHistoryEntry(entry);
  uc.renderLayerList();
  uc.requestRender();
  uc.syncLightStateToWidget();
  uc.scheduleFullSync?.();
  uc.setStatus(`Organized ${chosen.steps.length} layer${chosen.steps.length === 1 ? "" : "s"} into folders`
    + (renamed ? ` and renamed ${renamed} layer${renamed === 1 ? "" : "s"}` : ""));
  return true;
}

export function installUniCanvasFiling(uc) {
  if (!uc || uc._vnccsFilingInstalled) return uc;
  uc._vnccsFilingInstalled = true;
  injectOrganizeStyles(uc);
  uc.organizeLayers = () => organizeLayers(uc);
  uc.autoFileLayer = (layer) => autoFileLayer(uc, layer);
  // Renames recorded by an Organize entry ride the same groupStructure step: the widget's own
  // groupStructure restore handles order and parents, this applies the names on undo and redo.
  uc.registerHistoryKind?.("groupStructure", (entry, direction) => applyNameChanges(uc, entry.names, direction));
  const button = uc._button(ORGANIZE_ICON, "vnccs-uc-icon", () => organizeLayers(uc), "Organize layers: auto-name + file into folders");
  button.dataset.organizeLayers = "";
  // The row is [New group] [Organize] [Import image]: the icon sits before the import button,
  // which fills the remaining width (vnccs_unicanvas_groups.mjs prepends the New group icon).
  const importButton = uc.layersTopActions?.querySelector?.(".vnccs-uc-btn");
  if (importButton) uc.layersTopActions.insertBefore(button, importButton);
  else uc.layersTopActions?.append(button);
  return uc;
}
