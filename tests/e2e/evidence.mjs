#!/usr/bin/env node
// Evidence capture for UI changes (owner rule): Before/After pairs (same crop,
// same scale, labels exactly "Before"/"After"), standalone After, measured geometry.
import { chromium } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.reduce((acc, cur, i) => {
  if (cur.startsWith("--")) acc.push([cur.slice(2), args[i + 1] ?? ""]);
  return acc;
}, []));
const topic = opt.topic || "topic";
const phase = opt.phase || "after"; // before | after | compose
const baseURL = process.env.COMFYUI_URL || "http://localhost:8188";
const outDir = resolve(import.meta.dirname, "evidence", topic);
// Optional: reuse a preinstalled Chromium instead of the version pinned by @playwright/test.
const launchOptions = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};
await mkdir(outDir, { recursive: true });

if (phase === "compose") {
  const before = await readFile(resolve(outDir, "before.png"));
  const after = await readFile(resolve(outDir, "after.png"));
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 1700, height: 900 } });
  await page.setContent(`<body style="margin:0;background:#111;display:flex;gap:8px;padding:8px;font:700 22px sans-serif;color:#fff">
    <style>img{display:block;max-width:calc(50vw - 16px);height:auto}</style>
    <figure style="margin:0"><figcaption>Before</figcaption><img src="data:image/png;base64,${before.toString("base64")}"></figure>
    <figure style="margin:0"><figcaption>After</figcaption><img src="data:image/png;base64,${after.toString("base64")}"></figure>
  </body>`);
  await page.locator("body").screenshot({ path: resolve(outDir, `${topic}.pair.png`) });
  await page.locator("figure").nth(1).screenshot({ path: resolve(outDir, `${topic}.after.png`) });
  await browser.close();
  console.log(`composed ${topic}.pair.png`);
  process.exit(0);
}

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
// The standalone tab is opt-in; builds without the setting simply ignore it.
await page.request.post(`${baseURL}/api/settings/VNCCS.UniCanvas.StandaloneSidebar`, { data: true }).catch(() => {});
await page.goto(baseURL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 60_000 });
await page.waitForTimeout(2_000);
for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
if (topic === "config-override") {
  // Graph scenario: a VNCSS Config node linked to a UniCanvas node.
  await page.evaluate(() => {
    const { app, LiteGraph } = window;
    app.graph.clear();
    const config = LiteGraph.createNode("VNCCS_Config");
    config.pos = [40, 80];
    app.graph.add(config);
    const canvas = LiteGraph.createNode("VNCCS_UniCanvas");
    canvas.pos = [420, 40];
    app.graph.add(canvas);
    config.connectByType(0, canvas, "VNCSS_CONFIG");
    config.configWidget.state.loras.push({ name: "", strength: 0.8, clip_strength: null, enabled: true });
    config.configWidget.renderLoras();
    app.canvas.ds.offset = [0, 0];
    app.canvas.ds.scale = 1;
    app.graph.setDirtyCanvas(true, true);
  });
  await page.waitForTimeout(4_000);
} else {
  await page
    .locator('[data-testid="vnccs-unicanvas-standalone-tab-button"], .vnccs-unicanvas-sidebar-icon, [data-label="Unicanvas"], button[title="Unicanvas"]')
    .first()
    .click();
  await page.waitForSelector(".vnccs-uc-left", { timeout: 30_000 });
}
if (topic === "pose-editor") {
  // An image layer under the pose, then the pose editor: the new build opens it with the Pose
  // Studio tool, older builds with "Add pose layer".
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator('button[title="Import image"]').first().click(),
  ]);
  await chooser.setFiles(resolve(import.meta.dirname, "fixtures", "backdrop.png"));
  await page.waitForTimeout(2_500);
  const poseTool = page.locator('.vnccs-uc-layers-section [title="Add pose layer"]');
  if (await poseTool.count()) await poseTool.click();
  else await page.locator('[title="Add pose layer"]').first().click();
  await page.waitForTimeout(25_000);
}
if (topic === "scene-states") {
  // Scene states (#7): an imported image, two states with the second one hiding the image.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator('button[title="Import image"]').first().click(),
  ]);
  await chooser.setFiles(resolve(import.meta.dirname, "fixtures", "backdrop.png"));
  await page.waitForTimeout(2_500);
  await page.locator('[data-scene-states] [data-state-action="new"]').first().click();
  await page.locator('[data-scene-states] [data-state-action="new"]').first().click();
  await page.locator(".vnccs-uc-layer .vnccs-uc-thumb").first().click();
  await page.waitForTimeout(500);
}
if (topic === "multi-character") {
  // A pose layer with two mannequins: the Character reference card lists one row per mannequin.
  await page.locator('.vnccs-uc-layers-section [title="Add pose layer"]').click();
  await page.waitForTimeout(25_000);
  await page.locator('.vnccs-uc-pose-side [aria-label="Add Character 2"]').click();
  await page.waitForTimeout(5_000);
}
if (topic === "vn-preview") {
  // A scene (image layer + pose layer) with the Clean dark overlay on and the pose moved down so
  // its face sits under the textbox: the occlusion warning shows.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator('button[title="Import image"]').first().click(),
  ]);
  await chooser.setFiles(resolve(import.meta.dirname, "fixtures", "backdrop.png"));
  await page.waitForTimeout(2_000);
  await page.locator('.vnccs-uc-layers-section [title="Add pose layer"]').click();
  await page.waitForFunction(() => globalThis.__VNCCS_UC_E2E__?.getPoseBackdrop?.()?.distance != null, null, { timeout: 90_000 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1_000);
  await page.locator('[title="VN preview (P)"]').first().click();
  await page.mouse.click(3, 3);
  await page.locator('.vnccs-uc-tool[data-tool="move"]').click();
  const box = await page.locator("canvas.vnccs-uc-stage").first().boundingBox();
  const vn = await page.evaluate(() => globalThis.__VNCCS_UC_E2E__.getVnPreview());
  const face = vn.characters[0]?.face;
  if (face) {
    const start = { x: box.x + face.x + face.width / 2, y: box.y + face.y + face.height + 40 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y + (vn.textbox.y + vn.textbox.height * 0.35) - (face.y + face.height / 2), { steps: 10 });
    await page.mouse.up();
  }
  await page.waitForTimeout(800);
}
if (topic === "placement-harmonize") {
  // Plan 08 (#11): a background and a character, the Perspective tool calibrated from the
  // character (horizon at its eye level), so the horizon, ground grid and figure show.
  for (const name of ["backdrop.png", "character.png"]) {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.locator('button[title="Import image"]').first().click(),
    ]);
    await chooser.setFiles(resolve(import.meta.dirname, "fixtures", name));
    await page.waitForTimeout(1_500);
  }
  await page.locator('.vnccs-uc-tool[data-tool="perspective"]').click();
  await page.locator('[data-scene-action="calibrate"]').click();
  await page.locator("[data-scene-depth-scale]").click();
  await page.waitForTimeout(800);
}
if (topic === "history-gallery") {
  // Plan 10.5 (#24): one stubbed generation (batch 3, one accepted) in a fresh project, then the
  // History gallery with that run selected.
  const fixture = await readFile(resolve(import.meta.dirname, "fixtures", "backdrop.png"));
  const image = `data:image/png;base64,${fixture.toString("base64")}`;
  await page.route("**/vnccs/unicanvas/draw", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ images: [image, image, image], performance: "stub" }),
  }));
  await page.locator(".vnccs-uc-project-name").first().click();
  await page.locator(".vnccs-uc-project-browser-head button", { hasText: "New" }).click();
  await page.locator(".vnccs-uc-modal .vnccs-uc-field input").fill(`Evidence history ${Date.now()}`);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3_000);
  await page.locator('textarea[data-setting="positive"]').first().fill("a red lighthouse at dusk");
  await page.locator("button", { hasText: "GENERATE" }).first().click();
  await page.locator('[title="Accept as layer"]').first().click({ timeout: 30_000 });
  await page.waitForTimeout(2_000);
  await page.locator(".vnccs-uc-history-open").first().click();
  await page.locator(".vnccs-uc-history-card").first().click({ timeout: 30_000 });
  await page.waitForTimeout(1_500);
}
// Scenario per topic keeps crops identical between before/after (same locator).
const shots = {
  "mannequin-options": ".vnccs-uc-left",
  // The settings topic must frame the corner-bar gear and the popover anchored to
  // it, so it crops the whole widget root - whose geometry is identical in both
  // phases, which keeps the before/after crops aligned.
  "settings-panel": ".vnccs-unicanvas",
  "pose-editor": ".vnccs-unicanvas",
  "multi-character": ".vnccs-unicanvas",
  "vn-preview": ".vnccs-unicanvas",
  "placement-harmonize": ".vnccs-unicanvas",
  "scene-states": ".vnccs-unicanvas",
  "history-gallery": ".vnccs-unicanvas",
  "config-override": "body",
  "icons": "body",
  "auto-naming": ".vnccs-uc2-standalone-shell",
};
// The settings popover exists only once the gear is clicked. The crop still frames
// the pre-change popover, which the old code parked at the widget's top-left.
if (topic === "settings-panel") await page.locator('[title="Settings"]').first().click();
// Automatic naming (issue #17): two painted layers named by rules, then the Organize preview.
if (topic === "auto-naming") {
  await page.locator('[data-testid="vnccs-unicanvas-standalone-tab-button"], .vnccs-unicanvas-sidebar-icon').first().click();
  const shell = page.locator(".vnccs-uc2-standalone-shell");
  await shell.locator(".vnccs-uc-left").waitFor({ timeout: 30_000 });
  for (let i = 0; i < 2; i += 1) await shell.locator('[title="Add raster"]').first().click();
  await shell.locator("[data-organize-layers]").click();
  await shell.locator(".vnccs-uc-organize").waitFor();
}
const target = page.locator(shots[topic] || ".vnccs-uc-left").first();
// Fixed page crops keep both phases aligned where the subject spans several roots.
const clips = {
  icons: { x: 0, y: 0, width: 420, height: 760 },
  "config-override": { x: 0, y: 40, width: 700, height: 960 },
};
if (clips[topic]) await page.screenshot({ path: resolve(outDir, `${phase}.png`), clip: clips[topic] });
else await target.screenshot({ path: resolve(outDir, `${phase}.png`) });
const geometry = await target.evaluate((el, measureSelector) => {
  // Measure what the topic changes: the settings popover. Before the anchoring
  // change it carries no class yet, so fall back to the legacy inline-styled panel.
  const legacy = () => [...document.querySelectorAll(".vnccs-unicanvas > div")].find(
    (node) => node.style.position === "absolute" && (node.textContent || "").startsWith("UniCanvas settings"));
  const subject = (measureSelector ? (document.querySelector(measureSelector) || legacy()) : el) || el;
  const r = subject.getBoundingClientRect();
  const s = getComputedStyle(subject);
  return { x: r.x, y: r.y, width: r.width, height: r.height, fontSize: s.fontSize, zIndex: s.zIndex, background: s.background };
}, {
  "settings-panel": ".vnccs-uc-settings-popover",
  "config-override": ".vnccs-config-ui",
  icons: ".vnccs-uc-tools",
  "auto-naming": ".vnccs-uc-organize",
  "history-gallery": ".vnccs-uc-history-gallery",
}[topic] || null);
await writeFile(resolve(outDir, `${phase}.geometry.json`), JSON.stringify(geometry, null, 2));
await browser.close();
console.log(`captured ${phase}.png for ${topic}`);
