/**
 * VNCCS UniCanvas shared helpers: small pure functions the feature modules used to copy.
 * Everything here runs under Node for tests; ensureStyleTag is a no-op without a document.
 */

/** FNV-1a 32-bit hash of a string, as an unsigned integer. */
export function fnv1a(text) {
  const value = String(text);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** FNV-1a 32-bit hash of a string, as lower-case hex (no padding). */
export function fnv1aHex(text) {
  return fnv1a(text).toString(16);
}

/** Adds a `<style id>` with `css` to the document head once. */
export function ensureStyleTag(id, css) {
  if (typeof document === "undefined" || document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** The value as a finite number, else `fallback` (Number() coercion, so null is 0). */
export const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** A finite number or a numeric (non-blank) string as a number, else null. */
export function finiteOrNull(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

/** JSON deep copy; null and undefined pass through. */
export const cloneJson = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

const HTML_ESCAPES = Object.freeze({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" });

/** Escapes the five HTML-special characters (text and attribute values alike). */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** Whether two `{ x, y, width, height }` rects overlap (touching edges do not). */
export function rectsIntersect(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** A random id: `${prefix}_` plus 8 base-36 characters. */
export const randomId = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

let uniqueCounter = 0;
/** An id unique within the page: `${prefix}_<time>_<counter><4 random chars>`. */
export const uniqueId = (prefix) => `${prefix}_${Date.now().toString(36)}_${(uniqueCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
