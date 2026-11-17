#!/usr/bin/env bash
set -euo pipefail

expected_identity='system:serviceaccount:teagram:teagram-web-deployer'

if ! actual_identity="$(kubectl auth whoami -o 'jsonpath={.status.userInfo.username}')"; then
  echo '::error::kubectl auth whoami failed; expected system:serviceaccount:teagram:teagram-web-deployer'
  exit 1
fi
if [[ "$actual_identity" != "$expected_identity" ]]; then
  echo '::error::kubectl auth whoami failed; expected system:serviceaccount:teagram:teagram-web-deployer'
  exit 1
fi

if ! secret_access="$(kubectl auth can-i get secrets -n teagram)"; then
  echo '::error::kubectl auth can-i get secrets -n teagram failed; expected no'
  exit 1
fi
if [[ "$secret_access" != no ]]; then
  echo '::error::kubectl auth can-i get secrets -n teagram failed; expected no'
  exit 1
fi

if ! pod_access="$(kubectl auth can-i create pods -n teagram)"; then
  echo '::error::kubectl auth can-i create pods -n teagram failed; expected no'
  exit 1
fi
if [[ "$pod_access" != no ]]; then
  echo '::error::kubectl auth can-i create pods -n teagram failed; expected no'
  exit 1
fi
