import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entrySource = await readFile(path.join(root, "web/vnccs_unicanvas.js"), "utf8");
const initSource = await readFile(path.join(root, "__init__.py"), "utf8");

test("build info: commit id and file version are exposed to the settings popover and console", () => {
  assert.match(initSource, /@PromptServer\.instance\.routes\.get\("\/vnccs\/unicanvas\/build_info"\)/,
    "the backend must expose the build_info route");
  assert.match(initSource, /commit = _vnccs_read_git_commit\(/,
    "the build info must carry the git commit id");
  assert.ok(!/import subprocess/.test(initSource), "the commit is read from .git files, never by spawning git");
  assert.match(initSource, /"gitdir:"[\s\S]*"commondir"[\s\S]*"packed-refs"/,

    "the build info must carry the git commit id");
  const settings = entrySource.slice(entrySource.indexOf("openUniCanvasSettings() {"), entrySource.indexOf("openUniCanvasSettings() {") + 8000);
  assert.match(settings, /vnccs-uc-build-info/, "the settings popover must show the build identity");
  assert.match(settings, /\/vnccs\/unicanvas\/build_info/, "the popover must read the build_info route");
  assert.match(entrySource, /\[VNCCS UniCanvas\] build /, "extension setup must log the build identity");
});

test("entry-level history shield: stale cached modules cannot leak Ctrl+Z/Y to the graph", () => {
  const shieldStart = entrySource.indexOf("Self-contained safety net for the history keys");
  const shieldEnd = entrySource.indexOf("})();", entrySource.indexOf("}, true);", shieldStart));
  const shield = entrySource.slice(shieldStart, shieldEnd);
  assert.match(shield, /window\.addEventListener\("keydown"/, "the shield must listen on window keydown");
  assert.match(shield, /\}, true\);/, "the shield must listen in the capture phase");
  assert.match(shield, /key !== "z" && key !== "y"/, "the shield must claim only Z/Y");
  assert.match(shield, /closest\?\.\("input, textarea, select, \[contenteditable\]"\)/,
    "the shield must spare text fields");
  assert.match(shield, /querySelector\("\.vnccs-uc2-fullscreen-portal"\)/,
    "the shield must gate on the fullscreen portal marker");
  assert.match(shield, /classList\.contains\("vnccs-unicanvas-standalone-mode"\)/,
    "the shield must gate on the standalone body class");
  assert.match(shield, /stopImmediatePropagation\(\)/, "the shield must stop the key");
  assert.ok(!/import /.test(shield), "the shield must be dependency-free");
});

test("deleting any layer records history so undo restores it", () => {
  const del = entrySource.slice(entrySource.indexOf("  deleteLayer(id) {"), entrySource.indexOf("  deleteLayer(id) {") + 1200);
  assert.ok(/this\.recordHistoryBefore\(\);/.test(del),
    "deleteLayer must snapshot before removing the layer");
  assert.ok(!/type === "pose"[\s\S]{0,120}?recordHistoryBefore/.test(del),
    "history recording must not be limited to pose layers");
});

test("web modules import siblings by their plain URL, so each module loads once", async () => {
  // Freshness comes from the server's no-cache headers (api/web_cache.py), not from ?v= queries:
  // a module imported both with and without a query would load twice and split its state.
  const { readdir } = await import("node:fs/promises");
  const webDir = path.join(root, "web");
  let checked = 0;
  for (const name of await readdir(webDir)) {
    if (!/\.(js|mjs)$/.test(name)) continue;
    const source = await readFile(path.join(webDir, name), "utf8");
    for (const [, target, query] of source.matchAll(/from "\.\/(vnccs_(?:unicanvas|custom_select)[^"?]*\.mjs)(\?[^"]*)?"/g)) {
      assert.equal(query, undefined, `${name} must import ${target} without a query`);
      checked += 1;
    }
  }
  assert.ok(checked > 40, "the whole UniCanvas import graph is covered");
});
