import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    VN_PREVIEW_PRESETS,
    VN_PREVIEW_SKIN_IDS,
    VN_PREVIEW_TEXT_LENGTHS,
    faceRegionForLayer,
    fitAspect,
    isCharacterLayer,
    layoutVnPreview,
    makeLoremChars,
    makeLoremLines,
    mapSkinRect,
    normalizeVnPreviewSkin,
    normalizeVnPreviewState,
    presetById,
    rectsIntersect,
    skinUnitsForPreset,
    wrapText,
} from "../web/vnccs_unicanvas_vn_preview.mjs";

// Monospace stand-in for canvas measureText: every character is 0.55 em wide.
const measure = (font, text) => {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] || 10);
    return text.length * size * 0.55;
};

const widget = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const modes = await readFile(new URL("../web/vnccs_unicanvas_modes.mjs", import.meta.url), "utf8");

async function skin(id) {
    return normalizeVnPreviewSkin(JSON.parse(await readFile(new URL(`../web/assets/vn_preview_skins/${id}.json`, import.meta.url), "utf8")));
}

function method(source, signature) {
    const start = source.indexOf(`\n  ${signature}`);
    assert.ok(start >= 0, `method not found: ${signature}`);
    const next = source.slice(start + 1).search(/\n  (?:async )?[A-Za-z_$][\w$]*\([^)]*\) \{\n/);
    return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

test("state normalizes: old states without vn_preview get defaults, junk is dropped", () => {
    const empty = normalizeVnPreviewState(undefined);
    assert.equal(empty.enabled, false);
    assert.equal(empty.preset, "16x9_1080");
    assert.equal(empty.skinId, "clean_dark");
    assert.equal(empty.lockFrame, false);
    assert.equal(empty.frameRect, null);
    const state = normalizeVnPreviewState({ enabled: true, preset: "nope", skinId: "classic_paper", textLength: "long", seed: "12", toggles: { choiceMenu: true, bogus: 1 }, lockFrame: true, frameRect: { x: 1, y: 2, width: "30", height: 40 } });
    assert.equal(state.enabled, true);
    assert.equal(state.preset, "16x9_1080");
    assert.equal(state.skinId, "classic_paper");
    assert.equal(state.seed, 12);
    assert.equal(state.toggles.choiceMenu, true);
    assert.equal("bogus" in state.toggles, false);
    assert.deepEqual(state.frameRect, { x: 1, y: 2, width: 30, height: 40 });
});

test("the presets cover the plan's aspects and reference resolutions", () => {
    assert.deepEqual(VN_PREVIEW_PRESETS.map((p) => `${p.width}x${p.height}`), ["1920x1080", "1280x720", "1440x1080", "1920x1200", "1080x1920"]);
    const frame = fitAspect({ x: 0, y: 0, width: 1024, height: 1024 }, 16 / 9);
    assert.equal(frame.width, 1024);
    assert.equal(Math.round(frame.height), 576);
    assert.equal(Math.round(frame.y), 224);
    const portrait = fitAspect({ x: 0, y: 0, width: 1024, height: 1024 }, 9 / 16);
    assert.equal(portrait.height, 1024);
    assert.ok(portrait.height > portrait.width);
});

test("every shipped skin loads, keeps the generic format and fits its reference frame", async () => {
    for (const id of VN_PREVIEW_SKIN_IDS) {
        const s = await skin(id);
        assert.equal(s.id, id);
        assert.equal(s.format, "vnccs-vn-preview-skin");
        assert.ok("nineSlice" in s.textbox && "nineSlice" in s.nameplate, `${id}: 9-slice fields reserved`);
        for (const preset of VN_PREVIEW_PRESETS) {
            for (const length of VN_PREVIEW_TEXT_LENGTHS) {
                const state = normalizeVnPreviewState({ enabled: true, preset: preset.id, textLength: length.id, seed: 3, toggles: { choiceMenu: true, sideImage: true } });
                const layout = layoutVnPreview({ skin: s, preset, state, measure });
                const { width: W, height: H } = layout.units;
                const tb = layout.textbox;
                assert.ok(tb.x >= 0 && tb.y >= 0 && tb.x + tb.width <= W + 1e-6 && tb.y + tb.height <= H + 1e-6, `${id} ${preset.id}: textbox inside frame`);
                assert.ok(layout.lines.length >= 1 && layout.lines.length <= s.dialogue.maxLines);
                for (const line of layout.lines) {
                    assert.ok(line.x + line.width <= tb.x + tb.width - s.textbox.padding.right + 1e-6, `${id} ${preset.id} ${length.id}: line fits horizontally`);
                    assert.ok(line.y + line.height <= tb.y + tb.height + 1e-6, `${id} ${preset.id} ${length.id}: line fits vertically`);
                }
                assert.equal(layout.quickMenu.length, 7);
                assert.ok(layout.choices.length >= 2 && layout.choices.length <= 3);
            }
        }
    }
});

test("the default textbox is bottom, full width minus 2x60, 260 high, 34 px text", async () => {
    const s = await skin("clean_dark");
    const layout = layoutVnPreview({ skin: s, preset: presetById("16x9_1080"), state: normalizeVnPreviewState({}), measure });
    assert.deepEqual(layout.textbox, { x: 60, y: 1080 - 44 - 260, width: 1800, height: 260 });
    assert.equal(s.dialogue.font.size, 34);
    assert.equal(layout.nameplate.name, "Lorem");
    assert.ok(layout.nameplate.y < layout.textbox.y, "the nameplate overlaps the textbox top");
    // 720p scales the design uniformly: same proportions.
    const units = skinUnitsForPreset(s, presetById("16x9_720"));
    assert.equal(units.width, 1920);
});

test("max lines fills exactly the skin's max lines, two lines exactly two", async () => {
    for (const id of VN_PREVIEW_SKIN_IDS) {
        const s = await skin(id);
        for (const seed of [1, 2, 99, 12345]) {
            const max = layoutVnPreview({ skin: s, preset: presetById("16x9_1080"), state: normalizeVnPreviewState({ textLength: "max_lines", seed }), measure });
            assert.equal(max.lines.length, s.dialogue.maxLines, `${id} seed ${seed}`);
            assert.equal(max.overflow, false);
            const two = layoutVnPreview({ skin: s, preset: presetById("16x9_1080"), state: normalizeVnPreviewState({ textLength: "two_lines", seed }), measure });
            assert.equal(two.lines.length, Math.min(2, s.dialogue.maxLines));
        }
    }
});

test("lorem text is seeded, placeholder-only and near the requested length", () => {
    assert.equal(makeLoremChars(7, 110), makeLoremChars(7, 110));
    assert.notEqual(makeLoremChars(7, 110), makeLoremChars(8, 110));
    for (const chars of [40, 110, 220]) {
        const text = makeLoremChars(5, chars);
        assert.ok(Math.abs(text.length - chars) <= 16, `${chars} -> ${text.length}`);
        assert.match(text, /^[A-Z][A-Za-z ,.]+\.$/);
    }
    const width = 400;
    const m = (t) => measure("10px x", t);
    const text = makeLoremLines(3, 3, width, m);
    assert.equal(wrapText(text, width, m).length, 3);
});

test("wrapText never exceeds the width, even for one long word", () => {
    const m = (t) => t.length * 10;
    const lines = wrapText("a bb ccc supercalifragilistic dd", 80, m);
    for (const line of lines) assert.ok(m(line) <= 80, line);
    assert.equal(lines.join("").replace(/ /g, ""), "abbcccsupercalifragilisticdd");
});

test("character layers and face regions: sprite faceRect, bake headRect, else top 18% of alpha", () => {
    const uc = {
        origin: { x: -100, y: -50 },
        layers: [],
        getLayerAlphaBounds: () => ({ x: 200, y: 100, width: 300, height: 500 }),
        getLayerMovePreview: (layer) => (layer.id === "moving" ? { dx: 0, dy: -40 } : null),
    };
    const group = { id: "g", type: "group", name: "Characters" };
    uc.layers.push(group);
    assert.equal(isCharacterLayer(uc, { type: "pose" }), true);
    assert.equal(isCharacterLayer(uc, { type: "raster", meta: { origin: "import" } }), false);
    assert.equal(isCharacterLayer(uc, { type: "raster", meta: { origin: "sprite" } }), true);
    assert.equal(isCharacterLayer(uc, { type: "raster", meta: { origin: "paint", character: { name: "Eileen" } } }), true);
    assert.equal(isCharacterLayer(uc, { type: "raster", groupId: "g" }), true);
    assert.equal(isCharacterLayer(uc, { type: "mask" }), false);

    const sprite = { type: "raster", sprite: { rect: { x: 10, y: 20, width: 100, height: 200 }, faceRect: { x: 30, y: 5, width: 40, height: 40 } } };
    assert.deepEqual(faceRegionForLayer(uc, sprite), { x: 40, y: 25, width: 40, height: 40 });
    const baked = { type: "pose", canvas: {}, pose: { bake: { characters: { a: { headRect: { x: 5, y: 6, width: 7, height: 8 } } } } } };
    assert.deepEqual(faceRegionForLayer(uc, baked), { x: 5, y: 6, width: 7, height: 8 });
    const plain = { id: "moving", type: "pose", canvas: {} };
    assert.deepEqual(faceRegionForLayer(uc, plain), { x: 100, y: 10, width: 300, height: 90 });
});

test("skin rects map into the frame and overlap checks work", () => {
    const units = { width: 1920, height: 1080 };
    const frame = { x: 100, y: 200, width: 960, height: 540 };
    assert.deepEqual(mapSkinRect({ x: 60, y: 776, width: 1800, height: 260 }, units, frame), { x: 130, y: 588, width: 900, height: 130 });
    assert.equal(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 5, height: 5 }), true);
    assert.equal(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 }), false);
});

test("the overlay pass lives only in render(): never in flatten, export or payload code", () => {
    assert.match(method(widget, "render() {"), /this\.vnPreview\?\.drawOverlay\(ctx, w, h\)/);
    for (const signature of ["drawFlattenedLayers(", "makeExportCanvas(", "_buildDrawPayload(", "flattenLayersToMaster(", "buildSerializedState("]) {
        assert.doesNotMatch(method(widget, signature), /vnPreview|vn_preview/, signature);
    }
    assert.equal((widget.match(/drawOverlay\(/g) || []).length, 1);
    assert.match(method(widget, "applyHistoryEntry("), /vnPreviewFrame/);
    assert.match(modes, /lower === "p" && widget\.vnPreview/);
    assert.match(modes, /getVnPreview:/);
});
