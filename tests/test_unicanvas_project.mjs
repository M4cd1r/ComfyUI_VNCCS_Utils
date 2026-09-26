import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PROJECT_POINTER_KEY,
  UniCanvasProjectSession,
  blankSceneState,
  blobUrl,
  collectBlobNames,
  dehydrateValue,
  hydrateSceneState,
  installUniCanvasProjects,
  migrationProjectName,
  saveRetryDelay,
} from "../web/vnccs_unicanvas_project.mjs";

// Plan 10.3 (#22): incremental project saves, conflicts, restore and migration, driven against an
// in-memory copy of the Plan 10.2 project routes.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (label) => `data:image/png;base64,${Buffer.concat([PNG_SIGNATURE, Buffer.from(label)]).toString("base64")}`;
const sha = (dataUrl) => createHash("sha256").update(Buffer.from(dataUrl.split(",")[1], "base64")).digest("hex");

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The project routes of nodes/unicanvas/projects.py, kept in memory. */
function fakeServer() {
  const projects = new Map();
  const calls = [];
  let counter = 0;
  const id = (prefix) => `${prefix}_${(counter += 1).toString().padStart(4, "0")}`;
  const refsExist = (project, value) => [...collectBlobNames(value)].every((name) => project.blobs.has(name.slice(0, -4)));
  const entry = (scene) => ({ id: scene.id, name: scene.name, order: scene.order, rev: scene.rev, thumbnail: scene.thumbnail || null });
  const view = (project) => ({ id: project.id, name: project.name, activeSceneId: project.activeSceneId, scenes: project.scenes.map(entry) });
  const addScene = (project, name, state) => {
    const scene = { id: id("scn"), name: name || `Scene ${project.scenes.length + 1}`, order: project.scenes.length, rev: 1, state: structuredClone(state || { layers: [] }) };
    project.scenes.push(scene);
    project.activeSceneId ||= scene.id;
    return scene;
  };
  const server = {
    projects,
    calls,
    offline: false,
    async fetch(url, init = {}) {
      const method = init.method || "GET";
      calls.push(`${method} ${url}`);
      if (server.offline) throw new TypeError("Failed to fetch");
      const path = url.replace("/vnccs/unicanvas/projects", "");
      const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
      if (!parts.length && method === "GET") return json(200, { projects: [...projects.values()].map((p) => ({ id: p.id, name: p.name })) });
      if (!parts.length && method === "POST") {
        const project = { id: id("prj"), name: body?.name || "Untitled project", scenes: [], activeSceneId: null, blobs: new Map() };
        projects.set(project.id, project);
        addScene(project, "Scene 1");
        return json(200, view(project));
      }
      const project = projects.get(parts[0]);
      if (!project) return json(404, { error: "[VNCCS UniCanvas] Project not found." });
      if (parts.length === 1 && method === "GET") return json(200, view(project));
      if (parts.length === 1 && method === "PATCH") {
        if (body.activeSceneId) project.activeSceneId = body.activeSceneId;
        if (body.sceneOrder) project.scenes = body.sceneOrder.map((sid, order) => Object.assign(project.scenes.find((s) => s.id === sid), { order }));
        return json(200, view(project));
      }
      if (parts[1] === "blobs" && method === "PUT") {
        const bytes = Buffer.from(body);
        if (createHash("sha256").update(bytes).digest("hex") !== parts[2]) return json(400, { error: "hash" });
        project.blobs.set(parts[2], bytes);
        return json(200, { blob: `${parts[2]}.png` });
      }
      if (parts[1] === "scenes" && parts.length === 2 && method === "POST") {
        let state = body.state;
        if (body.fromSceneId) state = project.scenes.find((s) => s.id === body.fromSceneId).state;
        if (!refsExist(project, state)) return json(400, { error: "missing blob" });
        return json(200, entry(addScene(project, body.name, state)));
      }
      const scene = project.scenes.find((s) => s.id === parts[2]);
      if (!scene) return json(404, { error: "[VNCCS UniCanvas] Scene not found." });
      if (method === "GET") return json(200, { ...entry(scene), state: structuredClone(scene.state) });
      if (method === "PUT") {
        if (body.ifRev != null && body.ifRev !== scene.rev) return json(409, { error: "[VNCCS UniCanvas] The scene changed elsewhere.", rev: scene.rev });
        if (!refsExist(project, body.state)) return json(400, { error: "missing blob" });
        scene.state = structuredClone(body.state);
        scene.rev += 1;
        if (body.name) scene.name = body.name;
        return json(200, entry(scene));
      }
      return json(405, { error: "unsupported" });
    },
    uploads: () => calls.filter((call) => call.startsWith("PUT") && call.includes("/blobs/")).length,
  };
  return server;
}

let revisionCounter = 0;
function layer(id, label, type = "raster") {
  revisionCounter += 1;
  return { id, type, name: id, label, canvas: { id }, pixelRevision: revisionCounter };
}
function paint(item, label) {
  revisionCounter += 1;
  item.label = label;
  item.pixelRevision = revisionCounter;
}

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)), data };
}

/** Just the widget surface the project session uses. */
function fakeWidget({ layers = [], widgetState = null, standalone = false, legacyState = null } = {}) {
  const widget = {
    standalone,
    layers,
    size: { width: 64, height: 64 },
    settings: { positive: "keep me" },
    applied: [],
    legacyLoads: 0,
    node: { widgets: [{ name: "unicanvas_state", value: widgetState ? JSON.stringify(widgetState) : "{}" }] },
    buildSerializedState(includeData) {
      assert.equal(includeData, false, "project saves never build a full-data state");
      return {
        version: 2, storage: "server_cache", state_id: "legacy_id", origin: { x: 0, y: 0 }, size: this.size, settings: this.settings,
        layers: this.layers.map((item) => ({ id: item.id, name: item.name, type: item.type, crop: null, dataURL: null, hiresRect: null, hiresDataURL: null })),
        activeLayerId: this.layers[0]?.id || null,
        ...this.projectSession?.ref(),
      };
    },
    serializeLayer(item) {
      this.encoded = (this.encoded || 0) + 1;
      return { id: item.id, name: item.name, type: item.type, crop: item.label ? { x: 1, y: 2, width: 3, height: 4 } : null, dataURL: item.label ? png(item.label) : null, hiresRect: null, hiresDataURL: null };
    },
    getLayerAlphaBounds: (item) => (item.label ? { x: 1, y: 2, width: 3, height: 4 } : null),
    async applySerializedState(state, options) {
      this.applied.push({ state, options });
      this.layers = state.layers.map((item) => ({ id: item.id, type: item.type, name: item.name, label: item.dataURL ? `url:${item.dataURL}` : null, canvas: { id: item.id }, pixelRevision: (revisionCounter += 1) }));
      return true;
    },
    async _loadFromNode() {
      this.legacyLoads += 1;
      if (legacyState) this.layers = legacyState.layers.map((item) => ({ id: item.id, type: item.type, name: item.id, label: item.label, canvas: { id: item.id }, pixelRevision: (revisionCounter += 1) }));
    },
    setStatus(text) { this.lastStatus = text; },
  };
  return widget;
}

test("helpers: dehydrate / hydrate round-trip, blob refs, backoff and names", async () => {
  const blobs = new Map();
  const state = { layers: [{ crop: { x: 1, y: 2, width: 3, height: 4 }, dataURL: png("a"), hiresRect: { x: 0, y: 0, width: 8, height: 8 }, hiresDataURL: png("b"), pose: { character: { dataURL: png("a") } } }] };
  const stored = await dehydrateValue(state, blobs);
  assert.deepEqual([...blobs.keys()].sort(), [sha(png("a")), sha(png("b"))].sort());
  assert.deepEqual(stored.layers[0].dataURL, { blob: `${sha(png("a"))}.png`, crop: { x: 1, y: 2, width: 3, height: 4 } });
  assert.deepEqual(stored.layers[0].hiresDataURL.crop, { x: 0, y: 0, width: 8, height: 8 });
  const hydrated = hydrateSceneState(stored, "prj_1");
  assert.equal(hydrated.layers[0].dataURL, blobUrl("prj_1", `${sha(png("a"))}.png`));
  assert.equal(hydrated.layers[0].pose.character.dataURL, `/vnccs/unicanvas/projects/prj_1/blobs/${sha(png("a"))}`);
  // A URL restored from the project goes back to the same ref instead of being stored as text.
  const again = await dehydrateValue(hydrated, new Map());
  assert.deepEqual(again.layers[0].pose.character.dataURL, { blob: `${sha(png("a"))}.png`, crop: null });
  assert.deepEqual(saveRetryDelay(0), 1000);
  assert.deepEqual(saveRetryDelay(3), 8000);
  assert.deepEqual(saveRetryDelay(50), 30000);
  assert.equal(migrationProjectName(new Date(2026, 8, 5, 7, 3)), "Untitled - 2026-09-05 07:03");
  const blank = blankSceneState({ settings: { a: 1 } });
  assert.deepEqual(blank.layers.map((item) => item.type), ["mask", "raster"]);
  assert.deepEqual(blank.settings, { a: 1 });
});

test("saves are incremental: only changed layers are encoded and only new blobs uploaded", async () => {
  const server = fakeServer();
  const widget = fakeWidget({ layers: [layer("a", "one"), layer("b", "two"), layer("m", null, "mask")] });
  const session = new UniCanvasProjectSession(widget, { fetchImpl: server.fetch, storage: null, now: () => 0 });
  widget.projectSession = session;

  assert.equal(await session.save(), true);
  assert.ok(session.projectId, "the first save creates a project");
  assert.equal(server.uploads(), 2);
  assert.equal(widget.encoded, 3);
  const scene = server.projects.get(session.projectId).scenes[0];
  assert.equal(scene.rev, 2);
  assert.equal(scene.state.storage, "project");
  assert.equal(scene.state.projectId, undefined, "the pointer is not part of the scene");
  assert.deepEqual(scene.state.layers[0].dataURL, { blob: `${sha(png("one"))}.png`, crop: { x: 1, y: 2, width: 3, height: 4 } });

  // Nothing changed: no encode, no upload, no scene write.
  const puts = server.calls.length;
  assert.equal(await session.save(), true);
  assert.equal(server.calls.length, puts);
  assert.equal(widget.encoded, 3);

  // One layer repainted: one encode, one upload; the other keeps its ref.
  paint(widget.layers[1], "two v2");
  assert.equal(await session.save(), true);
  assert.equal(widget.encoded, 4);
  assert.equal(server.uploads(), 3);
  assert.equal(scene.rev, 3);
  assert.equal(scene.state.layers[0].dataURL.blob, `${sha(png("one"))}.png`);
  assert.equal(scene.state.layers[1].dataURL.blob, `${sha(png("two v2"))}.png`);

  // Painting back to known pixels re-encodes but does not upload again.
  paint(widget.layers[1], "two");
  await session.save();
  assert.equal(server.uploads(), 3);
});

test("a stale scene answers 409 and 'Save mine as a copy' keeps both versions", async () => {
  const server = fakeServer();
  const widget = fakeWidget({ layers: [layer("a", "mine")] });
  const session = new UniCanvasProjectSession(widget, { fetchImpl: server.fetch, storage: null, now: () => 0 });
  widget.projectSession = session;
  await session.save();
  const project = server.projects.get(session.projectId);
  project.scenes[0].rev += 5; // another tab saved
  let conflictRev = null;
  session.onConflict = (rev) => { conflictRev = rev; };
  paint(widget.layers[0], "mine v2");
  assert.equal(await session.save(), false);
  assert.equal(session.conflict, true);
  assert.equal(conflictRev, project.scenes[0].rev);
  assert.equal(await session.save(), false, "autosave pauses while the conflict is open");

  await session.resolveConflict("mine");
  assert.equal(session.conflict, false);
  assert.equal(project.scenes.length, 2);
  assert.equal(session.sceneId, project.scenes[1].id);
  assert.equal(project.scenes[1].state.layers[0].dataURL.blob, `${sha(png("mine v2"))}.png`);
  assert.match(project.scenes[1].name, /\(mine\)$/);
});

test("network failures keep the document dirty and retry with backoff", async () => {
  const server = fakeServer();
  const widget = fakeWidget({ layers: [layer("a", "x")] });
  const session = new UniCanvasProjectSession(widget, { fetchImpl: server.fetch, storage: null, now: () => 0 });
  widget.projectSession = session;
  await session.save();
  server.offline = true;
  paint(widget.layers[0], "offline edit");
  assert.equal(await session.save(), false);
  assert.equal(session.status, "offline");
  assert.equal(session.statusDetail, "Offline - retrying");
  assert.ok(session.retryTimer, "a retry is scheduled");
  server.offline = false;
  assert.equal(await session.flush(), true);
  assert.equal(session.status, "saved");
  assert.equal(server.projects.get(session.projectId).scenes[0].state.layers[0].dataURL.blob, `${sha(png("offline edit"))}.png`);
  session.dispose();
});

test("migration: an existing node-mode state is imported into a new project and loses nothing", async () => {
  const server = fakeServer();
  const legacy = { version: 2, storage: "server_cache", state_id: "vnccs_unicanvas_7_abc", layers: [{ id: "base", type: "raster", label: "base pixels" }, { id: "paint", type: "raster", label: "paint pixels" }] };
  const widget = fakeWidget({ widgetState: legacy, legacyState: legacy });
  installUniCanvasProjects(widget, { fetchImpl: server.fetch, storage: null, now: () => 0 });
  await widget._loadFromNode();
  assert.equal(widget.legacyLoads, 1, "without a project the legacy restore runs");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const session = widget.projectSession;
  assert.ok(session.projectId);
  const project = server.projects.get(session.projectId);
  assert.match(project.name, /^Untitled - \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(project.scenes.length, 1);
  const stored = project.scenes[0].state.layers;
  assert.deepEqual(stored.map((item) => item.id), ["base", "paint"]);
  for (const item of stored) {
    const expected = png(legacy.layers.find((l) => l.id === item.id).label);
    assert.deepEqual(project.blobs.get(item.dataURL.blob.slice(0, -4)), Buffer.from(expected.split(",")[1], "base64"));
  }
  assert.match(session.migrationNote, /Imported this canvas/);
  // The node's workflow state now points at the scene; the legacy fields stay for rollback.
  const nodeState = JSON.parse(widget.node.widgets[0].value);
  assert.equal(nodeState.projectId, session.projectId);
  assert.equal(nodeState.sceneId, session.sceneId);
  assert.equal(nodeState.state_id, "vnccs_unicanvas_7_abc");

  // Reloading the workflow restores from the project, not from the legacy cache.
  const reloaded = fakeWidget({ widgetState: nodeState });
  installUniCanvasProjects(reloaded, { fetchImpl: server.fetch, storage: null });
  await reloaded._loadFromNode();
  assert.equal(reloaded.legacyLoads, 0);
  const applied = reloaded.applied.at(-1);
  assert.equal(applied.options.exact, true);
  assert.deepEqual(applied.state.layers.map((item) => item.dataURL), stored.map((item) => blobUrl(session.projectId, item.dataURL)));
  assert.equal(reloaded.settings.positive, "keep me");
});

test("migration: an existing standalone document is imported and localStorage keeps only the pointer", async () => {
  const server = fakeServer();
  const oldDocument = JSON.stringify({ saved_at: 1, state: { version: 2, layers: [{ id: "base", type: "raster" }] } });
  const storage = memoryStorage({ "vnccs-unicanvas-standalone": oldDocument });
  const legacy = { version: 2, storage: "local", layers: [{ id: "base", type: "raster", label: "standalone pixels" }] };
  const widget = fakeWidget({ widgetState: legacy, legacyState: legacy });
  const session = installUniCanvasProjects(widget, { fetchImpl: server.fetch, storage, now: () => 0 });
  const loading = widget._loadFromNode();
  widget.standalone = true; // createStandaloneWidget sets it right after the constructor
  await loading;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const project = server.projects.get(session.projectId);
  const blob = project.scenes[0].state.layers[0].dataURL.blob;
  assert.deepEqual(project.blobs.get(blob.slice(0, -4)), Buffer.from(png("standalone pixels").split(",")[1], "base64"));
  assert.deepEqual(JSON.parse(storage.getItem(PROJECT_POINTER_KEY)), { lastProjectId: session.projectId, lastSceneId: session.sceneId });
  assert.equal(storage.getItem("vnccs-unicanvas-standalone"), oldDocument, "the old document is left untouched");
  assert.equal(widget.node.widgets[0].value, JSON.stringify(legacy), "standalone never writes the pointer into the stub state");

  // Next start: the pointer wins over the old document.
  const next = fakeWidget({ widgetState: legacy, legacyState: legacy });
  installUniCanvasProjects(next, { fetchImpl: server.fetch, storage });
  const nextLoading = next._loadFromNode();
  next.standalone = true;
  await nextLoading;
  assert.equal(next.legacyLoads, 0);
  assert.equal(next.projectSession.projectId, session.projectId);
});

test("scenes: new, switch, duplicate without uploads, reorder", async () => {
  const server = fakeServer();
  const widget = fakeWidget({ layers: [layer("a", "scene one")] });
  const session = new UniCanvasProjectSession(widget, { fetchImpl: server.fetch, storage: null, now: () => 0 });
  widget.projectSession = session;
  await session.save();
  const first = session.sceneId;
  await session.newScene();
  assert.notEqual(session.sceneId, first);
  assert.deepEqual(widget.layers.map((item) => item.type), ["mask", "raster"], "a new scene starts blank");
  assert.deepEqual(widget.undoStack, []);
  const uploads = server.uploads();
  await session.switchScene(first);
  assert.equal(session.sceneId, first);
  assert.equal(widget.layers[0].label, `url:${blobUrl(session.projectId, `${sha(png("scene one"))}.png`)}`);

  await session.duplicateScene(first);
  assert.equal(session.project.scenes.length, 3);
  await session.save();
  assert.equal(server.uploads(), uploads, "duplicating a scene uploads no blob");

  const order = session.project.scenes.map((scene) => scene.id).reverse();
  await session.reorderScenes(order);
  assert.deepEqual(session.project.scenes.map((scene) => scene.id), order);
});

test("thumbnails: an unchanged scene still sends a due thumbnail, a throttled one goes with a trailing save", async () => {
  const server = fakeServer();
  const bodies = [];
  const fetchImpl = (url, init = {}) => {
    if ((init.method || "GET") === "PUT" && url.includes("/scenes/")) bodies.push(JSON.parse(init.body));
    return server.fetch(url, init);
  };
  const widget = fakeWidget({ layers: [layer("a", "one")] });
  let clock = 100_000;
  const session = new UniCanvasProjectSession(widget, { fetchImpl, storage: null, now: () => clock });
  widget.projectSession = session;
  let thumbs = 0;
  session.buildThumbnail = () => `thumb-${(thumbs += 1)}`;
  assert.equal(await session.save(), true);
  assert.equal(bodies.at(-1).thumbnail, "thumb-1");

  // An edit inside the throttle interval saves without a thumbnail...
  paint(widget.layers[0], "two");
  clock += 1000;
  assert.equal(await session.save(), true);
  assert.equal(bodies.at(-1).thumbnail, undefined);
  assert.equal(session.thumbnailDirty, true);
  // ...and once the interval has passed, a save with no other change sends it.
  clock += 10_000;
  const count = bodies.length;
  assert.equal(await session.save(), true);
  assert.equal(bodies.length, count + 1);
  assert.equal(bodies.at(-1).thumbnail, "thumb-2");
  assert.equal(session.thumbnailDirty, false);
  // Nothing dirty: an unchanged scene does not write again.
  assert.equal(await session.save(), true);
  assert.equal(bodies.length, count + 1);
  session.dispose();
});
