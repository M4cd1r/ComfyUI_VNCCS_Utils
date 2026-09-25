// The panorama layer type (#28): v3 -> v4 state migration and the layer's settings panel.
import test from "node:test";
import assert from "node:assert/strict";
import {
  migratePanoramaState, normalizePanorama, panoramaLayerSettings, panoramaSettingsFromState, stateHasPanorama,
  isPanoramaLayer, PANORAMA_STATE_VERSION,
} from "../web/vnccs_unicanvas_panorama.mjs";
import { isImageLayer } from "../web/vnccs_unicanvas_pose_state.mjs";

const v3State = () => ({
  version: 3,
  storage: "server_cache", state_id: "cache",
  panorama: { projection: "equirectangular", width: 4096, height: 2048, baseLayerId: "base", contentRevision: 7, yaw: 45, pitch: -10, roll: 5, fov: 70 },
  bbox: { x: 0, y: 0, width: 1024, height: 1024 },
  layers: [
    { id: "edit", type: "raster", groupId: "g", dataURL: "EDIT", crop: { x: 0, y: 0, width: 4096, height: 2048 } },
    { id: "base", type: "raster", name: "Sky", locked: true, dataURL: "BASE", crop: { x: 0, y: 0, width: 4096, height: 2048 } },
  ],
});

test("a version 3 workflow migrates to a panorama layer without losing pixels or camera", () => {
  const original = v3State();
  const migrated = migratePanoramaState(original);
  assert.equal(migrated.version, PANORAMA_STATE_VERSION);
  assert.equal("panorama" in migrated, false);
  const base = migrated.layers.find(layer => layer.id === "base");
  assert.equal(base.type, "panorama"); assert.equal(isPanoramaLayer(base), true); assert.equal(isImageLayer(base), true);
  assert.equal(base.dataURL, "BASE"); assert.equal(base.name, "Sky"); assert.equal(base.locked, true);
  assert.deepEqual(base.crop, { x: 0, y: 0, width: 4096, height: 2048 });
  assert.deepEqual(base.panorama, { projection: "equirectangular", width: 4096, height: 2048, contentRevision: 7,
    yaw: 45, pitch: -10, roll: 5, fov: 70, quality: "balanced" });
  assert.deepEqual(migrated.layers[0], original.layers[0], "other layers keep their pixels and grouping");
  assert.deepEqual(panoramaSettingsFromState(migrated), normalizePanorama(original.panorama));
  assert.equal(original.version, 3, "the input state is not mutated");
  assert.equal(original.layers[1].type, "raster");
  assert.deepEqual(migratePanoramaState(migrated), migrated, "migration is idempotent");
});

test("flat states pass through and an incomplete version 3 panorama is rejected", () => {
  const flat = { version: 2, panorama: null, layers: [{ id: "a", type: "raster" }] };
  assert.equal(migratePanoramaState(flat), flat);
  assert.equal(migratePanoramaState(null), null);
  assert.equal(stateHasPanorama(flat), false);
  const broken = v3State(); broken.layers.pop();
  assert.throws(() => migratePanoramaState(broken), /base layer is missing/);
  assert.equal(stateHasPanorama(v3State()), true);
  assert.equal(stateHasPanorama(migratePanoramaState(v3State())), true);
});

test("a state holding both a panorama layer and a stale document entry keeps the layer settings", () => {
  const state = migratePanoramaState(v3State());
  const mixed = { ...state, panorama: { ...v3State().panorama, yaw: -120 } };
  assert.equal(panoramaSettingsFromState(mixed).yaw, 45);
  const cleaned = migratePanoramaState(mixed);
  assert.equal("panorama" in cleaned, false); assert.equal(cleaned.layers[1].panorama.yaw, 45);
});

test("layer settings exclude the layer id and normalize quality", () => {
  const settings = panoramaLayerSettings({ projection: "equirectangular", width: 8, height: 4, baseLayerId: "x", quality: "bogus", yaw: 400 });
  assert.equal(settings.baseLayerId, undefined); assert.equal(settings.quality, "balanced"); assert.equal(settings.yaw, 40);
  assert.equal(normalizePanorama({ projection: "equirectangular", width: 8, height: 4, quality: "sharp" }).quality, "sharp");
});

// --- settings panel -------------------------------------------------------------------------

class FakeElement {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.style = {};
    this.attributes = {}; this.value = ""; this.hidden = false; this.open = false; this.classes = new Set();
    this.classList = { toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)), add: name => this.classes.add(name) };
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  fire(name, extra = {}) { for (const callback of this.listeners[name] || []) callback({ preventDefault() {}, stopPropagation() {}, ...extra }); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  hasPointerCapture() { return false; }
}

async function panelFixture() {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tag => new FakeElement(tag), activeElement: null };
  const { PanoramaLayerPanel, PANORAMA_PANEL_CSS } = await import("../web/vnccs_unicanvas_panorama_panel.mjs");
  const calls = [];
  const doc = {
    settings: normalizePanorama({ projection: "equirectangular", width: 4096, height: 2048, baseLayerId: "base", yaw: 10, fov: 90 }),
    pendingCamera: null,
    beginCamera() { calls.push("begin"); return true; },
    setCamera(value) { calls.push(["set", value]); this.pendingCamera = normalizePanorama({ ...this.settings, ...value }); widget.updatePanoramaControls(); },
    endCamera() { calls.push("end"); this.settings = this.pendingCamera || this.settings; this.pendingCamera = null; },
    flushCamera() { calls.push("flush"); },
    project() { calls.push("project"); },
  };
  const widget = {
    layers: [{ id: "edit", type: "raster", name: "Paint" }, { id: "base", type: "panorama", name: "Sky" }],
    activeLayerId: "edit", status: null, synced: 0,
    setStatus(message) { this.status = message; }, requestRender() {},
    syncLightStateToWidget() { this.synced++; }, scheduleFullSync() {},
    updatePanoramaControls() { panel.update(doc); },
  };
  const panel = new PanoramaLayerPanel(widget);
  const restore = () => { globalThis.document = previousDocument; };
  return { panel, doc, widget, calls, restore, css: PANORAMA_PANEL_CSS };
}

test("camera sliders show every input event and commit once when the gesture ends", async () => {
  const { panel, doc, calls, restore } = await panelFixture();
  try {
    panel.update(doc);
    const { range, number } = panel.fields.yaw;
    globalThis.document.activeElement = range;
    range.value = "20"; range.fire("input");
    range.value = "35"; range.fire("input");
    assert.deepEqual(calls, ["begin", ["set", { yaw: 20 }], ["set", { yaw: 35 }]], "one gesture, a visible update per input");
    assert.equal(number.value, "35", "the paired numeric field follows the slider during the drag");
    range.fire("change");
    assert.equal(calls.at(-1), "end"); assert.equal(doc.settings.yaw, 35);
    range.fire("blur");
    assert.equal(calls.filter(call => call === "end").length, 1);
    globalThis.document.activeElement = number;
    number.value = "-50"; number.fire("input");
    assert.equal(panel.fields.yaw.range.value, "-50", "typing an exact value moves the slider");
    number.fire("change");
    assert.equal(doc.settings.yaw, -50);
  } finally { restore(); }
});

test("a camera change that cannot start leaves the view and fields unchanged", async () => {
  const { panel, doc, calls, restore } = await panelFixture();
  try {
    panel.update(doc);
    doc.beginCamera = () => { calls.push("refused"); return false; };
    panel.fields.fov.range.value = "40"; panel.fields.fov.range.fire("input");
    assert.deepEqual(calls, ["refused"]);
    assert.equal(panel.fields.fov.range.value, "90");
  } finally { restore(); }
});

test("the panel follows the panorama layer: hidden without one, opened when it becomes active", async () => {
  const { panel, doc, widget, restore } = await panelFixture();
  try {
    panel.update(null);
    assert.equal(panel.element.hidden, true);
    panel.update(doc);
    assert.equal(panel.element.hidden, false);
    assert.equal(panel.details.open, false, "an overlay layer is active");
    assert.match(panel.summary.textContent, /Sky/);
    widget.activeLayerId = "base"; panel.update(doc);
    assert.equal(panel.details.open, true); assert.equal(panel.details.classes.has("active"), true);
    panel.details.open = false; panel.update(doc);
    assert.equal(panel.details.open, false, "a folded panel stays folded while the layer stays active");
    widget.activeLayerId = "edit"; panel.update(doc);
    assert.equal(panel.details.classes.has("active"), false);
  } finally { restore(); }
});

test("navigation quality and projection are layer settings saved with the document", async () => {
  const { panel, doc, widget, calls, restore } = await panelFixture();
  try {
    panel.update(doc);
    assert.equal(panel.quality.value, "balanced");
    assert.equal(panel.projection.value, "equirectangular");
    assert.equal(panel.projection.disabled, true, "only one projection is available");
    panel.quality.value = "sharp"; panel.quality.fire("change");
    assert.equal(doc.settings.quality, "sharp"); assert.equal(widget.synced, 1);
    assert.deepEqual(calls, ["flush"]);
    assert.equal(panoramaLayerSettings(doc.settings).quality, "sharp");
  } finally { restore(); }
});

test("the panel is hooked from the widget, which owns no panorama panel markup", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
  const build = source.slice(source.indexOf("  buildPanoramaControls()"), source.indexOf("  updatePanoramaControls("));
  assert.match(build, /buildPanoramaLayerPanel\(this\)/);
  assert.doesNotMatch(build, /createElement/);
  assert.match(source, /\$\{PANORAMA_PANEL_CSS\}/);
});
