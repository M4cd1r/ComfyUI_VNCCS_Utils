import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    MAX_GROUP_DEPTH,
    PASS_THROUGH,
    buildLayerTree,
    canPlaceInGroup,
    captureGroupStructure,
    compositeLayerStack,
    createGroupLayer,
    getGroupDescendants,
    groupChainOf,
    groupCompositeOperation,
    isIsolatedGroup,
    isLayerEffectivelyLocked,
    isLayerEffectivelyVisible,
    normalizeGroupedLayerOrder,
    restoreGroupStructure,
    selectionRange,
    serializeGroupLayer,
    topLevelSelection,
    visibleLayerRows,
} from "../web/vnccs_unicanvas_groups.mjs";
import { LAYER_MENU_ITEMS, layerMenuItemAvailable, runLayerMenuAction } from "../web/vnccs_unicanvas_layer_tools.mjs";

const widget = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const modes = await readFile(new URL("../web/vnccs_unicanvas_modes.mjs", import.meta.url), "utf8");
const groupsSource = await readFile(new URL("../web/vnccs_unicanvas_groups.mjs", import.meta.url), "utf8");
const filingSource = await readFile(new URL("../web/vnccs_unicanvas_filing.mjs", import.meta.url), "utf8");

const layer = (id, extra = {}) => ({ id, name: id, type: "raster", visible: true, locked: false, opacity: 1, blendMode: "source-over", ...extra });
const group = (id, extra = {}) => createGroupLayer({ id, name: id, ...extra });
const ids = (layers) => layers.map((item) => item.id);
const menuItem = (id) => LAYER_MENU_ITEMS.find((item) => item.id === id);

test("groups are canvas-less pass-through folders by default", () => {
    const g = group("g");
    assert.equal(g.type, "group");
    assert.equal(g.canvas, null);
    assert.equal(g.blendMode, PASS_THROUGH);
    assert.equal(g.groupId, null);
    assert.equal(isIsolatedGroup(g), false);
    assert.equal(isIsolatedGroup({ ...g, opacity: 0.5 }), true);
    assert.equal(isIsolatedGroup({ ...g, blendMode: "multiply" }), true);
    assert.equal(groupCompositeOperation(g), "source-over");
    const saved = serializeGroupLayer({ ...g, collapsed: true });
    assert.equal(saved.dataURL, null);
    assert.equal(saved.collapsed, true);
    assert.equal("canvas" in saved, false);
});

test("normalize keeps masks first and each subtree right after its group", () => {
    const stack = [
        layer("a", { groupId: "g" }),
        layer("top"),
        { ...layer("m"), type: "mask", groupId: "g" },
        group("g"),
        layer("b", { groupId: "g" }),
        layer("bottom"),
    ];
    const out = normalizeGroupedLayerOrder(stack);
    assert.deepEqual(ids(out), ["m", "top", "g", "a", "b", "bottom"]);
    assert.equal(out[0].groupId, null, "masks never belong to a group");
});

test("the panorama base stays last and at the root", () => {
    const out = normalizeGroupedLayerOrder([layer("base", { groupId: "g" }), group("g"), layer("x")], { pinnedLastId: "base" });
    assert.deepEqual(ids(out), ["g", "x", "base"]);
    assert.equal(out[2].groupId, null);
});

test("missing parents and cycles sit at the root without losing their groupId", () => {
    const orphan = layer("o", { groupId: "gone" });
    const a = group("a", { groupId: "b" });
    const b = group("b", { groupId: "a" });
    const out = normalizeGroupedLayerOrder([orphan, a, b]);
    assert.deepEqual(ids(out), ["o", "a", "b"]);
    assert.equal(orphan.groupId, "gone", "an undo that re-inserts the group rebuilds the tree");
    assert.equal(buildLayerTree(out).length, 3);
});

test("effective visibility and lock follow the group chain", () => {
    const outer = group("outer", { visible: false });
    const inner = group("inner", { groupId: "outer", locked: true });
    const leaf = layer("leaf", { groupId: "inner" });
    const stack = [outer, inner, leaf];
    assert.deepEqual(ids(groupChainOf(stack, leaf)), ["inner", "outer"]);
    assert.equal(isLayerEffectivelyVisible(stack, leaf), false);
    assert.equal(isLayerEffectivelyLocked(stack, leaf), true);
    outer.visible = true;
    inner.locked = false;
    assert.equal(isLayerEffectivelyVisible(stack, leaf), true);
    assert.equal(isLayerEffectivelyLocked(stack, leaf), false);
});

test("depth 3 is allowed, depth 4 and moving a group into itself are refused", () => {
    const g1 = group("g1");
    const g2 = group("g2", { groupId: "g1" });
    const g3 = group("g3", { groupId: "g2" });
    const g4 = group("g4");
    const g5 = group("g5", { groupId: "g4" });
    const stack = normalizeGroupedLayerOrder([g1, g2, g3, g4, g5, layer("x")]);
    assert.equal(MAX_GROUP_DEPTH, 3);
    assert.equal(canPlaceInGroup(stack, layer("x"), "g3"), true, "a layer inside the third level");
    assert.equal(canPlaceInGroup(stack, group("solo"), "g2"), true, "a group at the third level");
    assert.equal(canPlaceInGroup(stack, group("solo"), "g3"), false, "a fourth level");
    assert.equal(canPlaceInGroup(stack, g1, "g3"), false, "into its own descendant");
    assert.equal(canPlaceInGroup(stack, g2, "g4"), true, "g4 > g2 > g3 is three levels");
    assert.equal(canPlaceInGroup(stack, g2, "g5"), false, "g4 > g5 > g2 > g3 would be four");
    assert.deepEqual(ids(getGroupDescendants(stack, g1)), ["g2", "g3"]);
});

test("a structure snapshot round-trips order and parents", () => {
    const g = group("g");
    const stack = normalizeGroupedLayerOrder([{ ...layer("m"), type: "mask" }, layer("a"), layer("b"), g]);
    const before = captureGroupStructure(stack);
    stack.find((item) => item.id === "a").groupId = "g";
    const moved = normalizeGroupedLayerOrder(stack);
    assert.deepEqual(ids(moved), ["m", "b", "g", "a"]);
    const restored = restoreGroupStructure(moved, before);
    assert.deepEqual(ids(restored), ["m", "a", "b", "g"]);
    assert.equal(restored.find((item) => item.id === "a").groupId, null);
});

test("selection helpers: ranges skip masks, children of selected groups collapse into them", () => {
    const stack = normalizeGroupedLayerOrder([{ ...layer("m"), type: "mask" }, layer("a"), group("g"), layer("c", { groupId: "g" }), layer("d")]);
    assert.deepEqual(selectionRange(stack, "a", "c"), ["a", "g", "c"]);
    assert.deepEqual(ids(topLevelSelection(stack, ["c", "g", "d", "m"])), ["g", "d"]);
    stack.find((item) => item.id === "g").collapsed = true;
    assert.deepEqual(ids(visibleLayerRows(stack)), ["a", "g", "d"]);
});

// A 2D context double that records draws with the transform, alpha and blend in force.
class FakeContext {
    constructor(canvas, log) { this.canvas = canvas; this.log = log; this.globalAlpha = 1; this.globalCompositeOperation = "source-over"; this.stack = []; this.transform = "T"; }
    save() { this.stack.push([this.globalAlpha, this.globalCompositeOperation, this.transform]); }
    restore() { [this.globalAlpha, this.globalCompositeOperation, this.transform] = this.stack.pop(); }
    setTransform(value) { this.transform = typeof value === "object" && value !== null ? value.name : "identity"; }
    getTransform() { return { name: this.transform }; }
    clearRect() {}
    drawImage(image) { this.log.push({ target: this.canvas.name, image: image.name || image, alpha: this.globalAlpha, op: this.globalCompositeOperation }); }
}
function fakeSurface(name, log) {
    const canvas = { name, width: 64, height: 32 };
    canvas.getContext = () => (canvas.ctx ||= new FakeContext(canvas, log));
    return canvas;
}

test("pass-through groups draw children in place, isolated groups through a scratch surface", () => {
    const log = [];
    const created = [];
    globalThis.document = { createElement: () => { const surface = fakeSurface(`scratch${created.length}`, log); created.push(surface); return surface; } };
    try {
        const main = fakeSurface("main", log);
        const drawLeaf = (ctx, item) => { ctx.save(); ctx.globalAlpha = item.opacity; ctx.drawImage({ name: item.id }); ctx.restore(); };
        const stack = normalizeGroupedLayerOrder([layer("top"), group("g"), layer("a", { groupId: "g" }), layer("b", { groupId: "g" }), layer("bottom")]);
        compositeLayerStack(main.getContext(), stack, drawLeaf);
        assert.deepEqual(log.map((entry) => `${entry.target}:${entry.image}`), ["main:bottom", "main:b", "main:a", "main:top"]);
        assert.equal(created.length, 0, "pass-through needs no scratch");

        log.length = 0;
        stack.find((item) => item.id === "g").opacity = 0.5;
        compositeLayerStack(main.getContext(), stack, drawLeaf, []);
        assert.deepEqual(log.map((entry) => `${entry.target}:${entry.image}`), ["main:bottom", "scratch0:b", "scratch0:a", "main:scratch0", "main:top"]);
        const composite = log.find((entry) => entry.image === "scratch0");
        assert.equal(composite.alpha, 0.5);
        assert.equal(composite.op, "source-over");
        assert.equal(created[0].width, 64, "the scratch covers the target surface");

        log.length = 0;
        stack.find((item) => item.id === "g").visible = false;
        compositeLayerStack(main.getContext(), stack, drawLeaf, []);
        assert.deepEqual(log.map((entry) => entry.image), ["bottom", "top"], "a hidden group hides its children");
    } finally {
        delete globalThis.document;
    }
});

test("the widget routes order, history, rendering and persistence through the groups module", () => {
    assert.match(widget, /installUniCanvasGroups\(this\)/);
    assert.match(widget, /normalizeGroupedLayerOrder\(this\.layers/);
    assert.match(widget, /entry\.kind === "historyGroup"/);
    assert.match(widget, /entry\.kind === "groupStructure"/);
    // Viewport, flatten/export and bbox stats share the group compositor.
    assert.ok((widget.match(/compositeLayerStack\(/g) || []).length >= 4);
    assert.match(widget, /if \(isGroupLayer\(layer\)\) return serializeGroupLayer/);
    assert.match(widget, /if \(item\?\.type === "group"\)/);
    assert.match(widget, /groupId: layer\.groupId \|\| null/);
    assert.match(modes, /widget\.groupSelectedLayers\?\.\(\)/);
    assert.match(modes, /widget\.ungroupActiveLayer\?\.\(\)/);
});

// The action bar is one row: [New group] [Organize] [Import image]; Group/Ungroup live in the
// layer context menu (T4).
test("the layers action bar is a single row with icon buttons before the import button", () => {
    assert.match(widget, /\.vnccs-uc-layers-top-actions \{[^}]*flex-direction:row/);
    assert.match(widget, /\.vnccs-uc-layers-top-actions \.vnccs-uc-btn \{ flex:1 1 auto; min-width:0;/);
    assert.match(widget, /<span>Import Image<\/span>/);
    assert.match(groupsSource, /GROUP_ICONS\.folderPlus/);
    assert.match(groupsSource, /dataset\.groupAction = ""/);
    assert.match(groupsSource, /layersTopActions\?\.prepend\(newGroupButton\)/);
    assert.match(groupsSource, /"New group \(empty folder\)"/);
    assert.match(filingSource, /dataset\.organizeLayers = ""/);
    assert.match(filingSource, /insertBefore\(button, importButton\)/);
    assert.match(filingSource, /"Organize layers: auto-name \+ file into folders"/);
    for (const source of [widget, groupsSource, filingSource]) {
        assert.ok(!source.includes("vnccs-uc-group-actions"), "the old Group/Ungroup button row is gone");
    }
});

function menuWidget(layers, { selectedLayerIds = [], activeLayerId = null } = {}) {
    return {
        layers,
        selectedLayerIds,
        activeLayerId,
        panorama: null,
        transformDraft: null,
        statuses: [],
        history: [],
        setStatus(text) { this.statuses.push(text); },
        normalizeLayerOrder() {},
        pushHistoryEntry(entry) { this.history.push(entry); },
        autoNaming: { onLayerStructureChanged() {} },
        syncPoseToolToActiveLayer() {},
        renderLayerList() {},
        requestRender() {},
        syncLightStateToWidget() {},
        scheduleFullSync() {},
        groupSelectedLayers() { return "grouped"; },
    };
}

test("the Group menu entries appear only when they apply, with a counted multiselection label", () => {
    const g = group("g");
    const child = layer("child", { groupId: "g" });
    const solo = layer("solo");
    const stack = normalizeGroupedLayerOrder([g, child, solo]);

    const groupItem = menuItem("group-selected");
    const ungroupItem = menuItem("ungroup");
    const removeItem = menuItem("remove-from-group");
    assert.ok(groupItem && ungroupItem && removeItem);

    const nothing = menuWidget(stack, {});
    assert.equal(layerMenuItemAvailable(nothing, solo, groupItem), false, "no selection, nothing to group");
    assert.equal(layerMenuItemAvailable(nothing, solo, ungroupItem), false, "no group in the selection");
    assert.equal(layerMenuItemAvailable(nothing, solo, removeItem), false, "solo is not inside a group");

    const some = menuWidget(stack, { selectedLayerIds: [child.id, solo.id], activeLayerId: solo.id });
    assert.equal(layerMenuItemAvailable(some, solo, groupItem), true);
    assert.equal(groupItem.multiselectLabel(some), "Group 2 layers", "multiselection shows the count");
    const one = menuWidget(stack, { selectedLayerIds: [child.id], activeLayerId: child.id });
    assert.equal(layerMenuItemAvailable(one, child, groupItem), true);
    assert.equal(groupItem.multiselectLabel(one), "Group selected (Ctrl+G)", "a single pick keeps the plain label");

    assert.equal(layerMenuItemAvailable(menuWidget(stack, {}), g, ungroupItem), true, "the right-clicked group is a target");
    assert.equal(layerMenuItemAvailable(menuWidget(stack, { selectedLayerIds: [g.id] }), solo, ungroupItem), true, "so is a group in the selection");
    assert.equal(layerMenuItemAvailable(menuWidget(stack, {}), child, removeItem), true, "a layer inside a group can leave it");
});

test("remove-from-group moves the layer to the parent container as one undo step", () => {
    const g = group("g");
    const child = layer("child", { groupId: "g" });
    const sub = group("sub", { groupId: "g" });
    const deep = layer("deep", { groupId: "sub" });
    const uc = menuWidget(normalizeGroupedLayerOrder([g, child, sub, deep]), { selectedLayerIds: [deep.id], activeLayerId: deep.id });
    assert.equal(runLayerMenuAction(uc, deep, menuItem("remove-from-group")), true);
    assert.equal(uc.history.length, 1);
    assert.equal(uc.history[0].kind, "groupStructure");
    assert.equal(deep.groupId, "g", "the layer left the subgroup for the parent container");
    assert.deepEqual(ids(uc.layers), ["g", "child", "sub", "deep"], "it lands right below its old folder");
    const restored = restoreGroupStructure(uc.layers, uc.history[0].before);
    assert.equal(restored.find((item) => item.id === "deep").groupId, "sub", "undo puts it back");
});

test("ungroup from the menu dissolves every group in the selection", () => {
    const g1 = group("g1");
    const g2 = group("g2");
    const a = layer("a", { groupId: "g1" });
    const b = layer("b", { groupId: "g2" });
    const solo = layer("solo");
    const stack = normalizeGroupedLayerOrder([g1, a, g2, b, solo]);
    // A right-click on an unselected row never changes the selection, so the entry still
    // targets the selection's groups.
    const uc = menuWidget(stack, { selectedLayerIds: [g1.id, g2.id], activeLayerId: g1.id });
    assert.equal(runLayerMenuAction(uc, solo, menuItem("ungroup")), true);
    assert.equal(uc.history.length, 2, "one groupStructure entry per ungrouped group");
    assert.equal(g1.type, "group");
    assert.ok(!uc.layers.includes(g1) && !uc.layers.includes(g2));
    assert.deepEqual([a.groupId, b.groupId], [null, null]);
});
