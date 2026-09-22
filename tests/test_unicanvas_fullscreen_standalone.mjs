import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// All regexes avoid literal line breaks so the suite stays CRLF-tolerant on
// Windows checkouts (see tests/test_unicanvas_frontend.mjs for the contrast).
const modesSource = await readFile(new URL("../web/vnccs_unicanvas_modes.mjs", import.meta.url), "utf8");
const widgetSource = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");

test("fullscreen installs window capture-phase keyboard isolation", () => {
    for (const type of ["keydown", "keyup", "keypress"]) {
        const pattern = new RegExp(`window\\.addEventListener\\("${type}",\\s*[^,]+,\\s*true\\)`);
        assert.ok(pattern.test(modesSource), `window ${type} listener must be capture-phase`);
    }

    for (const handler of ["onKeyDown", "onKeyUp", "onKeyPress"]) {
        const body = modesSource.match(new RegExp(`const ${handler} = \\(event\\) => \\{[\\s\\S]*?\\};`));
        assert.ok(body, `${handler} isolation handler not found`);
        assert.ok(body[0].includes("stopImmediatePropagation()"), `${handler} must stop immediate propagation`);
        assert.ok(body[0].includes("preventDefault()"), `${handler} must prevent the default action`);
        assert.ok(body[0].includes("isUniCanvasTextTarget(event)"), `${handler} must spare text fields`);
    }

    assert.ok(modesSource.includes('input, textarea, select, [contenteditable=\'true\']'),
        "text targets are input/textarea/select/[contenteditable]");
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

    assert.ok(/lower === "z"/.test(modesSource), "history shortcut must be Z");
    assert.ok(modesSource.includes("event.ctrlKey || event.metaKey"), "history shortcut must use Ctrl/Cmd");
    assert.ok(modesSource.includes("widget.undo()") && modesSource.includes("widget.redo()"), "undo/redo must be wired");
    assert.ok(modesSource.includes("event.shiftKey"), "Ctrl+Shift+Z must redo");

    assert.ok(modesSource.includes('key === "["') && modesSource.includes('key === "]"'), "brush size keys [ and ]");
    assert.ok(modesSource.includes('key === "Tab"'), "Tab toggles panel visibility");
    assert.ok(modesSource.includes('key === "Escape"'), "Esc exits fullscreen");
    assert.ok(modesSource.includes("enterUniCanvasFullscreen(widget)") && modesSource.includes("exitUniCanvasFullscreen(widget)"),
        "fullscreen enter/exit must be reachable from the shortcut map");
    assert.ok(widgetSource.includes("installUniCanvasWidgetModes(this.uniCanvasWidget)"),
        "vnccs_unicanvas.js must install the modes on every widget");
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
    assert.ok(modesSource.includes('"Are you sure?"'), "the confirm modal must ask \"Are you sure?\"");
    assert.ok(modesSource.includes("confirmInWidget("), "the confirmation must use the widget modal");
    assert.ok(modesSource.includes("widget.stagingItems = []"), "staged images must be cleared");
    assert.ok(modesSource.includes("widget.layers = []"), "layers must be cleared");
    assert.ok(modesSource.includes('widget.addLayer("raster", "Base Layer", false)'), "a fresh base layer must be created");
    assert.ok(modesSource.includes('widget._button("New", "vnccs-uc-btn"'), "standalone output actions must include New");
    assert.ok(modesSource.includes('widget._button("Save to output", "vnccs-uc-btn"'), "Save to output must be a widget button");
    assert.ok(modesSource.includes('"/vnccs/unicanvas/save_output"'), "Save to output must call the save_output route");
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
