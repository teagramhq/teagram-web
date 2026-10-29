# Web performance CI

The performance job restores the pinned 1x and 100x snapshots from the public
teagram-server fixture release, starts isolated local server instances, and runs
the same browser scenarios against each size. Pull request runs also compare the
head bundle with the base bundle. Main branch runs record compatible timing
history for calibration.

## Performance gates

The 1x and 100x scenarios are calibrated separately. Only main runs with the
same fixture version, fixture seed commit, and pinned server runtime contribute
to a noise band. After 20 matching runs, timing regressions block when the head
median is above the main median by more than `max(15%, 3σ)` and at least 2 ms;
the 100x median also fails when it exceeds the 1x median by more than 1.5x.
Absolute timing budgets apply to the 100x snapshot. On pull requests, every
scenario and size needs two base bundle measurements or the performance gate
fails closed. Because the base client has no date-jump flow, its open-chat
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
