#!/usr/bin/env python3
"""Fail for fixed high or critical vulnerabilities in an OSV-Scanner report."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, NamedTuple

from cvss import CVSS2, CVSS3, CVSS4


SAFE_ID = re.compile(r"[A-Za-z0-9._-]+")


class Finding(NamedTuple):
    lockfile: str
    package: str
    version: str
    identifier: str
    score: float | None


def cvss_score(vector: str, score_type: str | None) -> float:
    normalized_type = score_type.upper() if isinstance(score_type, str) else ""
    if not normalized_type:
        if vector.startswith("CVSS:4.0/"):
            normalized_type = "CVSS_V4"
        elif vector.startswith(("CVSS:3.0/", "CVSS:3.1/")):
            normalized_type = "CVSS_V3"
        else:
            normalized_type = "CVSS_V2"

    try:
        if normalized_type == "CVSS_V2":
            if vector.startswith("CVSS:2.0/"):
                vector = vector.removeprefix("CVSS:2.0/")
            return CVSS2(vector).scores()[0]
        if normalized_type == "CVSS_V3":
            return CVSS3(vector).scores()[0]
        if normalized_type == "CVSS_V4":
            return CVSS4(vector).scores()[0]
    except Exception:
        # Malformed vectors must not silently bypass the security gate.
        return 10.0

    return 10.0


def severity_score(vulnerability: dict[str, Any]) -> float | None:
    candidates: list[Any] = []
    severity = vulnerability.get("severity", [])
    if isinstance(severity, list):
        candidates.extend(severity)
    elif severity:
        candidates.append(severity)

    database_specific = vulnerability.get("database_specific", {})
    if isinstance(database_specific, dict):
        candidates.append(database_specific.get("severity"))
    for affected in vulnerability.get("affected", []):
        if not isinstance(affected, dict):
            continue
        for key in ("database_specific", "ecosystem_specific"):
            details = affected.get(key, {})
            if isinstance(details, dict):
                candidates.append(details.get("severity"))

    scores: list[float] = []
    for candidate in candidates:
        score_type = None
        if isinstance(candidate, dict):
            score_type = candidate.get("type")
            candidate = candidate.get("score")
        if not isinstance(candidate, (str, int, float)):
            continue
        if isinstance(candidate, str):
            normalized = candidate.strip().upper()
            if normalized == "CRITICAL":
                scores.append(10.0)
                continue
            if normalized == "HIGH":
                scores.append(7.0)
                continue
            if normalized in {"NONE", "LOW", "MEDIUM", "MODERATE"}:
                continue
            try:
                scores.append(float(candidate))
            except ValueError:
                scores.append(cvss_score(candidate, score_type))
        else:
            scores.append(float(candidate))

    return max(scores) if scores else None


def has_fix(vulnerability: dict[str, Any]) -> bool:
    for affected in vulnerability.get("affected", []):
        if not isinstance(affected, dict):
            continue
        for version_range in affected.get("ranges", []):
            if not isinstance(version_range, dict):
                continue
            for event in version_range.get("events", []):
                if isinstance(event, dict) and isinstance(event.get("fixed"), str):
                    if event["fixed"].strip():
                        return True
        for details_key in ("database_specific", "ecosystem_specific"):
            details = affected.get(details_key, {})
            if isinstance(details, dict):
                for key in ("fixed", "fixed_version", "fixedVersion"):
                    value = details.get(key)
                    if isinstance(value, str) and value.strip():
                        return True
    return False


def lockfile_path(result: dict[str, Any]) -> str:
    source = result.get("source", {})
    path = source.get("path") if isinstance(source, dict) else None
    if not isinstance(path, str) or not path:
        return "unknown"
    return path.removeprefix("/src/")


def collect_findings(report: Any) -> tuple[list[Finding], list[Finding]]:
    results = report.get("results") if isinstance(report, dict) else None
    if not isinstance(results, list):
        raise ValueError("OSV-Scanner report is missing a results array")

    failing: set[Finding] = set()
    without_fix: set[Finding] = set()
    for result in results:
        if not isinstance(result, dict):
            raise ValueError("OSV-Scanner report contains an invalid result")
        packages = result.get("packages", [])
        if not isinstance(packages, list):
            raise ValueError("OSV-Scanner result is missing a packages array")
        for package_result in packages:
            if not isinstance(package_result, dict):
                raise ValueError("OSV-Scanner report contains an invalid package")
            package = package_result.get("package", {})
            if not isinstance(package, dict):
                raise ValueError("OSV-Scanner package result is missing package metadata")
            name = package.get("name")
            version = package.get("version")
            vulnerabilities = package_result.get("vulnerabilities", [])
            if not isinstance(name, str) or not name or not isinstance(version, str) or not version:
                raise ValueError("OSV-Scanner package result is missing its name or version")
            if not isinstance(vulnerabilities, list):
                raise ValueError("OSV-Scanner package result has an invalid vulnerabilities array")
            for vulnerability in vulnerabilities:
                if not isinstance(vulnerability, dict):
                    raise ValueError("OSV-Scanner report contains an invalid vulnerability")
                identifier = vulnerability.get("id")
                if not isinstance(identifier, str) or not SAFE_ID.fullmatch(identifier):
                    raise ValueError("OSV-Scanner returned a vulnerability without a safe ID")
                score = severity_score(vulnerability)
                finding = Finding(lockfile_path(result), name, version, identifier, score)
                if has_fix(vulnerability):
                    if score is not None and score >= 7.0:
                        failing.add(finding)
                else:
                    without_fix.add(finding)

    sort_key = lambda finding: (
        finding.lockfile,
        finding.package,
        finding.version,
        finding.identifier,
        finding.score if finding.score is not None else -1.0,
    )
    return sorted(failing, key=sort_key), sorted(without_fix, key=sort_key)


def severity_label(score: float | None) -> str:
    if score is None:
        return "unknown"
    if score >= 9.0:
        return "critical"
    if score >= 7.0:
        return "high"
    if score >= 4.0:
        return "moderate"
    if score > 0:
        return "low"
    return "none"


def markdown_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ").replace("`", "\\`")


def finding_table(findings: list[Finding]) -> list[str]:
    rows = ["| Lockfile | Package | Version | Finding | Severity |", "| --- | --- | --- | --- | --- |"]
    for finding in findings:
        identifier = markdown_cell(finding.identifier)
        rows.append(
            "| {lockfile} | `{package}` | `{version}` | "
            "[{identifier}](https://osv.dev/{identifier}) | {severity} |".format(
                lockfile=markdown_cell(finding.lockfile),
                package=markdown_cell(finding.package),
                version=markdown_cell(finding.version),
                identifier=identifier,
                severity=severity_label(finding.score),
            )
        )
    return rows


def render_summary(failing: list[Finding], without_fix: list[Finding]) -> str:
    lines = ["## OSV Scanner", ""]
    if failing:
        lines.extend(["Fixed high or critical findings:", "", *finding_table(failing), ""])
    else:
        lines.extend(["No fixed high or critical vulnerabilities.", ""])
    if without_fix:
        lines.extend(["Findings without a published fix (informational):", "", *finding_table(without_fix), ""])
    else:
        lines.extend(["No findings without a published fix.", ""])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--summary-file", type=Path)
    args = parser.parse_args()

    try:
        report = json.loads(args.report.read_text(encoding="utf-8"))
        failing, without_fix = collect_findings(report)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"could not check OSV-Scanner report: {error}", file=sys.stderr)
        return 1

    summary = render_summary(failing, without_fix)
    summary_file = args.summary_file or (Path(os.environ["GITHUB_STEP_SUMMARY"]) if os.environ.get("GITHUB_STEP_SUMMARY") else None)
    if summary_file:
        try:
            with summary_file.open("a", encoding="utf-8") as output:
                output.write(summary)
        except OSError as error:
            print(f"could not write OSV-Scanner job summary: {error}", file=sys.stderr)
            return 1
    if without_fix:
        print(f"OSV-Scanner found {len(without_fix)} findings without a published fix; see the job summary")
    if failing:
        print("OSV-Scanner found fixed high or critical vulnerabilities:", file=sys.stderr)
        for finding in failing:
            print(
                f"- {finding.lockfile}: {finding.package}@{finding.version} "
                f"{finding.identifier} ({severity_label(finding.score)})",
                file=sys.stderr,
            )
        return 1
    print("OSV-Scanner found no fixed high or critical vulnerabilities")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
