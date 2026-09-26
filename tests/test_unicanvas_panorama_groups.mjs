// Group commands in a panorama document (#8, #33): flatten, duplicate and group moves.
import assert from "node:assert/strict";
import test from "node:test";
import { beginMultiLayerMove, createGroupLayer, duplicateGroup, flattenGroup } from "../web/vnccs_unicanvas_groups.mjs";

globalThis.crypto ??= { randomUUID: () => `id-${Math.random().toString(36).slice(2)}` };

function surface(name, draws = []) {
    const ctx = {
        canvas: null, save() {}, restore() {}, setTransform() {}, getTransform: () => ({}), clearRect() {},
        drawImage(source) { draws.push({ target: name, source: source.name }); },
    };
    const canvas = { name, width: 8, height: 4, getContext: () => ctx };
    ctx.canvas = canvas;
    return canvas;
}

const leaf = (id, type, extra = {}) => ({
    id, name: id, type, visible: true, locked: false, opacity: 1, blendMode: "source-over",
    canvas: surface(`${id}-view`), panoramaCanvas: surface(`${id}-sphere`), ...extra,
});

function panoramaWidget(layers) {
    const draws = [];
    const projected = [];
    const uc = {
        layers, activeLayerId: layers[0].id, selectedLayerIds: [], draws, projected, _groupScratchPool: [],
        get activeLayer() { return this.layers.find((layer) => layer.id === this.activeLayerId); },
        panorama: {
            settings: { baseLayerId: "base" },
            ensureLayer(layer) { return (layer.panoramaCanvas ||= surface(`${layer.id}-sphere`, draws)); },
            commitLayer() {}, projectLayer(layer) { projected.push(layer.id); },
        },
        normalizeLayerOrder() {}, recordHistoryBefore() {}, pushHistoryEntry(entry) { this.pushed = entry; },
        _createCanvas: () => surface("flat-view"), configureImageContext: (ctx) => ctx, drawFlattenedLayers() {},
        cloneCanvas: (canvas) => canvas && { ...canvas, name: `${canvas.name}-copy` },
        invalidateLayerCaches(layer) { layer._panoramaDirty = true; },
        createLayerPixelSnapshot: (layer) => ({ id: layer.id, crop: { x: 0, y: 0, width: 2, height: 2 } }),
        cloneCanvasCrop: (canvas) => canvas,
        renderLayerList() {}, requestRender() {}, syncLightStateToWidget() {}, scheduleFullSync() {}, setStatus(message) { this.status = message; },
    };
    return uc;
}

test("flattening a group in a panorama composites every image layer's sphere, sprite sets included", () => {
    const group = createGroupLayer({ id: "g", name: "Folder" });
    const layers = [group, leaf("paint", "raster", { groupId: "g" }), leaf("sprite", "sprite", { groupId: "g", sprite: {} }),
        leaf("pose", "pose", { groupId: "g" }), leaf("base", "panorama")];
    const uc = panoramaWidget(layers);
    const flat = flattenGroup(uc, group);
    assert.ok(flat, uc.status);
    const drawn = uc.draws.filter((draw) => draw.target === `${flat.id}-sphere`).map((draw) => draw.source);
    assert.deepEqual(drawn.sort(), ["paint-sphere", "pose-sphere", "sprite-sphere"]);
    assert.equal(flat._panoramaDirty, true, "the view is re-projected from the new sphere");
    assert.deepEqual(uc.projected, [flat.id]);
    assert.deepEqual(uc.layers.map((layer) => layer.id), [flat.id, "base"]);
});

test("duplicating a group in a panorama copies each sphere, sprite sets included", () => {
    const group = createGroupLayer({ id: "g", name: "Folder" });
    const sprites = { cloneLayerFields: (layer) => (layer.sprite ? { sprite: { ...layer.sprite, copied: true } } : {}) };
    const uc = Object.assign(panoramaWidget([group, leaf("sprite", "sprite", { groupId: "g", sprite: { rect: {} } }), leaf("base", "panorama")]), { sprites });
    const copy = duplicateGroup(uc, group);
    const copied = uc.layers.find((layer) => layer.groupId === copy.id);
    assert.equal(copied.type, "sprite");
    assert.equal(copied.sprite.copied, true);
    assert.equal(copied.panoramaCanvas.name, "sprite-sphere-copy");
    assert.equal(copied._panoramaDirty, false, "the copy already matches its sphere");
    assert.equal(uc.pushed.kind, "historyGroup", "one undo step");
});

test("a group move in a panorama takes sprite sets along and never the panorama base", () => {
    const group = createGroupLayer({ id: "g", name: "Folder" });
    const uc = panoramaWidget([group, leaf("paint", "raster", { groupId: "g" }), leaf("sprite", "sprite", { groupId: "g", sprite: {} }),
        leaf("ctl", "control", { groupId: "g" }), leaf("base", "panorama")]);
    uc.selectedLayerIds = ["base", "ctl"];
    uc.dragStart = {};
    assert.equal(beginMultiLayerMove(uc), true);
    assert.deepEqual([...uc.dragStart.moveLayerIds].sort(), ["paint", "sprite"]);
});
