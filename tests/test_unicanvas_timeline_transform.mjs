import test from "node:test";
import assert from "node:assert/strict";

import {
  TIMELINE_HISTORY_KIND,
  composeLayerMatrix,
  evaluateTrack,
  localMatrix,
  setKey,
  trackIdFor,
} from "../web/vnccs_unicanvas_timeline_core.mjs";
import { installUniCanvasTimeline } from "../web/vnccs_unicanvas_timeline.mjs";
import {
  changedTransformKeys,
  decomposeLocalMatrix,
  hitKeyHandle,
  isAffineQuad,
  keyHandleGeometry,
  quadToAffine,
  rotationFromDrag,
  scaleFromDrag,
  transformKeysFromFrame,
} from "../web/vnccs_unicanvas_timeline_transform.mjs";
import { draftPlacement, draftRestBounds, placedQuad, rectToQuad, rotateQuad, translateQuad } from "../web/vnccs_unicanvas_transform.mjs";
import { transformPointMap } from "../web/vnccs_unicanvas_sprites.mjs";
import { stateOffsetMatrix } from "../web/vnccs_unicanvas_state_offset.mjs";

const near = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const nearPoint = (actual, expected, epsilon = 1e-6) => { near(actual.x, expected.x, epsilon); near(actual.y, expected.y, epsilon); };
const REST = { x: 100, y: 100, width: 50, height: 100 };
const ANCHOR = { x: 125, y: 200 }; // bottom center of REST: the key anchor (feet)

// Pure math ------------------------------------------------------------------------------------

test("a keyed local matrix decomposes back into the keys that built it", () => {
  const state = { tx: 12, ty: -7, sx: 1.5, sy: 0.75, rotation: 30 };
  const back = decomposeLocalMatrix(localMatrix(state, ANCHOR), ANCHOR);
  for (const key of ["tx", "ty", "sx", "sy", "rotation"]) near(back[key], state[key], 1e-9);
  near(back.skew, 0, 1e-9);
  // The rotation takes the turn closest to the current key: no spin through 360.
  near(decomposeLocalMatrix(localMatrix({ rotation: 350 }, ANCHOR), ANCHOR, 340).rotation, 350, 1e-9);
  near(decomposeLocalMatrix(localMatrix({ rotation: -10 }, ANCHOR), ANCHOR, 0).rotation, -10, 1e-9);
  // A mirror lands in sy.
  const flipped = decomposeLocalMatrix(localMatrix({ sx: 1, sy: -1 }, ANCHOR), ANCHOR);
  assert.ok(flipped.sy < 0);
});

test("the frame fit is exact for parallelograms and flags distortion", () => {
  const matrix = localMatrix({ tx: 5, ty: 3, sx: 2, sy: 2, rotation: 45 }, ANCHOR);
  const quad = placedQuad(REST, matrix);
  const fit = quadToAffine(quad, REST);
  for (let index = 0; index < 6; index += 1) near(fit[index], matrix[index], 1e-9);
  assert.equal(isAffineQuad(quad), true);
  const bent = { ...quad, se: { x: quad.se.x + 20, y: quad.se.y } };
  assert.equal(isAffineQuad(bent), false);
});

test("Free Transform on a keyed frame yields keys that reproduce the frame under the parent and effects", () => {
  // Parent: a scene-state offset plus a keyed group move; effects: a bob and a breathe.
  const parent = composeLayerMatrix({ x: 40, y: 0 }, [{ state: { tx: 0, ty: 10, sx: 1, sy: 1, rotation: 0 }, anchor: { x: 0, y: 0 } }]);
  const effects = { dx: 0, dy: -4, scaleY: 1.02 };
  const current = { position: [10, 0], scale: [1, 1], rotation: 0 };
  const start = placedQuad(REST, parent);
  // The user rotates the shown frame by 90 degrees around its center and moves it.
  const center = { x: (start.nw.x + start.se.x) / 2, y: (start.nw.y + start.se.y) / 2 };
  const quad = translateQuad(rotateQuad(start, center, Math.PI / 2), 15, 0);
  const keys = transformKeysFromFrame({ quad, mesh: null }, { rest: REST, parent, anchor: ANCHOR, effects, current });
  assert.equal(keys.lossy, false);
  near(keys.rotation, 90, 1e-9);
  // Re-evaluating: keys + effects under the parent land exactly on the frame.
  const state = { tx: keys.position[0] + effects.dx, ty: keys.position[1] + effects.dy, sx: keys.scale[0], sy: keys.scale[1] * effects.scaleY, rotation: keys.rotation };
  const shown = placedQuad(REST, composeLayerMatrix({ x: 40, y: 0 }, [{ state: { tx: 0, ty: 10 }, anchor: { x: 0, y: 0 } }, { state, anchor: ANCHOR }]));
  for (const key of ["nw", "ne", "se", "sw"]) nearPoint(shown[key], quad[key], 1e-6);
  assert.deepEqual(changedTransformKeys(keys, current).sort(), ["position", "rotation", "scale"]);
  // A pure move only changes the position key.
  const moved = transformKeysFromFrame({ quad: translateQuad(start, 7, 0), mesh: null }, { rest: REST, parent, anchor: ANCHOR, effects: null, current: { position: [0, 0], scale: [1, 1], rotation: 0 } });
  assert.deepEqual(changedTransformKeys(moved, { position: [0, 0], scale: [1, 1], rotation: 0 }), ["position"]);
  near(moved.position[0], 7, 1e-9);
  // A warp mesh or a distorted corner cannot be keyed exactly.
  assert.equal(transformKeysFromFrame({ quad: start, mesh: [] }, { rest: REST, parent, anchor: ANCHOR, current }).lossy, true);
});

test("handle drags: uniform scale around the pivot, rotation with Shift snapping and mirrors", () => {
  const pivot = { x: 0, y: 0 };
  assert.deepEqual(scaleFromDrag(pivot, { x: 10, y: 0 }, { x: 20, y: 0 }, [1, 0.5]), [2, 1]);
  const tiny = scaleFromDrag(pivot, { x: 10, y: 0 }, { x: 0, y: 0 }, [1, 1]);
  assert.ok(tiny[0] >= 0.01 && tiny[1] >= 0.01, "never collapses to zero");
  near(rotationFromDrag(pivot, { x: 10, y: 0 }, { x: 0, y: 10 }, 5), 95, 1e-9);
  near(rotationFromDrag(pivot, { x: 10, y: 0 }, { x: 0, y: 10 }, 5, { direction: -1 }), -85, 1e-9);
  near(rotationFromDrag(pivot, { x: 10, y: 0 }, { x: 10, y: 3 }, 0, { snap: true }), 15, 1e-9);
  const geometry = keyHandleGeometry(REST, [1, 0, 0, 1, 0, 0], ANCHOR, 20);
  nearPoint(geometry.knob, { x: 125, y: 80 });
  nearPoint(geometry.pivot, ANCHOR);
  assert.deepEqual(hitKeyHandle(geometry, { x: 126, y: 81 }, 5), { kind: "rotate" });
  assert.deepEqual(hitKeyHandle(geometry, { x: 149, y: 199 }, 5), { kind: "scale", corner: "se" });
  assert.equal(hitKeyHandle(geometry, { x: 125, y: 150 }, 5), null);
});

// Free Transform placement (state scale, #7 / #11) ---------------------------------------------

test("a draft placement maps the stored pixels to where they show and back", () => {
  assert.deepEqual(draftPlacement({}), [1, 0, 0, 1, 0, 0]);
  assert.deepEqual(draftPlacement({ stateOffset: { x: 4, y: -2 } }), [1, 0, 0, 1, 4, -2]);
  assert.deepEqual(draftRestBounds({ stateOffset: { x: 4, y: -2 }, sourceBounds: { x: 14, y: 8, width: 5, height: 5 } }), { x: 10, y: 10, width: 5, height: 5 });
  // A depth-scaled state: scale 2 around the feet (125, 200), then a move by (10, 0).
  const placement = stateOffsetMatrix({ x: 10, y: 0, scale: 2, ax: 125, ay: 200 });
  const quad = placedQuad(REST, placement);
  assert.deepEqual(quad.sw, { x: 85, y: 200 });
  assert.deepEqual(quad.ne, { x: 185, y: 0 });
  // Sprite geometry follows the frame into the STORED space: an untouched frame is the identity.
  const draft = { placement, restBounds: REST, sourceBounds: { x: 85, y: 0, width: 100, height: 200 }, quad, mesh: null };
  const map = transformPointMap(draft);
  nearPoint(map({ x: 125, y: 200 }), { x: 125, y: 200 });
  nearPoint(map({ x: 100, y: 100 }), { x: 100, y: 100 });
  // Doubling the shown frame around the feet doubles the stored pixels around the feet.
  const bigger = { ...draft, quad: placedQuad(REST, [4, 0, 0, 4, 10 + 125 * -3, 200 * -3]) };
  nearPoint(transformPointMap(bigger)({ x: 100, y: 100 }), { x: 75, y: 0 });
});

// Controller -----------------------------------------------------------------------------------

function fakeWidget() {
  const layer = { id: "L", type: "raster", visible: true, opacity: 1, name: "Hero" };
  const uc = {
    standalone: true,
    tool: "move",
    view: { scale: 1 },
    layers: [layer],
    activeLayerId: "L",
    get activeLayer() { return this.layers.find((item) => item.id === this.activeLayerId); },
    bbox: { x: 0, y: 0, width: 512, height: 512 },
    undoStack: [],
    renders: 0,
    statuses: [],
    transformDraft: null,
    pushHistoryEntry(entry) { this.undoStack.push(entry); },
    requestRender() { this.renders++; },
    render() {},
    setStatus(text, error) { this.statuses.push({ text, error: Boolean(error) }); },
    getLayerStateOffset: () => ({ x: 0, y: 0 }),
    getLayerRestBounds: () => ({ ...REST }),
    getLayerRenderTransform(item) { return this.timelinePanel.layerMatrix(item) || [1, 0, 0, 1, 0, 0]; },
  };
  installUniCanvasTimeline(uc);
  uc.timelinePanel.open = true;
  uc.timelinePanel.ensureData();
  return { uc, layer, panel: uc.timelinePanel };
}

test("Free Transform on an offset frame writes position / scale / rotation keys, one history entry", () => {
  const { uc, layer, panel } = fakeWidget();
  setKey(uc.timeline, "L", "position", 0, [0, 0]);
  setKey(uc.timeline, "L", "position", 10, [60, 0]);
  panel.setFrame(10, { render: false });
  const keyFrame = panel.transformKeyFrame(layer);
  assert.ok(keyFrame, "a keyed frame opens a keyed draft");
  assert.equal(keyFrame.frame, 10);
  // The draft starts where the layer shows (moved by 60) and is scaled 2x around the feet.
  const placement = uc.getLayerRenderTransform(layer);
  const start = placedQuad(REST, placement);
  assert.deepEqual(start.nw, { x: 160, y: 100 });
  const feet = { x: 185, y: 200 };
  const quad = Object.fromEntries(Object.entries(start).map(([key, p]) => [key, { x: feet.x + (p.x - feet.x) * 2, y: feet.y + (p.y - feet.y) * 2 }]));
  panel.commitTransformKeys(layer, { quad, mesh: null, keyFrame });
  assert.deepEqual(evaluateTrack(uc.timeline, trackIdFor("L", "scale"), 10), [2, 2]);
  assert.deepEqual(evaluateTrack(uc.timeline, trackIdFor("L", "position"), 10), [60, 0]);
  assert.equal(uc.timeline.tracks["L:rotation"], undefined, "unchanged properties get no key");
  assert.equal(uc.undoStack.length, 1);
  assert.equal(uc.undoStack[0].kind, TIMELINE_HISTORY_KIND);
  const shown = placedQuad(REST, panel.layerMatrix(layer));
  for (const key of ["nw", "ne", "se", "sw"]) nearPoint(shown[key], quad[key], 1e-9);
  panel.applyHistory(uc.undoStack[0], "undo");
  assert.equal(uc.timeline.tracks["L:scale"], undefined);
});

test("a layer at rest, a mask, or auto-key off keeps the pixel Free Transform", () => {
  const { uc, layer, panel } = fakeWidget();
  assert.equal(panel.transformKeyFrame(layer), null, "no keys: the rest frame edits pixels");
  setKey(uc.timeline, "L", "position", 0, [30, 0]);
  assert.ok(panel.transformKeyFrame(layer));
  panel.autoKey = false;
  assert.equal(panel.transformKeyFrame(layer), null, "auto-key off: the draft edits the stored pixels");
  panel.autoKey = true;
  assert.equal(panel.transformKeyFrame({ ...layer, type: "mask" }), null);
  panel.open = false;
  assert.equal(panel.transformKeyFrame(layer), null);
});

test("distortion that no key can hold is dropped with a status message", () => {
  const { uc, layer, panel } = fakeWidget();
  setKey(uc.timeline, "L", "position", 0, [30, 0]);
  const keyFrame = panel.transformKeyFrame(layer);
  const quad = placedQuad(REST, uc.getLayerRenderTransform(layer));
  quad.se = { x: quad.se.x + 25, y: quad.se.y + 10 };
  panel.commitTransformKeys(layer, { quad, mesh: null, keyFrame });
  assert.equal(uc.undoStack.length, 1);
  assert.match(uc.statuses.at(-1).text, /dropped/);
});

test("key handles: scale and rotation keys update live during the drag and commit once", () => {
  const { uc, layer, panel } = fakeWidget();
  panel.setFrame(4, { render: false });
  const handles = panel.keyHandles;
  assert.equal(handles.hit({ x: 300, y: 300 }), null);
  // Grab the se corner (150, 200); the pivot is the feet (125, 200).
  uc.dragStart = {};
  assert.equal(handles.begin({ x: 150, y: 200 }), true);
  assert.equal(uc.pointerMode, "timeline-key-handle");
  const rendersBefore = uc.renders;
  handles.update({ x: 175, y: 200 });
  assert.deepEqual(evaluateTrack(uc.timeline, trackIdFor("L", "scale"), 4), [2, 2], "the key follows the pointer before release");
  assert.ok(uc.renders > rendersBefore, "every move renders");
  handles.update({ x: 162.5, y: 200 });
  assert.deepEqual(evaluateTrack(uc.timeline, trackIdFor("L", "scale"), 4), [1.5, 1.5]);
  assert.equal(uc.undoStack.length, 0, "no history entry during the gesture");
  handles.end();
  assert.equal(uc.undoStack.length, 1);
  assert.equal(uc.undoStack[0].kind, TIMELINE_HISTORY_KIND);
  assert.deepEqual(uc.undoStack[0].before.tracks, {}, "the entry starts from the timeline before the gesture");

  // The rotate knob sits above the scaled frame; a quarter turn around the feet.
  const geometry = handles.geometry(layer);
  assert.equal(handles.begin(geometry.knob, null), true);
  const pivot = geometry.pivot;
  const r = Math.hypot(geometry.knob.x - pivot.x, geometry.knob.y - pivot.y);
  handles.update({ x: pivot.x + r, y: pivot.y }, { shiftKey: true });
  near(evaluateTrack(uc.timeline, trackIdFor("L", "rotation"), 4), 90, 1e-9);
  handles.end();
  assert.equal(uc.undoStack.length, 2);
  panel.applyHistory(uc.undoStack[1], "undo");
  assert.equal(uc.timeline.tracks["L:rotation"], undefined);

  // Hidden unless the Move tool, auto-key and the dock are on, and never over an open transform.
  uc.tool = "brush";
  assert.equal(handles.target(), null);
  uc.tool = "move";
  uc.transformDraft = {};
  assert.equal(handles.target(), null);
  uc.transformDraft = null;
  panel.autoKey = false;
  assert.equal(handles.begin({ x: 150, y: 200 }), false);
});

test("rest quad helpers match the old axis-aligned frame for a plain offset", () => {
  assert.deepEqual(placedQuad(REST, [1, 0, 0, 1, 5, 6]), rectToQuad({ ...REST, x: 105, y: 106 }));
});
