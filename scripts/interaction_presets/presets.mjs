/**
 * Interaction preset definitions. Each preset places its mannequins, poses them
 * with two-bone IK towards shared contact points and lists the contacts that
 * must meet at the default mannequin proportions (checked by
 * tests/test_pose_interaction_presets.mjs).
 */
import {
    THREE, aim, applyPose, buildRig, curl, orientHand, point, reach, readPose, rotate, setRotation, twist,
} from "./rig.mjs";

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function context(rigs) {
    const dir = (index, x, y, z) => V(x, y, z).applyQuaternion(rigs[index].root.quaternion);
    const ctx = {
        rigs,
        V,
        dir,
        point: (index, name) => point(rigs[index], name),
        reach: (index, chain, target, bend, contact) => reach(rigs[index], chain, target, bend, contact),
        orientHand: (index, side, finger, palm) => orientHand(rigs[index], side, finger, palm),
        curl: (index, side, degrees, thumb) => curl(rigs[index], side, degrees, thumb),
        aim: (index, bone, direction, child) => aim(rigs[index], bone, direction, child),
        rotate: (index, bone, euler) => rotate(rigs[index], bone, euler),
        set: (index, bone, euler) => setRotation(rigs[index], bone, euler),
        twist: (index, bone, degrees) => twist(rigs[index], bone, degrees),
    };
    const sideSign = side => (side === "l" ? 1 : -1);
    /** Put a hand's contact point on target with the given finger / palm directions. */
    ctx.grip = (index, side, target, finger, palm, bend, contact = `palm_${side}`) => {
        for (let pass = 0; pass < 6; pass += 1) {
            orientHand(rigs[index], side, finger, palm);
            reach(rigs[index], `arm_${side}`, target, bend, contact);
        }
        orientHand(rigs[index], side, finger, palm);
    };
    /** Relaxed hanging arm (upper arm slightly out, forearm slightly forward). */
    ctx.relaxArm = (index, side, out = 0.12, forward = 0.25) => {
        const s = sideSign(side);
        aim(rigs[index], `upperarm_${side}`, dir(index, s * out, -1, 0.02), `lowerarm_${side}`);
        aim(rigs[index], `lowerarm_${side}`, dir(index, s * 0.04, -1, forward), `hand_${side}`);
        curl(rigs[index], side, 12, 5);
    };
    ctx.sideSign = sideSign;
    /** World position of a point given in a character's local (rest) space. */
    ctx.local = (index, x, y, z) => rigs[index].root.localToWorld(V(x, y, z));
    /** Index finger extended, the others curled. */
    ctx.pointFinger = (index, side) => {
        curl(rigs[index], side, 70, 30);
        for (const joint of ["01", "02", "03"]) setRotation(rigs[index], `index_${joint}_${side}`, [0, 0, 0]);
    };
    return ctx;
}

export function buildPresetScene(definition, meshes = []) {
    const rigs = definition.characters.map((_character, index) => buildRig(meshes[index] || {}));
    definition.characters.forEach((character, index) => {
        applyPose(rigs[index], { modelRotation: character.rotation || [0, 0, 0] }, character.transform);
        if (character.orient) {
            // Body up / front directions in world space, converted to the stored Euler modelRotation.
            const up = V(...character.orient.up).normalize();
            const front = V(...character.orient.front);
            front.sub(up.clone().multiplyScalar(front.dot(up))).normalize();
            const left = new THREE.Vector3().crossVectors(up, front);
            rigs[index].root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, up, front));
            rigs[index].root.updateMatrixWorld(true);
        }
    });
    definition.pose(context(rigs));
    const report = definition.contacts.map(([a, pointA, b, pointB, tolerance = 0.6]) => ({
        label: `${a}.${pointA}~${b}.${pointB}`,
        distance: point(rigs[a], pointA).distanceTo(point(rigs[b], pointB)),
        tolerance,
    }));
    return {
        characters: rigs.map((rig, index) => ({
            mesh: meshes[index] || {},
            pose: readPose(rig),
            transform: { x: 0, y: 0, z: 0, zoom: 1, ...definition.characters[index].transform },
            height: rig.height,
        })),
        report,
    };
}

const FACE_PLUS_X = [0, 90, 0];
const FACE_MINUS_X = [0, -90, 0];
// Feet rest on y = -8.44 at the default proportions; the mesh origin sits near the pelvis.
export const GROUND_Y = -8.44;

export const PRESET_DEFINITIONS = [
    {
        key: "hug",
        name: "Hug",
        prompt: "two people hugging each other tightly",
        characters: [
            { transform: { x: -1.5 }, rotation: FACE_PLUS_X },
            { transform: { x: 1.5 }, rotation: FACE_MINUS_X },
        ],
        contacts: [[0, "chest", 1, "chest", 3.3], [0, "palm_l", 1, "spine", 1.9], [0, "palm_r", 1, "spine", 1.9], [1, "palm_l", 0, "pelvis", 1.9], [1, "palm_r", 0, "pelvis", 1.9]],
        pose(s) {
            for (const index of [0, 1]) {
                s.set(index, "spine_02", [4, 0, 0]);
                s.set(index, "head", [0, 38, 6]);
            }
            // A reaches over the shoulders, B around the waist; both hands rest on the partner's back.
            for (const side of ["l", "r"]) {
                const sign = s.sideSign(side);
                s.grip(0, side, s.local(1, sign * -0.55, 2.3, -1.05), s.dir(1, sign * 1, -0.2, 0), s.dir(1, 0, 0, 1), s.dir(0, sign, -0.6, -0.5));
                s.curl(0, side, 18, 8);
                s.grip(1, side, s.local(0, sign * -0.6, 0.0, -1.0), s.dir(0, sign * 1, 0.1, 0), s.dir(0, 0, 0, 1), s.dir(1, sign, -0.8, -0.5));
                s.curl(1, side, 18, 8);
            }
        },
    },
    {
        key: "handshake",
        name: "Handshake",
        prompt: "two people shaking hands",
        characters: [
            { transform: { x: -2.7 }, rotation: FACE_PLUS_X },
            { transform: { x: 2.7 }, rotation: FACE_MINUS_X },
        ],
        contacts: [[0, "palm_r", 1, "palm_r"]],
        pose(s) {
            const contact = s.V(0, -0.2, 0);
            for (const [index, side] of [[0, 1], [1, -1]]) {
                s.grip(index, "r", contact.clone().add(s.V(0, 0, 0.18 * side)), s.dir(index, 0, -0.1, 1), s.dir(index, 1, 0, 0), s.dir(index, -1, -1.2, -0.4));
                s.curl(index, "r", 38, 12);
                s.relaxArm(index, "l");
                s.set(index, "head", [8, 0, 0]);
            }
        },
    },
    {
        key: "high_five",
        name: "High five",
        prompt: "two people giving each other a high five",
        characters: [
            { transform: { x: -3.0 }, rotation: FACE_PLUS_X },
            { transform: { x: 3.0 }, rotation: FACE_MINUS_X },
        ],
        contacts: [[0, "palm_r", 1, "palm_l"]],
        pose(s) {
            const contact = s.V(0, 5.2, 1.2);
            s.grip(0, "r", contact.clone().add(s.V(-0.16, 0, 0)), s.V(0.1, 1, 0), s.V(1, 0, 0), s.dir(0, -1, -0.4, -0.6));
            s.grip(1, "l", contact.clone().add(s.V(0.16, 0, 0)), s.V(-0.1, 1, 0), s.V(-1, 0, 0), s.dir(1, 1, -0.4, -0.6));
            s.curl(0, "r", -4, 0);
            s.curl(1, "l", -4, 0);
            s.relaxArm(0, "l");
            s.relaxArm(1, "r");
            for (const index of [0, 1]) s.set(index, "head", [-12, 0, 0]);
        },
    },
    {
        key: "kiss_on_the_cheek",
        closeup: { pos: [-1, 4, 9], target: [-0.6, 3.6, 0] },
        name: "Kiss on the cheek",
        prompt: "a person kissing another person on the cheek",
        characters: [
            { transform: { x: -2.2, z: 0.1 }, rotation: FACE_PLUS_X },
            { transform: { x: 0.9, z: 0 }, rotation: [0, -20, 0] },
        ],
        contacts: [[0, "head", 1, "head", 1.8], [0, "palm_r", 1, "shoulder_r", 1.2]],
        pose(s) {
            s.set(0, "spine_02", [9, 0, 0]);
            s.set(0, "spine_03", [6, 0, 0]);
            s.set(0, "neck_01", [4, -8, 0]);
            s.set(0, "head", [4, -12, -10]);
            s.grip(0, "r", s.local(1, -1.35, 3.3, -0.1), s.dir(1, 0.2, -0.3, -1), s.dir(1, 0, -1, 0), s.dir(0, -1, -0.5, -0.6));
            s.curl(0, "r", 20, 6);
            s.relaxArm(0, "l");
            s.set(1, "head", [-4, 8, 14]);
            s.relaxArm(1, "l");
            s.relaxArm(1, "r");
        },
    },
    {
        key: "arm_around_the_shoulder",
        name: "Arm around the shoulder",
        prompt: "two friends standing side by side, one with an arm around the other's shoulder",
        characters: [
            { transform: { x: -1.45 } },
            { transform: { x: 1.45 } },
        ],
        contacts: [[0, "palm_l", 1, "shoulder_l", 0.9], [0, "shoulder_l", 1, "shoulder_r", 1.2], [1, "palm_r", 0, "pelvis", 1.9]],
        pose(s) {
            s.grip(0, "l", s.local(1, 1.35, 3.35, 0.05), s.V(0.2, -0.3, 1), s.V(0, -1, 0), s.V(-0.1, 0.2, -1));
            s.curl(0, "l", 22, 8);
            s.relaxArm(0, "r");
            s.set(0, "head", [2, -6, 8]);
            s.grip(1, "r", s.local(0, -0.1, -0.1, -1.0), s.V(-1, 0.1, 0), s.V(0, 0, 1), s.V(0.2, -0.5, -1));
            s.curl(1, "r", 15, 6);
            s.relaxArm(1, "l");
            s.set(1, "head", [0, 6, -6]);
        },
    },
    {
        key: "princess_carry",
        name: "Princess carry",
        supports: [null, 0],
        prompt: "a person carrying another person in their arms, princess carry",
        characters: [
            { transform: { x: 0, z: -0.3 } },
            { transform: { x: 0.9, y: -0.4, z: 1.5 }, orient: { up: [-1, 0.4, 0], front: [0, 1, 0.15] } },
        ],
        contacts: [[0, "palm_r", 1, "spine", 1.4], [0, "palm_l", 1, "knee_l", 1.4], [1, "palm_l", 0, "neck", 1.3]],
        pose(s) {
            s.set(0, "spine_01", [-6, 0, 0]);
            s.set(0, "head", [18, -10, 0]);
            // Carried person: hips and knees bent over the carrier's left forearm.
            for (const side of ["l", "r"]) {
                s.set(1, `thigh_${side}`, [-75, 0, 0]);
                s.set(1, `calf_${side}`, [85, 0, 0]);
                s.set(1, `foot_${side}`, [20, 0, 0]);
            }
            s.set(1, "spine_02", [6, 0, 0]);
            s.set(1, "head", [-8, -25, 0]);
            s.grip(0, "r", s.point(1, "spine").add(s.dir(1, 0, 0, -1.1)), s.dir(1, 1, 0, 0), s.dir(1, 0, 0, 1), s.V(-0.4, -1, -0.6));
            s.grip(0, "l", s.point(1, "knee_l").add(s.dir(1, -0.4, -0.2, -0.75)), s.dir(1, -1, 0, 0), s.dir(1, 0, 1, 0.3), s.V(0.4, -1, -0.6));
            s.curl(0, "r", 25, 10);
            s.curl(0, "l", 25, 10);
            s.grip(1, "l", s.local(0, -0.9, 3.9, -0.7), s.dir(0, -1, 0, 0), s.dir(0, 0, 0, 1), s.dir(1, 0, 0, -1));
            s.curl(1, "l", 20, 8);
            s.aim(1, "upperarm_r", s.V(0.15, -1, 0.6));
            s.aim(1, "lowerarm_r", s.V(-0.6, 0.2, 0.8));
        },
    },
    {
        key: "piggyback",
        name: "Piggyback",
        supports: [null, 0],
        prompt: "a person giving another person a piggyback ride",
        characters: [
            { transform: { x: 0, z: 0.3 } },
            { transform: { x: 0, y: 0.9, z: -1.45 } },
        ],
        contacts: [[1, "chest", 0, "spine", 2.7], [0, "palm_l", 1, "knee_l", 1.0], [0, "palm_r", 1, "knee_r", 1.0]],
        pose(s) {
            s.set(0, "spine_01", [10, 0, 0]);
            s.set(0, "spine_02", [8, 0, 0]);
            s.set(0, "head", [-14, 0, 0]);
            for (const side of ["l", "r"]) {
                const sign = s.sideSign(side);
                s.set(0, `thigh_${side}`, [-18, 0, 0]);
                s.set(0, `calf_${side}`, [24, 0, 0]);
                s.set(0, `foot_${side}`, [-6, 0, 0]);
                // Rider's legs wrap around the carrier's waist.
                s.aim(1, `thigh_${side}`, s.V(sign * 0.4, -0.05, 1));
                s.aim(1, `calf_${side}`, s.V(sign * 0.1, -1, -0.15));
                s.set(1, `foot_${side}`, [30, 0, 0]);
                s.grip(0, side, s.point(1, `knee_${side}`).add(s.V(sign * 0.1, -0.55, -0.2)), s.V(0, 0.2, -1), s.V(0, 1, 0), s.V(sign * 1, -0.3, -0.6));
                s.curl(0, side, 30, 10);
                // Rider's arms over the carrier's shoulders, hands meeting on the chest.
                s.grip(1, side, s.local(0, sign * 0.25, 2.1, 1.35), s.V(-sign, -0.4, 0.2), s.V(0, 0, -1), s.V(sign, 0.2, -0.3));
                s.curl(1, side, 22, 8);
            }
            s.set(1, "spine_02", [12, 0, 0]);
            s.set(1, "head", [6, 20, 10]);
        },
    },
    {
        key: "punch_and_block",
        name: "Punch and block",
        prompt: "one person throwing a punch while the other blocks it with a forearm",
        characters: [
            { transform: { x: -2.1, z: 0.3 }, rotation: FACE_PLUS_X },
            { transform: { x: 3.0, z: -0.2 }, rotation: [0, -95, 0] },
        ],
        contacts: [[0, "fist_r", 1, "forearm_l", 0.8]],
        pose(s) {
            // Attacker: left leg forward, right fist driven at the defender's head.
            s.set(0, "thigh_l", [-28, 0, 4]);
            s.set(0, "calf_l", [26, 0, 0]);
            s.set(0, "thigh_r", [14, 0, -4]);
            s.set(0, "spine_02", [6, -14, 0]);
            s.set(0, "spine_03", [4, -10, 0]);
            s.set(0, "head", [0, 16, 0]);
            // Defender: braced stance, right fist guarding the chin.
            s.set(1, "thigh_r", [-18, 0, -6]);
            s.set(1, "calf_r", [22, 0, 0]);
            s.set(1, "thigh_l", [10, 0, 6]);
            s.set(1, "spine_02", [-4, 8, 0]);
            s.set(1, "head", [8, -6, 0]);
            s.grip(1, "r", s.local(1, -0.5, 3.6, 1.5), s.dir(1, 0.3, 1, 0.1), s.dir(1, 1, 0, 0), s.dir(1, -1, -1, 0), "fist_r");
            s.curl(1, "r", 80, 40);
            s.reach(1, "arm_l", s.local(1, 0.45, 4.4, 1.9), s.dir(1, 0.6, -1, 0.1), "wrist_l");
            s.orientHand(1, "l", s.V(0, 1, 0.1), s.dir(1, 0, 0, -1));
            s.curl(1, "l", 70, 30);
            const block = s.point(1, "forearm_l").add(s.dir(1, 0, 0, 0.5));
            s.grip(0, "r", block, s.dir(0, 0, -0.1, 1), s.dir(0, 1, 0, 0), s.dir(0, -1, -0.3, -0.2), "fist_r");
            s.curl(0, "r", 80, 40);
            s.grip(0, "l", s.local(0, 0.9, 3.0, 1.4), s.dir(0, -0.2, 1, 0.2), s.dir(0, -1, 0, 0), s.dir(0, 1, -1, 0), "fist_l");
            s.curl(0, "l", 80, 40);
        },
    },
    {
        key: "sitting_side_by_side",
        name: "Sitting side by side",
        prompt: "two people sitting side by side on the ground, hugging their knees",
        characters: [
            { transform: { x: -1.45, y: -6.9 } },
            { transform: { x: 1.45, y: -6.9 } },
        ],
        contacts: [[0, "shoulder_l", 1, "shoulder_r", 0.9], [0, "palm_l", 0, "knee_l", 1.6], [1, "palm_r", 1, "knee_r", 1.6]],
        pose(s) {
            for (const index of [0, 1]) {
                for (const side of ["l", "r"]) {
                    const sign = s.sideSign(side);
                    // Knees drawn up, feet flat on the ground in front of the hips.
                    s.reach(index, `leg_${side}`, s.local(index, sign * 1.15, 0, 3.6).setY(GROUND_Y + 0.55), s.dir(index, sign * 0.1, 1, 0.3), `ankle_${side}`);
                    s.set(index, `foot_${side}`, [-20, 0, 0]);
                }
                s.set(index, "spine_01", [-8, 0, 0]);
                s.set(index, "spine_02", [12, 0, 0]);
                s.set(index, "spine_03", [8, 0, 0]);
            }
            for (const index of [0, 1]) {
                for (const side of ["l", "r"]) {
                    const sign = s.sideSign(side);
                    const knee = s.point(index, `knee_${side}`);
                    s.grip(index, side, knee.add(s.dir(index, sign * -0.4, -0.9, 0.9)), s.dir(index, -sign, -0.2, 0), s.dir(index, 0, 0, -1), s.dir(index, sign, 0, -0.3));
                    s.curl(index, side, 25, 10);
                }
            }
            s.set(0, "head", [-6, -18, 14]);
            s.set(1, "head", [-6, 12, 0]);
        },
    },
    {
        key: "whisper",
        name: "Whisper",
        prompt: "a person whispering into another person's ear",
        characters: [
            { transform: { x: -2.35, z: 0.25 }, rotation: [0, 80, 0] },
            { transform: { x: 0.9, z: 0 }, rotation: [0, -15, 0] },
        ],
        contacts: [[0, "head", 1, "head", 1.8], [0, "palm_r", 0, "head", 1.45]],
        pose(s) {
            s.set(0, "spine_02", [8, 0, 0]);
            s.set(0, "spine_03", [4, 0, 0]);
            s.set(0, "neck_01", [6, 0, 0]);
            s.set(0, "head", [6, 0, -14]);
            const mouth = s.point(0, "head").add(s.dir(0, 0, -0.5, 0.9));
            s.grip(0, "r", mouth.add(s.dir(0, -0.5, 0, 0.25)), s.dir(0, 0.2, 1, 0.3), s.dir(0, 1, 0, 0.2), s.dir(0, -1, -1, 0));
            s.curl(0, "r", 25, 8);
            s.relaxArm(0, "l");
            s.set(1, "head", [4, 0, 8]);
            s.set(1, "spine_02", [0, 0, 4]);
            s.relaxArm(1, "l");
            s.relaxArm(1, "r");
        },
    },
    {
        key: "pointing_at_each_other",
        name: "Pointing at each other",
        prompt: "two people pointing at each other",
        characters: [
            { transform: { x: -3.6 }, rotation: FACE_PLUS_X },
            { transform: { x: 3.6 }, rotation: FACE_MINUS_X },
        ],
        contacts: [[0, "fingertip_r", 1, "fingertip_r", 2.3]],
        aims: [[0, "index_r", 1, "head"], [1, "index_r", 0, "head"]],
        pose(s) {
            for (const [index, other] of [[0, 1], [1, 0]]) {
                const head = s.point(other, "head");
                const shoulder = s.point(index, "shoulder_r");
                const direction = head.clone().sub(shoulder).normalize();
                s.pointFinger(index, "r");
                s.grip(index, "r", shoulder.clone().addScaledVector(direction, 3.9), direction, s.V(0, -1, 0), s.dir(index, -1, -1, -0.5), "fist_r");
                s.relaxArm(index, "l");
                s.set(index, "head", [-4, 0, 0]);
            }
        },
    },
    {
        key: "dancing_pair",
        name: "Dancing pair",
        prompt: "a couple dancing together in a closed ballroom hold",
        characters: [
            { transform: { x: -1.55, z: 0.3 }, rotation: FACE_PLUS_X },
            { transform: { x: 1.55, z: -0.3 }, rotation: FACE_MINUS_X },
        ],
        contacts: [[0, "palm_l", 1, "palm_r"], [0, "palm_r", 1, "spine", 1.6], [1, "palm_l", 0, "shoulder_r", 1.0]],
        pose(s) {
            // Joined hands out to the side at shoulder height.
            const joined = s.V(0, 3.0, -3.2);
            s.grip(0, "l", joined.clone().add(s.V(-0.17, 0, 0)), s.V(0, 1, -0.2), s.V(1, 0, 0), s.V(-0.3, -1, 0.3));
            s.grip(1, "r", joined.clone().add(s.V(0.17, 0, 0)), s.V(0, 1, -0.2), s.V(-1, 0, 0), s.V(0.3, -1, 0.3));
            s.curl(0, "l", 25, 10);
            s.curl(1, "r", 25, 10);
            // Lead's right hand on the partner's shoulder blade, partner's left hand on the lead's shoulder.
            s.grip(0, "r", s.local(1, 0.7, 1.9, -1.05), s.dir(1, 1, 0, 0), s.dir(1, 0, 0, 1), s.dir(0, -1, -0.5, -0.3));
            s.curl(0, "r", 12, 4);
            s.grip(1, "l", s.local(0, -1.45, 3.35, 0.2), s.dir(0, -1, -0.3, -0.2), s.V(0, -1, 0), s.dir(1, 1, -1, -0.3));
            s.curl(1, "l", 18, 6);
            s.set(0, "head", [-4, -24, 0]);
            s.set(1, "head", [-8, -30, 6]);
            s.set(1, "spine_03", [-6, 0, 0]);
            s.set(0, "thigh_l", [-12, 0, 0]);
            s.set(1, "thigh_r", [8, 0, 0]);
        },
    },
    {
        key: "group_photo",
        name: "Group photo",
        prompt: "three friends posing together for a group photo, arms around each other",
        characters: [
            { transform: { x: 0, z: 0.2 } },
            { transform: { x: 2.95, z: -0.1 }, rotation: [0, -12, 0] },
            { transform: { x: -2.95, z: -0.1 }, rotation: [0, 12, 0] },
        ],
        contacts: [[0, "palm_l", 1, "shoulder_l", 0.95], [0, "palm_r", 2, "shoulder_r", 0.95], [1, "palm_r", 0, "pelvis", 1.9], [2, "palm_l", 0, "pelvis", 1.9]],
        pose(s) {
            s.grip(0, "l", s.local(1, 1.3, 3.35, 0.05), s.V(0.25, -0.3, 1), s.V(0, -1, 0), s.V(0, 0.3, -1));
            s.grip(0, "r", s.local(2, -1.3, 3.35, 0.05), s.V(-0.25, -0.3, 1), s.V(0, -1, 0), s.V(0, 0.3, -1));
            s.curl(0, "l", 22, 8);
            s.curl(0, "r", 22, 8);
            s.set(0, "head", [-4, 0, 0]);
            s.grip(1, "r", s.local(0, 0.3, -0.1, -1.05), s.V(-1, 0.1, 0), s.V(0, 0, 1), s.V(0.3, -0.6, -1));
            s.grip(2, "l", s.local(0, -0.3, -0.1, -1.05), s.V(1, 0.1, 0), s.V(0, 0, 1), s.V(-0.3, -0.6, -1));
            s.curl(1, "r", 15, 6);
            s.curl(2, "l", 15, 6);
            // Outer hands: peace sign at shoulder height and a thumbs-free wave.
            s.grip(1, "l", s.local(1, 1.9, 3.6, 1.0), s.dir(1, 0, 1, 0.1), s.dir(1, 0, 0, 1), s.dir(1, 1, -1, 0));
            s.curl(1, "l", 70, 30);
            for (const finger of ["index", "middle"]) for (const joint of ["01", "02", "03"]) s.set(1, `${finger}_${joint}_l`, [0, 0, 0]);
            s.relaxArm(2, "r");
            s.set(1, "head", [0, 0, -10]);
            s.set(2, "head", [0, 0, 10]);
        },
    },
];
