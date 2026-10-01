"""Turn the `[[NEXT]]` changelog section into a numbered release.

Feature PRs add their notes under a top `# Version [[NEXT]]` heading in CHANGELOG.md and
never touch version numbers. The Release workflow runs this script, which then:

* renames the `[[NEXT]]` heading to the new version,
* puts a fresh empty `# Version [[NEXT]]` section on top for the next PRs,
* optionally saves the released notes to a file (for announcements),
* updates `version` in pyproject.toml and "Current release" in README.md.

Usage: python scripts/release.py (--bump patch|minor|major | --version X.Y.Z)
The new version is printed to stdout. Nothing is written when validation fails.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

NEXT_HEADING = "# Version [[NEXT]]"
_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
_PYPROJECT_RE = re.compile(r'^(version\s*=\s*")(\d+\.\d+\.\d+)(")', re.MULTILINE)
_README_RE = re.compile(r"(Current release: `)(\d+\.\d+\.\d+)(`)")
_HEADING_RE = re.compile(r"^# Version ", re.MULTILINE)


class ReleaseError(Exception):
    pass


def _parse(version: str) -> tuple[int, int, int]:
    if not _VERSION_RE.match(version):
        raise ReleaseError(f"Invalid version: {version!r} (expected X.Y.Z)")
    major, minor, patch = (int(part) for part in version.split("."))
    return major, minor, patch


def next_version(current: str, bump: str) -> str:
    major, minor, patch = _parse(current)
    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise ReleaseError(f"Unknown bump type: {bump!r}")


def split_changelog(text: str) -> tuple[str, str]:
    """Return (NEXT section body, rest of the changelog after the NEXT section)."""
    stripped = text.lstrip()
    if not stripped.startswith(NEXT_HEADING):
        raise ReleaseError(f"CHANGELOG.md must start with '{NEXT_HEADING}'")
    after = stripped[len(NEXT_HEADING):]
    match = _HEADING_RE.search(after)
    body, rest = (after[:match.start()], after[match.start():]) if match else (after, "")
    return body, rest


def prepare_release(
    root: Path, bump: str | None = None, version: str | None = None, notes_path: Path | None = None
) -> str:
    pyproject_path = root / "pyproject.toml"
    changelog_path = root / "CHANGELOG.md"
    readme_path = root / "README.md"

    pyproject = pyproject_path.read_text(encoding="utf-8")
    found = _PYPROJECT_RE.search(pyproject)
    if not found:
        raise ReleaseError("No version found in pyproject.toml")
    current = found.group(2)

    if version:
        new_version = version
        if _parse(new_version) <= _parse(current):
            raise ReleaseError(f"Version {new_version} must be greater than current {current}")
    elif bump:
        new_version = next_version(current, bump)
    else:
        raise ReleaseError("Pass a bump type or an explicit version")

    body, rest = split_changelog(changelog_path.read_text(encoding="utf-8"))
    if not body.strip():
        raise ReleaseError("The [[NEXT]] changelog section is empty; nothing to release")

    readme = readme_path.read_text(encoding="utf-8")
    if not _README_RE.search(readme):
        raise ReleaseError("No 'Current release' marker found in README.md")

    changelog = f"{NEXT_HEADING}\n\n# Version {new_version}{body.rstrip()}\n\n{rest}".rstrip() + "\n"
    changelog_path.write_text(changelog, encoding="utf-8")
    pyproject_path.write_text(_PYPROJECT_RE.sub(rf"\g<1>{new_version}\g<3>", pyproject, count=1), encoding="utf-8")
    readme_path.write_text(_README_RE.sub(rf"\g<1>{new_version}\g<3>", readme, count=1), encoding="utf-8")
    if notes_path:
        notes_path.write_text(body.strip() + "\n", encoding="utf-8")
    return new_version


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--bump", choices=["patch", "minor", "major"])
    group.add_argument("--version")
    parser.add_argument("--notes-file", type=Path, help="Write the released changelog section here")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args(argv)
    try:
        print(prepare_release(args.root, bump=args.bump, version=args.version, notes_path=args.notes_file))
    except ReleaseError as exc:
        print(f"release: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
