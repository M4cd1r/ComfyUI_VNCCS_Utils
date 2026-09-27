/**
 * VNCCS UniCanvas direct generation client, shared by the features that run the UniCanvas model
 * outside the GENERATE button (character bake, sprite variants, AI harmonize):
 *
 *  - requestDirectDraw(payload): POST /vnccs/unicanvas/draw and the returned images.
 *  - runExclusiveGeneration(uc, work): the widget's generation lock around `work`, so only one
 *    generation runs at a time and the controls that start one are disabled meanwhile.
 */

export const UNICANVAS_DRAW_ROUTE = "/vnccs/unicanvas/draw";

/** A draw debug id (it also keys the progress polling): `${prefix}-<time>-<random>`. */
export function drawDebugId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The images of a /draw response: `images` when it has any, else the single `image`. */
export function drawResponseImages(data) {
  return Array.isArray(data?.images) && data.images.length ? data.images : [data?.image].filter(Boolean);
}

/**
 * Runs one direct draw. Resolves `{ data, images }`; throws an Error with the backend's `error`
 * or `HTTP <status>`, also when a proxy answers with a non-JSON page.
 */
export async function requestDirectDraw(payload, { route = UNICANVAS_DRAW_ROUTE } = {}) {
  const res = await fetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  if (!res.ok || !data || typeof data !== "object" || data.error) {
    throw new Error(data?.error || (res.ok ? `Invalid response from the server (HTTP ${res.status})` : `HTTP ${res.status}`));
  }
  return { data, images: drawResponseImages(data) };
}

/** Sets the generation lock and the controls it disables (GENERATE and the batch count). */
export function setGenerationLock(uc, on) {
  uc.drawInProgress = on;
  if (uc.drawBtn) uc.drawBtn.disabled = on;
  if (uc.batchInput) uc.batchInput.disabled = on;
}

/** Runs `work` under the generation lock and releases it however `work` ends. */
export async function runExclusiveGeneration(uc, work) {
  setGenerationLock(uc, true);
  try {
    return await work();
  } finally {
    setGenerationLock(uc, false);
  }
}
