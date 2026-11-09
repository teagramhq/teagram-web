# Web performance CI

The performance job restores the pinned 1x and 100x snapshots from the public
teagram-server fixture release, starts isolated local server instances, and runs
the same browser scenarios against each size. Pull request runs also compare the
head bundle with the base bundle. Main branch runs record compatible timing
history for calibration.

The first-sticker frame probe uses the pinned pre-PR-178 client in
`.github/perf-sticker-base-commit`; its baseline is separate from the current
PR base used for the scale table.

## Performance gates

Timing-derived gates are report-only under MAIN-3608 while the paired noise
model is prepared in MAIN-3610. This interim policy covers median timing against
the master noise band and absolute budgets, the 100x/1x slowdown ratio, long-task
count and blocking-time comparisons against same-run pairs or master history,
100x scroll long tasks and dropped frames, the first animated sticker frame
against the pinned client, and worker recorder replay overhead. Their values
and limits remain in the job summary; a would-fail result is marked
`report-only (would fail)`. MAIN-3610 restores these timing gates as blocking.

The blocking gates remain bundle growth above 2%, request and RPC count increases
at the chat-list boundary, bundle measurements that vary across repeats, and
missing, invalid, or short sample sets. Bundle-size comparisons keep their
existing strictness. The 100 ms negative control must still be detected as a
report-only would-fail timing regression; the job fails if detection is missing.
There are no per-scenario allowances from the closed teagram-web#202.

The 1x and 100x scenarios are calibrated separately. Only master runs with the
same measurement version, fixture version, fixture seed commit, and pinned
server runtime contribute to a noise band. A calibrated timing regression is
above the master median by more than `max(15%, 3σ)` and at least 2 ms; the 100x
median is also compared with the 1x median against a 1.5x ceiling. Cold, warm,
and chat-open absolute budgets are 1,000 ms, 300 ms, and 200 ms. Cold chat-list
history also requires a matching cold-load measurement version; other scenarios
continue using the shared measurement version.

The 100x scroll noise band uses master history for long-task counts, blocking
time, and pooled dropped-frame percentage. Chat open, scroll back, and send
measurements collect five same-run paired repeats in PR artifacts; the existing
three-sample policy and calibration version are unchanged, and extra timing
samples are report-only. Send and scroll timing add no timing gates. Every
scenario and size needs three base bundle measurements or the performance gate
fails closed.
Each 100x scroll repeat in the JSON artifact includes `droppedFrameAttribution`,
with the measured frame intervals, overlapping renderer trace events and
instrumented history and chat-list spans. `droppedFrameCpu` joins sampled
stacks to those same intervals; `droppedFrameScripts` records overlapping
scripts from long animation frames, including scripts shorter than 50 ms. The
timestamps use the page performance clock. Empty event or stack lists describe
what was observed, not proof that no work ran. These diagnostics do not change
the frame counter or budget.
The 100x cold chat-list measurement uses six fresh contexts for the paired
blocking-time gate and its negative control. Its timing starts at navigation so
the existing cold-load budget still includes the document fetch.
Chat-open timing starts when the browser dispatches the chat-list row's click;
the separate `preInteractionMs` field records the time before that event so
browser-driver delay does not count against client response time.
Because the base client has no date-jump flow, its open-chat
bundle is the date-jump baseline; that row has no base timing sample. If the
base client cannot load 2,000 older messages, its open-chat bundle is the scroll
bundle baseline; that row has no base scroll timing sample.

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
