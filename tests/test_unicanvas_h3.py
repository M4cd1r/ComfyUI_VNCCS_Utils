import pytest

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
