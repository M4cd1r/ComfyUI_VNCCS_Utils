import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

import * as control from "../web/vnccs_unicanvas_control.mjs";
import * as groups from "../web/vnccs_unicanvas_groups.mjs";
import * as provenance from "../web/vnccs_unicanvas_provenance.mjs";
import { isImageLayer } from "../web/vnccs_unicanvas_pose_state.mjs";

const {
  buildControlPayload, controlLayerInactiveReason, controlSourceRect, defaultControlState, installUniCanvasControl,
  isControlLayer, isMaskSectionLayer, normalizeControlState, pickControlLayer, resolveControlNetSupport,
} = control;

const widgetSource = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const Z_IMAGE = {
  key: "z_image", aliases: ["z-image"],
  capabilities: { label: "Z-image", control_net: {
    label: "Z-Image Fun ControlNet", types: [{ key: "canny", label: "Canny" }, { key: "depth", label: "Depth" }, { key: "pose", label: "Pose" }],
    default_strength: 1, max_strength: 2, supports_range: false, combines_with_inpaint: true, prompt_note: "describe the content",
  } },
};
const SDXL = { key: "sdxl", aliases: [], capabilities: { label: "SDXL", control_net: null } };
const descriptors = new Map([["z_image", Z_IMAGE], ["z-image", Z_IMAGE], ["sdxl", SDXL]]);
const support = resolveControlNetSupport(descriptors, "z_image");
const controlLayer = (id, fields = {}) => ({ id, name: id, type: "control", visible: true, opacity: 1, control: defaultControlState(support, "depth"), ...fields });

// --- minimal DOM for the install path -------------------------------------------------------------

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {}; this.events = {};
    this.classList = { values: new Set(), add: (...names) => names.forEach((n) => this.classList.values.add(n)),
      toggle: (name, on) => (on ? this.classList.values.add(name) : this.classList.values.delete(name)), contains: (n) => this.classList.values.has(n) };
    this.hidden = false; this.textContent = ""; this.value = ""; this.checked = false; this.type = "";
  }
  set className(value) { this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classList.values].join(" "); }
  append(...nodes) { this.children.push(...nodes); }
  after() {}
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
  fire(name, event = {}) { for (const callback of this.events[name] || []) callback(event); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const match = selector.match(/^\[data-([a-z-]+)(?:="([^"]*)")?\]$/);
    const out = [];
    const key = match ? match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()) : null;
    const walk = (node) => {
      for (const child of node.children || []) {
        if (key && child.dataset && key in child.dataset && (match[2] === undefined || child.dataset[key] === match[2])) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  click() { this.fire("click"); }
}
globalThis.document = { createElement: (tag) => new FakeElement(tag), activeElement: null };
globalThis.HTMLInputElement = class {};
globalThis.HTMLTextAreaElement = class {};

function fakeWidget(layers, overrides = {}) {
  const history = [];
  const drawn = [];
  const uc = {
    layers, activeLayer: layers[0] || null, settings: { generation_mode: "z_image" }, modelDescriptors: descriptors,
    bbox: { x: 100, y: 50, width: 512, height: 256 }, origin: { x: -200, y: -100 }, view: { scale: 1 },
    container: new FakeElement(), layerSubhead: new FakeElement(), layersTopActions: new FakeElement(), layerList: null,
    pushHistoryEntry: (entry) => history.push(entry), renderLayerList() {}, requestRender() {}, syncLightStateToWidget() {},
    setStatus: (text) => { uc.status = text; }, refreshLayerRow() {},
    getReadbackContext: () => ({ fillRect() {}, drawImage: (...args) => drawn.push(args), set fillStyle(_) {} }),
    ...overrides,
  };
  globalThis.document.createElement = (tag) => {
    const element = new FakeElement(tag);
    if (tag === "canvas") element.toDataURL = () => `data:image/png;${element.width}x${element.height}`;
    return element;
  };
  const api = installUniCanvasControl(uc, { modelModule: () => null });
  return { uc, api, history, drawn };
}

// --- capability resolution --------------------------------------------------------------------

test("the ControlNet declaration comes from the family descriptor, with the registry as fallback", () => {
  assert.deepEqual(support.types.map((item) => item.key), ["canny", "depth", "pose"]);
  assert.equal(support.maxStrength, 2);
  assert.equal(resolveControlNetSupport(descriptors, "sdxl", { controlNet: { types: ["depth"] } }), null,
    "a descriptor that says no ControlNet wins over the registry");
  const fallback = resolveControlNetSupport(new Map(), "minimax_h3", { label: "MiniMax H3", controlNet: { types: ["depth", "pose"], supportsRange: true } });
  assert.deepEqual(fallback.types.map((item) => item.key), ["depth", "pose"]);
  assert.equal(fallback.supportsRange, true);
  assert.equal(resolveControlNetSupport(new Map(), "anima", { label: "Anima" }), null);
});

test("control layers sit in the mask section and are never image layers", () => {
  assert.equal(isControlLayer({ type: "control" }), true);
  assert.equal(isMaskSectionLayer({ type: "control" }), true);
  assert.equal(isMaskSectionLayer({ type: "mask" }), true);
  assert.equal(isMaskSectionLayer({ type: "raster" }), false);
  assert.equal(isImageLayer({ type: "control" }), false, "the image composite, flatten and PSD export only take image layers");
  const ordered = groups.normalizeGroupedLayerOrder([
    { id: "r", type: "raster" }, { id: "c", type: "control", groupId: "g" }, { id: "m", type: "mask" },
  ]);
  assert.deepEqual(ordered.map((layer) => layer.id), ["c", "m", "r"]);
  assert.equal(ordered[0].groupId, null, "a control layer is never grouped");
});

// --- which layer is sent -------------------------------------------------------------------------

test("the topmost active control layer wins; disabled, hidden and unsupported ones are skipped", () => {
  const disabled = controlLayer("disabled", { control: { ...defaultControlState(support), enabled: false } });
  const hidden = controlLayer("hidden", { visible: false });
  const lineart = controlLayer("lineart", { control: { ...defaultControlState(support), type: "lineart" } });
  const top = controlLayer("top");
  const lower = controlLayer("lower");
  const pick = pickControlLayer([disabled, hidden, lineart, top, { id: "m", type: "mask" }, lower], support);
  assert.equal(pick.layer, top);
  assert.equal(pick.count, 2);
  assert.equal(controlLayerInactiveReason(disabled, support), "Disabled");
  assert.equal(controlLayerInactiveReason(hidden, support), "Hidden");
  assert.match(controlLayerInactiveReason(lineart, support), /does not accept lineart/);
  assert.match(controlStatus(pick), /2 active layers, using the topmost "top"/);
});

function controlStatus(pick) { return control.controlStatusNote(pick); }

test("switching to a model without ControlNet keeps the layers but sends nothing", () => {
  const layer = controlLayer("kept");
  const sdxl = resolveControlNetSupport(descriptors, "sdxl");
  assert.equal(pickControlLayer([layer], sdxl).layer, null);
  assert.match(controlLayerInactiveReason(layer, sdxl), /has no ControlNet/);
  assert.equal(layer.type, "control");
});

test("the payload carries type and strength, and the range only when the node takes one", () => {
  const layer = controlLayer("c", { control: { ...defaultControlState(support), type: "canny", strength: 0.7, startPercent: 0.1, endPercent: 0.9 } });
  assert.deepEqual(buildControlPayload(layer, "data:x", support), { image: "data:x", type: "canny", strength: 0.7 });
  assert.deepEqual(buildControlPayload(layer, "data:x", { ...support, supportsRange: true }),
    { image: "data:x", type: "canny", strength: 0.7, start_percent: 0.1, end_percent: 0.9 });
  assert.equal(buildControlPayload({ ...layer, control: { ...layer.control, strength: 9 } }, "d", support).strength, 2, "clamped to the family maximum");
});

test("control state is sanitized for saves and old or broken values", () => {
  assert.deepEqual(normalizeControlState(undefined), { type: "depth", strength: 1, startPercent: 0, endPercent: 1, enabled: true, showOverlay: true });
  assert.deepEqual(normalizeControlState({ type: "pose", strength: "0.5", startPercent: 0.8, endPercent: 0.2, enabled: false, showOverlay: false }),
    { type: "pose", strength: 0.5, startPercent: 0.8, endPercent: 0.8, enabled: false, showOverlay: false });
});

// --- widget hand-off ------------------------------------------------------------------------------

test("a draw sends the control image cropped to the bbox and scaled to the inference size", () => {
  const layer = controlLayer("c", { canvas: { id: "control-canvas" }, control: { ...defaultControlState(support), type: "pose", strength: 0.8 } });
  const { api, drawn } = fakeWidget([layer, { id: "m", type: "mask", visible: true }]);
  const result = api.collectForDraw({ width: 1024, height: 512 });
  assert.equal(result.payload.type, "pose");
  assert.equal(result.payload.strength, 0.8);
  assert.equal(result.payload.image, "data:image/png;1024x512");
  assert.deepEqual(result.provenance, { type: "pose", strength: 0.8, layerId: "c", layerName: "c" });
  const [source, ...rect] = drawn.at(-1);
  assert.equal(source, layer.canvas);
  assert.deepEqual(rect, [300, 150, 512, 256, 0, 0, 1024, 512], "the layer canvas region under the bbox, stretched to the inference size");
  assert.deepEqual(controlSourceRect({ x: 100, y: 50, width: 512, height: 256 }, { x: -200, y: -100 }), { x: 300, y: 150, width: 512, height: 256 });
});

test("a family that cannot combine control with an inpaint mask stops the draw with a reason", () => {
  const noMask = { ...Z_IMAGE, capabilities: { ...Z_IMAGE.capabilities, control_net: { ...Z_IMAGE.capabilities.control_net, combines_with_inpaint: false } } };
  const { api } = fakeWidget([controlLayer("c", { canvas: {} })], { modelDescriptors: new Map([["z_image", noMask]]) });
  assert.match(api.collectForDraw({ width: 64, height: 64 }, { masked: true }).error, /cannot combine/);
  assert.equal(api.collectForDraw({ width: 64, height: 64 }, { masked: false }).payload.type, "depth");
});

test("the add button follows the model: shown for a ControlNet family, hidden for another", () => {
  const { uc, api } = fakeWidget([]);
  assert.equal(api.addButton.hidden, false);
  uc.settings.generation_mode = "sdxl";
  api.refresh();
  assert.equal(api.addButton.hidden, true);
  assert.equal(api.addLayer(), null);
  assert.match(uc.status, /no ControlNet/);
});

test("the strength slider shows the value while dragging and commits one history entry per gesture", () => {
  const layer = controlLayer("c");
  const { api, history } = fakeWidget([layer]);
  api.renderPanel();
  const range = api.panel.querySelector('[data-control-field="strength"]');
  const value = api.panel.querySelector('[data-control-value="strength"]');
  assert.ok(range && value, "the panel has a strength slider");
  for (const step of ["0.9", "0.6", "0.4"]) {
    range.value = step;
    range.fire("input");
    assert.equal(layer.control.strength, Number(step), "the layer follows the slider while dragging");
    assert.equal(value.textContent, Number(step).toFixed(2), "the number shows while dragging");
  }
  assert.equal(history.length, 0, "no history while dragging");
  range.fire("change");
  assert.equal(history.length, 1);
  assert.equal(history[0].kind, "layerProps");
  assert.equal(history[0].before.control.strength, 1);
  assert.equal(history[0].after.control.strength, 0.4);
});

test("the panel lists only the family's control types and marks a foreign type", () => {
  const layer = controlLayer("c", { control: { ...defaultControlState(support), type: "mlsd" } });
  const { api } = fakeWidget([layer]);
  api.renderPanel();
  const select = api.panel.querySelector('[data-control-field="type"]');
  assert.deepEqual(select.children.map((option) => option.value), ["canny", "depth", "pose", "mlsd"]);
  assert.match(select.children.at(-1).textContent, /not accepted/);
  assert.match(api.panel.querySelector("[data-control-status]").textContent, /does not accept mlsd/);
});

// --- widget source contracts ---------------------------------------------------------------------

const method = (signature) => {
  const start = widgetSource.indexOf(`  ${signature}`);
  assert.ok(start >= 0, signature);
  const end = widgetSource.indexOf("\n  }\n", start);
  return widgetSource.slice(start, end);
};

test("the widget sends control only from the main draw and never composites it", () => {
  assert.match(method("_buildDrawPayload("), /if \(control && !poseRequest\) payload\.control = control;/);
  assert.match(method("async draw() {"), /this\.controlLayers\?\.collectForDraw\(inferenceSize/);
  assert.match(method("async draw() {"), /snapshot\.control = control\.provenance/);
  assert.match(method("makeExportCanvas("), /if \(type === "image" && !isImageLayer\(layer\)\) return;/);
  assert.match(method("makeExportCanvas("), /if \(type === "mask" && layer\.type !== "mask"\) return;/);
  assert.match(method("render() {"), /isControlLayer\(layer\)[\s\S]{0,80}drawControlOverlay/);
});

test("control layers are saved, restored, duplicated and undone like other layers", () => {
  assert.match(method("serializeLayer("), /if \(isControlLayer\(layer\)\) payload\.control = normalizeControlState\(layer\.control\);/);
  assert.match(method("async applySerializedState("), /isControlLayer\(item\) && !restoredPanorama \? "control"/);
  assert.match(method("async applySerializedState("), /layer\.control = normalizeControlState\(item\.control\)/);
  assert.match(method("duplicateActiveLayer() {"), /control: normalizeControlState\(layer\.control\)/);
  // Settings edits are layerProps entries: Object.assign restores `control` on undo and redo.
  assert.match(method("applyHistoryEntry("), /entry\.kind === "layerProps"[\s\S]{0,200}Object\.assign\(layer, direction === "undo" \? entry\.before : entry\.after\)/);
});

test("provenance records the control that steered a generated layer", () => {
  const snapshot = { ...provenance.buildStagingSnapshot({ positive: "a room at night" }, { mode: "img2img" }), control: { type: "depth", strength: 0.8, layerName: "ControlNet Depth" } };
  const meta = provenance.metaFromStagingSnapshot(snapshot);
  assert.deepEqual(meta.control, { type: "depth", strength: 0.8, layerName: "ControlNet Depth" });
  assert.match(provenance.formatProvenanceTooltip(meta), /ControlNet: depth 0\.8/);
  assert.equal(provenance.normalizeLayerMeta({ origin: "paint" }).control, undefined);
});

test("the queued graph path forwards control with the composition", () => {
  const node = readFileSync(new URL("../nodes/unicanvas/node.py", import.meta.url), "utf8");
  assert.match(node, /_QUEUED_DRAW_COMPOSITION_KEYS = \([\s\S]*"control",[\s\S]*\)/);
});

// Keep vm referenced for parity with the other widget suites (they evaluate the class body).
test("the widget class body still evaluates with the control helpers in scope", () => {
  const context = { ...control, ...groups, ...provenance, isImageLayer, document: globalThis.document, window: {} };
  const prototype = vm.runInNewContext(widgetSource.slice(widgetSource.indexOf("class UniCanvasWidget {"), widgetSource.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype", context);
  assert.equal(typeof prototype._buildDrawPayload, "function");
  const payload = prototype._buildDrawPayload.call({}, {
    mode: "img2img", imageCanvas: { toDataURL: () => "img" }, maskCanvas: { toDataURL: () => "mask" },
    bbox: { x: 0, y: 0, width: 64, height: 64 }, inferenceSize: { width: 64, height: 64 }, outputSize: { width: 64, height: 64 },
    control: { image: "ctl", type: "depth", strength: 1 },
  });
  assert.deepEqual(payload.control, { image: "ctl", type: "depth", strength: 1 });
  const posePayload = prototype._buildDrawPayload.call({}, {
    mode: "img2img", imageCanvas: null, maskCanvas: null, bbox: {}, inferenceSize: {}, outputSize: {},
    poseRequest: { pose_edit: {} }, control: { image: "ctl", type: "depth", strength: 1 },
  });
  assert.equal(posePayload.control, undefined, "pose edits never carry a control image");
});
