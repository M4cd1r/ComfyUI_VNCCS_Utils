/**
 * Contact points, limb IK and contact fitting for multi-character interaction presets.
 *
 * Works on any Pose Studio rig: `{ root, bones }` where `root` is the object carrying the
 * character transform (the viewer's skinned mesh, a passive rig's mesh, or the headless rig of
 * scripts/interaction_presets/rig.mjs) and `bones` maps bone names to three.js bones. Rest bone
 * rotations are identity, so bone-local axes start out world aligned. THREE is passed in
 * because Pose Studio loads three.js lazily; nothing here touches the DOM.
 */

const HAND_CHAINS = Object.freeze({ l: ["upperarm_l", "lowerarm_l", "hand_l"], r: ["upperarm_r", "lowerarm_r", "hand_r"] });
const LIMB_CHAINS = Object.freeze({
    arm_l: HAND_CHAINS.l,
    arm_r: HAND_CHAINS.r,
    leg_l: ["thigh_l", "calf_l", "foot_l"],
    leg_r: ["thigh_r", "calf_r", "foot_r"],
});
// Contact points a hand can be moved to (the arm chain is re-solved for them).
const HAND_POINTS = new Set(["palm", "fingertip", "fist", "wrist"]);
// Below this distance (world units, ~12 cm each) a contact counts as already fitted.
const FIT_EPSILON = 0.05;

const splitPointName = name => {
    const text = String(name || "");
    const side = text.endsWith("_l") ? "l" : text.endsWith("_r") ? "r" : "";
    return { base: side ? text.slice(0, -2) : text, side };
};

/** The arm chain key ("arm_l" / "arm_r") that moves a hand contact point, or null. */
export function handChainForPoint(name) {
    const { base, side } = splitPointName(name);
    return side && HAND_POINTS.has(base) ? `arm_${side}` : null;
}

/** A bone's tail relative to its head in bone-local rest space. */
export function boneTailLocal(THREE, bone) {
    const data = bone?.userData || {};
    if (data.tailLocal) return data.tailLocal.clone();
    if (Array.isArray(data.tailPos) && Array.isArray(data.headPos)) {
        return new THREE.Vector3(data.tailPos[0] - data.headPos[0], data.tailPos[1] - data.headPos[1], data.tailPos[2] - data.headPos[2]);
    }
    const child = bone?.children?.find(item => item.isBone);
    return child ? child.position.clone() : new THREE.Vector3();
}

export function boneHeadWorld(THREE, rig, name) {
    return rig.bones[name].getWorldPosition(new THREE.Vector3());
}

export function boneTailWorld(THREE, rig, name) {
    const bone = rig.bones[name];
    bone.updateWorldMatrix(true, false);
    return bone.localToWorld(boneTailLocal(THREE, bone));
}

/** Named contact points (world space) used by interaction presets and their checks. */
export function contactPoint(THREE, rig, name) {
    const { base, side } = splitPointName(name);
    const head = bone => boneHeadWorld(THREE, rig, bone);
    const tail = bone => boneTailWorld(THREE, rig, bone);
    const mid = (a, b, t = 0.5) => a.clone().lerp(b, t);
    switch (base) {
        case "palm": return mid(head(`hand_${side}`), head(`middle_01_${side}`), 0.6);
        case "fingertip": return tail(`middle_03_${side}`);
        case "fist": return mid(head(`middle_01_${side}`), head(`index_01_${side}`));
        case "wrist": return head(`hand_${side}`);
        case "elbow": return head(`lowerarm_${side}`);
        case "forearm": return mid(head(`lowerarm_${side}`), head(`hand_${side}`));
        case "shoulder": return head(`upperarm_${side}`);
        case "knee": return head(`calf_${side}`);
        case "hip": return head(`thigh_${side}`);
        case "ankle": return head(`foot_${side}`);
        case "head_top": return tail("head");
        case "head": return mid(head("head"), tail("head"), 0.45);
        case "neck": return head("neck_01");
        case "chest": return mid(head("spine_03"), tail("spine_03"), 0.55);
        case "pelvis": return head("pelvis");
        case "spine": return head("spine_03");
        default: throw new Error(`Unknown contact point ${name}`);
    }
}

function firstChildDirection(THREE, bone) {
    const child = bone.children.find(item => item.isBone);
    return (child ? child.position : boneTailLocal(THREE, bone)).clone().normalize();
}

/**
 * Rotate a bone (minimal change from its current rotation) so its head-to-child direction
 * points along worldDirection.
 */
export function aimBone(THREE, rig, name, worldDirection, childName = null) {
    const bone = rig.bones[name];
    bone.updateMatrixWorld(true);
    const localDirection = childName ? rig.bones[childName].position.clone().normalize() : firstChildDirection(THREE, bone);
    const parentQuaternion = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const desired = worldDirection.clone().normalize().applyQuaternion(parentQuaternion.invert());
    const current = localDirection.clone().applyQuaternion(bone.quaternion);
    const delta = new THREE.Quaternion().setFromUnitVectors(current, desired);
    bone.quaternion.premultiply(delta);
    bone.updateMatrixWorld(true);
}

function solveTwoBone(THREE, rig, [upperName, lowerName, endName], target, bendWorld) {
    const start = boneHeadWorld(THREE, rig, upperName);
    const upperLength = start.distanceTo(boneHeadWorld(THREE, rig, lowerName));
    const lowerLength = boneHeadWorld(THREE, rig, lowerName).distanceTo(boneHeadWorld(THREE, rig, endName));
    const toTarget = target.clone().sub(start);
    const distance = Math.min(Math.max(toTarget.length(), Math.abs(upperLength - lowerLength) + 1e-3), (upperLength + lowerLength) * 0.9995);
    const direction = toTarget.normalize();
    const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
    const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
    const bend = bendWorld.clone().sub(direction.clone().multiplyScalar(bendWorld.dot(direction)));
    if (bend.lengthSq() < 1e-8) bend.set(0, 0, 1);
    bend.normalize();
    const joint = start.clone().addScaledVector(direction, along).addScaledVector(bend, height);
    aimBone(THREE, rig, upperName, joint.clone().sub(start), lowerName);
    const endPosition = start.clone().addScaledVector(direction, distance);
    aimBone(THREE, rig, lowerName, endPosition.sub(boneHeadWorld(THREE, rig, lowerName)), endName);
}

/**
 * Two-bone IK: move a limb so that the named contact point lands on target. bendWorld is the
 * direction the elbow / knee should point to.
 */
export function reachLimb(THREE, rig, chain, target, bendWorld, contact = null) {
    const bones = LIMB_CHAINS[chain];
    const aimAt = target.clone();
    for (let iteration = 0; iteration < 8; iteration += 1) {
        solveTwoBone(THREE, rig, bones, aimAt, bendWorld);
        if (!contact) break;
        const error = target.clone().sub(contactPoint(THREE, rig, contact));
        if (error.length() < 1e-3) break;
        aimAt.add(error);
    }
}

/** The direction an elbow currently points to, away from the shoulder-to-hand line. */
function currentBend(THREE, rig, chain) {
    const [upper, lower, end] = LIMB_CHAINS[chain];
    const start = boneHeadWorld(THREE, rig, upper);
    const joint = boneHeadWorld(THREE, rig, lower);
    const axis = boneHeadWorld(THREE, rig, end).sub(start);
    if (axis.lengthSq() < 1e-8) return new THREE.Vector3(0, -0.3, -1);
    axis.normalize();
    const out = joint.sub(start);
    out.sub(axis.multiplyScalar(out.dot(axis)));
    return out.lengthSq() < 1e-8 ? new THREE.Vector3(0, -0.3, -1) : out.normalize();
}

/**
 * Re-fit an interaction preset's hand contacts on rigs whose bodies differ from the reference
 * mannequin (a child and an adult, longer arms, ...). Each contact stores the authored offset
 * between its two points (`contact.offset`, world units at the reference proportions); the
 * hands are moved with two-bone IK until that offset (scaled by the pair's mean height ratio)
 * holds again. When both points are hands they meet halfway, so a child reaches up while an
 * adult reaches down, and when the arms cannot get there the two characters step closer or
 * apart on the ground (never a carried character or its carrier). A hand on a body point moves
 * alone. Contacts without a hand or without an authored offset are left alone.
 *
 * `ratios[i]` is character i's height / reference height, `supports[i]` the index of the
 * character carrying character i (or null). Returns, per rig, the changed bone names and the
 * horizontal step `{ x, z }` added to its root position (the caller adds it to the character
 * transform).
 */
export function fitInteractionContacts(THREE, rigs, interaction, { ratios = [], supports = interaction?.supports || [], rounds = 4 } = {}) {
    const bones = rigs.map(() => new Set());
    const moves = rigs.map(() => ({ x: 0, z: 0 }));
    const contacts = (Array.isArray(interaction?.contacts) ? interaction.contacts : []).filter(contact => (
        rigs[contact?.a] && rigs[contact?.b] && contact.a !== contact.b
        && Array.isArray(contact.offset) && contact.offset.length >= 3
        && (handChainForPoint(contact.point_a) || handChainForPoint(contact.point_b))
    ));
    const carries = index => supports.some?.((support, other) => other !== index && support === index);
    const grounded = index => !Number.isInteger(supports[index]) && !carries(index);
    const errorOf = (contact, offset) => contactPoint(THREE, rigs[contact.b], contact.point_b)
        .sub(contactPoint(THREE, rigs[contact.a], contact.point_a)).sub(offset);
    const step = (index, dx, dz) => {
        const root = rigs[index].root;
        root.position.x += dx; root.position.z += dz;
        root.updateMatrixWorld(true);
        moves[index].x += dx; moves[index].z += dz;
    };
    for (let round = 0; round < rounds; round += 1) {
        let settled = true;
        for (const contact of contacts) {
            const a = rigs[contact.a], b = rigs[contact.b];
            const chainA = handChainForPoint(contact.point_a), chainB = handChainForPoint(contact.point_b);
            const ratio = ((Number(ratios[contact.a]) || 1) + (Number(ratios[contact.b]) || 1)) / 2;
            const offset = new THREE.Vector3(...contact.offset.map(Number)).multiplyScalar(ratio);
            const error = errorOf(contact, offset);
            if (error.length() < FIT_EPSILON) continue;
            settled = false;
            const pointA = contactPoint(THREE, a, contact.point_a);
            const pointB = contactPoint(THREE, b, contact.point_b);
            const share = chainA && chainB ? 0.5 : 1;
            if (chainA) {
                reachLimb(THREE, a, chainA, pointA.clone().addScaledVector(error, share), currentBend(THREE, a, chainA), contact.point_a);
                LIMB_CHAINS[chainA].slice(0, 2).forEach(name => bones[contact.a].add(name));
            }
            if (chainB) {
                reachLimb(THREE, b, chainB, pointB.clone().addScaledVector(error, -share), currentBend(THREE, b, chainB), contact.point_b);
                LIMB_CHAINS[chainB].slice(0, 2).forEach(name => bones[contact.b].add(name));
            }
            // Out of reach: close the rest on the ground, half each, then solve the arms again.
            const rest = errorOf(contact, offset);
            const last = round === rounds - 1;
            if (!last && chainA && chainB && grounded(contact.a) && grounded(contact.b) && Math.hypot(rest.x, rest.z) >= FIT_EPSILON) {
                step(contact.a, rest.x / 2, rest.z / 2);
                step(contact.b, -rest.x / 2, -rest.z / 2);
            }
        }
        if (settled) break;
    }
    return rigs.map((_rig, index) => ({ bones: [...bones[index]], move: moves[index] }));
}

/** Bone Euler rotations in degrees, the way Pose Studio stores them in `pose.bones`. */
export function readBoneRotations(rig, names) {
    const round = value => Math.round(value * 100) / 100;
    const result = {};
    for (const name of names) {
        const bone = rig.bones[name];
        if (bone) result[name] = ["x", "y", "z"].map(axis => round(bone.rotation[axis] * 180 / Math.PI));
    }
    return result;
}

/**
 * Standing height of a rest skeleton: from the lowest bone head to the highest head or tail.
 * `bones` lists `{ name, parent, position: [x, y, z], tail: [x, y, z] }` with bone-local
 * offsets (rest rotations are identity, so world heads are sums along the parent chain).
 */
export function restSkeletonHeight(bones) {
    const byName = new Map((bones || []).map(bone => [bone.name, bone]));
    const worldY = new Map();
    const headY = bone => {
        if (worldY.has(bone.name)) return worldY.get(bone.name);
        const parent = byName.get(bone.parent);
        const y = (Number(bone.position?.[1]) || 0) + (parent && parent !== bone ? headY(parent) : 0);
        worldY.set(bone.name, y);
        return y;
    };
    let low = Infinity, high = -Infinity;
    for (const bone of byName.values()) {
        const y = headY(bone);
        low = Math.min(low, y);
        high = Math.max(high, y, y + (Number(bone.tail?.[1]) || 0));
    }
    return Number.isFinite(high - low) ? high - low : 0;
}

/**
 * Standing height of a morphed body with its bone-length proportions: the morph's vertical
 * extent plus how much the proportion sliders stretch or shrink the rest skeleton
 * (`shaped` vs `unshaped` bone offsets by name, `[x, y, z]` each).
 */
export function proportionedHeight(meshExtent, skeleton, shaped, unshaped) {
    const extent = Number(meshExtent) || 0;
    if (!extent || !Array.isArray(skeleton) || !skeleton.length) return extent;
    const withOffsets = offsets => skeleton.map(bone => ({ ...bone, position: offsets?.[bone.name] || bone.position }));
    const delta = restSkeletonHeight(withOffsets(shaped)) - restSkeletonHeight(withOffsets(unshaped));
    return Number.isFinite(delta) ? Math.max(extent * 0.25, extent + delta) : extent;
}

/**
 * Rest bone offsets after the bone-length sliders: each slider group scales its child bones'
 * offsets (PoseViewerCore.updateBoneLengthScale). `lengthParams` maps groups to slider values;
 * `scaleFor(value)` and `childrenFor(group)` are the viewer's own mapping.
 */
export function shapedRestOffsets(unshaped, lengthParams, { scaleFor, childrenFor }) {
    const shaped = { ...unshaped };
    for (const [group, value] of Object.entries(lengthParams || {})) {
        const scale = Number(scaleFor(value));
        if (!Number.isFinite(scale)) continue;
        for (const child of childrenFor(group) || []) {
            if (unshaped[child]) shaped[child] = unshaped[child].map(component => component * scale);
        }
    }
    return shaped;
}

/**
 * The bone-length slider values of a body (`mesh` params, `<group>_length` keys) by slider group,
 * with the legacy shared arm / leg sliders as fallbacks; unset groups are 0.5 (unscaled).
 */
export function boneLengthParamsFromMesh(mesh) {
    const value = (key, fallback) => {
        const number = Number(mesh?.[key]);
        return Number.isFinite(number) ? number : fallback;
    };
    const arm = value("arm_length", 0.5), leg = value("leg_length", 0.5);
    const upperArm = value("upper_arm_length", arm), forearm = value("forearm_length", arm);
    const thigh = value("thigh_length", leg), shin = value("shin_length", leg);
    return {
        shoulder_l: value("shoulder_l_length", 0.5),
        shoulder_r: value("shoulder_r_length", 0.5),
        hip_l: value("hip_l_length", 0.5),
        hip_r: value("hip_r_length", 0.5),
        upper_arm_l: value("upper_arm_l_length", upperArm),
        upper_arm_r: value("upper_arm_r_length", upperArm),
        forearm_l: value("forearm_l_length", forearm),
        forearm_r: value("forearm_r_length", forearm),
        thigh_l: value("thigh_l_length", thigh),
        thigh_r: value("thigh_r_length", thigh),
        shin_l: value("shin_l_length", shin),
        shin_r: value("shin_r_length", shin),
        spine: value("spine_length", 0.5),
    };
}

/** A loaded rig's rest skeleton in the `{ name, parent, position, tail }` form of restSkeletonHeight. */
export function restSkeletonFromBones(boneList, restPositions = {}) {
    return (boneList || []).map(bone => {
        const data = bone.userData || {};
        const rest = restPositions[bone.name] || bone.position;
        const tail = Array.isArray(data.tailPos) && Array.isArray(data.headPos)
            ? data.tailPos.map((component, index) => component - data.headPos[index])
            : data.tailLocal?.toArray?.() || [0, 0, 0];
        return { name: bone.name, parent: data.parentName ?? (bone.parent?.isBone ? bone.parent.name : null), position: rest.toArray ? rest.toArray() : [...rest], tail };
    });
}
