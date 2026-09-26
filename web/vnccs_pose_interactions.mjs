/**
 * Interaction presets: multi-character library scenes that keep the loaded
 * mannequins' bodies and adapt their placement to them.
 *
 * Pure helpers (no DOM, no Three.js) so Node tests cover them directly.
 */

const finite = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

const hasMesh = mesh => !!mesh && typeof mesh === "object" && !Array.isArray(mesh) && Object.keys(mesh).length > 0;

/** Standing height of a morphed mannequin: the vertical extent of its rest vertices. */
export function meshVerticalExtent(vertices) {
    if (!vertices || vertices.length < 3) return 0;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let index = 1; index < vertices.length; index += 3) {
        const y = vertices[index];
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    return Number.isFinite(maxY - minY) ? maxY - minY : 0;
}

/**
 * Pair a multi-character pose asset with the mannequins already in the scene, so loading it
 * poses those mannequins instead of replacing them: both lists are matched in slot order, asset
 * characters beyond the scene get a new mannequin (while the scene has room for `max`), and
 * scene characters beyond the asset are left as they are.
 *
 * Returns `{ source, sourceIndex, target }` per asset character that gets a mannequin, where
 * `sourceIndex` is its index in `asset.characters` (the index interaction contacts use) and
 * `target` the scene character it poses, or null for a new mannequin.
 */
export function matchScenePoseCharacters(characters = [], assetCharacters = [], max = Infinity) {
    const bySlot = list => (Array.isArray(list) ? list : [])
        .map((item, index) => ({ item, index, slot: finite(item?.slot ?? item?.slot_index, index) }))
        .filter(entry => entry.item && typeof entry.item === "object")
        .sort((left, right) => left.slot - right.slot || left.index - right.index);
    const scene = bySlot(characters).map(entry => entry.item);
    const limit = Number.isFinite(Number(max)) ? Math.floor(Number(max)) : Infinity;
    const room = Math.max(0, limit - scene.length);
    const pairs = [];
    let added = 0;
    bySlot(assetCharacters).forEach((entry, order) => {
        if (order < scene.length) pairs.push({ source: entry.item, sourceIndex: entry.index, target: scene[order] });
        else if (added < room) {
            pairs.push({ source: entry.item, sourceIndex: entry.index, target: null });
            added += 1;
        }
    });
    return pairs;
}

/** The pose an asset character holds on `tab` (its first pose otherwise), without camera fields. */
export function scenePoseForCharacter(source, tab = 0) {
    const poses = Array.isArray(source?.poses) ? source.poses : [];
    const pose = poses[Math.max(0, Math.floor(finite(tab, 0)))] || poses[0] || {};
    const copy = JSON.parse(JSON.stringify(pose && typeof pose === "object" ? pose : {}));
    delete copy.camera;
    delete copy.cameraParams;
    delete copy.sam_projection;
    return copy;
}

/** A library response holding a still pose of two or more characters (not a pose set or animation). */
export function isMultiCharacterScenePose(data) {
    const pose = data?.pose;
    if (!pose || typeof pose !== "object") return false;
    if (data.asset_type === "animation" || pose.animation) return false;
    if (pose.type === "pose_set" && Array.isArray(pose.poses)) return false;
    return Array.isArray(pose.characters) && pose.characters.length > 1;
}

/** Mesh params that shape the morphed vertices; the bone-scale sliders only change the rig. */
export function bodyMorphSignature(mesh) {
    const rigOnly = key => key.endsWith("_length") || ["head_size", "arm_size", "hand_size", "foot_size"].includes(key);
    const source = mesh && typeof mesh === "object" && !Array.isArray(mesh) ? mesh : {};
    return JSON.stringify(Object.keys(source).filter(key => !rigOnly(key)).sort().map(key => [key, source[key]]));
}

/** An asset character's placement as a Pose Studio transform (missing fields fall back to 0 / zoom 1). */
export function scenePoseTransform(source) {
    const transform = source?.transform && typeof source.transform === "object" ? source.transform : {};
    const zoom = finite(transform.zoom, 1);
    return { x: finite(transform.x, 0), y: finite(transform.y, 0), z: finite(transform.z, 0), zoom: zoom > 0 ? zoom : 1 };
}

/**
 * What loading a multi-character pose into an existing scene changes: per matched scene
 * character (`target`) and per new mannequin (`target: null`) the pose to hold on the active tab,
 * the placement, and `sourceIndex`, the asset index the interaction data uses for it. Scene
 * characters beyond the asset do not appear, so they stay as they are.
 */
export function planScenePoseApplication(characters, asset, { max = Infinity } = {}) {
    const tab = finite(asset?.activeTab, 0);
    return matchScenePoseCharacters(characters, asset?.characters, max).map(({ source, sourceIndex, target }) => ({
        target,
        sourceIndex,
        pose: scenePoseForCharacter(source, tab),
        transform: scenePoseTransform(source),
    }));
}

/**
 * A scene asset whose characters carry no body keeps the bodies (and the
 * name and color) of the mannequins already in the same slots, so applying a
 * preset to an adult and a child keeps an adult and a child.
 */
export function inheritSlotIdentity(asset, previousCharacters = []) {
    if (!asset || !Array.isArray(asset.characters)) return asset;
    const bySlot = new Map();
    previousCharacters.forEach((character, index) => {
        const slot = Math.floor(finite(character?.slot, index));
        if (!bySlot.has(slot)) bySlot.set(slot, character);
    });
    const characters = asset.characters.map((source, index) => {
        const character = { ...(source || {}) };
        const previous = bySlot.get(Math.floor(finite(character.slot ?? character.slot_index, index)));
        if (!previous) return character;
        if (!hasMesh(character.mesh) && hasMesh(previous.mesh)) character.mesh = JSON.parse(JSON.stringify(previous.mesh));
        if (!character.name && previous.name) character.name = previous.name;
        if (!character.color && previous.color) character.color = previous.color;
        return character;
    });
    return { ...asset, characters };
}

/**
 * Adapt an interaction preset authored at the default proportions to the
 * loaded mannequins: every character's offset from the pair's midpoint (and its
 * height above the ground) is scaled by its height ratio to the reference
 * mannequin the preset was authored with. A carried character follows the
 * ratio of the character that supports it.
 *
 * transforms[i] / heights[i] / slots[i] describe the scene characters;
 * interaction.reference_heights and interaction.supports are indexed by slot.
 */
export function scaleInteractionTransforms(transforms, heights, interaction, slots = null) {
    const references = Array.isArray(interaction?.reference_heights) ? interaction.reference_heights : null;
    const source = (transforms || []).map(transform => ({ ...transform }));
    if (!references || !source.length) return source;
    const slotOf = index => Math.floor(finite(slots?.[index], index));
    const ratioBySlot = new Map();
    source.forEach((_transform, index) => {
        const reference = finite(references[slotOf(index)], 0);
        const height = finite(heights?.[index], 0);
        ratioBySlot.set(slotOf(index), reference > 0 && height > 0 ? height / reference : 1);
    });
    const supports = Array.isArray(interaction?.supports) ? interaction.supports : [];
    const ratioFor = index => {
        const support = supports[slotOf(index)];
        const supportSlot = Number.isInteger(support) && ratioBySlot.has(support) ? support : slotOf(index);
        return ratioBySlot.get(supportSlot);
    };
    const midX = source.reduce((sum, transform) => sum + finite(transform.x, 0), 0) / source.length;
    const midZ = source.reduce((sum, transform) => sum + finite(transform.z, 0), 0) / source.length;
    return source.map((transform, index) => {
        const ratio = ratioFor(index);
        return {
            ...transform,
            x: midX + ratio * (finite(transform.x, 0) - midX),
            y: ratio * finite(transform.y, 0),
            z: midZ + ratio * (finite(transform.z, 0) - midZ),
        };
    });
}
