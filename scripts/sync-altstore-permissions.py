#!/usr/bin/env python3
"""Synchronize AltStore appPermissions from an iOS IPA."""

from __future__ import annotations

import argparse
import json
import plistlib
import re
import stat
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

SIGNING_ENTITLEMENTS = {
    "application-identifier",
    "com.apple.developer.team-identifier",
    "get-task-allow",
    "keychain-access-groups",
    "beta-reports-active",
}


def _read_plist(data: bytes, description: str) -> dict:
    try:
        value = plistlib.loads(data)
    except (plistlib.InvalidFileException, ValueError, TypeError) as exc:
        raise ValueError(f"invalid {description}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"invalid {description}: expected a plist dictionary")
    return value


def _find_main_app(archive: zipfile.ZipFile) -> tuple[str, dict]:
    candidates = []
    for name in archive.namelist():
        path = PurePosixPath(name)
        if (
            len(path.parts) == 3
            and path.parts[0] == "Payload"
            and path.parts[1].endswith(".app")
            and path.name == "Info.plist"
        ):
            candidates.append(name)

    if len(candidates) != 1:
        raise ValueError(
            "invalid IPA: expected exactly one Payload/<App>.app/Info.plist "
            f"(found {len(candidates)})"
        )

    info_path = candidates[0]
    info = _read_plist(archive.read(info_path), f"{info_path}")
    bundle_id = info.get("CFBundleIdentifier")
    executable = info.get("CFBundleExecutable")
    if not isinstance(bundle_id, str) or not bundle_id.strip():
        raise ValueError(f"invalid IPA: {info_path} is missing CFBundleIdentifier")
    if not isinstance(executable, str) or not executable.strip():
        raise ValueError(f"invalid IPA: {info_path} is missing CFBundleExecutable")

    app_directory = str(PurePosixPath(info_path).parent)
    executable_path = f"{app_directory}/{executable}"
    if executable_path not in archive.namelist():
        raise ValueError(f"invalid IPA: app executable not found: {executable_path}")

    return executable_path, info


def _extract_entitlements(executable: bytes) -> list[str]:
    entitlements: set[str] = set()
    for match in re.finditer(rb"<plist(?:\s[^>]*)?>", executable):
        end = executable.find(b"</plist>", match.end())
        if end < 0:
            continue
        try:
            value = plistlib.loads(executable[match.start() : end + len(b"</plist>")])
        except (plistlib.InvalidFileException, ValueError, TypeError):
            continue
        if isinstance(value, dict):
            entitlements.update(
                key
                for key in value
                if isinstance(key, str) and key not in SIGNING_ENTITLEMENTS
            )
    return sorted(entitlements)


def extract_app_permissions(ipa_path: Path) -> tuple[str, dict]:
    try:
        with zipfile.ZipFile(ipa_path) as archive:
            executable_path, info = _find_main_app(archive)
            executable = archive.read(executable_path)
    except (OSError, zipfile.BadZipFile, KeyError) as exc:
        raise ValueError(f"invalid IPA {ipa_path}: {exc}") from exc

    privacy = {
        key: value
        for key, value in info.items()
        if isinstance(key, str)
        and key.endswith("UsageDescription")
        and isinstance(value, str)
    }
    return info["CFBundleIdentifier"], {
        "entitlements": _extract_entitlements(executable),
        "privacy": dict(sorted(privacy.items())),
    }


def _find_source_app(source: object, bundle_id: str) -> dict:
    if not isinstance(source, dict):
        raise ValueError("invalid source JSON: expected an object")

    apps: list[dict] = []
    if "app" in source:
        template = source["app"]
        if not isinstance(template, dict):
            raise ValueError("invalid source JSON: 'app' must be an object")
        apps.append(template)
    if "apps" in source:
        source_apps = source["apps"]
        if not isinstance(source_apps, list) or not all(
            isinstance(app, dict) for app in source_apps
        ):
            raise ValueError("invalid source JSON: 'apps' must be an array of objects")
        apps.extend(source_apps)

    if not apps:
        raise ValueError("invalid source JSON: expected an 'app' object or 'apps' array")

    matches = [app for app in apps if app.get("bundleIdentifier") == bundle_id]
    if len(matches) != 1:
        raise ValueError(
            f"source JSON must contain exactly one app with bundleIdentifier "
            f"{bundle_id!r} (found {len(matches)})"
        )
    return matches[0]


def sync_source(source_path: Path, bundle_id: str, permissions: dict, *, check: bool,
                no_entitlements: bool) -> bool:
    try:
        source = json.loads(source_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid source JSON {source_path}: {exc}") from exc

    app = _find_source_app(source, bundle_id)
    old_permissions = app.get("appPermissions")
    if old_permissions is not None and not isinstance(old_permissions, dict):
        raise ValueError("invalid source JSON: 'appPermissions' must be an object")

    updated = dict(old_permissions or {})
    updated["privacy"] = permissions["privacy"]
    if not no_entitlements:
        updated["entitlements"] = permissions["entitlements"]
    changed = updated != old_permissions

    if check:
        if changed:
            raise ValueError(
                f"{source_path} appPermissions for {bundle_id} are out of sync"
            )
        return False

    if changed:
        app["appPermissions"] = updated
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=source_path.parent, delete=False
        ) as handle:
            json.dump(source, handle, indent=2)
            handle.write("\n")
            temp_path = Path(handle.name)
        temp_path.chmod(stat.S_IMODE(source_path.stat().st_mode))
        temp_path.replace(source_path)
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ipa", type=Path, help="IPA archive to inspect")
    parser.add_argument(
        "--source",
        type=Path,
        help="AltStore source JSON to patch (or verify with --check)",
    )
    parser.add_argument(
        "--print-app-permissions",
        action="store_true",
        help="print the extracted appPermissions JSON block",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit nonzero if source appPermissions differ; do not modify the source",
    )
    parser.add_argument(
        "--no-entitlements",
        action="store_true",
        help="preserve the source entitlements while syncing privacy strings",
    )
    args = parser.parse_args()

    if args.check and not args.source:
        parser.error("--check requires --source")
    if args.print_app_permissions and args.source:
        parser.error("--print-app-permissions cannot be combined with --source")
    if not args.print_app_permissions and not args.source:
        parser.error("provide --source or --print-app-permissions")

    try:
        bundle_id, permissions = extract_app_permissions(args.ipa)
        if args.print_app_permissions:
            print(json.dumps(permissions, indent=2))
            return 0
        changed = sync_source(
            args.source,
            bundle_id,
            permissions,
            check=args.check,
            no_entitlements=args.no_entitlements,
        )
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.check:
        print(f"{args.source} appPermissions are in sync for {bundle_id}")
    else:
        status = "Updated" if changed else "Already in sync"
        print(f"{status} {args.source} appPermissions for {bundle_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
