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
await mkdir(outDir, { recursive: true });

if (phase === "compose") {
  const before = await readFile(resolve(outDir, "before.png"));
  const after = await readFile(resolve(outDir, "after.png"));
  const browser = await chromium.launch();
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(baseURL, { waitUntil: "domcontentloaded" });
await page
  .locator('[data-testid="vnccs-unicanvas-standalone-tab-button"], [data-label="Unicanvas"], button[title="Unicanvas"]')
  .first()
  .click();
await page.waitForSelector(".vnccs-uc-left", { timeout: 30_000 });
// Scenario per topic keeps crops identical between before/after (same locator).
const shots = {
  "mannequin-options": ".vnccs-uc-left",
  // The settings topic must frame the corner-bar gear and the popover anchored to
  // it, so it crops the whole widget root - whose geometry is identical in both
  // phases, which keeps the before/after crops aligned.
  "settings-panel": ".vnccs-unicanvas",
  "pose-roundtrip": ".vnccs-uc-pose-edit-overlay",
  "pose-framing": ".vnccs-uc-pose-edit-overlay",
};
// The settings popover exists only once the gear is clicked. The crop still frames
// the pre-change popover, which the old code parked at the widget's top-left.
if (topic === "settings-panel") await page.locator('[title="Settings"]').first().click();
const target = page.locator(shots[topic] || ".vnccs-uc-left").first();
await target.screenshot({ path: resolve(outDir, `${phase}.png`) });
const geometry = await target.evaluate((el, measureSelector) => {
  // Measure what the topic changes: the settings popover. Before the anchoring
  // change it carries no class yet, so fall back to the legacy inline-styled panel.
  const legacy = () => [...document.querySelectorAll(".vnccs-unicanvas > div")].find(
    (node) => node.style.position === "absolute" && (node.textContent || "").startsWith("UniCanvas settings"));
  const subject = (measureSelector ? (document.querySelector(measureSelector) || legacy()) : el) || el;
  const r = subject.getBoundingClientRect();
  const s = getComputedStyle(subject);
  return { x: r.x, y: r.y, width: r.width, height: r.height, fontSize: s.fontSize, zIndex: s.zIndex, background: s.background };
}, topic === "settings-panel" ? ".vnccs-uc-settings-popover" : null);
await writeFile(resolve(outDir, `${phase}.geometry.json`), JSON.stringify(geometry, null, 2));
await browser.close();
console.log(`captured ${phase}.png for ${topic}`);
