import assert from "node:assert/strict";
import test from "node:test";
import {
  feetPlacement, isZeroStateOffset, normalizeStateOffset, sameStateOffset, stateOffsetMatrix, stateOffsetPoint, stateOffsetRect, stateOffsetRestRect,
} from "../web/vnccs_unicanvas_state_offset.mjs";
import { composeLayerMatrix } from "../web/vnccs_unicanvas_timeline_core.mjs";
import { placeOpenPosePeople } from "../web/vnccs_unicanvas_control_scene.mjs";

// Per-state depth scale (#33 with #7 / #11): a render-time scale around the feet plus a move.

test("offsets keep a valid scale with its anchor and drop anything else", () => {
  assert.deepEqual(normalizeStateOffset({ x: 1.4, y: 2.6 }), { x: 1, y: 3 });
  assert.deepEqual(normalizeStateOffset({ x: 1, y: 2, scale: 1.5, ax: 10, ay: 20 }), { x: 1, y: 2, scale: 1.5, ax: 10, ay: 20 });
  assert.deepEqual(normalizeStateOffset({ x: 1, y: 2, scale: 1, ax: 10, ay: 20 }), { x: 1, y: 2 });
  assert.deepEqual(normalizeStateOffset({ x: 1, y: 2, scale: -1, ax: 10, ay: 20 }), { x: 1, y: 2 });
  assert.deepEqual(normalizeStateOffset({ x: 1, y: 2, scale: 2 }), { x: 1, y: 2 }, "a scale needs its anchor");
  assert.equal(normalizeStateOffset({ scale: 500, ax: 0, ay: 0 }).scale, 64);
  assert.equal(isZeroStateOffset({ x: 0, y: 0 }), true);
  assert.equal(isZeroStateOffset({ x: 0, y: 0, scale: 0.5, ax: 1, ay: 1 }), false);
  assert.equal(sameStateOffset({ x: 1, y: 1 }, { x: 1, y: 1, scale: 1 }), true);
  assert.equal(sameStateOffset({ x: 1, y: 1 }, { x: 1, y: 1, scale: 2, ax: 0, ay: 0 }), false);
});

test("the placement scales around the anchor, then moves; the inverse maps back", () => {
  const offset = normalizeStateOffset({ x: 5, y: -3, scale: 2, ax: 10, ay: 20 });
  assert.deepEqual(stateOffsetPoint(offset, { x: 10, y: 20 }), { x: 15, y: 17 }, "the anchor only moves");
  assert.deepEqual(stateOffsetPoint(offset, { x: 0, y: 0 }), { x: -5, y: -23 });
  assert.deepEqual(stateOffsetRect(offset, { x: 0, y: 0, width: 4, height: 6 }), { x: -5, y: -23, width: 8, height: 12 });
  assert.deepEqual(stateOffsetRestRect(offset, { x: -5, y: -23, width: 8, height: 12 }), { x: 0, y: 0, width: 4, height: 6 });
  assert.deepEqual(stateOffsetMatrix({ x: 2, y: 3 }), [1, 0, 0, 1, 2, 3]);
  assert.deepEqual(composeLayerMatrix(offset, []), stateOffsetMatrix(offset), "the timeline starts from the same placement");
  const feet = feetPlacement({ x: 50, y: 200 }, { x: 80, y: 260 }, 1.5);
  assert.deepEqual(stateOffsetPoint(feet, { x: 50, y: 200 }), { x: 80, y: 260 });
});

test("the pose ControlNet skeleton follows a depth-scaled state", () => {
  const people = [{ points: [{ x: 0.5, y: 1 }, { x: 0.5, y: 0 }] }];
  const offset = normalizeStateOffset({ x: 0, y: 0, scale: 0.5, ax: 50, ay: 100 });
  const [placed] = placeOpenPosePeople([{ rect: { x: 0, y: 0, width: 100, height: 100 }, offset, people }], { x: 0, y: 0, width: 100, height: 100 }, { width: 100, height: 100 });
  assert.deepEqual(placed, [{ x: 50, y: 100 }, { x: 50, y: 50 }]);
});
