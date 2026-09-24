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

test("settings gear drives remove bg; the mannequin character recipe is gone", () => {
    assert.match(source, /openUniCanvasSettings\(\)/, "a settings entry must exist");
    assert.ok(source.includes("remove_bg_model"), "the settings choose the remove-bg model");
    assert.ok(!source.includes("generateCharacterFromPoseLayer") && !source.includes("char_gen_"),
        "live Pose Studio layers generate through the pose layer itself, not a separate character recipe");
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

test("settings popover carries the anchored class and size contract", () => {
    assert.match(source, /\.vnccs-uc-settings-popover\s*\{[^}]*min-width:\s*400px/,
        "the settings popover must be at least 400px wide");
    assert.match(source, /\.vnccs-uc-settings-popover\s*\{[^}]*font-size:\s*13px/,
        "the settings popover must use the larger 13px type");
    assert.match(source, /\.vnccs-uc-settings-popover\s*\{[^}]*max-height:\s*70vh/,
        "the settings popover must cap its height at 70vh");
    assert.match(source, /anchorPopoverTo\(panel,\s*this\.gearBtn,\s*this\.container\)/,
        "the settings popover must be anchored under the gear inside the widget");
});

test("a linked VNCSS Config greys out every UniCanvas control it overrides", () => {
    for (const marker of [
        'data-preset-card-list data-config-override',
        'data-turbo-panel data-config-override',
        'data-lora-stack data-config-override',
        'class="vnccs-uc-model-tabs" data-config-override',
        'data-action="edit-refs" data-config-override',
        'data-config-override>Loader<select',
    ]) {
        assert.ok(source.includes(marker), "missing override marker: " + marker);
    }
    const sync = source.slice(source.indexOf("  syncConfigOverride() {"), source.indexOf("  _isConfigLinked() {"));
    assert.ok(sync.includes('classList.toggle("vnccs-uc-config-linked", linked)'));
    assert.ok(sync.includes("el.inert = linked"), "overridden controls must be inert, not just dimmed");
    assert.ok(sync.includes("VNCSS Config linked"), "a banner explains where the values come from");
    assert.ok(!/data-mode-control[^>]*data-config-override/.test(source), "Mode (model family) stays editable");
    assert.ok(source.includes("[data-config-override] { opacity:.38; filter:grayscale(1)"), "overridden controls read as greyed out");
});
