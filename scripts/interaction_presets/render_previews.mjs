/**
 * Renders the Interactions preset previews (pose_presets/Interactions/*.webp) from the preset
 * JSONs with Pose Studio's own viewer in headless Chromium. The camera looks at the scene from a
 * fixed angle and frames the posed geometry of every character (heads, raised hands and feet
 * included) with a fixed margin, so no preview crops a body part.
 *
 *   node scripts/interaction_presets/build.mjs            # JSONs first
 *   node scripts/interaction_presets/render_previews.mjs [--only "High five"] [--chromium <path>]
 *
 * Needs Playwright: the one of tests/e2e (`npm install` there), or pass `--playwright <path to
 * playwright/index.mjs>`. Files are served to the page from the repository by request
 * interception; nothing listens on a port.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { INTERACTION_CATEGORY } from "./build.mjs";
import { PRESET_DEFINITIONS } from "./presets.mjs";

const ROOT = new URL("../../", import.meta.url);
const OUTPUT = new URL(`pose_presets/${INTERACTION_CATEGORY}/`, ROOT);
const ORIGIN = "http://vnccs-preview.localhost";

export const PREVIEW = Object.freeze({
    size: 384,
    // Camera direction from the scene centre: a little to the right and above, looking down.
    yawDeg: 20,
    pitchDeg: 8,
    fovDeg: 30,
    // Fraction of the half-frame kept free around the posed bodies.
    margin: 0.07,
    background: 0x2a2a2a,
    quality: 0.9,
});

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".gz": "application/octet-stream", ".bin": "application/octet-stream" };

const PAGE = `<!doctype html><meta charset="utf-8"><canvas id="view" width="${PREVIEW.size}" height="${PREVIEW.size}"></canvas>
<script type="module">
import { PoseViewerCore } from "/web/vnccs_pose_studio_core.js";
import { loadMorphPack, solveMorph, buildStaticModelData } from "/web/vnccs_pose_morph_runtime.mjs";
import { DEFAULT_CHARACTER_COLORS } from "/web/vnccs_pose_characters.mjs";

const LIGHTS = [
    { type: "directional", color: "#ffffff", intensity: 2.0, x: 10, y: 20, z: 30 },
    { type: "ambient", color: "#505050", intensity: 1.0, x: 0, y: 0, z: 0 },
];

// Same conversion as PoseStudioWidget.modelDataFromMorphMessage.
function modelData(pack) {
    const model = solveMorph(pack, {});
    const staticData = buildStaticModelData(pack, model.includeGenitals);
    const bones = staticData.bones.map((bone, index) => {
        const headPos = Array.from(model.bonePositions.subarray(index * 6, index * 6 + 3));
        const tailPos = Array.from(model.bonePositions.subarray(index * 6 + 3, index * 6 + 6));
        return { name: bone.name, parent: bone.parent || null, headPos, tailPos,
            length: Math.hypot(tailPos[0] - headPos[0], tailPos[1] - headPos[1], tailPos[2] - headPos[2]) };
    });
    return { status: "success", vertices: model.vertices, uvs: staticData.uvs, indices: staticData.indices, bones,
        skinIndices: staticData.skinIndices, skinWeights: staticData.skinWeights,
        landmarks: model.landmarks || {}, landmark_indices: model.landmarkIndices || {} };
}

const canvas = document.getElementById("view");
const viewer = new PoseViewerCore(canvas, { showSkeletonHelper: false, showCaptureFrame: false });
const ready = (async () => {
    await viewer.init();
    viewer.loadData(modelData(await loadMorphPack("/web/assets/pose_studio_makehuman.v2.bin.gz")), true);
    viewer.updateLights(LIGHTS);
    viewer.setDirectionalSkydomeVisible(false);
})();

// World positions of the drawn (indexed) vertices of a skinned mesh in its current pose.
function posedPoints(THREE, mesh, points) {
    mesh.updateMatrixWorld(true);
    mesh.skeleton?.update();
    const position = mesh.geometry.attributes.position;
    const drawn = new Set(mesh.geometry.index ? mesh.geometry.index.array : Array.from({ length: position.count }, (_, i) => i));
    for (const index of drawn) {
        const point = new THREE.Vector3().fromBufferAttribute(position, index);
        mesh.applyBoneTransform(index, point);
        points.push(point.applyMatrix4(mesh.matrixWorld));
    }
}

// Aim a camera along the fixed direction and fit every point inside the frame minus the margin.
function frame(THREE, camera, points, { yawDeg, pitchDeg, margin }) {
    const yaw = THREE.MathUtils.degToRad(yawDeg), pitch = THREE.MathUtils.degToRad(pitchDeg);
    const direction = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const box = new THREE.Box3().setFromPoints(points);
    const target = box.getCenter(new THREE.Vector3());
    let distance = box.getSize(new THREE.Vector3()).length() * 2;
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    let bounds = null;
    const project = () => {
        camera.position.copy(target).addScaledVector(direction, distance);
        camera.lookAt(target);
        camera.updateMatrixWorld(true);
        bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
        for (const point of points) {
            const ndc = point.clone().project(camera);
            bounds.minX = Math.min(bounds.minX, ndc.x); bounds.maxX = Math.max(bounds.maxX, ndc.x);
            bounds.minY = Math.min(bounds.minY, ndc.y); bounds.maxY = Math.max(bounds.maxY, ndc.y);
        }
    };
    for (let iteration = 0; iteration < 24; iteration += 1) {
        project();
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
        const unit = distance * tan;
        target.addScaledVector(right, (bounds.minX + bounds.maxX) / 2 * unit);
        target.addScaledVector(up, (bounds.minY + bounds.maxY) / 2 * unit);
        const extent = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2;
        distance *= extent / (1 - margin);
    }
    project();
    return bounds;
}

window.renderPreset = async (asset, options) => {
    await ready;
    const THREE = viewer.THREE;
    viewer.clearPassiveCharacters();
    const characters = asset.characters;
    characters.forEach((character, index) => {
        const pose = character.poses[asset.activeTab || 0] || character.poses[0];
        const color = DEFAULT_CHARACTER_COLORS[character.slot ?? index];
        if (index === 0) return;
        viewer.upsertPassiveCharacterFromActive(character.id, { pose, color, transform: character.transform });
    });
    const first = characters[0];
    viewer.setPose(first.poses[asset.activeTab || 0] || first.poses[0], true);
    viewer.setActiveCharacterAppearance({ color: DEFAULT_CHARACTER_COLORS[first.slot ?? 0], transform: first.transform });
    const meshes = [viewer.skinnedMesh, ...Array.from(viewer.passiveCharacters.values(), entry => entry.mesh)];
    // Only the mannequins and the lights: no grid, markers, gizmos or capture frame.
    const hidden = [];
    const hide = object => { if (object.visible) { hidden.push(object); object.visible = false; } };
    for (const child of viewer.scene.children) {
        if (child.isLight || child.isCamera) continue;
        if (!meshes.includes(child)) { hide(child); continue; }
        // Joint markers and helpers hang below the mannequin; its bones stay.
        child.traverse(object => { if (object !== child && !object.isBone) hide(object); });
    }
    const points = [];
    for (const mesh of meshes) posedPoints(THREE, mesh, points);
    const camera = new THREE.PerspectiveCamera(options.fovDeg, 1, 0.1, 1000);
    const bounds = frame(THREE, camera, points, options);
    const background = viewer.scene.background;
    viewer.scene.background = new THREE.Color(options.background);
    viewer.renderer.setPixelRatio(1);
    viewer.renderer.setSize(options.size, options.size, false);
    viewer.renderer.render(viewer.scene, camera);
    const url = canvas.toDataURL("image/webp", options.quality);
    viewer.scene.background = background;
    hidden.forEach(child => { child.visible = true; });
    return { url, bounds };
};
window.previewReady = ready.then(() => true);
</script>`;

function argument(name) {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : null;
}

async function loadChromium(explicit) {
    const pick = module => module.chromium || module.default?.chromium;
    if (explicit) return pick(await import(pathToFileURL(explicit).href));
    const require = createRequire(new URL("tests/e2e/package.json", ROOT));
    for (const name of ["playwright", "@playwright/test"]) {
        try { return pick(await import(pathToFileURL(require.resolve(name)).href)); } catch { /* try the next one */ }
    }
    throw new Error("Playwright not found: run `npm install` in tests/e2e or pass --playwright <path to playwright/index.mjs>.");
}

async function serveRepository(route) {
    const url = new URL(route.request().url());
    if (url.pathname === "/preview.html") return route.fulfill({ status: 200, contentType: "text/html", body: PAGE });
    const file = new URL(`.${decodeURIComponent(url.pathname)}`, ROOT);
    if (!fileURLToPath(file).startsWith(fileURLToPath(ROOT)) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    const extension = url.pathname.slice(url.pathname.lastIndexOf("."));
    return route.fulfill({ status: 200, contentType: MIME[extension] || "application/octet-stream", body: fs.readFileSync(file) });
}

export async function renderPreviews({ only = null, chromiumPath = null, playwright = null } = {}) {
    const chromium = await loadChromium(playwright);
    const browser = await chromium.launch({
        ...(chromiumPath ? { executablePath: chromiumPath } : {}),
        args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
    try {
        const page = await browser.newPage({ viewport: { width: PREVIEW.size, height: PREVIEW.size } });
        page.on("pageerror", error => console.error(`page: ${error.message}`));
        await page.route(`${ORIGIN}/**`, serveRepository);
        await page.goto(`${ORIGIN}/preview.html`);
        await page.waitForFunction(() => window.previewReady, null, { timeout: 60_000 });
        await page.evaluate(() => window.previewReady);
        const results = [];
        for (const definition of PRESET_DEFINITIONS) {
            if (only && definition.name !== only) continue;
            const asset = JSON.parse(fs.readFileSync(new URL(`${definition.name}.json`, OUTPUT), "utf8"));
            const { url, bounds } = await page.evaluate(([item, options]) => window.renderPreset(item, options), [asset, PREVIEW]);
            const [, base64] = url.split(",");
            fs.writeFileSync(new URL(`${definition.name}.webp`, OUTPUT), Buffer.from(base64, "base64"));
            results.push({ name: definition.name, bounds });
            const fmt = value => value.toFixed(3);
            console.log(`${definition.name}: x ${fmt(bounds.minX)}..${fmt(bounds.maxX)}, y ${fmt(bounds.minY)}..${fmt(bounds.maxY)}`);
        }
        return results;
    } finally {
        await browser.close();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    await renderPreviews({
        only: argument("--only"),
        chromiumPath: argument("--chromium") || process.env.PW_CHROMIUM_PATH || null,
        playwright: argument("--playwright"),
    });
}
