"""Pose Studio LoRA rules: version lookup, installed scan, family requirements, bake wiring."""

import re
from types import SimpleNamespace

import pytest

from nodes.unicanvas import loras as loras_module
from nodes.unicanvas import pose_studio_loras as psl
from nodes.unicanvas.models.registry import _get_unicanvas_model_module


POSE_EDIT_FAMILIES = ("qwen_image_edit", "flux_klein", "minimax_h3", "qwen_image21")
PINNED_REVISION = "e9748913dccc42dfaa0c69d999db399b908af014"


def _install_names(monkeypatch, names):
    import folder_paths

    monkeypatch.setattr(folder_paths, "get_filename_list", lambda category, _names=tuple(names): list(_names))


def _fake_hub(monkeypatch, sha="feed1234", paths=("models/loras/x/Test_Pose_V1.safetensors",)):
    """Replace HfApi inside huggingface_hub with a canned repository tree."""
    import huggingface_hub

    calls = {"model_info": 0, "list_repo_tree": 0}

    class FakeApi:
        def __init__(self, *args, **kwargs):
            assert kwargs.get("token") is False

        def model_info(self, repo_id, revision, token):
            calls["model_info"] += 1
            assert token is False
            return SimpleNamespace(sha=sha)

        def list_repo_tree(self, repo_id, path_in_repo, revision, token, **kwargs):
            calls["list_repo_tree"] += 1
            assert token is False
            assert revision == sha
            return [SimpleNamespace(type="file", path=path) for path in paths]

    monkeypatch.setattr(huggingface_hub, "HfApi", FakeApi)
    return calls


@pytest.fixture()
def fresh_cache(monkeypatch):
    monkeypatch.setattr(psl, "_LATEST_CACHE", {})
    return psl._LATEST_CACHE


def _make_rule(**overrides):
    fields = dict(
        family="testfam",
        label="Test Fam",
        hf_repo="repo/id",
        hf_dir="models/loras/x",
        match=re.compile(r"^Test_Pose_V(?P<v>\d+(?:\.\d+)*)\.safetensors$"),
        local_match=(re.compile(r"^Test_Pose_V(?P<v>\d+(?:\.\d+)*)\.safetensors$"),),
        baseline_version="1",
        baseline_hf_path="models/loras/x/Test_Pose_V1.safetensors",
        baseline_revision="deadbeef",
    )
    fields.update(overrides)
    return psl.PoseStudioLoraRule(**fields)


# --- configuration --------------------------------------------------------------------


def test_config_declares_a_rule_for_every_pose_edit_family():
    rules = psl.pose_studio_lora_rules()
    assert tuple(rules) == POSE_EDIT_FAMILIES
    for family, rule in rules.items():
        baseline = rule.baseline_entry()
        assert rule.hf_repo == "MIUProject/VNCCS_v3.0", family
        assert rule.baseline_revision == PINNED_REVISION, family
        # local_path = hf_path: the ComfyUI loras name strips models/loras/.
        assert baseline["name"] == rule.baseline_hf_path[len("models/loras/"):], family
        # The baseline file matches the family's own remote rule at the pinned version.
        found = rule.match.search(baseline["hf_path"].rsplit("/", 1)[-1])
        assert found and found.group("v") == rule.baseline_version, family


def test_unknown_family_raises():
    with pytest.raises(ValueError, match="Unknown Pose Studio LoRA family"):
        psl.pose_studio_lora_rule("sdxl")


# --- versions -------------------------------------------------------------------------


def test_dot_versions_order_numerically():
    assert psl.version_key("5.9.5") < psl.version_key("6")
    assert psl.version_key("2") < psl.version_key("2.1") < psl.version_key("2.2") < psl.version_key("2.5")
    assert psl.version_key("1") < psl.version_key("1.1")
    assert psl.version_key("10") > psl.version_key("9")


def test_h3_local_scan_recognizes_upstream_legacy_filename():
    rule = psl.pose_studio_lora_rule("minimax_h3")
    assert psl._match_version(rule.local_match, "H3_PoseStudioV1.safetensors") == "1"
    assert psl._match_version(rule.local_match, "VNCCS_PoseStudioH3_V1.safetensors") == "1"
    # Other families do not swallow foreign names.
    assert psl._match_version(psl.pose_studio_lora_rule("flux_klein").local_match, "H3_PoseStudioV1.safetensors") is None


# --- installed scan -------------------------------------------------------------------


def test_installed_scan_picks_highest_version_in_any_subfolder(monkeypatch):
    _install_names(monkeypatch, [
        "demo.safetensors",
        "Klein9b/VNCCS_PoseStudioKlein9b_V2.2.safetensors",
        "klein\\VNCCS_PoseStudioKlein9b_V2.5.safetensors",
        "some/other/VNCCS_PoseStudioKlein9b_V2.1.safetensors",
        "VNCCS_PoseStudioKlein9b_V2.safetensors",
    ])
    installed = psl.installed_pose_studio_loras("flux_klein")
    assert installed["version"] == "2.5"
    assert installed["name"].endswith("VNCCS_PoseStudioKlein9b_V2.5.safetensors")
    assert installed["hf_path"].startswith("models/loras/")


def test_installed_scan_returns_none_without_a_match(monkeypatch):
    _install_names(monkeypatch, ["demo.safetensors", "style/VNCCS_ClothesCore.safetensors"])
    assert psl.installed_pose_studio_loras("qwen_image_edit") is None


def test_resolve_prefers_the_explicit_name_over_the_installed_scan(monkeypatch):
    _install_names(monkeypatch, ["qwen/VNCCS/VNCCS_QIE2511_PoseStudio_ART_V6.safetensors"])
    assert psl.resolve_pose_studio_lora("qwen_image_edit") == "qwen/VNCCS/VNCCS_QIE2511_PoseStudio_ART_V6.safetensors"
    assert psl.resolve_pose_studio_lora("qwen_image_edit", {"pose_studio_lora_name": "mine/V5.safetensors"}) == "mine/V5.safetensors"


# --- latest lookup (Hub, cached, baseline fallback) ------------------------------------


def test_remote_query_selects_highest_version_and_pins_the_revision(monkeypatch, fresh_cache):
    rule = _make_rule()
    monkeypatch.setattr(psl, "_RULES", {"testfam": rule})
    calls = _fake_hub(monkeypatch, sha="feed1234", paths=(
        "models/loras/x/Test_Pose_V1.safetensors",
        "models/loras/x/Test_Pose_V2.10.safetensors",
        "models/loras/x/Test_Pose_V2.9.safetensors",
        "models/loras/x/unrelated.safetensors",
    ))
    entries = psl._query_remote_versions(rule)
    assert set(entries) == {"1", "2.10", "2.9"}
    assert calls["model_info"] == 1
    latest = psl.latest_pose_studio_lora("testfam")
    assert latest == {
        "version": "2.10",
        "hf_path": "models/loras/x/Test_Pose_V2.10.safetensors",
        "revision": "feed1234",
        "name": "x/Test_Pose_V2.10.safetensors",
    }


def test_latest_falls_back_to_baseline_when_the_hub_fails(monkeypatch, fresh_cache):
    import huggingface_hub

    class ExplodingApi:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("offline")

    monkeypatch.setattr(huggingface_hub, "HfApi", ExplodingApi)
    latest = psl.latest_pose_studio_lora("qwen_image_edit")
    assert latest["version"] == "6"
    assert latest["revision"] == PINNED_REVISION
    assert latest["hf_path"].endswith("VNCCS_QIE2511_PoseStudio_ART_V6.safetensors")


def test_latest_caches_within_the_ttl_and_refresh_bypasses(monkeypatch, fresh_cache):
    rule_family = "qwen_image_edit"
    calls = _fake_hub(monkeypatch, paths=("models/loras/qwen/VNCCS/VNCCS_QIE2511_PoseStudio_ART_V6.safetensors",))
    psl.latest_pose_studio_lora(rule_family)
    psl.latest_pose_studio_lora(rule_family)
    assert calls["list_repo_tree"] == 1
    psl.latest_pose_studio_lora(rule_family, refresh=True)
    assert calls["list_repo_tree"] == 2
    assert calls["model_info"] == 2


def test_status_reports_update_available_per_family(monkeypatch, fresh_cache):
    monkeypatch.setattr(psl, "installed_pose_studio_loras", lambda family: {"version": "6"})
    monkeypatch.setattr(psl, "latest_pose_studio_lora", lambda family, refresh=False: {"version": "6.1"})
    status = psl.pose_studio_loras_status()
    assert status["qwen_image_edit"] == {
        "installed": {"version": "6"},
        "latest": {"version": "6.1"},
        "update_available": True,
    }
    monkeypatch.setattr(psl, "latest_pose_studio_lora", lambda family, refresh=False: {"version": "6"})
    assert psl.pose_studio_loras_status()["qwen_image_edit"]["update_available"] is False
    monkeypatch.setattr(psl, "installed_pose_studio_loras", lambda family: None)
    assert psl.pose_studio_loras_status()["qwen_image_edit"]["update_available"] is True
    monkeypatch.setattr(psl, "latest_pose_studio_lora", lambda family, refresh=False: None)
    assert psl.pose_studio_loras_status()["qwen_image_edit"]["update_available"] is False


# --- the families' LoraRequirement -----------------------------------------------------


def _family_pose_rule(module):
    matches = [rule for rule in module.lora_requirements if rule.name_setting == psl.POSE_STUDIO_LORA_NAME_SETTING]
    assert len(matches) == 1, module.key
    return matches[0]


def test_every_pose_edit_family_declares_the_pose_studio_requirement():
    for family in POSE_EDIT_FAMILIES:
        rule = _family_pose_rule(_get_unicanvas_model_module(family))
        assert rule.enabled_setting == psl.POSE_EDIT_ACTIVE_SETTING, family
        assert rule.strength_setting == psl.POSE_STUDIO_LORA_STRENGTH_SETTING, family
        assert rule.default_strength == 1.0, family
        assert rule.required is True, family
        assert rule.dedupe_from_stack is True, family


def test_requirement_is_inactive_without_pose_layers():
    for family in POSE_EDIT_FAMILIES:
        rule = _family_pose_rule(_get_unicanvas_model_module(family))
        assert rule.resolve({}) is None, family
        assert rule.resolve({psl.POSE_EDIT_ACTIVE_SETTING: False}) is None, family


def test_requirement_resolves_auto_to_highest_installed_version(monkeypatch):
    _install_names(monkeypatch, [
        "qwen/VNCCS/VNCCS_QIE2511_PoseStudio_ART_V5.9.5.safetensors",
        "qwen/VNCCS/VNCCS_QIE2511_PoseStudio_ART_V6.safetensors",
    ])
    settings = {psl.POSE_EDIT_ACTIVE_SETTING: True, "lora_stack": [{"name": "qwen/VNCCS/VNCCS_QIE2511_PoseStudio_ART_V5.9.5.safetensors", "strength": 0.4}]}
    rule = _family_pose_rule(_get_unicanvas_model_module("qwen_image_edit"))
    assert rule.resolve(settings) == ("qwen/VNCCS/VNCCS_QIE2511_PoseStudio_ART_V6.safetensors", 1.0)


def test_requirement_keeps_an_explicitly_chosen_file(monkeypatch):
    _install_names(monkeypatch, ["qwen/VNCCS/VNCCS_QIE2511_PoseStudio_ART_V6.safetensors"])
    rule = _family_pose_rule(_get_unicanvas_model_module("qwen_image_edit"))
    settings = {psl.POSE_EDIT_ACTIVE_SETTING: True, psl.POSE_STUDIO_LORA_NAME_SETTING: "mine/V5.9.5.safetensors"}
    assert rule.resolve(settings) == ("mine/V5.9.5.safetensors", 1.0)


def test_requirement_raises_a_readable_error_when_nothing_is_installed(monkeypatch):
    _install_names(monkeypatch, ["demo.safetensors"])
    for family, label in (("minimax_h3", "MiniMax H3"), ("qwen_image21", "Qwen Image 2.1")):
        rule = _family_pose_rule(_get_unicanvas_model_module(family))
        with pytest.raises(ValueError, match=f"Pose Studio LoRA for {label} is not installed"):
            rule.resolve({psl.POSE_EDIT_ACTIVE_SETTING: True})


def test_strength_zero_disables_the_pose_lora(monkeypatch):
    _install_names(monkeypatch, ["Klein9b/VNCCS_PoseStudioKlein9b_V2.5.safetensors"])
    rule = _family_pose_rule(_get_unicanvas_model_module("flux_klein"))
    assert rule.resolve({psl.POSE_EDIT_ACTIVE_SETTING: True, psl.POSE_STUDIO_LORA_STRENGTH_SETTING: 0}) is None


def test_apply_loras_applies_the_pose_lora_only_during_pose_edits(monkeypatch):
    applied = []
    monkeypatch.setattr(
        loras_module, "_apply_lora_cached",
        lambda model, clip, name, strength, clip_strength=None: applied.append((name, strength)) or (model, clip),
    )
    _install_names(monkeypatch, ["Klein9b/VNCCS_PoseStudioKlein9b_V2.5.safetensors"])
    module = _get_unicanvas_model_module("flux_klein")

    module.apply_loras("m", "c", {})
    assert applied == []

    module.apply_loras("m", "c", {psl.POSE_EDIT_ACTIVE_SETTING: True, "lora_stack": [
        {"name": "Klein9b/VNCCS_PoseStudioKlein9b_V2.5.safetensors", "strength": 0.8},
        {"name": "style.safetensors", "strength": 0.5},
    ]})
    assert applied == [("Klein9b/VNCCS_PoseStudioKlein9b_V2.5.safetensors", 1.0), ("style.safetensors", 0.5)]


# --- reference slots and pose edit preparation -----------------------------------------


def test_generic_slots_map_pose_images_and_drop_other_references():
    from nodes.unicanvas.models.base import _reference_image_slots

    settings = {
        "_pose_edit_images": ["pose", "background-and-character"],
        "_external": {"references": {"reference_image_1": "external-ref"}},
    }
    assert _reference_image_slots("working-area", settings) == {1: "pose", 2: "background-and-character"}

    # Without pose images the socket mapping is unchanged.
    plain = _reference_image_slots("working-area", {"_external": {"references": {"reference_image_1": "external-ref"}}})
    assert plain == {1: "working-area", 2: "external-ref"}


def test_h3_and_qi21_wire_the_pose_slots_through():
    from nodes.unicanvas.models.base import _reference_image_slots

    h3 = _get_unicanvas_model_module("minimax_h3")
    settings = {"_pose_edit_images": ["pose", "character"], "_h3_reference_image": "working-area"}
    assert h3._h3_reference_images(settings) == {"ref_image_1": "pose", "ref_image_2": "character"}

    qi21 = _get_unicanvas_model_module("qwen_image21")
    assert qi21.reference_image_slots("working-area", {"_pose_edit_images": ["pose", "character"]}) == {1: "pose", 2: "character"}
    assert _reference_image_slots("working-area", {}) == {1: "working-area"}


class _FakeRequest:
    def __init__(self):
        self.steps = 20


class _FakeCtx:
    def __init__(self, settings):
        self.settings = settings
        self.denoise = 0.5
        self.request = _FakeRequest()


def test_prepare_pose_edit_sets_the_active_gate_and_full_denoise():
    for family in POSE_EDIT_FAMILIES:
        ctx = _FakeCtx({})
        _get_unicanvas_model_module(family).prepare_pose_edit(ctx)
        assert ctx.settings[psl.POSE_EDIT_ACTIVE_SETTING] is True, family
        assert ctx.denoise == 1.0, family
        assert ctx.settings["denoise"] == 1.0, family


def test_h3_pose_edit_keeps_the_region_edit_step_count():
    h3 = _get_unicanvas_model_module("minimax_h3")
    ctx = _FakeCtx({"steps": 5})
    h3.prepare_pose_edit(ctx)
    assert ctx.request.steps == 5

    ctx = _FakeCtx({"minimax_h3_steps": 999})
    h3.prepare_pose_edit(ctx)
    assert ctx.request.steps == 60  # clamped to the widget range
    assert ctx.settings["steps"] == 60

    ctx = _FakeCtx({"minimax_h3_steps": 0})
    h3.prepare_pose_edit(ctx)
    assert ctx.request.steps == h3.defaults["steps"]  # falls back to the family default


# --- download queue --------------------------------------------------------------------


def test_enqueue_download_builds_a_pinned_preset_asset(monkeypatch, fresh_cache):
    captured = {}
    from nodes.unicanvas import presets

    monkeypatch.setattr(presets, "_enqueue_preset_download", lambda key, asset: captured.update({"key": key, "asset": asset}))
    monkeypatch.setattr(psl, "_remote_versions", lambda family, refresh=False: {
        "1.1": {"version": "1.1", "hf_path": "models/loras/QI2.1/VNCCS/VNCCS_QI2_PoseStudioV1.1.safetensors", "revision": PINNED_REVISION, "name": "QI2.1/VNCCS/VNCCS_QI2_PoseStudioV1.1.safetensors"},
        "1": {"version": "1", "hf_path": "models/loras/QI2.1/VNCCS/VNCCS_QI2_PoseStudioV1.safetensors", "revision": PINNED_REVISION, "name": "QI2.1/VNCCS/VNCCS_QI2_PoseStudioV1.safetensors"},
    })

    result = psl.enqueue_pose_studio_lora_download("qwen_image21")
    assert result == {"status": "queued", "queued": ["pose_studio_lora:qwen_image21:1.1"]}
    asset = captured["asset"]
    assert asset["hf_repo"] == "MIUProject/VNCCS_v3.0"
    assert asset["hf_path"] == asset["local_path"]  # local_path = hf_path (VNCCS layout)
    assert asset["local_path"].startswith("models/loras/")
    assert asset["hf_revision"] == PINNED_REVISION

    psl.enqueue_pose_studio_lora_download("qwen_image21", "1")
    assert captured["key"] == "pose_studio_lora:qwen_image21:1"


def test_enqueue_download_rejects_unknown_families_and_versions(monkeypatch, fresh_cache):
    from nodes.unicanvas import presets

    enqueued = []
    monkeypatch.setattr(presets, "_enqueue_preset_download", lambda key, asset: enqueued.append(key))
    monkeypatch.setattr(psl, "_remote_versions", lambda family, refresh=False: {"1": {"version": "1", "hf_path": "models/loras/x/V1.safetensors", "revision": "r", "name": "x/V1.safetensors"}})
    with pytest.raises(ValueError, match="Unknown Pose Studio LoRA family"):
        psl.enqueue_pose_studio_lora_download("sdxl")
    with pytest.raises(ValueError, match="is not available"):
        psl.enqueue_pose_studio_lora_download("minimax_h3", "99")
    assert enqueued == []


# --- prompt guides carry the pose templates --------------------------------------------


def test_h3_pose_template_is_ported_from_upstream():
    guide = _get_unicanvas_model_module("minimax_h3").capabilities.prompt_guide
    assert "<Picture 1>" in guide.guide and "<Picture 2>" in guide.guide
    assert any("<Picture 2>" in example for example in guide.examples)


def test_qi21_pose_template_uses_image_slots():
    module = _get_unicanvas_model_module("qwen_image21")
    guide = module.capabilities.prompt_guide_for("image_to_image")  # pose bakes run img2img
    assert "Pose Studio" in guide.guide
    assert any("<image1>" in example and "<image2>" in example for example in guide.examples)


# --- QIE pose conditioning keeps exactly the two pose images ----------------------------


def test_qwen_pose_edit_drops_external_references():
    from unittest.mock import patch

    from nodes.unicanvas.models import qwen_image_edit

    module = _get_unicanvas_model_module("qwen_image_edit")
    settings = {
        "_pose_edit_images": ["pose", "character-on-background"],
        "draw_mode": "inpaint",
        "_qwen_edit_mask": "unused",
        "positive": "studio prompt",
        "_external": {"references": {"reference_image_1": "external-ref"}},
    }
    calls = []

    def encode(_self, **kwargs):
        calls.append(kwargs)
        return ([], [], {"samples": "latent"})

    with patch.object(type(module), "_encode_qwen_edit", encode), \
         patch.object(qwen_image_edit, "_conditioning_debug", return_value={}), \
         patch.object(qwen_image_edit, "_latent_debug", return_value={}):
        module.prepare_reference_conditioning([], [], "vae", "ordinary-input", settings)
    assert calls[0]["image_tensors"] == ["pose", "character-on-background"]
    assert calls[0]["image_tensor"] == "pose"
