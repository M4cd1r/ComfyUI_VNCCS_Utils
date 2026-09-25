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
