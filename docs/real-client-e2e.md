# Real client fixture scenarios

`pnpm run test:real-client` consumes a completed `server-ready` and `artifact-ready` pair from one foreground real-server fixture run. It checks the immutable harness, server and web pins, the fixture's protected synthetic credentials, isolation and audit evidence before driving the production UI. The core selection requires `sign-in,message,group`; `channel` and `poll` are independent optional scenarios, and channel runs before poll when both are selected. The MAIN-1316 combined acceptance selects all five scenarios and retains MAIN-1317's channel checks.

The MAIN-1317 rerun pins the harness and server to teagram-server main `a58c3f7141bc0c8956b2659cc98f2bef09d82318` and the web artifact source to current master `ac62bc68dd593d139d1fb9a9f0d5dcc11d083b4b`. The scenario runner revision is recorded separately from the artifact source revision. Each run also has a fresh run ID, RSA public key and endpoint identity. Do not reuse readiness or artifacts from another run.

The native arm64 fixture successor was accepted from server PR #499, merged as `b61fbe1a53348edd0039885fb4a4659e0dc455c0`. Server and harness revisions are full immutable SHAs so the server binary and runner provenance remain tied to the same run.

## Run the fixture

From the accepted `teagram-server` checkout, keep the fixture command in the foreground. `READINESS_FILE` must be accessible from the web checkout and should stay outside both repositories and artifact output.

```sh
set -euo pipefail
RUN_ID="$(openssl rand -hex 16)"
READINESS_FILE="$(mktemp /dev/shm/real-client-readiness.XXXXXX)"
chmod 600 "$READINESS_FILE"
printf 'READINESS_FILE=%s\n' "$READINESS_FILE"
test "$(git rev-parse HEAD)" = a58c3f7141bc0c8956b2659cc98f2bef09d82318
test -z "$(git status --porcelain --untracked-files=all)"
bash test/e2e/real_server_fixture/run.sh \
  --server-revision a58c3f7141bc0c8956b2659cc98f2bef09d82318 \
  --web-revision ac62bc68dd593d139d1fb9a9f0d5dcc11d083b4b \
  --run-id "$RUN_ID" | tee "$READINESS_FILE"
```

The fixture prints `server-ready` only after real SRP authentication, worker and direct-TCP probes, and its run isolation checks. Keep the foreground process and its stdin open. Do not pass `TG_*` or `MTPROTO_*` variables to it.

## Build and attach the run's artifact

From a clean web checkout at the exact positive web revision, use only that run's public PEM and endpoint. The key file stays outside the repository, fixture secret/build directories and artifact output. Only the build process receives the private-target environment.

```sh
set -euo pipefail
READINESS_FILE='/dev/shm/real-client-readiness.<path-printed-in-fixture-terminal>'
RUN_ID="$(jq -er 'select(.event == "server-ready") | .runId' "$READINESS_FILE")"
test "$(git rev-parse HEAD)" = ac62bc68dd593d139d1fb9a9f0d5dcc11d083b4b
test -z "$(git status --porcelain --untracked-files=all)"
KEY_FILE="$(mktemp /dev/shm/real-client-public-key.XXXXXX)"
chmod 600 "$KEY_FILE"
jq -er 'select(.event == "server-ready") | .mtprotoPublicKeyPEM' "$READINESS_FILE" > "$KEY_FILE"
ARTIFACT_PARENT="$(mktemp -d)"
ARTIFACT_DIR="$ARTIFACT_PARENT/dist-private"
MTPROTO_TARGET_MODE=private \
MTPROTO_PRIVATE_ENDPOINT=wss://teagramd.test/apiws \
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
  --harness-revision a58c3f7141bc0c8956b2659cc98f2bef09d82318 \
  --server-revision a58c3f7141bc0c8956b2659cc98f2bef09d82318 \
  --web-revision ac62bc68dd593d139d1fb9a9f0d5dcc11d083b4b \
  --run-id "$RUN_ID" \
  --scenarios sign-in,message,group,channel,poll
```

The browser uses two new independent contexts and the actual username/password flow. It sends `browser-ci-hello` to the other account, creates a basic group through the UI with that account, then checks the received group message and member list. It then creates a broadcast channel through the UI and adds Bob there. After the invite, Bob reloads the chat list to observe the committed membership and returns to the group. Before Alice posts `browser-channel-post`, the runner requires Bob's reloaded chat list to contain the channel row, matching its peer id or unique title, and to show no unread badge. It requires the dialog to show exactly one unread post before Bob opens the channel, then checks one exact matching post, a cleared unread count, and a still-cleared count after Bob returns to the group and reloads. The unread assertion happens before the channel is opened, so background auto-read cannot satisfy it. Channel creation, membership, delivery and persisted read state each have a separate assertion.

When selected, the poll scenario creates a two-answer poll with `Description stuff` and another with an empty description and a synthetic link on its first answer. Bob receives both and votes in each. The runner checks Bob's counts after his vote, then Alice's after she stops each poll from the message context menu. Bob must see final results, and the closed poll must reject another vote. Poll send diagnostics retain the Create/composer state, synthetic temp-message error fields, matching `message_sent` result, peer-scoped server-mid store check, DOM row and selector counts, RPC errors and worker failure categories. The diagnostics contain only bounded identifiers, enums and counts; poll text and arbitrary error text are not emitted. The poll flow captures 14 states. The full five-scenario run captures 40 states; poll without channel captures 30, core plus channel captures 26, and the core-only run captures 16.

The runner uses only the UI and does not mutate the fixture database. It captures each state inside the fixture browser's temporary directory, removes those screenshots and the runner on exit, and emits scenario, fixed password-stage, network, page-error and bounded RPC diagnostics. It does not import storage state, use test-only authentication, or export credentials. The pull-request flow exports Playwright traces only after a browser assertion fails, after the synthetic accounts sign in; password entry is outside the captured chunks.

For the legacy poll control, use a fresh fixture pinned to server `586403c1f4c92c09b006652278bdd02fd40ddf2d`, which predates MAIN-2111. Select poll and add `--poll-creation-negative-control`; the core scenarios must pass before the description and input-answer poll creation requests fail with `POLL_ANSWERS_INVALID` at `alice_poll_description_create` and `alice_poll_input_answer_create`. Channel also passes when selected. The negative run captures 4 poll states, 20 states without channel, or 30 states with channel.

When a message or group stage fails, the failure line adds one centre-column summary, read from the failing page before cleanup: the number of open and active chats, the active chat's numeric peer id and the one selected from search, how many elements the composer selector matched, how many composer inputs exist and how many are visible or editable, whether the chat input is absent, hidden or visible, which bottom bar replaced it (`start`, `unblock`, `join`, `mute`, `unmute`, `open_chat`, `frozen`, `multiple`, `other` or `none`), whether the composer wait ended on `timeout` or `strict_mode_violation`, the page exception and console-error counts since the peer was selected, and the handled RPC failures since then: their count and error types. For each logged API failure, the report also records the RPC method and up to eight peer, channel or user argument constructors with their numeric ids. The fixed reader follows only own data fields and excludes access hashes and other arguments; the passive message-port listener still records only error type, code and description fields. The diagnostics are a closed schema of counts, fixed values, method and constructor identifiers, and numeric ids: a field outside it is reported as `unclassified`. Scenario-level console diagnostics remain bounded and use their own closed schema. `gateBreakdown` accompanies passing reports, failed scenario stages and the final browser gate. On a scenario-stage failure, its step diagnostics contain only that failed scenario and stage. The final browser gate reports page errors with a fixed `[redacted]` message, up to 16 stack frames containing only function identifiers, logical script asset basenames and line/column numbers, plus fixed scenario and stage labels. Optional attribution adds only the private page path and RPC error type/code. Raw page-error messages and stack text are never serialized. The stack state distinguishes unavailable stacks, stacks with no frames, unclassified frames, captured frames, partial capture and truncation. The report parser rejects unsafe frame data, unknown fields and unrecognized page-error message values. A page that cannot be read within 5 seconds is reported as `unavailable`. Screenshots are still removed and cleanup is unchanged.

For each captured scenario step, the closed report groups up to 16 thrown or rejected values, RPC failures and console errors by the fixed scenario and stage. Thrown values and RPC failures expose only their own scalar `type`, `code` and `description` fields; console output and descriptions are bounded and redact URLs, credentials, email addresses and long token-shaped strings. Full RPC argument values are excluded; the report includes only selected peer, channel and user argument constructor names and numeric IDs, with no access hashes or other argument values. The fixture uses synthetic accounts and content.

The new-group name form has its own stages: `alice_group_name_form` (the form never became visible), `alice_group_name_screenshot`, `alice_group_name_fill` (the group name field, a contenteditable `.input-field-input`) and `alice_group_name_confirm` (the corner button that the name's input event shows). A failure in one of them adds a group name form summary next to the centre column: how many forms match and whether the one form is visible, how many visible `input` and contenteditable elements it holds, how many name fields match and are visible, whether the name field holds a value, how many corner buttons exist and whether the button is shown and enabled, and whether the step's wait ended on `timeout` or `strict_mode_violation`. It is a closed schema of counts, booleans and fixed values: the name field's content is reduced to a boolean, and a field outside the schema is reported as `unclassified`.

After the confirm, the group-created steps wait on the active centre-column chat only once its peer is a group, so the direct chat that is still active while the new group loads never satisfies them. Each step has its own stage: `alice_group_created_chat` (no active group chat), `alice_group_created_composer`, `alice_group_created_header`, `alice_group_created_title` (the header never showed the group name) and `alice_group_created_screenshot`. A failure in one of them adds a group created summary next to the centre column: whether the one active chat is a `group`, a `user` or `none`, how many chats the centre column holds, whether the active chat's visible header carries the group name, and whether the step's wait ended on `timeout` or `strict_mode_violation`. The group name is compared inside the page and reduced to that boolean; a field outside the schema is reported as `unclassified`.

Bob's group steps, from the click on the group's chat-list row to its title, wait on the active centre-column chat the same way, so Alice's direct chat that is still open on Bob's side never satisfies them. Their stages are `bob_group_open` (the row click), `bob_group_chat` (no active group chat), `bob_group_chat_composer`, `bob_group_header`, `bob_group_title` and `bob_group_screenshot`, and a failure in one of them adds the same group created summary.

A channel membership failure reports the channel row and title-match counts, active peer ids and chat-list row counts for both clients, plus page, console and sanitized RPC error deltas since the invite. Channel names and page text are compared in the browser and never returned.

Pass `--page-error-diagnostics` to correlate otherwise unattributed page errors and report safe source frames, the private page path, scenario and stage, and any RPC error type/code. When exactly one same-page, same-stage RPC failure matches the exception's type and code, the diagnostic also reports its validated method name only; ambiguous candidates leave the method unknown. RPC parameters are never added to page-error attribution. Debugger CDP commands are allowed only with this option. The runner correlates duplicate Runtime and debugger observations by exception identity, throw location or an adjacent same-context pause and exception pair. A window rejection can supplement one unique protocol exception when its RPC hints agree; separate exceptions with the same generic message remain unattributed. Enrichment also runs when an earlier click or wait fails, so the serialized failure report keeps available attribution. Message hashes are held in memory for correlation; raw error messages and stacks never enter the report.

A fresh channel run with `--page-error-diagnostics` used run ID `99a533e5381d31c37c4c959f74914991`, runner and artifact source revision `dd94dc335b801dce4c0eaa805708e67b52bf9e93`, and fixture harness/server revision `b451d3857ed21763d9bb750db938be29c29d9238`. Readiness, private artifact and browser audits passed; the scenario failed at `alice_channel_post_visible` with zero unexpected egress attempts and observer errors. The report contained a separate frame-less Alice error at `alice_channel_create`, which has no RPC hint and remains unclassified. It also attributed Alice's `PEER_ID_INVALID` (400) rejection to `messages.setTyping`, with the capture stage `alice_channel_post_send` while Alice pressed Enter to post `browser-channel-post`:

```json
{"scenario":"channel","pageError":{"message":"[redacted]","scriptAsset":"cryptoMessagePort-DQ_71Hnd.js","stack":{"state":"captured","lineCount":6,"frameCount":5,"frames":[{"functionName":"processResultTask","scriptAsset":"cryptoMessagePort-DQ_71Hnd.js","line":3,"column":2563},{"functionName":"onMessage","scriptAsset":"cryptoMessagePort-DQ_71Hnd.js","line":3,"column":2397},{"functionName":"unknown","scriptAsset":"cryptoMessagePort-DQ_71Hnd.js","line":3,"column":3267},{"functionName":"processBatchTask","scriptAsset":"cryptoMessagePort-DQ_71Hnd.js","line":3,"column":3241},{"functionName":"onMessage","scriptAsset":"cryptoMessagePort-DQ_71Hnd.js","line":3,"column":2397}]},"scenarioStep":{"scenario":"channel","step":"alice_channel_post_send"},"diagnostic":{"pageUrl":"https://teagramd.test/","scenario":"channel","stage":"alice_channel_post_send","rpcErrorType":"PEER_ID_INVALID","rpcErrorCode":400,"rpcMethod":"messages.setTyping"}}
```

The `processResultTask` frame maps to `src/lib/superMessagePort.ts:589`, where the worker rejects the RPC promise. The matched call is issued by `src/lib/appManagers/appMessagesManager.ts:12924`; trusted composer input reaches it through `src/components/chat/input.ts:3386`. The web client sends `messages.setTyping` for Alice's broadcast-channel composer, while the fixture handler supports typing for users, basic chats and megagroups and returns `PEER_ID_INVALID` for a broadcast channel (`teagram-server/internal/api/messages.go:1283`, `1321-1322`). This is a web product defect: the client should not send a typing action for a broadcast channel. The method's documented target is a user or group ([MTProto `messages.setTyping`](https://core.telegram.org/method/messages.setTyping)). The unrelated frame-less error at `alice_channel_create` remains unattributed; this run provides no evidence that it is the same rejection.

Password readiness selects only `#auth-pages input[name="notsearch_password"]`. Within one bounded wait of at most 30 seconds, it requires exactly one visible, non-`stealthy`, password-type match and the original Username field to be hidden. The runner keeps the password-card screenshot before filling, rechecks the count and masked type, then fills and presses Enter on the same element handle. Failures use fixed stages (`<name>_password_field_absent`, `_password_field_not_unique`, `_password_field_hidden`, `_password_field_unmasked` or `_password_card_not_reached`). Password-stage evidence contains only stage names and match counts; it does not read labels, hints, values, alert text or response bodies, and it takes no capture after filling before the card transition.

After the command succeeds or fails, send `stop` to the foreground fixture and wait for its owned cleanup to finish. Then remove the caller-owned artifact and temporary key/readiness files:

```sh
rm -rf -- "$ARTIFACT_PARENT"
rm -f -- "$KEY_FILE" "$READINESS_FILE"
```

## Check one Username submission

For a bounded authentication-progress check, use an `artifact-ready` pair for web source `569529c1f36923c098760ef727808254dcb6a662`, produced with harness and server both pinned to `465e6b246c636871ad3067c30b76a35e82081d80`. The artifact and readiness record must come from the same fresh run; do not modify the artifact after attachment. The runner creates Alice's ordinary browser context, fills and submits Username once, then stops when the masked password field is ready or the fixed password-card wait expires. It never creates Bob's context, fills or submits a password, retries Username, or enters the messaging and group scenarios. This mode cannot be combined with `--scenarios` or `--observer-controls-only`.

```sh
corepack pnpm run test:real-client -- \
  --readiness-file "$READINESS_FILE" \
  --harness-revision 465e6b246c636871ad3067c30b76a35e82081d80 \
  --server-revision 465e6b246c636871ad3067c30b76a35e82081d80 \
  --web-revision 569529c1f36923c098760ef727808254dcb6a662 \
  --run-id "$RUN_ID" \
  --auth-progress-one-submission
```

The report contains the immutable run and artifact references, fixed stage and count fields, and the existing privacy-safe network and worker observations. It does not report an application RPC count; the server snapshot consumer owns that evidence. Scenario reports also include bounded per-step API error diagnostics: the RPC method and allowlisted peer/channel/user constructor IDs, with access hashes and other arguments excluded. A timeout or ambiguous password card emits its fixed stage and match count, then the runner closes its browser and removes its temporary files.

## Shared-worker and installation-failure evidence

The runner reports what the browser did with workers, next to the scenario and egress summaries. Browser-level target discovery starts before this runner creates its first context, so shared-worker creation cannot be missed and absence becomes provable. Every page, shared worker, service worker and dedicated worker target is attributed by its browser context; a worker target that belongs to no runner context fails the run.

Each context reports one page, the shared-worker targets split by script and blob construction, service and dedicated workers, the allowlisted logical names of fetched worker scripts, the MTProto classification with the status of that source fetch: `mtproto_candidate` for exactly one same-origin blob worker created after a successful allowlisted chunk fetch, `ambiguous` for two or more such workers, `absent` for a successful allowlisted fetch with no blob worker under complete coverage, and `unknown` otherwise. A blob that predates the fetch, a cross-origin blob and a blob under a failed or absent fetch are never attributed, and any blob rules out absence. the installation-failure category with its validation state, and coverage counters.

Failure categories are `script_load_failed`, `module_resolve_failed`, `module_fetch_failed`, `evaluation_exception`, `csp_blocked`, `destroyed_before_attach`, `no_failure_observed` and `unknown`, each in a separate `validated` or `unvalidated` state. Only a category with an exact browser signal is validated: the page's own worker-script fetch failure, a CSP-attributed block, a worker target destroyed before its session attached, and `no_failure_observed` under complete coverage. The remaining categories stay best-effort and never become a stated cause. `unknown` is a reportable answer, not a failure of the observer.

Synthetic controls run in their own contexts against the fixture's own probe routes, before any application context, and the application scenarios start only when every control passes: a shared worker that is created, a shared-worker script that is missing, no construction at all, a worker target destroyed before its session attaches, an event stream that exceeds the bound, and more shared workers than the attached-target budget. A control that does not behave as specified blocks the application scenarios.

Resource bounds are fixed: 32 concurrently attached distinct target IDs per context, 4096 counted events per context, 256 KiB per CDP message, 5 seconds per command. The `attachedTargets` report is the peak concurrent count; a destroyed target frees one slot, and the same shared-worker target observed through browser discovery and page auto-attach counts once. Reaching a bound closes the observer: counting, retention and classification stop, and the context reports `unknown` with a nonzero overflow flag and fails the run. The attached-target budget bounds protocol setup as well as a counter: a target that cannot be counted receives no enables and is released immediately. CDP methods are allowlisted per session role, including nested sends. The sole `Runtime.callFunctionOn` uses a fixed reader on a matched API error log; it reads only TL constructor tags and the corresponding user, channel or chat ID fields, without reading access hashes or other parameter values. Arbitrary page and worker evaluation remains unavailable. The worker observation block is a closed schema of allowlisted logical chunk names with content hashes stripped: no URL, credential, password, key, endpoint list, page text or free-form log line is ever serialized. A schema violation is serialized as `unclassified` and fails the run.

The controls can be executed on their own, which is the only mode that does not require `artifact-ready`. `$SERVER_READY_FILE` holds the fixture's single `server-ready` line, written from the foreground fixture output:

```sh
corepack pnpm run test:real-client -- \
  --readiness-file "$SERVER_READY_FILE" \
  --harness-revision 465e6b246c636871ad3067c30b76a35e82081d80 \
  --server-revision 465e6b246c636871ad3067c30b76a35e82081d80 \
  --web-revision c88211e3985942343bf40dcbbcb8e8f5b4b7d364 \
  --run-id "$RUN_ID" \
  --observer-controls-only
```

That run touches no application context, captures no screenshot and reads no artifact: it emits `mode: observer_controls` with the observation block, and the fixture lifecycle and its owned cleanup stay the same.

## Historical negative pair

The original historical negative-pair evidence is web `09373cc2713d31e93664c38a4fd0335ea37a5f01` with server `6668a0a3519909ef512fdc59e4937975f108671d`, using the legacy harness `47daaaea5c71b859d9865c03cabb50da5a1a013b`. Its accepted CI evidence reaches `server-ready` and fails the independent artifact audit on worker source maps: `officialMtprotoDynamicRoutes`, `officialDcHosts`, `officialDcIpRanges` and `alternateWebSocketRoutes`. It has no `artifact-ready` event, so the UI sign-in scenario is unsupported for that pair. This audit rejection is not an SRP regression result; keep the original browser/SRP regression claim open until a supported negative control can reach the UI.

## PR browser-flow check, traces, and cleanup

The `Real-client browser flow / real-client-browser-flow` check runs on pull requests in both repositories on `ubuntu-26.04`. It builds the production web artifact, starts the disposable fixture, and runs the five-scenario command above. Its job summary records the full server and web revisions, the PR head, the merge revision tested, fixture cleanup, and the complete job duration. Each lane checks out its companion at a full SHA; update those pins in a reviewed change rather than using a branch name.

On a browser assertion failure, the run uploads `real-client-playwright-trace-<run>-<attempt>`. The trace starts after synthetic sign-in, records screenshots and action timing, and omits DOM snapshots and source files. Download the artifact from the failed workflow run and open either trace with `corepack pnpm exec playwright show-trace alice.zip` (or `bob.zip`). The trace contains only the disposable fixture's synthetic scenario data; password entry is outside the captured chunks.

The orchestration keeps the fixture in the foreground and sends `stop` after the runner exits. On failure or cancellation it terminates the fixture and waits for its owned cleanup. The fixture verifies removal of its containers, networks, image, temporary credentials, build output, and detached worktree. For a local run, follow the cleanup steps above: wait for `cleanup=verified`, then remove the caller-owned artifact, key, and readiness file.

When a user-facing feature needs real-client coverage, add a named scenario to `scripts/real-client/contract.mjs`, implement its UI flow and assertions in `scripts/real-client/browser.cjs`, then add it to `SCENARIOS` in the pinned server helper at `test/e2e/real_server_fixture/run_real_client_browser_flow.mjs`. Update that full companion SHA in both workflows in a reviewed change. The check rejects scenarios that are empty, skipped, duplicated, or not passed.
