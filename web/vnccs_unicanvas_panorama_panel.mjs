// Settings panel of the panorama layer: the orientation sphere plus exact camera, projection
// and navigation-quality controls. The widget only builds it and calls update().
import { installCustomSelects } from "./vnccs_custom_select.mjs";
import { PanoramaOrbitControl } from "./vnccs_unicanvas_panorama_orbit.mjs";
import { PANORAMA_NAVIGATION_QUALITY, PANORAMA_PROJECTIONS, isPanoramaLayer, normalizePanorama } from "./vnccs_unicanvas_panorama.mjs";

// Globe with a view cone: the panorama layer's row button.
export const PANORAMA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.6" ry="8.5"/><path d="M3.5 12h17"/></svg>';

export const PANORAMA_PANEL_CSS = `
.vnccs-uc-panorama-controls { flex:0 0 auto; padding:0 !important; overflow:hidden; }
.vnccs-uc-panorama-orbit { display:block; width:100%; height:144px; touch-action:none; cursor:grab; outline:none; }
.vnccs-uc-panorama-orbit:focus-visible { box-shadow:inset 0 0 0 2px var(--uc-accent); border-radius:12px; }
.vnccs-uc-panorama-settings { padding:0 10px 8px; color:var(--uc-muted); font-size:11px; }
.vnccs-uc-panorama-settings > summary { cursor:pointer; padding:4px 0; color:var(--uc-text); list-style-position:inside; }
.vnccs-uc-panorama-settings.active > summary { color:var(--uc-accent); }
.vnccs-uc-panorama-grid { display:grid; grid-template-columns:34px minmax(0,1fr) 58px; gap:4px 6px; align-items:center; }
.vnccs-uc-panorama-grid input[type=range] { width:100%; min-width:0; accent-color:var(--uc-accent); }
.vnccs-uc-panorama-grid .vnccs-uc-input { width:100%; min-width:0; padding:2px 4px; }
.vnccs-uc-panorama-grid select { grid-column:2 / 4; min-width:0; }
`;

// Camera fields in panel order: [key, label, min, max, step].
const CAMERA_FIELDS = [["yaw", "Yaw", -180, 180, 1], ["pitch", "Pitch", -90, 90, 1], ["roll", "Roll", -180, 180, 1], ["fov", "FOV", 25, 120, 1]];

const round = value => Math.round(value * 10) / 10;

export class PanoramaLayerPanel {
  constructor(widget) {
    this.widget = widget;
    this.document = null;
    this.gesture = null;
    this.lastActiveId = null;
    const orbit = document.createElement("canvas");
    orbit.className = "vnccs-uc-panorama-orbit";
    this.orbit = new PanoramaOrbitControl(orbit);
    this.element = document.createElement("div");
    this.element.className = "vnccs-uc-side-control vnccs-uc-panorama-controls";
    this.element.dataset.panoramaPanel = "";
    this.details = document.createElement("details");
    this.details.className = "vnccs-uc-panorama-settings";
    this.summary = document.createElement("summary");
    this.summary.textContent = "Panorama layer";
    const grid = document.createElement("div");
    grid.className = "vnccs-uc-panorama-grid";
    this.fields = {};
    for (const [key, label, min, max, step] of CAMERA_FIELDS) {
      const name = document.createElement("span");
      name.textContent = label;
      const range = this.input("range", key, min, max, step);
      const number = this.input("number", key, min, max, step);
      number.className = "vnccs-uc-input";
      number.lang = "en-US";
      this.fields[key] = { range, number };
      grid.append(name, range, number);
    }
    this.projection = this.select("projection", "Projection", PANORAMA_PROJECTIONS);
    // Only one projection exists today; the control shows it and gains options when more register.
    this.projection.disabled = PANORAMA_PROJECTIONS.length < 2;
    this.quality = this.select("quality", "Navigation quality", [
      { value: "fast", label: `Fast (${PANORAMA_NAVIGATION_QUALITY.fast}px preview)` },
      { value: "balanced", label: `Balanced (${PANORAMA_NAVIGATION_QUALITY.balanced}px preview)` },
      { value: "sharp", label: `Sharp (${PANORAMA_NAVIGATION_QUALITY.sharp}px preview)` },
    ]);
    for (const [label, select] of [["View", this.projection], ["Nav", this.quality]]) {
      const name = document.createElement("span");
      name.textContent = label;
      grid.append(name, select);
    }
    this.details.append(this.summary, grid);
    this.element.append(orbit, this.details);
    // Same themed selector as the rest of UniCanvas (a select is enhanced only once).
    this.customSelects = installCustomSelects(this.element, { theme: "unicanvas" });
  }

  input(type, key, min, max, step) {
    const input = document.createElement("input");
    Object.assign(input, { type, min: String(min), max: String(max), step: String(step) });
    input.dataset.panoramaSetting = key;
    input.setAttribute("aria-label", `Panorama ${key}`);
    // Visible feedback on every input event; the gesture (view commit, sync) ends on change.
    input.addEventListener("input", () => this.changeCamera(key, input.value));
    input.addEventListener("change", () => this.finishCamera());
    input.addEventListener("blur", () => this.finishCamera());
    input.addEventListener("keydown", event => event.stopPropagation());
    return input;
  }

  select(key, title, options) {
    const select = document.createElement("select");
    select.className = "vnccs-uc-select";
    select.title = title;
    select.dataset.panoramaSetting = key;
    for (const option of options) {
      const item = document.createElement("option");
      item.value = option.value; item.textContent = option.label;
      select.append(item);
    }
    select.addEventListener("change", () => this.changeSetting(key, select.value));
    select.addEventListener("keydown", event => event.stopPropagation());
    return select;
  }

  changeCamera(key, raw) {
    const doc = this.document, value = Number(raw);
    if (!doc || !Number.isFinite(value)) return;
    if (!this.gesture) {
      this.orbit.finish();
      if (!doc.beginCamera()) { this.update(doc); return; }
      this.gesture = { document: doc };
    }
    doc.setCamera({ [key]: value });
  }

  finishCamera() {
    const gesture = this.gesture;
    this.gesture = null;
    if (gesture && gesture.document === this.document) gesture.document.endCamera();
  }

  changeSetting(key, value) {
    const doc = this.document;
    if (!doc) return;
    try {
      doc.flushCamera();
      doc.settings = normalizePanorama({ ...doc.settings, [key]: value });
      if (key === "projection") doc.project();
    } catch (error) {
      this.widget.setStatus(`Panorama setting failed: ${error.message || error}`, true);
    }
    this.update(doc);
    this.widget.requestRender();
    this.widget.syncLightStateToWidget();
    this.widget.scheduleFullSync();
  }

  /** Reflect the document camera (or a pending one while it moves) and the active layer. */
  update(doc, settings = doc?.pendingCamera || doc?.settings) {
    if (doc !== this.document) this.gesture = null;
    this.document = doc || null;
    this.element.hidden = !settings;
    this.orbit.update(doc, settings);
    if (!settings) { this.lastActiveId = null; return; }
    const layer = this.widget.layers?.find(item => item.id === settings.baseLayerId);
    this.summary.textContent = layer ? `Panorama layer: ${layer.name}` : "Panorama layer";
    const active = Boolean(layer) && isPanoramaLayer(layer) && layer.id === this.widget.activeLayerId;
    this.details.classList.toggle("active", active);
    // Like the pose layer, selecting the panorama layer opens its settings; the user may fold them.
    const activeId = active ? layer.id : null;
    if (activeId !== this.lastActiveId) this.details.open = active;
    this.lastActiveId = activeId;
    const focused = globalThis.document?.activeElement;
    for (const [key, { range, number }] of Object.entries(this.fields)) {
      const value = String(round(settings[key]));
      if (range !== focused) range.value = value;
      if (number !== focused) number.value = value;
    }
    this.projection.value = settings.projection;
    this.quality.value = settings.quality || "balanced";
  }

  dispose() {
    this.customSelects.disconnect();
    this.orbit.dispose();
  }
}

export function buildPanoramaLayerPanel(widget) {
  return new PanoramaLayerPanel(widget);
}
