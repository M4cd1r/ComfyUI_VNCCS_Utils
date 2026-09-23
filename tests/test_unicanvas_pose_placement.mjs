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

test("editor pose saves preserve an off-centre placement and keep a fresh layer centred (spec 5.1b)", () => {
    // The move tool bakes the layer placement into the bitmap, so an editor
    // save must align the fresh capture's content centre with the previous
    // content centre instead of jumping back to the canvas centre. The draw
    // stays 1:1 natural size - never scaled.
    const image = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 };
    const renderMeta = { transparent: true, size: { width: 1024, height: 1024 } };
    // Where the mannequin sits inside the fresh capture (alpha bounds, image px).
    const incomingBounds = { x: 323, y: 217, width: 378, height: 595 };
    // The production scanner draws the capture on a scratch canvas; stub the
    // document + widget scanner so the geometry is testable in Node.
    const previousDocument = globalThis.document;
    globalThis.document = {
        createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }),
    };
    const makeFixture = (previousBounds) => {
        const recorder = makeDrawRecorder();
        const widget = {
            origin: { x: 0, y: 0 },
            size: { width: 2048, height: 2048 },
            getLayerAlphaBounds: () => previousBounds,
            getCanvasAlphaBounds: () => incomingBounds,
            configureImageContext: (context) => context,
        };
        const layer = { canvas: { width: 2048, height: 2048, getContext: () => recorder.context } };
        return { recorder, widget, layer };
    };
    try {
        // Previous content sits bottom-left (moved layer): the drawn rect must
        // put the incoming content centre on the previous content centre.
        const previousBounds = { x: 120, y: 900, width: 378, height: 595 };
        const moved = makeFixture(previousBounds);
        drawUniCanvasPoseRenderIntoLayer(moved.widget, moved.layer, image, renderMeta, { respectLayerCrop: false });
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
        const fresh = makeFixture(null);
        drawUniCanvasPoseRenderIntoLayer(fresh.widget, fresh.layer, image, renderMeta, { respectLayerCrop: false });
        assert.deepEqual(
            [fresh.recorder.draws[0].x, fresh.recorder.draws[0].y, fresh.recorder.draws[0].width, fresh.recorder.draws[0].height],
            [512, 512, 1024, 1024],
        );
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});
