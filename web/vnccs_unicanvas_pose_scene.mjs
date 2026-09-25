/**
 * VNCCS UniCanvas multi-character pose scenes (Plan 01, issue #4): split and merge.
 *
 *  - Split characters to layers: one pose layer per mannequin, each holding a copy of the
 *    studio scene with only that character, the same rect, viewport and camera, and its
 *    reference moved into `pose.character`. The original stays hidden directly below, so the
 *    split is reversible by hand as well as by Undo. Pixels come from the editor's solo pass.
 *  - Merge pose layers: the inverse for a multi-selection of pose layers with identical rect and
 *    viewport, capped at MAX_POSE_STUDIO_CHARACTERS, references merged by character id.
 *  - Both are one `historyGroup` entry (addLayer / layerProps / removeLayer + groupStructure).
 *
 * The pure helpers run under Node for tests; installUniCanvasPoseScene binds the actions onto
 * the widget like installUniCanvasLayerTools.
 */

import { MAX_POSE_STUDIO_CHARACTERS, nextCharacterColor, nextCharacterId, nextCharacterSlot, normalizeCharacterColor,
  normalizePoseStudioCharacters } from "./vnccs_pose_characters.mjs";
import { getPoseCharacterMask, poseCharacterPrompt, poseCharacterRef, poseStudioCharacters } from "./vnccs_unicanvas_pose_state.mjs";
import { captureGroupStructure } from "./vnccs_unicanvas_groups.mjs";
import { createLayerMeta } from "./vnccs_unicanvas_provenance.mjs";

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));
const newId = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
const sameJSON = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The full studio characters of a pose (v3 scene schema, or the migrated legacy singleton). */
export function studioCharacterList(pose) {
  const studio = pose?.studio || {};
  const list = Array.isArray(studio.characters) && studio.characters.length
    ? clone(studio.characters)
    : normalizePoseStudioCharacters(clone(studio)).characters;
  return list.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
}

/** A copy of a studio state holding `characters`, with the legacy mirrors of the first one. */
export function studioWithCharacters(studio, characters) {
  const next = clone(studio || {});
  const sorted = [...characters].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  const primary = sorted[0];
  next.characters = clone(sorted);
  next.active_character_id = primary.id;
  if (primary.mesh) next.mesh = clone(primary.mesh);
  if (Array.isArray(next.poses) && next.poses.length && Array.isArray(primary.poses)) next.poses = clone(primary.poses);
  if (Array.isArray(next.image_poses) && Array.isArray(primary.poses)) next.image_poses = clone(primary.poses);
  if (next.animation && primary.animation) next.animation = clone(primary.animation);
  if (next.export && primary.transform) {
    next.export = { ...next.export, cam_offset_x: primary.transform.x ?? 0, cam_offset_y: primary.transform.y ?? 0, cam_zoom: primary.transform.zoom ?? 1 };
  }
  return next;
}

function refEntry(layer, characterId) {
  const ref = poseCharacterRef(layer, characterId);
  const prompt = poseCharacterPrompt(layer, characterId);
  return ref || prompt ? { ...(ref || {}), ...(prompt ? { prompt } : {}) } : null;
}

/** The pose of one split layer: the scene with only `characterId`, its reference in `character`. */
export function splitPoseState(layer, characterId) {
  const pose = layer.pose;
  const character = studioCharacterList(pose).find((item) => String(item.id) === String(characterId));
  if (!character) return null;
  const next = clone(pose);
  delete next.ui;
  delete next.characterRefs;
  next.studio = studioWithCharacters(pose.studio, [character]);
  next.character = poseCharacterRef(layer, characterId);
  const prompt = poseCharacterPrompt(layer, characterId);
  if (prompt) next.characterRefs = { [character.id]: { ...(next.character || {}), prompt } };
  return next;
}

/** Why `layers` cannot merge into one pose layer, or null. */
export function mergePoseIssue(layers) {
  if (layers.length < 2 || layers.some((layer) => layer?.type !== "pose" || !layer.pose)) return "Select two or more pose layers to merge.";
  if (layers.some((layer) => layer.locked)) return "Unlock the pose layers to merge them.";
  const [first] = layers;
  if (!layers.every((layer) => sameJSON(layer.pose.rect, first.pose.rect) && sameJSON(layer.pose.viewport, first.pose.viewport))) {
    return "Only pose layers with the same frame and camera can be merged.";
  }
  const total = layers.reduce((sum, layer) => sum + studioCharacterList(layer.pose).length, 0);
  if (total > MAX_POSE_STUDIO_CHARACTERS) return `A pose layer holds at most ${MAX_POSE_STUDIO_CHARACTERS} characters (these hold ${total}).`;
  return null;
}

/** The merged pose of `layers` (top to bottom): the top layer's scene with every mannequin. */
export function mergePoseState(layers) {
  const characters = [];
  const refs = {};
  for (const layer of layers) {
    for (const source of studioCharacterList(layer.pose)) {
      const id = characters.some((item) => item.id === String(source.id)) ? nextCharacterId(characters) : String(source.id);
      const slot = nextCharacterSlot(characters, source.slot);
      const color = characters.some((item) => normalizeCharacterColor(item.color) === normalizeCharacterColor(source.color))
        ? nextCharacterColor(characters, slot) : source.color;
      characters.push({ ...clone(source), id, slot, color });
      const entry = refEntry(layer, source.id);
      if (entry) refs[id] = entry;
    }
  }
  const base = layers[0].pose;
  const pose = clone(base);
  delete pose.ui;
  pose.studio = studioWithCharacters(base.studio, characters);
  const first = pose.studio.characters[0].id;
  const { prompt: _prompt, ...firstRef } = refs[first] || {};
  pose.character = firstRef.source ? firstRef : null;
  pose.characterRefs = refs;
  return pose;
}

function drawSurface(uc, layer, surface, rect) {
  const ctx = layer.canvas.getContext("2d");
  ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  ctx.drawImage(surface, rect.x - uc.origin.x, rect.y - uc.origin.y, rect.width, rect.height);
  layer.hiresCanvas = surface;
  layer.hiresRect = { ...rect };
}

// The visible pixels of one mannequin cut from the committed layer: the fallback when the
// studio cannot render a solo pass.
function maskedSurface(uc, layer, characterId) {
  const mask = getPoseCharacterMask(layer, characterId, { createCanvas: (width, height) => uc._createCanvas(width, height) });
  const source = layer.hiresCanvas;
  if (!mask || !source) return null;
  const out = uc._createCanvas(mask.width, mask.height);
  const ctx = out.getContext("2d");
  ctx.drawImage(source, 0, 0, out.width, out.height);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask.canvas, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  return out;
}

function refusePanorama(uc, action) {
  if (!uc.panorama) return false;
  uc.setStatus(`${action} is not available in panorama documents yet.`, true);
  return true;
}

export async function splitPoseCharacters(uc, layer, createEditor) {
  if (layer?.type !== "pose" || !layer.pose) return null;
  if (layer.locked) { uc.setStatus("Unlock the pose layer to split it.", true); return null; }
  const characters = poseStudioCharacters(layer.pose);
  if (characters.length < 2) { uc.setStatus("Split characters needs a pose layer with two or more characters.", true); return null; }
  if (refusePanorama(uc, "Split characters")) return null;
  if (uc.transformDraft) { uc.setStatus("Apply or cancel the active transform first", true); return null; }
  if (uc.tool === "pose") uc.finishPoseEdit(true);
  const rect = { ...layer.pose.rect };
  const scale = Math.min(1, 2048 / Math.max(rect.width, rect.height));
  const size = { width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) };
  const solos = new Map();
  try {
    const editor = (uc.poseEditor ||= createEditor?.());
    if (editor) {
      await editor.activate(layer, { show: false });
      await editor.flush();
      if (editor.layer === layer) for (const character of characters) solos.set(character.id, editor.captureSoloPass(size, character.id));
      if (editor.layer === layer) editor.release();
    }
  } catch (error) {
    console.warn("[VNCCS UniCanvas] Solo pose capture failed; splitting the visible pixels", error);
  }
  if (!uc.layers.includes(layer) || layer.type !== "pose") return null;
  const activeBefore = uc.activeLayerId;
  const before = captureGroupStructure(uc.layers);
  const created = characters.map((character) => {
    const created = {
      id: newId(),
      name: `${layer.name} - ${character.name}`,
      type: "pose",
      pose: splitPoseState(layer, character.id),
      visible: true,
      locked: false,
      opacity: layer.opacity,
      blendMode: layer.blendMode || "source-over",
      groupId: layer.groupId || null,
      meta: createLayerMeta("split", { derivedFrom: layer.id }),
      canvas: uc._createCanvas(),
    };
    const surface = solos.get(character.id) || maskedSurface(uc, layer, character.id);
    if (surface) drawSurface(uc, created, surface, rect);
    uc.invalidateLayerCaches(created);
    return created;
  });
  uc.layers.splice(Math.max(0, uc.layers.indexOf(layer)), 0, ...created);
  layer.visible = false;
  uc.activeLayerId = created[0].id;
  uc.selectedLayerIds = [created[0].id];
  uc.normalizeLayerOrder();
  uc.pushHistoryEntry({ kind: "historyGroup", entries: [
    ...created.map((item) => ({ kind: "addLayer", layer: item, previousActiveLayerId: activeBefore })),
    { kind: "layerProps", layerId: layer.id, before: { visible: true }, after: { visible: false } },
    { kind: "groupStructure", before, after: captureGroupStructure(uc.layers), activeBefore, activeAfter: uc.activeLayerId },
  ] });
  created.forEach((item) => uc.markLayerPixelsChanged?.(item));
  finish(uc);
  uc.setStatus(`Split ${layer.name} into ${created.length} pose layers; the original is hidden below.`);
  return created;
}

export function mergePoseLayers(uc, ids = uc.selectedLayerIds, createEditor = null) {
  const wanted = new Set(ids || []);
  const layers = uc.layers.filter((layer) => wanted.has(layer.id));
  const issue = mergePoseIssue(layers);
  if (issue) { uc.setStatus(issue, true); return null; }
  if (refusePanorama(uc, "Merge pose layers")) return null;
  if (uc.transformDraft) { uc.setStatus("Apply or cancel the active transform first", true); return null; }
  if (uc.tool === "pose") uc.finishPoseEdit(true);
  uc.poseEditor?.commit?.();
  if (layers.includes(uc.poseEditor?.layer)) uc.poseEditor.release();
  const activeBefore = uc.activeLayerId;
  const before = captureGroupStructure(uc.layers);
  const [top] = layers;
  const merged = {
    id: newId(),
    name: `${top.name} (merged)`,
    type: "pose",
    pose: mergePoseState(layers),
    visible: true,
    locked: false,
    opacity: top.opacity,
    blendMode: top.blendMode || "source-over",
    groupId: top.groupId || null,
    meta: createLayerMeta("merge", { derivedFrom: top.id }),
    canvas: uc._createCanvas(),
  };
  // Until the editor re-renders the merged scene, the layer shows the sources stacked.
  const ctx = merged.canvas.getContext("2d");
  for (const layer of [...layers].reverse()) {
    if (!layer.visible) continue;
    ctx.save(); ctx.globalAlpha = layer.opacity ?? 1;
    ctx.drawImage(layer.canvas, 0, 0);
    ctx.restore();
  }
  uc.invalidateLayerCaches(merged);
  const removals = layers.map((layer) => ({ kind: "removeLayer", layer, index: uc.layers.indexOf(layer), groupId: layer.groupId || null, previousActiveLayerId: activeBefore }));
  uc.layers.splice(Math.max(0, uc.layers.indexOf(top)), 0, merged);
  uc.layers = uc.layers.filter((layer) => !wanted.has(layer.id));
  uc.activeLayerId = merged.id;
  uc.selectedLayerIds = [merged.id];
  uc.normalizeLayerOrder();
  uc.pushHistoryEntry({ kind: "historyGroup", entries: [
    ...removals,
    { kind: "addLayer", layer: merged, previousActiveLayerId: activeBefore },
    { kind: "groupStructure", before, after: captureGroupStructure(uc.layers), activeBefore, activeAfter: merged.id },
  ] });
  uc.markLayerPixelsChanged?.(merged);
  finish(uc);
  uc.setStatus(`Merged ${layers.length} pose layers into ${merged.name}.`);
  // Render the merged scene in the background (same path as generation's hidden activation).
  const editor = uc.poseEditor || createEditor?.();
  if (editor) {
    uc.poseEditor = editor;
    void editor.activate(merged, { show: false }).then(() => editor.commit()).catch(() => {});
  }
  return merged;
}

function finish(uc) {
  uc.syncPoseToolToActiveLayer?.();
  uc.renderLayerList();
  uc.requestRender();
  uc.syncLightStateToWidget?.();
  uc.syncToNode();
}

/** Pose layers of the current multi-selection, top to bottom. */
export function selectedPoseLayers(uc) {
  const ids = new Set(uc.selectedLayerIds || []);
  return uc.layers.filter((layer) => ids.has(layer.id) && layer.type === "pose");
}

export function installUniCanvasPoseScene(uc, { createEditor } = {}) {
  if (!uc || uc._vnccsPoseSceneInstalled) return uc;
  uc._vnccsPoseSceneInstalled = true;
  uc.splitPoseCharacters = (layer = uc.activeLayer) => splitPoseCharacters(uc, layer, createEditor);
  uc.mergePoseLayers = (ids = uc.selectedLayerIds) => mergePoseLayers(uc, ids, createEditor);
  return uc;
}
