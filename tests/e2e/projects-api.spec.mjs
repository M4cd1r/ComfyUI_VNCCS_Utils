import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

// Plan 10.2 (#21): the durable project store answers on the live server. Backend only: no UI.
const PNG = readFileSync(fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url)));
const SHA = createHash("sha256").update(PNG).digest("hex");
const BASE = "/vnccs/unicanvas/projects";

test("project store: create, upload a blob, save a scene, conflict, export, delete", async ({ request }) => {
  const created = await request.post(BASE, { data: { name: "E2E project" } });
  expect(created.ok()).toBeTruthy();
  const project = await created.json();
  const sceneId = project.scenes[0].id;
  try {
    expect((await request.put(`${BASE}/${project.id}/blobs/${"0".repeat(64)}`, { data: PNG, headers: { "Content-Type": "image/png" } })).status()).toBe(400);
    const blob = await request.put(`${BASE}/${project.id}/blobs/${SHA}`, { data: PNG, headers: { "Content-Type": "image/png" } });
    expect(await blob.json()).toMatchObject({ blob: `${SHA}.png` });

    const state = { version: 3, layers: [{ id: "l1", type: "raster", crop: { x: 0, y: 0, width: 4, height: 4 }, dataURL: { blob: `${SHA}.png`, crop: { x: 0, y: 0, width: 4, height: 4 } } }] };
    const saved = await request.put(`${BASE}/${project.id}/scenes/${sceneId}`, { data: { state, ifRev: 1 } });
    expect(saved.ok()).toBeTruthy();
    expect((await saved.json()).rev).toBe(2);
    const stale = await request.put(`${BASE}/${project.id}/scenes/${sceneId}`, { data: { state, ifRev: 1 } });
    expect(stale.status()).toBe(409);
    expect(await stale.json()).toMatchObject({ rev: 2 });

    const scene = await (await request.get(`${BASE}/${project.id}/scenes/${sceneId}`)).json();
    expect(scene.state.layers[0].dataURL.blob).toBe(`${SHA}.png`);
    expect(Buffer.compare(await (await request.get(`${BASE}/${project.id}/blobs/${SHA}`)).body(), PNG)).toBe(0);
    expect((await request.get(`${BASE}/..%2F..%2Fetc`)).status()).toBeGreaterThanOrEqual(400);

    const listed = await (await request.get(BASE)).json();
    expect(listed.projects.some((item) => item.id === project.id && item.sceneCount === 1)).toBe(true);
    const zip = await request.post(`${BASE}/${project.id}/export`);
    expect(zip.headers()["content-type"]).toContain("application/zip");
    expect((await zip.body()).subarray(0, 2).toString()).toBe("PK");
  } finally {
    expect((await request.delete(`${BASE}/${project.id}`)).ok()).toBeTruthy();
  }
  expect((await request.get(`${BASE}/${project.id}`)).status()).toBe(404);
});
