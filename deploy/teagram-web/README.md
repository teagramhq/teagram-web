## Teagram Web loopback stack

This is the deployment-only Compose project for the Teagram Web K static
artifact. It is intentionally separate from the development Compose file at
the repository root and from `/opt/teagram`. Its explicit
`teagram-web-edge` project, `teagram-web-edge-net` network, and
`teagram-web-edge-nginx-cache` volume names keep a root-directory Compose
invocation from selecting this stack by basename. The web service also joins
the existing `telegram-web-edge-net` network until MAIN-1980 removes that
compatibility attachment.

The target checkout is `/opt/telegram-web`. Run the commands below from this
directory:

```sh
cd /opt/telegram-web/deploy/teagram-web
docker compose up -d --build
docker compose ps
```

## Deploys

Successful push runs of `Private MTProto Artifact Publication` trigger the
`Deploy.` workflow. It resolves the tested commit, downloads that run's
`private-mtproto-<commit>-<digest>` artifact, packages it for the host, and
sends it over the tailnet to the forced-command deploy key. The host runs that
commit's `deploy/teagram-web/deploy-main.sh`; the workflow does not check out
or execute repository code itself. A compatibility launcher remains at the
previous script entry point used by the installed forced command.

To redeploy manually, run `Deploy.` from the GitHub Actions tab. It takes no
inputs and selects the newest successful push publication on `master`.

## Threat model

Automatic deployment accepts only a completed, successful `Private MTProto
Artifact Publication` run for a push to `master`. Pull request artifact runs do
not satisfy the deploy job condition. Manual dispatch selects the newest
successful `master` publication, and both the job condition and production
environment branch policy restrict dispatch runs to `master`.

The workflow downloads the artifact from the selected publication run ID and
requires its name and manifest to match the selected commit and SHA-256 digest.
This prevents run mix-ups; the host verifier recomputes the bundle digest to
detect corruption. The artifact name and manifest are not a signature. The
runner packages artifact data but executes none of it. On the host, the
verifier from the selected commit also checks the reviewed target, CSP, audited
routes, and sign-in marker before activation. The trust root is GitHub Actions
and the reviewed `master` source and publication workflow. A compromised
publisher run or an authorized malicious commit can still produce harmful
browser code.

Only the `deploy` job uses the `production` environment and its workflow token
has read-only `contents` and `actions` permissions. Keep `TS_OAUTH_CLIENT_ID`,
`TS_OAUTH_SECRET`, and `DEPLOY_SSH_KEY` as production-environment secrets, with
`DEPLOY_KNOWN_HOSTS` as an environment variable. The Tailscale identity must be
limited to `tag:ci-deploy`, and tailnet ACLs must permit SSH to the deploy LXC
only. The runner writes the key with restrictive permissions, checks the host
against the pinned known-hosts value, and removes the temporary key in an
always-run cleanup step.

The SSH key grants a root operation, so the host's dedicated `authorized_keys`
entry must use `restrict`, the Tailscale source range, and the fixed
`/usr/local/sbin/teagram-web-deploy` forced command. That handler must accept
only a 40-hex commit and a size-limited ZIP on stdin, verify the commit is an
ancestor of `master`, and execute only that commit's deploy script. It must not
offer a shell, PTY, or forwarding. A forced-command bypass would grant root on
the host. These host-side controls are prerequisites and are not installed by
this PR.

GitHub's production environment policy permits `master`. The `master` branch
also requires the `Build, typecheck, lint and test`, `docker`, `compose`, and
`pr-title` checks, including for administrators, and blocks force pushes and
deletion. GitHub cannot require PR approvals here because every seat uses the
same account, so review remains gated in Multica. Repository administrators,
the publisher workflow, production secrets, and the runner remain trusted parts
of the deployment chain.

The host script verifies the artifact manifest and content digest using the
Dockerfile's `artifact-verification` stage before changing the live checkout.
It keeps the prior artifact and a `rollback.sh` under
`/opt/telegram-web/backups/`, checks `/`, `/healthz`, and the served artifact
manifest after Compose starts, and runs the rollback script if deployment
fails. The first deploy under the renamed project builds the image before it
stops and removes the old web container, preserving the old external network
for link-edge. Rollback stops the new web container, restores the saved image
and artifact, then starts the previous Compose project. The release record is
written root-owned and read-only under
`/root/teagram-web-<commit>-<timestamp>/release-record.json`.

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
allocation, leaving the box's CPU and memory for Postgres and `teagramd`; the
nested Docker cgroup exposes no controllers, so this Compose service
deliberately requests no per-container memory, CPU, or PID limit. Nginx logs go
to the container log with Docker's 10 MiB, three-file rotation.

The Nginx response CSP remains `connect-src 'self'`. The verified private
artifact also carries its audited target metadata and CSP; this change leaves
the existing Nginx policy and serving layout intact.

The only persistent volume is `teagram-web-edge-nginx-cache`, owned by this Compose
project. `docker compose down` is safe and leaves that cache intact; never use
`docker compose down -v` on this host. The web build emits the version file at
`/.well-known/teagram-web/version.txt` and keeps
`/.well-known/telegram-web/version.txt` as a compatibility alias until
MAIN-1980.

Each deployment records a private `rollback.sh` in the printed backup
directory and invokes it automatically on failure. To restore manually, run
`bash <printed-backup-directory>/rollback.sh`. Verify success with `docker compose ps`,
`curl -fsS http://127.0.0.1:8080/healthz`, and a tailnet browser loading the
SPA through the existing HTTPS Serve route.
