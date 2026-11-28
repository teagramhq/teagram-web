# Teagram Web image

The Dockerfile builds the audited web artifact into the static Nginx image
published as `ghcr.io/teagramhq/teagram-web`. The `Deploy.` workflow uses the
image pin produced by a successful `master` publication and checks its source
commit and artifact digest before rendering the production overlay in
`deploy/k8s/`. The Pages job pulls that same pinned image, re-verifies its web
root, and copies its files without rebuilding them. It adds a byte-for-byte
`404.html` copy of `index.html` and
`/.well-known/teagram-web/source-commit.txt`. It excludes the retired
`/.well-known/teagram-web/version.txt` and
`/.well-known/telegram-web/version.txt` paths, and rejects static `healthz` or
`/invite` routes. The job preserves the other hidden `.well-known` files,
prints the image file list and hash, and verifies the published subset against
that hash before upload.

The production job retains its existing deployment identity checks, server-side
dry run, rollback, and readiness checks. With `WEB_ORIGIN` unset or set to
`k3s`, it checks that `https://web.teagram.io/` serves the selected source
commit and artifact manifest. When `WEB_ORIGIN=pages`, it still updates the
fallback deployment and checks it through its own local service route. The
Pages job checks the Pages origin in both modes and fails unless its version
file serves the selected source commit and both retired version paths return
404. The `github-pages` environment must
allow only `master`, and the Pages site must use Actions publishing and the
configured custom domain before any Pages artifact is uploaded.

A failed rollout or smoke check runs:

```sh
kubectl rollout undo deployment/teagram-web --namespace teagram --to-revision="$PREVIOUS_REVISION"
```

Use the revision captured before apply. The rollback must complete and restore
the previous image or the deploy job fails. A successful run logs exactly one
`rollout=verified sha=<sha>` line: the k3s verification in `k3s` mode or the
Pages verification in `pages` mode. The other origin logs
`pages=verified sha=<sha>` or `fallback=verified sha=<sha>`. Set `WEB_ORIGIN` to
`pages` to switch the primary origin; unset it or set it to `k3s` to revert.
The workflow can be dispatched from `master` to redeploy the latest successful
publication.

`deploy/k8s/README.md` documents the overlays and the throwaway k3s deployment
test. CI uses the production k3s version and disable flags, and injects an
unavailable image to prove the automatic rollback before the change can merge.

The legacy `compose.yaml` and `deploy-main.sh` remain for the stopped LXC's
rollback window. The current `Deploy.` workflow does not use them.
