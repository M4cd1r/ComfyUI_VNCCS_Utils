"""ControlNet layer backend: capability data, request validation, the family hook and crop-to-mask."""

import base64
import io
import sys
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest
import torch
from PIL import Image

from nodes.unicanvas import draw, draw_pipeline
from nodes.unicanvas.crop_stitch import plan_crop
from nodes.unicanvas.draw_request import ControlRequest
from nodes.unicanvas.models import UNICANVAS_MODEL_MODULES
from nodes.unicanvas.models.base import UniCanvasModelModule
from nodes.unicanvas.models.capabilities import (
    ControlNetSupport,
    ControlNetWeights,
    ControlType,
    ModelCapabilities,
    PromptGuide,
)

GUIDE = PromptGuide(hint="Describe it", guide="Test family.")
SUPPORT = ControlNetSupport(
    types=(ControlType.DEPTH, ControlType.CANNY),
    weights=ControlNetWeights(hf_repo="test/controlnet", hf_path="weights/test_control.safetensors"),
    max_strength=2.0,
)


def png(color=(10, 20, 30, 255), size=(64, 64), box=None, box_color=(255, 255, 255, 255)):
    image = Image.new("RGBA", size, color)
    if box is not None:
        image.paste(Image.new("RGBA", (box[2] - box[0], box[3] - box[1]), box_color), box[:2])
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


@dataclass(frozen=True)
class EchoFamily(UniCanvasModelModule):
    key: str = "test_control_echo"
    aliases: tuple[str, ...] = ()
    defaults: dict[str, Any] = field(default_factory=lambda: {"steps": 2, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple"})
    capabilities: ModelCapabilities = ModelCapabilities(label="Echo", prompt_guide=GUIDE)
    log: list = field(default_factory=list, compare=False)

    def clone_assets(self, model, clip):
        return model, clip

    def encode_prompt(self, clip, text, gen_settings):
        return [[text, {}]]

    def create_empty_latent(self, width, height, gen_settings, draw_id="unknown"):
        return {"samples": torch.zeros(1, 4, height // 8, width // 8)}

    def prepare_generation_latent(self, ctx):
        return self.create_empty_latent(ctx.width, ctx.height, ctx.settings, ctx.draw_id)

    def sample_latent(self, **kwargs):
        self.log.append(("sample", kwargs["model"]))
        return kwargs["latent"]

    def decode_samples(self, vae, samples, gen_settings):
        return torch.full((1, 64, 64, 3), 0.5)


@dataclass(frozen=True)
class ControlFamily(EchoFamily):
    key: str = "test_control_family"
    capabilities: ModelCapabilities = ModelCapabilities(label="Control", prompt_guide=GUIDE, control_net=SUPPORT)
    seen: list = field(default_factory=list, compare=False)

    def apply_control(self, ctx):
        self.seen.append({
            "tensor_shape": tuple(ctx.control_tensor.shape),
            "control_image": ctx.control_image.copy(),
            "control": ctx.request.control,
            "mode": ctx.mode,
            "crop_plan": ctx.crop_plan,
        })
        return "controlled-" + str(ctx.model)


@pytest.fixture()
def register(monkeypatch):
    monkeypatch.setattr(draw_pipeline, "_save_temp_image", lambda image, prefix="x": {"filename": prefix, "size": image.size})

    def _register(family):
        monkeypatch.setitem(UNICANVAS_MODEL_MODULES, family.key, family)
        return family

    return _register


def run(key, mode="img2img", control=None, **extra):
    payload = {
        "debug_id": "control-test",
        "mode": mode,
        "image": png(),
        "settings": {"generation_mode": key, "positive": "a room at night", "negative": ""},
        "external": {"model": "M", "clip": "C", "vae": "V"},
    }
    if control is not None:
        payload["control"] = control
    payload.update(extra)
    return draw._run_unicanvas_draw(payload)


# --- capability data -----------------------------------------------------------------------


def test_control_net_is_declared_as_data_and_served():
    z_image = UNICANVAS_MODEL_MODULES["z_image"].describe()["capabilities"]["control_net"]
    assert {item["key"] for item in z_image["types"]} >= {"depth", "canny", "pose", "lineart"}
    assert z_image["weights"]["hf_repo"] == "alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1"
    assert z_image["weights"]["filename"].endswith(".safetensors")
    assert z_image["weights"]["setting"] == "fun_controlnet_patch_name"
    assert z_image["combines_with_inpaint"] is True
    assert z_image["prompt_note"]
    h3 = UNICANVAS_MODEL_MODULES["minimax_h3"].describe()["capabilities"]["control_net"]
    assert h3["weights"]["folder"] == "model_patches"
    assert h3["supports_range"] is True
    for key in ("sdxl", "anima", "flux_klein", "qwen_image_edit", "krea2_edit"):
        assert UNICANVAS_MODEL_MODULES[key].describe()["capabilities"]["control_net"] is None, key


def test_control_request_parsing():
    assert ControlRequest.from_payload(None) is None
    parsed = ControlRequest.from_payload({"image": "data:x", "type": "Depth", "strength": 0.7, "end_percent": 0.8})
    assert (parsed.type, parsed.strength, parsed.start_percent, parsed.end_percent) == ("depth", 0.7, 0.0, 0.8)
    with pytest.raises(ValueError, match="control.image"):
        ControlRequest.from_payload({"type": "depth"})
    with pytest.raises(ValueError, match="control.type"):
        ControlRequest.from_payload({"image": "data:x"})
    with pytest.raises(ValueError, match="end_percent"):
        ControlRequest.from_payload({"image": "data:x", "type": "depth", "start_percent": 0.6, "end_percent": 0.2})


# --- validation --------------------------------------------------------------------------------


def test_family_without_control_net_rejects_a_control_image(register, monkeypatch):
    register(EchoFamily())
    monkeypatch.setattr(draw_pipeline, "_load_generation_assets", lambda settings: pytest.fail("must not load"))
    with pytest.raises(ValueError, match="Echo has no ControlNet"):
        run("test_control_echo", control={"image": png(), "type": "depth"})


def test_control_type_and_strength_are_validated(register, monkeypatch):
    register(ControlFamily())
    monkeypatch.setattr(draw_pipeline, "_load_generation_assets", lambda settings: pytest.fail("must not load"))
    with pytest.raises(ValueError, match="does not accept 'pose'"):
        run("test_control_family", control={"image": png(), "type": "pose"})
    with pytest.raises(ValueError, match="strength must be between 0 and 2"):
        run("test_control_family", control={"image": png(), "type": "depth", "strength": 3})


def test_family_that_cannot_combine_control_with_inpaint(register, monkeypatch):
    no_inpaint = ControlNetSupport(types=SUPPORT.types, weights=SUPPORT.weights, combines_with_inpaint=False)
    register(ControlFamily(key="test_control_no_mask", capabilities=ModelCapabilities(
        label="No mask", prompt_guide=GUIDE, control_net=no_inpaint)))
    monkeypatch.setattr(draw_pipeline, "_load_generation_assets", lambda settings: pytest.fail("must not load"))
    with pytest.raises(ValueError, match="cannot combine a ControlNet layer with an inpaint mask"):
        run("test_control_no_mask", mode="inpaint", mask=png(box=(10, 10, 20, 20)), control={"image": png(), "type": "depth"})


# --- the hook ----------------------------------------------------------------------------------


def patch_loading(monkeypatch):
    monkeypatch.setattr(draw_pipeline, "_load_generation_assets", lambda settings: ("M", "C", "V"))


def test_control_image_reaches_the_family_hook(register, monkeypatch):
    patch_loading(monkeypatch)
    family = register(ControlFamily())
    result = run("test_control_family", mode="txt2img", control={"image": png(box=(0, 0, 32, 64)), "type": "canny", "strength": 0.8})
    assert result["status"] == "ok"
    assert result["control"] == {"type": "canny", "strength": 0.8, "start_percent": 0.0, "end_percent": 1.0}
    [seen] = family.seen
    assert seen["tensor_shape"] == (1, 64, 64, 3)
    assert seen["control_image"].getpixel((5, 5)) == (255, 255, 255)
    assert seen["control_image"].getpixel((50, 5)) == (10, 20, 30)
    assert ("sample", "controlled-M") in family.log


def test_draw_without_control_never_calls_the_hook(register, monkeypatch):
    patch_loading(monkeypatch)
    family = register(ControlFamily())
    run("test_control_family")
    assert family.seen == []
    assert ("sample", "M") in family.log


def test_transparent_control_pixels_become_black(register, monkeypatch):
    patch_loading(monkeypatch)
    family = register(ControlFamily())
    run("test_control_family", control={"image": png(color=(0, 0, 0, 0), box=(0, 0, 8, 8)), "type": "depth"})
    image = family.seen[0]["control_image"]
    assert image.getpixel((2, 2)) == (255, 255, 255)
    assert image.getpixel((40, 40)) == (0, 0, 0)


def test_inpaint_crop_to_mask_crops_the_control_image_with_the_mask(register, monkeypatch):
    patch_loading(monkeypatch)
    family = register(ControlFamily())
    size = (256, 256)
    mask_box = (100, 100, 130, 130)
    mask = png(color=(0, 0, 0, 0), size=size, box=mask_box)
    # White control lines only inside the left half of the mask area.
    control = png(color=(0, 0, 0, 255), size=size, box=(100, 100, 115, 130))
    result = run("test_control_family", mode="inpaint", image=png(size=size), mask=mask, control={"image": control, "type": "canny"},
                 inference_size={"width": 256, "height": 256})
    assert result["status"] == "ok"
    [seen] = family.seen
    expected = plan_crop(Image.open(io.BytesIO(base64.b64decode(mask.split(",", 1)[1]))), size)
    assert seen["crop_plan"] == expected
    assert seen["control_image"].size == expected.work_size
    assert seen["tensor_shape"] == (1, expected.work_size[1], expected.work_size[0], 3)
    # The white block maps into the crop at the same relative place.
    left, top, right, bottom = expected.box
    scale_x = expected.work_size[0] / (right - left)
    inside = (int((107 - left) * scale_x), int((115 - top) * scale_x))
    outside = (int((125 - left) * scale_x), int((115 - top) * scale_x))
    assert seen["control_image"].getpixel(inside)[0] > 200
    assert seen["control_image"].getpixel(outside)[0] < 50


# --- Z-Image and MiniMax-H3 hooks (ComfyUI nodes stubbed) -------------------------------------


def z_image_ctx(mode, masked):
    module = UNICANVAS_MODEL_MODULES["z_image"]
    settings = {"draw_mode": mode, "fun_controlnet_patch_name": "zc.safetensors", "fun_controlnet_inpaint": True,
                "_z_image_fun_controlnet_patch_model": "PATCH"}
    if masked:
        settings.update({"_z_image_fun_controlnet_image": torch.zeros(1, 8, 8, 3), "_z_image_fun_controlnet_mask": torch.ones(1, 8, 8),
                         "_z_image_fun_controlnet_vae": "V"})
    control = ControlRequest(image="data:x", type="depth", strength=0.6)
    ctx = SimpleNamespace(settings=settings, model="M", vae="V", draw_id="z", control_tensor=torch.ones(1, 8, 8, 3),
                          request=SimpleNamespace(control=control), mode=mode)
    return module, ctx


def test_z_image_applies_the_control_image_through_zimage_fun_controlnet(monkeypatch):
    calls = []

    def fake_call(class_names, method_names, **kwargs):
        calls.append((class_names, kwargs))
        return "PATCHED"

    monkeypatch.setattr("nodes.unicanvas.models.z_image._call_node_method", fake_call)
    module, ctx = z_image_ctx("img2img", masked=False)
    assert module.apply_control(ctx) == "PATCHED"
    [(names, kwargs)] = calls
    assert names == ["ZImageFunControlnet"]
    assert kwargs["image"] is ctx.control_tensor
    assert kwargs["inpaint_image"] is None and kwargs["mask"] is None
    assert kwargs["strength"] == 0.6 and kwargs["model_patch"] == "PATCH"
    # sample_latent's inpaint patch must not patch the model a second time.
    assert module._apply_fun_controlnet_if_needed("PATCHED", ctx.settings, "z") == "PATCHED"
    assert len(calls) == 1


def test_z_image_control_with_inpaint_mask_is_one_patch(monkeypatch):
    calls = []
    monkeypatch.setattr("nodes.unicanvas.models.z_image._call_node_method", lambda names, methods, **kw: calls.append(kw) or "PATCHED")
    module, ctx = z_image_ctx("inpaint", masked=True)
    module.apply_control(ctx)
    [kwargs] = calls
    assert kwargs["image"] is ctx.control_tensor
    assert kwargs["inpaint_image"] is ctx.settings["_z_image_fun_controlnet_image"]
    assert kwargs["mask"] is ctx.settings["_z_image_fun_controlnet_mask"]
    module._apply_fun_controlnet_if_needed("PATCHED", ctx.settings, "z")
    assert len(calls) == 1


def test_z_image_preloads_the_patch_for_a_control_draw(monkeypatch):
    from nodes.unicanvas.models import z_image

    monkeypatch.setattr(z_image, "_ensure_z_image_fun_controlnet_model", lambda name, draw_id="x": name)
    monkeypatch.setattr(z_image, "_load_model_patch", lambda name: ("LOADED", name))
    settings = {"generation_mode": "z_image", "fun_controlnet_patch_name": "zc.safetensors"}
    z_image._preload_z_image_fun_controlnet_patch(settings, "txt2img", "z")
    assert "_z_image_fun_controlnet_patch_model" not in settings
    z_image._preload_z_image_fun_controlnet_patch(settings, "txt2img", "z", control=True)
    assert settings["_z_image_fun_controlnet_patch_model"] == ("LOADED", "zc.safetensors")


def test_minimax_h3_applies_the_core_fun_controlnet(monkeypatch):
    module = UNICANVAS_MODEL_MODULES["minimax_h3"]
    calls = []
    monkeypatch.setattr("nodes.unicanvas.models.minimax_h3.load_control_net_patch", lambda weights, settings, draw_id: ("PATCH", weights.local_name))
    monkeypatch.setattr("nodes.unicanvas.models.minimax_h3._call_comfy_node", lambda name, **kw: calls.append((name, kw)) or ("PATCHED",))
    control = ControlRequest(image="data:x", type="pose", strength=0.9, start_percent=0.1, end_percent=0.7)
    ctx = SimpleNamespace(settings={}, model="M", vae="V", draw_id="h3", control_tensor=torch.ones(1, 8, 8, 3),
                          request=SimpleNamespace(control=control))
    assert module.apply_control(ctx) == "PATCHED"
    [(name, kwargs)] = calls
    assert name == "MiniMaxH3FunControlNetApply"
    assert kwargs["model_patch"] == ("PATCH", "minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors")
    assert kwargs["control_video"] is ctx.control_tensor
    assert (kwargs["strength"], kwargs["start_percent"], kwargs["end_percent"]) == (0.9, 0.1, 0.7)


def test_weights_resolve_to_a_user_file_or_the_pinned_download(monkeypatch, tmp_path):
    from nodes.unicanvas import control_net

    weights = ControlNetWeights(hf_repo="org/repo", hf_path="sub/pinned.safetensors", setting="my_patch")
    assert control_net.control_net_weights_name(weights, {"my_patch": "mine.safetensors"}) == "mine.safetensors"
    assert control_net.control_net_weights_name(weights, {}) == "pinned.safetensors"
    assert control_net.ensure_control_net_weights(weights, "mine.safetensors") == "mine.safetensors"

    monkeypatch.setattr(control_net, "_get_full_path_agnostic", lambda *args, **kwargs: None)
    monkeypatch.setattr(control_net, "_safe_get_folder_paths", lambda fp, category: [str(tmp_path)])
    downloads = []

    def fake_download(**kwargs):
        downloads.append(kwargs)
        source = tmp_path / "cache.bin"
        source.write_bytes(b"w")
        return str(source)

    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(hf_hub_download=fake_download))
    assert control_net.ensure_control_net_weights(weights) == "pinned.safetensors"
    assert (tmp_path / "pinned.safetensors").read_bytes() == b"w"
    assert downloads[0]["repo_id"] == "org/repo" and downloads[0]["filename"] == "sub/pinned.safetensors"
    assert downloads[0]["token"] is False
