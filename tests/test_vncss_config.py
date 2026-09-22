import json
import pytest

from nodes.vncss_config import VNCCS_Config


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
