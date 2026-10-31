# Teagram Web on k3s

The production overlay uses the `teagram` namespace shared with teagram-server.
Its image digest is supplied by the `teagram-web-image-pin` artifact from the
`Private MTProto Artifact Publication` workflow. Render the overlay with
`python3 deploy/k8s/render.py --pin <pin.json> --source-commit <sha>` before
applying it; the committed all-zero digest is only a render-time placeholder
and must never be applied.

The publisher emits `teagram-web-image-pin-<source-commit>-<image-digest>` with
`image`, `sourceCommit`, and `artifactDigest` fields. The recorded image digest
is the registry manifest digest; `artifactDigest` ties it to the reviewed web
bundle.

The `ci` overlay changes only the image reference. `test: k8s-deploy` builds the
audited private artifact with the existing Dockerfile, imports that image into a
throwaway k3s cluster, and applies the same Deployment and Service resources.
The stage 3 production workflow can use the same image pin artifact to render
the prod overlay before its server-side dry-run.

The CI cluster uses k3s `v1.37.0+k3s1` with Traefik, ServiceLB, and
metrics-server disabled, matching the production k3s flags.

The service listens on port 80 and forwards to the container's unprivileged
Nginx port 8080. `/healthz` is used for Kubernetes probes; the CI smoke check
also fetches `/` and the JavaScript app bundle.
