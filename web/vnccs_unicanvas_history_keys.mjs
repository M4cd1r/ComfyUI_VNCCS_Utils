/**
 * VNCCS UniCanvas - undo / redo key capture.
 *
 * While UniCanvas owns the screen (the node in fullscreen, or the standalone tab while it is
 * open) Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z (Cmd on macOS) act only on the UniCanvas history and never
 * reach ComfyUI's own undo / redo. A window capture-phase listener sees the keys before any
 * ComfyUI or LiteGraph handler and stops them there:
 * - in a text field the browser's native text undo still runs (only propagation stops);
 * - with a widget modal open the keys are swallowed without touching the history;
 * - anywhere else they run `widget.undo()` / `widget.redo()` (pose edits and the timeline dock
 *   share that history).
 * Outside those surfaces the capture is not installed and ComfyUI keeps its normal keys; the
 * focused inline canvas keeps its own local shortcut map (vnccs_unicanvas_modes.mjs).
 *
 * No import-time side effects and no ComfyUI app import, so it runs in `node --test`.
 */

const TEXT_TARGET_SELECTOR = "input, textarea, select, [contenteditable]";
const MODAL_SELECTOR = ".vnccs-uc-modal-overlay";

export function isUniCanvasTextTarget(event) {
  const target = event?.target;
  return Boolean(target?.closest?.(TEXT_TARGET_SELECTOR));
}

export function isUniCanvasModalOpen(widget) {
  // The widget's confirm/prompt modal owns Enter and Escape while it is open.
  return Boolean(widget?.container?.querySelector(MODAL_SELECTOR));
}

function historyLetter(event) {
  const key = String(event.key || "").toLowerCase();
  if (/^[a-z]$/.test(key)) return key;
  // Non-Latin layouts report another character; the physical key still counts.
  const code = /^Key([A-Z])$/.exec(String(event.code || ""));
  return code ? code[1].toLowerCase() : "";
}

/** "undo", "redo" or null for a keydown: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y. */
export function uniCanvasHistoryKeyAction(event) {
  if (!event || !(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const letter = historyLetter(event);
  if (letter === "z") return event.shiftKey ? "redo" : "undo";
  if (letter === "y") return "redo";
  return null;
}

/** Whether UniCanvas owns the history keys: the node in fullscreen or the open standalone tab. */
export function isUniCanvasKeyboardOwner(widget) {
  return Boolean(widget && !widget._disposed && (widget._vnccsFullscreen || widget._vnccsStandaloneActive));
}

/**
 * What the capture does with a keydown: "pass" (not a history key, ComfyUI may have it),
 * "native" (text field: native text undo, ComfyUI does not see it), "blocked" (a widget modal
 * is open) or the history action "undo" / "redo".
 */
export function routeUniCanvasHistoryKey(widget, event) {
  const action = uniCanvasHistoryKeyAction(event);
  if (!action || !isUniCanvasKeyboardOwner(widget)) return "pass";
  if (isUniCanvasTextTarget(event)) return "native";
  if (isUniCanvasModalOpen(widget)) return "blocked";
  return action;
}

/** Runs a keydown through the capture; returns the route taken. */
export function handleUniCanvasHistoryKey(widget, event) {
  const route = routeUniCanvasHistoryKey(widget, event);
  if (route === "pass") return route;
  // Stop every later listener (ComfyUI's keybindings and change tracker, LiteGraph, the
  // fullscreen shield) so the key acts exactly once.
  event.stopImmediatePropagation?.();
  if (route === "native") return route;
  event.preventDefault?.();
  if (route === "undo") widget.undo?.();
  else if (route === "redo") widget.redo?.();
  return route;
}

/**
 * Installs or removes the capture to match `isUniCanvasKeyboardOwner(widget)`. Idempotent; call
 * it after entering / leaving fullscreen or the standalone tab and on teardown.
 */
export function syncUniCanvasHistoryKeyCapture(widget, target = typeof window === "undefined" ? null : window) {
  if (!widget) return false;
  const installed = widget._vnccsHistoryKeyCapture;
  if (isUniCanvasKeyboardOwner(widget)) {
    if (installed || !target?.addEventListener) return Boolean(installed);
    const onKeyDown = (event) => {
      handleUniCanvasHistoryKey(widget, event);
    };
    target.addEventListener("keydown", onKeyDown, true);
    widget._vnccsHistoryKeyCapture = { target, onKeyDown };
    return true;
  }
  if (installed) {
    installed.target.removeEventListener("keydown", installed.onKeyDown, true);
    widget._vnccsHistoryKeyCapture = null;
  }
  return false;
}
