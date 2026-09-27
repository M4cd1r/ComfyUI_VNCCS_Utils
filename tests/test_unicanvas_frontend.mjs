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
    assert.match(source, /this\.gearBtn = this\._button\(UI_ICONS\.gear, "vnccs-uc-icon vnccs-uc-gear", \(\) => this\.openUniCanvasSettings\(\), "UniCanvas settings"\);/,
        "a gear button must be created for the corner bar");
    assert.match(source, /this\.settingsBar\.append\(this\.undoBtn, this\.redoBtn, this\.fitBtn, this\.zoomResetBtn, settingsSpacer, this\.snapBtn, this\.gearBtn\);/,
        "the gear must sit in the corner bar right after Snap to grid");
    assert.ok(!/\["\\u2699", "Settings"/.test(source), "the old Layers-section gear entry must be gone");
});

test("remove bg offers edit model / birefnet / rembg / sam 3 with BiRefNet default", async () => {
    assert.ok(source.includes('remove_bg_model: "birefnet"'), "BiRefNet must be the default backend");
    const removeBg = await readFile(new URL("../web/vnccs_unicanvas_remove_bg.mjs", import.meta.url), "utf8");
    assert.ok(source.includes("buildRemoveBgSettings(s, {"), "the settings popover builds the remove bg rows from the module");
    for (const marker of ['["edit", "Edit model"]', '["birefnet", "BiRefNet"]', '["rembg", "rembg"]', '["sam3", "SAM 3']) {
        assert.ok(removeBg.includes(marker), "missing remove bg backend option: " + marker);
    }
    assert.ok(removeBg.includes('["qwen_image21", "Qwen Image 2.1"]'), "the edit-model backend needs the QI2.1 choice");
    assert.ok(!removeBg.includes('"minimax_h3"'), "MiniMax H3 decodes RGB only: it is not a remove bg edit model");
    assert.ok(removeBg.includes("REMOVE_BG_DEFAULT_PROMPT"), "the universal remove bg prompt is editable");
    for (const key of ["model_loader", "gguf_arch", "clip_name", "vae_name", "steps", "cfg", "sampler_name", "scheduler", "lora_name", "prompt"]) {
        assert.ok(removeBg.includes(`"${key}"`), "the edit-model backend exposes " + key);
    }
    assert.ok(!removeBg.includes('"seed"'), "the seed is not user-facing (random per run)");
    assert.ok(!removeBg.includes('"lora_strength"'), "the remove bg LoRA always runs at strength 1");
});

test("edit model reference images upload next to Steps with per-family slot markers", () => {
    assert.ok(source.includes('data-action="edit-refs"'), "the cards icon button must exist");
    assert.ok(source.includes("data-edit-refs-badge"), "the icon must carry a count badge");
    assert.ok(source.includes("referenceSlotName(this.modelDescriptors, this.settings.generation_mode, index + 2)"), "uploaded images are marked with the active family's slot 2.. name");
    assert.ok(source.includes("edit_reference_images"), "the uploads must persist in the widget settings");
    assert.match(source, /openEditReferenceImages\(\)/, "the popover entry point must exist");
});

test("settings popover carries the anchored class and size contract", () => {
    assert.match(source, /\.vnccs-uc-settings-popover\s*\{[^}]*width:\s*440px/,
        "the settings popover must have the hard 440px width");
    assert.match(source, /\.vnccs-uc-settings-popover\s*\{[^}]*height:\s*min\(560px,\s*72vh\)/,
        "the settings popover must use the hard 560px/72vh height");
    assert.match(source, /\.vnccs-uc-settings-popover\s*\{[^}]*overflow-y:\s*auto/,
        "the settings popover content must scroll inside the hard size");
    assert.match(source, /\.vnccs-uc-settings-popover\s*\{[^}]*font-size:\s*13px/,
        "the settings popover must use the larger 13px type");
    assert.match(source, /anchorPopoverTo\(panel,\s*this\.gearBtn,\s*this\.container\)/,
        "the settings popover must be anchored under the gear inside the widget");
});

test("the Seed dice starts active on a fresh canvas", () => {
    assert.match(source, /const DEFAULT_SEED_MODE = "randomize"/,
        "the random seed mode must be the declared default");
    assert.match(source, /seed_mode: DEFAULT_SEED_MODE/,
        "fresh settings must default to the random seed mode");
    const sync = source.match(/syncSeedModeControl\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(sync, "syncSeedModeControl missing");
    assert.match(sync[1], /DEFAULT_SEED_MODE/,
        "the dice highlight must read the same default");
    assert.match(source, /if \(\(this\.settings\.seed_mode \|\| DEFAULT_SEED_MODE\) === "randomize"\) \{/,
        "GENERATE must draw a fresh seed while the random mode is on");
    assert.match(source, /=== "randomize" \? "fixed" : "randomize"/,
        "the dice must still toggle back to a fixed seed");
    assert.match(source, /seed_mode_user_set = true/,
        "clicking the dice must record the explicit choice");
    const migrate = source.match(/applySeedModeDefault\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(migrate, "applySeedModeDefault missing");
    assert.match(migrate[1], /seed_mode_user_set === true/,
        "an explicit dice choice must survive restores");
    assert.match(migrate[1], /= DEFAULT_SEED_MODE/,
        "states saved with the old default adopt the random dice");
    const restoreCalls = (source.match(/this\.applySeedModeDefault\(\);/g) || []).length;
    assert.ok(restoreCalls >= 2, "both restore paths (state and workflow settings) must migrate");
});

test("tool settings dock above the Layers section in the right sidebar", () => {
    assert.match(source, /this\.side\.insertBefore\(this\.toolSettingsSection, layersSection\)/,
        "tool settings must dock as a sidebar section above Layers");
    assert.match(source, /vnccs-uc-tool-settings-section/,
        "the docked tool settings must be styled as a sidebar section");
    assert.match(source, /if \(this\.toolSettingsSection\) this\.toolSettingsSection\.hidden = true;/,
        "tools without settings (move/pan/sam/bbox) must collapse the whole section");
    assert.match(source, /this\.showToolSettingsPanel\(`\$\{title\} Settings`, html\.join\(""\)\)/,
        "the section head must carry the active tool's title");
    assert.match(source, /if \(this\.toolSettingsTitle\) this\.toolSettingsTitle\.textContent = title;/,
        "showToolSettingsPanel must title the docked section");
    assert.ok(!/\.vnccs-uc-tool-settings \{ position:absolute/.test(source),
        "the old stage-overlay positioning must be gone");
});

test("feature panels (perspective, shadows) open the docked tool-settings section", async () => {
    // The section is hidden by default; a feature module that only filled the inner panel left
    // its controls (Calibrate, Scene light) invisible once tool settings moved into the sidebar.
    for (const file of ["vnccs_unicanvas_scene_place.mjs", "vnccs_unicanvas_harmonize.mjs"]) {
        const text = await readFile(new URL(`../web/${file}`, import.meta.url), "utf8");
        assert.match(text, /uc\.showToolSettingsPanel\(/, `${file} must show its panel through showToolSettingsPanel`);
        assert.ok(!/toolSettings\.classList\.add\("visible"\)/.test(text), `${file} must not toggle the inner panel by hand`);
    }
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

test("the preset picker head card reads as a dropdown: chevron, preset count, aria, keyboard", () => {
    const card = source.match(/  buildPresetCard\(preset, turbo = false, head = false\) \{[\s\S]*?\n  \}\n\n  getPresetGroupLabel/);
    assert.ok(card, "buildPresetCard method not found");
    const body = card[0];
    assert.match(source, /chevronDown: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"\/><\/svg>`/, "UI_ICONS must define a chevronDown icon");
    assert.ok(body.includes("${UI_ICONS.chevronDown}"), "the head card must render the chevron icon");
    assert.ok(body.includes("vnccs-uc-model-card-chevron"), "the chevron must carry its own class for the open-state rotation");
    assert.ok(body.includes("vnccs-uc-model-card-sub"), "the head card must show the Change model / N presets sub-line");
    assert.ok(body.includes("Change model / "), "the sub-line must advertise that the card opens the picker");
    assert.ok(body.includes("groupPresetsByType()"), "the preset count must come from groupPresetsByType()");
    assert.match(body, /const subLine = head \?/, "the sub-line belongs to the head card only");
    assert.match(body, /setAttribute\("aria-haspopup", "listbox"\)/, "the head card must declare aria-haspopup=listbox");
    assert.match(body, /setAttribute\("aria-expanded"/, "the head card must declare aria-expanded");
    assert.match(body, /e\.key === "Enter" \|\| e\.key === " "/, "Enter and Space must toggle the picker");
    assert.ok(body.includes("card.click()"), "keyboard activation must reuse the delegated click path");
    assert.match(body, /key !== "Escape"/, "Escape must close the open picker");
    assert.ok(source.includes(".vnccs-uc-model-picker.open .vnccs-uc-model-card.head .vnccs-uc-model-card-chevron { rotate:180deg; }"),
        "STYLES must rotate the head chevron while the picker is open");
    assert.ok(source.includes(".vnccs-uc-model-picker .vnccs-uc-model-card.head:hover { border-color:var(--uc-accent); }"),
        "STYLES must give the head card a select-like accent hover");
});
