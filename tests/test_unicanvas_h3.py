import base64
import io

import pytest
import torch
from PIL import Image

from nodes.unicanvas import (
    _MODEL_CACHE,
    MiniMaxH3UniCanvasModule,
    _call_comfy_node,
    _get_unicanvas_model_loader,
    _get_unicanvas_model_module,
    _load_generation_assets,
)


def test_module_registered_with_aliases():
    module = _get_unicanvas_model_module("minimax_h3")
    assert isinstance(module, MiniMaxH3UniCanvasModule)
    assert _get_unicanvas_model_module("h3") is module
    assert _get_unicanvas_model_module("MiniMaxH3") is module
    assert module.key == "minimax_h3"
    assert module.is_edit_model is True


def test_defaults_follow_h3_recipe():
    module = _get_unicanvas_model_module("minimax_h3")
    assert module.defaults["steps"] == 20
    assert module.defaults["sampler_name"] == "res_multistep"
    assert module.defaults["scheduler"] == "simple"
    assert module.defaults["cfg"] == 1.0
    assert module.defaults["frame_count"] == 5


def test_external_loader_passthrough():
    loader = _get_unicanvas_model_loader("external")
    external = {"model": "M", "clip": "C", "vae": "V"}
    model, clip, vae = loader.load({"_external": external}, draw_id="t")
    assert (model, clip, vae) == ("M", "C", "V")


def test_external_loader_requires_config():
    loader = _get_unicanvas_model_loader("external")
    with pytest.raises(RuntimeError, match=r"\[VNCCS UniCanvas\] External model block is missing\."):
        loader.load({}, draw_id="t")


def test_call_comfy_node_uses_registry(monkeypatch):
    import nodes as comfy_nodes

    class Dummy:
        FUNCTION = "run"

        def run(self, value):
            return ("ok", value)

    monkeypatch.setattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {"DummyNode": Dummy}, raising=False)
    assert _call_comfy_node("DummyNode", value=3) == ("ok", 3)


def test_call_comfy_node_missing_raises():
    with pytest.raises(RuntimeError, match=r"Required node 'NopeNode' is not available"):
        _call_comfy_node("NopeNode")


def _external_gen_settings(block):
    return {"model_loader": "external", "_external": block}


def test_sequential_external_blocks_load_their_own_assets():
    """Two external draws with different blocks must not share the first block's assets."""
    _MODEL_CACHE.clear()
    first = {"model": "M1", "clip": "C1", "vae": "V1"}
    second = {"model": "M2", "clip": "C2", "vae": "V2"}

    assert _load_generation_assets(_external_gen_settings(first)) == ("M1", "C1", "V1")
    assert _load_generation_assets(_external_gen_settings(second)) == ("M2", "C2", "V2")
    # The pass-through loader bypasses the model cache, so no external block is pinned.
    external_loader = _get_unicanvas_model_loader("external")
    assert external_loader.cache_key(_external_gen_settings(second)) not in _MODEL_CACHE


def test_repeated_external_block_loads_consistently():
    """The same external block loaded twice still yields its own triple."""
    _MODEL_CACHE.clear()
    block = {"model": "M", "clip": "C", "vae": "V"}

    assert _load_generation_assets(_external_gen_settings(block)) == ("M", "C", "V")
    assert _load_generation_assets(_external_gen_settings(block)) == ("M", "C", "V")


def test_reference_mapping_order(monkeypatch):
    module = _get_unicanvas_model_module("minimax_h3")
    captured = {}

    def fake_call(name, **kwargs):
        captured.setdefault(name, []).append(kwargs)
        if name == "MiniMaxH3ReferenceToVideo":
            return ("positive", "latent")
        if name == "BasicGuider":
            return ("guider",)
        if name == "RandomNoise":
            return ("noise",)
        if name == "KSamplerSelect":
            return ("sampler",)
        if name == "BasicScheduler":
            return ("sigmas",)
        if name == "SamplerCustomAdvanced":
            return ({"samples": torch.zeros(1, 4, 8, 8)}, {"samples": torch.zeros(1, 4, 8, 8)})
        raise AssertionError(name)

    monkeypatch.setattr("nodes.unicanvas._call_comfy_node", fake_call)
    gen_settings = {
        "_h3_prompt": "Keep the face from <Picture 2>.",
        "_h3_reference_image": torch.zeros(1, 64, 64, 3),
        "_external": {
            "clip": "C",
            "vae": "V",
            "audio_vae": "A",
            "references": {
                "reference_image_1": torch.ones(1, 32, 32, 3),
                "reference_image_2": torch.full((1, 32, 32, 3), 2.0),
            },
        },
    }
    module.sample_latent(
        model="M", positive=None, negative=None, latent=None, seed=7,
        steps=20, cfg=1.0, sampler_name="res_multistep", scheduler="simple",
        denoise=1.0, gen_settings=gen_settings, draw_id="t", width=64, height=64,
    )
    encode_kwargs = captured["MiniMaxH3ReferenceToVideo"][0]
    refs = encode_kwargs["ref_images"]
    assert list(refs) == ["ref_image_1", "ref_image_2", "ref_image_3"]
    assert torch.equal(refs["ref_image_1"], torch.zeros(1, 64, 64, 3))
    assert torch.equal(refs["ref_image_2"], torch.ones(1, 32, 32, 3))
    assert torch.equal(refs["ref_image_3"], torch.full((1, 32, 32, 3), 2.0))
    assert encode_kwargs["prompt"] == "Keep the face from <Picture 2>."
    assert encode_kwargs["length"] == 5
    assert captured["BasicGuider"][0]["conditioning"] == "positive"
    assert captured["SamplerCustomAdvanced"][0]["latent_image"] == "latent"


def test_decode_samples_takes_first_frame(monkeypatch):
    module = _get_unicanvas_model_module("minimax_h3")
    frames = torch.zeros(5, 32, 32, 3)
    samples = torch.zeros(1, 4, 8, 8)
    captured = {}

    def fake_call(name, **kwargs):
        assert name == "VAEDecodeTiled", name
        captured.update(kwargs)
        return (frames,)

    monkeypatch.setattr("nodes.unicanvas._call_comfy_node", fake_call)
    out = module.decode_samples("V", samples, {"_draw_id": "t"})
    assert out.shape[0] == 1
    assert torch.equal(out, frames[:1])
    # The tile widgets must be passed explicitly: _call_comfy_node cannot supply missing
    # required parameters, and it filters out keywords the installed core does not declare.
    assert captured["samples"] is samples
    assert captured["vae"] == "V"
    assert captured["tile_size"] == 512
    assert captured["overlap"] == 64
    assert captured["temporal_size"] == 64
    assert captured["temporal_overlap"] == 8


def test_decode_samples_single_frame_passes_through(monkeypatch):
    module = _get_unicanvas_model_module("minimax_h3")
    frame = torch.zeros(1, 32, 32, 3)
    monkeypatch.setattr(
        "nodes.unicanvas._call_comfy_node",
        lambda name, **kwargs: (frame,) if name == "VAEDecodeTiled" else (_ for _ in ()).throw(AssertionError(name)),
    )
    out = module.decode_samples("V", torch.zeros(1, 4, 8, 8), {"_draw_id": "t"})
    assert out is frame
    assert out.shape[0] == 1


def test_sample_latent_requires_audio_vae():
    module = _get_unicanvas_model_module("minimax_h3")
    import pytest

    with pytest.raises(RuntimeError, match=r"\[VNCCS UniCanvas\] MiniMax H3 requires the audio VAE\."):
        module.sample_latent(
            model="M", positive=None, negative=None, latent=None, seed=1,
            steps=20, cfg=1.0, sampler_name="res_multistep", scheduler="simple",
            denoise=1.0,
            gen_settings={"_h3_prompt": "p", "_external": {}},
            draw_id="t", width=64, height=64,
        )


def test_graph_generate_runs_draw_and_returns_tensor(monkeypatch):
    from nodes import unicanvas as uc
    from nodes.vncss_config import VNCCS_Config

    captured = {}

    def fake_draw(payload):
        captured.update(payload)
        return {"images": ["data:image/png;base64,AAAA"], "tensor": torch.zeros(1, 8, 8, 3)}

    monkeypatch.setattr(uc, "_run_unicanvas_draw", fake_draw)
    config = VNCCS_Config().execute(
        '{"loras": [], "edit_model": False}', model="M", clip="C", vae="V",
    )[0]
    node = uc.VNCCS_UniCanvas()
    (image,) = node.export_state(
        '{"state_id": "s1", "layers": [], "settings": {"draw_id": "draw-1", "generation_mode": "minimax_h3"}}',
        config=config,
        unique_id="9",
    )
    assert captured["debug_id"] == "draw-1"
    assert captured["external"]["model"] == "M"
    assert captured["return_tensor"] is True
    assert image.shape == (1, 8, 8, 3)


def test_graph_generate_without_config_keeps_legacy_export(monkeypatch):
    from nodes import unicanvas as uc

    monkeypatch.setattr(
        uc, "_render_unicanvas_state_to_image_tensor", lambda state: torch.zeros(1, 4, 4, 3)
    )
    (image,) = uc.VNCCS_UniCanvas().export_state('{"layers": []}', config=None, unique_id="9")
    assert image.shape == (1, 4, 4, 3)


def test_result_store_roundtrip():
    from nodes.unicanvas import _store_draw_result, _get_draw_result

    _store_draw_result("draw-x", {"images": ["data:x"], "mask": None})
    assert _get_draw_result("draw-x") == {"present": True, "images": ["data:x"], "mask": None}
    assert _get_draw_result("missing") == {"present": False}


def test_external_payload_selects_external_loader(monkeypatch):
    """A graph-generation payload forwards its VNCSS_CONFIG block to the pass-through loader."""
    from nodes import unicanvas as uc

    buffer = io.BytesIO()
    Image.new("RGB", (64, 64), (0, 0, 0)).save(buffer, format="PNG")
    image_data_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    captured = {}

    def fake_load_assets(gen_settings):
        captured.update(gen_settings)
        raise RuntimeError("stop after asset selection")

    monkeypatch.setattr(uc, "_load_generation_assets", fake_load_assets)
    with pytest.raises(RuntimeError, match="stop after asset selection"):
        uc._run_unicanvas_draw({
            "debug_id": "graph-draw",
            "mode": "txt2img",
            "image": image_data_url,
            "settings": {"generation_mode": "minimax_h3"},
            "external": {"model": "M", "clip": "C", "vae": "V", "audio_vae": "A", "references": {}},
        })
    assert captured["model_loader"] == "external"
    assert captured["generation_mode"] == "minimax_h3"
    assert captured["_external"]["model"] == "M"
