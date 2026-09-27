import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  handleUniCanvasHistoryKey,
  isUniCanvasKeyboardOwner,
  routeUniCanvasHistoryKey,
  syncUniCanvasHistoryKeyCapture,
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

function fakeWidget(state = {}) {
  const calls = [];
  return {
    calls,
    container: { querySelector: () => (state.modal ? {} : null) },
    undo() { calls.push("undo"); },
    redo() { calls.push("redo"); },
    ...state,
  };
}

function fakeWindow() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture }); },
    removeEventListener(type, fn, capture) {
      const index = listeners.findIndex((item) => item.type === type && item.fn === fn && item.capture === capture);
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatch(event) { for (const item of [...listeners]) if (item.type === "keydown") item.fn(event); },
  };
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

test("UniCanvas owns the keys only in fullscreen or in the open standalone tab", () => {
  assert.equal(isUniCanvasKeyboardOwner(fakeWidget()), false, "inline node: ComfyUI keeps its undo");
  assert.equal(isUniCanvasKeyboardOwner(fakeWidget({ _vnccsFullscreen: {} })), true);
  assert.equal(isUniCanvasKeyboardOwner(fakeWidget({ _vnccsStandaloneActive: true })), true);
  assert.equal(isUniCanvasKeyboardOwner(fakeWidget({ _vnccsStandaloneActive: false })), false, "hidden tab");
  assert.equal(isUniCanvasKeyboardOwner(fakeWidget({ _vnccsFullscreen: {}, _disposed: true })), false);
  assert.equal(isUniCanvasKeyboardOwner(null), false);
});

test("routing: pass outside, native in text fields, blocked under a modal, else history", () => {
  const owner = fakeWidget({ _vnccsFullscreen: {} });
  assert.equal(routeUniCanvasHistoryKey(fakeWidget(), keyEvent({ ctrlKey: true })), "pass");
  assert.equal(routeUniCanvasHistoryKey(owner, keyEvent({ key: "b", code: "KeyB", ctrlKey: true })), "pass");
  assert.equal(routeUniCanvasHistoryKey(owner, keyEvent({ ctrlKey: true, target: textTarget })), "native");
  assert.equal(routeUniCanvasHistoryKey(fakeWidget({ _vnccsFullscreen: {}, modal: true }), keyEvent({ ctrlKey: true })), "blocked");
  assert.equal(routeUniCanvasHistoryKey(owner, keyEvent({ ctrlKey: true })), "undo");
  assert.equal(routeUniCanvasHistoryKey(owner, keyEvent({ ctrlKey: true, key: "y", code: "KeyY" })), "redo");
});

test("an owned history key runs the UniCanvas history once and never reaches ComfyUI", () => {
  const widget = fakeWidget({ _vnccsStandaloneActive: true });
  const undo = keyEvent({ ctrlKey: true });
  assert.equal(handleUniCanvasHistoryKey(widget, undo), "undo");
  assert.ok(undo.immediate && undo.prevented);
  const redo = keyEvent({ metaKey: true, shiftKey: true, key: "Z" });
  handleUniCanvasHistoryKey(widget, redo);
  assert.deepEqual(widget.calls, ["undo", "redo"]);

  // Text fields keep the browser's text undo: propagation stops, the default runs.
  const text = keyEvent({ ctrlKey: true, target: textTarget });
  assert.equal(handleUniCanvasHistoryKey(widget, text), "native");
  assert.ok(text.immediate, "ComfyUI does not see it");
  assert.equal(text.prevented, false, "native text undo still runs");
  assert.deepEqual(widget.calls, ["undo", "redo"], "the canvas history is untouched");

  // A modal swallows the key without editing the history.
  const modalWidget = fakeWidget({ _vnccsFullscreen: {}, modal: true });
  const blocked = keyEvent({ ctrlKey: true });
  handleUniCanvasHistoryKey(modalWidget, blocked);
  assert.ok(blocked.immediate && blocked.prevented);
  assert.deepEqual(modalWidget.calls, []);
});

test("outside fullscreen and standalone the event is left alone for ComfyUI", () => {
  const widget = fakeWidget();
  const event = keyEvent({ ctrlKey: true });
  assert.equal(handleUniCanvasHistoryKey(widget, event), "pass");
  assert.equal(event.stopped, false);
  assert.equal(event.prevented, false);
  assert.deepEqual(widget.calls, []);
});

test("the capture is a window capture-phase listener that follows ownership and is removed", () => {
  const win = fakeWindow();
  const widget = fakeWidget();
  assert.equal(syncUniCanvasHistoryKeyCapture(widget, win), false);
  assert.equal(win.listeners.length, 0, "inline node: nothing installed");

  widget._vnccsFullscreen = {};
  assert.equal(syncUniCanvasHistoryKeyCapture(widget, win), true);
  assert.equal(syncUniCanvasHistoryKeyCapture(widget, win), true);
  assert.equal(win.listeners.length, 1, "idempotent");
  assert.deepEqual([win.listeners[0].type, win.listeners[0].capture], ["keydown", true]);
  const event = keyEvent({ ctrlKey: true });
  win.dispatch(event);
  assert.deepEqual(widget.calls, ["undo"]);
  assert.ok(event.immediate);

  // Leaving fullscreen removes it.
  widget._vnccsFullscreen = null;
  syncUniCanvasHistoryKeyCapture(widget, win);
  assert.equal(win.listeners.length, 0);
  assert.equal(widget._vnccsHistoryKeyCapture, null);

  // Standalone tab: installed while open, removed when the widget is disposed.
  widget._vnccsStandaloneActive = true;
  syncUniCanvasHistoryKeyCapture(widget, win);
  assert.equal(win.listeners.length, 1);
  widget._disposed = true;
  syncUniCanvasHistoryKeyCapture(widget, win);
  assert.equal(win.listeners.length, 0, "widget removal takes the listener away");
});

test("fullscreen, the standalone tab and teardown keep the capture in sync", () => {
  const between = (start, end) => {
    const from = modesSource.indexOf(start);
    assert.ok(from >= 0, start);
    return modesSource.slice(from, modesSource.indexOf(end, from + start.length));
  };
  const enter = between("export function enterUniCanvasFullscreen", "export function exitUniCanvasFullscreen");
  const exit = between("export function exitUniCanvasFullscreen", "function writeStandaloneState");
  const teardown = between("export function teardownUniCanvasWidgetModes", "function readStandalonePersistedStateValue");
  const tab = between("const syncStandaloneChrome = () => {", "const setActive");
  assert.match(enter, /syncUniCanvasHistoryKeyCapture\(widget\)/);
  assert.match(exit, /widget\._vnccsFullscreen = null;\s*syncUniCanvasHistoryKeyCapture\(widget\)/);
  assert.match(teardown, /widget\._vnccsStandaloneActive = false;\s*syncUniCanvasHistoryKeyCapture\(widget\)/);
  assert.match(tab, /widget\._vnccsStandaloneActive = active;/);
  assert.match(tab, /syncUniCanvasHistoryKeyCapture\(widget\)/);
  // The fullscreen key shield leaves undo / redo to the capture, whatever has focus.
  const onKeyDown = enter.match(/const onKeyDown = \(event\) => \{[\s\S]*?\};/)[0];
  assert.ok(onKeyDown.indexOf("uniCanvasHistoryKeyAction(event)") < onKeyDown.indexOf("handleUniCanvasShortcut"));
});
