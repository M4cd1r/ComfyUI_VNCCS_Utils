/**
 * VNCCS UniCanvas - node vs standalone surface (single source of truth).
 *
 * UniCanvas runs on two surfaces: the node inside a ComfyUI workflow and the standalone sidebar
 * tab (vnccs_unicanvas_modes.mjs). Every feature stays available in the standalone tab; a few
 * document-level features only make sense there and are not shown on the node:
 * scene states (#7), the timeline (#9), the VN preview (#10) and the project / scene selector
 * with its generation history (#22, #24).
 *
 * "Not shown" hides, it never deletes: the node keeps loading and saving that data unchanged,
 * only the UI and the keyboard shortcuts are withheld. Feature code asks
 * `isUniCanvasFeatureAvailable(uc, key)` instead of reading `uc.standalone` or the feature
 * toggle on its own, and the hiding stylesheet is generated from the feature-toggle registry's
 * `hide` selectors, so a feature has one list of selectors for both reasons to hide it.
 *
 * No import-time side effects and no ComfyUI app import, so it runs in `node --test`.
 */

import { isUniCanvasEnabled, UNICANVAS_FEATURE_TOGGLES } from "./vnccs_unicanvas_feature_toggles.mjs";

/** Marker on the stub node the standalone tab constructs its widget with. */
export const UNICANVAS_STANDALONE_NODE_FLAG = "vnccsUniCanvasStandalone";
/** Feature-toggle keys shown only in the standalone tab. */
export const UNICANVAS_STANDALONE_ONLY_FEATURES = Object.freeze(["sceneStates", "timeline", "vnPreview", "projects", "history"]);
/** Class on the widget container while it runs as a workflow node. */
export const UNICANVAS_NODE_SURFACE_CLASS = "vnccs-uc-node-surface";
const STYLE_ID = "vnccs-unicanvas-surface";
const STANDALONE_ONLY = new Set(UNICANVAS_STANDALONE_ONLY_FEATURES);

/** Marks the stub node of a standalone widget, so the mode is known from the constructor on. */
export function markUniCanvasStandaloneNode(node) {
  if (node && typeof node === "object") node[UNICANVAS_STANDALONE_NODE_FLAG] = true;
  return node;
}

/** Whether this widget is the standalone tab (anything else is a workflow node). */
export function isUniCanvasStandalone(uc) {
  return uc?.standalone === true || uc?.node?.[UNICANVAS_STANDALONE_NODE_FLAG] === true;
}

export function uniCanvasSurface(uc) {
  return isUniCanvasStandalone(uc) ? "standalone" : "node";
}

export function isUniCanvasStandaloneOnlyFeature(key) {
  return STANDALONE_ONLY.has(key);
}

/** The one availability check: the feature toggle is on and the surface shows the feature. */
export function isUniCanvasFeatureAvailable(uc, key) {
  if (!isUniCanvasEnabled(key)) return false;
  return !STANDALONE_ONLY.has(key) || isUniCanvasStandalone(uc);
}

/** Stylesheet hiding the standalone-only features inside a node-surface widget. */
export function uniCanvasNodeSurfaceCss() {
  const selectors = UNICANVAS_FEATURE_TOGGLES
    .filter((entry) => STANDALONE_ONLY.has(entry.key))
    .flatMap((entry) => entry.hide || [])
    .map((selector) => `.vnccs-unicanvas.${UNICANVAS_NODE_SURFACE_CLASS} ${selector}`);
  return selectors.length ? `${selectors.join(",\n")} { display: none !important; }\n` : "";
}

function ensureSurfaceStyles(doc) {
  if (!doc?.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = uniCanvasNodeSurfaceCss();
  doc.head.appendChild(style);
}

/** Tags the widget container with its surface and installs the hiding stylesheet once. */
export function applyUniCanvasSurface(uc) {
  const container = uc?.container;
  if (!container) return uc;
  ensureSurfaceStyles(container.ownerDocument || (typeof document === "undefined" ? null : document));
  container.classList?.toggle(UNICANVAS_NODE_SURFACE_CLASS, !isUniCanvasStandalone(uc));
  if (container.dataset) container.dataset.surface = uniCanvasSurface(uc);
  return uc;
}
