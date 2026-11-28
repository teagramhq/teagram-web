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

The production job validates the CA-pinned `K3S_WEB_KUBECONFIG` secret from the
`k3s-prod` GitHub environment, restricted to deployment branch `master`, and
joins the tailnet as `tag:k3s-deploy` using `K3S_TS_OAUTH_CLIENT_ID` and
`K3S_TS_OAUTH_SECRET`. It requires a successful tailnet ping of
`teagram.tailaa4918.ts.net` and confirms that exactly one k3s Cloudflare
connector pod is ready. It runs
`kubectl apply --dry-run=server`, applies the
rendered overlay, waits for the Deployment, then checks the public web route's
root, JavaScript bundle, and `mtproto-target.json` source identity. If apply,
rollout, or smoke verification fails after changes begin, it runs
`kubectl rollout undo deployment/teagram-web --namespace teagram --to-revision="$PREVIOUS_REVISION"`,
waits for that rollout, and verifies the previous image is restored. If the rollout
fails, it first records the web pods' status, termination metadata, and recent
events without printing pod environment values. A successful run logs
`rollout=verified sha=<source-commit>`.

The `test: k8s-deploy` job runs the same deployment script in a throwaway k3s
cluster. It first deploys and smokes the reviewed image, then substitutes an
unavailable image and requires the script to restore the prior ReplicaSet and
image. The test cluster uses the production k3s image and disable flags.

## Pages failover monitor

The separate `failover` overlay runs the monitor in the `web-failover`
namespace with its own service account. Render it with the same image pin and
`--overlay failover`. The `Deploy.` identity remains unable to read Secrets in
this namespace; the namespace, service account, Role, and RoleBinding are
provisioned through the cutover bootstrap.

Before starting the monitor, provision a `web-failover-config` Secret in that
namespace with keys `zone-id`, `record-id`, `pages-target`, `tunnel-target`,
`pages-ip`, and `initial-target`. These values stay outside the repository. The
`web-failover-token` Secret can contain a `token` key for Cloudflare API access.
The token is mounted at `/run/credentials/cloudflare/token` and never enters an
environment variable. Without the token, the monitor still runs in dry-run mode
and logs its decisions, but cannot validate the DNS record. Enabling writes
without the token fails closed. Its Role grants `get` for only that named
Secret, `get` and `patch` for only its state ConfigMap, permission to create
ConfigMaps in the isolated namespace, and permission to create warning Events.
The monitor creates its runtime state ConfigMap on first use. It is excluded
from the applied overlay so a redeploy preserves the recorded target and hourly
change history.

The deployment starts with `WRITES_ENABLED=false`. It reads and validates the
configured DNS record at startup and before every write. `FAILBACK_ENABLED`
starts false and can be switched independently after the Pages certificate has
been verified. The probe checks `mtproto-target.json` directly at the supplied
Pages IP with SNI and Host `web.teagram.io` and full TLS verification. Logs use
structured `level=alert` entries and Kubernetes Warning Events for a denied
write or exhausted change cap; the metrics Service exposes probe status,
current origin, change count, and the safety lock on port 9090.

If startup reports `pending_state_unsubmitted`, the ConfigMap contains a
transition intent without a persisted PATCH confirmation. After a pod restart,
the monitor keeps writes locked even if the live target matches `from` or `to`,
because it cannot distinguish an interrupted request from an operator edit.
For manual recovery, first disable writes and failback, wait for that rollout,
then scale `web-failover-monitor` to zero. Inspect both the configured Cloudflare
record and the saved journal:

```sh
kubectl scale deployment web-failover-monitor -n web-failover --replicas=0
kubectl get configmap web-failover-state -n web-failover \
  -o jsonpath='{.data.state\.json}' > ./web-failover-state-backup.json
kubectl edit configmap web-failover-state -n web-failover
```

The JSON file backs up only the runtime state. To undo a bad manual edit while
the monitor remains scaled to zero, run `kubectl edit configmap web-failover-state -n web-failover`
again and restore only `data.state.json` from the backup file.
Do not reapply a saved ConfigMap object: its old `metadata.resourceVersion` can
conflict with the current object version.

Edit `data.state.json` only after verifying the record ID, name, type, proxy
setting, and live target. If the record is at `pending.to` and Cloudflare's
change history confirms that transition, set `target` to `pending.to`, add
`pending.at` to `changes` once, preserve every other change from the last hour,
and remove `pending`. If the record is at `pending.from` and the change history
confirms that no transition occurred, preserve `target` and `changes` and remove
`pending`. If the target differs, the ConfigMap data is missing, or the recent
change history cannot be reconstructed, leave writes disabled and restore a
verified state backup or reconstruct the complete hourly ledger before
restarting. After editing, scale the monitor back to one replica while writes
remain disabled:

```sh
kubectl scale deployment web-failover-monitor -n web-failover --replicas=1
```

Confirm the pod is ready and no state-loss or
`pending_state_unsubmitted` alert appears. Then enable writes through the normal
deployment configuration and verify `web_failover_safety_locked` is `0`; if it
is `1`, disable writes and keep investigating.

For a monitor rollback, first set `WRITES_ENABLED=false` and
`FAILBACK_ENABLED=false`, wait for the rollout, then scale
`web-failover-monitor` to zero in `web-failover`. The web deployment and tunnel
route remain available, and the monitor state and Secrets stay in place for
recovery. The production cluster has no preview environment; CI validates the
rendered manifests and RBAC in a throwaway k3s cluster and exercises the
decision logic with a forced failing probe and a simulated ten-minute recovery.
