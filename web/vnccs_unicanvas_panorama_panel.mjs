// Panorama view panel: the orientation sphere, exact camera, projection and navigation-quality
// controls, and Reset / Cancel / Save. It is shown only during a panorama view session (#33),
// which the panorama layer's globe button opens. The widget only builds it and calls update().
import { installCustomSelects } from "./vnccs_custom_select.mjs";
import { PanoramaOrbitControl } from "./vnccs_unicanvas_panorama_orbit.mjs";
import { PANORAMA_NAVIGATION_QUALITY, PANORAMA_PROJECTIONS, isPanoramaLayer, normalizePanorama } from "./vnccs_unicanvas_panorama.mjs";
import { PanoramaViewSession } from "./vnccs_unicanvas_panorama_view.mjs";

// Globe with a view cone: the panorama layer's row button.
export const PANORAMA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.6" ry="8.5"/><path d="M3.5 12h17"/></svg>';

export const PANORAMA_PANEL_CSS = `
.vnccs-uc-panorama-controls { flex:0 0 auto; padding:0 !important; overflow:hidden; }
.vnccs-uc-panorama-controls[hidden] { display:none !important; }
.vnccs-uc-panorama-orbit { display:block; width:100%; height:144px; touch-action:none; cursor:grab; outline:none; }
.vnccs-uc-panorama-orbit:focus-visible { box-shadow:inset 0 0 0 2px var(--uc-accent); border-radius:12px; }
.vnccs-uc-panorama-settings { padding:0 10px 8px; color:var(--uc-muted); font-size:11px; }
.vnccs-uc-panorama-settings > summary { cursor:pointer; padding:4px 0; color:var(--uc-text); list-style-position:inside; }
.vnccs-uc-panorama-settings.active > summary { color:var(--uc-accent); }
.vnccs-uc-panorama-grid { display:grid; grid-template-columns:34px minmax(0,1fr) 58px; gap:4px 6px; align-items:center; }
.vnccs-uc-panorama-grid input[type=range] { width:100%; min-width:0; accent-color:var(--uc-accent); }
.vnccs-uc-panorama-grid .vnccs-uc-input { width:100%; min-width:0; padding:2px 4px; }
.vnccs-uc-panorama-grid select { grid-column:2 / 4; min-width:0; }
.vnccs-uc-panorama-actions { display:flex; gap:6px; padding:0 10px 10px; }
.vnccs-uc-panorama-actions .vnccs-uc-btn { flex:1 1 0; min-width:0; }
`;

// Camera fields in panel order: [key, label, min, max, step].
const CAMERA_FIELDS = [["yaw", "Yaw", -180, 180, 1], ["pitch", "Pitch", -90, 90, 1], ["roll", "Roll", -180, 180, 1], ["fov", "FOV", 25, 120, 1]];
// Session actions in panel order: [action, label, title, extra class].
const VIEW_ACTIONS = [
  ["reset", "Reset", "Return to the initial view position", ""],
  ["cancel", "Cancel", "Restore the view from before editing and close", ""],
  ["save", "Save", "Keep this view (one undo step) and close", " primary"],
];

const round = value => Math.round(value * 10) / 10;

export class PanoramaLayerPanel {
  constructor(widget) {
    this.widget = widget;
    this.document = null;
    this.gesture = null;
    this.session = new PanoramaViewSession(widget);
    const orbit = document.createElement("canvas");
    orbit.className = "vnccs-uc-panorama-orbit";
    this.orbit = new PanoramaOrbitControl(orbit);
    this.element = document.createElement("div");
    this.element.className = "vnccs-uc-side-control vnccs-uc-panorama-controls";
    this.element.dataset.panoramaPanel = "";
    this.element.hidden = true;
    this.details = document.createElement("details");
    this.details.className = "vnccs-uc-panorama-settings";
    this.summary = document.createElement("summary");
    this.summary.textContent = "Panorama view";
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
    const actions = document.createElement("div");
    actions.className = "vnccs-uc-panorama-actions";
    this.actions = {};
    for (const [action, label, title, extra] of VIEW_ACTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `vnccs-uc-btn${extra}`;
      button.textContent = label;
      button.title = title;
      button.dataset.panoramaAction = action;
      button.addEventListener("click", () => this[action]());
      this.actions[action] = button;
      actions.append(button);
    }
    this.element.append(orbit, this.details, actions);
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

  /** End any slider, field or sphere gesture before a session action. */
  finishGestures() {
    if (this.orbit.gesture) this.orbit.finish();
    this.finishCamera();
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

  /** The globe button: open the view session of the current panorama. */
  enter() {
    const doc = this.document;
    if (!doc || !this.session.enter(doc)) return false;
    this.details.open = true;
    this.update(doc);
    this.widget.setStatus("Panorama view: drag the canvas or the sphere, then Save or Cancel.");
    return true;
  }

  reset() {
    if (!this.session.active) return false;
    this.finishGestures();
    const moved = this.session.reset();
    this.update(this.document);
    return moved;
  }

  save() {
    if (!this.session.active) return null;
    this.finishGestures();
    const entry = this.session.save();
    this.update(this.document);
    this.widget.setStatus(entry ? "Panorama view saved." : "Panorama view unchanged.");
    return entry;
  }

  cancel() {
    if (!this.session.active) return false;
    this.finishGestures();
    const closed = this.session.cancel();
    this.update(this.document);
    if (closed) this.widget.setStatus("Panorama view restored.");
    return closed;
  }

  /** Reflect the document camera (or a pending one while it moves) and the active layer. */
  update(doc, settings = doc?.pendingCamera || doc?.settings) {
    if (doc !== this.document) this.gesture = null;
    this.document = doc || null;
    // A replaced or closed document ends its view session without history.
    if (this.session.active && !this.session.isFor(this.document)) this.session.close();
    this.element.hidden = !settings || !this.session.isFor(this.document);
    this.orbit.update(doc, settings);
    if (!settings) return;
    const layer = this.widget.layers?.find(item => item.id === settings.baseLayerId);
    this.summary.textContent = layer ? `Panorama view: ${layer.name}` : "Panorama view";
    this.details.classList.toggle("active", Boolean(layer) && isPanoramaLayer(layer) && layer.id === this.widget.activeLayerId);
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
    this.session.close();
    this.customSelects.disconnect();
    this.orbit.dispose();
  }
}

export function buildPanoramaLayerPanel(widget) {
  return new PanoramaLayerPanel(widget);
}
