import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8");
const source = read("vnccs_unicanvas.js");
const warnings = [];
const prototype = vm.runInNewContext(
  source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype",
  { console: { warn: (...args) => warnings.push(args) } },
);

function widget() {
  return Object.assign(Object.create(prototype), {
    _disposed: false, _disposers: [], poseEditor: null,
    flushStateUpload() {}, stopDrawProgressPolling() {},
  });
}

test("onDispose cleanups run once on dispose, last registered first, and a failing one does not stop the rest", () => {
  const w = widget();
  const order = [];
  w.onDispose(() => order.push("first"));
  w.onDispose(() => { throw new Error("broken"); });
  w.onDispose(() => order.push("last"));
  w.onDispose(null);
  // dispose() also tears down the modes and other widget state; only the cleanup drain is checked.
  try { w.dispose(); } catch (_) { /* teardown helpers are not in this VM context */ }
  assert.deepEqual(order, ["last", "first"]);
  assert.equal(warnings.length, 1);
  assert.equal(w._disposers.length, 0);
  w.onDispose(() => order.push("late"));
  assert.deepEqual(order, ["last", "first", "late"], "a cleanup registered after disposal runs at once");
});

test("feature menus and popovers tie their document listeners to an AbortController and close on dispose", () => {
  const project = read("vnccs_unicanvas_project.mjs");
  assert.match(project, /widget\.onDispose\?\.\(\(\) => closeSceneMenu\(widget\)\)/);
  assert.match(project, /\{ capture: true, signal: abort\.signal \}/);
  assert.doesNotMatch(project, /_vnccsSceneMenuOutside/);
  const preview = read("vnccs_unicanvas_vn_preview.mjs");
  assert.match(preview, /uc\.onDispose\?\.\(\(\) => controller\.closePopover\(\)\)/);
  assert.match(preview, /\{ capture: true, signal: this\.popoverAbort\.signal \}/);
  assert.match(preview, /closePopover\(\) \{[\s\S]*?this\.popoverAbort\?\.abort\(\);/);
  const timeline = read("vnccs_unicanvas_timeline.mjs");
  assert.match(timeline, /closeMenu\(\) \{[\s\S]*?this\.menuAbort\?\.abort\(\);/);
  assert.match(timeline, /\{ capture: true, signal: this\.menuAbort\.signal \}/);
  assert.doesNotMatch(timeline, /removeEventListener\("pointerdown", dismiss/);
  assert.match(read("vnccs_unicanvas_bake.mjs"), /uc\.onDispose\?\.\(\(\) => \{\n    if \(labelTimer\) clearTimeout\(labelTimer\);/);
});
