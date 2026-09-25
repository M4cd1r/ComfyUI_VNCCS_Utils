/**
 * VNCCS UniCanvas ControlNet layer (issue #45).
 *
 * A control layer (`type: "control"`) holds a control image (depth, canny, lineart, pose ...) that
 * steers generation inside the bbox, the way the Inpaint Mask says where generation happens. It
 * lives in the mask section of the layer list, is never part of the image composite (it is not an
 * image layer, see isImageLayer), and is offered only when the selected family declares a
 * ControlNet (`capabilities.control_net` from /vnccs/unicanvas/assets, mirrored by the frontend
 * registry's `controlNet`).
 *
 *  - State: `layer.control = { type, strength, startPercent, endPercent, enabled, showOverlay }`,
 *    serialized with the layer (additive: old states have no control layers). Setting edits are
 *    `layerProps` history entries on `control`; pixel edits (import, paste, brush) are the usual
 *    `layerPixels` entries.
 *  - Generation: the topmost active control layer (enabled, visible, a type the family accepts)
 *    is cropped to the bbox, scaled to the inference size like the mask, and sent as
 *    `control: { image, type, strength, start_percent, end_percent }`. A model without ControlNet
 *    keeps the layers but marks them inactive and sends nothing.
 *
 * The pure helpers at the top run under Node for tests; installUniCanvasControl binds the panel,
 * the "New ControlNet layer" action, the overlay and the draw hand-off onto the widget.
 */

import { installCustomSelects } from "./vnccs_custom_select.mjs";

export const CONTROL_LAYER_TYPE = "control";
export const CONTROL_OVERLAY_COLOR = "rgba(72, 196, 255, 0.55)";
export const CONTROL_DEFAULT_STRENGTH = 1;

export const isControlLayer = (layer) => layer?.type === CONTROL_LAYER_TYPE;
// Layers listed in the mask section (never grouped, never image content).
export const isMaskSectionLayer = (layer) => layer?.type === "mask" || layer?.type === CONTROL_LAYER_TYPE;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

// Frontend ControlNet declaration: the backend descriptor wins, the registry entry is the fallback
// (before /assets answered). Both normalize to one shape.
export function normalizeControlNetSupport(raw, label = "") {
  if (!raw || typeof raw !== "object") return null;
  const types = (Array.isArray(raw.types) ? raw.types : [])
    .map((item) => (typeof item === "string" ? { key: item, label: item } : item))
    .filter((item) => item && typeof item.key === "string" && item.key)
    .map((item) => ({ key: item.key, label: String(item.label || item.key) }));
  if (!types.length) return null;
  const maxStrength = Math.max(0.01, finite(raw.max_strength ?? raw.maxStrength, 2));
  return {
    label: String(raw.label || label || "ControlNet"),
    family: String(label || ""),
    types,
    defaultStrength: clamp(finite(raw.default_strength ?? raw.defaultStrength, CONTROL_DEFAULT_STRENGTH), 0, maxStrength),
    maxStrength,
    supportsRange: Boolean(raw.supports_range ?? raw.supportsRange),
    combinesWithInpaint: (raw.combines_with_inpaint ?? raw.combinesWithInpaint) !== false,
    promptNote: String(raw.prompt_note || raw.promptNote || ""),
  };
}

export function resolveControlNetSupport(descriptors, generationMode, registryModule = null) {
  const descriptor = descriptors?.get?.(String(generationMode || "").toLowerCase());
  const capabilities = descriptor?.capabilities;
  if (capabilities && "control_net" in capabilities) {
    return normalizeControlNetSupport(capabilities.control_net, capabilities.label || descriptor.key);
  }
  return normalizeControlNetSupport(registryModule?.controlNet, registryModule?.label || "");
}

export function defaultControlState(support = null, type = null) {
  const types = support?.types || [];
  return {
    type: type && types.some((item) => item.key === type) ? type : types[0]?.key || "depth",
    strength: support ? support.defaultStrength : CONTROL_DEFAULT_STRENGTH,
    startPercent: 0,
    endPercent: 1,
    enabled: true,
    showOverlay: true,
  };
}

// Sanitizes saved or edited control state; unknown types are kept (another family may accept them).
export function normalizeControlState(raw) {
  const base = defaultControlState();
  const source = raw && typeof raw === "object" ? raw : {};
  const start = clamp(finite(source.startPercent, base.startPercent), 0, 1);
  return {
    type: typeof source.type === "string" && source.type ? source.type : base.type,
    strength: clamp(finite(source.strength, base.strength), 0, 10),
    startPercent: start,
    endPercent: clamp(finite(source.endPercent, base.endPercent), start, 1),
    enabled: source.enabled !== false,
    showOverlay: source.showOverlay !== false,
  };
}

// Why a control layer will not be sent (empty string: it will be, if it is the topmost active one).
export function controlLayerInactiveReason(layer, support, isVisible = (item) => item?.visible !== false) {
  if (!isControlLayer(layer)) return "Not a ControlNet layer";
  const control = normalizeControlState(layer.control);
  if (!support) return "Inactive: the selected model has no ControlNet";
  if (!support.types.some((item) => item.key === control.type)) {
    return `Inactive: ${support.family || "this model"} does not accept ${control.type} control images`;
  }
  if (!control.enabled) return "Disabled";
  if (!isVisible(layer)) return "Hidden";
  return "";
}

// One control layer per draw: the topmost active one wins. `layers` is the widget order (index 0 is
// the top of the stack).
export function pickControlLayer(layers, support, isVisible = (item) => item?.visible !== false) {
  const active = (layers || []).filter((layer) => isControlLayer(layer) && !controlLayerInactiveReason(layer, support, isVisible));
  return { layer: active[0] || null, count: active.length };
}

// The layer-canvas rectangle under the bbox (the canvas starts at the world origin).
export function controlSourceRect(bbox, origin = { x: 0, y: 0 }) {
  return {
    x: bbox.x - (origin?.x || 0),
    y: bbox.y - (origin?.y || 0),
    width: Math.max(1, Math.round(bbox.width)),
    height: Math.max(1, Math.round(bbox.height)),
  };
}

export function buildControlPayload(layer, image, support = null) {
  const control = normalizeControlState(layer?.control);
  const max = support?.maxStrength ?? 10;
  const payload = { image, type: control.type, strength: clamp(control.strength, 0, max) };
  if (!support || support.supportsRange) {
    payload.start_percent = control.startPercent;
    payload.end_percent = control.endPercent;
  }
  return payload;
}

// What the provenance of a generated layer records about the control that steered it.
export function controlProvenance(layer, payload) {
  return { type: payload.type, strength: payload.strength, layerId: layer?.id || null, layerName: layer?.name || "" };
}

export function controlStatusNote(pick) {
  if (!pick?.layer) return "";
  return pick.count > 1 ? `ControlNet: ${pick.count} active layers, using the topmost "${pick.layer.name}"` : `ControlNet: ${pick.layer.name}`;
}

// ---------------------------------------------------------------------------------------------

const CONTROL_PANEL_CSS = `
.vnccs-uc-control-panel { display:flex; flex-direction:column; gap:6px; margin:6px 0; padding:8px; border:1px solid rgba(72,196,255,.45); border-radius:10px; background:rgba(72,196,255,.06); color:#e8e8f0; font-size:11px; }
.vnccs-uc-control-panel[hidden] { display:none; }
.vnccs-uc-control-head { display:flex; align-items:center; gap:6px; color:#8fdcff; }
.vnccs-uc-control-status { color:#9fe3b0; }
.vnccs-uc-control-status.inactive { color:#ffb86b; }
.vnccs-uc-control-panel .vnccs-uc-control-row { display:grid; grid-template-columns:64px 1fr 36px; align-items:center; gap:6px; }
.vnccs-uc-control-panel .vnccs-uc-control-row select { grid-column:2 / span 2; min-width:0; }
.vnccs-uc-control-panel .vnccs-uc-control-row input[type=range] { width:100%; min-width:0; }
.vnccs-uc-control-value { text-align:right; font-variant-numeric:tabular-nums; }
.vnccs-uc-control-toggles { display:flex; flex-wrap:wrap; gap:10px; }
.vnccs-uc-control-toggle { display:flex; align-items:center; gap:4px; }
.vnccs-uc-control-actions { display:flex; gap:6px; flex-wrap:wrap; }
.vnccs-uc-control-hint { color:#a8a8b8; line-height:1.35; }
.vnccs-uc-layer.vnccs-uc-control-layer { box-shadow: inset 3px 0 0 rgba(72,196,255,.85); }
.vnccs-uc-layer.vnccs-uc-control-layer.inactive { opacity:.6; }
.vnccs-uc-control-add[hidden] { display:none; }
`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatStrength(value) {
  return Number(value).toFixed(2);
}

export function installUniCanvasControl(uc, { modelModule = () => null } = {}) {
  const api = {
    panel: null,
    addButton: null,
    fileInput: null,
    gesture: null,

    support() {
      return resolveControlNetSupport(uc.modelDescriptors, uc.settings?.generation_mode, modelModule(uc.settings?.generation_mode));
    },

    isVisible(layer) {
      return layer?.visible !== false;
    },

    addLayer(type = null) {
      const support = api.support();
      if (!support) {
        uc.setStatus("The selected model has no ControlNet", true);
        return null;
      }
      if (uc.transformDraft) {
        uc.setStatus("Apply or cancel the active transform first", true);
        return null;
      }
      const control = defaultControlState(support, type);
      const label = support.types.find((item) => item.key === control.type)?.label || control.type;
      const layer = uc.addLayer(CONTROL_LAYER_TYPE, `ControlNet ${label}`, true, true);
      layer.control = control;
      uc.renderLayerList();
      uc.requestRender();
      uc.syncLightStateToWidget();
      uc.setStatus("ControlNet layer added: import, paste or paint the control image inside the bbox");
      return layer;
    },

    // Replace the layer pixels with an image fitted into the bbox (one layerPixels entry).
    async importInto(layer, source) {
      if (!isControlLayer(layer)) return;
      const url = typeof source === "string" ? source : URL.createObjectURL(source);
      let img;
      try { img = await uc.loadImage(url); }
      catch (error) { uc.setStatus(`Control image import failed: ${error.message || error}`, true); return; }
      finally { if (typeof source !== "string") URL.revokeObjectURL(url); }
      if (!uc.layers.includes(layer)) return;
      const before = uc.createLayerPixelSnapshot(layer);
      const fit = uc.getImageFitInRect(img, uc.bbox);
      const ctx = uc.configureImageContext(layer.canvas.getContext("2d"));
      ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      ctx.drawImage(img, fit.x - uc.origin.x, fit.y - uc.origin.y, fit.width, fit.height);
      uc.invalidateLayerCaches(layer);
      uc.pushHistoryEntry({ kind: "layerPixels", layerId: layer.id, before, after: uc.createLayerPixelSnapshot(layer) });
      uc.renderLayerList();
      uc.requestRender();
      uc.syncLightStateToWidget();
      uc.setStatus(`Control image imported into ${layer.name}`);
    },

    // Realtime: the value shows while dragging; the gesture commits one layerProps entry.
    beginGesture(layer) {
      if (!api.gesture || api.gesture.layerId !== layer.id) api.gesture = { layerId: layer.id, before: { ...normalizeControlState(layer.control) } };
    },

    setControl(layer, patch, { commit = true } = {}) {
      if (!isControlLayer(layer)) return;
      const previous = normalizeControlState(layer.control);
      const next = normalizeControlState({ ...previous, ...patch });
      if (!commit) {
        api.beginGesture(layer);
        layer.control = next;
        api.syncPanelValues(layer);
        if ("showOverlay" in patch) uc.requestRender();
        return;
      }
      const before = api.gesture?.layerId === layer.id ? api.gesture.before : previous;
      api.gesture = null;
      layer.control = next;
      if (JSON.stringify(before) !== JSON.stringify(next)) {
        uc.pushHistoryEntry({ kind: "layerProps", layerId: layer.id, before: { control: before }, after: { control: { ...next } } });
      }
      api.renderPanel();
      uc.refreshLayerRow?.(layer.id);
      uc.requestRender();
      uc.syncLightStateToWidget();
    },

    drawControlOverlay(ctx, layer) {
      const control = normalizeControlState(layer.control);
      if (!control.showOverlay || uc.hasOpenStagingPanel?.()) return;
      ctx.save();
      // The control image itself (so lines and depth read correctly), dimmed by the layer opacity,
      // with a cyan wash so it is never mistaken for image content.
      ctx.globalAlpha = layer.opacity * 0.85;
      uc.drawRasterLayerVisible(ctx, layer);
      const bounds = uc.getLayerAlphaBounds?.(layer);
      if (bounds) {
        const x = bounds.x + uc.origin.x;
        const y = bounds.y + uc.origin.y;
        ctx.globalAlpha = layer.opacity * 0.2;
        ctx.fillStyle = CONTROL_OVERLAY_COLOR;
        ctx.fillRect(x, y, bounds.width, bounds.height);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = CONTROL_OVERLAY_COLOR;
        ctx.lineWidth = 1.5 / Math.max(0.01, uc.view?.scale || 1);
        ctx.setLineDash([6 / Math.max(0.01, uc.view?.scale || 1), 4 / Math.max(0.01, uc.view?.scale || 1)]);
        ctx.strokeRect(x, y, bounds.width, bounds.height);
      }
      ctx.restore();
    },

    exportImage(layer, inferenceSize) {
      const out = document.createElement("canvas");
      out.width = Math.max(64, Math.round(inferenceSize.width));
      out.height = Math.max(64, Math.round(inferenceSize.height));
      const ctx = uc.getReadbackContext(out);
      const rect = controlSourceRect(uc.bbox, uc.origin);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(layer.canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, out.width, out.height);
      return out.toDataURL("image/png");
    },

    // The draw hand-off: the payload part, the provenance record and the status note, or null.
    collectForDraw(inferenceSize, { masked = false } = {}) {
      const support = api.support();
      const pick = pickControlLayer(uc.layers, support, (layer) => api.isVisible(layer));
      if (!pick.layer) return null;
      if (masked && !support.combinesWithInpaint) {
        return { error: `${support.family || "This model"} cannot combine a ControlNet layer with an inpaint mask` };
      }
      const payload = buildControlPayload(pick.layer, api.exportImage(pick.layer, inferenceSize), support);
      return { payload, layer: pick.layer, provenance: controlProvenance(pick.layer, payload), note: controlStatusNote(pick) };
    },

    refresh() {
      const support = api.support();
      if (api.addButton) {
        api.addButton.hidden = !support;
        api.addButton.title = support ? `New ControlNet layer (${support.types.map((item) => item.label).join(", ")})` : "";
      }
      api.renderPanel();
      uc.layerList?.querySelectorAll?.('[data-layer-type="control"]').forEach((row) => api.decorateRow(row));
    },

    decorateRow(row) {
      const layer = uc.layers.find((item) => item.id === row?.dataset?.layerId);
      if (!isControlLayer(layer)) return;
      row.classList.add("vnccs-uc-control-layer");
      const reason = controlLayerInactiveReason(layer, api.support(), (item) => api.isVisible(item));
      row.classList.toggle("inactive", Boolean(reason));
      const type = row.querySelector(".vnccs-uc-layer-type");
      if (type) type.textContent = `controlnet · ${normalizeControlState(layer.control).type}${reason ? ` · ${reason.replace(/^Inactive: /, "inactive")}` : ""}`;
      row.title = reason || "ControlNet layer: steers the next generation inside the bbox";
    },

    syncPanelValues(layer) {
      const panel = api.panel;
      if (!panel || panel.hidden) return;
      const control = normalizeControlState(layer.control);
      const set = (name, value) => {
        panel.querySelectorAll(`[data-control-field="${name}"]`).forEach((input) => {
          if (input.type === "checkbox") input.checked = Boolean(value);
          else if (document.activeElement !== input || input.type === "range") input.value = String(value);
        });
        const out = panel.querySelector(`[data-control-value="${name}"]`);
        if (out) out.textContent = formatStrength(value);
      };
      set("strength", control.strength);
      set("startPercent", control.startPercent);
      set("endPercent", control.endPercent);
      set("enabled", control.enabled);
      set("showOverlay", control.showOverlay);
      const type = panel.querySelector('[data-control-field="type"]');
      if (type) type.value = control.type;
    },

    renderPanel() {
      const panel = api.panel;
      if (!panel) return;
      const layer = uc.activeLayer;
      if (!isControlLayer(layer)) {
        panel.hidden = true;
        panel.replaceChildren();
        return;
      }
      panel.hidden = false;
      const support = api.support();
      const control = normalizeControlState(layer.control);
      const reason = controlLayerInactiveReason(layer, support, (item) => api.isVisible(item));
      panel.replaceChildren();
      const head = el("div", "vnccs-uc-control-head");
      head.append(el("strong", "", support ? support.label : "ControlNet"));
      const status = el("div", `vnccs-uc-control-status${reason ? " inactive" : ""}`, reason || "Active: sent with the next Generate");
      status.dataset.controlStatus = "";
      panel.append(head, status);

      const typeRow = el("label", "vnccs-uc-control-row");
      typeRow.append(el("span", "", "Type"));
      const select = document.createElement("select");
      select.className = "vnccs-uc-select";
      select.dataset.controlField = "type";
      const options = [...(support?.types || [])];
      if (!options.some((item) => item.key === control.type)) options.push({ key: control.type, label: `${control.type} (not accepted)` });
      for (const item of options) {
        const option = document.createElement("option");
        option.value = item.key;
        option.textContent = item.label;
        select.append(option);
      }
      select.value = control.type;
      select.addEventListener("change", () => api.setControl(layer, { type: select.value }));
      typeRow.append(select);
      panel.append(typeRow);

      const slider = (name, label, min, max, step) => {
        const row = el("label", "vnccs-uc-control-row");
        row.append(el("span", "", label));
        const range = document.createElement("input");
        range.type = "range";
        range.min = String(min);
        range.max = String(max);
        range.step = String(step);
        range.value = String(control[name]);
        range.dataset.controlField = name;
        const value = el("span", "vnccs-uc-control-value", formatStrength(control[name]));
        value.dataset.controlValue = name;
        range.addEventListener("input", () => api.setControl(layer, { [name]: Number(range.value) }, { commit: false }));
        range.addEventListener("change", () => api.setControl(layer, { [name]: Number(range.value) }));
        row.append(range, value);
        panel.append(row);
      };
      slider("strength", "Strength", 0, support?.maxStrength ?? 2, 0.01);
      if (support?.supportsRange) {
        slider("startPercent", "Start", 0, 1, 0.01);
        slider("endPercent", "End", 0, 1, 0.01);
      }

      const toggles = el("div", "vnccs-uc-control-row vnccs-uc-control-toggles");
      for (const [name, label] of [["enabled", "Use for generation"], ["showOverlay", "Show overlay"]]) {
        const wrap = el("label", "vnccs-uc-control-toggle");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = Boolean(control[name]);
        box.dataset.controlField = name;
        box.addEventListener("change", () => api.setControl(layer, { [name]: box.checked }));
        wrap.append(box, el("span", "", label));
        toggles.append(wrap);
      }
      panel.append(toggles);

      const actions = el("div", "vnccs-uc-control-actions");
      const importBtn = el("button", "vnccs-uc-btn", "Import control image");
      importBtn.type = "button";
      importBtn.dataset.controlImport = "";
      importBtn.title = "Fit an image (depth, canny, lineart, pose ...) into the bbox on this layer";
      importBtn.addEventListener("click", () => api.fileInput?.click());
      actions.append(importBtn);
      panel.append(actions);
      const hint = el("div", "vnccs-uc-control-hint",
        "Paint with the brush (white lines on black for canny/lineart, gray for depth) or paste an image. " +
        (support?.promptNote || "The prompt describes the content; the control carries the shape."));
      panel.append(hint);
    },

    onPaste(event) {
      const layer = uc.activeLayer;
      if (!isControlLayer(layer)) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const file = [...(event.clipboardData?.files || [])].find((item) => item.type?.startsWith("image/"));
      if (!file) return;
      event.preventDefault();
      void api.importInto(layer, file);
    },
  };

  if (uc.container?.append) {
    const style = el("style");
    style.dataset.controlStyle = "";
    style.textContent = CONTROL_PANEL_CSS;
    uc.container.append(style);
  }
  api.panel = el("div", "vnccs-uc-control-panel");
  api.panel.dataset.controlPanel = "";
  api.panel.hidden = true;
  api.panel.addEventListener("pointerdown", (e) => e.stopPropagation());
  installCustomSelects(api.panel, { theme: "unicanvas" });
  if (uc.layerSubhead?.after) uc.layerSubhead.after(api.panel);

  api.addButton = el("button", "vnccs-uc-btn vnccs-uc-control-add", "New ControlNet layer");
  api.addButton.type = "button";
  api.addButton.dataset.controlAdd = "";
  api.addButton.hidden = true;
  api.addButton.addEventListener("click", () => api.addLayer());
  uc.layersTopActions?.append?.(api.addButton);

  api.fileInput = document.createElement("input");
  api.fileInput.type = "file";
  api.fileInput.accept = "image/*";
  api.fileInput.hidden = true;
  api.fileInput.dataset.controlFile = "";
  api.fileInput.addEventListener("change", () => {
    const file = api.fileInput.files?.[0];
    api.fileInput.value = "";
    if (file && isControlLayer(uc.activeLayer)) void api.importInto(uc.activeLayer, file);
  });
  uc.container?.append?.(api.fileInput);
  uc.container?.addEventListener?.("paste", (event) => api.onPaste(event));

  uc.controlLayers = api;
  api.refresh();
  return api;
}
