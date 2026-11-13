#!/usr/bin/env python3
"""Synchronize AltStore appPermissions from an iOS IPA."""

from __future__ import annotations

import argparse
import json
import plistlib
import struct
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
    """Read CSSLOT_ENTITLEMENTS from LC_CODE_SIGNATURE (including fat binaries)."""
    entitlements: set[str] = set()

    def unpack(fmt: str, data: bytes, offset: int) -> tuple:
        if offset < 0 or offset + struct.calcsize(fmt) > len(data):
            raise ValueError("invalid code signature: truncated structure")
        return struct.unpack_from(fmt, data, offset)

    def parse(data: bytes, *, allow_fat: bool = True) -> None:
        magic = data[:4]
        fat = {b"\xca\xfe\xba\xbe": (">", False), b"\xbe\xba\xfe\xca": ("<", False),
               b"\xca\xfe\xba\xbf": (">", True), b"\xbf\xba\xfe\xca": ("<", True)}
        if magic in fat and allow_fat:
            endian, wide = fat[magic]
            count, = unpack(endian + "I", data, 4)
            table_end = 8 + count * (32 if wide else 20)
            if table_end > len(data):
                raise ValueError("invalid Mach-O: truncated architecture table")
            for index in range(count):
                entry = 8 + index * (32 if wide else 20)
                offset, size = unpack(endian + ("QQ" if wide else "II"), data, entry + 8)
                if offset < table_end or offset + size > len(data):
                    raise ValueError("invalid Mach-O: truncated architecture")
                parse(data[offset:offset + size], allow_fat=False)
            return
        formats = {b"\xce\xfa\xed\xfe": ("<", 28), b"\xcf\xfa\xed\xfe": ("<", 32),
                   b"\xfe\xed\xfa\xce": (">", 28), b"\xfe\xed\xfa\xcf": (">", 32)}
        if magic not in formats:
            raise ValueError("invalid Mach-O executable")
        endian, cursor = formats[magic]
        count, command_size = unpack(endian + "II", data, 16)
        commands_end = cursor + command_size
        if commands_end > len(data):
            raise ValueError("invalid Mach-O: truncated load commands")
        for _ in range(count):
            if cursor + 8 > commands_end:
                raise ValueError("invalid Mach-O: truncated load command")
            command, size = unpack(endian + "II", data, cursor)
            if size < 8 or cursor + size > commands_end:
                raise ValueError("invalid Mach-O load command")
            if command == 0x1D:  # LC_CODE_SIGNATURE
                if size < 16:
                    raise ValueError("invalid LC_CODE_SIGNATURE")
                offset, length = unpack(endian + "II", data, cursor + 8)
                if offset + length > len(data):
                    raise ValueError("invalid code signature: truncated data")
                signature = data[offset:offset + length]
                sig_magic, sig_length, slots = unpack(">III", signature, 0)
                if sig_magic != 0xFADE0CC0 or not 12 + slots * 8 <= sig_length <= len(signature):
                    raise ValueError("invalid embedded code signature")
                signature = signature[:sig_length]
                for index in range(slots):
                    slot, blob_offset = unpack(">II", signature, 12 + index * 8)
                    if slot != 5:  # CSSLOT_ENTITLEMENTS
                        continue
                    blob_magic, blob_length = unpack(">II", signature, blob_offset)
                    if (blob_magic != 0xFADE7171 or blob_length < 8
                            or blob_offset < 12 + slots * 8
                            or blob_offset + blob_length > sig_length):
                        raise ValueError("invalid entitlement blob")
                    value = _read_plist(signature[blob_offset + 8:blob_offset + blob_length],
                                        "entitlement blob")
                    entitlements.update(key for key in value if key not in SIGNING_ENTITLEMENTS)
            cursor += size

    parse(executable)
    return sorted(entitlements)


def extract_app_permissions(ipa_path: Path) -> tuple[str, dict]:
    try:
        with zipfile.ZipFile(ipa_path) as archive:
            executable_path, info = _find_main_app(archive)
            entitlements = set(_extract_entitlements(archive.read(executable_path)))
            app_directory = PurePosixPath(executable_path).parent
            for name in archive.namelist():
                path = PurePosixPath(name)
                if (path.is_relative_to(app_directory) and path.name == "Info.plist"
                        and path.parent.suffix == ".appex"):
                    extension = _read_plist(archive.read(name), name)
                    executable = extension.get("CFBundleExecutable")
                    if not isinstance(executable, str) or not executable.strip():
                        raise ValueError(f"invalid IPA: {name} is missing CFBundleExecutable")
                    entitlements.update(_extract_entitlements(
                        archive.read(str(path.parent / executable))))
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
        "entitlements": sorted(entitlements),
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
