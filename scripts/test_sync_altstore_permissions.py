import json
import plistlib
import subprocess
import struct
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).with_name("sync-altstore-permissions.py")
BUNDLE_ID = "com.example.mobile"
SIGNING_ENTITLEMENTS = {
    "application-identifier": "TEAM.com.example.mobile",
    "com.apple.developer.team-identifier": "TEAM",
    "get-task-allow": True,
    "keychain-access-groups": ["TEAM.com.example.mobile"],
    "beta-reports-active": True,
}
DECLARED_ENTITLEMENTS = {
    **SIGNING_ENTITLEMENTS,
    "com.apple.developer.associated-domains": ["applinks:example.com"],
    "com.apple.developer.networking.networkextension": True,
}
INFO = {
    "CFBundleIdentifier": BUNDLE_ID,
    "CFBundleExecutable": "Example",
    "NSCameraUsageDescription": "Camera access for profile photos",
    "NSLocationWhenInUseUsageDescription": "Location for nearby events",
    "NSNotAStringUsageDescription": 42,
    "CFBundleName": "Example",
}


def signed_executable(entitlements: dict, *, endian: str = "<", wide: bool = True) -> bytes:
    """Minimal Mach-O fixture with an indexed signature and unrelated XML."""
    unrelated = plistlib.dumps({"unrelated.plist.key": True})
    payload = plistlib.dumps(entitlements)
    blob = struct.pack(">II", 0xFADE7171, 8 + len(payload)) + payload
    # Include a second plist inside a non-entitlement slot as well.
    other = struct.pack(">II", 0xFADE7171, 8 + len(unrelated)) + unrelated
    signature = (struct.pack(">III", 0xFADE0CC0, 28 + len(blob) + len(other), 2)
                 + struct.pack(">II", 5, 28)
                 + struct.pack(">II", 0x10000, 28 + len(blob)) + blob + other)
    header = struct.pack(endian + "7I", 0xFEEDFACF if wide else 0xFEEDFACE,
                         0, 0, 2, 1, 16, 0)
    if wide:
        header += struct.pack(endian + "I", 0)
    command = struct.pack(endian + "4I", 0x1D, 16,
                          len(header) + 16 + len(unrelated), len(signature))
    return header + command + unrelated + signature


class SyncAltStorePermissionsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        self.ipa = self.root / "example.ipa"
        with zipfile.ZipFile(self.ipa, "w") as archive:
            archive.writestr(
                "Payload/Example.app/Info.plist",
                plistlib.dumps(INFO, fmt=plistlib.FMT_XML),
            )
            archive.writestr(
                "Payload/Example.app/Example", signed_executable(DECLARED_ENTITLEMENTS)
            )

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(self.ipa), *args],
            check=False,
            capture_output=True,
            text=True,
        )

    def write_source(self, source: dict) -> Path:
        path = self.root / "source.json"
        path.write_text(json.dumps(source, indent=2) + "\n", encoding="utf-8")
        return path

    def test_extracts_usage_strings_and_filters_signing_entitlements(self) -> None:
        result = self.run_cli("--print-app-permissions")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            {
                "entitlements": [
                    "com.apple.developer.associated-domains",
                    "com.apple.developer.networking.networkextension",
                ],
                "privacy": {
                    "NSCameraUsageDescription": "Camera access for profile photos",
                    "NSLocationWhenInUseUsageDescription": "Location for nearby events",
                },
            },
        )

    def test_patches_app_template_and_successfully_checks_it(self) -> None:
        source_path = self.write_source(
            {
                "name": "Example",
                "app": {
                    "bundleIdentifier": BUNDLE_ID,
                    "appPermissions": {
                        "entitlements": ["old.entitlement"],
                        "privacy": {"NSOldUsageDescription": "old"},
                    },
                },
            }
        )

        patched = self.run_cli("--source", str(source_path))
        checked = self.run_cli("--source", str(source_path), "--check")

        self.assertEqual(patched.returncode, 0, patched.stderr)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        source = json.loads(source_path.read_text(encoding="utf-8"))
        self.assertEqual(
            source["app"]["appPermissions"],
            {
                "entitlements": [
                    "com.apple.developer.associated-domains",
                    "com.apple.developer.networking.networkextension",
                ],
                "privacy": {
                    "NSCameraUsageDescription": "Camera access for profile photos",
                    "NSLocationWhenInUseUsageDescription": "Location for nearby events",
                },
            },
        )

    def test_patches_apps_array_by_bundle_id(self) -> None:
        source_path = self.write_source(
            {
                "apps": [
                    {"bundleIdentifier": "com.example.other"},
                    {"bundleIdentifier": BUNDLE_ID, "appPermissions": {}},
                ]
            }
        )

        result = self.run_cli("--source", str(source_path))

        self.assertEqual(result.returncode, 0, result.stderr)
        source = json.loads(source_path.read_text(encoding="utf-8"))
        self.assertEqual(
            source["apps"][1]["appPermissions"]["privacy"]["NSCameraUsageDescription"],
            "Camera access for profile photos",
        )
        self.assertNotIn("appPermissions", source["apps"][0])

    def test_check_reports_drift_without_modifying_source(self) -> None:
        source_path = self.write_source(
            {
                "apps": [
                    {
                        "bundleIdentifier": BUNDLE_ID,
                        "appPermissions": {
                            "entitlements": ["existing.entitlement"],
                            "privacy": {},
                        },
                    }
                ]
            }
        )
        before = source_path.read_bytes()

        result = self.run_cli("--source", str(source_path), "--check")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("out of sync", result.stderr)
        self.assertEqual(source_path.read_bytes(), before)

    def test_no_entitlements_preserves_existing_values(self) -> None:
        source_path = self.write_source(
            {
                "app": {
                    "bundleIdentifier": BUNDLE_ID,
                    "appPermissions": {"entitlements": ["keep.me"], "privacy": {}},
                }
            }
        )

        result = self.run_cli("--source", str(source_path), "--no-entitlements")

        self.assertEqual(result.returncode, 0, result.stderr)
        source = json.loads(source_path.read_text(encoding="utf-8"))
        self.assertEqual(
            source["app"]["appPermissions"]["entitlements"], ["keep.me"]
        )

    def test_extension_entitlements_are_merged_and_main_bundle_is_selected(self) -> None:
        with zipfile.ZipFile(self.ipa, "a") as archive:
            archive.writestr("Payload/Example.app/PlugIns/Share.appex/Info.plist",
                             plistlib.dumps({"CFBundleIdentifier": BUNDLE_ID + ".share",
                                             "CFBundleExecutable": "Share"}))
            archive.writestr("Payload/Example.app/PlugIns/Share.appex/Share",
                             signed_executable({"extension.only": True,
                                                **SIGNING_ENTITLEMENTS}))
        source = self.write_source({"apps": [
            {"bundleIdentifier": BUNDLE_ID + ".share"},
            {"bundleIdentifier": BUNDLE_ID}]})
        result = self.run_cli("--source", str(source))
        self.assertEqual(result.returncode, 0, result.stderr)
        apps = json.loads(source.read_text())["apps"]
        self.assertNotIn("appPermissions", apps[0])
        self.assertEqual(apps[1]["appPermissions"]["entitlements"], [
            "com.apple.developer.associated-domains",
            "com.apple.developer.networking.networkextension", "extension.only"])
        self.assertEqual(self.run_cli("--source", str(source), "--check").returncode, 0)

    def test_macho_variants_and_unsigned_binary(self) -> None:
        for endian in ("<", ">"):
            for wide in (False, True):
                with self.subTest(endian=endian, wide=wide):
                    executable = signed_executable(DECLARED_ENTITLEMENTS,
                                                   endian=endian, wide=wide)
                    self.rewrite_executable(executable)
                    result = self.run_cli("--print-app-permissions")
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(len(json.loads(result.stdout)["entitlements"]), 2)
        self.rewrite_executable(struct.pack("<8I", 0xFEEDFACF, 0, 0, 2, 0, 0, 0, 0))
        result = self.run_cli("--print-app-permissions")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["entitlements"], [])

    def rewrite_executable(self, executable: bytes) -> None:
        with zipfile.ZipFile(self.ipa, "w") as archive:
            archive.writestr("Payload/Example.app/Info.plist", plistlib.dumps(INFO))
            archive.writestr("Payload/Example.app/Example", executable)

    def test_fat_binary_and_truncated_signature(self) -> None:
        executable = signed_executable(DECLARED_ENTITLEMENTS)
        fat = (struct.pack(">II", 0xCAFEBABE, 1)
               + struct.pack(">5I", 0, 0, 28, len(executable), 0) + executable)
        self.rewrite_executable(fat)
        result = self.run_cli("--print-app-permissions")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)["entitlements"]), 2)
        self.rewrite_executable(executable[:-1])
        result = self.run_cli("--print-app-permissions")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("truncated", result.stderr)

    def test_rejects_invalid_ipa_and_missing_bundle_id(self) -> None:
        self.ipa.write_bytes(b"not a zip archive")
        invalid_ipa = self.run_cli("--print-app-permissions")
        self.assertNotEqual(invalid_ipa.returncode, 0)
        self.assertIn("invalid IPA", invalid_ipa.stderr)

        with zipfile.ZipFile(self.ipa, "w") as archive:
            info = {**INFO}
            del info["CFBundleIdentifier"]
            archive.writestr(
                "Payload/Example.app/Info.plist",
                plistlib.dumps(info, fmt=plistlib.FMT_XML),
            )
            archive.writestr("Payload/Example.app/Example", b"executable")

        missing_bundle_id = self.run_cli("--print-app-permissions")
        self.assertNotEqual(missing_bundle_id.returncode, 0)
        self.assertIn("missing CFBundleIdentifier", missing_bundle_id.stderr)

    def test_rejects_invalid_source_json(self) -> None:
        source_path = self.root / "source.json"
        source_path.write_text("{", encoding="utf-8")

        result = self.run_cli("--source", str(source_path))

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid source JSON", result.stderr)


if __name__ == "__main__":
    unittest.main()
