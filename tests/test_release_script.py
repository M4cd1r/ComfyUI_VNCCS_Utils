from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("vnccs_release_script", ROOT / "scripts" / "release.py")
release = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(release)


def _make_repo(tmp_path, changelog):
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "x"\nversion = "1.2.3"\n', encoding="utf-8")
    (tmp_path / "README.md").write_text("> **Current release: `1.2.3`**\n", encoding="utf-8")
    (tmp_path / "CHANGELOG.md").write_text(changelog, encoding="utf-8")
    return tmp_path


def test_release_promotes_next_and_restores_stub(tmp_path):
    root = _make_repo(tmp_path, "# Version [[NEXT]]\n\n* **Fix**: a.\n\n# Version 1.2.3\n\n* old\n")
    notes = tmp_path / "notes.md"
    assert release.prepare_release(root, bump="patch", notes_path=notes) == "1.2.4"
    assert notes.read_text(encoding="utf-8") == "* **Fix**: a.\n"
    assert (root / "CHANGELOG.md").read_text(encoding="utf-8") == (
        "# Version [[NEXT]]\n\n# Version 1.2.4\n\n* **Fix**: a.\n\n# Version 1.2.3\n\n* old\n"
    )
    assert 'version = "1.2.4"' in (root / "pyproject.toml").read_text(encoding="utf-8")
    assert "`1.2.4`" in (root / "README.md").read_text(encoding="utf-8")


def test_bumps_and_explicit_version(tmp_path):
    assert release.next_version("1.2.3", "minor") == "1.3.0"
    assert release.next_version("1.2.3", "major") == "2.0.0"
    root = _make_repo(tmp_path, "# Version [[NEXT]]\n\n* x\n")
    assert release.prepare_release(root, version="1.5.0") == "1.5.0"
    assert (root / "CHANGELOG.md").read_text(encoding="utf-8").endswith("# Version 1.5.0\n\n* x\n")


@pytest.mark.parametrize(
    "changelog,kwargs",
    [
        ("# Version [[NEXT]]\n\n# Version 1.2.3\n\n* old\n", {"bump": "patch"}),
        ("# Version 1.2.3\n\n* old\n", {"bump": "patch"}),
        ("# Version [[NEXT]]\n\n* x\n", {"version": "1.2.3"}),
        ("# Version [[NEXT]]\n\n* x\n", {"version": "1.2.x"}),
    ],
)
def test_invalid_release_changes_nothing(tmp_path, changelog, kwargs):
    root = _make_repo(tmp_path, changelog)
    with pytest.raises(release.ReleaseError):
        release.prepare_release(root, **kwargs)
    assert (root / "CHANGELOG.md").read_text(encoding="utf-8") == changelog
    assert 'version = "1.2.3"' in (root / "pyproject.toml").read_text(encoding="utf-8")


def test_repo_changelog_starts_with_next_section():
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    release.split_changelog(text)
