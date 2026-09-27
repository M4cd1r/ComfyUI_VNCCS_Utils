import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  COMFY_DIALOG_SELECTOR,
  isUniCanvasModalOpen,
  routeUniCanvasCapturedKey,
  uniCanvasHistoryKeyAction,
} from "../web/vnccs_unicanvas_history_keys.mjs";

const modesSource = await readFile(new URL("../web/vnccs_unicanvas_modes.mjs", import.meta.url), "utf8");

const plainTarget = { closest: () => null };
const textTarget = { closest: (selector) => (selector.includes("textarea") ? {} : null) };

function keyEvent(init = {}) {
  const event = {
    key: "z", code: "KeyZ", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: plainTarget,
    stopped: false, immediate: false, prevented: false,
    stopPropagation() { this.stopped = true; },
    stopImmediatePropagation() { this.immediate = true; this.stopped = true; },
    preventDefault() { this.prevented = true; },
    ...init,
  };
  return event;
}

const dialogTarget = { closest: (selector) => (selector === COMFY_DIALOG_SELECTOR ? {} : null) };

function fakeWidget(state = {}) {
  return { container: { querySelector: () => (state.modal ? {} : null) }, ...state };
}

test("Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo", () => {
  assert.equal(uniCanvasHistoryKeyAction(keyEvent({ ctrlKey: true })), "undo");
  assert.equal(uniCanvasHistoryKeyAction(keyEvent({ metaKey: true })), "undo", "Cmd on macOS");
  assert.equal(uniCanvasHistoryKeyAction(keyEvent({ ctrlKey: true, shiftKey: true, key: "Z" })), "redo");
  assert.equal(uniCanvasHistoryKeyAction(keyEvent({ metaKey: true, shiftKey: true, key: "Z" })), "redo");
  assert.equal(uniCanvasHistoryKeyAction(keyEvent({ ctrlKey: true, key: "y", code: "KeyY" })), "redo");
  assert.equal(uniCanvasHistoryKeyAction(keyEvent({ metaKey: true, key: "y", code: "KeyY" })), "redo");
  // A non-Latin layout still maps the physical Z key.
  assert.equal(uniCanvasHistoryKeyAction(keyEvent({ ctrlKey: true, key: "я", code: "KeyZ" })), "undo");
  assert.equal(uniCanvasHistoryKeyAction(keyEvent({})), null, "plain Z is a tool key, not history");
  assert.equal(uniCanvasHistoryKeyAction(keyEvent({ ctrlKey: true, altKey: true })), null, "Ctrl+Alt+Z is not history");
  assert.equal(uniCanvasHistoryKeyAction(keyEvent({ ctrlKey: true, key: "c", code: "KeyC" })), null);
  assert.equal(uniCanvasHistoryKeyAction(null), null);
});

test("node mode claims only the history keys; everything else stays with ComfyUI", () => {
  const node = { fullKeyboard: false, insideWidget: false };
  assert.equal(routeUniCanvasCapturedKey(keyEvent({ ctrlKey: true }), node), "shortcut", "Ctrl+Z runs the UniCanvas history");
  assert.equal(routeUniCanvasCapturedKey(keyEvent({ ctrlKey: true, key: "y", code: "KeyY" }), { ...node, insideWidget: true }), "shortcut");
  assert.equal(routeUniCanvasCapturedKey(keyEvent({ key: "b", code: "KeyB" }), node), "pass", "tool keys are not claimed");
  assert.equal(routeUniCanvasCapturedKey(keyEvent({ key: "b", code: "KeyB" }), { ...node, insideWidget: true }), "pass",
    "the inline canvas map (container listener) keeps the tool keys");
  assert.equal(routeUniCanvasCapturedKey(keyEvent({ ctrlKey: true, key: "s", code: "KeyS" }), node), "pass", "Ctrl+S stays with ComfyUI");
  assert.equal(routeUniCanvasCapturedKey(keyEvent({ ctrlKey: true, target: textTarget }), node), "native",
    "a text field keeps its native undo and ComfyUI does not see it");
});

test("fullscreen / standalone claim every key and hand in-widget keys to UniCanvas's own controls", () => {
  const outside = { fullKeyboard: true, insideWidget: false };
  const inside = { fullKeyboard: true, insideWidget: true };
  assert.equal(routeUniCanvasCapturedKey(keyEvent({ key: "b", code: "KeyB" }), outside), "shortcut",
    "a key with no UniCanvas target is swallowed after the shortcut map");
  assert.equal(routeUniCanvasCapturedKey(keyEvent({ ctrlKey: true, key: "s", code: "KeyS" }), outside), "shortcut",
    "ComfyUI keybinds never fire");
  assert.equal(routeUniCanvasCapturedKey(keyEvent({ key: "Enter", code: "Enter" }), inside), "widget",
    "modals, renames, selects and the panorama sphere receive their keys");
  assert.equal(routeUniCanvasCapturedKey(keyEvent({ key: "a", code: "KeyA", target: textTarget }), inside), "widget",
    "typing in a UniCanvas field reaches its own listeners");
  assert.equal(routeUniCanvasCapturedKey(keyEvent({ ctrlKey: true }), inside), "shortcut",
    "history keys run the UniCanvas history once, from any focus inside the widget");
  assert.equal(routeUniCanvasCapturedKey(keyEvent({ ctrlKey: true, target: textTarget }), inside), "native",
    "Ctrl+Z in a text field is the browser's text undo");
  assert.equal(routeUniCanvasCapturedKey(keyEvent({ key: "Escape", code: "Escape", target: dialogTarget }), outside), "pass",
    "a ComfyUI dialog opened above the tab keeps its keys");
  assert.equal(routeUniCanvasCapturedKey(keyEvent({ ctrlKey: true, target: dialogTarget }), outside), "shortcut",
    "even over a ComfyUI dialog Ctrl+Z never reaches the graph undo");
  assert.equal(routeUniCanvasCapturedKey(keyEvent({ key: "x", code: "KeyX", target: textTarget }), outside), "native");
});

test("an open widget modal is detected for the shortcut map", () => {
  assert.equal(isUniCanvasModalOpen(fakeWidget({ modal: true })), true);
  assert.equal(isUniCanvasModalOpen(fakeWidget()), false);
  assert.equal(isUniCanvasModalOpen(null), false);
});

test("one capture owns the keys: no per-surface history listener remains", () => {
  const count = (needle) => modesSource.split(needle).length - 1;
  assert.equal(count('window.addEventListener("keydown"'), 1, "a single Ctrl+Z is handled by exactly one listener");
  assert.ok(!modesSource.includes("syncUniCanvasHistoryKeyCapture"), "the former fullscreen/standalone capture is folded in");
  assert.ok(modesSource.includes("routeUniCanvasCapturedKey(event, {"), "the capture routes through the shared decision");
  const keydown = modesSource.slice(modesSource.indexOf("function handleUniCanvasHistoryKeyDown"), modesSource.indexOf("function handleUniCanvasHistoryKeyUp"));
  assert.ok(keydown.indexOf('if (route === "pass") return;') < keydown.indexOf("uniCanvasHistoryLastClaimAt = Date.now()"),
    "only claimed keys open the Comfy.Undo / ChangeTracker claim window");
});
