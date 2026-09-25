/**
 * VNCCS UniCanvas scene timeline: "Export animation" (Plan 06.2, issue #18).
 *
 *  - Formats: WebM (VP9), MP4 (H.264), GIF, PNG sequence. Range: the work area or the full
 *    timeline. Frame: the bbox, the camera rect (per frame, bbox when unkeyed) or a custom size of
 *    the camera view, at 100 % or 50 %. The source rect is fitted into the output ("contain"), so a
 *    camera zoom or a custom aspect never distorts the picture. PNG sequence and WebM keep alpha:
 *    hide the background layers for a transparent export.
 *  - Every frame is rendered offscreen through the flatten / export path with that frame's
 *    transforms (`_timelineCompositeFrame`), never a screen capture, so an export frame equals the
 *    composite of the scrubbed frame.
 *  - Pose layers are prepared first (the timeline's "Prepare pose frames").
 *  - Frames stream to /vnccs/unicanvas/animation/{begin,frames,end} in ordered batches; Cancel posts
 *    .../cancel. The dialog shows two phases: rendering, then encoding (polled from .../status).
 *  - Standalone only like the timeline; in node mode the node's `image` output stays the still
 *    composite (the export is a UI action).
 */

import { installCustomSelects } from "./vnccs_custom_select.mjs";

export const ANIMATION_ROUTE = "/vnccs/unicanvas/animation";
export const EXPORT_FORMATS = Object.freeze([
  { value: "webm", label: "WebM (VP9)", alpha: true },
  { value: "mp4", label: "MP4 (H.264)", alpha: false },
  { value: "gif", label: "GIF", alpha: false },
  { value: "png", label: "PNG sequence", alpha: true },
]);
export const MAX_EXPORT_SIDE = 4096;
// A batch stays well under the route's request limit (48 MB + 1 MB).
export const BATCH_MAX_BYTES = 16 * 1024 * 1024;
export const BATCH_MAX_FRAMES = 12;

const STYLE_ID = "vnccs-uc-anim-export-styles";
const STYLES = `
.vnccs-uc-anim-export { min-width:340px; }
.vnccs-uc-anim-export .vnccs-uc-anim-grid { display:grid; grid-template-columns:auto 1fr; gap:6px 10px; align-items:center; margin:8px 0; font:12px sans-serif; }
.vnccs-uc-anim-export select, .vnccs-uc-anim-export input { background:rgba(0,0,0,.35); border:1px solid rgba(255,255,255,.14); color:#e8e8f0; border-radius:5px; padding:3px 6px; font:12px sans-serif; }
.vnccs-uc-anim-export .vnccs-uc-anim-size { display:flex; gap:6px; align-items:center; }
.vnccs-uc-anim-export .vnccs-uc-anim-size input { width:70px; }
.vnccs-uc-anim-export .vnccs-uc-anim-note { font-size:11px; opacity:.75; min-height:14px; }
.vnccs-uc-anim-export .vnccs-uc-anim-progress { height:8px; border-radius:4px; background:rgba(255,255,255,.1); overflow:hidden; margin-top:6px; }
.vnccs-uc-anim-export .vnccs-uc-anim-progress > div { height:100%; width:0; background:#9d7aff; transition:width .1s linear; }
.vnccs-uc-anim-export .vnccs-uc-anim-phase { font-size:11px; margin-top:4px; min-height:14px; }
`;

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

// Pure helpers (Node tests) ---------------------------------------------------------------------

/** Scene frames to export: `{ start, end }` inclusive. */
export function exportFrameRange(timeline, range = "work") {
  if (!timeline) return { start: 0, end: 0 };
  if (range === "full") return { start: 0, end: timeline.frameCount - 1 };
  return { start: timeline.workArea.start, end: timeline.workArea.end };
}

/** The world rect a frame shows: the bbox, or the camera view (bbox when unkeyed). */
export function exportSourceRect(frameMode, bbox, cameraRect) {
  if (frameMode !== "bbox" && cameraRect && cameraRect.width > 0 && cameraRect.height > 0) return { ...cameraRect };
  return { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
}

/** The output size in pixels (at least 1, at most MAX_EXPORT_SIDE per side). */
export function exportOutputSize({ frameMode, bbox, startCameraRect, custom, scale = 1 }) {
  const base = frameMode === "custom" && custom
    ? { width: Number(custom.width) || bbox.width, height: Number(custom.height) || bbox.height }
    : exportSourceRect(frameMode, bbox, startCameraRect);
  const factor = scale === 0.5 ? 0.5 : 1;
  const side = (value) => Math.max(1, Math.min(MAX_EXPORT_SIDE, Math.round(value * factor)));
  return { width: side(base.width), height: side(base.height) };
}

/** The source rect fitted into the output ("contain", centered): `{ x, y, width, height }`. */
export function fitRect(source, out) {
  const scale = Math.min(out.width / source.width, out.height / source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  return { x: Math.floor((out.width - width) / 2), y: Math.floor((out.height - height) / 2), width, height };
}

/** Groups frames into ordered upload batches by size and count. */
export class FrameBatcher {
  constructor({ maxBytes = BATCH_MAX_BYTES, maxFrames = BATCH_MAX_FRAMES } = {}) {
    this.maxBytes = maxBytes;
    this.maxFrames = maxFrames;
    this.start = 0;
    this.frames = [];
    this.bytes = 0;
  }

  /** Adds a frame; returns true when the batch should be sent before the next frame. */
  push(dataUrl) {
    this.frames.push(dataUrl);
    this.bytes += dataUrl.length;
    return this.frames.length >= this.maxFrames || this.bytes >= this.maxBytes;
  }

  /** The pending batch `{ start, frames }` (null when empty); the next batch starts after it. */
  take() {
    if (!this.frames.length) return null;
    const batch = { start: this.start, frames: this.frames };
    this.start += this.frames.length;
    this.frames = [];
    this.bytes = 0;
    return batch;
  }
}

// Rendering -------------------------------------------------------------------------------------

/**
 * One export frame: the composite at `frame` over `source`, fitted into `out`. Runs through
 * makeExportCanvas with the timeline composite frame set, like "Generate at frame".
 */
export function renderExportFrame(uc, frame, source, out) {
  const fit = fitRect(source, out);
  const savedBbox = uc.bbox;
  const savedFrame = uc._timelineCompositeFrame;
  uc.bbox = { ...source };
  uc._timelineCompositeFrame = frame;
  try {
    const rendered = uc.makeExportCanvas("image", { width: fit.width, height: fit.height });
    const canvas = document.createElement("canvas");
    canvas.width = out.width;
    canvas.height = out.height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(rendered, 0, 0, rendered.width, rendered.height, fit.x, fit.y, fit.width, fit.height);
    return canvas;
  } finally {
    uc.bbox = savedBbox;
    uc._timelineCompositeFrame = savedFrame;
  }
}

async function postJson(path, payload, signal) {
  const res = await fetch(`${ANIMATION_ROUTE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  let data = {};
  try { data = await res.json(); } catch (_) { data = {}; }
  if (!res.ok || data.error) {
    const error = new Error(String(data.error || `HTTP ${res.status}`).replace(/^\[VNCCS UniCanvas\]\s*/, ""));
    error.cancelled = Boolean(data.cancelled);
    throw error;
  }
  return data;
}

/**
 * Runs one export. `options = { format, range, frameMode, custom, scale, subfolder, name }`;
 * `hooks = { onProgress(phase, done, total), cancelled() }`. Resolves with the backend result, or
 * null when cancelled.
 */
export async function runAnimationExport(controller, options, hooks = {}) {
  const uc = controller.uc;
  const timeline = controller.ensureData();
  const { start, end } = exportFrameRange(timeline, options.range);
  const total = end - start + 1;
  const cancelled = () => Boolean(hooks.cancelled?.());
  const progress = (phase, done, count) => hooks.onProgress?.(phase, done, count);
  controller.pause();

  progress("pose", 0, 1);
  await controller.preparePoseFrames({ start, end, cancelled, onProgress: (done, count) => progress("pose", done, count) });
  if (cancelled()) return null;

  const out = exportOutputSize({
    frameMode: options.frameMode,
    bbox: uc.bbox,
    startCameraRect: controller.cameraRect(start),
    custom: options.custom,
    scale: options.scale,
  });
  const job = await postJson("begin", {
    format: options.format, fps: timeline.fps, width: out.width, height: out.height, frame_count: total,
    subfolder: options.subfolder, name: options.name,
  });
  const jobId = job.job_id;
  const abort = async () => { try { await postJson("cancel", { job_id: jobId }); } catch (_) { /* already gone */ } };
  try {
    const batcher = new FrameBatcher();
    for (let frame = start; frame <= end; frame++) {
      if (cancelled()) { await abort(); return null; }
      const source = exportSourceRect(options.frameMode, uc.bbox, controller.cameraRect(frame));
      const canvas = renderExportFrame(uc, frame, source, out);
      if (batcher.push(canvas.toDataURL("image/png"))) await postJson("frames", { job_id: jobId, ...batcher.take() });
      progress("render", frame - start + 1, total);
      // Let the dialog paint between frames.
      if ((frame - start) % 2 === 1) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const last = batcher.take();
    if (last) await postJson("frames", { job_id: jobId, ...last });
    if (cancelled()) { await abort(); return null; }
    progress("encode", 0, total);
    let polling = true;
    const poll = (async () => {
      while (polling) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!polling) break;
        if (cancelled()) { polling = false; await abort(); break; }
        try {
          const res = await fetch(`${ANIMATION_ROUTE}/status/${jobId}`, { cache: "no-store" });
          const status = await res.json();
          if (res.ok && Number.isFinite(status.encoded)) progress("encode", status.encoded, total);
        } catch (_) { /* the job ends while polling */ }
      }
    })();
    try {
      const result = await postJson("end", { job_id: jobId });
      progress("encode", total, total);
      return result;
    } catch (error) {
      if (error.cancelled) return null;
      throw error;
    } finally {
      polling = false;
      await poll;
    }
  } catch (error) {
    await abort();
    throw error;
  }
}

// Dialog ----------------------------------------------------------------------------------------

function sanitizeName(value) {
  return String(value || "").replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_").trim().replace(/^\.+|\.+$/g, "").slice(0, 120);
}

function defaultName(uc) {
  const title = String(uc.node?.title || "").trim();
  return sanitizeName(title && title !== "VNCCS UniCanvas" ? `${title} animation` : "animation") || "animation";
}

/** Opens the Export animation dialog for a timeline controller (one at a time). */
export function openAnimationExportDialog(controller) {
  const uc = controller.uc;
  if (controller.exportDialog || !controller.isOpen()) return null;
  ensureStyles();
  controller.pause();
  const timeline = controller.ensureData();
  const overlay = document.createElement("div");
  overlay.className = "vnccs-uc-modal-overlay";
  const modal = document.createElement("div");
  modal.className = "vnccs-uc-modal vnccs-uc-anim-export";
  modal.dataset.animExport = "";
  modal.innerHTML = `
    <div class="vnccs-uc-modal-title">Export animation</div>
    <div class="vnccs-uc-modal-message">Renders every frame of the timeline and writes it to output/&lt;folder&gt;/.</div>
    <div class="vnccs-uc-anim-grid">
      <span>Format</span><select data-anim="format"></select>
      <span>Range</span><select data-anim="range">
        <option value="work">Work area (${timeline.workArea.start}-${timeline.workArea.end})</option>
        <option value="full">Full (0-${timeline.frameCount - 1})</option>
      </select>
      <span>Frame</span><select data-anim="frame">
        <option value="bbox">Bbox</option>
        <option value="camera">Camera rect</option>
        <option value="custom">Custom size</option>
      </select>
      <span>Size</span><span class="vnccs-uc-anim-size">
        <input type="number" min="1" max="${MAX_EXPORT_SIDE}" data-anim="width"> x
        <input type="number" min="1" max="${MAX_EXPORT_SIDE}" data-anim="height">
        <select data-anim="scale"><option value="1">100%</option><option value="0.5">50%</option></select>
      </span>
      <span>Folder</span><input data-anim="folder" value="unicanvas_animation">
      <span>Name</span><input data-anim="name">
    </div>
    <div class="vnccs-uc-anim-note" data-anim="note"></div>
    <div class="vnccs-uc-anim-progress" hidden><div data-anim="bar"></div></div>
    <div class="vnccs-uc-anim-phase" data-anim="phase"></div>
    <div class="vnccs-uc-modal-actions"></div>`;
  const field = (name) => modal.querySelector(`[data-anim="${name}"]`);
  const format = field("format");
  for (const item of EXPORT_FORMATS) format.add(new Option(item.label, item.value));
  field("name").value = defaultName(uc);
  const width = field("width");
  const height = field("height");
  const note = field("note");
  const bar = field("bar");
  const phase = field("phase");

  const readOptions = () => ({
    format: format.value,
    range: field("range").value,
    frameMode: field("frame").value,
    custom: { width: Number(width.value), height: Number(height.value) },
    scale: Number(field("scale").value) === 0.5 ? 0.5 : 1,
    subfolder: field("folder").value.trim(),
    name: sanitizeName(field("name").value) || "animation",
  });
  // The size fields follow the frame choice (editable only for a custom size) and show the output.
  const syncSize = () => {
    const options = readOptions();
    const custom = options.frameMode === "custom";
    width.disabled = !custom;
    height.disabled = !custom;
    if (!custom) {
      const { start } = exportFrameRange(timeline, options.range);
      const size = exportOutputSize({ ...options, bbox: uc.bbox, startCameraRect: controller.cameraRect(start), scale: 1 });
      width.value = String(size.width);
      height.value = String(size.height);
    }
    const out = exportOutputSize({ ...options, bbox: uc.bbox, startCameraRect: controller.cameraRect(exportFrameRange(timeline, options.range).start) });
    const alpha = EXPORT_FORMATS.find((item) => item.value === options.format)?.alpha;
    note.textContent = `${out.width} x ${out.height} px, ${timeline.fps} fps. ${alpha ? "Keeps alpha: hide background layers for a transparent export." : "No alpha: transparent areas become black."}${options.format === "mp4" && (out.width % 2 || out.height % 2) ? " MP4 pads odd sizes by one pixel." : ""}`;
  };
  for (const name of ["format", "range", "frame", "scale", "width", "height"]) field(name).addEventListener("input", syncSize);
  syncSize();

  const selects = installCustomSelects(modal, { theme: "unicanvas" });
  let running = false;
  let cancelRequested = false;
  const close = () => {
    selects.disconnect();
    overlay.remove();
    controller.exportDialog = null;
  };
  const actions = modal.querySelector(".vnccs-uc-modal-actions");
  const cancel = uc._button("Cancel", "vnccs-uc-btn", () => {
    if (running) {
      cancelRequested = true;
      phase.textContent = "Cancelling...";
      return;
    }
    close();
  }, "Cancel the export");
  cancel.dataset.anim = "cancel";
  const ok = uc._button("Export", "vnccs-uc-btn", () => void run(), "Render and encode the animation");
  ok.dataset.anim = "export";
  actions.append(cancel, ok);

  const labels = { pose: "Preparing pose frames", render: "Rendering", encode: "Encoding" };
  const run = async () => {
    if (running) return;
    running = true;
    cancelRequested = false;
    ok.disabled = true;
    for (const input of modal.querySelectorAll("select, input")) input.disabled = true;
    modal.querySelector(".vnccs-uc-anim-progress").hidden = false;
    const options = readOptions();
    try {
      const result = await runAnimationExport(controller, options, {
        cancelled: () => cancelRequested,
        onProgress: (name, done, total) => {
          // Two phases on one bar: rendering fills the first half, encoding the second.
          const fraction = total ? done / total : 0;
          const value = name === "encode" ? 0.5 + fraction / 2 : name === "render" ? fraction / 2 : 0;
          bar.style.width = `${Math.round(value * 100)}%`;
          phase.textContent = `${labels[name]} ${done}/${total}`;
        },
      });
      if (!result) {
        uc.setStatus?.("Animation export cancelled");
        close();
        return;
      }
      uc.setStatus?.(`Exported ${result.frames} frames to ${result.path}`);
      close();
    } catch (error) {
      phase.textContent = `Export failed: ${error?.message || error}`;
      uc.setStatus?.(`Animation export failed: ${error?.message || error}`, true);
      running = false;
      ok.disabled = false;
      for (const input of modal.querySelectorAll("select, input")) input.disabled = false;
      syncSize();
    } finally {
      running = false;
    }
  };

  overlay.appendChild(modal);
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay && !running) close(); });
  overlay.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape" && !running) { e.preventDefault(); close(); }
  });
  uc.container.appendChild(overlay);
  controller.exportDialog = overlay;
  requestAnimationFrame(() => ok.focus());
  return overlay;
}
