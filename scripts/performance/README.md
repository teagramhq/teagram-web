# Web performance CI

The performance job restores the pinned 1x and 100x snapshots from the public
teagram-server fixture release, starts isolated local server instances, and runs
the same browser scenarios against each size. Pull request runs also compare the
head bundle with the base bundle. Main branch runs record compatible timing
history for calibration.

Pull request runs measure the next painted frame after the player first frame
for cold animated stickers against the PR base. Cold samples record the worker
request, player first frame and a timestamp after the intervening render
update, using one animation-frame callback followed by a zero-delay timer on the
page clock. Warm
sticker timing remains screenshot-observed. The pinned pre-PR-178 client in
`.github/perf-sticker-base-commit` remains a report-only comparison.

## Performance gates

Pull requests record nine interleaved base/head pairs for every timing scenario.
The first pair runs base then head, the next head then base, alternating through
the run. The same nine-pair count applies to scenario timings, scroll quality,
scale ratios, first-sticker cold timing, worker recorder overhead, and walk-mirror
counts. Missing scenarios, incomplete metrics, or any base variant that cannot
complete the date jump or 2,000-message scroll-back fail the job.

Every timing gate uses the one-sided 95% distribution-free sign-test lower
confidence bound of the paired median. A gate fails only when that lower bound
is above its minimum effect. Minimum effects and observed spread from the last
pre-change performance artifact ([run 42710920668, attempt 3](https://github.com/teagramhq/teagram-web/actions/runs/42710920668)) are:

| Timing gate | Minimum effect | Paired run-to-run spread in the legacy CI artifact |
| --- | --- | --- |
| Scenario response time, all scales and scenarios | `max(2 ms, 15% of the base median)` | 2.62–349.62 ms across 3–11 pairs; the 1x chat-open pair SD was 15.24 ms |
| 100x cold chat-list absolute budget | `max(scenario response minimum, headroom to 1,000 ms)` | 47.52 ms SD across 6 pairs |
| 100x warm chat-list absolute budget | `max(scenario response minimum, headroom to 300 ms)` | 8.30 ms SD across 3 pairs |
| 100x chat-open absolute budget | `max(scenario response minimum, headroom to 200 ms)` | 101.26 ms SD across 5 pairs |
| 100x/1x slowdown ratio | `max(15% of base ratio, headroom to the 1.5x ceiling)` | 0.759x SD at most across 3 paired ratios |
| 100x long-task count | 1 additional task | 0–1.40 tasks SD across 3–11 pairs |
| 100x long-task blocking time | 25 ms | 0–28.53 ms SD across 3–11 pairs |
| 100x scroll dropped-frame percentage | 15% of the base dropped-frame percentage | 1.081 percentage points SD across 5 pairs |
| Walk-mirror long-task count | 1 additional task | 0 tasks SD across 5 legacy head-only trace repeats; the new report records paired base/head spread |
| Cold first animated sticker next painted frame | 100 ms | 602.59 ms SD across 3 legacy screenshot-polling pinned-client/head pairs; the gate now uses PR base/head pairs |
| Worker recorder overhead | `min(2 ms, 15% of record-off median)` | The legacy run kept medians only. The new report includes nine grouped paired deltas and their SD. |

The measured 100x runs collect cached-dialog walk overlap counts directly from
their nine paired samples. Full CPU/RPC attribution uses one additional
base/head diagnostic pair, avoiding repeated traced copies of the timing
scenarios while preserving all nine samples for every gate.

The CI artifact used for these estimates predates the nine-pair policy and is a
spread estimate, not a gate result. Each new worker-recorder summary prints the
paired SD and lower bound; the uploaded report keeps all browser base/head pairs
so the PR body can cite the measured spread from its A/A run. Master history is
calibration only. It cannot affect a pull-request verdict, and a master push
without a base blocks only on deterministic checks.

Bundle growth still fails only above 2%, and request/RPC increases at the
chat-list boundary, varying contacts-list bundle sizes, and missing or invalid
samples remain blocking. The 100 ms negative control must fail under the paired
rule. It uses the same bundle for control and injected-stall samples.

Each 100x scroll repeat in the JSON artifact includes `droppedFrameAttribution`,
with the measured frame intervals, overlapping renderer trace events and
instrumented history and chat-list spans. `droppedFrameCpu` joins sampled
stacks to those same intervals; `droppedFrameScripts` records overlapping
scripts from long animation frames, including scripts shorter than 50 ms. The
timestamps use the page performance clock. Empty event or stack lists describe
what was observed, not proof that no work ran. These diagnostics do not change
the frame counter or budget.
The 100x cold chat-list measurement uses fresh contexts and starts at navigation
so the cold-load budget includes the document fetch.
Chat-open timing starts when the browser dispatches the chat-list row's click;
the separate `preInteractionMs` field records the time before that event so
browser-driver delay does not count against client response time.

## Fixture credentials and runner threat model

The fixture owner username and password are fixed test data documented in
`teagram-server/test/perf/README.md`. They are public and must never be treated
as secrets or reused for a real account. The snapshots contain generated
performance data and must not contain production or personal data.

Pull request code is untrusted and can read those public credentials, alter the
seeded account, and make outbound network requests from its runner. The workflow
grants `contents: read`, checks out repositories without persisting credentials,
and injects no GitHub Actions secrets. The fixture's fixed auth-key encryption
value is public test data, not a production secret. The job creates its server,
database, TLS key, and RSA key inside the GitHub-hosted runner. The account
authenticates only to that job's disposable server and PostgreSQL snapshot.
These credentials do not grant access to a shared or production service. The
runner and its local performance services are discarded when the job ends.
