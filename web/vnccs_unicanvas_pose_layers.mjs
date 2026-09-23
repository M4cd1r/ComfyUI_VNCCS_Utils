/**
 * VNCCS UniCanvas - pose layers (design spec section 7).
 *
 * A pose layer is a raster-like smart object: its pixels come from a Pose
 * Studio mannequin render (PNG with alpha) and everything needed to rebuild
 * the render lives in `layer.poseData`:
 *
 *   { schemaVersion, pose,
 *     character: { id, name, source: "vnccs" | "mannequin", morphs },
 *     camera,
 *     render: { transparent: true, size } }
 *
 * Live bridge (spec 7.2) - a window CustomEvent bus named
 * "vnccs:unicanvas:pose-layer" (detail JSON):
 *
 *   UniCanvas -> Pose Studio:
 *     { source: "unicanvas", type: "subscribe", layerId, schemaVersion }
 *     { source: "unicanvas", type: "unsubscribe", layerId }
 *     { source: "unicanvas", type: "capture-request", layerId }
 *     { source: "unicanvas", type: "character", layerId, character }
 *   Pose Studio -> UniCanvas:
 *     { source: "pose-studio", type: "hello", layerId? }
 *     { source: "pose-studio", type: "render", layerId, seq,
 *       quality: "preview" | "final", phase: "start" | "move" | "end",
 *       gestureId, dataURL, pose, character, camera,
 *       render: { transparent: true, size: { width, height } } }
 *
 * The render carrying quality "final" (or phase "end" when the producer does
 * not send a final-quality capture) commits its gesture as one `layerPixels`
 * history command. Previews are coalesced through requestAnimationFrame at
 * ~15-20 fps and the newest render always wins; stale async results are
 * dropped (repo realtime rule).
 *
 * In-place editing (spec 7.3) - the mannequin tool swaps the layer pixels for
 * an interactive mannequin embedded over the stage, reusing the Pose Studio
 * runtime (web/vnccs_pose_studio_core.js viewer and morph runtime).
 */
import { installCustomSelects } from "./vnccs_custom_select.mjs";
import { createSliderNumber } from "./vnccs_config_ui.mjs";

export const POSE_LAYER_TYPE = "pose";
export const POSE_LAYER_BUS_EVENT = "vnccs:unicanvas:pose-layer";
export const POSE_LAYER_SCHEMA_VERSION = 1;
export const POSE_LAYER_PREVIEW_FPS = 18;
export const POSE_LAYER_LINK_TIMEOUT_MS = 4000;

export const POSE_LAYER_STATUS_LINKED = "linked to Pose Studio";
export const POSE_LAYER_STATUS_WAITING = "waiting…";
export const POSE_LAYER_STATUS_DISCONNECTED = "disconnected";

export const POSE_LAYER_STATUS = {
  LINKED: POSE_LAYER_STATUS_LINKED,
  WAITING: POSE_LAYER_STATUS_WAITING,
  DISCONNECTED: POSE_LAYER_STATUS_DISCONNECTED,
};

export const POSE_LAYER_CHARACTERS_UNAVAILABLE_NOTE = "VNCCS characters unavailable — Mannequin only";

export const POSE_LAYER_ADD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="5.5" r="2.5"/><path d="M10 8v6"/><path d="M6 10.5h8"/><path d="M10 14l-3 5"/><path d="M10 14l3 5"/><path d="M18 13v6"/><path d="M15 16h6"/></svg>`;
export const MANNEQUIN_TOOL_ICON = `<svg viewBox="0 0 256 256" aria-hidden="true"><circle cx="128" cy="46" r="24"/><path d="M128 70v76"/><path d="M66 106h124"/><path d="M128 146l-38 74"/><path d="M128 146l38 74"/><circle cx="66" cy="106" r="12"/><circle cx="190" cy="106" r="12"/></svg>`;

const POSE_LAYER_STYLES = `
.vnccs-uc-pose-chip { display:flex; align-items:center; gap:6px; margin-top:4px; flex-wrap:wrap; }
.vnccs-uc-pose-status { padding:2px 8px; border-radius:999px; border:1px solid var(--uc-border); color:var(--uc-muted); background:rgba(255,255,255,.05); white-space:nowrap; }
.vnccs-uc-pose-status.linked { color:var(--uc-good); border-color:rgba(0,214,143,.4); }
.vnccs-uc-pose-status.waiting { color:#ffd45c; border-color:rgba(255,212,92,.4); }
.vnccs-uc-pose-status.disconnected { color:var(--uc-danger); border-color:rgba(255,71,87,.4); }
.vnccs-uc-pose-status-note { color:var(--uc-muted); font-size:10px; }
.vnccs-uc-pose-capture { height:22px; padding:0 8px; font-size:10px; }
.vnccs-uc-pose-panel { display:flex; flex-direction:column; gap:6px; padding:6px; border-bottom:1px solid var(--uc-border); }
.vnccs-uc-pose-panel-title { color:var(--uc-accent); font-weight:700; }
.vnccs-uc-pose-edit-overlay { position:absolute; inset:0; z-index:5; display:flex; flex-direction:column; background:transparent; }
.vnccs-uc-pose-edit-canvas { flex:1 1 auto; width:100%; min-height:0; display:block; touch-action:none; }
.vnccs-uc-pose-edit-bar { display:flex; align-items:center; gap:8px; padding:8px; background:rgba(10,10,15,.92); border-top:1px solid var(--uc-border); }
.vnccs-uc-pose-edit-title { color:var(--uc-accent); font-weight:800; margin-right:auto; }
`;

function deepCloneJSON(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function clampRenderSide(value, fallback) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(8192, number) : fallback;
}

function normalizePoseLayerSize(size) {
  return {
    width: clampRenderSide(size?.width, 1024),
    height: clampRenderSide(size?.height, 1024),
  };
}

function normalizeFinite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Single source of truth for morph normalization (the Pose Studio bridge
 * imports this). Preserves every numeric/boolean morph key: saved character
 * morphs beyond any known list must survive into layer.poseData.character.
 */
export function normalizePoseLayerMorphs(raw, base = {}) {
  const morphs = {};
  const sources = [base && typeof base === "object" ? base : {}, raw && typeof raw === "object" ? raw : {}];
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "boolean") morphs[key] = value;
      else {
        const number = Number(value);
        if (Number.isFinite(number)) morphs[key] = number;
      }
    }
  }
  return morphs;
}

export function defaultUniCanvasPoseLayerCharacter() {
  return {
    id: "mannequin",
    name: "Mannequin",
    source: "mannequin",
    morphs: {},
  };
}

export function normalizePoseLayerCharacter(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const fallback = defaultUniCanvasPoseLayerCharacter();
  return {
    id: String(source.id || fallback.id),
    name: String(source.name || fallback.name),
    source: source.source === "vnccs" ? "vnccs" : "mannequin",
    morphs: normalizePoseLayerMorphs(source.morphs),
  };
}

export function normalizePoseLayerCamera(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    offset_x: normalizeFinite(source.offset_x, 0),
    offset_y: normalizeFinite(source.offset_y, 0),
    zoom: normalizeFinite(source.zoom, 1),
    yaw_deg: normalizeFinite(source.yaw_deg, 0),
    pitch_deg: normalizeFinite(source.pitch_deg, 0),
  };
}

/**
 * Build the spec section 7.1 poseData payload with exactly the documented
 * keys: { schemaVersion, pose, character: { id, name, source, morphs },
 * camera, render: { transparent: true, size } }.
 */
export function buildPoseLayerData({ pose, character, camera, size } = {}) {
  return {
    schemaVersion: POSE_LAYER_SCHEMA_VERSION,
    pose: pose && typeof pose === "object" ? deepCloneJSON(pose) : {},
    character: normalizePoseLayerCharacter(character),
    camera: normalizePoseLayerCamera(camera),
    render: {
      transparent: true,
      size: normalizePoseLayerSize(size),
    },
  };
}

export function normalizePoseLayerData(raw) {
  if (!raw || typeof raw !== "object") return null;
  return buildPoseLayerData({
    pose: raw.pose,
    character: raw.character,
    camera: raw.camera,
    size: raw.render?.size,
  });
}

function getUniCanvasPoseLayerState(widget) {
  if (widget._poseLayerState) return widget._poseLayerState;
  const state = {
    widget,
    subs: new Map(),
    charactersNote: "",
    charactersLoaded: false,
    charactersPromise: null,
    session: null,
    panel: null,
    panelSelect: null,
    panelSignature: "",
    stylesInstalled: false,
  };
  state.busListener = (event) => {
    try {
      handleUniCanvasPoseLayerBusEvent(widget, event?.detail);
    } catch (err) {
      console.warn("[VNCCS UniCanvas] Pose layer bus handler failed", err);
    }
  };
  window.addEventListener(POSE_LAYER_BUS_EVENT, state.busListener);
  widget._poseLayerState = state;
  return state;
}

function broadcastUniCanvasPoseLayerMessage(detail) {
  if (typeof window === "undefined" || typeof CustomEvent !== "function") return false;
  window.dispatchEvent(new CustomEvent(POSE_LAYER_BUS_EVENT, { detail }));
  return true;
}

function removeUniCanvasPoseLayerSubscription(state, layerId) {
  const sub = state.subs.get(layerId);
  if (!sub) return;
  if (sub.linkTimer) window.clearTimeout(sub.linkTimer);
  if (sub.previewFrame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(sub.previewFrame);
  if (sub.subscribed) {
    broadcastUniCanvasPoseLayerMessage({ source: "unicanvas", type: "unsubscribe", layerId });
  }
  state.subs.delete(layerId);
}

function setUniCanvasPoseLayerStatus(sub, status) {
  if (sub.status === status) return;
  sub.status = status;
  updateUniCanvasPoseLayerChips(sub);
}

function updateUniCanvasPoseLayerChips(sub) {
  const widget = sub.stateWidget;
  if (!widget?.container) return;
  for (const el of widget.container.querySelectorAll(`[data-pose-status="${sub.layerId}"]`)) {
    el.textContent = sub.status;
    el.classList.toggle("linked", sub.status === POSE_LAYER_STATUS_LINKED);
    el.classList.toggle("waiting", sub.status === POSE_LAYER_STATUS_WAITING);
    el.classList.toggle("disconnected", sub.status === POSE_LAYER_STATUS_DISCONNECTED);
    el.title = `Pose layer link: ${sub.status}`;
  }
}

function ensureUniCanvasPoseLayerSubscription(state, layer) {
  let sub = state.subs.get(layer.id);
  if (!sub) {
    sub = {
      layerId: layer.id,
      stateWidget: state.widget,
      status: POSE_LAYER_STATUS_DISCONNECTED,
      subscribed: false,
      linkTimer: null,
      previewFrame: null,
      pendingRender: null,
      lastPreviewAt: 0,
      latestSeq: null,
      gesture: null,
    };
    state.subs.set(layer.id, sub);
  }
  if (!sub.subscribed) {
    sub.subscribed = true;
    // Arm the waiting state and the link timeout before broadcasting: a Pose
    // Studio responder answers the subscribe message synchronously and its
    // hello flips the chip to "linked to Pose Studio" during the dispatch.
    setUniCanvasPoseLayerStatus(sub, POSE_LAYER_STATUS_WAITING);
    if (sub.linkTimer) window.clearTimeout(sub.linkTimer);
    sub.linkTimer = window.setTimeout(() => {
      sub.linkTimer = null;
      if (sub.status === POSE_LAYER_STATUS_WAITING) {
        setUniCanvasPoseLayerStatus(sub, POSE_LAYER_STATUS_DISCONNECTED);
      }
    }, POSE_LAYER_LINK_TIMEOUT_MS);
    broadcastUniCanvasPoseLayerMessage({
      source: "unicanvas",
      type: "subscribe",
      layerId: layer.id,
      schemaVersion: POSE_LAYER_SCHEMA_VERSION,
    });
  }
  void loadUniCanvasPoseCharacters(state);
  return sub;
}

function markUniCanvasPoseLayerLinked(sub) {
  if (sub.linkTimer) {
    window.clearTimeout(sub.linkTimer);
    sub.linkTimer = null;
  }
  setUniCanvasPoseLayerStatus(sub, POSE_LAYER_STATUS_LINKED);
}

function handleUniCanvasPoseLayerBusEvent(widget, detail) {
  if (!detail || typeof detail !== "object") return;
  if (detail.source === "unicanvas") return;
  const state = getUniCanvasPoseLayerState(widget);
  const sub = detail.layerId ? state.subs.get(String(detail.layerId)) : null;
  if (detail.type === "hello") {
    const targets = sub ? [sub] : [...state.subs.values()];
    for (const target of targets) markUniCanvasPoseLayerLinked(target);
    return;
  }
  if (detail.type === "render" && sub) {
    handleUniCanvasPoseLayerRender(widget, sub, detail);
  }
}

function handleUniCanvasPoseLayerRender(widget, sub, detail) {
  const layer = widget.layers.find((item) => item.id === sub.layerId);
  if (!layer || layer.type !== POSE_LAYER_TYPE) return;
  // Spec 7.3: while a pose edit session owns the layer, bridge renders are
  // dropped (a queue is not needed) - they must not touch layer pixels or
  // layer.poseData. Render metadata may still mirror morphs into the embedded
  // mannequin through applyExternalCharacterCreatorValues.
  const state = widget._poseLayerState;
  if (state?.session?.layerId === sub.layerId) {
    markUniCanvasPoseLayerLinked(sub);
    if (detail.character) {
      applyUniCanvasPoseLayerCharacterMorphs(state, normalizePoseLayerCharacter(detail.character));
    }
    return;
  }
  const seq = Number(detail.seq);
  // Newest-wins: a render older than the newest one we accepted is stale and
  // is dropped before it ever reaches the canvas.
  if (Number.isFinite(seq)) {
    if (sub.latestSeq !== null && seq < sub.latestSeq) return;
    sub.latestSeq = seq;
  }
  markUniCanvasPoseLayerLinked(sub);
  const quality = detail.quality === "final" ? "final" : "preview";
  const phase = detail.phase || (quality === "final" ? "end" : "move");
  const gestureId = String(detail.gestureId ?? (quality === "final" ? `final-${seq}` : "default"));
  if (!sub.gesture || sub.gesture.id !== gestureId) {
    // One layerPixels history command per gesture: snapshot the pixels before
    // the first replacement and commit the entry on the full-quality capture.
    sub.gesture = {
      id: gestureId,
      before: widget.createLayerPixelSnapshot(layer),
      poseDataBefore: layer.poseData ? deepCloneJSON(layer.poseData) : null,
    };
  }
  if (quality === "final" || phase === "end") {
    void applyUniCanvasPoseLayerRenderPixels(widget, sub, detail, true);
  } else {
    scheduleUniCanvasPoseLayerPreview(widget, sub, detail);
  }
}

/**
 * Live preview pipeline: renders are coalesced through requestAnimationFrame
 * and painted at ~POSE_LAYER_PREVIEW_FPS (15-20 fps) while the user poses.
 * The pending slot holds only the newest render, so the newest value always
 * wins and intermediate frames are skipped instead of queued.
 */
function scheduleUniCanvasPoseLayerPreview(widget, sub, detail) {
  sub.pendingRender = detail;
  if (sub.previewFrame !== null) return;
  const minFrameMs = 1000 / POSE_LAYER_PREVIEW_FPS;
  const pump = () => {
    sub.previewFrame = null;
    const now = performance.now();
    if (now - sub.lastPreviewAt < minFrameMs) {
      sub.previewFrame = requestAnimationFrame(pump);
      return;
    }
    const pending = sub.pendingRender;
    sub.pendingRender = null;
    if (pending) {
      sub.lastPreviewAt = now;
      void applyUniCanvasPoseLayerRenderPixels(widget, sub, pending, false);
    }
  };
  sub.previewFrame = requestAnimationFrame(pump);
}

function loadUniCanvasPoseRenderImage(dataURL) {
  if (typeof dataURL !== "string" || !dataURL.startsWith("data:image/")) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = dataURL;
  });
}

async function applyUniCanvasPoseLayerRenderPixels(widget, sub, detail, commit) {
  const image = await loadUniCanvasPoseRenderImage(detail.dataURL);
  if (!image) return false;
  const seq = Number(detail.seq);
  // Stale async results lose to whatever render was applied while decoding.
  if (Number.isFinite(seq) && sub.latestSeq !== null && seq < sub.latestSeq) return false;
  const layer = widget.layers.find((item) => item.id === sub.layerId);
  if (!layer || layer.type !== POSE_LAYER_TYPE) return false;
  drawUniCanvasPoseRenderIntoLayer(widget, layer, image, detail.render);
  if (commit) {
    layer.poseData = mergeUniCanvasPoseLayerDetail(layer, detail);
    // The character selection made in the Pose Studio Characters panel is
    // authoritative and arrives with the render metadata; mirror it into the
    // embedded edit mannequin through applyExternalCharacterCreatorValues.
    if (detail.character && widget._poseLayerState?.session?.layerId === layer.id) {
      applyUniCanvasPoseLayerCharacterMorphs(widget._poseLayerState, normalizePoseLayerCharacter(detail.character));
    }
    renderUniCanvasPoseLayerPanel(getUniCanvasPoseLayerState(widget), widget.activeLayer);
  }
  widget.markLayerPixelsChanged(layer, null, false);
  widget.refreshLayerRow(layer.id);
  widget.requestRender();
  if (commit) {
    commitUniCanvasPoseLayerGesture(widget, sub, layer);
    widget.setStatus("[VNCCS UniCanvas] Pose render captured");
  }
  return true;
}

function commitUniCanvasPoseLayerGesture(widget, sub, layer) {
  const gesture = sub.gesture;
  sub.gesture = null;
  if (!gesture) return;
  widget.pushHistoryEntry({
    kind: "layerPixels",
    layerId: layer.id,
    before: gesture.before,
    after: widget.createLayerPixelSnapshot(layer),
    poseDataBefore: gesture.poseDataBefore ?? null,
    poseDataAfter: layer.poseData ? deepCloneJSON(layer.poseData) : null,
  });
  widget.refreshLayerRow(layer.id);
  widget.syncLightStateToWidget();
  widget.scheduleFullSync();
}

function mergeUniCanvasPoseLayerDetail(layer, detail) {
  const previous = normalizePoseLayerData(layer.poseData) || buildPoseLayerData({});
  return buildPoseLayerData({
    pose: detail.pose ?? previous.pose,
    character: detail.character ? normalizePoseLayerCharacter(detail.character) : previous.character,
    camera: detail.camera ?? previous.camera,
    size: detail.render?.size ?? previous.render.size,
  });
}

/**
 * Natural-size target rect: the capture lands 1:1 (its render.size), centered
 * on the canvas. This is the fixed point of the editor save draw - reusing it
 * for every save keeps the mannequin footprint constant instead of shrinking
 * into the previous frame's alpha bounds.
 */
function resolveUniCanvasPoseLayerNaturalRect(widget, image, renderMeta) {
  const width = clampRenderSide(renderMeta?.size?.width, image.naturalWidth || image.width || 1024);
  const height = clampRenderSide(renderMeta?.size?.height, image.naturalHeight || image.height || 1024);
  const centerX = widget.origin.x + widget.size.width / 2;
  const centerY = widget.origin.y + widget.size.height / 2;
  return {
    x: Math.round(centerX - width / 2),
    y: Math.round(centerY - height / 2),
    width,
    height,
  };
}

function resolveUniCanvasPoseLayerTargetRect(widget, layer, image, renderMeta) {
  const crop = widget.getLayerAlphaBounds(layer);
  if (crop && crop.width > 0 && crop.height > 0) {
    return {
      x: widget.origin.x + crop.x,
      y: widget.origin.y + crop.y,
      width: crop.width,
      height: crop.height,
    };
  }
  return resolveUniCanvasPoseLayerNaturalRect(widget, image, renderMeta);
}

/**
 * Alpha bounds of the incoming capture, scanned on a scratch canvas (same
 * style as the widget's layer bounds scan). The editor save needs them to
 * align the fresh render with the layer's previous placement (spec 5.1b).
 * Returns image-pixel bounds, or null when the capture is empty/unscannable.
 */
function scanUniCanvasCaptureAlphaBounds(widget, image) {
  const width = image.naturalWidth || image.width || 0;
  const height = image.naturalHeight || image.height || 0;
  if (!width || !height || typeof document === "undefined") return null;
  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const ctx = scratch.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return widget.getCanvasAlphaBounds ? widget.getCanvasAlphaBounds(scratch) : null;
}

export function drawUniCanvasPoseRenderIntoLayer(widget, layer, image, renderMeta, { respectLayerCrop = true } = {}) {
  const natural = resolveUniCanvasPoseLayerNaturalRect(widget, image, renderMeta);
  let target = natural;
  if (respectLayerCrop) {
    target = resolveUniCanvasPoseLayerTargetRect(widget, layer, image, renderMeta);
  } else {
    // Editor save path. Squeezing the fresh capture into the previous alpha
    // bounds scaled the mannequin down on every edit -> save cycle (Bug A),
    // and plain centring threw away a placement the move tool had baked into
    // the bitmap (spec 5.1b). Align 1:1 instead: shift the natural-size rect
    // so the incoming content centre lands on the previous content centre.
    // After one aligned save the centres agree, so repeated saves are stable.
    const previous = widget.getLayerAlphaBounds(layer);
    const incoming = scanUniCanvasCaptureAlphaBounds(widget, image);
    if (previous && previous.width > 0 && previous.height > 0 && incoming && incoming.width > 0 && incoming.height > 0) {
      const incomingWidth = image.naturalWidth || image.width || natural.width;
      const incomingHeight = image.naturalHeight || image.height || natural.height;
      const previousCentreX = previous.x + previous.width / 2;
      const previousCentreY = previous.y + previous.height / 2;
      const naturalIncomingCentreX = natural.x - widget.origin.x + (incoming.x + incoming.width / 2) * (natural.width / incomingWidth);
      const naturalIncomingCentreY = natural.y - widget.origin.y + (incoming.y + incoming.height / 2) * (natural.height / incomingHeight);
      target = {
        x: natural.x + (previousCentreX - naturalIncomingCentreX),
        y: natural.y + (previousCentreY - naturalIncomingCentreY),
        width: natural.width,
        height: natural.height,
      };
    }
  }
  const ctx = widget.configureImageContext(layer.canvas.getContext("2d"), true);
  ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  ctx.drawImage(
    image,
    target.x - widget.origin.x,
    target.y - widget.origin.y,
    target.width,
    target.height,
  );
  layer.hiresCanvas = null;
  layer.hiresRect = null;
}

function nextUniCanvasPoseLayerName(widget) {
  let max = 0;
  for (const layer of widget.layers) {
    const match = String(layer.name || "").match(/^Pose (\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Pose ${max + 1}`;
}

export function createUniCanvasPoseLayer(widget) {
  try {
    const state = getUniCanvasPoseLayerState(widget);
    const layer = widget.addLayer(POSE_LAYER_TYPE, nextUniCanvasPoseLayerName(widget), true, true);
    layer.poseData = buildPoseLayerData({
      pose: {},
      character: defaultUniCanvasPoseLayerCharacter(),
      camera: {},
      size: {
        width: widget.bbox?.width || 1024,
        height: widget.bbox?.height || 1024,
      },
    });
    ensureUniCanvasPoseLayerSubscription(state, layer);
    widget.renderLayerList();
    widget.requestRender();
    widget.syncLightStateToWidget();
    widget.scheduleFullSync();
    widget.setStatus("[VNCCS UniCanvas] Pose layer added - editing the mannequin (Pose Studio link optional)");
    // Open the mannequin editor right away so the layer is immediately usable
    // without any Pose Studio node (spec 7.3 is the local editing path).
    void editUniCanvasPoseLayer(widget, layer).catch((err) => {
      widget.setStatus(`[VNCCS UniCanvas] Pose editor failed: ${err?.message || err}`, true);
    });
    return layer;
  } catch (err) {
    widget.setStatus(`[VNCCS UniCanvas] Could not add a pose layer: ${err?.message || err}`, true);
    return null;
  }
}

/**
 * Convert a pose layer into a normal raster layer (smart object rasterize).
 * One history command: undo restores the pose layer with its poseData.
 */
export function rasterizeUniCanvasPoseLayer(widget, layer) {
  if (!layer || layer.type !== POSE_LAYER_TYPE) {
    widget.setStatus("[VNCCS UniCanvas] Rasterize requires a pose layer", true);
    return false;
  }
  if (widget.transformDraft) {
    widget.setStatus("[VNCCS UniCanvas] Apply or cancel the active transform first", true);
    return false;
  }
  const state = getUniCanvasPoseLayerState(widget);
  if (state.session?.layerId === layer.id) cancelUniCanvasPoseEdit(widget);
  widget.recordHistoryBefore();
  removeUniCanvasPoseLayerSubscription(state, layer.id);
  layer.type = "raster";
  delete layer.poseData;
  widget.invalidateLayerCaches(layer);
  widget.renderLayerList();
  widget.requestRender();
  widget.syncLightStateToWidget();
  widget.scheduleFullSync();
  widget.setStatus("[VNCCS UniCanvas] Pose layer rasterized");
  return true;
}

/**
 * Availability probe only (Minor 2): the character list itself lives with the
 * dropdown in the Pose Studio Characters panel. This fetch only decides
 * whether the status chip has to report that the VNCCS pack is unavailable.
 */
function loadUniCanvasPoseCharacters(state) {
  if (state.charactersPromise) return state.charactersPromise;
  state.charactersPromise = (async () => {
    try {
      const res = await fetch("/vnccs/list_characters");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
      state.charactersNote = "";
    } catch (_err) {
      // Graceful degradation: no VNCCS pack means "Mannequin" only and the
      // status chip says so.
      state.charactersNote = POSE_LAYER_CHARACTERS_UNAVAILABLE_NOTE;
    }
    state.charactersLoaded = true;
    refreshUniCanvasPoseLayerUI(state.widget);
  })();
  return state.charactersPromise;
}

function applyUniCanvasPoseLayerCharacterMorphs(state, character) {
  const morphs = { ...(character?.morphs || {}) };
  // Saved VNCCS character morphs go through the existing
  // applyExternalCharacterCreatorValues() entry point: the embedded pose
  // editor mirrors it and live Pose Studio widgets implement it.
  state.session?.applyExternalCharacterCreatorValues?.(morphs);
  const registry = globalThis.window?.__vnccsPoseStudioCharacterCreatorSync;
  if (registry && registry.studios) {
    for (const studio of registry.studios) {
      if (typeof studio?.applyExternalCharacterCreatorValues === "function") {
        studio.applyExternalCharacterCreatorValues({ ...morphs });
      }
    }
  }
}

function captureUniCanvasPoseLayerNow(widget, layer) {
  if (!layer || layer.type !== POSE_LAYER_TYPE) {
    widget.setStatus("[VNCCS UniCanvas] capture now requires a pose layer", true);
    return false;
  }
  const state = getUniCanvasPoseLayerState(widget);
  if (state.session?.layerId === layer.id) {
    void applyUniCanvasPoseEditCapture(widget, { closeSession: false });
    return true;
  }
  const sub = ensureUniCanvasPoseLayerSubscription(state, layer);
  if (sub.status !== POSE_LAYER_STATUS_LINKED) {
    widget.setStatus("[VNCCS UniCanvas] Pose capture failed: no Pose Studio linked", true);
    return false;
  }
  broadcastUniCanvasPoseLayerMessage({
    source: "unicanvas",
    type: "capture-request",
    layerId: layer.id,
  });
  widget.setStatus("[VNCCS UniCanvas] Pose capture requested");
  return true;
}

function ensureUniCanvasPoseLayerStyles(state) {
  if (state.stylesInstalled || typeof document === "undefined") return;
  if (!document.getElementById("vnccs-uc-pose-layer-styles")) {
    const style = document.createElement("style");
    style.id = "vnccs-uc-pose-layer-styles";
    style.textContent = POSE_LAYER_STYLES;
    document.head.appendChild(style);
  }
  state.stylesInstalled = true;
}

function decorateUniCanvasPoseLayerRow(state, layer, row) {
  const existing = row.querySelector(`[data-pose-chip="${layer.id}"]`);
  if (existing) return;
  const label = row.querySelector(".vnccs-uc-layer-name")?.parentElement || row;
  const chip = document.createElement("div");
  chip.className = "vnccs-uc-pose-chip";
  chip.dataset.poseChip = layer.id;
  const statusEl = document.createElement("span");
  statusEl.className = "vnccs-uc-pose-status";
  statusEl.dataset.poseStatus = layer.id;
  const noteEl = document.createElement("span");
  noteEl.className = "vnccs-uc-pose-status-note";
  noteEl.dataset.poseNote = layer.id;
  const captureBtn = state.widget._button(
    "capture now",
    "vnccs-uc-btn vnccs-uc-pose-capture",
    () => captureUniCanvasPoseLayerNow(state.widget, layer),
    "Capture a full-quality Pose Studio render into this layer",
  );
  chip.append(statusEl, noteEl, captureBtn);
  label.appendChild(chip);
  const sub = state.subs.get(layer.id);
  if (sub) {
    statusEl.textContent = sub.status;
    updateUniCanvasPoseLayerChips(sub);
  }
  noteEl.textContent = state.charactersNote;
}

function ensureUniCanvasPoseLayerPanel(state) {
  if (state.panel && state.panel.isConnected) return state.panel;
  const widget = state.widget;
  const panel = document.createElement("div");
  panel.className = "vnccs-uc-pose-panel";
  const title = document.createElement("div");
  title.className = "vnccs-uc-pose-panel-title";
  title.textContent = "Pose Studio Characters";
  const field = document.createElement("label");
  field.className = "vnccs-uc-field";
  field.textContent = "Character";
  // Read-only mirror: the character dropdown in the Pose Studio Characters
  // panel is the single source of truth for layer.poseData.character.
  const select = document.createElement("select");
  select.className = "vnccs-uc-select";
  select.dataset.poseCharacter = "1";
  select.disabled = true;
  select.title = "Selected in the Pose Studio Characters panel";
  field.appendChild(select);
  panel.append(title, field);
  installCustomSelects(panel);
  if (!widget.layerList?.parentElement) return null;
  widget.layerList.parentElement.insertBefore(panel, widget.layerList);
  state.panel = panel;
  state.panelSelect = select;
  return panel;
}

function renderUniCanvasPoseLayerPanel(state, layer) {
  const panel = ensureUniCanvasPoseLayerPanel(state);
  if (!panel || !state.panelSelect) return;
  const visible = layer && layer.type === POSE_LAYER_TYPE;
  panel.style.display = visible ? "flex" : "none";
  if (!visible) return;
  const character = normalizePoseLayerCharacter(layer.poseData?.character);
  const signature = `${layer.id}|${character.id}|${character.name}`;
  if (state.panelSignature === signature) return;
  state.panelSignature = signature;
  const select = state.panelSelect;
  select.innerHTML = "";
  const option = document.createElement("option");
  option.value = character.id;
  option.textContent = character.name;
  option.selected = true;
  select.appendChild(option);
}

/**
 * Pose layers get their own group heading and count in the layer list so a
 * pose-only stack never reads "Raster Layers" (the raster head counts raster
 * layers only).
 */
function updateUniCanvasPoseLayerGroup(widget, poseLayers) {
  const rasterList = widget.rasterLayerList;
  const layerList = widget.layerList;
  if (!rasterList || !layerList) return;
  let poseList = layerList.querySelector("[data-pose-layer-group]");
  if (!poseList) {
    poseList = document.createElement("div");
    poseList.className = "vnccs-uc-layer-group";
    poseList.dataset.poseLayerGroup = "1";
    layerList.appendChild(poseList);
    widget.attachLayerGroupDrop(poseList, "pose");
  }
  poseList.innerHTML = "";
  poseList.append(widget.createLayerGroupHead("Pose Layers", poseLayers.length, "pose"));
  for (const layer of poseLayers) {
    const row = layerList.querySelector(`[data-layer-id="${layer.id}"]`);
    if (row) poseList.append(row);
  }
  if (!poseLayers.length) poseList.append(widget.createLayerGroupEmpty("No pose layers"));
  const rasterHead = rasterList.querySelector(".vnccs-uc-layer-group-head");
  const rasterCount = widget.layers.filter((layer) => layer.type === "raster").length;
  if (rasterHead?.children?.[1]) rasterHead.children[1].textContent = String(rasterCount);
}

export function refreshUniCanvasPoseLayerUI(widget) {
  if (!widget || widget._disposed) return;
  const state = getUniCanvasPoseLayerState(widget);
  ensureUniCanvasPoseLayerStyles(state);
  if (state.session && !widget.layers.some((layer) => layer.id === state.session.layerId)) {
    cancelUniCanvasPoseEdit(widget);
  }
  const poseLayers = widget.layers.filter((layer) => layer.type === POSE_LAYER_TYPE);
  updateUniCanvasPoseLayerGroup(widget, poseLayers);
  for (const layer of poseLayers) ensureUniCanvasPoseLayerSubscription(state, layer);
  for (const layer of poseLayers) {
    const row = widget.layerList?.querySelector(`[data-layer-id="${layer.id}"]`);
    if (row) decorateUniCanvasPoseLayerRow(state, layer, row);
    const sub = state.subs.get(layer.id);
    if (sub) {
      for (const noteEl of widget.container.querySelectorAll(`[data-pose-note="${layer.id}"]`)) {
        noteEl.textContent = state.charactersNote;
      }
      updateUniCanvasPoseLayerChips(sub);
    }
  }
  renderUniCanvasPoseLayerPanel(state, widget.activeLayer);
}

function buildUniCanvasPoseEditOverlay(state, session) {
  ensureUniCanvasPoseLayerStyles(state);
  const widget = state.widget;
  const overlay = document.createElement("div");
  overlay.className = "vnccs-uc-pose-edit-overlay";
  const canvas = document.createElement("canvas");
  canvas.className = "vnccs-uc-pose-edit-canvas";
  const bar = document.createElement("div");
  bar.className = "vnccs-uc-pose-edit-bar";
  const title = document.createElement("div");
  title.className = "vnccs-uc-pose-edit-title";
  title.textContent = "Edit pose";
  const saveBtn = widget._button(
    "Save pose",
    "vnccs-uc-btn primary",
    () => void saveUniCanvasPoseEdit(widget),
    "Re-render the mannequin and rebuild the pose layer",
  );
  const cancelBtn = widget._button(
    "Cancel",
    "vnccs-uc-btn",
    () => cancelUniCanvasPoseEdit(widget),
    "Restore the previous render untouched",
  );
  const libBtn = widget._button(
    "Pose Library",
    "vnccs-uc-btn",
    () => openUniCanvasPoseLibrary(state, session),
    "Load a pose from the Pose Library",
  );
  const optsBtn = widget._button(
    "Options",
    "vnccs-uc-btn",
    () => openUniCanvasPoseOptions(state, session),
    "Mannequin options (morphs)",
  );
  bar.append(title, libBtn, optsBtn, saveBtn, cancelBtn);
  overlay.append(canvas, bar);
  widget.stageWrap.appendChild(overlay);
  return { overlay, canvas, saveBtn, cancelBtn };
}

// Legacy morph key list (age/gender/weight/muscle/height) kept for backward
// compatibility; the options modal now exposes the full mannequin set below.
const POSE_EDIT_MORPH_KEYS = Object.freeze([
  { key: "age", label: "Age", min: 1, max: 90, step: 1, value: 25 },
  { key: "gender", label: "Gender", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "weight", label: "Weight", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "muscle", label: "Muscle", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "height", label: "Height", min: 0, max: 1, step: 0.01, value: 0.5 },
]);

// Full mannequin options ported from Pose Studio (web/vnccs_pose_studio.js
// meshParams). Gender is a toggle (meshParams.gender: 1.0 = male, 0.0 = female).
const POSE_EDIT_BODY_MORPH_KEYS = Object.freeze([
  { key: "age", label: "Age", min: 1, max: 90, step: 1, value: 25 },
  { key: "weight", label: "Weight", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "muscle", label: "Muscle", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "height", label: "Height", min: 0, max: 2, step: 0.01, value: 0.5 },
]);

const POSE_EDIT_FEMALE_MORPH_KEYS = Object.freeze([
  { key: "breast_size", label: "Breast size", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "firmness", label: "Firmness", min: 0, max: 1, step: 0.01, value: 0.5 },
]);

const POSE_EDIT_MALE_MORPH_KEYS = Object.freeze([
  { key: "penis_len", label: "Penis length", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "penis_circ", label: "Penis girth", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "penis_test", label: "Testicles", min: 0, max: 1, step: 0.01, value: 0.5 },
]);

// Client-side bone scaling proportions (DEFAULT_POSE_STUDIO_MESH_PROPORTIONS).
const POSE_EDIT_PROPORTION_KEYS = Object.freeze([
  { key: "head_size", label: "Head size", min: 0.5, max: 2, step: 0.01, value: 1 },
  { key: "arm_size", label: "Arm size", min: 0.5, max: 2, step: 0.01, value: 1 },
  { key: "hand_size", label: "Hand size", min: 0.5, max: 2, step: 0.01, value: 1 },
  { key: "foot_size", label: "Foot size", min: 0.5, max: 2, step: 0.01, value: 1 },
  { key: "shoulder_l_length", label: "Shoulder L length", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "shoulder_r_length", label: "Shoulder R length", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "hip_l_length", label: "Hip L length", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "hip_r_length", label: "Hip R length", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "upper_arm_l_length", label: "Upper arm L length", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "upper_arm_r_length", label: "Upper arm R length", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "forearm_l_length", label: "Forearm L length", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "forearm_r_length", label: "Forearm R length", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "thigh_l_length", label: "Thigh L length", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "thigh_r_length", label: "Thigh R length", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "shin_l_length", label: "Shin L length", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "shin_r_length", label: "Shin R length", min: 0, max: 1, step: 0.01, value: 0.5 },
  { key: "spine_length", label: "Spine length", min: 0, max: 1, step: 0.01, value: 0.5 },
]);

function openUniCanvasPoseLibrary(state, session) {
  const widget = state.widget;
  const overlay = document.createElement("div");
  overlay.className = "vnccs-uc-modal-overlay";
  const modal = document.createElement("div");
  modal.className = "vnccs-uc-modal";
  modal.style.maxHeight = "70vh";
  modal.style.overflowY = "auto";
  const title = document.createElement("div");
  title.className = "vnccs-uc-modal-title";
  title.textContent = "Pose Library";
  const list = document.createElement("div");
  list.style.display = "grid";
  list.style.gap = "4px";
  const message = document.createElement("div");
  message.className = "vnccs-uc-modal-message";
  message.textContent = "Loading poses...";
  list.appendChild(message);
  const closeBtn = widget._button("Close", "vnccs-uc-btn", () => overlay.remove(), "Close the pose library");
  modal.append(title, list, closeBtn);
  overlay.appendChild(modal);
  widget.container.appendChild(overlay);
  fetch("/vnccs/pose_library/list?full=true")
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))))
    .then((data) => {
      list.textContent = "";
      const entries = Array.isArray(data) ? data : (data?.poses || data?.items || data?.entries || []);
      if (!entries.length) {
        message.textContent = "No poses in the library yet.";
        list.appendChild(message);
        return;
      }
      for (const entry of entries) {
        const pose = entry.pose || entry.poseData?.pose || entry.data?.pose || null;
        const name = String(entry.name || entry.title || entry.id || "pose");
        const btn = widget._button(name, "vnccs-uc-btn", () => {
          if (!pose || !session.viewer?.isInitialized?.()) {
            widget.setStatus("[VNCCS UniCanvas] This pose cannot be applied here", true);
            return;
          }
          session.viewer.setPose(absolutizeUniCanvasPoseBones(session.viewer, pose) || {}, true);
          widget.setStatus(`[VNCCS UniCanvas] Pose loaded: ${name}`);
        }, "Apply this pose to the mannequin");
        list.appendChild(btn);
      }
    })
    .catch((err) => {
      list.textContent = "";
      message.textContent = "Pose library unavailable: " + (err?.message || err);
      list.appendChild(message);
    });
}

function openUniCanvasPoseOptions(state, session) {
  const widget = state.widget;
  const overlay = document.createElement("div");
  overlay.className = "vnccs-uc-modal-overlay";
  const modal = document.createElement("div");
  modal.className = "vnccs-uc-modal";
  modal.style.maxHeight = "70vh";
  modal.style.overflowY = "auto";
  const title = document.createElement("div");
  title.className = "vnccs-uc-modal-title";
  title.textContent = "Mannequin options";
  const hint = document.createElement("div");
  hint.className = "vnccs-uc-modal-message";
  hint.textContent = "Morphs update live; double-click a slider to reset it.";
  modal.append(title, hint);

  let raf = 0;
  const scheduleMorphApply = () => {
    if (raf) return;
    // Coalesce morph application to one frame (repo realtime rule).
    raf = requestAnimationFrame(() => {
      raf = 0;
      void session.applyExternalCharacterCreatorValues?.(session.morphs);
    });
  };
  const setMorphValue = (key, value) => {
    session.morphs = normalizePoseLayerMorphs({ [key]: value }, session.morphs);
    scheduleMorphApply();
  };
  const isFemaleGender = () => Number(session.morphs?.gender ?? 0.5) < 0.5;

  const addSection = (label) => {
    const section = document.createElement("div");
    const heading = document.createElement("div");
    heading.className = "vnccs-uc-modal-message";
    heading.textContent = label;
    section.appendChild(heading);
    modal.appendChild(section);
    return section;
  };
  const addSlider = (container, spec) => {
    const row = document.createElement("label");
    row.className = "vnccs-uc-modal-message";
    row.textContent = spec.label + " ";
    const current = Number(session.morphs?.[spec.key] ?? spec.value);
    const pair = createSliderNumber({
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: Number.isFinite(current) ? current : spec.value,
      resetValue: spec.value,
      onInput: (value) => setMorphValue(spec.key, value),
    });
    row.appendChild(pair.root);
    container.appendChild(row);
  };

  // Gender toggle (meshParams.gender: 1.0 = male, 0.0 = female).
  const genderField = document.createElement("div");
  genderField.className = "vnccs-uc-modal-message";
  genderField.textContent = "Gender ";
  const genderToggle = document.createElement("div");
  genderToggle.className = "vnccs-uc-gender-toggle";
  const maleBtn = document.createElement("button");
  maleBtn.type = "button";
  maleBtn.textContent = "Male";
  const femaleBtn = document.createElement("button");
  femaleBtn.type = "button";
  femaleBtn.textContent = "Female";
  genderToggle.append(maleBtn, femaleBtn);
  genderField.appendChild(genderToggle);
  modal.appendChild(genderField);

  const bodySection = addSection("Body");
  for (const spec of POSE_EDIT_BODY_MORPH_KEYS) addSlider(bodySection, spec);

  // Female options show only while gender < 0.5 (Pose Studio rule).
  const femaleSection = addSection("Female");
  for (const spec of POSE_EDIT_FEMALE_MORPH_KEYS) addSlider(femaleSection, spec);

  // Male options show only while gender >= 0.5.
  const maleSection = addSection("Male");
  const genitalsRow = document.createElement("label");
  genitalsRow.className = "vnccs-uc-modal-message";
  genitalsRow.textContent = "Show genitals ";
  const genitalsInput = document.createElement("input");
  genitalsInput.type = "checkbox";
  genitalsInput.checked = session.morphs?.show_genitals === true;
  genitalsRow.appendChild(genitalsInput);
  maleSection.appendChild(genitalsRow);
  for (const spec of POSE_EDIT_MALE_MORPH_KEYS) addSlider(maleSection, spec);

  const proportionSection = addSection("Proportions");
  for (const spec of POSE_EDIT_PROPORTION_KEYS) addSlider(proportionSection, spec);

  const updateGenderUI = () => {
    const female = isFemaleGender();
    maleBtn.classList.toggle("vnccs-uc-toggle-active", !female);
    femaleBtn.classList.toggle("vnccs-uc-toggle-active", female);
  };
  const updateGenderVisibility = () => {
    const female = isFemaleGender();
    femaleSection.style.display = female ? "" : "none";
    maleSection.style.display = female ? "none" : "";
  };
  const setGender = (value) => {
    setMorphValue("gender", value);
    updateGenderUI();
    updateGenderVisibility();
  };
  maleBtn.addEventListener("click", () => setGender(1));
  femaleBtn.addEventListener("click", () => setGender(0));
  genitalsInput.addEventListener("change", () => {
    const shown = genitalsInput.checked === true;
    setMorphValue("show_genitals", shown);
    // modelUsesGenitals needs show_genitals === true AND gender >= 0.99, so
    // enabling genitals forces the male body.
    if (shown) setGender(1);
  });
  updateGenderUI();
  updateGenderVisibility();

  const closeBtn = widget._button("Close", "vnccs-uc-btn", () => overlay.remove(), "Close mannequin options");
  modal.appendChild(closeBtn);
  overlay.appendChild(modal);
  widget.container.appendChild(overlay);
}

export function buildUniCanvasPoseViewerModelData(result, staticData) {
  const bonePositions = result.bonePositions;
  const bones = (staticData.bones || []).map((bone, index) => {
    const offset = index * 6;
    const headPos = Array.from(bonePositions.subarray(offset, offset + 3));
    const tailPos = Array.from(bonePositions.subarray(offset + 3, offset + 6));
    const dx = tailPos[0] - headPos[0];
    const dy = tailPos[1] - headPos[1];
    const dz = tailPos[2] - headPos[2];
    return {
      name: bone.name,
      parent: bone.parent || null,
      headPos,
      tailPos,
      length: Math.hypot(dx, dy, dz),
    };
  });
  return {
    status: "success",
    vertices: result.vertices,
    uvs: staticData.uvs,
    indices: staticData.indices,
    bones,
    skinIndices: staticData.skinIndices,
    skinWeights: staticData.skinWeights,
    landmarks: result.landmarks || {},
    landmark_indices: result.landmarkIndices || {},
  };
}

// Proportion morph keys are client-side bone scaling (the Pose Studio
// meshParams proportions); solveMorph/calculateMorphFactors only understand
// body morphs, so these are applied straight to the viewer skeleton.
const POSE_PROPORTION_SIZE_SETTERS = Object.freeze({
  head_size: ["updateHeadScale", "setHeadScale"],
  arm_size: ["updateArmScale", "setArmScale"],
  hand_size: ["updateHandScale", "setHandScale"],
  foot_size: ["updateFootScale", "setFootScale"],
});

function applyUniCanvasPoseProportionParams(viewer, morphs) {
  if (!viewer || !morphs) return;
  for (const [key, rawValue] of Object.entries(morphs)) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    if (key.endsWith("_length")) {
      // Slider 0..1 maps to a bone offset scale in the viewer core.
      const group = key.slice(0, -"_length".length);
      if (!group) continue;
      if (typeof viewer.updateBoneLengthScale === "function") viewer.updateBoneLengthScale(group, value);
      continue;
    }
    const setterNames = POSE_PROPORTION_SIZE_SETTERS[key];
    if (!setterNames) continue;
    for (const name of setterNames) {
      // Skip silently when the viewer core does not expose the setter.
      if (typeof viewer[name] === "function") {
        viewer[name](value);
        break;
      }
    }
  }
}

async function applyUniCanvasPoseEditMorphs(session, morphs) {
  const token = ++session.loadToken;
  const runtime = session.morphRuntime;
  const pack = session.morphPack;
  const viewer = session.viewer;
  if (!runtime || !pack || !viewer) return false;
  const result = runtime.solveMorph(pack, { ...morphs });
  const staticData = runtime.buildStaticModelData(pack, result.includeGenitals);
  // Newest-wins: a newer morph solve supersedes this one entirely.
  if (session.closed || token !== session.loadToken) return false;
  const currentPose = viewer.isInitialized?.() ? viewer.getPose() : null;
  viewer.loadData(buildUniCanvasPoseViewerModelData(result, staticData), true);
  // Proportion keys reshape the skeleton and re-cache the shaped rest bone
  // positions; apply them BEFORE setPose so pose offsets land on the new rest.
  applyUniCanvasPoseProportionParams(viewer, morphs);
  // The stored pose is relativized to the shaped rest; absolutize it before it
  // can reach setPose (the live getPose() result is already absolute).
  const fallbackPose = absolutizeUniCanvasPoseBones(viewer, session.poseData.pose || {}) || {};
  viewer.setPose(currentPose || fallbackPose, true);
  return true;
}

/**
 * Shared capture dance (the Pose Studio bridge imports this - single copy):
 * hide the scene background and skydome so the PNG keeps real alpha, capture
 * with the stored framing, then restore the editor view.
 */
function snapshotUniCanvasViewerCamera(viewer) {
  const cam = viewer?.camera;
  if (!cam?.position) return null;
  return {
    position: [cam.position.x, cam.position.y, cam.position.z],
    target: viewer.orbit?.target ? [viewer.orbit.target.x, viewer.orbit.target.y, viewer.orbit.target.z] : null,
  };
}

function restoreUniCanvasViewerCamera(viewer, state) {
  if (!state || !viewer?.camera?.position) return;
  viewer.camera.position.set(state.position[0], state.position[1], state.position[2]);
  if (state.target && viewer.orbit?.target) viewer.orbit.target.set(state.target[0], state.target[1], state.target[2]);
}

export function captureUniCanvasPoseLayerPNG(viewer, width, height, camera) {
  const framing = normalizePoseLayerCamera(camera);
  const scene = viewer.scene;
  const previousBackground = scene ? scene.background : null;
  const skydomeWasVisible = viewer.directionalSkydomeVisible !== false;
  // viewer.capture() syncs the VIEW camera to the capture camera; snapshot and
  // restore it so edit->save cycles cannot accumulate camera drift.
  const cameraState = snapshotUniCanvasViewerCamera(viewer);
  if (scene) scene.background = null;
  viewer.setDirectionalSkydomeVisible?.(false);
  try {
    return viewer.capture(
      width,
      height,
      framing.zoom,
      null,
      framing.offset_x,
      framing.offset_y,
      framing.yaw_deg,
      framing.pitch_deg,
    );
  } finally {
    if (scene) scene.background = previousBackground;
    viewer.setDirectionalSkydomeVisible?.(skydomeWasVisible);
    restoreUniCanvasViewerCamera(viewer, cameraState);
    viewer.requestRender?.();
  }
}

// Pose round-trip (user report: the mannequin receded in Z on every
// edit -> save cycle). bonePositions are stored RELATIVE to the shaped rest so
// the viewer's morph-driven bone-offset re-scaling cannot accumulate across
// sessions; legacy poses (no tag) pass through as absolute positions.
function shapedRestPositionOf(viewer, name) {
  return viewer?.shapedBoneRestPositions?.[name] || viewer?.initialBoneStates?.[name]?.position || null;
}

export function relativizeUniCanvasPoseBones(viewer, pose) {
  const absolute = pose && pose.bonePositions;
  if (!absolute || !viewer) return pose;
  const relative = {};
  for (const [name, position] of Object.entries(absolute)) {
    const rest = shapedRestPositionOf(viewer, name);
    if (rest && Array.isArray(position) && position.length >= 3) {
      relative[name] = [position[0] - rest.x, position[1] - rest.y, position[2] - rest.z];
    } else {
      relative[name] = position;
    }
  }
  return { ...pose, bonePositions: relative, bonePositionsRel: true };
}

export function absolutizeUniCanvasPoseBones(viewer, pose) {
  const relative = pose && pose.bonePositions;
  if (!relative || !pose.bonePositionsRel || !viewer) return pose;
  const absolute = {};
  for (const [name, delta] of Object.entries(relative)) {
    const rest = shapedRestPositionOf(viewer, name);
    if (rest && Array.isArray(delta) && delta.length >= 3) {
      absolute[name] = [delta[0] + rest.x, delta[1] + rest.y, delta[2] + rest.z];
    } else {
      absolute[name] = delta;
    }
  }
  return { ...pose, bonePositions: absolute, bonePositionsRel: false };
}

function captureUniCanvasPoseEditPNG(session) {
  const viewer = session.viewer;
  if (!viewer?.isInitialized?.()) return null;
  const size = session.poseData.render.size;
  return captureUniCanvasPoseLayerPNG(viewer, size.width, size.height, session.poseData.camera);
}

function closeUniCanvasPoseEditSession(state) {
  const session = state.session;
  if (!session) return;
  session.closed = true;
  try {
    session.viewer?.dispose?.();
  } catch (err) {
    console.warn("[VNCCS UniCanvas] Pose editor dispose failed", err);
  }
  session.viewer = null;
  session.resizeObserver?.disconnect?.();
  session.resizeObserver = null;
  session.overlay?.remove();
  state.session = null;
}

async function applyUniCanvasPoseEditCapture(widget, { closeSession }) {
  const state = getUniCanvasPoseLayerState(widget);
  const session = state.session;
  if (!session) return false;
  const layer = widget.layers.find((item) => item.id === session.layerId);
  if (!layer || layer.type !== POSE_LAYER_TYPE) {
    cancelUniCanvasPoseEdit(widget);
    return false;
  }
  const viewer = session.viewer;
  if (!viewer?.isInitialized?.()) {
    widget.setStatus("[VNCCS UniCanvas] Pose editor is still loading", true);
    return false;
  }
  const pose = relativizeUniCanvasPoseBones(viewer, viewer.getPose());
  const png = captureUniCanvasPoseEditPNG(session);
  // One history command: Save pose rebuilds the layer pixels and poseData
  // together, so undo restores both.
  widget.recordHistoryBefore();
  layer.poseData = buildPoseLayerData({
    pose,
    // Persist the session morphs (Mannequin options + character creator):
    // keeping the OLD character.morphs would rebuild the next edit session
    // with a differently shaped rest = visible drift on every save cycle.
    character: {
      ...(layer.poseData?.character || session.poseData.character || {}),
      morphs: { ...session.morphs },
    },
    camera: session.poseData.camera,
    size: session.poseData.render.size,
  });
  if (png) {
    const image = await loadUniCanvasPoseRenderImage(png);
    if (image) {
      // Natural size, centered: the capture camera framing is fixed, so every
      // save redraws the same footprint and the round trip stays the identity
      // (squeezing into the layer's previous alpha bounds shrank the mannequin
      // on each edit -> save cycle - Bug A).
      drawUniCanvasPoseRenderIntoLayer(widget, layer, image, session.poseData.render, { respectLayerCrop: false });
    }
  }
  widget.markLayerPixelsChanged(layer, null, false);
  widget.refreshLayerRow(layer.id);
  if (closeSession) {
    layer._poseEditing = false;
    closeUniCanvasPoseEditSession(state);
  }
  widget.renderLayerList();
  widget.requestRender();
  widget.syncLightStateToWidget();
  widget.scheduleFullSync();
  widget.setStatus(closeSession ? "[VNCCS UniCanvas] Pose saved" : "[VNCCS UniCanvas] Pose captured");
  return true;
}

export async function saveUniCanvasPoseEdit(widget) {
  const saved = await applyUniCanvasPoseEditCapture(widget, { closeSession: true });
  if (saved) widget.setTool?.("move");
  return saved;
}

export function cancelUniCanvasPoseEdit(widget) {
  const state = widget._poseLayerState;
  const session = state?.session;
  if (!session) return false;
  const layer = widget.layers.find((item) => item.id === session.layerId);
  if (layer) {
    layer._poseEditing = false;
    // Spec 7.3: Cancel restores the pre-edit render and poseData untouched,
    // whatever happened while the mannequin was on the stage.
    if (session.beforePixels) widget.restoreLayerPixelSnapshot(layer, session.beforePixels);
    if (session.beforePoseData) layer.poseData = deepCloneJSON(session.beforePoseData);
    widget.markLayerPixelsChanged(layer, null, false);
  }
  closeUniCanvasPoseEditSession(state);
  widget.renderLayerList();
  widget.requestRender();
  widget.setStatus("[VNCCS UniCanvas] Pose edit canceled");
  widget.setTool?.("move");
  return true;
}

/**
 * In-place pose editing (spec 7.3): the mannequin tool replaces the pose
 * layer pixels with an interactive mannequin embedded over the stage. The
 * mannequin is loaded from layer.poseData (pose, character morphs, camera)
 * by reusing the Pose Studio viewer and morph runtime.
 */
export async function editUniCanvasPoseLayer(widget, layer) {
  if (!layer || layer.type !== POSE_LAYER_TYPE) {
    widget.setStatus("[VNCCS UniCanvas] Edit pose requires a pose layer", true);
    return null;
  }
  const state = getUniCanvasPoseLayerState(widget);
  if (state.session) {
    if (state.session.layerId === layer.id) return state.session;
    cancelUniCanvasPoseEdit(widget);
  }
  const poseData = normalizePoseLayerData(layer.poseData) || buildPoseLayerData({});
  const session = {
    layerId: layer.id,
    poseData,
    beforePixels: widget.createLayerPixelSnapshot(layer),
    beforePoseData: layer.poseData ? deepCloneJSON(layer.poseData) : null,
    morphs: { ...(poseData.character?.morphs || {}) },
    viewer: null,
    morphPack: null,
    morphRuntime: null,
    resizeObserver: null,
    loadToken: 0,
    closed: false,
    overlay: null,
    canvas: null,
  };
  session.applyExternalCharacterCreatorValues = (values) => {
    if (!values || typeof values !== "object") return false;
    session.morphs = normalizePoseLayerMorphs(values, session.morphs);
    void applyUniCanvasPoseEditMorphs(session, session.morphs);
    return true;
  };
  const ui = buildUniCanvasPoseEditOverlay(state, session);
  session.overlay = ui.overlay;
  session.canvas = ui.canvas;
  state.session = session;
  // The layer's pixels are temporarily replaced by the interactive mannequin.
  layer._poseEditing = true;
  widget.renderLayerList();
  widget.requestRender();
  widget.setStatus("[VNCCS UniCanvas] Loading pose editor...");
  try {
    const [coreModule, morphRuntime] = await Promise.all([
      import("./vnccs_pose_studio_core.js"),
      import("./vnccs_pose_morph_runtime.mjs"),
    ]);
    if (session.closed) return null;
    session.morphRuntime = morphRuntime;
    const rect = session.overlay.getBoundingClientRect();
    const viewer = new coreModule.PoseViewerCore(session.canvas, {
      rendererAlpha: true,
      syncMode: "end",
      skinMode: "flat_color",
      showSkeletonHelper: true,
      showCaptureFrame: false,
      showReferenceImage: false,
      onError: (err) => widget.setStatus(`[VNCCS UniCanvas] Pose editor error: ${err?.message || err}`, true),
    });
    session.viewer = viewer;
    await viewer.init();
    if (session.closed) return null;
    const viewWidth = Math.round(rect.width);
    const viewHeight = Math.round(rect.height);
    // A zero-size overlay would give the viewer a 1x1 canvas; fall back to sane
    // defaults so the mannequin is always visible.
    viewer.resize(viewWidth > 2 ? viewWidth : 480, viewHeight > 2 ? viewHeight : 320);
    if (typeof globalThis.ResizeObserver === "function") {
      session.resizeObserver = new globalThis.ResizeObserver(() => {
        const bounds = session.overlay?.getBoundingClientRect();
        if (bounds && session.viewer) {
          session.viewer.resize(Math.max(1, Math.round(bounds.width)), Math.max(1, Math.round(bounds.height)));
        }
      });
      session.resizeObserver.observe(session.overlay);
    }
    session.morphPack = await morphRuntime.loadMorphPack();
    if (session.closed) return null;
    await applyUniCanvasPoseEditMorphs(session, session.morphs);
    // preserveCamera keeps every edit session on the default framing so the
    // saved pose round-trips without view drift.
    viewer.setPose(absolutizeUniCanvasPoseBones(viewer, poseData.pose) || {}, true);
    widget.setStatus("[VNCCS UniCanvas] Edit pose - drag the mannequin, then Save pose or Cancel");
  } catch (err) {
    console.warn("[VNCCS UniCanvas] Pose editor failed to start", err);
    widget.setStatus(`[VNCCS UniCanvas] Pose editor failed: ${err?.message || err}`, true);
    cancelUniCanvasPoseEdit(widget);
    return null;
  }
  return session;
}

export function disposeUniCanvasPoseLayers(widget) {
  const state = widget?._poseLayerState;
  if (!state) return;
  cancelUniCanvasPoseEdit(widget);
  for (const layerId of [...state.subs.keys()]) {
    removeUniCanvasPoseLayerSubscription(state, layerId);
  }
  window.removeEventListener(POSE_LAYER_BUS_EVENT, state.busListener);
  state.panel?.remove();
  widget._poseLayerState = null;
}
