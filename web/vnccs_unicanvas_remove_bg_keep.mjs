/**
 * VNCCS UniCanvas - Remove background keep areas (issue #13).
 *
 * The keep mask is the Inpaint Mask layer: when Remove background runs while that layer has
 * painted pixels, those pixels (cropped to the target layer's region) are sent as `keep`
 * (PNG data URL, white = keep). The backend forces them opaque after every backend
 * (nodes/unicanvas/remove_bg.py). No new layer type and no extra history: the run stays one
 * layerPixels entry.
 */

// Same threshold as hasMaskContent / sanitizeMaskCanvas: faint alpha is not paint.
const PAINTED_ALPHA = 8;

/** The mask layer Remove background reads: the active mask layer, else the first visible one. */
export function keepMaskLayer(uc) {
  const active = uc.activeLayer;
  if (active?.type === "mask" && active.visible) return active;
  return uc.layers.find((layer) => layer.type === "mask" && layer.visible) || null;
}

function readAlpha(uc, canvas, crop) {
  const ctx = uc.getReadbackContext(canvas, false);
  return ctx.getImageData(crop.x, crop.y, crop.width, crop.height);
}

/** Painted pixels of the keep mask layer (whole layer, or inside `crop`). */
export function countKeepPixels(uc, crop = null) {
  const layer = keepMaskLayer(uc);
  if (!layer?.canvas?.width || !layer.canvas.height) return 0;
  const rect = crop || { x: 0, y: 0, width: layer.canvas.width, height: layer.canvas.height };
  if (rect.width <= 0 || rect.height <= 0) return 0;
  const data = readAlpha(uc, layer.canvas, rect).data;
  let painted = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > PAINTED_ALPHA) painted += 1;
  return painted;
}

/** The popover line, so the keep state is visible before running. */
export function describeKeepAreas(uc) {
  const painted = countKeepPixels(uc);
  return painted > 0 ? `Keep areas: Inpaint Mask layer (${painted} px painted)` : "Keep areas: none";
}

/**
 * The `keep` field for a Remove background request on the target layer's `crop`
 * (layer-canvas coordinates, shared by raster and mask layers), or null when nothing
 * painted falls inside it.
 */
export function buildKeepMask(uc, crop) {
  const layer = keepMaskLayer(uc);
  if (!layer || !crop || crop.width <= 0 || crop.height <= 0) return null;
  const imageData = readAlpha(uc, layer.canvas, crop);
  const data = imageData.data;
  let painted = 0;
  for (let i = 0; i < data.length; i += 4) {
    const keep = data[i + 3] > PAINTED_ALPHA;
    if (keep) painted += 1;
    const value = keep ? 255 : 0;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  if (!painted) return null;
  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  canvas.getContext("2d").putImageData(imageData, 0, 0);
  return { dataUrl: canvas.toDataURL("image/png"), painted };
}
