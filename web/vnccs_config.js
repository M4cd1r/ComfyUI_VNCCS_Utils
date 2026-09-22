import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const REFERENCE_INPUTS = ["reference_image_1", "reference_image_2", "reference_image_3", "reference_image_4"];

class UniCanvasConfigWidget {
  constructor(node) {
    this.node = node;
    this.state = this._readState();
    this.loraNames = [];
    this.container = document.createElement("div");
    this.container.className = "vnccs-config-root";
    this.container.innerHTML = `
      <style>
        .vnccs-config-root { display:flex; flex-direction:column; gap:8px; padding:8px; color:#eee; font:12px sans-serif; }
        .vnccs-config-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
        .vnccs-config-lora { display:grid; grid-template-columns:minmax(0,2fr) 64px 24px; gap:6px; align-items:center; }
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
        this.node.removeInput(index);
        this.node.setDirtyCanvas(true, true);
      }
    });
  }

  renderLoras() {
    this.loraList.innerHTML = "";
    this.state.loras.forEach((entry, index) => {
      const row = document.createElement("div");
      row.className = "vnccs-config-lora";
      const options = this.loraNames
        .map((name) => `<option value="${name}" ${name === entry.name ? "selected" : ""}>${name}</option>`)
        .join("");
      row.innerHTML = `
        <select data-field="name" data-index="${index}">${options}</select>
        <input type="number" min="0" max="2" step="0.05" value="${entry.strength}" data-field="strength" data-index="${index}">
        <button class="vnccs-config-btn" data-lora-action="remove-lora" data-index="${index}">✕</button>`;
      this.loraList.appendChild(row);
    });
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
      setTimeout(() => this.configWidget?._syncReferenceInputs(), 50);
    };
  },
});
