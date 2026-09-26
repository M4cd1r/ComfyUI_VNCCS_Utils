import test from "node:test";
import assert from "node:assert/strict";
import {
  clamp, cloneJson, escapeHtml, finite, finiteOrNull, fnv1a, fnv1aHex, randomId, rectsIntersect, uniqueId,
} from "../web/vnccs_unicanvas_util.mjs";
import { hashText } from "../web/vnccs_unicanvas_bake.mjs";
import { hashString } from "../web/vnccs_unicanvas_timeline_core.mjs";

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
