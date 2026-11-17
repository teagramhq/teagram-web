#!/usr/bin/env bash
set -euo pipefail

expected_identity='system:serviceaccount:teagram:teagram-web-deployer'

if ! actual_identity="$(kubectl auth whoami -o 'jsonpath={.status.userInfo.username}')"; then
  echo '::error::kubectl auth whoami failed; expected system:serviceaccount:teagram:teagram-web-deployer'
  exit 1
fi
if [[ "$actual_identity" != "$expected_identity" ]]; then
  printf '::error::kubectl auth whoami returned %q; expected %s\n' "$actual_identity" "$expected_identity"
  exit 1
fi

secret_access="$(kubectl auth can-i get secrets -n teagram || true)"
if [[ "$secret_access" != no ]]; then
  echo '::error::kubectl auth can-i get secrets -n teagram failed; expected no'
  exit 1
fi

pod_access="$(kubectl auth can-i create pods -n teagram || true)"
if [[ "$pod_access" != no ]]; then
  echo '::error::kubectl auth can-i create pods -n teagram failed; expected no'
  exit 1
fi
