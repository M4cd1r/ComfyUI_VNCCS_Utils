import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { test, expect } from "@playwright/test";
import { importImageLayer, openUnicanvas, setLayerNaming } from "./helpers/app.mjs";

// Plan 10.3 (#22): the standalone tab saves into a project (incremental blob uploads, scene tabs),
// and the document survives reloads, scene switches and large states. No GPU: the draw route is
// stubbed with the fixture image.
const FIXTURE = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const FIXTURE_DATA_URL = `data:image/png;base64,${readFileSync(FIXTURE).toString("base64")}`;
const SHELL = ".vnccs-uc2-standalone-shell";

const hook = (page, name, ...args) => page.evaluate(([fn, rest]) => globalThis.__VNCCS_UC_E2E__[fn](...rest), [name, args]);
const project = (page) => hook(page, "getProjectInfo");
const layers = (page) => hook(page, "listLayers");

async function snapshot(page) {
  const out = {};
  for (const layer of await layers(page)) out[layer.id] = (await hook(page, "getLayerPixels", layer.id)).dataURL;
  return out;
}

/** Waits until the autosave has stored the current document (status Saved, nothing pending). */
async function waitSaved(page, minRev = 0) {
  await page.waitForTimeout(1600); // the state upload is debounced (1.2 s)
  await expect.poll(async () => {
    const info = await project(page);
    return info?.status === "saved" && info.rev > minRev;
  }, { timeout: 60_000 }).toBe(true);
  await expect(page.locator(`${SHELL} .vnccs-uc-project-chip`)).toHaveText("Saved");
  return project(page);
}

async function stroke(page, from, to) {
  await page.locator(`${SHELL} .vnccs-uc-tool[data-tool="brush"]`).click();
  const box = await page.locator(`${SHELL} canvas.vnccs-uc-stage`).first().boundingBox();
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 10 });
  await page.mouse.up();
}

async function createProject(page, name) {
  await page.locator(`${SHELL} .vnccs-uc-project-name`).click();
  await expect(page.locator(`${SHELL} .vnccs-uc-project-browser`)).toBeVisible();
  await page.locator(`${SHELL} .vnccs-uc-project-browser-head button`, { hasText: "New" }).click();
  const input = page.locator(`${SHELL} .vnccs-uc-modal .vnccs-uc-field input`);
  await input.fill(name);
  await input.press("Enter");
  await expect(page.locator(`${SHELL} .vnccs-uc-project-name span`)).toHaveText(name, { timeout: 30_000 });
  return project(page);
}

// A PNG of random RGBA noise (incompressible): `size`^2 * 4 bytes of payload.
function noisePng(size, seed) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let state = seed >>> 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (i % (size * 4 + 1) === 0) { raw[i] = 0; continue; }
    state = (state * 1664525 + 1013904223) >>> 0;
    raw[i] = (i % 4 === 0) ? 255 : state >>> 24; // opaque alpha keeps the pixels exact through canvas
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("projects: create, save a painted and generated scene, restore it after a reload", async ({ page, request }) => {
  await openUnicanvas(page);
  await setLayerNaming(page, { autoFile: false }); // keep imported layers where the spec expects them
  const created = await createProject(page, `E2E project ${Date.now()}`);
  expect(created.scenes).toHaveLength(1);

  await stroke(page, [0.4, 0.4], [0.55, 0.5]);
  await page.route("**/vnccs/unicanvas/draw", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ images: [FIXTURE_DATA_URL], performance: "stub" }),
  }));
  await page.locator(`${SHELL} textarea[data-setting="positive"]`).fill("a red lighthouse at dusk");
  await page.locator(`${SHELL} button`, { hasText: "GENERATE" }).first().click();
  const accept = page.locator(`${SHELL} [title="Accept as layer"]`).first();
  await expect(accept).toBeVisible({ timeout: 30_000 });
  const before = (await layers(page)).length;
  await accept.click();
  await expect.poll(async () => (await layers(page)).length).toBe(before + 1);
  const saved = await waitSaved(page, 1);
  const expected = await snapshot(page);

  // The scene on the server holds blob refs, not inline pixels.
  const scene = await (await request.get(`/vnccs/unicanvas/projects/${saved.projectId}/scenes/${saved.sceneId}`)).json();
  expect(JSON.stringify(scene.state)).not.toContain("data:image/png");
  expect(scene.state.layers.some((layer) => layer.dataURL?.blob)).toBe(true);

  await page.reload({ waitUntil: "domcontentloaded" });
  await openUnicanvas(page, { navigate: false });
  await expect.poll(async () => (await project(page))?.sceneId, { timeout: 30_000 }).toBe(saved.sceneId);
  await expect.poll(async () => Object.keys(await snapshot(page)).sort().join(","), { timeout: 30_000 }).toBe(Object.keys(expected).sort().join(","));
  expect(await snapshot(page)).toEqual(expected);
  await expect(page.locator(`${SHELL} .vnccs-uc-project-name span`)).toHaveText(created.name);

  // Scene 2: switching back and forth keeps both intact and never shows a blank stage.
  await page.locator(`${SHELL} .vnccs-uc-scene-add`).click();
  await expect.poll(async () => (await project(page)).scenes.length, { timeout: 30_000 }).toBe(2);
  await expect.poll(async () => (await project(page)).sceneId).not.toBe(saved.sceneId);
  const second = await project(page);
  await stroke(page, [0.3, 0.6], [0.6, 0.7]);
  await waitSaved(page, 1);
  const expectedSecond = await snapshot(page);
  expect(expectedSecond).not.toEqual(expected);

  await page.evaluate(() => {
    const stage = document.querySelector(".vnccs-uc2-standalone-shell canvas.vnccs-uc-stage");
    const probe = document.createElement("canvas");
    const watch = { frames: 0, blankFrames: 0, stop: false };
    globalThis.__projectsBlankWatch = watch;
    const tick = () => {
      if (watch.stop) return;
      probe.width = stage.width;
      probe.height = stage.height;
      const ctx = probe.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(stage, 0, 0);
      const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
      let opaque = false;
      for (let i = 3; i < data.length; i += 4 * 97) if (data[i] > 0) { opaque = true; break; }
      watch.frames += 1;
      if (!opaque) watch.blankFrames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (const [target, pixels] of [[saved.sceneId, expected], [second.sceneId, expectedSecond], [saved.sceneId, expected]]) {
    await page.locator(`${SHELL} .vnccs-uc-scene-tab[data-scene-id="${target}"]`).click();
    await expect.poll(async () => (await project(page)).sceneId, { timeout: 30_000 }).toBe(target);
    await expect.poll(() => snapshot(page), { timeout: 30_000 }).toEqual(pixels);
  }
  const watch = await page.evaluate(() => { globalThis.__projectsBlankWatch.stop = true; return globalThis.__projectsBlankWatch; });
  expect(watch.frames).toBeGreaterThan(5);
  expect(watch.blankFrames).toBe(0);

  // Duplicate a scene: the copy shares every blob, so nothing is uploaded again.
  const blobPuts = [];
  page.on("request", (req) => {
    if (req.method() === "PUT" && req.url().includes("/blobs/")) blobPuts.push(req.url());
  });
  await page.locator(`${SHELL} .vnccs-uc-scene-tab[data-scene-id="${saved.sceneId}"]`).click({ button: "right" });
  await page.locator(".vnccs-uc-scene-menu button", { hasText: "Duplicate" }).click();
  await expect.poll(async () => (await project(page)).scenes.length, { timeout: 30_000 }).toBe(3);
  await expect.poll(() => snapshot(page), { timeout: 30_000 }).toEqual(expected);
  const copy = await project(page);
  expect(copy.sceneId).not.toBe(saved.sceneId);
  await page.waitForTimeout(2500);
  expect(blobPuts).toEqual([]);

  await request.delete(`/vnccs/unicanvas/projects/${saved.projectId}`);
});

test("projects: a 10 MB standalone document persists across a reload", async ({ page }) => {
  const dir = join(tmpdir(), "vnccs-projects-e2e");
  mkdirSync(dir, { recursive: true });
  await openUnicanvas(page);
  await setLayerNaming(page, { autoFile: false }); // keep imported layers where the spec expects them
  const uploaded = [];
  page.on("request", (req) => {
    if (req.method() === "PUT" && req.url().includes("/blobs/")) uploaded.push(req.postDataBuffer()?.length || 0);
  });
  for (const seed of [1, 2, 3]) {
    const file = join(dir, `noise-${seed}.png`);
    writeFileSync(file, noisePng(1024, seed));
    await importImageLayer(page, file);
  }
  const saved = await waitSaved(page, 1);
  expect(saved.name).toMatch(/^Untitled - /); // the first edit created a project on its own
  expect(uploaded.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(10 * 1024 * 1024);
  const expected = await snapshot(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await openUnicanvas(page, { navigate: false });
  await expect.poll(async () => (await project(page))?.sceneId, { timeout: 30_000 }).toBe(saved.sceneId);
  await expect.poll(() => snapshot(page), { timeout: 60_000 }).toEqual(expected);
  // localStorage holds only the project pointer.
  const stored = await page.evaluate(() => ({
    pointer: localStorage.getItem("vnccs-unicanvas-standalone-project"),
    document: localStorage.getItem("vnccs-unicanvas-standalone"),
  }));
  expect(JSON.parse(stored.pointer)).toEqual({ lastProjectId: saved.projectId, lastSceneId: saved.sceneId });
  expect(stored.document).toBeNull();
  await page.request.delete(`/vnccs/unicanvas/projects/${saved.projectId}`);
});

test("projects: an existing standalone document is migrated into a project", async ({ page }) => {
  // A document saved by the previous release (localStorage), with one painted layer.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const legacy = await page.evaluate(async (dataURL) => {
    const state = {
      version: 2, storage: "local", origin: { x: 0, y: 0 }, size: { width: 1024, height: 1024 }, bbox: { x: 0, y: 0, width: 1024, height: 1024 },
      settings: {}, activeLayerId: "legacy_base",
      layers: [
        { id: "legacy_mask", name: "Inpaint Mask", type: "mask", visible: true, opacity: 1, crop: null, dataURL: null },
        { id: "legacy_base", name: "Legacy art", type: "raster", visible: true, opacity: 1, crop: { x: 100, y: 120, width: 256, height: 256 }, dataURL },
      ],
    };
    localStorage.removeItem("vnccs-unicanvas-standalone-project");
    localStorage.setItem("vnccs-unicanvas-standalone", JSON.stringify({ saved_at: Date.now(), state }));
    return localStorage.getItem("vnccs-unicanvas-standalone");
  }, FIXTURE_DATA_URL);
  await openUnicanvas(page);
  await setLayerNaming(page, { autoFile: false }); // keep imported layers where the spec expects them
  await expect.poll(async () => (await project(page))?.projectId, { timeout: 30_000 }).toBeTruthy();
  const info = await waitSaved(page, 1);
  expect(info.name).toMatch(/^Untitled - \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  await expect(page.locator(`${SHELL} .vnccs-uc-project-note`)).toContainText("Imported this canvas");
  const expected = await snapshot(page);
  expect(Object.keys(expected).sort()).toEqual(["legacy_base", "legacy_mask"]);
  expect(await page.evaluate(() => localStorage.getItem("vnccs-unicanvas-standalone"))).toBe(legacy);

  await page.reload({ waitUntil: "domcontentloaded" });
  await openUnicanvas(page, { navigate: false });
  await expect.poll(async () => (await project(page))?.projectId, { timeout: 30_000 }).toBe(info.projectId);
  await expect.poll(() => snapshot(page), { timeout: 30_000 }).toEqual(expected);
  await page.request.delete(`/vnccs/unicanvas/projects/${info.projectId}`);
});
