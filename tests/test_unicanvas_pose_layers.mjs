import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    buildPoseLayerData,
    computeTorsoAnchor,
    MANNEQUIN_TOOL_ICON,
    normalizePoseLayerData,
    normalizePoseLayerMorphs,
    POSE_LAYER_ADD_ICON,
    POSE_LAYER_BUS_EVENT,
    POSE_LAYER_STATUS,
    POSE_LAYER_TYPE,
    saveUniCanvasPoseEdit,
} from "../web/vnccs_unicanvas_pose_layers.mjs";


const widgetSource = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const poseLayerSource = await readFile(new URL("../web/vnccs_unicanvas_pose_layers.mjs", import.meta.url), "utf8");
const poseStudioSource = await readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");


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


test("the pose status chip reports when /vnccs/list_characters is unavailable", () => {
    assert.match(poseLayerSource, /fetch\("\/vnccs\/list_characters"\)/);
    assert.match(poseLayerSource, /"Mannequin"/);
    assert.match(poseLayerSource, /POSE_LAYER_CHARACTERS_UNAVAILABLE_NOTE = "VNCCS characters unavailable/);
    assert.match(poseLayerSource, /applyExternalCharacterCreatorValues/);
});


test("Pose Studio answers pose layer subscriptions on the vnccs:unicanvas:pose-layer bus", () => {
    assert.match(poseStudioSource, /"vnccs:unicanvas:pose-layer"/);
    assert.match(poseStudioSource, /source: "pose-studio"/);
    assert.match(poseStudioSource, /type: "hello"/);
    assert.match(poseStudioSource, /type: "render"/);
    assert.match(poseStudioSource, /gestureId/);
    assert.match(poseStudioSource, /seq: sub\.seq \+ 1/);
    assert.match(poseStudioSource, /render: \{ transparent: true, size: this\.renderSize\(\) \}/);
});


test("Pose Studio streams rAF-coalesced previews and one final capture per gesture", () => {
    assert.match(poseStudioSource, /VNCCS_POSE_LAYER_PREVIEW_FPS = 18/);
    const schedulerStart = poseStudioSource.indexOf("schedulePreview(sub)");
    assert.ok(schedulerStart >= 0, "Pose Studio preview scheduler not found");
    const scheduler = poseStudioSource.slice(schedulerStart, schedulerStart + 900);
    assert.ok(scheduler.includes("requestAnimationFrame"), "Pose Studio previews must be coalesced through requestAnimationFrame");
    assert.match(poseStudioSource, /window\.addEventListener\("pointerup", onPointerUp\)/);
    assert.match(poseStudioSource, /Exactly one full-quality capture per gesture/);
    assert.match(poseStudioSource, /if \(sub\.gestureFinalEmitted\) return;/);
});


test("the Pose Studio Characters panel owns the character dropdown", () => {
    assert.match(poseStudioSource, /studio\.renderCharactersUI = /);
    assert.match(poseStudioSource, /"Mannequin"/);
    assert.match(poseStudioSource, /fetch\("\/vnccs\/list_characters"\)/);
    assert.match(poseStudioSource, /applyExternalCharacterCreatorValues/);
    assert.match(poseStudioSource, /VNCCS_POSE_LAYER_CHARACTERS_UNAVAILABLE_NOTE = "VNCCS characters unavailable/);
});


test("the UniCanvas character control mirrors the Pose Studio selection read-only", () => {
    assert.match(poseLayerSource, /select\.disabled = true/);
    assert.match(poseLayerSource, /single source of truth for layer\.poseData\.character/);
});


test("bridge renders are dropped while a pose edit session owns the layer", () => {
    const guardStart = poseLayerSource.indexOf("function handleUniCanvasPoseLayerRender");
    assert.ok(guardStart >= 0, "render handler not found");
    const handler = poseLayerSource.slice(guardStart, guardStart + 1400);
    assert.match(handler, /state\?\.session\?\.layerId === sub\.layerId/);
    // Morph mirroring into the session is still allowed.
    assert.match(handler, /applyUniCanvasPoseLayerCharacterMorphs/);
    // Cancel restores the pre-edit pixels AND poseData untouched.
    assert.match(poseLayerSource, /session\.beforePixels/);
    assert.match(poseLayerSource, /session\.beforePoseData/);
    const cancelStart = poseLayerSource.indexOf("export function cancelUniCanvasPoseEdit");
    assert.ok(cancelStart >= 0, "cancelUniCanvasPoseEdit not found");
    const cancel = poseLayerSource.slice(cancelStart, cancelStart + 1400);
    assert.match(cancel, /restoreLayerPixelSnapshot\(layer, session\.beforePixels\)/);
    assert.match(cancel, /layer\.poseData = deepCloneJSON\(session\.beforePoseData\)/);
});


test("the chip links only when a Pose Studio that can render answers", () => {
    const pickStart = poseStudioSource.indexOf("    pickStudio() {");
    assert.ok(pickStart >= 0, "pickStudio not found");
    const pick = poseStudioSource.slice(pickStart, pickStart + 400);
    assert.match(pick, /isInitialized/);
    const subscribeStart = poseStudioSource.indexOf("    subscribe(layerId) {");
    assert.ok(subscribeStart >= 0, "subscribe not found");
    const subscribe = poseStudioSource.slice(subscribeStart, subscribeStart + 1400);
    assert.match(subscribe, /if \(!this\.pickStudio\(\)\) return;/);
});


test("the initial render is re-issued and the final guard re-arms on failure", () => {
    const finalStart = poseStudioSource.indexOf("    requestFinal(sub) {");
    assert.ok(finalStart >= 0, "requestFinal not found");
    const requestFinal = poseStudioSource.slice(finalStart, finalStart + 1200);
    const successIndex = requestFinal.indexOf('emitRender(sub, "final")');
    const guardIndex = requestFinal.indexOf("gestureFinalEmitted = true");
    assert.ok(successIndex >= 0 && guardIndex > successIndex, "the final-emitted guard must be set only after emitRender succeeds");
    assert.match(requestFinal, /reportError/);
    assert.match(poseStudioSource, /sub\.emittedCount/);
    assert.match(poseStudioSource, /_viewerInitPromise\)\.then\(reissue\)/);
});


test("one character selection commits one layerPixels history command", () => {
    assert.match(poseStudioSource, /VNCCS_POSE_LAYER_GESTURE_SETTLE_MS/);
    assert.match(poseStudioSource, /nudgeGesture\(sub\)/);
    const applyStart = poseStudioSource.indexOf("    applyCharacter(character) {");
    assert.ok(applyStart >= 0, "applyCharacter not found");
    const apply = poseStudioSource.slice(applyStart, applyStart + 2200);
    assert.match(apply, /settleHold = true/);
    assert.match(apply, /settleHold = false/);
    // The morph settle re-nudges the SAME gesture instead of opening a new one.
    assert.ok(!apply.includes("beginGesture"), "applyCharacter must not open a second gesture");
    assert.match(poseStudioSource, /if \(sub\.settleHold\) return;/);
});


test("undo of bridge gestures restores poseData together with pixels", () => {
    assert.match(poseLayerSource, /poseDataBefore: gesture\.poseDataBefore/);
    assert.match(poseLayerSource, /poseDataAfter: layer\.poseData \? deepCloneJSON\(layer\.poseData\) : null/);
    assert.match(widgetSource, /entry\.poseDataBefore !== undefined/);
    assert.match(widgetSource, /layer\.poseData = poseData \? JSON\.parse\(JSON\.stringify\(poseData\)\) : null;/);
});


test("fix-round hygiene: probe-only availability, own pose group, visible capture errors", () => {
    assert.ok(!poseLayerSource.includes("state.characters."), "vestigial character-list parsing must be gone");
    assert.ok(!poseLayerSource.includes("state.characters "), "vestigial character-list state must be gone");
    assert.match(poseLayerSource, /createLayerGroupHead\("Pose Layers"/);
    assert.match(poseLayerSource, /Pose capture failed: no Pose Studio linked/);
    assert.match(poseStudioSource, /\[VNCCS Pose Studio\] Pose layer capture failed/);
    assert.match(poseStudioSource, /console\.warn\("\[VNCCS Pose Studio\] Pose layer character morph solve failed"/);
});

test("pose layer creation opens the mannequin editor and failures are visible", async () => {
    const widgetSource = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
    assert.match(widgetSource, /this\.addPoseLayer\(\);/, "the mannequin tool must create a pose layer when none exists");
    assert.match(widgetSource, /editPoseLayer\(layer\)\?\.catch/, "editor failures must surface instead of dying silently");
    const poseSource = await readFile(new URL("../web/vnccs_unicanvas_pose_layers.mjs", import.meta.url), "utf8");
    assert.match(poseSource, /void editUniCanvasPoseLayer\(widget, layer\)\.catch/, "Add pose layer must open the editor right away");
    assert.match(poseSource, /viewWidth > 2 \? viewWidth : 480/, "the editor must fall back to a sane size on a zero-size overlay");
});

test("pose edits round-trip without drift and ship the library/options tools", async () => {
    const poseSource = await readFile(new URL("../web/vnccs_unicanvas_pose_layers.mjs", import.meta.url), "utf8");
    assert.ok(poseSource.includes("relativizeUniCanvasPoseBones"), "bone positions must be stored relative to the shaped rest");
    assert.ok(poseSource.includes("bonePositionsRel"), "the relative layout must be tagged");
    assert.match(poseSource, /viewer\.setPose\(absolutizeUniCanvasPoseBones\(viewer, poseData\.pose\) \|\| \{\}, true\)/, "edit sessions must set the absolutized stored pose");
    assert.ok(poseSource.includes("restoreUniCanvasViewerCamera"), "captures must not move the view camera");
    assert.ok(poseSource.includes("openUniCanvasPoseLibrary"), "the editor must offer the Pose Library");
    assert.ok(poseSource.includes("openUniCanvasPoseOptions"), "the editor must offer mannequin options");
    assert.ok(poseSource.includes("background:transparent"), "the editor overlay must stay transparent so the canvas shows through");
});


test("Save pose persists the session morphs into layer.poseData.character.morphs", async () => {
    const layer = {
        id: "pose-1",
        type: POSE_LAYER_TYPE,
        poseData: buildPoseLayerData({
            pose: { bonePositions: { spine: [1, 2, 3] } },
            character: { id: "vnccs-1", name: "Saved character", source: "vnccs", morphs: { age: 30, gender: 0.2 } },
            size: { width: 64, height: 64 },
        }),
    };
    const viewer = {
        isInitialized: () => true,
        getPose: () => ({ bonePositions: { spine: [1, 2, 3] } }),
        setPose: () => {},
        capture: () => "stub-png",
        dispose: () => {},
        requestRender: () => {},
        setDirectionalSkydomeVisible: () => {},
        shapedBoneRestPositions: { spine: { x: 0, y: 1, z: 0 } },
    };
    const session = {
        layerId: layer.id,
        poseData: buildPoseLayerData({ size: { width: 64, height: 64 } }),
        beforePixels: null,
        beforePoseData: null,
        // Session morphs: the stored ones merged with Mannequin options edits.
        morphs: normalizePoseLayerMorphs(
            { age: 44, breast_size: 0.8, show_genitals: true, spine_length: 0.7 },
            { age: 30, gender: 0.2 },
        ),
        viewer,
        overlay: null,
        resizeObserver: null,
        loadToken: 0,
        closed: false,
    };
    const widget = {
        layers: [layer],
        _poseLayerState: { widget: null, subs: new Map(), session },
        recordHistoryBefore: () => {},
        markLayerPixelsChanged: () => {},
        refreshLayerRow: () => {},
        renderLayerList: () => {},
        requestRender: () => {},
        syncLightStateToWidget: () => {},
        scheduleFullSync: () => {},
        setStatus: () => {},
        setTool: () => {},
    };
    widget._poseLayerState.widget = widget;

    assert.equal(await saveUniCanvasPoseEdit(widget), true);
    const saved = layer.poseData;
    // The character identity survives while morphs come from the session.
    assert.equal(saved.character.id, "vnccs-1");
    assert.equal(saved.character.name, "Saved character");
    assert.equal(saved.character.source, "vnccs");
    assert.deepEqual(saved.character.morphs, {
        age: 44,
        gender: 0.2,
        breast_size: 0.8,
        show_genitals: true,
        spine_length: 0.7,
    });
    // The saved pose stays relativized so the next edit session cannot drift.
    assert.equal(saved.pose.bonePositionsRel, true);
});


test("the mannequin options modal ports the full Pose Studio mesh params", () => {
    const optionsStart = poseLayerSource.indexOf("function openUniCanvasPoseOptions");
    assert.ok(optionsStart >= 0, "openUniCanvasPoseOptions not found");
    // Gender toggle (meshParams.gender: 1.0 = male, 0.0 = female).
    assert.match(poseLayerSource, /maleBtn\.addEventListener\("click", \(\) => setGender\(1\)\)/);
    assert.match(poseLayerSource, /femaleBtn\.addEventListener\("click", \(\) => setGender\(0\)\)/);
    assert.match(poseLayerSource, /"Male"/);
    assert.match(poseLayerSource, /"Female"/);
    // Gender-conditional sections flip live with the gender value.
    assert.match(poseLayerSource, /femaleSection\.style\.display = female \? "" : "none"/);
    assert.match(poseLayerSource, /maleSection\.style\.display = female \? "none" : ""/);
    for (const key of [
        "breast_size",
        "firmness",
        "show_genitals",
        "penis_len",
        "penis_circ",
        "penis_test",
        "head_size",
        "spine_length",
    ]) {
        assert.ok(poseLayerSource.includes('"' + key + '"'), "missing mannequin option key: " + key);
    }
    // Sliders keep the repo realtime rule: rAF-coalesced live updates.
    const options = poseLayerSource.slice(optionsStart);
    assert.ok(options.includes("requestAnimationFrame"), "options must apply morphs through requestAnimationFrame");
    assert.match(options, /session\.applyExternalCharacterCreatorValues\?\.\(session\.morphs\)/);
});


test("proportion morph keys scale the skeleton before the pose is applied", () => {
    const morphsStart = poseLayerSource.indexOf("async function applyUniCanvasPoseEditMorphs");
    assert.ok(morphsStart >= 0, "applyUniCanvasPoseEditMorphs not found");
    const morphs = poseLayerSource.slice(morphsStart, morphsStart + 1600);
    assert.match(poseLayerSource, /key\.endsWith\("_length"\)/);
    assert.match(poseLayerSource, /viewer\.updateBoneLengthScale\(group, value\)/);
    const proportionsIndex = morphs.indexOf("applyUniCanvasPoseProportionParams(viewer, morphs)");
    const setPoseIndex = morphs.indexOf("viewer.setPose(currentPose || fallbackPose, true)");
    assert.ok(proportionsIndex >= 0, "proportion params must be applied on morph updates");
    assert.ok(setPoseIndex > proportionsIndex, "proportions must apply BEFORE setPose");
    // The stored relativized pose must be absolutized before reaching setPose.
    assert.match(poseLayerSource, /absolutizeUniCanvasPoseBones\(viewer, session\.poseData\.pose/);
});


// Minimal stand-in for a Three.js bone: getWorldPosition(target) fills target.
function boneStub(map) {
    const bones = {};
    for (const [name, [x, y, z]] of Object.entries(map)) {
        bones[name] = {
            getWorldPosition(target) {
                Object.assign(target, { x, y, z });
                return target;
            },
        };
    }
    return bones;
}


test("computeTorsoAnchor centers between pelvis and upper chest, never the head", () => {
    const viewer = {
        bones: boneStub({
            root: [0, 0, 0], pelvis: [0, 3, 0], spine_02: [0, 4, 0], spine_03: [0, 5, 0],
            neck: [0, 6, 0], head: [0, 7, 0], upperarm_l: [-1, 5.5, 0], upperarm_r: [1, 5.5, 0],
            thigh_l: [-0.5, 2.5, 0], thigh_r: [0.5, 2.5, 0],
        }),
    };
    const anchor = computeTorsoAnchor(viewer);
    assert.ok(anchor, "anchor resolved");
    // Mid-torso: between pelvis (3) and upper chest (5) -> ~4; the head (7) must
    // not drag the anchor up.
    assert.ok(Math.abs(anchor.y - 4) < 0.35, `anchor.y=${anchor.y} expected ~4`);
    assert.ok(Math.abs(anchor.x) < 1e-6);
});

test("computeTorsoAnchor falls back to the mesh center on an unknown rig", () => {
    const viewer = { bones: boneStub({ something: [0, 1, 0] }), meshCenter: { x: 0, y: 2, z: 0 } };
    const anchor = computeTorsoAnchor(viewer);
    assert.deepEqual(anchor, { x: 0, y: 2, z: 0 });
});

test("pose edit framing is torso-anchored and saves a re-centered camera", () => {
    // Edit entry re-frames the viewer on the torso anchor after setPose (spec 6.2).
    const setPoseIndex = poseLayerSource.indexOf("viewer.setPose(absolutizeUniCanvasPoseBones(viewer, poseData.pose) || {}, true)");
    assert.ok(setPoseIndex >= 0, "edit entry setPose call not found");
    const editTail = poseLayerSource.slice(setPoseIndex);
    const framingIndex = editTail.indexOf("applyUniCanvasPoseFraming(viewer)");
    assert.ok(framingIndex >= 0, "edit entry must apply the torso framing after setPose");
    assert.ok(
        framingIndex < editTail.indexOf('widget.setStatus("[VNCCS UniCanvas] Edit pose'),
        "the framing must be applied before the editor reports ready",
    );
    // The anchor must hit BOTH the live orbit target and the capture camera
    // target, or the saved PNG and the edit view would frame different centers.
    assert.match(poseLayerSource, /viewer\.sceneCameraTarget = /);
    assert.match(poseLayerSource, /viewer\.orbit\.target\.copy\(viewer\.sceneCameraTarget\)/);
    // Save/capture zero the stored offsets so the stored framing re-frames on
    // the torso anchor exactly like the captured PNG (spec 6.3 re-frame).
    const captureStart = poseLayerSource.indexOf("function captureUniCanvasPoseEditPNG(session)");
    assert.ok(captureStart >= 0, "captureUniCanvasPoseEditPNG not found");
    // Cut at the object literal's closing brace: CRLF + comment tolerant.
    const capture = poseLayerSource.slice(captureStart, poseLayerSource.indexOf("}", captureStart) + 1);
    assert.match(capture, /offset_x: 0,\s*offset_y: 0/);
    const storedCameraIndex = poseLayerSource.indexOf("camera: { ...session.poseData.camera");
    assert.ok(storedCameraIndex >= 0, "saved poseData.camera must zero the offsets");
    const storedCamera = poseLayerSource.slice(storedCameraIndex, storedCameraIndex + 200);
    assert.match(storedCamera, /offset_x: 0,\s*offset_y: 0/);
});
