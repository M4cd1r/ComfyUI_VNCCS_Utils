// Evidence scenarios (After captures, see AGENTS.md) registered per topic. Each entry sets up the
// UI through the real controls and names what to crop (`shot`) and measure (`measure`).
// `surface: "node"` scenarios build their own graph instead of opening the standalone tab.
// Routes that would run inference are stubbed with fixtures; nothing generates or downloads.
import { resolve } from "node:path";

const fixture = (name) => resolve(import.meta.dirname, "fixtures", name);
const SHELL = ".vnccs-uc2-standalone-shell";
const hook = (page, name, ...args) => page.evaluate(([fn, rest]) => globalThis.__VNCCS_UC_E2E__[fn](...rest), [name, args]);
const PNG_RED = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4o6EBRAwQCgAjrgSxn17XlQAAAABJRU5ErkJggg==";

async function openStandalone(page) {
  const shell = page.locator(SHELL);
  if (!(await shell.count())) {
    await page.locator('[data-testid="vnccs-unicanvas-standalone-tab-button"], .vnccs-unicanvas-sidebar-icon').first().click();
  }
  await shell.locator(".vnccs-uc-left").waitFor({ timeout: 30_000 });
  return shell;
}

async function importImage(page, name, scope = SHELL) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator(`${scope} button[title="Import image"]`).first().click(),
  ]);
  await chooser.setFiles(fixture(name));
  await page.waitForTimeout(1_500);
}

async function stroke(page, tool, from, to, scope = SHELL) {
  if (tool) await page.locator(`${scope} .vnccs-uc-tool[data-tool="${tool}"]`).first().click();
  const box = await page.locator(`${scope} canvas.vnccs-uc-stage`).first().boundingBox();
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 12 });
  await page.mouse.up();
}

async function chooseSetting(page, setting, value) {
  await page.evaluate(([key, next]) => {
    const select = document.querySelector(`.vnccs-uc2-standalone-shell select[data-setting="${key}"]`);
    select.value = next;
    select.dispatchEvent(new Event("input", { bubbles: true }));
  }, [setting, value]);
}

async function selectZImage(page) {
  await page.locator(`${SHELL} [data-model-selection-mode="custom"]`).first().click();
  await chooseSetting(page, "model_loader", "diffusion_model");
  await chooseSetting(page, "generation_mode", "z_image");
}

async function setNaming(page, { level, autoFile }) {
  await page.locator(`${SHELL} .vnccs-uc-gear`).first().click();
  const panel = page.locator(".vnccs-uc-settings-popover");
  const section = panel.locator("details.vnccs-uc-settings-section", { has: page.locator("summary", { hasText: "Layer names" }) });
  if (!(await section.evaluate((details) => details.open))) await section.locator("summary").click();
  if (level) await section.locator("select[data-naming-level]").selectOption(level, { force: true });
  if (autoFile !== undefined) await section.getByLabel("Auto-file new layers into folders").setChecked(autoFile, { force: true });
  await panel.locator('button:has-text("Close")').click();
}

async function newProject(page, name) {
  await page.locator(`${SHELL} .vnccs-uc-project-name`).first().click();
  await page.locator(`${SHELL} .vnccs-uc-project-browser-head button`, { hasText: "New" }).click();
  const input = page.locator(`${SHELL} .vnccs-uc-modal .vnccs-uc-field input`);
  await input.fill(name);
  await input.press("Enter");
  await page.locator(`${SHELL} .vnccs-uc-project-name span`, { hasText: name }).waitFor({ timeout: 30_000 });
}

async function waitSaved(page) {
  await page.waitForTimeout(1_600);
  await page.waitForFunction(() => globalThis.__VNCCS_UC_E2E__.getProjectInfo()?.status === "saved", null, { timeout: 60_000 });
}

export const SCENARIOS = {
  // #9: a character keyed at frame 0 and 20 (x + 200 px), scrubbed to frame 10 with its row
  // expanded, so the dock shows the keys and the canvas the interpolated position.
  timeline: {
    shot: ".vnccs-unicanvas",
    measure: "[data-timeline-dock]",
    async run(page) {
      await openStandalone(page);
      await importImage(page, "character.png");
      const layerId = (await hook(page, "getLayerStack")).activeLayerId;
      await page.locator(`${SHELL} [data-timeline-toggle]`).first().click();
      const dock = `${SHELL} [data-timeline-dock]`;
      await page.locator(dock).waitFor();
      const setFrame = async (frame) => {
        const input = page.locator(`${dock} [data-tl="frame"]`).first();
        await input.fill(String(frame));
        await input.dispatchEvent("input");
      };
      const x = page.locator(`${dock} [data-tl="field-x"]`).first();
      for (const [frame, value] of [[0, "0"], [20, "200"]]) {
        await setFrame(frame);
        await x.fill(value);
        await x.dispatchEvent("input");
        await x.dispatchEvent("change");
      }
      await page.locator(`${dock} .vnccs-uc-tl-expand[data-expand="${layerId}"]`).click();
      await setFrame(10);
      await page.waitForTimeout(800);
    },
  },
  // #17: two painted layers named by the rules, then the Organize preview.
  "auto-naming": {
    shot: SHELL,
    measure: ".vnccs-uc-organize",
    async run(page) {
      const shell = await openStandalone(page);
      await setNaming(page, { level: "rules" });
      for (let i = 0; i < 2; i += 1) await shell.locator('[title="Add raster"]').first().click();
      await stroke(page, "brush", [0.3, 0.3], [0.5, 0.35]);
      await shell.locator("[data-organize-layers]").click();
      await shell.locator(".vnccs-uc-organize").waitFor();
      await page.waitForTimeout(500);
    },
  },
  // #12: a pose layer with two mannequins; the Character reference card lists one row each.
  "multi-character": {
    shot: ".vnccs-unicanvas",
    async run(page) {
      await openStandalone(page);
      await page.locator(`${SHELL} .vnccs-uc-layers-section [title="Add pose layer"]`).click();
      await page.waitForFunction(() => globalThis.__VNCCS_UC_E2E__?.getPoseBackdrop?.()?.distance != null, null, { timeout: 90_000 });
      const side = page.locator(".vnccs-uc-pose-side");
      await side.getByRole("tab", { name: "Scene" }).click();
      const section = side.locator(".vnccs-ps-characters-section");
      if (await section.evaluate((el) => el.classList.contains("collapsed"))) await section.locator(".vnccs-ps-section-header").click();
      await side.locator('[aria-label="Add Character 2"]').click();
      await page.waitForTimeout(5_000);
    },
  },
  // #8: an imported image and a painted stroke grouped with Ctrl+G, the folder open in Layers.
  "layer-groups": {
    shot: ".vnccs-unicanvas",
    async run(page) {
      await openStandalone(page);
      await setNaming(page, { autoFile: false });
      await importImage(page, "backdrop.png");
      const imported = (await hook(page, "getLayerStack")).activeLayerId;
      await page.locator(`${SHELL} [title="Add raster"]`).first().click();
      await stroke(page, "brush", [0.35, 0.45], [0.62, 0.52]);
      const painted = (await hook(page, "getLayerStack")).activeLayerId;
      await page.locator(`${SHELL} [data-layer-id="${painted}"]`).first().click();
      await page.locator(`${SHELL} [data-layer-id="${imported}"]`).first().click({ modifiers: ["Control"] });
      await page.keyboard.press("Control+g");
      await page.waitForTimeout(800);
    },
  },
  // #13: a painted Inpaint Mask stroke over an image; the settings popover reports the keep area
  // that Remove background will send.
  "remove-bg-keep": {
    shot: ".vnccs-unicanvas",
    measure: ".vnccs-uc-settings-popover .vnccs-uc-remove-bg-keep",
    async run(page) {
      await openStandalone(page);
      await importImage(page, "backdrop.png");
      await page.locator(`${SHELL} [title="Mask brush"]`).first().click();
      await stroke(page, null, [0.38, 0.45], [0.62, 0.55]);
      await page.locator(`${SHELL} .vnccs-uc-gear`).first().click();
      const line = page.locator(".vnccs-uc-settings-popover .vnccs-uc-remove-bg-keep");
      await line.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
    },
  },
  // #22: a project with two saved scenes (an image, a painted stroke), the project browser open.
  projects: {
    shot: ".vnccs-unicanvas",
    measure: ".vnccs-uc-project-browser",
    async run(page) {
      await openStandalone(page);
      await newProject(page, `Evidence project ${new Date().toISOString().slice(0, 16)}`);
      await importImage(page, "backdrop.png");
      await waitSaved(page);
      await page.locator(`${SHELL} .vnccs-uc-scene-add`).click();
      await page.waitForTimeout(2_000);
      await importImage(page, "character.png");
      await stroke(page, "brush", [0.3, 0.7], [0.7, 0.75]);
      await waitSaved(page);
      await page.waitForTimeout(1_500);
      await page.locator(`${SHELL} .vnccs-uc-project-name`).first().click();
      await page.locator(`${SHELL} .vnccs-uc-project-browser`).waitFor();
      await page.waitForTimeout(1_500);
    },
  },
  // #6: a sprite set from a character: presets added, face area set, missing variants generated
  // (draw stubbed with a red patch).
  "sprite-set": {
    shot: ".vnccs-unicanvas",
    measure: "[data-sprite-panel]",
    async run(page) {
      await page.route("**/vnccs/unicanvas/draw", (route) => route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ images: [`data:image/png;base64,${PNG_RED}`], performance: "stub" }),
      }));
      await openStandalone(page);
      await setNaming(page, { autoFile: false });
      await importImage(page, "character.png");
      const source = (await hook(page, "getLayerStack")).activeLayerId;
      await page.locator(`${SHELL} [data-layer-id="${source}"]`).first().click({ button: "right" });
      await page.locator('.vnccs-uc-layer-menu [data-menu-item="create-sprite-set"]').click();
      const panel = `${SHELL} [data-sprite-panel]`;
      await page.locator(panel).waitFor();
      await page.locator(`${panel} [data-sprite-action="add-presets"]`).click();
      const face = await page.locator(`${panel} [data-sprite-face] canvas`).boundingBox();
      await page.mouse.move(face.x + face.width * 0.25, face.y + face.height * 0.02);
      await page.mouse.down();
      await page.mouse.move(face.x + face.width * 0.75, face.y + face.height * 0.22, { steps: 6 });
      await page.mouse.up();
      await page.locator(`${panel} [data-sprite-action="generate-missing"]`).click();
      const id = (await hook(page, "getLayerStack")).layers.find((layer) => layer.type === "sprite").id;
      await page.waitForFunction((layerId) => globalThis.__VNCCS_UC_E2E__.getSpriteState(layerId).variants.every((v) => v.status === "ready"), id, { timeout: 60_000 });
      const happy = (await hook(page, "getSpriteState", id)).variants.find((v) => v.name === "happy");
      await page.locator(`${panel} [data-sprite-variant="${happy.id}"]`).click();
      await page.waitForTimeout(800);
    },
  },
  // #45: a ControlNet layer (Z-Image) holding an imported control image, its panel open.
  "control-layer": {
    shot: ".vnccs-unicanvas",
    measure: "[data-control-panel]",
    async run(page) {
      await openStandalone(page);
      await selectZImage(page);
      await page.locator(`${SHELL} [data-control-add]`).waitFor({ timeout: 30_000 });
      await page.locator(`${SHELL} [data-control-add]`).click();
      const panel = page.locator(`${SHELL} [data-control-panel]`);
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), panel.locator("[data-control-import]").click()]);
      await chooser.setFiles(fixture("backdrop.png"));
      await page.waitForTimeout(1_500);
    },
  },
  // #46: a Canny ControlNet layer made from the scene (runs in the browser, no model).
  "control-from-scene": {
    shot: ".vnccs-unicanvas",
    measure: "[data-control-panel]",
    async run(page) {
      await openStandalone(page);
      await importImage(page, "backdrop.png");
      await selectZImage(page);
      await page.locator(`${SHELL} [data-control-add]`).waitFor({ timeout: 30_000 });
      await page.locator(`${SHELL} [data-control-add]`).click();
      const panel = page.locator(`${SHELL} [data-control-panel]`);
      await panel.locator('[data-control-field="type"]').selectOption("canny");
      await panel.locator("[data-control-from-scene]").click();
      await page.waitForFunction(() => {
        const e2e = globalThis.__VNCCS_UC_E2E__;
        const layer = e2e.listLayers().find((item) => item.type === "control");
        return layer && e2e.getControlSource(layer.id)?.hasImage;
      }, null, { timeout: 30_000 });
      await page.waitForTimeout(1_000);
    },
  },
  // #50: ComfyUI settings switch off the brush, the eraser, mask layers, scene states and the VN
  // preview; the standalone widget hides them live (restored in `cleanup`).
  "feature-toggles": {
    shot: SHELL,
    measure: ".vnccs-uc-tools",
    toggles: ["Tools.tool_brush", "Tools.tool_eraser", "LayerTypes.maskLayers", "Features.sceneStates", "Features.vnPreview"],
    async run(page) {
      await openStandalone(page);
      for (const key of this.toggles) {
        await page.evaluate((id) => globalThis.app.extensionManager.setting.set(id, false), `VNCCS.UniCanvas.${key}`);
      }
      await page.waitForTimeout(800);
    },
    async cleanup(page, { baseURL }) {
      for (const key of this.toggles) await page.request.post(`${baseURL}/api/settings/VNCCS.UniCanvas.${key}`, { data: true });
    },
  },
  // #33: panorama view mode: the globe button opens Yaw/Pitch/Roll/FOV with Save, Cancel, Reset;
  // the yaw slider has turned the view live.
  "panorama-view": {
    shot: ".vnccs-unicanvas",
    measure: "[data-panorama-panel]",
    async run(page) {
      await openStandalone(page);
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.locator(`${SHELL} button[title="Import image"]`).first().click(),
      ]);
      await chooser.setFiles(fixture("panorama-2048x1024.webp"));
      const dialog = page.getByRole("dialog", { name: "Import as panorama?" });
      await dialog.getByRole("button", { name: "Panorama", exact: true }).click();
      await page.waitForFunction(() => globalThis.__VNCCS_UC_E2E__.listLayers().some((layer) => layer.type === "panorama"), null, { timeout: 30_000 });
      const id = (await hook(page, "listLayers")).find((layer) => layer.type === "panorama").id;
      await page.locator(`${SHELL} [data-layer-id="${id}"] button[title="Edit panorama view"]`).click();
      const panel = page.locator(`${SHELL} [data-panorama-panel]`);
      await panel.waitFor();
      await panel.locator('input[type="range"][data-panorama-setting="yaw"]').evaluate((input) => {
        input.value = "60";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.waitForTimeout(1_500);
    },
  },
  // Node surface: a UniCanvas node in a workflow (fullscreen) shows no scene states, timeline,
  // VN preview or project bar; those stay in the standalone tab.
  "node-surface": {
    surface: "node",
    shot: ".vnccs-uc2-fullscreen-portal .vnccs-unicanvas",
    async run(page) {
      await page.evaluate(() => {
        const { app, LiteGraph } = window;
        app.graph.clear();
        const node = LiteGraph.createNode("VNCCS_UniCanvas");
        node.pos = [40, 40];
        app.graph.add(node);
        app.canvas.ds.scale = 0.5;
        app.canvas.ds.offset = [0, 0];
        app.canvas.setDirty(true, true);
      });
      const root = page.locator(".vnccs-unicanvas").first();
      await root.waitFor({ timeout: 30_000 });
      await root.locator(".vnccs-uc2-fullscreen-btn").click();
      await page.locator(".vnccs-uc2-fullscreen-portal .vnccs-uc-left").waitFor({ timeout: 30_000 });
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.locator('.vnccs-uc2-fullscreen-portal button[title="Import image"]').first().click(),
      ]);
      await chooser.setFiles(fixture("backdrop.png"));
      await page.waitForTimeout(2_000);
    },
  },
};
