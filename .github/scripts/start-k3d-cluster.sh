#!/usr/bin/env bash
set -euo pipefail

: "${K3D_CLUSTER:?K3D_CLUSTER must be set}"
: "${KUBERNETES_VERSION:?KUBERNETES_VERSION must be set}"

"$(go env GOPATH)/bin/k3d" cluster create "$K3D_CLUSTER" \
  --servers 1 \
  --agents 0 \
  --wait \
  --image "rancher/k3s:v${KUBERNETES_VERSION}-k3s1" \
  --k3s-arg '--disable=traefik,servicelb,metrics-server@server:*'
kubectl config use-context "k3d-$K3D_CLUSTER"
kubectl wait --for=condition=Ready node --all --timeout=120s
