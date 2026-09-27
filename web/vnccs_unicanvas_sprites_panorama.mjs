/**
 * Sprite sets in panorama documents (issue #6, #33).
 *
 * A sprite set stores flat variant pixels at one shared world rect. In a panorama the editing
 * window shows the sphere from the current camera, so the rect only means something together
 * with the camera it was measured from: `sprite.panoramaCamera`, the sprite's anchor camera.
 *
 *  - The layer's sphere holds the active variant as seen from the anchor camera. Showing a
 *    variant replaces the sphere (`PanoramaDocument.replaceLayerFromView`), from any view.
 *  - Reading the layer back (paint that should land in the active variant) renders the sphere
 *    from the anchor camera (`viewOfLayer`), so the variant never takes pixels of another view.
 *  - Edits that are measured in the current view (move, transform, paint on all variants)
 *    first re-anchor the set: every variant is re-projected into the current view and the
 *    rect, anchor point and face area follow.
 *  - Sync bookkeeping follows the sphere (`layer.panoramaRevision`), not the view's pixel
 *    revision: turning the camera re-projects the view but must not re-copy the variant.
 *
 * Flat documents go through the same adapter unchanged (`createSpriteSurface` without a
 * panorama draws straight into `layer.canvas`). Pure helpers run under Node for tests.
 */

import { sphereToView, viewToSphere } from "./vnccs_unicanvas_panorama.mjs";

export const SPRITE_CAMERA_KEYS = Object.freeze(["yaw", "pitch", "roll", "fov"]);

/** `{ yaw, pitch, roll, fov }` from panorama settings or a saved sprite, or null. */
export function normalizeSpriteCamera(raw) {
  if (!raw || typeof raw !== "object") return null;
  const values = SPRITE_CAMERA_KEYS.map((key) => Number(raw[key] ?? (key === "fov" ? 90 : 0)));
  if (!values.every(Number.isFinite)) return null;
  return Object.fromEntries(SPRITE_CAMERA_KEYS.map((key, index) => [key, values[index]]));
}

export const sameSpriteCamera = (a, b) => Boolean(a && b)
  && SPRITE_CAMERA_KEYS.every((key) => Math.abs(Number(a[key]) - Number(b[key])) < 1e-6);

/**
 * A world point of the editing window `frame` seen from camera `from`, as seen from camera
 * `to`; null when it falls outside the window of `to`.
 */
export function mapViewPoint(point, frame, from, to) {
  const sphere = viewToSphere((point.x - frame.x) / frame.width, (point.y - frame.y) / frame.height, from);
  const view = sphereToView(sphere.u, sphere.v, to);
  return view && { x: frame.x + view.u * frame.width, y: frame.y + view.v * frame.height };
}

/**
 * The drawing surface of sprite layers. `helpers` are the sprite module's pure box helpers
 * (`mapBox`, `clampBox`, `unionBox`, `alphaBounds`, `alphaOf`, `readPixels`, optional `drawScaled`),
 * passed in to keep this module free of an import cycle. Variant pixels may be stored above the
 * rect's resolution (source resolution); they are drawn scaled to the rect.
 */
export function createSpriteSurface(uc, helpers) {
  const { mapBox, clampBox, unionBox, alphaBounds, alphaOf, readPixels } = helpers;
  const drawScaled = helpers.drawScaled || ((ctx, pixels, x, y, width, height) => ctx.drawImage(pixels, x, y, width, height));
  const doc = () => uc.panorama || null;
  const currentCamera = () => normalizeSpriteCamera(doc()?.settings);
  const anchorOf = (layer) => normalizeSpriteCamera(layer.sprite?.panoramaCamera) || currentCamera();
  const local = (rect) => ({ x: rect.x - uc.origin.x, y: rect.y - uc.origin.y });

  function viewCanvas(layer, pixels, rect) {
    const view = uc._createCanvas(layer.canvas.width, layer.canvas.height);
    if (pixels) drawScaled(view.getContext("2d"), pixels, local(rect).x, local(rect).y, rect.width, rect.height);
    return view;
  }

  function boundsOf(canvas) {
    return alphaBounds(alphaOf(readPixels(canvas)), canvas.width, canvas.height);
  }

  const surface = {
    /** The camera a new sprite set made from `source` is measured in (null in flat documents). */
    cameraFor(source) {
      if (!doc()) return null;
      return normalizeSpriteCamera(source?.type === "pose" ? source.pose?.panoramaCamera : null) || currentCamera();
    },

    /** Whether the editing window shows the set from its anchor camera. */
    anchored(layer) {
      return !doc() || sameSpriteCamera(anchorOf(layer), currentCamera());
    },

    /** Changes when the layer's own pixels change (the sphere in a panorama). */
    syncKey(layer) {
      if (!doc()) return layer.pixelRevision;
      doc().commitLayer(layer);
      return `sphere:${layer.panoramaRevision || 0}`;
    },

    /** The layer as seen from its anchor camera, in layer-canvas coordinates. */
    read(layer) {
      if (!doc() || surface.anchored(layer)) return layer.canvas;
      return doc().viewOfLayer(layer, anchorOf(layer));
    },

    /** Alpha bounds (canvas coordinates) of a canvas returned by `read`. */
    bounds(layer, canvas) {
      return canvas === layer.canvas ? uc.getLayerAlphaBounds(layer) : boundsOf(canvas);
    },

    /**
     * Make `pixels` at world `rect` the whole content of `target`, measured from `camera`
     * (default: the sprite's anchor camera). Caches are invalidated here.
     */
    write(target, pixels, rect, camera = null) {
      target.hiresCanvas = null;
      target.hiresRect = null;
      if (!doc()) {
        const ctx = target.canvas.getContext("2d");
        ctx.clearRect(0, 0, target.canvas.width, target.canvas.height);
        if (pixels) drawScaled(ctx, pixels, local(rect).x, local(rect).y, rect.width, rect.height);
        uc.invalidateLayerCaches(target);
        return;
      }
      // replaceLayerFromView re-projects the view, which invalidates the caches and leaves the
      // view clean, so the next commit does not bump the sphere revision again.
      doc().replaceLayerFromView(target, viewCanvas(target, pixels, rect), camera || anchorOf(target));
    },

    /**
     * Before an edit measured in the current view: re-project every variant from the anchor
     * camera into the current view. Returns whether anything moved.
     */
    reanchor(layer) {
      const panorama = doc(), sprite = layer.sprite;
      if (!panorama || !sprite) return false;
      const to = currentCamera();
      const from = normalizeSpriteCamera(sprite.panoramaCamera);
      if (!from) { sprite.panoramaCamera = to; return false; }
      if (sameSpriteCamera(from, to)) return false;
      const old = sprite.rect;
      const views = new Map();
      let box = null, content = null;
      for (const variant of sprite.variants) {
        if (!variant.pixels) continue;
        // Content bounds in rect units (variants may be stored at a higher resolution).
        const own = boundsOf(variant.pixels);
        const kx = variant.pixels.width / Math.max(1, old.width), ky = variant.pixels.height / Math.max(1, old.height);
        if (own) content = unionBox(content, { x: own.x / kx, y: own.y / ky, width: own.width / kx, height: own.height / ky });
        const view = panorama.reprojectView(viewCanvas(layer, variant.pixels, old), from, to);
        views.set(variant, view);
        box = unionBox(box, boundsOf(view));
      }
      // The new rect keeps the margins the old one had around the pixels; when nothing of the
      // set is visible from here the rect stays where it is.
      const pad = content
        ? { left: content.x, top: content.y, right: old.width - content.x - content.width, bottom: old.height - content.y - content.height }
        : { left: 0, top: 0, right: 0, bottom: 0 };
      const next = box ? {
        x: box.x + uc.origin.x - pad.left, y: box.y + uc.origin.y - pad.top,
        width: box.width + pad.left + pad.right, height: box.height + pad.top + pad.bottom,
      } : { ...old };
      // Re-projected variants come back at the view's (rect) resolution.
      for (const [variant, view] of views) {
        const pixels = uc._createCanvas(next.width, next.height);
        pixels.getContext("2d").drawImage(view, next.x - uc.origin.x, next.y - uc.origin.y, next.width, next.height, 0, 0, next.width, next.height);
        variant.pixels = pixels;
      }
      const frame = uc.bbox;
      const shift = { x: next.x - old.x, y: next.y - old.y };
      const map = (point) => mapViewPoint(point, frame, from, to) || { x: point.x + shift.x, y: point.y + shift.y };
      const anchor = map({ x: old.x + sprite.anchor.x, y: old.y + sprite.anchor.y });
      sprite.anchor = {
        x: Math.max(0, Math.min(next.width, anchor.x - next.x)),
        y: Math.max(0, Math.min(next.height, anchor.y - next.y)),
      };
      if (sprite.faceRect) {
        const face = mapBox(map, { ...sprite.faceRect, x: old.x + sprite.faceRect.x, y: old.y + sprite.faceRect.y });
        sprite.faceRect = clampBox({ ...face, x: face.x - next.x, y: face.y - next.y }, next.width, next.height);
      }
      sprite.rect = next;
      sprite.panoramaCamera = to;
      return true;
    },
  };
  return surface;
}
