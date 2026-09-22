import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const inputTools = await readFile(new URL("../web/vnccs_unicanvas_input_tools.mjs", import.meta.url), "utf8");
const layerTools = await readFile(new URL("../web/vnccs_unicanvas_layer_tools.mjs", import.meta.url), "utf8");
const widgetSource = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");

const MENU_LABELS = [
  "Copy layer as image to clipboard",
  "Save layer as image",
  "Remove bg \u2013 QI2.1",
  "Remove bg \u2013 BiRefNet",
  "Color match to below",
  "Rasterize",
  "Edit pose",
];

test("widget source installs both tool packs", () => {
  assert.match(widgetSource, /import \{ installUniCanvasInputTools \} from "\.\/vnccs_unicanvas_input_tools\.mjs";/);
  assert.match(widgetSource, /import \{ installUniCanvasLayerTools \} from "\.\/vnccs_unicanvas_layer_tools\.mjs";/);
  assert.match(widgetSource, /installUniCanvasInputTools\(this\);/);
  assert.match(widgetSource, /installUniCanvasLayerTools\(this\);/);
});

test("Alt guard keeps the brush-size gesture and the radial HUD apart", () => {
  assert.match(inputTools, /if \(e\.altKey\) \{[\s\S]*?startBrushSizeGesture\(uc, e\);/);
  assert.match(inputTools, /else if \(uc\.tool !== "sam"\) \{[\s\S]*?openRadialHud\(uc, e\);/);
  assert.ok(inputTools.includes("BRUSH_FAMILY_TOOLS.has(uc.tool)"), "the size gesture must be limited to brush-family tools");
  assert.ok(inputTools.includes("BRUSH_SIZE_GESTURE_SENSITIVITY = 0.5"), "size sensitivity must stay at ~0.5 px per pointer px");
});

test("radial HUD maps the four drag directions to parameters", () => {
  assert.ok(inputTools.includes('direction: "up", key: "size"'), "up must adjust size");
  assert.ok(inputTools.includes('direction: "right", key: "opacity"'), "right must adjust opacity");
  assert.ok(inputTools.includes('direction: "down", key: "hardness"'), "down must adjust hardness");
  assert.ok(inputTools.includes('direction: "left", key: "color"'), "left must adjust the foreground color");
});

test("brushHardness is a brush-engine setting with radial-gradient stamps", () => {
  assert.ok(inputTools.includes("brushHardness"), "brushHardness setting must exist");
  assert.ok(inputTools.includes('data-control="brushHardness"'), "brushHardness needs a tool-settings slider");
  assert.ok(inputTools.includes("createRadialGradient"), "soft edges must use radial-gradient stamps");
  assert.match(inputTools, /addEventListener\("input"/, "the hardness slider must update continuously from input events");
});

test("layer context menu defines all seven entries", () => {
  for (const label of MENU_LABELS) {
    assert.ok(layerTools.includes(`"${label}"`), `missing menu entry: ${label}`);
  }
  assert.equal(MENU_LABELS.length, 7);
});

test("pose entries guard the parallel-branch methods with a status fallback", () => {
  assert.ok(layerTools.includes('typeof uc.rasterizePoseLayer === "function"'));
  assert.ok(layerTools.includes('typeof uc.editPoseLayer === "function"'));
  assert.ok(layerTools.includes("[VNCCS UniCanvas] Pose tools are not available."));
});

test("Import PSD sits next to Export Layers as PSD", () => {
  assert.ok(layerTools.includes('"Import PSD"'), "Import PSD button label must exist");
  assert.ok(layerTools.includes('"Export Layers as PSD"'), "the export button must stay the placement anchor");
  assert.match(layerTools, /insertBefore\(importButton, exportButton \|\| null\)/, "Import PSD must be inserted next to the export button");
});

test("PSD import reports every skipped non-raster construct", () => {
  for (const reason of [
    "clipping mask",
    "adjustment layer",
    "layer effects",
    "text/vector/smart-object layer without raster data",
  ]) {
    assert.ok(layerTools.includes(reason), `missing skip reason: ${reason}`);
  }
  assert.match(layerTools, /PSD imported \$\{importedCount\} raster layers/, "the status line must report the imported count");
  assert.match(layerTools, /skipped \$\{skipped\.length\}/, "the status line must report skipped layers");
});

test("strength slider previews live and commits on release", () => {
  assert.ok(layerTools.includes('data-control="colorMatchStrength"'), "strength slider must exist");
  assert.match(layerTools, /strengthInput\.addEventListener\("input"/, "dragging must update the preview from input events");
  assert.ok(layerTools.includes("requestAnimationFrame"), "per-frame work must be coalesced");
  assert.ok(layerTools.includes("stale preview dropped; newest value wins"), "stale async previews must be dropped");
  assert.match(layerTools, /strengthInput\.addEventListener\("pointerup"/, "release must commit");
  assert.match(layerTools, /kind: "layerPixels"/, "the commit must record a layerPixels history entry");
});
