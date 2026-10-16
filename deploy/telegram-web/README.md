## Telegram Web loopback stack

This is the deployment-only Compose project for the Telegram Web K static
artifact. It is intentionally separate from the development Compose file at
the repository root and from `/opt/telegram-server`. Its explicit
`telegram-web-edge` project, `telegram-web-edge-net` network, and
`telegram-web-edge-nginx-cache` volume names keep a root-directory Compose
invocation from selecting this stack by basename.

The target checkout is `/opt/telegram-web`. Run the commands below from this
directory:

```sh
cd /opt/telegram-web/deploy/telegram-web
docker compose up -d --build
docker compose ps
```

## Deploys

Successful push runs of `Private MTProto Artifact Publication` trigger the
`Deploy.` workflow. It resolves the tested commit, downloads that run's
`private-mtproto-<commit>-<digest>` artifact, packages it for the host, and
sends it over the tailnet to the forced-command deploy key. The host runs that
commit's `deploy/telegram-web/deploy-main.sh`; the workflow does not check out
or execute repository code itself.

To redeploy manually, run `Deploy.` from the GitHub Actions tab. It takes no
inputs and selects the newest successful push publication on `master`.

The host script verifies the artifact manifest and content digest using the
Dockerfile's `artifact-verification` stage before changing the live checkout.
It keeps the prior artifact and a `rollback.sh` under
`/opt/telegram-web/backups/`, checks `/`, `/healthz`, and the served artifact
manifest after Compose starts, and runs the rollback script if deployment
fails. The release record is written root-owned and read-only under
`/root/telegram-web-<commit>-<timestamp>/release-record.json`.

The SPA listens on `127.0.0.1:8080` for host-local proxies such as Serve. Keep
this port loopback-only; the existing HTTPS Serve route remains the external
entry point, and the Web container must not create direct tailnet ingress.

The Compose network is not marked `internal`, because Docker must publish this
host-side listener. The loopback host binding is the ingress boundary; the
browser's `connect-src 'self'` CSP is the separate egress boundary below.

The image consumes the CI-published private artifact staged at
`/opt/telegram-web/dist-private`. Set `PRIVATE_ARTIFACT_COMMIT` to the artifact's
40-character source commit before building. Docker verifies the manifest,
artifact digest, reviewed endpoint and RSA fingerprint, attested key hash, CSP,
and username sign-in marker before copying the bundle into the final image.
The verification stage uses Node; the Nginx serving image does not contain a
Node runtime. Keep the artifact's source commit and digest from the successful
Private MTProto Artifact Publication run together when staging it.

Resource isolation is provided by the target LXC's existing 2 vCPU and 4 GiB
allocation, leaving the box's CPU and memory for Postgres and `telegramd`; the
nested Docker cgroup exposes no controllers, so this Compose service
deliberately requests no per-container memory, CPU, or PID limit. Nginx logs go
to the container log with Docker's 10 MiB, three-file rotation.

The Nginx response CSP remains `connect-src 'self'`. The verified private
artifact also carries its audited target metadata and CSP; this change leaves
the existing Nginx policy and serving layout intact.

The only persistent volume is `telegram-web-edge-nginx-cache`, owned by this Compose
project. `docker compose down` is safe and leaves that cache intact; never use
`docker compose down -v` on this host.

Rollback is the code revert followed by `docker compose up -d --build` from this
directory. Verify success with `docker compose ps`,
`curl -fsS http://127.0.0.1:8080/healthz`, and a tailnet browser loading the
SPA through the existing HTTPS Serve route.
