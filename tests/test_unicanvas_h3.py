import pytest

from nodes.unicanvas import (
    MiniMaxH3UniCanvasModule,
    _call_comfy_node,
    _get_unicanvas_model_loader,
    _get_unicanvas_model_module,
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
