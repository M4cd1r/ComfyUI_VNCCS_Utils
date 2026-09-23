// Qwen-Image-2.1 family and "Spectrum acceleration" panel for VNCCS UniCanvas.
//
// Spectrum acceleration is ported from Comfyui-Spectrum-Qwen2.1
// (https://github.com/awdqwdasdg/Comfyui-Spectrum-Qwen2.1), MIT License,
// Copyright (c) 2026 ComfyUI-Spectrum-QwenImage21 contributors.
import { installCustomSelects } from "./vnccs_custom_select.mjs";

export const QWEN21_MODULE_KEY = "qwen_image21";

export const QWEN21_MODE_ALIASES = [
  "qwen_image21",
  "qwen-image-2.1",
  "qwen_image_21",
  "qwenimage21",
  "qi21",
  "qwen21",
];

// Native 2K aspect-ratio presets from the official Qwen-Image-2.1 table.
export const QWEN21_ASPECT_PRESETS = [
  "2048x2048",
  "2400x1792",
  "1792x2400",
  "2528x1696",
  "1696x2528",
  "2752x1536",
  "1536x2752",
];

// Spectrum parameter presets. "moderate" is the paper default (arXiv 2603.01623:
// W=5, N=2, alpha=0.75, M=4, lambda=0.1, blend 0.5). "aggressive" and "quality"
// follow the vendored upstream README tuning guide: speed raises flex_window to
// 3.0 and drops tail_actual_steps to 1; quality lowers flex_window to 0.4,
// raises tail_actual_steps to 4 and sets blend_weight to 1.0.
export const QWEN21_SPECTRUM_PRESETS = {
  moderate: {
    warmup_steps: 5,
    tail_actual_steps: 2,
    window_size: 2.0,
    flex_window: 0.75,
    max_consecutive_forecasts: 8,
    history_points: 8,
    chebyshev_degree: 4,
    ridge_lambda: 0.1,
    blend_weight: 0.5,
    cache_device: "main_device",
    force_actual_on_control: true,
    debug: false,
  },
  aggressive: {
    warmup_steps: 5,
    tail_actual_steps: 1,
    window_size: 2.0,
    flex_window: 3.0,
    max_consecutive_forecasts: 8,
    history_points: 8,
    chebyshev_degree: 4,
    ridge_lambda: 0.1,
    blend_weight: 0.5,
    cache_device: "main_device",
    force_actual_on_control: true,
    debug: false,
  },
  quality: {
    warmup_steps: 5,
    tail_actual_steps: 4,
    window_size: 2.0,
    flex_window: 0.4,
    max_consecutive_forecasts: 8,
    history_points: 8,
    chebyshev_degree: 4,
    ridge_lambda: 0.1,
    blend_weight: 1.0,
    cache_device: "main_device",
    force_actual_on_control: true,
    debug: false,
  },
};

export const QWEN21_SPECTRUM_PRESET_NAMES = ["moderate", "aggressive", "quality"];

export const QWEN21_SPECTRUM_PARAMS = [
  { name: "warmup_steps", label: "Warmup steps", kind: "int", min: 0, max: 64, step: 1 },
  { name: "tail_actual_steps", label: "Tail actual steps", kind: "int", min: 0, max: 64, step: 1 },
  { name: "window_size", label: "Window size", kind: "float", min: 1.0, max: 16.0, step: 0.25 },
  { name: "flex_window", label: "Flex window", kind: "float", min: 0.0, max: 8.0, step: 0.05 },
  { name: "max_consecutive_forecasts", label: "Max consecutive forecasts", kind: "int", min: 0, max: 32, step: 1 },
  { name: "history_points", label: "History points", kind: "int", min: 2, max: 32, step: 1 },
  { name: "chebyshev_degree", label: "Chebyshev degree", kind: "int", min: 1, max: 12, step: 1 },
  { name: "ridge_lambda", label: "Ridge lambda", kind: "float", min: 0.0, max: 10.0, step: 0.01 },
  { name: "blend_weight", label: "Blend weight", kind: "float", min: 0.0, max: 1.0, step: 0.01 },
  { name: "cache_device", label: "Cache device", kind: "choice", options: ["main_device", "offload_device", "cpu"] },
  { name: "force_actual_on_control", label: "Force actual on control", kind: "bool" },
  { name: "debug", label: "Debug", kind: "bool" },
];

export const UNICANVAS_QWEN21_MODULE = {
  [QWEN21_MODULE_KEY]: {
    key: QWEN21_MODULE_KEY,
    aliases: QWEN21_MODE_ALIASES.slice(1),
    label: "QwenImage21",
    base: QWEN21_MODULE_KEY,
    isEditModel: true,
    detect: ["qwen-image-2.1", "qwen_image_2.1", "qwen-image-21", "qwen_image_21", "qwenimage21", "qi21"],
    aspectPresets: QWEN21_ASPECT_PRESETS,
    defaults: {
      generation_mode: QWEN21_MODULE_KEY,
      model_loader: "diffusion_model",
      diffusion_model_name: "qwen_image_2.1_int8_convrot.safetensors",
      clip_name: "qwen3vl_8b_int8_convrot.safetensors",
      vae_name: "qwen_image_2.1_vae_bf16.safetensors",
      clip_type: "qwen_image",
      sampler_name: "euler",
      scheduler: "simple",
      steps: 40,
      cfg: 1,
      denoise: 1,
      qwen21_opaque_output: false,
      qwen21_aspect_preset: "",
      spectrum: { enabled: false, ...QWEN21_SPECTRUM_PRESETS.moderate },
    },
  },
};

export function isQwen21Mode(mode) {
  return QWEN21_MODE_ALIASES.includes(String(mode || "").toLowerCase());
}

function spectrumSettings(widget) {
  if (!widget || !widget.settings || typeof widget.settings !== "object") return null;
  if (!widget.settings.spectrum || typeof widget.settings.spectrum !== "object") {
    widget.settings.spectrum = { enabled: false, ...QWEN21_SPECTRUM_PRESETS.moderate };
  }
  return widget.settings.spectrum;
}

function clampSpectrumValue(param, raw) {
  const numeric = Number(raw);
  const value = Number.isFinite(numeric) ? numeric : Number(param.min) || 0;
  const clamped = Math.min(param.max, Math.max(param.min, value));
  return param.kind === "int" ? Math.round(clamped) : clamped;
}

// Cross-field constraint mirrored from SpectrumConfig.validate(): the
// Chebyshev fit needs at least chebyshev_degree + 1 history points. The
// untouched side of the edited pair absorbs the clamp so no selectable
// combination is invalid (defense in depth next to the backend validation).
export function clampSpectrumPair(spectrum, editedName) {
  const degreeParam = paramByName("chebyshev_degree");
  const historyParam = paramByName("history_points");
  let degree = clampSpectrumValue(degreeParam, spectrum.chebyshev_degree);
  let history = clampSpectrumValue(historyParam, spectrum.history_points);
  if (history < degree + 1) {
    if (editedName === "chebyshev_degree") history = degree + 1;
    else degree = history - 1;
  }
  spectrum.chebyshev_degree = degree;
  spectrum.history_points = history;
  return spectrum;
}

const QWEN21_HELP_TEXTS = {
  qwen21: "Qwen-Image-2.1 (QI2.1) generates with the official stack: 7B DiT + Qwen3-VL 8B text encoder + 64-channel RGBA image VAE. RGBA output is transparent by default.",
  opaque: "Disables the transparent-RGBA prompting and flattens the result - use it only when you want a plain opaque image.",
  aspect: "Forces one of the official 2K aspect presets; auto (match canvas) keeps the current canvas aspect ratio.",
  spectrum: "Training-free sampling acceleration (Spectrum, arXiv 2603.01623): selected steps are forecast with a Chebyshev fit instead of running the 32-block transformer. Fail-closed: any unsafe forecast degrades to a real forward.",
  preset: "Tunes the acceleration parameters: moderate (paper default), aggressive (more speedup), quality (safer forecasts).",
  turbo: "Runs the Viggle 4-step DMD turbo LoRA (huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo) over the base transformer and switches Steps to 4 / CFG to 1 (the distillation runs without classifier-free guidance). The LoRA downloads into models/loras/viggle/ on first use.",
};

// Viggle turbo (4-step) constants + profile swap, mirroring the other turbo switches.
export const QWEN21_TURBO_LORA_NAME = "viggle/Qwen-Image-2.1-viggle-turbo-4step-lora-r64.safetensors";
export const QWEN21_TURBO_SETTINGS = { steps: 4, cfg: 1 };
export const QWEN21_TURBO_STATUS_ROUTE = "/vnccs/unicanvas/qwen21_turbo";

export function applyQwen21TurboProfile(widget, enabled) {
  const settings = widget && widget.settings;
  if (!settings) return;
  if (enabled) {
    if (!settings.qwen21_turbo_previous_settings) {
      settings.qwen21_turbo_previous_settings = {
        steps: settings.steps,
        cfg: settings.cfg,
        sampler_name: settings.sampler_name,
        scheduler: settings.scheduler,
      };
    }
    settings.qwen21_turbo_enabled = true;
    settings.qwen_lora_name = QWEN21_TURBO_LORA_NAME;
    settings.qwen_lora_strength = 1;
    settings.steps = QWEN21_TURBO_SETTINGS.steps;
    settings.cfg = QWEN21_TURBO_SETTINGS.cfg;
    return;
  }
  settings.qwen21_turbo_enabled = false;
  settings.qwen_lora_name = "";
  settings.qwen_lora_strength = 0;
  const previous = settings.qwen21_turbo_previous_settings;
  if (previous && typeof previous === "object") {
    if (Number.isFinite(Number(previous.steps))) settings.steps = Number(previous.steps);
    if (Number.isFinite(Number(previous.cfg))) settings.cfg = Number(previous.cfg);
    if (previous.sampler_name) settings.sampler_name = previous.sampler_name;
    if (previous.scheduler) settings.scheduler = previous.scheduler;
  }
  settings.qwen21_turbo_previous_settings = null;
}

export function requestQwen21TurboDownload() {
  return fetch(QWEN21_TURBO_STATUS_ROUTE, { method: "POST" })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))))
    .catch(() => null);
}

async function refreshQwen21TurboStatus(panel) {
  const statusEl = panel.querySelector("[data-qwen21-turbo-status]");
  if (!statusEl) return;
  try {
    const res = await fetch(QWEN21_TURBO_STATUS_ROUTE + "?t=" + Date.now());
    if (!res.ok) return;
    const data = await res.json();
    if (data.status === "success") statusEl.textContent = "LoRA installed";
    else statusEl.textContent = data.message || data.status || "";
  } catch {
    statusEl.textContent = "";
  }
}

const QWEN21_PANEL_STYLE_ID = "vnccs-uc-qwen21-styles";

// UniCanvas palette tokens (var(--uc-*) are defined on the widget root).
function ensureQwen21PanelStyles(doc = document) {
  if (!doc?.head || doc.getElementById(QWEN21_PANEL_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = QWEN21_PANEL_STYLE_ID;
  style.textContent = `
.vnccs-uc-qwen21-panel { display:grid; gap:6px; padding:8px; background:var(--uc-panel, rgba(20,16,30,.82)); border:1px solid rgba(255,143,163,.2); border-radius:8px; color:var(--uc-text, #e8e8f0); font:11px var(--uc-font, sans-serif); }
.vnccs-uc-qwen21-title { display:flex; align-items:center; gap:6px; color:var(--uc-accent, #ff8fa3); font-weight:800; font-size:12px; letter-spacing:.02em; }
.vnccs-uc-qwen21-panel .vnccs-uc-field { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.vnccs-uc-qwen21-panel input[type="checkbox"] { accent-color:var(--uc-accent, #ff8fa3); }
.vnccs-uc-spectrum-panel { display:grid; gap:6px; border-top:1px solid var(--uc-border, rgba(255,255,255,.08)); padding-top:6px; }
.vnccs-uc-spectrum-title { display:flex; align-items:center; gap:6px; color:var(--uc-accent-2, #b8a9e8); font-weight:700; font-size:11px; }
.vnccs-uc-spectrum-param { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.vnccs-uc-spectrum-label { flex:1 1 96px; min-width:0; color:var(--uc-muted, #9898a8); font-size:10px; line-height:1.1; }
.vnccs-uc-spectrum-param .vnccs-uc-range { flex:1 1 80px; accent-color:var(--uc-accent, #ff8fa3); }
.vnccs-uc-spectrum-param .vnccs-uc-input { width:54px; }
.vnccs-uc-help { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; flex:0 0 auto; border-radius:50%; border:1px solid var(--uc-border, rgba(255,255,255,.14)); color:var(--uc-muted, #9898a8); font-size:10px; cursor:help; position:relative; }
.vnccs-uc-help:hover::after { content: attr(data-tip); position:absolute; bottom:130%; left:50%; transform:translateX(-50%); width:230px; padding:6px 8px; border-radius:8px; background:#0a0a0f; border:1px solid var(--uc-border, rgba(255,255,255,.14)); color:var(--uc-text, #e8e8f0); font-size:11px; line-height:1.4; z-index:30; text-transform:none; letter-spacing:normal; }
`;
  doc.head.appendChild(style);
}

// Help "?" icon with a hover tooltip explaining what a control is for.
function buildQwen21Help(key) {
  const help = document.createElement("span");
  help.className = "vnccs-uc-help";
  help.textContent = "?";
  help.dataset.tip = QWEN21_HELP_TEXTS[key] || "";
  help.title = QWEN21_HELP_TEXTS[key] || "";
  return help;
}

function buildPanelShell() {
  ensureQwen21PanelStyles();
  const panel = document.createElement("div");
  panel.className = "vnccs-uc-qwen21-panel";
  panel.dataset.qwen21Panel = "";
  panel.style.display = "none";

  const title = document.createElement("div");
  title.className = "vnccs-uc-qwen21-title";
  title.textContent = "Qwen-Image-2.1 ";
  title.appendChild(buildQwen21Help("qwen21"));
  panel.appendChild(title);

  const opaqueLabel = document.createElement("label");
  opaqueLabel.className = "vnccs-uc-field";
  opaqueLabel.textContent = "opaque output ";
  opaqueLabel.appendChild(buildQwen21Help("opaque"));
  const opaqueInput = document.createElement("input");
  opaqueInput.type = "checkbox";
  opaqueInput.dataset.qwen21Setting = "qwen21_opaque_output";
  opaqueLabel.appendChild(opaqueInput);
  panel.appendChild(opaqueLabel);

  const aspectLabel = document.createElement("label");
  aspectLabel.className = "vnccs-uc-field";
  aspectLabel.textContent = "2K aspect preset ";
  aspectLabel.appendChild(buildQwen21Help("aspect"));
  const aspectSelect = document.createElement("select");
  aspectSelect.className = "vnccs-uc-select";
  aspectSelect.dataset.qwen21Setting = "qwen21_aspect_preset";
  const autoOption = document.createElement("option");
  autoOption.value = "";
  autoOption.textContent = "auto (match canvas)";
  aspectSelect.appendChild(autoOption);
  for (const preset of QWEN21_ASPECT_PRESETS) {
    const option = document.createElement("option");
    option.value = preset;
    option.textContent = preset;
    aspectSelect.appendChild(option);
  }
  aspectLabel.appendChild(aspectSelect);
  panel.appendChild(aspectLabel);

  const turboRow = document.createElement("div");
  turboRow.className = "vnccs-uc-spectrum-param";
  turboRow.dataset.qwen21TurboRow = "";
  const turboLabel = document.createElement("span");
  turboLabel.className = "vnccs-uc-spectrum-label";
  turboLabel.textContent = "Viggle turbo (4-step) ";
  turboLabel.appendChild(buildQwen21Help("turbo"));
  const turboToggle = document.createElement("input");
  turboToggle.type = "checkbox";
  turboToggle.dataset.qwen21TurboToggle = "";
  turboToggle.title = "Enable the Viggle 4-step turbo LoRA";
  const turboDownload = document.createElement("button");
  turboDownload.type = "button";
  turboDownload.className = "vnccs-uc-btn";
  turboDownload.dataset.qwen21TurboDownload = "";
  turboDownload.textContent = "Download LoRA";
  turboDownload.title = "Download the Viggle turbo LoRA into models/loras/viggle/";
  const turboStatus = document.createElement("span");
  turboStatus.className = "vnccs-uc-spectrum-label";
  turboStatus.dataset.qwen21TurboStatus = "";
  turboRow.append(turboLabel, turboToggle, turboDownload, turboStatus);
  panel.appendChild(turboRow);

  const spectrum = document.createElement("div");
  spectrum.className = "vnccs-uc-spectrum-panel";
  spectrum.dataset.spectrumPanel = "";

  const spectrumTitle = document.createElement("div");
  spectrumTitle.className = "vnccs-uc-spectrum-title";
  spectrumTitle.textContent = "Spectrum acceleration ";
  spectrumTitle.appendChild(buildQwen21Help("spectrum"));
  spectrum.appendChild(spectrumTitle);

  const enableLabel = document.createElement("label");
  enableLabel.className = "vnccs-uc-field";
  enableLabel.textContent = "Enable Spectrum ";
  const enableInput = document.createElement("input");
  enableInput.type = "checkbox";
  enableInput.dataset.spectrumToggle = "";
  enableLabel.appendChild(enableInput);
  spectrum.appendChild(enableLabel);

  const presetLabel = document.createElement("label");
  presetLabel.className = "vnccs-uc-field";
  presetLabel.textContent = "Preset ";
  presetLabel.appendChild(buildQwen21Help("preset"));
  const presetSelect = document.createElement("select");
  presetSelect.className = "vnccs-uc-select";
  presetSelect.dataset.spectrumPreset = "";
  for (const name of QWEN21_SPECTRUM_PRESET_NAMES) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name === "moderate" ? "moderate (paper default)" : name;
    presetSelect.appendChild(option);
  }
  presetLabel.appendChild(presetSelect);
  spectrum.appendChild(presetLabel);

  for (const param of QWEN21_SPECTRUM_PARAMS) {
    const row = document.createElement("div");
    row.className = "vnccs-uc-spectrum-param";
    row.dataset.spectrumParam = param.name;
    const label = document.createElement("span");
    label.className = "vnccs-uc-spectrum-label";
    label.textContent = param.label;
    row.appendChild(label);
    if (param.kind === "bool") {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.spectrumControl = param.name;
      row.appendChild(checkbox);
    } else if (param.kind === "choice") {
      const select = document.createElement("select");
      select.className = "vnccs-uc-select";
      select.dataset.spectrumControl = param.name;
      for (const value of param.options || []) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
      }
      row.appendChild(select);
    } else {
      // Paired slider + exact numeric field. Both update visible state from
      // every "input" event (repository realtime rule); "change" only commits.
      const range = document.createElement("input");
      range.type = "range";
      range.className = "vnccs-uc-range";
      range.min = String(param.min);
      range.max = String(param.max);
      range.step = String(param.step);
      range.dataset.spectrumRange = param.name;
      const number = document.createElement("input");
      number.type = "number";
      number.className = "vnccs-uc-input";
      number.min = String(param.min);
      number.max = String(param.max);
      number.step = String(param.step);
      number.lang = "en-US";
      number.dataset.spectrumNumber = param.name;
      row.append(range, number);
    }
    spectrum.appendChild(row);
  }

  const hint = document.createElement("div");
  hint.className = "vnccs-uc-h3-hint";
  hint.textContent =
    "Training-free sampling acceleration (Spectrum, arXiv 2603.01623): selected steps are forecast " +
    "with a Chebyshev fit instead of running the 32-block transformer. Fail-closed: any unsafe " +
    "forecast degrades to a real forward.";
  spectrum.appendChild(hint);

  panel.appendChild(spectrum);
  return panel;
}

function paramByName(name) {
  return QWEN21_SPECTRUM_PARAMS.find((param) => param.name === name) || null;
}

function commitSettings(widget) {
  if (widget && typeof widget.syncSettingsToWidget === "function") widget.syncSettingsToWidget();
}

function applyControlValue(widget, panel, target) {
  const spectrum = spectrumSettings(widget);
  if (!spectrum) return;
  const rangeName = target.dataset.spectrumRange;
  const numberName = target.dataset.spectrumNumber;
  const controlName = target.dataset.spectrumControl;
  const name = rangeName || numberName || controlName;
  const param = paramByName(name);
  if (!param) return;
  let value;
  if (param.kind === "bool") {
    value = Boolean(target.checked);
  } else if (param.kind === "choice") {
    value = String(target.value || (param.options || [""])[0]);
  } else {
    value = clampSpectrumValue(param, target.value);
  }
  spectrum[name] = value;
  // Cross-field safety: the Chebyshev fit needs history_points >= degree + 1.
  clampSpectrumPair(spectrum, name);
  // Newest value wins: mirror the fresh values into the paired slider/number
  // fields (never into the control being edited) so every field stays
  // synchronized during the whole interaction.
  for (const mirrored of QWEN21_SPECTRUM_PARAMS) {
    if (mirrored.kind !== "int" && mirrored.kind !== "float") continue;
    const row = panel.querySelector(`[data-spectrum-param="${mirrored.name}"]`);
    if (!row) continue;
    const range = row.querySelector("input[type=range]");
    const number = row.querySelector("input[type=number]");
    const mirrorValue = String(spectrum[mirrored.name]);
    if (range && range !== target) range.value = mirrorValue;
    if (number && number !== target) number.value = mirrorValue;
  }
}

function refreshPanel(widget, panel) {
  const spectrum = spectrumSettings(widget);
  if (!spectrum) return;
  const enabled = Boolean(spectrum.enabled);
  const toggle = panel.querySelector("[data-spectrum-toggle]");
  if (toggle) toggle.checked = enabled;
  for (const param of QWEN21_SPECTRUM_PARAMS) {
    const row = panel.querySelector(`[data-spectrum-param="${param.name}"]`);
    if (!row) continue;
    row.classList.toggle("disabled", !enabled);
    const control = row.querySelector(`[data-spectrum-control="${param.name}"]`);
    if (control) {
      control.disabled = !enabled;
      if (param.kind === "bool") control.checked = Boolean(spectrum[param.name]);
      else control.value = String(spectrum[param.name]);
      continue;
    }
    const range = row.querySelector("input[type=range]");
    const number = row.querySelector("input[type=number]");
    const value = String(spectrum[param.name]);
    if (range) {
      range.value = value;
      range.disabled = !enabled;
    }
    if (number) {
      number.value = value;
      number.disabled = !enabled;
    }
  }
  const opaque = panel.querySelector('[data-qwen21-setting="qwen21_opaque_output"]');
  if (opaque) opaque.checked = Boolean(widget.settings.qwen21_opaque_output);
  const aspect = panel.querySelector('[data-qwen21-setting="qwen21_aspect_preset"]');
  if (aspect) aspect.value = String(widget.settings.qwen21_aspect_preset || "");
  const turboToggle = panel.querySelector("[data-qwen21-turbo-toggle]");
  if (turboToggle) turboToggle.checked = Boolean(widget.settings.qwen21_turbo_enabled);
  void refreshQwen21TurboStatus(panel);
}

function bindPanelEvents(widget, panel) {
  // Realtime rule: "input" streams every intermediate value into settings and
  // the visible controls; "change" only commits persistence.
  panel.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target.dataset.spectrumRange !== undefined || target.dataset.spectrumNumber !== undefined || target.dataset.spectrumControl !== undefined) {
      applyControlValue(widget, panel, target);
      return;
    }
    if (target.dataset.qwen21Setting === "qwen21_opaque_output") {
      widget.settings.qwen21_opaque_output = Boolean(target.checked);
    }
  });
  panel.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.qwen21TurboDownload !== undefined) {
      void requestQwen21TurboDownload().then(() => refreshQwen21TurboStatus(panel));
    }
  });
  panel.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target.dataset.qwen21TurboToggle !== undefined) {
      applyQwen21TurboProfile(widget, Boolean(target.checked));
      refreshPanel(widget, panel);
      commitSettings(widget);
      return;
    }
    const spectrum = spectrumSettings(widget);
    if (!spectrum) return;
    if (target.dataset.spectrumToggle !== undefined) {
      spectrum.enabled = Boolean(target.checked);
      refreshPanel(widget, panel);
    } else if (target.dataset.spectrumPreset !== undefined) {
      const preset = QWEN21_SPECTRUM_PRESETS[target.value] || QWEN21_SPECTRUM_PRESETS.moderate;
      widget.settings.spectrum = { ...spectrum, ...preset };
      clampSpectrumPair(widget.settings.spectrum, null);
      refreshPanel(widget, panel);
    } else if (target.dataset.spectrumRange !== undefined || target.dataset.spectrumNumber !== undefined || target.dataset.spectrumControl !== undefined) {
      applyControlValue(widget, panel, target);
    } else if (target.dataset.qwen21Setting === "qwen21_opaque_output") {
      widget.settings.qwen21_opaque_output = Boolean(target.checked);
    } else if (target.dataset.qwen21Setting === "qwen21_aspect_preset") {
      widget.settings.qwen21_aspect_preset = String(target.value || "");
    }
    commitSettings(widget);
  });
}

export function mountQwen21SpectrumPanel(widget) {
  const host = (widget && (widget.promptBox || widget.container)) || null;
  if (!host || typeof host.querySelector !== "function") return null;
  let panel = host.querySelector("[data-qwen21-panel]");
  if (panel) return panel;
  panel = buildPanelShell();
  const anchor = host.querySelector("[data-h3-panel]");
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  else host.appendChild(panel);
  bindPanelEvents(widget, panel);
  refreshPanel(widget, panel);
  installCustomSelects(panel);
  return panel;
}

export function syncQwen21SpectrumPanel(widget) {
  const panel = mountQwen21SpectrumPanel(widget);
  if (!panel) return null;
  // The Spectrum panel is exposed only for the Qwen-Image-2.1 family.
  const active = isQwen21Mode(widget && widget.settings ? widget.settings.generation_mode : "");
  panel.style.display = active ? "" : "none";
  if (active) refreshPanel(widget, panel);
  return panel;
}
