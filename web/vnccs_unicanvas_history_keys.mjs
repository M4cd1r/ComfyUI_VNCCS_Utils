/**
 * VNCCS UniCanvas - key routing for the keyboard isolation.
 *
 * vnccs_unicanvas_modes.mjs registers ONE set of window capture-phase key listeners (keydown,
 * keyup, keypress) at import. They run before ComfyUI's keybindings, LiteGraph and the change
 * tracker's own undo; this module holds the pure decisions they take, so they run in `node --test`:
 *
 * - Node mode: only Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y are claimed, and only while the
 *   widget owns them (pointer over it, last pointerdown inside it, or its canvas focused). Every
 *   other key stays with ComfyUI and the focused inline canvas map.
 * - Fullscreen and the open standalone tab: every key is claimed; ComfyUI keybindings never fire.
 *   A key aimed at UniCanvas's own controls travels on to them (modals, renames, custom selects,
 *   the panorama sphere, the timeline dock) and the widget container stops it on its way out; a
 *   key aimed at a ComfyUI dialog opened above the tab stays with that dialog.
 * - A focused text field keeps its native editing and undo in every case.
 *
 * No import-time side effects and no ComfyUI app import.
 */

const TEXT_TARGET_SELECTOR = "input, textarea, select, [contenteditable]";
const MODAL_SELECTOR = ".vnccs-uc-modal-overlay";
/** ComfyUI's own dialogs, lifted above the fullscreen portal and the standalone shell. */
export const COMFY_DIALOG_SELECTOR = ".p-dialog-mask, .p-dialog, .comfy-modal, [role=\"dialog\"], [role=\"alertdialog\"]";

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

/**
 * What the capture does with a key event while `widget` owns the keyboard route:
 * - "pass": not claimed (node mode and not a history key, or a key for a ComfyUI dialog);
 * - "widget": fullscreen/standalone key aimed inside the widget: it reaches UniCanvas's own
 *   controls and the widget container stops it before ComfyUI;
 * - "native": a history key in a text field, or any key in a text field outside the widget:
 *   native editing and undo run, propagation stops;
 * - "shortcut": the capture runs the UniCanvas shortcut map (history included) and swallows it.
 * `fullKeyboard` is true in fullscreen and the open standalone tab; `insideWidget` whether the
 * target sits in the widget container.
 */
export function routeUniCanvasCapturedKey(event, { fullKeyboard = false, insideWidget = false } = {}) {
  const history = Boolean(uniCanvasHistoryKeyAction(event));
  if (!fullKeyboard && !history) return "pass";
  if (!history && insideWidget) return "widget";
  if (!history && event?.target?.closest?.(COMFY_DIALOG_SELECTOR)) return "pass";
  if (isUniCanvasTextTarget(event)) return "native";
  return "shortcut";
}
