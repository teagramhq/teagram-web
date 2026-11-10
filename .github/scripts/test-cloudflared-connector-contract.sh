#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deployment_filter="$script_dir/cloudflared-deployment-ready.jq"
pods_filter="$script_dir/cloudflared-pods-ready.jq"

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

ready_deployment='{"spec":{"replicas":1},"status":{"readyReplicas":1,"availableReplicas":1}}'
not_ready_deployment='{"spec":{"replicas":1},"status":{"readyReplicas":0,"availableReplicas":0}}'
zero_pods='{"items":[]}'
one_ready_pod='{"items":[{"status":{"phase":"Running","containerStatuses":[{"ready":true}]}}]}'
two_pods='{"items":[{"status":{"phase":"Running","containerStatuses":[{"ready":true}]}},{"status":{"phase":"Running","containerStatuses":[{"ready":true}]}}]}'
one_not_ready_pod='{"items":[{"status":{"phase":"Running","containerStatuses":[{"ready":false}]}}]}'

jq -e -f "$deployment_filter" <<<"$ready_deployment" >/dev/null ||
  fail 'connector deployment readiness filter rejected one ready replica'
if jq -e -f "$deployment_filter" <<<"$not_ready_deployment" >/dev/null; then
  fail 'connector deployment readiness filter accepted a not-ready replica'
fi

if jq -e -f "$pods_filter" <<<"$zero_pods" >/dev/null; then
  fail 'connector pod filter accepted zero pods'
fi
jq -e -f "$pods_filter" <<<"$one_ready_pod" >/dev/null ||
  fail 'connector pod filter rejected one ready pod'
if jq -e -f "$pods_filter" <<<"$two_pods" >/dev/null; then
  fail 'connector pod filter accepted two pods'
fi
if jq -e -f "$pods_filter" <<<"$one_not_ready_pod" >/dev/null; then
  fail 'connector pod filter accepted a not-ready pod'
fi

printf 'cloudflared connector contract holds\n'
