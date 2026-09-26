import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { THREE, applyPose, buildRig, point } from "../scripts/interaction_presets/rig.mjs";
import {
    fitInteractionContacts,
    handChainForPoint,
    proportionedHeight,
    readBoneRotations,
    restSkeletonHeight,
} from "../web/vnccs_pose_contacts.mjs";
import { scaleInteractionTransforms } from "../web/vnccs_pose_interactions.mjs";

const PRESET_DIR = new URL("../pose_presets/Interactions/", import.meta.url);
const readPreset = name => JSON.parse(fs.readFileSync(new URL(`${name}.json`, PRESET_DIR), "utf8"));

// Bone-length sliders scale a child bone's rest offset (PoseViewerCore._setBoneOffsetScale).
function stretch(rig, names, scale) {
    for (const name of names) {
        rig.bones[name].userData.rest.multiplyScalar(scale);
        rig.bones[name].position.copy(rig.bones[name].userData.rest);
    }
}

function restBones(rig) {
    return rig.list.map(bone => ({
        name: bone.name,
        parent: bone.userData.parentName,
        position: bone.userData.rest.toArray(),
        tail: bone.userData.tailLocal.toArray(),
    }));
}

function placeFitted(asset, meshes, { fit = true, stretches = [] } = {}) {
    const rigs = asset.characters.map((_character, index) => buildRig(meshes[index] || {}));
    stretches.forEach((entry, index) => entry && stretch(rigs[index], entry.names, entry.scale));
    const heights = rigs.map((rig, index) => {
        const bones = restBones(rig);
        const unshaped = Object.fromEntries(bones.map(bone => [bone.name, bone.position]));
        if (stretches[index]) {
            // restBones already carries the stretched offsets; recover the unstretched ones.
            for (const name of stretches[index].names) unshaped[name] = unshaped[name].map(value => value / stretches[index].scale);
        }
        return proportionedHeight(rig.height, bones, Object.fromEntries(bones.map(bone => [bone.name, bone.position])), unshaped);
    });
    const transforms = scaleInteractionTransforms(asset.characters.map(character => character.transform), heights, asset.interaction);
    rigs.forEach((rig, index) => applyPose(rig, asset.characters[index].poses[0], transforms[index]));
    const ratios = heights.map((height, index) => height / asset.interaction.reference_heights[index]);
    const fitted = fit ? fitInteractionContacts(THREE, rigs, asset.interaction, { ratios }) : rigs.map(() => ({ bones: [], move: { x: 0, z: 0 } }));
    return { rigs, heights, ratios, changed: fitted.map(entry => entry.bones), moves: fitted.map(entry => entry.move) };
}

function contactError(asset, { rigs, ratios }, contact) {
    const ratio = (ratios[contact.a] + ratios[contact.b]) / 2;
    const gap = point(rigs[contact.b], contact.point_b).sub(point(rigs[contact.a], contact.point_a));
    return gap.sub(new THREE.Vector3(...contact.offset).multiplyScalar(ratio));
}

test("hand contact points map to their arm chain", () => {
    assert.equal(handChainForPoint("palm_r"), "arm_r");
    assert.equal(handChainForPoint("fist_l"), "arm_l");
    assert.equal(handChainForPoint("fingertip_r"), "arm_r");
    assert.equal(handChainForPoint("shoulder_l"), null);
    assert.equal(handChainForPoint("chest"), null);
});

test("every preset contact stores its authored offset", () => {
    for (const name of ["Handshake", "High five", "Group photo", "Hug", "Piggyback"]) {
        const asset = readPreset(name);
        const rigs = asset.characters.map((character, index) => {
            const rig = buildRig({});
            applyPose(rig, character.poses[0], asset.characters[index].transform);
            return rig;
        });
        for (const contact of asset.interaction.contacts) {
            const gap = point(rigs[contact.b], contact.point_b).sub(point(rigs[contact.a], contact.point_a));
            assert.ok(gap.distanceTo(new THREE.Vector3(...contact.offset)) < 0.01, `${name} ${contact.point_a}~${contact.point_b}`);
        }
    }
});

test("an adult and a child meet vertically after the contact fit (#16)", () => {
    const meshes = [{}, { age: 10 }];
    for (const name of ["Handshake", "High five"]) {
        const asset = readPreset(name);
        const [contact] = asset.interaction.contacts;
        const before = contactError(asset, placeFitted(asset, meshes, { fit: false }), contact);
        assert.ok(Math.abs(before.y) > 0.5, `${name}: the child's hand starts clearly lower (${before.y.toFixed(2)})`);
        const scene = placeFitted(asset, meshes);
        const after = contactError(asset, scene, contact);
        assert.ok(Math.abs(after.y) < 0.1, `${name}: vertical gap ${after.y.toFixed(2)} after fitting`);
        assert.ok(after.length() < 0.15, `${name}: contact ${after.length().toFixed(2)} from its authored offset`);
        // Both hands moved: the adult reaches down and the child reaches up.
        assert.ok(scene.changed[0].includes("upperarm_r") || scene.changed[0].includes("upperarm_l"), name);
        assert.ok(scene.changed[1].length > 0, name);
        const rotations = readBoneRotations(scene.rigs[1], scene.changed[1]);
        assert.ok(Object.values(rotations).every(value => value.length === 3 && value.every(Number.isFinite)), name);
    }
});

test("the fit leaves reference bodies unchanged", () => {
    for (const name of ["Handshake", "Group photo", "Piggyback"]) {
        const asset = readPreset(name);
        const scene = placeFitted(asset, []);
        assert.deepEqual(scene.changed, asset.characters.map(() => []), name);
        assert.deepEqual(scene.moves, asset.characters.map(() => ({ x: 0, z: 0 })), name);
    }
});

test("bone-length sliders count towards the standing height (#16)", () => {
    const rig = buildRig({});
    const bones = restBones(rig);
    const offsets = Object.fromEntries(bones.map(bone => [bone.name, bone.position]));
    const height = restSkeletonHeight(bones);
    assert.ok(height > 10 && height < 16, `rest skeleton height ${height}`);
    assert.equal(proportionedHeight(rig.height, bones, offsets, offsets), rig.height, "default sliders keep the mesh height");
    // Longer thighs and shins (Thigh / Shin Length sliders at 0.8 -> scale 1.3).
    const shaped = { ...offsets };
    for (const name of ["calf_l", "calf_r", "foot_l", "foot_r"]) shaped[name] = offsets[name].map(value => value * 1.3);
    const legDrop = Math.max(-offsets.calf_l[1] - offsets.foot_l[1], -offsets.calf_r[1] - offsets.foot_r[1]);
    const taller = proportionedHeight(rig.height, bones, shaped, offsets);
    assert.ok(Math.abs(taller - rig.height - legDrop * 0.3) < 0.2, `${taller} vs ${rig.height} + ${legDrop * 0.3}`);
    // A longer spine (Spine Length) raises the head too.
    const spine = { ...offsets, spine_02: offsets.spine_02.map(value => value * 1.4), spine_03: offsets.spine_03.map(value => value * 1.4) };
    assert.ok(proportionedHeight(rig.height, bones, spine, offsets) > rig.height + 0.2);
    assert.equal(proportionedHeight(0, bones, shaped, offsets), 0);
});

test("longer legs change the placement ratio and the fit still meets the hands", () => {
    const asset = readPreset("Handshake");
    const legs = { names: ["calf_l", "calf_r", "foot_l", "foot_r"], scale: 1.35 };
    const plain = placeFitted(asset, [], { fit: false });
    const long = placeFitted(asset, [], { fit: false, stretches: [null, legs] });
    assert.ok(long.heights[1] > plain.heights[1] + 0.5, "the stretched legs make character 2 taller");
    const fitted = placeFitted(asset, [], { stretches: [null, legs] });
    const [contact] = asset.interaction.contacts;
    assert.ok(contactError(asset, fitted, contact).length() < 0.2);
});
