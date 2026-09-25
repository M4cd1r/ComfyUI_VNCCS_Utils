/**
 * Headless Pose Studio rig for authoring and checking interaction presets.
 *
 * It rebuilds the same bone hierarchy PoseViewerCore creates from the bundled
 * MakeHuman pack (rest rotations are identity, so bone-local axes start out
 * world aligned) and applies poses the way setPose / setPassiveCharacterState
 * do: bone Euler rotations in degrees, modelRotation on the mesh, then the
 * character transform (position + uniform zoom).
 */
import fs from "node:fs";
import zlib from "node:zlib";
import * as THREE from "../../web/three.module.js";
import { parseMorphPack, solveMorph } from "../../web/vnccs_pose_morph_runtime.mjs";
import { meshVerticalExtent } from "../../web/vnccs_pose_interactions.mjs";

const PACK_URL = new URL("../../web/assets/pose_studio_makehuman.v2.bin.gz", import.meta.url);
let packCache = null;

export function loadPack() {
    if (packCache) return packCache;
    const bytes = zlib.gunzipSync(fs.readFileSync(PACK_URL));
    packCache = parseMorphPack(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return packCache;
}

export function buildRig(meshParams = {}) {
    const pack = loadPack();
    const solved = solveMorph(pack, meshParams);
    const root = new THREE.Group();
    const bones = {};
    const list = [];
    pack.bones.forEach((source, index) => {
        const offset = index * 6;
        const head = new THREE.Vector3().fromArray(solved.bonePositions, offset);
        const tail = new THREE.Vector3().fromArray(solved.bonePositions, offset + 3);
        const bone = new THREE.Bone();
        bone.name = source.name;
        bone.userData = { head, tail, parentName: source.parent || null };
        bones[bone.name] = bone;
        list.push(bone);
    });
    for (const bone of list) {
        const parent = bones[bone.userData.parentName];
        if (parent) {
            parent.add(bone);
            bone.position.copy(bone.userData.head).sub(parent.userData.head);
        } else {
            root.add(bone);
            bone.position.copy(bone.userData.head);
        }
        bone.userData.rest = bone.position.clone();
        bone.userData.tailLocal = bone.userData.tail.clone().sub(bone.userData.head);
    }
    return { root, bones, list, height: meshVerticalExtent(solved.vertices), meshParams };
}

export function applyPose(rig, pose = {}, transform = {}) {
    for (const bone of rig.list) {
        bone.position.copy(bone.userData.rest);
        bone.rotation.set(0, 0, 0);
    }
    for (const [name, rotation] of Object.entries(pose.bones || {})) {
        const bone = rig.bones[name];
        if (bone) bone.rotation.set(...rotation.map(value => value * Math.PI / 180));
    }
    for (const [name, position] of Object.entries(pose.bonePositions || {})) {
        const bone = rig.bones[name];
        if (bone) bone.position.fromArray(position);
    }
    const [rx, ry, rz] = (pose.modelRotation || [0, 0, 0]).map(value => value * Math.PI / 180);
    rig.root.rotation.set(rx, ry, rz);
    rig.root.position.set(transform.x || 0, transform.y || 0, transform.z || 0);
    rig.root.scale.setScalar(transform.zoom || 1);
    rig.root.updateMatrixWorld(true);
}

export function readPose(rig) {
    const bones = {};
    const round = value => Math.round(value * 100) / 100;
    for (const bone of rig.list) {
        const { x, y, z } = bone.rotation;
        if (Math.abs(x) > 1e-4 || Math.abs(y) > 1e-4 || Math.abs(z) > 1e-4) {
            bones[bone.name] = [x, y, z].map(value => round(value * 180 / Math.PI));
        }
    }
    const modelRotation = ["x", "y", "z"].map(axis => round(rig.root.rotation[axis] * 180 / Math.PI));
    return { bones, modelRotation };
}

export function headWorld(rig, name) {
    return rig.bones[name].getWorldPosition(new THREE.Vector3());
}

export function tailWorld(rig, name) {
    const bone = rig.bones[name];
    return bone.localToWorld(bone.userData.tailLocal.clone());
}

/** Named contact points (world space) used by presets and their checks. */
export function point(rig, name) {
    const side = name.endsWith("_l") ? "l" : name.endsWith("_r") ? "r" : "";
    const base = side ? name.slice(0, -2) : name;
    const mid = (a, b, t = 0.5) => a.clone().lerp(b, t);
    switch (base) {
        case "palm": return mid(headWorld(rig, `hand_${side}`), headWorld(rig, `middle_01_${side}`), 0.6);
        case "fingertip": return tailWorld(rig, `middle_03_${side}`);
        case "fist": return mid(headWorld(rig, `middle_01_${side}`), headWorld(rig, `index_01_${side}`));
        case "wrist": return headWorld(rig, `hand_${side}`);
        case "elbow": return headWorld(rig, `lowerarm_${side}`);
        case "forearm": return mid(headWorld(rig, `lowerarm_${side}`), headWorld(rig, `hand_${side}`));
        case "shoulder": return headWorld(rig, `upperarm_${side}`);
        case "knee": return headWorld(rig, `calf_${side}`);
        case "hip": return headWorld(rig, `thigh_${side}`);
        case "ankle": return headWorld(rig, `foot_${side}`);
        case "head_top": return tailWorld(rig, "head");
        case "head": return mid(headWorld(rig, "head"), tailWorld(rig, "head"), 0.45);
        case "neck": return headWorld(rig, "neck_01");
        case "chest": return mid(headWorld(rig, "spine_03"), tailWorld(rig, "spine_03"), 0.55);
        case "pelvis": return headWorld(rig, "pelvis");
        case "spine": return headWorld(rig, "spine_03");
        default: throw new Error(`Unknown contact point ${name}`);
    }
}

function firstChildDirection(bone) {
    const child = bone.children.find(item => item.isBone);
    return (child ? child.position : bone.userData.tailLocal).clone().normalize();
}

/**
 * Rotate a bone (minimal change from its current rotation) so its
 * head-to-child direction points along worldDirection.
 */
export function aim(rig, name, worldDirection, childName = null) {
    const bone = rig.bones[name];
    bone.updateMatrixWorld(true);
    const localDirection = childName ? rig.bones[childName].position.clone().normalize() : firstChildDirection(bone);
    const parentQuaternion = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const desired = worldDirection.clone().normalize().applyQuaternion(parentQuaternion.invert());
    const current = localDirection.clone().applyQuaternion(bone.quaternion);
    const delta = new THREE.Quaternion().setFromUnitVectors(current, desired);
    bone.quaternion.premultiply(delta);
    bone.updateMatrixWorld(true);
}

/** Twist a bone around its own length axis (degrees). */
export function twist(rig, name, degrees) {
    const bone = rig.bones[name];
    const axis = firstChildDirection(bone);
    bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis, degrees * Math.PI / 180));
    bone.updateMatrixWorld(true);
}

/** Add an Euler rotation (degrees, bone-local) on top of the current one. */
export function rotate(rig, name, [x = 0, y = 0, z = 0]) {
    const bone = rig.bones[name];
    const extra = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z).set(
        x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180));
    bone.quaternion.multiply(extra);
    bone.updateMatrixWorld(true);
}

export function setRotation(rig, name, [x = 0, y = 0, z = 0]) {
    rig.bones[name].rotation.set(x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180);
    rig.bones[name].updateMatrixWorld(true);
}

const CHAINS = {
    arm_l: ["upperarm_l", "lowerarm_l", "hand_l"],
    arm_r: ["upperarm_r", "lowerarm_r", "hand_r"],
    leg_l: ["thigh_l", "calf_l", "foot_l"],
    leg_r: ["thigh_r", "calf_r", "foot_r"],
};

function solveTwoBone(rig, [upperName, lowerName, endName], target, bendWorld) {
    const start = headWorld(rig, upperName);
    const upperLength = start.distanceTo(headWorld(rig, lowerName));
    const lowerLength = headWorld(rig, lowerName).distanceTo(headWorld(rig, endName));
    const toTarget = target.clone().sub(start);
    const distance = Math.min(Math.max(toTarget.length(), Math.abs(upperLength - lowerLength) + 1e-3), (upperLength + lowerLength) * 0.9995);
    const direction = toTarget.normalize();
    const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
    const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
    const bend = bendWorld.clone().sub(direction.clone().multiplyScalar(bendWorld.dot(direction)));
    if (bend.lengthSq() < 1e-8) bend.set(0, 0, 1);
    bend.normalize();
    const joint = start.clone().addScaledVector(direction, along).addScaledVector(bend, height);
    aim(rig, upperName, joint.clone().sub(start), lowerName);
    const endPosition = start.clone().addScaledVector(direction, distance);
    aim(rig, lowerName, endPosition.sub(headWorld(rig, lowerName)), endName);
}

/**
 * Two-bone IK: move a limb so that the named contact point lands on target.
 * bendWorld is the direction the elbow / knee should point to.
 */
export function reach(rig, chain, target, bendWorld, contact = null) {
    const bones = CHAINS[chain];
    let aimAt = target.clone();
    for (let iteration = 0; iteration < 8; iteration += 1) {
        solveTwoBone(rig, bones, aimAt, bendWorld);
        if (!contact) break;
        const error = target.clone().sub(point(rig, contact));
        if (error.length() < 1e-3) break;
        aimAt.add(error);
    }
}

/**
 * Orient a hand in world space: fingers along fingerWorld and the palm facing
 * palmWorld (both approximate; they are orthogonalized).
 */
export function orientHand(rig, side, fingerWorld, palmWorld) {
    const hand = rig.bones[`hand_${side}`];
    const restFinger = rig.bones[`middle_01_${side}`].position.clone().normalize();
    const across = rig.bones[`pinky_01_${side}`].position.clone().sub(rig.bones[`index_01_${side}`].position).normalize();
    // Outward palm normal; the hands mirror each other, so the cross product flips per side.
    const restPalm = new THREE.Vector3().crossVectors(restFinger, across).normalize();
    if (side === "l") restPalm.negate();
    const restMatrix = basis(restFinger, restPalm);
    const targetMatrix = basis(fingerWorld.clone().normalize(), palmWorld.clone().normalize());
    const worldQuaternion = new THREE.Quaternion().setFromRotationMatrix(targetMatrix.multiply(restMatrix.transpose()));
    const parentQuaternion = hand.parent.getWorldQuaternion(new THREE.Quaternion());
    hand.quaternion.copy(parentQuaternion.invert().multiply(worldQuaternion));
    hand.updateMatrixWorld(true);
}

function basis(forward, up) {
    const x = forward.clone().normalize();
    const z = new THREE.Vector3().crossVectors(x, up).normalize();
    const y = new THREE.Vector3().crossVectors(z, x).normalize();
    return new THREE.Matrix4().makeBasis(x, y, z);
}

/** Curl all fingers of a hand towards the palm (degrees per joint; negative opens). */
export function curl(rig, side, degrees, thumbDegrees = degrees * 0.5) {
    const across = rig.bones[`pinky_01_${side}`].position.clone().sub(rig.bones[`index_01_${side}`].position).normalize();
    if (side === "r") across.negate();
    for (const finger of ["index", "middle", "ring", "pinky"]) {
        for (const joint of ["01", "02", "03"]) {
            const bone = rig.bones[`${finger}_${joint}_${side}`];
            bone.quaternion.setFromAxisAngle(across, degrees * Math.PI / 180);
        }
    }
    for (const joint of ["02", "03"]) {
        const bone = rig.bones[`thumb_${joint}_${side}`];
        bone.quaternion.setFromAxisAngle(across, thumbDegrees * Math.PI / 180);
    }
    rig.root.updateMatrixWorld(true);
}

export { THREE };
