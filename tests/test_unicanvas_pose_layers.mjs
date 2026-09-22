import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    buildPoseLayerData,
    MANNEQUIN_TOOL_ICON,
    normalizePoseLayerData,
    POSE_LAYER_ADD_ICON,
    POSE_LAYER_BUS_EVENT,
    POSE_LAYER_STATUS,
    POSE_LAYER_TYPE,
} from "../web/vnccs_unicanvas_pose_layers.mjs";


const widgetSource = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const poseLayerSource = await readFile(new URL("../web/vnccs_unicanvas_pose_layers.mjs", import.meta.url), "utf8");


test("pose layer type is \"pose\" and poseData keeps the spec section 7.1 keys", () => {
    assert.equal(POSE_LAYER_TYPE, "pose");

    const poseData = buildPoseLayerData({
        pose: { bones: { spine: [1, 2, 3] } },
        character: { id: "vnccs-1", name: "Saved character", source: "vnccs", morphs: { age: 30, gender: 0.2 } },
        camera: { zoom: 1.25, offset_x: -4 },
        size: { width: 768, height: 512 },
    });

    assert.deepEqual(Object.keys(poseData).sort(), ["camera", "character", "pose", "render", "schemaVersion"]);
    assert.deepEqual(Object.keys(poseData.character).sort(), ["id", "morphs", "name", "source"]);
    assert.equal(poseData.character.source, "vnccs");
    assert.equal(poseData.render.transparent, true);
    assert.deepEqual(Object.keys(poseData.render).sort(), ["size", "transparent"]);
    assert.deepEqual(poseData.render.size, { width: 768, height: 512 });
    assert.equal(poseData.camera.zoom, 1.25);
    assert.equal(poseData.pose.bones.spine[1], 2);

    const roundTripped = normalizePoseLayerData(JSON.parse(JSON.stringify(poseData)));
    assert.deepEqual(Object.keys(roundTripped).sort(), ["camera", "character", "pose", "render", "schemaVersion"]);
    assert.equal(roundTripped.render.transparent, true);
});


test("pose layer bus uses the vnccs:unicanvas:pose-layer CustomEvent name", () => {
    assert.equal(POSE_LAYER_BUS_EVENT, "vnccs:unicanvas:pose-layer");
    assert.match(poseLayerSource, /window\.addEventListener\(POSE_LAYER_BUS_EVENT/);
    assert.match(poseLayerSource, /window\.dispatchEvent\(new CustomEvent\(POSE_LAYER_BUS_EVENT/);
});


test("UniCanvasWidget exposes rasterizePoseLayer(layer) and editPoseLayer(layer)", () => {
    assert.match(widgetSource, /rasterizePoseLayer\(layer\)/);
    assert.match(widgetSource, /editPoseLayer\(layer\)/);
});


test("pose layer status chip keeps the exact spec strings", () => {
    assert.equal(POSE_LAYER_STATUS.LINKED, "linked to Pose Studio");
    assert.equal(POSE_LAYER_STATUS.WAITING, "waiting\u2026");
    assert.equal(POSE_LAYER_STATUS.DISCONNECTED, "disconnected");
    for (const value of Object.values(POSE_LAYER_STATUS)) {
        assert.ok(poseLayerSource.includes(JSON.stringify(value).slice(1, -1)), `missing status chip string: ${value}`);
    }
});


test("pose previews are requestAnimationFrame-coalesced and newest-wins", () => {
    const schedulerStart = poseLayerSource.indexOf("function scheduleUniCanvasPoseLayerPreview");
    assert.ok(schedulerStart >= 0, "preview scheduler not found");
    const scheduler = poseLayerSource.slice(schedulerStart, schedulerStart + 1400);

    assert.match(scheduler, /sub\.pendingRender = detail;/);
    assert.ok(scheduler.includes("requestAnimationFrame"), "preview updates must be coalesced through requestAnimationFrame");
    assert.match(scheduler, /1000 \/ POSE_LAYER_PREVIEW_FPS/);
    assert.match(poseLayerSource, /POSE_LAYER_PREVIEW_FPS = 18/);

    // Newest-wins stale dropping before and after the async image decode.
    assert.match(poseLayerSource, /if \(Number\.isFinite\(seq\)\) \{\r?\n    if \(sub\.latestSeq !== null && seq < sub\.latestSeq\) return;/);
    assert.match(poseLayerSource, /if \(Number\.isFinite\(seq\) && sub\.latestSeq !== null && seq < sub\.latestSeq\) return false;/);
});


test("each bridge gesture commits one layerPixels history command", () => {
    const commitStart = poseLayerSource.indexOf("function commitUniCanvasPoseLayerGesture");
    assert.ok(commitStart >= 0, "gesture commit helper not found");
    const commit = poseLayerSource.slice(commitStart, commitStart + 800);
    assert.match(commit, /kind: "layerPixels"/);
    assert.match(commit, /before: gesture\.before/);
    assert.match(poseLayerSource, /One layerPixels history command per gesture/);
});


test("brush and eraser are blocked on pose layers", () => {
    const strokeStart = widgetSource.indexOf("drawStroke(a, b) {");
    assert.ok(strokeStart >= 0, "drawStroke not found");
    const strokeGuard = widgetSource.slice(strokeStart, strokeStart + 700);
    assert.match(strokeGuard, /layer\.type === POSE_LAYER_TYPE/);
    assert.match(strokeGuard, /Brush and eraser are blocked on pose layers/);

    const pointerStart = widgetSource.indexOf('if (["brush", "eraser", "mask"].includes(this.pointerMode))');
    assert.ok(pointerStart >= 0, "brush pointer guard not found");
    const pointerGuard = widgetSource.slice(pointerStart, pointerStart + 700);
    assert.match(pointerGuard, /poseBrushTarget\?\.type === POSE_LAYER_TYPE/);
    assert.match(pointerGuard, /Brush and eraser are blocked on pose layers/);
});


test("Add pose layer and the mannequin tool hook into the widget chrome", () => {
    assert.match(widgetSource, /"Add pose layer", \(\) => this\.addPoseLayer\(\)/);
    assert.match(widgetSource, /\["mannequin", "Pose mannequin"\]/);
    assert.match(widgetSource, /mannequin: MANNEQUIN_TOOL_ICON/);
    assert.ok(POSE_LAYER_ADD_ICON.includes("<svg"));
    assert.ok(MANNEQUIN_TOOL_ICON.includes("<svg"));
});


test("mannequin editing keeps the Save pose / Cancel contract and rasterize is one history command", () => {
    assert.match(poseLayerSource, /"Save pose"/);
    assert.match(poseLayerSource, /"Cancel"/);
    assert.match(poseLayerSource, /"\[VNCCS UniCanvas\] Pose saved"/);
    assert.match(poseLayerSource, /"\[VNCCS UniCanvas\] Pose edit canceled"/);

    const rasterizeStart = poseLayerSource.indexOf("export function rasterizeUniCanvasPoseLayer");
    assert.ok(rasterizeStart >= 0, "rasterizeUniCanvasPoseLayer not found");
    const rasterize = poseLayerSource.slice(rasterizeStart, rasterizeStart + 1400);
    assert.match(rasterize, /widget\.recordHistoryBefore\(\)/);
    assert.match(rasterize, /layer\.type = "raster";/);
});


test("character dropdown degrades to Mannequin when /vnccs/list_characters is unavailable", () => {
    assert.match(poseLayerSource, /fetch\("\/vnccs\/list_characters"\)/);
    assert.match(poseLayerSource, /"Mannequin"/);
    assert.match(poseLayerSource, /POSE_LAYER_CHARACTERS_UNAVAILABLE_NOTE = "VNCCS characters unavailable/);
    assert.match(poseLayerSource, /applyExternalCharacterCreatorValues/);
});
