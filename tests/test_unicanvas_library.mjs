import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSET_KINDS,
  LibraryClient,
  absolutePerspective,
  anchorPoint,
  anchoredRect,
  assetBlobUrl,
  assetsPath,
  dropScale,
  filterAssets,
  insertAsset,
  installUniCanvasLibrary,
  normalizeAnchor,
  parseTags,
  placedSpriteSet,
  poseForAsset,
  presetSnapshot,
  pushLayerToLibrary,
  relativePerspective,
  saveLayerToLibrary,
  saveableKinds,
  updateLayerFromLibrary,
} from "../web/vnccs_unicanvas_library.mjs";
import { normalizeLayerMeta } from "../web/vnccs_unicanvas_provenance.mjs";

// Plan 10.4 (#23): the asset library's pure helpers, its HTTP client and the insert / save /
// update / push flows, driven against a fake widget and an in-memory copy of the asset routes.

const SHA = "a".repeat(64);

test("paths and blob urls follow the two scopes", () => {
  assert.equal(assetsPath("global"), "/vnccs/unicanvas/library/assets");
  assert.equal(assetsPath("project", "prj 1"), "/vnccs/unicanvas/projects/prj%201/assets");
  assert.throws(() => assetsPath("project", null));
  assert.equal(assetBlobUrl("global", null, `${SHA}.png`), `/vnccs/unicanvas/library/blobs/${SHA}`);
  assert.equal(assetBlobUrl("project", "prj_1", { blob: `${SHA}.png` }), `/vnccs/unicanvas/projects/prj_1/blobs/${SHA}`);
  assert.equal(assetBlobUrl("global", null, "../evil.png"), null);
  assert.deepEqual([...ASSET_KINDS], ["character", "background", "prop", "pose", "preset"]);
});

test("saveable kinds follow the layer type and provenance", () => {
  assert.deepEqual(saveableKinds({ type: "mask" }), []);
  assert.deepEqual(saveableKinds({ type: "group" }), []);
  assert.deepEqual(saveableKinds({ type: "pose" }), ["pose"]);
  assert.deepEqual(saveableKinds({ type: "sprite", meta: {} }), ["character"]);
  assert.equal(saveableKinds({ type: "raster", meta: { origin: "paint" } })[0], "prop");
  assert.equal(saveableKinds({ type: "raster", meta: { origin: "generate", heightFactor: 1.1 } })[0], "character");
  assert.equal(saveableKinds({ type: "raster", meta: { origin: "asset", assetKind: "background" } })[0], "background");
  assert.deepEqual(saveableKinds({ type: "panorama" }), []);
  // Folder categories (issue #17) decide the kind when present.
  assert.equal(saveableKinds({ type: "raster", name: "x", meta: { origin: "import", category: "Background" } })[0], "background");
  assert.equal(saveableKinds({ type: "raster", name: "x", meta: { origin: "import", category: "Props" } })[0], "prop");
  assert.equal(saveableKinds({ type: "raster", name: "x", meta: { origin: "generate", character: { name: "Alice" } } })[0], "character");
});

test("filter and tags", () => {
  const assets = [
    { name: "Alice", kind: "character", tags: ["cast"] },
    { name: "Forest", kind: "background", tags: ["outdoor", "day"] },
    { name: "Lamp", kind: "prop", tags: [] },
  ];
  assert.deepEqual(filterAssets(assets, { kind: "prop" }).map((a) => a.name), ["Lamp"]);
  assert.deepEqual(filterAssets(assets, { query: "OUT" }).map((a) => a.name), ["Forest"]);
  assert.deepEqual(filterAssets(assets, { query: "li" }).map((a) => a.name), ["Alice"]);
  assert.equal(filterAssets(assets).length, 3);
  assert.deepEqual(parseTags(" cast, hero ,cast,,"), ["cast", "hero"]);
});

test("anchored placement puts the anchor on the point", () => {
  const anchor = normalizeAnchor(null, "character");
  assert.deepEqual(anchor, { x: 0.5, y: 1 });
  const rect = anchoredRect({ width: 40, height: 100 }, anchor, { x: 200, y: 300 });
  assert.deepEqual(rect, { x: 180, y: 200, width: 40, height: 100 });
  assert.deepEqual(anchorPoint(rect, anchor), { x: 200, y: 300 });
  const scaled = anchoredRect({ width: 40, height: 100 }, anchor, { x: 200, y: 300 }, 0.5);
  assert.deepEqual(anchorPoint(scaled, anchor), { x: 200, y: 300 });
  assert.deepEqual(normalizeAnchor({ x: 2, y: -1 }, "prop"), { x: 1, y: 0 });
});

test("drop scale uses the calibrated, enabled depth scale for characters only", () => {
  const perspective = { enabled: true, horizonY: 100, vanishX: null, referenceHeight: { feetY: 500, heightPx: 200 } };
  // Feet at 300: half-way to the horizon -> expected height 100 for a standard character.
  assert.equal(dropScale(perspective, "character", 300, 50), 2);
  assert.equal(dropScale(perspective, "character", 300, 50, 1.2), 2.4);
  assert.equal(dropScale(perspective, "prop", 300, 50), 1);
  assert.equal(dropScale({ ...perspective, enabled: false }, "character", 300, 50), 1);
  assert.equal(dropScale(perspective, "character", 50, 50), 1); // above the horizon
});

test("background perspective round-trips through a moved rect", () => {
  const perspective = { enabled: true, horizonY: 300, vanishX: 500, referenceHeight: { feetY: 900, heightPx: 400, x: 500 } };
  const relative = relativePerspective(perspective, { x: 0, y: 0, width: 1000, height: 1000 });
  const moved = absolutePerspective(relative, { x: 100, y: 50, width: 500, height: 500 });
  assert.deepEqual(moved, { horizonY: 200, vanishX: 350, referenceHeight: { feetY: 500, heightPx: 200, x: 350 } });
  assert.equal(relativePerspective({ horizonY: null }, { x: 0, y: 0, width: 10, height: 10 }), null);
});

test("preset snapshots drop machine and UI settings; pose assets drop the bound reference", () => {
  const snapshot = presetSnapshot({ generation_mode: "sdxl", steps: 20, cfg: 5, loras: [{ name: "a", strength: 1 }], debug_mode: true, remove_bg_method: "x", vae_chunking: true, sdxl_turbo_previous_settings: {} });
  assert.deepEqual(snapshot, { generation_mode: "sdxl", steps: 20, cfg: 5, loras: [{ name: "a", strength: 1 }] });
  const pose = poseForAsset({ version: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, studio: { a: 1, background_url: "data:image/png;base64,AA" }, character: { source: "upload", dataURL: "data:x" } });
  assert.equal(pose.character, null);
  assert.deepEqual(pose.studio, { a: 1 });
});

test("provenance keeps the asset link fields", () => {
  const meta = normalizeLayerMeta({ origin: "asset", assetId: "ast_1", assetScope: "global", assetKind: "character" });
  assert.deepEqual(meta, { origin: "asset", assetId: "ast_1", assetScope: "global", assetKind: "character" });
});

// -- flows against a fake widget ----------------------------------------------------------------

function fakeCanvas(width = 1024, height = 1024) {
  const ops = [];
  return {
    width, height, ops,
    getContext: () => ({
      clearRect: (...args) => ops.push(["clear", ...args]),
      drawImage: (image, ...args) => ops.push(["draw", image.src, ...args]),
    }),
    toDataURL: () => "data:image/png;base64,AAAA",
  };
}

function fakeWidget({ projectId = "prj_1", perspective = null } = {}) {
  const history = [];
  const uc = {
    layers: [], origin: { x: 0, y: 0 }, size: { width: 1024, height: 1024 }, bbox: { x: 0, y: 0, width: 1024, height: 1024 },
    panorama: null, transformDraft: null, settings: { steps: 12 }, scenePerspective: perspective, history, statuses: [],
    projectSession: projectId ? { attached: true, projectId } : null,
    addLayer(type, name, record, _defer, meta) {
      const layer = { id: `l${this.layers.length + 1}`, type, name, meta, canvas: fakeCanvas() };
      this.layers.unshift(layer);
      if (record) history.push({ kind: "addLayer", layer });
      return layer;
    },
    recordHistoryBefore() { history.push({ kind: "snapshot" }); },
    filed: [],
    autoFileLayer(layer) { this.filed.push(layer.id); },
    pushHistoryEntry(entry) { history.push(entry); },
    normalizeLayerOrder() {},
    ensureWorldRectBounds: () => true,
    configureImageContext: (ctx) => ctx,
    invalidateLayerCaches(layer) { layer.revision = (layer.revision || 0) + 1; },
    renderLayerList() {}, requestRender() {}, syncLightStateToWidget() {}, scheduleFullSync() {},
    setStatus(text, isError) { this.statuses.push([text, Boolean(isError)]); },
    loadImage: async (src) => ({ src, naturalWidth: 40, naturalHeight: 100, width: 40, height: 100 }),
    getLayerAlphaBounds: (layer) => layer.bounds || null,
    getLayerWorldBounds: (layer) => layer.bounds ? { ...layer.bounds } : null,
    cloneCanvasCrop: () => fakeCanvas(),
    createLayerPixelSnapshot: (layer) => ({ id: layer.id, ops: layer.canvas.ops.length }),
    applySerializedSettings(settings) { this.settings = { ...this.settings, ...settings }; },
  };
  return uc;
}

function fakeServer() {
  const assets = new Map();
  const calls = [];
  let counter = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push([init.method, url]);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const match = /\/assets(?:\/([^/?]+))?/.exec(url);
    const id = match?.[1];
    const respond = (status, data) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (init.method === "GET" && !id) return respond(200, { assets: [...assets.values()] });
    if (init.method === "POST") {
      const asset = { ...body, id: `ast_${(counter += 1)}`, rev: 1, data: { ...body.data, imageDataURL: body.data.imageDataURL ? { blob: `${SHA}.png` } : null } };
      assets.set(asset.id, asset);
      return respond(200, asset);
    }
    const asset = assets.get(id);
    if (!asset) return respond(404, { error: "[VNCCS UniCanvas] Asset not found." });
    if (init.method === "GET") return respond(200, asset);
    if (init.method === "PUT") {
      if (body.ifRev !== undefined && body.ifRev !== asset.rev) return respond(409, { error: "changed", rev: asset.rev });
      Object.assign(asset, { data: { ...body.data, imageDataURL: { blob: `${SHA}.png` } }, rev: asset.rev + 1 });
      return respond(200, asset);
    }
    if (init.method === "DELETE") { assets.delete(id); return respond(200, { deleted: true }); }
    return respond(405, { error: "no" });
  };
  return { assets, calls, client: new LibraryClient(fetchImpl) };
}

test("client surfaces route errors without the log prefix", async () => {
  const { client } = fakeServer();
  await assert.rejects(client.get("global", null, "ast_missing"), (error) => error.status === 404 && error.message === "Asset not found.");
});

test("a character inserts as an asset layer with its feet on the drop point", async () => {
  const uc = fakeWidget();
  const asset = { id: "ast_1", kind: "character", name: "Alice", scope: "global",
    data: { imageDataURL: { blob: `${SHA}.png` }, size: { width: 40, height: 100 }, anchor: { x: 0.5, y: 1 }, heightFactor: 1.1, identityPrompt: "red hair" } };
  const layer = await insertAsset(uc, asset, { x: 300, y: 400 });
  assert.equal(layer.type, "raster");
  assert.deepEqual(normalizeLayerMeta(layer.meta), { origin: "asset", assetId: "ast_1", assetScope: "global", assetKind: "character", sourceName: "Alice", prompt: "red hair", heightFactor: 1.1, createdAt: layer.meta.createdAt, category: "Characters", character: { id: "ast_1", name: "Alice" } });
  assert.deepEqual(uc.filed, [layer.id]);
  const draw = layer.canvas.ops.find((op) => op[0] === "draw");
  assert.deepEqual(draw, ["draw", `/vnccs/unicanvas/library/blobs/${SHA}`, 280, 300, 40, 100]);
  assert.equal(layer.hiresCanvas, null);
  assert.equal(uc.history.filter((entry) => entry.kind === "addLayer").length, 1);
});

test("depth scale sizes a dropped character for its ground row", async () => {
  const perspective = { enabled: true, horizonY: 100, vanishX: null, referenceHeight: { feetY: 500, heightPx: 200 } };
  const uc = fakeWidget({ perspective });
  globalThis.document = { createElement: () => fakeCanvas(1, 1) };
  try {
    const asset = { id: "ast_1", kind: "character", name: "Alice", scope: "global", data: { imageDataURL: { blob: `${SHA}.png` }, size: { width: 40, height: 100 } } };
    const layer = await insertAsset(uc, asset, { x: 300, y: 300 }); // expected height 100 -> scale 1
    assert.deepEqual(layer.canvas.ops.find((op) => op[0] === "draw").slice(2), [280, 200, 40, 100]);
    const far = await insertAsset(uc, asset, { x: 300, y: 200 }); // expected height 50 -> half size
    assert.deepEqual(far.canvas.ops.find((op) => op[0] === "draw").slice(2), [290, 150, 20, 50]);
    assert.deepEqual(far.hiresRect, { x: 290, y: 150, width: 20, height: 50 });
  } finally {
    delete globalThis.document;
  }
});

test("backgrounds go to the bottom of the stack in one undo step; presets apply settings", async () => {
  const uc = fakeWidget();
  uc.layers.push({ id: "top", type: "raster", name: "Top", canvas: fakeCanvas() });
  const background = await insertAsset(uc, { id: "ast_2", kind: "background", name: "Forest", scope: "project",
    data: { imageDataURL: { blob: `${SHA}.png` }, size: { width: 40, height: 100 }, anchor: { x: 0.5, y: 0.5 } } }, { x: 20, y: 50 });
  assert.equal(uc.layers.at(-1), background);
  assert.deepEqual(uc.history.map((entry) => entry.kind), ["snapshot"]);
  assert.deepEqual(uc.filed, []); // backgrounds stay at the bottom, outside the folders
  assert.equal(background.canvas.ops.find((op) => op[0] === "draw")[1], `/vnccs/unicanvas/projects/prj_1/blobs/${SHA}`);
  const result = await insertAsset(uc, { id: "ast_3", kind: "preset", name: "Style", data: { settings: { steps: 30, cfg: 4 } } }, { x: 0, y: 0 });
  assert.equal(result, null);
  assert.deepEqual(uc.settings, { steps: 30, cfg: 4 });
});

test("pose assets keep the render inside the moved pose rect", async () => {
  const uc = fakeWidget();
  const asset = { id: "ast_4", kind: "pose", name: "Wave", scope: "global", data: {
    imageDataURL: { blob: `${SHA}.png` }, size: { width: 200, height: 400 }, anchor: { x: 0.5, y: 1 },
    pose: { version: 1, rect: { x: 0, y: 0, width: 200, height: 400 }, studio: { s: 1 }, character: null },
    imageRect: { x: 80, y: 300, width: 40, height: 100 },
  } };
  const layer = await insertAsset(uc, asset, { x: 500, y: 600 });
  assert.equal(layer.type, "pose");
  assert.deepEqual(layer.pose.rect, { x: 400, y: 200, width: 200, height: 400 });
  assert.deepEqual(layer.pose.studio, { s: 1 });
  assert.deepEqual(layer.canvas.ops.find((op) => op[0] === "draw").slice(2), [480, 500, 40, 100]);
});

test("save links the layer, push updates the asset, update repaints in place with one history entry", async () => {
  const { client, assets } = fakeServer();
  const uc = fakeWidget();
  const layer = { id: "l9", type: "raster", name: "Alice", meta: { origin: "generate", prompt: "girl", heightFactor: 1 }, canvas: fakeCanvas(), bounds: { x: 100, y: 200, width: 40, height: 100 } };
  uc.layers.push(layer);
  const asset = await saveLayerToLibrary(uc, layer, { kind: "character", name: "Alice", tags: ["cast"], scope: "project", identityPrompt: "red hair" }, client);
  const stored = assets.get(asset.id);
  assert.equal(stored.kind, "character");
  assert.equal(stored.data.identityPrompt, "red hair");
  assert.deepEqual(stored.data.size, { width: 40, height: 100 });
  assert.deepEqual(stored.data.anchor, { x: 0.5, y: 1 });
  assert.equal(stored.data.spriteSet, null);
  const meta = normalizeLayerMeta(layer.meta);
  assert.equal(meta.assetId, asset.id);
  assert.equal(meta.assetScope, "project");
  assert.equal(uc.history.at(-1).kind, "layerProps");

  const pushed = await pushLayerToLibrary(uc, layer, client);
  assert.equal(pushed.rev, 2);
  assert.equal(assets.get(asset.id).data.identityPrompt, "red hair"); // kept from the stored asset

  layer.bounds = { x: 100, y: 200, width: 40, height: 100 };
  await updateLayerFromLibrary(uc, layer, client);
  const entry = uc.history.at(-1);
  assert.equal(entry.kind, "layerPixels");
  assert.equal(entry.layerId, layer.id);
  // Feet stay at (120, 300); the asset is 40x100 so it lands exactly where the layer was.
  assert.deepEqual(layer.canvas.ops.find((op) => op[0] === "draw").slice(2), [100, 200, 40, 100]);

  await assert.rejects(saveLayerToLibrary(uc, { type: "mask", meta: {} }, { kind: "prop", scope: "global" }, client));
  const projectless = fakeWidget({ projectId: null });
  await assert.rejects(saveLayerToLibrary(projectless, layer, { kind: "prop", scope: "project" }, client), /not in a project/);
});

test("install adds the layer menu entries and works without a DOM", () => {
  const uc = fakeWidget();
  const library = installUniCanvasLibrary(uc, { fetchImpl: async () => new Response("{}") });
  assert.ok(library.client instanceof LibraryClient);
  assert.deepEqual(uc.layerMenuExtensions.map((item) => item.id), ["library-save", "library-update", "library-push"]);
  const [save, update] = uc.layerMenuExtensions;
  assert.equal(save.visible({ type: "raster", meta: {} }), true);
  assert.equal(save.visible({ type: "mask", meta: {} }), false);
  assert.equal(update.visible({ type: "raster", meta: { origin: "paint" } }), false);
  assert.equal(update.visible({ type: "raster", meta: { origin: "asset", assetId: "ast_1", assetScope: "global" } }), true);
  assert.equal(installUniCanvasLibrary(uc), library);
});

// Sprite sets on character assets (#6 / #23): saved with every variant, inserted as a sprite layer.
function fakeSprites() {
  const calls = [];
  return {
    calls,
    syncFromCanvas: (layer) => calls.push(["sync", layer.id]),
    serialize: (layer) => ({ rect: { ...layer.sprite.rect }, anchor: { ...layer.sprite.anchor }, faceRect: { x: 10, y: 5, width: 20, height: 20 },
      activeVariantId: "v1", variants: layer.sprite.variants.map((variant) => ({ id: variant.id, name: variant.name, status: "ready", dataURL: "data:image/png;base64,AAAA" })) }),
    loadSet: async (stored) => ({ ...stored, variants: stored.variants.map((variant) => ({ ...variant, pixels: { src: variant.dataURL } })) }),
    attachSet: (layer, sprite) => { calls.push(["attach", layer.id]); layer.sprite = sprite; },
  };
}

test("a sprite set is placed over a new rect: rect-space fields scale, blob refs become urls", () => {
  const stored = { rect: { x: 5, y: 5, width: 100, height: 200 }, anchor: { x: 50, y: 200 }, faceRect: { x: 30, y: 10, width: 40, height: 40 }, sourceLayerId: "old",
    variants: [{ id: "a", dataURL: { blob: `${SHA}.png` } }, { id: "b", dataURL: "data:image/png;base64,AAAA" }, { id: "c", status: "empty" }] };
  const placed = placedSpriteSet(stored, { x: 10.4, y: 20.6, width: 50, height: 100 }, (ref) => assetBlobUrl("global", null, ref));
  assert.deepEqual(placed.rect, { x: 10, y: 21, width: 50, height: 100 });
  assert.deepEqual(placed.anchor, { x: 25, y: 100 });
  assert.deepEqual(placed.faceRect, { x: 15, y: 5, width: 20, height: 20 });
  assert.equal(placed.variants[0].dataURL, `/vnccs/unicanvas/library/blobs/${SHA}`);
  assert.equal(placed.variants[1].dataURL, "data:image/png;base64,AAAA");
  assert.equal(placed.variants[2].dataURL, undefined);
  assert.equal(placed.sourceLayerId, undefined);
  assert.equal(stored.rect.width, 100, "the stored set is not changed");
  assert.equal(placedSpriteSet(null, { x: 0, y: 0, width: 1, height: 1 }), null);
});

test("a sprite layer saves as a character with its set and inserts back as a sprite layer", async () => {
  const { client, assets } = fakeServer();
  const uc = fakeWidget();
  uc.sprites = fakeSprites();
  const layer = { id: "s1", type: "sprite", name: "Alice sprites", meta: { origin: "sprite", heightFactor: 1 }, canvas: fakeCanvas(),
    sprite: { rect: { x: 100, y: 100, width: 40, height: 100 }, anchor: { x: 20, y: 90 }, activeVariantId: "v1",
      variants: [{ id: "v1", name: "neutral", pixels: fakeCanvas(80, 200) }, { id: "v2", name: "happy", pixels: fakeCanvas(80, 200) }] } };
  uc.layers.push(layer);
  const asset = await saveLayerToLibrary(uc, layer, { kind: "character", name: "Alice", scope: "global" }, client);
  const stored = assets.get(asset.id);
  assert.equal(stored.data.spriteSet.variants.length, 2);
  assert.deepEqual(stored.data.size, { width: 40, height: 100 });
  assert.deepEqual(stored.data.anchor, { x: 0.5, y: 0.9 }, "the set's feet are the anchor");
  assert.deepEqual(uc.sprites.calls[0], ["sync", "s1"]);

  const inserted = await insertAsset(uc, { ...stored, scope: "global" }, { x: 300, y: 400 });
  assert.equal(inserted.type, "sprite");
  assert.deepEqual(inserted.sprite.rect, { x: 280, y: 310, width: 40, height: 100 });
  assert.equal(inserted.sprite.variants.length, 2);
  assert.ok(inserted.sprite.variants.every((variant) => variant.pixels));
  assert.equal(normalizeLayerMeta(inserted.meta).assetId, asset.id);
  assert.equal(uc.history.at(-1).kind, "addLayer");
  assert.deepEqual(uc.filed.at(-1), inserted.id);
  assert.match(uc.statuses.at(-1)[0], /2 sprite variants/);

  // Update from library keeps the place and replaces the set in one history entry.
  const before = uc.history.length;
  await updateLayerFromLibrary(uc, inserted, client);
  assert.equal(uc.history.length, before + 1);
  assert.equal(uc.history.at(-1).kind, "layerPixels");
  assert.deepEqual(inserted.sprite.rect, { x: 280, y: 310, width: 40, height: 100 });
});
