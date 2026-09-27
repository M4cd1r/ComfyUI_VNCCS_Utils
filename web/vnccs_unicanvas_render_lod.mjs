// Render LOD levels for large inactive layers (a downscaled copy drawn instead of the full canvas).
export const RENDER_LOD_LEVELS = [0.5, 0.25, 0.125, 0.0625];

// The LOD copy must never have fewer pixels than the screen needs: pick the smallest level at or
// above the target scale, and full resolution once the target exceeds the largest level. (Picking
// the first level below the target drew every inactive layer at half resolution when zoomed in.)
export function pickRenderLodScale(targetScale) {
  const target = Number(targetScale);
  if (!Number.isFinite(target) || target > RENDER_LOD_LEVELS[0]) return 1;
  let best = RENDER_LOD_LEVELS[0];
  for (const scale of RENDER_LOD_LEVELS) {
    if (scale >= target) best = scale;
  }
  return best;
}

// Stage oversampling for still frames: LOD copies keep 2.25x the screen density so an inactive
// layer stays sharp at the current zoom.
export const RENDER_LOD_OVERSAMPLE = 2.25;

// Timeline playback redraws every layer on every frame: source pixels at screen density are
// enough for a moving frame (the lightweight preview of the realtime rule); pausing renders the
// frame at full quality again. On a CPU rasterizer this halves the cost of rotated 1080p layers.
export const PLAYBACK_LOD_OVERSAMPLE = 1;
export const PLAYBACK_LOD_CACHE_KEY = "_playbackLodCache";

/** Every per-layer LOD cache; a pixel change clears them all. */
export const RENDER_LOD_CACHE_KEYS = Object.freeze(["_renderLodCache", "_hiresRenderLodCache", PLAYBACK_LOD_CACHE_KEY]);

export function clearRenderLodCaches(layer) {
  if (!layer) return;
  for (const key of RENDER_LOD_CACHE_KEYS) layer[key] = null;
}
