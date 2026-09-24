/** Pose Studio host contract and image preparation for UniCanvas pose layers. */
import { PoseStudioWidget } from "./vnccs_pose_studio.js";

import { installCustomSelects } from "./vnccs_custom_select.mjs";
import { composePoseReference, isImageLayer, poseAtPanoramaCamera } from "./vnccs_unicanvas_pose_state.mjs";
import { UniCanvasPoseBackdrop } from "./vnccs_unicanvas_pose_backdrop.mjs";
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

const styles = `
.vnccs-unicanvas .vnccs-uc-pose-root { position:absolute; inset:0; display:block; width:auto; height:auto; min-width:0; min-height:0; background:none; border:0; border-radius:0; pointer-events:none; z-index:5; --vnccs-ps-ui-scale:1; --vnccs-ps-relative-ui-scale:1; }
.vnccs-unicanvas .vnccs-uc-pose-root:has(> .vnccs-ps-modal-overlay) { z-index:1000; }
.vnccs-uc-pose-controls { position:absolute; pointer-events:none; overflow:hidden; z-index:1; }
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
                layer.pose.studio = clone(data);
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
        this.characterSelect?.focus({ preventScroll: true });
    }

    buildCharacterMenu() {
        const menu = document.createElement("div"); menu.className = "vnccs-uc-pose-character";
        menu.id = `uc-pose-character-${this.layer.id}`;
        menu.setAttribute("role", "group"); menu.setAttribute("aria-label", "Character reference");
        const header = document.createElement("div"); header.className = "vnccs-uc-pose-character-header";
        const title = document.createElement("strong"); title.textContent = "Character reference";
        header.append(title);
        const select = document.createElement("select"); select.className = "vnccs-uc-select";
        select.id = `${menu.id}-source`;
        select.setAttribute("aria-label", "Character image source");
        const image = document.createElement("img"); image.alt = "Selected character"; image.hidden = true;
        const row = document.createElement("div"); row.className = "vnccs-uc-pose-character-row";
        row.append(image, select);
        const issue = document.createElement("div"); issue.className = "vnccs-uc-pose-character-issue";
        const file = document.createElement("input"); file.type = "file"; file.accept = "image/*"; file.hidden = true;
        const upload = this.host._button("Upload image", "vnccs-uc-btn", () => file.click());
        const clear = this.host._button("Clear", "vnccs-uc-btn", () => {
            this.host.recordHistoryBefore(); this.layer.pose.character = null;
            this.refreshCharacterMenu(); this.host.syncToNode();
        });
        const actions = document.createElement("div"); actions.className = "vnccs-uc-pose-character-actions";
        actions.append(upload, clear);
        select.addEventListener("change", () => {
            if (select.value === "__uploaded__") return;
            this.host.recordHistoryBefore();
            this.layer.pose.character = select.value ? { source: "layer", layerId: select.value } : null;
            this.setCharacterOpen(false);
            this.refreshCharacterMenu(); this.host.syncToNode();
        });
        file.addEventListener("change", async () => {
            const chosen = file.files?.[0]; file.value = "";
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
                this.host.recordHistoryBefore();
                layer.pose.character = { source: "upload", name: chosen.name, dataURL: surface.toDataURL("image/png") };
                this.characterMenuKey = null;
                this.setCharacterOpen(false);
                this.refreshCharacterMenu(); this.host.syncToNode();
            } catch (error) { this.host.setStatus(`Character image: ${error.message || error}`, true); }
        });
        menu.append(header, row, issue, actions, file);
        this.characterMenu = menu; this.characterClear = clear; this.characterIssue = issue;
        this.characterSelect = select; this.characterPreview = image;
        this.refreshCharacterMenu();
        return menu;
    }

    refreshCharacterMenu() {
        if (!this.characterSelect) return;
        const select = this.characterSelect, character = this.layer.pose.character;
        const key = JSON.stringify([character?.source, character?.layerId, character?.name, this.host.layers.map(l => [l.id, l.name, l.type])]);
        if (key === this.characterMenuKey) return;
        this.characterMenuKey = key;
        select.replaceChildren(new Option("Choose a layer", ""));
        if (character?.source === "upload") select.add(new Option(character.name, "__uploaded__"));
        for (const layer of this.host.layers) {
            if (layer !== this.layer && isImageLayer(layer)) select.add(new Option(layer.name, layer.id));
        }
        select.value = character?.source === "layer" ? character.layerId : character?.source === "upload" ? "__uploaded__" : "";
        const selected = character?.source === "layer" ? this.host.layers.find(item => item.id === character.layerId) : null;
        const src = character?.source === "upload" ? character.dataURL
            : selected ? this.host.getLayerThumbnailCanvas(selected, 256)?.toDataURL("image/png") : null;
        this.characterPreview.hidden = !src;
        if (src) this.characterPreview.src = src;
        else this.characterPreview.removeAttribute("src");
        this.characterClear.disabled = !character;
        this.characterIssue.textContent = character ? "" : "Needed to generate: pick a layer or upload an image.";
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

    captureSurface(size, transparent = true) {
        if (!this.initialized) return null;
        const target = transparent
            ? (this.previewSurface ||= this.host._createCanvas(size.width, size.height))
            : this.host._createCanvas(size.width, size.height);
        const w = this.studio, v = w.viewer;
        const result = v.capture(size.width, size.height, 1, w.exportParams.bg_color, 0, 0,
            w.exportParams.cam_yaw_deg || 0, w.exportParams.cam_pitch_deg || 0,
            { targetCanvas: target, transparent, hideReference: true, viewport: true });
        if (this.visible) v.renderInteractionOverlay();
        return result;
    }

    capturePreview(final = false) {
        if (this.capturing || !this.initialized || !this.host.layers.includes(this.layer)) return;
        this.capturing = true;
        try {
            const rect = this.layer.pose.rect;
            const scale = Math.min(1, (final ? 2048 : 768) / Math.max(rect.width, rect.height));
            const surface = this.captureSurface({ width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) });
            if (!surface) return;
            const ctx = this.layer.canvas.getContext("2d");
            ctx.clearRect(0, 0, this.layer.canvas.width, this.layer.canvas.height);
            ctx.drawImage(surface, rect.x - this.host.origin.x, rect.y - this.host.origin.y, rect.width, rect.height);
            this.layer.hiresCanvas = surface;
            this.layer.hiresRect = { ...rect };
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
        const userPrompt = [posePrompt, this.host.settings.positive].filter(Boolean).join("\n");
        const positive = PoseStudioWidget.prototype.generatePromptFromLights.call(
            { exportParams: params }, state.lights || [], userPrompt,
        );
        const reference = image2.toDataURL("image/png");
        return {
            pose_edit: { image1: image1.toDataURL("image/png"), image2: reference },
            positive,
        };
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
        this.characterSelect = null; this.characterMenuKey = null; this.stateKey = null; this.pages = null;
        this.sidePanel?.remove();
        this.controls = null; this.characterMenu = null; this.sidePanel = null; this.editBar = null;
        this.host.container.classList.remove("vnccs-uc-pose-active", "vnccs-uc-pose-editing");
    }
    dispose() { this.release(); this.abort.abort(); }
}
