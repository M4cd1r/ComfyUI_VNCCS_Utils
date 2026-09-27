// Regression: picking a model file in the Custom panel must never reset the family, the loader or
// the picked model names. The Qwen Edit family used to carry a bare "qwen" detect token, so every
// Qwen file (including Qwen-Image-2.1's qwen_image_21_int8_convrot.safetensors) was read as Qwen
// Edit and its GGUF default flipped Mode and Loader on the spot.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

import { UNICANVAS_QWEN21_MODULE } from "../web/vnccs_unicanvas_qwen21.mjs";

const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const context = {
  UNICANVAS_QWEN21_MODULE,
  // The class slice references the module only from syncPromptControls paths the tests stub away.
  syncQwen21SpectrumPanel() {},
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf("const NUMERIC_SETTINGS"), source.indexOf("const TOOL_ICONS")), context);
const prototype = vm.runInContext(
  source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype",
  context
);

function detect(name) {
  return vm.runInContext(`detectUniCanvasModelModule(${JSON.stringify(name)})`, context)?.key ?? null;
}

function widget(settings) {
  return Object.assign(Object.create(prototype), {
    settings,
    syncPromptControls() {},
    _isConfigLinked() { return false; },
  });
}

test("family detection reads the family, never the Qwen Edit shorthand", () => {
  assert.equal(detect("qwen/qwen_image_21_int8_convrot.safetensors"), "qwen_image21");
  assert.equal(detect("qwen/qwen_image_edit_2511_int8_convrot.safetensors"), "qwen_image_edit");
  assert.equal(detect("Qwen-Image-Edit-2511-Q5_0.gguf"), "qwen_image_edit");
  assert.equal(detect("qwen/qwen2.5_vl_7b_fp8_scaled.safetensors"), null);
  assert.equal(detect("animal/JANIMA_v10.safetensors"), null);
  assert.equal(detect("flux-2-klein-9b-fp8.safetensors"), "flux_klein");
  assert.equal(detect("z_image_turbo_bf16.safetensors"), "z_image");
  assert.equal(detect("krea2_turbo_int8_convrot.safetensors"), "krea2_edit");
});

test("the most specific family keyword wins over a shorter one", () => {
  // Synthetic name carrying a Qwen-Image-2.1 token and a Qwen Edit token: the longer
  // "qwen-image-2.1" must not lose to "qwen-edit".
  assert.equal(detect("qwen-image-2.1-qwen-edit.safetensors"), "qwen_image21");
  assert.equal(detect("klein-flux2-krea2.safetensors"), "flux_klein");
});

test("picking the QwenImage21 diffusion model keeps the mode, loader and file", () => {
  const w = widget({
    model_selection_mode: "custom",
    generation_mode: "qwen_image21",
    model_loader: "diffusion_model",
    diffusion_model_name: String.raw`qwen\qwen_image_21_int8_convrot.safetensors`,
    clip_name: "qwen3vl_8b_int8_convrot_bf16vision.safetensors",
    vae_name: "qwen_image_2.1_vae_bf16.safetensors",
    steps: 45,
    qwen21_turbo_enabled: false,
  });

  w.autoDetectGenerationModeFromModel();

  assert.equal(w.settings.generation_mode, "qwen_image21");
  assert.equal(w.settings.model_loader, "diffusion_model");
  assert.equal(w.settings.diffusion_model_name, String.raw`qwen\qwen_image_21_int8_convrot.safetensors`);
  assert.equal(w.settings.steps, 45);
  assert.equal(w.settings.qwen21_turbo_enabled, false);
});

test("a Qwen Edit safetensors file switches the family but keeps the Diffusion Model loader", () => {
  const w = widget({
    model_selection_mode: "custom",
    generation_mode: "qwen_image21",
    model_loader: "diffusion_model",
    diffusion_model_name: String.raw`qwen\qwen_image_edit_2511_int8_convrot.safetensors`,
    clip_name: "custom_clip.safetensors",
    vae_name: "custom_vae.safetensors",
  });

  w.autoDetectGenerationModeFromModel();

  assert.equal(w.settings.generation_mode, "qwen_image_edit");
  assert.equal(w.settings.model_loader, "diffusion_model");
  assert.equal(w.settings.diffusion_model_name, String.raw`qwen\qwen_image_edit_2511_int8_convrot.safetensors`);
  assert.equal(w.settings.clip_name, "custom_clip.safetensors");
  assert.equal(w.settings.vae_name, "custom_vae.safetensors");
  // The family's own generation defaults still apply.
  assert.equal(w.settings.steps, 4);
});

test("a GGUF edit file switches the family and stays on the GGUF loader", () => {
  const w = widget({
    model_selection_mode: "custom",
    generation_mode: "sdxl",
    model_loader: "gguf",
    gguf_model_name: "qwen-image-edit-2511-Q5_0.gguf",
  });

  w.autoDetectGenerationModeFromModel();

  assert.equal(w.settings.generation_mode, "qwen_image_edit");
  assert.equal(w.settings.model_loader, "gguf");
  assert.equal(w.settings.gguf_model_name, "qwen-image-edit-2511-Q5_0.gguf");
});

test("an unknown or empty model name changes nothing", () => {
  const w = widget({
    model_selection_mode: "custom",
    generation_mode: "sdxl",
    model_loader: "diffusion_model",
    diffusion_model_name: "",
    steps: 24,
  });

  w.autoDetectGenerationModeFromModel();

  assert.equal(w.settings.generation_mode, "sdxl");
  assert.equal(w.settings.model_loader, "diffusion_model");
  assert.equal(w.settings.steps, 24);
});
