// Prompt help ("?" next to the prompt) driven by the backend model-family descriptors.
//
// /vnccs/unicanvas/assets returns "model_modules": one UniCanvasModelModule.describe() per
// family, whose capabilities.prompt_guide carries a one-line hint and a short guide. A new
// family therefore gets its prompt help without any frontend change. The guide text comes
// from the server and is only ever written with textContent.

export const PROMPT_GUIDE_CSS = `
.vnccs-uc-prompt-head { display:flex; align-items:center; justify-content:space-between; gap:6px; }
.vnccs-uc-prompt-help { width:18px; height:18px; padding:0; border-radius:50%; border:1px solid var(--uc-border); background:rgba(255,255,255,.06); color:var(--uc-text); font:inherit; font-size:11px; line-height:16px; cursor:pointer; }
.vnccs-uc-prompt-help[aria-expanded="true"] { background:rgba(123,92,255,.35); border-color:rgba(160,140,255,.7); }
.vnccs-uc-prompt-guide { display:flex; flex-direction:column; gap:6px; padding:8px 10px; border:1px solid var(--uc-border); border-left:3px solid rgba(160,140,255,.8); border-radius:8px; background:rgba(123,92,255,.08); color:var(--uc-text); font-size:11px; line-height:1.4; }
.vnccs-uc-prompt-guide-title { font-weight:600; }
.vnccs-uc-prompt-guide-meta { color:var(--uc-muted); }
.vnccs-uc-prompt-guide-examples { margin:0; padding-left:16px; }
.vnccs-uc-prompt-guide-examples li { font-family:monospace; white-space:pre-wrap; }
`;

export function indexModelDescriptors(modelModules) {
  const index = new Map();
  for (const descriptor of Array.isArray(modelModules) ? modelModules : []) {
    if (!descriptor || !descriptor.key) continue;
    index.set(String(descriptor.key).toLowerCase(), descriptor);
    for (const alias of descriptor.aliases || []) index.set(String(alias).toLowerCase(), descriptor);
  }
  return index;
}

export function referenceSlotLabels(references) {
  if (!references || !references.slot_label) return [];
  const count = Math.max(0, Number(references.max_images) || 0) + 1; // slot 1 is the working area
  return Array.from({ length: count }, (_, index) => String(references.slot_label).replace("{n}", String(index + 1)));
}

// taskKey (e.g. "image_to_video") selects the task's own guide when the family declares one;
// without it the family-wide guide is used and taskGuides lists the tasks that prompt differently.
export function resolvePromptGuide(index, generationMode, taskKey = null) {
  const descriptor = index?.get(String(generationMode || "").toLowerCase());
  const capabilities = descriptor?.capabilities;
  if (!capabilities?.prompt_guide) return null;
  const tasks = Array.isArray(capabilities.tasks) ? capabilities.tasks : [];
  const task = taskKey ? tasks.find((entry) => entry.key === taskKey) : null;
  const guide = task?.prompt_guide || capabilities.prompt_guide;
  return {
    key: descriptor.key,
    label: capabilities.label || descriptor.key,
    role: descriptor.role || "",
    task: task ? task.label : null,
    taskGuides: task ? [] : tasks.filter((entry) => entry.prompt_guide).map((entry) => ({ task: entry.label, hint: String(entry.prompt_guide.hint || "") })),
    hint: String(guide.hint || ""),
    paragraphs: String(guide.guide || "").split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean),
    examples: (guide.examples || []).map(String),
    sources: (guide.sources || []).map(String),
    negativePrompt: guide.negative_prompt !== false,
    tasks: tasks.filter((task) => task.available !== false).map((task) => task.label),
    plannedTasks: tasks.filter((task) => task.available === false).map((task) => task.label),
    referenceSlots: referenceSlotLabels(capabilities.references),
  };
}

function textElement(doc, tag, className, text) {
  const element = doc.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

export function renderPromptGuide(container, guide, doc = globalThis.document) {
  if (!guide) {
    container.replaceChildren(textElement(doc, "div", "vnccs-uc-prompt-guide-meta", "No prompt guide for this model."));
    return;
  }
  const title = guide.task ? `${guide.label} - ${guide.task} - how to prompt` : `${guide.label} - how to prompt`;
  const nodes = [textElement(doc, "div", "vnccs-uc-prompt-guide-title", title)];
  for (const paragraph of guide.paragraphs) nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-text", paragraph));
  if (guide.referenceSlots.length) {
    nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-meta",
      `Picture slots: ${guide.referenceSlots[0]} is the working area; ${guide.referenceSlots.slice(1).join(", ")} are reference images.`));
  }
  if (!guide.negativePrompt) nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-meta", "This model does not use the negative prompt."));
  if (guide.tasks.length) nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-meta", `Tasks: ${guide.tasks.join(", ")}`));
  if (guide.plannedTasks.length) nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-meta", `Coming later: ${guide.plannedTasks.join(", ")}`));
  for (const entry of guide.taskGuides || []) {
    nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-meta", `${entry.task} prompts differently: ${entry.hint}`));
  }
  if (guide.examples.length) {
    nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-meta", "Examples:"));
    const list = doc.createElement("ul");
    list.className = "vnccs-uc-prompt-guide-examples";
    list.append(...guide.examples.map((example) => textElement(doc, "li", "", example)));
    nodes.push(list);
  }
  if (guide.sources?.length) nodes.push(textElement(doc, "div", "vnccs-uc-prompt-guide-meta", `Sources: ${guide.sources.join(" | ")}`));
  container.replaceChildren(...nodes);
}
