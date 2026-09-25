import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    LAYER_ORIGINS,
    buildStagingSnapshot,
    bumpLayerPixelRevision,
    cloneLayerMeta,
    createLayerMeta,
    formatProvenanceTooltip,
    metaFromStagingSnapshot,
    normalizeLayerMeta,
    setLayerOrigin,
} from "../web/vnccs_unicanvas_provenance.mjs";

const widget = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const layerTools = await readFile(new URL("../web/vnccs_unicanvas_layer_tools.mjs", import.meta.url), "utf8");
const modes = await readFile(new URL("../web/vnccs_unicanvas_modes.mjs", import.meta.url), "utf8");

function method(source, signature) {
    const start = source.indexOf(`\n  ${signature}`);
    assert.ok(start >= 0, `method not found: ${signature}`);
    const next = source.slice(start + 1).search(/\n  (?:async )?[A-Za-z_$][\w$]*\([^)]*\) \{\n/);
    return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

test("origins cover the reserved list and unknown values fall back", () => {
    for (const origin of ["base", "paint", "generate", "bake", "sprite", "import", "psd", "paste", "duplicate",
        "rasterize", "split", "occluder", "shadow", "asset", "unknown"]) {
        assert.ok(LAYER_ORIGINS.includes(origin), origin);
    }
    assert.deepEqual(normalizeLayerMeta(undefined), { origin: "unknown" });
    assert.deepEqual(normalizeLayerMeta({ origin: "nope" }), { origin: "unknown" });
    assert.equal(createLayerMeta("teleport").origin, "unknown");
});

test("a fixture state saved before provenance loads as origin unknown", () => {
    const legacy = { id: "l1", name: "Layer 1", type: "raster", visible: true, locked: false, opacity: 1 };
    assert.deepEqual(normalizeLayerMeta(legacy.meta), { origin: "unknown" });
});

test("meta keeps known fields, drops junk and survives a JSON round trip", () => {
    const meta = createLayerMeta("import", { sourceName: "hero", derivedFrom: "abc", junk: () => 1, seed: "12",
        character: { id: "c1", name: "Ann", extra: true } });
    assert.equal(meta.origin, "import");
    assert.equal(meta.sourceName, "hero");
    assert.equal(meta.seed, 12);
    assert.deepEqual(meta.character, { id: "c1", name: "Ann" });
    assert.ok(Number.isFinite(meta.createdAt));
    assert.equal("junk" in meta, false);
    assert.deepEqual(normalizeLayerMeta(JSON.parse(JSON.stringify(meta))), meta);
    const copy = cloneLayerMeta(meta);
    assert.notEqual(copy, meta);
    assert.deepEqual(copy, meta);
});

test("pixel revisions are monotonic and never reused across layers", () => {
    const a = {}; const b = {};
    const first = bumpLayerPixelRevision(a);
    const second = bumpLayerPixelRevision(b);
    const third = bumpLayerPixelRevision(a);
    assert.ok(second > first && third > second);
    assert.equal(a.pixelRevision, third);
    assert.equal(bumpLayerPixelRevision(null), 0);
});

test("a generation run stores one settings snapshot that accept copies into meta", () => {
    const settings = {
        positive: "a knight in armor", negative: "blurry", generation_mode: "illustrious", model_loader: "checkpoint",
        ckpt_name: "wai.safetensors", seed: 42, steps: 28, cfg: 6, sampler_name: "euler", scheduler: "normal",
        denoise: 0.6, lora_stack: [{ name: "style.safetensors", strength: 0.8 }, { name: "" }],
    };
    const snapshot = buildStagingSnapshot(settings, { mode: "inpaint", bbox: { x: 1, y: 2, width: 3, height: 4 } });
    assert.match(snapshot.historyId, /^gen_/);
    assert.equal(snapshot.prompt, "a knight in armor");
    assert.equal(snapshot.model, "illustrious / wai.safetensors");
    assert.deepEqual(snapshot.loras, [{ name: "style.safetensors", strength: 0.8 }]);
    assert.deepEqual(snapshot.bbox, { x: 1, y: 2, width: 3, height: 4 });
    for (const key of ["negative", "mode", "seed", "steps", "cfg", "sampler", "scheduler", "denoise"]) assert.ok(key in snapshot, key);
    const meta = metaFromStagingSnapshot(snapshot);
    assert.equal(meta.origin, "generate");
    assert.equal(meta.historyId, snapshot.historyId);
    assert.equal(meta.prompt, "a knight in armor");
    assert.equal(meta.negative, "blurry");
    assert.equal(meta.mode, "inpaint");
    assert.equal(meta.seed, 42);
    assert.equal(metaFromStagingSnapshot(null).origin, "generate");
    assert.notEqual(buildStagingSnapshot(settings).historyId, snapshot.historyId, "every run gets a fresh historyId");
});

test("the tooltip names the origin and, for generated layers, prompt, model and seed", () => {
    const text = formatProvenanceTooltip(metaFromStagingSnapshot(buildStagingSnapshot({
        positive: "x".repeat(300), ckpt_name: "m.safetensors", generation_mode: "sdxl", seed: 7,
    })));
    assert.match(text, /^Origin: Generated/);
    assert.match(text, /Prompt: x+…/);
    assert.ok(text.split("\n").find((line) => line.startsWith("Prompt:")).length < 140, "the prompt is truncated");
    assert.match(text, /Model: sdxl \/ m\.safetensors/);
    assert.match(text, /Seed: 7/);
    const dup = formatProvenanceTooltip(createLayerMeta("duplicate", { derivedFrom: "a" }), [{ id: "a", name: "Hero" }]);
    assert.match(dup, /Origin: Duplicate\nFrom: Hero/);
    assert.equal(formatProvenanceTooltip(undefined), "Origin: Unknown origin");
    const layer = setLayerOrigin({}, "paste");
    assert.equal(layer.meta.origin, "paste");
});

test("every layer creation path in the widget sets its origin", () => {
    assert.match(method(widget, "_createInitialLayers()"), /setLayerOrigin\(this\.addLayer\("raster", "Base Layer"\), "base"\)/);
    assert.match(method(widget, "_createInitialLayers()"), /setLayerOrigin\(this\.addLayer\("mask", "Inpaint Mask"\), "base"\)/);
    assert.match(method(widget, "addLayer(type"), /meta: meta \? normalizeLayerMeta\(meta\) : createLayerMeta\("paint"\)/,
        "UI-added layers default to paint");
    assert.match(method(widget, "async acceptStaging()"), /metaFromStagingSnapshot\(staging\.snapshot\)/);
    assert.match(method(widget, "async importFile(file)"), /createLayerMeta\("import", \{ sourceName/);
    assert.match(method(widget, "duplicateActiveLayer()"), /createLayerMeta\("duplicate", \{ derivedFrom: layer\.id/);
    assert.match(method(widget, "rasterizePoseLayer(layer)"), /createLayerMeta\("rasterize", \{ derivedFrom: layer\.id/);
    assert.match(method(widget, "flattenLayersToMaster()"), /meta: createLayerMeta\("rasterize"\)/);
    assert.match(method(widget, "async importPanorama("), /createLayerMeta\("import", \{ sourceName/);
    assert.match(layerTools, /createLayerMeta\("psd", \{ sourceName: entry\.name/);
    assert.match(modes, /widget\.addLayer\("raster", "Base Layer", false, false, createLayerMeta\("base"\)\)/);
    // Every other literal layer object carries meta too.
    for (const match of widget.matchAll(/\{\s*id: uid\(\),[\s\S]*?canvas: this\._createCanvas\(/g)) {
        assert.match(match[0], /meta: /, `layer literal without meta: ${match[0].slice(0, 80)}`);
    }
    assert.match(method(widget, "async deletePanoramaLayer(id)"), /meta: createLayerMeta\("base"\)/);
});

test("staging items carry the run snapshot", () => {
    const stage = method(widget, "async _stageGeneratedImages(");
    assert.match(stage, /buildStagingSnapshot\(this\.settings, \{ mode, bbox/);
    assert.match(stage, /snapshot: \{ \.\.\.snapshot/);
});

test("meta is serialized, restored with a normalizer and kept in history clones", () => {
    const serialize = method(widget, "serializeLayer(layer");
    assert.equal((serialize.match(/meta: normalizeLayerMeta\(layer\.meta\)/g) || []).length, 3, "the group, panorama and flat branch");
    assert.match(method(widget, "async applySerializedState(state, { exact = false } = {})"), /meta: normalizeLayerMeta\(item\.meta\)/);
    assert.match(method(widget, "cloneHistoryLayer(layer)"), /meta: cloneLayerMeta\(layer\.meta\)/);
});

test("pixel-changing paths bump the revision and non-pixel paths do not", () => {
    for (const name of ["invalidateLayerCaches(layer)", "invalidateLayerRenderCaches(layer)", "markLayerPixelsChanged(layer"]) {
        assert.match(method(widget, name), /bumpLayerPixelRevision\(layer\)/, name);
    }
    assert.doesNotMatch(method(widget, "invalidateLayerThumbnail(layer)"), /bumpLayerPixelRevision/,
        "opacity only refreshes the thumbnail");
    assert.match(method(widget, "async applySerializedState(state, { exact = false } = {})"), /bumpLayerPixelRevision\(layer\)/, "state load");
    assert.doesNotMatch(method(widget, "serializeLayer(layer"), /pixelRevision/, "the revision is not serialized");
    const row = method(widget, "createLayerRow(layer)");
    for (const handler of row.split("addEventListener").filter((part) => /layer\.(visible|locked|name) = /.test(part))) {
        assert.doesNotMatch(handler, /invalidateLayerCaches|markLayerPixelsChanged|invalidateLayerRenderCaches/);
    }
});
