"""Config-driven Pose Studio LoRA rules, shared by the pose-edit model families.

Upstream VNCCS Pose Studio always pairs a pose edit with a dedicated LoRA
(``control_center.json`` of ``AHEKOT/ComfyUI_VNCCS``); ``config/unicanvas_presets.json``
declares one lookup rule per model family (``"pose_studio_loras"``) instead of a
single pinned file, so a new LoRA version in the Hugging Face repository is picked
up without a code change:

* :func:`latest_pose_studio_lora` asks the Hugging Face Hub for the newest file
  matching the family rule (``huggingface_hub``, anonymous, off the event loop via
  the routes, cached in memory with a TTL and overridable with a "check now").
  Any Hub error falls back to the rule's pinned ``baseline`` - this never raises.
* :func:`installed_pose_studio_loras` scans the local ``loras`` folders for the
  highest installed version (any subfolder, upstream legacy names included).
* :func:`resolve_pose_studio_lora` picks the file a draw should apply: the
  highest installed version, or the explicitly chosen ``pose_studio_lora_name``.
* :func:`pose_studio_lora_requirement` builds the :class:`LoraRequirement` a
  family declares; it only applies while Pose Studio layers are active and never
  downloads - a missing file raises with a pointer to the bake settings.
"""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass
from typing import Any

from .loras import LoraRequirement


# Settings keys shared with the frontend bake UI (the fixed API contract).
POSE_STUDIO_LORA_NAME_SETTING = "pose_studio_lora_name"
POSE_STUDIO_LORA_STRENGTH_SETTING = "pose_studio_lora_strength"
# Set in the draw settings by ``UniCanvasModelModule.prepare_pose_edit`` while a
# draw runs with Pose Studio layers. The LoRA requirement is gated on it because
# the pose images are stashed later in the pipeline than the LoRA application.
POSE_EDIT_ACTIVE_SETTING = "_pose_edit_active"

_POSE_STUDIO_LORAS_SECTION = "pose_studio_loras"
_POSE_STUDIO_LORAS_TTL = 6 * 60 * 60  # in-memory freshness window for Hub lookups
_LORAS_HF_PREFIX = "models/loras/"
_VERSION_GROUP = "v"


@dataclass(frozen=True)
class PoseStudioLoraRule:
    """One family's Pose Studio LoRA lookup rule from ``unicanvas_presets.json``.

    ``match`` selects the remote files (named group ``v`` carries the version);
    ``local_match`` are the extra file-name patterns the local scan recognizes
    (e.g. the upstream legacy ``H3_PoseStudioV1.safetensors`` naming).
    """

    family: str
    label: str
    hf_repo: str
    hf_dir: str
    match: re.Pattern[str]
    local_match: tuple[re.Pattern[str], ...]
    baseline_version: str
    baseline_hf_path: str
    baseline_revision: str

    def baseline_entry(self) -> dict[str, Any]:
        """The pinned fallback used offline or when the Hub cannot be reached."""
        return {
            "version": self.baseline_version,
            "hf_path": self.baseline_hf_path,
            "revision": self.baseline_revision,
            "name": lora_name_from_hf_path(self.baseline_hf_path),
        }

    def not_installed_message(self) -> str:
        return f"Pose Studio LoRA for {self.label} is not installed – download it in Settings › Character bake."


_RULES: dict[str, PoseStudioLoraRule] | None = None
_LATEST_CACHE: dict[str, tuple[float, dict[str, dict[str, Any]]]] = {}
_LATEST_LOCK = threading.Lock()


# -- rules ------------------------------------------------------------------------------


def pose_studio_lora_rules() -> dict[str, PoseStudioLoraRule]:
    """The configured rules, parsed once (a local file read, never the Hub)."""
    global _RULES
    if _RULES is None:
        _RULES = _load_rules()
    return _RULES


def pose_studio_lora_families() -> tuple[str, ...]:
    """The families that declare a Pose Studio LoRA rule, in config order."""
    return tuple(pose_studio_lora_rules())


def pose_studio_lora_rule(family: str) -> PoseStudioLoraRule:
    try:
        return pose_studio_lora_rules()[str(family or "")]
    except KeyError:
        known = ", ".join(sorted(pose_studio_lora_rules()))
        raise ValueError(f"Unknown Pose Studio LoRA family '{family}' (known: {known})") from None


def _load_rules() -> dict[str, PoseStudioLoraRule]:
    from .presets import _unicanvas_presets_path

    try:
        with open(_unicanvas_presets_path(), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    section = data.get(_POSE_STUDIO_LORAS_SECTION) if isinstance(data, dict) else None
    if not isinstance(section, dict):
        return {}
    rules: dict[str, PoseStudioLoraRule] = {}
    for family, raw in section.items():
        rule = _parse_rule(str(family), raw)
        if rule is not None:
            rules[family] = rule
    return rules


def _parse_rule(family: str, raw: Any) -> PoseStudioLoraRule | None:
    if not isinstance(raw, dict):
        return None
    match = _compile(raw.get("match"))
    baseline = raw.get("baseline") if isinstance(raw.get("baseline"), dict) else {}
    baseline_path = str(baseline.get("hf_path") or "")
    if match is None or not baseline_path or not raw.get("hf_repo"):
        return None
    local_match = tuple(
        pattern
        for pattern in [_compile(raw.get("match"))] + [_compile(item) for item in raw.get("local_match") or []]
        if pattern is not None
    )
    return PoseStudioLoraRule(
        family=family,
        label=str(raw.get("label") or family),
        hf_repo=str(raw.get("hf_repo") or ""),
        hf_dir=str(raw.get("hf_dir") or ""),
        match=match,
        local_match=local_match,
        baseline_version=str(baseline.get("version") or _version_from_path(baseline_path)),
        baseline_hf_path=baseline_path,
        baseline_revision=str(baseline.get("revision") or "main"),
    )


def _compile(pattern: Any) -> re.Pattern[str] | None:
    try:
        return re.compile(str(pattern or ""))
    except re.error:
        return None


# -- versions ---------------------------------------------------------------------------


def version_key(version: Any) -> tuple[int, ...]:
    """A dot-separated numeric version as a comparable tuple: ``"5.9.5" < "6"``."""
    numbers = re.findall(r"\d+", str(version or ""))
    return tuple(int(part) for part in numbers) or (0,)


def _version_from_path(path: str) -> str:
    match = re.search(r"_V(\d+(?:\.\d+)*)\.safetensors$", str(path or ""))
    return match.group(1) if match else "0"


def _match_version(patterns: tuple[re.Pattern[str], ...], filename: str) -> str | None:
    for pattern in patterns:
        found = pattern.search(filename)
        if found:
            groups = found.groupdict()
            version = groups.get(_VERSION_GROUP) or (found.group(1) if found.groups() else "")
            if version:
                return version
    return None


def lora_name_from_hf_path(hf_path: str) -> str:
    """The ComfyUI ``loras``-relative name of a repo file (``local_path`` = ``hf_path``)."""
    normalized = str(hf_path or "").replace("\\", "/")
    if normalized.lower().startswith(_LORAS_HF_PREFIX):
        return normalized[len(_LORAS_HF_PREFIX):]
    return normalized.rsplit("/", 1)[-1]


# -- installed scan (local, never the Hub) ----------------------------------------------


def installed_pose_studio_loras(family: str) -> dict[str, Any] | None:
    """The highest installed version of the family's Pose Studio LoRA.

    Every configured ``loras`` subfolder is scanned (files installed by VNCCS
    workflows may sit elsewhere than the repo path suggests), so ``name`` is the
    ComfyUI-listed file and ``hf_path`` the canonical ``models/loras/`` location.
    """
    rule = pose_studio_lora_rule(family)
    best_key: tuple[int, ...] | None = None
    best: dict[str, Any] | None = None
    for name in _listed_lora_names():
        normalized = name.replace("\\", "/")
        version = _match_version(rule.local_match, normalized.rsplit("/", 1)[-1])
        if version is None:
            continue
        key = version_key(version)
        if best_key is None or key > best_key:
            best_key = key
            best = {
                "version": version,
                "hf_path": f"{_LORAS_HF_PREFIX}{normalized}",
                "name": normalized,
            }
    return best


def _listed_lora_names() -> list[str]:
    try:
        import folder_paths

        return [str(name) for name in (folder_paths.get_filename_list("loras") or [])]
    except Exception:
        return []


# -- latest lookup (the Hub, cached, baseline fallback) ----------------------------------


def latest_pose_studio_lora(family: str, refresh: bool = False) -> dict[str, Any] | None:
    """The newest Pose Studio LoRA version in the family's repository folder.

    Pinned to the commit sha of ``main`` so a download is repeatable. Falls back
    to the configured baseline on any Hub error (never raises, never blocks a
    draw); ``refresh`` bypasses the TTL cache for an explicit "check now".
    """
    entries = _remote_versions(family, refresh=refresh)
    if not entries:
        return None
    best = max(entries.values(), key=lambda entry: version_key(entry.get("version")))
    return dict(best) if best else None


def _remote_versions(family: str, refresh: bool = False) -> dict[str, dict[str, Any]]:
    rule = pose_studio_lora_rule(family)
    if not refresh:
        with _LATEST_LOCK:
            cached = _LATEST_CACHE.get(family)
        if cached is not None and time.monotonic() - cached[0] < _POSE_STUDIO_LORAS_TTL:
            return cached[1]
    try:
        entries = _query_remote_versions(rule)
    except Exception:
        # Offline, rate limited, repository moved: the pinned baseline keeps the
        # feature working (and is cached, so a flaky network is not hammered).
        entries = {rule.baseline_version: rule.baseline_entry()}
    with _LATEST_LOCK:
        _LATEST_CACHE[family] = (time.monotonic(), entries)
    return entries


def _query_remote_versions(rule: PoseStudioLoraRule) -> dict[str, dict[str, Any]]:
    from huggingface_hub import HfApi

    api = HfApi(token=False)
    info = api.model_info(repo_id=rule.hf_repo, revision="main", token=False)
    revision = str(getattr(info, "sha", "") or "main")
    entries: dict[str, dict[str, Any]] = {}
    for item in api.list_repo_tree(repo_id=rule.hf_repo, path_in_repo=rule.hf_dir, revision=revision, token=False):
        if str(getattr(item, "type", "file")) != "file":
            continue
        path = str(getattr(item, "path", "") or "")
        version = _match_version((rule.match,), path.rsplit("/", 1)[-1])
        if version is None:
            continue
        entries[version] = {
            "version": version,
            "hf_path": path,
            "revision": revision,
            "name": lora_name_from_hf_path(path),
        }
    return entries


def pose_studio_loras_status(refresh: bool = False) -> dict[str, Any]:
    """The ``GET /vnccs/unicanvas/pose_studio_loras`` payload, keyed by family."""
    payload: dict[str, Any] = {}
    for family in pose_studio_lora_families():
        installed = installed_pose_studio_loras(family)
        latest = latest_pose_studio_lora(family, refresh=refresh)
        update_available = bool(latest) and (
            installed is None or version_key(latest.get("version")) > version_key(installed.get("version"))
        )
        payload[family] = {
            "installed": installed,
            "latest": latest,
            "update_available": update_available,
        }
    return payload


# -- draw-time resolution and the families' requirement ----------------------------------


def resolve_pose_studio_lora(family: str, settings: dict[str, Any] | None = None) -> str | None:
    """The Pose Studio LoRA file a draw should apply, or ``None``.

    An explicit ``pose_studio_lora_name`` wins; otherwise the highest installed
    version. Local scan only: a draw never contacts the Hub or downloads.
    """
    explicit = str((settings or {}).get(POSE_STUDIO_LORA_NAME_SETTING) or "").strip()
    if explicit:
        return explicit
    installed = installed_pose_studio_loras(family)
    return str(installed["name"]) if installed else None


def _require_pose_studio_lora(family: str) -> str:
    name = resolve_pose_studio_lora(family)
    if not name:
        raise ValueError(pose_studio_lora_rule(family).not_installed_message())
    return name


def pose_studio_lora_requirement(family: str) -> LoraRequirement:
    """The ``LoraRequirement`` a pose-edit family declares for its Pose Studio LoRA.

    The rule is active only while Pose Studio layers are drawn
    (``_pose_edit_active``). The family's baseline file acts as the "auto"
    sentinel: when no explicit ``pose_studio_lora_name`` is set the resolver
    replaces it with the highest installed version, and any other explicitly
    chosen file is passed through untouched.
    """
    rule = pose_studio_lora_rule(family)
    auto_name = rule.baseline_entry()["name"]
    return LoraRequirement(
        name_setting=POSE_STUDIO_LORA_NAME_SETTING,
        default_name=auto_name,
        resolve_match=auto_name,
        enabled_setting=POSE_EDIT_ACTIVE_SETTING,
        strength_setting=POSE_STUDIO_LORA_STRENGTH_SETTING,
        default_strength=1.0,
        required=True,
        dedupe_from_stack=True,
        resolver=lambda: _require_pose_studio_lora(family),
        description=f"VNCCS Pose Studio LoRA for {rule.label} (required while pose layers are drawn)",
    )


# -- download queue ---------------------------------------------------------------------


def enqueue_pose_studio_lora_download(family: str, version: str = "") -> dict[str, Any]:
    """Queue one Pose Studio LoRA file through the existing preset download worker.

    Builds the asset from the Hub listing pinned to its revision; progress
    surfaces through the same ``/vnccs/unicanvas/presets/status`` payloads the
    preset downloads already use. No new download mechanism.
    """
    rule = pose_studio_lora_rule(family)
    entries = _remote_versions(family)
    requested = str(version or "").strip()
    entry = entries.get(requested) if requested else None
    if entry is None:
        if requested:
            available = ", ".join(sorted(entries, key=version_key)) or "none"
            raise ValueError(f"Pose Studio LoRA version '{requested}' is not available for {rule.label} (available: {available})")
        entry = max(entries.values(), key=lambda item: version_key(item.get("version")))
    asset = {
        "role": "lora",
        "name": f"VNCCS Pose Studio LoRA {rule.label} {entry['version']}",
        "hf_repo": rule.hf_repo,
        "hf_path": entry["hf_path"],
        "hf_revision": entry["revision"],
        # local_path = hf_path, like upstream VNCCS: files installed by VNCCS
        # workflows are recognized by the installed scan this way.
        "local_path": entry["hf_path"],
        "description": f"Pose Studio LoRA for {rule.label}, version {entry['version']}.",
    }
    download_key = f"pose_studio_lora:{family}:{entry['version']}"
    from .presets import _enqueue_preset_download

    _enqueue_preset_download(download_key, asset)
    return {"status": "queued", "queued": [download_key]}
