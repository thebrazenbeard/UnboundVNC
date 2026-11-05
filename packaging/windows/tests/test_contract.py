"""Static boundary tests for an unexecuted Windows staging prototype."""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class StagingContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.install = (ROOT / "Install-AttendedHost.ps1").read_text(encoding="utf-8")
        cls.uninstall = (ROOT / "Uninstall-AttendedHost.ps1").read_text(encoding="utf-8")

    def test_explicit_apply_and_preview(self):
        for script in (self.install, self.uninstall):
            self.assertIn("[switch]$Apply", script)
            self.assertIn("if (-not $Apply)", script)
            self.assertIn("PREVIEW ONLY", script)

    def test_hash_and_license_gate(self):
        self.assertIn("ExpectedSha256", self.install)
        self.assertIn("Get-FileHash", self.install)
        self.assertIn("$LicenseAcknowledged", self.install)
        self.assertIn("Post-copy SHA-256 mismatch", self.install)

    def test_uninstall_receipt_and_allowlist(self):
        for token in ("install-receipt.json", "UnboundVNCAttendedHost.exe", "Get-FileHash", "Get-Process", "Unknown or missing", "Unowned item"):
            self.assertIn(token, self.uninstall)
        self.assertIn("$items.Count -ne 2", self.uninstall)

    def test_no_persistence_or_recursive_cleanup(self):
        for script in (self.install, self.uninstall):
            for forbidden in (r"\bNew-Service\b", r"\bStart-Service\b", r"\bStart-Process\b", r"\bNew-NetFirewallRule\b", r"\bSet-NetFirewallRule\b", r"\bNew-ItemProperty\b", r"\bSet-ItemProperty\b", r"\b-?Recurse\b"):
                self.assertIsNone(re.search(forbidden, script, re.I), forbidden)

    def test_no_binary_committed(self):
        self.assertFalse(any(p.suffix.lower() in {".exe", ".msi", ".dll"} for p in ROOT.rglob("*")))

    def test_windows_runner_source_only_gate(self):
        workflow = (ROOT.parents[1] / '.github/workflows/windows-attended-packaging-contract.yml').read_text(encoding='utf-8')
        self.assertIn('runs-on: windows-latest', workflow)
        self.assertIn('contents: read', workflow)
        self.assertIn('persist-credentials: false', workflow)
        self.assertIn('--self-contained true', workflow)
        self.assertIn('-p:PublishSingleFile=true', workflow)
        self.assertIn('Invoke-WindowsPackagingContract.ps1', workflow)


if __name__ == "__main__":
    unittest.main()
