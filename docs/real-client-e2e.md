# Real client fixture scenarios

`pnpm run test:real-client` consumes a completed `server-ready` and `artifact-ready` pair from one foreground real-server fixture run. It checks the immutable harness, server and web pins, the fixture's protected synthetic credentials, isolation and audit evidence before driving the production UI. It requires all four scenarios: `sign-in,message,group,poll`.

The accepted positive inputs are harness `22cbb3fd22f6a1c38ddf1e21b3cf35013f178d35`, server `052f1b91274be72ccc9a7eda0d71af10272addc0` and web artifact source `aa060751df036727fb27cbdd4dbdf0525cd381b4`. The negative-control server is pinned separately to `586403c1f4c92c09b006652278bdd02fd40ddf2d`: it includes MAIN-1301 group support but predates the MAIN-2111 poll creator-flag fix. Each run records the harness, server and artifact source revisions with a fresh run ID, RSA public key, endpoint identity and artifact. Do not reuse readiness or artifacts from another run.

The fixture harness, server and web pins are the exact revisions used for the accepted positive run. Keep the fixture process in the foreground while building and attaching a fresh artifact.

## Run the fixture

From the accepted `teagram-server` checkout, keep the fixture command in the foreground. `READINESS_FILE` must be accessible from the web checkout and should stay outside both repositories and artifact output.

```sh
set -euo pipefail
RUN_ID="$(openssl rand -hex 16)"
READINESS_FILE="$(mktemp /dev/shm/real-client-readiness.XXXXXX)"
chmod 600 "$READINESS_FILE"
printf 'READINESS_FILE=%s\n' "$READINESS_FILE"
test "$(git rev-parse HEAD)" = 22cbb3fd22f6a1c38ddf1e21b3cf35013f178d35
test -z "$(git status --porcelain --untracked-files=all)"
bash test/e2e/real_server_fixture/run.sh \
  --server-revision 052f1b91274be72ccc9a7eda0d71af10272addc0 \
  --web-revision aa060751df036727fb27cbdd4dbdf0525cd381b4 \
  --run-id "$RUN_ID" | tee "$READINESS_FILE"
```

The fixture prints `server-ready` only after real SRP authentication, worker and direct-TCP probes, and its run isolation checks. Keep the foreground process and its stdin open. Do not pass `TG_*` or `MTPROTO_*` variables to it.

## Build and attach the run's artifact

From a clean web checkout at the exact positive web revision, use only that run's public PEM and endpoint. The key file stays outside the repository, fixture secret/build directories and artifact output. Only the build process receives the private-target environment.

```sh
set -euo pipefail
READINESS_FILE='/dev/shm/real-client-readiness.<path-printed-in-fixture-terminal>'
RUN_ID="$(jq -er 'select(.event == "server-ready") | .runId' "$READINESS_FILE")"
test "$(git rev-parse HEAD)" = aa060751df036727fb27cbdd4dbdf0525cd381b4
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
  --harness-revision 22cbb3fd22f6a1c38ddf1e21b3cf35013f178d35 \
  --server-revision 052f1b91274be72ccc9a7eda0d71af10272addc0 \
  --web-revision aa060751df036727fb27cbdd4dbdf0525cd381b4 \
  --run-id "$RUN_ID" \
  --scenarios sign-in,message,group,poll
```

The browser uses two new independent contexts and the actual username/password flow. It sends `browser-ci-hello` to the other account, creates a basic group through the UI with that account, then checks the received group message and member list. The poll scenario creates one two-answer poll with the description `Description stuff` and one with an empty description. The second poll attaches a synthetic link to its first answer through the UI, exercising the client's `inputPollAnswer` creation path without depending on photo permissions. Bob sees both polls and votes in each; his count/result is checked after his vote, and Alice's after she closes each poll. Alice stops each poll from the message context menu after the send status confirms delivery. Bob must then see `Final Results`, and the answer controls must reject a trial click. Each positive run captures 30 states inside the fixture browser's temporary directory, removes those screenshots and the runner on exit, and emits only scenario, fixed password-stage and network summaries. Poll send failures also retain whether Create was clicked and the composer closed, synthetic temp-message status and error fields, a matching `message_sent` result with numeric message identifiers when present, whether its server mid was found in Alice's peer-scoped message store and whether that entry still matched the synthetic poll, synthetic-only counts for server/temp-id message rows and question text nodes at send time and after the DOM wait, and the actual poll locator's match and visibility counts, RPC error counts/types, and worker exception categories/counts; no poll text or arbitrary error text is emitted. It does not import storage state, use test-only authentication, or export credentials, traces or captures.

Each scenario failure includes the page/worker gate snapshot collected at that point. A `TypeError` retains a recognized JavaScript error message, the first stack frame's function and line/column, its asset name when that frame maps to a script requested from the staged private artifact, and the active scenario/stage. Other messages collapse to `unclassified`; raw URLs, full stacks and arbitrary exception text stay out of the report.

To compare page errors without the poll step, run the same pins in a fresh fixture with `--scenarios sign-in,message,group --page-error-no-poll-comparison`. This diagnostic mode accepts only that exact scenario set and still enforces all page, worker and egress gates; it is not a substitute for the four-scenario acceptance run.

## Verify the legacy poll failures

Run a separate fresh fixture using the same harness and web artifact source, but server revision `586403c1f4c92c09b006652278bdd02fd40ddf2d`. This server includes MAIN-1301 group support while predating the MAIN-2111 creator-flag fix, so sign-in, message and group can pass before both poll creations are rejected. Build and attach a new private artifact for that run. Do not reuse the positive run's readiness, public key, endpoint or artifact.

From the teagram-server checkout at the harness revision, keep this fixture process in the foreground and use a fresh run ID and readiness file:

```sh
set -euo pipefail
RUN_ID="$(openssl rand -hex 16)"
READINESS_FILE="$(mktemp /dev/shm/real-client-negative-readiness.XXXXXX)"
chmod 600 "$READINESS_FILE"
printf 'READINESS_FILE=%s\n' "$READINESS_FILE"
test "$(git rev-parse HEAD)" = 22cbb3fd22f6a1c38ddf1e21b3cf35013f178d35
bash test/e2e/real_server_fixture/run.sh \
  --server-revision 586403c1f4c92c09b006652278bdd02fd40ddf2d \
  --web-revision aa060751df036727fb27cbdd4dbdf0525cd381b4 \
  --run-id "$RUN_ID" | tee "$READINESS_FILE"
```

Run the complete scenario set with `--poll-creation-negative-control`:

```sh
corepack pnpm run test:real-client -- \
  --readiness-file "$READINESS_FILE" \
  --harness-revision 22cbb3fd22f6a1c38ddf1e21b3cf35013f178d35 \
  --server-revision 586403c1f4c92c09b006652278bdd02fd40ddf2d \
  --web-revision aa060751df036727fb27cbdd4dbdf0525cd381b4 \
  --run-id "$RUN_ID" \
  --scenarios sign-in,message,group,poll \
  --poll-creation-negative-control
```

This mode still signs in both users and completes the message and group scenarios. It then submits two polls through the UI and passes only when the server rejects both at poll creation with `POLL_ANSWERS_INVALID`: the description shape at `alice_poll_description_create` and empty-description media-answer shape at `alice_poll_input_answer_create`. It captures 20 states and cleans them up with the runner. Login or fixture startup failures do not count as a regression result.

When a message or group stage fails, the failure line adds one centre-column summary, read from the failing page before cleanup: the number of open and active chats, the active chat's numeric peer id and the one selected from search, how many elements the composer selector matched, how many composer inputs exist and how many are visible or editable, whether the chat input is absent, hidden or visible, which bottom bar replaced it (`start`, `unblock`, `join`, `mute`, `unmute`, `open_chat`, `frozen`, `multiple`, `other` or `none`), whether the composer wait ended on `timeout` or `strict_mode_violation`, the page exception and console-error counts since the peer was selected, and the handled RPC failures since then: their count and, for up to 16 types, the error types that match `^[A-Z][A-Z0-9_]{1,63}$` (such as `PEER_ID_INVALID`). The RPC count comes from a passive listener the runner adds to the page's worker message ports before the app loads. It reads only the error type of a failed result, never a request, result, argument or message. It is a closed schema of counts, fixed values, numeric ids and error-type identifiers: a field outside it is reported as `unclassified`, and no page text, message, label, console text or exception message is read. A page that cannot be read within 5 seconds is reported as `unavailable`. Screenshots are still removed and cleanup is unchanged.

The new-group name form has its own stages: `alice_group_name_form` (the form never became visible), `alice_group_name_screenshot`, `alice_group_name_fill` (the group name field, a contenteditable `.input-field-input`) and `alice_group_name_confirm` (the corner button that the name's input event shows). A failure in one of them adds a group name form summary next to the centre column: how many forms match and whether the one form is visible, how many visible `input` and contenteditable elements it holds, how many name fields match and are visible, whether the name field holds a value, how many corner buttons exist and whether the button is shown and enabled, and whether the step's wait ended on `timeout` or `strict_mode_violation`. It is a closed schema of counts, booleans and fixed values: the name field's content is reduced to a boolean, and a field outside the schema is reported as `unclassified`.

After the confirm, the group-created steps wait on the active centre-column chat only once its peer is a group, so the direct chat that is still active while the new group loads never satisfies them. Each step has its own stage: `alice_group_created_chat` (no active group chat), `alice_group_created_composer`, `alice_group_created_header`, `alice_group_created_title` (the header never showed the group name) and `alice_group_created_screenshot`. A failure in one of them adds a group created summary next to the centre column: whether the one active chat is a `group`, a `user` or `none`, how many chats the centre column holds, whether the active chat's visible header carries the group name, and whether the step's wait ended on `timeout` or `strict_mode_violation`. The group name is compared inside the page and reduced to that boolean; a field outside the schema is reported as `unclassified`.

Bob's group steps, from the click on the group's chat-list row to its title, wait on the active centre-column chat the same way, so Alice's direct chat that is still open on Bob's side never satisfies them. Their stages are `bob_group_open` (the row click), `bob_group_chat` (no active group chat), `bob_group_chat_composer`, `bob_group_header`, `bob_group_title` and `bob_group_screenshot`, and a failure in one of them adds the same group created summary.

Password readiness selects only `#auth-pages input[name="notsearch_password"]`. Within one bounded wait of at most 30 seconds, it requires exactly one visible, non-`stealthy`, password-type match and the original Username field to be hidden. The runner keeps the password-card screenshot before filling, rechecks the count and masked type, then fills and presses Enter on the same element handle. Failures use fixed stages (`<name>_password_field_absent`, `_password_field_not_unique`, `_password_field_hidden`, `_password_field_unmasked` or `_password_card_not_reached`). Password-stage evidence contains only stage names and match counts; it does not read labels, hints, values, alert text or response bodies, and it takes no capture after filling before the card transition.

After the command succeeds or fails, send `stop` to the foreground fixture and wait for its owned cleanup to finish. Then remove the caller-owned artifact and temporary key/readiness files:

```sh
rm -rf -- "$ARTIFACT_PARENT"
rm -f -- "$KEY_FILE" "$READINESS_FILE"
```

## Check one Username submission

For a bounded authentication-progress check, use the accepted completed `artifact-ready` pair for web source `569529c1f36923c098760ef727808254dcb6a662` and its matching immutable pins. Do not rebuild or modify that artifact. The runner creates Alice's ordinary browser context, fills and submits Username once, then stops when the masked password field is ready or the fixed password-card wait expires. It never creates Bob's context, fills or submits a password, retries Username, or enters the messaging and group scenarios. This mode cannot be combined with `--scenarios` or `--observer-controls-only`.

```sh
corepack pnpm run test:real-client -- \
  --readiness-file "$READINESS_FILE" \
  --harness-revision 5f294c39abb32fc8ae15a4f7ccb085974098b320 \
  --server-revision 47daaaea5c71b859d9865c03cabb50da5a1a013b \
  --web-revision 569529c1f36923c098760ef727808254dcb6a662 \
  --run-id "$RUN_ID" \
  --auth-progress-one-submission
```

The report contains the immutable run and artifact references, fixed stage and count fields, and the existing privacy-safe network and worker observations. It does not report an application RPC count; the server snapshot consumer owns that evidence. A timeout or ambiguous password card emits its fixed stage and match count, then the runner closes its browser and removes its temporary files.

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
