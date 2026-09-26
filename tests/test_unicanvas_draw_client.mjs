import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  UNICANVAS_DRAW_ROUTE, drawDebugId, drawResponseImages, requestDirectDraw, runExclusiveGeneration, setGenerationLock,
} from "../web/vnccs_unicanvas_draw_client.mjs";

const read = (name) => fs.readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8");

function stubFetch(response) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (route, init) => { calls.push({ route, init }); return response; };
  return { calls, restore: () => { globalThis.fetch = previous; } };
}

test("requestDirectDraw posts the payload and normalises images / image", async () => {
  const stub = stubFetch({ ok: true, status: 200, json: async () => ({ image: "one", performance: "1s" }) });
  try {
    const out = await requestDirectDraw({ mode: "inpaint", debug_id: "x" });
    assert.deepEqual(out.images, ["one"]);
    assert.equal(out.data.performance, "1s");
    assert.equal(stub.calls[0].route, UNICANVAS_DRAW_ROUTE);
    assert.equal(stub.calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(stub.calls[0].init.body), { mode: "inpaint", debug_id: "x" });
  } finally { stub.restore(); }
  assert.deepEqual(drawResponseImages({ images: ["a", "b"], image: "c" }), ["a", "b"]);
  assert.deepEqual(drawResponseImages({ images: [] }), []);
  assert.deepEqual(drawResponseImages(null), []);
});

test("requestDirectDraw surfaces backend errors and tolerates non-JSON error pages", async () => {
  let stub = stubFetch({ ok: false, status: 400, json: async () => ({ error: "bad settings" }) });
  try { await assert.rejects(requestDirectDraw({}), /bad settings/); } finally { stub.restore(); }
  stub = stubFetch({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } });
  try { await assert.rejects(requestDirectDraw({}), /^Error: HTTP 502$/); } finally { stub.restore(); }
  stub = stubFetch({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } });
  try { await assert.rejects(requestDirectDraw({}), /Invalid response from the server \(HTTP 200\)/); } finally { stub.restore(); }
  stub = stubFetch({ ok: true, status: 200, json: async () => ({ error: "out of memory" }) });
  try { await assert.rejects(requestDirectDraw({}), /out of memory/); } finally { stub.restore(); }
});

test("the generation lock covers GENERATE and the batch count, and is released on failure", async () => {
  const uc = { drawBtn: { disabled: false }, batchInput: { disabled: false } };
  setGenerationLock(uc, true);
  assert.deepEqual([uc.drawInProgress, uc.drawBtn.disabled, uc.batchInput.disabled], [true, true, true]);
  setGenerationLock(uc, false);
  assert.deepEqual([uc.drawInProgress, uc.drawBtn.disabled, uc.batchInput.disabled], [false, false, false]);
  let seen = null;
  assert.equal(await runExclusiveGeneration(uc, async () => { seen = uc.drawInProgress; return 7; }), 7);
  assert.equal(seen, true);
  await assert.rejects(runExclusiveGeneration(uc, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(uc.drawInProgress, false);
  assert.equal(uc.drawBtn.disabled, false);
  setGenerationLock({}, true); // a host without controls
  assert.match(drawDebugId("bake"), /^bake-\d+-[0-9a-z]+$/);
});

test("bake, sprites and harmonize use the shared draw client and lock", () => {
  for (const name of ["vnccs_unicanvas_bake.mjs", "vnccs_unicanvas_sprites.mjs", "vnccs_unicanvas_harmonize.mjs"]) {
    const source = read(name);
    assert.match(source, /from "\.\/vnccs_unicanvas_draw_client\.mjs"/, name);
    assert.match(source, /requestDirectDraw\(/, name);
    assert.doesNotMatch(source, /uc\.drawInProgress = |uc\.drawBtn\.disabled = /, name);
    assert.doesNotMatch(source, /fetch\([A-Z_]*DRAW_ROUTE/, name);
  }
  const widget = read("vnccs_unicanvas.js");
  assert.match(widget, /runExclusiveGeneration\(work\) \{\n    return runExclusiveGeneration\(this, work\);/);
});
