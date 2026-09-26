import test from "node:test";
import assert from "node:assert/strict";
import { buildPsdChildren, countPsdLayers, psdBlendMode, psdOpacity } from "../web/vnccs_unicanvas_psd_export.mjs";
import { createGroupLayer } from "../web/vnccs_unicanvas_groups.mjs";

const raster = (id, extra = {}) => ({ id, name: id, type: "raster", visible: true, opacity: 1, blendMode: "source-over", groupId: null, ...extra });

test("groups export as PSD folders with their opacity and blend, bottom first", () => {
  const outer = createGroupLayer({ id: "outer", name: "Characters", opacity: 0.5, blendMode: "multiply" });
  const inner = createGroupLayer({ id: "inner", name: "Hero", groupId: "outer", collapsed: true });
  // The widget's flat order is top to bottom with each subtree right after its group.
  const layers = [
    raster("top", { opacity: 0.25, blendMode: "screen" }),
    outer, inner, raster("face", { groupId: "inner" }), raster("body", { groupId: "outer", blendMode: "color-dodge" }),
    raster("hidden", { visible: false }),
    createGroupLayer({ id: "empty", name: "Empty" }),
    raster("background"),
  ];
  const children = buildPsdChildren(layers, (layer) => ({ name: layer.name }));
  assert.deepEqual(children.map((child) => child.name), ["background", "Characters", "top"]);
  const folder = children[1];
  assert.equal(folder.opacity, 0.5);
  assert.equal(folder.blendMode, "multiply");
  assert.equal(folder.opened, true);
  assert.deepEqual(folder.children.map((child) => child.name), ["body", "Hero"]);
  assert.equal(folder.children[0].blendMode, "color dodge");
  assert.equal(folder.children[1].blendMode, "pass through");
  assert.equal(folder.children[1].opened, false);
  assert.deepEqual(folder.children[1].children.map((child) => child.name), ["face"]);
  assert.equal(children[2].opacity, 0.25, "opacity is 0..1: ag-psd writes the byte");
  assert.equal(children[2].blendMode, "screen");
  assert.equal(countPsdLayers(children), 4);
});

test("a faded pass-through group is isolated in the canvas, so it exports as a normal folder", () => {
  assert.equal(psdBlendMode(createGroupLayer({ opacity: 0.4 })), "normal");
  assert.equal(psdBlendMode(createGroupLayer({})), "pass through");
  assert.equal(psdBlendMode(raster("a", { blendMode: "unknown" })), "normal");
  assert.equal(psdOpacity({ opacity: 2 }), 1);
  assert.equal(psdOpacity({}), 1);
});

test("a leaf builder can skip layers and a group with no exported child is dropped", () => {
  const group = createGroupLayer({ id: "g" });
  const layers = [group, raster("a", { groupId: "g" }), { id: "m", type: "mask", visible: true }, raster("b")];
  const children = buildPsdChildren(layers, (layer) => (layer.id === "b" ? { name: "b" } : null));
  assert.deepEqual(children.map((child) => child.name), ["b"]);
});
