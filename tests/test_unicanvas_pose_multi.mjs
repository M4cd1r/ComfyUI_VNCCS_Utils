import test from "node:test";
import assert from "node:assert/strict";
import * as state from "../web/vnccs_unicanvas_pose_state.mjs";
import * as scene from "../web/vnccs_unicanvas_pose_scene.mjs";
import { LAYER_MENU_ITEMS, layerMenuItemAvailable } from "../web/vnccs_unicanvas_layer_tools.mjs";
import { restoreGroupStructure } from "../web/vnccs_unicanvas_groups.mjs";

const clone = value => JSON.parse(JSON.stringify(value));
const character = (id, slot, extra = {}) => ({ id, slot, name: extra.name || `Character ${slot + 1}`, color: extra.color || "#ffffff",
    transform: { x: slot, y: 0, z: 0, zoom: 1 }, mesh: {}, poses: [{ bones: { hips: [slot, 0, 0] } }], animation: null, ...extra });
const upload = name => ({ source: "upload", name, dataURL: `data:image/png;base64,${name}` });
const poseLayer = (id, characters, extra = {}) => ({ id, name: id, type: "pose", visible: true, locked: false, opacity: 1,
    blendMode: "source-over", groupId: null, pose: { version: 1, rect: { x: 0, y: 0, width: 4, height: 2 },
        viewport: { position: [0, 1, 5], target: [0, 1, 0], fov: 40, zoom: 1 },
        studio: { characters, active_character_id: characters[0]?.id, export: { view_width: 4, view_height: 2 }, mesh: {}, poses: [{}] },
        character: null, ...extra } });

// Minimal 2D canvas backed by an RGBA buffer, enough for the ID pass readers.
class PixelCanvas {
    constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4); this.draws = []; }
    getContext() {
        const canvas = this;
        return {
            getImageData: () => ({ data: canvas.data }),
            createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
            putImageData: image => { canvas.data = image.data; },
            drawImage: (...args) => canvas.draws.push(args), clearRect() {}, save() {}, restore() {},
            set globalCompositeOperation(value) { canvas.composite = value; }, set globalAlpha(value) { canvas.alpha = value; },
        };
    }
    set(x, y, [r, g, b], a = 255) { const o = (y * this.width + x) * 4; this.data.set([r, g, b, a], o); }
    toDataURL() { return "data:image/png;base64,id"; }
}

test("the first mannequin's reference is also pose.character; single layers keep the legacy shape", () => {
    const legacy = poseLayer("legacy", []);
    delete legacy.pose.studio.characters;
    state.setPoseCharacterRef(legacy.pose, state.poseStudioCharacters(legacy.pose)[0].id, upload("a"));
    assert.equal(legacy.pose.character.name, "a");
    assert.equal(legacy.pose.characterRefs, undefined, "a single mannequin writes only the legacy field");
    assert.equal(state.poseCharacterRef(legacy, "character-1").name, "a");

    const layer = poseLayer("pose", [character("c1", 0), character("c2", 1)]);
    layer.pose.character = upload("legacy");
    assert.equal(state.poseCharacterRef(layer, "c1").name, "legacy", "the first mannequin falls back to pose.character");
    assert.equal(state.poseCharacterRef(layer, "c2"), null);
    state.setPoseCharacterRef(layer.pose, "c2", upload("b"));
    state.setPoseCharacterRef(layer.pose, "c1", upload("a"));
    assert.equal(layer.pose.character.name, "a");
    assert.equal(layer.pose.characterRefs.c1.name, "a");
    assert.equal(state.poseCharacterRef(layer, "c2").name, "b");
    state.setPoseCharacterPrompt(layer.pose, "c2", "  red-haired girl  ");
    assert.equal(state.poseCharacterPrompt(layer, "c2"), "red-haired girl");
    assert.equal(state.poseCharacterRef(layer, "c2").prompt, undefined, "the prompt is not part of the reference");
    state.setPoseCharacterRef(layer.pose, "c2", null);
    assert.deepEqual(layer.pose.characterRefs.c2, { prompt: "red-haired girl" }, "Clear keeps the identity prompt");
    state.setPoseCharacterRef(layer.pose, "c1", null);
    assert.equal(layer.pose.character, null);
});

test("poseCharacterIssues reports one issue per unbound mannequin with the legacy messages", () => {
    const host = { layers: [] };
    const single = poseLayer("single", [character("c1", 0)]);
    host.layers = [single];
    assert.equal(state.poseCharacterIssue(host, single), "Choose a character image from a layer or upload one, then press Generate.");
    single.pose.character = { source: "upload", name: "x" };
    assert.equal(state.poseCharacterIssue(host, single), "The character image is missing. Upload it again.");

    const layer = poseLayer("pose", [character("c1", 0, { name: "Alice" }), character("c2", 1, { name: "Bob" }), character("c3", 2)]);
    host.layers = [layer];
    state.setPoseCharacterRef(layer.pose, "c2", upload("b"));
    const issues = state.poseCharacterIssues(host, layer);
    assert.deepEqual(issues.map(item => item.characterId), ["c1", "c3"]);
    assert.match(state.poseCharacterIssue(host, layer), /^Alice: Choose a character image/);
    state.setPoseCharacterRef(layer.pose, "c3", { source: "layer", layerId: "gone" });
    assert.match(state.poseCharacterIssues(host, layer)[1].issue, /no longer exists/);
});

test("workflow metadata drops uploaded pixels of every reference and the state cache restores them per id", () => {
    const layer = poseLayer("pose", [character("c1", 0), character("c2", 1)]);
    state.setPoseCharacterRef(layer.pose, "c1", upload("a"));
    state.setPoseCharacterRef(layer.pose, "c2", upload("b"));
    const metadata = state.serializePose(layer.pose, false), full = state.serializePose(layer.pose, true);
    assert.equal(metadata.character.dataURL, undefined);
    assert.equal(metadata.characterRefs.c2.dataURL, undefined);
    assert.equal(full.characterRefs.c2.dataURL, "data:image/png;base64,b");
    const restored = state.mergePoseCache(metadata, full);
    assert.equal(restored.characterRefs.c2.dataURL, "data:image/png;base64,b");
    assert.equal(restored.character.dataURL, "data:image/png;base64,a");
    metadata.characterRefs.c2.name = "other";
    assert.equal(state.mergePoseCache(metadata, full).characterRefs.c2.dataURL, undefined, "only the matching upload is restored");
    assert.equal(layer.pose.characterRefs.c2.dataURL, "data:image/png;base64,b");
});

test("removing a mannequin drops its reference and a replaced scene remaps references by slot", () => {
    const layer = poseLayer("pose", [character("c1", 0), character("c2", 1), character("c3", 2)]);
    state.setPoseCharacterRef(layer.pose, "c1", upload("a"));
    state.setPoseCharacterRef(layer.pose, "c2", upload("b"));
    state.setPoseCharacterRef(layer.pose, "c3", upload("c"));
    const ids = list => list.map(([id, slot]) => ({ id, slot }));
    assert.equal(state.reconcilePoseCharacterRefs(layer.pose, ids([["c1", 0], ["c2", 1], ["c3", 2]]), ids([["c1", 0], ["c2", 1], ["c3", 2]])), false);
    assert.ok(state.reconcilePoseCharacterRefs(layer.pose, ids([["c1", 0], ["c2", 1], ["c3", 2]]), ids([["c1", 0], ["c3", 2]])));
    assert.deepEqual(Object.keys(layer.pose.characterRefs).sort(), ["c1", "c3"]);
    // A scene asset replaced every id: the reference of each slot moves to the new mannequin.
    state.reconcilePoseCharacterRefs(layer.pose, ids([["c1", 0], ["c3", 2]]), ids([["n1", 0], ["n3", 2]]));
    assert.equal(layer.pose.characterRefs.n1.name, "a");
    assert.equal(layer.pose.characterRefs.n3.name, "c");
    assert.equal(layer.pose.character.name, "a");
    // Removing the first mannequin makes the next one the legacy `character`.
    state.reconcilePoseCharacterRefs(layer.pose, ids([["n1", 0], ["n3", 2]]), ids([["n3", 2]]));
    assert.equal(layer.pose.character.name, "c");
    assert.equal(layer.pose.characterRefs, undefined, "a single mannequin without a prompt returns to the legacy shape");
});

test("the ID pass maps antialiased pixels to exactly one mannequin and masks dilate in world pixels", () => {
    const [red, green] = state.POSE_ID_COLORS;
    const data = new Uint8ClampedArray([...red, 255, ...green, 255, 128, 127, 0, 200, 0, 0, 0, 0, ...red, 100]);
    assert.deepEqual([...state.classifyPoseIdPixels(data, 2)], [0, 1, 0, -1, -1]);
    const labels = Int8Array.from([-1, -1, -1, -1, -1, 0, -1, -1, -1, -1, -1, -1]);
    assert.equal(state.poseIdMaskAlpha(labels, 4, 3, 0).filter(Boolean).length, 1);
    assert.equal(state.poseIdMaskAlpha(labels, 4, 3, 0, 1).filter(Boolean).length, 9);

    const layer = poseLayer("pose", [character("c1", 0), character("c2", 1)]);
    const canvas = new PixelCanvas(4, 2);
    canvas.set(0, 0, red); canvas.set(1, 0, red); canvas.set(3, 1, green);
    layer.poseIdCanvas = canvas;
    layer.poseIdMeta = { key: state.poseIdKey(layer.pose), ids: ["c1", "c2"], rect: { ...layer.pose.rect } };
    const create = (width, height) => new PixelCanvas(width, height);
    const first = state.getPoseCharacterMask(layer, "c1", { createCanvas: create });
    const second = state.getPoseCharacterMask(layer, "c2", { createCanvas: create });
    assert.deepEqual([...first.alpha], [255, 255, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual([...second.alpha], [0, 0, 0, 0, 0, 0, 0, 255]);
    assert.ok(first.alpha.every((value, index) => !(value && second.alpha[index])), "masks are disjoint");
    assert.deepEqual(first.rect, layer.pose.rect);
    assert.equal(state.getPoseCharacterMask(layer, "c1", { createCanvas: create, dilate: 1 }).alpha.filter(Boolean).length, 6);
    assert.equal(state.getPoseCharacterMask(layer, "missing", { createCanvas: create }), null);
    assert.deepEqual(state.poseCharacterScreenOrder(layer), ["c1", "c2"]);
    // Any change of the mannequins, camera or rect makes the ID canvas stale until the next commit.
    layer.pose.studio.characters[1].transform.x = -3;
    assert.equal(state.getPoseCharacterMask(layer, "c1", { createCanvas: create }), null);
    assert.deepEqual(state.poseCharacterScreenOrder(layer), ["c1", "c2"], "without a current ID pass the slot order is used");
    const stored = state.serializePoseId(layer);
    assert.deepEqual(stored.ids, ["c1", "c2"]);
    assert.equal(stored.dataURL, "data:image/png;base64,id");
});

test("image2 gets one column per bound reference in screen order and the prompt names the mapping", async () => {
    const layer = poseLayer("pose", [character("c1", 0), character("c2", 1)]);
    state.setPoseCharacterRef(layer.pose, "c1", upload("a"));
    state.setPoseCharacterRef(layer.pose, "c2", upload("b"));
    state.setPoseCharacterPrompt(layer.pose, "c1", "red-haired girl");
    // c2 stands on the left of image1.
    const [red, green] = state.POSE_ID_COLORS, canvas = new PixelCanvas(4, 2);
    canvas.set(0, 0, green); canvas.set(3, 0, red);
    layer.poseIdCanvas = canvas;
    layer.poseIdMeta = { key: state.poseIdKey(layer.pose), ids: ["c1", "c2"], rect: { ...layer.pose.rect } };
    const multi = state.poseMultiReferences(layer);
    assert.deepEqual(multi.entries.map(entry => entry.id), ["c2", "c1"]);
    assert.equal(state.posePromptMapping(multi.entries, multi.total),
        "The character on the left is the first person in image2, the character on the right (red-haired girl) is the second person in image2.");
    const drawn = [];
    const out = { getContext: () => ({ fillRect() {}, save() {}, restore() {}, drawImage: (image, ...box) => drawn.push([image.name, ...box]) }) };
    const host = { layers: [layer], bbox: layer.pose.rect, _createCanvas: () => Object.assign(out, { width: 200, height: 100 }),
        loadImage: async url => ({ name: url.slice(-1), width: 50, height: 100 }), drawRasterLayerToWorldRect() {} };
    await state.composePoseReference(host, layer, { width: 200, height: 100 });
    assert.deepEqual(drawn, [["b", 25, 0, 50, 100], ["a", 125, 0, 50, 100]]);
    // One bound reference keeps the legacy single-image path.
    state.setPoseCharacterRef(layer.pose, "c2", null);
    assert.equal(state.poseMultiReferences(layer), null);
    drawn.length = 0;
    await state.composePoseReference(host, layer, { width: 200, height: 100 });
    assert.deepEqual(drawn, [["a", 75, 0, 50, 100]]);
    assert.equal(state.posePromptMapping([{}, {}, {}, {}]).split(",")[3].trim().startsWith("the character on the far right"), true);
});

test("split states hold one mannequin each and merge states are their inverse", () => {
    const layer = poseLayer("pose", [character("c1", 0, { color: "#ffffff" }), character("c2", 1, { color: "#8ec5ff" })]);
    state.setPoseCharacterRef(layer.pose, "c1", upload("a"));
    state.setPoseCharacterRef(layer.pose, "c2", upload("b"));
    state.setPoseCharacterPrompt(layer.pose, "c2", "tall man");
    const parts = ["c1", "c2"].map(id => scene.splitPoseState(layer, id));
    assert.deepEqual(parts.map(pose => pose.studio.characters.map(item => item.id)), [["c1"], ["c2"]]);
    assert.equal(parts[1].studio.active_character_id, "c2");
    assert.deepEqual(parts[1].studio.poses, layer.pose.studio.characters[1].poses, "legacy mirrors follow the kept mannequin");
    assert.equal(parts[1].studio.export.cam_offset_x, 1);
    assert.equal(parts[1].character.name, "b");
    assert.equal(parts[1].characterRefs.c2.prompt, "tall man");
    assert.equal(parts[0].characterRefs, undefined);
    assert.deepEqual(parts[0].rect, layer.pose.rect); assert.deepEqual(parts[1].viewport, layer.pose.viewport);

    const layers = parts.map((pose, index) => ({ ...poseLayer(`part${index}`, []), pose }));
    assert.equal(scene.mergePoseIssue(layers), null);
    const merged = scene.mergePoseState(layers);
    assert.deepEqual(merged.studio.characters.map(item => [item.id, item.slot]), [["c1", 0], ["c2", 1]]);
    assert.equal(merged.character.name, "a");
    assert.equal(state.poseCharacterRef({ pose: merged }, "c2").name, "b");
    assert.equal(state.poseCharacterPrompt({ pose: merged }, "c2"), "tall man");

    // Colliding ids and slots are renumbered; references follow their mannequin.
    const twin = [poseLayer("x", [character("c1", 0)], { character: upload("x") }), poseLayer("y", [character("c1", 0)], { character: upload("y") })];
    const renamed = scene.mergePoseState(twin);
    assert.deepEqual(renamed.studio.characters.map(item => [item.id, item.slot]), [["c1", 0], ["character-1", 1]]);
    assert.notEqual(renamed.studio.characters[1].color, renamed.studio.characters[0].color);
    assert.equal(state.poseCharacterRef({ pose: renamed }, "character-1").name, "y");

    const moved = clone(layers[1]); moved.pose.rect.x = 10;
    assert.match(scene.mergePoseIssue([layers[0], moved]), /same frame and camera/);
    const full = [0, 1, 2].map(index => poseLayer(`f${index}`, [character("a", 0), character("b", 1)]));
    assert.match(scene.mergePoseIssue(full), /at most 4/);
});

function sceneHost(layers) {
    const statuses = [], history = [];
    return {
        layers, activeLayerId: layers[0].id, selectedLayerIds: [], origin: { x: 0, y: 0 }, statuses, history,
        get activeLayer() { return this.layers.find(item => item.id === this.activeLayerId); },
        _createCanvas: (width = 8, height = 8) => new PixelCanvas(width, height),
        setStatus: (message, error) => statuses.push([message, Boolean(error)]), pushHistoryEntry: entry => history.push(entry),
        normalizeLayerOrder() {}, invalidateLayerCaches() {}, markLayerPixelsChanged() {}, renderLayerList() {}, requestRender() {},
        syncToNode() {}, finishPoseEdit() {},
    };
}

test("split creates one pose layer per mannequin above the hidden original as one history group", async () => {
    const original = poseLayer("pose", [character("c1", 0, { name: "Alice" }), character("c2", 1, { name: "Bob" })]);
    state.setPoseCharacterRef(original.pose, "c1", upload("a"));
    state.setPoseCharacterRef(original.pose, "c2", upload("b"));
    const below = { id: "below", type: "raster", visible: true };
    const uc = sceneHost([original, below]);
    const solos = [];
    const editor = { layer: null, async activate(layer) { this.layer = layer; }, async flush() {}, release() { this.layer = null; },
        captureSoloPass: (size, id) => { solos.push(id); return Object.assign(new PixelCanvas(size.width, size.height), { solo: id }); } };
    scene.installUniCanvasPoseScene(uc, { createEditor: () => editor });
    const created = await uc.splitPoseCharacters(original);
    assert.deepEqual(solos, ["c1", "c2"]);
    assert.deepEqual(uc.layers.map(item => item.id), [created[0].id, created[1].id, "pose", "below"]);
    assert.equal(original.visible, false);
    assert.deepEqual(created.map(item => item.name), ["pose - Alice", "pose - Bob"]);
    assert.deepEqual(created.map(item => item.pose.character.name), ["a", "b"]);
    assert.deepEqual(created.map(item => item.hiresCanvas.solo), ["c1", "c2"]);
    assert.deepEqual(created.map(item => item.meta.origin), ["split", "split"]);
    assert.equal(uc.history.length, 1);
    const [group] = uc.history;
    assert.equal(group.kind, "historyGroup");
    assert.deepEqual(group.entries.map(entry => entry.kind), ["addLayer", "addLayer", "layerProps", "groupStructure"]);
    // Undo order (reverse) restores the stack without the new layers and shows the original.
    const undone = restoreGroupStructure(uc.layers, group.entries[3].before);
    assert.deepEqual(undone.map(item => item.id), ["pose", "below"]);
    assert.deepEqual(group.entries[2].before, { visible: true });

    const single = poseLayer("one", [character("c1", 0)]);
    uc.layers.unshift(single);
    assert.equal(await uc.splitPoseCharacters(single), null);
    assert.match(uc.statuses.at(-1)[0], /two or more characters/);
});

test("merge replaces the selected pose layers with one layer holding every mannequin", () => {
    const a = poseLayer("a", [character("c1", 0)], { character: upload("a") });
    const b = poseLayer("b", [character("c1", 0)], { character: upload("b") });
    const other = { id: "raster", type: "raster", visible: true, opacity: 1, canvas: new PixelCanvas(8, 8) };
    for (const layer of [a, b]) layer.canvas = new PixelCanvas(8, 8);
    const uc = sceneHost([other, a, b]);
    uc.selectedLayerIds = ["a", "b"];
    scene.installUniCanvasPoseScene(uc, {});
    const merged = uc.mergePoseLayers();
    assert.deepEqual(uc.layers.map(item => item.id), ["raster", merged.id]);
    assert.equal(state.poseStudioCharacters(merged.pose).length, 2);
    assert.equal(merged.meta.origin, "merge");
    assert.deepEqual(uc.history[0].entries.map(entry => entry.kind), ["removeLayer", "removeLayer", "addLayer", "groupStructure"]);
    assert.deepEqual(uc.history[0].entries.slice(0, 2).map(entry => entry.index), [1, 2]);
    assert.deepEqual(restoreGroupStructure(uc.layers, uc.history[0].entries[3].before).map(item => item.id), ["raster", "a", "b"]);
    uc.selectedLayerIds = [merged.id];
    assert.equal(uc.mergePoseLayers(), null);
    assert.match(uc.statuses.at(-1)[0], /two or more pose layers/);
});

test("the layer menu offers split for multi-character layers and merge for pose multi-selections", () => {
    const split = LAYER_MENU_ITEMS.find(item => item.id === "split-characters");
    const merge = LAYER_MENU_ITEMS.find(item => item.id === "merge-pose-layers");
    const single = poseLayer("one", [character("c1", 0)]), multi = poseLayer("two", [character("c1", 0), character("c2", 1)]);
    const raster = { id: "r", type: "raster" };
    const uc = { layers: [single, multi, raster], selectedLayerIds: [] };
    assert.equal(layerMenuItemAvailable(uc, single, split), false);
    assert.equal(layerMenuItemAvailable(uc, multi, split), true);
    assert.equal(layerMenuItemAvailable(uc, raster, split), false);
    assert.equal(layerMenuItemAvailable(uc, multi, merge), false);
    uc.selectedLayerIds = ["one", "r"];
    assert.equal(layerMenuItemAvailable(uc, single, merge), false);
    uc.selectedLayerIds = ["one", "two"];
    assert.equal(layerMenuItemAvailable(uc, single, merge), true);
    assert.equal(layerMenuItemAvailable(uc, raster, merge), false);
});

test("legacy multi-mannequin layers with one reference say which mannequin image2 shows (#4)", async () => {
    // An old state: two mannequins in the studio, but only pose.character (no characterRefs).
    const layer = poseLayer("legacy", [character("c1", 0), character("c2", 1)]);
    layer.pose.character = upload("alice");
    assert.equal(layer.pose.characterRefs, undefined);
    assert.equal(state.poseMultiReferences(layer), null, "one reference keeps the single-image path");
    assert.equal(state.posePromptMappingForLayer(layer),
        "The character on the left is the person in image2; the character on the right is not in image2.");
    // image2 still holds only that one reference, centred.
    const drawn = [];
    const out = { getContext: () => ({ fillRect() {}, save() {}, restore() {}, drawImage: (image, ...box) => drawn.push([image.name, ...box]) }) };
    const host = { layers: [layer], bbox: layer.pose.rect, _createCanvas: () => Object.assign(out, { width: 200, height: 100 }),
        loadImage: async url => ({ name: url.split(",")[1], width: 50, height: 100 }), drawRasterLayerToWorldRect() {} };
    await state.composePoseReference(host, layer, { width: 200, height: 100 });
    assert.deepEqual(drawn, [["alice", 75, 0, 50, 100]]);

    // Screen order decides the words: with c1 on the right, the reference is "on the right".
    const [red, green] = state.POSE_ID_COLORS, canvas = new PixelCanvas(4, 2);
    canvas.set(0, 0, green); canvas.set(3, 0, red);
    layer.poseIdCanvas = canvas;
    layer.poseIdMeta = { key: state.poseIdKey(layer.pose), ids: ["c1", "c2"], rect: { ...layer.pose.rect } };
    state.setPoseCharacterPrompt(layer.pose, "c2", "tall man");
    assert.equal(state.poseCharacterRef(layer, "c1").name, "alice", "the identity prompt map keeps the legacy reference");
    assert.equal(state.posePromptMappingForLayer(layer),
        "The character on the right is the person in image2; the character on the left (tall man) is not in image2.");

    // Three mannequins, two bound: the column mapping plus the unbound one.
    const three = poseLayer("three", [character("a", 0), character("b", 1), character("c", 2)]);
    state.setPoseCharacterRef(three.pose, "a", upload("a"));
    state.setPoseCharacterRef(three.pose, "c", upload("c"));
    assert.equal(state.posePromptMappingForLayer(three),
        "The character on the left is the first person in image2, the character on the right is the second person in image2; the character in the middle is not in image2.");
    // Nothing bound, or a single mannequin: no mapping line.
    assert.equal(state.posePromptMappingForLayer(poseLayer("none", [character("a", 0), character("b", 1)])), "");
    const single = poseLayer("single", [character("a", 0)]);
    single.pose.character = upload("a");
    assert.equal(state.posePromptMappingForLayer(single), "");
});
