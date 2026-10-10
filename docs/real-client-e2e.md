# Real client fixture scenarios

`pnpm run test:real-client` consumes a completed `server-ready` and `artifact-ready` pair from one foreground real-server fixture run. It checks the immutable harness, server and web pins, the fixture's protected synthetic credentials, isolation and audit evidence before driving the production UI. It requires all three scenarios: `sign-in,message,group`.

The accepted positive inputs are harness `5f294c39abb32fc8ae15a4f7ccb085974098b320`, server `47daaaea5c71b859d9865c03cabb50da5a1a013b` and web artifact source `c88211e3985942343bf40dcbbcb8e8f5b4b7d364`. The scenario runner revision is recorded separately from the artifact source revision. Each run also has a fresh run ID, RSA public key and endpoint identity. Do not reuse readiness or artifacts from another run.

The native arm64 fixture successor was accepted from server PR #499, merged as `b61fbe1a53348edd0039885fb4a4659e0dc455c0`. The executable harness pin remains the reviewed PR head `5f294c39abb32fc8ae15a4f7ccb085974098b320`; do not substitute the squash merge or moving main. The server-under-test and historical negative pair remain unchanged.

## Run the fixture

From the accepted `teagram-server` checkout, keep the fixture command in the foreground. `READINESS_FILE` must be accessible from the web checkout and should stay outside both repositories and artifact output.

```sh
set -euo pipefail
RUN_ID="$(openssl rand -hex 16)"
READINESS_FILE="$(mktemp /dev/shm/real-client-readiness.XXXXXX)"
chmod 600 "$READINESS_FILE"
printf 'READINESS_FILE=%s\n' "$READINESS_FILE"
test "$(git rev-parse HEAD)" = 5f294c39abb32fc8ae15a4f7ccb085974098b320
test -z "$(git status --porcelain --untracked-files=all)"
bash test/e2e/real_server_fixture/run.sh \
  --server-revision 47daaaea5c71b859d9865c03cabb50da5a1a013b \
  --web-revision c88211e3985942343bf40dcbbcb8e8f5b4b7d364 \
  --run-id "$RUN_ID" | tee "$READINESS_FILE"
```

The fixture prints `server-ready` only after real SRP authentication, worker and direct-TCP probes, and its run isolation checks. Keep the foreground process and its stdin open. Do not pass `TG_*` or `MTPROTO_*` variables to it.

## Build and attach the run's artifact

From a clean web checkout at the exact positive web revision, use only that run's public PEM and endpoint. The key file stays outside the repository, fixture secret/build directories and artifact output. Only the build process receives the private-target environment.

```sh
set -euo pipefail
READINESS_FILE='/dev/shm/real-client-readiness.<path-printed-in-fixture-terminal>'
RUN_ID="$(jq -er 'select(.event == "server-ready") | .runId' "$READINESS_FILE")"
test "$(git rev-parse HEAD)" = c88211e3985942343bf40dcbbcb8e8f5b4b7d364
test -z "$(git status --porcelain --untracked-files=all)"
KEY_FILE="$(mktemp /dev/shm/real-client-public-key.XXXXXX)"
chmod 600 "$KEY_FILE"
jq -er 'select(.event == "server-ready") | .mtprotoPublicKeyPEM' "$READINESS_FILE" > "$KEY_FILE"
ARTIFACT_PARENT="$(mktemp -d)"
ARTIFACT_DIR="$ARTIFACT_PARENT/dist-private"
MTPROTO_TARGET_MODE=private \
MTPROTO_PRIVATE_ENDPOINT=wss://telegramd.test/apiws \
MTPROTO_PRIVATE_RSA_PUBLIC_KEY_FILE="$KEY_FILE" \
  corepack pnpm exec vite build --outDir "$ARTIFACT_DIR"
MTPROTO_TARGET_MODE=private node scripts/check-bundle-mangling.mjs "$ARTIFACT_DIR"
```

Return to the fixture terminal and enter one command with the absolute artifact path:

```text
attach /absolute/path/to/dist-private
```

Wait for `artifact-ready`. This confirms that the immutable fixture independently staged and audited the caller's files, checked the private CSP and run-specific manifest, and loaded the production entry and both workers in its fresh browser. `server-ready` alone is not enough to start the scenarios.

## Drive the UI

Run from the checkout containing `test:real-client`, using the readiness file and pins from that foreground run. The runner validates the artifact's web pin; its own checkout can carry this scenario implementation.

```sh
corepack pnpm run test:real-client -- \
  --readiness-file "$READINESS_FILE" \
  --harness-revision 5f294c39abb32fc8ae15a4f7ccb085974098b320 \
  --server-revision 47daaaea5c71b859d9865c03cabb50da5a1a013b \
  --web-revision c88211e3985942343bf40dcbbcb8e8f5b4b7d364 \
  --run-id "$RUN_ID" \
  --scenarios sign-in,message,group
```

The browser uses two new independent contexts and the actual username/password flow. It sends `browser-ci-hello` to the other account, creates a basic group through the UI with that account, then checks the received group message and member list. It captures each state inside the fixture browser's temporary directory, removes those screenshots and the runner on exit, and emits only scenario, fixed password-stage and network summaries. It does not import storage state, use test-only authentication, or export credentials, traces or captures.

Password readiness selects only `#auth-pages input[name="notsearch_password"]`. Within one bounded wait of at most 30 seconds, it requires exactly one visible, non-`stealthy`, password-type match and the original Username field to be hidden. The runner keeps the password-card screenshot before filling, rechecks the count and masked type, then fills and presses Enter on the same element handle. Failures use fixed stages (`<name>_password_field_absent`, `_password_field_not_unique`, `_password_field_hidden`, `_password_field_unmasked` or `_password_card_not_reached`). Password-stage evidence contains only stage names and match counts; it does not read labels, hints, values, alert text or response bodies, and it takes no capture after filling before the card transition.

After the command succeeds or fails, send `stop` to the foreground fixture and wait for its owned cleanup to finish. Then remove the caller-owned artifact and temporary key/readiness files:

```sh
rm -rf -- "$ARTIFACT_PARENT"
rm -f -- "$KEY_FILE" "$READINESS_FILE"
```

## Shared-worker and installation-failure evidence

The runner reports what the browser did with workers, next to the scenario and egress summaries. Browser-level target discovery starts before this runner creates its first context, so shared-worker creation cannot be missed and absence becomes provable. Every page, shared worker, service worker and dedicated worker target is attributed by its browser context; a worker target that belongs to no runner context fails the run.

Each context reports one page, the shared-worker targets split by script and blob construction, service and dedicated workers, the allowlisted logical names of fetched worker scripts, the MTProto classification with the status of that source fetch: `mtproto_candidate` for exactly one same-origin blob worker created after a successful allowlisted chunk fetch, `ambiguous` for two or more such workers, `absent` for a successful allowlisted fetch with no blob worker under complete coverage, and `unknown` otherwise. A blob that predates the fetch, a cross-origin blob and a blob under a failed or absent fetch are never attributed, and any blob rules out absence. the installation-failure category with its validation state, and coverage counters.

Failure categories are `script_load_failed`, `module_resolve_failed`, `module_fetch_failed`, `evaluation_exception`, `csp_blocked`, `destroyed_before_attach`, `no_failure_observed` and `unknown`, each in a separate `validated` or `unvalidated` state. Only a category with an exact browser signal is validated: the page's own worker-script fetch failure, a CSP-attributed block, a worker target destroyed before its session attached, and `no_failure_observed` under complete coverage. The remaining categories stay best-effort and never become a stated cause. `unknown` is a reportable answer, not a failure of the observer.

Synthetic controls run in their own contexts against the fixture's own probe routes, before any application context, and the application scenarios start only when every control passes: a shared worker that is created, a shared-worker script that is missing, no construction at all, a worker target destroyed before its session attaches, an event stream that exceeds the bound, and more shared workers than the attached-target budget. A control that does not behave as specified blocks the application scenarios.

Resource bounds are fixed: 16 attached targets, 512 counted events per context, 256 KiB per CDP message, 5 seconds per command. Reaching a bound closes the observer: counting, retention and classification stop, and the context reports `unknown` with a nonzero overflow flag and fails the run. The attached-target budget bounds protocol setup as well as a counter: a target that cannot be counted receives no enables and is released immediately. CDP methods are allowlisted per session role, including nested sends, so page and worker evaluation is never reachable. The report is a closed schema of allowlisted logical chunk names with content hashes stripped: no URL, credential, password, key, endpoint list, page text or free-form log line is ever serialized. A schema violation is serialized as `unclassified` and fails the run.

The controls can be executed on their own, which is the only mode that does not require `artifact-ready`. `$SERVER_READY_FILE` holds the fixture's single `server-ready` line, written from the foreground fixture output:

```sh
corepack pnpm run test:real-client -- \
  --readiness-file "$SERVER_READY_FILE" \
  --harness-revision 5f294c39abb32fc8ae15a4f7ccb085974098b320 \
  --server-revision 47daaaea5c71b859d9865c03cabb50da5a1a013b \
  --web-revision c88211e3985942343bf40dcbbcb8e8f5b4b7d364 \
  --run-id "$RUN_ID" \
  --observer-controls-only
```

That run touches no application context, captures no screenshot and reads no artifact: it emits `mode: observer_controls` with the observation block, and the fixture lifecycle and its owned cleanup stay the same.

## Historical negative pair

The original negative pair is web `09373cc2713d31e93664c38a4fd0335ea37a5f01` with server `6668a0a3519909ef512fdc59e4937975f108671d`, using the accepted harness `47daaaea5c71b859d9865c03cabb50da5a1a013b`. Its accepted CI evidence reaches `server-ready` and fails the independent artifact audit on worker source maps: `officialMtprotoDynamicRoutes`, `officialDcHosts`, `officialDcIpRanges` and `alternateWebSocketRoutes`. It has no `artifact-ready` event, so the UI sign-in scenario is unsupported for that pair. This audit rejection is not an SRP regression result; keep the original browser/SRP regression claim open until a supported negative control can reach the UI.
