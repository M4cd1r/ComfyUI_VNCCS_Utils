import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { buildPresetAsset } from "../scripts/interaction_presets/build.mjs";
import { PRESET_DEFINITIONS } from "../scripts/interaction_presets/presets.mjs";
import { applyPose, buildRig, point } from "../scripts/interaction_presets/rig.mjs";
import { normalizePoseStudioCharacters } from "../web/vnccs_pose_characters.mjs";
import {
    inheritSlotIdentity,
    meshVerticalExtent,
    scaleInteractionTransforms,
} from "../web/vnccs_pose_interactions.mjs";

const PRESET_DIR = new URL("../pose_presets/Interactions/", import.meta.url);
const EXPECTED = [
    "Hug", "Handshake", "High five", "Kiss on the cheek", "Arm around the shoulder", "Princess carry",
    "Piggyback", "Punch and block", "Sitting side by side", "Whisper", "Pointing at each other",
    "Dancing pair", "Group photo",
];
const readPreset = name => JSON.parse(fs.readFileSync(new URL(`${name}.json`, PRESET_DIR), "utf8"));

function placeScene(asset, meshes, transforms = asset.characters.map(character => character.transform)) {
    return asset.characters.map((character, index) => {
        const rig = buildRig(meshes[index] || {});
        applyPose(rig, character.poses[0], transforms[index]);
        return rig;
    });
}

test("all 13 interaction presets ship in the Interactions category with a preview", () => {
    assert.deepEqual(PRESET_DEFINITIONS.map(definition => definition.name), EXPECTED);
    for (const name of EXPECTED) {
        const asset = readPreset(name);
        assert.equal(asset.type, "scene_pose", name);
        assert.equal(asset._library.category, "Interactions", name);
        assert.equal(asset._library.repository, "vnccs_interaction_presets", name);
        assert.ok(fs.existsSync(new URL(`${name}.webp`, PRESET_DIR)), `${name} preview`);
        const count = name === "Group photo" ? 3 : 2;
        assert.equal(asset.characters.length, count, name);
        assert.equal(asset.interaction.reference_heights.length, count, name);
        for (const character of asset.characters) {
            // Bodies, names and colors come from the mannequins the preset is applied to.
            assert.equal(character.mesh, undefined, name);
            assert.equal(character.name, undefined, name);
            assert.ok(Object.keys(character.poses[0].bones).length > 0, name);
        }
        const normalized = normalizePoseStudioCharacters(asset, { mesh: { age: 25 } });
        assert.deepEqual(normalized.characters.map(character => character.slot), asset.characters.map((_c, slot) => slot));
    }
});

test("committed presets match the generator", () => {
    for (const definition of PRESET_DEFINITIONS) {
        assert.deepEqual(readPreset(definition.name), JSON.parse(JSON.stringify(buildPresetAsset(definition))), definition.name);
    }
});

test("contact points meet at the default mannequin proportions", () => {
    for (const name of EXPECTED) {
        const asset = readPreset(name);
        const rigs = placeScene(asset, []);
        assert.ok(asset.interaction.contacts.length > 0, name);
        for (const contact of asset.interaction.contacts) {
            const distance = point(rigs[contact.a], contact.point_a).distanceTo(point(rigs[contact.b], contact.point_b));
            assert.ok(distance <= contact.tolerance, `${name}: ${contact.point_a}~${contact.point_b} ${distance.toFixed(2)} > ${contact.tolerance}`);
        }
        const heights = rigs.map(rig => rig.height);
        assert.deepEqual(asset.interaction.reference_heights, heights.map(height => Math.round(height * 1000) / 1000), name);
    }
});

test("height-ratio scaling keeps an adult and a child's hands together", () => {
    const meshes = [{}, { age: 10 }];
    for (const name of ["Handshake", "High five"]) {
        const asset = readPreset(name);
        const [contact] = asset.interaction.contacts;
        const horizontal = rigs => {
            const a = point(rigs[contact.a], contact.point_a);
            const b = point(rigs[contact.b], contact.point_b);
            return Math.hypot(a.x - b.x, a.z - b.z);
        };
        const unscaled = horizontal(placeScene(asset, meshes));
        const heights = meshes.map(mesh => buildRig(mesh).height);
        assert.ok(heights[1] < heights[0] * 0.8, "the child is clearly shorter");
        const transforms = scaleInteractionTransforms(asset.characters.map(character => character.transform), heights, asset.interaction);
        const scaled = horizontal(placeScene(asset, meshes, transforms));
        assert.ok(scaled < 0.6, `${name}: contact ${scaled.toFixed(2)} apart after scaling`);
        assert.ok(scaled < unscaled, `${name}: scaling brings the hands closer (${scaled.toFixed(2)} vs ${unscaled.toFixed(2)})`);
    }
});

test("scaling is the identity at the reference heights and carried characters follow their support", () => {
    const transforms = [{ x: -2, y: 0, z: 0, zoom: 1 }, { x: 2, y: 1, z: -1, zoom: 1 }];
    const interaction = { reference_heights: [10, 10], supports: [null, 0] };
    assert.deepEqual(scaleInteractionTransforms(transforms, [10, 10], interaction), transforms);
    const scaled = scaleInteractionTransforms(transforms, [5, 20], interaction);
    // Character 1 rides on character 0, so it uses character 0's ratio (0.5), not its own (2).
    assert.deepEqual(scaled[0], { x: -1, y: 0, z: -0.25, zoom: 1 });
    assert.deepEqual(scaled[1], { x: 1, y: 0.5, z: -0.75, zoom: 1 });
    // Unknown heights or a scene without interaction data leave the transforms alone.
    assert.deepEqual(scaleInteractionTransforms(transforms, [0, 0], interaction), transforms);
    assert.deepEqual(scaleInteractionTransforms(transforms, [5, 5], null), transforms);
});

test("slot identity: bodies, names and colors stay by slot unless the asset brings its own", () => {
    const previous = [
        { id: "character-1", slot: 0, name: "Alice", color: "#8ec5ff", mesh: { age: 30, height: 0.7 } },
        { id: "character-2", slot: 1, name: "Bob", color: "#f0a6ca", mesh: { age: 9 } },
    ];
    const asset = {
        characters: [
            { id: "character-1", slot: 0, poses: [{}] },
            { id: "character-2", slot: 1, poses: [{}], mesh: { age: 60 }, name: "Preset" },
            { id: "character-3", slot: 2, poses: [{}] },
        ],
    };
    const merged = inheritSlotIdentity(asset, previous);
    assert.deepEqual(merged.characters.map(character => character.mesh), [{ age: 30, height: 0.7 }, { age: 60 }, undefined]);
    assert.deepEqual(merged.characters.map(character => character.name), ["Alice", "Preset", undefined]);
    assert.deepEqual(merged.characters.map(character => character.color), ["#8ec5ff", "#f0a6ca", undefined]);
    assert.notEqual(merged.characters[0].mesh, previous[0].mesh);
    assert.equal(asset.characters[0].mesh, undefined, "the cached library asset is not mutated");
    const normalized = normalizePoseStudioCharacters(merged, { mesh: { age: 25 } });
    assert.deepEqual(normalized.characters.map(character => character.mesh.age), [30, 60, 25]);
});

test("mesh height is the vertical extent of the rest vertices", () => {
    assert.equal(meshVerticalExtent(new Float32Array([0, -2, 0, 1, 3, 1, 0, 0.5, 0])), 5);
    assert.equal(meshVerticalExtent(null), 0);
});
