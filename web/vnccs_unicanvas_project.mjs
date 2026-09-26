/**
 * VNCCS UniCanvas - projects and scenes (Plan 10.3).
 *
 * The widget's document lives in the durable project store of Plan 10.2
 * (`/vnccs/unicanvas/projects`, nodes/unicanvas/projects.py) instead of the temp state cache
 * (node mode) or the localStorage document (standalone mode):
 *
 * - Saving is incremental: each layer's PNG is hashed with `crypto.subtle.digest` and only
 *   blobs the project has not seen are uploaded (`PUT .../blobs/{sha}`); layers whose runtime
 *   `pixelRevision` did not change since the last save reuse their blob refs without encoding.
 *   Then the scene JSON goes up with `ifRev`; a 409 asks "Reload theirs" / "Save mine as a copy".
 * - Autosave rides the widget's scheduleStateUpload / flushStateUpload pipeline (debounced,
 *   deferred while drawing); failed saves retry with backoff and nothing is dropped, because
 *   every save rebuilds the scene from the live widget.
 * - A project bar (name + scene tabs) sits at the top of the right column, a project browser
 *   opens from the name, and a corner chip shows Saved / Saving... / Offline - retrying.
 * - Node mode keeps `{ projectId, sceneId }` in the node's widget state (the backend renders the
 *   scene on execution); standalone mode keeps `{ lastProjectId, lastSceneId }` in localStorage.
 * - An existing state without a project is imported into "Untitled - <date>" once; the old
 *   storage (server cache, localStorage document) is left untouched.
 *
 * The widget only calls installUniCanvasProjects() and a few `widget.projectSession?.` hooks.
 */

import { createLayerMeta } from "./vnccs_unicanvas_provenance.mjs";

export const PROJECTS_BASE = "/vnccs/unicanvas/projects";
export const PROJECT_POINTER_KEY = "vnccs-unicanvas-standalone-project";
const SAVE_RETRY_MIN_MS = 1000;
const SAVE_RETRY_MAX_MS = 30000;
const THUMBNAIL_MAX = 512;
const THUMBNAIL_MIN_INTERVAL_MS = 8000;
const PNG_PREFIX = "data:image/png;base64,";
const BLOB_RE = /^[0-9a-f]{64}\.png$/;
const BLOB_URL_RE = /^\/vnccs\/unicanvas\/projects\/[^/]+\/blobs\/([0-9a-f]{64})$/;
const STYLE_ID = "vnccs-unicanvas-project-styles";

// Live sessions by "<projectId>/<sceneId>": a copied node must not autosave over its source.
const liveScenes = new Map();
// Saves still running by "<projectId>/<sceneId>": a widget recreated for the same scene (workflow
// reload, tab switch) waits for the final save of the widget it replaces before loading.
const pendingSaves = new Map();

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/test_unicanvas_project.mjs)
// ---------------------------------------------------------------------------

export function isPixelKey(key) {
  return typeof key === "string" && key.toLowerCase().endsWith("dataurl");
}

export function isBlobRef(value) {
  return Boolean(value && typeof value === "object" && typeof value.blob === "string" && BLOB_RE.test(value.blob));
}

export function dataUrlToBytes(dataUrl) {
  const base64 = String(dataUrl).slice(String(dataUrl).indexOf(",") + 1);
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(globalThis.Buffer.from(base64, "base64"));
}

export async function sha256Hex(bytes, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error("crypto.subtle is not available (the page must be served from localhost or HTTPS)");
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Backoff for failed saves: 1 s, 2 s, 4 s ... capped at 30 s. */
export function saveRetryDelay(attempt) {
  return Math.min(SAVE_RETRY_MAX_MS, SAVE_RETRY_MIN_MS * 2 ** Math.max(0, Math.min(10, attempt)));
}

export function migrationProjectName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `Untitled - ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function blobUrl(projectId, ref) {
  const name = typeof ref === "string" ? ref : ref?.blob;
  return `${PROJECTS_BASE}/${encodeURIComponent(projectId)}/blobs/${encodeURIComponent(String(name || "").replace(/\.png$/, ""))}`;
}

export function collectBlobNames(value, into = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectBlobNames(item, into);
  } else if (value && typeof value === "object") {
    if (isBlobRef(value)) into.add(value.blob);
    for (const item of Object.values(value)) collectBlobNames(item, into);
  }
  return into;
}

/** A stored scene (pixel fields as `{blob, crop}` refs) with every ref turned into a fetchable URL. */
export function hydrateSceneState(value, projectId) {
  if (Array.isArray(value)) return value.map((item) => hydrateSceneState(item, projectId));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isPixelKey(key) && isBlobRef(item) ? blobUrl(projectId, item) : hydrateSceneState(item, projectId);
  }
  return out;
}

/**
 * Replaces every inline PNG data URL under a pixel key by a `{blob, crop}` ref and collects the
 * bytes in `blobs` (sha -> Uint8Array). Mirrors ProjectStore._dehydrate on the server.
 */
export async function dehydrateValue(value, blobs, digest = sha256Hex) {
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await dehydrateValue(item, blobs, digest));
    return out;
  }
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const storedUrl = isPixelKey(key) && typeof item === "string" ? BLOB_URL_RE.exec(item) : null;
    if (storedUrl) {
      // A value restored from the project (e.g. a pose character image) round-trips as its ref.
      const crop = key.toLowerCase().startsWith("hires") ? value.hiresRect : value.crop;
      out[key] = { blob: `${storedUrl[1]}.png`, crop: crop ? { ...crop } : null };
    } else if (isPixelKey(key) && typeof item === "string" && item.startsWith(PNG_PREFIX)) {
      const bytes = dataUrlToBytes(item);
      const sha = await digest(bytes);
      blobs.set(sha, bytes);
      const crop = key.toLowerCase().startsWith("hires") ? value.hiresRect : value.crop;
      out[key] = { blob: `${sha}.png`, crop: crop ? { ...crop } : null };
    } else {
      out[key] = await dehydrateValue(item, blobs, digest);
    }
  }
  return out;
}

function layerId() {
  return `layer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** A fresh scene: one empty mask and one empty base layer, keeping the widget's model settings. */
export function blankSceneState(widget = {}) {
  const size = { width: 1024, height: 1024 };
  const mask = { id: layerId(), name: "Inpaint Mask", type: "mask", meta: createLayerMeta("base") };
  const base = { id: layerId(), name: "Base Layer", type: "raster", meta: createLayerMeta("base") };
  const layer = (item) => ({ ...item, visible: true, locked: false, opacity: 1, blendMode: "source-over", crop: null, dataURL: null, hiresRect: null, hiresDataURL: null });
  return {
    version: 2, panorama: null, storage: "project", origin: { x: 0, y: 0 }, size, bbox: { x: 0, y: 0, ...size },
    snapToGrid: widget.snapToGrid === true, resizeTransformMode: widget.resizeTransformMode || "free",
    settings: widget.settings ? { ...widget.settings } : {}, layers: [layer(mask), layer(base)], activeLayerId: base.id,
  };
}

function stateHasPixels(state) {
  return Array.isArray(state?.layers) && state.layers.some((layer) => Boolean(layer?.dataURL || layer?.hiresDataURL));
}

function readJSONStorage(storage, key) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writeJSONStorage(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch (_) {
    // Storage unavailable (private mode, blocked site data): the pointer is a convenience.
  }
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    return null;
  }
}

class ProjectRequestError extends Error {
  constructor(message, status, data = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// ---------------------------------------------------------------------------
// Session: one widget attached to one project scene
// ---------------------------------------------------------------------------

export class UniCanvasProjectSession {
  constructor(widget, { fetchImpl, storage, digest, now } = {}) {
    this.widget = widget;
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.storage = storage === undefined ? defaultStorage() : storage;
    this.digest = digest || sha256Hex;
    this.now = now || (() => Date.now());
    this.enabled = true;
    this.project = null;
    this.projectId = null;
    this.sceneId = null;
    this.rev = null;
    this.knownBlobs = new Set();
    this.layerCache = new Map();
    this.lastSavedJSON = "";
    this.saveRequested = false;
    this.inFlight = null;
    this.retryTimer = null;
    this.attempt = 0;
    this.conflict = false;
    this.loading = false;
    this.blocked = false;
    this.lastThumbnailAt = 0;
    this.thumbnailDirty = true;
    this.thumbnailTimer = null;
    this.status = "idle";
    this.listeners = new Set();
    this.stats = { blobUploads: 0, sceneSaves: 0 };
  }

  get mode() {
    return this.widget?.standalone ? "standalone" : "node";
  }

  get attached() {
    return Boolean(this.projectId && this.sceneId);
  }

  /** Whether autosave goes to the project (false once the store turned out to be unavailable). */
  get active() {
    return this.enabled && !this.widget?._disposed;
  }

  get sceneEntry() {
    return this.project?.scenes?.find((scene) => scene.id === this.sceneId) || null;
  }

  /** Fields buildSerializedState adds to every widget state. */
  ref() {
    return this.attached ? { projectId: this.projectId, sceneId: this.sceneId } : {};
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) {
      try { listener(this); } catch (err) { console.warn("[VNCCS UniCanvas] Project listener failed", err); }
    }
  }

  setStatus(status, detail = "") {
    this.status = status;
    this.statusDetail = detail;
    this.emit();
  }

  // -- HTTP ------------------------------------------------------------------------------------

  async request(method, path, { json, body, headers, raw = false } = {}) {
    const init = { method, headers: { ...(headers || {}) } };
    if (json !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(json);
    } else if (body !== undefined) {
      init.body = body;
    }
    const res = await this.fetch(`${PROJECTS_BASE}${path}`, init);
    if (raw && res.ok) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ProjectRequestError(String(data?.error || `HTTP ${res.status}`).replace(/^\[VNCCS UniCanvas\]\s*/, ""), res.status, data);
    return data;
  }

  projectPath(projectId = this.projectId) {
    return `/${encodeURIComponent(projectId)}`;
  }

  // -- attach / pointer ------------------------------------------------------------------------

  attach(project, sceneId, rev) {
    this.releaseLiveScene();
    if (project?.id !== this.projectId) {
      this.knownBlobs = new Set();
      this.layerCache = new Map();
    }
    this.project = project;
    this.projectId = project?.id || null;
    this.sceneId = sceneId || null;
    this.rev = rev ?? this.sceneEntry?.rev ?? null;
    this.conflict = false;
    this.blocked = false;
    this.lastSavedJSON = "";
    this.thumbnailDirty = true;
    if (this.attached) {
      const key = `${this.projectId}/${this.sceneId}`;
      if (!liveScenes.has(key)) liveScenes.set(key, new Set());
      liveScenes.get(key).add(this);
    }
    this.writePointer();
    this.emit();
  }

  releaseLiveScene() {
    if (!this.attached) return;
    const key = `${this.projectId}/${this.sceneId}`;
    liveScenes.get(key)?.delete(this);
    if (!liveScenes.get(key)?.size) liveScenes.delete(key);
  }

  sharesSceneWithAnotherWidget() {
    const peers = liveScenes.get(`${this.projectId}/${this.sceneId}`);
    return Boolean(peers && [...peers].some((peer) => peer !== this && !peer.widget?._disposed));
  }

  readPointer(widgetState = null) {
    if (this.mode === "standalone") {
      const pointer = readJSONStorage(this.storage, PROJECT_POINTER_KEY);
      return pointer?.lastProjectId && pointer?.lastSceneId ? { projectId: pointer.lastProjectId, sceneId: pointer.lastSceneId } : null;
    }
    return widgetState?.projectId && widgetState?.sceneId ? { projectId: String(widgetState.projectId), sceneId: String(widgetState.sceneId) } : null;
  }

  writePointer() {
    if (!this.attached) return;
    if (this.mode === "standalone") {
      writeJSONStorage(this.storage, PROJECT_POINTER_KEY, { lastProjectId: this.projectId, lastSceneId: this.sceneId });
      return;
    }
    const stateWidget = this.widget?.node?.widgets?.find?.((w) => w.name === "unicanvas_state");
    if (!stateWidget) return;
    let state = null;
    try {
      state = stateWidget.value && stateWidget.value !== "{}" ? JSON.parse(stateWidget.value) : null;
    } catch (_) {
      state = null;
    }
    if (!state || typeof state !== "object") return; // the next syncToNode writes it with ref()
    if (state.projectId === this.projectId && state.sceneId === this.sceneId) return;
    state.projectId = this.projectId;
    state.sceneId = this.sceneId;
    stateWidget.value = JSON.stringify(state);
  }

  // -- saving ----------------------------------------------------------------------------------

  async ensureProject(name = migrationProjectName()) {
    if (this.attached) return this.project;
    const project = await this.request("POST", "", { json: { name } });
    const scene = project.scenes?.find((item) => item.id === project.activeSceneId) || project.scenes?.[0];
    this.attach(project, scene?.id, scene?.rev ?? 1);
    return project;
  }

  /** The widget's document as a scene: pixel fields as blob refs, `blobs` holds new bytes. */
  async buildSceneState() {
    const widget = this.widget;
    const meta = widget.buildSerializedState(false);
    const blobs = new Map();
    const cacheUpdates = new Map();
    const layers = [];
    let pixelsChanged = false;
    for (let index = 0; index < widget.layers.length; index += 1) {
      const layer = widget.layers[index];
      const base = meta.layers[index] || {};
      const revision = layer.pixelRevision;
      const cached = this.layerCache.get(layer.id);
      const reusable = cached && revision != null && cached.revision === revision
        && cached.canvas === layer.canvas && cached.hires === (layer.hiresCanvas || null)
        && layer.type !== "pose" && !widget.panorama;
      if (reusable) {
        layers.push({ ...base, ...cached.fields });
        continue;
      }
      pixelsChanged = true;
      const full = await dehydrateValue(widget.serializeLayer(layer, true), blobs, this.digest);
      layers.push(full);
      cacheUpdates.set(layer.id, {
        revision, canvas: layer.canvas, hires: layer.hiresCanvas || null,
        fields: { crop: full.crop ?? null, dataURL: full.dataURL ?? null, hiresRect: full.hiresRect ?? null, hiresDataURL: full.hiresDataURL ?? null },
      });
    }
    const { projectId: _p, sceneId: _s, ...rest } = meta;
    const state = { ...rest, storage: "project", layers };
    return { state, blobs, cacheUpdates, pixelsChanged };
  }

  thumbnailDue() {
    return this.thumbnailDirty && this.now() - this.lastThumbnailAt >= THUMBNAIL_MIN_INTERVAL_MS;
  }

  /**
   * A thumbnail that was throttled is sent by a trailing save once the interval has passed, so
   * the last edit of a session always reaches the project list.
   */
  scheduleThumbnail() {
    if (!this.thumbnailDirty || this.thumbnailTimer || typeof document === "undefined") return;
    const delay = Math.max(0, THUMBNAIL_MIN_INTERVAL_MS - (this.now() - this.lastThumbnailAt));
    this.thumbnailTimer = setTimeout(() => {
      this.thumbnailTimer = null;
      if (this.active && this.attached && this.thumbnailDirty) void this.save();
    }, delay);
  }

  buildThumbnail() {
    const widget = this.widget;
    if (typeof document === "undefined" || typeof widget.drawFlattenedLayers !== "function") return null;
    const width = Math.max(1, Math.round(widget.size?.width || 1));
    const height = Math.max(1, Math.round(widget.size?.height || 1));
    const scale = Math.min(1, THUMBNAIL_MAX / Math.max(width, height));
    const full = document.createElement("canvas");
    full.width = width;
    full.height = height;
    widget.drawFlattenedLayers(full.getContext("2d"));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(width * scale));
    out.height = Math.max(1, Math.round(height * scale));
    out.getContext("2d").drawImage(full, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  }

  /** Queues a save of the live document; resolves true once it (or a newer one) is stored. */
  save() {
    if (!this.active) return Promise.resolve(false);
    this.saveRequested = true;
    if (!this.inFlight) {
      const key = this.attached ? `${this.projectId}/${this.sceneId}` : null;
      const run = this.drain().finally(() => {
        this.inFlight = null;
        if (key && pendingSaves.get(key) === run) pendingSaves.delete(key);
      });
      this.inFlight = run;
      if (key) pendingSaves.set(key, run);
    }
    return this.inFlight;
  }

  flush() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    return this.save();
  }

  async drain() {
    let ok = true;
    while (this.saveRequested) {
      this.saveRequested = false;
      try {
        ok = await this.saveOnce();
        this.attempt = 0;
      } catch (err) {
        ok = false;
        this.scheduleRetry(err);
        break;
      }
    }
    return ok;
  }

  scheduleRetry(err) {
    const offline = !(err instanceof ProjectRequestError) || err.status >= 500;
    if (err instanceof ProjectRequestError && (err.status === 404 || err.status === 405) && !this.attached) {
      // No project routes on this server (older backend): keep the legacy storage.
      this.enabled = false;
      this.setStatus("disabled", err.message);
      return;
    }
    const delay = saveRetryDelay(this.attempt);
    this.attempt += 1;
    this.setStatus(offline ? "offline" : "error", offline ? "Offline - retrying" : `Save failed - retrying: ${err.message || err}`);
    console.warn("[VNCCS UniCanvas] Project save failed; retrying", err);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.active) void this.save();
    }, delay);
  }

  async saveOnce() {
    if (this.conflict || this.loading || this.blocked) return false;
    await this.ensureProject();
    const projectId = this.projectId;
    const sceneId = this.sceneId;
    const { state, blobs, cacheUpdates, pixelsChanged } = await this.buildSceneState();
    const json = JSON.stringify(state);
    if (pixelsChanged) this.thumbnailDirty = true;
    // A scene the store has no thumbnail for (a new or migrated scene, one saved while the
    // thumbnail was throttled) still gets one, even when nothing else changed.
    const thumbnail = this.thumbnailDue() ? this.buildThumbnail() : null;
    if (json === this.lastSavedJSON && !thumbnail) {
      this.scheduleThumbnail();
      return true;
    }
    this.setStatus("saving", "Saving...");
    for (const [sha, bytes] of blobs) {
      if (this.knownBlobs.has(sha)) continue;
      await this.request("PUT", `${this.projectPath(projectId)}/blobs/${sha}`, { body: bytes, headers: { "Content-Type": "image/png" } });
      this.stats.blobUploads += 1;
      this.knownBlobs.add(sha);
    }
    const payload = { state, ifRev: this.rev };
    if (thumbnail) {
      payload.thumbnail = thumbnail;
      this.lastThumbnailAt = this.now();
      this.thumbnailDirty = false;
    } else this.scheduleThumbnail();
    let entry;
    try {
      entry = await this.request("PUT", `${this.projectPath(projectId)}/scenes/${encodeURIComponent(sceneId)}`, { json: payload });
    } catch (err) {
      if (err instanceof ProjectRequestError && err.status === 409 && projectId === this.projectId && sceneId === this.sceneId) {
        this.conflict = true;
        this.setStatus("conflict", "Changed in another tab");
        this.onConflict?.(err.data?.rev);
        return false;
      }
      if (payload.thumbnail) this.thumbnailDirty = true;
      throw err;
    }
    this.stats.sceneSaves += 1;
    if (projectId !== this.projectId || sceneId !== this.sceneId) return true; // switched meanwhile
    this.rev = entry.rev;
    const scenes = this.project?.scenes || [];
    const index = scenes.findIndex((scene) => scene.id === sceneId);
    if (index >= 0) scenes[index] = { ...scenes[index], ...entry };
    for (const [id, value] of cacheUpdates) this.layerCache.set(id, value);
    this.lastSavedJSON = json;
    this.setStatus(this.saveRequested ? "saving" : "saved", this.saveRequested ? "Saving..." : "Saved");
    return true;
  }

  // -- loading ---------------------------------------------------------------------------------

  /** Primes the incremental-save cache from a scene that was just applied to the widget. */
  primeFromStored(stored) {
    const byId = new Map((stored.layers || []).map((item) => [item?.id, item]));
    for (const layer of this.widget.layers || []) {
      const item = byId.get(layer.id);
      if (!item || layer.type === "pose" || this.widget.panorama) continue;
      this.layerCache.set(layer.id, {
        revision: layer.pixelRevision, canvas: layer.canvas, hires: layer.hiresCanvas || null,
        fields: { crop: item.crop ?? null, dataURL: item.dataURL ?? null, hiresRect: item.hiresRect ?? null, hiresDataURL: item.hiresDataURL ?? null },
      });
    }
    for (const name of collectBlobNames(stored)) this.knownBlobs.add(name.replace(/\.png$/, ""));
  }

  async preloadBlobs(names, onProgress) {
    if (typeof Image === "undefined") return;
    let done = 0;
    const urls = [...names].map((name) => blobUrl(this.projectId, name));
    onProgress?.(0, urls.length);
    await Promise.all(urls.map((url) => new Promise((resolve) => {
      const image = new Image();
      image.crossOrigin = "anonymous"; // same request mode as widget.loadImage, so the cache is shared
      image.onload = image.onerror = () => {
        done += 1;
        onProgress?.(done, urls.length);
        resolve();
      };
      image.src = url;
    })));
  }

  /**
   * Loads one scene of the attached project into the widget. The old document stays on screen
   * until every blob has arrived (applySerializedState swaps in one step).
   */
  async loadScene(sceneId, { settingsOverride = null, isStale = () => false } = {}) {
    const projectId = this.projectId;
    this.loading = true;
    this.setStatus("loading", "Loading scene...");
    try {
      const scene = await this.request("GET", `${this.projectPath(projectId)}/scenes/${encodeURIComponent(sceneId)}`);
      if (isStale() || projectId !== this.projectId) return false;
      let stored = scene.state && typeof scene.state === "object" ? scene.state : {};
      if (!Array.isArray(stored.layers) || !stored.layers.length) stored = { ...blankSceneState(this.widget), ...(stored.settings ? { settings: stored.settings } : {}) };
      if (settingsOverride) stored = { ...stored, settings: { ...(stored.settings || {}), ...settingsOverride } };
      const names = collectBlobNames(stored);
      await this.preloadBlobs(names, (done, total) => {
        if (total) this.setStatus("loading", `Loading scene ${done}/${total}`);
      });
      if (isStale() || projectId !== this.projectId) return false;
      const applied = await this.widget.applySerializedState(hydrateSceneState(stored, projectId), { exact: true });
      if (applied === false || isStale()) return false;
      const entry = { ...scene };
      delete entry.state;
      const scenes = this.project?.scenes || [];
      const index = scenes.findIndex((item) => item.id === entry.id);
      if (index >= 0) scenes[index] = { ...scenes[index], ...entry };
      this.layerCache = new Map();
      this.attach(this.project, entry.id, entry.rev);
      this.primeFromStored(stored);
      this.loading = false;
      // What this scene looks like to the saver now, so an unchanged scene does not re-save.
      try {
        this.lastSavedJSON = JSON.stringify((await this.buildSceneState()).state);
      } catch (_) {
        this.lastSavedJSON = "";
      }
      this.thumbnailDirty = !entry.thumbnail;
      this.scheduleThumbnail();
      this.setStatus("saved", "Saved");
      return true;
    } finally {
      this.loading = false;
    }
  }

  afterSceneApplied() {
    const widget = this.widget;
    widget.undoStack = [];
    widget.redoStack = [];
    widget.stagingItems = [];
    widget.activeStagingIndex = -1;
    widget.updateStagingControls?.();
    widget.updateHistoryButtons?.();
    widget.renderLayerList?.();
    widget.syncActiveLayerControls?.();
    widget.syncPoseToolToActiveLayer?.();
    widget.fitView?.();
    widget.requestRender?.();
    widget.syncLightStateToWidget?.();
  }

  /**
   * Restores the widget from its project pointer. Returns true when the project path handled the
   * load; false lets the legacy restore (server cache / localStorage document) run.
   */
  async restoreFromWidgetState(widgetState, isStale = () => false) {
    const pointer = this.readPointer(widgetState);
    if (!pointer) return false;
    let project;
    try {
      project = await this.request("GET", this.projectPath(pointer.projectId));
    } catch (err) {
      if (err instanceof ProjectRequestError && err.status === 404) return false; // deleted: migrate what is left
      if (err instanceof ProjectRequestError && err.status === 405) {
        this.enabled = false;
        return false;
      }
      // Unreachable for now: never autosave a half-restored canvas over the stored scene.
      this.blocked = true;
      this.project = { id: pointer.projectId, name: "", scenes: [] };
      this.projectId = pointer.projectId;
      this.sceneId = pointer.sceneId;
      this.setStatus("offline", "Offline - project not loaded");
      this.retryRestore(widgetState);
      return false;
    }
    if (isStale()) return true;
    const sceneId = project.scenes?.some((scene) => scene.id === pointer.sceneId) ? pointer.sceneId : (project.activeSceneId || project.scenes?.[0]?.id);
    if (!sceneId) return false;
    await pendingSaves.get(`${project.id}/${sceneId}`)?.catch(() => {});
    if (isStale()) return true;
    project = await this.request("GET", this.projectPath(project.id)).catch(() => project);
    this.attach(project, sceneId);
    const settingsOverride = this.mode === "node" && widgetState?.settings && typeof widgetState.settings === "object" ? widgetState.settings : null;
    const loaded = await this.loadScene(sceneId, { settingsOverride, isStale });
    if (loaded && this.mode === "node" && this.sharesSceneWithAnotherWidget()) {
      // A copied node: give it its own scene so the two nodes do not overwrite each other.
      await this.forkScene("copy");
    }
    return true;
  }

  retryRestore(widgetState, attempt = 0) {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (!this.blocked || this.widget?._disposed) return;
      const pointer = { projectId: this.projectId, sceneId: this.sceneId };
      try {
        const project = await this.request("GET", this.projectPath(pointer.projectId));
        this.project = project;
        this.blocked = false;
        if (await this.loadScene(pointer.sceneId)) this.afterSceneApplied();
      } catch (err) {
        this.blocked = true;
        this.setStatus("offline", "Offline - project not loaded");
        this.retryRestore(widgetState, attempt + 1);
      }
    }, saveRetryDelay(attempt));
  }

  /** After a legacy restore: import an existing state that has no project yet (one time). */
  async migrateLegacyState() {
    if (!this.active || this.attached || this.blocked) return false;
    const widget = this.widget;
    const hasPixels = (widget.layers || []).some((layer) => widget.getLayerAlphaBounds?.(layer));
    if (!hasPixels) return false;
    try {
      const project = await this.ensureProject(migrationProjectName());
      const ok = await this.flush();
      if (ok) {
        const note = `Imported this canvas into the project "${project.name}". The old copy was kept.`;
        widget.setStatus?.(`[VNCCS UniCanvas] ${note}`);
        this.migrationNote = note;
        this.emit();
      }
      return ok;
    } catch (err) {
      console.warn("[VNCCS UniCanvas] Could not import the canvas into a project", err);
      return false;
    }
  }

  // -- scenes ----------------------------------------------------------------------------------

  async switchScene(sceneId) {
    if (!this.attached || sceneId === this.sceneId || this.loading) return false;
    if (!(await this.flush())) {
      this.widget.setStatus?.("[VNCCS UniCanvas] The current scene could not be saved; it stays open until the save goes through.", true);
      return false;
    }
    const ok = await this.loadScene(sceneId);
    if (ok) {
      this.afterSceneApplied();
      void this.request("PATCH", this.projectPath(), { json: { activeSceneId: sceneId } }).then((project) => {
        if (project?.id === this.projectId) this.project = { ...project, scenes: this.project.scenes };
      }).catch(() => {});
    }
    return ok;
  }

  async newScene(name = "") {
    await this.ensureProject();
    await this.flush();
    const entry = await this.request("POST", `${this.projectPath()}/scenes`, { json: { name, state: blankSceneState(this.widget) } });
    this.project.scenes.push(entry);
    this.emit();
    await this.switchScene(entry.id);
    return entry;
  }

  async duplicateScene(sceneId = this.sceneId) {
    await this.flush();
    const entry = await this.request("POST", `${this.projectPath()}/scenes`, { json: { fromSceneId: sceneId } });
    this.project.scenes.push(entry);
    this.emit();
    await this.switchScene(entry.id);
    return entry;
  }

  async renameScene(sceneId, name) {
    const clean = String(name || "").trim();
    if (!clean) return;
    if (sceneId === this.sceneId) await this.flush();
    const entry = this.project.scenes.find((scene) => scene.id === sceneId);
    const current = await this.request("GET", `${this.projectPath()}/scenes/${encodeURIComponent(sceneId)}`);
    const saved = await this.request("PUT", `${this.projectPath()}/scenes/${encodeURIComponent(sceneId)}`, { json: { state: current.state, ifRev: current.rev, name: clean } });
    Object.assign(entry, saved);
    if (sceneId === this.sceneId) this.rev = saved.rev;
    this.emit();
  }

  async deleteScene(sceneId) {
    if ((this.project?.scenes?.length || 0) <= 1) throw new Error("A project keeps at least one scene.");
    if (sceneId === this.sceneId) {
      const next = this.project.scenes.find((scene) => scene.id !== sceneId);
      if (!(await this.switchScene(next.id))) return;
    }
    const project = await this.request("DELETE", `${this.projectPath()}/scenes/${encodeURIComponent(sceneId)}`);
    this.project = project;
    this.emit();
  }

  async reorderScenes(order) {
    const project = await this.request("PATCH", this.projectPath(), { json: { sceneOrder: order } });
    this.project = project;
    this.emit();
  }

  /** "Save mine as a copy" and copied nodes: the live document goes to a new scene. */
  async forkScene(reason = "mine") {
    const { state, blobs } = await this.buildSceneState();
    for (const [sha, bytes] of blobs) {
      if (this.knownBlobs.has(sha)) continue;
      await this.request("PUT", `${this.projectPath()}/blobs/${sha}`, { body: bytes, headers: { "Content-Type": "image/png" } });
      this.stats.blobUploads += 1;
      this.knownBlobs.add(sha);
    }
    const sourceName = this.sceneEntry?.name || "Scene";
    const entry = await this.request("POST", `${this.projectPath()}/scenes`, {
      json: reason === "copy" ? { fromSceneId: this.sceneId, name: `${sourceName} (copy)` } : { name: `${sourceName} (mine)`, state },
    });
    this.project.scenes.push(entry);
    this.attach(this.project, entry.id, entry.rev);
    this.lastSavedJSON = reason === "copy" ? "" : JSON.stringify(state);
    this.setStatus("saved", "Saved");
    if (reason === "copy") void this.save();
    return entry;
  }

  async resolveConflict(choice) {
    if (!this.conflict) return;
    if (choice === "theirs") {
      this.conflict = false;
      if (await this.loadScene(this.sceneId)) this.afterSceneApplied();
      return;
    }
    await this.forkScene("mine");
    this.conflict = false;
    this.widget.syncLightStateToWidget?.();
  }

  // -- projects --------------------------------------------------------------------------------

  listProjects() {
    return this.request("GET", "").then((data) => data.projects || []);
  }

  async openProject(projectId) {
    if (this.attached && !(await this.flush())) {
      throw new Error("The current scene could not be saved.");
    }
    const project = await this.request("GET", this.projectPath(projectId));
    const sceneId = project.activeSceneId || project.scenes?.[0]?.id;
    const previous = { project: this.project, sceneId: this.sceneId, rev: this.rev };
    this.attach(project, sceneId);
    if (!(await this.loadScene(sceneId))) {
      if (previous.project) this.attach(previous.project, previous.sceneId, previous.rev);
      return false;
    }
    this.afterSceneApplied();
    return true;
  }

  async createProject(name) {
    const project = await this.request("POST", "", { json: { name: name || migrationProjectName() } });
    await this.openProject(project.id);
    return project;
  }

  async renameProject(projectId, name) {
    const project = await this.request("PATCH", this.projectPath(projectId), { json: { name } });
    if (projectId === this.projectId) this.project = { ...project, scenes: this.project.scenes };
    this.emit();
    return project;
  }

  duplicateProject(projectId) {
    return this.request("POST", `${this.projectPath(projectId)}/duplicate`, { json: {} });
  }

  async deleteProject(projectId) {
    if (projectId === this.projectId) throw new Error("Open another project before deleting this one.");
    await this.request("DELETE", this.projectPath(projectId));
  }

  async exportProject(projectId) {
    const res = await this.request("POST", `${this.projectPath(projectId)}/export`, { raw: true });
    const disposition = res.headers?.get?.("Content-Disposition") || "";
    const name = /filename="([^"]+)"/.exec(disposition)?.[1] || "project.vnccs-project.zip";
    return { blob: await res.blob(), name };
  }

  importProject(file) {
    return this.request("POST", "/import", { body: file, headers: { "Content-Type": "application/zip" } });
  }

  dispose() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.thumbnailTimer) clearTimeout(this.thumbnailTimer);
    this.thumbnailTimer = null;
    this.releaseLiveScene();
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// UI: project bar, scene tabs, status chip, browser and conflict dialog
// ---------------------------------------------------------------------------

const STYLES = `
.vnccs-uc-project-bar { display:flex; flex-direction:column; gap:6px; padding:8px; border:1px solid var(--uc-border); border-radius:10px; background:var(--uc-panel); }
.vnccs-uc-project-name { display:flex; align-items:center; gap:6px; width:100%; min-width:0; text-align:left; font-weight:700; }
.vnccs-uc-project-name span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1 1 auto; }
.vnccs-uc-scene-tabs { display:flex; gap:4px; flex-wrap:wrap; align-items:center; }
.vnccs-uc-scene-tab { max-width:140px; overflow:hidden; text-overflow:ellipsis; height:24px !important; padding:0 8px !important; font-size:12px; }
.vnccs-uc-scene-tab.active { border-color:var(--uc-accent) !important; color:var(--uc-accent); }
.vnccs-uc-scene-tab.drop-target { outline:1px dashed var(--uc-accent-2); }
.vnccs-uc-scene-add { height:24px !important; width:26px; padding:0 !important; }
.vnccs-uc-project-chip { position:absolute; left:10px; bottom:10px; z-index:6; padding:3px 9px; border-radius:999px; font:600 11px var(--uc-font, sans-serif); color:var(--uc-text); background:var(--uc-panel); border:1px solid var(--uc-border); pointer-events:none; opacity:.92; }
.vnccs-uc-project-chip[data-status="offline"], .vnccs-uc-project-chip[data-status="error"], .vnccs-uc-project-chip[data-status="conflict"] { color:var(--uc-danger); border-color:var(--uc-danger); }
.vnccs-uc-project-chip[data-status="saving"], .vnccs-uc-project-chip[data-status="loading"] { color:var(--uc-accent-2); }
.vnccs-uc-project-note { position:absolute; left:10px; bottom:36px; z-index:6; max-width:320px; padding:6px 10px; border-radius:8px; font:500 12px var(--uc-font, sans-serif); color:var(--uc-text); background:var(--uc-panel); border:1px solid var(--uc-accent-2); }
.vnccs-uc-scene-menu { position:fixed; z-index:2147483000; display:flex; flex-direction:column; min-width:130px; padding:4px; border-radius:8px; background:var(--uc-surface, #1e1c2c); border:1px solid var(--uc-border); box-shadow:0 8px 24px rgba(0,0,0,.4); }
.vnccs-uc-scene-menu button { text-align:left; background:none; border:0; color:var(--uc-text); padding:6px 10px; border-radius:6px; cursor:pointer; font:inherit; }
.vnccs-uc-scene-menu button:hover { background:var(--uc-hover); }
.vnccs-uc-scene-menu button.danger { color:var(--uc-danger); }
.vnccs-uc-modal.vnccs-uc-project-browser { width:min(860px, 92%); max-height:86%; display:flex; flex-direction:column; gap:10px; }
.vnccs-uc-project-browser-head { display:flex; gap:6px; align-items:center; }
.vnccs-uc-project-browser-head input[type="search"] { flex:1 1 auto; min-width:80px; }
.vnccs-uc-project-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(170px, 1fr)); gap:10px; overflow:auto; min-height:120px; }
.vnccs-uc-project-card { display:flex; flex-direction:column; gap:6px; padding:8px; border-radius:10px; border:1px solid var(--uc-border); background:var(--uc-surface); }
.vnccs-uc-project-card.current { border-color:var(--uc-accent); }
.vnccs-uc-project-thumb { aspect-ratio:1/1; width:100%; border-radius:6px; object-fit:contain; background:repeating-conic-gradient(#2a2838 0% 25%, #1f1d2b 0% 50%) 50%/16px 16px; cursor:pointer; }
.vnccs-uc-project-card-name { font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-uc-project-card-meta { color:var(--uc-muted); font-size:11px; }
.vnccs-uc-project-card-actions { display:flex; flex-wrap:wrap; gap:4px; }
.vnccs-uc-project-card-actions .vnccs-uc-btn { height:24px; padding:0 7px; font-size:11px; }
.vnccs-uc-project-empty { color:var(--uc-muted); padding:12px; }
`;

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

function button(label, className, onClick, title = label) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = label;
  el.title = title;
  el.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(event);
  });
  return el;
}

function formatDate(seconds) {
  if (!seconds) return "";
  try {
    return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch (_) {
    return "";
  }
}

async function runAction(widget, label, action) {
  try {
    return await action();
  } catch (err) {
    widget.setStatus?.(`[VNCCS UniCanvas] ${label} failed: ${err?.message || err}`, true);
    return null;
  }
}

function closeSceneMenu(widget) {
  widget._vnccsSceneMenu?.remove();
  widget._vnccsSceneMenu = null;
  if (widget._vnccsSceneMenuOutside) document.removeEventListener("pointerdown", widget._vnccsSceneMenuOutside, true);
  widget._vnccsSceneMenuOutside = null;
}

function openSceneMenu(widget, session, scene, event) {
  closeSceneMenu(widget);
  const menu = document.createElement("div");
  menu.className = "vnccs-uc-scene-menu";
  menu.dataset.sceneId = scene.id;
  const item = (label, action, className = "") => {
    const el = button(label, className, async () => {
      closeSceneMenu(widget);
      await action();
    });
    menu.appendChild(el);
  };
  item("Rename", async () => {
    const name = await widget.promptInWidget("Rename scene", "Scene name", scene.name || "");
    if (name?.trim()) await runAction(widget, "Rename scene", () => session.renameScene(scene.id, name));
  });
  item("Duplicate", () => runAction(widget, "Duplicate scene", () => session.duplicateScene(scene.id)));
  if ((session.project?.scenes?.length || 0) > 1) {
    item("Delete", async () => {
      const ok = await widget.confirmInWidget("Delete scene", `Delete "${scene.name}"? This cannot be undone.`, "Delete");
      if (ok) await runAction(widget, "Delete scene", () => session.deleteScene(scene.id));
    }, "danger");
  }
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  document.body.appendChild(menu);
  widget._vnccsSceneMenu = menu;
  widget._vnccsSceneMenuOutside = (e) => {
    if (!menu.contains(e.target)) closeSceneMenu(widget);
  };
  document.addEventListener("pointerdown", widget._vnccsSceneMenuOutside, true);
}

function renderProjectBar(widget, session) {
  const bar = widget._vnccsProjectBar;
  if (!bar) return;
  const nameLabel = bar.querySelector(".vnccs-uc-project-name span");
  nameLabel.textContent = session.project?.name || (session.active ? "No project yet" : "Projects unavailable");
  bar.querySelector(".vnccs-uc-project-name").disabled = !session.active;
  const tabs = bar.querySelector(".vnccs-uc-scene-tabs");
  tabs.replaceChildren();
  const scenes = [...(session.project?.scenes || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const scene of scenes) {
    const tab = button(scene.name || "Scene", "vnccs-uc-btn vnccs-uc-scene-tab", () => {
      void runAction(widget, "Switch scene", () => session.switchScene(scene.id));
    }, `${scene.name || "Scene"} (right-click for more)`);
    tab.dataset.sceneId = scene.id;
    tab.classList.toggle("active", scene.id === session.sceneId);
    tab.draggable = true;
    tab.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openSceneMenu(widget, session, scene, event);
    });
    tab.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/x-vnccs-scene", scene.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    tab.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types?.includes("text/x-vnccs-scene")) return;
      event.preventDefault();
      tab.classList.add("drop-target");
    });
    tab.addEventListener("dragleave", () => tab.classList.remove("drop-target"));
    tab.addEventListener("drop", (event) => {
      event.preventDefault();
      tab.classList.remove("drop-target");
      const dragged = event.dataTransfer?.getData("text/x-vnccs-scene");
      if (!dragged || dragged === scene.id) return;
      const order = scenes.map((item) => item.id).filter((id) => id !== dragged);
      order.splice(order.indexOf(scene.id), 0, dragged);
      void runAction(widget, "Reorder scenes", () => session.reorderScenes(order));
    });
    tabs.appendChild(tab);
  }
  if (session.active) {
    tabs.appendChild(button("+", "vnccs-uc-btn vnccs-uc-scene-add", () => {
      void runAction(widget, "New scene", () => session.newScene());
    }, "New scene"));
  }
}

function renderChip(widget, session) {
  const chip = widget._vnccsProjectChip;
  if (!chip) return;
  const labels = { saved: "Saved", saving: "Saving...", offline: "Offline - retrying", loading: "Loading scene...", conflict: "Changed in another tab", error: "Save failed - retrying" };
  const visible = session.active && session.status !== "idle" && session.status !== "disabled";
  chip.hidden = !visible;
  chip.dataset.status = session.status;
  chip.textContent = session.statusDetail || labels[session.status] || "";
  if (session.migrationNote && !widget._vnccsProjectNoteShown) {
    widget._vnccsProjectNoteShown = true;
    const note = document.createElement("div");
    note.className = "vnccs-uc-project-note";
    note.textContent = session.migrationNote;
    widget.stageWrap?.appendChild(note);
    setTimeout(() => note.remove(), 9000);
  }
}

function showConflictDialog(widget, session) {
  if (widget.container.querySelector(".vnccs-uc-project-conflict")) return;
  const overlay = document.createElement("div");
  overlay.className = "vnccs-uc-modal-overlay vnccs-uc-project-conflict";
  const modal = document.createElement("div");
  modal.className = "vnccs-uc-modal";
  const title = document.createElement("div");
  title.className = "vnccs-uc-modal-title";
  title.textContent = "Scene changed in another tab";
  const message = document.createElement("div");
  message.className = "vnccs-uc-modal-message";
  message.textContent = `"${session.sceneEntry?.name || "This scene"}" was saved somewhere else after you opened it. Keep their version, or keep yours as a new scene.`;
  const actions = document.createElement("div");
  actions.className = "vnccs-uc-modal-actions";
  const close = () => overlay.remove();
  actions.append(
    button("Reload theirs", "vnccs-uc-btn", async () => { close(); await runAction(widget, "Reload scene", () => session.resolveConflict("theirs")); }),
    button("Save mine as a copy", "vnccs-uc-btn primary", async () => { close(); await runAction(widget, "Save a copy", () => session.resolveConflict("mine")); }),
  );
  overlay.addEventListener("keydown", (event) => event.stopPropagation());
  modal.append(title, message, actions);
  overlay.appendChild(modal);
  widget.container.appendChild(overlay);
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function openProjectBrowser(widget, session = widget.projectSession) {
  if (!session?.active || widget.container.querySelector(".vnccs-uc-project-browser")) return null;
  const overlay = document.createElement("div");
  overlay.className = "vnccs-uc-modal-overlay";
  const modal = document.createElement("div");
  modal.className = "vnccs-uc-modal vnccs-uc-project-browser";
  const title = document.createElement("div");
  title.className = "vnccs-uc-modal-title";
  title.textContent = "Projects";
  const head = document.createElement("div");
  head.className = "vnccs-uc-project-browser-head";
  const search = document.createElement("input");
  search.type = "search";
  search.className = "vnccs-uc-input";
  search.placeholder = "Search projects";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".zip,application/zip";
  fileInput.hidden = true;
  const grid = document.createElement("div");
  grid.className = "vnccs-uc-project-grid";
  let projects = [];
  const close = () => {
    overlay.remove();
  };
  const refresh = async () => {
    projects = (await runAction(widget, "List projects", () => session.listProjects())) || [];
    render();
  };
  const render = () => {
    const query = search.value.trim().toLowerCase();
    grid.replaceChildren();
    const shown = projects.filter((project) => !query || String(project.name || "").toLowerCase().includes(query));
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "vnccs-uc-project-empty";
      empty.textContent = query ? "No project matches the search." : "No projects yet.";
      grid.appendChild(empty);
    }
    for (const project of shown) {
      const card = document.createElement("div");
      card.className = "vnccs-uc-project-card";
      card.dataset.projectId = project.id;
      card.classList.toggle("current", project.id === session.projectId);
      const thumb = document.createElement("img");
      thumb.className = "vnccs-uc-project-thumb";
      thumb.alt = "";
      if (project.thumbnail) {
        const sceneId = String(project.thumbnail).replace(/^thumbs\//, "").replace(/\.png$/, "");
        thumb.src = `${PROJECTS_BASE}/${encodeURIComponent(project.id)}/thumbs/${encodeURIComponent(sceneId)}?t=${Math.round((project.updatedAt || 0) * 1000)}`;
      }
      thumb.addEventListener("click", () => open(project));
      const name = document.createElement("div");
      name.className = "vnccs-uc-project-card-name";
      name.textContent = project.name || "Untitled";
      name.title = project.name || "";
      const meta = document.createElement("div");
      meta.className = "vnccs-uc-project-card-meta";
      meta.textContent = `${project.sceneCount || 0} scene${project.sceneCount === 1 ? "" : "s"} · ${formatDate(project.updatedAt)}`;
      const actions = document.createElement("div");
      actions.className = "vnccs-uc-project-card-actions";
      const isCurrent = project.id === session.projectId;
      const del = button("Delete", "vnccs-uc-btn danger", async () => {
        const ok = await widget.confirmInWidget("Delete project", `Move "${project.name}" to the trash? It is purged after 30 days.`, "Delete");
        if (ok && await runAction(widget, "Delete project", () => session.deleteProject(project.id)) !== null) await refresh();
      }, isCurrent ? "Open another project before deleting this one" : "Delete project");
      del.disabled = isCurrent;
      actions.append(
        button("Open", "vnccs-uc-btn primary", () => open(project), "Open project"),
        button("Duplicate", "vnccs-uc-btn", async () => {
          if (await runAction(widget, "Duplicate project", () => session.duplicateProject(project.id))) await refresh();
        }, "Duplicate project"),
        button("Rename", "vnccs-uc-btn", async () => {
          const next = await widget.promptInWidget("Rename project", "Project name", project.name || "");
          if (next?.trim() && await runAction(widget, "Rename project", () => session.renameProject(project.id, next.trim()))) await refresh();
        }, "Rename project"),
        button("Export", "vnccs-uc-btn", async () => {
          if (project.id === session.projectId) await session.flush();
          const file = await runAction(widget, "Export project", () => session.exportProject(project.id));
          if (file) downloadBlob(file.blob, file.name);
        }, "Download the project as a zip"),
        del,
      );
      card.append(thumb, name, meta, actions);
      grid.appendChild(card);
    }
  };
  const open = async (project) => {
    if (project.id === session.projectId) {
      close();
      return;
    }
    close();
    await runAction(widget, "Open project", () => session.openProject(project.id));
  };
  search.addEventListener("input", render);
  search.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") close();
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    if (await runAction(widget, "Import project", () => session.importProject(file))) await refresh();
  });
  head.append(
    search,
    button("New", "vnccs-uc-btn primary", async () => {
      const name = await widget.promptInWidget("New project", "Project name", migrationProjectName());
      if (name === null) return;
      close();
      await runAction(widget, "New project", () => session.createProject(name.trim()));
    }, "New project"),
    button("Import", "vnccs-uc-btn", () => fileInput.click(), "Import a project zip"),
    button("Close", "vnccs-uc-btn", close, "Close"),
    fileInput,
  );
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close();
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  });
  modal.append(title, head, grid);
  overlay.appendChild(modal);
  widget.container.appendChild(overlay);
  void refresh();
  requestAnimationFrame(() => search.focus());
  return overlay;
}

function buildProjectBar(widget, session) {
  const bar = document.createElement("div");
  bar.className = "vnccs-uc-project-bar";
  const name = button("", "vnccs-uc-btn vnccs-uc-project-name", () => openProjectBrowser(widget, session), "Open the project browser");
  const label = document.createElement("span");
  name.append(label);
  const caret = document.createElement("small");
  caret.textContent = "▾";
  name.append(caret);
  const tabs = document.createElement("div");
  tabs.className = "vnccs-uc-scene-tabs";
  bar.append(name, tabs);
  return bar;
}

/** Installs projects on a widget (called from the UniCanvas constructor, before its restore). */
export function installUniCanvasProjects(widget, options = {}) {
  if (!widget || widget.projectSession) return widget?.projectSession;
  const session = new UniCanvasProjectSession(widget, options);
  widget.projectSession = session;
  if (typeof document !== "undefined" && widget.side) {
    ensureStyles();
    const bar = buildProjectBar(widget, session);
    widget.side.insertBefore(bar, widget.side.firstChild);
    widget._vnccsProjectBar = bar;
    const chip = document.createElement("div");
    chip.className = "vnccs-uc-project-chip";
    chip.hidden = true;
    widget.stageWrap?.appendChild(chip);
    widget._vnccsProjectChip = chip;
    session.onChange(() => {
      renderProjectBar(widget, session);
      renderChip(widget, session);
    });
    session.onConflict = () => showConflictDialog(widget, session);
    renderProjectBar(widget, session);
  }
  // Restore through the project first; the legacy restore runs only without one, then migrates.
  const legacyLoadFromNode = widget._loadFromNode;
  const legacyLoad = () => legacyLoadFromNode.call(widget);
  widget._loadFromNode = async () => {
    const revision = widget._stateLoadRevision = (widget._stateLoadRevision || 0) + 1;
    // Standalone widgets get their `standalone` flag right after construction.
    await Promise.resolve();
    const isStale = () => widget._disposed || revision !== widget._stateLoadRevision;
    let widgetState = null;
    try {
      const stateWidget = widget.node?.widgets?.find?.((w) => w.name === "unicanvas_state");
      widgetState = stateWidget?.value && stateWidget.value !== "{}" ? JSON.parse(stateWidget.value) : null;
    } catch (_) {
      widgetState = null;
    }
    if (session.active && await session.restoreFromWidgetState(widgetState, isStale).catch((err) => {
      console.warn("[VNCCS UniCanvas] Project restore failed", err);
      return false;
    })) return;
    if (isStale()) return;
    await legacyLoad();
    if (!widget._disposed) void session.migrateLegacyState();
  };
  return session;
}
