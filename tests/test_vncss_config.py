import json
import pytest

from nodes.vncss_config import VNCCS_Config, apply_lora_stack, normalize_lora_stack


def _state(payload: dict) -> str:
    return json.dumps(payload)


def test_packages_connected_inputs():
    model, clip, vae = object(), object(), object()
    ref = object()
    result = VNCCS_Config().execute(
        _state({"loras": [], "edit_model": True}),
        model=model,
        clip=clip,
        vae=vae,
        reference_image_1=ref,
    )[0]
    assert result["model"] is model
    assert result["clip"] is clip
    assert result["vae"] is vae
    assert result["edit_model"] is True
    assert result["references"] == {"reference_image_1": ref}


def test_missing_model_raises_config_error():
    with pytest.raises(RuntimeError, match=r"\[VNCCS Config\] Model input is not connected\."):
        VNCCS_Config().execute(_state({"loras": [], "edit_model": False}), clip=object(), vae=object())


def test_missing_clip_and_vae_raise():
    with pytest.raises(RuntimeError, match=r"\[VNCCS Config\] CLIP input is not connected\."):
        VNCCS_Config().execute(_state({"loras": []}), model=object(), vae=object())
    with pytest.raises(RuntimeError, match=r"\[VNCCS Config\] VAE input is not connected\."):
        VNCCS_Config().execute(_state({"loras": []}), model=object(), clip=object())


def test_edit_model_requires_reference_1():
    with pytest.raises(RuntimeError, match=r"\[VNCCS Config\] Edit model requires reference_image_1\."):
        VNCCS_Config().execute(
            _state({"loras": [], "edit_model": True}),
            model=object(), clip=object(), vae=object(),
        )


def test_invalid_node_state_falls_back_to_defaults():
    result = VNCCS_Config().execute("not-json", model=object(), clip=object(), vae=object())[0]
    assert result["edit_model"] is False
    assert result["lora_stack"] == []


def test_normalize_lora_stack_filters_and_defaults():
    stack = normalize_lora_stack([
        {"name": "a.safetensors", "strength": 0.5, "enabled": True},
        {"name": "", "strength": 1.0},
        {"strength": 2.0},
        "junk",
        {"name": "b.safetensors", "strength": "0.8", "enabled": False},
    ])
    assert stack == [
        {"name": "a.safetensors", "strength": 0.5, "enabled": True},
        {"name": "b.safetensors", "strength": 0.8, "enabled": False},
    ]


def test_apply_lora_stack_applies_enabled_in_order(monkeypatch):
    calls = []
    import nodes.vncss_config as vc

    def fake_cached(model, clip, name, strength, clip_strength=None):
        calls.append((name, strength))
        return f"m-{name}", f"c-{name}"

    monkeypatch.setattr(vc, "_apply_lora_cached", fake_cached, raising=False)
    model, clip = apply_lora_stack(
        "m0", "c0",
        [
            {"name": "one", "strength": 0.3, "enabled": True},
            {"name": "off", "strength": 1.0, "enabled": False},
            {"name": "two", "strength": 0.7, "enabled": True},
        ],
    )
    assert calls == [("one", 0.3), ("two", 0.7)]
    assert model == "m-two" and clip == "c-two"


def test_execute_returns_patched_model(monkeypatch):
    import nodes.vncss_config as vc
    monkeypatch.setattr(vc, "_apply_lora_cached",
                        lambda m, c, n, s, cs=None: (f"m-{n}", f"c-{n}"), raising=False)
    result = VNCCS_Config().execute(
        _state({"loras": [{"name": "x", "strength": 0.5, "enabled": True}], "edit_model": False}),
        model="m0", clip="c0", vae="v0",
    )[0]
    assert result["model"] == "m-x"
    assert result["clip"] == "c-x"
    assert result["lora_stack"] == [{"name": "x", "strength": 0.5, "enabled": True}]
