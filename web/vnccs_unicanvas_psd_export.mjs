/**
 * VNCCS UniCanvas PSD export structure (issue #8).
 *
 * Layer groups export as PSD folders (ag-psd `children` with `opened`), with the group's
 * opacity and blend mode: a pass-through group stays "pass through", an isolated one keeps its
 * blend, so Photoshop composites the file like the canvas. Canvas composite operations are
 * mapped to the PSD blend mode names ag-psd writes. Invisible layers and groups left empty
 * are skipped. Pure: the widget passes a `leaf(layer, index)` that builds one raster record
 * (or null to skip it).
 */

import { buildLayerTree, groupCompositeOperation, isGroupLayer, isIsolatedGroup, isLayerEffectivelyVisible } from "./vnccs_unicanvas_groups.mjs";

// Canvas globalCompositeOperation -> ag-psd blend mode name.
const COMPOSITE_TO_PSD = Object.freeze({
  "source-over": "normal",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "color dodge",
  "color-burn": "color burn",
  "hard-light": "hard light",
  "soft-light": "soft light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
});

/**
 * The PSD blend mode of a layer or group. A group is "pass through" only while UniCanvas draws
 * it in place; an isolated group (opacity below 1 or a blend mode) exports as an isolated
 * folder with its blend ("normal" for a faded pass-through group), as the canvas composites it.
 */
export function psdBlendMode(layer) {
  if (isGroupLayer(layer)) return isIsolatedGroup(layer) ? COMPOSITE_TO_PSD[groupCompositeOperation(layer)] || "normal" : "pass through";
  return COMPOSITE_TO_PSD[layer?.blendMode || "source-over"] || "normal";
}

/** ag-psd opacity: 0..1 (it writes the byte itself). */
export const psdOpacity = (layer) => {
  const value = Number(layer?.opacity ?? 1);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
};

/**
 * ag-psd `children` (bottom first) for `layers` (the widget's flat top-to-bottom array):
 * groups become folders with their opacity and blend, leaves come from `leaf`.
 */
export function buildPsdChildren(layers, leaf) {
  let index = 0;
  const visit = (nodes) => {
    const out = [];
    for (const node of [...nodes].reverse()) {
      const layer = node.layer;
      if (!isLayerEffectivelyVisible(layers, layer)) continue;
      if (isGroupLayer(layer)) {
        const children = visit(node.children);
        if (!children.length) continue;
        out.push({
          name: layer.name || "Group", opened: layer.collapsed !== true, hidden: false,
          opacity: psdOpacity(layer), blendMode: psdBlendMode(layer), children,
        });
        continue;
      }
      const record = leaf(layer, index++);
      if (record) out.push({ hidden: false, opacity: psdOpacity(layer), blendMode: psdBlendMode(layer), ...record });
    }
    return out;
  };
  return visit(buildLayerTree(layers));
}

/** Number of raster records (folders excluded) in a `children` tree. */
export function countPsdLayers(children) {
  return (children || []).reduce((sum, child) => sum + (Array.isArray(child.children) ? countPsdLayers(child.children) : 1), 0);
}
