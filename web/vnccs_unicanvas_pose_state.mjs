/** Serializable pose layer contracts shared by the canvas and editor host. */
// Articulated mannequin mid-pose: filled head and joints read as a posable figure at tool size.
export const POSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="fill" cx="12" cy="3.7" r="2.5"/><rect class="fill" x="9.7" y="7" width="4.6" height="7.4" rx="2.3"/><path stroke-width="2.4" d="M10.4 8.4 7 6.4 5.8 2.9M13.6 8.4l3.2 2.9 2.9 1.4M10.8 13.8l-1.6 4-1 3.6M13.2 13.8l1.7 3.9 1.3 3.5"/><circle class="fill" cx="7" cy="6.4" r="1.4"/><circle class="fill" cx="16.8" cy="11.3" r="1.4"/><circle class="fill" cx="9.2" cy="17.8" r="1.4"/><circle class="fill" cx="14.9" cy="17.7" r="1.4"/></svg>';
// A panorama layer is an image layer that holds the equirectangular source (vnccs_unicanvas_panorama.mjs).
export const isImageLayer = layer => layer?.type === "raster" || layer?.type === "pose" || layer?.type === "panorama";
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

export function serializePose(pose, includeData = true) {
    if (!pose) return undefined;
    const result = clone(pose);
    if (!includeData && result.character?.source === "upload") delete result.character.dataURL;
    // Per-character references follow the same rule: uploaded pixels live in the state cache only.
    for (const ref of Object.values(result.characterRefs || {})) {
        if (!includeData && ref?.source === "upload") delete ref.dataURL;
    }
    if (!includeData && result.studio?.background_url?.startsWith("data:")) {
        delete result.studio.background_url;
        result.backgroundCached = true;
    }
    return result;
}

export function poseLayerBelow(layers, layer) {
    const index = layers.indexOf(layer);
    return index < 0 ? [] : layers.slice(index + 1).filter(item => item.visible && isImageLayer(item));
}

export function poseGenerationLayer(host) {
    const eligible = layer => layer?.type === "pose" && layer.visible
        && layer.pose?.rect && intersects(layer.pose.rect, host.bbox);
    return eligible(host.activeLayer) ? host.activeLayer : host.layers.find(eligible) || null;
}

// Mannequins of a pose layer in slot order. Layers whose studio never ran (or older states
// without the v3 scene schema) have exactly one: Pose Studio's default "character-1".
export function poseStudioCharacters(pose) {
    const list = Array.isArray(pose?.studio?.characters) ? pose.studio.characters : [];
    const characters = list.filter(item => item && item.id != null).map((item, index) => ({
        id: String(item.id), slot: Number.isFinite(Number(item.slot)) ? Number(item.slot) : index,
        name: String(item.name || `Character ${index + 1}`), color: typeof item.color === "string" ? item.color : "#ffffff",
    })).sort((a, b) => a.slot - b.slot);
    return characters.length ? characters : [{ id: "character-1", slot: 0, name: "Main Character", color: "#ffffff" }];
}

const withoutPrompt = ref => {
    if (!ref?.source) return null;
    const { prompt: _prompt, ...rest } = ref;
    return rest;
};

/** The reference bound to one mannequin; the first (lowest slot) falls back to `pose.character`. */
export function poseCharacterRef(layer, characterId) {
    const pose = layer?.pose;
    if (!pose) return null;
    const id = String(characterId ?? poseStudioCharacters(pose)[0].id);
    const own = pose.characterRefs?.[id];
    if (own?.source) return withoutPrompt(own);
    return id === poseStudioCharacters(pose)[0].id ? pose.character || null : null;
}

export function poseCharacterPrompt(layer, characterId) {
    return String(layer?.pose?.characterRefs?.[String(characterId)]?.prompt || "");
}

// Writing the first mannequin's reference also writes `pose.character`, so the single-shot
// generation path, workflows and caches keep reading the field they always read. The map is
// only created once a second mannequin or an identity prompt needs it.
export function setPoseCharacterRef(pose, characterId, ref) {
    if (!pose) return;
    const id = String(characterId);
    const first = poseStudioCharacters(pose)[0].id === id;
    const value = withoutPrompt(ref);
    if (first) pose.character = value;
    const prompt = pose.characterRefs?.[id]?.prompt;
    if (!pose.characterRefs && first && !prompt) return;
    pose.characterRefs ||= {};
    if (value || prompt) pose.characterRefs[id] = { ...(value || {}), ...(prompt ? { prompt } : {}) };
    else delete pose.characterRefs[id];
}

export function setPoseCharacterPrompt(pose, characterId, prompt) {
    if (!pose) return;
    const id = String(characterId), text = String(prompt || "").trim();
    const ref = pose.characterRefs?.[id]?.source ? withoutPrompt(pose.characterRefs[id])
        : poseStudioCharacters(pose)[0].id === id ? withoutPrompt(pose.character) : null;
    if (!text && !pose.characterRefs?.[id]) return;
    pose.characterRefs ||= {};
    if (ref || text) pose.characterRefs[id] = { ...(ref || {}), ...(text ? { prompt: text } : {}) };
    else delete pose.characterRefs[id];
}

function referenceIssue(host, layer, character) {
    if (character?.source === "upload") return character.dataURL ? null : "The character image is missing. Upload it again.";
    if (character?.source === "layer") {
        return host.layers.some(item => item.id === character.layerId && item !== layer && isImageLayer(item))
            ? null : "The character layer no longer exists. Choose another character image.";
    }
    return "Choose a character image from a layer or upload one, then press Generate.";
}

/** One issue per mannequin without a valid reference, in slot order. */
export function poseCharacterIssues(host, layer) {
    const issues = [];
    for (const character of poseStudioCharacters(layer?.pose)) {
        const issue = referenceIssue(host, layer, poseCharacterRef(layer, character.id));
        if (issue) issues.push({ characterId: character.id, name: character.name, issue });
    }
    return issues;
}

export function poseCharacterIssue(host, layer) {
    const issues = poseCharacterIssues(host, layer);
    if (!issues.length) return null;
    return poseStudioCharacters(layer?.pose).length > 1 ? `${issues[0].name}: ${issues[0].issue}` : issues[0].issue;
}

/**
 * Keep `characterRefs` in step with the studio's mannequins after a state change: removed ids
 * drop their entry, and ids a scene asset replaced are remapped by slot. Returns true when the
 * references changed.
 */
export function reconcilePoseCharacterRefs(pose, previous, next) {
    if (!pose || !previous?.length || !next?.length) return false;
    const sorted = list => [...list].sort((a, b) => a.slot - b.slot);
    const prev = sorted(previous), after = sorted(next);
    const sameIds = prev.length === after.length && prev.every((item, index) => item.id === after[index].id);
    if (sameIds) return false;
    const refs = { ...(pose.characterRefs || {}) };
    const oldFirst = prev[0].id;
    if (pose.character && !refs[oldFirst]?.source) refs[oldFirst] = { ...pose.character, ...(refs[oldFirst]?.prompt ? { prompt: refs[oldFirst].prompt } : {}) };
    const nextIds = new Set(after.map(item => item.id)), prevIds = new Set(prev.map(item => item.id));
    const result = {};
    for (const [id, ref] of Object.entries(refs)) if (nextIds.has(id)) result[id] = ref;
    for (const old of prev) {
        if (nextIds.has(old.id) || !refs[old.id]) continue;
        const replacement = after.find(item => item.slot === old.slot && !prevIds.has(item.id));
        if (replacement && !result[replacement.id]) result[replacement.id] = refs[old.id];
    }
    const before = JSON.stringify([pose.character ?? null, pose.characterRefs ?? null]);
    pose.character = withoutPrompt(result[after[0].id]);
    const keepMap = after.length > 1 || Object.values(result).some(ref => ref?.prompt);
    if (keepMap) pose.characterRefs = result;
    else delete pose.characterRefs;
    return before !== JSON.stringify([pose.character ?? null, pose.characterRefs ?? null]);
}

/* Per-character visible-pixel masks. The ID pass renders every mannequin unlit in one of these
 * colors: pure primaries (and white) survive sRGB output conversion unchanged, and they stay far
 * apart even where antialiasing blends two neighbours, so each pixel maps back to one character. */
export const POSE_ID_COLORS = Object.freeze([[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]]);

function hashString(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}

/** Changes whenever the mannequins, the camera or the layer rect change. */
export function poseIdKey(pose) {
    return hashString(JSON.stringify([pose?.studio?.characters ?? null, pose?.viewport ?? null, pose?.rect ?? null]));
}

/** Label per pixel: palette index of the nearest ID color, or -1 where alpha < minAlpha. */
export function classifyPoseIdPixels(data, count = POSE_ID_COLORS.length, minAlpha = 128) {
    const labels = new Int8Array(data.length / 4).fill(-1);
    const palette = POSE_ID_COLORS.slice(0, count);
    for (let pixel = 0, offset = 0; offset < data.length; pixel++, offset += 4) {
        if (data[offset + 3] < minAlpha) continue;
        let best = -1, bestDistance = Infinity;
        for (let index = 0; index < palette.length; index++) {
            const [r, g, b] = palette[index];
            const distance = (data[offset] - r) ** 2 + (data[offset + 1] - g) ** 2 + (data[offset + 2] - b) ** 2;
            if (distance < bestDistance) { bestDistance = distance; best = index; }
        }
        labels[pixel] = best;
    }
    return labels;
}

/** Binary alpha (0 / 255) for one label, optionally dilated by a square radius in pixels. */
export function poseIdMaskAlpha(labels, width, height, index, dilate = 0) {
    let alpha = new Uint8ClampedArray(width * height);
    for (let pixel = 0; pixel < alpha.length; pixel++) if (labels[pixel] === index) alpha[pixel] = 255;
    const radius = Math.max(0, Math.round(dilate));
    if (!radius) return alpha;
    // Separable max filter: rows, then columns.
    const pass = (source, horizontal) => {
        const out = new Uint8ClampedArray(source.length);
        const outer = horizontal ? height : width, inner = horizontal ? width : height;
        for (let a = 0; a < outer; a++) {
            for (let b = 0; b < inner; b++) {
                const at = horizontal ? a * width + b : b * width + a;
                if (!source[at]) continue;
                const from = Math.max(0, b - radius), to = Math.min(inner - 1, b + radius);
                for (let c = from; c <= to; c++) out[horizontal ? a * width + c : c * width + a] = 255;
            }
        }
        return out;
    };
    alpha = pass(pass(alpha, true), false);
    return alpha;
}

function poseIdLabels(layer) {
    const canvas = layer?.poseIdCanvas;
    if (!canvas) return null;
    if (layer._poseIdLabels?.canvas === canvas) return layer._poseIdLabels.labels;
    const data = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
    const labels = classifyPoseIdPixels(data, layer.poseIdMeta?.ids?.length || POSE_ID_COLORS.length);
    layer._poseIdLabels = { canvas, labels };
    return labels;
}

/** The ID canvas of a layer when it matches the current mannequins and camera, else null. */
export function currentPoseId(layer) {
    const meta = layer?.poseIdMeta;
    if (!layer?.poseIdCanvas || !meta || meta.key !== poseIdKey(layer.pose)) return null;
    return { canvas: layer.poseIdCanvas, meta };
}

/**
 * The visible pixels of one mannequin as a binary alpha mask covering `rect` (the pose layer's
 * world rect; the canvas is the ID pass resolution). Null when the ID canvas is missing or stale:
 * callers `await editor.flush()` first, whose commit regenerates it. `dilate` is in world pixels.
 */
export function getPoseCharacterMask(layer, characterId, { dilate = 0, createCanvas = null } = {}) {
    const current = currentPoseId(layer);
    if (!current) return null;
    const { canvas, meta } = current;
    const index = meta.ids.indexOf(String(characterId));
    if (index < 0) return null;
    const labels = poseIdLabels(layer);
    const rect = { ...meta.rect };
    const alpha = poseIdMaskAlpha(labels, canvas.width, canvas.height, index, dilate * canvas.width / Math.max(1, rect.width));
    const out = createCanvas ? createCanvas(canvas.width, canvas.height)
        : Object.assign(globalThis.document.createElement("canvas"), { width: canvas.width, height: canvas.height });
    const ctx = out.getContext("2d");
    const image = ctx.createImageData(canvas.width, canvas.height);
    for (let pixel = 0; pixel < alpha.length; pixel++) {
        const offset = pixel * 4;
        image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = 255;
        image.data[offset + 3] = alpha[pixel];
    }
    ctx.putImageData(image, 0, 0);
    return { canvas: out, rect, alpha, width: canvas.width, height: canvas.height };
}

/** State-cache form of the ID pass (a PNG of the rect-sized ID canvas plus its key). */
export function serializePoseId(layer) {
    const meta = layer?.poseIdMeta, canvas = layer?.poseIdCanvas;
    if (!canvas || !meta?.key || !Array.isArray(meta.ids)) return null;
    return { key: meta.key, ids: [...meta.ids], rect: { ...meta.rect }, dataURL: canvas.toDataURL("image/png") };
}

export async function restorePoseId(layer, stored, loadImage) {
    if (!stored?.dataURL || !stored.key || !Array.isArray(stored.ids) || !stored.rect) return;
    try {
        const image = await loadImage(stored.dataURL);
        const canvas = globalThis.document.createElement("canvas");
        canvas.width = Math.max(1, image.naturalWidth || image.width);
        canvas.height = Math.max(1, image.naturalHeight || image.height);
        canvas.getContext("2d").drawImage(image, 0, 0);
        layer.poseIdCanvas = canvas;
        layer.poseIdMeta = { key: String(stored.key), ids: stored.ids.map(String), rect: { ...stored.rect } };
    } catch (_) { /* A missing ID pass is regenerated by the next commit. */ }
}

/** Mannequin ids ordered left to right by the centroid of their visible pixels. */
export function poseCharacterScreenOrder(layer) {
    const characters = poseStudioCharacters(layer?.pose);
    const current = currentPoseId(layer);
    if (!current) return characters.map(item => item.id);
    const labels = poseIdLabels(layer), width = current.canvas.width;
    const sums = current.meta.ids.map(() => ({ x: 0, count: 0 }));
    for (let pixel = 0; pixel < labels.length; pixel++) {
        const label = labels[pixel];
        if (label < 0 || !sums[label]) continue;
        sums[label].x += pixel % width; sums[label].count++;
    }
    const centroid = id => {
        const index = current.meta.ids.indexOf(id);
        return sums[index]?.count ? sums[index].x / sums[index].count : Infinity;
    };
    return characters.map((item, order) => ({ id: item.id, x: centroid(item.id), order }))
        .sort((a, b) => a.x - b.x || a.order - b.order).map(item => item.id);
}

const POSITION_WORDS = {
    2: ["on the left", "on the right"],
    3: ["on the left", "in the middle", "on the right"],
    4: ["on the far left", "second from the left", "second from the right", "on the far right"],
};
const ORDINALS = ["first", "second", "third", "fourth"];

/** "The character on the left is the first person in image2, ..." for the image2 columns. */
export function posePromptMapping(entries, total = entries.length) {
    const words = POSITION_WORDS[total];
    if (!words || !entries.length) return "";
    return entries.map((entry, index) => {
        const identity = entry.prompt ? ` (${entry.prompt})` : "";
        return `the character ${words[entry.position ?? index]}${identity} is the ${ORDINALS[index]} person in image2`;
    }).join(", ").replace(/^t/, "T") + ".";
}

/** Bound references in left-to-right screen order, when a layer has 2+ mannequins and 2+ references. */
export function poseMultiReferences(layer) {
    const characters = poseStudioCharacters(layer?.pose);
    if (characters.length < 2) return null;
    const entries = poseCharacterScreenOrder(layer).map((id, position) => ({
        id, position, ref: poseCharacterRef(layer, id), prompt: poseCharacterPrompt(layer, id),
    })).filter(entry => entry.ref);
    return entries.length >= 2 ? { entries, total: characters.length } : null;
}
function intersects(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Compose image2 from the lower stack and the explicitly selected character. `rect` is the world
 * rect image2 covers (the bbox by default, a bake's working rect otherwise); with `characterId`
 * only that mannequin's reference is placed (a character bake).
 */
export async function composePoseReference(host, layer, size, { rect = host.bbox, characterId = null } = {}) {
    const out = host._createCanvas(size.width, size.height);
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    const lower = poseLayerBelow(host.layers, layer);
    const drawLayer = item => {
        ctx.save();
        ctx.globalAlpha = item.opacity;
        ctx.globalCompositeOperation = item.blendMode || "source-over";
        host.drawRasterLayerToWorldRect(ctx, item, rect, { x: 0, y: 0, width: out.width, height: out.height });
        ctx.restore();
    };
    [...lower].reverse().forEach(drawLayer);
    const fit = (width, height, box) => {
        const scale = Math.min(box.width / width, box.height / height);
        return { x: box.x + (box.width - width * scale) / 2, y: box.y + (box.height - height * scale) / 2, width: width * scale, height: height * scale };
    };
    const drawReference = async (character, box) => {
        if (character?.source === "layer") {
            const selected = host.layers.find(item => item.id === character.layerId && item !== layer && isImageLayer(item));
            if (!selected) throw new Error("The character layer no longer exists. Select another character image.");
            // An already visible lower layer is part of image2 exactly once.
            const bounds = host.getLayerWorldBounds(selected);
            if (!lower.includes(selected) || (bounds && !intersects(bounds, rect))) {
                if (!bounds) throw new Error("The character layer is empty. Select another character image.");
                ctx.save(); ctx.globalAlpha = selected.opacity;
                host.drawRasterLayerToWorldRect(ctx, selected, bounds, fit(bounds.width, bounds.height, box));
                ctx.restore();
            }
        } else if (character?.source === "upload") {
            if (!character.dataURL) throw new Error("The character image is missing. Load it again.");
            const image = await host.loadImage(character.dataURL);
            const target = fit(image.width, image.height, box);
            ctx.drawImage(image, target.x, target.y, target.width, target.height);
        }
    };
    // Several mannequins with their own references: one column each, left to right in the order
    // the mannequins appear in image1 (the prompt states the mapping, see posePromptMapping).
    if (characterId != null) {
        await drawReference(poseCharacterRef(layer, characterId), { x: 0, y: 0, width: out.width, height: out.height });
        return out;
    }
    const multi = poseMultiReferences(layer);
    if (multi) {
        const columnWidth = out.width / multi.entries.length;
        for (const [index, entry] of multi.entries.entries()) {
            await drawReference(entry.ref, { x: index * columnWidth, y: 0, width: columnWidth, height: out.height });
        }
    } else await drawReference(layer.pose?.character, { x: 0, y: 0, width: out.width, height: out.height });
    return out;
}


export function mergePoseCache(live, cached) {
    if (!live) return clone(cached);
    const result = clone(live);
    if (result.backgroundCached && cached?.studio?.background_url) {
        result.studio = { ...result.studio, background_url: cached.studio.background_url };
        delete result.backgroundCached;
    }
    if (result.character?.source === "upload" && !result.character.dataURL
        && cached?.character?.source === "upload" && cached.character.name === result.character.name) {
        result.character.dataURL = cached.character.dataURL;
    }
    for (const [id, ref] of Object.entries(result.characterRefs || {})) {
        const stored = cached?.characterRefs?.[id];
        if (ref?.source === "upload" && !ref.dataURL && stored?.source === "upload" && stored.name === ref.name) ref.dataURL = stored.dataURL;
    }
    return result;
}

export function poseAtPanoramaCamera(layer, panorama) {
    const anchor = layer?.pose?.panoramaCamera;
    return !panorama || !anchor || ["yaw", "pitch", "roll", "fov"].every(key =>
        Math.abs(Number(anchor[key] ?? (key === "fov" ? 90 : 0)) - Number(panorama.settings[key] ?? (key === "fov" ? 90 : 0))) < 1e-6);
}
