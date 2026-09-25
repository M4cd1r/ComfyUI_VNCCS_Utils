"""Content-based layer names from a small local vision model.

Backs ``POST /vnccs/unicanvas/describe_layers``::

    { layers: [{ id, image, prompt?, fallback? }], groups?: [{ id, children: [name] }], model? }
    -> { names: [{ id, name, category, parsed }], groups: [{ id, name }], model }

Models (Apache-2.0, downloaded on first use into ``models/LLM/``, one kept loaded):
Qwen3-VL-2B-Instruct (default, ~4 GB, recognises what it sees) and SmolVLM-256M-Instruct
(~500 MB, fast but vague). The model answers ``{"name": ..., "category": ...}``; the answer is
parsed strictly (a 1-5 word name, a category from ``LAYER_CATEGORIES``). On any parse failure the
layer gets the frontend's rules name (``fallback``) and ``Other``, never a raw model string. A
layer's generation prompt, when sent, is extra context for the model. Groups are named from their
children's names with the same model, text only.
"""

from __future__ import annotations

import json
import re
import threading
from typing import Any

from PIL import Image

from .helper_models import ensure_helper_model
from .imaging import _decode_data_url
from .locks import _COMFY_MODEL_OP_LOCK


SMOLVLM_KEY = "smolvlm_256m"
QWEN3VL_KEY = "qwen3vl_2b"
NAMING_MODELS = (QWEN3VL_KEY, SMOLVLM_KEY)
DEFAULT_NAMING_MODEL = QWEN3VL_KEY
MAX_LAYERS_PER_REQUEST = 16
MAX_GROUPS_PER_REQUEST = 16
LAYER_CATEGORIES = ("Background", "Characters", "Props", "Effects", "Lighting", "Overlays", "Other")
FALLBACK_CATEGORY = "Other"
NAME_PROMPT = (
    "This picture is one layer of a digital illustration. Give it a short layer name of 1 to 4 "
    "words describing its main subject, like 'Blonde Woman' or 'Night Street', and pick its "
    "category from: " + ", ".join(LAYER_CATEGORIES) + ". "
    'Answer with JSON only, like {"name": "Night Street", "category": "Background"}.'
)
PROMPT_CONTEXT = "The layer was generated from this prompt: "
GROUP_PROMPT = (
    "These layers are inside one folder of a digital illustration: {children}. "
    "Give the folder a short name of 1 to 3 words, like 'Street Props' or 'Weather'. "
    "Answer with the name only."
)
_MAX_PROMPT_CONTEXT = 300
_THUMBNAIL_SIZE = 384
_MODEL_LOCK = threading.Lock()
_MODEL: dict[str, Any] = {}


def naming_model_key(value: Any) -> str:
    key = str(value or "").strip().lower()
    return key if key in NAMING_MODELS else DEFAULT_NAMING_MODEL


def _load_model(key: str = DEFAULT_NAMING_MODEL) -> tuple[Any, Any, Any]:
    with _MODEL_LOCK:
        cached = _MODEL.get(key)
        if cached is not None:
            return cached
        _MODEL.clear()  # one naming model at a time
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor

        root = ensure_helper_model(key)
        try:
            import comfy.model_management as model_management

            device = model_management.get_torch_device()
        except Exception:
            device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        if getattr(device, "type", None) not in {"cpu", "cuda"}:
            device = torch.device("cpu")
        dtype = torch.float16 if device.type == "cuda" else torch.float32
        if key == QWEN3VL_KEY and device.type == "cuda":
            dtype = torch.bfloat16
        processor = AutoProcessor.from_pretrained(root, local_files_only=True)
        model = AutoModelForImageTextToText.from_pretrained(root, torch_dtype=dtype, local_files_only=True).to(device).eval()
        _MODEL[key] = (model, processor, device)
        return _MODEL[key]


def layer_thumbnail(image: Image.Image) -> Image.Image:
    """The layer's pixels on neutral gray, alpha-cropped and fitted into 384 px."""
    rgba = image.convert("RGBA")
    bbox = rgba.getchannel("A").getbbox()
    if bbox:
        rgba = rgba.crop(bbox)
    rgba.thumbnail((_THUMBNAIL_SIZE, _THUMBNAIL_SIZE), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", rgba.size, (128, 128, 128))
    canvas.paste(rgba, mask=rgba.getchannel("A"))
    return canvas


_TRAILING_STOPWORDS = {"a", "an", "the", "in", "on", "of", "with", "and", "at", "by", "for", "to"}


def clean_layer_name(text: Any) -> str | None:
    """A model answer as a layer name, or None when it is not one."""
    line = str(text or "").strip().splitlines()[0] if str(text or "").strip() else ""
    line = re.sub(r"^(assistant|name|layer name)\s*:\s*", "", line, flags=re.IGNORECASE)
    line = re.sub(r"[\"'`*_#.:;!?()\[\]{}]", "", line).strip()
    words = [word for word in re.split(r"\s+", line) if word]
    if not words or len(words) > 6:
        return None
    if words[0].lower() in {"a", "an", "the"} and len(words) > 1:
        words = words[1:]
    words = words[:5]
    # Never end a name on a dangling function word ("Blonde Woman In A").
    while len(words) > 1 and words[-1].lower() in _TRAILING_STOPWORDS:
        words.pop()
    name = " ".join(word[:1].upper() + word[1:] for word in words)
    return name[:40] or None


_JSON_OBJECT = re.compile(r"\{[^{}]*\}", re.DOTALL)


def parse_naming_answer(text: Any, fallback: Any = None) -> dict[str, Any]:
    """Strict parse of a ``{"name", "category"}`` answer.

    Returns ``{name, category, parsed}``. Anything else than one JSON object with a valid name and
    a category from ``LAYER_CATEGORIES`` (case-insensitive) yields the rules name ``fallback``
    and ``Other`` with ``parsed: False``; a raw model string never becomes a name.
    """
    fallback_name = str(fallback).strip()[:80] if isinstance(fallback, str) and fallback.strip() else None
    failed = {"name": fallback_name, "category": FALLBACK_CATEGORY, "parsed": False}
    match = _JSON_OBJECT.search(str(text or ""))
    if not match:
        return failed
    try:
        data = json.loads(match.group(0))
    except (TypeError, ValueError):
        return failed
    if not isinstance(data, dict) or not isinstance(data.get("name"), str) or not isinstance(data.get("category"), str):
        return failed
    category = next((item for item in LAYER_CATEGORIES if item.lower() == data["category"].strip().lower()), None)
    name = clean_layer_name(data["name"])
    if not category or not name:
        return failed
    return {"name": name, "category": category, "parsed": True}


def _prompt_context(value: Any) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:_MAX_PROMPT_CONTEXT]


def _generate(messages: list[dict[str, Any]], images: list[Image.Image] | None, key: str, max_new_tokens: int) -> str:
    import torch

    model, processor, device = _load_model(key)
    prompt = processor.apply_chat_template(messages, add_generation_prompt=True)
    if images:
        inputs = processor(text=prompt, images=images, return_tensors="pt").to(device)
    else:
        inputs = processor(text=prompt, return_tensors="pt").to(device)
    if "pixel_values" in inputs and device.type == "cuda":
        inputs["pixel_values"] = inputs["pixel_values"].to(model.dtype)
    with torch.inference_mode():
        generated = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
    return processor.batch_decode(generated[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0]


def _describe(image: Image.Image, key: str = DEFAULT_NAMING_MODEL, prompt: Any = None, fallback: Any = None) -> dict[str, Any]:
    text = NAME_PROMPT
    context = _prompt_context(prompt)
    if context:
        text = f"{PROMPT_CONTEXT}{context!r}. {text}"
    messages = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": text}]}]
    return parse_naming_answer(_generate(messages, [layer_thumbnail(image)], key, 32), fallback)


def group_prompt(children: Any) -> str | None:
    names = [re.sub(r"\s+", " ", str(name)).strip()[:60] for name in (children if isinstance(children, list) else [])]
    names = [name for name in names if name][:24]
    return GROUP_PROMPT.format(children=", ".join(repr(name) for name in names)) if names else None


def _name_group(children: Any, key: str) -> str | None:
    text = group_prompt(children)
    if not text:
        return None
    messages = [{"role": "user", "content": [{"type": "text", "text": text}]}]
    try:
        return clean_layer_name(_generate(messages, None, key, 12))
    except Exception:
        # A processor that refuses text-only input leaves the group with its current name.
        return None


def _run_unicanvas_describe_layers(payload: dict[str, Any]) -> dict[str, Any]:
    items = (payload or {}).get("layers") or []
    groups = (payload or {}).get("groups") or []
    if not isinstance(items, list) or not isinstance(groups, list) or not (items or groups):
        raise ValueError("[VNCCS UniCanvas] describe_layers needs a non-empty 'layers' or 'groups' list.")
    key = naming_model_key((payload or {}).get("model"))
    names = []
    group_names = []
    with _COMFY_MODEL_OP_LOCK:
        for item in items[:MAX_LAYERS_PER_REQUEST]:
            if not isinstance(item, dict) or not item.get("id") or not item.get("image"):
                continue
            image = _decode_data_url(str(item["image"]), "RGBA")
            result = _describe(image, key, item.get("prompt"), item.get("fallback"))
            names.append({"id": str(item["id"]), **result})
        for item in groups[:MAX_GROUPS_PER_REQUEST]:
            if not isinstance(item, dict) or not item.get("id"):
                continue
            group_names.append({"id": str(item["id"]), "name": _name_group(item.get("children"), key)})
    return {"names": names, "groups": group_names, "model": key}
