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

test("the settings gear sits next to the snap-to-grid icon", () => {
    assert.match(source, /this\.gearBtn = this\._button\("⚙", "vnccs-uc-icon", \(\) => this\.openUniCanvasSettings\(\), "Settings"\);/,
        "a gear button must be created for the corner bar");
    assert.match(source, /this\.settingsBar\.append\(this\.undoBtn, this\.redoBtn, this\.fitBtn, settingsSpacer, this\.snapBtn, this\.gearBtn\);/,
        "the gear must sit in the corner bar right after Snap to grid");
    assert.ok(!/\["\\u2699", "Settings"/.test(source), "the old Layers-section gear entry must be gone");
});

test("remove bg offers edit model / birefnet / rembg / sam 3 with BiRefNet default", () => {
    assert.ok(source.includes('remove_bg_model: "birefnet"'), "BiRefNet must be the default backend");
    for (const marker of ['["edit", "Edit model"]', '["birefnet", "BiRefNet"]', '["rembg", "rembg"]', '["sam3", "SAM 3"]']) {
        assert.ok(source.includes(marker), "missing remove bg backend option: " + marker);
    }
    assert.ok(source.includes('["qwen_image21", "Qwen Image 2.1"]'), "the edit-model backend needs the QI2.1 choice");
    assert.ok(source.includes('["minimax_h3", "MiniMax H3"]'), "the edit-model backend needs the MiniMax H3 choice");
});

test("edit model reference images upload next to Steps with Picture markers", () => {
    assert.ok(source.includes('data-action="edit-refs"'), "the cards icon button must exist");
    assert.ok(source.includes("data-edit-refs-badge"), "the icon must carry a count badge");
    assert.ok(source.includes('"Picture " + (index + 2)'), "uploaded images must be marked Picture 2..");
    assert.ok(source.includes("edit_reference_images"), "the uploads must persist in the widget settings");
    assert.match(source, /openEditReferenceImages\(\)/, "the popover entry point must exist");
});
