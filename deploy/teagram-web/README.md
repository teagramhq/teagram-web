# Teagram Web image

The Dockerfile builds the audited private web artifact into the static Nginx
image published as `ghcr.io/teagramhq/teagram-web`. The `Deploy.` workflow uses
the image pin artifact produced with a successful `Private MTProto Artifact
Publication` run on `master`; it checks the pin's source commit and artifact
digest before rendering the production overlay in `deploy/k8s/`.

The production workflow connects to the k3s API through Tailscale and the
`KUBECONFIG` secret in the `production` environment. It verifies that the k3s
Cloudflare connector has exactly one ready pod, runs a server-side dry run,
applies the manifests, waits for the web rollout, and checks that
`https://web.teagram.io/` serves the matching source commit and artifact
manifest. A failed rollout or smoke check runs:

```sh
kubectl rollout undo deployment/teagram-web --namespace teagram --to-revision="$PREVIOUS_REVISION"
```

Use the revision captured before apply. The rollback must complete and restore
the previous image or the deploy job fails. Successful deployments log
`rollout=verified sha=<sha>`. The workflow
can be dispatched from `master` to redeploy the latest successful publication.

`deploy/k8s/README.md` documents the overlays and the throwaway k3s deployment
test. CI uses the production k3s version and disable flags, and injects an
unavailable image to prove the automatic rollback before the change can merge.

The legacy `compose.yaml` and `deploy-main.sh` remain for the stopped LXC's
rollback window. The current `Deploy.` workflow does not use them.
