// Double-clicking the inference scale "W×H" digits must turn them into a text input whose typed
// value drives the slider: a bare number targets the width, "WxH" the size, a value within the
// slider range a raw scale. The result snaps to the slider step (0.05) so the range input, the
// digits and the setting can never disagree about where the thumb stands.
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

function widget(bbox = { width: 1024, height: 768 }, settings = {}) {
  const w = Object.assign(Object.create(prototype), {
    settings: { inference_scale: 1, ...settings },
    bbox,
    container: { querySelectorAll: () => [] },
  });
  w.synced = 0;
  w.syncSettingsToWidget = () => { w.synced += 1; };
  return w;
}

test("a bare number sets the width and the digits match it after grid rounding", () => {
  const w = widget();
  assert.equal(w.applyInferenceSizeText("1536"), true);
  assert.equal(w.settings.inference_scale, 1.3);
  assert.equal(w.getInferenceSize().width, 1536);
  assert.equal(w.synced, 1);
});

test("a bare number that is not step-exact lands on the nearest slider step", () => {
  const w = widget();
  assert.equal(w.applyInferenceSizeText("1024"), true);
  assert.equal(w.settings.inference_scale, 0.85); // exact 0.866 is off-step; 0.85 shows 1008px
  assert.equal(w.getInferenceSize().width, 1008);
});

test("WxH sets the size through the area, the aspect stays the bbox one", () => {
  const w = widget();
  assert.equal(w.applyInferenceSizeText("2048x1024"), true);
  assert.equal(w.settings.inference_scale, 1.4); // nearest 0.05 step to sqrt(2048*1024)/1024
  const size = w.getInferenceSize();
  assert.ok(Math.abs(size.width / size.height - 4 / 3) < 0.02); // bbox aspect preserved
});

test("a value within the slider range is a raw scale, not a width", () => {
  const w = widget();
  assert.equal(w.applyInferenceSizeText("1.5"), true);
  assert.equal(w.settings.inference_scale, 1.5);
  assert.equal(w.applyInferenceSizeText("2"), true);
  assert.equal(w.settings.inference_scale, 2);
});

test("the scale is clamped to the slider range", () => {
  const w = widget();
  assert.equal(w.applyInferenceSizeText("0.1"), true);
  assert.equal(w.settings.inference_scale, 0.5);
  assert.equal(w.applyInferenceSizeText("99999"), true);
  assert.equal(w.settings.inference_scale, 3);
});

test("a comma decimal normalizes like the other numeric inputs", () => {
  const w = widget();
  assert.equal(w.applyInferenceSizeText("1,5"), true);
  assert.equal(w.settings.inference_scale, 1.5);
});

test("a half-typed WxH keeps applying as a width while typing", () => {
  const w = widget();
  assert.equal(w.applyInferenceSizeText("1536x"), true);
  assert.equal(w.settings.inference_scale, 1.3);
});

test("garbage and empty text are rejected without touching the setting", () => {
  const w = widget(undefined, { inference_scale: 1.25 });
  assert.equal(w.applyInferenceSizeText("abc"), false);
  assert.equal(w.applyInferenceSizeText(""), false);
  assert.equal(w.applyInferenceSizeText("x"), false);
  assert.equal(w.settings.inference_scale, 1.25);
  assert.equal(w.synced, 0);
});

test("the label refresh skips a span that hosts an open size edit", () => {
  const w = widget();
  const open = { querySelector: (sel) => (sel === ".vnccs-uc-infer-size-edit" ? {} : null), textContent: "old" };
  const closed = { querySelector: () => null, textContent: "old" };
  w.container = { querySelectorAll: () => [open, closed] };
  w.updateInferenceSizeLabels({ width: 1536, height: 1152 });
  assert.equal(open.textContent, "old");
  assert.equal(closed.textContent, "1536×1152");
});
