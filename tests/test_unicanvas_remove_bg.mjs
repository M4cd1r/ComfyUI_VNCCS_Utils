import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REMOVE_BG_DEFAULT_PROMPT } from "../web/vnccs_unicanvas_remove_bg.mjs";

test("the Remove bg default prompt matches the backend constant", () => {
  const backend = readFileSync(new URL("../nodes/unicanvas/remove_bg.py", import.meta.url), "utf8");
  const match = backend.match(/^UC_REMOVE_BG_DEFAULT_PROMPT = "([^"]*)"$/m);
  assert.ok(match, "remove_bg.py defines UC_REMOVE_BG_DEFAULT_PROMPT as a plain string");
  assert.equal(REMOVE_BG_DEFAULT_PROMPT, match[1]);
});
