/**
 * VNCCS UniCanvas - asset library (Plan 10.4, #23).
 *
 * Reusable characters, backgrounds, props, poses and generation presets, stored once and
 * dropped into any scene:
 *
 * - Two scopes with one format (nodes/unicanvas/projects.py): project assets
 *   (`/vnccs/unicanvas/projects/<id>/assets`) and the global library
 *   (`/vnccs/unicanvas/library/assets`). Pixels travel as PNG data URLs and are stored as blobs.
 * - A "Library" tab next to "Layers" lists the assets of one scope with kind filters, a name /
 *   tag search and thumbnails. Cards are dragged onto the canvas (or inserted with a click);
 *   presets are applied instead.
 * - The layer context menu gets "Save to library...", and for layers linked to an asset
 *   (`meta.origin = "asset"`, `meta.assetId`, `meta.assetScope`) "Update from library" and
 *   "Push to library". Nothing propagates on its own.
 * - Inserted layers land with the asset's anchor on the drop point (feet for characters and
 *   props); with the scene's depth scale on (Plan 08) a character is sized for that ground row.
 * - The settings popover gets "Save generation preset to library".
 *
 * - Characters saved from a sprite layer (Plan 03, #6) carry their sprite set (`data.spriteSet`,
 *   every variant a PNG blob) and insert as a sprite layer with all variants; other characters
 *   insert as raster layers. The reserved `skin` kind is not built yet.
 *
 * The widget only calls installUniCanvasLibrary(); the layer menu and the settings popover read
 * `uc.layerMenuExtensions` / `uc.library`.
 */

import { isMaskSectionLayer } from "./vnccs_unicanvas_control.mjs";
import { createLayerMeta, normalizeLayerMeta } from "./vnccs_unicanvas_provenance.mjs";
import { expectedHeightAt, isPerspectiveCalibrated, layerHeightFactor, normalizeScenePerspective, editScenePerspective } from "./vnccs_unicanvas_scene_place.mjs";
import { serializePose } from "./vnccs_unicanvas_pose_state.mjs";
import { PROJECTS_BASE } from "./vnccs_unicanvas_project.mjs";
import { installCustomSelects } from "./vnccs_custom_select.mjs";
import { layerCategory } from "./vnccs_unicanvas_naming_rules.mjs";

export const LIBRARY_BASE = "/vnccs/unicanvas/library";
export const ASSET_KINDS = Object.freeze(["character", "background", "prop", "pose", "preset"]);
export const ASSET_KIND_LABELS = Object.freeze({ character: "Character", background: "Background", prop: "Prop", pose: "Pose", preset: "Preset" });
export const ASSET_DRAG_TYPE = "application/x-vnccs-asset";
export const DEFAULT_ANCHORS = Object.freeze({
  character: Object.freeze({ x: 0.5, y: 1 }),
  prop: Object.freeze({ x: 0.5, y: 1 }),
  background: Object.freeze({ x: 0.5, y: 0.5 }),
  pose: Object.freeze({ x: 0.5, y: 1 }),
});
// Settings that describe the machine or the UI, not a house style: never part of a preset.
const PRESET_EXCLUDED = /^(remove_bg|auto_name|debug_mode$|vae_chunking$|step_cache$|inpaint_crop_to_mask$|standalone)|_turbo_previous_settings$/;
const STYLE_ID = "vnccs-unicanvas-library-styles";

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/test_unicanvas_library.mjs)
// ---------------------------------------------------------------------------

export function assetsPath(scope, projectId) {
  if (scope === "global") return `${LIBRARY_BASE}/assets`;
  if (scope === "project" && projectId) return `${PROJECTS_BASE}/${encodeURIComponent(projectId)}/assets`;
  throw new Error("Asset scope needs a project");
}

export function assetBlobUrl(scope, projectId, ref) {
  const name = String((typeof ref === "string" ? ref : ref?.blob) || "").replace(/\.png$/, "");
  if (!/^[0-9a-f]{64}$/.test(name)) return null;
  if (scope === "global") return `${LIBRARY_BASE}/blobs/${name}`;
  return `${PROJECTS_BASE}/${encodeURIComponent(projectId)}/blobs/${name}`;
}

// Folder categories (issue #17) that decide the kind; other layers leave the choice to the user.
const CATEGORY_KINDS = Object.freeze({ Characters: "character", Background: "background", Props: "prop" });
const KIND_CATEGORIES = Object.freeze({ character: "Characters", background: "Background", prop: "Props" });

/** The kinds a layer can be saved as (the first one is the suggestion). */
export function saveableKinds(layer) {
  if (!layer || isMaskSectionLayer(layer) || layer.type === "group" || layer.type === "panorama") return [];
  if (layer.type === "pose") return ["pose"];
  if (layer.type === "sprite") return ["character"];
  const meta = normalizeLayerMeta(layer.meta);
  const raster = ["character", "prop", "background"];
  const suggested = (meta.origin === "asset" && raster.includes(meta.assetKind) && meta.assetKind)
    || CATEGORY_KINDS[layerCategory(layer)]
    || (meta.heightFactor ? "character" : "prop");
  return [suggested, ...raster.filter((kind) => kind !== suggested)];
}

export function filterAssets(assets, { kind = "", query = "" } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  return (assets || []).filter((asset) => {
    if (kind && asset.kind !== kind) return false;
    if (!needle) return true;
    return String(asset.name || "").toLowerCase().includes(needle)
      || (asset.tags || []).some((tag) => String(tag).toLowerCase().includes(needle));
  });
}

export function parseTags(text) {
  const tags = [];
  for (const part of String(text || "").split(",")) {
    const tag = part.trim().slice(0, 64);
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

export function normalizeAnchor(anchor, kind) {
  const fallback = DEFAULT_ANCHORS[kind] || DEFAULT_ANCHORS.prop;
  const x = Number(anchor?.x), y = Number(anchor?.y);
  return { x: Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : fallback.x, y: Number.isFinite(y) ? Math.min(1, Math.max(0, y)) : fallback.y };
}

/** The world rect of a `size` box whose `anchor` (fractions of the box) sits on `point`. */
export function anchoredRect(size, anchor, point, scale = 1) {
  const width = Math.max(1, (Number(size?.width) || 1) * scale);
  const height = Math.max(1, (Number(size?.height) || 1) * scale);
  return { x: point.x - width * anchor.x, y: point.y - height * anchor.y, width, height };
}

export function anchorPoint(rect, anchor) {
  return { x: rect.x + rect.width * anchor.x, y: rect.y + rect.height * anchor.y };
}

/** Scale for a character dropped with its feet at `feetY` (1 without a calibrated, enabled depth scale). */
export function dropScale(perspective, kind, feetY, height, heightFactor = 1) {
  if (kind !== "character" || !perspective?.enabled || !isPerspectiveCalibrated(perspective)) return 1;
  const expected = expectedHeightAt(perspective, feetY, heightFactor);
  return expected && height > 0 ? expected / height : 1;
}

export function presetSnapshot(settings) {
  const out = {};
  for (const [key, value] of Object.entries(settings || {})) {
    if (PRESET_EXCLUDED.test(key) || typeof value === "function") continue;
    out[key] = clone(value);
  }
  return out;
}

/** A pose layer's `layer.pose` without its bound character reference. */
export function poseForAsset(pose) {
  const result = serializePose(pose) || {};
  result.character = null;
  // The studio backdrop is a capture of the scene the pose sat in, not part of the pose.
  if (result.studio && typeof result.studio === "object") delete result.studio.background_url;
  delete result.backgroundCached;
  return result;
}

export function translatePose(pose, dx, dy) {
  const result = clone(pose) || {};
  if (result.rect) result.rect = { ...result.rect, x: result.rect.x + dx, y: result.rect.y + dy };
  return result;
}

/** A scene perspective expressed in fractions of a background rect, so it can move with it. */
export function relativePerspective(perspective, rect) {
  const p = normalizeScenePerspective(perspective);
  if (!isPerspectiveCalibrated(p) || !(rect?.width > 0 && rect?.height > 0)) return null;
  const fy = (y) => (y - rect.y) / rect.height;
  return {
    horizonY: fy(p.horizonY),
    vanishX: p.vanishX === null ? null : (p.vanishX - rect.x) / rect.width,
    referenceHeight: { feetY: fy(p.referenceHeight.feetY), heightPx: p.referenceHeight.heightPx / rect.height,
      ...(p.referenceHeight.x !== undefined ? { x: (p.referenceHeight.x - rect.x) / rect.width } : {}) },
  };
}

export function absolutePerspective(relative, rect) {
  if (!relative?.referenceHeight || !(rect?.width > 0 && rect?.height > 0)) return null;
  const ref = relative.referenceHeight;
  return {
    horizonY: rect.y + relative.horizonY * rect.height,
    vanishX: relative.vanishX == null ? null : rect.x + relative.vanishX * rect.width,
    referenceHeight: { feetY: rect.y + ref.feetY * rect.height, heightPx: ref.heightPx * rect.height,
      ...(ref.x != null ? { x: rect.x + ref.x * rect.width } : {}) },
  };
}

/**
 * A character asset's sprite set placed over the world `rect` (integers): the rect-space anchor
 * and face area scale with it, variant pixels keep their stored resolution (they are drawn
 * scaled). `urlOf(ref)` turns a stored pixel ref (a blob ref from the server) into a loadable
 * URL; data URLs pass through.
 */
export function placedSpriteSet(stored, rect, urlOf = (ref) => ref) {
  if (!stored?.rect || !Array.isArray(stored.variants)) return null;
  const set = clone(stored);
  const next = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
  const sx = next.width / Math.max(1, Number(stored.rect.width) || 1), sy = next.height / Math.max(1, Number(stored.rect.height) || 1);
  if (set.anchor) set.anchor = { x: Number(set.anchor.x) * sx, y: Number(set.anchor.y) * sy };
  if (set.faceRect) {
    const face = set.faceRect;
    set.faceRect = { x: Math.round(face.x * sx), y: Math.round(face.y * sy), width: Math.max(1, Math.round(face.width * sx)), height: Math.max(1, Math.round(face.height * sy)) };
  }
  set.rect = next;
  for (const variant of set.variants) {
    if (!variant || variant.dataURL == null) continue;
    const url = typeof variant.dataURL === "string" && variant.dataURL.startsWith("data:") ? variant.dataURL : urlOf(variant.dataURL);
    if (url) variant.dataURL = url;
    else delete variant.dataURL;
  }
  delete set.sourceLayerId;
  return set;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

class LibraryRequestError extends Error {
  constructor(message, status, data = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export class LibraryClient {
  constructor(fetchImpl) {
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  }

  async request(method, url, json) {
    const init = { method, headers: {} };
    if (json !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(json);
    }
    const res = await this.fetch(url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new LibraryRequestError(String(data?.error || `HTTP ${res.status}`).replace(/^\[VNCCS UniCanvas\]\s*/, ""), res.status, data);
    return data;
  }

  async list(scope, projectId, { kind = "", query = "" } = {}) {
    const params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (query) params.set("q", query);
    const suffix = params.toString() ? `?${params}` : "";
    return (await this.request("GET", `${assetsPath(scope, projectId)}${suffix}`)).assets || [];
  }

  get(scope, projectId, id) {
    return this.request("GET", `${assetsPath(scope, projectId)}/${encodeURIComponent(id)}`);
  }

  create(scope, projectId, asset) {
    return this.request("POST", assetsPath(scope, projectId), asset);
  }

  update(scope, projectId, id, patch) {
    return this.request("PUT", `${assetsPath(scope, projectId)}/${encodeURIComponent(id)}`, patch);
  }

  remove(scope, projectId, id) {
    return this.request("DELETE", `${assetsPath(scope, projectId)}/${encodeURIComponent(id)}`);
  }
}

// ---------------------------------------------------------------------------
// Widget integration
// ---------------------------------------------------------------------------

function currentProjectId(uc) {
  const session = uc.projectSession;
  return session?.attached ? session.projectId : null;
}

function refreshWidget(uc) {
  uc.renderLayerList();
  uc.requestRender();
  uc.syncLightStateToWidget();
  uc.scheduleFullSync();
}

/** The pixels of a layer for an asset: its hi-res source when present, else its alpha crop. */
function layerImage(uc, layer) {
  if (layer.type === "sprite" && layer.sprite?.rect && uc.sprites) {
    // A sprite set: the active variant at its stored resolution over the set's rect.
    uc.sprites.syncFromCanvas(layer);
    const active = layer.sprite.variants.find((variant) => variant.id === layer.sprite.activeVariantId);
    if (active?.pixels) return { dataURL: active.pixels.toDataURL("image/png"), rect: { ...layer.sprite.rect } };
  }
  if (layer.hiresCanvas && layer.hiresRect) {
    return { dataURL: layer.hiresCanvas.toDataURL("image/png"), rect: uc.normalizeLayerWorldRect(layer.hiresRect) };
  }
  const crop = uc.getLayerAlphaBounds(layer);
  if (!crop) return null;
  const out = uc.cloneCanvasCrop(layer.canvas, crop);
  return { dataURL: out.toDataURL("image/png"), rect: { x: uc.origin.x + crop.x, y: uc.origin.y + crop.y, width: crop.width, height: crop.height } };
}

/** The `data` of an asset of `kind` built from a layer; `previous` keeps fields the layer does not carry. */
export function layerAssetData(uc, layer, kind, previous = {}) {
  if (uc.panorama) throw new Error("the library is not available in panorama mode");
  const image = layerImage(uc, layer);
  if (!image && kind !== "pose") throw new Error("the layer is empty");
  const meta = normalizeLayerMeta(layer.meta);
  const data = {
    ...(previous || {}),
    anchor: normalizeAnchor(previous?.anchor, kind),
    imageDataURL: image?.dataURL || null,
    size: image ? { width: image.rect.width, height: image.rect.height } : null,
  };
  if (kind === "character") {
    data.identityPrompt = typeof previous?.identityPrompt === "string" ? previous.identityPrompt : (meta.prompt || "");
    data.heightFactor = layerHeightFactor(layer);
    data.meshMorphs = previous?.meshMorphs ?? null;
    data.spriteSet = previous?.spriteSet ?? null;
    if (layer.type === "sprite" && layer.sprite?.rect && uc.sprites) {
      data.spriteSet = uc.sprites.serialize(layer);
      // The feet of the set are the asset's anchor, so a drop puts them on the drop point.
      const { rect, anchor } = layer.sprite;
      data.anchor = normalizeAnchor({ x: anchor.x / rect.width, y: anchor.y / rect.height }, kind);
    }
  }
  if (kind === "background") {
    data.perspective = relativePerspective(uc.scenePerspective, image.rect) ?? previous?.perspective ?? null;
  }
  if (kind === "pose") {
    if (!layer.pose) throw new Error("the layer has no pose");
    data.pose = poseForAsset(layer.pose);
    const rect = data.pose.rect || image?.rect;
    data.size = rect ? { width: rect.width, height: rect.height } : data.size;
    // Where the rendered pose sits inside the pose rect, so both move together on insert.
    data.imageRect = image && rect ? { x: image.rect.x - rect.x, y: image.rect.y - rect.y, width: image.rect.width, height: image.rect.height } : null;
  }
  return data;
}

async function loadAssetImage(uc, scope, projectId, ref) {
  const url = assetBlobUrl(scope, projectId, ref);
  return url ? uc.loadImage(url) : null;
}

function imageCanvas(uc, image) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, image.naturalWidth || image.width);
  canvas.height = Math.max(1, image.naturalHeight || image.height);
  uc.configureImageContext(canvas.getContext("2d")).drawImage(image, 0, 0);
  return canvas;
}

/** Clears `layer` and draws `image` over the world `rect` (keeping a hi-res source when it is resampled). */
function paintLayer(uc, layer, image, rect) {
  const ctx = uc.configureImageContext(layer.canvas.getContext("2d"));
  ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  layer.hiresCanvas = null;
  layer.hiresRect = null;
  if (!image || !rect) return;
  const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
  const exact = Math.abs(width - rect.width) < 0.5 && Math.abs(height - rect.height) < 0.5
    && Number.isInteger(rect.x) && Number.isInteger(rect.y);
  if (!exact && layer.type === "raster") {
    layer.hiresCanvas = imageCanvas(uc, image);
    layer.hiresRect = { ...rect };
  }
  ctx.drawImage(image, rect.x - uc.origin.x, rect.y - uc.origin.y, rect.width, rect.height);
}

function roundRect(rect) {
  // Unscaled drops land on whole pixels so saved and inserted pixels stay identical.
  return { ...rect, x: Math.round(rect.x), y: Math.round(rect.y) };
}

async function applyPreset(uc, asset) {
  const settings = asset?.data?.settings;
  if (!settings || typeof settings !== "object") throw new Error("the preset has no settings");
  uc.applySerializedSettings(clone(settings));
  uc.syncInferenceControls?.();
  uc.flushSettingsToWidget?.();
  uc.setStatus(`Preset "${asset.name}" applied`);
  return null;
}

/** Inserts a full asset (as returned by GET) with its anchor on the world `point`; returns the new layer. */
export async function insertAsset(uc, asset, point) {
  if (!asset) return null;
  if (asset.kind === "preset") return applyPreset(uc, asset);
  if (uc.panorama) throw new Error("the library is not available in panorama mode");
  if (uc.transformDraft) throw new Error("apply or cancel the active transform first");
  const scope = asset.scope || "global";
  const projectId = currentProjectId(uc);
  const data = asset.data || {};
  const kind = asset.kind;
  const anchor = normalizeAnchor(data.anchor, kind);
  const image = await loadAssetImage(uc, scope, projectId, data.imageDataURL);
  if (uc._disposed) return null;
  const naturalSize = image ? { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height } : null;
  const size = data.size?.width > 0 && data.size?.height > 0 ? data.size : naturalSize;
  if (!size) throw new Error("the asset has no image");
  const meta = { assetId: asset.id, assetScope: scope, assetKind: kind, sourceName: asset.name };
  if (KIND_CATEGORIES[kind]) meta.category = KIND_CATEGORIES[kind];
  if (kind === "character") {
    if (Number(data.heightFactor) > 0) meta.heightFactor = Number(data.heightFactor);
    if (data.identityPrompt) meta.prompt = data.identityPrompt;
    meta.character = { id: asset.id, name: asset.name };
  }
  const scale = dropScale(uc.scenePerspective, kind, point.y, size.height, Number(data.heightFactor) || 1);
  let rect = anchoredRect(size, anchor, point, scale);
  if (scale === 1) rect = roundRect(rect);

  if (kind === "pose") {
    if (!data.pose) throw new Error("the pose asset has no pose");
    const poseRect = data.pose.rect || rect;
    const dx = rect.x - poseRect.x, dy = rect.y - poseRect.y;
    const imageRect = data.imageRect ? { x: rect.x + data.imageRect.x, y: rect.y + data.imageRect.y, width: data.imageRect.width, height: data.imageRect.height } : null;
    if (!uc.ensureWorldRectBounds(rect, 0) || (imageRect && !uc.ensureWorldRectBounds(imageRect, 0))) throw new Error("the drop point is outside the canvas limits");
    if (uc.tool === "pose") uc.finishPoseEdit?.(true);
    const layer = uc.addLayer("pose", asset.name, true, true, createLayerMeta("asset", meta));
    layer.pose = translatePose(data.pose, dx, dy);
    layer.pose.rect = { ...rect };
    layer.pose.panoramaCamera = null;
    paintLayer(uc, layer, image, imageRect);
    uc.invalidateLayerCaches(layer);
    uc.autoFileLayer?.(layer);
    refreshWidget(uc);
    uc.setStatus(`Inserted pose "${asset.name}"`);
    return layer;
  }

  if (!uc.ensureWorldRectBounds(rect, 0)) throw new Error("the drop point is outside the canvas limits");
  if (kind === "character" && data.spriteSet && uc.sprites) {
    // A character with a sprite set comes in as a sprite layer holding every variant.
    const placed = placedSpriteSet(data.spriteSet, rect, (ref) => assetBlobUrl(scope, projectId, ref));
    const sprite = placed && await uc.sprites.loadSet(placed);
    if (uc._disposed) return null;
    if (sprite?.variants?.some((variant) => variant.pixels)) {
      const layer = uc.addLayer("sprite", asset.name, true, true, createLayerMeta("asset", meta));
      uc.sprites.attachSet(layer, sprite);
      uc.autoFileLayer?.(layer);
      refreshWidget(uc);
      uc.setStatus(`Inserted character "${asset.name}" with ${sprite.variants.length} sprite variant${sprite.variants.length === 1 ? "" : "s"}${scale !== 1 ? " (depth scaled)" : ""}`);
      return layer;
    }
  }
  let layer;
  if (kind === "background") {
    // Backgrounds go under everything: one snapshot entry covers the insert and the reorder.
    uc.recordHistoryBefore();
    layer = uc.addLayer("raster", asset.name, false, true, createLayerMeta("asset", meta));
    uc.layers = uc.layers.filter((item) => item !== layer);
    uc.layers.push(layer);
    uc.normalizeLayerOrder();
  } else {
    layer = uc.addLayer("raster", asset.name, true, true, createLayerMeta("asset", meta));
  }
  paintLayer(uc, layer, image, rect);
  uc.invalidateLayerCaches(layer);
  // Category folders (issue #17): the move joins the add's undo entry when auto-file is on.
  if (kind !== "background") uc.autoFileLayer?.(layer);
  refreshWidget(uc);
  if (kind === "background" && data.perspective && !isPerspectiveCalibrated(uc.scenePerspective)) {
    const absolute = absolutePerspective(data.perspective, rect);
    if (absolute) editScenePerspective(uc, (next) => Object.assign(next, absolute));
  }
  uc.setStatus(`Inserted ${ASSET_KIND_LABELS[kind]?.toLowerCase() || "asset"} "${asset.name}"${scale !== 1 ? " (depth scaled)" : ""}`);
  return layer;
}

function linkedAsset(layer) {
  const meta = normalizeLayerMeta(layer?.meta);
  return meta.assetId && (meta.assetScope === "global" || meta.assetScope === "project")
    ? { id: meta.assetId, scope: meta.assetScope, kind: meta.assetKind || null } : null;
}

function setLayerMeta(uc, layer, meta) {
  const before = { meta: normalizeLayerMeta(layer.meta) };
  const after = { meta: normalizeLayerMeta(meta) };
  layer.meta = after.meta;
  uc.pushHistoryEntry({ kind: "layerProps", layerId: layer.id, before, after });
}

/** Update from library: the layer takes the asset's current pixels (and pose), keeping its place and height. */
export async function updateLayerFromLibrary(uc, layer, client = uc.library?.client) {
  const link = linkedAsset(layer);
  if (!link) throw new Error("the layer is not linked to a library asset");
  if (uc.panorama) throw new Error("the library is not available in panorama mode");
  const asset = await client.get(link.scope, currentProjectId(uc), link.id);
  const data = asset.data || {};
  const anchor = normalizeAnchor(data.anchor, asset.kind);
  const image = await loadAssetImage(uc, link.scope, currentProjectId(uc), data.imageDataURL);
  if (uc._disposed || !uc.layers.includes(layer)) return null;
  const size = data.size?.width > 0 ? data.size : image ? { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height } : null;
  const current = layer.type === "pose" && layer.pose?.rect ? layer.pose.rect
    : layer.type === "sprite" && layer.sprite?.rect ? layer.sprite.rect : uc.getLayerWorldBounds(layer);
  if (!size || !current) throw new Error("nothing to update");
  const scale = current.height > 0 ? current.height / size.height : 1;
  let rect = anchoredRect(size, anchor, anchorPoint(current, anchor), scale);
  if (Math.abs(scale - 1) < 1e-6) rect = roundRect(rect);
  if (layer.type === "sprite" && data.spriteSet && uc.sprites) {
    const placed = placedSpriteSet(data.spriteSet, rect, (ref) => assetBlobUrl(link.scope, currentProjectId(uc), ref));
    const sprite = placed && await uc.sprites.loadSet(placed);
    if (uc._disposed || !uc.layers.includes(layer) || !sprite) return null;
    uc.ensureWorldRectBounds(sprite.rect, 0);
    const before = uc.createLayerPixelSnapshot(layer);
    uc.sprites.attachSet(layer, sprite);
    uc.pushHistoryEntry({ kind: "layerPixels", layerId: layer.id, before, after: uc.createLayerPixelSnapshot(layer) });
    refreshWidget(uc);
    uc.setStatus(`Updated "${layer.name}" from the library`);
    return asset;
  }
  const before = uc.createLayerPixelSnapshot(layer);
  if (layer.type === "pose" && data.pose) {
    const poseRect = data.pose.rect || rect;
    const pose = translatePose(data.pose, rect.x - poseRect.x, rect.y - poseRect.y);
    pose.rect = { ...rect };
    pose.character = layer.pose?.character ?? null; // the bound reference stays with the layer
    pose.panoramaCamera = layer.pose?.panoramaCamera ?? null;
    if (uc.poseEditor?.layer === layer) uc.poseEditor.release();
    layer.pose = pose;
    const imageRect = data.imageRect ? { x: rect.x + data.imageRect.x * scale, y: rect.y + data.imageRect.y * scale, width: data.imageRect.width * scale, height: data.imageRect.height * scale } : null;
    if (imageRect) uc.ensureWorldRectBounds(imageRect, 0);
    paintLayer(uc, layer, image, imageRect);
  } else {
    uc.ensureWorldRectBounds(rect, 0);
    paintLayer(uc, layer, image, rect);
  }
  uc.invalidateLayerCaches(layer);
  uc.pushHistoryEntry({ kind: "layerPixels", layerId: layer.id, before, after: uc.createLayerPixelSnapshot(layer) });
  refreshWidget(uc);
  uc.setStatus(`Updated "${layer.name}" from the library`);
  return asset;
}

/** Push to library: the linked asset takes this layer's pixels (and pose); name and tags stay. */
export async function pushLayerToLibrary(uc, layer, client = uc.library?.client) {
  const link = linkedAsset(layer);
  if (!link) throw new Error("the layer is not linked to a library asset");
  const projectId = currentProjectId(uc);
  const asset = await client.get(link.scope, projectId, link.id);
  const data = layerAssetData(uc, layer, asset.kind, asset.data);
  const updated = await client.update(link.scope, projectId, link.id, { data, ifRev: asset.rev });
  uc.setStatus(`Pushed "${layer.name}" to the library`);
  uc.library?.refresh();
  return updated;
}

export async function saveLayerToLibrary(uc, layer, { kind, name, tags = [], scope, identityPrompt } = {}, client = uc.library?.client) {
  if (!saveableKinds(layer).includes(kind)) throw new Error(`this layer cannot be saved as ${kind}`);
  const projectId = currentProjectId(uc);
  if (scope === "project" && !projectId) throw new Error("the canvas is not in a project");
  const data = layerAssetData(uc, layer, kind, kind === "character" ? { identityPrompt: identityPrompt ?? undefined } : {});
  if (kind === "character" && typeof identityPrompt === "string") data.identityPrompt = identityPrompt;
  const asset = await client.create(scope, projectId, { kind, name: name || layer.name, tags, data });
  // The layer becomes a placed copy of the new asset, so Update / Push work on it.
  setLayerMeta(uc, layer, { ...normalizeLayerMeta(layer.meta), assetId: asset.id, assetScope: scope, assetKind: kind });
  uc.syncLightStateToWidget();
  uc.scheduleFullSync();
  uc.setStatus(`Saved "${asset.name}" to the ${scope === "global" ? "global library" : "project library"}`);
  uc.library?.refresh();
  return asset;
}

export async function savePresetToLibrary(uc, { name, tags = [], scope } = {}, client = uc.library?.client) {
  const projectId = currentProjectId(uc);
  if (scope === "project" && !projectId) throw new Error("the canvas is not in a project");
  const asset = await client.create(scope, projectId, { kind: "preset", name: name || "Preset", tags, data: { settings: presetSnapshot(uc.settings) } });
  uc.setStatus(`Saved preset "${asset.name}"`);
  uc.library?.refresh();
  return asset;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const STYLES = `
.vnccs-uc-library-tabs { display:flex; gap:2px; }
.vnccs-uc-library-tab { border:0; background:transparent; color:inherit; opacity:.55; font:inherit; font-weight:600; padding:0 6px 0 0; cursor:pointer; }
.vnccs-uc-library-tab.active { opacity:1; }
.vnccs-uc-library { flex:1 1 auto; display:grid; gap:6px; padding:8px; min-height:0; grid-template-rows:auto auto minmax(0,1fr) auto; }
.vnccs-uc-library[hidden] { display:none; }
.vnccs-uc-library-bar { display:flex; gap:4px; align-items:center; }
.vnccs-uc-library-bar input { flex:1; min-width:0; }
.vnccs-uc-library-scope { display:flex; border-radius:6px; overflow:hidden; border:1px solid rgba(255,255,255,.12); }
.vnccs-uc-library-scope button { border:0; background:transparent; color:inherit; font:11px sans-serif; padding:3px 8px; cursor:pointer; }
.vnccs-uc-library-scope button.active { background:rgba(124,92,255,.35); }
.vnccs-uc-library-scope button:disabled { opacity:.4; cursor:default; }
.vnccs-uc-library-kinds { display:flex; flex-wrap:wrap; gap:3px; }
.vnccs-uc-library-kinds button { border:1px solid rgba(255,255,255,.12); border-radius:10px; background:transparent; color:inherit; font:10px sans-serif; padding:2px 7px; cursor:pointer; }
.vnccs-uc-library-kinds button.active { background:rgba(124,92,255,.35); border-color:rgba(124,92,255,.6); }
.vnccs-uc-library-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(84px, 1fr)); gap:6px; overflow:auto; align-content:start; min-height:80px; }
.vnccs-uc-library-card { position:relative; display:grid; gap:3px; padding:4px; border-radius:8px; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); cursor:grab; font:10px sans-serif; }
.vnccs-uc-library-card:hover { border-color:rgba(124,92,255,.6); }
.vnccs-uc-library-thumb { aspect-ratio:1; border-radius:6px; background:repeating-conic-gradient(#2a2a36 0 25%, #1c1c26 0 50%) 0 0/12px 12px; display:grid; place-items:center; overflow:hidden; }
.vnccs-uc-library-thumb img { max-width:100%; max-height:100%; object-fit:contain; pointer-events:none; }
.vnccs-uc-library-name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.vnccs-uc-library-kind { opacity:.6; }
.vnccs-uc-library-card .vnccs-uc-library-delete { position:absolute; top:2px; right:2px; display:none; width:18px; height:18px; padding:0; border:0; border-radius:9px; background:rgba(0,0,0,.6); color:#fff; cursor:pointer; }
.vnccs-uc-library-card:hover .vnccs-uc-library-delete { display:block; }
.vnccs-uc-library-empty { opacity:.6; font:11px sans-serif; padding:8px 2px; grid-column:1/-1; }
.vnccs-uc-library-note { opacity:.6; font:10px sans-serif; }
.vnccs-uc-library-dialog { position:absolute; z-index:45; width:260px; padding:10px; border-radius:10px; background:rgba(20,16,30,.97); border:1px solid rgba(255,255,255,.12); display:grid; gap:6px; font:11px sans-serif; color:#e8e8f0; }
.vnccs-uc-library-dialog label { display:grid; gap:3px; }
.vnccs-uc-library-dialog .row { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
`;

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

function reportError(uc, label, error) {
  console.warn(`[VNCCS UniCanvas] ${label} failed`, error);
  uc.setStatus(`${label}: ${error?.message || error}`, true);
}

function placeDialog(uc, element, point) {
  const host = uc.container.getBoundingClientRect();
  const left = point ? point.x - host.left : 24;
  const top = point ? point.y - host.top : 48;
  element.style.left = `${Math.max(8, Math.min(left, host.width - 270))}px`;
  element.style.top = `${Math.max(8, Math.min(top, host.height - 260))}px`;
}

function closeDialog(uc) {
  uc._vnccsLibraryDialog?.remove();
  uc._vnccsLibraryDialog = null;
}

function scopeOptions(uc, selected) {
  const project = Boolean(currentProjectId(uc));
  const value = selected === "project" && project ? "project" : (project && !selected ? "project" : "global");
  return `<option value="project"${project ? "" : " disabled"}${value === "project" ? " selected" : ""}>This project</option>
    <option value="global"${value === "global" ? " selected" : ""}>Global library</option>`;
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

/** "Save to library..." dialog for a layer, or for the generation preset when `layer` is null. */
export function openSaveDialog(uc, layer, point = null) {
  closeDialog(uc);
  const kinds = layer ? saveableKinds(layer) : ["preset"];
  if (!kinds.length) {
    uc.setStatus("Masks and groups cannot be saved to the library", true);
    return null;
  }
  const meta = normalizeLayerMeta(layer?.meta);
  const dialog = document.createElement("div");
  dialog.className = "vnccs-uc-library-dialog";
  dialog.innerHTML = `
    <strong>${layer ? "Save layer to library" : "Save generation preset"}</strong>
    <label>Name <input class="vnccs-uc-input" data-field="name" value="${escapeHtml(layer ? layer.name : "House style")}"></label>
    <div class="row">
      <label>Kind <select class="vnccs-uc-select" data-field="kind"${kinds.length > 1 ? "" : " disabled"}>${kinds.map((kind) => `<option value="${kind}">${ASSET_KIND_LABELS[kind]}</option>`).join("")}</select></label>
      <label>Scope <select class="vnccs-uc-select" data-field="scope">${scopeOptions(uc, uc.library?.scope)}</select></label>
    </div>
    <label>Tags (comma separated) <input class="vnccs-uc-input" data-field="tags" placeholder="cast, outdoor"></label>
    <label data-character-only>Identity prompt <input class="vnccs-uc-input" data-field="identity" value="${escapeHtml(meta.prompt || "")}"></label>
    <div class="row">
      <button class="vnccs-uc-btn" type="button" data-action="cancel">Cancel</button>
      <button class="vnccs-uc-btn primary" type="button" data-action="save">Save</button>
    </div>`;
  const field = (name) => dialog.querySelector(`[data-field="${name}"]`);
  const syncKind = () => {
    const identity = dialog.querySelector("[data-character-only]");
    identity.hidden = field("kind").value !== "character";
  };
  field("kind").addEventListener("change", syncKind);
  syncKind();
  const save = async () => {
    const options = { kind: field("kind").value, name: field("name").value.trim(), tags: parseTags(field("tags").value), scope: field("scope").value };
    closeDialog(uc);
    try {
      if (layer) await saveLayerToLibrary(uc, layer, { ...options, identityPrompt: field("identity").value });
      else await savePresetToLibrary(uc, options);
    } catch (error) {
      reportError(uc, "Save to library", error);
    }
  };
  dialog.querySelector('[data-action="save"]').addEventListener("click", save);
  dialog.querySelector('[data-action="cancel"]').addEventListener("click", () => closeDialog(uc));
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.tagName === "INPUT") save();
    if (event.key === "Escape") closeDialog(uc);
    event.stopPropagation();
  });
  uc.container.appendChild(dialog);
  installCustomSelects(dialog);
  placeDialog(uc, dialog, point);
  uc._vnccsLibraryDialog = dialog;
  field("name").focus();
  field("name").select();
  return dialog;
}

class LibraryPanel {
  constructor(uc, client) {
    this.uc = uc;
    this.client = client;
    this.scope = "project";
    this.kind = "";
    this.query = "";
    this.assets = [];
    this.loadSeq = 0;
    this.visible = false;
    this.element = null;
  }

  get effectiveScope() {
    return this.scope === "project" && !currentProjectId(this.uc) ? "global" : this.scope;
  }

  build() {
    const el = document.createElement("div");
    el.className = "vnccs-uc-library";
    el.hidden = true;
    el.innerHTML = `
      <div class="vnccs-uc-library-bar">
        <div class="vnccs-uc-library-scope">
          <button type="button" data-scope="project" title="Assets saved in this project">Project</button>
          <button type="button" data-scope="global" title="Assets shared by every project">Global</button>
        </div>
        <input class="vnccs-uc-input" type="search" placeholder="Search name or tag" data-library-search>
      </div>
      <div class="vnccs-uc-library-kinds">
        <button type="button" data-kind="">All</button>
        ${ASSET_KINDS.map((kind) => `<button type="button" data-kind="${kind}">${ASSET_KIND_LABELS[kind]}</button>`).join("")}
      </div>
      <div class="vnccs-uc-library-grid" data-library-grid></div>
      <div class="vnccs-uc-library-note">Drag an asset onto the canvas, or click it to insert at the bbox. Right-click a layer to save it.</div>`;
    el.querySelectorAll("[data-scope]").forEach((button) => button.addEventListener("click", () => {
      this.scope = button.dataset.scope;
      this.refresh();
    }));
    el.querySelectorAll("[data-kind]").forEach((button) => button.addEventListener("click", () => {
      this.kind = button.dataset.kind;
      this.render();
    }));
    const search = el.querySelector("[data-library-search]");
    // Filtering is local and runs on every keystroke.
    search.addEventListener("input", () => {
      this.query = search.value;
      this.render();
    });
    search.addEventListener("keydown", (event) => event.stopPropagation());
    this.grid = el.querySelector("[data-library-grid]");
    this.element = el;
    return el;
  }

  async refresh() {
    if (!this.element || !this.visible) return;
    const seq = ++this.loadSeq;
    const scope = this.effectiveScope;
    const projectId = currentProjectId(this.uc);
    try {
      const assets = await this.client.list(scope, projectId);
      if (seq !== this.loadSeq) return; // a newer scope / project won
      this.assets = assets.map((asset) => ({ ...asset, scope, projectId }));
      this.error = "";
    } catch (error) {
      if (seq !== this.loadSeq) return;
      this.assets = [];
      this.error = error?.message || String(error);
    }
    this.render();
  }

  render() {
    if (!this.element) return;
    const scope = this.effectiveScope;
    const projectId = currentProjectId(this.uc);
    this.element.querySelectorAll("[data-scope]").forEach((button) => {
      button.classList.toggle("active", button.dataset.scope === scope);
      button.disabled = button.dataset.scope === "project" && !projectId;
      if (button.disabled) button.title = "The canvas is not in a project yet";
    });
    this.element.querySelectorAll("[data-kind]").forEach((button) => button.classList.toggle("active", button.dataset.kind === this.kind));
    this.grid.replaceChildren();
    const items = filterAssets(this.assets, { kind: this.kind, query: this.query });
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "vnccs-uc-library-empty";
      empty.textContent = this.error ? `Library unavailable: ${this.error}` : this.assets.length ? "No asset matches." : "No assets yet. Right-click a layer and choose Save to library.";
      this.grid.appendChild(empty);
      return;
    }
    for (const asset of items) this.grid.appendChild(this.card(asset));
  }

  card(asset) {
    const card = document.createElement("div");
    card.className = "vnccs-uc-library-card";
    card.dataset.assetId = asset.id;
    card.dataset.assetKind = asset.kind;
    card.draggable = asset.kind !== "preset";
    card.title = `${asset.name}${asset.tags?.length ? `\nTags: ${asset.tags.join(", ")}` : ""}\n${asset.kind === "preset" ? "Click to apply" : "Drag onto the canvas or click to insert"}`;
    const thumb = document.createElement("div");
    thumb.className = "vnccs-uc-library-thumb";
    const url = asset.thumbnail ? assetBlobUrl(asset.scope, asset.projectId, asset.thumbnail) : null;
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      thumb.appendChild(img);
    } else {
      thumb.textContent = ASSET_KIND_LABELS[asset.kind] || asset.kind;
    }
    const name = document.createElement("div");
    name.className = "vnccs-uc-library-name";
    name.textContent = asset.name;
    const kind = document.createElement("div");
    kind.className = "vnccs-uc-library-kind";
    kind.textContent = ASSET_KIND_LABELS[asset.kind] || asset.kind;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "vnccs-uc-library-delete";
    remove.textContent = "×";
    remove.title = "Delete from the library";
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!globalThis.confirm?.(`Delete "${asset.name}" from the ${asset.scope === "global" ? "global" : "project"} library? Placed layers keep their pixels.`)) return;
      try {
        await this.client.remove(asset.scope, asset.projectId, asset.id);
        this.refresh();
      } catch (error) {
        reportError(this.uc, "Delete asset", error);
      }
    });
    card.append(thumb, name, kind, remove);
    card.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData(ASSET_DRAG_TYPE, JSON.stringify({ scope: asset.scope, id: asset.id }));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
    });
    card.addEventListener("click", () => {
      const bbox = this.uc.bbox;
      const anchor = DEFAULT_ANCHORS[asset.kind] || DEFAULT_ANCHORS.prop;
      this.insert(asset.scope, asset.id, anchorPoint(bbox, anchor));
    });
    return card;
  }

  async insert(scope, id, point) {
    try {
      const asset = await this.client.get(scope, currentProjectId(this.uc), id);
      return await insertAsset(this.uc, { ...asset, scope }, point);
    } catch (error) {
      reportError(this.uc, "Insert asset", error);
      return null;
    }
  }

  setVisible(visible) {
    this.visible = visible;
    if (this.element) this.element.hidden = !visible;
    if (visible) this.refresh();
  }
}

function installTabs(uc, panel) {
  const section = uc.layerList?.closest?.(".vnccs-uc-section");
  const head = section?.querySelector(".vnccs-uc-section-head");
  const body = uc.layerList?.parentElement;
  if (!section || !head || !body) return;
  const title = head.querySelector(".vnccs-uc-section-title");
  const actions = head.querySelector(".vnccs-uc-section-actions");
  const tabs = document.createElement("div");
  tabs.className = "vnccs-uc-library-tabs vnccs-uc-section-title";
  const tab = (label, library) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vnccs-uc-library-tab";
    button.textContent = label;
    button.dataset.libraryTab = library ? "library" : "layers";
    button.addEventListener("click", () => show(library));
    return button;
  };
  const layersTab = tab("Layers", false);
  const libraryTab = tab("Library", true);
  tabs.append(layersTab, libraryTab);
  const show = (library) => {
    layersTab.classList.toggle("active", !library);
    libraryTab.classList.toggle("active", library);
    // The body's own class sets `display`, so `hidden` alone would not hide it.
    body.style.display = library ? "none" : "";
    if (actions) actions.style.visibility = library ? "hidden" : "";
    panel.setVisible(library);
  };
  title?.replaceWith(tabs);
  section.appendChild(panel.build());
  show(false);
  uc.showLibraryTab = show;
}

function installCanvasDrop(uc, panel) {
  const target = uc.stageWrap;
  if (!target) return;
  const isAssetDrag = (event) => [...(event.dataTransfer?.types || [])].includes(ASSET_DRAG_TYPE);
  const options = { signal: uc._eventAbortController?.signal };
  target.addEventListener("dragover", (event) => {
    if (!isAssetDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, options);
  target.addEventListener("drop", (event) => {
    if (!isAssetDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    let payload = null;
    try { payload = JSON.parse(event.dataTransfer.getData(ASSET_DRAG_TYPE)); } catch (_) { payload = null; }
    if (!payload?.id) return;
    panel.insert(payload.scope, payload.id, uc.worldFromEvent(event));
  }, options);
}

function installLayerMenu(uc) {
  const run = (label, work) => (layer) => work(layer).catch((error) => reportError(uc, label, error));
  uc.layerMenuExtensions = [
    ...(uc.layerMenuExtensions || []),
    { id: "library-save", label: "Save to library...", visible: (layer) => saveableKinds(layer).length > 0 && !uc.panorama,
      run: (layer, point) => openSaveDialog(uc, layer, point) },
    { id: "library-update", label: "Update from library", visible: (layer) => Boolean(linkedAsset(layer)) && !uc.panorama,
      run: run("Update from library", (layer) => updateLayerFromLibrary(uc, layer)) },
    { id: "library-push", label: "Push to library", visible: (layer) => Boolean(linkedAsset(layer)) && !uc.panorama,
      run: run("Push to library", (layer) => pushLayerToLibrary(uc, layer)) },
  ];
}

export function installUniCanvasLibrary(uc, { fetchImpl } = {}) {
  if (!uc || uc.library) return uc?.library;
  const client = new LibraryClient(fetchImpl);
  const panel = new LibraryPanel(uc, client);
  uc.library = {
    client,
    panel,
    get scope() { return panel.effectiveScope; },
    refresh: () => panel.refresh(),
    insert: (asset, point) => insertAsset(uc, asset, point),
    openSaveDialog: (layer, point) => openSaveDialog(uc, layer, point),
    // Settings popover: "Asset library" section with the preset save.
    buildSettingsSection(body) {
      const button = uc._button("Save generation preset to library...", "vnccs-uc-btn", () => openSaveDialog(uc, null, null),
        "Model family, checkpoint, LoRAs, sampler, steps, cfg and prompts as a reusable preset");
      body.appendChild(button);
    },
  };
  installLayerMenu(uc);
  if (typeof document === "undefined") return uc.library;
  ensureStyles();
  installTabs(uc, panel);
  // The widget wires its AbortController after the installers run (see installUniCanvasLayerTools).
  queueMicrotask(() => {
    if (uc._disposed) return;
    installCanvasDrop(uc, panel);
    const close = (event) => {
      // Custom select menus open on document.body; picking an option must keep the dialog.
      if (event.target?.closest?.(".vnccs-custom-select-menu")) return;
      if (uc._vnccsLibraryDialog && !uc._vnccsLibraryDialog.contains(event.target)) closeDialog(uc);
    };
    document.addEventListener("pointerdown", close, { signal: uc._eventAbortController?.signal });
  });
  uc.projectSession?.onChange?.(() => {
    const key = `${currentProjectId(uc) || ""}`;
    if (key === panel.lastProjectKey) return;
    panel.lastProjectKey = key;
    panel.refresh();
  });
  return uc.library;
}
