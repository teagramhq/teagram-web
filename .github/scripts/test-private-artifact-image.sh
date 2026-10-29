#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_COMMIT:?SOURCE_COMMIT must be set}"
: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"

image_ref="${IMAGE_REF:-teagram-web:private-artifact-check}"
image_contents="$RUNNER_TEMP/teagram-web-image-content"
publisher_snapshot="$RUNNER_TEMP/private-image-publisher-snapshot"
artifact_digest="$(jq -er '.artifactDigest | select(test("^sha256:[0-9a-f]{64}$"))' dist-private/mtproto-target.json)"
artifact_digest_hex="${artifact_digest#sha256:}"

node --input-type=module <<'NODE'
import {snapshotReviewedPrivateTarget} from './scripts/private-artifact-release.mjs';

snapshotReviewedPrivateTarget({
  sourceRef: 'refs/heads/master',
  sourceCommit: process.env.SOURCE_COMMIT,
  reviewedWorkflowCommit: process.env.SOURCE_COMMIT,
  outputDirectory: `${process.env.RUNNER_TEMP}/private-image-publisher-snapshot`
});
NODE

docker build \
  --platform linux/amd64 \
  --file deploy/teagram-web/Dockerfile \
  --build-arg PRIVATE_ARTIFACT_COMMIT="$SOURCE_COMMIT" \
  --label "org.opencontainers.image.source=https://github.com/teagramhq/teagram-web" \
  --label "org.opencontainers.image.revision=$SOURCE_COMMIT" \
  --label "com.teagram.private-artifact.digest=$artifact_digest" \
  --tag "$image_ref" \
  .

container_id="$(docker create "$image_ref")"
trap 'docker rm "$container_id" >/dev/null' EXIT
mkdir -p "$image_contents"
docker cp "$container_id:/usr/share/nginx/html/." "$image_contents/"
node "$publisher_snapshot/publisher-verify.mjs" \
  --dist "$image_contents" \
  --snapshot "$publisher_snapshot" \
  --ref refs/heads/master \
  --commit "$SOURCE_COMMIT" \
  --digest "$artifact_digest_hex"
