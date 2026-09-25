/**
 * VNCCS shared animation core: the value-type independent keyframe math used by the Pose
 * Studio dope sheet (vnccs_pose_animation.mjs) and the UniCanvas scene timeline
 * (vnccs_unicanvas_timeline_core.mjs).
 *
 * An animation state here is anything shaped `{ frameCount, currentFrame, tracks: { [name]:
 * { keys: [{ id, frame, value, interpolation }] } } }` with keys sorted by frame. Values are
 * opaque: interpolating them is the caller's job (see findKeySegment).
 */

export const INTERPOLATION_PRESETS = Object.freeze([
    { value: "hold", label: "Hold / Step" },
    { value: "linear", label: "Linear" },
    { value: "easeIn", label: "Ease In" },
    { value: "easeOut", label: "Ease Out" },
    { value: "easeInOut", label: "Easy Ease" },
    { value: "smooth", label: "Smooth" },
]);

export const INTERPOLATION_NAMES = new Set(INTERPOLATION_PRESETS.map(item => item.value));

let fallbackKeyId = 1;

export const finiteNumber = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const cloneJSON = (value, fallback = {}) => {
    try {
        return JSON.parse(JSON.stringify(value ?? fallback));
    } catch (_) {
        return JSON.parse(JSON.stringify(fallback));
    }
};

export const createKeyId = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `key_${Date.now().toString(36)}_${(fallbackKeyId++).toString(36)}`;
};

export function isInterpolationName(value) {
    return INTERPOLATION_NAMES.has(value);
}

export function applyInterpolation(tValue, interpolation = "linear") {
    const t = clamp(finiteNumber(tValue), 0, 1);
    switch (interpolation) {
        case "hold": return 0;
        case "easeIn": return t * t * t;
        case "easeOut": return 1 - Math.pow(1 - t, 3);
        case "easeInOut": return t < 0.5
            ? 4 * t * t * t
            : 1 - Math.pow(-2 * t + 2, 3) / 2;
        case "smooth": return t * t * t * (t * (t * 6 - 15) + 10);
        default: return t;
    }
}

/**
 * The keys around `frame` in a sorted key list: `{ left, right, t }` with the left key's
 * interpolation already applied to t. Before the first / after the last key both sides are
 * that key and t is 0. Returns null for an empty list.
 */
export function findKeySegment(keys, frame) {
    if (!keys?.length) return null;
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (frame <= first.frame) return { left: first, right: first, t: 0 };
    if (frame >= last.frame) return { left: last, right: last, t: 0 };
    let low = 1;
    let high = keys.length - 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (keys[middle].frame < frame) low = middle + 1;
        else high = middle;
    }
    const left = keys[low - 1];
    const right = keys[low];
    const span = Math.max(1, right.frame - left.frame);
    return { left, right, t: applyInterpolation((frame - left.frame) / span, left.interpolation) };
}

/** Whole frames elapsed after `elapsedMilliseconds` at `fps` (clamped to [minFps, maxFps]). */
export function framesForElapsed(elapsedMilliseconds, fpsValue, { fallbackFps = 12, minFps = 0.001, maxFps = 120 } = {}) {
    const fps = clamp(finiteNumber(fpsValue, fallbackFps), minFps, maxFps);
    return Math.floor((Math.max(0, finiteNumber(elapsedMilliseconds)) / 1000) * fps);
}

/** A ruler tick step giving roughly 12 labelled ticks. */
export function niceTickStep(frameCount) {
    const target = Math.max(1, frameCount / 12);
    const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
    const residual = target / magnitude;
    const nice = residual >= 5 ? 5 : residual >= 2 ? 2 : 1;
    return Math.max(1, nice * magnitude);
}

/** `[{ trackName, keyId | frame }]` -> `[{ trackName, key }]`, unknown and duplicate keys dropped. */
export function resolveKeyframeSelections(state, selections = []) {
    const resolved = [];
    const seen = new Set();
    const lookups = new Map();
    for (const selection of selections || []) {
        const trackName = selection?.trackName;
        const track = state?.tracks?.[trackName];
        if (!track) continue;
        if (!lookups.has(trackName)) {
            lookups.set(trackName, {
                byId: new Map(track.keys.map(key => [key.id, key])),
                byFrame: new Map(track.keys.map(key => [key.frame, key])),
            });
        }
        const lookup = lookups.get(trackName);
        const key = selection.keyId
            ? lookup.byId.get(selection.keyId)
            : lookup.byFrame.get(Math.round(finiteNumber(selection?.frame)));
        if (!key || seen.has(key.id)) continue;
        seen.add(key.id);
        resolved.push({ trackName, key });
    }
    return resolved;
}

export function findKeyframesInRange(state, trackNames, range = {}) {
    const names = Array.isArray(trackNames) ? trackNames : [];
    const firstTrack = clamp(Math.floor(finiteNumber(range.startTrack)), 0, Math.max(0, names.length - 1));
    const lastTrack = clamp(Math.floor(finiteNumber(range.endTrack)), 0, Math.max(0, names.length - 1));
    const startTrack = Math.min(firstTrack, lastTrack);
    const endTrack = Math.max(firstTrack, lastTrack);
    const startFrame = Math.min(finiteNumber(range.startFrame), finiteNumber(range.endFrame));
    const endFrame = Math.max(finiteNumber(range.startFrame), finiteNumber(range.endFrame));
    const selections = [];
    for (let index = startTrack; index <= endTrack; index++) {
        const trackName = names[index];
        for (const key of state?.tracks?.[trackName]?.keys || []) {
            if (key.frame >= startFrame && key.frame <= endFrame) {
                selections.push({ trackName, keyId: key.id, frame: key.frame });
            }
        }
    }
    return selections;
}

/** Moves the selected keys by a frame delta (clamped to the timeline); a moved key replaces a key at its destination. */
export function moveKeyframeSelection(state, selections, deltaFrameValue) {
    const resolved = resolveKeyframeSelections(state, selections);
    if (!resolved.length) return { delta: 0, selections: [] };
    const requestedDelta = Math.round(finiteNumber(deltaFrameValue));
    const minimumFrame = Math.min(...resolved.map(item => item.key.frame));
    const maximumFrame = Math.max(...resolved.map(item => item.key.frame));
    const delta = clamp(requestedDelta, -minimumFrame, state.frameCount - 1 - maximumFrame);
    if (!delta) {
        return {
            delta: 0,
            selections: resolved.map(({ trackName, key }) => ({ trackName, keyId: key.id, frame: key.frame })),
        };
    }

    const byTrack = new Map();
    for (const item of resolved) {
        if (!byTrack.has(item.trackName)) byTrack.set(item.trackName, []);
        byTrack.get(item.trackName).push(item.key);
    }
    for (const [trackName, movingKeys] of byTrack) {
        const track = state.tracks[trackName];
        const movingIds = new Set(movingKeys.map(key => key.id));
        const destinationFrames = new Set(movingKeys.map(key => key.frame + delta));
        const stationary = track.keys.filter(key => !movingIds.has(key.id) && !destinationFrames.has(key.frame));
        for (const key of movingKeys) key.frame += delta;
        track.keys = [...stationary, ...movingKeys].sort((a, b) => a.frame - b.frame);
    }
    return {
        delta,
        selections: resolved.map(({ trackName, key }) => ({ trackName, keyId: key.id, frame: key.frame })),
    };
}

/** Scales every key (and the playhead) to a new frame count; keys landing on one frame merge. */
export function retimeFrameCount(state, nextFrameCountValue, { minFrames = 2, maxFrames = 600 } = {}) {
    const nextFrameCount = clamp(Math.round(finiteNumber(nextFrameCountValue, state.frameCount)), minFrames, maxFrames);
    const previousFrameCount = state.frameCount;
    if (previousFrameCount === nextFrameCount) return state;
    const previousLast = Math.max(1, previousFrameCount - 1);
    const nextLast = nextFrameCount - 1;
    for (const track of Object.values(state.tracks || {})) {
        const byFrame = new Map();
        for (const key of track.keys || []) {
            key.frame = clamp(Math.round((key.frame / previousLast) * nextLast), 0, nextLast);
            byFrame.set(key.frame, key);
        }
        track.keys = Array.from(byFrame.values()).sort((a, b) => a.frame - b.frame);
    }
    state.frameCount = nextFrameCount;
    state.currentFrame = clamp(Math.round((state.currentFrame / previousLast) * nextLast), 0, nextLast);
    return state;
}

/**
 * Changes the timeline boundary without retiming its contents. Existing key frame numbers
 * and the playhead stay fixed; shrinking stops at the last key.
 */
export function resizeFrameCount(state, nextFrameCountValue, { minFrames = 2, maxFrames = 600 } = {}) {
    if (!state) return state;
    const requestedFrameCount = clamp(
        Math.round(finiteNumber(nextFrameCountValue, state.frameCount)),
        minFrames,
        maxFrames,
    );
    let lastKeyFrame = -1;
    for (const track of Object.values(state.tracks || {})) {
        for (const key of track.keys || []) {
            lastKeyFrame = Math.max(lastKeyFrame, Math.round(finiteNumber(key.frame, -1)));
        }
    }
    state.frameCount = clamp(Math.max(requestedFrameCount, lastKeyFrame + 1), minFrames, maxFrames);
    state.currentFrame = clamp(Math.round(finiteNumber(state.currentFrame)), 0, state.frameCount - 1);
    return state;
}

/** The previous / next key frame across the given tracks, or null. */
export function adjacentKeyFrame(state, trackNames, frame, direction) {
    let best = null;
    for (const name of trackNames || Object.keys(state?.tracks || {})) {
        for (const key of state?.tracks?.[name]?.keys || []) {
            if (direction < 0 ? key.frame < frame && (best === null || key.frame > best) : key.frame > frame && (best === null || key.frame < best)) {
                best = key.frame;
            }
        }
    }
    return best;
}
