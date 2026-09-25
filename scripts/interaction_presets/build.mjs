/**
 * Writes the bundled Interactions presets (pose_presets/Interactions/*.json)
 * from presets.mjs. Previews (*.webp next to each JSON) are rendered
 * separately from the same scenes in Pose Studio's viewer.
 *
 *   node scripts/interaction_presets/build.mjs
 */
import fs from "node:fs";
import { PRESET_DEFINITIONS, buildPresetScene } from "./presets.mjs";

export const INTERACTION_CATEGORY = "Interactions";
export const INTERACTION_REPOSITORY = "vnccs_interaction_presets";
const OUTPUT = new URL(`../../pose_presets/${INTERACTION_CATEGORY}/`, import.meta.url);

export function buildPresetAsset(definition) {
    const scene = buildPresetScene(definition);
    const failed = scene.report.filter(contact => contact.distance > contact.tolerance);
    if (failed.length) {
        throw new Error(`${definition.name}: contacts apart: ${failed.map(contact => `${contact.label} ${contact.distance.toFixed(2)}`).join(", ")}`);
    }
    const round = value => Math.round(value * 1000) / 1000;
    const characters = scene.characters.map((character, slot) => ({
        id: `character-${slot + 1}`,
        slot,
        // No name, color or mesh: applying the preset keeps the mannequins' own.
        transform: Object.fromEntries(Object.entries(character.transform).map(([key, value]) => [key, round(value)])),
        poses: [{ ...character.pose, prompt: definition.prompt }],
        animation: null,
    }));
    const first = characters[0].poses[0];
    return {
        bones: first.bones,
        modelRotation: first.modelRotation,
        type: "scene_pose",
        schema_version: 3,
        active_character_id: characters[0].id,
        characters,
        timeline: { fps: 12, duration: 1, frameCount: 13, currentFrame: 0, loop: true },
        activeTab: 0,
        pose_prompts: [definition.prompt],
        camera: { yaw_deg: 0, pitch_deg: 0 },
        prompt: definition.prompt,
        interaction: {
            key: definition.key,
            reference_heights: scene.characters.map(character => round(character.height)),
            supports: characters.map((_character, slot) => definition.supports?.[slot] ?? null),
            contacts: definition.contacts.map(([a, pointA, b, pointB, tolerance = 0.6]) => ({ a, point_a: pointA, b, point_b: pointB, tolerance })),
        },
        _library: {
            repository: INTERACTION_REPOSITORY,
            category: INTERACTION_CATEGORY,
            tags: ["Interaction", `${characters.length} characters`],
            asset_type: "pose",
        },
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    fs.mkdirSync(OUTPUT, { recursive: true });
    for (const definition of PRESET_DEFINITIONS) {
        const asset = buildPresetAsset(definition);
        fs.writeFileSync(new URL(`${definition.name}.json`, OUTPUT), `${JSON.stringify(asset, null, 1)}\n`);
        console.log(`${definition.name}: ${asset.characters.length} characters`);
    }
}
