/**
 * VNCCS UniCanvas - deterministic layer names and categories from provenance (issue #17).
 *
 * Pure helpers, no DOM: they read `layer.meta` (vnccs_unicanvas_provenance.mjs), pose data and
 * the layer stack, and never call the naming model. vnccs_unicanvas_naming.mjs applies them on
 * layer creation and asks the model only where these rules have nothing better than a fallback.
 *
 * nameSource: "auto" (rules or model, may be replaced), "user" (typed by the user, never replaced
 * automatically) or "import" (file stem or PSD layer name, never replaced by the model).
 */

import { isMaskSectionLayer } from "./vnccs_unicanvas_control.mjs";
import { LAYER_CATEGORIES, normalizeLayerCategory } from "./vnccs_unicanvas_provenance.mjs";

export { LAYER_CATEGORIES, normalizeLayerCategory };

export const NAME_SOURCES = Object.freeze(["auto", "user", "import"]);
export const CATEGORY_CHARACTERS = "Characters";
export const CATEGORY_OTHER = "Other";
export const OCCLUDER_PREFIX = "Occluder - ";

/** The layer name a model answer becomes: occluders keep their "Occluder - " prefix. */
export function modelLayerName(layer, name) {
  const text = String(name || "").trim();
  if (layer?.meta?.origin !== "occluder" || !text) return text;
  return text.startsWith(OCCLUDER_PREFIX) ? text : `${OCCLUDER_PREFIX}${text}`;
}

// Pose Studio's default mannequin names; a name the user changed wins over the reference name.
const DEFAULT_STUDIO_NAME = /^(main character|character \d+)$/i;
const IMPORT_ORIGINS = new Set(["import", "psd"]);

// Words that carry no subject in a prompt ("a", "masterpiece", "best quality", ...).
const PROMPT_STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "with", "and", "or", "to", "for", "by", "from", "is", "are",
  "very", "highly", "detailed", "masterpiece", "best", "quality", "high", "highres", "absurdres", "ultra",
  "realistic", "photorealistic", "8k", "4k", "hd", "uhd", "newest",
  "amazing", "beautiful", "1girl", "1boy", "2girls", "2boys", "solo", "illustration", "artwork", "image", "picture", "photo", "render", "style",
]);

// Rules-only categories: a few unambiguous words in a name or prompt.
const KEYWORD_CATEGORIES = [
  ["Background", /\b(background|backdrop|sky|skies|street|city|cityscape|room|interior|landscape|forest|scenery|scene|wall|floor|horizon|panorama|mountains?|ocean|beach|field)\b/i],
  ["Effects", /\b(rain|snow|fog|mist|smoke|sparkles?|particles?|fire|flames?|explosion|magic|dust|bokeh|splash)\b/i],
  ["Lighting", /\b(light|lighting|glow|shadows?|sun ?rays|god ?rays|highlights?|rim light|lens flare|shading)\b/i],
  ["Overlays", /\b(overlay|text|title|logo|frame|border|vignette|speech bubble|caption|watermark|ui)\b/i],
  ["Characters", /\b(character|girl|boy|woman|man|person|people|portrait|figure|hero|heroine)\b/i],
  ["Props", /\b(prop|chair|table|sword|lamp|cup|bottle|car|book|bag|box|weapon|furniture|flower|plant|tree)\b/i],
];

const cleanName = (value, max = 64) => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text ? text.slice(0, max) : null;
};
const stripExtension = (name) => String(name).replace(/\.(png|jpe?g|webp|gif|bmp|psd|tiff?)$/i, "");
const titleCase = (word) => word.charAt(0).toUpperCase() + word.slice(1);
const unique = (items) => [...new Set(items)];

export function normalizeNameSource(value) {
  return NAME_SOURCES.includes(value) ? value : undefined;
}

/** The nameSource a new layer of this origin starts with. */
export function nameSourceForOrigin(origin) {
  return IMPORT_ORIGINS.has(origin) ? "import" : "auto";
}

/** "a (red:1.2) chair, masterpiece, night street" -> "Red Chair Night Street" (at most 4 words). */
export function promptFallbackName(prompt, maxWords = 4) {
  const text = String(prompt || "")
    .replace(/<[^>]*>/g, " ") // LoRA tags
    .replace(/\bscore_\w+/gi, " ") // Pony quality tags
    .replace(/:\s*-?\d+(\.\d+)?/g, " ") // (word:1.2) weights
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ");
  const words = text.split(/\s+/).map((word) => word.replace(/^['-]+|['-]+$/g, "")).filter(Boolean)
    .filter((word) => !PROMPT_STOPWORDS.has(word.toLowerCase()) && !/^\d+$/.test(word));
  return words.length ? words.slice(0, maxWords).map(titleCase).join(" ").slice(0, 40) : null;
}

/** Names of the characters a pose layer is bound to (custom Studio names first). */
export function poseCharacterNames(layer, layers = []) {
  const pose = layer?.pose;
  if (!pose) return [];
  const studio = Array.isArray(pose.studio?.characters) ? pose.studio.characters : [];
  const custom = studio.map((character) => cleanName(character?.name)).filter((name) => name && !DEFAULT_STUDIO_NAME.test(name));
  if (custom.length) return unique(custom);
  const ref = pose.character;
  let name = null;
  if (ref?.source === "layer") name = cleanName(layers.find((item) => item.id === ref.layerId)?.name);
  else if (ref) name = cleanName(ref.vnccsCharacter) || cleanName(ref.name);
  return name ? [cleanName(stripExtension(name))] : [];
}

/** The character a layer belongs to, or null (pose binding, then meta.character). */
export function layerCharacterName(layer, layers = []) {
  const names = poseCharacterNames(layer, layers);
  if (names.length) return names.join(" & ");
  return cleanName(layer?.meta?.character?.name);
}

/** True for layers filed under Characters even when no character name is known yet. */
export function isCharacterLinked(layer) {
  return layer?.type === "pose" || Boolean(layer?.meta?.character) || ["bake", "sprite"].includes(layer?.meta?.origin);
}

/** Next free "Paint N" (painted layers with no provenance). */
export function nextPaintName(layers = [], exclude = null) {
  let max = 0;
  for (const layer of layers) {
    if (layer === exclude) continue;
    const match = String(layer.name || "").match(/^Paint (\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Paint ${max + 1}`;
}

/**
 * The rules name of a layer, or null to keep its current name. `model` is true when the naming
 * model may improve on it (generated and painted layers with no better provenance).
 */
export function rulesLayerName(layer, layers = []) {
  const meta = layer?.meta || {};
  const origin = meta.origin || "unknown";
  if (isMaskSectionLayer(layer)) return { name: null, model: false };
  if (layer?.type === "pose") return { name: layerCharacterName(layer, layers) || "Pose", model: false };
  if (IMPORT_ORIGINS.has(origin)) return { name: cleanName(meta.sourceName) || null, model: false };
  const character = layerCharacterName(layer, layers);
  if (origin === "sprite") return { name: character || null, model: !character };
  if (origin === "bake") {
    if (!character) return { name: null, model: true };
    const posed = layers.some((item) => item.type === "pose" && item.visible !== false && layerCharacterName(item, layers) === character);
    return { name: posed ? `${character} (baked)` : character, model: false };
  }
  if (origin === "duplicate" || origin === "rasterize") {
    const source = layers.find((item) => item.id === meta.derivedFrom && item !== layer);
    if (origin === "rasterize") return { name: character || null, model: false };
    return { name: source ? `${source.name} copy` : null, model: false };
  }
  if (origin === "generate") return { name: character || promptFallbackName(meta.prompt), model: !character };
  // "Occluder - <object>": the model names the object (vnccs_unicanvas_naming.mjs keeps the prefix).
  if (origin === "occluder") return { name: String(layer.name || "").startsWith(OCCLUDER_PREFIX) ? layer.name : `${OCCLUDER_PREFIX}foreground`, model: true };
  if (origin === "paint" || origin === "paste" || origin === "unknown") {
    return { name: character || (/^Paint \d+$/.test(layer.name || "") ? layer.name : nextPaintName(layers, layer)), model: !character };
  }
  return { name: null, model: false };
}

/** Category from rules alone (character link, base layer, keywords in the name), or null. */
export function rulesCategory(layer) {
  if (!layer || isMaskSectionLayer(layer) || layer.type === "group") return null;
  if (isCharacterLinked(layer)) return CATEGORY_CHARACTERS;
  if (layer.meta?.origin === "base") return "Background";
  // Name and file stem only: a prompt usually describes the whole scene, not this layer.
  const text = `${layer.name || ""} ${layer.meta?.sourceName || ""}`;
  for (const [category, pattern] of KEYWORD_CATEGORIES) if (pattern.test(text)) return category;
  return null;
}

/** The category a layer is filed under: character link, then the model's answer, then keywords. */
export function layerCategory(layer) {
  if (!layer || isMaskSectionLayer(layer) || layer.type === "group") return null;
  if (isCharacterLinked(layer)) return CATEGORY_CHARACTERS;
  return normalizeLayerCategory(layer.meta?.category) || rulesCategory(layer);
}

/** A group's rules name: the character all its leaf layers share, or null. */
export function groupCharacterName(group, layers = []) {
  const leaves = [];
  const walk = (parentId) => {
    for (const layer of layers) {
      if (layer.groupId !== parentId) continue;
      if (layer.type === "group") walk(layer.id);
      else leaves.push(layer);
    }
  };
  walk(group?.id);
  if (!leaves.length) return null;
  const names = leaves.map((layer) => layerCharacterName(layer, layers));
  return names[0] && names.every((name) => name === names[0]) ? names[0] : null;
}
