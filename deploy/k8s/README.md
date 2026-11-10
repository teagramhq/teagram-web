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

The CI cluster uses the pinned k3s `v1.37.1+k3s1` image with Traefik,
ServiceLB, and metrics-server disabled, matching production.

The service listens on port 80 and forwards to the container's unprivileged
Nginx port 8080. `/healthz` is used for Kubernetes probes; the CI smoke check
also fetches `/` and the JavaScript app bundle.

## Production deployment

`Deploy.` follows successful image publications from `master`. It selects the
matching `teagram-web-image-pin-<source-commit>-<image-digest>` artifact,
refreshes that selection after taking the serialized deployment slot, and
checks its source commit and private-artifact digest before rendering the
production overlay. Only the published source commit is checked out.

The production job joins the tailnet, uses the `KUBECONFIG` secret from the
`k3s-prod` GitHub environment, restricted to deployment branch `master`, and
confirms that exactly one k3s Cloudflare connector pod is ready. It runs
`kubectl apply --dry-run=server`, applies the
rendered overlay, waits for the Deployment, then checks the public web route's
root, JavaScript bundle, and `mtproto-target.json` source identity. If apply,
rollout, or smoke verification fails after changes begin, it runs
`kubectl rollout undo deployment/teagram-web --namespace teagram --to-revision="$PREVIOUS_REVISION"`,
waits for that rollout, and verifies the previous image is restored. A successful run logs
`rollout=verified sha=<source-commit>`.

The `test: k8s-deploy` job runs the same deployment script in a throwaway k3s
cluster. It first deploys and smokes the reviewed image, then substitutes an
unavailable image and requires the script to restore the prior ReplicaSet and
image. The test cluster uses the production k3s image and disable flags.
