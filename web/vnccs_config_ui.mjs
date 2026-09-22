/**
 * Shared DOM primitives for VNCCS config-style widgets (VNCSS Config node and
 * future Control Center panels): a fluid container-query layout, collapsible
 * sections, toggle switches, connection status dots and paired slider+number
 * controls. Pure DOM APIs — no value is ever parsed as HTML.
 */

const STYLE_ID = "vnccs-config-ui-styles";

export function ensureConfigStyles(doc = document) {
  if (!doc?.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.vnccs-config-ui { container-type: inline-size; display:flex; flex-direction:column; gap:6px; padding:8px; color:#eee; font:12px sans-serif; min-width:0; }
.vnccs-config-ui, .vnccs-config-ui * { box-sizing:border-box; }
.vnccs-cfg-section { border:1px solid #3a3744; border-radius:8px; background:#1c1a24; overflow:hidden; min-width:0; }
.vnccs-cfg-section-head { display:flex; align-items:center; gap:6px; padding:6px 8px; cursor:pointer; user-select:none; min-width:0; }
.vnccs-cfg-section-head:hover { background:#242130; }
.vnccs-cfg-chevron { width:12px; flex:0 0 auto; text-align:center; transition:transform .12s ease; color:#aaa; }
.vnccs-cfg-section.open .vnccs-cfg-chevron { transform:rotate(90deg); }
.vnccs-cfg-section-title { font-weight:600; flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-cfg-badge { color:#ffd45c; font-weight:600; white-space:nowrap; }
.vnccs-cfg-section-body { display:none; padding:6px 8px; }
.vnccs-cfg-section.open .vnccs-cfg-section-body { display:flex; flex-direction:column; gap:6px; }
.vnccs-cfg-row { display:flex; flex-wrap:wrap; align-items:center; gap:6px; min-width:0; }
.vnccs-cfg-grow { flex:1 1 120px; min-width:0; }
.vnccs-cfg-btn { border:1px solid #555; background:#222; color:#eee; border-radius:6px; height:24px; padding:0 8px; cursor:pointer; }
.vnccs-cfg-btn:hover { background:#2c2a38; }
.vnccs-cfg-input { background:#141219; border:1px solid #444; color:#eee; border-radius:6px; height:24px; padding:0 4px; }
.vnccs-cfg-pair { display:flex; align-items:center; gap:4px; flex:0 1 auto; min-width:0; }
.vnccs-cfg-pair input[type="range"] { width:76px; accent-color:#ffd45c; cursor:pointer; }
.vnccs-cfg-pair input[type="number"] { width:52px; cursor:text; }
.vnccs-cfg-dot { display:inline-flex; align-items:center; gap:4px; white-space:nowrap; color:#bbb; }
.vnccs-cfg-dot::before { content:""; width:8px; height:8px; border-radius:50%; background:#555; }
.vnccs-cfg-dot.on { color:#eee; }
.vnccs-cfg-dot.on::before { background:#7ddb6f; }
.vnccs-cfg-switch { width:38px; height:20px; flex:0 0 auto; border-radius:999px; border:1px solid #f08fa3; background:#f08fa322; position:relative; cursor:pointer; }
.vnccs-cfg-switch::after { content:""; position:absolute; top:2px; left:3px; width:14px; height:14px; border-radius:50%; background:#aaa; transition:left .12s ease; }
.vnccs-cfg-switch.on::after { left:19px; background:#ffd45c; }
.vnccs-cfg-refchip { display:flex; align-items:center; gap:6px; border:1px dashed #444; border-radius:8px; padding:4px 6px; min-width:0; }
.vnccs-cfg-refchip.connected { border-style:solid; border-color:#5a5670; }
.vnccs-cfg-refchip img { width:34px; height:34px; object-fit:cover; border-radius:4px; background:#111; }
.vnccs-cfg-refchip .vnccs-cfg-reflabel { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#ccc; }
.vnccs-cfg-refchip .vnccs-cfg-refindex { color:#ffd45c; font-weight:600; flex:0 0 auto; }
.vnccs-cfg-x { border:0; background:transparent; color:#f08fa3; cursor:pointer; font:inherit; padding:0 2px; }
@container (max-width: 269px) {
  .vnccs-cfg-pair input[type="range"] { width:56px; }
  .vnccs-cfg-pair input[type="number"] { width:44px; }
}
`;
  doc.head.appendChild(style);
}

/** Collapsible section: returns { root, body, setOpen, setBadge }. */
export function createCollapsibleSection({ title, badge = "", open = true, onToggle } = {}) {
  const root = document.createElement("div");
  root.className = "vnccs-cfg-section" + (open ? " open" : "");
  const head = document.createElement("div");
  head.className = "vnccs-cfg-section-head";
  const chevron = document.createElement("span");
  chevron.className = "vnccs-cfg-chevron";
  chevron.textContent = "\u25b8";
  const titleEl = document.createElement("span");
  titleEl.className = "vnccs-cfg-section-title";
  titleEl.textContent = title;
  const badgeEl = document.createElement("span");
  badgeEl.className = "vnccs-cfg-badge";
  badgeEl.textContent = badge;
  const body = document.createElement("div");
  body.className = "vnccs-cfg-section-body";
  head.append(chevron, titleEl, badgeEl);
  root.append(head, body);
  head.addEventListener("click", () => {
    // Only the header toggles; interactive controls live in the body and are
    // never descendants of the header, so they keep their own gestures.
    const willOpen = !root.classList.contains("open");
    root.classList.toggle("open", willOpen);
    onToggle?.(willOpen);
  });
  return {
    root,
    body,
    setOpen(next) {
      root.classList.toggle("open", !!next);
    },
    setBadge(text) {
      badgeEl.textContent = text;
    },
  };
}

/** Toggle switch: returns { root, get, set }. onChange receives the new value. */
export function createSwitch(enabled = false, onChange) {
  const root = document.createElement("div");
  root.className = "vnccs-cfg-switch" + (enabled ? " on" : "");
  root.title = "Toggle";
  root.addEventListener("click", () => {
    const next = !root.classList.contains("on");
    root.classList.toggle("on", next);
    onChange?.(next);
  });
  return {
    root,
    get: () => root.classList.contains("on"),
    set(next) {
      root.classList.toggle("on", !!next);
    },
  };
}

/** Connection status dot: returns { root, set(connected) }. */
export function createStatusDot(label) {
  const root = document.createElement("span");
  root.className = "vnccs-cfg-dot";
  root.textContent = label;
  return {
    root,
    set(connected) {
      root.classList.toggle("on", !!connected);
    },
  };
}

/**
 * Paired slider + exact number that stay in sync from every "input" event
 * (repository realtime rule); "change" only reports the committed value and a
 * double-click resets to resetValue (default 1.0).
 * Returns { root, get, set }.
 */
export function createSliderNumber({ min = 0, max = 2, step = 0.05, value = 1, resetValue = 1, onInput, onChange, onReset } = {}) {
  const clamp = (v) => Math.min(max, Math.max(min, Number(v)));
  const range = document.createElement("input");
  range.type = "range";
  range.min = String(min);
  range.max = String(max);
  range.step = String(step);
  range.value = String(value);
  const number = document.createElement("input");
  number.type = "number";
  number.min = String(min);
  number.max = String(max);
  number.step = String(step);
  number.value = String(value);
  const pair = document.createElement("div");
  pair.className = "vnccs-cfg-pair";
  pair.append(range, number);
  const sync = (source) => {
    const current = clamp(source.value);
    range.value = String(current);
    number.value = String(current);
    return current;
  };
  for (const control of [range, number]) {
    control.addEventListener("input", () => {
      const current = sync(control);
      onInput?.(current);
    });
    // "change" is commit-only; it must never be the first event that updates
    // the visible value (AGENTS.md realtime rule).
    control.addEventListener("change", () => onChange?.(clamp(range.value)));
    control.addEventListener("dblclick", () => {
      range.value = String(resetValue);
      number.value = String(resetValue);
      onReset?.(resetValue);
      onChange?.(resetValue);
    });
  }
  return {
    root: pair,
    get: () => clamp(range.value),
    set(next) {
      range.value = String(clamp(next));
      number.value = String(clamp(next));
    },
  };
}
