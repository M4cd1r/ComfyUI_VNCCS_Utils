import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const prototype = vm.runInNewContext(
  source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype",
  { PANORAMA_VIEW_HISTORY_KIND: "panoramaView", applyPanoramaViewHistory() {} },
);

function widget() {
  const calls = [];
  const w = Object.assign(Object.create(prototype), {
    layers: [], panorama: null, generationHistory: null,
    cancelDeferredCanvasCommit: () => calls.push("cancelDeferred"),
    syncPoseToolToActiveLayer: () => calls.push("syncPoseTool"),
    syncActiveLayerControls: () => calls.push("syncControls"),
    renderLayerList: () => calls.push("renderLayerList"),
    requestRender: () => calls.push("requestRender"),
    syncLightStateToWidget: () => calls.push("syncLight"),
    scheduleFullSync: () => calls.push("fullSync"),
  });
  return { w, calls };
}

test("a registered history kind is applied with the widget's layer refresh", () => {
  const { w, calls } = widget();
  const seen = [];
  w.registerHistoryKind("featureKind", (entry, direction) => seen.push([entry.value, direction, w.historyRestoring]));
  w.applyHistoryEntry({ kind: "featureKind", value: 1 }, "undo");
  assert.deepEqual(seen, [[1, "undo", true]], "applied while history is restoring");
  assert.equal(w.historyRestoring, false);
  assert.deepEqual(calls, ["cancelDeferred", "syncPoseTool", "syncControls", "renderLayerList", "requestRender", "syncLight"]);
});

test("an isolated kind skips the refresh and a group applies its children in order, undo reversed", () => {
  const { w, calls } = widget();
  const seen = [];
  w.registerHistoryKind("iso", (entry, direction) => seen.push(`${entry.id}:${direction}:${w.historyRestoring}`), { isolated: true });
  const group = { kind: "historyGroup", entries: [{ kind: "iso", id: "a" }, { kind: "iso", id: "b" }] };
  w.applyHistoryEntry(group, "redo");
  w.applyHistoryEntry(group, "undo");
  assert.deepEqual(seen, ["a:redo:true", "b:redo:true", "b:undo:true", "a:undo:true"]);
  assert.deepEqual(calls, []);
  assert.equal(w.historyRestoring, false);
  w.registerHistoryKind("broken", () => { throw new Error("boom"); }, { isolated: true });
  assert.throws(() => w.applyHistoryEntry({ kind: "broken" }, "undo"), /boom/);
  assert.equal(w.historyRestoring, false, "restoring is cleared when an isolated kind throws");
});

test("unknown kinds and invalid registrations are ignored", () => {
  const { w } = widget();
  w.registerHistoryKind("", () => {});
  w.registerHistoryKind("x", null);
  assert.equal(w.historyHandlers?.size ?? 0, 0);
  w.applyHistoryEntry({ kind: "nobodyOwnsThis" }, "undo");
  w.applyHistoryEntry(null, "undo");
});
