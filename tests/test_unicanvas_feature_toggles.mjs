import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  UNICANVAS_FEATURE_TOGGLES,
  UNICANVAS_TOGGLE_GROUPS,
  bindUniCanvasFeatureToggles,
  buildUniCanvasToggleSettings,
  filterUniCanvasChoices,
  isUniCanvasEnabled,
  isUniCanvasFamilyEnabled,
  isUniCanvasLayerMenuItemEnabled,
  isUniCanvasNamingModelAvailable,
  isUniCanvasRemoveBgAvailable,
  isUniCanvasRemoveBgMethodEnabled,
  isUniCanvasSettingsSectionEnabled,
  isUniCanvasToggleOn,
  isUniCanvasToolEnabled,
  onUniCanvasTogglesChanged,
  pickEnabledUniCanvasChoice,
  resetUniCanvasToggles,
  setUniCanvasToggleValue,
  syncUniCanvasSelectOptions,
  uniCanvasToggleBlocker,
  uniCanvasToggleCss,
  uniCanvasToggleRefusal,
  uniCanvasToggleSettingId,
  uniCanvasRequestOverrides,
  uniCanvasRequestSettings,
} from "../web/vnccs_unicanvas_feature_toggles.mjs";
import { REMOVE_BG_METHODS, automaticRemoveBgRequest, removeBgEditLoader, resolveRemoveBgSelection } from "../web/vnccs_unicanvas_remove_bg.mjs";
import { bakeRemoveBgRequest } from "../web/vnccs_unicanvas_bake.mjs";
import { AUTO_NAME_MODELS, resolveAutoNameModel, resolveAutoNamingLevel } from "../web/vnccs_unicanvas_naming.mjs";
import { resolveAutoFile } from "../web/vnccs_unicanvas_filing.mjs";
import { PERSPECTIVE_TOOL } from "../web/vnccs_unicanvas_scene_place.mjs";
import { LAYER_MENU_ITEMS } from "../web/vnccs_unicanvas_layer_tools.mjs";

const read = (name) => readFile(new URL(`../web/${name}`, import.meta.url), "utf8");
const widgetSource = await read("vnccs_unicanvas.js");
const qwen21Source = await read("vnccs_unicanvas_qwen21.mjs");
const modesSource = await read("vnccs_unicanvas_modes.mjs");
const timelineSource = await read("vnccs_unicanvas_timeline.mjs");
const bakeSource = await read("vnccs_unicanvas_bake.mjs");
const spritesSource = await read("vnccs_unicanvas_sprites.mjs");
const removeBgSource = await read("vnccs_unicanvas_remove_bg.mjs");
const extensionMenuSources = await Promise.all(["vnccs_unicanvas_sprites.mjs", "vnccs_unicanvas_library.mjs", "vnccs_unicanvas_control_scene.mjs"].map(read));

const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `missing ${end}`);
  return source.slice(from, to);
};
const topLevelKeys = (block) => [...block.matchAll(/^ {2}(\w+): \{/gm)].map((match) => match[1]);
const byKey = new Map(UNICANVAS_FEATURE_TOGGLES.map((entry) => [entry.key, entry]));

function offOnly(...keys) {
  resetUniCanvasToggles();
  for (const key of keys) setUniCanvasToggleValue(key, false, { notify: false });
}

test.afterEach(() => resetUniCanvasToggles());

test("the settings array is generated from the registry, one boolean per entry, all on", () => {
  const settings = buildUniCanvasToggleSettings();
  assert.equal(settings.length, UNICANVAS_FEATURE_TOGGLES.length);
  const groups = new Map(UNICANVAS_TOGGLE_GROUPS.map((group) => [group.id, group.label]));
  const ids = new Set();
  settings.forEach((setting, index) => {
    const entry = UNICANVAS_FEATURE_TOGGLES[index];
    assert.equal(setting.id, `VNCCS.UniCanvas.${entry.group}.${entry.key}`);
    assert.equal(setting.id, uniCanvasToggleSettingId(entry.key));
    assert.deepEqual(setting.category, ["VNCCS", "UniCanvas", groups.get(entry.group)]);
    assert.equal(setting.type, "boolean");
    assert.equal(setting.defaultValue, true);
    assert.equal(setting.name, entry.label);
    assert.ok(setting.tooltip.length > 10, `${entry.key} needs a tooltip`);
    assert.equal(typeof setting.onChange, "function");
    ids.add(setting.id);
  });
  assert.equal(ids.size, settings.length, "setting ids are unique");
  assert.ok(widgetSource.includes("...buildUniCanvasToggleSettings()"), "the extension registers the generated settings");
  for (const entry of UNICANVAS_FEATURE_TOGGLES) {
    for (const key of entry.requires || []) assert.ok(byKey.has(key), `${entry.key} requires unknown ${key}`);
  }
});

test("with nothing stored every entry is on and the stylesheet hides nothing", () => {
  resetUniCanvasToggles();
  for (const entry of UNICANVAS_FEATURE_TOGGLES) assert.equal(isUniCanvasEnabled(entry.key), true, entry.key);
  assert.equal(uniCanvasToggleCss(), "");
  bindUniCanvasFeatureToggles({ extensionManager: { setting: { get: () => undefined } } });
  assert.equal(isUniCanvasEnabled("sprites"), true, "an unset ComfyUI value reads as the default");
});

test("guard: every model family (including Qwen-Image 2.1) and loader has a toggle", () => {
  const families = topLevelKeys(between(widgetSource, "const UNICANVAS_MODEL_MODULES = {", "...UNICANVAS_QWEN21_MODULE"));
  const qwen21 = qwen21Source.match(/const QWEN21_MODULE_KEY = "(\w+)"/)?.[1];
  assert.match(qwen21Source, /export const UNICANVAS_QWEN21_MODULE = \{\s*\[QWEN21_MODULE_KEY\]:/);
  assert.equal(qwen21, "qwen_image21");
  assert.ok(families.length >= 7);
  for (const key of [...families, qwen21]) {
    assert.ok(UNICANVAS_FEATURE_TOGGLES.some((entry) => entry.family === key), `family ${key} has no toggle`);
  }
  const loaders = topLevelKeys(between(widgetSource, "const UNICANVAS_MODEL_LOADERS = {", "\n};"));
  assert.deepEqual(loaders, ["checkpoint", "diffusion_model", "gguf"]);
  for (const key of loaders) assert.ok(UNICANVAS_FEATURE_TOGGLES.some((entry) => entry.loader === key), `loader ${key} has no toggle`);
});

test("guard: every toolbar tool except Move has a toggle", () => {
  const block = between(widgetSource, 'this.tools.className = "vnccs-uc-tools";', "forEach(([tool, title])");
  const tools = [...block.matchAll(/\["(\w+)", "[^"]+"\]/g)].map((match) => match[1]);
  assert.ok(tools.includes("brush") && tools.includes("pan"));
  for (const name of [...tools, PERSPECTIVE_TOOL]) {
    if (name === "move") {
      assert.equal(isUniCanvasToolEnabled("move"), true);
      continue;
    }
    assert.ok(UNICANVAS_FEATURE_TOGGLES.some((entry) => (entry.tools || []).includes(name)), `tool ${name} has no toggle`);
  }
});

test("guard: every Remove background method and naming model has a toggle", () => {
  for (const [method] of REMOVE_BG_METHODS) {
    assert.ok(UNICANVAS_FEATURE_TOGGLES.some((entry) => entry.removeBgMethod === method), `remove-bg method ${method} has no toggle`);
  }
  for (const [model] of AUTO_NAME_MODELS) {
    assert.ok(UNICANVAS_FEATURE_TOGGLES.some((entry) => entry.autoNameModel === model), `naming model ${model} has no toggle`);
  }
});

test("guard: every layer-menu id in the registry exists in the menu", () => {
  const known = new Set(LAYER_MENU_ITEMS.map((item) => item.id));
  for (const source of extensionMenuSources) for (const match of source.matchAll(/id: "([\w-]+)",\s*label:/g)) known.add(match[1]);
  for (const entry of UNICANVAS_FEATURE_TOGGLES) {
    for (const id of entry.menu || []) assert.ok(known.has(id), `${entry.key}: unknown layer-menu item ${id}`);
  }
});

test("dependencies: an entry whose requirement is off is off, transitively, and says why", () => {
  offOnly("poseLayers");
  assert.equal(isUniCanvasToggleOn("sprites"), true, "the entry's own switch is untouched");
  assert.equal(isUniCanvasEnabled("sprites"), false);
  assert.equal(isUniCanvasEnabled("characterBake"), false);
  assert.equal(isUniCanvasEnabled("sceneGenerate"), false, "Scene Generate needs Character bake, which needs Pose layers");
  assert.equal(isUniCanvasEnabled("interactionPresets"), false);
  assert.equal(uniCanvasToggleBlocker("interactionPresets"), "Pose layers");
  assert.equal(isUniCanvasLayerMenuItemEnabled("create-sprite-set"), false);
  assert.equal(isUniCanvasLayerMenuItemEnabled("bake-characters"), false);
  assert.equal(isUniCanvasLayerMenuItemEnabled("copy-clipboard"), true, "items without a toggle stay");

  offOnly("sceneStates");
  assert.equal(isUniCanvasEnabled("timeline"), false);
  offOnly("controlLayers");
  assert.equal(isUniCanvasEnabled("controlFromScene"), false);
  assert.equal(isUniCanvasLayerMenuItemEnabled("control-from-scene"), false);
  offOnly("groups");
  assert.equal(isUniCanvasEnabled("autoFiling"), false);
  assert.equal(resolveAutoFile({}), false);
  offOnly("family_qwen_image21");
  assert.equal(isUniCanvasEnabled("qwen21Spectrum"), false);
  assert.equal(isUniCanvasRemoveBgMethodEnabled("edit"), false);
  assert.equal(isUniCanvasRemoveBgMethodEnabled("birefnet"), true);
});

test("the last enabled family or loader cannot be switched off", () => {
  const families = UNICANVAS_FEATURE_TOGGLES.filter((entry) => entry.group === "ModelFamilies");
  offOnly(...families.slice(1).map((entry) => entry.key));
  assert.equal(uniCanvasToggleRefusal(families[0].key, false).startsWith("At least one model family"), true);
  assert.equal(uniCanvasToggleRefusal(families[0].key, true), "");
  assert.equal(uniCanvasToggleRefusal(families[1].key, false), "", "switching off an already-off family is fine");
  assert.equal(isUniCanvasFamilyEnabled(families[0].family), true);
  assert.equal(isUniCanvasFamilyEnabled(families[1].family), false);

  // Stored values that are all off (e.g. edited by hand) never hide every family.
  offOnly(...families.map((entry) => entry.key));
  for (const entry of families) assert.equal(isUniCanvasToggleOn(entry.key), true);

  const loaders = UNICANVAS_FEATURE_TOGGLES.filter((entry) => entry.group === "ModelLoaders");
  offOnly("loader_checkpoint", "loader_diffusion_model");
  assert.match(uniCanvasToggleRefusal("loader_gguf", false), /model loader/);
  assert.equal(loaders.length, 3);
  assert.equal(uniCanvasToggleRefusal("tool_brush", false), "", "other groups have no minimum");
});

test("a refused change snaps the stored value back and tells the user", async () => {
  const writes = [];
  const toasts = [];
  bindUniCanvasFeatureToggles({
    extensionManager: {
      setting: { get: (id) => !id.includes("ModelFamilies") || id.endsWith(".family_sdxl"), set: async (id, value) => writes.push([id, value]) },
      toast: { add: (toast) => toasts.push(toast) },
    },
  });
  const setting = buildUniCanvasToggleSettings().find((item) => item.id === uniCanvasToggleSettingId("family_sdxl"));
  let notified = 0;
  const off = onUniCanvasTogglesChanged(() => { notified += 1; });
  setting.onChange(false, true);
  off();
  await Promise.resolve();
  assert.deepEqual(writes, [[setting.id, true]]);
  assert.equal(toasts.length, 1);
  assert.equal(isUniCanvasFamilyEnabled("sdxl"), true);
  assert.equal(notified, 1, "open widgets refresh once");
});

test("changes reach every listener live and the stylesheet follows them", () => {
  resetUniCanvasToggles();
  const seen = [];
  const offA = onUniCanvasTogglesChanged(() => seen.push("a"));
  const offB = onUniCanvasTogglesChanged(() => seen.push("b"));
  buildUniCanvasToggleSettings().find((item) => item.id === uniCanvasToggleSettingId("tool_brush")).onChange(false, true);
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(isUniCanvasToolEnabled("brush"), false);
  assert.match(uniCanvasToggleCss(), /\.vnccs-unicanvas \.vnccs-uc-tools \[data-tool="brush"\]/);
  offA();
  setUniCanvasToggleValue("tool_brush", true);
  assert.deepEqual(seen, ["a", "b", "b"]);
  assert.equal(uniCanvasToggleCss(), "");
  offB();

  offOnly("groups", "promptGuide");
  const css = uniCanvasToggleCss();
  assert.match(css, /\[data-group-action\]/);
  assert.match(css, /\[data-prompt-help\]/);
  assert.match(css, /\[data-organize-layers\]/, "Auto filing follows Groups");
  assert.match(css, /display: none !important/);
});

test("pickers keep a saved value but offer only enabled choices", () => {
  offOnly("family_anima");
  const pairs = [["sdxl", "SDXL"], ["anima", "Anima"]];
  assert.deepEqual(filterUniCanvasChoices(pairs, isUniCanvasFamilyEnabled), [["sdxl", "SDXL"]]);
  assert.deepEqual(filterUniCanvasChoices(pairs, isUniCanvasFamilyEnabled, "anima"), pairs);
  assert.equal(pickEnabledUniCanvasChoice("anima", pairs, isUniCanvasFamilyEnabled), "sdxl");
  const options = pairs.map(([value]) => ({ value, hidden: false, disabled: false }));
  syncUniCanvasSelectOptions({ options }, isUniCanvasFamilyEnabled, "sdxl");
  assert.deepEqual(options.map((option) => option.hidden), [false, true]);
  assert.deepEqual(options.map((option) => option.disabled), [false, true]);
  syncUniCanvasSelectOptions({ options }, isUniCanvasFamilyEnabled, "anima");
  assert.deepEqual(options.map((option) => option.hidden), [false, false], "the current family stays visible");
});

test("Remove background and naming never pick a switched-off method or model", () => {
  offOnly("removebg_birefnet");
  assert.equal(resolveRemoveBgSelection({ remove_bg_model: "birefnet" }).method, "edit");
  assert.equal(resolveRemoveBgSelection({ remove_bg_model: "rembg" }).method, "rembg");
  offOnly("removeBackground");
  assert.equal(isUniCanvasRemoveBgAvailable(), false);
  assert.equal(isUniCanvasLayerMenuItemEnabled("remove-bg"), false);
  assert.equal(isUniCanvasSettingsSectionEnabled("remove_bg"), false);
  assert.equal(resolveRemoveBgSelection({ remove_bg_model: "rembg" }).method, "rembg", "the panel keeps showing the saved method");
  assert.equal(automaticRemoveBgRequest({ remove_bg_model: "rembg" }), null, "bakes and sprites do not cut out with it");
  offOnly("removebg_edit", "removebg_birefnet", "removebg_rembg", "removebg_sam3");
  assert.equal(isUniCanvasRemoveBgAvailable(), false);
  assert.equal(automaticRemoveBgRequest({ remove_bg_model: "birefnet" }), null);

  offOnly("naming_qwen3vl_2b");
  assert.equal(resolveAutoNameModel({ auto_name_model: "qwen3vl_2b" }), "smolvlm_256m");
  assert.equal(resolveAutoNamingLevel({ auto_naming: "model" }), "model");
  offOnly("naming_qwen3vl_2b", "naming_smolvlm_256m");
  assert.equal(isUniCanvasNamingModelAvailable(), false);
  assert.equal(resolveAutoNamingLevel({ auto_naming: "model" }), "rules", "nothing can download");
  offOnly("autoLayerNames");
  assert.equal(resolveAutoNamingLevel({ auto_naming: "model" }), "off");
  assert.equal(isUniCanvasLayerMenuItemEnabled("auto-name"), false);
});

test("bakes and sprites cut out only with an enabled automatic method (#33)", () => {
  resetUniCanvasToggles();
  assert.equal(automaticRemoveBgRequest({ remove_bg_model: "rembg" }).method, "rembg");
  assert.equal(automaticRemoveBgRequest({ remove_bg_model: "sam3" }).method, "birefnet", "interactive SAM 3 falls back");
  assert.equal(bakeRemoveBgRequest({ remove_bg_model: "sam3" }).method, "birefnet");
  offOnly("removebg_birefnet");
  assert.equal(automaticRemoveBgRequest({ remove_bg_model: "sam3" }).method, "rembg", "the next enabled automatic backend");
  offOnly("removeBackground");
  assert.equal(bakeRemoveBgRequest({ remove_bg_model: "birefnet" }), null, "Remove background off: no backend call");
  offOnly("removebg_birefnet", "removebg_rembg", "removebg_edit");
  assert.equal(automaticRemoveBgRequest({ remove_bg_model: "sam3" }), null, "only the interactive method is left");
  const sources = [widgetSource, bakeSource, spritesSource];
  assert.match(bakeSource, /\(await removeBackground\(crop\)\) \?\? silCrop/, "a bake cuts along the mannequin silhouette instead");
  assert.match(spritesSource, /\(await removeBackground\(full\)\) \?\? mask/, "an outfit sprite cuts along its outfit mask instead");
  assert.ok(sources.every((source) => !source.includes("resolveRemoveBgSelection(uc.settings)")));
});

test("the Edit-model loader list follows the loader toggles (#33)", () => {
  resetUniCanvasToggles();
  assert.equal(removeBgEditLoader(undefined, undefined), "diffusion_model");
  assert.equal(removeBgEditLoader("gguf", "diffusion_model"), "gguf", "a saved loader stays");
  offOnly("loader_diffusion_model");
  assert.equal(removeBgEditLoader(undefined, "diffusion_model"), "gguf", "the default gives way to an enabled loader");
  assert.equal(removeBgEditLoader("diffusion_model", undefined), "diffusion_model", "the saved loader stays visible");
  assert.match(removeBgSource, /syncUniCanvasSelectOptions\(loader, isUniCanvasLoaderEnabled, loader\.value\)/);
});

test("a switched-off Spectrum never runs, the saved scene keeps it (#33)", () => {
  const saved = { spectrum: { enabled: true, chebyshev_degree: 4 }, steps: 20 };
  resetUniCanvasToggles();
  assert.deepEqual(uniCanvasRequestOverrides(saved), {});
  assert.equal(uniCanvasRequestSettings(structuredClone(saved)).spectrum.enabled, true);
  offOnly("qwen21Spectrum");
  const request = uniCanvasRequestSettings(structuredClone(saved));
  assert.equal(request.spectrum.enabled, false);
  assert.equal(request.spectrum.chebyshev_degree, 4);
  assert.equal(saved.spectrum.enabled, true, "the saved settings are untouched");
  assert.deepEqual(uniCanvasRequestOverrides(saved), { spectrum: { enabled: false, chebyshev_degree: 4 } });
  offOnly("family_qwen_image21");
  assert.equal(uniCanvasRequestSettings(structuredClone(saved)).spectrum.enabled, false, "its requirement off turns it off too");
  assert.match(widgetSource, /return uniCanvasRequestSettings\(settings\);/, "every request goes through makeSettingsPayload");
  assert.match(widgetSource, /queued_draw\.settings_overrides = uniCanvasRequestOverrides\(this\.settings\)/, "the queued node path too");
});

test("the widget, shortcuts and timeline read the toggles", async () => {
  assert.match(widgetSource, /installUniCanvasFeatureToggles\(this\);/);
  assert.match(widgetSource, /this\._vnccsTogglesOff\?\.\(\);/, "dispose unsubscribes");
  assert.match(widgetSource, /if \(tool !== "pose" && !isUniCanvasToolEnabled\(tool\)\) tool = "move";/);
  assert.match(widgetSource, /isUniCanvasEnabled\("panoramas"\) && isPanoramaCandidate/);
  assert.match(widgetSource, /isUniCanvasFamilyEnabled\(getUniCanvasModelModule\(preset/);
  assert.match(modesSource, /isUniCanvasToolEnabled\(TOOL_SHORTCUTS\[lower\]\)/);
  assert.match(modesSource, /isUniCanvasEnabled\("groups"\)/);
  assert.match(timelineSource, /isUniCanvasFeatureAvailable\(this\.uc, "timeline"\)/,
    "the toggle only hides on top of the standalone split");
  assert.ok(!/localStorage\s*[.[]/.test(await read("vnccs_unicanvas_feature_toggles.mjs")), "values live in ComfyUI settings, not localStorage");
});
