import json
import plistlib
import subprocess
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
            embedded_entitlements = plistlib.dumps(
                DECLARED_ENTITLEMENTS, fmt=plistlib.FMT_XML
            )
            archive.writestr(
                "Payload/Example.app/Example",
                b"fake Mach-O prefix\x00" + embedded_entitlements + b"\x00suffix",
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
