import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createScene } from "./helpers/pose_studio_scene.mjs";
import {
    bodyMorphSignature,
    isMultiCharacterScenePose,
    planScenePoseApplication,
    scenePoseTransform,
} from "../web/vnccs_pose_interactions.mjs";
import { boneLengthParamsFromMesh, contactPoint, restSkeletonFromBones } from "../web/vnccs_pose_contacts.mjs";

// #33 item 1: a multi-character library pose poses the mannequins of the current scene.
const PRESET_DIR = new URL("../pose_presets/Interactions/", import.meta.url);
const readPreset = name => JSON.parse(fs.readFileSync(new URL(`${name}.json`, PRESET_DIR), "utf8"));

test("only still poses of two or more characters count as a multi-character scene pose", () => {
    const handshake = readPreset("Handshake");
    assert.equal(isMultiCharacterScenePose({ pose: handshake }), true);
    assert.equal(isMultiCharacterScenePose({ pose: { ...handshake, characters: handshake.characters.slice(0, 1) } }), false);
    assert.equal(isMultiCharacterScenePose({ pose: handshake, asset_type: "animation" }), false);
    assert.equal(isMultiCharacterScenePose({ pose: { type: "pose_set", poses: [{}], characters: handshake.characters } }), false);
    assert.equal(isMultiCharacterScenePose({}), false);
});

test("the plan matches characters in slot order, adds missing ones and leaves extra ones out", () => {
    const asset = readPreset("Group photo");
    const scene = [{ id: "b", slot: 1 }, { id: "a", slot: 0 }];
    const plan = planScenePoseApplication(scene, asset);
    assert.deepEqual(plan.map(entry => entry.target?.id ?? null), ["a", "b", null]);
    assert.deepEqual(plan.map(entry => entry.sourceIndex), [0, 1, 2]);
    plan.forEach((entry, index) => {
        assert.deepEqual(entry.transform, scenePoseTransform(asset.characters[index]));
        assert.deepEqual(entry.pose.bones, asset.characters[index].poses[0].bones);
        assert.equal(entry.pose.cameraParams, undefined);
    });
    // Room for one more mannequin only.
    assert.equal(planScenePoseApplication(scene, asset, { max: 2 }).length, 2);
    // More scene characters than the asset: the extra one is not part of the plan.
    const handshake = planScenePoseApplication([...scene, { id: "c", slot: 2 }], readPreset("Handshake"));
    assert.deepEqual(handshake.map(entry => entry.target.id), ["a", "b"]);
});

test("the body signature ignores the sliders that only scale the rig", () => {
    assert.equal(bodyMorphSignature({ age: 10, thigh_length: 0.8, head_size: 1.2 }), bodyMorphSignature({ age: 10 }));
    assert.notEqual(bodyMorphSignature({ age: 10 }), bodyMorphSignature({ age: 25 }));
    assert.equal(bodyMorphSignature({ b: 1, a: 2 }), bodyMorphSignature({ a: 2, b: 1 }));
    const lengths = boneLengthParamsFromMesh({ leg_length: 0.7, shin_l_length: 0.2 });
    assert.equal(lengths.thigh_l, 0.7);
    assert.equal(lengths.shin_r, 0.7);
    assert.equal(lengths.shin_l, 0.2);
    assert.equal(lengths.spine, 0.5);
});

function sceneWithCharacters(count) {
    const scene = createScene({ skinned: true });
    const { w } = scene;
    w.host.keepCharactersOnScenePose = true;
    for (let slot = 1; slot < count; slot += 1) {
        const character = w.createSceneCharacter(slot, { x: slot * 3, y: 0, z: 0, zoom: 1 });
        character.name = `Hero ${slot + 1}`;
        character.mesh = { ...character.mesh, age: 30 + slot };
        w.characters.push(character);
    }
    w.getActiveCharacter().name = "Hero 1";
    w.updateCharacterScene();
    w.syncToNode(false);
    return scene;
}

async function loadAsset(scene, asset) {
    scene.context.fetch = async () => ({ ok: true, json: async () => ({ pose: asset, asset_type: "pose" }) });
    await scene.w.loadFromLibrary("Interactions/test");
}

// The widget runs in a VM context; compare plain copies of its objects.
const plain = value => JSON.parse(JSON.stringify(value));
const identity = character => ({ id: character.id, slot: character.slot, name: character.name, color: character.color, mesh: JSON.stringify(character.mesh) });

test("a multi-character pose poses the scene's mannequins and keeps their identity", async () => {
    const scene = sceneWithCharacters(3);
    const { w, viewer } = scene;
    const before = plain(w.characters.map(identity));
    const third = JSON.stringify({ transform: w.characters[2].transform, pose: w.characters[2].poses[0] });
    const asset = readPreset("Handshake");
    await loadAsset(scene, asset);
    assert.deepEqual(plain(w.characters.map(identity)), before, "ids, names, colors and bodies stay");
    for (const index of [0, 1]) {
        const transform = w.characterTransformForScene(w.characters[index]);
        assert.ok(Math.abs(transform.x - asset.characters[index].transform.x) < 1e-6, `character ${index + 1} x`);
        assert.deepEqual(plain(w.characters[index].poses[0].modelRotation), asset.characters[index].poses[0].modelRotation);
    }
    assert.equal(JSON.stringify({ transform: w.characters[2].transform, pose: w.characters[2].poses[0] }), third, "the extra mannequin is unchanged");
    assert.deepEqual(plain(viewer.getPose().modelRotation), asset.characters[0].poses[0].modelRotation, "the active mannequin shows the pose");
    assert.deepEqual([...viewer.passiveCharacters.keys()].sort(), plain(w.characters.slice(1).map(item => item.id)).sort());
    const saved = JSON.parse(scene.node.widgets[0].value);
    assert.deepEqual(plain(saved.characters.map(item => item.id)), before.map(item => item.id));
});

test("missing mannequins are added, and one Undo / Redo covers the whole load", async () => {
    const scene = sceneWithCharacters(1);
    const { w, viewer } = scene;
    const before = { ids: plain(w.characters.map(item => item.id)), transform: plain(w.characters[0].transform), pose: JSON.stringify(viewer.getPose().bones) };
    const depth = viewer.history.length;
    const asset = readPreset("Group photo");
    await loadAsset(scene, asset);
    assert.equal(viewer.history.length, depth + 1, "one history entry");
    assert.equal(w.characters.length, 3);
    assert.equal(w.characters[0].id, before.ids[0], "the existing mannequin keeps its id");
    assert.equal(viewer.passiveCharacters.size, 2);
    const loaded = plain(w.characters.map(item => w.characterTransformForScene(item).x));
    asset.characters.forEach((character, index) => assert.ok(Math.abs(loaded[index] - character.transform.x) < 1e-6, `slot ${index}`));

    viewer.undo();
    assert.deepEqual(plain(w.characters.map(item => item.id)), before.ids);
    assert.equal(viewer.passiveCharacters.size, 0);
    assert.deepEqual(plain(w.getActiveCharacter().transform), before.transform);
    assert.equal(JSON.stringify(viewer.getPose().bones), before.pose);
    assert.equal(JSON.parse(scene.node.widgets[0].value).characters.length, 1);

    viewer.redo();
    assert.equal(w.characters.length, 3);
    assert.deepEqual(plain(w.characters.map(item => w.characterTransformForScene(item).x)), loaded);
    assert.equal(viewer.passiveCharacters.size, 2);
});

test("a shorter mannequin gets its hand contact re-fitted on the loaded rigs (#16)", async () => {
    const scene = sceneWithCharacters(2);
    const { w, THREE } = scene;
    // Character 2 stands 80% as tall as the reference mannequin the preset was authored with.
    const asset = readPreset("High five");
    const [reference] = asset.interaction.reference_heights;
    w._meshHeights = new Map(w.characters.map((character, index) => [bodyMorphSignature(character.mesh), index ? reference * 0.8 : reference]));
    await loadAsset(scene, asset);
    const [contact] = asset.interaction.contacts;
    const rigs = w.characters.map(character => w.characterRig(character));
    const gap = contactPoint(THREE, rigs[contact.b], contact.point_b).sub(contactPoint(THREE, rigs[contact.a], contact.point_a));
    const error = gap.sub(new THREE.Vector3(...contact.offset).multiplyScalar(0.9));
    assert.ok(error.length() < 0.15, `contact ${error.length().toFixed(3)} from its scaled offset`);
    // The fitted arm rotations are part of the saved poses.
    const saved = JSON.parse(scene.node.widgets[0].value).characters;
    const side = contact.point_a.slice(-1);
    assert.notDeepEqual(saved[0].poses[0].bones[`upperarm_${side}`], asset.characters[0].poses[0].bones[`upperarm_${side}`]);
});

test("bone-length sliders raise the standing height used for interaction placement (#16)", () => {
    const { w, viewer } = createScene({ skinned: true });
    const signature = bodyMorphSignature(w.meshParams);
    w._meshHeights = new Map([[signature, 14.3]]);
    w._meshSkeletons = new Map([[signature, restSkeletonFromBones(viewer.boneList,
        Object.fromEntries(Object.entries(viewer.initialBoneStates).map(([name, state]) => [name, state.position])))]]);
    const plain = w.characterStandingHeight({ mesh: { ...w.meshParams } });
    assert.ok(Math.abs(plain - 14.3) < 1e-6, `default sliders keep the morph height (${plain})`);
    const longLegs = w.characterStandingHeight({ mesh: { ...w.meshParams, thigh_l_length: 0.8, thigh_r_length: 0.8, shin_l_length: 0.8, shin_r_length: 0.8 } });
    assert.ok(longLegs > plain + 0.5, `longer legs are taller (${longLegs})`);
    const shortSpine = w.characterStandingHeight({ mesh: { ...w.meshParams, spine_length: 0.2 } });
    assert.ok(shortSpine < plain - 0.2, `a shorter spine is shorter (${shortSpine})`);
});
