#!/usr/bin/env python3

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


IMAGE_PATTERN = re.compile(r"ghcr\.io/teagramhq/teagram-web@sha256:([0-9a-f]{64})")
ARTIFACT_DIGEST_PATTERN = re.compile(r"sha256:[0-9a-f]{64}")
SOURCE_COMMIT_PATTERN = re.compile(r"[0-9a-f]{40}")
PLACEHOLDER_PATTERN = re.compile(
    r"(?m)^([ \t]*-[ \t]+image:\s*)ghcr\.io/teagramhq/teagram-web@sha256:0{64}\s*$"
)


def fail(message):
    raise SystemExit(message)


def main():
    parser = argparse.ArgumentParser(
        description="Render the production web overlay with its reviewed image pin."
    )
    parser.add_argument("--pin", required=True, type=Path)
    parser.add_argument("--source-commit", required=True)
    args = parser.parse_args()

    if not SOURCE_COMMIT_PATTERN.fullmatch(args.source_commit):
        fail("source commit must be a full 40-character SHA")

    try:
        pin = json.loads(args.pin.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read image pin: {error}")

    if not isinstance(pin, dict) or set(pin) != {"image", "sourceCommit", "artifactDigest"}:
        fail("image pin must contain exactly image, sourceCommit, and artifactDigest")
    if pin["sourceCommit"] != args.source_commit:
        fail("image pin source commit does not match the requested source commit")
    if not isinstance(pin["artifactDigest"], str) or not ARTIFACT_DIGEST_PATTERN.fullmatch(pin["artifactDigest"]):
        fail("image pin artifact digest is invalid")
    if not isinstance(pin["image"], str):
        fail("image pin reference is invalid")

    image_match = IMAGE_PATTERN.fullmatch(pin["image"])
    if not image_match or set(image_match.group(1)) == {"0"}:
        fail("image pin must be a non-placeholder teagram-web registry digest")

    repository_root = Path(__file__).resolve().parents[2]
    overlay = repository_root / "deploy/k8s/overlays/prod"
    rendered = subprocess.run(
        ["kubectl", "kustomize", str(overlay)],
        check=False,
        capture_output=True,
        text=True,
    )
    if rendered.returncode != 0:
        sys.stderr.write(rendered.stderr)
        fail("kubectl kustomize failed for the production overlay")

    manifest, replacements = PLACEHOLDER_PATTERN.subn(
        lambda match: f"{match.group(1)}{pin['image']}", rendered.stdout
    )
    if replacements != 1:
        fail(f"expected one production image placeholder, found {replacements}")

    sys.stdout.write(manifest)


if __name__ == "__main__":
    main()
