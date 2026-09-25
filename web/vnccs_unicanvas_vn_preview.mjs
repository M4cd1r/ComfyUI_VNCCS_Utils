/**
 * VNCCS UniCanvas - VN preview overlay (Plan 07, issue #10).
 *
 * Draws an example in-game interface (textbox with lorem ipsum, nameplate, quick menu, choice
 * menu, side image slot, safe areas) over a "game frame" so the composition can be judged
 * against what the game UI will cover.
 *
 * Hard rule: the overlay is a PREVIEW ONLY. It is drawn by one screen-space pass at the end of
 * the widget's render() and nowhere else: never into layer pixels, never by drawFlattenedLayers
 * or makeExportCanvas, never into a generation payload (settings.vn_preview is even stripped
 * from the draw settings) and never into the node's image output. The only way its pixels leave
 * the viewport is the explicit "Copy preview" action, which writes a `*_preview.png`.
 *
 * The text is always placeholder lorem ipsum plus a speaker name; nothing is user-typed.
 *
 * Everything is installed onto the widget instance (like vnccs_unicanvas_layer_tools.mjs), so
 * vnccs_unicanvas.js only carries the install call, the render hook and the history kind.
 */

import { installCustomSelects } from "./vnccs_custom_select.mjs";
import { isLayerEffectivelyVisible } from "./vnccs_unicanvas_groups.mjs";
import { isUniCanvasEnabled } from "./vnccs_unicanvas_feature_toggles.mjs";

export const VN_PREVIEW_PRESETS = Object.freeze([
  { id: "16x9_1080", label: "16:9 - 1920x1080", width: 1920, height: 1080 },
  { id: "16x9_720", label: "16:9 - 1280x720", width: 1280, height: 720 },
  { id: "4x3_1080", label: "4:3 - 1440x1080", width: 1440, height: 1080 },
  { id: "16x10_1200", label: "16:10 - 1920x1200", width: 1920, height: 1200 },
  { id: "9x16_1920", label: "9:16 - 1080x1920 (mobile)", width: 1080, height: 1920 },
]);

export const VN_PREVIEW_SKIN_IDS = Object.freeze(["clean_dark", "classic_paper", "renpy_default_like", "mobile_bubble"]);
export const VN_PREVIEW_SKIN_LABELS = Object.freeze({
  clean_dark: "Clean dark",
  classic_paper: "Classic paper",
  renpy_default_like: "Ren'Py default-like",
  mobile_bubble: "Mobile bubble",
});

export const VN_PREVIEW_TEXT_LENGTHS = Object.freeze([
  { id: "short", label: "Short (~40 chars)", chars: 40 },
  { id: "medium", label: "Medium (~110 chars)", chars: 110 },
  { id: "long", label: "Long (~220 chars)", chars: 220 },
  { id: "two_lines", label: "Two lines", lines: 2 },
  { id: "max_lines", label: "Max lines", lines: "max" },
]);

export const VN_PREVIEW_TOGGLES = Object.freeze([
  { key: "textbox", label: "Textbox", default: true },
  { key: "nameplate", label: "Nameplate", default: true },
  { key: "quickMenu", label: "Quick menu", default: true },
  { key: "choiceMenu", label: "Choice menu", default: false },
  { key: "sideImage", label: "Side image slot", default: false },
  { key: "safeAreas", label: "Safe areas", default: true },
  { key: "notch", label: "Notch / rounded corners (9:16)", default: true },
  { key: "occlusion", label: "Occlusion warning", default: true },
]);

export const VN_PREVIEW_QUICK_MENU = Object.freeze(["Back", "History", "Skip", "Auto", "Save", "Load", "Settings"]);
export const VN_PREVIEW_DIM_ALPHA = 0.55;
export const VN_PREVIEW_ACTION_SAFE = 0.93;
export const VN_PREVIEW_TITLE_SAFE = 0.9;
export const VN_PREVIEW_FACE_FALLBACK = 0.18;
export const VN_PREVIEW_DEFAULT_SPEAKER = "Lorem";
const FRAME_HANDLE_PX = 9;
const FRAME_EDGE_PX = 6;
const MIN_FRAME_WORLD = 32;

const LOREM_WORDS = (
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore "
  + "magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo "
  + "consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur "
  + "excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum "
  + "curabitur pretium tincidunt lacus nulla gravida orci a odio nullam varius turpis et commodo pharetra est eros "
  + "bibendum elit nec luctus magna felis sollicitudin mauris integer in mauris eu nibh euismod gravida"
).split(" ");

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export function defaultVnPreviewState() {
  return {
    enabled: false,
    preset: VN_PREVIEW_PRESETS[0].id,
    skinId: VN_PREVIEW_SKIN_IDS[0],
    textLength: "medium",
    seed: 1,
    toggles: Object.fromEntries(VN_PREVIEW_TOGGLES.map((t) => [t.key, t.default])),
    lockFrame: false,
    frameRect: null,
  };
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeFrameRect(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rect = {
    x: finite(raw.x, NaN), y: finite(raw.y, NaN),
    width: finite(raw.width, NaN), height: finite(raw.height, NaN),
  };
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
  if (rect.width < 1 || rect.height < 1) return null;
  return rect;
}

/** Normalizes a raw settings.vn_preview (old states have none: defaults, additive schema). */
export function normalizeVnPreviewState(raw) {
  const base = defaultVnPreviewState();
  if (!raw || typeof raw !== "object") return base;
  const toggles = { ...base.toggles };
  if (raw.toggles && typeof raw.toggles === "object") {
    for (const key of Object.keys(toggles)) if (typeof raw.toggles[key] === "boolean") toggles[key] = raw.toggles[key];
  }
  return {
    enabled: raw.enabled === true,
    preset: VN_PREVIEW_PRESETS.some((p) => p.id === raw.preset) ? raw.preset : base.preset,
    skinId: VN_PREVIEW_SKIN_IDS.includes(raw.skinId) ? raw.skinId : base.skinId,
    textLength: VN_PREVIEW_TEXT_LENGTHS.some((t) => t.id === raw.textLength) ? raw.textLength : base.textLength,
    seed: Math.max(1, Math.floor(finite(raw.seed, base.seed))) % 2147483647 || 1,
    toggles,
    lockFrame: raw.lockFrame === true,
    frameRect: normalizeFrameRect(raw.frameRect),
  };
}

export function presetById(id) {
  return VN_PREVIEW_PRESETS.find((p) => p.id === id) || VN_PREVIEW_PRESETS[0];
}

// ---------------------------------------------------------------------------------------------
// Skins
// ---------------------------------------------------------------------------------------------

const FONT_TEMPLATE = { family: "system-ui, sans-serif", size: 34, weight: "400", color: "#ffffff" };
const BORDER_TEMPLATE = { color: "#ffffff", alpha: 1, width: 2 };
const SKIN_TEMPLATE = {
  format: "vnccs-vn-preview-skin",
  version: 1,
  id: "custom",
  name: "Custom",
  designResolution: { width: 1920, height: 1080 },
  textbox: {
    anchor: "bottom", marginX: 60, marginBottom: 44, marginTop: 44, height: 260,
    fill: "#0c0b14", fillAlpha: 0.78, radius: 18, border: BORDER_TEMPLATE,
    padding: { left: 52, right: 52, top: 42, bottom: 24 },
    nineSlice: null,
  },
  nameplate: {
    anchor: "top-left", offsetX: 36, offsetY: -30, minWidth: 220, height: 58, paddingX: 26,
    fill: "#ff8fa3", fillAlpha: 0.95, radius: 12, border: BORDER_TEMPLATE, textAlign: "left",
    font: FONT_TEMPLATE, nineSlice: null,
  },
  dialogue: {
    font: FONT_TEMPLATE, lineHeight: 1.35, maxLines: 4,
    shadow: { color: "#000000", alpha: 0.6, blur: 4, offsetX: 0, offsetY: 2 },
    outline: { color: "#000000", alpha: 1, width: 3 },
  },
  quickMenu: {
    placement: "below", align: "center", offsetY: 10, fontSize: 21, gap: 30,
    color: "#ffffff", alpha: 0.72, fontFamily: "system-ui, sans-serif",
  },
  choiceMenu: {
    width: 920, height: 74, gap: 22, centerY: 0.38,
    fill: "#0c0b14", fillAlpha: 0.82, radius: 14, border: BORDER_TEMPLATE,
    font: FONT_TEMPLATE, nineSlice: null,
  },
  sideImage: { width: 200, height: 200, marginLeft: 30, border: BORDER_TEMPLATE },
  mobile: { notchWidth: 0.32, notchHeight: 64, cornerRadius: 90 },
};
// Keys a skin may switch off with null (the template value is used when the key is absent).
const NULLABLE_KEYS = new Set(["border", "shadow", "outline", "nineSlice"]);

function mergeWithTemplate(template, raw) {
  const out = {};
  for (const [key, def] of Object.entries(template)) {
    const value = raw && typeof raw === "object" ? raw[key] : undefined;
    if (NULLABLE_KEYS.has(key)) {
      if (value === null) { out[key] = null; continue; }
      if (def === null) {
        // Reserved (9-slice): kept as given when it is an object, for future custom skins.
        out[key] = value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : null;
        continue;
      }
      if (value === undefined) { out[key] = key === "outline" ? null : mergeWithTemplate(def, {}); continue; }
    }
    if (def && typeof def === "object") out[key] = mergeWithTemplate(def, value);
    else if (typeof def === "number") out[key] = finite(value, def);
    else if (typeof def === "string") out[key] = typeof value === "string" && value ? value.slice(0, 300) : def;
    else out[key] = value ?? def;
  }
  return out;
}

/** Validates a skin JSON against the generic format: missing or malformed fields get defaults. */
export function normalizeVnPreviewSkin(raw) {
  const skin = mergeWithTemplate(SKIN_TEMPLATE, raw || {});
  skin.designResolution.width = Math.max(64, skin.designResolution.width);
  skin.designResolution.height = Math.max(64, skin.designResolution.height);
  skin.dialogue.maxLines = Math.max(1, Math.min(12, Math.round(skin.dialogue.maxLines)));
  skin.dialogue.lineHeight = Math.max(0.8, Math.min(3, skin.dialogue.lineHeight));
  skin.dialogue.font.size = Math.max(6, skin.dialogue.font.size);
  if (typeof raw?.note === "string") skin.note = raw.note.slice(0, 300);
  return skin;
}

// ---------------------------------------------------------------------------------------------
// Placeholder text
// ---------------------------------------------------------------------------------------------

export function makeRng(seed) {
  let state = (Math.floor(Number(seed) || 1) >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An endless seeded lorem ipsum word stream with sentence capitalization and punctuation. */
export function loremWordStream(seed) {
  const rng = makeRng(seed);
  let sentenceLeft = 0;
  let first = true;
  return () => {
    let word = LOREM_WORDS[Math.floor(rng() * LOREM_WORDS.length)];
    if (sentenceLeft <= 0) {
      sentenceLeft = 6 + Math.floor(rng() * 9);
      word = word[0].toUpperCase() + word.slice(1);
    }
    if (first) { first = false; }
    sentenceLeft -= 1;
    if (sentenceLeft === 0) word += ".";
    else if (sentenceLeft > 2 && rng() < 0.08) word += ",";
    return word;
  };
}

function finishSentence(text) {
  const trimmed = text.replace(/[,\s]+$/, "");
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** About `chars` characters of lorem ipsum (whole words, ends with a period). */
export function makeLoremChars(seed, chars) {
  const next = loremWordStream(seed);
  let text = "";
  while (text.length < chars - 3) text = text ? `${text} ${next()}` : next();
  return finishSentence(text);
}

/**
 * Greedy word wrap with a real measure function (`measure(text) -> width`). A word wider than
 * the line is broken by characters so nothing overflows horizontally.
 */
export function wrapText(text, maxWidth, measure) {
  const lines = [];
  let line = "";
  for (const word of String(text || "").split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate) <= maxWidth) { line = candidate; continue; }
    if (line) lines.push(line);
    if (measure(word) <= maxWidth) { line = word; continue; }
    let piece = "";
    for (const char of word) {
      if (piece && measure(piece + char) > maxWidth) { lines.push(piece); piece = char; }
      else piece += char;
    }
    line = piece;
  }
  if (line) lines.push(line);
  return lines;
}

/** Lorem ipsum that fills exactly `lineCount` wrapped lines at `maxWidth`. */
export function makeLoremLines(seed, lineCount, maxWidth, measure) {
  const next = loremWordStream(seed);
  let text = next();
  for (let guard = 0; guard < 400; guard += 1) {
    const word = next();
    const candidate = `${text} ${word}`;
    if (wrapText(finishSentence(candidate), maxWidth, measure).length > lineCount) break;
    text = candidate;
  }
  let finished = finishSentence(text);
  // The closing period can push the last word onto one line too many.
  while (wrapText(finished, maxWidth, measure).length > lineCount && text.includes(" ")) {
    text = text.slice(0, text.lastIndexOf(" "));
    finished = finishSentence(text);
  }
  return finished;
}

export function makePlaceholderText({ seed, textLength, maxLines, maxWidth, measure }) {
  const spec = VN_PREVIEW_TEXT_LENGTHS.find((t) => t.id === textLength) || VN_PREVIEW_TEXT_LENGTHS[1];
  if (spec.lines) return makeLoremLines(seed, spec.lines === "max" ? maxLines : Math.min(spec.lines, maxLines), maxWidth, measure);
  return makeLoremChars(seed, spec.chars);
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/** The largest rect of `aspect` (w/h) centered inside `rect`. */
export function fitAspect(rect, aspect) {
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  let w = width;
  let h = w / aspect;
  if (h > height) { h = height; w = h * aspect; }
  return { x: rect.x + (width - w) / 2, y: rect.y + (height - h) / 2, width: w, height: h };
}

export function rectsIntersect(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Skin units per reference pixel: skins are authored at `designResolution` and scale to fit. */
export function skinUnitsForPreset(skin, preset) {
  const scale = Math.min(preset.width / skin.designResolution.width, preset.height / skin.designResolution.height);
  return { width: preset.width / scale, height: preset.height / scale, scale };
}

function fontCss(font, size = font.size) {
  return `${font.weight || "400"} ${size}px ${font.family}`;
}

/**
 * Lays the overlay out in skin units (the frame is `units.width` x `units.height`).
 * `measure(fontCss, text) -> width` is the canvas measureText, stubbed in unit tests.
 */
export function layoutVnPreview({ skin, preset, state, speaker = VN_PREVIEW_DEFAULT_SPEAKER, measure }) {
  const units = skinUnitsForPreset(skin, preset);
  const W = units.width;
  const H = units.height;
  const t = state.toggles;
  const out = { units, frame: { x: 0, y: 0, width: W, height: H }, textbox: null, nameplate: null, lines: [], quickMenu: [], choices: [], sideImage: null, safe: null, notch: null, overflow: false };
  const tb = skin.textbox;
  const box = {
    x: tb.marginX,
    y: tb.anchor === "top" ? tb.marginTop : H - tb.marginBottom - tb.height,
    width: Math.max(10, W - 2 * tb.marginX),
    height: tb.height,
  };
  if (t.textbox) {
    out.textbox = box;
    let textLeft = box.x + tb.padding.left;
    if (t.sideImage) {
      const si = skin.sideImage;
      out.sideImage = { x: box.x + si.marginLeft, y: box.y + (box.height - si.height) / 2, width: si.width, height: si.height };
      textLeft = Math.max(textLeft, out.sideImage.x + si.width + si.marginLeft);
    }
    const maxWidth = Math.max(20, box.x + box.width - tb.padding.right - textLeft);
    const dialogue = skin.dialogue;
    const font = fontCss(dialogue.font);
    const measureDialogue = (text) => measure(font, text);
    const text = makePlaceholderText({ seed: state.seed, textLength: state.textLength, maxLines: dialogue.maxLines, maxWidth, measure: measureDialogue });
    let lines = wrapText(text, maxWidth, measureDialogue);
    if (lines.length > dialogue.maxLines) {
      out.overflow = true;
      lines = lines.slice(0, dialogue.maxLines);
      let last = lines[lines.length - 1];
      while (last && measureDialogue(`${last}…`) > maxWidth) last = last.slice(0, -1);
      lines[lines.length - 1] = `${last}…`;
    }
    const lineHeight = dialogue.font.size * dialogue.lineHeight;
    const top = box.y + tb.padding.top;
    out.text = text;
    out.font = font;
    out.textArea = { x: textLeft, y: top, width: maxWidth, height: lineHeight * dialogue.maxLines };
    out.lines = lines.map((line, index) => ({
      text: line,
      x: textLeft,
      y: top + index * lineHeight,
      width: measureDialogue(line),
      height: dialogue.font.size,
    }));
  }
  if (t.nameplate) {
    const np = skin.nameplate;
    const npFont = fontCss(np.font);
    const name = String(speaker || VN_PREVIEW_DEFAULT_SPEAKER).slice(0, 80);
    const textWidth = measure(npFont, name);
    const width = Math.max(np.minWidth, textWidth + 2 * np.paddingX);
    const right = np.anchor === "top-right";
    out.nameplate = {
      x: right ? box.x + box.width - np.offsetX - width : box.x + np.offsetX,
      y: box.y + np.offsetY,
      width,
      height: np.height,
      name,
      font: npFont,
      textX: np.textAlign === "center" ? box.x + (right ? box.width - np.offsetX - width : np.offsetX) + (width - textWidth) / 2
        : (right ? box.x + box.width - np.offsetX - width : box.x + np.offsetX) + np.paddingX,
      textWidth,
    };
  }
  if (t.quickMenu) {
    const qm = skin.quickMenu;
    const qmFont = `500 ${qm.fontSize}px ${qm.fontFamily}`;
    const widths = VN_PREVIEW_QUICK_MENU.map((label) => measure(qmFont, label));
    const total = widths.reduce((sum, w) => sum + w, 0) + qm.gap * (widths.length - 1);
    let x = qm.align === "right" ? box.x + box.width - total - 24 : box.x + (box.width - total) / 2;
    const y = qm.placement === "inside-bottom" ? box.y + box.height - qm.offsetY - qm.fontSize : box.y + box.height + qm.offsetY;
    out.quickMenuFont = qmFont;
    out.quickMenu = VN_PREVIEW_QUICK_MENU.map((label, index) => {
      const item = { label, x, y, width: widths[index], height: qm.fontSize };
      x += widths[index] + qm.gap;
      return item;
    });
  }
  if (t.choiceMenu) {
    const cm = skin.choiceMenu;
    const count = 2 + (Math.floor(state.seed) % 2);
    const width = Math.min(cm.width, W * 0.9);
    const total = count * cm.height + (count - 1) * cm.gap;
    const top = H * cm.centerY - total / 2;
    const cmFont = fontCss(cm.font);
    for (let i = 0; i < count; i += 1) {
      const label = makeLoremChars(state.seed * 31 + i + 7, 22 + ((state.seed + i) % 3) * 6).replace(/\.$/, "");
      out.choices.push({ x: (W - width) / 2, y: top + i * (cm.height + cm.gap), width, height: cm.height, label, font: cmFont, textWidth: measure(cmFont, label) });
    }
  }
  if (t.safeAreas) {
    const inset = (ratio) => ({ x: W * (1 - ratio) / 2, y: H * (1 - ratio) / 2, width: W * ratio, height: H * ratio });
    out.safe = { action: inset(VN_PREVIEW_ACTION_SAFE), title: inset(VN_PREVIEW_TITLE_SAFE) };
  }
  if (t.notch && preset.height > preset.width) {
    const m = skin.mobile;
    const width = W * m.notchWidth;
    out.notch = { x: (W - width) / 2, y: 0, width, height: m.notchHeight, cornerRadius: m.cornerRadius };
  }
  return out;
}

/** Maps a rect from skin units into the world (or screen) rect of the frame. */
export function mapSkinRect(rect, units, frame) {
  if (!rect) return null;
  const k = frame.width / units.width;
  return { x: frame.x + rect.x * k, y: frame.y + rect.y * k, width: rect.width * k, height: rect.height * k };
}

// ---------------------------------------------------------------------------------------------
// Characters and faces
// ---------------------------------------------------------------------------------------------

function layerFolderNames(uc, layer) {
  const names = [];
  const byId = new Map((uc.layers || []).map((item) => [item.id, item]));
  let groupId = layer?.groupId;
  for (let depth = 0; groupId && depth < 8; depth += 1) {
    const group = byId.get(groupId);
    if (!group) break;
    names.push(String(group.name || ""));
    groupId = group.groupId;
  }
  if (typeof layer?.folder === "string") names.push(layer.folder);
  return names;
}

/** Pose and sprite layers, baked or sprite provenance, character-tagged layers and layers filed under "Characters". */
export function isCharacterLayer(uc, layer) {
  if (!layer || layer.type === "mask" || layer.type === "group") return false;
  if (layer.type === "pose" || layer.type === "sprite" || layer.sprite) return true;
  if (["sprite", "bake"].includes(layer.meta?.origin)) return true;
  if (layer.meta?.character) return true;
  return layerFolderNames(uc, layer).some((name) => name.trim().toLowerCase() === "characters");
}

export function characterDisplayName(layer) {
  return String(layer?.sprite?.characterName || layer?.meta?.character?.name || layer?.name || "").trim();
}

/**
 * The world-space face region of a character layer: the sprite faceRect (rect space, Plan 03),
 * the bake headRect of a baked pose layer (Plan 02), or the top 18% of the alpha bbox.
 */
export function faceRegionForLayer(uc, layer) {
  const move = uc.getLayerMovePreview?.(layer) || { dx: 0, dy: 0 };
  const shift = (rect) => (rect ? { x: rect.x + move.dx, y: rect.y + move.dy, width: rect.width, height: rect.height } : null);
  const sprite = layer.sprite;
  const face = normalizeFrameRect(sprite?.faceRect);
  const spriteRect = normalizeFrameRect(sprite?.rect);
  if (face && spriteRect) return shift({ x: spriteRect.x + face.x, y: spriteRect.y + face.y, width: face.width, height: face.height });
  const bakes = layer.pose?.bake?.characters;
  if (bakes && typeof bakes === "object") {
    const heads = Object.values(bakes).map((entry) => normalizeFrameRect(entry?.headRect)).filter(Boolean);
    if (heads.length) {
      const x = Math.min(...heads.map((r) => r.x));
      const y = Math.min(...heads.map((r) => r.y));
      const right = Math.max(...heads.map((r) => r.x + r.width));
      const bottom = Math.max(...heads.map((r) => r.y + r.height));
      return shift({ x, y, width: right - x, height: bottom - y });
    }
  }
  if (!layer.canvas || typeof uc.getLayerAlphaBounds !== "function") return null;
  const bounds = uc.getLayerAlphaBounds(layer);
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null;
  const origin = uc.origin || { x: 0, y: 0 };
  return shift({
    x: bounds.x + origin.x,
    y: bounds.y + origin.y,
    width: bounds.width,
    height: Math.max(1, bounds.height * VN_PREVIEW_FACE_FALLBACK),
  });
}

function layerWorldBounds(uc, layer) {
  if (!layer.canvas || typeof uc.getLayerAlphaBounds !== "function") return null;
  const bounds = uc.getLayerAlphaBounds(layer);
  if (!bounds || !(bounds.width > 0)) return null;
  const move = uc.getLayerMovePreview?.(layer) || { dx: 0, dy: 0 };
  const origin = uc.origin || { x: 0, y: 0 };
  return { x: bounds.x + origin.x + move.dx, y: bounds.y + origin.y + move.dy, width: bounds.width, height: bounds.height };
}

// ---------------------------------------------------------------------------------------------
// Drawing (skin units; the caller sets the transform)
// ---------------------------------------------------------------------------------------------

function rgba(hex, alpha = 1) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  const value = match ? parseInt(match[1], 16) : 0xffffff;
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${Math.max(0, Math.min(1, alpha))})`;
}

function roundRectPath(ctx, rect, radius) {
  const r = Math.max(0, Math.min(radius || 0, rect.width / 2, rect.height / 2));
  ctx.beginPath();
  ctx.moveTo(rect.x + r, rect.y);
  ctx.arcTo(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + rect.height, r);
  ctx.arcTo(rect.x + rect.width, rect.y + rect.height, rect.x, rect.y + rect.height, r);
  ctx.arcTo(rect.x, rect.y + rect.height, rect.x, rect.y, r);
  ctx.arcTo(rect.x, rect.y, rect.x + rect.width, rect.y, r);
  ctx.closePath();
}

function drawPanel(ctx, rect, style) {
  roundRectPath(ctx, rect, style.radius);
  if (style.fillAlpha > 0) {
    ctx.fillStyle = rgba(style.fill, style.fillAlpha);
    ctx.fill();
  }
  if (style.border && style.border.width > 0 && style.border.alpha > 0) {
    ctx.lineWidth = style.border.width;
    ctx.strokeStyle = rgba(style.border.color, style.border.alpha);
    ctx.stroke();
  }
}

/** Draws the laid-out overlay; `pxPerUnit` scales shadows (they ignore the transform). */
export function drawVnPreviewLayout(ctx, layout, skin, pxPerUnit = 1) {
  ctx.save();
  ctx.textBaseline = "top";
  if (layout.safe) {
    ctx.setLineDash([12, 8]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(90,200,255,.8)";
    const a = layout.safe.action;
    ctx.strokeRect(a.x, a.y, a.width, a.height);
    ctx.strokeStyle = "rgba(255,210,90,.85)";
    const t = layout.safe.title;
    ctx.strokeRect(t.x, t.y, t.width, t.height);
    ctx.setLineDash([]);
  }
  for (const choice of layout.choices) {
    drawPanel(ctx, choice, skin.choiceMenu);
    ctx.font = choice.font;
    ctx.fillStyle = rgba(skin.choiceMenu.font.color, 1);
    ctx.fillText(choice.label, choice.x + (choice.width - choice.textWidth) / 2, choice.y + (choice.height - skin.choiceMenu.font.size) / 2);
  }
  if (layout.textbox) drawPanel(ctx, layout.textbox, skin.textbox);
  if (layout.sideImage) {
    const border = skin.sideImage.border || BORDER_TEMPLATE;
    ctx.setLineDash([10, 6]);
    ctx.lineWidth = border.width;
    ctx.strokeStyle = rgba(border.color, border.alpha);
    ctx.strokeRect(layout.sideImage.x, layout.sideImage.y, layout.sideImage.width, layout.sideImage.height);
    ctx.setLineDash([]);
  }
  if (layout.lines.length) {
    const dialogue = skin.dialogue;
    ctx.font = layout.font;
    for (const line of layout.lines) {
      if (dialogue.outline && dialogue.outline.width > 0) {
        ctx.lineJoin = "round";
        ctx.lineWidth = dialogue.outline.width;
        ctx.strokeStyle = rgba(dialogue.outline.color, dialogue.outline.alpha);
        ctx.strokeText(line.text, line.x, line.y);
      }
      ctx.save();
      if (dialogue.shadow) {
        ctx.shadowColor = rgba(dialogue.shadow.color, dialogue.shadow.alpha);
        ctx.shadowBlur = dialogue.shadow.blur * pxPerUnit;
        ctx.shadowOffsetX = dialogue.shadow.offsetX * pxPerUnit;
        ctx.shadowOffsetY = dialogue.shadow.offsetY * pxPerUnit;
      }
      ctx.fillStyle = rgba(dialogue.font.color, 1);
      ctx.fillText(line.text, line.x, line.y);
      ctx.restore();
    }
  }
  if (layout.nameplate) {
    const np = skin.nameplate;
    drawPanel(ctx, layout.nameplate, np);
    ctx.font = layout.nameplate.font;
    ctx.fillStyle = rgba(np.font.color, 1);
    ctx.fillText(layout.nameplate.name, layout.nameplate.textX, layout.nameplate.y + (layout.nameplate.height - np.font.size) / 2);
  }
  if (layout.quickMenu.length) {
    ctx.font = layout.quickMenuFont;
    ctx.fillStyle = rgba(skin.quickMenu.color, skin.quickMenu.alpha);
    for (const item of layout.quickMenu) ctx.fillText(item.label, item.x, item.y);
  }
  if (layout.notch) {
    const { width: W, height: H } = layout.frame;
    const n = layout.notch;
    ctx.fillStyle = "#000";
    roundRectPath(ctx, n, n.height / 2);
    ctx.fill();
    ctx.fillRect(n.x + n.height / 2, 0, n.width - n.height, n.height / 2);
    // Rounded screen corners: black outside a rounded rect.
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    roundRectPath(ctx, layout.frame, n.cornerRadius);
    ctx.fill("evenodd");
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
// Widget integration
// ---------------------------------------------------------------------------------------------

const SPEECH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v10H9l-5 4z"/><path d="M8 9h8"/><path d="M8 12h5"/></svg>';

const VN_PREVIEW_CSS = `
.vnccs-uc-vnp-popover { position:absolute; z-index:30; width:300px; max-width:calc(100% - 8px); max-height:70vh; overflow-y:auto; padding:12px; border-radius:10px;
  background:rgba(20,16,30,.96); border:1px solid rgba(255,255,255,.18); box-shadow:0 12px 32px rgba(0,0,0,.55); color:#e8e8f0; font-family:sans-serif; font-size:13px; display:grid; gap:8px; }
.vnccs-uc-vnp-popover .vnccs-uc-vnp-title { font-weight:700; }
.vnccs-uc-vnp-popover .vnccs-uc-vnp-note { opacity:.7; font-size:11px; line-height:1.35; }
.vnccs-uc-vnp-popover label.vnccs-uc-vnp-field { display:grid; gap:4px; }
.vnccs-uc-vnp-popover label.vnccs-uc-vnp-check { display:flex; gap:8px; align-items:center; }
.vnccs-uc-vnp-popover .vnccs-uc-vnp-row { display:flex; gap:6px; flex-wrap:wrap; }
.vnccs-uc-vnp-popover .vnccs-uc-vnp-row .vnccs-uc-btn { flex:1 1 auto; }
`;

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById("vnccs-uc-vnp-styles")) return;
  const style = document.createElement("style");
  style.id = "vnccs-uc-vnp-styles";
  style.textContent = VN_PREVIEW_CSS;
  document.head.appendChild(style);
}

let measureCanvas = null;
function canvasMeasure(font, text) {
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (ctx.font !== font) ctx.font = font;
  return ctx.measureText(text).width;
}

const skinCache = new Map();
function loadSkin(id) {
  if (!skinCache.has(id)) {
    const url = new URL(`./assets/vn_preview_skins/${id}.json`, import.meta.url);
    const entry = { skin: null, error: null, promise: null };
    entry.promise = fetch(url)
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then((json) => { entry.skin = normalizeVnPreviewSkin(json); return entry.skin; })
      .catch((err) => { entry.error = err; entry.skin = normalizeVnPreviewSkin({ id, name: id }); return entry.skin; });
    skinCache.set(id, entry);
  }
  return skinCache.get(id);
}

export class VnPreviewController {
  constructor(uc) {
    this.uc = uc;
    this.gesture = null;
    this.lastLayout = null;
    this.lastFlagged = [];
    this.popover = null;
  }

  get state() {
    const normalized = normalizeVnPreviewState(this.uc.settings?.vn_preview);
    if (this.uc.settings) this.uc.settings.vn_preview = normalized;
    return normalized;
  }

  update(patch, { persist = true } = {}) {
    const next = normalizeVnPreviewState({ ...this.state, ...patch });
    this.uc.settings.vn_preview = next;
    this.syncButton();
    this.uc.requestRender?.();
    if (persist) this.uc.syncSettingsToWidget?.();
    return next;
  }

  toggle(force) {
    const enabled = typeof force === "boolean" ? force : !this.state.enabled;
    this.update({ enabled });
    this.uc.setStatus?.(enabled ? "VN preview on (preview only, never exported)" : "VN preview off");
    return enabled;
  }

  get preset() { return presetById(this.state.preset); }

  skin() {
    const entry = loadSkin(this.state.skinId);
    if (!entry.skin) entry.promise.then(() => this.uc.requestRender?.());
    return entry.skin;
  }

  /** The game frame in world coordinates. */
  frameRect(state = this.state) {
    const preset = presetById(state.preset);
    const aspect = preset.width / preset.height;
    if (state.lockFrame && state.frameRect) return { ...state.frameRect };
    return fitAspect(this.uc.bbox, aspect);
  }

  speakerName() {
    const active = this.uc.activeLayer;
    if (active && isCharacterLayer(this.uc, active)) return characterDisplayName(active) || VN_PREVIEW_DEFAULT_SPEAKER;
    return VN_PREVIEW_DEFAULT_SPEAKER;
  }

  computeLayout(state = this.state) {
    const skin = this.skin();
    if (!skin) return null;
    return { skin, layout: layoutVnPreview({ skin, preset: presetById(state.preset), state, speaker: this.speakerName(), measure: canvasMeasure }) };
  }

  /** Character layers whose face region is covered by the textbox or the nameplate. */
  occludedLayers(layout, frame) {
    const covers = [layout.textbox, layout.nameplate].filter(Boolean).map((r) => mapSkinRect(r, layout.units, frame));
    if (!covers.length) return [];
    const flagged = [];
    for (const layer of this.uc.layers || []) {
      if (!isLayerEffectivelyVisible(this.uc.layers || [], layer) || !isCharacterLayer(this.uc, layer)) continue;
      const face = faceRegionForLayer(this.uc, layer);
      if (face && covers.some((cover) => rectsIntersect(face, cover))) flagged.push({ layer, face });
    }
    return flagged;
  }

  worldToScreen(rect) {
    const { x, y, scale } = this.uc.view;
    return { x: rect.x * scale + x, y: rect.y * scale + y, width: rect.width * scale, height: rect.height * scale };
  }

  /** The screen-space overlay pass, called once at the end of render(). */
  drawOverlay(ctx, viewWidth, viewHeight) {
    const state = this.state;
    this.lastLayout = null;
    this.lastFlagged = [];
    // Switched off in Settings > VNCCS > UniCanvas: hidden, the saved overlay state stays.
    if (!state.enabled || !isUniCanvasEnabled("vnPreview")) return;
    const frameWorld = this.frameRect(state);
    const frame = this.worldToScreen(frameWorld);
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${VN_PREVIEW_DIM_ALPHA})`;
    ctx.beginPath();
    ctx.rect(0, 0, viewWidth, viewHeight);
    ctx.rect(frame.x, frame.y, frame.width, frame.height);
    ctx.fill("evenodd");
    const computed = this.computeLayout(state);
    if (computed) {
      const { skin, layout } = computed;
      const k = frame.width / layout.units.width;
      ctx.save();
      ctx.beginPath();
      ctx.rect(frame.x, frame.y, frame.width, frame.height);
      ctx.clip();
      ctx.translate(frame.x, frame.y);
      ctx.scale(k, k);
      drawVnPreviewLayout(ctx, layout, skin, k);
      ctx.restore();
      if (state.toggles.occlusion) {
        this.lastFlagged = this.occludedLayers(layout, frameWorld);
        ctx.lineWidth = 2;
        for (const { layer, face } of this.lastFlagged) {
          const bounds = layerWorldBounds(this.uc, layer);
          ctx.strokeStyle = "rgba(255,59,48,.95)";
          ctx.setLineDash([]);
          if (bounds) { const s = this.worldToScreen(bounds); ctx.strokeRect(s.x, s.y, s.width, s.height); }
          const f = this.worldToScreen(face);
          ctx.setLineDash([5, 4]);
          ctx.strokeRect(f.x, f.y, f.width, f.height);
          ctx.setLineDash([]);
          ctx.font = "700 11px sans-serif";
          ctx.fillStyle = "rgba(255,59,48,.95)";
          ctx.fillText("Face under UI", f.x + 2, Math.max(12, f.y - 4));
        }
      }
      this.lastLayout = { layout, frameWorld, frameScreen: frame, k };
    }
    ctx.strokeStyle = state.lockFrame ? "rgba(255,143,163,.95)" : "rgba(255,255,255,.55)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(frame.x, frame.y, frame.width, frame.height);
    if (state.lockFrame) {
      ctx.fillStyle = "rgba(255,143,163,.95)";
      for (const h of this.handlePoints(frame)) ctx.fillRect(h.x - FRAME_HANDLE_PX / 2, h.y - FRAME_HANDLE_PX / 2, FRAME_HANDLE_PX, FRAME_HANDLE_PX);
    }
    ctx.restore();
  }

  handlePoints(frame) {
    return [
      { key: "nw", x: frame.x, y: frame.y },
      { key: "ne", x: frame.x + frame.width, y: frame.y },
      { key: "sw", x: frame.x, y: frame.y + frame.height },
      { key: "se", x: frame.x + frame.width, y: frame.y + frame.height },
    ];
  }

  hitFrame(screen) {
    const state = this.state;
    if (!state.enabled || !state.lockFrame) return null;
    const frame = this.worldToScreen(this.frameRect(state));
    for (const h of this.handlePoints(frame)) {
      if (Math.abs(screen.x - h.x) <= FRAME_HANDLE_PX && Math.abs(screen.y - h.y) <= FRAME_HANDLE_PX) return h.key;
    }
    const insideX = screen.x >= frame.x - FRAME_EDGE_PX && screen.x <= frame.x + frame.width + FRAME_EDGE_PX;
    const insideY = screen.y >= frame.y - FRAME_EDGE_PX && screen.y <= frame.y + frame.height + FRAME_EDGE_PX;
    const nearX = Math.abs(screen.x - frame.x) <= FRAME_EDGE_PX || Math.abs(screen.x - frame.x - frame.width) <= FRAME_EDGE_PX;
    const nearY = Math.abs(screen.y - frame.y) <= FRAME_EDGE_PX || Math.abs(screen.y - frame.y - frame.height) <= FRAME_EDGE_PX;
    if ((nearX && insideY) || (nearY && insideX)) return "move";
    return null;
  }

  beginGesture(e) {
    if (e.button !== 0 || this.uc.isPointerDown || !isUniCanvasEnabled("vnPreview")) return false;
    const screen = this.uc.canvasPointFromEvent(e);
    const handle = this.hitFrame(screen);
    if (!handle) return false;
    e.preventDefault();
    e.stopPropagation();
    this.uc.canvas.setPointerCapture?.(e.pointerId);
    this.gesture = { handle, pointerId: e.pointerId, start: this.uc.worldFromCanvasPoint(screen), before: this.frameRect() };
    return true;
  }

  moveGesture(e) {
    const g = this.gesture;
    if (!g) return false;
    e.preventDefault();
    e.stopPropagation();
    const point = this.uc.worldFromCanvasPoint(this.uc.canvasPointFromEvent(e));
    const dx = point.x - g.start.x;
    const dy = point.y - g.start.y;
    const b = g.before;
    let rect;
    if (g.handle === "move") {
      rect = { x: b.x + dx, y: b.y + dy, width: b.width, height: b.height };
    } else {
      // Resize from a corner with the aspect kept; the opposite corner stays put.
      const aspect = b.width / b.height;
      const west = g.handle.includes("w");
      const north = g.handle.includes("n");
      const anchorX = west ? b.x + b.width : b.x;
      const anchorY = north ? b.y + b.height : b.y;
      const px = west ? b.x + dx : b.x + b.width + dx;
      const py = north ? b.y + dy : b.y + b.height + dy;
      let width = Math.max(MIN_FRAME_WORLD, Math.abs(px - anchorX));
      let height = Math.max(MIN_FRAME_WORLD, Math.abs(py - anchorY));
      if (width / height > aspect) height = width / aspect;
      else width = height * aspect;
      rect = { x: west ? anchorX - width : anchorX, y: north ? anchorY - height : anchorY, width, height };
    }
    this.uc.settings.vn_preview = { ...this.state, frameRect: rect };
    this.uc.requestRender?.();
    return true;
  }

  endGesture(e) {
    const g = this.gesture;
    if (!g) return false;
    e?.preventDefault?.();
    e?.stopPropagation?.();
    this.gesture = null;
    const after = this.frameRect();
    const changed = ["x", "y", "width", "height"].some((key) => Math.abs(after[key] - g.before[key]) > 1e-6);
    if (changed) {
      this.uc.pushHistoryEntry?.({ kind: "vnPreviewFrame", before: { ...g.before }, after: { ...after } });
      this.uc.syncSettingsToWidget?.();
    }
    this.uc.requestRender?.();
    return true;
  }

  /** History hook: undo/redo of a locked-frame move or resize (one entry per gesture). */
  applyFrameHistory(entry, direction) {
    const rect = normalizeFrameRect(direction === "undo" ? entry.before : entry.after);
    if (!rect) return;
    this.update({ lockFrame: true, frameRect: rect });
  }

  setLockFrame(lock) {
    if (lock) this.update({ lockFrame: true, frameRect: this.frameRect() });
    else this.update({ lockFrame: false });
  }

  setPreset(presetId) {
    const state = this.state;
    const preset = presetById(presetId);
    const patch = { preset: preset.id };
    // A locked frame keeps its place: the new aspect is fitted into it.
    if (state.lockFrame && state.frameRect) patch.frameRect = fitAspect(state.frameRect, preset.width / preset.height);
    this.update(patch);
  }

  shuffle() {
    this.update({ seed: 1 + Math.floor(Math.random() * 2147483000) });
  }

  /** Composite of the visible image layers inside the frame, plus the overlay, at the reference resolution. */
  buildPreviewCanvas() {
    const state = this.state;
    const preset = presetById(state.preset);
    const frame = this.frameRect(state);
    const out = document.createElement("canvas");
    out.width = preset.width;
    out.height = preset.height;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, out.width, out.height);
    const full = document.createElement("canvas");
    full.width = Math.max(1, Math.round(this.uc.size.width));
    full.height = Math.max(1, Math.round(this.uc.size.height));
    const fullCtx = this.uc.configureImageContext ? this.uc.configureImageContext(full.getContext("2d"), false) : full.getContext("2d");
    this.uc.drawFlattenedLayers(fullCtx);
    const k = preset.width / frame.width;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(full, (this.uc.origin.x - frame.x) * k, (this.uc.origin.y - frame.y) * k, full.width * k, full.height * k);
    const computed = this.computeLayout(state);
    if (computed) {
      const unitScale = preset.width / computed.layout.units.width;
      ctx.save();
      ctx.scale(unitScale, unitScale);
      drawVnPreviewLayout(ctx, computed.layout, computed.skin, unitScale);
      ctx.restore();
    }
    return out;
  }

  async copyPreview() {
    const canvas = this.buildPreviewCanvas();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not encode the preview");
    const name = `unicanvas_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}_preview.png`;
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem !== "function") throw new Error("Clipboard images are not available");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      this.uc.setStatus?.(`Copied ${name} to the clipboard (preview only)`);
    } catch (_) {
      // No clipboard access (insecure origin, permissions): download the same file instead.
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 5000);
      this.uc.setStatus?.(`Clipboard unavailable: downloaded ${name}`);
    }
    return name;
  }

  /** Read-only description for the E2E hook (screen and world rects, flagged layers). */
  describe() {
    const state = this.state;
    const info = { ...JSON.parse(JSON.stringify(state)), skinLoaded: Boolean(loadSkin(state.skinId).skin), frame: this.frameRect(state) };
    const last = this.lastLayout;
    if (!state.enabled || !last) return info;
    const toScreen = (rect) => mapSkinRect(rect, last.layout.units, last.frameScreen);
    return {
      ...info,
      frameScreen: { ...last.frameScreen },
      textbox: toScreen(last.layout.textbox),
      nameplate: toScreen(last.layout.nameplate),
      textArea: toScreen(last.layout.textArea),
      lines: last.layout.lines.map((line) => ({ text: line.text, ...toScreen(line) })),
      maxLines: this.skin()?.dialogue.maxLines ?? null,
      overflow: last.layout.overflow,
      speaker: last.layout.nameplate?.name ?? null,
      choices: last.layout.choices.length,
      flaggedLayerIds: this.lastFlagged.map(({ layer }) => layer.id),
      characters: (this.uc.layers || []).filter((layer) => isLayerEffectivelyVisible(this.uc.layers || [], layer) && isCharacterLayer(this.uc, layer)).map((layer) => {
        const face = faceRegionForLayer(this.uc, layer);
        return { id: layer.id, face: face ? this.worldToScreen(face) : null };
      }),
    };
  }

  syncButton() {
    const btn = this.button;
    if (!btn) return;
    const on = this.state.enabled;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  closePopover() {
    if (!this.popover) return;
    this.popover.remove();
    this.popover = null;
    document.removeEventListener("pointerdown", this.outsideHandler, true);
  }

  openPopover() {
    this.closePopover();
    const uc = this.uc;
    const state = this.state;
    const panel = document.createElement("div");
    panel.className = "vnccs-uc-vnp-popover";
    const title = document.createElement("div");
    title.className = "vnccs-uc-vnp-title";
    title.textContent = "VN preview";
    const note = document.createElement("div");
    note.className = "vnccs-uc-vnp-note";
    note.textContent = "Example game UI over the scene. Preview only: never saved, exported or sent to generation. Shortcut: P.";
    panel.append(title, note);
    const check = (label, checked, onChange, testId) => {
      const wrap = document.createElement("label");
      wrap.className = "vnccs-uc-vnp-check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(checked);
      if (testId) input.dataset.vnp = testId;
      input.addEventListener("change", () => onChange(input.checked));
      wrap.append(input, document.createTextNode(label));
      panel.appendChild(wrap);
      return input;
    };
    const select = (label, options, value, onChange, testId) => {
      const wrap = document.createElement("label");
      wrap.className = "vnccs-uc-vnp-field";
      wrap.append(document.createTextNode(label));
      const el = document.createElement("select");
      el.className = "vnccs-uc-select";
      el.dataset.vnp = testId;
      for (const [id, text] of options) {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = text;
        el.appendChild(option);
      }
      el.value = value;
      el.addEventListener("change", () => onChange(el.value));
      wrap.appendChild(el);
      panel.appendChild(wrap);
      return el;
    };
    check("Show VN preview", state.enabled, (on) => this.toggle(on), "enabled");
    select("Screen preset", VN_PREVIEW_PRESETS.map((p) => [p.id, p.label]), state.preset, (id) => this.setPreset(id), "preset");
    select("Skin", VN_PREVIEW_SKIN_IDS.map((id) => [id, VN_PREVIEW_SKIN_LABELS[id]]), state.skinId, (id) => this.update({ skinId: id }), "skin");
    select("Text length", VN_PREVIEW_TEXT_LENGTHS.map((t) => [t.id, t.label]), state.textLength, (id) => this.update({ textLength: id }), "textLength");
    const row = document.createElement("div");
    row.className = "vnccs-uc-vnp-row";
    row.append(
      uc._button("Shuffle text", "vnccs-uc-btn", () => this.shuffle(), "New placeholder text"),
      uc._button("Copy preview", "vnccs-uc-btn", () => void this.copyPreview().catch((err) => uc.setStatus?.(`Copy preview failed: ${err?.message || err}`, true)), "Copy the frame with the overlay to the clipboard (*_preview.png)"),
    );
    panel.appendChild(row);
    for (const toggle of VN_PREVIEW_TOGGLES) {
      check(toggle.label, state.toggles[toggle.key], (on) => this.update({ toggles: { ...this.state.toggles, [toggle.key]: on } }), toggle.key);
    }
    check("Lock frame (detach from the bbox)", state.lockFrame, (on) => this.setLockFrame(on), "lockFrame");
    uc.container.appendChild(panel);
    uc.anchorPopoverTo?.(panel, this.button, uc.container);
    installCustomSelects(panel);
    this.popover = panel;
    this.outsideHandler = (event) => {
      if (panel.contains(event.target) || this.button.contains(event.target)) return;
      if (event.target?.closest?.(".vnccs-custom-select-menu")) return;
      this.closePopover();
    };
    document.addEventListener("pointerdown", this.outsideHandler, true);
  }

  onButtonClick() {
    const enabled = this.toggle();
    if (enabled) this.openPopover();
    else this.closePopover();
  }
}

export function installUniCanvasVnPreview(uc) {
  if (!uc || uc.vnPreview) return uc?.vnPreview;
  ensureStyles();
  const controller = new VnPreviewController(uc);
  uc.vnPreview = controller;

  if (uc.settingsBar && typeof uc._button === "function") {
    controller.button = uc._button(SPEECH_ICON, "vnccs-uc-icon vnccs-uc-vnp-toggle", () => controller.onButtonClick(), "VN preview (P)");
    controller.button.setAttribute("aria-pressed", "false");
    controller.button.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (controller.popover) controller.closePopover();
      else controller.openPopover();
    });
    // Right after Snap to grid, before the settings gear.
    const anchor = uc.snapBtn?.nextSibling || uc.gearBtn || null;
    uc.settingsBar.insertBefore(controller.button, anchor);
    controller.syncButton();
  }

  // Locked-frame handles take the pointer before the active tool.
  const onPointerDown = uc.onPointerDown;
  const onPointerMove = uc.onPointerMove;
  const onPointerUp = uc.onPointerUp;
  uc.onPointerDown = (e) => (controller.beginGesture(e) ? undefined : onPointerDown.call(uc, e));
  uc.onPointerMove = (e) => (controller.moveGesture(e) ? undefined : onPointerMove.call(uc, e));
  uc.onPointerUp = (e) => (controller.endGesture(e) ? undefined : onPointerUp.call(uc, e));

  // The overlay settings are a UI preference: they never travel with a generation request.
  const makeSettingsPayload = uc.makeSettingsPayload;
  uc.makeSettingsPayload = (...args) => {
    const settings = makeSettingsPayload.apply(uc, args);
    if (settings && typeof settings === "object") delete settings.vn_preview;
    return settings;
  };

  // Whole-document undo snapshots carry settings; the overlay preference is not scene content,
  // so undoing a paint stroke must not flip the overlay (its own frame entry restores the frame).
  const restoreHistorySnapshot = uc.restoreHistorySnapshot;
  uc.restoreHistorySnapshot = (snapshot) => {
    const keep = uc.settings?.vn_preview ? JSON.parse(JSON.stringify(uc.settings.vn_preview)) : undefined;
    restoreHistorySnapshot.call(uc, snapshot);
    if (keep && uc.settings) uc.settings.vn_preview = keep;
    controller.syncButton();
  };

  const applySerializedState = uc.applySerializedState;
  uc.applySerializedState = async (...args) => {
    const result = await applySerializedState.apply(uc, args);
    controller.syncButton();
    return result;
  };
  return controller;
}
