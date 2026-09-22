/**
 * VNCCS UniCanvas layer utilities (design spec sections 10.1-10.4).
 *
 *  - 10.1 Right-clicking a layer row opens a context menu: copy the layer PNG
 *    (with alpha) to the clipboard, save it via the save_output route, remove
 *    its background (QI2.1 or BiRefNet), color-match it to the composite below,
 *    plus the pose-layer entries Rasterize / Edit pose (pose layers only).
 *  - 10.2 "Import PSD" sits next to "Export Layers as PSD" and maps raster
 *    layers (name, visibility, opacity, blend mode) from the vendored ag-psd
 *    bundle, preserving order; anything UniCanvas cannot represent is skipped
 *    and reported in the status line.
 *  - 10.3 Background removal is one-shot with status-line progress and a
 *    single layerPixels history entry; the returned alpha is applied with
 *    destination-in so the layer keeps its own colors.
 *  - 10.4 Color match compares the active layer against the composite of the
 *    visible layers below it and previews live on a scratch copy while the
 *    strength slider is dragged; the release commits one history entry and
 *    stale previews are dropped (newest value wins).
 *
 * Like vnccs_unicanvas_input_tools.mjs, everything is installed onto the
 * widget instance so the shared vnccs_unicanvas.js only needs an import and
 * one install call.
 */

import { clamp } from "./vnccs_unicanvas_input_tools.mjs";

export const LAYER_MENU_ITEMS = Object.freeze([
  { id: "copy-clipboard", label: "Copy layer as image to clipboard" },
  { id: "save-image", label: "Save layer as image" },
  { id: "remove-bg-qi21", label: "Remove bg – QI2.1" },
  { id: "remove-bg-birefnet", label: "Remove bg – BiRefNet" },
  { id: "color-match", label: "Color match to below" },
  { id: "rasterize", label: "Rasterize", poseOnly: true },
  { id: "edit-pose", label: "Edit pose", poseOnly: true },
]);

export const PSD_SKIP_REASONS = Object.freeze({
  clipping: "clipping mask",
  adjustment: "adjustment layer",
  effects: "layer effects",
  noRaster: "text/vector/smart-object layer without raster data",
});

export const PSD_BLEND_MODE_MAP = Object.freeze({
  normal: "source-over",
  dissolve: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  colordodge: "color-dodge",
  colorburn: "color-burn",
  hardlight: "hard-light",
  softlight: "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
});

export const COLOR_MATCH_METHODS = Object.freeze([
  "mkl",
  "hm",
  "reinhard",
  "mvgd",
  "hm-mvgd-hm",
  "hm-mkl-hm",
  "reinhard_lab_gpu",
]);
export const COLOR_MATCH_STRENGTH_MAX = 10;
export const COLOR_MATCH_ROUTE = "/vnccs/unicanvas/color_match";
export const REMOVE_BG_ROUTE = "/vnccs/unicanvas/remove_bg";
export const SAVE_OUTPUT_ROUTE = "/vnccs/unicanvas/save_output";
export const POSE_TOOLS_UNAVAILABLE = "[VNCCS UniCanvas] Pose tools are not available.";

function normalizePsdOpacity(value) {
  const opacity = Number(value);
  if (!Number.isFinite(opacity)) return 1;
  return clamp(opacity > 1 ? opacity / 255 : opacity, 0, 1);
}

function psdBlendModeToComposite(blendMode) {
  const key = String(blendMode || "normal").toLowerCase().replace(/[\s_-]/g, "");
  return PSD_BLEND_MODE_MAP[key] || "source-over";
}

function psdEntryToCanvas(entry) {
  if (entry.canvas) return entry.canvas;
  const data = entry.imageData;
  const width = data.width || entry.right - entry.left;
  const height = data.height || entry.bottom - entry.top;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d");
  const clamped = data.data instanceof Uint8ClampedArray ? data.data : new Uint8ClampedArray(data.data);
  ctx.putImageData(new ImageData(clamped, canvas.width, canvas.height), 0, 0);
  return canvas;
}

function collectPsdRasterLayers(entries, imported, skipped) {
  for (const entry of entries || []) {
    if (!entry || typeof entry !== "object") continue;
    if (Array.isArray(entry.children)) {
      // Groups are structural: keep walking into them for their raster children.
      collectPsdRasterLayers(entry.children, imported, skipped);
      continue;
    }
    const name = entry.name || "Unnamed";
    if (entry.clipped) {
      skipped.push({ reason: PSD_SKIP_REASONS.clipping, name });
      continue;
    }
    if (entry.adjustment) {
      skipped.push({ reason: PSD_SKIP_REASONS.adjustment, name });
      continue;
    }
    if (entry.effects && Object.keys(entry.effects).length) {
      skipped.push({ reason: PSD_SKIP_REASONS.effects, name });
      continue;
    }
    if (!entry.canvas && !entry.imageData) {
      skipped.push({ reason: PSD_SKIP_REASONS.noRaster, name });
      continue;
    }
    imported.push(entry);
  }
}

function formatPsdImportReport(importedCount, skipped) {
  const base = `[VNCCS UniCanvas] PSD imported ${importedCount} raster layers`;
  if (!skipped.length) return `${base}; nothing skipped.`;
  const details = skipped.map((item) => `${item.reason} "${item.name}"`).join(", ");
  return `${base}; skipped ${skipped.length}: ${details}.`;
}

function createPsdLayer(uc, entry) {
  const source = psdEntryToCanvas(entry);
  const left = Number(entry.left) || 0;
  const top = Number(entry.top) || 0;
  const worldX = uc.bbox.x + left;
  const worldY = uc.bbox.y + top;
  uc.ensureWorldBounds(worldX + source.width, worldY + source.height, 64);
  uc.ensureWorldBounds(worldX, worldY, 64);
  const layer = uc.addLayer("raster", entry.name || "PSD Layer", true, true);
  layer.visible = entry.hidden ? false : true;
  layer.opacity = normalizePsdOpacity(entry.opacity);
  layer.blendMode = psdBlendModeToComposite(entry.blendMode);
  const ctx = uc.configureImageContext(layer.canvas.getContext("2d"));
  ctx.drawImage(source, worldX - uc.origin.x, worldY - uc.origin.y);
  uc.invalidateLayerCaches(layer);
  return layer;
}

async function importPSDFile(uc, file) {
  if (!file) return;
  try {
    uc.setStatus("[VNCCS UniCanvas] Reading PSD...");
    const { readPsd } = await uc.loadAgPsd();
    if (typeof readPsd !== "function") throw new Error("ag-psd readPsd is not available");
    const buffer = await file.arrayBuffer();
    const psd = readPsd(new Uint8Array(buffer), { useImageData: true });
    const imported = [];
    const skipped = [];
    collectPsdRasterLayers(psd.children || [], imported, skipped);
    // PSD children come top-to-bottom and new layers insert at the top, so
    // create them bottom-up to preserve the PSD stacking order.
    for (const entry of [...imported].reverse()) createPsdLayer(uc, entry);
    uc.renderLayerList();
    uc.requestRender();
    uc.syncLightStateToWidget();
    uc.scheduleFullSync();
    uc.setStatus(formatPsdImportReport(imported.length, skipped));
  } catch (err) {
    uc.setStatus(`[VNCCS UniCanvas] PSD import failed: ${err.message || err}`, true);
  }
}

async function copyLayerToClipboard(uc, layer) {
  try {
    const crop = uc.getLayerAlphaBounds(layer);
    const source = crop ? uc.cloneCanvasCrop(layer.canvas, crop) : layer.canvas;
    const blob = await new Promise((resolve, reject) => {
      source.toBlob((value) => (value ? resolve(value) : reject(new Error("PNG encoding failed"))), "image/png");
    });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    uc.setStatus("[VNCCS UniCanvas] Layer copied to clipboard.");
  } catch (err) {
    uc.setStatus(`[VNCCS UniCanvas] Clipboard copy failed: ${err.message || err}`, true);
  }
}

async function saveLayerAsImage(uc, layer) {
  try {
    uc.setStatus("[VNCCS UniCanvas] Saving layer image...");
    const crop = uc.getLayerAlphaBounds(layer);
    const source = crop ? uc.cloneCanvasCrop(layer.canvas, crop) : layer.canvas;
    // Route owned by a parallel branch: only call it (contract #1), with the
    // layer id in both the query string and the body for compatibility.
    const res = await fetch(`${SAVE_OUTPUT_ROUTE}?layer_id=${encodeURIComponent(layer.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layer_id: layer.id, name: layer.name, image: source.toDataURL("image/png") }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    uc.setStatus(`[VNCCS UniCanvas] Layer image saved to output/ (${data.filename || layer.name}).`);
  } catch (err) {
    uc.setStatus(`[VNCCS UniCanvas] Save layer failed: ${err.message || err}`, true);
  }
}

async function removeLayerBackground(uc, layer, method) {
  const label = method === "qi21" ? "Remove bg – QI2.1" : "Remove bg – BiRefNet";
  const crop = uc.getLayerAlphaBounds(layer);
  if (!crop) {
    uc.setStatus("[VNCCS UniCanvas] Remove bg: layer is empty.", true);
    return;
  }
  if (layer.locked) {
    uc.setStatus("[VNCCS UniCanvas] Remove bg: layer is locked.", true);
    return;
  }
  const before = uc.createLayerPixelSnapshot(layer);
  const source = uc.cloneCanvasCrop(layer.canvas, crop);
  uc.setStatus(`[VNCCS UniCanvas] ${label} running...`);
  try {
    const res = await fetch(REMOVE_BG_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: method === "qi21" ? "qi21" : "birefnet", image: source.toDataURL("image/png") }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    const alpha = await uc.loadImage(data.alpha);
    uc.materializeRasterLayerForEditing(layer);
    const ctx = layer.canvas.getContext("2d");
    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(alpha, 0, 0, alpha.width, alpha.height, crop.x, crop.y, crop.width, crop.height);
    ctx.restore();
    uc.markLayerPixelsChanged(layer, crop, false);
    // One-shot operation: exactly one layerPixels history entry.
    uc.pushHistoryEntry({
      kind: "layerPixels",
      layerId: layer.id,
      before,
      after: uc.createLayerPixelSnapshot(layer),
    });
    uc.refreshLayerRow(layer.id);
    uc.requestRender();
    uc.syncLightStateToWidget();
    uc.scheduleFullSync();
    uc.setStatus(`[VNCCS UniCanvas] ${label} complete.`);
  } catch (err) {
    uc.setStatus(`[VNCCS UniCanvas] ${label} failed: ${err.message || err}`, true);
  }
}

function buildColorMatchReference(uc, layer, crop) {
  const index = uc.layers.indexOf(layer);
  const below = uc.layers.slice(index + 1).filter((item) => item.visible);
  const pool = below.length ? below : uc.layers.filter((item) => item.visible && item.id !== layer.id);
  if (!pool.length) return null;
  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  const ctx = uc.configureImageContext(canvas.getContext("2d"));
  const worldRect = { x: uc.origin.x + crop.x, y: uc.origin.y + crop.y, width: crop.width, height: crop.height };
  for (const item of [...pool].reverse()) {
    ctx.save();
    ctx.globalAlpha = clamp(Number(item.opacity ?? 1), 0, 1);
    ctx.globalCompositeOperation = item.blendMode || "source-over";
    // Same hi-res-aware semantics as the base composite paths.
    uc.drawRasterLayerToWorldRect(ctx, item, worldRect, { x: 0, y: 0, width: crop.width, height: crop.height });
    ctx.restore();
  }
  return canvas;
}

async function requestColorMatch(targetCanvas, referenceCanvas, method, strength) {
  const res = await fetch(COLOR_MATCH_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image: targetCanvas.toDataURL("image/png"),
      reference: referenceCanvas.toDataURL("image/png"),
      method,
      strength,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data.image;
}

function applyColorMatchPreview(uc, preview, resultImage) {
  const { layer, crop } = preview;
  uc.materializeRasterLayerForEditing(layer);
  const ctx = layer.canvas.getContext("2d");
  ctx.clearRect(crop.x, crop.y, crop.width, crop.height);
  uc.configureImageContext(ctx).drawImage(resultImage, crop.x, crop.y, crop.width, crop.height);
  uc.markLayerPixelsChanged(layer, crop, false);
  uc.refreshLayerRow(layer.id);
  uc.requestRender();
}

function commitColorMatchPreview(uc, preview) {
  if (!preview.gestureBefore) return;
  uc.pushHistoryEntry({
    kind: "layerPixels",
    layerId: preview.layer.id,
    before: preview.gestureBefore,
    after: uc.createLayerPixelSnapshot(preview.layer),
  });
  preview.gestureBefore = null;
  preview.commitRequested = false;
  uc.syncLightStateToWidget();
  uc.scheduleFullSync();
  uc.setStatus("[VNCCS UniCanvas] Color match committed.");
}

function finishColorMatchGesture(uc, preview) {
  // End of one gesture: record exactly one layerPixels entry, waiting for the
  // newest preview first so no pixel change is ever left unrecorded.
  if (!preview.gestureBefore) return;
  if (preview.rafId || preview.inFlight) {
    preview.commitRequested = true;
    return;
  }
  commitColorMatchPreview(uc, preview);
}

function scheduleColorMatchPreview(uc, preview, strength, commit) {
  preview.pendingStrength = strength;
  if (commit) preview.commitRequested = true;
  if (preview.rafId) return;
  // Coalesce per-frame work; the newest slider value always wins.
  preview.rafId = requestAnimationFrame(() => {
    preview.rafId = 0;
    runColorMatchPreview(uc, preview);
  });
}

async function runColorMatchPreview(uc, preview) {
  if (preview.closed) return;
  if (preview.inFlight) {
    // One round trip at a time; the newest value reruns on completion.
    preview.rerunNeeded = true;
    return;
  }
  const strength = preview.pendingStrength;
  preview.seq += 1;
  const seq = preview.seq;
  preview.inFlight = true;
  if (!preview.gestureBefore) preview.gestureBefore = uc.createLayerPixelSnapshot(preview.layer);
  try {
    const resultURL = await requestColorMatch(preview.targetBase, preview.referenceBase, preview.method, strength);
    const resultImage = await uc.loadImage(resultURL);
    if (preview.closed || seq !== preview.seq) return; // stale preview dropped; newest value wins
    applyColorMatchPreview(uc, preview, resultImage);
  } catch (err) {
    if (!preview.closed && seq === preview.seq) {
      uc.setStatus(`[VNCCS UniCanvas] Color match failed: ${err.message || err}`, true);
    }
  } finally {
    preview.inFlight = false;
    if (preview.closed) return;
    if (preview.rerunNeeded) {
      preview.rerunNeeded = false;
      runColorMatchPreview(uc, preview);
      return;
    }
    // Commit whatever the gesture produced - even after a failed preview - so
    // changed pixels never end up without a history entry.
    if (preview.commitRequested) {
      preview.commitRequested = false;
      commitColorMatchPreview(uc, preview);
    }
  }
}

function closeColorMatchPreview(uc, commit) {
  const preview = uc._vnccsColorMatch;
  if (!preview) return;
  uc._vnccsColorMatch = null;
  preview.closed = true;
  preview.seq += 1; // drop any in-flight preview (stale preview dropped)
  if (preview.rafId) cancelAnimationFrame(preview.rafId);
  if (preview.gestureBefore) {
    if (commit) {
      // Closing with commit=true still records the pending gesture.
      commitColorMatchPreview(uc, preview);
    } else {
      // Closing mid-gesture discards the uncommitted scratch preview.
      uc.restoreLayerPixelSnapshot(preview.layer, preview.gestureBefore);
      preview.gestureBefore = null;
      uc.refreshLayerRow(preview.layer.id);
      uc.requestRender();
    }
  }
  preview.element?.remove();
}

function openColorMatchPopover(uc, layer) {
  closeColorMatchPreview(uc, false);
  const crop = uc.getLayerAlphaBounds(layer);
  if (!crop) {
    uc.setStatus("[VNCCS UniCanvas] Color match to below: layer is empty.", true);
    return;
  }
  const referenceBase = buildColorMatchReference(uc, layer, crop);
  if (!referenceBase) {
    uc.setStatus("[VNCCS UniCanvas] Color match to below needs a visible reference layer.", true);
    return;
  }
  const targetBase = uc.cloneCanvasCrop(layer.canvas, crop);
  const element = document.createElement("div");
  element.className = "vnccs-uc-color-match-popover";
  element.style.cssText = "position:absolute; z-index:30; min-width:220px; padding:10px; border-radius:10px; background:rgba(20,16,30,.96); border:1px solid rgba(255,255,255,.12); color:#e8e8f0; font:11px sans-serif; display:grid; gap:8px;";
  const methodOptions = COLOR_MATCH_METHODS
    .map((method) => `<option value="${method}">${method}</option>`)
    .join("");
  element.innerHTML = `
    <div style="font-weight:600;">Color match to below</div>
    <label style="display:grid; gap:4px;">Method
      <select class="vnccs-uc-select" data-control="colorMatchMethod">${methodOptions}</select>
    </label>
    <label style="display:grid; gap:4px;">Strength <span data-color-match-readout>10.0</span>
      <input class="vnccs-uc-range" type="range" min="0" max="${COLOR_MATCH_STRENGTH_MAX}" step="0.1" value="${COLOR_MATCH_STRENGTH_MAX}" data-control="colorMatchStrength">
    </label>
    <button class="vnccs-uc-btn" type="button" data-control="colorMatchClose">Close</button>`;
  uc.container.appendChild(element);
  element.style.left = "24px";
  element.style.top = "48px";

  const preview = {
    element,
    layer,
    crop,
    targetBase,
    referenceBase,
    method: COLOR_MATCH_METHODS[0],
    seq: 0,
    rafId: 0,
    inFlight: false,
    rerunNeeded: false,
    closed: false,
    pendingStrength: COLOR_MATCH_STRENGTH_MAX,
    commitRequested: false,
    gestureBefore: null,
  };
  uc._vnccsColorMatch = preview;

  const methodSelect = element.querySelector('[data-control="colorMatchMethod"]');
  const strengthInput = element.querySelector('[data-control="colorMatchStrength"]');
  const readout = element.querySelector("[data-color-match-readout]");
  const closeBtn = element.querySelector('[data-control="colorMatchClose"]');

  methodSelect.addEventListener("change", () => {
    preview.method = methodSelect.value;
    if (!preview.gestureBefore) preview.gestureBefore = uc.createLayerPixelSnapshot(layer);
    scheduleColorMatchPreview(uc, preview, Number(strengthInput.value), true);
  });
  strengthInput.addEventListener("input", () => {
    const strength = clamp(Number(strengthInput.value), 0, COLOR_MATCH_STRENGTH_MAX);
    readout.textContent = strength.toFixed(1);
    if (!preview.gestureBefore) preview.gestureBefore = uc.createLayerPixelSnapshot(layer);
    // Live preview on the scratch copy while dragging (realtime rule).
    scheduleColorMatchPreview(uc, preview, strength, false);
  });
  strengthInput.addEventListener("pointerup", () => {
    // Release commits the current gesture as one history entry.
    finishColorMatchGesture(uc, preview);
  });
  strengthInput.addEventListener("change", () => {
    // Keyboard-only adjustments fire no pointerup; change also ends a gesture.
    finishColorMatchGesture(uc, preview);
  });
  closeBtn.addEventListener("click", () => closeColorMatchPreview(uc, true));
}

function closeLayerContextMenu(uc) {
  uc._vnccsLayerMenu?.remove();
  uc._vnccsLayerMenu = null;
}

function openLayerContextMenu(uc, layer, e) {
  closeLayerContextMenu(uc);
  closeColorMatchPreview(uc, false);
  const menu = document.createElement("div");
  menu.className = "vnccs-uc-layer-menu";
  menu.style.cssText = `position:absolute; z-index:40; min-width:230px; padding:6px; border-radius:10px; background:rgba(20,16,30,.97); border:1px solid rgba(255,255,255,.12); display:grid; gap:2px; font:11px sans-serif;`;
  for (const item of LAYER_MENU_ITEMS) {
    if (item.poseOnly && layer.type !== "pose") continue;
    const entry = document.createElement("button");
    entry.type = "button";
    entry.textContent = item.label;
    entry.style.cssText = "text-align:left; padding:6px 10px; border:0; border-radius:6px; background:transparent; color:#e8e8f0; cursor:pointer;";
    entry.addEventListener("pointerenter", () => { entry.style.background = "rgba(255,255,255,.08)"; });
    entry.addEventListener("pointerleave", () => { entry.style.background = "transparent"; });
    entry.addEventListener("click", () => {
      closeLayerContextMenu(uc);
      runLayerMenuAction(uc, layer, item);
    });
    menu.appendChild(entry);
  }
  const rect = uc.container.getBoundingClientRect();
  menu.style.left = `${clamp(e.clientX - rect.left, 4, Math.max(4, rect.width - 240))}px`;
  menu.style.top = `${clamp(e.clientY - rect.top, 4, Math.max(4, rect.height - 40))}px`;
  uc.container.appendChild(menu);
  uc._vnccsLayerMenu = menu;
}

function runLayerMenuAction(uc, layer, item) {
  if (item.id === "copy-clipboard") return copyLayerToClipboard(uc, layer);
  if (item.id === "save-image") return saveLayerAsImage(uc, layer);
  if (item.id === "remove-bg-qi21") return removeLayerBackground(uc, layer, "qi21");
  if (item.id === "remove-bg-birefnet") return removeLayerBackground(uc, layer, "birefnet");
  if (item.id === "color-match") return openColorMatchPopover(uc, layer);
  if (item.id === "rasterize") {
    // Method provided by a parallel branch (contract #2).
    if (typeof uc.rasterizePoseLayer === "function") return uc.rasterizePoseLayer(layer);
    uc.setStatus(POSE_TOOLS_UNAVAILABLE);
    return undefined;
  }
  if (item.id === "edit-pose") {
    // Method provided by a parallel branch (contract #2).
    if (typeof uc.editPoseLayer === "function") return uc.editPoseLayer(layer);
    uc.setStatus(POSE_TOOLS_UNAVAILABLE);
    return undefined;
  }
  return undefined;
}

export function installUniCanvasLayerTools(uc) {
  if (!uc || uc._vnccsLayerToolsInstalled) return uc;
  uc._vnccsLayerToolsInstalled = true;

  const footer = uc.flattenLayersFooter;
  if (footer) {
    const psdInput = document.createElement("input");
    psdInput.type = "file";
    psdInput.accept = ".psd,application/octet-stream";
    psdInput.style.display = "none";
    psdInput.addEventListener("change", () => {
      importPSDFile(uc, psdInput.files?.[0]);
      psdInput.value = "";
    });
    uc.container.appendChild(psdInput);
    const importButton = uc._button("Import PSD", "vnccs-uc-btn", () => psdInput.click(), "Import layers from a PSD file");
    const exportButton = [...footer.querySelectorAll("button")].find((btn) => btn.textContent.trim() === "Export Layers as PSD") || null;
    // "Import PSD" sits right next to the existing "Export Layers as PSD".
    footer.insertBefore(importButton, exportButton || null);
  }

  uc.layerList.addEventListener("contextmenu", (e) => {
    const row = e.target.closest?.("[data-layer-id]");
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    const layer = uc.layers.find((item) => item.id === row.dataset.layerId);
    if (!layer) return;
    openLayerContextMenu(uc, layer, e);
  });

  const onDocumentPointerDown = (e) => {
    if (uc._vnccsLayerMenu && !uc._vnccsLayerMenu.contains(e.target)) closeLayerContextMenu(uc);
  };
  const onDocumentKeyDown = (e) => {
    if (e.key !== "Escape") return;
    if (uc._vnccsLayerMenu) closeLayerContextMenu(uc);
    else if (uc._vnccsColorMatch) closeColorMatchPreview(uc, false);
  };
  // The base widget wires its AbortController in _attachEvents (after this
  // installer runs), so bind on the next microtask and tie the listeners to
  // the widget's dispose signal.
  queueMicrotask(() => {
    if (uc._disposed) return;
    const options = { signal: uc._eventAbortController?.signal };
    document.addEventListener("pointerdown", onDocumentPointerDown, options);
    document.addEventListener("keydown", onDocumentKeyDown, options);
  });

  return uc;
}
