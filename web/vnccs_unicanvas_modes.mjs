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
const UNICANVAS_SIDEBAR_ICON_CLASS = "vnccs-unicanvas-sidebar-icon";
const UNICANVAS_MODE_STYLE_ID = "vnccs-unicanvas-modes-styles";

// Inline SVG data URI behind the sidebar icon class: the ComfyUI sidebar tab
// strip renders the icon value as a CSS class on an <i> element, so painting the
// SVG from CSS guarantees a visible icon regardless of the icon font.
const UNICANVAS_SIDEBAR_ICON_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23e8e8f0' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='18' height='18' rx='2'/%3E%3Cpath d='M3 16l5-5 3.5 3.5 3-3L21 18'/%3E%3Ccircle cx='8.5' cy='8' r='1.4'/%3E%3C/svg%3E";

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
i.${UNICANVAS_SIDEBAR_ICON_CLASS} { display: inline-block; width: 1.35em; height: 1.35em; background: url("${UNICANVAS_SIDEBAR_ICON_SVG}") center / contain no-repeat; }
.vnccs-uc2-standalone-shell { position: fixed; top: 0; bottom: 0; display: flex; z-index: 2147481000; background: #0e0b12; }
.vnccs-uc2-standalone-shell > .vnccs-unicanvas { flex: 1 1 auto; width: 100%; min-width: 0; min-height: 0; }
.vnccs-uc2-config-hint { margin: 2px 8px 0; padding: 6px 8px; border: 1px dashed rgba(255, 143, 163, 0.35); border-radius: 8px; color: #f3c9d2; font-size: 12px; line-height: 1.3; }
body.${UNICANVAS_STANDALONE_BODY_CLASS} #comfyui-body-top,
body.${UNICANVAS_STANDALONE_BODY_CLASS} .comfyui-body-top,
body.${UNICANVAS_STANDALONE_BODY_CLASS} #comfy-menu,
body.${UNICANVAS_STANDALONE_BODY_CLASS} .comfyui-menu,
body.${UNICANVAS_STANDALONE_BODY_CLASS} #comfyui-body-bottom,
body.${UNICANVAS_STANDALONE_BODY_CLASS} .comfyui-body-bottom { display: none !important; }
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
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable]"));
}

export function isUniCanvasModalOpen(widget) {
  // The widget's confirm/prompt modal owns Enter and Escape while it is open.
  return Boolean(widget?.container?.querySelector(".vnccs-uc-modal-overlay"));
}

function isUniCanvasCanvasFocused(widget, event) {
  const target = event?.target;
  return Boolean(target && widget?.canvas && (target === widget.canvas || widget.canvas.contains(target)));
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

function consumeUniCanvasShortcut(event) {
  // The canvas owns the key while it has focus, so the graph's global shortcuts
  // must not also run for it.
  event.preventDefault();
  event.stopPropagation();
}

export function handleUniCanvasShortcut(widget, event) {
  if (!widget || !event || isUniCanvasTextTarget(event)) return false;
  // An open modal owns the keyboard: Enter activates its confirm button and
  // Escape closes the modal instead of leaving fullscreen or switching tools.
  if (isUniCanvasModalOpen(widget)) return false;
  const key = String(event.key || "");
  // Esc exits fullscreen from anywhere inside the fullscreen (chrome behavior).
  if (key === "Escape" && widget._vnccsFullscreen) {
    consumeUniCanvasShortcut(event);
    exitUniCanvasFullscreen(widget);
    return true;
  }
  // The rest of the shortcut map is active only while the canvas has focus
  // (spec 5), fullscreen or not.
  if (!isUniCanvasCanvasFocused(widget, event)) return false;
  const lower = key.toLowerCase();
  const modifier = event.ctrlKey || event.metaKey;
  // History: Ctrl+Z / Ctrl+Shift+Z.
  if (modifier && !event.altKey && lower === "z") {
    consumeUniCanvasShortcut(event);
    if (event.shiftKey) widget.redo();
    else widget.undo();
    return true;
  }
  if (modifier || event.altKey) return false;
  // Tools: B brush, V move, E eraser, M mask, L lasso, S rect.
  if (key.length === 1 && Object.prototype.hasOwnProperty.call(TOOL_SHORTCUTS, lower)) {
    consumeUniCanvasShortcut(event);
    widget.setTool(TOOL_SHORTCUTS[lower]);
    return true;
  }
  // Brush size: [ / ].
  if (key === "[") {
    consumeUniCanvasShortcut(event);
    setUniCanvasBrushSize(widget, widget.brushSize - BRUSH_SIZE_STEP);
    return true;
  }
  if (key === "]") {
    consumeUniCanvasShortcut(event);
    setUniCanvasBrushSize(widget, widget.brushSize + BRUSH_SIZE_STEP);
    return true;
  }
  // Tab toggles panel visibility.
  if (key === "Tab") {
    consumeUniCanvasShortcut(event);
    toggleUniCanvasPanels(widget);
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
  // shortcuts receive nothing. An open widget modal keeps its own Enter and
  // Escape contract, and the UniCanvas shortcut map runs first so the canvas
  // keeps its own keys.
  const modalOwnsKey = (event) => isUniCanvasModalOpen(widget) && (event.key === "Enter" || event.key === "Escape");
  const onKeyDown = (event) => {
    if (isUniCanvasTextTarget(event)) return;
    if (modalOwnsKey(event)) return;
    handleUniCanvasShortcut(widget, event);
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  const onKeyUp = (event) => {
    if (isUniCanvasTextTarget(event)) return;
    if (modalOwnsKey(event)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  const onKeyPress = (event) => {
    if (isUniCanvasTextTarget(event)) return;
    if (modalOwnsKey(event)) return;
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
    // Re-insert only when the saved anchor still sits in the saved parent; a
    // re-laid-out DOM widget area leaves a stale sibling reference behind.
    const sibling = state.restoreNextSibling;
    if (sibling && sibling.parentNode === state.restoreParent) {
      state.restoreParent.insertBefore(widget.container, sibling);
    } else {
      state.restoreParent.appendChild(widget.container);
    }
  }
  widget._vnccsFullscreen = null;
  if (!widget._disposed) {
    widget.resize();
    widget.render();
  }
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
  // Flattened composite = exactly what flattenLayersToMaster draws: the shared
  // per-layer semantics of widget.drawFlattenedLayers (hi-res layers included),
  // over the whole canvas. Mask layers stay out of it, matching the node's image
  // socket output.
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(widget.size.width));
  out.height = Math.max(1, Math.round(widget.size.height));
  const ctx = widget.configureImageContext(out.getContext("2d"), false);
  widget.drawFlattenedLayers(ctx);
  return out;
}

export async function saveUniCanvasOutput(widget, layerId = null) {
  // layerId is the layer-context-menu call shape ("Save layer as image" in the
  // layer context menu of a parallel branch): it saves only that layer's PNG.
  try {
    widget.setStatus("[VNCCS UniCanvas] Saving to output...");
    let payload;
    if (layerId) {
      const layer = widget.layers.find((item) => item.id === String(layerId));
      if (!layer) throw new Error(`[VNCCS UniCanvas] Layer '${layerId}' was not found.`);
      payload = { state: { version: 2, layers: [widget.serializeLayer(layer, true)] }, layer_id: String(layerId) };
    } else {
      payload = { image: buildUniCanvasCompositeCanvas(widget).toDataURL("image/png") };
    }
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
  if (widget.standalone) {
    installStandaloneEngineNote(widget);
    installStandalonePersistence(widget);
  }
  return widget;
}

// ---------------------------------------------------------------------------
// Standalone sidebar mode: "Unicanvas" tab, chrome hiding, local persistence
// ---------------------------------------------------------------------------

function installStandaloneEngineNote(widget) {
  const note = document.createElement("div");
  note.className = "vnccs-uc2-config-hint";
  note.textContent = "External VNCSS_CONFIG is node-mode only.";
  const modelTabs = widget.promptBox?.querySelector(".vnccs-uc-model-tabs");
  if (modelTabs) modelTabs.insertAdjacentElement("afterend", note);
  else widget.promptBox?.appendChild(note);
  widget._vnccsStandaloneEngineNote = note;
}

function writeStandaloneState(widget, state) {
  // Mirrors saveLocalStateBackup's degradation: persistence stops (after one
  // informative message) once localStorage cannot hold the document.
  if (widget.localStateBackupDisabled) return;
  try {
    state.storage = "local";
    const payload = JSON.stringify({ saved_at: Date.now(), state });
    if (payload.length > 4_000_000) {
      widget.localStateBackupDisabled = true;
      if (!widget.localStateBackupWarned) {
        widget.localStateBackupWarned = true;
        console.info("[VNCCS UniCanvas] Local backup skipped: state is too large for browser localStorage; work will not survive a reload.");
      }
      return;
    }
    window.localStorage?.setItem(UNICANVAS_STANDALONE_STORAGE_KEY, payload);
  } catch (err) {
    widget.localStateBackupDisabled = true;
    if (!widget.localStateBackupWarned) {
      widget.localStateBackupWarned = true;
      console.info("[VNCCS UniCanvas] Local backup disabled: browser localStorage quota is not enough; work will not survive a reload.");
    }
  }
}

const standalonePersistState = new WeakMap();

function installStandalonePersistence(widget) {
  // Standalone mode has no workflow widget and no server state cache: the
  // localStorage key "vnccs-unicanvas-standalone" holds the document instead.
  const entry = { timer: null };
  standalonePersistState.set(widget, entry);
  const schedulePersist = () => {
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    entry.timer = window.setTimeout(() => {
      entry.timer = null;
      writeStandaloneState(widget, widget.buildSerializedState(true));
    }, 300);
  };
  widget.getStateBackupKey = () => UNICANVAS_STANDALONE_STORAGE_KEY;
  widget.uploadStatePayload = async (state) => {
    writeStandaloneState(widget, state);
  };
  const originalWriteLightStateToWidget = widget.writeLightStateToWidget;
  widget.writeLightStateToWidget = (...args) => {
    const result = originalWriteLightStateToWidget.call(widget, ...args);
    schedulePersist();
    return result;
  };
}

export function flushStandalonePersistence(widget) {
  const entry = widget ? standalonePersistState.get(widget) : null;
  if (!entry) return;
  if (entry.timer !== null) {
    window.clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (!widget._disposed) writeStandaloneState(widget, widget.buildSerializedState(true));
}

export function teardownUniCanvasWidgetModes(widget) {
  if (!widget) return;
  // Runs from widget.dispose()/onRemoved and from the standalone tab destroy():
  // leave fullscreen (without touching a disposed widget) and flush/clear the
  // pending standalone persistence timer.
  exitUniCanvasFullscreen(widget);
  flushStandalonePersistence(widget);
}

function readStandalonePersistedStateValue() {
  try {
    const raw = window.localStorage?.getItem(UNICANVAS_STANDALONE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const state = parsed && typeof parsed === "object" ? parsed.state : null;
    if (!state || typeof state !== "object" || !Array.isArray(state.layers)) return "";
    // The widget's own restore pipeline reads this hidden state widget; the
    // storage marker keeps it from reaching for the node-mode server cache.
    state.storage = "local";
    return JSON.stringify(state);
  } catch (err) {
    console.warn("[VNCCS UniCanvas] Standalone state restore failed", err);
    return "";
  }
}

function createStandaloneWidget(UniCanvasWidgetClass) {
  // No node and no workflow: the stub only feeds the existing restore pipeline
  // (hidden unicanvas_state widget) and carries a size hint.
  const stubNode = {
    id: undefined,
    inputs: [],
    size: [1280, 860],
    widgets: [{ name: "unicanvas_state", value: readStandalonePersistedStateValue() }],
  };
  const widget = new UniCanvasWidgetClass(stubNode);
  widget.standalone = true;
  installUniCanvasWidgetModes(widget);
  return widget;
}

function findUniCanvasSidebarRail(doc) {
  return doc.querySelector("nav.side-tool-bar-container") || doc.querySelector(".side-tool-bar-container");
}

function applyUniCanvasStandaloneShellInset(shell, doc) {
  // Entering the standalone tab hides all ComfyUI chrome and keeps only the
  // icon sidebar visible: the app surface stops exactly at the tab strip.
  const rail = findUniCanvasSidebarRail(doc);
  const railRect = rail?.getBoundingClientRect?.();
  shell.style.top = "0";
  shell.style.bottom = "0";
  shell.style.left = "0";
  shell.style.right = "0";
  const viewportWidth = doc.defaultView?.innerWidth || 0;
  if (railRect && railRect.width > 0 && viewportWidth > 0) {
    if (railRect.left + railRect.width / 2 < viewportWidth / 2) {
      shell.style.left = `${Math.ceil(railRect.right)}px`;
    } else {
      shell.style.right = `${Math.ceil(viewportWidth - railRect.left)}px`;
    }
  } else {
    shell.style.left = "56px";
  }
}

function watchUniCanvasStandaloneTab(onChange) {
  const state = { button: null, buttonObserver: null, scanObserver: null, disposed: false };
  const evaluate = () => {
    if (state.disposed || !state.button) return;
    onChange(state.button.classList.contains("side-bar-button-selected"));
  };
  const attach = (button) => {
    state.buttonObserver?.disconnect();
    state.button = button;
    state.buttonObserver = new MutationObserver(evaluate);
    state.buttonObserver.observe(button, { attributes: true, attributeFilter: ["class"] });
    evaluate();
  };
  const scan = () => {
    if (state.disposed) return;
    if (state.button && state.button.isConnected) return;
    const byTestId = document.querySelector(`[data-testid="${UNICANVAS_STANDALONE_TAB_ID}-tab-button"]`);
    const iconEl = byTestId || document.querySelector(`.${UNICANVAS_SIDEBAR_ICON_CLASS}`);
    const button = byTestId || iconEl?.closest?.("button") || null;
    if (button) {
      state.scanObserver?.disconnect();
      state.scanObserver = null;
      attach(button);
    }
  };
  state.scanObserver = new MutationObserver(scan);
  state.scanObserver.observe(document.body, { subtree: true, childList: true });
  scan();
  return {
    dispose() {
      state.disposed = true;
      state.buttonObserver?.disconnect();
      state.scanObserver?.disconnect();
    },
  };
}

export function registerUniCanvasStandaloneSidebarTab(UniCanvasWidgetClass) {
  const registerSidebarTab = app?.extensionManager?.registerSidebarTab;
  if (typeof registerSidebarTab !== "function") return;
  ensureUniCanvasModeStyles();
  let widget = null;
  let shell = null;
  let mountContainer = null;
  let parking = null;
  let tabWatcher = null;
  let containerObserver = null;
  let windowResizeHandler = null;
  let active = false;

  const syncStandaloneChrome = () => {
    if (!widget) return;
    if (active) {
      if (widget._vnccsFullscreen) exitUniCanvasFullscreen(widget);
      if (!shell) {
        shell = document.createElement("div");
        shell.className = "vnccs-uc2-standalone-shell";
        document.body.appendChild(shell);
        windowResizeHandler = () => {
          if (!shell || !widget) return;
          applyUniCanvasStandaloneShellInset(shell, document);
          widget.resize?.();
        };
        window.addEventListener("resize", windowResizeHandler);
      }
      applyUniCanvasStandaloneShellInset(shell, document);
      if (widget.container.parentNode !== shell) shell.appendChild(widget.container);
      document.body.classList.add(UNICANVAS_STANDALONE_BODY_CLASS);
    } else {
      // Leaving the tab restores the standard ComfyUI chrome.
      if (widget._vnccsFullscreen) exitUniCanvasFullscreen(widget);
      document.body.classList.remove(UNICANVAS_STANDALONE_BODY_CLASS);
      if (windowResizeHandler) window.removeEventListener("resize", windowResizeHandler);
      windowResizeHandler = null;
      shell?.remove();
      shell = null;
      if (!parking) parking = document.createDocumentFragment();
      (mountContainer?.isConnected ? mountContainer : parking).appendChild(widget.container);
    }
    widget.resize?.();
    widget.requestRender?.();
  };

  const setActive = (next) => {
    if (active === next) {
      syncStandaloneChrome();
      return;
    }
    active = next;
    syncStandaloneChrome();
  };

  registerSidebarTab({
    id: UNICANVAS_STANDALONE_TAB_ID,
    title: "Unicanvas",
    tooltip: "Unicanvas",
    icon: UNICANVAS_SIDEBAR_ICON_CLASS,
    type: "custom",
    render(container) {
      mountContainer = container;
      if (!widget) widget = createStandaloneWidget(UniCanvasWidgetClass);
      if (!tabWatcher) tabWatcher = watchUniCanvasStandaloneTab(setActive);
      if (!containerObserver && typeof IntersectionObserver === "function") {
        // Belt and braces: hiding/unmounting the tab panel also restores chrome.
        containerObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) setActive(false);
          }
        });
      }
      containerObserver?.observe(container);
      setActive(true);
    },
    destroy() {
      setActive(false);
      tabWatcher?.dispose();
      tabWatcher = null;
      containerObserver?.disconnect();
      containerObserver = null;
      mountContainer = null;
      // Flush and clear the pending persistence timer before disposal.
      teardownUniCanvasWidgetModes(widget);
      widget?.dispose?.();
      widget = null;
    },
  });
}
