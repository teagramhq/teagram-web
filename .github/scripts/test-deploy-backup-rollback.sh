#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
deploy_script="$repo_root/deploy/teagram-web/deploy-main.sh"
dockerfile="$repo_root/deploy/teagram-web/Dockerfile"
compatibility_launcher="$repo_root/deploy/telegram-web/deploy-main.sh"

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

grep -Fq 'mkdir -m 700 "$BACKUP_DIR"' "$deploy_script" ||
  fail 'backup directory must remain private'
grep -Fq 'cp -a "$ROOT/dist-private" "$BACKUP_DIR/dist-private"' "$deploy_script" ||
  fail 'deployment must preserve artifact modes in the backup'
grep -Fq 'cp -a "$BACKUP_DIR/dist-private" "$ROOT/dist-private"' "$deploy_script" ||
  fail 'rollback must restore the backed-up artifact with preserved modes'
grep -Fq 'PRIVATE_ARTIFACT_COMMIT="$SHA" docker compose ps' "$deploy_script" ||
  fail 'failure diagnostics must pass the attempted commit to docker compose ps'
grep -Fq 'PRIVATE_ARTIFACT_COMMIT="$SHA" docker compose logs --tail=50 web' "$deploy_script" ||
  fail 'failure diagnostics must pass the attempted commit to docker compose logs'
grep -Fq 'git -C "$ROOT" show "$SHA:deploy/teagram-web/deploy-main.sh"' "$compatibility_launcher" ||
  fail 'the existing forced-command entry point must dispatch the selected commit'
grep -Fq 'docker compose stop --timeout 60 web' "$deploy_script" ||
  fail 'rollback must stop the renamed project before restoring the previous stack'
grep -Fq 'docker compose rm --force web' "$deploy_script" ||
  fail 'rollback must remove the renamed project container before restoring the previous stack'
grep -Fq 'docker image tag "$BACKUP_IMAGE" "$PREVIOUS_IMAGE"' "$deploy_script" ||
  fail 'rollback must restore the image tag used by the previous project'
grep -Fq 'if [[ "$CURRENT_PROJECT" != "teagram-web-edge" ]]; then' "$deploy_script" ||
  fail 'the first renamed deployment must remove the old project container'

build_line=$(grep -Fn 'docker compose build' "$deploy_script" | cut -d: -f1)
stop_line=$(grep -Fn 'docker stop --time 60 "${previous_running_containers[@]}"' "$deploy_script" | cut -d: -f1)
remove_line=$(grep -Fn 'docker rm "${previous_containers[@]}"' "$deploy_script" | cut -d: -f1)
up_line=$(grep -Fn 'docker compose up --detach --no-build' "$deploy_script" | tail -n 1 | cut -d: -f1)
[[ -n "$build_line" && -n "$stop_line" && -n "$remove_line" && -n "$up_line" ]] || fail 'deployment must build, stop and start the renamed stack'
(( build_line < stop_line && stop_line < remove_line && remove_line < up_line )) ||
  fail 'the new image must build before the old container stops and is removed, then start the new project'
grep -Fq 'COPY --from=artifact-verification /workspace/dist-private/ /usr/share/nginx/html/' "$dockerfile" ||
  fail 'serving image must copy the restored artifact into the Nginx document root'
if grep -Eq 'chmod[^#]*"\$BACKUP_DIR/dist-private"' "$deploy_script"; then
  fail 'do not change artifact permissions inside the private backup directory'
fi

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
live="$tmp/live"
backup_root="$tmp/backups"
backup_dir="$backup_root/pre-release"
image_root="$tmp/image/usr/share/nginx/html"

mkdir -p "$live" "$image_root"
mkdir -m 755 "$live/dist-private"
printf 'old release\n' >"$live/dist-private/index.html"
mkdir -m 755 "$live/dist-private/assets"
printf 'old asset\n' >"$live/dist-private/assets/app.js"
chmod 644 "$live/dist-private/index.html" "$live/dist-private/assets/app.js"

mkdir -m 700 "$backup_root"
mkdir -m 700 "$backup_dir"
cp -a "$live/dist-private" "$backup_dir/dist-private"

# Simulate a failed rollout, then the rollback copy and Dockerfile COPY rebuild.
rm -rf -- "$live/dist-private"
mkdir -m 755 "$live/dist-private"
printf 'failed release\n' >"$live/dist-private/index.html"
chmod 644 "$live/dist-private/index.html"
rm -rf -- "$live/dist-private"
cp -a "$backup_dir/dist-private" "$live/dist-private"
cp -a "$live/dist-private/." "$image_root/"

[[ "$(cat "$image_root/index.html")" == 'old release' ]] || fail 'rollback did not restore the previous release'

while IFS= read -r -d '' path; do
  mode="$(stat -c '%a' "$path")"
  bits=$((8#$mode))
  if [[ -d "$path" ]]; then
    (( bits & 0001 )) || fail "Nginx cannot traverse restored directory: $path ($mode)"
  else
    (( bits & 0004 )) || fail "Nginx cannot read restored asset: $path ($mode)"
  fi
done < <(find "$image_root" -mindepth 1 -print0)

printf 'rollback rebuild preserves Nginx-readable artifact modes\n'
