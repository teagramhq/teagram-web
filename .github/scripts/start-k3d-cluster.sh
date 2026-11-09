#!/usr/bin/env bash
set -euo pipefail

: "${K3D_CLUSTER:?K3D_CLUSTER must be set}"
: "${K3S_IMAGE:?K3S_IMAGE must be set}"

"$(go env GOPATH)/bin/k3d" cluster create "$K3D_CLUSTER" \
  --servers 1 \
  --agents 0 \
  --wait \
  --image "$K3S_IMAGE" \
  --k3s-arg '--disable=traefik,servicelb,metrics-server@server:*'
kubectl config use-context "k3d-$K3D_CLUSTER"
kubectl wait --for=condition=Ready node --all --timeout=120s
