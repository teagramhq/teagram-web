#!/usr/bin/env bash
set -Eeuo pipefail

SHA=${DEPLOY_SHA:-}
ROOT=/opt/telegram-web
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'DEPLOY_SHA must be a full 40-hex commit SHA' >&2; exit 1; }

script=$(mktemp)
trap 'rm -f -- "$script"' EXIT
git -C "$ROOT" show "$SHA:deploy/teagram-web/deploy-main.sh" >"$script"
bash "$script" "$@"
