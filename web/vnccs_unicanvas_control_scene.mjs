/**
 * VNCCS UniCanvas ControlNet layer from the scene (issue #46).
 *
 * "From scene" on a ControlNet layer (vnccs_unicanvas_control.mjs, #45) captures the flattened
 * visible image layers inside the bbox (`makeExportCanvas("image")`, control layers and masks are
 * not image layers), keeps that **source** on the layer and turns it into the control image with a
 * preprocessor. The result is drawn into the layer at the source bbox, so it stays aligned to the
 * scene pixel for pixel wherever the bbox goes next.
 *
 *  - State: `layer.controlSource = { id, type, bbox, image, params, poseLayerIds, linked,
 *    handEdited }`, serialized with the layer (additive). `image` is the source PNG (not for pose,
 *    which is drawn from the pose layers). The object is replaced, never mutated, so history
 *    entries can hold before/after references.
 *  - Preprocessors: depth and lineart run once on the server (`POST
 *    /vnccs/unicanvas/control_preprocess`) and their raw output is cached per source in the
 *    browser; canny runs in the browser; pose draws an OpenPose COCO-18 skeleton from the
 *    mannequins' joints (`layer.pose.openpose`, projected by the pose editor) on black. Every
 *    slider re-renders from the cached raw output while dragging (newest value per animation
 *    frame) and commits one history entry on release.
 *  - Pose control layers stay linked to their pose layers: a mannequin edit or a moved pose layer
 *    redraws the skeleton until the user paints on the control layer, which detaches it
 *    ("Relink" restores the link). While a linked pose layer is dragged the skeleton follows it
 *    live at preview size; the drop renders it at full size. Re-running a preprocessor over hand
 *    edits asks first.
 *
 * The pure helpers at the top run under Node for tests; installUniCanvasControlScene binds the
 * panel section, the layer menu entries and the pose link onto the widget.
 */

import { isControlLayer, normalizeControlState } from "./vnccs_unicanvas_control.mjs";
import { isLayerEffectivelyVisible } from "./vnccs_unicanvas_groups.mjs";

export const CONTROL_PREPROCESS_ROUTE = "/vnccs/unicanvas/control_preprocess";
export const CONTROL_SOURCE_MAX_SIDE = 2048;
// Canny previews while dragging run on at most this many pixels (the release renders full size).
export const CANNY_PREVIEW_PIXELS = 512 * 512;
// A linked pose skeleton follows a dragged pose layer at this size; the drop renders full size.
export const POSE_PREVIEW_MAX_SIDE = 512;

// What each scene preprocessor needs, its defaults and its live sliders.
export const CONTROL_SCENE_TYPES = Object.freeze({
  depth: {
    label: "Depth",
    runsOn: "server",
    defaults: { near: 1, far: 0, gamma: 1, invert: false },
    sliders: [
      { key: "near", label: "Near clip", min: 0, max: 1, step: 0.01 },
      { key: "far", label: "Far clip", min: 0, max: 1, step: 0.01 },
      { key: "gamma", label: "Gamma", min: 0.2, max: 3, step: 0.01 },
    ],
    toggles: [{ key: "invert", label: "Invert" }],
  },
  canny: {
    label: "Canny",
    runsOn: "browser",
    defaults: { low: 60, high: 140, blur: 1 },
    sliders: [
      { key: "low", label: "Low", min: 0, max: 500, step: 1 },
      { key: "high", label: "High", min: 0, max: 500, step: 1 },
      { key: "blur", label: "Blur", min: 0, max: 5, step: 0.1 },
    ],
    toggles: [],
  },
  lineart: {
    label: "Lineart",
    runsOn: "server",
    defaults: { threshold: 0, thickness: 0, invert: false },
    sliders: [
      { key: "threshold", label: "Threshold", min: 0, max: 1, step: 0.01 },
      { key: "thickness", label: "Thickness", min: 0, max: 4, step: 1 },
    ],
    toggles: [{ key: "invert", label: "Invert" }],
  },
  pose: {
    label: "Pose",
    runsOn: "pose",
    defaults: { lineWidth: 4, jointSize: 4 },
    sliders: [
      { key: "lineWidth", label: "Line width", min: 1, max: 16, step: 1 },
      { key: "jointSize", label: "Joint size", min: 1, max: 16, step: 1 },
    ],
    toggles: [],
  },
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
let sourceCounter = 0;

export function isSceneControlType(type) {
  return Object.prototype.hasOwnProperty.call(CONTROL_SCENE_TYPES, type);
}

// The scene types the selected family's ControlNet accepts, in the family's order.
export function sceneTypesFor(support) {
  return (support?.types || []).filter((item) => isSceneControlType(item.key));
}

export function normalizeSceneParams(type, raw) {
  const spec = CONTROL_SCENE_TYPES[type];
  if (!spec) return {};
  const source = raw && typeof raw === "object" ? raw : {};
  const params = {};
  for (const slider of spec.sliders) params[slider.key] = clamp(finite(source[slider.key], spec.defaults[slider.key]), slider.min, slider.max);
  for (const toggle of spec.toggles) params[toggle.key] = source[toggle.key] === undefined ? Boolean(spec.defaults[toggle.key]) : Boolean(source[toggle.key]);
  return params;
}

function normalizeRect(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rect = { x: finite(raw.x, NaN), y: finite(raw.y, NaN), width: finite(raw.width, NaN), height: finite(raw.height, NaN) };
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 1 || rect.height < 1) return null;
  return rect;
}

// Sanitizes a saved or edited source; null when it cannot be used (old states have none).
export function normalizeControlSource(raw) {
  if (!raw || typeof raw !== "object" || !isSceneControlType(raw.type)) return null;
  const bbox = normalizeRect(raw.bbox);
  if (!bbox) return null;
  const params = {};
  for (const type of Object.keys(CONTROL_SCENE_TYPES)) params[type] = normalizeSceneParams(type, raw.params?.[type]);
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `src${Date.now().toString(36)}${(sourceCounter += 1)}`,
    type: raw.type,
    bbox,
    image: typeof raw.image === "string" && raw.image.startsWith("data:image/") ? raw.image : null,
    params,
    poseLayerIds: Array.isArray(raw.poseLayerIds) ? raw.poseLayerIds.filter((id) => typeof id === "string") : [],
    linked: raw.type === "pose" && raw.linked !== false,
    handEdited: raw.handEdited === true,
  };
}

// The pixel size a source is captured at: the bbox size, the long side capped.
export function controlSourceSize(bbox, maxSide = CONTROL_SOURCE_MAX_SIDE) {
  const width = Math.max(1, Math.round(bbox.width));
  const height = Math.max(1, Math.round(bbox.height));
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Where a source-sized result lands on the layer canvas (which starts at the world `origin`).
export function controlPlacementRect(sourceBbox, origin = { x: 0, y: 0 }) {
  return {
    x: sourceBbox.x - (origin?.x || 0),
    y: sourceBbox.y - (origin?.y || 0),
    width: Math.max(1, Math.round(sourceBbox.width)),
    height: Math.max(1, Math.round(sourceBbox.height)),
  };
}

// --- pixel operations (gray = Uint8Array, one byte per pixel) -------------------------------

export function luminance(rgba, width, height) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p += 1) {
    // Transparent scene pixels read as black.
    const a = rgba[i + 3] / 255;
    gray[p] = Math.round((0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * a);
  }
  return gray;
}

export function adjustDepth(gray, params) {
  const p = normalizeSceneParams("depth", params);
  const near = Math.max(p.near, p.far + 1e-3);
  const far = p.far;
  const table = new Uint8Array(256);
  for (let v = 0; v < 256; v += 1) {
    let t = clamp((v / 255 - far) / (near - far), 0, 1);
    t = Math.pow(t, p.gamma);
    if (p.invert) t = 1 - t;
    table[v] = Math.round(t * 255);
  }
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) out[i] = table[gray[i]];
  return out;
}

function dilate(gray, width, height, radius) {
  if (radius <= 0) return gray;
  const horizontal = new Uint8Array(gray.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let max = 0;
      for (let dx = Math.max(0, x - radius); dx <= Math.min(width - 1, x + radius); dx += 1) max = Math.max(max, gray[row + dx]);
      horizontal[row + x] = max;
    }
  }
  const out = new Uint8Array(gray.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let max = 0;
      for (let dy = Math.max(0, y - radius); dy <= Math.min(height - 1, y + radius); dy += 1) max = Math.max(max, horizontal[dy * width + x]);
      out[y * width + x] = max;
    }
  }
  return out;
}

export function adjustLineart(gray, width, height, params) {
  const p = normalizeSceneParams("lineart", params);
  const threshold = Math.round(p.threshold * 255);
  let out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    const v = gray[i];
    out[i] = threshold > 0 ? (v >= threshold ? 255 : 0) : v;
  }
  out = dilate(out, width, height, Math.round(p.thickness));
  if (p.invert) for (let i = 0; i < out.length; i += 1) out[i] = 255 - out[i];
  return out;
}

function gaussianBlur(gray, width, height, sigma) {
  if (!(sigma > 0)) return Float32Array.from(gray);
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i += 1) { const w = Math.exp(-(i * i) / (2 * sigma * sigma)); kernel.push(w); sum += w; }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= sum;
  const tmp = new Float32Array(gray.length);
  const out = new Float32Array(gray.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let acc = 0;
      for (let k = -radius; k <= radius; k += 1) acc += gray[y * width + clamp(x + k, 0, width - 1)] * kernel[k + radius];
      tmp[y * width + x] = acc;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let acc = 0;
      for (let k = -radius; k <= radius; k += 1) acc += tmp[clamp(y + k, 0, height - 1) * width + x] * kernel[k + radius];
      out[y * width + x] = acc;
    }
  }
  return out;
}

/**
 * Canny edges (255 on edges): Gaussian blur, Sobel gradient (L2), non-maximum suppression along
 * the quantized gradient direction, double threshold and hysteresis. Thresholds are on the Sobel
 * magnitude of 0..255 input, the same scale as OpenCV's Canny with L2 gradients.
 */
export function cannyEdges(gray, width, height, params) {
  const p = normalizeSceneParams("canny", params);
  const low = Math.min(p.low, p.high);
  const high = Math.max(p.low, p.high);
  const src = gaussianBlur(gray, width, height, p.blur);
  const magnitude = new Float32Array(width * height);
  const direction = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const gx = -src[i - width - 1] - 2 * src[i - 1] - src[i + width - 1] + src[i - width + 1] + 2 * src[i + 1] + src[i + width + 1];
      const gy = -src[i - width - 1] - 2 * src[i - width] - src[i - width + 1] + src[i + width - 1] + 2 * src[i + width] + src[i + width + 1];
      magnitude[i] = Math.hypot(gx, gy);
      const angle = ((Math.atan2(gy, gx) * 180) / Math.PI + 180) % 180;
      direction[i] = angle < 22.5 || angle >= 157.5 ? 0 : angle < 67.5 ? 1 : angle < 112.5 ? 2 : 3;
    }
  }
  const state = new Uint8Array(width * height); // 0 none, 1 weak, 2 strong
  const stack = [];
  const offsets = [[1, 0], [1, 1], [0, 1], [-1, 1]];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const m = magnitude[i];
      if (m < low) continue;
      const [dx, dy] = offsets[direction[i]];
      // Screen y grows downward: direction 1 is the 45° diagonal in gradient space.
      const a = magnitude[(y + dy) * width + (x + dx)];
      const b = magnitude[(y - dy) * width + (x - dx)];
      if (m < a || m < b) continue;
      if (m >= high) { state[i] = 2; stack.push(i); }
      else state[i] = 1;
    }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % width;
    const y = (i - x) / width;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (state[j] === 1) { state[j] = 2; stack.push(j); }
      }
    }
  }
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i += 1) out[i] = state[i] === 2 ? 255 : 0;
  return out;
}

export function downscaleGray(gray, width, height, maxPixels) {
  const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, width * height)));
  if (scale >= 1) return { gray, width, height };
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(height - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < w; x += 1) out[y * w + x] = gray[sy * width + Math.min(width - 1, Math.floor((x + 0.5) / scale))];
  }
  return { gray: out, width: w, height: h };
}

export function grayToRgba(gray) {
  const rgba = new Uint8ClampedArray(gray.length * 4);
  for (let i = 0, p = 0; p < gray.length; i += 4, p += 1) {
    rgba[i] = rgba[i + 1] = rgba[i + 2] = gray[p];
    rgba[i + 3] = 255;
  }
  return rgba;
}

// --- OpenPose ---------------------------------------------------------------------------------

export const COCO18_KEYPOINTS = Object.freeze([
  "nose", "neck", "r_shoulder", "r_elbow", "r_wrist", "l_shoulder", "l_elbow", "l_wrist",
  "r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle", "r_eye", "l_eye", "r_ear", "l_ear",
]);

// Mannequin (MakeHuman game skeleton) sources of each keypoint. The rest pose faces +Z with the
// character's left on +X and bone-local axes world aligned, so face points are offsets in the
// head bone's frame (rest units, the head bone is about 1.3 long).
export const COCO18_RIG_SOURCES = Object.freeze({
  nose: { bone: "head", offset: [0, 0.55, 1.0] },
  neck: { between: ["upperarm_l", "upperarm_r"] },
  r_shoulder: { bone: "upperarm_r" },
  r_elbow: { bone: "lowerarm_r" },
  r_wrist: { bone: "hand_r" },
  l_shoulder: { bone: "upperarm_l" },
  l_elbow: { bone: "lowerarm_l" },
  l_wrist: { bone: "hand_l" },
  r_hip: { bone: "thigh_r" },
  r_knee: { bone: "calf_r" },
  r_ankle: { bone: "foot_r" },
  l_hip: { bone: "thigh_l" },
  l_knee: { bone: "calf_l" },
  l_ankle: { bone: "foot_l" },
  r_eye: { bone: "head", offset: [-0.3, 0.75, 0.85] },
  l_eye: { bone: "head", offset: [0.3, 0.75, 0.85] },
  r_ear: { bone: "head", offset: [-0.72, 0.6, 0] },
  l_ear: { bone: "head", offset: [0.72, 0.6, 0] },
});

// Limbs (0-based keypoint pairs) and the standard OpenPose colors, as the ControlNet annotator draws them.
export const OPENPOSE_LIMBS = Object.freeze([
  [1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10],
  [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17],
]);
export const OPENPOSE_COLORS = Object.freeze([
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0],
  [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255],
  [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85],
]);

/**
 * The 18 keypoints of one mannequin. `worldOf(boneName, localOffset|null)` returns a world point
 * (anything with x/y/z) or null; `project(point)` returns `{ x, y }` normalized to the pose rect
 * (0..1, y down) or null when the point is behind the camera.
 */
export function openPoseFromRig(worldOf, project) {
  return COCO18_KEYPOINTS.map((name) => {
    const source = COCO18_RIG_SOURCES[name];
    let world = null;
    if (source.between) {
      const [a, b] = source.between.map((bone) => worldOf(bone, null));
      if (a && b) world = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    } else {
      world = worldOf(source.bone, source.offset || null);
    }
    const point = world ? project(world) : null;
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
  });
}

// Pose-rect-normalized people of the pose layers -> pixel coordinates in a `size` image of `bbox`.
export function placeOpenPosePeople(entries, bbox, size) {
  const sx = size.width / bbox.width;
  const sy = size.height / bbox.height;
  const people = [];
  for (const { rect, offset = { x: 0, y: 0 }, people: list } of entries || []) {
    if (!rect) continue;
    for (const person of list || []) {
      const points = (person?.points || person || []).map((point) => (point
        ? { x: (rect.x + offset.x + point.x * rect.width - bbox.x) * sx, y: (rect.y + offset.y + point.y * rect.height - bbox.y) * sy }
        : null));
      people.push(points);
    }
  }
  return people;
}

// OpenPose body skeleton on black: limbs as ellipses at 60 % color, then the joints. `scale` shrinks
// the line and joint sizes for a skeleton drawn smaller than its source (the drag preview).
export function drawOpenPose(ctx, people, size, params, scale = 1) {
  const normalized = normalizeSceneParams("pose", params);
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const p = { ...normalized, lineWidth: normalized.lineWidth * k, jointSize: normalized.jointSize * k };
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size.width, size.height);
  for (const points of people) {
    OPENPOSE_LIMBS.forEach(([a, b], index) => {
      const from = points[a], to = points[b];
      if (!from || !to) return;
      const [r, g, bl] = OPENPOSE_COLORS[index];
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      ctx.fillStyle = `rgb(${Math.round(r * 0.6)},${Math.round(g * 0.6)},${Math.round(bl * 0.6)})`;
      ctx.beginPath();
      ctx.ellipse((from.x + to.x) / 2, (from.y + to.y) / 2, Math.max(0.5, length / 2), p.lineWidth, Math.atan2(to.y - from.y, to.x - from.x), 0, Math.PI * 2);
      ctx.fill();
    });
    points.forEach((point, index) => {
      if (!point) return;
      const [r, g, b] = OPENPOSE_COLORS[index];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.arc(point.x, point.y, p.jointSize, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  ctx.restore();
}

function rectsIntersect(a, b) {
  return a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// Visible pose layers under a bbox (ids in stack order).
export function poseLayersUnder(layers, bbox, isVisible = (layer) => layer?.visible !== false) {
  return (layers || []).filter((layer) => layer?.type === "pose" && layer.pose?.rect && isVisible(layer) && rectsIntersect(layer.pose.rect, bbox));
}

/**
 * A pose rect placed by a live move preview ({ dx, dy, scale?, anchor? }, the widget's
 * getLayerMovePreview): scaled around the anchor, then offset, like the render transform.
 */
export function previewedPoseRect(rect, preview) {
  if (!rect || !preview) return rect;
  const scale = preview.scale || 1;
  const anchor = preview.anchor || { x: 0, y: 0 };
  return {
    x: anchor.x + (rect.x - anchor.x) * scale + (preview.dx || 0),
    y: anchor.y + (rect.y - anchor.y) * scale + (preview.dy || 0),
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

// What a linked pose control layer depends on: changes whenever a mannequin, a pose rect (live
// move preview included, `previewOf`) or a pose layer's visibility changes, and when a drag ends.
export function poseLinkSignature(layers, ids, offsetOf = () => ({ x: 0, y: 0 }), previewOf = () => null) {
  return JSON.stringify((ids || []).map((id) => {
    const layer = (layers || []).find((item) => item.id === id);
    if (!layer?.pose) return [id, null];
    const preview = previewOf(layer) || null;
    return [id, layer.visible !== false, previewedPoseRect(layer.pose.rect, preview), offsetOf(layer), layer.pose.openpose?.people ?? null, Boolean(preview)];
  }));
}

// ---------------------------------------------------------------------------------------------

const SCENE_CSS = `
.vnccs-uc-control-scene { display:flex; flex-direction:column; gap:6px; padding-top:6px; border-top:1px solid rgba(72,196,255,.25); }
.vnccs-uc-control-scene .vnccs-uc-control-row { display:grid; grid-template-columns:64px 1fr 36px; align-items:center; gap:6px; }
.vnccs-uc-control-scene-note { color:#a8a8b8; }
.vnccs-uc-control-scene-note.warn { color:#ffb86b; }
.vnccs-uc-control-scene-link { color:#9fe3b0; }
.vnccs-uc-control-scene-link.detached { color:#ffb86b; }
`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatParam(value, step) {
  return step >= 1 ? String(Math.round(value)) : Number(value).toFixed(2);
}

export function installUniCanvasControlScene(uc) {
  const rawCache = new Map(); // `${source.id}:${type}` -> { gray, width, height } (browser memory only)
  const api = {
    busy: false,
    pending: null, // { layerId, label, run } while "replace hand edits?" waits for an answer
    frame: 0,
    live: null, // { layerId, params } newest slider values while dragging
    gesture: null,
    linkSignatures: new Map(),
    linkFrame: 0,

    support() {
      return uc.controlLayers?.support?.() || null;
    },

    types() {
      return sceneTypesFor(api.support());
    },

    isHandEdited(layer) {
      return Boolean(layer?.controlSource?.handEdited);
    },

    // Replace hand edits only after the user says so.
    guard(layer, label, run) {
      if (!api.isHandEdited(layer)) return run();
      api.pending = { layerId: layer.id, label, run };
      uc.controlLayers?.renderPanel();
      uc.setStatus(`${layer.name} has hand edits: confirm in the ControlNet panel to replace them`, true);
      return null;
    },

    async captureSource(type) {
      const bbox = { x: uc.bbox.x, y: uc.bbox.y, width: uc.bbox.width, height: uc.bbox.height };
      const size = controlSourceSize(bbox);
      if (type === "pose") {
        const poseLayers = poseLayersUnder(uc.layers, bbox, (layer) => api.isLayerVisible(layer));
        if (!poseLayers.length) throw new Error("There is no visible pose layer inside the bbox");
        for (const layer of poseLayers) await api.ensureKeypoints(layer);
        return { bbox, size, image: null, poseLayerIds: poseLayers.map((layer) => layer.id) };
      }
      await uc.poseEditor?.flush?.().catch(() => {});
      const canvas = uc.makeExportCanvas("image", size);
      return { bbox, size, image: canvas.toDataURL("image/png"), poseLayerIds: [] };
    },

    isLayerVisible(layer) {
      return isLayerEffectivelyVisible(uc.layers, layer);
    },

    async ensureKeypoints(layer) {
      if (layer.pose?.openpose?.people) return;
      if (typeof uc.projectPoseLayer !== "function") throw new Error("Pose tools are not available");
      await uc.projectPoseLayer(layer);
      if (!layer.pose?.openpose?.people) throw new Error(`${layer.name}: the mannequin joints could not be read`);
    },

    // The raw preprocessor output for a source (cached per source and type).
    async raw(source, type) {
      const key = `${source.id}:${type}`;
      if (rawCache.has(key)) return rawCache.get(key);
      if (type === "pose") return null;
      if (!source.image) throw new Error("The scene source is missing: use Refresh from scene");
      const size = controlSourceSize(source.bbox);
      let gray;
      if (type === "canny") {
        const img = await uc.loadImage(source.image);
        gray = luminance(api.readPixels(img, size).data, size.width, size.height);
      } else {
        const response = await fetch(CONTROL_PREPROCESS_ROUTE, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: source.image, type, params: {} }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
        const img = await uc.loadImage(data.raw);
        const rgba = api.readPixels(img, size).data;
        gray = new Uint8Array(size.width * size.height);
        for (let i = 0, p = 0; p < gray.length; i += 4, p += 1) gray[p] = rgba[i];
      }
      const entry = { gray, width: size.width, height: size.height };
      // Keep the caches small: sources of layers that are gone or refreshed drop out.
      const live = new Set(uc.layers.map((layer) => layer.controlSource?.id).filter(Boolean));
      for (const cached of rawCache.keys()) if (!live.has(cached.split(":")[0])) rawCache.delete(cached);
      rawCache.set(key, entry);
      return entry;
    },

    readPixels(image, size) {
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = uc.getReadbackContext(canvas);
      ctx.drawImage(image, 0, 0, size.width, size.height);
      return ctx.getImageData(0, 0, size.width, size.height);
    },

    movePreview(layer) {
      return uc.getLayerMovePreview?.(layer) || null;
    },

    poseEntries(source) {
      return source.poseLayerIds
        .map((id) => uc.layers.find((layer) => layer.id === id))
        .filter((layer) => layer?.pose?.rect && layer.pose.openpose?.people && api.isLayerVisible(layer))
        .map((layer) => ({
          rect: previewedPoseRect(layer.pose.rect, api.movePreview(layer)),
          offset: uc.getLayerStateOffset?.(layer) || { x: 0, y: 0 },
          people: layer.pose.openpose.people,
        }));
    },

    // The control image of a source at `params` as a canvas of the source size (or a preview size).
    renderResult(source, type, raw, params, { preview = false } = {}) {
      const size = controlSourceSize(source.bbox);
      const out = document.createElement("canvas");
      out.width = size.width;
      out.height = size.height;
      const ctx = out.getContext("2d");
      if (type === "pose") {
        // A drag preview draws the skeleton small (cheap); paint() stretches it over the bbox.
        const drawn = preview ? controlSourceSize(source.bbox, POSE_PREVIEW_MAX_SIDE) : size;
        out.width = drawn.width;
        out.height = drawn.height;
        drawOpenPose(ctx, placeOpenPosePeople(api.poseEntries(source), source.bbox, drawn), drawn, params, drawn.width / size.width);
        return out;
      }
      let gray, width = raw.width, height = raw.height;
      if (type === "depth") gray = adjustDepth(raw.gray, params);
      else if (type === "lineart") gray = adjustLineart(raw.gray, width, height, params);
      else {
        const work = preview ? downscaleGray(raw.gray, width, height, CANNY_PREVIEW_PIXELS) : raw;
        ({ width, height } = work);
        gray = cannyEdges(work.gray, width, height, params);
      }
      const small = document.createElement("canvas");
      small.width = width;
      small.height = height;
      small.getContext("2d").putImageData(new ImageData(grayToRgba(gray), width, height), 0, 0);
      ctx.imageSmoothingEnabled = width !== size.width;
      ctx.drawImage(small, 0, 0, size.width, size.height);
      return out;
    },

    // Writes a result into the layer at the source bbox (the layer holds only the control image).
    paint(layer, source, canvas) {
      const rect = controlPlacementRect(source.bbox, uc.origin);
      const ctx = uc.configureImageContext(layer.canvas.getContext("2d"));
      ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      ctx.drawImage(canvas, rect.x, rect.y, rect.width, rect.height);
      uc.markLayerPixelsChanged(layer);
      uc.invalidateLayerCaches(layer);
      uc.requestRender();
    },

    // One history entry: control state + source + pixels.
    commit(layer, before, work) {
      const pixelsBefore = uc.createLayerPixelSnapshot(layer);
      work();
      const after = { control: normalizeControlState(layer.control), controlSource: layer.controlSource };
      uc.pushHistoryEntry({
        kind: "historyGroup",
        entries: [
          { kind: "layerProps", layerId: layer.id, before, after },
          { kind: "layerPixels", layerId: layer.id, before: pixelsBefore, after: uc.createLayerPixelSnapshot(layer) },
        ],
      });
      api.linkSignatures.delete(layer.id);
      uc.controlLayers?.renderPanel();
      uc.refreshLayerRow?.(layer.id);
      uc.syncLightStateToWidget();
    },

    propsSnapshot(layer) {
      return { control: normalizeControlState(layer.control), controlSource: layer.controlSource || null };
    },

    async fromScene(layer, type = null, { refresh = false } = {}) {
      if (!isControlLayer(layer)) return;
      const accepted = api.types();
      const kind = type || (refresh ? layer.controlSource?.type : null) || (isSceneControlType(normalizeControlState(layer.control).type) ? normalizeControlState(layer.control).type : accepted[0]?.key);
      if (!accepted.some((item) => item.key === kind)) {
        uc.setStatus(accepted.length ? `${api.support()?.family || "This model"} does not accept ${kind} control images` : "The selected model has no ControlNet", true);
        return;
      }
      if (api.busy) return;
      api.busy = true;
      uc.setStatus(`ControlNet: capturing the scene for ${CONTROL_SCENE_TYPES[kind].label.toLowerCase()}...`);
      try {
        const captured = await api.captureSource(kind);
        if (!uc.layers.includes(layer)) return;
        const source = normalizeControlSource({
          type: kind, bbox: captured.bbox, image: captured.image, poseLayerIds: captured.poseLayerIds,
          params: layer.controlSource?.params, linked: true, handEdited: false,
        });
        const raw = await api.raw(source, kind);
        if (!uc.layers.includes(layer)) return;
        const result = api.renderResult(source, kind, raw, source.params[kind]);
        const before = api.propsSnapshot(layer);
        api.commit(layer, before, () => {
          layer.controlSource = source;
          layer.control = normalizeControlState({ ...normalizeControlState(layer.control), type: kind });
          api.paint(layer, source, result);
        });
        uc.setStatus(`ControlNet ${CONTROL_SCENE_TYPES[kind].label.toLowerCase()} ${refresh ? "refreshed" : "created"} from the scene`);
      } catch (error) {
        uc.setStatus(`ControlNet from scene failed: ${error.message || error}`, true);
      } finally {
        api.busy = false;
      }
    },

    // Type change: re-run the preprocessor on the stored source (one history entry).
    async changeType(layer, type) {
      const source = layer?.controlSource;
      if (!source || !isSceneControlType(type)) return false;
      if (type === "pose" || source.type === "pose") {
        // Pose comes from the pose layers, the others from the scene pixels: capture anew.
        api.guard(layer, `Switch to ${type} from the scene`, () => api.fromScene(layer, type));
        return true;
      }
      api.guard(layer, `Switch to ${type}`, async () => {
        if (api.busy) return;
        api.busy = true;
        try {
          const next = normalizeControlSource({ ...source, type, handEdited: false });
          const raw = await api.raw(next, type);
          if (!uc.layers.includes(layer)) return;
          const result = api.renderResult(next, type, raw, next.params[type]);
          api.commit(layer, api.propsSnapshot(layer), () => {
            layer.controlSource = next;
            layer.control = normalizeControlState({ ...normalizeControlState(layer.control), type });
            api.paint(layer, next, result);
          });
        } catch (error) {
          uc.setStatus(`ControlNet ${type} failed: ${error.message || error}`, true);
          uc.controlLayers?.renderPanel();
        } finally {
          api.busy = false;
        }
      });
      return true;
    },

    // Realtime slider: the newest value renders once per animation frame from the cached raw output.
    setParam(layer, key, value, { commit = false } = {}) {
      const source = layer?.controlSource;
      if (!source) return;
      const type = source.type;
      const params = normalizeSceneParams(type, { ...(api.live?.layerId === layer.id ? api.live.params : source.params[type]), [key]: value });
      if (!api.gesture || api.gesture.layerId !== layer.id) {
        api.gesture = { layerId: layer.id, before: api.propsSnapshot(layer), pixels: uc.createLayerPixelSnapshot(layer) };
      }
      api.live = { layerId: layer.id, params };
      api.syncValues(params);
      if (!commit) {
        if (!api.frame) api.frame = requestAnimationFrame(() => { api.frame = 0; void api.renderLive(layer, true); });
        return;
      }
      if (api.frame) { cancelAnimationFrame(api.frame); api.frame = 0; }
      const gesture = api.gesture;
      api.gesture = null;
      api.live = null;
      const run = async () => {
        const raw = await api.raw(source, type);
        if (!uc.layers.includes(layer) || layer.controlSource !== source) return;
        const next = normalizeControlSource({ ...source, params: { ...source.params, [type]: params }, handEdited: false });
        const result = api.renderResult(next, type, raw, params);
        layer.controlSource = next;
        api.paint(layer, next, result);
        uc.pushHistoryEntry({
          kind: "historyGroup",
          entries: [
            { kind: "layerProps", layerId: layer.id, before: gesture.before, after: api.propsSnapshot(layer) },
            { kind: "layerPixels", layerId: layer.id, before: gesture.pixels, after: uc.createLayerPixelSnapshot(layer) },
          ],
        });
        api.linkSignatures.delete(layer.id);
        uc.controlLayers?.renderPanel();
        uc.syncLightStateToWidget();
      };
      void run().catch((error) => uc.setStatus(`ControlNet: ${error.message || error}`, true));
    },

    async renderLive(layer, preview) {
      const live = api.live;
      const source = layer.controlSource;
      if (!live || live.layerId !== layer.id || !source) return;
      try {
        const raw = await api.raw(source, source.type);
        // A newer value or the release may have landed meanwhile: only the newest one renders.
        if (api.live !== live || layer.controlSource !== source) return;
        api.paint(layer, source, api.renderResult(source, source.type, raw, live.params, { preview }));
      } catch (error) {
        uc.setStatus(`ControlNet: ${error.message || error}`, true);
      }
    },

    syncValues(params) {
      const panel = uc.controlLayers?.panel;
      if (!panel) return;
      for (const [key, value] of Object.entries(params)) {
        panel.querySelectorAll(`[data-scene-param="${key}"]`).forEach((input) => {
          if (input.type === "checkbox") input.checked = Boolean(value);
          else input.value = String(value);
        });
        const out = panel.querySelector(`[data-scene-value="${key}"]`);
        if (out) out.textContent = formatParam(value, Number(out.dataset.step || 0.01));
      }
    },

    relink(layer) {
      const source = layer?.controlSource;
      if (!source || source.type !== "pose") return;
      const next = normalizeControlSource({ ...source, linked: true, handEdited: false });
      api.commit(layer, api.propsSnapshot(layer), () => {
        layer.controlSource = next;
        api.paint(layer, next, api.renderResult(next, "pose", null, next.params.pose));
      });
      uc.setStatus(`${layer.name} is linked to its pose layers again`);
    },

    // Called on every render of a control layer: a linked pose control follows its mannequins.
    syncLinked(layer) {
      const source = layer?.controlSource;
      if (!source || source.type !== "pose" || !source.linked || source.handEdited) return;
      const signature = poseLinkSignature(uc.layers, source.poseLayerIds, (item) => uc.getLayerStateOffset?.(item) || { x: 0, y: 0 }, api.movePreview);
      const previous = api.linkSignatures.get(layer.id);
      if (previous === signature) return;
      api.linkSignatures.set(layer.id, signature);
      if (previous === undefined) return; // first sight (after load or a commit): the pixels are current
      if (api.linkFrame) return;
      // Realtime: a dragged pose layer redraws the skeleton every frame at preview size, the drop at
      // full size (the frame reads the newest drag state when it runs).
      api.linkFrame = requestAnimationFrame(() => {
        api.linkFrame = 0;
        if (!uc.layers.includes(layer) || layer.controlSource !== source) return;
        const dragging = source.poseLayerIds.some((id) => api.movePreview(uc.layers.find((item) => item.id === id)));
        api.paint(layer, source, api.renderResult(source, "pose", null, source.params.pose, { preview: dragging }));
        if (!dragging) uc.syncLightStateToWidget();
      });
    },

    // Hand edits (brush, eraser, import, paste) on a control layer with a source: remember them in
    // the same undo step, and detach a pose link.
    wrapHistoryEntry(entry) {
      if (entry?.kind !== "layerPixels") return null;
      const layer = uc.layers.find((item) => item.id === entry.layerId);
      const source = layer?.controlSource;
      if (!isControlLayer(layer) || !source || source.handEdited) return null;
      const before = { controlSource: source };
      layer.controlSource = normalizeControlSource({ ...source, handEdited: true, linked: false });
      uc.controlLayers?.renderPanel();
      return {
        kind: "historyGroup",
        entries: [entry, { kind: "layerProps", layerId: layer.id, before, after: { controlSource: layer.controlSource } }],
      };
    },

    serialize(layer) {
      return layer?.controlSource ? { ...layer.controlSource, params: JSON.parse(JSON.stringify(layer.controlSource.params)) } : undefined;
    },

    cloneFields(layer) {
      return layer?.controlSource ? { controlSource: normalizeControlSource({ ...layer.controlSource, id: undefined }) } : {};
    },

    renderSection(panel, layer) {
      const support = api.support();
      const types = sceneTypesFor(support);
      if (!support || !types.length) return;
      const source = layer.controlSource;
      const section = el("div", "vnccs-uc-control-scene");
      section.dataset.controlScene = "";

      if (api.pending?.layerId === layer.id) {
        const warn = el("div", "vnccs-uc-control-scene-note warn", `${api.pending.label}: this replaces your hand edits on the layer.`);
        const row = el("div", "vnccs-uc-control-actions");
        const yes = el("button", "vnccs-uc-btn", "Replace");
        yes.type = "button";
        yes.dataset.sceneConfirm = "";
        yes.addEventListener("click", () => { const pending = api.pending; api.pending = null; void pending?.run(); uc.controlLayers?.renderPanel(); });
        const no = el("button", "vnccs-uc-btn", "Keep edits");
        no.type = "button";
        no.addEventListener("click", () => { api.pending = null; uc.controlLayers?.renderPanel(); });
        row.append(yes, no);
        section.append(warn, row);
      }

      const actions = el("div", "vnccs-uc-control-actions");
      const from = el("button", "vnccs-uc-btn", source ? "Refresh from scene" : "From scene");
      from.type = "button";
      from.dataset.controlFromScene = "";
      from.title = source
        ? "Capture the scene inside the current bbox again and re-run the preprocessor"
        : `Make the control image from the visible image layers inside the bbox (${types.map((item) => item.label).join(", ")})`;
      from.addEventListener("click", () => api.guard(layer, source ? "Refresh from scene" : "From scene", () => api.fromScene(layer, null, { refresh: Boolean(source) })));
      actions.append(from);
      if (source?.type === "pose" && (!source.linked || source.handEdited)) {
        const relink = el("button", "vnccs-uc-btn", "Relink");
        relink.type = "button";
        relink.dataset.controlRelink = "";
        relink.title = "Follow the pose layers again (replaces hand edits)";
        relink.addEventListener("click", () => api.guard(layer, "Relink", () => api.relink(layer)));
        actions.append(relink);
      }
      section.append(actions);

      if (!source) {
        section.append(el("div", "vnccs-uc-control-scene-note", "Creates the control image from the scene with the Type above; the sliders then tune it live."));
        panel.append(section);
        return;
      }
      if (source.type === "pose") {
        const linked = source.linked && !source.handEdited;
        const state = el("div", `vnccs-uc-control-scene-link${linked ? "" : " detached"}`,
          linked ? "Linked to pose layers: follows mannequin edits" : "Detached from pose layers (hand edited)");
        state.dataset.controlLink = linked ? "linked" : "detached";
        section.append(state);
      } else if (source.handEdited) {
        section.append(el("div", "vnccs-uc-control-scene-note warn", "Hand edited: sliders and type changes ask before replacing your edits."));
      }
      const spec = CONTROL_SCENE_TYPES[source.type];
      const params = api.live?.layerId === layer.id ? api.live.params : source.params[source.type];
      for (const slider of spec.sliders) {
        const row = el("label", "vnccs-uc-control-row");
        row.append(el("span", "", slider.label));
        const range = document.createElement("input");
        range.type = "range";
        range.min = String(slider.min);
        range.max = String(slider.max);
        range.step = String(slider.step);
        range.value = String(params[slider.key]);
        range.dataset.sceneParam = slider.key;
        const value = el("span", "vnccs-uc-control-value", formatParam(params[slider.key], slider.step));
        value.dataset.sceneValue = slider.key;
        value.dataset.step = String(slider.step);
        const guarded = (commit) => {
          if (source.handEdited && source.type !== "pose") {
            range.value = String(params[slider.key]);
            api.guard(layer, `${slider.label} change`, () => api.setParam(layer, slider.key, Number(range.value), { commit: true }));
            return;
          }
          api.setParam(layer, slider.key, Number(range.value), { commit });
        };
        range.addEventListener("input", () => guarded(false));
        range.addEventListener("change", () => guarded(true));
        row.append(range, value);
        section.append(row);
      }
      for (const toggle of spec.toggles) {
        const wrap = el("label", "vnccs-uc-control-toggle");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = Boolean(params[toggle.key]);
        box.dataset.sceneParam = toggle.key;
        box.addEventListener("change", () => {
          if (source.handEdited) {
            const wanted = box.checked;
            box.checked = !wanted;
            api.guard(layer, `${toggle.label}`, () => api.setParam(layer, toggle.key, wanted, { commit: true }));
            return;
          }
          api.setParam(layer, toggle.key, box.checked, { commit: true });
        });
        wrap.append(box, el("span", "", toggle.label));
        section.append(wrap);
      }
      panel.append(section);
    },
  };

  if (uc.container?.append) {
    const style = el("style");
    style.dataset.controlSceneStyle = "";
    style.textContent = SCENE_CSS;
    uc.container.append(style);
  }

  uc.layerMenuExtensions = [
    ...(uc.layerMenuExtensions || []),
    {
      id: "control-from-scene",
      label: "ControlNet: from scene",
      visible: (layer) => isControlLayer(layer) && api.types().length > 0,
      run: (layer) => api.guard(layer, layer.controlSource ? "Refresh from scene" : "From scene", () => api.fromScene(layer, null, { refresh: Boolean(layer.controlSource) })),
    },
    {
      id: "control-pose-from-layer",
      label: "New pose ControlNet layer",
      visible: (layer) => layer?.type === "pose" && api.types().some((item) => item.key === "pose"),
      run: async () => {
        const created = uc.controlLayers?.addLayer("pose");
        if (created) await api.fromScene(created, "pose");
      },
    },
  ];

  uc.controlScene = api;
  return api;
}
