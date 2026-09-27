import test from "node:test";
import assert from "node:assert/strict";
import {
  clamp, cloneJson, escapeHtml, finite, finiteOrNull, fnv1a, fnv1aHex, randomId, rectsIntersect, uniqueId,
  setStageBottomInset, stagePopoverBottom, STAGE_BOTTOM_INSET_VAR,
} from "../web/vnccs_unicanvas_util.mjs";
import { hashText } from "../web/vnccs_unicanvas_bake.mjs";
import { hashString } from "../web/vnccs_unicanvas_timeline_core.mjs";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8");

test("failed debug toggles, setting writes, merged pose renders and active-scene saves are reported, not swallowed", () => {
  assert.match(read("vnccs_unicanvas.js"), /body: JSON\.stringify\(\{ enabled \}\),\n    \}\)\.catch\(\(err\) => console\.warn\(/);
  assert.doesNotMatch(read("vnccs_unicanvas_feature_toggles.mjs"), /\.catch\(\(\) => \{\}\)/);
  assert.match(read("vnccs_unicanvas_pose_scene.mjs"), /editor\.commit\(\)\)\.catch\(\(err\) => \{\n\s+console\.warn\(/);
  assert.match(read("vnccs_unicanvas_project.mjs"), /Saving the active scene failed/);
});

test("FNV-1a matches the reference vectors and the bake / timeline hashes share it", () => {
  assert.equal(fnv1a(""), 0x811c9dc5);
  assert.equal(fnv1a("a"), 0xe40c292c);
  assert.equal(fnv1aHex("foobar"), "bf9cf968");
  assert.equal(hashText("foobar"), "bf9cf968");
  assert.equal(hashString("foobar"), 0xbf9cf968);
  assert.equal(fnv1aHex(12), fnv1aHex("12"));
});

test("escapeHtml escapes all five HTML-special characters", () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(3), "3");
});

test("number helpers keep the semantics of the copies they replace", () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(finite("2.5", 7), 2.5);
  assert.equal(finite("x", 7), 7);
  assert.equal(finite(null, 7), 0);
  assert.equal(finiteOrNull("2"), 2);
  assert.equal(finiteOrNull(" "), null);
  assert.equal(finiteOrNull(null), null);
  assert.equal(finiteOrNull(Infinity), null);
});

test("cloneJson, rectsIntersect and id helpers", () => {
  const value = { a: [1, { b: 2 }] };
  const copy = cloneJson(value);
  assert.deepEqual(copy, value);
  assert.notEqual(copy.a, value.a);
  assert.equal(cloneJson(undefined), undefined);
  assert.equal(cloneJson(null), null);
  const a = { x: 0, y: 0, width: 10, height: 10 };
  assert.equal(rectsIntersect(a, { x: 5, y: 5, width: 10, height: 10 }), true);
  assert.equal(rectsIntersect(a, { x: 10, y: 0, width: 5, height: 5 }), false);
  assert.equal(rectsIntersect(a, null), false);
  assert.match(randomId("uc"), /^uc_[0-9a-z]{1,8}$/);
  const first = uniqueId("var"), second = uniqueId("var");
  assert.match(first, /^var_[0-9a-z]+_[0-9a-z]+$/);
  assert.notEqual(first, second);
});

test("stage popovers clear the timeline dock through the bottom inset variable", () => {
  assert.equal(stagePopoverBottom(12), `calc(12px + var(${STAGE_BOTTOM_INSET_VAR}, 0px) / var(--vnccs-uc-ui-scale, 1))`);
  const props = new Map();
  const element = { style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } };
  setStageBottomInset(element, 219.6);
  assert.equal(props.get(STAGE_BOTTOM_INSET_VAR), "220px");
  setStageBottomInset(element, 0);
  assert.equal(props.has(STAGE_BOTTOM_INSET_VAR), false);
  setStageBottomInset(null, 10); // no stage: no-op
  // The staging, transform and SAM popovers all use it; the timeline dock publishes it.
  const widget = read("vnccs_unicanvas.js");
  assert.equal((widget.match(/style\.bottom = STAGE_POPOVER_BOTTOM;/g) || []).length, 3);
  assert.doesNotMatch(widget, /style\.bottom = "12px"/);
  assert.match(read("vnccs_unicanvas_timeline.mjs"), /setStageBottomInset\(this\.uc\.stageWrap/);
});
