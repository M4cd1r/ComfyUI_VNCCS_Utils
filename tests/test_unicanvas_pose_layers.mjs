import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    absolutizeUniCanvasPoseBones,
    buildPoseLayerData,
    buildUniCanvasPoseOptionsSection,
    computeTorsoAnchor,
    drawUniCanvasPoseRenderIntoLayer,
    resolveUniCanvasPoseLayerBridgeAnchor,
    drawUniCanvasPoseBridgeRenderIntoLayer,
    MANNEQUIN_TOOL_ICON,
    mountUniCanvasPoseOptions,
    normalizePoseLayerData,
    normalizePoseLayerMorphs,
    POSE_LAYER_ADD_ICON,
    POSE_LAYER_BUS_EVENT,
    POSE_LAYER_STATUS,
    POSE_LAYER_TYPE,
    relativizeUniCanvasPoseBones,
    saveUniCanvasPoseEdit,
    unmountUniCanvasPoseOptions,
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
    assert.ok(poseSource.includes("buildUniCanvasPoseOptionsSection"), "the editor must offer mannequin options");
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


test("the mannequin options sidebar section ports the full Pose Studio mesh params", () => {
    const optionsStart = poseLayerSource.indexOf("export function buildUniCanvasPoseOptionsSection");
    assert.ok(optionsStart >= 0, "buildUniCanvasPoseOptionsSection not found");
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


// ---------------------------------------------------------------------------
// Mannequin options sidebar section (spec section 3).
//
// The section builder is plain DOM code, so the test drives it with a minimal
// fake document (class/text/event/containment only - the very API surface the
// builder uses) instead of pulling jsdom into the repo.
// ---------------------------------------------------------------------------

class FakeElement {
    constructor(tagName = "div", ownerDocument = null) {
        this.tagName = String(tagName).toUpperCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.parentElement = null;
        this.textContent = "";
        this.value = "";
        this.checked = false;
        this.type = "";
        this.style = {};
        this.dataset = {};
        this.listeners = new Map();
        this._classes = new Set();
    }

    get className() {
        return [...this._classes].join(" ");
    }

    set className(value) {
        this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
    }

    get classList() {
        const classes = this._classes;
        return {
            add: (...names) => { for (const name of names) classes.add(name); },
            remove: (...names) => { for (const name of names) classes.delete(name); },
            contains: (name) => classes.has(name),
            toggle: (name, force) => {
                const next = force === undefined ? !classes.has(name) : Boolean(force);
                if (next) classes.add(name);
                else classes.delete(name);
                return next;
            },
        };
    }

    append(...nodes) {
        for (const node of nodes) this.appendChild(node);
    }

    appendChild(node) {
        if (node.parentElement) node.parentElement.children = node.parentElement.children.filter((child) => child !== node);
        node.parentElement = this;
        this.children.push(node);
        return node;
    }

    remove() {
        if (!this.parentElement) return;
        this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
        this.parentElement = null;
    }

    contains(node) {
        if (this === node) return true;
        return this.children.some((child) => child.contains?.(node) === true);
    }

    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(handler);
    }

    dispatchEvent(event) {
        for (const handler of this.listeners.get(event?.type) || []) handler(event);
        return true;
    }

    /** Class-selector and tag-selector support only - enough for these tests. */
    querySelectorAll(selector) {
        const wanted = String(selector);
        const matches = (element) => (wanted.startsWith(".")
            ? element._classes.has(wanted.slice(1))
            : element.tagName === wanted.toUpperCase());
        const found = [];
        const walk = (element) => {
            for (const child of element.children) {
                if (matches(child)) found.push(child);
                walk(child);
            }
        };
        walk(this);
        return found;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
    }
}

function createFakeDocument() {
    const document = {
        createElement(tagName) {
            return new FakeElement(tagName, document);
        },
        getElementById() {
            return null;
        },
        querySelector() {
            return null;
        },
        querySelectorAll() {
            return [];
        },
    };
    document.head = new FakeElement("head", document);
    document.body = new FakeElement("body", document);
    return document;
}

function descendantsOf(root) {
    const all = [];
    const walk = (element) => {
        for (const child of element.children) {
            all.push(child);
            walk(child);
        }
    };
    walk(root);
    return all;
}

function makePoseEditFixture() {
    const fakeDocument = createFakeDocument();
    const previousDocument = globalThis.document;
    globalThis.document = fakeDocument;
    const widget = {
        container: new FakeElement("div", fakeDocument),
        left: new FakeElement("div", fakeDocument),
        layers: [],
    };
    const session = {
        layerId: "pose-1",
        morphs: normalizePoseLayerMorphs({ age: 25 }, {}),
        optionsSection: null,
        applyExternalCharacterCreatorValues: () => true,
    };
    const state = {
        widget,
        subs: new Map(),
        session,
        stylesInstalled: true,
    };
    widget._poseLayerState = state;
    return {
        widget,
        state,
        session,
        restore() {
            if (previousDocument === undefined) delete globalThis.document;
            else globalThis.document = previousDocument;
        },
    };
}


test("mannequin options render as a sidebar section, never as a modal overlay", () => {
    const fixture = makePoseEditFixture();
    try {
        const { widget, state, session } = fixture;
        const section = buildUniCanvasPoseOptionsSection(state, session);
        assert.equal(section.className, "vnccs-uc-pose-options-section");
        assert.equal(section.querySelector(".vnccs-uc-pose-panel-title")?.textContent, "Mannequin options");
        assert.equal(section.querySelectorAll(".vnccs-uc-modal-overlay").length, 0, "the section is not a modal");
        assert.equal(section.querySelectorAll(".vnccs-uc-modal").length, 0, "the section is not a modal");

        mountUniCanvasPoseOptions(widget, session);
        assert.ok(widget.left.contains(session.optionsSection), "options mount into the left column");
        assert.equal(widget.container.querySelectorAll(".vnccs-uc-modal-overlay").length, 0, "no dimming overlay");

        unmountUniCanvasPoseOptions(widget);
        assert.equal(session.optionsSection, null);
        assert.equal(widget.left.contains(section), false, "unmount detaches the section");
    } finally {
        fixture.restore();
    }
});


test("mannequin options apply morphs live through requestAnimationFrame", () => {
    const fixture = makePoseEditFixture();
    const previousRaf = globalThis.requestAnimationFrame;
    try {
        const { state, session } = fixture;
        const applied = [];
        session.applyExternalCharacterCreatorValues = (morphs) => {
            applied.push({ ...morphs });
            return true;
        };
        const frames = [];
        globalThis.requestAnimationFrame = (callback) => {
            frames.push(callback);
            return frames.length;
        };
        const section = buildUniCanvasPoseOptionsSection(state, session);
        const range = descendantsOf(section).find((element) => element.type === "range");
        assert.ok(range, "the section must expose morph sliders");
        assert.equal(range.value, "25", "the slider starts at the session morph value");

        range.value = "42";
        range.dispatchEvent({ type: "input" });
        assert.equal(session.morphs.age, 42, "the newest control value wins immediately");
        assert.equal(frames.length, 1, "morph application is coalesced into one frame");
        frames[0](0);
        assert.deepEqual(applied, [{ ...session.morphs }]);

        range.dispatchEvent({ type: "input" });
        assert.equal(frames.length, 2);
    } finally {
        if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
        else globalThis.requestAnimationFrame = previousRaf;
        fixture.restore();
    }
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

test("computeTorsoAnchor caps the mesh-center fallback below the head bone", () => {
    // Spec 6.1 fallback: a rig with no torso-pattern bones must not re-center
    // on the head - the bbox is truncated at the head/neck Y first.
    const viewer = {
        bones: boneStub({ head: [0, 8.6, 0] }),
        meshCenter: { x: 0.5, y: 5, z: -0.25 },
        skinnedMesh: { geometry: { boundingBox: { min: { y: 0 }, max: { y: 10 } } } },
    };
    const anchor = computeTorsoAnchor(viewer);
    // bbox y in [0, 10] capped at the head (8.6) -> truncated centre 4.3,
    // not the head-inclusive 5.0.
    assert.ok(Math.abs(anchor.y - 4.3) < 1e-6, `anchor.y=${anchor.y} expected ~4.3`);
    assert.equal(anchor.x, 0.5);
    assert.equal(anchor.z, -0.25);

    // No head/neck bone either: raw meshCenter stays the last resort.
    const bareViewer = {
        bones: boneStub({ tentacle_a: [0, 9, 0] }),
        meshCenter: { x: 0, y: 5, z: 0 },
        skinnedMesh: { geometry: { boundingBox: { min: { y: 0 }, max: { y: 10 } } } },
    };
    assert.deepEqual(computeTorsoAnchor(bareViewer), { x: 0, y: 5, z: 0 });
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

// --- Task 5: pose round-trip idempotence (Bug A) -----------------------------


// --- Task 5: pose round-trip idempotence (Bug A) -----------------------------

// Minimal 2D-context stub: records drawImage destination rects so the pose
// layer draw geometry is assertable without a browser canvas.
function makeDrawRecorder() {
    const draws = [];
    const context = {
        clearRect() {},
        drawImage(_image, x, y, width, height) { draws.push({ x, y, width, height }); },
    };
    return { context, draws };
}

test("editor pose saves draw the capture at its natural render size, never squeezed into the previous alpha bounds", () => {
    // Bug A geometry: the first editor save left a 378x595 mannequin footprint
    // on a 2048 canvas. The next save squeezed the whole 1024x1024 capture
    // into that footprint, shrinking the mannequin on every edit -> save cycle.
    // The alpha-crop branch is gone, so no caller can ask for that squeeze.
    const recorder = makeDrawRecorder();
    const widget = {
        origin: { x: 0, y: 0 },
        size: { width: 2048, height: 2048 },
        getLayerAlphaBounds: () => ({ x: 835, y: 725, width: 378, height: 595 }),
        configureImageContext: (context) => context,
    };
    const layer = { canvas: { width: 2048, height: 2048, getContext: () => recorder.context } };
    const image = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 };
    const renderMeta = { transparent: true, size: { width: 1024, height: 1024 } };

    drawUniCanvasPoseRenderIntoLayer(widget, layer, image, renderMeta);

    assert.equal(recorder.draws.length, 1);
    const { x, y, width, height } = recorder.draws[0];
    // Natural capture size, centered on the canvas: a fixed point across save
    // cycles, independent of the mannequin footprint left by earlier saves.
    assert.deepEqual([width, height], [1024, 1024]);
    assert.deepEqual([x, y], [512, 512]);
});


test("the shared pose draw exposes no crop option any more", () => {
    const drawStart = poseLayerSource.indexOf("export function drawUniCanvasPoseRenderIntoLayer");
    assert.ok(drawStart >= 0, "drawUniCanvasPoseRenderIntoLayer not found");
    const draw = poseLayerSource.slice(drawStart, poseLayerSource.indexOf("\nfunction nextUniCanvasPoseLayerName", drawStart));
    assert.doesNotMatch(draw, /respectLayerCrop/, "the dead crop option must not come back");
    assert.doesNotMatch(
        poseLayerSource,
        /resolveUniCanvasPoseLayerTargetRect/,
        "the dead crop target helper must be gone (the squeeze was Bug A)",
    );
});


test("the editor capture path draws 1:1 through the shared pose draw", () => {
    const captureStart = poseLayerSource.indexOf("async function applyUniCanvasPoseEditCapture");
    assert.ok(captureStart >= 0, "applyUniCanvasPoseEditCapture not found");
    const capture = poseLayerSource.slice(captureStart, captureStart + 2800);
    assert.match(
        capture,
        /drawUniCanvasPoseRenderIntoLayer\(widget, layer, image, session\.poseData\.render\)/,
        "the editor capture must draw the fresh render 1:1 at natural size",
    );
    assert.doesNotMatch(
        capture,
        /respectLayerCrop/,
        "the removed crop option must not be passed any more",
    );
});


// --- Task 8: the Pose Studio bridge path never scales ------------------------

test("bridge draws land 1:1 at natural size, frame centre on the previous content centre", () => {
    // The bridge used the alpha-crop branch: every capture now squeezed the
    // fresh 1024x1024 render into the previous footprint (e.g. 378x595) and
    // the mannequin shrank on every push.
    const recorder = makeDrawRecorder();
    const bounds = { x: 835, y: 725, width: 378, height: 595 };
    let scans = 0;
    const widget = {
        origin: { x: 0, y: 0 },
        size: { width: 2048, height: 2048 },
        getLayerAlphaBounds: () => { scans += 1; return bounds; },
        configureImageContext: (context) => context,
        markLayerPixelsChanged: (layer) => {
            layer._pixelsRev = (layer._pixelsRev || 0) + 1;
        },
    };
    const layer = { canvas: { width: 2048, height: 2048, getContext: () => recorder.context } };
    const image = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 };
    const renderMeta = { transparent: true, size: { width: 1024, height: 1024 } };
    const sub = {};
    const anchor = resolveUniCanvasPoseLayerBridgeAnchor(widget, sub, layer);
    // Anchor = centre of the previous content: (835+189, 725+297.5).
    assert.deepEqual([anchor.x, anchor.y], [1024, 1022.5]);

    drawUniCanvasPoseBridgeRenderIntoLayer(widget, layer, image, renderMeta, anchor);

    assert.equal(recorder.draws.length, 1);
    const { x, y, width, height } = recorder.draws[0];
    // Natural capture size 1:1 - never the previous footprint.
    assert.deepEqual([width, height], [1024, 1024]);
    // The frame centre sits on the anchor: x + 512 = 1024, y + 512 ~ 1022.5
    // (rounded), so y = round(512 - 1.5) = 511.
    assert.deepEqual([x, y], [512, 511]);
    // The draw recorded that rect, so the next anchor comes from the record -
    // O(1), with no second scan of the layer bitmap.
    const again = resolveUniCanvasPoseLayerBridgeAnchor(widget, sub, layer);
    assert.deepEqual([again.x, again.y], [1024, 1023]);
    assert.deepEqual(again.rect, { x: 512, y: 511, width: 1024, height: 1024 });
    assert.equal(scans, 1, "the recorded rect must be reused without rescanning the layer");
});

test("the bridge render path never goes through the alpha-crop draw branch", () => {
    const bridgeStart = poseLayerSource.indexOf("async function applyUniCanvasPoseLayerRenderPixels");
    assert.ok(bridgeStart >= 0, "applyUniCanvasPoseLayerRenderPixels not found");
    const bridge = poseLayerSource.slice(bridgeStart, poseLayerSource.indexOf("\nfunction commitUniCanvasPoseLayerGesture", bridgeStart));
    assert.match(
        bridge,
        /drawUniCanvasPoseBridgeRenderIntoLayer\(/,
        "the bridge must draw through the 1:1 bridge path",
    );
    assert.doesNotMatch(
        bridge,
        /drawUniCanvasPoseRenderIntoLayer\(/,
        "the bridge must not call the crop-capable draw any more",
    );
});


test("bridge preview frames reuse the recorded rect and stop scanning the layer bitmap", () => {
    // Preview pushes arrive at ~18 FPS, so the second and later frames of an
    // unchanged layer must cost no alpha scan at all: they reuse the rect the
    // previous frame recorded. The layer's pixel revision is the validity
    // token, so a move or a paint drops back to one cold scan per change.
    const recorder = makeDrawRecorder();
    const bounds = { x: 835, y: 725, width: 378, height: 595 };
    let scans = 0;
    const widget = {
        origin: { x: 0, y: 0 },
        size: { width: 2048, height: 2048 },
        getLayerAlphaBounds: () => { scans += 1; return bounds; },
        configureImageContext: (context) => context,
        markLayerPixelsChanged: (layer) => {
            layer._pixelsRev = (layer._pixelsRev || 0) + 1;
        },
    };
    const layer = { canvas: { width: 2048, height: 2048, getContext: () => recorder.context } };
    const image = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 };
    const renderMeta = { transparent: true, size: { width: 1024, height: 1024 } };
    const sub = {};
    let anchor = resolveUniCanvasPoseLayerBridgeAnchor(widget, sub, layer);
    let rect = drawUniCanvasPoseBridgeRenderIntoLayer(widget, layer, image, renderMeta, anchor);
    assert.equal(scans, 1, "the first frame of a foreign layer needs one cold scan");

    // Same layer, next preview frame: no scan, same rect (no drift).
    for (let frame = 0; frame < 3; frame += 1) {
        anchor = resolveUniCanvasPoseLayerBridgeAnchor(widget, sub, layer);
        const next = drawUniCanvasPoseBridgeRenderIntoLayer(widget, layer, image, renderMeta, anchor);
        assert.deepEqual(next, rect, "a reused frame must land on the identical rect");
    }
    assert.equal(scans, 1, "steady-state preview frames must not scan the layer bitmap");
    assert.deepEqual(recorder.draws.map((draw) => [draw.x, draw.y]), [[512, 511], [512, 511], [512, 511], [512, 511]]);

    // A committed foreign change (move/paint) bumps the revision: exactly one
    // cold scan, then the reuse resumes on the new placement.
    layer._pixelsRev = (layer._pixelsRev || 0) + 1;
    const moved = { x: 300, y: 900, width: 378, height: 595 };
    widget.getLayerAlphaBounds = () => { scans += 1; return moved; };
    anchor = resolveUniCanvasPoseLayerBridgeAnchor(widget, sub, layer);
    rect = drawUniCanvasPoseBridgeRenderIntoLayer(widget, layer, image, renderMeta, anchor);
    assert.equal(scans, 2, "one cold scan per foreign change");
    // New anchor = the moved content centre (300+189, 900+297.5) = (489, 1197.5),
    // so the natural rect shifts to (round(512-535), round(512+173.5)) = (-23, 686).
    assert.deepEqual(rect, { x: -23, y: 686, width: 1024, height: 1024 });
    assert.deepEqual(recorder.draws.at(-1), { x: -23, y: 686, width: 1024, height: 1024 });
});


// Faithful stub of the viewer semantics the storage round trip relies on:
// getPose() -> absolute local positions; setPose() resets to rest then
// applies; updateBoneLengthScale() rescales a child offset from the UN-shaped
// initial state and re-caches the shaped rest (vnccs_pose_studio_core.js
// _setBoneOffsetScale/_cacheShapedRestBonePositions/updateBoneLengthScale).
// CHILD_OF mirrors _boneLengthChildrenForGroup output for the seeded groups.
const poseVec = ([x, y, z]) => ({ x, y, z });
const POSE_CHILD_OF = { shoulder_l: "upperarm_l", spine: "spine_02" };

class PoseRoundTripViewerStub {
    constructor(initialOffsets) {
        this.initialBoneStates = Object.fromEntries(
            Object.entries(initialOffsets).map(([name, position]) => [name, { position: poseVec(position) }]),
        );
        this.shapedBoneRestPositions = {};
        this.scaled = {};
        this.positions = {};
        this.restyle();
    }
    restyle() {
        for (const [name, initial] of Object.entries(this.initialBoneStates)) {
            const scale = this.scaled[name] ?? 1;
            const rest = [initial.position.x * scale, initial.position.y * scale, initial.position.z * scale];
            this.shapedBoneRestPositions[name] = poseVec(rest);
            this.positions[name] = [...rest];
        }
    }
    getPose() {
        return { bonePositions: Object.fromEntries(Object.entries(this.positions).map(([n, p]) => [n, [...p]])) };
    }
    setPose(pose) {
        this.restyle();
        for (const [name, p] of Object.entries(pose.bonePositions || {})) this.positions[name] = [...p];
    }
    updateBoneLengthScale(group, value) {
        this.scaled[POSE_CHILD_OF[group]] = 0.5 + value;
        this.restyle();
    }
}

test("relativize -> absolutize over a reshaped rest is the identity across 10 edit->save cycles", () => {
    // Binary-exact offsets so the float arithmetic is deterministic (the
    // identity must hold bit-for-bit, not approximately).
    const viewer = new PoseRoundTripViewerStub({ upperarm_l: [2, 0, 0], spine_02: [0, 2, 0] });
    const first = relativizeUniCanvasPoseBones(viewer, {
        bonePositions: { upperarm_l: [3.5, 0.5, 0], spine_02: [0, 3, 0.5] },
    });
    let current = first;
    for (let cycle = 0; cycle < 10; cycle += 1) {
        viewer.updateBoneLengthScale("shoulder_l", 0.5); // neutral 1.0 scale, re-caches rest
        current = relativizeUniCanvasPoseBones(viewer, absolutizeUniCanvasPoseBones(viewer, current));
    }
    assert.deepEqual(current.bonePositions, first.bonePositions);
    // The saved pose stays tagged relative so the next edit absolutizes it.
    assert.equal(current.bonePositionsRel, true);
});
