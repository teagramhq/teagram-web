#!/usr/bin/env bash
# Deploys the pinned web image through a rollback-safe Kubernetes rollout.
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo 'usage: deploy-k8s-web.sh manifest source-commit artifact-digest image smoke-url' >&2
  exit 64
fi

manifest=$1
deploy_sha=$2
artifact_digest=$3
deploy_image=$4
smoke_url=$5
namespace=teagram
deployment=teagram-web
rollout_timeout=${ROLLOUT_TIMEOUT:-180s}
require_single_cloudflared=${REQUIRE_SINGLE_CLOUDFLARED:-false}
deployment_started=false
previous_revision=
previous_image=

fail() {
  printf 'web deploy: %s\n' "$1" >&2
  return 1
}

rollback_failure() {
  local stage="$1" detail="$2"
  printf 'rollout=rollback-failed stage=%s previous_revision=%s detail=%s\n' \
    "$stage" "$previous_revision" "$detail" >&2
  printf 'manual recovery: kubectl rollout undo deployment/%s --namespace %s --to-revision=%s\n' \
    "$deployment" "$namespace" "$previous_revision" >&2
  exit 1
}

rollback_on_error() {
  local status="$1"
  trap - ERR INT TERM

  if [[ "$deployment_started" == true ]]; then
    printf 'deploy failed; restoring teagram-web revision %s\n' "$previous_revision" >&2
    if ! kubectl rollout undo "deployment/$deployment" \
      --namespace "$namespace" --to-revision="$previous_revision"; then
      rollback_failure undo 'kubectl rollout undo failed'
    fi
    if ! kubectl rollout status "deployment/$deployment" \
      --namespace "$namespace" --timeout="$rollout_timeout"; then
      rollback_failure status 'the restored revision did not become ready'
    fi

    local restored_image
    if ! restored_image=$(kubectl get "deployment/$deployment" --namespace "$namespace" --output json |
      jq -er '[.spec.template.spec.containers[] | select(.name == "teagram-web") | .image] |
        if length == 1 then .[0] else error("expected one teagram-web container") end'); then
      rollback_failure image-read 'restored deployment image is unreadable'
    fi
    if [[ "$restored_image" != "$previous_image" ]]; then
      rollback_failure image-verify "restored image was $restored_image"
    fi
    printf 'rollout=rollback-verified previous_revision=%s\n' "$previous_revision" >&2
  fi

  exit "$status"
}

trap 'rollback_on_error "$?"' ERR
trap 'rollback_on_error 130' INT
trap 'rollback_on_error 143' TERM

[[ -f "$manifest" && ! -L "$manifest" ]] || fail 'manifest must be a regular file'
[[ "$deploy_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'source commit must be a full 40-character SHA'
[[ "$artifact_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'artifact digest is invalid'
[[ "$deploy_image" =~ ^ghcr\.io/teagramhq/teagram-web(:[A-Za-z0-9_.-]+|@sha256:[0-9a-f]{64})$ ]] ||
  fail 'image reference is invalid'
[[ "$smoke_url" =~ ^https?://[^[:space:]]+$ ]] || fail 'smoke URL is invalid'
[[ "$require_single_cloudflared" == true || "$require_single_cloudflared" == false ]] ||
  fail 'REQUIRE_SINGLE_CLOUDFLARED must be true or false'

for command in kubectl jq node; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is missing: $command"
done

grep --fixed-strings --quiet -- "$deploy_image" "$manifest" ||
  fail 'manifest does not contain the reviewed image pin'

if [[ "$require_single_cloudflared" == true ]]; then
  connector=$(kubectl get deployment/cloudflared --namespace "$namespace" --output json)
  connector_pods=$(kubectl get pods --namespace "$namespace" \
    --selector app.kubernetes.io/name=cloudflared --output json)
  connector_replicas=$(jq -r '.spec.replicas // "unknown"' <<<"$connector" 2>/dev/null || printf unknown)
  connector_ready=$(jq -r '.status.readyReplicas // 0' <<<"$connector" 2>/dev/null || printf unknown)
  connector_available=$(jq -r '.status.availableReplicas // 0' <<<"$connector" 2>/dev/null || printf unknown)
  connector_pod_count=$(jq -r '(.items // []) | length' <<<"$connector_pods" 2>/dev/null || printf unknown)
  if ! jq -e -f .github/scripts/cloudflared-deployment-ready.jq <<<"$connector" >/dev/null ||
    ! jq -e -f .github/scripts/cloudflared-pods-ready.jq <<<"$connector_pods" >/dev/null; then
    fail "expected exactly one ready k3s tunnel connector (replicas=$connector_replicas ready=$connector_ready available=$connector_available pods=$connector_pod_count)"
  fi
fi

kubectl rollout status "deployment/$deployment" --namespace "$namespace" --timeout="$rollout_timeout"
current_deployment=$(kubectl get "deployment/$deployment" --namespace "$namespace" --output json)
previous_revision=$(jq -er '
  .metadata.annotations["deployment.kubernetes.io/revision"] |
  select(type == "string" and test("^[1-9][0-9]*$"))
' <<<"$current_deployment") || fail 'the existing web deployment has no rollback revision'
previous_image=$(jq -er '
  [.spec.template.spec.containers[] | select(.name == "teagram-web") | .image] |
  if length == 1 then .[0] else error("expected one teagram-web container") end
' <<<"$current_deployment") || fail 'the existing web deployment image is unreadable'

kubectl apply --dry-run=server --filename "$manifest"
deployment_started=true
kubectl apply --filename "$manifest"
kubectl rollout status "deployment/$deployment" --namespace "$namespace" --timeout="$rollout_timeout"

deployed_image=$(kubectl get "deployment/$deployment" --namespace "$namespace" --output json |
  jq -er '[.spec.template.spec.containers[] | select(.name == "teagram-web") | .image] |
    if length == 1 then .[0] else error("expected one teagram-web container") end')
[[ "$deployed_image" == "$deploy_image" ]] || fail 'the deployment image does not match the reviewed pin'
node .github/scripts/smoke-k8s-web.mjs "$smoke_url" "$deploy_sha" "$artifact_digest"

trap - ERR INT TERM
printf 'rollout=verified sha=%s\n' "$deploy_sha"
