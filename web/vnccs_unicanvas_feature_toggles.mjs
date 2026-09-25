/**
 * VNCCS UniCanvas - feature toggles (issue #50).
 *
 * One registry of on/off switches for model families, loaders, layer types, tools, features and
 * the helper models they download. The ComfyUI settings (Settings > VNCCS > UniCanvas) are
 * generated from it, so a new family or tool is one registry line. ComfyUI stores the values per
 * user on the server, so they are the same in every browser and in the PWA (no localStorage).
 *
 * "Off" hides, it never deletes: the entry's selectors are hidden by one generated stylesheet
 * (every open widget, node and standalone alike, live), its tools / layer-menu items / shortcuts
 * are refused, and the modules that could download something ask `isUniCanvasEnabled` first.
 * Existing layers and saved settings are never touched.
 *
 * The module has no import-time side effects and does not import the ComfyUI app, so it runs in
 * `node --test`; the extension binds the app with `bindUniCanvasFeatureToggles(app)`.
 */

export const UNICANVAS_TOGGLE_SETTING_PREFIX = "VNCCS.UniCanvas";
const STYLE_ID = "vnccs-unicanvas-feature-toggles";

export const UNICANVAS_TOGGLE_GROUPS = Object.freeze([
  { id: "ModelFamilies", label: "Model families", atLeastOne: true },
  { id: "ModelLoaders", label: "Model loaders", atLeastOne: true },
  { id: "LayerTypes", label: "Layer types" },
  { id: "Tools", label: "Tools" },
  { id: "Features", label: "Features" },
  { id: "Projects", label: "Projects and history" },
  { id: "BackgroundRemoval", label: "Background removal" },
  { id: "HelperModels", label: "Helper and LLM models" },
]);

const family = (key, label, tooltip, extra = {}) => ({ key: `family_${key}`, group: "ModelFamilies", family: key, label, tooltip, ...extra });
const loader = (key, label, tooltip) => ({ key: `loader_${key}`, group: "ModelLoaders", loader: key, label, tooltip });
const tool = (key, label, tooltip) => ({ key: `tool_${key}`, group: "Tools", tools: [key], label, tooltip });

/**
 * Registry entry: { key, group, label, tooltip, requires?, hide?, tools?, menu?, family?, loader?,
 * removeBgMethod?, autoNameModel?, settingsSections? }. Every entry is on by default.
 * - hide: CSS selectors (inside .vnccs-unicanvas) hidden while the entry is off.
 * - tools: toolbar tools refused (the widget falls back to Move) and hidden.
 * - menu: layer context-menu item ids hidden.
 * - settingsSections: gear-popover sections left out.
 */
export const UNICANVAS_FEATURE_TOGGLES = Object.freeze([
  // Model families (frontend UNICANVAS_MODEL_MODULES + Qwen-Image 2.1).
  family("sdxl", "SDXL / Illustrious", "SDXL and Illustrious checkpoints."),
  family("anima", "Anima", "The Anima family (Qwen3 text encoder, LLLite inpaint)."),
  family("flux_klein", "Flux Klein", "Flux 2 Klein guided edit."),
  family("z_image", "Z-Image", "Z-Image Turbo with the Fun ControlNet."),
  family("krea2_edit", "Krea2 Edit", "Krea2 identity edit."),
  family("qwen_image_edit", "Qwen Image Edit", "Qwen Image Edit 2511 region edit."),
  family("qwen_image21", "Qwen-Image 2.1", "Qwen-Image 2.1 reference edit (also the Edit model of Remove background)."),
  family("minimax_h3", "MiniMax H3", "MiniMax H3 region edit."),
  // Model loaders (frontend UNICANVAS_MODEL_LOADERS).
  loader("checkpoint", "Checkpoint", "Load a single checkpoint file (SDXL)."),
  loader("diffusion_model", "Diffusion model", "Load a diffusion model with separate text encoder and VAE."),
  loader("gguf", "GGUF", "Load a quantized GGUF diffusion model."),
  // Layer types (raster is always on).
  { key: "maskLayers", group: "LayerTypes", label: "Inpaint masks", tooltip: "The Add mask button. Existing mask layers stay.",
    hide: ['.vnccs-uc-section-actions [title="Add mask"]'] },
  { key: "poseLayers", group: "LayerTypes", label: "Pose layers", tooltip: "The Add pose layer button. Existing pose layers stay editable.",
    hide: ['.vnccs-uc-section-actions [title="Add pose layer"]'] },
  { key: "groups", group: "LayerTypes", label: "Groups", tooltip: "New group, Group, Ungroup and Ctrl+G. Existing groups stay.",
    hide: ["[data-group-action]"] },
  { key: "sprites", group: "LayerTypes", label: "Sprites", tooltip: "Create sprite set. Needs Pose layers. Existing sprite sets stay.",
    requires: ["poseLayers"], menu: ["create-sprite-set"] },
  { key: "controlLayers", group: "LayerTypes", label: "ControlNet layers", tooltip: "New ControlNet layer. Existing ControlNet layers stay.",
    hide: ["[data-control-add]"], menu: ["control-pose-from-layer"] },
  { key: "panoramas", group: "LayerTypes", label: "Panoramas", tooltip: "Importing a 2:1 image no longer offers a 360° panorama. An open panorama stays." },
  // Tools (Move is always on).
  tool("brush", "Brush", "Brush tool (B)."),
  tool("eraser", "Eraser", "Eraser tool (E)."),
  tool("mask", "Mask brush", "Mask brush tool (M)."),
  tool("sam", "SAM object mask", "Point-to-mask tool (downloads SAM models)."),
  tool("rect", "Rectangle", "Rectangle tool (S)."),
  tool("lasso", "Lasso", "Lasso tool (L)."),
  tool("resize", "Resize", "Resize layer tool."),
  tool("bbox", "Generation bbox", "Generation bbox tool."),
  tool("pan", "Pan", "Pan view tool (Space or Alt-drag still pan)."),
  { key: "radialHud", group: "Tools", label: "Radial HUD", tooltip: "Right-button hold on the canvas: size, opacity, hardness and color." },
  // Features.
  { key: "multiCharacter", group: "Features", label: "Multi-character pose scenes", requires: ["poseLayers"],
    tooltip: "More than one mannequin per pose layer, split and merge. Needs Pose layers.",
    hide: [".vnccs-uc-pose-root .vnccs-ps-character-slot.empty"], menu: ["split-characters", "merge-pose-layers"] },
  { key: "interactionPresets", group: "Features", label: "Interaction pose presets", requires: ["multiCharacter"],
    tooltip: "Built-in two-character interaction presets in the pose library. Needs Multi-character pose scenes.",
    hide: ['.vnccs-uc-pose-root .vnccs-ps-library-item[data-pose-repository="vnccs_interaction_presets"]'] },
  { key: "characterBake", group: "Features", label: "Character bake", requires: ["poseLayers"],
    tooltip: "Bake pose characters into images. Needs Pose layers.",
    hide: [".vnccs-uc-bake-row", ".vnccs-uc-bake-slot", "[data-bake-toggle]"], menu: ["bake-characters"], settingsSections: ["character_bake"] },
  { key: "sceneGenerate", group: "Features", label: "Scene Generate", requires: ["characterBake"],
    tooltip: "GENERATE bakes the pose characters first, then the scene. Needs Character bake.",
    hide: [".vnccs-uc-bake-count"] },
  { key: "sceneStates", group: "Features", label: "Scene states", tooltip: "The States panel and Alt+1..9.",
    hide: [".vnccs-uc-states"] },
  { key: "timeline", group: "Features", label: "Timeline and export", requires: ["sceneStates"],
    tooltip: "The timeline dock and video export (standalone only). Needs Scene states.",
    hide: ["[data-timeline-toggle]"] },
  { key: "vnPreview", group: "Features", label: "VN preview", tooltip: "The visual-novel frame overlay (P).",
    hide: [".vnccs-uc-vnp-toggle"] },
  { key: "groundPlane", group: "Features", label: "Ground plane and depth scaling", tools: ["perspective"],
    tooltip: "The Perspective tool (G) and depth-scaled moves.", hide: ["[data-scene-depth-scale]"] },
  { key: "shadowsLight", group: "Features", label: "Shadows and scene light",
    tooltip: "Contact and cast shadows and the scene light. Existing shadow layers stay.",
    menu: ["add-contact-shadow", "add-cast-shadow", "detach-shadow"] },
  { key: "harmonize", group: "Features", label: "Harmonize and foreground occluder",
    tooltip: "Harmonize... and Create foreground occluder.", menu: ["harmonize", "create-occluder"], settingsSections: ["harmonize"],
    hide: [".vnccs-uc-harmonize-panel"] },
  { key: "colorMatch", group: "Features", label: "Color match", tooltip: "Color match to below.", menu: ["color-match"] },
  { key: "psd", group: "Features", label: "PSD import/export", tooltip: "Import PSD and Export Layers as PSD.",
    hide: ["[data-psd-action]"] },
  { key: "promptGuide", group: "Features", label: "Prompt guide", tooltip: "The ? prompt guide next to the prompt.",
    hide: ["[data-prompt-help]", "[data-prompt-guide]"] },
  { key: "controlFromScene", group: "Features", label: "ControlNet from scene", requires: ["controlLayers"],
    tooltip: "Fill a ControlNet layer from the scene (depth, canny, lineart, pose). Needs ControlNet layers.",
    hide: ["[data-control-scene]"], menu: ["control-from-scene", "control-pose-from-layer"] },
  { key: "qwen21Spectrum", group: "Features", label: "Qwen-Image 2.1 Spectrum / turbo", requires: ["family_qwen_image21"],
    tooltip: "The Spectrum and turbo LoRA panel. Needs the Qwen-Image 2.1 family.", hide: [".vnccs-uc-qwen21-panel"] },
  // Projects and history.
  { key: "projects", group: "Projects", label: "Projects and scenes", tooltip: "The project and scene bar. The document is still saved.",
    hide: [".vnccs-uc-project-bar", ".vnccs-uc-project-chip"] },
  { key: "library", group: "Projects", label: "Asset library", tooltip: "The Library tab and Save / Update / Push to library.",
    hide: ['[data-library-tab="library"]'], menu: ["library-save", "library-update", "library-push"], settingsSections: ["library"] },
  { key: "history", group: "Projects", label: "Generation history", requires: ["projects"],
    tooltip: "The History gallery of a project. Needs Projects and scenes.", hide: [".vnccs-uc-history-open"] },
  // Background removal.
  { key: "removeBackground", group: "BackgroundRemoval", label: "Remove background",
    tooltip: "The whole feature: layer menu entries and settings.", menu: ["remove-bg", "remove-bg-prompt"], settingsSections: ["remove_bg"] },
  { key: "removebg_edit", group: "BackgroundRemoval", removeBgMethod: "edit", label: "Edit model", requires: ["removeBackground", "family_qwen_image21"],
    tooltip: "Remove background with the Qwen-Image 2.1 edit model. Needs Remove background and Qwen-Image 2.1." },
  { key: "removebg_birefnet", group: "BackgroundRemoval", removeBgMethod: "birefnet", label: "BiRefNet", requires: ["removeBackground"],
    tooltip: "BiRefNet (downloads on first use). Needs Remove background." },
  { key: "removebg_rembg", group: "BackgroundRemoval", removeBgMethod: "rembg", label: "rembg", requires: ["removeBackground"],
    tooltip: "rembg ONNX (downloads on first use). Needs Remove background." },
  { key: "removebg_sam3", group: "BackgroundRemoval", removeBgMethod: "sam3", label: "SAM 3", requires: ["removeBackground"],
    tooltip: "SAM 3, also the SAM 3 model of the SAM object mask tool (downloads on first use). Needs Remove background." },
  // Helper and LLM models.
  { key: "autoLayerNames", group: "HelperModels", label: "Automatic layer names", tooltip: "Auto-name and the Layer names settings.",
    menu: ["auto-name"] },
  { key: "naming_qwen3vl_2b", group: "HelperModels", autoNameModel: "qwen3vl_2b", label: "Qwen3-VL 2B", requires: ["autoLayerNames"],
    tooltip: "Naming model, ~4 GB download. Needs Automatic layer names." },
  { key: "naming_smolvlm_256m", group: "HelperModels", autoNameModel: "smolvlm_256m", label: "SmolVLM 256M", requires: ["autoLayerNames"],
    tooltip: "Naming model, ~500 MB download. Needs Automatic layer names." },
  { key: "autoFiling", group: "HelperModels", label: "Auto filing", requires: ["groups"],
    tooltip: "Organize and auto-file new layers into folders. Needs Groups.", hide: ["[data-organize-layers]"] },
]);

const ENTRIES = new Map(UNICANVAS_FEATURE_TOGGLES.map((entry) => [entry.key, entry]));
const GROUPS = new Map(UNICANVAS_TOGGLE_GROUPS.map((group) => [group.id, group]));
const byField = (field) => new Map(UNICANVAS_FEATURE_TOGGLES.filter((entry) => entry[field]).map((entry) => [entry[field], entry.key]));
const FAMILY_KEYS = byField("family");
const LOADER_KEYS = byField("loader");
const REMOVE_BG_KEYS = byField("removeBgMethod");
const AUTO_NAME_KEYS = byField("autoNameModel");
const TOOL_KEYS = new Map(UNICANVAS_FEATURE_TOGGLES.flatMap((entry) => (entry.tools || []).map((name) => [name, entry.key])));
const MENU_KEYS = new Map();
for (const entry of UNICANVAS_FEATURE_TOGGLES) {
  for (const id of entry.menu || []) MENU_KEYS.set(id, [...(MENU_KEYS.get(id) || []), entry.key]);
}

const state = { app: null, values: new Map(), listeners: new Set() };

export function uniCanvasToggleSettingId(entry) {
  const item = typeof entry === "string" ? ENTRIES.get(entry) : entry;
  return item ? `${UNICANVAS_TOGGLE_SETTING_PREFIX}.${item.group}.${item.key}` : "";
}

/** The ComfyUI app the stored values are read from (called once by the extension). */
export function bindUniCanvasFeatureToggles(appRef) {
  state.app = appRef || null;
}

function readStored(entry) {
  if (state.values.has(entry.key)) return state.values.get(entry.key);
  const id = uniCanvasToggleSettingId(entry);
  const appRef = state.app;
  let value;
  try {
    const store = appRef?.extensionManager?.setting;
    if (typeof store?.get === "function") value = store.get(id);
    else if (typeof appRef?.ui?.settings?.getSettingValue === "function") value = appRef.ui.settings.getSettingValue(id);
  } catch (_) {
    value = undefined;
  }
  return value !== false;
}

function groupEntries(groupId) {
  return UNICANVAS_FEATURE_TOGGLES.filter((entry) => entry.group === groupId);
}

/** The switch's own value; an "at least one" group never reads as all off. */
export function isUniCanvasToggleOn(key) {
  const entry = ENTRIES.get(key);
  if (!entry) return true;
  if (readStored(entry)) return true;
  if (GROUPS.get(entry.group)?.atLeastOne) return !groupEntries(entry.group).some(readStored);
  return false;
}

/** The first requirement (label) that keeps this entry off, or "" when nothing does. */
export function uniCanvasToggleBlocker(key, seen = new Set()) {
  const entry = ENTRIES.get(key);
  if (!entry || seen.has(key)) return "";
  seen.add(key);
  for (const requirement of entry.requires || []) {
    if (!isUniCanvasToggleOn(requirement)) return ENTRIES.get(requirement)?.label || requirement;
    const deeper = uniCanvasToggleBlocker(requirement, seen);
    if (deeper) return deeper;
  }
  return "";
}

/** On when its own switch and every requirement (transitively) are on. Unknown keys are on. */
export function isUniCanvasEnabled(key) {
  return isUniCanvasToggleOn(key) && !uniCanvasToggleBlocker(key);
}

export const isUniCanvasFamilyEnabled = (familyKey) => !FAMILY_KEYS.has(familyKey) || isUniCanvasEnabled(FAMILY_KEYS.get(familyKey));
export const isUniCanvasLoaderEnabled = (loaderKey) => !LOADER_KEYS.has(loaderKey) || isUniCanvasEnabled(LOADER_KEYS.get(loaderKey));
export const isUniCanvasToolEnabled = (name) => !TOOL_KEYS.has(name) || isUniCanvasEnabled(TOOL_KEYS.get(name));
export const isUniCanvasAutoNameModelEnabled = (model) => !AUTO_NAME_KEYS.has(model) || isUniCanvasEnabled(AUTO_NAME_KEYS.get(model));
export function isUniCanvasRemoveBgMethodEnabled(method) {
  if (!isUniCanvasEnabled("removeBackground")) return false;
  return !REMOVE_BG_KEYS.has(method) || isUniCanvasEnabled(REMOVE_BG_KEYS.get(method));
}
export function isUniCanvasLayerMenuItemEnabled(id) {
  return (MENU_KEYS.get(id) || []).every((key) => isUniCanvasEnabled(key));
}
/** Whether a gear-popover section is shown. */
export function isUniCanvasSettingsSectionEnabled(section) {
  return UNICANVAS_FEATURE_TOGGLES.every((entry) => !(entry.settingsSections || []).includes(section) || isUniCanvasEnabled(entry.key));
}
/** Remove background with at least one method left. */
export function isUniCanvasRemoveBgAvailable() {
  return [...REMOVE_BG_KEYS.keys()].some(isUniCanvasRemoveBgMethodEnabled);
}
/** Automatic naming with a model still allowed to download. */
export function isUniCanvasNamingModelAvailable() {
  return isUniCanvasEnabled("autoLayerNames") && [...AUTO_NAME_KEYS.keys()].some(isUniCanvasAutoNameModelEnabled);
}

/** [value, label] pairs the user may pick; `current` stays so a saved value shows as it is. */
export function filterUniCanvasChoices(pairs, isOn, current = undefined) {
  return (pairs || []).filter(([value]) => isOn(value) || (current !== undefined && value === current));
}

/** The first enabled value, keeping `value` while it is enabled. */
export function pickEnabledUniCanvasChoice(value, pairs, isOn) {
  if (isOn(value)) return value;
  return (pairs || []).find(([key]) => isOn(key))?.[0] ?? value;
}

/**
 * Hides the options of switched-off values in a select element (hidden + disabled: the custom select
 * skips both, and Safari's native picker honors `disabled`). The selected value always stays.
 */
export function syncUniCanvasSelectOptions(select, isOn, current = select?.value) {
  for (const option of select?.options || []) {
    const off = !isOn(option.value) && option.value !== String(current ?? "");
    if (option.hidden !== off) option.hidden = off;
    if (option.disabled !== off) option.disabled = off;
  }
}

/**
 * The last enabled family or loader cannot be switched off: returns the refusal message, or ""
 * when the change is fine.
 */
export function uniCanvasToggleRefusal(key, value) {
  const entry = ENTRIES.get(key);
  if (!entry || value !== false || !GROUPS.get(entry.group)?.atLeastOne) return "";
  const othersOn = groupEntries(entry.group).some((item) => item.key !== key && readStored(item));
  if (othersOn) return "";
  const noun = entry.group === "ModelFamilies" ? "model family" : "model loader";
  return `At least one ${noun} must stay on: ${entry.label} was switched back on.`;
}

/** Stores a value from ComfyUI's onChange (or a test) and tells every open widget. */
export function setUniCanvasToggleValue(key, value, { notify = true } = {}) {
  if (!ENTRIES.has(key)) return;
  state.values.set(key, value !== false);
  if (notify) notifyUniCanvasTogglesChanged();
}

/** Test helper: forget the stored values and the bound app. */
export function resetUniCanvasToggles() {
  state.values.clear();
  state.app = null;
}

export function onUniCanvasTogglesChanged(listener) {
  if (typeof listener !== "function") return () => {};
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function notifyUniCanvasTogglesChanged() {
  syncUniCanvasToggleStyles();
  for (const listener of [...state.listeners]) {
    try {
      listener();
    } catch (err) {
      console.warn("[VNCCS UniCanvas] Feature toggle update failed", err);
    }
  }
}

/** The stylesheet that hides every switched-off entry in every widget. */
export function uniCanvasToggleCss() {
  const selectors = [];
  for (const entry of UNICANVAS_FEATURE_TOGGLES) {
    if (isUniCanvasEnabled(entry.key)) continue;
    for (const selector of entry.hide || []) selectors.push(`.vnccs-unicanvas ${selector}`);
    for (const name of entry.tools || []) selectors.push(`.vnccs-unicanvas .vnccs-uc-tools [data-tool="${name}"]`);
  }
  return selectors.length ? `${selectors.join(",\n")} { display: none !important; }\n` : "";
}

export function syncUniCanvasToggleStyles(doc = typeof document === "undefined" ? null : document) {
  if (!doc?.head) return;
  let style = doc.getElementById(STYLE_ID);
  if (!style) {
    style = doc.createElement("style");
    style.id = STYLE_ID;
    doc.head.appendChild(style);
  }
  const css = uniCanvasToggleCss();
  if (style.textContent !== css) style.textContent = css;
}

function showToggleToast(appRef, message) {
  try {
    if (typeof appRef?.extensionManager?.toast?.add === "function") {
      appRef.extensionManager.toast.add({ severity: "warn", summary: "VNCCS UniCanvas", detail: message, life: 5000 });
      return;
    }
  } catch (_) {
    // Fall back to the console below.
  }
  console.warn(`[VNCCS UniCanvas] ${message}`);
}

function writeSetting(appRef, id, value) {
  try {
    const store = appRef?.extensionManager?.setting;
    if (typeof store?.set === "function") return Promise.resolve(store.set(id, value)).catch(() => {});
    if (typeof appRef?.ui?.settings?.setSettingValue === "function") return Promise.resolve(appRef.ui.settings.setSettingValue(id, value)).catch(() => {});
  } catch (_) {
    // A refused write leaves the stored value; the reader still never reports all families off.
  }
  return Promise.resolve();
}

/** The `settings` array of the VNCCS.UniCanvas extension, one boolean per registry entry. */
export function buildUniCanvasToggleSettings() {
  return UNICANVAS_FEATURE_TOGGLES.map((entry) => {
    const group = GROUPS.get(entry.group);
    const needs = (entry.requires || []).map((key) => ENTRIES.get(key)?.label || key);
    const tooltip = needs.length && !/Needs /.test(entry.tooltip) ? `${entry.tooltip} Needs ${needs.join(" and ")}.` : entry.tooltip;
    const id = uniCanvasToggleSettingId(entry);
    return {
      id,
      category: ["VNCCS", "UniCanvas", group.label],
      name: entry.label,
      tooltip,
      type: "boolean",
      defaultValue: true,
      onChange(value, oldValue) {
        const refusal = uniCanvasToggleRefusal(entry.key, value);
        if (refusal) {
          // Keep it on and snap the stored value back.
          setUniCanvasToggleValue(entry.key, true);
          if (oldValue !== undefined) showToggleToast(state.app, refusal);
          void writeSetting(state.app, id, true);
          return;
        }
        setUniCanvasToggleValue(entry.key, value);
      },
    };
  });
}

/** Brings one widget in line with the current toggles (called on every change). */
export function applyUniCanvasFeatureToggles(uc) {
  if (!uc || uc._disposed) return;
  syncUniCanvasToggleStyles(uc.container?.ownerDocument);
  if (uc.tool && uc.tool !== "pose" && !isUniCanvasToolEnabled(uc.tool)) uc.setTool?.("move");
  if (uc.sam && uc.sam.model === "sam3" && !isUniCanvasRemoveBgMethodEnabled("sam3")) {
    uc.sam.model = "sam2_large";
    if (uc.samModelSelect) uc.samModelSelect.value = "sam2_large";
    uc.clearSamMask?.(false);
  }
  if (uc.samModelSelect) syncUniCanvasSelectOptions(uc.samModelSelect, (value) => value !== "sam3" || isUniCanvasRemoveBgMethodEnabled("sam3"));
  // Open panels of a switched-off feature close.
  uc._vnccsLayerMenu?.remove?.();
  uc._vnccsLayerMenu = null;
  if (!isUniCanvasEnabled("colorMatch")) uc.closeColorMatchPreview?.(false);
  if (!isUniCanvasEnabled("harmonize") && uc.harmonizeLightTarget?.()) uc.closeHarmonizePanel?.(false);
  if (!isUniCanvasEnabled("vnPreview")) uc.vnPreview?.closePopover?.();
  if (!isUniCanvasEnabled("library")) uc.showLibraryTab?.(false);
  if (!isUniCanvasEnabled("promptGuide")) uc.togglePromptGuide?.(false);
  uc.timelinePanel?.syncAvailability?.();
  if (uc._vnccsSettingsPopover) {
    // Rebuild the gear popover so its sections follow the switches.
    uc.openUniCanvasSettings?.();
    uc.openUniCanvasSettings?.();
  }
  uc.syncPromptControls?.();
  uc.renderToolSettings?.();
  uc.poseBake?.updateGenerateLabel?.();
  uc.updateHud?.();
  uc.requestRender?.();
}

/** Subscribes a widget to toggle changes; the returned function (also `uc._vnccsTogglesOff`) unsubscribes. */
export function installUniCanvasFeatureToggles(uc) {
  if (!uc || uc._vnccsTogglesOff) return uc?._vnccsTogglesOff;
  const off = onUniCanvasTogglesChanged(() => applyUniCanvasFeatureToggles(uc));
  uc._vnccsTogglesOff = off;
  syncUniCanvasToggleStyles(uc.container?.ownerDocument);
  return off;
}
