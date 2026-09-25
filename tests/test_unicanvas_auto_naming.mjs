import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createGroupLayer } from "../web/vnccs_unicanvas_groups.mjs";
import {
    CANONICAL_FOLDER_ORDER,
    applyFilingPlan,
    autoFileLayer,
    filingTarget,
    planFiling,
} from "../web/vnccs_unicanvas_filing.mjs";
import {
    MAX_NAMING_BATCH,
    NAMING_DEBOUNCE_MS,
    autoNameLayers,
    onLayerCreated,
    onLayerRenamedByUser,
    resolveAutoNamingLevel,
} from "../web/vnccs_unicanvas_naming.mjs";
import {
    groupCharacterName,
    layerCategory,
    layerCharacterName,
    nameSourceForOrigin,
    promptFallbackName,
    rulesCategory,
    rulesLayerName,
    modelLayerName,
} from "../web/vnccs_unicanvas_naming_rules.mjs";
import { createLayerMeta, normalizeLayerMeta } from "../web/vnccs_unicanvas_provenance.mjs";

const widget = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const layerTools = await readFile(new URL("../web/vnccs_unicanvas_layer_tools.mjs", import.meta.url), "utf8");

const raster = (id, origin = "paint", extra = {}) => ({
    id, name: extra.name || id, type: "raster", visible: true, locked: false, opacity: 1, blendMode: "source-over",
    groupId: null, meta: createLayerMeta(origin, extra.meta || {}), ...extra, ...(extra.meta ? { meta: createLayerMeta(origin, extra.meta) } : {}),
});
const pose = (id, character = null, studio = {}) => ({ id, name: "Pose Studio", type: "pose", visible: true, groupId: null, meta: createLayerMeta("paint"), pose: { character, studio } });
const ids = (layers) => layers.map((layer) => layer.id);

test("prompt fallback keeps the first four meaningful words", () => {
    assert.equal(promptFallbackName("masterpiece, best quality, a (red chair:1.2) in a night street <lora:x:0.8>"), "Red Chair Night Street");
    assert.equal(promptFallbackName("score_9, 8k, masterpiece"), null);
    assert.equal(promptFallbackName(""), null);
});

test("pose layers take their bound character, custom Studio names win over file stems", () => {
    const layers = [];
    assert.equal(rulesLayerName(pose("p"), layers).name, "Pose");
    assert.equal(layerCharacterName(pose("p", { source: "upload", name: "eileen_ref.png", dataURL: "x" })), "eileen_ref");
    assert.equal(layerCharacterName(pose("p", { source: "upload", name: "Eileen", vnccsCharacter: "Eileen" })), "Eileen");
    const ref = raster("ref", "import", { name: "Mira" });
    assert.equal(layerCharacterName(pose("p", { source: "layer", layerId: "ref" }), [ref]), "Mira");
    const defaults = { characters: [{ name: "Main Character" }, { name: "Character 2" }] };
    assert.equal(layerCharacterName(pose("p", { source: "upload", name: "Eileen" }, defaults)), "Eileen");
    const custom = { characters: [{ name: "Eileen" }, { name: "Tom" }] };
    assert.equal(layerCharacterName(pose("p", { source: "upload", name: "file" }, custom)), "Eileen & Tom");
});

test("rules name each layer kind from provenance", () => {
    const source = raster("src", "paint", { name: "Rain overlay" });
    const layers = [source, raster("Paint 2", "paint", { name: "Paint 2" })];
    assert.deepEqual(rulesLayerName(raster("imp", "import", { meta: { sourceName: "night_street" } }), layers), { name: "night_street", model: false });
    assert.deepEqual(rulesLayerName(raster("psd", "psd", { meta: { sourceName: "Sky" } }), layers), { name: "Sky", model: false });
    assert.equal(rulesLayerName(raster("dup", "duplicate", { meta: { derivedFrom: "src" } }), layers).name, "Rain overlay copy");
    assert.deepEqual(rulesLayerName(raster("gen", "generate", { meta: { prompt: "1girl, blonde woman, smiling" } }), layers), { name: "Blonde Woman Smiling", model: true });
    assert.deepEqual(rulesLayerName(raster("new", "paint", { name: "Layer 3" }), layers), { name: "Paint 3", model: true });
    assert.equal(rulesLayerName(raster("gen", "generate", { meta: { character: { name: "Eileen" } } }), layers).name, "Eileen");
    const baked = raster("b", "bake", { meta: { character: { name: "Eileen" } } });
    assert.equal(rulesLayerName(baked, [baked]).name, "Eileen");
    const shown = pose("p", { source: "upload", name: "Eileen" });
    assert.equal(rulesLayerName(baked, [baked, shown]).name, "Eileen (baked)");
    assert.equal(nameSourceForOrigin("import"), "import");
    assert.equal(nameSourceForOrigin("psd"), "import");
    assert.equal(nameSourceForOrigin("generate"), "auto");
});

test("categories: character link first, then the model answer, then name keywords", () => {
    assert.equal(layerCategory(pose("p")), "Characters");
    assert.equal(layerCategory(raster("a", "generate", { meta: { category: "Props" } })), "Props");
    assert.equal(layerCategory(raster("a", "generate", { meta: { character: { name: "E" } }, name: "x" })), "Characters");
    assert.equal(rulesCategory(raster("a", "import", { name: "Rain overlay" })), "Effects");
    assert.equal(rulesCategory(raster("a", "import", { name: "night_street" })), null, "underscores are word characters");
    assert.equal(rulesCategory(raster("a", "import", { name: "Night street" })), "Background");
    assert.equal(rulesCategory(raster("base", "base", { name: "Base Layer" })), "Background");
    assert.equal(rulesCategory(raster("a", "paint", { name: "Paint 1" })), null);
    assert.equal(normalizeLayerMeta({ origin: "generate", category: "effects" }).category, "Effects");
    assert.equal(normalizeLayerMeta({ origin: "generate", category: "Scenery" }).category, undefined);
});

test("filing plan lists only unfiled root layers and falls back to Other", () => {
    const folder = createGroupLayer({ id: "user", name: "My stuff" });
    const layers = [
        { ...raster("m"), type: "mask" },
        raster("rain", "import", { name: "Rain" }),
        folder,
        raster("inside", "import", { name: "Street", groupId: "user" }),
        raster("paint", "paint", { name: "Paint 1" }),
        pose("p", { source: "upload", name: "Eileen" }),
        raster("pano", "base", { name: "Base" }),
    ];
    const plan = planFiling(layers, { pinnedId: "pano" });
    assert.deepEqual(plan.map((step) => [step.layerId, step.path]), [
        ["rain", "Effects"], ["paint", "Other"], ["p", "Characters / Eileen"],
    ]);
    assert.equal(filingTarget(raster("x", "paint", { name: "Paint 1" }), layers), null, "auto-filing needs a category");
});

test("applying a plan creates folders on demand in canonical order and never touches user folders", () => {
    let n = 0;
    const makeGroup = (fields) => createGroupLayer({ ...fields, id: `f${++n}` });
    const user = createGroupLayer({ id: "user", name: "Props" }); // reused by name, not renamed
    const layers = [
        raster("bg", "import", { name: "Night street" }),
        raster("rain", "import", { name: "Rain" }),
        user,
        raster("chair", "import", { name: "Chair", groupId: "user" }),
        pose("p", { source: "upload", name: "Eileen" }),
        raster("lamp", "import", { name: "Lamp" }),
    ];
    const plan = planFiling(layers);
    const { layers: out, created } = applyFilingPlan(layers, plan, { makeGroup });
    const byId = new Map(out.map((layer) => [layer.id, layer]));
    const rootFolders = out.filter((layer) => layer.type === "group" && !layer.groupId).map((layer) => layer.name);
    assert.deepEqual(rootFolders, ["Effects", "Characters", "Props", "Background"]);
    assert.equal(user.name, "Props");
    assert.equal(byId.get("lamp").groupId, "user");
    assert.equal(byId.get("chair").groupId, "user");
    const characters = out.find((layer) => layer.name === "Characters");
    const eileen = out.find((layer) => layer.name === "Eileen");
    assert.equal(eileen.groupId, characters.id);
    assert.equal(byId.get("p").groupId, eileen.id);
    assert.deepEqual(created.map((group) => group.name).sort(), ["Background", "Characters", "Effects", "Eileen"]);
    assert.equal(CANONICAL_FOLDER_ORDER[0], "Overlays");
});

test("new category folders respect a user's reordering of existing ones", () => {
    const makeGroup = (fields) => createGroupLayer({ ...fields, id: `new-${fields.name}` });
    // The user moved Background above Effects; Lighting goes before the first folder ranking below it.
    const layers = [
        createGroupLayer({ id: "bg", name: "Background" }),
        createGroupLayer({ id: "fx", name: "Effects" }),
        raster("glow", "import", { name: "Glow" }),
    ];
    const { layers: out } = applyFilingPlan(layers, planFiling(layers), { makeGroup });
    assert.deepEqual(ids(out), ["new-Lighting", "glow", "bg", "fx"]);
    assert.equal(out[1].groupId, "new-Lighting");
});

function fakeWidget(settings = {}) {
    const uc = {
        settings,
        layers: [],
        undoStack: [],
        activeLayerId: null,
        statuses: [],
        setStatus(text) { this.statuses.push(text); },
        normalizeLayerOrder() {},
        renderLayerList() {},
        requestRender() {},
        syncLightStateToWidget() {},
        refreshLayerRow() {},
        getLayerAlphaBounds: (layer) => (layer.empty ? null : { x: 0, y: 0, width: 1, height: 1 }),
        cloneCanvasCrop: () => ({ toDataURL: () => "data:image/png;base64,AAAA" }),
    };
    return uc;
}

function addToWidget(uc, layer) {
    uc.layers.unshift(layer);
    uc.undoStack.push({ kind: "addLayer", layer });
    onLayerCreated(uc, layer);
    return layer;
}

test("auto-filing joins the creation entry so one undo removes the layer and its new folder", () => {
    const uc = fakeWidget({ auto_naming: "rules" });
    const layer = addToWidget(uc, raster("rain", "import", { name: "Rain", meta: { sourceName: "Rain" } }));
    assert.equal(uc.undoStack.length, 1);
    const entry = uc.undoStack[0];
    assert.equal(entry.kind, "historyGroup");
    assert.deepEqual(entry.entries.map((item) => item.kind), ["addLayer", "groupStructure"]);
    const folder = uc.layers.find((item) => item.type === "group");
    assert.equal(folder.name, "Effects");
    assert.equal(layer.groupId, folder.id);
    assert.equal(entry.entries[1].before.order.some((item) => item.id === folder.id), false, "undo drops the folder");
    assert.equal(layer.nameSource, "import");
});

test("auto-filing is skipped when the setting is off or another action came in between", () => {
    const off = fakeWidget({ auto_naming: "rules", auto_file_layers: false });
    addToWidget(off, raster("rain", "import", { name: "Rain" }));
    assert.equal(off.layers.some((item) => item.type === "group"), false);
    const later = fakeWidget({ auto_naming: "rules" });
    const layer = raster("rain", "import", { name: "Rain" });
    later.layers.push(layer);
    later.undoStack.push({ kind: "addLayer", layer }, { kind: "layerPixels", layerId: "rain" });
    assert.equal(autoFileLayer(later, layer), false);
});

test("naming levels: legacy checkbox reads as model, default is rules", () => {
    assert.equal(resolveAutoNamingLevel({}), "rules");
    assert.equal(resolveAutoNamingLevel({ auto_name_layers: true }), "model");
    assert.equal(resolveAutoNamingLevel({ auto_name_layers: true, auto_naming: "off" }), "off");
});

function stubFetch(handler) {
    const calls = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push(body);
        const data = await handler(body);
        return { ok: true, status: 200, json: async () => data };
    };
    return { calls, restore: () => { globalThis.fetch = previous; } };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("model level: rules name first, then the model name and category, filed in the creation entry", async () => {
    const stub = stubFetch((body) => ({ names: body.layers.map((item) => ({ id: item.id, name: "Night Street", category: "Background", parsed: true })), groups: [] }));
    try {
        const uc = fakeWidget({ auto_naming: "model" });
        const layer = addToWidget(uc, raster("gen", "generate", { name: "Layer 1", meta: { prompt: "night street, rain" } }));
        assert.equal(layer.name, "Night Street Rain", "fallback name right away");
        assert.equal(uc.layers.some((item) => item.type === "group"), false, "filing waits for the category");
        await sleep(NAMING_DEBOUNCE_MS + 50);
        assert.equal(stub.calls.length, 1);
        assert.equal(stub.calls[0].layers[0].prompt, "night street, rain");
        assert.equal(stub.calls[0].layers[0].fallback, "Night Street Rain");
        assert.equal(layer.name, "Night Street");
        assert.equal(layer.meta.category, "Background");
        assert.equal(uc.layers.find((item) => item.type === "group")?.name, "Background");
        assert.equal(uc.undoStack.length, 1, "naming never adds history entries");
    } finally {
        stub.restore();
    }
});

test("stale replies are dropped: user rename, deleted layer, regenerated pixels", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const stub = stubFetch(async (body) => {
        await gate;
        return { names: body.layers.map((item) => ({ id: item.id, name: "Model Name", category: "Props", parsed: true })) };
    });
    try {
        const uc = fakeWidget({ auto_naming: "model" });
        const renamed = addToWidget(uc, raster("a", "paint", { name: "Layer 1" }));
        const deleted = addToWidget(uc, raster("b", "paint", { name: "Layer 2" }));
        const regenerated = addToWidget(uc, raster("c", "paint", { name: "Layer 3" }));
        await sleep(NAMING_DEBOUNCE_MS + 50);
        assert.equal(stub.calls.length, 1, "one batched request");
        assert.equal(stub.calls[0].layers.length, 3);
        renamed.name = "Hero";
        onLayerRenamedByUser(uc, renamed);
        uc.layers = uc.layers.filter((layer) => layer !== deleted);
        regenerated.pixelRevision = (regenerated.pixelRevision || 0) + 1;
        const before = regenerated.name;
        release();
        await sleep(20);
        assert.equal(renamed.name, "Hero");
        assert.equal(renamed.nameSource, "user");
        assert.equal(regenerated.name, before);
    } finally {
        stub.restore();
    }
});

test("a malformed answer keeps the rules name and never files by it", async () => {
    const stub = stubFetch((body) => ({ names: body.layers.map((item) => ({ id: item.id, name: item.fallback, category: "Other", parsed: false })) }));
    try {
        const uc = fakeWidget({ auto_naming: "model" });
        const layer = addToWidget(uc, raster("a", "paint", { name: "Layer 1" }));
        await sleep(NAMING_DEBOUNCE_MS + 50);
        assert.equal(layer.name, "Paint 1");
        assert.equal(layer.meta.category, undefined);
        assert.equal(uc.layers.some((item) => item.type === "group"), false);
    } finally {
        stub.restore();
    }
});

test("requests are batched at most 16 layers per call", async () => {
    const stub = stubFetch((body) => ({ names: body.layers.map((item) => ({ id: item.id, name: "X", category: "Props", parsed: true })) }));
    try {
        const uc = fakeWidget({ auto_naming: "model", auto_file_layers: false });
        for (let index = 0; index < MAX_NAMING_BATCH + 2; index += 1) addToWidget(uc, raster(`l${index}`, "paint", { name: `Layer ${index}` }));
        await sleep(2 * NAMING_DEBOUNCE_MS + 100);
        assert.deepEqual(stub.calls.map((call) => call.layers.length), [MAX_NAMING_BATCH, 2]);
    } finally {
        stub.restore();
    }
});

test("rules-only level never calls the model; Auto-name does, and resets a user name", async () => {
    const stub = stubFetch((body) => ({ names: body.layers.map((item) => ({ id: item.id, name: "Wooden Chair", category: "Props", parsed: true })) }));
    try {
        const uc = fakeWidget({ auto_naming: "rules" });
        const layer = addToWidget(uc, raster("a", "paint", { name: "Layer 1" }));
        await sleep(NAMING_DEBOUNCE_MS + 50);
        assert.equal(stub.calls.length, 0);
        layer.name = "Mine";
        onLayerRenamedByUser(uc, layer);
        await autoNameLayers(uc, [layer]);
        assert.equal(stub.calls.length, 1);
        assert.equal(layer.nameSource, "auto");
        assert.equal(layer.name, "Wooden Chair");
    } finally {
        stub.restore();
    }
});

test("groups take the character all their layers share", () => {
    const group = createGroupLayer({ id: "g", name: "Group 1", nameSource: "auto" });
    const layers = [group, { ...pose("p1", { source: "upload", name: "Eileen" }), groupId: "g" }, { ...raster("b", "bake", { meta: { character: { name: "Eileen" } } }), groupId: "g" }];
    assert.equal(groupCharacterName(group, layers), "Eileen");
    layers.push({ ...raster("x", "paint"), groupId: "g" });
    assert.equal(groupCharacterName(group, layers), null);
});

test("the widget wires the hooks and the settings", () => {
    assert.match(widget, /installUniCanvasAutoNaming\(this\);\n\s*installUniCanvasFiling\(this\);/);
    assert.match(widget, /this\.autoNaming\.onLayerCreated\(layer\);\n\s*}\n\n\s*loadImage/);
    assert.match(widget, /Staging accepted; remaining results discarded"\);\n\s*this\.autoNaming\.onLayerCreated\(layer\);/);
    assert.match(widget, /this\.autoNaming\.onLayerRenamedByUser\(layer\)/);
    assert.match(widget, /bind\("Auto naming", namingLevel\)/);
    assert.match(widget, /Auto-file new layers into folders/);
    assert.match(layerTools, /uc\.autoNaming\?\.onLayerCreated\(layer\)/);
});

test("a stroke never reverts a model name; painted layers with their rules name ask the model", async () => {
    const { onLayerPixelsCommitted } = await import("../web/vnccs_unicanvas_naming.mjs");
    const stub = stubFetch((body) => ({ names: body.layers.map((item) => ({ id: item.id, name: "Red Brush Strokes", category: "Effects", parsed: true })) }));
    try {
        const uc = fakeWidget({ auto_naming: "model", auto_file_layers: false });
        const named = raster("g", "generate", { name: "Night Street", meta: { prompt: "a night street at dusk, rain" } });
        named.nameSource = "auto";
        uc.layers.push(named);
        onLayerPixelsCommitted(uc, named);
        const painted = raster("p", "paint", { name: "Paint 1" });
        painted.nameSource = "auto";
        uc.layers.push(painted);
        onLayerPixelsCommitted(uc, painted);
        await sleep(NAMING_DEBOUNCE_MS + 50);
        assert.equal(named.name, "Night Street");
        assert.deepEqual(stub.calls.map((call) => call.layers.map((item) => item.id)), [["p"]]);
        assert.equal(painted.name, "Red Brush Strokes");
        const posed = pose("pose", { source: "upload", name: "Eileen" });
        posed.nameSource = "auto";
        posed.name = "Pose";
        uc.layers.push(posed);
        onLayerPixelsCommitted(uc, posed);
        assert.equal(posed.name, "Eileen");
    } finally {
        stub.restore();
    }
});

test("occluders are named \"Occluder - <object>\" and the model only names the object", () => {
    const occluder = raster("occ", "occluder", { name: "Layer 7" });
    assert.deepEqual(rulesLayerName(occluder, [occluder]), { name: "Occluder - foreground", model: true });
    occluder.name = "Occluder - table";
    assert.equal(rulesLayerName(occluder, [occluder]).name, "Occluder - table");
    assert.equal(modelLayerName(occluder, " wooden table "), "Occluder - wooden table");
    assert.equal(modelLayerName(occluder, "Occluder - fence"), "Occluder - fence");
    assert.equal(modelLayerName(raster("p"), "Cat"), "Cat");
});
