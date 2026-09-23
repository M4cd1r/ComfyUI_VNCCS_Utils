import assert from "node:assert/strict";
import test from "node:test";

import { drawUniCanvasPoseRenderIntoLayer } from "../web/vnccs_unicanvas_pose_layers.mjs";


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

// The production scanner draws the capture on a scratch canvas; stub the
// document + widget scanner so the geometry is testable in Node.
function makeScratchDocument(previousDocument) {
    globalThis.document = {
        createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }),
    };
    return () => {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    };
}

const IMAGE = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 };
const RENDER_META = { transparent: true, size: { width: 1024, height: 1024 } };

/**
 * Widget/layer fixture with the production pixel-revision contract: the widget
 * bumps `layer._pixelsRev` whenever it invalidates the layer's pixel caches,
 * and the draw helper records the rect it drew against that revision.
 */
function makeFixture({ previousBounds, incomingBounds }) {
    const recorder = makeDrawRecorder();
    const state = { previousBounds, incomingBounds, scans: 0 };
    const widget = {
        origin: { x: 0, y: 0 },
        size: { width: 2048, height: 2048 },
        getLayerAlphaBounds: () => state.previousBounds,
        getCanvasAlphaBounds: () => state.incomingBounds,
        configureImageContext: (context) => context,
        markLayerPixelsChanged: (layer) => {
            layer._pixelsRev = (layer._pixelsRev || 0) + 1;
        },
    };
    const layer = { canvas: { width: 2048, height: 2048, getContext: () => recorder.context } };
    return { recorder, widget, layer, state };
}

test("editor pose saves preserve an off-centre placement and keep a fresh layer centred (spec 5.1b)", () => {
    // The move tool bakes the layer placement into the bitmap, so an editor
    // save must align the fresh capture's content centre with the previous
    // content centre instead of jumping back to the canvas centre. The draw
    // stays 1:1 natural size - never scaled.
    const incomingBounds = { x: 323, y: 217, width: 378, height: 595 };
    const restoreDocument = makeScratchDocument(globalThis.document);
    try {
        // Previous content sits bottom-left (moved layer): the drawn rect must
        // put the incoming content centre on the previous content centre.
        const previousBounds = { x: 120, y: 900, width: 378, height: 595 };
        const moved = makeFixture({ previousBounds, incomingBounds });
        drawUniCanvasPoseRenderIntoLayer(moved.widget, moved.layer, IMAGE, RENDER_META);
        assert.equal(moved.recorder.draws.length, 1);
        const draw = moved.recorder.draws[0];
        assert.deepEqual([draw.width, draw.height], [1024, 1024], "the capture must never be scaled");
        const drawnContentCentreX = draw.x + incomingBounds.x + incomingBounds.width / 2;
        const drawnContentCentreY = draw.y + incomingBounds.y + incomingBounds.height / 2;
        assert.ok(
            Math.abs(drawnContentCentreX - (previousBounds.x + previousBounds.width / 2)) <= 0.5,
            "content centre must match the previous placement on x",
        );
        assert.ok(
            Math.abs(drawnContentCentreY - (previousBounds.y + previousBounds.height / 2)) <= 0.5,
            "content centre must match the previous placement on y",
        );

        // Fresh/empty layer: no previous placement -> centred fallback.
        const fresh = makeFixture({ previousBounds: null, incomingBounds });
        drawUniCanvasPoseRenderIntoLayer(fresh.widget, fresh.layer, IMAGE, RENDER_META);
        assert.deepEqual(
            [fresh.recorder.draws[0].x, fresh.recorder.draws[0].y, fresh.recorder.draws[0].width, fresh.recorder.draws[0].height],
            [512, 512, 1024, 1024],
        );
    } finally {
        restoreDocument();
    }
});

test("a pose change reuses the recorded draw rect, so the body cannot translate (spec 5.1b)", () => {
    // Frame-anchored saves: the capture is torso-anchored, so its content bbox
    // centre sits BELOW the torso. Aligning bbox centres (the old rule) turns
    // any silhouette change into a whole-body translation - raising an arm by
    // 100 px moved the mannequin ~50 px. Reusing the rect the layer already
    // holds is the fix; a move/paint invalidates the record and the
    // content-centre rule comes back for that save.
    const restoreDocument = makeScratchDocument(globalThis.document);
    try {
        const previousBounds = { x: 120, y: 900, width: 378, height: 595 };
        const fixture = makeFixture({ previousBounds, incomingBounds: { x: 323, y: 217, width: 378, height: 595 } });
        const rect1 = drawUniCanvasPoseRenderIntoLayer(fixture.widget, fixture.layer, IMAGE, RENDER_META);
        assert.deepEqual([rect1.width, rect1.height], [1024, 1024]);

        // Pose change: the arm goes up, so the capture's alpha bbox grows 100 px
        // at the top while the layer pixels are untouched since the last save.
        fixture.state.incomingBounds = { x: 323, y: 117, width: 378, height: 695 };
        const rect2 = drawUniCanvasPoseRenderIntoLayer(fixture.widget, fixture.layer, IMAGE, RENDER_META);
        assert.deepEqual(
            { x: rect2.x, y: rect2.y, width: rect2.width, height: rect2.height },
            { x: rect1.x, y: rect1.y, width: rect1.width, height: rect1.height },
            "a pose change must redraw at the recorded rect (bbox-centre alignment would shift the body)",
        );

        // Foreign pixel change (the move tool bakes the new placement into the
        // bitmap) invalidates the record: the save falls back to the content
        // centre rule and follows the new placement.
        fixture.state.previousBounds = { x: -500, y: 1100, width: 378, height: 595 };
        fixture.layer._pixelsRev = (fixture.layer._pixelsRev || 0) + 1;
        const rect3 = drawUniCanvasPoseRenderIntoLayer(fixture.widget, fixture.layer, IMAGE, RENDER_META);
        assert.deepEqual([rect3.width, rect3.height], [1024, 1024], "still never scaled");
        assert.notDeepEqual([rect3.x, rect3.y], [rect2.x, rect2.y], "a moved layer must not keep the stale rect");
        const drawnContentCentreX = rect3.x + 323 + 189;
        const drawnContentCentreY = rect3.y + 117 + 347.5;
        assert.ok(
            Math.abs(drawnContentCentreX - (fixture.state.previousBounds.x + 189)) <= 0.5
            && Math.abs(drawnContentCentreY - (fixture.state.previousBounds.y + 297.5)) <= 0.5,
            "the fallback must still align the incoming content centre with the moved placement",
        );
    } finally {
        restoreDocument();
    }
});

test("a world expansion invalidates the recorded rect, a render-size change keeps its placement", () => {
    // The recorded rect lives in layer-canvas coordinates, so a world expansion
    // (which shifts every layer canvas) must discard it even though the pixel
    // revision may look unchanged. A render-size change keeps the frame centre
    // and draws at the new natural size - the mannequin is never re-centred and
    // never scaled.
    const restoreDocument = makeScratchDocument(globalThis.document);
    try {
        const previousBounds = { x: 120, y: 900, width: 378, height: 595 };
        const incomingBounds = { x: 323, y: 217, width: 378, height: 595 };
        const fixture = makeFixture({ previousBounds, incomingBounds });
        const rect1 = drawUniCanvasPoseRenderIntoLayer(fixture.widget, fixture.layer, IMAGE, RENDER_META);
        assert.deepEqual([rect1.width, rect1.height], [1024, 1024]);

        // Render-size change with the frame record still current: same centre,
        // new size (never the old footprint, never a re-centre).
        const small = { transparent: true, size: { width: 512, height: 512 } };
        const rect2 = drawUniCanvasPoseRenderIntoLayer(fixture.widget, fixture.layer, IMAGE, small);
        assert.deepEqual(rect2, { x: rect1.x + 256, y: rect1.y + 256, width: 512, height: 512 });
        assert.deepEqual(
            [rect2.x + rect2.width / 2, rect2.y + rect2.height / 2],
            [rect1.x + rect1.width / 2, rect1.y + rect1.height / 2],
            "a size change must keep the frame centre",
        );

        // World expansion: the canvas coordinate system moved, so the record is
        // no longer a claim about the current pixels.
        const beforeExpansion = fixture.recorder.draws.length;
        fixture.widget.origin = { x: -256, y: -256 };
        fixture.state.previousBounds = { x: -136, y: 644, width: 378, height: 595 };
        const rect3 = drawUniCanvasPoseRenderIntoLayer(fixture.widget, fixture.layer, IMAGE, small);
        assert.equal(fixture.recorder.draws.length, beforeExpansion + 1);
        assert.notDeepEqual(
            [rect3.x, rect3.y],
            [rect2.x, rect2.y],
            "a shifted world frame must not reuse the old rect",
        );
        assert.deepEqual([rect3.width, rect3.height], [512, 512]);
    } finally {
        restoreDocument();
    }
});
