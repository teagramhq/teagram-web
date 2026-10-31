#!/usr/bin/env python3
"""Tests for the OSV-Scanner severity gate."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


SCRIPT = Path(__file__).with_name("check_osv_report.py")


def vulnerability(identifier: str, score: str, fixed: str | None) -> dict[str, Any]:
    events = [{"introduced": "0"}]
    if fixed is not None:
        events.append({"fixed": fixed})
    return {
        "id": identifier,
        "severity": [{"type": "CVSS_V3", "score": score}],
        "affected": [{"ranges": [{"type": "ECOSYSTEM", "events": events}]}],
    }


def report(*vulnerabilities: dict[str, Any]) -> dict[str, Any]:
    return {
        "results": [
            {
                "source": {"path": "/src/pnpm-lock.yaml", "type": "lockfile"},
                "packages": [
                    {
                        "package": {"name": "example-package", "version": "1.0.0", "ecosystem": "npm"},
                        "vulnerabilities": list(vulnerabilities),
                    }
                ],
            }
        ]
    }


class CheckOSVReportTest(unittest.TestCase):
    def run_checker(self, report_data: Any) -> tuple[subprocess.CompletedProcess[str], str]:
        with tempfile.TemporaryDirectory() as directory:
            report_path = Path(directory) / "report.json"
            summary_path = Path(directory) / "summary.md"
            report_path.write_text(json.dumps(report_data), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(report_path), "--summary-file", str(summary_path)],
                check=False,
                capture_output=True,
                text=True,
            )
            summary = summary_path.read_text(encoding="utf-8") if summary_path.exists() else ""
            return result, summary

    def test_fixed_high_finding_fails(self) -> None:
        result, summary = self.run_checker(
            report(
                vulnerability(
                    "GHSA-fixed-high",
                    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
                    "1.0.1",
                )
            )
        )

        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("GHSA-fixed-high", result.stderr)
        self.assertIn("Fixed high or critical findings", summary)

    def test_high_finding_without_fix_is_summarized_without_failing(self) -> None:
        result, summary = self.run_checker(
            report(
                vulnerability(
                    "GHSA-no-fix-high",
                    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
                    None,
                )
            )
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("GHSA-no-fix-high", summary)
        self.assertIn("Findings without a published fix", summary)
        self.assertIn("No fixed high or critical vulnerabilities", summary)

    def test_fixed_low_finding_does_not_fail(self) -> None:
        result, summary = self.run_checker(
            report(
                vulnerability(
                    "GHSA-fixed-low",
                    "CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:N/A:L",
                    "1.0.1",
                )
            )
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("GHSA-fixed-low", summary)

    def test_invalid_report_fails_closed(self) -> None:
        result, _ = self.run_checker({"results": None})

        self.assertEqual(result.returncode, 1)
        self.assertIn("missing a results array", result.stderr)


if __name__ == "__main__":
    unittest.main()
