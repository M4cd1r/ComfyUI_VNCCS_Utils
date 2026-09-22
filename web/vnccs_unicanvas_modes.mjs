/**
 * VNCCS UniCanvas - fullscreen mode and standalone sidebar mode.
 *
 * The logic lives outside vnccs_unicanvas.js on purpose: parallel feature
 * branches share that file, so everything here hooks in through two small
 * calls (installUniCanvasWidgetModes and registerUniCanvasStandaloneSidebarTab).
 */

import { app } from "../../scripts/app.js";

export const UNICANVAS_STANDALONE_STORAGE_KEY = "vnccs-unicanvas-standalone";

const UNICANVAS_STANDALONE_TAB_ID = "vnccs-unicanvas-standalone";
const UNICANVAS_STANDALONE_BODY_CLASS = "vnccs-unicanvas-standalone-mode";
const UNICANVAS_PANELS_HIDDEN_CLASS = "vnccs-uc2-panels-hidden";
const UNICANVAS_MODE_STYLE_ID = "vnccs-unicanvas-modes-styles";

const BRUSH_SIZE_MIN = 1;
const BRUSH_SIZE_MAX = 220;
const BRUSH_SIZE_STEP = 4;

// The UniCanvas shortcut map, active whenever the canvas has focus (fullscreen or not).
export const TOOL_SHORTCUTS = Object.freeze({
  b: "brush",
  v: "move",
  e: "eraser",
  m: "mask",
  l: "lasso",
  s: "rect",
});

const FULLSCREEN_ICON_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/></svg>';
const TRUE_FULLSCREEN_ICON_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M13 7h4a2 2 0 0 1 2 2v4"/><path d="M11 17H7a2 2 0 0 1-2-2v-4"/></svg>';

const UNICANVAS_MODE_STYLES = `
.vnccs-uc-stage-wrap { position: relative; }
.vnccs-uc2-fullscreen-btn { position: absolute; top: 10px; right: 10px; z-index: 6; }
.vnccs-uc2-fullscreen-portal { position: fixed; inset: 0; z-index: 2147482000; display: flex; flex-direction: column; background: #0e0b12; }
.vnccs-uc2-fullscreen-portal > .vnccs-unicanvas { flex: 1 1 auto; min-height: 0; min-width: 0; }
.vnccs-uc2-fullscreen-chrome { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #171320; color: #e8e8f0; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
.vnccs-uc2-fullscreen-title { flex: 1 1 auto; font: 700 13px/1.2 inherit; letter-spacing: 0.04em; text-transform: uppercase; }
.vnccs-uc2-true-fullscreen, .vnccs-uc2-fullscreen-exit { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--uc-border, rgba(255, 255, 255, 0.14)); border-radius: 8px; background: var(--uc-surface, rgba(255, 255, 255, 0.045)); color: inherit; cursor: pointer; font: inherit; }
.vnccs-uc2-true-fullscreen svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.vnccs-uc2-true-fullscreen.active { border-color: rgba(255, 143, 163, 0.7); background: rgba(255, 143, 163, 0.18); color: #ffdce5; }
.vnccs-uc2-fullscreen-exit { font-size: 15px; font-weight: 800; }
.vnccs-uc2-true-fullscreen:hover, .vnccs-uc2-fullscreen-exit:hover { background: var(--uc-hover, rgba(255, 255, 255, 0.1)); }
.vnccs-uc2-output-actions { display: flex; gap: 6px; padding: 8px 8px 0; }
.vnccs-uc2-output-actions .vnccs-uc-btn { flex: 1 1 auto; }
.${UNICANVAS_PANELS_HIDDEN_CLASS} .vnccs-uc-left, .${UNICANVAS_PANELS_HIDDEN_CLASS} .vnccs-uc-side { display: none !important; }
`;

export function ensureUniCanvasModeStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(UNICANVAS_MODE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = UNICANVAS_MODE_STYLE_ID;
  style.textContent = UNICANVAS_MODE_STYLES;
  document.head.appendChild(style);
}

export function isUniCanvasTextTarget(event) {
  const target = event?.target;
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

export function setUniCanvasBrushSize(widget, value) {
  const size = Math.max(BRUSH_SIZE_MIN, Math.min(BRUSH_SIZE_MAX, Math.round(Number(value) || BRUSH_SIZE_MIN)));
  if (size === widget.brushSize) return;
  widget.brushSize = size;
  // The slider stays in sync on every step (repo realtime rule).
  for (const input of widget.toolSettings?.querySelectorAll('[data-control="brushSize"]') || []) {
    input.value = String(size);
  }
  widget.updateToolPreviewOverlay?.();
  widget.updateHud?.();
  widget.requestRender?.();
}

export function toggleUniCanvasPanels(widget) {
  widget.container.classList.toggle(UNICANVAS_PANELS_HIDDEN_CLASS);
  widget.resize?.();
  widget.requestRender?.();
}

export function handleUniCanvasShortcut(widget, event) {
  if (!widget || !event || isUniCanvasTextTarget(event)) return false;
  const key = String(event.key || "");
  const lower = key.toLowerCase();
  const modifier = event.ctrlKey || event.metaKey;
  // History: Ctrl+Z / Ctrl+Shift+Z.
  if (modifier && !event.altKey && lower === "z") {
    event.preventDefault();
    if (event.shiftKey) widget.redo();
    else widget.undo();
    return true;
  }
  if (modifier || event.altKey) return false;
  // Tools: B brush, V move, E eraser, M mask, L lasso, S rect.
  if (key.length === 1 && Object.prototype.hasOwnProperty.call(TOOL_SHORTCUTS, lower)) {
    event.preventDefault();
    widget.setTool(TOOL_SHORTCUTS[lower]);
    return true;
  }
  // Brush size: [ / ].
  if (key === "[") {
    event.preventDefault();
    setUniCanvasBrushSize(widget, widget.brushSize - BRUSH_SIZE_STEP);
    return true;
  }
  if (key === "]") {
    event.preventDefault();
    setUniCanvasBrushSize(widget, widget.brushSize + BRUSH_SIZE_STEP);
    return true;
  }
  // Tab toggles panel visibility.
  if (key === "Tab") {
    event.preventDefault();
    toggleUniCanvasPanels(widget);
    return true;
  }
  // Esc exits fullscreen.
  if (key === "Escape" && widget._vnccsFullscreen) {
    event.preventDefault();
    exitUniCanvasFullscreen(widget);
    return true;
  }
  return false;
}

function installUniCanvasShortcuts(widget) {
  if (widget.canvas) {
    widget.canvas.tabIndex = 0;
    widget.canvas.setAttribute("aria-label", "UniCanvas stage");
    widget.canvas.addEventListener("pointerdown", () => {
      widget.canvas.focus({ preventScroll: true });
    });
  }
  widget.container.addEventListener("keydown", (event) => {
    handleUniCanvasShortcut(widget, event);
  });
}

function toggleUniCanvasTrueFullscreen(widget) {
  const portal = widget?._vnccsFullscreen?.portal;
  const doc = portal?.ownerDocument || (typeof document === "undefined" ? null : document);
  if (!doc) return;
  if (doc.fullscreenElement) {
    const leaving = doc.exitFullscreen?.();
    leaving?.catch?.(() => {});
    return;
  }
  const request = portal?.requestFullscreen?.();
  request?.catch?.((err) => {
    widget.setStatus(`[VNCCS UniCanvas] Browser fullscreen failed: ${err?.message || err}`, true);
  });
}

function buildUniCanvasFullscreenChrome(widget) {
  const chrome = document.createElement("div");
  chrome.className = "vnccs-uc2-fullscreen-chrome";
  const title = document.createElement("span");
  title.className = "vnccs-uc2-fullscreen-title";
  title.textContent = "Unicanvas";
  const trueFullscreenBtn = document.createElement("button");
  trueFullscreenBtn.type = "button";
  trueFullscreenBtn.className = "vnccs-uc2-true-fullscreen";
  trueFullscreenBtn.title = "Toggle browser fullscreen";
  trueFullscreenBtn.innerHTML = TRUE_FULLSCREEN_ICON_SVG;
  trueFullscreenBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleUniCanvasTrueFullscreen(widget);
  });
  const exitBtn = document.createElement("button");
  exitBtn.type = "button";
  exitBtn.className = "vnccs-uc2-fullscreen-exit";
  exitBtn.title = "Exit fullscreen";
  exitBtn.textContent = "✕";
  exitBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    exitUniCanvasFullscreen(widget);
  });
  chrome.append(title, trueFullscreenBtn, exitBtn);
  return { chrome, trueFullscreenBtn };
}

export function enterUniCanvasFullscreen(widget) {
  if (!widget || widget._vnccsFullscreen) return;
  ensureUniCanvasModeStyles();
  const container = widget.container;
  const restoreParent = container.parentNode;
  const restoreNextSibling = container.nextSibling;
  const portal = document.createElement("div");
  portal.className = "vnccs-uc2-fullscreen-portal";
  const { chrome, trueFullscreenBtn } = buildUniCanvasFullscreenChrome(widget);
  // Same widget instance is re-parented into the fixed portal; no reload.
  portal.append(chrome, container);
  document.body.appendChild(portal);

  // Keyboard isolation for the duration of the fullscreen: window-level
  // capture-phase listeners swallow every key event that is not targeted at
  // input/textarea/select/[contenteditable], so LiteGraph and ComfyUI
  // shortcuts receive nothing. The UniCanvas shortcut map runs first so the
  // canvas keeps its own keys.
  const onKeyDown = (event) => {
    if (isUniCanvasTextTarget(event)) return;
    handleUniCanvasShortcut(widget, event);
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  const onKeyUp = (event) => {
    if (isUniCanvasTextTarget(event)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  const onKeyPress = (event) => {
    if (isUniCanvasTextTarget(event)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("keypress", onKeyPress, true);
  const onFullscreenChange = () => {
    if (!widget._vnccsFullscreen) return;
    trueFullscreenBtn.classList.toggle("active", Boolean(document.fullscreenElement));
  };
  document.addEventListener("fullscreenchange", onFullscreenChange);

  // enableUniCanvasGraphNavigationForwarding stays suspended until exit.
  container._vnccsUniCanvasGraphNavigationSuspended = true;

  widget._vnccsFullscreen = {
    portal,
    chrome,
    trueFullscreenBtn,
    restoreParent,
    restoreNextSibling,
    onKeyDown,
    onKeyUp,
    onKeyPress,
    onFullscreenChange,
  };
  // The ResizeObserver re-lays out; the view fits the new size.
  widget.resize();
  widget.fitView();
  widget.render();
}

export function exitUniCanvasFullscreen(widget) {
  const state = widget?._vnccsFullscreen;
  if (!state) return;
  window.removeEventListener("keydown", state.onKeyDown, true);
  window.removeEventListener("keyup", state.onKeyUp, true);
  window.removeEventListener("keypress", state.onKeyPress, true);
  document.removeEventListener("fullscreenchange", state.onFullscreenChange);
  widget.container._vnccsUniCanvasGraphNavigationSuspended = false;
  if (document.fullscreenElement === state.portal) {
    const leaving = document.exitFullscreen?.();
    leaving?.catch?.(() => {});
  }
  state.portal.remove();
  if (state.restoreParent) {
    state.restoreParent.insertBefore(widget.container, state.restoreNextSibling || null);
  }
  widget._vnccsFullscreen = null;
  widget.resize();
  widget.render();
}

function installUniCanvasFullscreenButton(widget) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "vnccs-uc-icon vnccs-uc2-fullscreen-btn";
  btn.title = "Fullscreen";
  btn.setAttribute("aria-label", "Fullscreen");
  btn.innerHTML = FULLSCREEN_ICON_SVG;
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    enterUniCanvasFullscreen(widget);
  });
  widget.stageWrap.appendChild(btn);
  widget._vnccsFullscreenButton = btn;
}

export function buildUniCanvasCompositeCanvas(widget) {
  // Flattened composite: every visible raster layer, in stacking order, over the
  // whole canvas. Mask layers stay out of it, matching the node's image output.
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(widget.size.width));
  out.height = Math.max(1, Math.round(widget.size.height));
  const ctx = out.getContext("2d");
  widget.configureImageContext?.(ctx);
  for (const layer of [...widget.layers].reverse()) {
    if (!layer.visible || layer.type !== "raster") continue;
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = layer.blendMode || "source-over";
    ctx.drawImage(layer.canvas, 0, 0);
    ctx.restore();
  }
  return out;
}

export async function saveUniCanvasOutput(widget, layerId = null) {
  try {
    widget.setStatus("Saving to output...");
    const composite = buildUniCanvasCompositeCanvas(widget);
    const payload = { image: composite.toDataURL("image/png") };
    if (layerId) payload.layer_id = String(layerId);
    const res = await fetch("/vnccs/unicanvas/save_output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    widget.setStatus(`[VNCCS UniCanvas] Saved ${data.path}`);
  } catch (err) {
    widget.setStatus(`[VNCCS UniCanvas] Save to output failed: ${err?.message || err}`, true);
  }
}

export async function newUniCanvasDocument(widget) {
  const confirmed = await widget.confirmInWidget("New", "Are you sure?", "Confirm");
  if (!confirmed) return;
  // Clear every layer and image, then create one fresh base layer for new work.
  widget.stagingItems = [];
  widget.activeStagingIndex = -1;
  widget.layers = [];
  widget.activeLayerId = null;
  widget.undoStack = [];
  widget.redoStack = [];
  widget.addLayer("raster", "Base Layer", false);
  widget.updateHistoryButtons?.();
  widget.renderLayerList();
  widget.syncActiveLayerControls?.();
  widget.requestRender();
  widget.syncToNode?.();
  widget.setStatus("[VNCCS UniCanvas] Started a new canvas.");
}

function installUniCanvasOutputActions(widget) {
  const row = document.createElement("div");
  row.className = "vnccs-uc2-output-actions";
  row.append(
    widget._button("Save to output", "vnccs-uc-btn", () => void saveUniCanvasOutput(widget), "Save the flattened composite to the ComfyUI output directory")
  );
  if (widget.standalone) {
    // Standalone mode replaces the node's image socket with Save to output + New.
    row.append(widget._button("New", "vnccs-uc-btn", () => void newUniCanvasDocument(widget), "New canvas"));
  }
  widget.left.insertBefore(row, widget.left.firstChild);
  widget._vnccsOutputActions = row;
}

export function installUniCanvasWidgetModes(widget) {
  if (!widget || widget._vnccsModesInstalled) return widget;
  widget._vnccsModesInstalled = true;
  ensureUniCanvasModeStyles();
  installUniCanvasShortcuts(widget);
  installUniCanvasFullscreenButton(widget);
  installUniCanvasOutputActions(widget);
  return widget;
}
