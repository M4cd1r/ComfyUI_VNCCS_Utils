import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// All regexes avoid literal line breaks so the suite stays CRLF-tolerant on
// Windows checkouts (see tests/test_unicanvas_frontend.mjs for the contrast).
const modesSource = await readFile(new URL("../web/vnccs_unicanvas_modes.mjs", import.meta.url), "utf8");
const widgetSource = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");

// Handler-region scoping: assertions run against the named region only, so they
// cannot pass on unrelated code elsewhere in the file.
function region(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `region start not found: ${startMarker}`);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(end > start, `region end not found: ${endMarker}`);
    return source.slice(start, end);
}

function isolationHandler(name) {
    const body = modesSource.match(new RegExp(`const ${name} = \\(event\\) => \\{[\\s\\S]*?\\};`));
    assert.ok(body, `${name} isolation handler not found`);
    return body[0];
}

test("fullscreen installs window capture-phase keyboard isolation", () => {
    for (const type of ["keydown", "keyup", "keypress"]) {
        const pattern = new RegExp(`window\\.addEventListener\\("${type}",\\s*[^,]+,\\s*true\\)`);
        assert.ok(pattern.test(modesSource), `window ${type} listener must be capture-phase`);
    }

    for (const handler of ["onKeyDown", "onKeyUp", "onKeyPress"]) {
        const body = isolationHandler(handler);
        assert.ok(body.includes("stopImmediatePropagation()"), `${handler} must stop immediate propagation`);
        assert.ok(body.includes("preventDefault()"), `${handler} must prevent the default action`);
        assert.ok(body.includes("isUniCanvasTextTarget(event)"), `${handler} must spare text fields`);
        assert.ok(body.includes("modalOwnsKey(event)"), `${handler} must defer Enter/Escape to an open modal`);
    }

    assert.ok(modesSource.includes("input, textarea, select, [contenteditable]"),
        "text targets are input/textarea/select/[contenteditable] per spec 5");
    for (const type of ["keydown", "keyup", "keypress"]) {
        const removal = new RegExp(`window\\.removeEventListener\\("${type}",\\s*state\\.onKey[^,]*,\\s*true\\)`);
        assert.ok(removal.test(modesSource), `window ${type} listener must be removed on exit`);
    }
});

test("UniCanvas shortcut map covers tools, history, brush size, panels and Esc", () => {
    for (const [key, tool] of [["b", "brush"], ["v", "move"], ["e", "eraser"], ["m", "mask"], ["l", "lasso"], ["s", "rect"]]) {
        const pattern = new RegExp(`${key}:\\s*"${tool}"`);
        assert.ok(pattern.test(modesSource), `shortcut ${key} must select the ${tool} tool`);
    }

    const shortcuts = region(modesSource, "export function handleUniCanvasShortcut", "function installUniCanvasShortcuts");
    assert.ok(/lower === "z"/.test(shortcuts), "history shortcut must be Z");
    assert.ok(shortcuts.includes("event.ctrlKey || event.metaKey"), "history shortcut must use Ctrl/Cmd");
    assert.ok(shortcuts.includes("widget.undo()") && shortcuts.includes("widget.redo()"), "undo/redo must be wired");
    assert.ok(shortcuts.includes("event.shiftKey"), "Ctrl+Shift+Z must redo");
    assert.ok(shortcuts.includes('key === "["') && shortcuts.includes('key === "]"'), "brush size keys [ and ]");
    assert.ok(shortcuts.includes('key === "Tab"'), "Tab toggles panel visibility");
    assert.ok(shortcuts.includes('key === "Escape"'), "Esc exits fullscreen");
    assert.ok(shortcuts.includes("exitUniCanvasFullscreen(widget)"), "Esc must reach the fullscreen exit");
    assert.ok(shortcuts.includes("TOOL_SHORTCUTS[lower]"), "tool keys must route through the shortcut map");
    assert.ok(shortcuts.includes("isUniCanvasCanvasFocused(widget, event)"),
        "the map (minus Esc) must be scoped to canvas focus");
    assert.ok(widgetSource.includes("installUniCanvasWidgetModes(this.uniCanvasWidget)"),
        "vnccs_unicanvas.js must install the modes on every widget");
});

test("open widget modals keep their Enter/Escape keyboard contract in fullscreen", () => {
    assert.ok(modesSource.includes('const modalOwnsKey = (event) => isUniCanvasModalOpen(widget) && (event.key === "Enter" || event.key === "Escape")'),
        "Enter/Escape must be deferred to the modal while one is open");
    assert.ok(modesSource.includes(".vnccs-uc-modal-overlay"), "the modal overlay must be detected");
    const shortcuts = region(modesSource, "export function handleUniCanvasShortcut", "function installUniCanvasShortcuts");
    assert.ok(shortcuts.includes("isUniCanvasModalOpen(widget)"), "an open modal must keep the keyboard");
    assert.ok(shortcuts.indexOf("isUniCanvasModalOpen(widget)") < shortcuts.indexOf('key === "Escape"'),
        "the modal check must precede the Esc fullscreen exit");
});

test("standalone sidebar tab registers Unicanvas with a visible icon", () => {
    assert.ok(modesSource.includes("registerSidebarTab({"), "app.extensionManager.registerSidebarTab must be used");
    assert.ok(modesSource.includes("app?.extensionManager?.registerSidebarTab"), "extensionManager must be probed safely");
    assert.ok(/title:\s*"Unicanvas"/.test(modesSource), 'the tab must be labeled exactly "Unicanvas"');
    assert.ok(/tooltip:\s*"Unicanvas"/.test(modesSource), 'the tab tooltip must be "Unicanvas"');
    assert.ok(/icon:\s*UNICANVAS_SIDEBAR_ICON_CLASS/.test(modesSource), "the tab must register an icon");
    assert.ok(modesSource.includes('const UNICANVAS_SIDEBAR_ICON_CLASS = "vnccs-unicanvas-sidebar-icon";'),
        "the icon class must be a stable marker");
    assert.ok(modesSource.includes("data:image/svg+xml"), "the icon is an inline SVG data URI");
    assert.ok(modesSource.includes('background: url("${UNICANVAS_SIDEBAR_ICON_SVG}") center / contain no-repeat'),
        "the icon must render from CSS on the sidebar tab <i>");
    assert.ok(modesSource.includes('type: "custom"'), "the tab renders a custom DOM container");
    assert.ok(/widget\.standalone = true/.test(modesSource), "the tab opens UniCanvasWidget with standalone: true");
    assert.ok(widgetSource.includes("registerUniCanvasStandaloneSidebarTab(UniCanvasWidget)"),
        "vnccs_unicanvas.js must register the sidebar tab");
});

test("standalone state persists to the vnccs-unicanvas-standalone key", () => {
    assert.ok(modesSource.includes('const UNICANVAS_STANDALONE_STORAGE_KEY = "vnccs-unicanvas-standalone";'),
        "localStorage key must be exactly vnccs-unicanvas-standalone");
    assert.ok(modesSource.includes("window.localStorage?.setItem(UNICANVAS_STANDALONE_STORAGE_KEY"),
        "state must be written to that localStorage key");
    assert.ok(modesSource.includes("window.localStorage?.getItem(UNICANVAS_STANDALONE_STORAGE_KEY"),
        "state must be restored from that localStorage key");
});

test("New canvas asks Are you sure? and clears layers and images", () => {
    const newDocument = region(modesSource, "export async function newUniCanvasDocument", "function installUniCanvasOutputActions");
    assert.ok(newDocument.includes('"Are you sure?"'), 'the confirm modal must ask "Are you sure?"');
    assert.ok(newDocument.includes("confirmInWidget("), "the confirmation must use the widget modal");
    assert.ok(newDocument.includes("widget.stagingItems = []"), "staged images must be cleared");
    assert.ok(newDocument.includes("widget.layers = []"), "layers must be cleared");
    assert.ok(newDocument.includes('widget.addLayer("raster", "Base Layer", false)'), "a fresh base layer must be created");
    assert.ok(modesSource.includes('widget._button("New", "vnccs-uc-btn"'), "standalone output actions must include New");
    assert.ok(modesSource.includes('widget._button("Save to output", "vnccs-uc-btn"'), "Save to output must be a widget button");
});

test("Save to output flattens through the shared helper and keeps the layer-menu call shape", () => {
    const composite = region(modesSource, "export function buildUniCanvasCompositeCanvas", "export async function saveUniCanvasOutput");
    assert.ok(composite.includes("widget.drawFlattenedLayers(ctx)"),
        "the composite must reuse the shared flatten draw");
    const sharedDraw = region(widgetSource, "  drawFlattenedLayers(ctx, layers = this.layers) {", "  flattenLayersToMaster() {");
    assert.ok(sharedDraw.includes("layer.hiresCanvas && layer.hiresRect"),
        "the shared draw must keep the hi-res layer branch");
    const flattenCall = region(widgetSource, "  flattenLayersToMaster() {", "  async importFile(");
    assert.ok(flattenCall.includes("this.drawFlattenedLayers(ctx)"),
        "flattenLayersToMaster must use the shared draw");
    assert.ok(!flattenCall.includes("drawImage(layer.canvas"),
        "flattenLayersToMaster must not keep its own compositing loop");

    const save = region(modesSource, "export async function saveUniCanvasOutput", "export async function newUniCanvasDocument");
    assert.ok(save.includes('widget.setStatus("[VNCCS UniCanvas] Saving to output...")'),
        "the status message must carry the [VNCCS UniCanvas] prefix");
    assert.ok(save.includes("layer-context-menu call shape"),
        "the layerId argument must be documented as the layer-menu call shape");
    assert.ok(save.includes("widget.serializeLayer(layer, true)"),
        "a layer save must send only that layer's pixels");
    assert.ok(save.includes('"/vnccs/unicanvas/save_output"'), "Save to output must call the save_output route");
    assert.ok(!modesSource.includes("_vnccsStandalonePersist"),
        "no dead standalone persistence hooks may remain");
});

test("fullscreen and standalone teardown run on disposal and tab destroy", () => {
    const dispose = region(widgetSource, "  dispose() {", "app.registerExtension({");
    assert.ok(dispose.includes("teardownUniCanvasWidgetModes(this)"), "dispose() must tear the modes down");
    const onRemoved = widgetSource.slice(widgetSource.indexOf("const onRemoved = nodeType.prototype.onRemoved;"));
    assert.ok(onRemoved.includes("teardownUniCanvasWidgetModes(this.uniCanvasWidget)"),
        "onRemoved must tear the modes down");

    const exit = region(modesSource, "export function exitUniCanvasFullscreen", "function installUniCanvasFullscreenButton");
    assert.ok(exit.includes("if (!widget._disposed)"), "the exit path must not touch a disposed widget");
    assert.ok(exit.includes("sibling.parentNode === state.restoreParent"),
        "fullscreen restore must guard a stale sibling anchor");

    const destroy = region(modesSource, "    destroy() {", "  });");
    assert.ok(destroy.includes("teardownUniCanvasWidgetModes(widget)"),
        "the tab destroy() must flush/clear the pending persistence timer");
    assert.ok(modesSource.includes("localStateBackupDisabled") && modesSource.includes("4_000_000"),
        "standalone persistence must mirror the local backup degradation");
});

test("standalone mode hides ComfyUI chrome with explicit markers", () => {
    assert.ok(modesSource.includes('const UNICANVAS_STANDALONE_BODY_CLASS = "vnccs-unicanvas-standalone-mode";'),
        "the body class marker must exist");
    assert.ok(modesSource.includes("document.body.classList.add(UNICANVAS_STANDALONE_BODY_CLASS)"),
        "entering the tab must add the chrome-hiding class");
    assert.ok(modesSource.includes("document.body.classList.remove(UNICANVAS_STANDALONE_BODY_CLASS)"),
        "leaving the tab must restore the standard chrome");
    for (const selector of ["#comfyui-body-top", ".comfyui-body-top", "#comfy-menu", "#comfyui-body-bottom"]) {
        assert.ok(modesSource.includes(selector), `chrome-hiding CSS must cover ${selector}`);
    }
    assert.ok(modesSource.includes("vnccs-uc2-standalone-shell"), "the standalone app surface must exist");
    assert.ok(modesSource.includes("side-tool-bar-container"), "the icon sidebar rail must stay visible");
});

test("graph navigation forwarding is suspended during fullscreen", () => {
    assert.ok(widgetSource.includes("root._vnccsUniCanvasGraphNavigationSuspended"),
        "enableUniCanvasGraphNavigationForwarding must honor the suspend flag");
    assert.ok(modesSource.includes("container._vnccsUniCanvasGraphNavigationSuspended = true"),
        "entering fullscreen must suspend graph navigation forwarding");
    assert.ok(modesSource.includes("container._vnccsUniCanvasGraphNavigationSuspended = false"),
        "exiting fullscreen must restore graph navigation forwarding");
});

test("modal keydown stops propagation so Esc cannot exit fullscreen behind a modal", () => {
    const modal = region(widgetSource, "overlay.addEventListener(\"keydown\", (e) =>", "this.container.appendChild(overlay)");
    assert.ok(/e\.key === "Escape"[\s\S]{0,160}?e\.stopPropagation\(\)/.test(modal),
        "Escape in the modal keydown handler must stopPropagation before close");
    assert.ok(/e\.key === "Enter"[\s\S]{0,160}?e\.stopPropagation\(\)/.test(modal),
        "Enter in the modal keydown handler must stopPropagation before close");
});
