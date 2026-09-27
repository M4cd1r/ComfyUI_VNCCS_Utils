import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  alphaBounds, BAKE_FAMILIES, bakeFamilies, bakePickerGroups, bakePoseHash, bakeRefHash, bakeRemoveBgRequest, bakeSettingsPayload, bakeStatus, bakeWorkingRect, boxWithin,
  collectBakeCandidates, dilateAlpha, expandBox, extentBeyond, generateBakeLabel, installUniCanvasCharacterBake,
  keepOverlappingComponents, normalizePoseBake, orderBakeParts, poseStudioLoraBanner, refreshBakeStatuses, resolveBakeModel, scaleBakeWithPlacement, skipPoseStudioLoraVersion, subtractAlpha,
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

test("a missing Pose Studio LoRA blocks the bake; an offline or skipped check never does", async () => {
  // The backend report says the family's LoRA is not installed: blocked, with a Download hint.
  const missing = controllerHarness();
  missing.uc.poseBake.fetchPoseStudioLoras = async () => ({
    qwen_image_edit: { installed: null, latest: { version: "ART_V6" }, update_available: false },
  });
  const blocked = await missing.uc.poseBake.ensurePoseStudioLora("qwen_image_edit");
  assert.equal(blocked.blocked, true);
  // HF offline (the fetch fails): the state stays unknown, the bake runs.
  const offline = controllerHarness();
  offline.uc.poseBake.fetchPoseStudioLoras = async () => { throw new Error("offline"); };
  const unknown = await offline.uc.poseBake.ensurePoseStudioLora("qwen_image_edit");
  assert.equal(unknown.blocked, false);
  assert.equal(unknown.name, "");
  // Installed: the highest version's file name rides along, with the settings' strength.
  const installed = controllerHarness();
  installed.uc.settings.pose_studio_lora_strength = 1.25;
  installed.uc.poseBake.fetchPoseStudioLoras = async () => ({
    qwen_image_edit: { installed: { version: "ART_V6", name: "PoseStudio_QiE_ART_V6.safetensors" }, latest: { version: "ART_V6" }, update_available: false },
  });
  const lora = await installed.uc.poseBake.ensurePoseStudioLora("qwen_image_edit");
  assert.equal(lora.blocked, false);
  assert.equal(lora.name, "PoseStudio_QiE_ART_V6.safetensors");
  assert.equal(lora.strength, 1.25);
  assert.equal(installed.uc.settings.pose_studio_lora_name, "PoseStudio_QiE_ART_V6.safetensors", "the settings key follows the highest installed version");
  // Out-of-range strengths clamp into 0–1.5; junk reads as the default 1.
  installed.uc.settings.pose_studio_lora_strength = 9;
  assert.equal((await installed.uc.poseBake.ensurePoseStudioLora("qwen_image_edit")).strength, 1.5);
  installed.uc.settings.pose_studio_lora_strength = "junk";
  assert.equal((await installed.uc.poseBake.ensurePoseStudioLora("qwen_image_edit")).strength, 1);
});

test("the LoRA download enqueues through the shared queue and refreshes the family report", async () => {
  const { uc, statuses } = controllerHarness();
  const posted = [];
  uc.presetDownloads = {};
  uc.poseBake.startPoseStudioLoraDownload = async (family, version) => {
    posted.push([family, version]);
    uc.presetDownloads["pose_lora:qwen_image_edit:ART_V7"] = { status: "success", progress: 1 };
    return ["pose_lora:qwen_image_edit:ART_V7"];
  };
  uc.poseBake.fetchPoseStudioLoras = async () => ({
    qwen_image_edit: { installed: { version: "ART_V7", name: "PoseStudio_QiE_ART_V7.safetensors" }, latest: { version: "ART_V7" }, update_available: false },
  });
  await uc.poseBake.downloadPoseStudioLora("qwen_image_edit", "ART_V7");
  assert.deepEqual(posted, [["qwen_image_edit", "ART_V7"]]);
  assert.deepEqual(uc.poseBake.poseLoraStatus().qwen_image_edit.installed, { version: "ART_V7", name: "PoseStudio_QiE_ART_V7.safetensors" });
  // A failed enqueue surfaces in the status bar and never throws out of the row's click handler.
  const failing = controllerHarness();
  failing.uc.poseBake.startPoseStudioLoraDownload = async () => { throw new Error("HF 404"); };
  await failing.uc.poseBake.downloadPoseStudioLora("qwen_image_edit", "V9");
  assert.match(failing.statuses.at(-1)[0], /Pose Studio LoRA download failed: HF 404/);
});

test("a frozen download status ends the wait; progress-only movement is never a stall", async () => {
  // refreshPresetDownloadStatus swallows its own errors, so a dead backend just leaves the
  // watched entries frozen: the wait must exit after the stall threshold instead of polling
  // forever, re-enable the row and say how to recover.
  const { uc, statuses } = controllerHarness();
  uc.presetDownloads = {};
  uc.poseBake.startPoseStudioLoraDownload = async () => {
    uc.presetDownloads["lora-job"] = { status: "downloading", message: "Downloading", progress: 0.4 };
    return ["lora-job"];
  };
  uc.poseBake.poseLoraPollMs = 1;
  uc.poseBake.poseLoraStallLimit = 3;
  uc.refreshPresetDownloadStatus = async () => { /* nothing changes at all, the callee never rejects */ };
  uc.poseBake.fetchPoseStudioLoras = async () => ({
    qwen_image_edit: { installed: { version: "ART_V6", name: "PoseStudio_QiE_ART_V6.safetensors" }, latest: { version: "ART_V6" }, update_available: false },
  });
  await uc.poseBake.downloadPoseStudioLora("qwen_image_edit", "ART_V7");
  assert.match(statuses.at(-1)[0], /shows no progress\. Check for updates or start the download again\./);
  assert.equal(uc.poseBake.poseLoraStatus().qwen_image_edit.installed.version, "ART_V6", "the report was force-refreshed before the bail-out");
  // A healthy download keeps `status: "downloading"` for minutes while only `progress` climbs:
  // the stall detector must watch the progress too, so the loop polls past the stall limit on
  // progress-only movement (only the settled job ends it).
  const moving = controllerHarness();
  moving.uc.presetDownloads = {};
  moving.uc.poseBake.startPoseStudioLoraDownload = async () => {
    moving.uc.presetDownloads["lora-job"] = { status: "downloading", message: "Downloading", progress: 0 };
    return ["lora-job"];
  };
  moving.uc.poseBake.poseLoraPollMs = 1;
  moving.uc.poseBake.poseLoraStallLimit = 2;
  let movingPolls = 0;
  moving.uc.refreshPresetDownloadStatus = async () => {
    movingPolls++;
    // Progress only: the status stays "downloading" until the very last poll settles the job.
    const job = moving.uc.presetDownloads["lora-job"];
    job.progress = Math.min(1, job.progress + 0.2);
    if (job.progress >= 1) job.status = "success";
  };
  moving.uc.poseBake.fetchPoseStudioLoras = async () => ({
    qwen_image_edit: { installed: { version: "ART_V7", name: "PoseStudio_QiE_ART_V7.safetensors" }, latest: { version: "ART_V7" }, update_available: false },
  });
  await moving.uc.poseBake.downloadPoseStudioLora("qwen_image_edit", "ART_V7");
  assert.ok(movingPolls > 2, "progress-only movement carried the loop past the stall limit");
  assert.equal(moving.statuses.some(([text]) => /no progress/.test(text)), false);
  assert.equal(moving.uc.poseBake.poseLoraStatus().qwen_image_edit.installed.version, "ART_V7");
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

test("the layer row's Show mannequin button toggles both ways (the row is updated in place)", () => {
  const fakeCanvas = (width, height, name = "canvas") => ({ name, width, height, getContext: () => ({
    clearRect: () => {}, drawImage: () => {}, globalCompositeOperation: "source-over",
  }) });
  const layer = poseLayer("p", [character("a", 0)]);
  layer.canvas = fakeCanvas(2048, 2048, "layer");
  layer.mannequinSurface = fakeCanvas(400, 600, "mannequin");
  layer.bakeParts = { a: { surface: fakeCanvas(400, 600, "part"), rect: { x: 0, y: 0, width: 400, height: 600 }, anchor: { x: 0, y: 0 } } };
  layer.pose.bake = { characters: { a: { status: "baked" } }, showMannequin: false };
  const button = () => {
    const listeners = [];
    return { dataset: {}, style: {}, attrs: {}, textContent: "", title: "", listeners,
      addEventListener: (type, fn) => listeners.push([type, fn]), setAttribute(name, value) { this.attrs[name] = value; } };
  };
  const uc = {
    layers: [layer], settings: {}, tool: "move", origin: { x: 0, y: 0 }, stagingItems: [], activeStagingIndex: -1,
    _createCanvas: (w, h) => fakeCanvas(w, h, "view"), _button: button,
    invalidateLayerCaches: () => {}, requestRender: () => {}, refreshLayerRow: () => {}, syncToNode: () => {},
  };
  installUniCanvasCharacterBake(uc);
  let toggle = null;
  uc.poseBake.decorateLayerRow({ querySelector: () => null, appendChild: (el) => { toggle = el; } }, layer);
  const click = () => toggle.listeners.filter(([type]) => type === "click").forEach(([, fn]) => fn({ stopPropagation() {} }));
  assert.equal(toggle.textContent, "Show mannequin");
  click();
  assert.equal(layer.pose.bake.showMannequin, true);
  assert.equal(toggle.textContent, "Show baked");
  assert.equal(toggle.attrs["aria-pressed"], "true");
  click();
  assert.equal(layer.pose.bake.showMannequin, false);
  assert.equal(toggle.textContent, "Show mannequin");
});

test("the bake families come from the backend descriptors' supports_pose_edit, with the fixed list as fallback", () => {
  assert.deepEqual(bakeFamilies(null), BAKE_FAMILIES);
  assert.deepEqual(bakeFamilies(new Map()), BAKE_FAMILIES);
  const qie = { key: "qwen_image_edit", capabilities: { label: "Qwen Edit", supports_pose_edit: true } };
  const klein = { key: "flux_klein", capabilities: { label: "Flux Klein", supports_pose_edit: true } };
  const sdxl = { key: "sdxl", capabilities: { label: "SDXL", supports_pose_edit: false } };
  const fresh = { key: "new_edit", capabilities: { label: "New Edit", supports_pose_edit: true } };
  // Backend registry order (klein before qie) and alias duplicates keep the known order and labels.
  const index = new Map([["sdxl", sdxl], ["flux_klein", klein], ["klein", klein], ["new_edit", fresh], ["qwen_image_edit", qie]]);
  assert.deepEqual(bakeFamilies(index), [["qwen_image_edit", "QiE2511"], ["flux_klein", "Klein9b"], ["new_edit", "New Edit"]]);
  const families = bakeFamilies(new Map([["new_edit", fresh]]));
  const presets = [{ id: "n", settings: { generation_mode: "new_edit" } }, { id: "qie", settings: { generation_mode: "qwen_image_edit" } }];
  assert.deepEqual(bakePickerGroups(presets, { families }).map((group) => group.family), ["new_edit"]);
  assert.deepEqual(resolveBakeModel({}, { currentBase: "new_edit", presets, families }), { useCurrent: true, family: "new_edit" });
  assert.match(resolveBakeModel({}, { currentBase: "sdxl", presets: [], families }).error, /needs New Edit:/);
  assert.match(resolveBakeModel({}, { currentBase: "sdxl", presets: [] }).error, /needs QiE2511 or Klein9b or H3 or QI2\.1:/);
});

const BAKE_TEST_LOADERS = [
  {
    key: "checkpoint", label: "Checkpoint",
    fields: [{ setting: "ckpt_name", label: "Checkpoint", asset: "checkpoints" }],
    validate: (settings) => (settings.ckpt_name ? null : "Select a checkpoint first"),
  },
  {
    key: "gguf", label: "GGUF",
    fields: [
      { setting: "gguf_model_name", label: "GGUF Model", asset: "gguf_models" },
      { setting: "gguf_arch", label: "Architecture", asset: "gguf_architectures" },
      { setting: "clip_name", label: "CLIP", asset: "text_encoders" },
      { setting: "vae_name", label: "VAE", asset: "vae_models" },
    ],
    validate: (settings) => (settings.gguf_model_name && settings.clip_name && settings.vae_name ? null : "Select GGUF model, CLIP and VAE first"),
  },
];
const BAKE_CUSTOM_OK = {
  bake_model_source: "custom",
  bake_custom: {
    generation_mode: "qwen_image_edit", model_loader: "gguf", gguf_model_name: "qwen-image-edit-2511-Q5_0.gguf",
    clip_name: "qwen_2.5_vl.safetensors", vae_name: "qwen_image_vae.safetensors", gguf_arch: "auto",
  },
};
const BAKE_CUSTOM_FAMILIES = [["qwen_image_edit", "QiE2511"], ["flux_klein", "Klein9b"]];

test("the Custom (installed files) source resolves bake_custom through the shared loader definitions", () => {
  const model = resolveBakeModel(BAKE_CUSTOM_OK, { currentBase: "sdxl", presets: [], families: BAKE_CUSTOM_FAMILIES, loaders: BAKE_TEST_LOADERS });
  assert.equal(model.family, "qwen_image_edit");
  assert.equal(model.ready, true);
  assert.equal(model.custom.gguf_model_name, "qwen-image-edit-2511-Q5_0.gguf");
  assert.equal(model.custom.clip_name, "qwen_2.5_vl.safetensors");
  assert.equal(model.custom.gguf_arch, "auto");
  assert.equal(model.label, "qwen-image-edit-2511-Q5_0");
  // An incomplete pick (no VAE) reads as an error naming the missing piece, never as a crash.
  const incomplete = resolveBakeModel(
    { bake_model_source: "custom", bake_custom: { generation_mode: "qwen_image_edit", model_loader: "gguf", gguf_model_name: "q.gguf", clip_name: "c.safetensors" } },
    { currentBase: "sdxl", families: BAKE_CUSTOM_FAMILIES, loaders: BAKE_TEST_LOADERS });
  assert.match(incomplete.error, /incomplete: Select GGUF model, CLIP and VAE first/);
  // A non-bake family (the scene engine) is a wrong pick: the family must be a bake family.
  const wrong = resolveBakeModel(
    { bake_model_source: "custom", bake_custom: { generation_mode: "sdxl", model_loader: "checkpoint", ckpt_name: "a.safetensors" } },
    { currentBase: "sdxl", families: BAKE_CUSTOM_FAMILIES, loaders: BAKE_TEST_LOADERS });
  assert.match(wrong.error, /Choose the family/);
  // Without the hook's definitions (old widget, plain harness) the source degrades to an error.
  assert.match(resolveBakeModel(BAKE_CUSTOM_OK, { currentBase: "sdxl", families: BAKE_CUSTOM_FAMILIES }).error, /Choose a loader/);
  assert.match(resolveBakeModel({ bake_model_source: "custom" }, { currentBase: "sdxl", families: BAKE_CUSTOM_FAMILIES, loaders: BAKE_TEST_LOADERS }).error, /Choose the family/);
});

test("the bake source selects Automatic, the picked preset, or the Custom files; old settings keep working", () => {
  const presets = [
    { id: "klein", settings: { generation_mode: "flux_klein" } },
    { id: "qie", settings: { generation_mode: "qwen_image_edit" } },
  ];
  const ready = () => true;
  const options = { currentBase: "sdxl", presets, presetReady: ready, families: BAKE_CUSTOM_FAMILIES };
  // "Automatic" ignores the stored preset pick; "preset" honors it; a missing source keeps the
  // older behavior (the stored preset pick wins).
  assert.equal(resolveBakeModel({ bake_model_source: "auto", bake_preset_id: "klein" }, options).preset.id, "qie");
  assert.equal(resolveBakeModel({ bake_model_source: "preset", bake_preset_id: "klein" }, options).preset.id, "klein");
  assert.equal(resolveBakeModel({ bake_preset_id: "klein" }, options).preset.id, "klein");
  // The current engine still bakes, whatever the source says.
  assert.deepEqual(resolveBakeModel({ bake_model_source: "custom", bake_custom: {} }, { ...options, currentBase: "flux_klein" }), { useCurrent: true, family: "flux_klein" });
});

test("the bake payload carries the custom files and the Pose Studio LoRA, also for useCurrent", () => {
  const model = resolveBakeModel(BAKE_CUSTOM_OK, { currentBase: "sdxl", presets: [], families: BAKE_CUSTOM_FAMILIES, loaders: BAKE_TEST_LOADERS });
  const payload = bakeSettingsPayload(
    { lora_stack: [{ name: "scene-lora" }], pose_studio_lora_strength: 1.25, steps: 30, bake_steps: 6, queued_draw: {} },
    { model, defaults: { steps: 4, cfg: 1, clip_type: "qwen_image" }, positive: "p", seed: 3, batch: 1,
      poseStudioLora: { name: "PoseStudio_QiE_ART_V6.safetensors", strength: 1.25 } });
  assert.equal(payload.model_selection_mode, "custom");
  assert.equal(payload.generation_mode, "qwen_image_edit");
  assert.equal(payload.model_loader, "gguf");
  assert.equal(payload.gguf_model_name, "qwen-image-edit-2511-Q5_0.gguf");
  assert.equal(payload.clip_name, "qwen_2.5_vl.safetensors");
  assert.equal(payload.vae_name, "qwen_image_vae.safetensors");
  assert.equal(payload.gguf_arch, "auto");
  assert.equal(payload.clip_type, "qwen_image", "the family default survives the pick");
  assert.deepEqual(payload.lora_stack, []);
  assert.equal(payload.pose_studio_lora_name, "PoseStudio_QiE_ART_V6.safetensors");
  assert.equal(payload.pose_studio_lora_strength, 1.25);
  assert.equal(payload.queued_draw, undefined);
  // useCurrent carries the LoRA keys too.
  const current = bakeSettingsPayload({ generation_mode: "qwen_image_edit" }, {
    model: { useCurrent: true, family: "qwen_image_edit" }, positive: "", seed: 1,
    poseStudioLora: { name: "PoseStudio_QiE_ART_V6.safetensors", strength: 0.5 },
  });
  assert.equal(current.pose_studio_lora_name, "PoseStudio_QiE_ART_V6.safetensors");
  assert.equal(current.pose_studio_lora_strength, 0.5);
  // The strength defaults to 1 and clamps into 0–1.5; without a name nothing junk is written.
  assert.equal(bakeSettingsPayload({}, { model: { useCurrent: true, family: "f" }, positive: "", seed: 1, poseStudioLora: { name: "n", strength: 9 } }).pose_studio_lora_strength, 1.5);
  const nameless = bakeSettingsPayload({ pose_studio_lora_name: "kept.safetensors" }, { model: { useCurrent: true, family: "f" }, positive: "", seed: 1 });
  assert.equal(nameless.pose_studio_lora_name, "kept.safetensors", "an unknown status still sends the stored name");
  assert.equal(nameless.pose_studio_lora_strength, 1);
});

test("the Pose Studio LoRA banner: update_available, skipping one version, the next higher asks again", () => {
  const entry = (installed, latest, update = true) => ({
    installed: installed ? { version: installed, name: `${installed}.safetensors` } : null,
    latest: latest ? { version: latest, name: `${latest}.safetensors` } : null,
    update_available: update,
  });
  assert.deepEqual(poseStudioLoraBanner(entry("V1", "V2"), {}, "qwen_image_edit"), { installed: "V1", latest: "V2", name: "V2.safetensors" });
  assert.equal(poseStudioLoraBanner(entry("V1", "V2", false), {}, "f"), null, "no update, no banner");
  assert.equal(poseStudioLoraBanner(entry("V2", "V2", true), {}, "f"), null, "equal versions are no update");
  assert.equal(poseStudioLoraBanner(entry(null, "V2"), {}, "f"), null, "nothing installed: the Download row, not the update banner");
  assert.equal(poseStudioLoraBanner(null, {}, "f"), null);
  assert.deepEqual(poseStudioLoraBanner(entry("V1", "V2"), null, ""), { installed: "V1", latest: "V2", name: "V2.safetensors" });
  // Skipping one version silences exactly that version; the next higher one asks again.
  const skipped = skipPoseStudioLoraVersion({}, "qwen_image_edit", "V2");
  assert.deepEqual(skipped, { qwen_image_edit: "V2" });
  assert.equal(poseStudioLoraBanner(entry("V1", "V2"), skipped, "qwen_image_edit"), null);
  assert.ok(poseStudioLoraBanner(entry("V1", "V3"), skipped, "qwen_image_edit"));
  assert.deepEqual(poseStudioLoraBanner(entry("V1", "V2"), skipped, "flux_klein"), { installed: "V1", latest: "V2", name: "V2.safetensors" }, "other families are unaffected");
  // The skip map is a copy: the settings object it came from is never mutated.
  const stored = { qwen_image_edit: "V1" };
  skipPoseStudioLoraVersion(stored, "qwen_image_edit", "V2");
  assert.deepEqual(stored, { qwen_image_edit: "V1" });
  assert.deepEqual(skipPoseStudioLoraVersion(null, "f", "V1"), { f: "V1" });
});

test("the bake custom panel reads the loader definitions through the uc.modelLoaderFields hook", () => {
  assert.match(widget, /function uniCanvasModelLoaderFields\(\)/);
  assert.match(widget, /this\.modelLoaderFields = uniCanvasModelLoaderFields/);
  const bake = fs.readFileSync(new URL("../web/vnccs_unicanvas_bake.mjs", import.meta.url), "utf8");
  assert.match(bake, /uc\.modelLoaderFields\?\.\(\)/);
  assert.doesNotMatch(bake, /UNICANVAS_MODEL_LOADERS/, "the definitions are never copied into bake.mjs");
});
