set -euo pipefail

if [[ ! "${KUBERNETES_VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'KUBERNETES_VERSION must be a pinned semantic version' >&2
  exit 1
fi

kubectl_path="$RUNNER_TEMP/kubectl"
kubectl_url="https://dl.k8s.io/release/v$KUBERNETES_VERSION/bin/linux/amd64/kubectl"
curl --fail --silent --show-error --location "$kubectl_url" --output "$kubectl_path"
expected_sha256="$(curl --fail --silent --show-error --location "$kubectl_url.sha256")"
printf '%s  %s\n' "$expected_sha256" "$kubectl_path" | sha256sum --check
sudo install --mode 0755 "$kubectl_path" /usr/local/bin/kubectl
