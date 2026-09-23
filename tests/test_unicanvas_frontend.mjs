import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const source = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");


test("imported UniCanvas images immediately refresh the layer list", () => {
    const method = source.match(/async importFile\(file\) \{[\s\S]*?\n  \}\n\n  loadImage\(src\)/);
    assert.ok(method, "UniCanvas importFile method not found");

    const addLayerIndex = method[0].indexOf('this.addLayer("raster"');
    const invalidateIndex = method[0].indexOf("this.invalidateLayerCaches(layer)");
    const listRenderIndex = method[0].indexOf("this.renderLayerList()");
    const canvasRenderIndex = method[0].indexOf("this.requestRender()");

    assert.ok(addLayerIndex >= 0, "image import must create a raster layer");
    assert.ok(invalidateIndex > addLayerIndex, "imported pixels must invalidate layer caches");
    assert.ok(listRenderIndex > invalidateIndex, "layer list must refresh after imported pixels are ready");
    assert.ok(canvasRenderIndex > listRenderIndex, "canvas redraw must follow the layer-list refresh");
});

test("re-importing the same image file works after its layer was deleted", () => {
    assert.match(source, /this\.fileInput\.addEventListener\("change"[\s\S]{0,260}?this\.fileInput\.value = "";/,
        "the file input must reset so picking the same file re-fires change");
});

test("settings gear drives remove bg and character generation", () => {
    assert.match(source, /openUniCanvasSettings\(\)/, "a settings entry must exist");
    assert.match(source, /generateCharacterFromPoseLayer/, "pose layers can generate the selected character");
    assert.ok(source.includes("char_gen_lora_name"), "the character recipe includes a pose studio LoRA");
    assert.ok(source.includes("remove_bg_model"), "the settings choose the remove-bg model");
});
