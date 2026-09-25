/**
 * VNCCS UniCanvas - layer provenance (`layer.meta`) and pixel revisions.
 *
 * - Every layer carries `meta = { origin, createdAt, ... }` saying where its pixels came from.
 *   Generated layers also carry the settings snapshot of the run that produced them.
 * - Every layer carries a runtime `pixelRevision` that changes whenever its pixels change. It is
 *   not serialized; project saves (Plan 10.2/10.3) compare it to decide which layers to upload.
 *   Revisions come from one monotonic counter, so a value is never reused, not even after undo
 *   swaps a layer object for its history clone.
 * The widget only calls these helpers at its creation sites and pixel-invalidation points.
 */

export const LAYER_ORIGINS = Object.freeze([
  "base", "paint", "generate", "bake", "sprite", "import", "psd", "paste", "duplicate",
  "rasterize", "split", "merge", "occluder", "shadow", "asset", "unknown",
]);
const ORIGIN_SET = new Set(LAYER_ORIGINS);

// Folder categories for automatic filing (issue #17). `meta.category` holds the naming model's
// answer; layers without one are filed by rules.
export const LAYER_CATEGORIES = Object.freeze(["Background", "Characters", "Props", "Effects", "Lighting", "Overlays", "Other"]);

export function normalizeLayerCategory(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return LAYER_CATEGORIES.find((category) => category.toLowerCase() === text);
}

const STRING_FIELDS = ["historyId", "prompt", "negative", "mode", "model", "sourceName", "derivedFrom", "assetId", "assetScope", "assetKind"];
const NUMBER_FIELDS = ["seed", "createdAt", "heightFactor", "steps", "cfg", "denoise"];

let revisionCounter = 0;

/** Gives `layer` a fresh pixel revision. Call it on every pixel change, never on rename/visibility/opacity. */
export function bumpLayerPixelRevision(layer) {
  if (!layer) return 0;
  revisionCounter += 1;
  layer.pixelRevision = revisionCounter;
  return revisionCounter;
}

export function newHistoryId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `gen_${Date.now().toString(36)}_${random}`;
}

function cleanString(value, max = 4000) {
  return typeof value === "string" && value ? value.slice(0, max) : undefined;
}

function cleanNumber(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

/** Normalizes a raw meta object (from a saved state, a history clone or a creation site). */
export function normalizeLayerMeta(raw) {
  if (!raw || typeof raw !== "object") return { origin: "unknown" };
  const meta = { origin: ORIGIN_SET.has(raw.origin) ? raw.origin : "unknown" };
  for (const key of STRING_FIELDS) {
    const value = cleanString(raw[key]);
    if (value !== undefined) meta[key] = value;
  }
  for (const key of NUMBER_FIELDS) {
    const value = cleanNumber(raw[key]);
    if (value !== undefined) meta[key] = value;
  }
  if (raw.character && typeof raw.character === "object") {
    const id = cleanString(raw.character.id, 200);
    const name = cleanString(raw.character.name, 200);
    if (id || name) meta.character = { ...(id ? { id } : {}), ...(name ? { name } : {}) };
  }
  if (Array.isArray(raw.loras)) {
    const loras = raw.loras
      .filter((entry) => entry && typeof entry.name === "string" && entry.name)
      .map((entry) => ({ name: entry.name.slice(0, 400), strength: cleanNumber(entry.strength) ?? 1 }));
    if (loras.length) meta.loras = loras;
  }
  for (const key of ["sampler", "scheduler"]) {
    const value = cleanString(raw[key], 200);
    if (value !== undefined) meta[key] = value;
  }
  const category = normalizeLayerCategory(raw.category);
  if (category) meta.category = category;
  // ControlNet that steered a generated layer (issue #45): type and strength.
  if (raw.control && typeof raw.control === "object") {
    const type = cleanString(raw.control.type, 64);
    if (type) meta.control = { type, strength: cleanNumber(raw.control.strength) ?? 1, ...(cleanString(raw.control.layerName, 200) ? { layerName: cleanString(raw.control.layerName, 200) } : {}) };
  }
  return meta;
}

/** A new meta record for a layer created now. */
export function createLayerMeta(origin, extra = {}) {
  return normalizeLayerMeta({ ...extra, origin: ORIGIN_SET.has(origin) ? origin : "unknown", createdAt: Date.now() });
}

/** Sets `layer.meta` for a creation site; returns the layer. */
export function setLayerOrigin(layer, origin, extra = {}) {
  if (layer) layer.meta = createLayerMeta(origin, extra);
  return layer;
}

export function cloneLayerMeta(meta) {
  return normalizeLayerMeta(meta);
}

/** The model a generation used, in words a person recognizes. */
export function describeGenerationModel(settings = {}, modelBase = "") {
  const file = settings.model_loader === "gguf" ? settings.gguf_model_name
    : settings.model_loader === "checkpoint" || !settings.diffusion_model_name ? settings.ckpt_name
      : settings.diffusion_model_name;
  const family = String(settings.generation_mode || modelBase || "").trim();
  if (file) return family ? `${family} / ${file}` : String(file);
  return family || undefined;
}

/** Settings snapshot stored on every staging item of one generation run. */
export function buildStagingSnapshot(settings = {}, { mode, bbox, historyId, modelBase } = {}) {
  const loras = (Array.isArray(settings.lora_stack) ? settings.lora_stack : [])
    .filter((entry) => entry && entry.name)
    .map((entry) => ({ name: String(entry.name), strength: cleanNumber(entry.strength) ?? 1 }));
  return {
    prompt: typeof settings.positive === "string" ? settings.positive : "",
    negative: typeof settings.negative === "string" ? settings.negative : "",
    mode: mode || "",
    model: describeGenerationModel(settings, modelBase) || "",
    modelFamily: String(settings.generation_mode || modelBase || ""),
    ckpt: String(settings.ckpt_name || settings.diffusion_model_name || settings.gguf_model_name || ""),
    loras,
    seed: cleanNumber(settings.seed),
    steps: cleanNumber(settings.steps),
    cfg: cleanNumber(settings.cfg),
    sampler: typeof settings.sampler_name === "string" ? settings.sampler_name : undefined,
    scheduler: typeof settings.scheduler === "string" ? settings.scheduler : undefined,
    denoise: cleanNumber(settings.denoise),
    bbox: bbox ? { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height } : null,
    historyId: historyId || newHistoryId(),
  };
}

/** Meta for a layer accepted from a staging item carrying `snapshot`. */
export function metaFromStagingSnapshot(snapshot) {
  if (!snapshot) return createLayerMeta("generate");
  return createLayerMeta("generate", {
    historyId: snapshot.historyId,
    prompt: snapshot.prompt,
    negative: snapshot.negative,
    mode: snapshot.mode,
    model: snapshot.model,
    seed: snapshot.seed,
    steps: snapshot.steps,
    cfg: snapshot.cfg,
    sampler: snapshot.sampler,
    scheduler: snapshot.scheduler,
    denoise: snapshot.denoise,
    loras: snapshot.loras,
    control: snapshot.control,
  });
}

const ORIGIN_LABELS = {
  base: "Base layer", paint: "Painted", generate: "Generated", bake: "Baked character",
  sprite: "Sprite", import: "Imported image", psd: "Imported from PSD", paste: "Pasted",
  duplicate: "Duplicate", rasterize: "Rasterized", split: "Split", merge: "Merged pose layers", occluder: "Occluder",
  shadow: "Shadow", asset: "From asset library", unknown: "Unknown origin",
};

function truncate(text, max) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Tooltip text for a layer row. */
export function formatProvenanceTooltip(meta, layers = []) {
  const record = normalizeLayerMeta(meta);
  const lines = [`Origin: ${ORIGIN_LABELS[record.origin] || record.origin}`];
  if (record.sourceName) lines.push(`Source: ${truncate(record.sourceName, 80)}`);
  if (record.derivedFrom) {
    const source = layers.find((layer) => layer.id === record.derivedFrom);
    lines.push(`From: ${source ? truncate(source.name, 60) : "a deleted layer"}`);
  }
  if (record.origin === "generate") {
    if (record.prompt) lines.push(`Prompt: ${truncate(record.prompt, 120)}`);
    if (record.model) lines.push(`Model: ${truncate(record.model, 80)}`);
    if (record.seed !== undefined) lines.push(`Seed: ${record.seed}`);
    if (record.control) lines.push(`ControlNet: ${record.control.type} ${record.control.strength}`);
  }
  return lines.join("\n");
}
