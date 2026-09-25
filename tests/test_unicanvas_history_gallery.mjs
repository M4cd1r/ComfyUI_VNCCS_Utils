import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  HISTORY_SETTINGS_HISTORY_KIND,
  UniCanvasHistory,
  buildHistoryRecord,
  filterHistoryRecords,
  formatBytes,
  historyFamilies,
  historySettingsSnapshot,
  installUniCanvasHistory,
  recordSeed,
  restoredSettings,
} from "../web/vnccs_unicanvas_history_gallery.mjs";

// Plan 10.5 (#24): history records written when a run settles, acceptance flags, restore/undo,
// and the gallery filters, driven against an in-memory copy of the history routes.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (label) => `data:image/png;base64,${Buffer.concat([PNG_SIGNATURE, Buffer.from(label)]).toString("base64")}`;
const sha = (dataUrl) => createHash("sha256").update(Buffer.from(dataUrl.split(",")[1], "base64")).digest("hex");
const digest = async (bytes) => createHash("sha256").update(bytes).digest("hex");

function fakeSession({ attached = true } = {}) {
  const calls = [];
  const records = new Map();
  const blobs = new Map();
  const session = {
    active: true,
    attached,
    projectId: "prj_1",
    sceneId: "scn_1",
    project: { id: "prj_1", settings: {}, scenes: [{ id: "scn_1", name: "Scene 1" }] },
    knownBlobs: new Set(),
    digest,
    calls,
    records,
    blobs,
    prunedBlobs: [],
    projectPath: (id = "prj_1") => `/${id}`,
    async switchScene(sceneId) { session.sceneId = sceneId; return true; },
    async request(method, path, { json, body } = {}) {
      calls.push({ method, path, json });
      const blob = /^\/prj_1\/blobs\/([0-9a-f]{64})$/.exec(path);
      if (blob && method === "PUT") {
        blobs.set(blob[1], body);
        return { blob: `${blob[1]}.png` };
      }
      if (path === "/prj_1/history" && method === "POST") {
        records.set(json.id, structuredClone(json));
        return { record: json, pruned: { records: [], results: 0, blobs: session.prunedBlobs } };
      }
      if (path === "/prj_1/history" && method === "GET") return { records: [...records.values()].reverse(), settings: null, usage: null };
      const one = /^\/prj_1\/history\/(.+)$/.exec(path);
      if (one && method === "PATCH") {
        const record = records.get(decodeURIComponent(one[1]));
        for (const change of json.results) Object.assign(record.results[change.index], change);
        return record;
      }
      if (one && method === "DELETE") {
        records.delete(decodeURIComponent(one[1]));
        return { deleted: true };
      }
      if (path === "/prj_1" && method === "PATCH") return { id: "prj_1", settings: json.settings };
      if (path === "/prj_1/history/prune") return { records: [], results: 0, blobs: [] };
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return session;
}

function fakeWidget(session) {
  const widget = {
    settings: { positive: "a red fox", negative: "blurry", seed: 11, steps: 20, generation_mode: "sdxl", seed_mode: "randomize", draw_id: "uc_1", queued_draw: { image: "x" }, lora_stack: [{ name: "a.safetensors", strength: 0.5 }], selected_preset_id: "sdxl" },
    activeLayerId: "layer_base",
    layers: [{ id: "layer_base" }],
    projectSession: session,
    undoStack: [],
    applied: [],
    applySerializedSettings(settings) {
      widget.settings = { ...widget.settings, ...settings };
      widget.applied.push(settings);
    },
    pushHistoryEntry(entry) { widget.undoStack.push(entry); },
    setStatus() {},
    setActiveLayer(id) { widget.activeLayerId = id; },
    generateRandomSeed: () => 424242,
  };
  return widget;
}

const staged = (label, seed) => ({ imageDataURL: png(label), snapshot: { historyId: "gen_run", seed }, displaySize: { width: 64, height: 48 }, bbox: { x: 0, y: 0, width: 64, height: 48 } });

test("a record keeps the full settings without the transient draw keys", () => {
  const record = buildHistoryRecord({
    kind: "generate", id: "gen_a", sceneId: "scn_1", startedAt: 2_000, finishedAt: 3_500,
    settings: { positive: "p", draw_id: "x", queued_draw: {}, lora_stack: [{ name: "l", strength: 1 }, { name: "" }], selected_preset_id: "anima" },
    bbox: { x: 1, y: 2, width: 3, height: 4 }, results: [{ imageDataURL: png("r"), seed: 5, width: 3, height: 4 }],
  });
  assert.equal(record.createdAt, 2);
  assert.equal(record.durationMs, 1500);
  assert.equal(record.status, "ok");
  assert.deepEqual(Object.keys(record.settings).sort(), ["lora_stack", "positive", "selected_preset_id"]);
  assert.deepEqual(record.loras, [{ name: "l", strength: 1 }]);
  assert.equal(record.presetId, "anima");
  assert.deepEqual(record.results[0], { index: 0, imageDataURL: png("r"), accepted: false, layerId: null, seed: 5, width: 3, height: 4, rect: null });
  assert.throws(() => buildHistoryRecord({ kind: "nope" }));
  assert.equal(buildHistoryRecord({ kind: "remove_bg", error: "boom" }).status, "error");
});

test("a generate run with batch 3 records 3 results; accepting one flags exactly that one", async () => {
  const session = fakeSession();
  const widget = fakeWidget(session);
  const history = new UniCanvasHistory(widget, { now: (() => { let t = 1_000; return () => (t += 250); })() });
  const run = history.beginRun("generate", { settings: widget.settings, snapshot: { historyId: "gen_run", seed: 11, prompt: "a red fox" }, bbox: { x: 0, y: 0, width: 64, height: 48 }, mode: "txt2img" });
  widget.settings.positive = "edited while the run was in flight";
  const items = [staged("one", 11), staged("two", 12), staged("three", 13)];
  await run.finish(items);
  assert.deepEqual(items.map((item) => [item.historyId, item.historyIndex]), [["gen_run", 0], ["gen_run", 1], ["gen_run", 2]]);
  const stored = session.records.get("gen_run");
  assert.equal(stored.kind, "generate");
  assert.equal(stored.sceneId, "scn_1");
  assert.equal(stored.targetLayerId, "layer_base");
  assert.equal(stored.settings.positive, "a red fox", "settings are the request-time snapshot");
  assert.equal(stored.results.length, 3);
  assert.deepEqual(stored.results.map((item) => item.imageDataURL.blob), items.map((item) => `${sha(item.imageDataURL)}.png`));
  assert.deepEqual(stored.results.map((item) => item.seed), [11, 12, 13]);
  assert.equal(session.blobs.size, 3);
  await history.onStagingAccepted(items[1], { id: "layer_new" });
  assert.deepEqual(session.records.get("gen_run").results.map((item) => item.accepted), [false, true, false]);
  assert.equal(session.records.get("gen_run").results[1].layerId, "layer_new");
  await history.onAcceptHistory({ acceptedItem: items[1], layer: { id: "layer_new" } }, "undo");
  assert.deepEqual(session.records.get("gen_run").results.map((item) => item.accepted), [false, false, false]);
  await history.onAcceptHistory({ acceptedItem: items[1], layer: { id: "layer_new" } }, "redo");
  assert.equal(session.records.get("gen_run").results[1].accepted, true);
});

test("blobs the project already has are not uploaded again, pruned ones are", async () => {
  const session = fakeSession();
  const history = new UniCanvasHistory(fakeWidget(session));
  await history.beginRun("generate", { snapshot: { historyId: "gen_1" } }).finish([staged("same", 1)]);
  const puts = () => session.calls.filter((call) => call.method === "PUT").length;
  assert.equal(puts(), 1);
  session.prunedBlobs = [sha(png("same"))];
  await history.beginRun("generate", { snapshot: { historyId: "gen_2" } }).finish([staged("same", 1)]);
  assert.equal(puts(), 1, "known blob skipped");
  session.prunedBlobs = [];
  await history.beginRun("generate", { snapshot: { historyId: "gen_3" } }).finish([staged("same", 1)]);
  assert.equal(puts(), 2, "a blob pruned on the server is uploaded again");
});

test("a failed run is recorded with its error and no results; each run writes once", async () => {
  const session = fakeSession();
  const history = new UniCanvasHistory(fakeWidget(session));
  const run = history.beginRun("generate", { snapshot: { historyId: "gen_fail" } });
  await run.fail(new Error("CUDA out of memory"));
  assert.equal(run.finish([staged("late", 1)]), null);
  const record = session.records.get("gen_fail");
  assert.equal(record.status, "error");
  assert.equal(record.error, "CUDA out of memory");
  assert.deepEqual(record.results, []);
  assert.equal(session.calls.filter((call) => call.method === "POST").length, 1);
});

test("without an attached project nothing is recorded", () => {
  const history = new UniCanvasHistory(fakeWidget(fakeSession({ attached: false })));
  assert.equal(history.beginRun("generate", {}), null);
});

test("Restore settings is one undo entry that makes the panel equal the snapshot", async () => {
  const session = fakeSession();
  const widget = fakeWidget(session);
  const history = new UniCanvasHistory(widget);
  const record = { kind: "generate", settings: { positive: "old prompt", seed: 77, steps: 8, generation_mode: "anima" } };
  const before = historySettingsSnapshot(widget.settings);
  history.restoreSettings(record);
  for (const [key, value] of Object.entries(record.settings)) assert.equal(widget.settings[key], value);
  assert.equal(widget.undoStack.length, 1);
  const entry = widget.undoStack[0];
  assert.equal(entry.kind, HISTORY_SETTINGS_HISTORY_KIND);
  history.applySettingsHistory(entry, "undo");
  for (const key of ["positive", "seed", "steps", "generation_mode"]) assert.equal(widget.settings[key], before[key]);
  history.applySettingsHistory(entry, "redo");
  assert.equal(widget.settings.positive, "old prompt");
});

test("Re-run uses the recorded or a new seed and keeps the recorded seed mode", async () => {
  const session = fakeSession();
  const widget = fakeWidget(session);
  const draws = [];
  widget.draw = async () => { draws.push({ seed: widget.settings.seed, mode: widget.settings.seed_mode, bbox: { ...widget.bbox } }); };
  widget.bbox = { x: 0, y: 0, width: 10, height: 10 };
  const history = new UniCanvasHistory(widget);
  const record = { kind: "generate", bbox: { x: 5, y: 6, width: 64, height: 48 }, snapshot: { seed: 99 }, settings: { seed: 99, seed_mode: "randomize", positive: "p" } };
  await history.rerun(record);
  await history.rerun(record, { newSeed: true });
  assert.deepEqual(draws.map((draw) => [draw.seed, draw.mode]), [[99, "fixed"], [424242, "fixed"]]);
  assert.deepEqual(draws[0].bbox, record.bbox);
  assert.equal(widget.settings.seed_mode, "randomize");
  await assert.rejects(history.rerun({ kind: "remove_bg" }));
});

test("Show layer switches to the record's scene and selects the layer", async () => {
  const session = fakeSession();
  const widget = fakeWidget(session);
  widget.layers.push({ id: "layer_x" });
  const history = new UniCanvasHistory(widget);
  const record = { sceneId: "scn_2", results: [{ layerId: "layer_x" }, { layerId: null }, { layerId: "gone" }] };
  assert.equal(await history.showLayer(record, 0), "layer_x");
  assert.equal(session.sceneId, "scn_2");
  assert.equal(widget.activeLayerId, "layer_x");
  await assert.rejects(history.showLayer(record, 1), /not placed/);
  await assert.rejects(history.showLayer(record, 2), /deleted/);
});

test("retention caps go into the project settings and trigger a prune", async () => {
  const session = fakeSession();
  const history = new UniCanvasHistory(fakeWidget(session));
  await history.setRetention({ maxRecords: 5, maxBytes: 1024 });
  assert.deepEqual(session.project.settings.history, { maxRecords: 5, maxBytes: 1024 });
  assert.ok(session.calls.some((call) => call.path === "/prj_1/history/prune"));
});

test("filters narrow the grid by scene, kind, accepted, family and prompt text", () => {
  const records = [
    { id: "a", createdAt: 1, sceneId: "s1", kind: "generate", snapshot: { prompt: "red fox", modelFamily: "sdxl" }, results: [{ accepted: true }] },
    { id: "b", createdAt: 3, sceneId: "s2", kind: "generate", snapshot: { prompt: "blue whale", modelFamily: "anima" }, results: [{ accepted: false }] },
    { id: "c", createdAt: 2, sceneId: "s1", kind: "remove_bg", settings: { positive: "Fox Portrait", generation_mode: "sdxl" }, results: [{ accepted: true }] },
  ];
  const ids = (filters) => filterHistoryRecords(records, filters).map((record) => record.id);
  assert.deepEqual(ids({}), ["b", "c", "a"]);
  assert.deepEqual(ids({ sceneId: "s1" }), ["c", "a"]);
  assert.deepEqual(ids({ kind: "remove_bg" }), ["c"]);
  assert.deepEqual(ids({ acceptedOnly: true }), ["c", "a"]);
  assert.deepEqual(ids({ family: "anima" }), ["b"]);
  assert.deepEqual(ids({ text: "FOX" }), ["c", "a"]);
  assert.deepEqual(historyFamilies(records), ["anima", "sdxl"]);
});

test("helpers: seeds, settings overrides and byte formatting", () => {
  assert.equal(recordSeed({ snapshot: { seed: 4 }, results: [{ seed: 9 }] }, 0), 9);
  assert.equal(recordSeed({ snapshot: { seed: 4 } }), 4);
  assert.equal(recordSeed({ settings: {} }), null);
  assert.deepEqual(restoredSettings({ a: 1, b: 2 }, { settings: { b: 3 } }, { c: 4, d: undefined }), { a: 1, b: 3, c: 4 });
  assert.equal(formatBytes(4 * 1024 ** 3), "4.00 GB");
  assert.equal(formatBytes(1536), "2 KB");
});

test("install puts history on the widget once", () => {
  const widget = fakeWidget(fakeSession());
  const history = installUniCanvasHistory(widget);
  assert.ok(history instanceof UniCanvasHistory);
  assert.equal(installUniCanvasHistory(widget), history);
});
