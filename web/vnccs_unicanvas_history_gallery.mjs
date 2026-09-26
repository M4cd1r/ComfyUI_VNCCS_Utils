/**
 * VNCCS UniCanvas - generation history (Plan 10.5).
 *
 * Every generation-like run writes one record into the attached project
 * (`/vnccs/unicanvas/projects/{id}/history`, nodes/unicanvas/history.py) when it settles: the kind,
 * scene, target layer, timing, the full settings snapshot, 256 px input thumbnails and ALL its
 * results (staged images, discarded ones included) as content-addressed blobs. Accepting a staged
 * result flags it `accepted` with the layer it became; undoing the accept clears the flag again.
 *
 * The History gallery (a button next to the Library tab) lists the records newest first with filters
 * (scene, kind, accepted only, model family, prompt text) and per record: Restore settings (one
 * undo entry), Re-run with the same or a new seed, Place any result as a layer, Show the layer a
 * result became, and an A/B compare slider between two results.
 *
 * The widget only calls installUniCanvasHistory() and a few `widget.generationHistory?.` hooks.
 */

import { installCustomSelects } from "./vnccs_custom_select.mjs";
import { isUniCanvasFamilyEnabled } from "./vnccs_unicanvas_feature_toggles.mjs";
import { blobUrl, dehydrateValue } from "./vnccs_unicanvas_project.mjs";
import { createLayerMeta, metaFromStagingSnapshot } from "./vnccs_unicanvas_provenance.mjs";

export const HISTORY_KINDS = Object.freeze(["generate", "bake", "sprite", "harmonize", "remove_bg", "color_match"]);
export const HISTORY_KIND_LABELS = Object.freeze({
  generate: "Generate", bake: "Bake", sprite: "Sprite", harmonize: "Harmonize", remove_bg: "Remove bg", color_match: "Color match",
});
export const HISTORY_SETTINGS_HISTORY_KIND = "historyRestoreSettings";
export const HISTORY_THUMBNAIL_SIZE = 256;
export const DEFAULT_HISTORY_MAX_RECORDS = 1000;
export const DEFAULT_HISTORY_MAX_BYTES = 4 * 1024 ** 3;
// Transient keys that describe one queued draw, not the user's settings.
const TRANSIENT_SETTINGS = new Set(["queued_draw", "draw_id"]);
const STYLE_ID = "vnccs-unicanvas-history-styles";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** A deep copy of the widget settings without the per-draw transient keys. */
export function historySettingsSnapshot(settings = {}) {
  const out = {};
  for (const [key, value] of Object.entries(settings || {})) {
    if (TRANSIENT_SETTINGS.has(key) || typeof value === "function") continue;
    out[key] = value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value;
  }
  return out;
}

function rectOf(value) {
  if (!value || typeof value !== "object") return null;
  const rect = { x: Number(value.x) || 0, y: Number(value.y) || 0, width: Number(value.width) || 0, height: Number(value.height) || 0 };
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

function sizeOf(value) {
  if (!value || typeof value !== "object") return null;
  const width = Math.round(Number(value.width) || 0);
  const height = Math.round(Number(value.height) || 0);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The JSON record a run writes (pixel fields still as data URLs; dehydrated before upload). */
export function buildHistoryRecord({
  kind, id, sceneId = null, targetLayerId = null, startedAt, finishedAt, settings = {}, snapshot = null,
  configLinked = false, inferenceSize = null, outputSize = null, bbox = null, mode = "", params = null, inputs = {}, results = [], error = "",
} = {}) {
  if (!HISTORY_KINDS.includes(kind)) throw new Error(`Unknown history kind: ${kind}`);
  const started = Number(startedAt) || Date.now();
  const finished = Number(finishedAt) || started;
  const cleanSettings = historySettingsSnapshot(settings);
  return {
    id,
    kind,
    sceneId: sceneId || null,
    targetLayerId: targetLayerId || null,
    createdAt: started / 1000,
    durationMs: Math.max(0, Math.round(finished - started)),
    status: error ? "error" : "ok",
    error: error ? String(error).slice(0, 2000) : "",
    settings: cleanSettings,
    snapshot: snapshot ? JSON.parse(JSON.stringify(snapshot)) : null,
    loras: Array.isArray(cleanSettings.lora_stack) ? cleanSettings.lora_stack.filter((item) => item?.name) : [],
    presetId: cleanSettings.selected_preset_id || null,
    configLinked: Boolean(configLinked),
    inferenceSize: sizeOf(inferenceSize),
    outputSize: sizeOf(outputSize),
    bbox: rectOf(bbox),
    mode: mode || "",
    params: params && typeof params === "object" ? JSON.parse(JSON.stringify(params)) : null,
    inputs: Object.fromEntries(Object.entries(inputs || {}).filter(([, value]) => typeof value === "string" && value)),
    results: (results || []).map((item, index) => ({
      index,
      imageDataURL: item.imageDataURL,
      accepted: item.accepted === true,
      layerId: item.layerId || null,
      seed: Number.isFinite(item.seed) ? item.seed : null,
      width: sizeOf(item)?.width ?? null,
      height: sizeOf(item)?.height ?? null,
      rect: rectOf(item.rect),
    })),
  };
}

/**
 * The history item of a result that was applied without staging (Bake characters, Generate
 * missing sprites): it is recorded accepted, as the layer it went into.
 */
export function autoAcceptedHistoryItem({ img, seed, rect, layerId }) {
  return { img, snapshot: { seed }, bbox: rect ? { ...rect } : null, accepted: true, layerId: layerId || null };
}

export function recordPrompt(record) {
  return String(record?.snapshot?.prompt ?? record?.settings?.positive ?? "");
}

export function recordFamily(record) {
  return String(record?.snapshot?.modelFamily || record?.settings?.generation_mode || "");
}

export function recordSeed(record, index = null) {
  const result = index === null ? null : record?.results?.[index];
  const seed = result?.seed ?? record?.snapshot?.seed ?? record?.settings?.seed;
  return Number.isFinite(Number(seed)) && seed !== null && seed !== "" ? Number(seed) : null;
}

/** Records matching the gallery filters, newest first. */
export function filterHistoryRecords(records, { sceneId = "", kind = "", acceptedOnly = false, family = "", text = "" } = {}) {
  const needle = String(text || "").trim().toLowerCase();
  return (records || [])
    .filter((record) => !sceneId || record.sceneId === sceneId)
    .filter((record) => !kind || record.kind === kind)
    .filter((record) => !acceptedOnly || (record.results || []).some((item) => item.accepted))
    .filter((record) => !family || recordFamily(record) === family)
    .filter((record) => {
      if (!needle) return true;
      const haystack = `${recordPrompt(record)}\n${record?.snapshot?.negative ?? record?.settings?.negative ?? ""}`.toLowerCase();
      return haystack.includes(needle);
    })
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

/**
 * The distinct model families of `records`, for the family filter. `isEnabled` drops families
 * switched off in Settings > VNCCS > UniCanvas; their records stay listed under "All models".
 */
export function historyFamilies(records, isEnabled = () => true) {
  return [...new Set((records || []).map(recordFamily).filter(Boolean))].filter((family) => isEnabled(family)).sort();
}

/** Settings to apply for Restore / Re-run: the snapshot over the current settings. */
export function restoredSettings(current, record, overrides = {}) {
  const next = { ...historySettingsSnapshot(current), ...historySettingsSnapshot(record?.settings || {}) };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value !== undefined && value !== null) next[key] = value;
  }
  return next;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function newRecordId() {
  return `gen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function canvasDataURL(source, maxSide = null) {
  if (typeof document === "undefined" || !source) return "";
  const width = Math.max(1, source.naturalWidth || source.width || 0);
  const height = Math.max(1, source.naturalHeight || source.height || 0);
  const scale = maxSide ? Math.min(1, maxSide / Math.max(width, height)) : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** One run in flight: `finish*` / `fail` write its record once. */
class HistoryRun {
  constructor(history, kind, fields) {
    this.history = history;
    this.kind = kind;
    this.fields = fields;
    this.id = fields.id || newRecordId();
    this.startedAt = history.now();
    this.done = false;
  }

  /** A generate run settled with its staged items (they learn their record and result index). */
  finish(items = []) {
    if (this.done) return null;
    this.done = true;
    return this.safely(() => this.history.write(this, { results: this.collect(items) }));
  }

  // Recording must never break the run it records.
  safely(work) {
    try {
      return work();
    } catch (err) {
      console.warn("[VNCCS UniCanvas] Recording the history record failed", err);
      return null;
    }
  }

  collect(items) {
    return items.map((item, index) => {
      item.historyId = this.id;
      item.historyIndex = index;
      return {
        imageDataURL: item.imageDataURL || canvasDataURL(item.img),
        // Auto-accepted results (Bake characters, Generate missing sprites) know their layer already.
        accepted: item.accepted === true,
        layerId: item.accepted === true ? item.layerId || null : null,
        seed: item.snapshot?.seed,
        width: item.img?.naturalWidth || item.img?.width || item.displaySize?.width,
        height: item.img?.naturalHeight || item.img?.height || item.displaySize?.height,
        rect: item.bbox || this.fields.bbox,
      };
    });
  }

  /** An in-place layer run (remove_bg, color_match): its one result is the layer's new pixels. */
  finishLayer(layer, crop = null) {
    if (this.done) return null;
    this.done = true;
    return this.safely(() => this.writeLayer(layer, crop));
  }

  writeLayer(layer, crop) {
    const widget = this.history.widget;
    const bounds = crop || widget.getLayerAlphaBounds?.(layer);
    let imageDataURL = "";
    if (bounds && layer?.canvas) {
      const cropped = widget.cloneCanvasCrop ? widget.cloneCanvasCrop(layer.canvas, bounds) : layer.canvas;
      imageDataURL = canvasDataURL(cropped);
    }
    const rect = bounds ? { x: (widget.origin?.x || 0) + bounds.x, y: (widget.origin?.y || 0) + bounds.y, width: bounds.width, height: bounds.height } : null;
    const results = imageDataURL ? [{ imageDataURL, accepted: true, layerId: layer.id, width: bounds.width, height: bounds.height, rect }] : [];
    return this.history.write(this, { results, bbox: rect });
  }

  fail(error) {
    if (this.done) return null;
    this.done = true;
    return this.safely(() => this.history.write(this, { results: [], error: error?.message || String(error || "Failed") }));
  }
}

export class UniCanvasHistory {
  constructor(widget, { now, digest, modelModule } = {}) {
    this.widget = widget;
    this.modelModule = typeof modelModule === "function" ? modelModule : null;
    this.now = now || (() => Date.now());
    this.digest = digest || null;
    this.pending = new Map();
    this.listeners = new Set();
  }

  get session() {
    return this.widget?.projectSession || null;
  }

  get available() {
    return Boolean(this.session?.active && this.session.attached);
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) {
      try { listener(this); } catch (err) { console.warn("[VNCCS UniCanvas] History listener failed", err); }
    }
  }

  request(method, path, options) {
    return this.session.request(method, `${this.session.projectPath()}/history${path}`, options);
  }

  /**
   * Starts recording a run. `fields`: settings (cloned now, so edits during the run do not leak
   * in), snapshot, bbox, mode, inferenceSize, outputSize, configLinked, targetLayerId, and the
   * input canvases `imageCanvas` / `maskCanvas` (thumbnailed to 256 px now).
   */
  beginRun(kind, fields = {}) {
    if (!this.available) return null;
    const { imageCanvas, maskCanvas, ...rest } = fields;
    const inputs = {};
    try {
      if (imageCanvas) inputs.imageDataURL = canvasDataURL(imageCanvas, HISTORY_THUMBNAIL_SIZE);
      if (maskCanvas) inputs.maskDataURL = canvasDataURL(maskCanvas, HISTORY_THUMBNAIL_SIZE);
    } catch (err) {
      console.warn("[VNCCS UniCanvas] History input thumbnails failed", err);
    }
    return new HistoryRun(this, kind, {
      ...rest,
      id: rest.snapshot?.historyId || rest.id,
      settings: historySettingsSnapshot(rest.settings || this.widget.settings),
      sceneId: this.session.sceneId,
      projectId: this.session.projectId,
      targetLayerId: rest.targetLayerId ?? this.widget.activeLayerId ?? null,
      inputs,
    });
  }

  write(run, { results, error = "", bbox }) {
    const fields = run.fields;
    const record = buildHistoryRecord({
      ...fields,
      kind: run.kind,
      id: run.id,
      bbox: bbox || fields.bbox,
      startedAt: run.startedAt,
      finishedAt: this.now(),
      results,
      error,
    });
    const promise = this.upload(fields.projectId, record).then((data) => {
      this.emit();
      return data?.record || null;
    }).catch((err) => {
      console.warn("[VNCCS UniCanvas] Saving the history record failed", err);
      return null;
    });
    this.pending.set(run.id, promise);
    return promise;
  }

  async upload(projectId, record) {
    const session = this.session;
    if (!session || session.projectId !== projectId) return null;
    const blobs = new Map();
    const stored = await dehydrateValue(record, blobs, this.digest || session.digest);
    for (const [sha, bytes] of blobs) {
      if (session.knownBlobs?.has(sha)) continue;
      await session.request("PUT", `${session.projectPath(projectId)}/blobs/${sha}`, { body: bytes, headers: { "Content-Type": "image/png" } });
      session.knownBlobs?.add(sha);
    }
    const data = await session.request("POST", `${session.projectPath(projectId)}/history`, { json: stored });
    // Pruning may have deleted blobs this tab believes are stored: forget them so they upload again.
    for (const sha of data?.pruned?.blobs || []) session.knownBlobs?.delete(sha);
    return data;
  }

  async patchResult(historyId, index, change) {
    if (!historyId || !Number.isInteger(index) || !this.available) return null;
    const projectId = this.session.projectId;
    await this.pending.get(historyId);
    if (this.session?.projectId !== projectId) return null;
    try {
      const record = await this.request("PATCH", `/${encodeURIComponent(historyId)}`, { json: { results: [{ index, ...change }] } });
      this.emit();
      return record;
    } catch (err) {
      console.warn("[VNCCS UniCanvas] Updating the history record failed", err);
      return null;
    }
  }

  /** Hook: a staged result became `layer`. */
  onStagingAccepted(item, layer) {
    if (!item?.historyId) return null;
    return this.patchResult(item.historyId, item.historyIndex, { accepted: true, layerId: layer?.id || null });
  }

  /**
   * Hook: a history entry that accepted a staged result (`entry.acceptedItem`) was undone or
   * redone: acceptStaging (a new layer) or layerPixels (a bake, sprite or harmonize result written
   * into its own layer).
   */
  onAcceptHistory(entry, direction) {
    const item = entry?.acceptedItem;
    if (!item?.historyId) return null;
    return direction === "undo"
      ? this.patchResult(item.historyId, item.historyIndex, { accepted: false, layerId: null })
      : this.patchResult(item.historyId, item.historyIndex, { accepted: true, layerId: entry.layer?.id || entry.layerId || null });
  }

  /**
   * Accepting a staged result into an existing layer (bake, sprite, harmonize): the pixels entry
   * carries the staged item so undo / redo flip the record's accept flag, and the record learns the
   * layer now.
   */
  acceptIntoLayer(entry, staging, layer) {
    if (!entry || !staging?.historyId) return entry;
    void this.onStagingAccepted(staging, layer);
    return { ...entry, acceptedItem: staging };
  }

  /** The family registry key of a recorded generation_mode (aliases resolved by the widget). */
  familyKey(family) {
    const key = this.modelModule?.(family)?.key;
    return key || family;
  }

  // -- gallery actions -------------------------------------------------------------------------

  async listRecords() {
    if (!this.available) return { records: [], settings: null, usage: null };
    return this.request("GET", "");
  }

  resultUrl(result) {
    return result?.imageDataURL?.blob ? blobUrl(this.session.projectId, result.imageDataURL) : "";
  }

  inputUrl(record, key = "imageDataURL") {
    const ref = record?.inputs?.[key];
    return ref?.blob ? blobUrl(this.session.projectId, ref) : "";
  }

  /** Applies the record's settings to the panel as ONE undo entry. */
  restoreSettings(record, overrides = {}) {
    const widget = this.widget;
    const before = historySettingsSnapshot(widget.settings);
    const after = restoredSettings(widget.settings, record, overrides);
    widget.applySerializedSettings(after);
    widget.pushHistoryEntry({ kind: HISTORY_SETTINGS_HISTORY_KIND, before, after });
    widget.syncSettingsToWidget?.();
    widget.setStatus?.("Settings restored from history");
    return after;
  }

  /** Hook from applyHistoryEntry. */
  applySettingsHistory(entry, direction) {
    this.widget.applySerializedSettings(direction === "undo" ? entry.before : entry.after);
    this.widget.syncSettingsToWidget?.();
  }

  /** Restores the settings and bbox of a generate record and generates again. */
  async rerun(record, { newSeed = false } = {}) {
    const widget = this.widget;
    if (record?.kind !== "generate") throw new Error("Only generate runs can be re-run");
    if (widget.drawInProgress) throw new Error("A generation is already running");
    const seed = newSeed ? widget.generateRandomSeed() : recordSeed(record);
    const seedMode = record.settings?.seed_mode ?? widget.settings.seed_mode;
    // The seed is chosen here, so draw() must not randomize it; the recorded seed mode comes back after.
    this.restoreSettings(record, { seed, seed_mode: "fixed" });
    if (record.bbox && !widget.panorama) widget.bbox = { ...record.bbox };
    widget.syncPromptControls?.();
    widget.requestRender?.();
    try {
      await widget.draw();
    } finally {
      if (seedMode !== undefined) widget.settings.seed_mode = seedMode;
      widget.syncSeedModeControl?.();
      widget.syncSettingsToWidget?.();
    }
  }

  /** Places result `index` of `record` as a new layer (discarded results too). */
  async placeResult(record, index) {
    const widget = this.widget;
    const result = record?.results?.[index];
    if (!result) throw new Error("No such result");
    if (widget.panorama) throw new Error("History results cannot be placed into a panorama");
    const img = await widget.loadImage(this.resultUrl(result));
    const rect = result.rect || record.bbox || {
      x: widget.bbox.x, y: widget.bbox.y, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height,
    };
    const placement = widget.normalizeLayerWorldRect ? widget.normalizeLayerWorldRect(rect) : rect;
    if (!widget.ensureWorldBounds(placement.x + placement.width, placement.y + placement.height, 128)) return null;
    if (!widget.ensureWorldBounds(placement.x, placement.y, 128)) return null;
    const previousActiveLayerId = widget.activeLayerId;
    const meta = record.kind === "generate" && record.snapshot
      ? metaFromStagingSnapshot({ ...record.snapshot, seed: result.seed ?? record.snapshot.seed })
      : createLayerMeta("import", { sourceName: `History: ${HISTORY_KIND_LABELS[record.kind] || record.kind}`, historyId: record.id });
    const layer = widget.addLayer("raster", null, false, true, meta);
    const hires = document.createElement("canvas");
    hires.width = Math.max(1, img.naturalWidth || img.width);
    hires.height = Math.max(1, img.naturalHeight || img.height);
    widget.configureImageContext(hires.getContext("2d")).drawImage(img, 0, 0);
    layer.hiresCanvas = hires;
    layer.hiresRect = { ...placement };
    widget.configureImageContext(layer.canvas.getContext("2d"))
      .drawImage(hires, placement.x - widget.origin.x, placement.y - widget.origin.y, placement.width, placement.height);
    widget.invalidateLayerCaches(layer);
    widget.pushHistoryEntry({ kind: "addLayer", layer, previousActiveLayerId });
    widget.renderLayerList();
    widget.requestRender();
    widget.syncLightStateToWidget();
    widget.scheduleFullSync?.();
    widget.setStatus?.("History result placed as a layer");
    if (record.sceneId === this.session?.sceneId) void this.patchResult(record.id, index, { accepted: true, layerId: layer.id });
    return layer;
  }

  /** Selects the layer a result became, switching scenes when needed. */
  async showLayer(record, index) {
    const widget = this.widget;
    const layerId = record?.results?.[index]?.layerId;
    if (!layerId) throw new Error("This result was not placed as a layer");
    if (record.sceneId && record.sceneId !== this.session?.sceneId) {
      if (!(await this.session.switchScene(record.sceneId))) throw new Error("Could not open the scene of this result");
    }
    if (!widget.layers.some((layer) => layer.id === layerId)) throw new Error("The layer from this result was deleted");
    widget.setActiveLayer(layerId);
    widget.renderLayerList?.();
    return layerId;
  }

  async deleteRecord(record) {
    await this.request("DELETE", `/${encodeURIComponent(record.id)}`);
    this.emit();
  }

  /** Saves the retention caps into the project settings and prunes. */
  async setRetention({ maxRecords, maxBytes }) {
    const session = this.session;
    const settings = { ...(session.project?.settings || {}) };
    settings.history = { maxRecords: Math.max(1, Math.round(maxRecords)), maxBytes: Math.max(1, Math.round(maxBytes)) };
    const project = await session.request("PATCH", session.projectPath(), { json: { settings } });
    if (project?.id === session.projectId) session.project = { ...session.project, settings: project.settings };
    const pruned = await this.request("POST", "/prune");
    for (const sha of pruned?.blobs || []) session.knownBlobs?.delete(sha);
    this.emit();
    return pruned;
  }
}

// ---------------------------------------------------------------------------
// UI: History button, gallery and compare view
// ---------------------------------------------------------------------------

const STYLES = `
.vnccs-uc-project-bar .vnccs-uc-history-open { height:24px !important; padding:0 8px !important; font-size:12px; align-self:flex-start; }
.vnccs-uc-modal.vnccs-uc-history-gallery { width:min(980px, 94%); max-height:88%; display:flex; flex-direction:column; gap:10px; }
.vnccs-uc-history-filters { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.vnccs-uc-history-filters input[type="search"] { flex:1 1 160px; min-width:100px; }
.vnccs-uc-history-filters label { display:flex; gap:4px; align-items:center; color:var(--uc-text); font-size:12px; }
.vnccs-uc-history-body { display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 340px); gap:10px; min-height:200px; overflow:hidden; }
.vnccs-uc-history-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:8px; overflow:auto; align-content:start; }
.vnccs-uc-history-card { display:flex; flex-direction:column; gap:4px; padding:6px; border-radius:10px; border:1px solid var(--uc-border); background:var(--uc-surface); cursor:pointer; text-align:left; color:var(--uc-text); font:inherit; }
.vnccs-uc-history-card.selected { border-color:var(--uc-accent); }
.vnccs-uc-history-card.failed { border-color:var(--uc-danger); }
.vnccs-uc-history-thumb { aspect-ratio:1/1; width:100%; border-radius:6px; object-fit:contain; background:repeating-conic-gradient(#2a2838 0% 25%, #1f1d2b 0% 50%) 50%/16px 16px; }
.vnccs-uc-history-meta { color:var(--uc-muted); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-uc-history-prompt { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-uc-history-detail { display:flex; flex-direction:column; gap:8px; overflow:auto; padding:6px; border-radius:10px; border:1px solid var(--uc-border); }
.vnccs-uc-history-actions { display:flex; flex-wrap:wrap; gap:4px; }
.vnccs-uc-history-actions .vnccs-uc-btn { height:26px; padding:0 8px; font-size:11px; }
.vnccs-uc-history-results { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:6px; }
.vnccs-uc-history-result { display:flex; flex-direction:column; gap:4px; padding:4px; border-radius:8px; border:1px solid var(--uc-border); }
.vnccs-uc-history-result.accepted { border-color:var(--uc-accent-2); }
.vnccs-uc-history-result.compare-a, .vnccs-uc-history-result.compare-b { outline:2px solid var(--uc-accent); }
.vnccs-uc-history-result .vnccs-uc-btn { height:22px; padding:0 6px; font-size:10px; }
.vnccs-uc-history-badge { font-size:10px; color:var(--uc-muted); }
.vnccs-uc-history-empty { color:var(--uc-muted); padding:12px; }
.vnccs-uc-history-retention { display:flex; flex-wrap:wrap; gap:6px; align-items:center; color:var(--uc-muted); font-size:11px; }
.vnccs-uc-history-retention input { width:80px; }
.vnccs-uc-history-compare { position:relative; width:100%; aspect-ratio:1/1; background:repeating-conic-gradient(#2a2838 0% 25%, #1f1d2b 0% 50%) 50%/16px 16px; border-radius:8px; overflow:hidden; }
.vnccs-uc-history-compare img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; }
.vnccs-uc-history-compare-divider { position:absolute; top:0; bottom:0; width:2px; background:var(--uc-accent); pointer-events:none; }
.vnccs-uc-modal.vnccs-uc-history-compare-modal { width:min(760px, 92%); display:flex; flex-direction:column; gap:8px; }
`;

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

function button(widget, label, className, onClick, title = label) {
  if (widget._button) return widget._button(label, className, onClick, title);
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.title = title;
  element.addEventListener("click", onClick);
  return element;
}

function option(value, label) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

function formatTime(seconds) {
  const date = new Date((Number(seconds) || 0) * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

async function runAction(widget, label, action) {
  try {
    return await action();
  } catch (err) {
    widget.setStatus?.(`[VNCCS UniCanvas] ${label} failed: ${err?.message || err}`, true);
    return null;
  }
}

/** A/B compare between two result URLs; the slider moves the split on every `input`. */
export function openHistoryCompare(widget, urlA, urlB) {
  widget.container.querySelector(".vnccs-uc-history-compare-modal")?.closest(".vnccs-uc-modal-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "vnccs-uc-modal-overlay";
  const modal = document.createElement("div");
  modal.className = "vnccs-uc-modal vnccs-uc-history-compare-modal";
  const title = document.createElement("div");
  title.className = "vnccs-uc-modal-title";
  title.textContent = "Compare results (A | B)";
  const view = document.createElement("div");
  view.className = "vnccs-uc-history-compare";
  const imageB = new Image();
  imageB.src = urlB;
  imageB.dataset.compare = "b";
  const imageA = new Image();
  imageA.src = urlA;
  imageA.dataset.compare = "a";
  const divider = document.createElement("div");
  divider.className = "vnccs-uc-history-compare-divider";
  view.append(imageB, imageA, divider);
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.step = "0.5";
  slider.value = "50";
  slider.className = "vnccs-uc-history-compare-slider";
  const apply = () => {
    const value = Math.max(0, Math.min(100, Number(slider.value) || 0));
    imageA.style.clipPath = `inset(0 ${100 - value}% 0 0)`;
    divider.style.left = `calc(${value}% - 1px)`;
  };
  slider.addEventListener("input", apply);
  // Dragging on the image itself moves the split too, continuously.
  const fromPointer = (event) => {
    const box = view.getBoundingClientRect();
    slider.value = String(((event.clientX - box.left) / Math.max(1, box.width)) * 100);
    apply();
  };
  view.addEventListener("pointerdown", (event) => {
    view.setPointerCapture?.(event.pointerId);
    fromPointer(event);
  });
  view.addEventListener("pointermove", (event) => {
    if (event.buttons & 1) fromPointer(event);
  });
  apply();
  const actions = document.createElement("div");
  actions.className = "vnccs-uc-modal-actions";
  actions.append(button(widget, "Close", "vnccs-uc-btn", () => overlay.remove()));
  modal.append(title, view, slider, actions);
  overlay.append(modal);
  overlay.addEventListener("pointerdown", (event) => { if (event.target === overlay) overlay.remove(); });
  widget.container.appendChild(overlay);
  return overlay;
}

/** The History gallery. */
export function openHistoryGallery(widget, history = widget.generationHistory) {
  if (!history || widget.container.querySelector(".vnccs-uc-history-gallery")) return null;
  if (!history.available) {
    widget.setStatus?.("[VNCCS UniCanvas] History needs an open project.", true);
    return null;
  }
  ensureStyles();
  const session = history.session;
  const overlay = document.createElement("div");
  overlay.className = "vnccs-uc-modal-overlay";
  const modal = document.createElement("div");
  modal.className = "vnccs-uc-modal vnccs-uc-history-gallery";
  const title = document.createElement("div");
  title.className = "vnccs-uc-modal-title";
  title.textContent = "History";

  const filters = document.createElement("div");
  filters.className = "vnccs-uc-history-filters";
  const sceneSelect = document.createElement("select");
  sceneSelect.className = "vnccs-uc-select";
  sceneSelect.dataset.historyFilter = "scene";
  const kindSelect = document.createElement("select");
  kindSelect.className = "vnccs-uc-select";
  kindSelect.dataset.historyFilter = "kind";
  kindSelect.append(option("", "All kinds"), ...HISTORY_KINDS.map((kind) => option(kind, HISTORY_KIND_LABELS[kind])));
  const familySelect = document.createElement("select");
  familySelect.className = "vnccs-uc-select";
  familySelect.dataset.historyFilter = "family";
  const acceptedLabel = document.createElement("label");
  const acceptedBox = document.createElement("input");
  acceptedBox.type = "checkbox";
  acceptedBox.dataset.historyFilter = "accepted";
  acceptedLabel.append(acceptedBox, document.createTextNode("Accepted only"));
  const search = document.createElement("input");
  search.type = "search";
  search.className = "vnccs-uc-input";
  search.placeholder = "Search prompts";
  search.dataset.historyFilter = "text";
  filters.append(sceneSelect, kindSelect, familySelect, acceptedLabel, search);

  const body = document.createElement("div");
  body.className = "vnccs-uc-history-body";
  const grid = document.createElement("div");
  grid.className = "vnccs-uc-history-grid";
  const detail = document.createElement("div");
  detail.className = "vnccs-uc-history-detail";
  body.append(grid, detail);

  const retention = document.createElement("div");
  retention.className = "vnccs-uc-history-retention";
  const usageText = document.createElement("span");
  const maxRecordsInput = document.createElement("input");
  maxRecordsInput.type = "number";
  maxRecordsInput.min = "1";
  maxRecordsInput.className = "vnccs-uc-input";
  maxRecordsInput.dataset.historyRetention = "records";
  const maxGbInput = document.createElement("input");
  maxGbInput.type = "number";
  maxGbInput.min = "0.01";
  maxGbInput.step = "0.1";
  maxGbInput.className = "vnccs-uc-input";
  maxGbInput.dataset.historyRetention = "gb";
  const saveRetention = button(widget, "Apply", "vnccs-uc-btn", () => runAction(widget, "History retention", async () => {
    const maxRecords = Number(maxRecordsInput.value) || DEFAULT_HISTORY_MAX_RECORDS;
    const maxBytes = (Number(maxGbInput.value) || DEFAULT_HISTORY_MAX_BYTES / 1024 ** 3) * 1024 ** 3;
    await history.setRetention({ maxRecords, maxBytes });
    await refresh();
  }), "Save the history caps for this project and prune");
  retention.append(usageText, document.createTextNode("Keep at most"), maxRecordsInput, document.createTextNode("records or"), maxGbInput, document.createTextNode("GB"), saveRetention);

  const actions = document.createElement("div");
  actions.className = "vnccs-uc-modal-actions";
  const close = () => {
    unsubscribe();
    selects?.disconnect?.();
    overlay.remove();
  };
  actions.append(button(widget, "Close", "vnccs-uc-btn", close));
  modal.append(title, filters, body, retention, actions);
  overlay.append(modal);
  overlay.addEventListener("pointerdown", (event) => { if (event.target === overlay) close(); });
  modal.addEventListener("keydown", (event) => {
    event.stopPropagation(); // typing in the filters must not trigger canvas shortcuts
    if (event.key === "Escape") close();
  });

  let records = [];
  let selectedId = null;
  let compare = [];

  const currentFilters = () => ({
    sceneId: sceneSelect.value, kind: kindSelect.value, family: familySelect.value, acceptedOnly: acceptedBox.checked, text: search.value,
  });

  const fillSelect = (select, entries, allLabel) => {
    const value = select.value;
    select.replaceChildren(option("", allLabel), ...entries.map(([key, label]) => option(key, label)));
    select.value = entries.some(([key]) => key === value) ? value : "";
  };

  const renderGrid = () => {
    const visible = filterHistoryRecords(records, currentFilters());
    grid.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "vnccs-uc-history-empty";
      empty.textContent = records.length ? "No runs match the filters." : "No runs recorded in this project yet.";
      grid.appendChild(empty);
    }
    for (const record of visible) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "vnccs-uc-history-card";
      card.dataset.historyId = record.id;
      card.classList.toggle("selected", record.id === selectedId);
      card.classList.toggle("failed", record.status === "error");
      const cover = (record.results || []).find((item) => item.accepted) || record.results?.[0];
      const thumb = new Image();
      thumb.className = "vnccs-uc-history-thumb";
      thumb.loading = "lazy";
      thumb.alt = "";
      const url = cover ? history.resultUrl(cover) : history.inputUrl(record);
      if (url) thumb.src = url;
      const prompt = document.createElement("div");
      prompt.className = "vnccs-uc-history-prompt";
      prompt.textContent = recordPrompt(record) || HISTORY_KIND_LABELS[record.kind] || record.kind;
      const accepted = (record.results || []).filter((item) => item.accepted).length;
      const meta = document.createElement("div");
      meta.className = "vnccs-uc-history-meta";
      meta.textContent = record.status === "error"
        ? `${HISTORY_KIND_LABELS[record.kind] || record.kind} · failed`
        : `${HISTORY_KIND_LABELS[record.kind] || record.kind} · ${(record.results || []).length} results · ${accepted} accepted`;
      const when = document.createElement("div");
      when.className = "vnccs-uc-history-meta";
      when.textContent = [formatTime(record.createdAt), recordFamily(record)].filter(Boolean).join(" · ");
      card.append(thumb, prompt, meta, when);
      card.addEventListener("click", () => {
        selectedId = record.id;
        compare = [];
        renderGrid();
        renderDetail();
      });
      grid.appendChild(card);
    }
  };

  const renderDetail = () => {
    detail.replaceChildren();
    const record = records.find((item) => item.id === selectedId);
    if (!record) {
      const hint = document.createElement("div");
      hint.className = "vnccs-uc-history-empty";
      hint.textContent = "Select a run to see its results.";
      detail.appendChild(hint);
      return;
    }
    detail.dataset.historyId = record.id;
    const heading = document.createElement("div");
    heading.className = "vnccs-uc-history-prompt";
    heading.textContent = recordPrompt(record) || HISTORY_KIND_LABELS[record.kind] || record.kind;
    heading.title = recordPrompt(record);
    const info = document.createElement("div");
    info.className = "vnccs-uc-history-meta";
    const seed = recordSeed(record);
    info.textContent = [
      HISTORY_KIND_LABELS[record.kind] || record.kind, record.mode, record.snapshot?.model || recordFamily(record),
      seed !== null ? `seed ${seed}` : "", record.durationMs ? `${(record.durationMs / 1000).toFixed(1)} s` : "",
      session.project?.scenes?.find((scene) => scene.id === record.sceneId)?.name || "",
    ].filter(Boolean).join(" · ");
    const recordActions = document.createElement("div");
    recordActions.className = "vnccs-uc-history-actions";
    recordActions.append(button(widget, "Restore settings", "vnccs-uc-btn", () => runAction(widget, "Restore settings", () => history.restoreSettings(record)), "Apply this run's settings to the panel"));
    if (record.kind === "generate") {
      recordActions.append(
        button(widget, "Re-run", "vnccs-uc-btn", () => { close(); void runAction(widget, "Re-run", () => history.rerun(record)); }, "Generate again with the same seed"),
        button(widget, "Re-run new seed", "vnccs-uc-btn", () => { close(); void runAction(widget, "Re-run", () => history.rerun(record, { newSeed: true })); }, "Generate again with a new seed"),
      );
    }
    const compareBtn = button(widget, "Compare A/B", "vnccs-uc-btn", () => {
      const [a, b] = compare.map((index) => history.resultUrl(record.results[index]));
      if (a && b) openHistoryCompare(widget, a, b);
    }, "Pick A and B below, then compare them");
    compareBtn.disabled = compare.length !== 2;
    recordActions.append(compareBtn, button(widget, "Delete", "vnccs-uc-btn danger", () => runAction(widget, "Delete history record", async () => {
      await history.deleteRecord(record);
      selectedId = null;
      await refresh();
    }), "Delete this record (its blobs are freed by the project GC)"));
    detail.append(heading, info, recordActions);
    if (record.error) {
      const error = document.createElement("div");
      error.className = "vnccs-uc-history-meta";
      error.textContent = `Error: ${record.error}`;
      detail.appendChild(error);
    }
    const results = document.createElement("div");
    results.className = "vnccs-uc-history-results";
    (record.results || []).forEach((result, index) => {
      const cell = document.createElement("div");
      cell.className = "vnccs-uc-history-result";
      cell.dataset.resultIndex = String(index);
      cell.classList.toggle("accepted", Boolean(result.accepted));
      cell.classList.toggle("compare-a", compare[0] === index);
      cell.classList.toggle("compare-b", compare[1] === index);
      const img = new Image();
      img.className = "vnccs-uc-history-thumb";
      img.alt = "";
      img.src = history.resultUrl(result);
      const badge = document.createElement("div");
      badge.className = "vnccs-uc-history-badge";
      badge.textContent = `${result.accepted ? "Accepted" : "Discarded"}${result.seed !== null && result.seed !== undefined ? ` · seed ${result.seed}` : ""}`;
      const row = document.createElement("div");
      row.className = "vnccs-uc-history-actions";
      row.append(button(widget, "Place as layer", "vnccs-uc-btn", () => runAction(widget, "Place result", async () => {
        await history.placeResult(record, index);
        await refresh();
      }), "Add this result to the scene as a new layer"));
      if (result.layerId) {
        row.append(button(widget, "Show layer", "vnccs-uc-btn", () => runAction(widget, "Show layer", async () => {
          await history.showLayer(record, index);
          close();
        }), "Select the layer this result became"));
      }
      row.append(button(widget, compare.includes(index) ? "Unpick" : "Pick A/B", "vnccs-uc-btn", () => {
        compare = compare.includes(index) ? compare.filter((item) => item !== index) : [...compare, index].slice(-2);
        renderDetail();
      }, "Choose this result for the A/B compare"));
      cell.append(img, badge, row);
      results.appendChild(cell);
    });
    detail.appendChild(results);
  };

  const renderRetention = (settings, usage) => {
    const caps = settings || { maxRecords: DEFAULT_HISTORY_MAX_RECORDS, maxBytes: DEFAULT_HISTORY_MAX_BYTES };
    if (document.activeElement !== maxRecordsInput) maxRecordsInput.value = String(caps.maxRecords);
    if (document.activeElement !== maxGbInput) maxGbInput.value = String(Math.round((caps.maxBytes / 1024 ** 3) * 100) / 100);
    usageText.textContent = usage ? `${usage.records} runs, ${formatBytes(usage.bytes)} ·` : "";
  };

  const render = () => {
    fillSelect(sceneSelect, (session.project?.scenes || []).map((scene) => [scene.id, scene.name || "Scene"]), "All scenes");
    // Switched-off families leave the filter; their records stay under "All models".
    const familyOn = (family) => isUniCanvasFamilyEnabled(history.familyKey(family));
    fillSelect(familySelect, historyFamilies(records, familyOn).map((family) => [family, family]), "All models");
    renderGrid();
    renderDetail();
  };

  const refresh = async () => {
    const data = await runAction(widget, "Load history", () => history.listRecords());
    records = Array.isArray(data?.records) ? data.records : [];
    if (selectedId && !records.some((record) => record.id === selectedId)) selectedId = null;
    renderRetention(data?.settings, data?.usage);
    render();
  };

  for (const control of [sceneSelect, kindSelect, familySelect, acceptedBox]) control.addEventListener("change", renderGrid);
  search.addEventListener("input", renderGrid);
  const unsubscribe = history.onChange(() => { void refresh(); });

  widget.container.appendChild(overlay);
  const selects = installCustomSelects(modal);
  render();
  void refresh();
  search.focus();
  return overlay;
}

/**
 * Where the History button goes: right after the Library tab (vnccs_unicanvas_library.mjs), else
 * the project bar when the library tabs are missing.
 */
export function historyButtonSlot(widget) {
  const tabs = widget?.container?.querySelector?.(".vnccs-uc-library-tabs");
  if (tabs) return { parent: tabs, className: "vnccs-uc-library-tab vnccs-uc-history-open" };
  const bar = widget?._vnccsProjectBar;
  return bar ? { parent: bar, className: "vnccs-uc-btn vnccs-uc-history-open" } : null;
}

/** Installs history on a widget (called from the UniCanvas constructor, after projects and the library). */
export function installUniCanvasHistory(widget, options = {}) {
  if (!widget || widget.generationHistory) return widget?.generationHistory;
  const history = new UniCanvasHistory(widget, options);
  widget.generationHistory = history;
  const slot = typeof document === "undefined" ? null : historyButtonSlot(widget);
  if (slot) {
    ensureStyles();
    const open = button(widget, "History", slot.className, () => openHistoryGallery(widget, history), "Every generation run of this project");
    open.dataset.historyOpen = "";
    slot.parent.appendChild(open);
    widget._vnccsHistoryButton = open;
  }
  return history;
}
