import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  alphaBounds, bakePickerGroups, bakePoseHash, bakeRefHash, bakeRemoveBgRequest, bakeSettingsPayload, bakeStatus, bakeWorkingRect, boxWithin,
  collectBakeCandidates, dilateAlpha, expandBox, extentBeyond, generateBakeLabel, installUniCanvasCharacterBake,
  keepOverlappingComponents, normalizePoseBake, orderBakeParts, refreshBakeStatuses, resolveBakeModel, scaleBakeWithPlacement, subtractAlpha,
} from "../web/vnccs_unicanvas_bake.mjs";

const widget = fs.readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const editor = fs.readFileSync(new URL("../web/vnccs_unicanvas_pose.mjs", import.meta.url), "utf8");

const character = (id, slot, extra = {}) => ({ id, slot, name: `Char ${id}`, color: "#ffffff", poses: [{ bones: { head: [0, 0, slot] } }], ...extra });

function poseLayer(id, characters, refs = {}, extra = {}) {
  return {
    id, type: "pose", name: id, visible: true, locked: false, opacity: 1, groupId: null,
    pose: { rect: { x: 0, y: 0, width: 400, height: 600 }, viewport: { fov: 30 }, studio: { characters, lights: [] }, character: null, characterRefs: refs },
    ...extra,
  };
}

test("a depth-scaled move scales the baked parts and anchors and keeps a matching bake baked", () => {
  const layer = poseLayer("p", [character("a", 0)]);
  const previousRect = { ...layer.pose.rect };
  const part = { surface: {}, rect: { x: -40, y: -60, width: 480, height: 720 }, anchor: { x: 0, y: 0 } };
  layer.bakeParts = { a: part };
  layer.pose.bake = { characters: { a: { status: "baked", poseHash: bakePoseHash(layer.pose, "a"), refHash: "r", headRect: { x: 150, y: 0, width: 100, height: 100 }, feetPoint: { x: 200, y: 600 } } }, showMannequin: false };
  // Scale 0.5 around the feet (200, 600), then move right by 100.
  const scale = 0.5, anchor = { x: 200, y: 600 };
  const point = (p) => ({ x: anchor.x + 100 + (p.x - anchor.x) * scale, y: anchor.y + (p.y - anchor.y) * scale });
  const map = { point, rect: (r) => ({ ...point(r), width: r.width * scale, height: r.height * scale }), scale };
  layer.pose.rect = map.rect(previousRect);
  scaleBakeWithPlacement(layer, map, previousRect);
  assert.notEqual(layer.bakeParts.a, part, "parts are replaced, never mutated (history shares them)");
  assert.deepEqual(layer.bakeParts.a.rect, { x: 180, y: 270, width: 240, height: 360 });
  assert.deepEqual(layer.bakeParts.a.anchor, { x: layer.pose.rect.x, y: layer.pose.rect.y });
  assert.deepEqual(layer.pose.bake.characters.a.feetPoint, { x: 300, y: 600 }, "the feet stay under the cursor");
  assert.deepEqual(layer.pose.bake.characters.a.headRect, { x: 275, y: 300, width: 50, height: 50 });
  assert.equal(bakeStatus([layer], layer, "a"), "stale", "the ref hash of this fixture never matched");
  assert.equal(layer.pose.bake.characters.a.poseHash, bakePoseHash(layer.pose, "a"), "the pose hash follows the new rect");
  // A bake that was already stale for the pose stays stale.
  layer.pose.bake.characters.a.poseHash = "old";
  const before = { ...layer.pose.rect };
  layer.pose.rect = map.rect(before);
  scaleBakeWithPlacement(layer, map, before);
  assert.equal(layer.pose.bake.characters.a.poseHash, "old");
});

test("bake state is additive: old layers read as nothing baked and bad entries are dropped", () => {
  assert.deepEqual(normalizePoseBake(undefined), { characters: {}, showMannequin: false });
  const value = normalizePoseBake({ characters: { a: { status: "baked", poseHash: "1", refHash: "2", seed: "7", headRect: { x: 1, y: 2, width: 3, height: 4 } }, b: "junk", c: { status: "weird" } }, showMannequin: true });
  assert.equal(value.showMannequin, true);
  assert.deepEqual(value.characters.a, { status: "baked", poseHash: "1", refHash: "2", seed: 7, headRect: { x: 1, y: 2, width: 3, height: 4 } });
  assert.equal(value.characters.b, undefined);
  assert.equal(value.characters.c.status, "none");
});

test("the pose hash follows the character, camera, rect size and lights, not the other characters", () => {
  const layer = poseLayer("p", [character("a", 0), character("b", 1)]);
  const base = bakePoseHash(layer.pose, "a");
  layer.pose.studio = { ...layer.pose.studio, characters: [character("a", 0), character("b", 1, { poses: [{ bones: { head: [9, 9, 9] } }] })] };
  assert.equal(bakePoseHash(layer.pose, "a"), base, "posing B does not stale A");
  layer.pose.studio = { ...layer.pose.studio, characters: [character("a", 0, { poses: [{ bones: { head: [1, 1, 1] } }] }), character("b", 1)] };
  const moved = bakePoseHash(layer.pose, "a");
  assert.notEqual(moved, base);
  layer.pose.rect = { ...layer.pose.rect, x: 50 };
  assert.equal(bakePoseHash(layer.pose, "a"), moved, "moving the layer keeps the bake");
  layer.pose.rect = { ...layer.pose.rect, width: 500 };
  assert.notEqual(bakePoseHash(layer.pose, "a"), moved, "resizing the rect stales it");
  const sized = bakePoseHash(layer.pose, "a");
  layer.pose.studio = { ...layer.pose.studio, lights: [{ type: "point" }] };
  assert.notEqual(bakePoseHash(layer.pose, "a"), sized, "lights are part of the hash");
});

test("the reference hash follows the bound layer's pixels and the identity prompt", () => {
  const ref = { id: "ref", type: "raster", visible: true, pixelRevision: 1 };
  const layer = poseLayer("p", [character("a", 0)]);
  layer.pose.character = { source: "layer", layerId: "ref" };
  const layers = [layer, ref];
  const first = bakeRefHash(layers, layer, "a");
  ref.pixelRevision = 2;
  const repainted = bakeRefHash(layers, layer, "a");
  assert.notEqual(repainted, first);
  layer.pose.characterRefs = { a: { source: "layer", layerId: "ref", prompt: "red scarf" } };
  assert.notEqual(bakeRefHash(layers, layer, "a"), repainted);
});

test("a baked character turns stale after an edit, back after undo, and removed mannequins lose their bake", () => {
  const ref = { id: "ref", type: "raster", visible: true, pixelRevision: 1 };
  const layer = poseLayer("p", [character("a", 0), character("b", 1)], { a: { source: "layer", layerId: "ref" }, b: { source: "layer", layerId: "ref" } });
  const layers = [layer, ref];
  layer.bakeParts = { a: { surface: {} }, b: { surface: {} } };
  const entry = (id) => ({ status: "baked", poseHash: bakePoseHash(layer.pose, id), refHash: bakeRefHash(layers, layer, id) });
  layer.pose.bake = { characters: { a: entry("a"), b: entry("b") }, showMannequin: false };
  assert.equal(bakeStatus(layers, layer, "a"), "baked");
  const original = layer.pose.studio;
  layer.pose.studio = { ...original, characters: [character("a", 0, { poses: [] }), character("b", 1)] };
  assert.equal(refreshBakeStatuses(layers, layer), true);
  assert.equal(layer.pose.bake.characters.a.status, "stale");
  assert.equal(layer.pose.bake.characters.b.status, "baked");
  layer.pose.studio = original;
  refreshBakeStatuses(layers, layer);
  assert.equal(layer.pose.bake.characters.a.status, "baked", "undoing the edit makes the bake current again");
  layer.pose.studio = { ...original, characters: [character("a", 0)] };
  refreshBakeStatuses(layers, layer);
  assert.equal(layer.pose.bake.characters.b, undefined);
  assert.equal(layer.bakeParts.b, undefined);
  assert.equal(bakeStatus(layers, layer, "a", { hasPart: false }), "none", "a bake without pixels reads as unbaked");
});

test("the working rect is the pose rect plus 10%, clamped to the world but never smaller than the rect", () => {
  assert.deepEqual(bakeWorkingRect({ x: 100, y: 100, width: 400, height: 600 }), { x: 60, y: 40, width: 480, height: 720 });
  assert.deepEqual(bakeWorkingRect({ x: 0, y: 0, width: 400, height: 600 }, { x: 0, y: 0, width: 420, height: 2000 }), { x: 0, y: 0, width: 420, height: 660 });
});

test("extraction keeps the component touching the mannequin (with hair past it) and drops the rest", () => {
  const width = 20, height = 20;
  const alpha = new Uint8ClampedArray(width * height);
  const silhouette = new Uint8ClampedArray(width * height);
  const set = (array, x1, y1, x2, y2, value = 255) => { for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) array[y * width + x] = value; };
  set(silhouette, 5, 5, 10, 15);
  set(alpha, 5, 3, 10, 15); // body plus hair two pixels above the silhouette
  set(alpha, 15, 15, 18, 18); // a separate prop
  const kept = keepOverlappingComponents(alpha, silhouette, width, height);
  assert.deepEqual(alphaBounds(kept, width, height), { x: 5, y: 3, width: 6, height: 13 });
  assert.equal(kept[16 * width + 16], 0);
  const silBox = alphaBounds(silhouette, width, height);
  assert.equal(extentBeyond(silBox, alphaBounds(kept, width, height)), 2);
  // Baking never moves a character: the kept alpha box stays within 5% of the silhouette box here.
  assert.ok(boxWithin({ x: 100, y: 98, width: 200, height: 404 }, { x: 100, y: 100, width: 200, height: 400 }));
  assert.ok(!boxWithin({ x: 140, y: 100, width: 200, height: 400 }, { x: 100, y: 100, width: 200, height: 400 }));
});

test("A's clip never covers B's visible pixels, even after dilation", () => {
  const width = 10, height = 1;
  const a = dilateAlpha(Uint8ClampedArray.from([0, 0, 255, 255, 255, 0, 0, 0, 0, 0]), width, height, 2);
  const b = Uint8ClampedArray.from([0, 0, 0, 0, 0, 255, 255, 0, 0, 0]);
  const clip = subtractAlpha(a, [b]);
  assert.deepEqual([...clip], [255, 255, 255, 255, 255, 0, 0, 0, 0, 0]);
  assert.deepEqual(expandBox({ x: 10, y: 10, width: 20, height: 40 }, 0.15, 35, 100), { x: 7, y: 4, width: 26, height: 52 });
});

test("GENERATE candidates: bound characters that are unbaked, failed or stale; never unbound, hidden or locked ones", () => {
  const ref = { id: "ref", type: "raster", visible: true, pixelRevision: 1 };
  const scene = poseLayer("scene", [character("a", 0), character("b", 1)], { a: { source: "layer", layerId: "ref" } });
  const hidden = poseLayer("hidden", [character("a", 0)], {}, { visible: false });
  hidden.pose.character = { source: "layer", layerId: "ref" };
  const locked = poseLayer("locked", [character("a", 0)], {}, { locked: true });
  locked.pose.character = { source: "layer", layerId: "ref" };
  const far = poseLayer("far", [character("a", 0)]);
  far.pose.rect = { x: 5000, y: 5000, width: 100, height: 100 };
  far.pose.character = { source: "layer", layerId: "ref" };
  const host = { layers: [scene, hidden, locked, far, ref], bbox: { x: 0, y: 0, width: 512, height: 512 } };
  assert.deepEqual(collectBakeCandidates(host).map((item) => [item.layer.id, item.characterId, item.status]), [["scene", "a", "none"]]);
  scene.bakeParts = { a: { surface: {} } };
  scene.pose.bake = { characters: { a: { status: "baked", poseHash: "old", refHash: bakeRefHash(host.layers, scene, "a") } } };
  assert.deepEqual(collectBakeCandidates(host).map((item) => item.status), ["stale"]);
  assert.deepEqual(collectBakeCandidates(host, { includeStale: false }), []);
  assert.equal(generateBakeLabel(2), "+2 bakes");
  assert.equal(generateBakeLabel(1), "+1 bake");
  assert.equal(generateBakeLabel(0), "");
});

test("the bake model is the current engine when it is QiE2511 / Klein9b, else the Bake model setting", () => {
  const presets = [
    { id: "sdxl", settings: { generation_mode: "sdxl" } },
    { id: "klein", settings: { generation_mode: "flux_klein" } },
    { id: "qie", settings: { generation_mode: "qwen_image_edit" } },
  ];
  const ready = new Set(["qie"]);
  const presetReady = (preset) => ready.has(preset.id);
  assert.deepEqual(resolveBakeModel({}, { currentBase: "flux_klein", presets, presetReady }), { useCurrent: true, family: "flux_klein" });
  assert.equal(resolveBakeModel({}, { currentBase: "sdxl", presets, presetReady }).preset.id, "qie", "first ready preset of a bake family");
  const klein = resolveBakeModel({ bake_model_family: "flux_klein" }, { currentBase: "sdxl", presets, presetReady });
  assert.equal(klein.preset.id, "klein"); assert.equal(klein.ready, false);
  assert.ok(resolveBakeModel({}, { currentBase: "sdxl", presets: [presets[0]], presetReady }).error);
  const settings = bakeSettingsPayload({ steps: 30, cfg: 7, lora_stack: [{ name: "x" }], bake_steps: 6, seed: 1, queued_draw: {} },
    { model: { preset: presets[2] }, defaults: { steps: 4, cfg: 1, qwen_2511: true }, positive: "p", seed: 9, batch: 3 });
  assert.equal(settings.generation_mode, "qwen_image_edit");
  assert.equal(settings.steps, 6); assert.equal(settings.cfg, 1); assert.deepEqual(settings.lora_stack, []);
  assert.equal(settings.denoise, 1); assert.equal(settings.seed, 9); assert.equal(settings.batch_size, 3);
  assert.equal(settings.queued_draw, undefined);
  assert.equal(bakeRemoveBgRequest({ remove_bg_method: "sam3" }).method, "birefnet", "interactive SAM falls back to BiRefNet");
  assert.deepEqual(orderBakeParts([{ id: "front", feetY: 500 }, { id: "back", feetY: 300 }]).map((item) => item.id), ["back", "front"]);
});

test("baked parts order back to front by camera depth, and by feet only for bakes without one", () => {
  // A far character standing lower on screen (e.g. a camera looking down) is still drawn first.
  const parts = [{ id: "near", feetY: 300, depth: 2 }, { id: "far", feetY: 500, depth: 6 }, { id: "mid", feetY: 400, depth: 4 }];
  assert.deepEqual(orderBakeParts(parts).map((item) => item.id), ["far", "mid", "near"]);
  assert.deepEqual(orderBakeParts([{ id: "a", feetY: 500, depth: 6 }, { id: "b", feetY: 300 }]).map((item) => item.id), ["b", "a"]);
  assert.equal(normalizePoseBake({ characters: { a: { status: "baked", depth: 3.5 } } }).characters.a.depth, 3.5);
  assert.equal(normalizePoseBake({ characters: { a: { status: "baked" } } }).characters.a.depth, undefined);
});

function controllerHarness() {
  const ref = { id: "ref", type: "raster", visible: true, pixelRevision: 1 };
  const bound = poseLayer("bound", [character("a", 0)]);
  bound.pose.character = { source: "layer", layerId: "ref" };
  const unbound = poseLayer("unbound", [character("b", 0)]);
  const history = [];
  const statuses = [];
  const uc = {
    layers: [bound, unbound, ref], bbox: { x: 0, y: 0, width: 512, height: 512 }, settings: {}, tool: "move",
    origin: { x: 0, y: 0 }, size: { width: 2048, height: 2048 }, drawBtn: { disabled: false },
    createLayerPixelSnapshot: (layer) => ({ id: layer.id, pose: JSON.parse(JSON.stringify(layer.pose)) }),
    pushHistoryEntry(entry) { entry = uc.poseBake.wrapHistoryEntry(entry); history.push(entry); },
    setStatus: (text, error) => statuses.push([text, Boolean(error)]),
    updateGenerationProgress: () => {}, syncToNode: () => {}, renderLayerList: () => {}, refreshLayerRow: () => {},
    requestRender: () => {}, invalidateLayerCaches: () => {}, getModelBase: () => "sdxl",
  };
  installUniCanvasCharacterBake(uc);
  const baked = [];
  uc.poseBake.runBake = async (layer, characterId) => { baked.push([layer.id, characterId]); return { results: [{ seed: 1 }], meta: {} }; };
  uc.poseBake.applyBake = (layer, characterId) => {
    layer.pose.bake = { characters: { [characterId]: { status: "baked" } }, showMannequin: false };
  };
  return { uc, bound, unbound, history, statuses, baked };
}

test("GENERATE bakes only the bound mannequin, then one undo covers the bakes and the accepted scene", async () => {
  const { uc, history, baked } = controllerHarness();
  assert.equal(await uc.poseBake.beforeScenePass(), true);
  assert.deepEqual(baked, [["bound", "a"]], "exactly one bake: the unbound mannequin goes to the scene pass as is");
  assert.equal(history.length, 0, "the bakes wait for the scene result");
  assert.equal(uc.poseBake.pending.length, 1);
  uc.pushHistoryEntry({ kind: "acceptStaging", layer: { id: "result" } });
  assert.equal(history.length, 1);
  assert.equal(history[0].kind, "historyGroup");
  assert.deepEqual(history[0].entries.map((entry) => entry.kind), ["layerPixels", "acceptStaging"]);
  assert.equal(uc.poseBake.pending, null);
});

test("pending bakes become their own undo step when anything else is recorded first", async () => {
  const { uc, history } = controllerHarness();
  await uc.poseBake.beforeScenePass();
  uc.pushHistoryEntry({ kind: "layerProps", layerId: "ref" });
  assert.deepEqual(history.map((entry) => entry.kind), ["historyGroup", "layerProps"]);
});

test("with nothing to bake GENERATE is today's GENERATE, and a failed bake blocks the scene pass", async () => {
  const { uc, bound, history, statuses, baked } = controllerHarness();
  bound.pose.character = null;
  assert.equal(await uc.poseBake.beforeScenePass(), true);
  assert.equal(baked.length, 0);
  assert.equal(uc.poseBake.pending, null);
  bound.pose.character = { source: "layer", layerId: "ref" };
  uc.poseBake.runBake = async () => { throw new Error("out of memory"); };
  assert.equal(await uc.poseBake.beforeScenePass(), false);
  assert.equal(bound.pose.bake.characters.a.status, "failed");
  assert.equal(bound.pose.bake.characters.a.error, "out of memory");
  assert.match(statuses.at(-1)[0], /scene was not generated/);
  assert.equal(history.length, 1, "the failed attempt is still one undo step");
  assert.equal(uc.drawInProgress, false);
});

test("the widget and editor only receive hook calls", () => {
  assert.match(widget, /installUniCanvasCharacterBake\(this, \{ createEditor: \(\) => new UniCanvasPoseEditor\(this\), modelModule: getUniCanvasModelModule \}\)/);
  assert.match(widget, /if \(staging\.bake\) return this\.poseBake\?\.acceptStaged\(staging\)/);
  assert.match(widget, /entry = this\.poseBake\?\.wrapHistoryEntry\(entry\) \?\? entry/);
  assert.match(widget, /getInferenceSize\(rect = this\.bbox\)/);
  assert.match(widget, /if \(bakePixels\) payload\.bakePixels = bakePixels/);
  assert.match(editor, /this\.layer\.mannequinSurface = surface/);
  assert.match(editor, /this\.host\.poseBake\?\.afterCommit\(this\.layer\)/);
});

test("the Bake model picker groups presets by enabled bake family and keeps the chosen family", () => {
  const presets = [
    { id: "qie", settings: { generation_mode: "qwen_image_edit" } },
    { id: "klein", settings: { generation_mode: "flux_klein" } },
    { id: "sdxl", settings: { generation_mode: "sdxl" } },
  ];
  const all = bakePickerGroups(presets);
  assert.deepEqual(all.map((group) => [group.family, group.presets.map((preset) => preset.id)]), [["qwen_image_edit", ["qie"]], ["flux_klein", ["klein"]]]);
  const off = (family) => family !== "flux_klein";
  assert.deepEqual(bakePickerGroups(presets, { familyEnabled: off }).map((group) => group.family), ["qwen_image_edit"]);
  assert.deepEqual(bakePickerGroups(presets, { familyEnabled: off, current: "flux_klein" }).map((group) => group.family), ["qwen_image_edit", "flux_klein"]);
  assert.deepEqual(bakePickerGroups([], {}), []);
});

test("a staged card bake hides its character's mannequin until the staging is gone", () => {
  const fakeCanvas = (width, height, name = "canvas") => {
    const draws = [];
    return { name, width, height, draws, getContext: () => ({
      clearRect: () => draws.length = 0, drawImage: (image) => draws.push(image.name || "image"),
      globalCompositeOperation: "source-over",
    }) };
  };
  const layer = poseLayer("p", [character("a", 0)]);
  layer.canvas = fakeCanvas(2048, 2048, "layer");
  layer.mannequinSurface = fakeCanvas(400, 600, "mannequin");
  const uc = {
    layers: [layer], settings: {}, tool: "move", origin: { x: 0, y: 0 }, stagingItems: [], activeStagingIndex: -1,
    _createCanvas: (w, h) => fakeCanvas(w, h, "view"), invalidateLayerCaches: () => {}, requestRender: () => {},
  };
  installUniCanvasCharacterBake(uc);
  uc.poseBake.syncStagingView();
  assert.notEqual(layer._bakeViewBaked, true, "nothing staged: the layer keeps its mannequin pixels");

  uc.stagingItems = [{ visible: true, bake: { layerId: "p", characterId: "a" } }];
  uc.activeStagingIndex = 0;
  uc.poseBake.syncStagingView();
  assert.equal(layer._bakeViewBaked, true);
  assert.equal(layer.hiresCanvas.draws.includes("mannequin"), false, "the staged character's mannequin is hidden");

  uc.stagingItems[0].visible = false;
  uc.poseBake.syncStagingView();
  assert.equal(layer._bakeViewBaked, false, "a hidden staging item shows the mannequin again");
  assert.equal(layer.hiresCanvas, layer.mannequinSurface);

  uc.stagingItems[0].visible = true;
  uc.poseBake.syncStagingView();
  assert.equal(layer._bakeViewBaked, true);
  uc.stagingItems = []; uc.activeStagingIndex = -1;
  uc.poseBake.syncStagingView();
  assert.equal(layer._bakeViewBaked, false, "discarding the staging brings the mannequin back");
  assert.deepEqual(layer.canvas.draws, ["mannequin"]);
});
