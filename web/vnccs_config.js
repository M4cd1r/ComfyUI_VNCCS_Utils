import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { installCustomSelects } from "./vnccs_custom_select.mjs";

const REFERENCE_INPUTS = ["reference_image_1", "reference_image_2", "reference_image_3", "reference_image_4"];

class UniCanvasConfigWidget {
  constructor(node) {
    this.node = node;
    this.state = this._readState();
    this.loraNames = [];
    this.dragLoraIndex = null;
    this.container = document.createElement("div");
    this.container.className = "vnccs-config-root";
    this.container.innerHTML = `
      <style>
        .vnccs-config-root { display:flex; flex-direction:column; gap:8px; padding:8px; color:#eee; font:12px sans-serif; }
        .vnccs-config-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
        .vnccs-config-lora { display:grid; grid-template-columns:minmax(0,2fr) 58px 22px 24px; gap:6px; align-items:center; cursor:grab; }
        .vnccs-config-lora input[type="checkbox"] { margin:0; accent-color:#ffd45c; cursor:pointer; }
        .vnccs-config-lora input[type="number"] { cursor:text; }
        .vnccs-config-lora.dragging { opacity:.5; }
        .vnccs-config-lora.drop-target { outline:1px dashed #ffd45c; outline-offset:1px; border-radius:4px; }
        .vnccs-config-btn { border:1px solid #555; background:#222; color:#eee; border-radius:6px; height:26px; cursor:pointer; }
        .vnccs-config-switch { width:42px; height:22px; border-radius:999px; border:1px solid #f08fa3; background:#f08fa322; position:relative; cursor:pointer; }
        .vnccs-config-switch::after { content:""; position:absolute; top:3px; left:3px; width:14px; height:14px; border-radius:50%; background:#aaa; transition:left .12s ease; }
        .vnccs-config-switch.on::after { left:23px; background:#ffd45c; }
      </style>
      <div class="vnccs-config-row"><strong>LoRA stack</strong><button class="vnccs-config-btn" data-action="add-lora">+ add LoRA</button></div>
      <div data-role="lora-list"></div>
      <div class="vnccs-config-row"><span>Edit model</span><div class="vnccs-config-switch" data-action="edit-model"></div></div>`;
    this.loraList = this.container.querySelector('[data-role="lora-list"]');
    this.editSwitch = this.container.querySelector('[data-action="edit-model"]');
    // Native selects (LoRA names) use the shared custom selector; the mutation
    // observer inside covers rows re-rendered later.
    installCustomSelects(this.container);
    this.editSwitch.classList.toggle("on", !!this.state.edit_model);

    this.container.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action], [data-lora-action]");
      if (!btn) return;
      const action = btn.dataset.action || btn.dataset.loraAction;
      if (action === "edit-model") {
        this.state.edit_model = !this.state.edit_model;
        this.editSwitch.classList.toggle("on", this.state.edit_model);
        this._syncReferenceInputs();
        this._writeState();
      } else if (action === "add-lora") {
        this.state.loras.push({ name: this.loraNames[0] || "", strength: 1.0, enabled: true });
        this.renderLoras();
        this._writeState();
      } else if (action === "remove-lora") {
        this.state.loras.splice(Number(btn.dataset.index), 1);
        this.renderLoras();
        this._writeState();
      }
    });
    // Realtime rule (AGENTS.md): strength updates from `input`, never on release.
    this.container.addEventListener("input", (e) => {
      const target = e.target;
      const index = Number(target.dataset.index);
      const entry = this.state.loras[index];
      if (!entry) return;
      if (target.dataset.field === "strength") entry.strength = Number(target.value);
      if (target.dataset.field === "enabled") entry.enabled = target.checked;
      this._writeState();
    });
    this.container.addEventListener("change", (e) => {
      const target = e.target;
      if (target.dataset.field === "name") {
        this.state.loras[Number(target.dataset.index)].name = target.value;
        this._writeState();
      }
    });

    this._loadLoraNames().then(() => {
      this.renderLoras();
      this._syncReferenceInputs();
    });
  }

  _readState() {
    const widget = this.node.widgets?.find((w) => w.name === "node_state");
    try {
      return { loras: [], edit_model: false, ...JSON.parse(widget?.value || "{}") };
    } catch {
      return { loras: [], edit_model: false };
    }
  }

  _writeState() {
    const widget = this.node.widgets?.find((w) => w.name === "node_state");
    if (widget) widget.value = JSON.stringify(this.state);
  }

  async _loadLoraNames() {
    try {
      const res = await api.fetchApi("/vnccs/unicanvas/loras");
      const data = await res.json();
      this.loraNames = data.loras || [];
    } catch {
      this.loraNames = [];
    }
  }

  _syncReferenceInputs() {
    REFERENCE_INPUTS.forEach((name) => {
      const index = (this.node.inputs || []).findIndex((input) => input?.name === name);
      if (this.state.edit_model) {
        if (index === -1) {
          this.node.addInput(name, "IMAGE");
          this.node.setDirtyCanvas(true, true);
        }
      } else if (index !== -1) {
        if (typeof this.node.disconnectInput === "function") this.node.disconnectInput(index);
        this.node.removeInput(index);
        this.node.setDirtyCanvas(true, true);
      }
    });
  }

  renderLoras() {
    this.loraList.innerHTML = "";
    this.state.loras.forEach((entry, index) => {
      // LoRA names come from the server listing and from persisted node_state JSON, so every row is
      // built with DOM APIs: no value is ever parsed as HTML/attribute text.
      if (typeof entry.enabled !== "boolean") {
        entry.enabled = entry.enabled === undefined ? true : Boolean(entry.enabled);
      }
      const row = document.createElement("div");
      row.className = "vnccs-config-lora";
      // Spec §3: the LoRA stack rows are drag-reorderable. The row is the drag source, any other row
      // is a drop target, and the reorder commits on drop (a discrete action: no undo semantics).
      row.draggable = true;
      row.dataset.index = String(index);
      row.title = "Drag to reorder";

      const select = document.createElement("select");
      select.dataset.field = "name";
      select.dataset.index = String(index);
      this.loraNames.forEach((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        if (name === entry.name) option.selected = true;
        select.appendChild(option);
      });

      const strength = document.createElement("input");
      strength.type = "number";
      strength.min = "0";
      strength.max = "2";
      strength.step = "0.05";
      strength.value = String(entry.strength);
      strength.dataset.field = "strength";
      strength.dataset.index = String(index);

      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = entry.enabled;
      enabled.title = "Enable LoRA";
      enabled.dataset.field = "enabled";
      enabled.dataset.index = String(index);

      const remove = document.createElement("button");
      remove.className = "vnccs-config-btn";
      remove.dataset.loraAction = "remove-lora";
      remove.dataset.index = String(index);
      remove.textContent = "✕";

      row.append(select, strength, enabled, remove);

      row.addEventListener("dragstart", (e) => {
        // A drag that starts on one of the row controls must not steal the control's own gesture
        // (text selection in the strength field, opening the picker), so the controls keep behaving
        // exactly as before the drag reorder existed.
        if (e.target?.closest?.("input, select, button")) {
          e.preventDefault();
          return;
        }
        this.dragLoraIndex = index;
        row.classList.add("dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(index));
        }
      });
      row.addEventListener("dragend", () => {
        this.dragLoraIndex = null;
        row.classList.remove("dragging");
        this.clearLoraDropMarkers();
      });
      row.addEventListener("dragover", (e) => {
        const from = this._dragLoraIndex(e);
        if (from === null || from === index) return;
        e.preventDefault();
        this.markLoraDropTarget(row);
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = this._dragLoraIndex(e);
        this.dragLoraIndex = null;
        this.clearLoraDropMarkers();
        // Dropping a row onto itself is a no-op: nothing moves, nothing is written.
        if (from === null || from === index) return;
        this.reorderLoras(from, index);
      });

      this.loraList.appendChild(row);
    });
  }

  _dragLoraIndex(e) {
    if (Number.isInteger(this.dragLoraIndex) && this.dragLoraIndex >= 0) return this.dragLoraIndex;
    const raw = e.dataTransfer?.getData?.("text/plain");
    const index = Number(raw);
    return raw !== undefined && raw !== "" && Number.isInteger(index) && index >= 0 ? index : null;
  }

  clearLoraDropMarkers() {
    this.loraList?.querySelectorAll?.(".drop-target").forEach((el) => el.classList.remove("drop-target"));
  }

  markLoraDropTarget(row) {
    this.clearLoraDropMarkers();
    row.classList.add("drop-target");
  }

  // Drop commit: the dragged entry lands on the index of the row it was dropped onto, then the
  // stack is re-rendered and persisted (single discrete action, no history entry).
  reorderLoras(from, to) {
    const total = this.state.loras.length;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return false;
    if (from < 0 || to < 0 || from >= total || to >= total) return false;
    const [entry] = this.state.loras.splice(from, 1);
    this.state.loras.splice(to, 0, entry);
    this.renderLoras();
    this._writeState();
    return true;
  }
}

app.registerExtension({
  name: "VNCCS.Config",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "VNCCS_Config") return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      const stateWidget = this.widgets?.find((w) => w.name === "node_state");
      if (stateWidget) {
        stateWidget.type = "hidden";
        stateWidget.hidden = true;
        stateWidget.computeSize = () => [0, -4];
        if (stateWidget.element) stateWidget.element.style.display = "none";
      }
      this.configWidget = new UniCanvasConfigWidget(this);
      this.addDOMWidget("vnccs_config_ui", "ui", this.configWidget.container, { serialize: false, hideOnZoom: false });
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      clearTimeout(this._vnccsConfigConfigureTimer);
      this._vnccsConfigConfigureTimer = setTimeout(() => {
        const widget = this.configWidget;
        if (!widget) return;
        // The constructor snapshot runs before widgets_values are applied, so re-read the persisted
        // node_state here, then resync the switch, the LoRA rows and the reference sockets from it
        // (same pattern as vnccs_unicanvas.js:6476 loadFromNode).
        widget.state = widget._readState();
        widget.editSwitch.classList.toggle("on", !!widget.state.edit_model);
        widget.renderLoras();
        widget._syncReferenceInputs();
      }, 50);
    };
  },
});
