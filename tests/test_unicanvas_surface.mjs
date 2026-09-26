import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resetUniCanvasToggles, setUniCanvasToggleValue, UNICANVAS_FEATURE_TOGGLES } from "../web/vnccs_unicanvas_feature_toggles.mjs";
import {
  UNICANVAS_NODE_SURFACE_CLASS,
  UNICANVAS_STANDALONE_ONLY_FEATURES,
  applyUniCanvasSurface,
  isUniCanvasFeatureAvailable,
  isUniCanvasStandalone,
  isUniCanvasStandaloneOnlyFeature,
  markUniCanvasStandaloneNode,
  uniCanvasNodeSurfaceCss,
  uniCanvasSurface,
} from "../web/vnccs_unicanvas_surface.mjs";

const read = (name) => readFile(new URL(`../web/${name}`, import.meta.url), "utf8");

function fakeContainer() {
  const classes = new Set();
  const head = { children: [], appendChild(el) { this.children.push(el); } };
  const doc = {
    head,
    getElementById: (id) => head.children.find((el) => el.id === id) || null,
    createElement: () => ({ id: "", textContent: "" }),
  };
  return {
    ownerDocument: doc,
    dataset: {},
    classList: {
      toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name),
    },
  };
}

test("a workflow node is the node surface, the standalone tab is standalone", () => {
  assert.equal(isUniCanvasStandalone({ node: { id: 3 } }), false);
  assert.equal(uniCanvasSurface({ node: { id: 3 } }), "node");
  assert.equal(isUniCanvasStandalone(null), false);
  // The standalone tab marks its stub node, so the constructor already knows the surface.
  const stub = markUniCanvasStandaloneNode({ widgets: [] });
  assert.equal(isUniCanvasStandalone({ node: stub }), true);
  assert.equal(uniCanvasSurface({ node: stub }), "standalone");
  // The legacy flag set after construction still counts.
  assert.equal(isUniCanvasStandalone({ standalone: true, node: {} }), true);
});

test("states, timeline, VN preview, projects and history are standalone only", () => {
  resetUniCanvasToggles();
  const node = { node: {} };
  const standalone = { node: markUniCanvasStandaloneNode({}) };
  for (const key of ["sceneStates", "timeline", "vnPreview", "projects", "history"]) {
    assert.ok(isUniCanvasStandaloneOnlyFeature(key), key);
    assert.equal(isUniCanvasFeatureAvailable(node, key), false, `${key} hidden on the node`);
    assert.equal(isUniCanvasFeatureAvailable(standalone, key), true, `${key} shown standalone`);
  }
  // Everything else is on both surfaces.
  for (const key of ["groups", "library", "harmonize", "promptGuide"]) {
    assert.equal(isUniCanvasStandaloneOnlyFeature(key), false);
    assert.equal(isUniCanvasFeatureAvailable(node, key), true, `${key} on the node`);
    assert.equal(isUniCanvasFeatureAvailable(standalone, key), true, `${key} standalone`);
  }
});

test("the settings switch still applies on top of the surface split", () => {
  resetUniCanvasToggles();
  const standalone = { node: markUniCanvasStandaloneNode({}) };
  setUniCanvasToggleValue("vnPreview", false, { notify: false });
  assert.equal(isUniCanvasFeatureAvailable(standalone, "vnPreview"), false);
  // Timeline needs scene states.
  setUniCanvasToggleValue("sceneStates", false, { notify: false });
  assert.equal(isUniCanvasFeatureAvailable(standalone, "timeline"), false);
  resetUniCanvasToggles();
  assert.equal(isUniCanvasFeatureAvailable(standalone, "timeline"), true);
});

test("the node-surface stylesheet hides every standalone-only entry's registry selectors", () => {
  const css = uniCanvasNodeSurfaceCss();
  const prefix = `.vnccs-unicanvas.${UNICANVAS_NODE_SURFACE_CLASS} `;
  for (const key of UNICANVAS_STANDALONE_ONLY_FEATURES) {
    const entry = UNICANVAS_FEATURE_TOGGLES.find((item) => item.key === key);
    assert.ok(entry, `${key} is a feature-toggle entry`);
    for (const selector of entry.hide || []) assert.ok(css.includes(prefix + selector), `${key}: ${selector}`);
  }
  for (const selector of [".vnccs-uc-states", "[data-timeline-toggle]", ".vnccs-uc-vnp-toggle", ".vnccs-uc-project-bar", ".vnccs-uc-project-chip", ".vnccs-uc-history-open"]) {
    assert.ok(css.includes(prefix + selector), selector);
  }
  assert.ok(!css.includes("[data-group-action]"), "only standalone-only features are hidden");
  assert.match(css, /\{ display: none !important; \}/);
});

test("applyUniCanvasSurface tags the container and installs the stylesheet once", () => {
  const nodeContainer = fakeContainer();
  applyUniCanvasSurface({ node: {}, container: nodeContainer });
  assert.equal(nodeContainer.classList.contains(UNICANVAS_NODE_SURFACE_CLASS), true);
  assert.equal(nodeContainer.dataset.surface, "node");
  assert.equal(nodeContainer.ownerDocument.head.children.length, 1);
  applyUniCanvasSurface({ node: {}, container: nodeContainer });
  assert.equal(nodeContainer.ownerDocument.head.children.length, 1, "one stylesheet");

  const tabContainer = fakeContainer();
  applyUniCanvasSurface({ node: markUniCanvasStandaloneNode({}), container: tabContainer });
  assert.equal(tabContainer.classList.contains(UNICANVAS_NODE_SURFACE_CLASS), false);
  assert.equal(tabContainer.dataset.surface, "standalone");
  assert.equal(applyUniCanvasSurface(null), null);
});

test("every surface decision goes through the one helper", async () => {
  const [widget, modes, timeline, vnPreview, project] = await Promise.all([
    read("vnccs_unicanvas.js"), read("vnccs_unicanvas_modes.mjs"), read("vnccs_unicanvas_timeline.mjs"),
    read("vnccs_unicanvas_vn_preview.mjs"), read("vnccs_unicanvas_project.mjs"),
  ]);
  assert.match(widget, /applyUniCanvasSurface\(this\);/, "the widget tags its surface in the constructor");
  assert.match(modes, /markUniCanvasStandaloneNode\(\{/, "the standalone tab marks its stub node");
  assert.match(modes, /isUniCanvasFeatureAvailable\(widget, "sceneStates"\)/, "Alt+1..9 is standalone only");
  assert.match(modes, /isUniCanvasFeatureAvailable\(widget, "vnPreview"\)/, "P is standalone only");
  assert.match(timeline, /isUniCanvasFeatureAvailable\(this\.uc, "timeline"\)/);
  assert.equal((vnPreview.match(/isUniCanvasFeatureAvailable\(this\.uc, "vnPreview"\)/g) || []).length, 2, "overlay and frame drag");
  assert.match(project, /uniCanvasSurface\(this\.widget\)/);
  for (const [name, source] of [["modes", modes], ["timeline", timeline], ["vn preview", vnPreview], ["project", project]]) {
    assert.ok(!/\.standalone\s*===\s*true|\.standalone\s*\?|if \(!?widget\.standalone\)/.test(source), `${name} must not read .standalone directly`);
  }
});
