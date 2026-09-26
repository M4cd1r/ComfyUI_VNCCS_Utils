import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createGroupLayer } from "../web/vnccs_unicanvas_groups.mjs";
import {
  MOVE_SCOPE_ALL,
  MOVE_SCOPE_STATE,
  SCENE_STATE_HISTORY_KINDS,
  applySceneLayers,
  applySceneState,
  applySceneStateByIndex,
  applySceneStateHistory,
  beginSceneStateMove,
  captureLayerState,
  captureSceneLayers,
  commitSceneStateMove,
  deleteState,
  duplicateState,
  emptySceneStates,
  exportFileNames,
  getSceneStateMoveScope,
  hideLayerInOtherStates,
  layerVariesAcrossStates,
  moveState,
  newStateFromCurrent,
  normalizeSceneStates,
  normalizeStateOffset,
  pruneSceneStates,
  renameState,
  resolveMoveScope,
  sceneLayersDiffer,
  serializeSceneStates,
  serializeStateOffset,
  updateState,
} from "../web/vnccs_unicanvas_states.mjs";

const widgetSource = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const modesSource = await readFile(new URL("../web/vnccs_unicanvas_modes.mjs", import.meta.url), "utf8");

const layer = (id, extra = {}) => ({ id, name: id, type: "raster", visible: true, locked: false, opacity: 1, blendMode: "source-over", ...extra });

// A widget stand-in: the module only needs layers, history and a few no-op hooks.
function fakeWidget(layers) {
  const uc = {
    layers,
    activeLayerId: layers[0]?.id || null,
    selectedLayerIds: [],
    panorama: null,
    undoStack: [],
    sceneStates: emptySceneStates(),
    _sceneThumbCache: new Map(),
    pushHistoryEntry(entry) { this.undoStack.push(entry); },
    setStatus() {},
    requestRender() {},
    renderLayerList() {},
    syncLightStateToWidget() {},
  };
  return uc;
}

const props = (uc) => Object.fromEntries(uc.layers.map((item) => [item.id, captureLayerState(item)]));

test("offsets normalize to integers and malformed values to zero", () => {
  assert.deepEqual(normalizeStateOffset({ x: 3.6, y: -2.2 }), { x: 4, y: -2 });
  assert.deepEqual(normalizeStateOffset(null), { x: 0, y: 0 });
  assert.deepEqual(normalizeStateOffset({ x: "a", y: Infinity }), { x: 0, y: 0 });
});

test("capture keeps visibility, opacity, blend and offset; groups only visibility and opacity", () => {
  const group = createGroupLayer({ id: "g", opacity: 0.5, collapsed: true });
  const raster = layer("a", { opacity: 0.4, blendMode: "multiply", stateOffset: { x: 5, y: 6 } });
  const mask = layer("m", { type: "mask" });
  const captured = captureSceneLayers([mask, group, raster]);
  assert.deepEqual(Object.keys(captured).sort(), ["a", "g"]);
  assert.deepEqual(captured.g, { visible: true, opacity: 0.5 });
  assert.deepEqual(captured.a, { visible: true, opacity: 0.4, blendMode: "multiply", offset: { x: 5, y: 6 } });
});

test("applying a map touches only named layers and returns their previous properties", () => {
  const layers = [layer("a"), layer("b", { stateOffset: { x: 1, y: 1 } })];
  const previous = applySceneLayers(layers, { b: { visible: false, offset: { x: 0, y: 0 } }, gone: { visible: false } });
  assert.deepEqual(Object.keys(previous), ["b"]);
  assert.equal(layers[0].visible, true);
  assert.equal(layers[1].visible, false);
  assert.equal(layers[1].stateOffset, undefined, "a zero offset removes the field");
  applySceneLayers(layers, previous);
  assert.deepEqual(layers[1].stateOffset, { x: 1, y: 1 });
  assert.equal(layers[1].visible, true);
});

test("differs, varies, prune and hidden-in-other-states", () => {
  const layers = [layer("a"), layer("b")];
  const scene = emptySceneStates();
  scene.states = [
    { id: "s1", name: "A", layers: captureSceneLayers(layers) },
    { id: "s2", name: "B", layers: { ...captureSceneLayers(layers), b: { ...captureLayerState(layers[1]), visible: false } } },
  ];
  scene.activeStateId = "s1";
  assert.equal(sceneLayersDiffer(layers, scene.states[0]), false);
  layers[0].opacity = 0.3;
  assert.equal(sceneLayersDiffer(layers, scene.states[0]), true);
  assert.equal(layerVariesAcrossStates(scene, "a"), false);
  assert.equal(layerVariesAcrossStates(scene, "b"), true);

  const pruned = pruneSceneStates(scene, new Set(["a"]));
  assert.deepEqual(Object.keys(pruned.states[1].layers), ["a"]);
  assert.ok("b" in scene.states[1].layers, "prune returns a copy");

  const fresh = layer("c");
  hideLayerInOtherStates(scene, fresh);
  assert.equal(scene.states[0].layers.c.visible, true, "the active state shows the new layer");
  assert.equal(scene.states[1].layers.c.visible, false);
});

test("move scope defaults to this state once more than one state exists", () => {
  const scene = emptySceneStates();
  assert.equal(resolveMoveScope(scene), MOVE_SCOPE_ALL);
  scene.states = [{ id: "a" }, { id: "b" }];
  assert.equal(resolveMoveScope(scene), MOVE_SCOPE_STATE);
  scene.moveScope = MOVE_SCOPE_ALL;
  assert.equal(resolveMoveScope(scene), MOVE_SCOPE_ALL);
});

test("normalizeSceneStates is additive and tolerant", () => {
  assert.deepEqual(normalizeSceneStates(undefined).states, []);
  const scene = normalizeSceneStates({
    activeStateId: "missing",
    moveScope: "bogus",
    states: [
      { id: "x", name: "Night", order: 1, layers: { a: { visible: false, offset: { x: 2.4, y: 0 } } } },
      { id: "x", name: "", order: 0, layers: null },
      "junk",
    ],
  });
  assert.equal(scene.states.length, 2);
  assert.equal(scene.activeStateId, null);
  assert.equal(scene.moveScope, null);
  assert.notEqual(scene.states[0].id, scene.states[1].id, "duplicate ids are replaced");
  assert.equal(scene.states[1].name, "Night");
  assert.deepEqual(scene.states[1].layers.a, { visible: false, offset: { x: 2, y: 0 } });
});

test("states capture showMannequin and the sprite variant, and old entries without them still apply", () => {
  const pose = layer("p", { type: "pose", pose: { rect: { x: 0, y: 0, width: 10, height: 10 }, bake: { characters: {}, showMannequin: false } } });
  const sprite = layer("s", { type: "sprite", sprite: { activeVariantId: "v1", variants: [
    { id: "v1", status: "ready" }, { id: "v2", status: "ready" }, { id: "v3", status: "empty" }] } });
  const captured = captureSceneLayers([pose, sprite]);
  assert.equal(captured.p.showMannequin, false);
  assert.equal(captured.s.spriteVariantId, "v1");
  assert.equal("spriteVariantId" in captured.p, false);

  const rebuilt = [];
  const synced = [];
  const view = { before: (item) => synced.push(item.id), after: (item) => rebuilt.push(item.id) };
  const previous = applySceneLayers([pose, sprite], { p: { showMannequin: true }, s: { spriteVariantId: "v2" } }, view);
  assert.equal(pose.pose.bake.showMannequin, true);
  assert.equal(sprite.sprite.activeVariantId, "v2");
  assert.deepEqual(rebuilt, ["p", "s"]);
  assert.deepEqual(synced, ["p", "s"]);
  assert.equal(sceneLayersDiffer([pose, sprite], { layers: captured }), true);
  applySceneLayers([pose, sprite], previous, view);
  assert.equal(pose.pose.bake.showMannequin, false);
  assert.equal(sprite.sprite.activeVariantId, "v1");
  assert.equal(sceneLayersDiffer([pose, sprite], { layers: captured }), false);

  // An empty or deleted variant never becomes active; unchanged parts rebuild nothing.
  rebuilt.length = 0;
  applySceneLayers([pose, sprite], { s: { spriteVariantId: "v3" }, p: { showMannequin: false } }, view);
  assert.equal(sprite.sprite.activeVariantId, "v1");
  assert.deepEqual(rebuilt, []);
  // Old entries (before #5 / #6) lack the keys and leave the view as it is.
  const legacy = normalizeSceneStates({ states: [{ id: "old", layers: { s: { visible: true, blendMode: "normal", offset: { x: 0, y: 0 } } } }] });
  applySceneLayers([sprite], legacy.states[0].layers, view);
  assert.equal(sprite.sprite.activeVariantId, "v1");
  const restored = normalizeSceneStates({ states: [{ id: "n", layers: { s: { visible: true, blendMode: "normal", spriteVariantId: "v2" }, p: { visible: true, blendMode: "normal", showMannequin: true } } }] });
  assert.equal(restored.states[0].layers.s.spriteVariantId, "v2");
  assert.equal(restored.states[0].layers.p.showMannequin, true);
});

test("export names are safe and unique", () => {
  assert.deepEqual(exportFileNames(["Day", "day", "a/b:c", "..", ""]), ["Day", "day-2", "a_b_c", "state-4", "state-5"]);
});

test("capture A and B, apply A, B, A exactly, undo restores, move in B leaves A alone", () => {
  const bg = layer("bg");
  const anna = layer("anna");
  const ben = layer("ben");
  const uc = fakeWidget([anna, ben, bg]);
  const a = newStateFromCurrent(uc);
  ben.visible = false;
  anna.stateOffset = { x: 200, y: 0 };
  const b = newStateFromCurrent(uc);
  const propsA = a.layers;
  const propsB = b.layers;
  assert.equal(uc.sceneStates.activeStateId, b.id);

  assert.ok(applySceneState(uc, a.id));
  assert.deepEqual(captureSceneLayers(uc.layers), propsA);
  applySceneState(uc, b.id);
  assert.deepEqual(captureSceneLayers(uc.layers), propsB);
  applySceneState(uc, a.id);
  assert.deepEqual(captureSceneLayers(uc.layers), propsA);

  // Undo of the last apply restores B's properties and B as the active state.
  const entry = uc.undoStack.at(-1);
  assert.equal(entry.kind, "applySceneState");
  assert.ok(SCENE_STATE_HISTORY_KINDS.has(entry.kind));
  applySceneStateHistory(uc, entry, "undo");
  assert.deepEqual(captureSceneLayers(uc.layers), propsB);
  assert.equal(uc.sceneStates.activeStateId, b.id);
  applySceneStateHistory(uc, entry, "redo");
  assert.equal(uc.sceneStates.activeStateId, a.id);

  // Move in B with "this state": only B's offset changes, pixels are untouched.
  applySceneState(uc, b.id);
  assert.equal(getSceneStateMoveScope(uc), MOVE_SCOPE_STATE);
  uc.activeLayerId = "ben";
  uc.dragStart = {};
  assert.ok(beginSceneStateMove(uc));
  assert.equal(uc.pointerMode, "layer-move");
  uc.dragStart.previewDx = 30;
  uc.dragStart.previewDy = -10.4;
  commitSceneStateMove(uc, uc.dragStart);
  assert.deepEqual(ben.stateOffset, { x: 30, y: -10 });
  assert.deepEqual(b.layers.ben.offset, { x: 30, y: -10 });
  assert.deepEqual(a.layers.ben.offset, { x: 0, y: 0 });
  const moveEntry = uc.undoStack.at(-1);
  assert.equal(moveEntry.kind, "sceneStateOffset");
  applySceneStateHistory(uc, moveEntry, "undo");
  assert.equal(ben.stateOffset, undefined);
  assert.deepEqual(b.layers.ben.offset, { x: 0, y: 0 });
  applySceneState(uc, a.id);
  assert.deepEqual(captureSceneLayers(uc.layers), propsA);
});

test("list edits are one sceneStates entry each and undo cleanly", () => {
  const uc = fakeWidget([layer("a"), layer("b")]);
  const first = newStateFromCurrent(uc);
  const second = newStateFromCurrent(uc);
  const copy = duplicateState(uc, first.id);
  assert.deepEqual(uc.sceneStates.states.map((state) => state.id), [first.id, copy.id, second.id]);
  renameState(uc, copy.id, "Night");
  moveState(uc, copy.id, 2);
  assert.deepEqual(uc.sceneStates.states.map((state) => state.name), [first.name, second.name, "Night"]);
  uc.layers[0].opacity = 0.5;
  updateState(uc, second.id);
  assert.equal(second.layers.a.opacity, 0.5);
  deleteState(uc, second.id);
  assert.equal(uc.sceneStates.states.length, 2);
  const kinds = uc.undoStack.map((entry) => entry.kind);
  assert.deepEqual(kinds, ["sceneStates", "sceneStates", "sceneStates", "sceneStates", "sceneStates", "sceneStates", "sceneStates"]);
  assert.ok(uc.undoStack.every((entry) => entry.before.states.every((state) => state.thumbnailDataURL === null)), "history has no thumbnails");
  applySceneStateHistory(uc, uc.undoStack.at(-1), "undo");
  assert.equal(uc.sceneStates.states.length, 3);
  assert.equal(uc.sceneStates.states[1].name, second.name);
});

test("serialization drops keys of deleted layers and skips empty scenes", () => {
  const uc = fakeWidget([layer("a"), layer("b", { stateOffset: { x: 4, y: 0 } })]);
  assert.equal(serializeSceneStates(uc), null);
  newStateFromCurrent(uc);
  uc.layers = uc.layers.filter((item) => item.id !== "a");
  const saved = serializeSceneStates(uc);
  assert.deepEqual(Object.keys(saved.states[0].layers), ["b"]);
  assert.deepEqual(serializeStateOffset(uc, uc.layers[0]), { stateOffset: { x: 4, y: 0 } });
  assert.deepEqual(serializeStateOffset(uc, layer("z")), { stateOffset: null });
  assert.deepEqual(serializeStateOffset(uc, layer("m", { type: "mask" })), {});
  const restored = normalizeSceneStates(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.activeStateId, saved.activeStateId);
  assert.deepEqual(restored.states[0].layers, saved.states[0].layers);
});

test("Alt+digit applies states by index", () => {
  const uc = fakeWidget([layer("a")]);
  const first = newStateFromCurrent(uc);
  newStateFromCurrent(uc);
  assert.ok(applySceneStateByIndex(uc, 0));
  assert.equal(uc.sceneStates.activeStateId, first.id);
  assert.equal(applySceneStateByIndex(uc, 5), false);
  assert.match(modesSource, /Digit\(\[1-9\]\)/);
  assert.match(modesSource, /applySceneStateByIndex/);
});

test("the widget routes composites, bounds and tools through the state offset", () => {
  for (const pattern of [
    // The render transform (issue #9) is the state offset plus the timeline frame.
    /getLayerRenderTransform\(layer\) \{[\s\S]{0,200}const offset = this\.getLayerStateOffset\(layer\);\n\s+return \[1, 0, 0, 1, offset\.x, offset\.y\];/,
    /const renderMatrix = this\.getLayerRenderTransform\(layer\);\n\s+const stateOffset = \{ x: renderMatrix\[4\], y: renderMatrix\[5\] \};/,
    /target\.drawImage\(layer\.canvas, offset\.x, offset\.y\)/,
    /getLayerWorldBounds\(layer = this\.activeLayer\) \{[\s\S]{0,160}getLayerRenderTransform/,
    /beginSceneStateMove\?\.\(\)/,
    /commitSceneStateMove\?\.\(this\.dragStart\)/,
    /SCENE_STATE_HISTORY_KINDS\.has\(entry\.kind\)/,
    /sceneStates: this\.serializeSceneStates\?\.\(\) \?\? null/,
    /this\.restoreSceneStates\?\.\(state\.sceneStates\)/,
    /ctx\.translate\(-this\.origin\.x - stateOffset\.x, -this\.origin\.y - stateOffset\.y\)/,
  ]) {
    assert.match(widgetSource, pattern);
  }
});
