/** Pose Studio host contract and image preparation for UniCanvas pose layers. */
import { PoseStudioWidget } from "./vnccs_pose_studio.js";

import { installCustomSelects } from "./vnccs_custom_select.mjs";
import { composePoseReference, poseAtPanoramaCamera, poseStudioCharacters, poseCharacterRef, poseCharacterPrompt, poseCharacterIssues, setPoseCharacterRef, setPoseCharacterPrompt, reconcilePoseCharacterRefs, poseIdKey, poseMultiReferences, posePromptMapping, POSE_ID_COLORS } from "./vnccs_unicanvas_pose_state.mjs";
import { UniCanvasPoseBackdrop } from "./vnccs_unicanvas_pose_backdrop.mjs";
import { openPoseFromRig } from "./vnccs_unicanvas_control_scene.mjs";
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

const styles = `
.vnccs-unicanvas .vnccs-uc-pose-root { position:absolute; inset:0; display:block; width:auto; height:auto; min-width:0; min-height:0; background:none; border:0; border-radius:0; pointer-events:none; z-index:5; --vnccs-ps-ui-scale:1; --vnccs-ps-relative-ui-scale:1; }
.vnccs-unicanvas .vnccs-uc-pose-root:has(> .vnccs-ps-modal-overlay) { z-index:1000; }
/* Pose Library inside UniCanvas: the modal is as large as the canvas, but its header, toolbar and
   settings keep a compact size (Pose Studio scales them with the modal width, up to 1.4x). */
.vnccs-unicanvas .vnccs-uc-pose-root .vnccs-ps-library-modal { --vnccs-ps-library-ui-scale: 0.62 !important; }
.vnccs-uc-pose-controls { position:absolute; pointer-events:none; overflow:hidden; z-index:1; }
/* Pose Studio's settings are re-parented into the UniCanvas sidebar and controls, outside the
   .vnccs-pose-studio root that defines its --ps-* theme variables. Without them the active toggle
   (e.g. Female) had no background and the slider thumbs no color. Map them onto the UniCanvas
   palette so the panel matches the rest of the UI. */
.vnccs-unicanvas .vnccs-uc-pose-side, .vnccs-unicanvas .vnccs-uc-pose-controls {
  --ps-bg: var(--uc-bg, #0a0a0f); --ps-panel: var(--uc-panel, rgba(20,16,30,.82)); --ps-elevated: #1a1a26;
  --ps-surface: var(--uc-surface, rgba(30,28,44,.9)); --ps-hover: var(--uc-hover, rgba(44,40,62,.95));
  --ps-border: var(--uc-border, rgba(255,255,255,.08)); --ps-border-hover: rgba(255,255,255,.14);
  --ps-accent: var(--uc-accent, #ff8fa3); --ps-accent-hover: #ffb6c8; --ps-accent-glow: rgba(255,143,163,.3);
  --ps-accent-subtle: rgba(255,143,163,.1); --ps-accent-border: rgba(255,143,163,.22); --ps-accent-lavender: var(--uc-accent-2, #b8a9e8);
  --ps-success: var(--uc-good, #00d68f); --ps-danger: var(--uc-danger, #ff4757); --ps-warning: #ffaa00;
  --ps-text: var(--uc-text, #e8e8f0); --ps-text-muted: var(--uc-muted, #9898a8); --ps-text-dim: #5e5e70;
  --ps-input-bg: rgba(255,255,255,.04); --ps-font: var(--uc-font, 'Sora', -apple-system, BlinkMacSystemFont, sans-serif);
  --ps-font-mono: 'JetBrains Mono', 'Fira Code', monospace; --ps-radius-sm: 8px; --ps-radius-md: 12px; --ps-radius-lg: 16px;
  --ps-transition: .2s ease; --vnccs-ps-ui-scale: 1; --vnccs-ps-relative-ui-scale: 1;
  color: var(--ps-text); font-family: var(--ps-font);
}
.vnccs-uc-pose-side { display:flex; flex-direction:column; gap:8px; flex:1 1 auto; min-height:0; min-width:0; }
.vnccs-uc-pose-side-head { display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid rgba(255,143,163,.45); border-radius:10px; background:rgba(255,143,163,.08); }
.vnccs-uc-pose-side-head strong { font-size:12px; color:var(--uc-accent, #ff8fa3); text-transform:uppercase; letter-spacing:.05em; }
.vnccs-uc-pose-side-head span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--uc-muted); font-size:11px; }
.vnccs-uc-pose-dock { display:flex; flex-direction:column; gap:8px; flex:1 1 auto; min-height:0; }
.vnccs-uc-pose-tabs { display:flex; gap:4px; flex:none; }
.vnccs-uc-pose-tabs button { flex:1; min-width:0; }
.vnccs-uc-pose-tabs .vnccs-uc-pose-collapse { display:none; }
.vnccs-uc-pose-page { min-height:0; overflow:auto; flex:1; overscroll-behavior:contain; }
.vnccs-uc-pose-page > .vnccs-ps-left, .vnccs-uc-pose-page > .vnccs-ps-right-sidebar, .vnccs-uc-pose-page > .vnccs-ps-center { width:100%; flex:none; min-width:0; height:auto; max-height:none; overflow:visible; padding:0; border:0; background:transparent; zoom:1; }
.vnccs-uc-pose-editbar { position:absolute; left:50%; bottom:12px; transform:translateX(-50%); display:flex; align-items:center; gap:8px; max-width:calc(100% - 24px); padding:6px 8px 6px 12px; box-sizing:border-box; border:1px solid var(--uc-border); border-radius:12px; background:rgba(14,11,20,.94); box-shadow:0 12px 32px rgba(0,0,0,.45); pointer-events:auto; zoom:var(--vnccs-uc-ui-scale); z-index:3; }
.vnccs-uc-pose-editbar strong { color:var(--uc-accent, #ff8fa3); font-size:12px; white-space:nowrap; }
.vnccs-uc-pose-editbar .vnccs-uc-pose-hint { color:var(--uc-muted); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.vnccs-uc-pose-root > .vnccs-ps-canvas-wrap { position:absolute; flex:none; min-width:0; min-height:0; margin:0; padding:0; background:transparent; border:0; border-radius:0; pointer-events:auto; overflow:hidden; }
.vnccs-uc-pose-root > .vnccs-ps-canvas-wrap canvas { background:transparent; }
.vnccs-uc-pose-root > [class*="modal"], .vnccs-uc-pose-root > .vnccs-ps-manager, .vnccs-uc-pose-root > .vnccs-ps-manager-detail-strip { pointer-events:auto; }
.vnccs-uc-pose-root > .vnccs-ps-manager { position:absolute; inset:12px 300px 12px 330px; background:var(--uc-bg); }
.vnccs-uc-pose-character { display:flex; flex-direction:column; gap:8px; padding:10px; flex:none; background:var(--uc-panel); border:1px solid var(--uc-border); border-radius:10px; transition:border-color .2s, box-shadow .2s; }
.vnccs-uc-pose-character.attention { border-color:#ffd45c; box-shadow:0 0 0 2px rgba(255,212,92,.35); }
.vnccs-uc-pose-character-header { display:flex; align-items:center; gap:8px; }
.vnccs-uc-pose-character-header strong { flex:1; font-size:12px; }
.vnccs-uc-pose-character-row { display:flex; align-items:center; gap:8px; min-width:0; }
.vnccs-uc-pose-character-row img { width:44px; height:52px; flex:none; object-fit:contain; background:var(--uc-surface); border:1px solid var(--uc-border); border-radius:6px; }
.vnccs-uc-pose-character-row select { flex:1; min-width:0; width:100%; }
.vnccs-uc-pose-character-actions { display:flex; align-items:center; gap:8px; }
.vnccs-uc-pose-character-actions > button { flex:1; min-width:0; }
.vnccs-uc-pose-character-issue { color:#ffd45c; font-size:11px; }
.vnccs-uc-pose-character-count { font-size:11px; color:var(--uc-muted); white-space:nowrap; }
.vnccs-uc-pose-character-count.incomplete { color:#ffd45c; }
.vnccs-uc-pose-character-list { display:flex; flex-direction:column; gap:6px; }
.vnccs-uc-pose-character-item { display:flex; flex-direction:column; gap:6px; padding:8px; border:1px solid var(--uc-border); border-radius:8px; cursor:pointer; }
.vnccs-uc-pose-character-item.active { border-color:var(--uc-accent, #ff8fa3); background:rgba(255,143,163,.06); }
.vnccs-uc-pose-character-item-head { display:flex; align-items:center; gap:6px; min-width:0; font-size:12px; }
.vnccs-uc-pose-character-item-head span:last-child { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-uc-pose-character-dot { width:10px; height:10px; flex:none; border-radius:50%; border:1px solid rgba(255,255,255,.35); }
.vnccs-uc-pose-character-item input[type=text] { width:100%; box-sizing:border-box; min-width:0; }
.vnccs-uc-pose-root .vnccs-ps-loading-overlay { pointer-events:none; background:transparent; backdrop-filter:none; }
`;

export class UniCanvasPoseEditor {
    constructor(host) {
        this.host = host;
        this.token = 0;
        this.visible = false;
        this.ready = null;
        this.abort = new AbortController();
        if (!document.getElementById("vnccs-uc-pose-style")) {
            const style = document.createElement("style");
            style.id = "vnccs-uc-pose-style"; style.textContent = styles;
            document.head.appendChild(style);
        }
    }

    async activate(layer, { show = true } = {}) {
        if (this.layer === layer && this.studio) {
            this.setVisible(show);
            await this.ready;
            return;
        }
        this.release();
        const token = ++this.token;
        this.layer = layer;
        const value = { name: "pose_data", value: JSON.stringify(layer.pose.studio || {}) };
        // An isolated state adapter, not a second graph node or another renderer implementation.
        const node = { id: `${this.host.node.id}_pose_${layer.id}`, widgets: [value], size: this.host.node.size };
        this.studio = new PoseStudioWidget(node, {
            embedded: true,
            onStateChange: data => {
                if (this.token !== token || !this.host.layers.includes(layer)) return;
                if (this.initialized) { this.applyDimensions(data.export); this.saveViewport(); }
                const meshKey = JSON.stringify(data?.characters?.map?.(item => item?.mesh) ?? data?.mesh ?? null);
                if (meshKey !== this.meshKey) { this.meshKey = meshKey; this.backdrop?.invalidate(); }
                const key = JSON.stringify([data, layer.pose.viewport]);
                // Removed mannequins drop their reference; a replaced scene keeps them by slot.
                if (Array.isArray(layer.pose.studio?.characters) && Array.isArray(data?.characters)) {
                    reconcilePoseCharacterRefs(layer.pose, poseStudioCharacters(layer.pose), poseStudioCharacters({ studio: data }));
                }
                layer.pose.studio = clone(data);
                this.refreshCharacterMenu();
                if (key === this.stateKey) return;
                this.stateKey = key;
                this.host.syncLightStateToWidget();
                this.host.scheduleFullSync();
            },
            onViewportRender: () => {
                if (this.token !== token || !this.initialized || this.capturing || !this.visible) return;
                this.capturePreview();
            },
        });
        const studio = this.studio;
        studio.container.classList.add("vnccs-uc-pose-root");
        this.host.container.appendChild(studio.container);
        this.buildDock();
        this.selectController = installCustomSelects(studio.container, { theme: "pose-studio" });
        this.setVisible(show);
        this.ready = (async () => {
            await studio._viewerInitPromise;
            if (this.token !== token) return;
            studio.loadFromNode();
            studio.exportParams.view_width = Math.round(layer.pose.rect.width);
            studio.exportParams.view_height = Math.round(layer.pose.rect.height);
            await studio.loadModel(true, false);
            if (this.token !== token) return;
            await studio.awaitReadyForCompositeCapture();
            if (this.token !== token || this.host._disposed) return;
            studio.viewer.scene.background = null;
            if (studio.viewer.gridHelper) studio.viewer.gridHelper.visible = false;
            if (studio.viewer.captureFrame) studio.viewer.captureFrame.visible = false;
            // Mannequin only, over a flat backdrop of the layers below that it cannot sink behind.
            this.backdrop = new UniCanvasPoseBackdrop(this);
            if (layer.pose.viewport) {
                const camera = layer.pose.viewport;
                studio.viewer.camera.position.fromArray(camera.position);
                studio.viewer.orbit.target.fromArray(camera.target);
                studio.viewer.camera.fov = camera.fov;
                studio.viewer.camera.zoom = camera.zoom || 1;
                studio.viewer.camera.updateProjectionMatrix();
                studio.viewer.orbit.update();
            } else studio.applyCameraToViewer(true);
            studio.viewer.orbit.addEventListener("end", () => {
                if (this.token === token) this.commit();
            });
            this.initialized = true;
            this.layout();
            this.capturePreview(true);
            studio.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
            void studio.refreshLibrary(false);
        })();
        try { await this.ready; }
        catch (error) {
            if (this.token === token) {
                this.host.setStatus(`Pose Studio: ${error.message || error}`, true);
                this.release();
                this.host.setTool?.("move");
            }
            throw error;
        }
    }

    buildDock() {
        const studio = this.studio, root = studio.container;
        const controls = document.createElement("div"); controls.className = "vnccs-uc-pose-controls";
        this.controls = controls;
        // While editing, the right sidebar (denoise, masks, layers) is replaced by this panel.
        const side = document.createElement("div"); side.className = "vnccs-uc-pose-side";
        const head = document.createElement("div"); head.className = "vnccs-uc-pose-side-head";
        const headTitle = document.createElement("strong"); headTitle.textContent = "Edit pose";
        this.sideLayerName = document.createElement("span");
        head.append(headTitle, this.sideLayerName);
        const dock = document.createElement("div"); dock.className = "vnccs-uc-pose-dock";
        const tabs = document.createElement("div"); tabs.className = "vnccs-uc-pose-tabs";
        tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Pose settings");
        dock.appendChild(tabs);
        root.appendChild(studio.canvasContainer);
        // Keep shared scene state and action references alive without a second action toolbar.
        studio.centerPanel.hidden = true;
        const pages = [
            ["Body", studio.leftPanel], ["Scene", studio.rightSidebar],
        ];
        const panels = pages.map(([name, content], index) => {
            const page = document.createElement("div"); page.className = "vnccs-uc-pose-page";
            page.id = `uc-pose-${this.layer.id}-${index}`; page.setAttribute("role", "tabpanel");
            page.appendChild(content); page.hidden = index !== 0; dock.appendChild(page);
            const button = this.host._button(name, "vnccs-uc-btn", () => select(index));
            button.setAttribute("role", "tab"); button.setAttribute("aria-controls", page.id);
            button.setAttribute("aria-selected", String(index === 0));
            button.tabIndex = index === 0 ? 0 : -1;
            button.addEventListener("keydown", event => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? 0 : event.key === "End" ? pages.length - 1
                    : (index + (event.key === "ArrowRight" ? 1 : -1) + pages.length) % pages.length;
                select(next); panels[next].button.focus();
            });
            tabs.appendChild(button);
            return { page, button, scrollTop: 0, scrollLeft: 0 };
        });
        const select = index => {
            this.activePage = index;
            panels.forEach((entry, i) => {
                if (!entry.page.hidden) { entry.scrollTop = entry.page.scrollTop; entry.scrollLeft = entry.page.scrollLeft; }
                entry.page.hidden = i !== index;
                entry.button.classList.toggle("active", i === index);
                entry.button.setAttribute("aria-selected", String(i === index));
                entry.button.tabIndex = i === index ? 0 : -1;
                if (i === index) { entry.page.scrollTop = entry.scrollTop; entry.page.scrollLeft = entry.scrollLeft; }
            });
        };
        side.append(head, this.buildCharacterMenu(), dock);
        controls.append(this.buildEditBar());
        root.appendChild(controls);
        this.sidePanel = side;
        this.dock = dock;
        this.pages = panels;
        const savedUI = this.layer.pose.ui;
        panels.forEach((entry, index) => {
            entry.page.hidden = true;
            entry.scrollTop = savedUI?.pages?.[index]?.top || 0;
            entry.scrollLeft = savedUI?.pages?.[index]?.left || 0;
            entry.page.querySelectorAll?.(".vnccs-ps-section").forEach((section, sectionIndex) => {
                const collapsed = savedUI?.pages?.[index]?.collapsed?.[sectionIndex];
                if (typeof collapsed !== "boolean") return;
                section.classList.toggle("collapsed", collapsed);
                section.querySelector(".vnccs-ps-section-header")?.setAttribute("aria-expanded", String(!collapsed));
            });
        });
        select(Math.max(0, Math.min(panels.length - 1, savedUI?.tab || 0)));
        this.uiAbort?.abort(); this.uiAbort = new AbortController();
        // Keep all shared settings mounted; only visibility changes, so drafts and scroll survive.
        for (const element of [controls, side, studio.canvasContainer]) {
            element.addEventListener("keydown", event => {
                // Enter/Escape leave the editor from anywhere but a text field or a Pose Studio dialog.
                if ((event.key === "Escape" || event.key === "Enter") && !event.target.closest?.("input, textarea, select, [contenteditable], [role=dialog], [class*=modal]")) {
                    event.preventDefault();
                    this.host.finishPoseEdit(true);
                }
                event.stopPropagation();
            });
            element.addEventListener("pointerdown", event => event.stopPropagation());
            element.addEventListener("wheel", event => event.stopPropagation(), { passive: true });
        }
    }

    buildEditBar() {
        const bar = document.createElement("div"); bar.className = "vnccs-uc-pose-editbar";
        const title = document.createElement("strong"); title.textContent = "Editing pose";
        const hint = document.createElement("span"); hint.className = "vnccs-uc-pose-hint";
        hint.textContent = "Left: joints · Right-drag: orbit · Middle: pan · Wheel: zoom";
        const library = this.host._button("Pose Library", "vnccs-uc-btn", () => this.studio?.showLibraryModal?.(), "Load a pose from the Pose Library");
        const cancel = this.host._button("Cancel", "vnccs-uc-btn", () => this.host.finishPoseEdit(false), "Discard this edit session and restore the pose");
        const save = this.host._button("Save pose", "vnccs-uc-btn primary", () => this.host.finishPoseEdit(true), "Keep the pose and leave the editor (Enter / Esc)");
        bar.append(title, hint, library, cancel, save);
        this.editBar = bar;
        return bar;
    }

    // The pose settings take the right sidebar only while the editor is shown.
    mountSidebar(show) {
        if (!this.sidePanel) return;
        const side = this.host.side;
        if (show && side) {
            if (this.sidePanel.parentNode !== side) side.appendChild(this.sidePanel);
            this.sideLayerName.textContent = this.layer?.name || "";
        } else this.sidePanel.remove();
        this.host.container.classList.toggle("vnccs-uc-pose-editing", Boolean(show && side));
    }

    // The character reference is an inline sidebar section: "open" draws attention to it.
    setCharacterOpen(open) {
        if (!this.characterMenu) return;
        this.characterMenu.classList.toggle("attention", Boolean(open));
        if (!open) return;
        this.characterMenu.scrollIntoView?.({ block: "nearest" });
        const missing = this.layer ? poseCharacterIssues(this.host, this.layer)[0]?.characterId : null;
        (this.characterRowSelects?.get(missing) || this.characterSelect)?.focus({ preventScroll: true });
    }

    // With one mannequin the card is a single source picker; with 2+ it lists one row per
    // mannequin (studio color, name, reference, identity prompt) bound through characterRefs.
    buildCharacterMenu() {
        const menu = document.createElement("div"); menu.className = "vnccs-uc-pose-character";
        menu.id = `uc-pose-character-${this.layer.id}`;
        menu.setAttribute("role", "group"); menu.setAttribute("aria-label", "Character reference");
        const header = document.createElement("div"); header.className = "vnccs-uc-pose-character-header";
        const title = document.createElement("strong"); title.textContent = "Character reference";
        const count = document.createElement("span"); count.className = "vnccs-uc-pose-character-count"; count.hidden = true;
        header.append(title, count);
        const select = document.createElement("select"); select.className = "vnccs-uc-select";
        select.id = `${menu.id}-source`;
        select.setAttribute("aria-label", "Character image source");
        const image = document.createElement("img"); image.alt = "Selected character"; image.hidden = true;
        const row = document.createElement("div"); row.className = "vnccs-uc-pose-character-row";
        row.append(image, select);
        const issue = document.createElement("div"); issue.className = "vnccs-uc-pose-character-issue";
        const file = document.createElement("input"); file.type = "file"; file.accept = "image/*"; file.hidden = true;
        this.uploadTarget = null;
        const upload = this.host._button("Upload image", "vnccs-uc-btn", () => { this.uploadTarget = null; file.click(); });
        const clear = this.host._button("Clear", "vnccs-uc-btn", () => this.setCharacterReference(null, null, { keepOpen: true }));
        const actions = document.createElement("div"); actions.className = "vnccs-uc-pose-character-actions";
        actions.append(upload, clear);
        select.addEventListener("change", () => this.onCharacterSourceChange(select, null));
        file.addEventListener("change", async () => {
            const chosen = file.files?.[0]; file.value = "";
            const characterId = this.uploadTarget;
            if (!chosen) return;
            const token = this.token, layer = this.layer;
            try {
                const url = URL.createObjectURL(chosen);
                let loaded;
                try { loaded = await this.host.loadImage(url); } finally { URL.revokeObjectURL(url); }
                if (token !== this.token || !this.host.layers.includes(layer)) return;
                const scale = Math.min(1, 2048 / Math.max(loaded.width, loaded.height));
                const surface = this.host._createCanvas(Math.max(1, Math.round(loaded.width * scale)), Math.max(1, Math.round(loaded.height * scale)));
                surface.getContext("2d").drawImage(loaded, 0, 0, surface.width, surface.height);
                this.setCharacterReference(characterId, { source: "upload", name: chosen.name, dataURL: surface.toDataURL("image/png") });
            } catch (error) { this.host.setStatus(`Character image: ${error.message || error}`, true); }
        });
        const list = document.createElement("div"); list.className = "vnccs-uc-pose-character-list"; list.hidden = true;
        menu.append(header, row, issue, actions, list, file);
        this.characterMenu = menu; this.characterClear = clear; this.characterIssue = issue;
        this.characterSelect = select; this.characterPreview = image;
        this.characterCount = count; this.characterList = list; this.characterFile = file;
        this.characterSingleParts = [row, issue, actions];
        this.refreshCharacterMenu();
        return menu;
    }

    firstCharacterId() {
        return poseStudioCharacters(this.layer?.pose)[0].id;
    }

    // One history entry per reference change; the first mannequin also writes pose.character.
    setCharacterReference(characterId, ref, { keepOpen = false } = {}) {
        if (!this.layer) return;
        this.host.recordHistoryBefore();
        setPoseCharacterRef(this.layer.pose, characterId ?? this.firstCharacterId(), ref);
        this.characterMenuKey = null;
        if (!keepOpen) this.setCharacterOpen(false);
        this.refreshCharacterMenu(); this.host.syncToNode();
    }

    async onCharacterSourceChange(select, characterId) {
        if (select.value === "__uploaded__") return;
        if (select.value.startsWith("vnccs:")) {
            await this.pickVnccsCharacter(select.value.slice(6), characterId);
            return;
        }
        this.setCharacterReference(characterId, select.value ? { source: "layer", layerId: select.value } : null);
    }

    // Characters made with ComfyUI_VNCCS (Character Creator / Cloner), listed by its own
    // /vnccs/context_lists route; empty when that extension is not installed.
    async loadVnccsCharacters() {
        const host = this.host;
        if (host._vnccsCharacters) return host._vnccsCharacters;
        host._vnccsCharacters = fetch("/vnccs/context_lists")
            .then(res => (res.ok ? res.json() : {}))
            .then(data => (Array.isArray(data?.characters) ? data.characters.map(String).filter(Boolean) : []))
            .catch(() => []);
        const list = await host._vnccsCharacters;
        host._vnccsCharacters = Promise.resolve(list);
        return list;
    }

    async pickVnccsCharacter(name, characterId = null) {
        const token = this.token, layer = this.layer;
        try {
            const query = `character=${encodeURIComponent(name)}`;
            let res = await fetch(`/vnccs/get_cached_preview?${query}`);
            if (!res.ok) res = await fetch(`/vnccs/get_character_pose_preview?${query}&index=0`);
            if (!res.ok) throw new Error(`no preview image for ${name} (HTTP ${res.status})`);
            const blob = await res.blob();
            const dataURL = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(blob);
            });
            if (token !== this.token || !this.host.layers.includes(layer)) return;
            this.setCharacterReference(characterId, { source: "upload", name, vnccsCharacter: name, dataURL });
        } catch (error) {
            this.host.setStatus(`Character reference: ${error.message || error}`, true);
            this.characterMenuKey = null;
            this.refreshCharacterMenu();
        }
    }

    // Options of a source picker: VNCCS characters, the uploaded image, a legacy layer reference.
    fillCharacterSource(select, character) {
        const characters = this.host._vnccsCharacterList || [];
        select.replaceChildren(new Option(characters.length ? "Choose a character" : "No VNCCS characters - upload an image", ""));
        for (const name of characters) {
            if (character?.vnccsCharacter !== name) select.add(new Option(name, `vnccs:${name}`));
        }
        if (character?.source === "upload") select.add(new Option(character.name, "__uploaded__"));
        // Older poses referenced a canvas layer: keep showing that choice, but offer no new ones.
        const legacy = character?.source === "layer" ? this.host.layers.find(item => item.id === character.layerId) : null;
        if (legacy) select.add(new Option(`Layer: ${legacy.name}`, legacy.id));
        select.value = character?.source === "layer" ? character.layerId : character?.source === "upload" ? "__uploaded__" : "";
    }

    characterThumbnail(character) {
        const selected = character?.source === "layer" ? this.host.layers.find(item => item.id === character.layerId) : null;
        return character?.source === "upload" ? character.dataURL
            : selected ? this.host.getLayerThumbnailCanvas(selected, 256)?.toDataURL("image/png") : null;
    }

    refreshCharacterMenu() {
        if (!this.characterSelect || !this.layer) return;
        const pose = this.layer.pose;
        const mannequins = poseStudioCharacters(pose);
        const multi = mannequins.length > 1;
        const refs = mannequins.map(item => poseCharacterRef(this.layer, item.id));
        const characters = this.host._vnccsCharacterList || [];
        const key = JSON.stringify([refs.map(ref => [ref?.source, ref?.layerId, ref?.name]), characters,
            multi && [mannequins, pose.studio?.active_character_id ?? null]]);
        if (key === this.characterMenuKey) { this.host.poseBake?.renderCardChips(this); return; }
        this.characterMenuKey = key;
        if (!this.host._vnccsCharacterList) {
            void this.loadVnccsCharacters().then(list => {
                this.host._vnccsCharacterList = list;
                this.characterMenuKey = null;
                this.refreshCharacterMenu();
            });
        }
        this.characterSingleParts.forEach(part => { part.hidden = multi; });
        this.characterList.hidden = !multi;
        this.characterCount.hidden = !multi;
        if (multi) { this.renderCharacterRows(mannequins, refs); this.host.poseBake?.renderCardChips(this); return; }
        this.characterList.replaceChildren();
        const character = refs[0];
        this.fillCharacterSource(this.characterSelect, character);
        const src = this.characterThumbnail(character);
        this.characterPreview.hidden = !src;
        if (src) this.characterPreview.src = src;
        else this.characterPreview.removeAttribute("src");
        this.characterClear.disabled = !character;
        this.characterIssue.textContent = character ? "" : "Optional: bind a VNCCS character or an image to bake this mannequin.";
        this.host.poseBake?.renderCardChips(this);
    }

    renderCharacterRows(mannequins, refs) {
        const issues = new Map(poseCharacterIssues(this.host, this.layer).map(item => [item.characterId, item.issue]));
        const bound = mannequins.length - issues.size;
        this.characterCount.textContent = `${bound}/${mannequins.length} characters bound`;
        this.characterCount.classList.toggle("incomplete", bound < mannequins.length);
        const activeId = String(this.layer.pose.studio?.active_character_id ?? mannequins[0].id);
        const selects = new Map();
        const rows = mannequins.map((mannequin, index) => {
            const id = mannequin.id, ref = refs[index];
            const item = document.createElement("div"); item.className = "vnccs-uc-pose-character-item";
            item.classList.toggle("active", id === activeId);
            item.setAttribute("data-character-id", id);
            item.setAttribute("aria-label", `${mannequin.name} reference`);
            const head = document.createElement("div"); head.className = "vnccs-uc-pose-character-item-head";
            const dot = document.createElement("span"); dot.className = "vnccs-uc-pose-character-dot";
            dot.style.background = mannequin.color;
            const name = document.createElement("span"); name.textContent = mannequin.name;
            head.append(dot, name);
            const image = document.createElement("img"); image.alt = `${mannequin.name} reference`;
            const src = this.characterThumbnail(ref);
            image.hidden = !src; if (src) image.src = src;
            const select = document.createElement("select"); select.className = "vnccs-uc-select";
            select.setAttribute("aria-label", `${mannequin.name} image source`);
            this.fillCharacterSource(select, ref);
            selects.set(id, select);
            select.addEventListener("change", () => this.onCharacterSourceChange(select, id));
            const line = document.createElement("div"); line.className = "vnccs-uc-pose-character-row";
            line.append(image, select);
            const upload = this.host._button("Upload image", "vnccs-uc-btn", () => { this.uploadTarget = id; this.characterFile.click(); });
            const clear = this.host._button("Clear", "vnccs-uc-btn", () => this.setCharacterReference(id, null, { keepOpen: true }));
            clear.disabled = !ref;
            const actions = document.createElement("div"); actions.className = "vnccs-uc-pose-character-actions";
            actions.append(upload, clear);
            const prompt = document.createElement("input"); prompt.type = "text"; prompt.className = "vnccs-uc-input";
            prompt.placeholder = "Identity prompt (optional)"; prompt.value = poseCharacterPrompt(this.layer, id);
            prompt.setAttribute("aria-label", `${mannequin.name} identity prompt`);
            // One undo step per edit: history is recorded on the first keystroke after focus.
            let recorded = false;
            prompt.addEventListener("focus", () => { recorded = false; });
            prompt.addEventListener("input", () => {
                if (!recorded) { this.host.recordHistoryBefore(); recorded = true; }
                setPoseCharacterPrompt(this.layer.pose, id, prompt.value);
            });
            prompt.addEventListener("change", () => { recorded = false; this.host.syncToNode(); });
            const issue = document.createElement("div"); issue.className = "vnccs-uc-pose-character-issue";
            issue.textContent = issues.get(id) || "";
            item.append(head, line, actions, prompt, issue);
            // Selecting a row selects that mannequin in the embedded studio.
            item.addEventListener("click", event => {
                if (event.target?.closest?.("button, select, input")) return;
                if (String(this.studio?.activeCharacterId) !== id) void this.studio?.selectCharacter?.(id);
            });
            return item;
        });
        this.characterRowSelects = selects;
        this.characterList.replaceChildren(...rows);
    }

    // Pose Studio's own history (mannequin edits; the animation timeline in animation mode),
    // driven by UniCanvas's Undo/Redo buttons and Ctrl+Z / Ctrl+Y while a pose is edited.
    historyDepth() {
        const viewer = this.studio?.viewer;
        return { undo: viewer?.history?.length || 0, redo: viewer?.future?.length || 0 };
    }

    undo() {
        const studio = this.studio;
        if (!studio) return false;
        if (studio.isAnimationMode?.()) studio.undoAnimation?.();
        else studio.viewer?.undo?.();
        return true;
    }

    redo() {
        const studio = this.studio;
        if (!studio) return false;
        if (studio.isAnimationMode?.()) studio.redoAnimation?.();
        else studio.viewer?.redo?.();
        return true;
    }

    setVisible(visible) {
        this.visible = visible;
        if (!this.studio) return;
        this.studio.container.hidden = !visible;
        if (!visible && this.studio.viewer?.orbit) this.studio.viewer.orbit.enableDamping = false;
        this.host.container.classList.toggle("vnccs-uc-pose-active", visible);
        this.mountSidebar(visible);
        if (!visible) {
            this.setCharacterOpen(false);
            this.studio.animationTimeline?.stopPlayback?.();
            this.studio._closeCharacterRemoveModal?.();
            this.studio._activeSaveLibraryClose?.(true);
            this.studio._activeVideoImportClose?.();
            this.studio.hideHandControlPopover();
        }
        this.layout();
        this.host.requestRender();
    }

    layout() {
        if (!this.studio || !this.layer) return;
        if (!this.host.layers.includes(this.layer)) { this.release(); return; }
        const rect = this.layer.pose.rect, view = this.host.view, stage = this.host.stageWrap;
        const surface = this.studio.canvasContainer;
        // Controls are confined to the stage, leaving model settings, Generate and layers accessible.
        Object.assign(this.controls.style, { left: `${stage.offsetLeft}px`, top: `${stage.offsetTop}px`,
            width: `${stage.clientWidth}px`, height: `${stage.clientHeight}px` });
        this.controls.inert = this.layer.locked || !this.layer.visible || this.host.hasOpenStagingPanel();
        this.sidePanel.inert = this.layer.locked || !this.layer.visible;
        surface.style.left = `${stage.offsetLeft + view.x + rect.x * view.scale}px`;
        surface.style.top = `${stage.offsetTop + view.y + rect.y * view.scale}px`;
        surface.style.width = `${rect.width * view.scale}px`;
        surface.style.height = `${rect.height * view.scale}px`;
        surface.style.opacity = String(this.layer.opacity);
        surface.style.mixBlendMode = this.layer.blendMode === "source-over" ? "normal" : this.layer.blendMode;
        surface.hidden = !this.layer.visible || this.layer.locked || this.host.hasOpenStagingPanel();
        // The bbox surface is clipped to the canvas region even when it crosses a sidebar.
        const x = view.x + rect.x * view.scale, y = view.y + rect.y * view.scale;
        const width = rect.width * view.scale, height = rect.height * view.scale;
        surface.style.clipPath = `inset(${Math.max(0,-y)}px ${Math.max(0,x+width-stage.clientWidth)}px ${Math.max(0,y+height-stage.clientHeight)}px ${Math.max(0,-x)}px)`;
        if (!this.visible && this.initialized) {
            const scale = Math.min(1, 1024 / Math.max(rect.width, rect.height));
            this.studio.performViewerResize(Math.round(rect.width * scale), Math.round(rect.height * scale));
        }
        this.refreshCharacterMenu();
    }

    captureSurface(size, transparent = true, targetCanvas = null) {
        if (!this.initialized) return null;
        const target = targetCanvas || (transparent
            ? (this.previewSurface ||= this.host._createCanvas(size.width, size.height))
            : this.host._createCanvas(size.width, size.height));
        const w = this.studio, v = w.viewer;
        const result = v.capture(size.width, size.height, 1, w.exportParams.bg_color, 0, 0,
            w.exportParams.cam_yaw_deg || 0, w.exportParams.cam_pitch_deg || 0,
            { targetCanvas: target, transparent, hideReference: true, viewport: true });
        if (this.visible) v.renderInteractionOverlay();
        return result;
    }

    // Every mannequin with its viewer mesh: the active one is the studio's skinned mesh, the
    // others are Pose Studio's passive rigs keyed by character id.
    characterMeshes() {
        const v = this.studio?.viewer;
        if (!v) return [];
        const meshes = [];
        const activeId = String(this.studio.activeCharacterId ?? poseStudioCharacters(this.layer?.pose)[0].id);
        if (v.skinnedMesh) meshes.push([activeId, v.skinnedMesh]);
        for (const [id, entry] of v.passiveCharacters?.entries?.() || []) {
            if (entry?.mesh && String(id) !== activeId) meshes.push([String(id), entry.mesh]);
        }
        return meshes;
    }

    /**
     * Exact visible-pixel map per mannequin: each one unlit in its POSE_ID_COLORS entry (by slot
     * order), everything else hidden, through the same viewer.capture call as the layer pixels,
     * so depth resolves occlusion. Materials and visibility are restored afterwards.
     */
    captureIdPass(size) {
        if (!this.initialized) return null;
        const w = this.studio, v = w.viewer, THREE = v.THREE;
        if (!THREE?.MeshBasicMaterial || !v.scene) return null;
        const ids = poseStudioCharacters(this.layer.pose).map(item => item.id).slice(0, POSE_ID_COLORS.length);
        const meshes = this.characterMeshes().filter(([id]) => ids.includes(id));
        const characterMeshes = new Set(meshes.map(([, mesh]) => mesh));
        const hidden = [], swapped = [], materials = [];
        v.scene.traverse(object => {
            if (characterMeshes.has(object) || !(object.isMesh || object.isLine || object.isPoints || object.isSprite)) return;
            if (object.visible) { hidden.push(object); object.visible = false; }
        });
        for (const [id, mesh] of meshes) {
            const [r, g, b] = POSE_ID_COLORS[ids.indexOf(id)];
            const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(r / 255, g / 255, b / 255), toneMapped: false });
            materials.push(material);
            swapped.push([mesh, mesh.material, mesh.visible]);
            mesh.material = Array.isArray(mesh.material) ? mesh.material.map(() => material) : material;
            mesh.visible = true;
        }
        const target = this.host._createCanvas(size.width, size.height);
        let result = null;
        try {
            result = v.capture(size.width, size.height, 1, w.exportParams.bg_color, 0, 0,
                w.exportParams.cam_yaw_deg || 0, w.exportParams.cam_pitch_deg || 0,
                { targetCanvas: target, transparent: true, hideReference: true, viewport: true });
        } finally {
            for (const [mesh, material, visible] of swapped) { mesh.material = material; mesh.visible = visible; }
            hidden.forEach(object => { object.visible = true; });
            materials.forEach(material => material.dispose?.());
            if (this.visible) v.renderInteractionOverlay?.();
        }
        return result ? { canvas: result, ids } : null;
    }

    /**
     * Camera-space normals of every mannequin (MeshNormalMaterial packs them as n * 0.5 + 0.5, no
     * color space conversion), with the same camera and size as the ID pass, for the relight in
     * the Harmonize panel (vnccs_unicanvas_harmonize.mjs). Materials and visibility are restored.
     */
    captureNormalPass(size) {
        if (!this.initialized) return null;
        const w = this.studio, v = w.viewer, THREE = v.THREE;
        if (!THREE?.MeshNormalMaterial || !v.scene) return null;
        const meshes = this.characterMeshes();
        const characterMeshes = new Set(meshes.map(([, mesh]) => mesh));
        const hidden = [], swapped = [];
        v.scene.traverse(object => {
            if (characterMeshes.has(object) || !(object.isMesh || object.isLine || object.isPoints || object.isSprite)) return;
            if (object.visible) { hidden.push(object); object.visible = false; }
        });
        const material = new THREE.MeshNormalMaterial();
        for (const [, mesh] of meshes) {
            swapped.push([mesh, mesh.material, mesh.visible]);
            mesh.material = Array.isArray(mesh.material) ? mesh.material.map(() => material) : material;
            mesh.visible = true;
        }
        const target = this.host._createCanvas(size.width, size.height);
        let result = null;
        try {
            result = v.capture(size.width, size.height, 1, w.exportParams.bg_color, 0, 0,
                w.exportParams.cam_yaw_deg || 0, w.exportParams.cam_pitch_deg || 0,
                { targetCanvas: target, transparent: true, hideReference: true, viewport: true });
        } finally {
            for (const [mesh, previous, visible] of swapped) { mesh.material = previous; mesh.visible = visible; }
            hidden.forEach(object => { object.visible = true; });
            material.dispose?.();
            if (this.visible) v.renderInteractionOverlay?.();
        }
        return result ? { canvas: result } : null;
    }

    /** One mannequin alone with the normal transparent capture, including parts others occlude. */
    captureSoloPass(size, characterId) {
        if (!this.initialized) return null;
        const others = this.characterMeshes().filter(([id]) => id !== String(characterId)).map(([, mesh]) => mesh);
        const visibility = others.map(mesh => mesh.visible);
        others.forEach(mesh => { mesh.visible = false; });
        try {
            return this.captureSurface(size, true, this.host._createCanvas(size.width, size.height));
        } finally {
            others.forEach((mesh, index) => { mesh.visible = visibility[index]; });
        }
    }

    // After every commit the layer carries a current ID canvas (runtime only; the state cache
    // stores it as a PNG, workflow metadata never does). Unchanged scenes are not re-rendered.
    updateIdPass() {
        const layer = this.layer, rect = layer?.pose?.rect;
        if (!rect) return;
        const key = poseIdKey(layer.pose);
        if (layer.poseIdCanvas && layer.poseIdMeta?.key === key) return;
        const scale = Math.min(1, 1024 / Math.max(rect.width, rect.height));
        const pass = this.captureIdPass({ width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) });
        if (!pass) return;
        layer.poseIdCanvas = pass.canvas;
        layer.poseIdMeta = { key, ids: pass.ids, rect: { ...rect } };
    }

    // The normal pass sits next to the ID pass: same key, camera and size (runtime + state cache).
    updateNormalPass() {
        const layer = this.layer, rect = layer?.pose?.rect;
        if (!rect) return;
        const key = poseIdKey(layer.pose);
        if (layer.poseNormalCanvas && layer.poseNormalMeta?.key === key) return;
        const scale = Math.min(1, 1024 / Math.max(rect.width, rect.height));
        const pass = this.captureNormalPass({ width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) });
        if (!pass) return;
        layer.poseNormalCanvas = pass.canvas;
        layer.poseNormalMeta = { key, rect: { ...rect } };
    }

    capturePreview(final = false) {
        if (this.capturing || !this.initialized || !this.host.layers.includes(this.layer)) return;
        this.capturing = true;
        try {
            const rect = this.layer.pose.rect;
            // The mannequin on screen IS this capture (the WebGL viewport only draws the gizmos),
            // so the live preview must have at least the pixels the screen shows: a fixed low
            // preview size looked rasterized and jumped to smooth on the final capture.
            const cap = 2048 / Math.max(rect.width, rect.height);
            const screen = (this.host.view?.scale || 1) * (window.devicePixelRatio || 1);
            const scale = Math.min(1, cap, final ? Math.max(screen, cap) : screen);
            const surface = this.captureSurface({ width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) });
            if (!surface) return;
            // The render is always the mannequin; a layer with baked characters shows its composite
            // view instead (vnccs_unicanvas_bake.mjs), rebuilt from this surface.
            this.layer.mannequinSurface = surface;
            if (this.host.poseBake?.showsBakedView(this.layer)) this.host.poseBake.rebuildView(this.layer);
            else {
                const ctx = this.layer.canvas.getContext("2d");
                ctx.clearRect(0, 0, this.layer.canvas.width, this.layer.canvas.height);
                ctx.drawImage(surface, rect.x - this.host.origin.x, rect.y - this.host.origin.y, rect.width, rect.height);
                this.layer.hiresCanvas = surface;
                this.layer.hiresRect = { ...rect };
                this.layer._bakeViewBaked = false;
            }
            this.updateOpenPose();
            this.host.markLayerPixelsChanged(this.layer);
            this.host.requestRender();
            if (final) this.host.refreshLayerRow?.(this.layer.id);
        } finally {
            this.capturing = false;
        }
    }

    applyDimensions(params) {
        if (!params) return;
        const previous = this.layer.pose.studio?.export || {};
        if (previous.view_width === params.view_width && previous.view_height === params.view_height) return;
        const rect = this.layer.pose.rect;
        const width = Math.max(64, Math.min(4096, Math.round(Number(params.view_width) || rect.width)));
        const height = Math.max(64, Math.min(4096, Math.round(Number(params.view_height) || rect.height)));
        if (rect.width === width && rect.height === height) return;
        const next = { ...rect, width, height };
        if (!this.host.ensureWorldRectBounds(next, 0)) return;
        const bbox = this.host.bbox;
        const followsBbox = ["x", "y", "width", "height"].every(key => bbox[key] === rect[key]);
        this.layer.pose.rect = next;
        if (followsBbox && !this.host.panorama) this.host.bbox = { ...next };
        this.layout();
        this.studio.performViewerResize(width, height);
        this.host.requestRender();
    }

    saveUI() {
        if (!this.layer || !this.pages) return;
        this.layer.pose.ui = { tab: this.activePage || 0, pages: this.pages.map(entry => ({
            top: entry.page.hidden ? entry.scrollTop : entry.page.scrollTop,
            left: entry.page.hidden ? entry.scrollLeft : entry.page.scrollLeft,
            collapsed: Array.from(entry.page.querySelectorAll?.(".vnccs-ps-section") || [], section => section.classList.contains("collapsed")),
        })) };
    }

    saveViewport() {
        const v = this.studio.viewer;
        this.layer.pose.viewport = { position: v.camera.position.toArray(), target: v.orbit.target.toArray(), fov: v.camera.fov, zoom: v.camera.zoom };
    }

    commit() {
        if (!this.initialized || !this.host.layers.includes(this.layer) || !poseAtPanoramaCamera(this.layer, this.host.panorama)) return;
        this.capturePreview(true);
        this.saveUI();
        this.saveViewport();
        this.host.panorama?.commitLayer(this.layer);
        this.studio.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
        this.updateIdPass();
        this.updateNormalPass();
        this.host.poseBake?.afterCommit(this.layer);
    }

    // A depth clamp moved a character: persist it once per frame, like any other studio edit.
    scheduleBackdropSync() {
        if (this.backdropSyncFrame) return;
        const token = this.token;
        this.backdropSyncFrame = requestAnimationFrame(() => {
            this.backdropSyncFrame = null;
            if (token !== this.token || !this.studio) return;
            this.studio.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
        });
    }

    async flush() {
        const token = this.token, studio = this.studio;
        await this.ready;
        if (token !== this.token) throw new Error("The pose layer changed while preparing the image.");
        if (!this.initialized) return;
        await studio.awaitReadyForCompositeCapture();
        if (token !== this.token) throw new Error("The pose layer changed while preparing the image.");
        this.commit();
        await this.studio.flushAnimationCacheUpload();
    }

    async generation(layer, size) {
        // A rotated spherical layer already contains the correctly warped pose.
        // Reopening its original camera here would change the generation view.
        const projected = !poseAtPanoramaCamera(layer, this.host.panorama);
        if (!projected) {
            await this.activate(layer, { show: this.host.tool === "pose" });
            await this.flush();
            if (this.layer !== layer) throw new Error("The pose layer changed. Generate again.");
        }
        if (!this.host.layers.includes(layer)) throw new Error("The pose layer changed. Generate again.");
        const token = this.token;
        const state = layer.pose.studio;
        const params = state.export || {};
        const bg = params.bg_color || [255, 255, 255];
        const image1 = this.host._createCanvas(size.width, size.height);
        const ctx = image1.getContext("2d");
        ctx.fillStyle = `rgb(${bg.join(",")})`;
        ctx.fillRect(0, 0, image1.width, image1.height);
        this.host.drawRasterLayerToWorldRect(ctx, layer, this.host.bbox,
            { x: 0, y: 0, width: image1.width, height: image1.height });
        const image2 = await composePoseReference(this.host, layer, size);
        if (token !== this.token || !this.host.layers.includes(layer)) throw new Error("The pose layer changed. Generate again.");
        const index = state.activeTab || 0;
        const posePrompt = state.pose_prompts?.[index] ?? state.poses?.[index]?.prompt ?? params.user_prompt ?? "";
        // Several bound references share image2 in columns: say which one is which.
        const multi = poseMultiReferences(layer);
        const mapping = multi ? posePromptMapping(multi.entries, multi.total) : "";
        const userPrompt = [posePrompt, this.host.settings.positive, mapping].filter(Boolean).join("\n");
        const positive = PoseStudioWidget.prototype.generatePromptFromLights.call(
            { exportParams: params }, state.lights || [], userPrompt,
        );
        const reference = image2.toDataURL("image/png");
        return {
            pose_edit: { image1: image1.toDataURL("image/png"), image2: reference },
            positive,
        };
    }

    /**
     * Inputs of one character bake over the working rect `work` (world coordinates), at `size`:
     * image1 is that character's solo pass over the studio background, image2 the lower visible
     * composite plus that character's reference, and the prompt is the studio pose prompt plus the
     * identity prompt, through the lights. `solo` is the transparent solo pass over `pose.rect`.
     */
    async bakeInputs(layer, characterId, work, size) {
        if (this.layer !== layer || !this.initialized) throw new Error("The pose layer changed. Bake again.");
        const token = this.token;
        const rect = { ...layer.pose.rect };
        const scale = Math.min(1, 2048 / Math.max(rect.width, rect.height));
        const solo = this.captureSoloPass({ width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) }, characterId);
        if (!solo) throw new Error("The pose editor could not render the character.");
        const state = layer.pose.studio || {};
        const params = state.export || {};
        const bg = params.bg_color || [255, 255, 255];
        const image1 = this.host._createCanvas(size.width, size.height);
        const ctx = image1.getContext("2d");
        ctx.fillStyle = `rgb(${bg.join(",")})`;
        ctx.fillRect(0, 0, image1.width, image1.height);
        const k = size.width / work.width;
        ctx.drawImage(solo, (rect.x - work.x) * k, (rect.y - work.y) * k, rect.width * k, rect.height * k);
        const image2 = await composePoseReference(this.host, layer, size, { rect: work, characterId });
        if (token !== this.token || !this.host.layers.includes(layer)) throw new Error("The pose layer changed. Bake again.");
        const index = state.activeTab || 0;
        const posePrompt = state.pose_prompts?.[index] ?? state.poses?.[index]?.prompt ?? params.user_prompt ?? "";
        const userPrompt = [posePrompt, poseCharacterPrompt(layer, characterId)].filter(Boolean).join("\n");
        const positive = PoseStudioWidget.prototype.generatePromptFromLights.call({ exportParams: params }, state.lights || [], userPrompt);
        return { image1: image1.toDataURL("image/png"), image2: image2.toDataURL("image/png"), positive, solo };
    }

    /**
     * OpenPose COCO-18 joints of every mannequin, normalized to `pose.rect`, kept on
     * `layer.pose.openpose` (serialized with the pose) for pose ControlNet layers
     * (vnccs_unicanvas_control_scene.mjs). Refreshed with every capture, so a linked control
     * layer follows the mannequin while it is dragged.
     */
    updateOpenPose() {
        const v = this.studio?.viewer, THREE = v?.THREE, camera = v?.camera, layer = this.layer;
        if (!THREE?.Vector3 || !camera || !layer?.pose) return;
        const people = [];
        try {
            for (const [id, mesh] of this.characterMeshes()) {
                if (mesh.visible === false) continue;
                mesh.updateMatrixWorld?.(true);
                const bone = name => mesh.skeleton?.bones?.find(item => item.name === name) || mesh.getObjectByName?.(name) || null;
                const worldOf = (name, offset) => {
                    const object = bone(name);
                    if (!object) return null;
                    return offset ? object.localToWorld(new THREE.Vector3(...offset)) : object.getWorldPosition(new THREE.Vector3());
                };
                const project = point => {
                    const projected = new THREE.Vector3(point.x, point.y, point.z).project(camera);
                    if (projected.z > 1 || projected.z < -1) return null;
                    return { x: Math.round((projected.x + 1) / 2 * 1e4) / 1e4, y: Math.round((1 - projected.y) / 2 * 1e4) / 1e4 };
                };
                people.push({ id, points: openPoseFromRig(worldOf, project) });
            }
        } catch (_) { return; }
        layer.pose.openpose = { key: poseIdKey(layer.pose), people };
    }

    /** Projected head box and feet contact point of one character, normalized to `pose.rect`. */
    characterAnchors(characterId) {
        const v = this.studio?.viewer, THREE = v?.THREE, camera = v?.camera;
        if (!THREE?.Vector3 || !camera) return null;
        const mesh = this.characterMeshes().find(([id]) => id === String(characterId))?.[1];
        if (!mesh) return null;
        const bone = name => mesh.skeleton?.bones?.find(item => item.name === name) || mesh.getObjectByName?.(name) || null;
        const project = object => {
            if (!object) return null;
            const point = object.getWorldPosition(new THREE.Vector3()).project(camera);
            return { x: (point.x + 1) / 2, y: (1 - point.y) / 2 };
        };
        try {
            mesh.updateMatrixWorld?.(true);
            const head = project(bone("head")), neck = project(bone("neck_01"));
            const feet = ["foot_l", "foot_r", "ball_l", "ball_r"].map(name => project(bone(name))).filter(Boolean);
            const result = {};
            if (head) {
                const aspect = (this.layer?.pose?.rect?.width || 1) / (this.layer?.pose?.rect?.height || 1);
                const half = Math.max(0.02, neck ? Math.hypot((head.x - neck.x) * aspect, head.y - neck.y) * 1.3 : 0.05);
                result.head = { x: head.x - half / aspect, y: head.y - half * 1.2, width: 2 * half / aspect, height: half * 2.2 };
            }
            if (feet.length) {
                const lowest = Math.max(...feet.map(point => point.y));
                result.feet = { x: feet.reduce((sum, point) => sum + point.x, 0) / feet.length, y: lowest };
            }
            return result.head || result.feet ? result : null;
        } catch (_) { return null; }
    }

    /**
     * Scene timeline (issue #18): renders studio animation frames of a pose layer without showing
     * the editor. The editor is activated hidden, each frame is applied transiently and captured
     * at the layer rect size, and the editor is released without a commit, so the layer keeps its
     * pose, pixels and history. `onFrame(frame, canvas)` receives every capture; `cancelled()`
     * stops between frames.
     */
    async captureAnimationFrames(layer, frames, { onFrame, cancelled } = {}) {
        const savedStudio = layer.pose.studio, savedViewport = layer.pose.viewport;
        await this.activate(layer, { show: false });
        const token = this.token, studio = this.studio;
        const editorMode = studio.exportParams.editor_mode;
        try {
            // Inline tracks load with the scene; a compact cache reference restores asynchronously
            // (started by loadFromNode in animation mode, deferred until requested in image mode).
            if (!studio._animationInitialized) studio.ensureAnimationInitialized();
            if (studio._animationCacheRestorePending && studio._animationCacheRestorePromise) await studio._animationCacheRestorePromise;
            if (token !== this.token) throw new Error("The pose layer changed while preparing its frames.");
            if (!studio._animationInitialized || !studio.animationState) throw new Error("The pose animation data is not available.");
            // applyAnimationFrame only steps in animation mode; the editor is discarded afterwards.
            studio.exportParams.editor_mode = "animation";
            const rect = layer.pose.rect;
            const size = { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
            let done = 0;
            for (const frame of frames) {
                if (cancelled?.() || token !== this.token) break;
                studio.applyAnimationFrame(frame, { transient: true, updateTimeline: false });
                const canvas = this.captureSurface(size, true, this.host._createCanvas(size.width, size.height));
                if (canvas) onFrame?.(frame, canvas);
                // Yield now and then so the page stays responsive during long preparations.
                if (++done % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
            }
        } finally {
            if (this.studio === studio) {
                studio.exportParams.editor_mode = editorMode;
                // No commit: the stepped frame must not become the layer's still.
                this.initialized = false;
                this.release();
            }
            layer.pose.studio = savedStudio;
            layer.pose.viewport = savedViewport;
        }
    }

    release() {
        this.saveUI();
        this.commit();
        ++this.token;
        this.initialized = false;
        if (this.backdropSyncFrame) cancelAnimationFrame(this.backdropSyncFrame);
        this.backdropSyncFrame = null;
        this.backdrop?.dispose(); this.backdrop = null; this.meshKey = null;
        this.selectController?.disconnect();
        this.uiAbort?.abort(); this.uiAbort = null;
        this.selectController = null;
        this.studio?.dispose();
        this.studio?.container.remove();
        this.studio = null; this.layer = null; this.ready = null; this.previewSurface = null;
        this.characterSelect = null; this.characterMenuKey = null; this.characterBakeSlot = null; this.characterList = null; this.characterRowSelects = null; this.stateKey = null; this.pages = null;
        this.sidePanel?.remove();
        this.controls = null; this.characterMenu = null; this.sidePanel = null; this.editBar = null;
        this.host.container.classList.remove("vnccs-uc-pose-active", "vnccs-uc-pose-editing");
    }
    dispose() { this.release(); this.abort.abort(); }
}
