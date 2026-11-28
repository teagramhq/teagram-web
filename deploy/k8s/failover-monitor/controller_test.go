package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"testing"
	"time"
)

func testConfig() Config {
	return Config{
		ZoneID:          strings.Repeat("a", 32),
		RecordID:        strings.Repeat("b", 32),
		PagesTarget:     "pages.example.test",
		TunnelTarget:    "tunnel.example.test",
		PagesIP:         "127.0.0.1",
		InitialTarget:   "pages.example.test",
		FailbackEnabled: true,
	}
}

func TestDryRunLogsFailoverAndFailbackDecisions(t *testing.T) {
	config := testConfig()
	var logs bytes.Buffer
	controller, err := NewController(context.Background(), config, nil, nil, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)

	controller.observe(context.Background(), start, fmt.Errorf("forced probe failure"))
	controller.observe(context.Background(), start.Add(20*time.Second), fmt.Errorf("forced probe failure"))
	controller.observe(context.Background(), start.Add(40*time.Second), fmt.Errorf("forced probe failure"))
	if got := controller.CurrentTarget(); got != "tunnel.example.test" {
		t.Fatalf("target after three failures = %q, want tunnel target", got)
	}
	if !strings.Contains(logs.String(), `message="would switch to tunnel.example.test"`) {
		t.Fatalf("dry-run failover decision was not logged: %s", logs.String())
	}

	controller.observe(context.Background(), start.Add(time.Minute), nil)
	controller.observe(context.Background(), start.Add(10*time.Minute+59*time.Second), nil)
	if got := controller.CurrentTarget(); got != "tunnel.example.test" {
		t.Fatalf("target switched back before the healthy window elapsed: %q", got)
	}
	controller.observe(context.Background(), start.Add(11*time.Minute), nil)
	if got := controller.CurrentTarget(); got != "pages.example.test" {
		t.Fatalf("target after ten healthy minutes = %q, want Pages target", got)
	}
	if !strings.Contains(logs.String(), `message="would switch to pages.example.test"`) {
		t.Fatalf("dry-run failback decision was not logged: %s", logs.String())
	}
	if got := controller.ChangeCount(start.Add(11 * time.Minute)); got != 2 {
		t.Fatalf("simulated changes in the rolling hour = %d, want 2", got)
	}
	t.Logf("dry-run evidence: %s", logs.String())
}

func TestProbeLogUsesSanitizedFailureCause(t *testing.T) {
	var logs bytes.Buffer
	controller, err := NewController(context.Background(), testConfig(), nil, nil, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	controller.observe(context.Background(), time.Now(), fmt.Errorf("private probe detail: %w", context.DeadlineExceeded))
	if !strings.Contains(logs.String(), `reason="timeout"`) {
		t.Fatalf("probe log did not classify the timeout: %s", logs.String())
	}
	if strings.Contains(logs.String(), "private probe detail") || strings.Contains(logs.String(), "deadline exceeded") {
		t.Fatalf("probe log exposed the underlying error: %s", logs.String())
	}
}

func TestFailureStreakResetsOnHealthyProbe(t *testing.T) {
	config := testConfig()
	controller, err := NewController(context.Background(), config, nil, nil, log.New(&bytes.Buffer{}, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	controller.observe(context.Background(), start, fmt.Errorf("forced probe failure"))
	controller.observe(context.Background(), start.Add(20*time.Second), fmt.Errorf("forced probe failure"))
	controller.observe(context.Background(), start.Add(40*time.Second), nil)
	controller.observe(context.Background(), start.Add(60*time.Second), fmt.Errorf("forced probe failure"))
	controller.observe(context.Background(), start.Add(80*time.Second), fmt.Errorf("forced probe failure"))
	if got := controller.CurrentTarget(); got != "pages.example.test" {
		t.Fatalf("target changed before three consecutive failures: %q", got)
	}
	controller.observe(context.Background(), start.Add(100*time.Second), fmt.Errorf("forced probe failure"))
	if got := controller.CurrentTarget(); got != "tunnel.example.test" {
		t.Fatalf("target after three consecutive failures = %q, want tunnel target", got)
	}
}

func TestFailbackCanBeDisabledIndependently(t *testing.T) {
	config := testConfig()
	config.InitialTarget = config.TunnelTarget
	config.FailbackEnabled = false
	controller, err := NewController(context.Background(), config, nil, nil, log.New(&bytes.Buffer{}, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	controller.observe(context.Background(), start, nil)
	controller.observe(context.Background(), start.Add(10*time.Minute), nil)
	if got := controller.CurrentTarget(); got != "tunnel.example.test" {
		t.Fatalf("target switched back with failback disabled: %q", got)
	}
}

func TestChangeCapHoldsTunnelTarget(t *testing.T) {
	config := testConfig()
	config.InitialTarget = config.TunnelTarget
	var logs bytes.Buffer
	controller, err := NewController(context.Background(), config, nil, nil, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	controller.history = []time.Time{start.Add(-30 * time.Minute), start.Add(-20 * time.Minute)}
	controller.healthySince = start.Add(-10 * time.Minute)
	controller.observe(context.Background(), start, nil)
	if got := controller.CurrentTarget(); got != "tunnel.example.test" {
		t.Fatalf("target switched back with only one rate-cap slot left: %q", got)
	}
	if !strings.Contains(logs.String(), "change_cap_reserve") {
		t.Fatalf("rate-cap alert was not logged: %s", logs.String())
	}
}

func TestFinalAllowedChangeLeavesMonitorOnTunnelAndAlerts(t *testing.T) {
	config := testConfig()
	var logs bytes.Buffer
	controller, err := NewController(context.Background(), config, nil, nil, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	controller.history = []time.Time{start.Add(-30 * time.Minute), start.Add(-20 * time.Minute)}
	controller.observe(context.Background(), start, fmt.Errorf("forced probe failure"))
	controller.observe(context.Background(), start.Add(20*time.Second), fmt.Errorf("forced probe failure"))
	controller.observe(context.Background(), start.Add(40*time.Second), fmt.Errorf("forced probe failure"))
	if got := controller.CurrentTarget(); got != "tunnel.example.test" {
		t.Fatalf("target at the cap = %q, want tunnel target", got)
	}
	if got := controller.ChangeCount(start.Add(time.Minute)); got != maxChanges {
		t.Fatalf("changes at the cap = %d, want %d", got, maxChanges)
	}
	if !strings.Contains(logs.String(), "change_cap_exhausted") {
		t.Fatalf("change cap alert was not logged: %s", logs.String())
	}
}

func TestExhaustedCapWithPagesTargetLocksWrites(t *testing.T) {
	config := testConfig()
	config.WritesEnabled = true
	now := time.Now()
	state := &memoryStateStore{state: PersistentState{
		Target: config.PagesTarget,
		Changes: []time.Time{
			now.Add(-30 * time.Minute),
			now.Add(-20 * time.Minute),
			now.Add(-10 * time.Minute),
		},
	}}
	client := &mutableRecordClient{record: testRecord(config, config.PagesTarget)}
	var logs bytes.Buffer
	controller, err := NewController(context.Background(), config, client, state, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	if !controller.SafetyLocked() || len(client.patched) != 0 {
		t.Fatalf("invalid exhausted-cap state did not lock writes: %s", logs.String())
	}
}

func TestRecordValidationAllowsOnlyConfiguredRecordAndTargets(t *testing.T) {
	config := testConfig()
	record := testRecord(config, config.PagesTarget)
	if _, err := validateRecord(record, config); err != nil {
		t.Fatalf("valid record was rejected: %v", err)
	}
	tests := []struct {
		name   string
		change func(*DNSRecord)
	}{
		{name: "wrong record ID", change: func(record *DNSRecord) { record.ID = strings.Repeat("c", 32) }},
		{name: "wrong record name", change: func(record *DNSRecord) { record.Name = "other.example.test" }},
		{name: "wrong record type", change: func(record *DNSRecord) { record.Type = "A" }},
		{name: "unconfigured target", change: func(record *DNSRecord) { record.Content = "unexpected.example.test" }},
		{name: "unproxied record", change: func(record *DNSRecord) { record.Proxied = false }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			invalid := record
			test.change(&invalid)
			if _, err := validateRecord(invalid, config); err == nil {
				t.Fatal("invalid record was accepted")
			}
		})
	}
}

func TestWriteRechecksRecordAndRefusesOutOfBandTargetChange(t *testing.T) {
	config := testConfig()
	config.WritesEnabled = true
	state := &memoryStateStore{state: PersistentState{Target: config.PagesTarget}}
	client := &fakeRecordClient{records: []DNSRecord{
		testRecord(config, config.PagesTarget),
		testRecord(config, config.TunnelTarget),
	}}
	var logs bytes.Buffer
	controller, err := NewController(context.Background(), config, client, state, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	controller.observe(context.Background(), start, fmt.Errorf("forced probe failure"))
	controller.observe(context.Background(), start.Add(20*time.Second), fmt.Errorf("forced probe failure"))
	controller.observe(context.Background(), start.Add(40*time.Second), fmt.Errorf("forced probe failure"))
	if got := controller.CurrentTarget(); got != "pages.example.test" {
		t.Fatalf("monitor accepted an out-of-band record change: %q", got)
	}
	if len(client.patched) != 0 {
		t.Fatalf("record was patched after drift: %#v", client.patched)
	}
	if !controller.SafetyLocked() || !strings.Contains(logs.String(), "record_drift_before_write") {
		t.Fatalf("drift did not lock writes and alert: %s", logs.String())
	}
}

func TestWriteReadsAndPersistsTheSingleAllowedRecord(t *testing.T) {
	config := testConfig()
	config.WritesEnabled = true
	state := &memoryStateStore{state: PersistentState{Target: config.PagesTarget}}
	client := &mutableRecordClient{record: testRecord(config, config.PagesTarget)}
	controller, err := NewController(context.Background(), config, client, state, log.New(&bytes.Buffer{}, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	controller.observe(context.Background(), start, fmt.Errorf("forced probe failure"))
	controller.observe(context.Background(), start.Add(20*time.Second), fmt.Errorf("forced probe failure"))
	controller.observe(context.Background(), start.Add(40*time.Second), fmt.Errorf("forced probe failure"))
	if len(client.patched) != 1 || client.patched[0] != config.TunnelTarget {
		t.Fatalf("record updates = %#v, want only the tunnel target", client.patched)
	}
	if client.getCalls != 3 {
		t.Fatalf("record reads = %d, want startup, pre-write, and post-intent reads", client.getCalls)
	}
	if state.state.Target != config.TunnelTarget || len(state.state.Changes) != 1 {
		t.Fatalf("persisted switch state = %#v, want tunnel target and one change", state.state)
	}
}

func TestRecordFailureAlertsIncludeOnlySafeCause(t *testing.T) {
	config := testConfig()
	config.WritesEnabled = true

	var readLogs bytes.Buffer
	readCause := fmt.Errorf("private endpoint detail: %w", context.DeadlineExceeded)
	_, err := NewController(
		context.Background(), config,
		&fakeRecordClient{getErr: readCause},
		&memoryStateStore{}, log.New(&readLogs, "", 0), NewMetrics(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(readLogs.String(), "event=record_read_failed") || !strings.Contains(readLogs.String(), "cause=timeout") {
		t.Fatalf("record read alert did not include its safe cause: %s", readLogs.String())
	}
	if strings.Contains(readLogs.String(), "private endpoint detail") || strings.Contains(readLogs.String(), "deadline exceeded") {
		t.Fatalf("record read alert exposed the underlying error: %s", readLogs.String())
	}

	state := &memoryStateStore{state: PersistentState{Target: config.PagesTarget}}
	client := &fakeRecordClient{
		records: []DNSRecord{
			testRecord(config, config.PagesTarget),
			testRecord(config, config.PagesTarget),
			testRecord(config, config.PagesTarget),
		},
		patchErr: fmt.Errorf("private API detail: %w", context.DeadlineExceeded),
	}
	var patchLogs bytes.Buffer
	controller, err := NewController(context.Background(), config, client, state, log.New(&patchLogs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	for attempt := 0; attempt < 3; attempt++ {
		controller.observe(context.Background(), start.Add(time.Duration(attempt)*probeInterval), errors.New("probe failed"))
	}
	if !strings.Contains(patchLogs.String(), "event=record_patch_failed") || !strings.Contains(patchLogs.String(), "cause=timeout") {
		t.Fatalf("record patch alert did not include its safe cause: %s", patchLogs.String())
	}
	if strings.Contains(patchLogs.String(), "private API detail") || strings.Contains(patchLogs.String(), "deadline exceeded") {
		t.Fatalf("record patch alert exposed the underlying error: %s", patchLogs.String())
	}
}

func TestPatchFailureAlertDeduplicatesUntilSuccessfulPatch(t *testing.T) {
	config := testConfig()
	config.WritesEnabled = true
	state := &memoryStateStore{state: PersistentState{Target: config.PagesTarget}}
	client := &mutableRecordClient{
		record: testRecord(config, config.PagesTarget),
		patchErrors: []error{
			errors.New("first simulated patch failure"),
			errors.New("second simulated patch failure"),
			nil,
			errors.New("failback patch failure"),
		},
	}
	var logs bytes.Buffer
	controller, err := NewController(context.Background(), config, client, state, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	events := &recordingAlertSink{}
	controller.alertSink = events

	start := time.Now()
	for attempt := 0; attempt < 3; attempt++ {
		controller.observe(context.Background(), start.Add(time.Duration(attempt)*probeInterval), errors.New("probe failed"))
	}
	if got := events.count("record_patch_failed"); got != 1 {
		t.Fatalf("first patch failure emitted %d Warning Events, want 1", got)
	}

	controller.retryRecordValidation(context.Background())
	controller.observe(context.Background(), start.Add(3*probeInterval), errors.New("probe failed"))
	if got := events.count("record_patch_failed"); got != 1 {
		t.Fatalf("repeated patch failure emitted %d Warning Events, want 1", got)
	}

	controller.retryRecordValidation(context.Background())
	controller.observe(context.Background(), start.Add(4*probeInterval), errors.New("probe failed"))
	if client.record.Content != config.TunnelTarget {
		t.Fatalf("successful patch target = %q, want tunnel target", client.record.Content)
	}
	if got := events.count("record_patch_failed"); got != 1 {
		t.Fatalf("successful patch should not add a failure event, got %d", got)
	}

	controller.observe(context.Background(), start.Add(5*probeInterval), nil)
	controller.observe(context.Background(), start.Add(5*probeInterval+failbackWindow), nil)
	if client.record.Content != config.TunnelTarget {
		t.Fatalf("failed failback changed target to %q", client.record.Content)
	}
	if got := events.count("record_patch_failed"); got != 2 {
		t.Fatalf("patch failure after a successful patch emitted %d Warning Events, want 2 total", got)
	}
	controller.retryRecordValidation(context.Background())
	if got := events.count("record_patch_failed"); got != 2 {
		t.Fatalf("record validation cleared the deduplication state; events = %d, want 2", got)
	}
	if strings.Count(logs.String(), "event=record_patch_failed") != 2 {
		t.Fatalf("patch failure logs do not match Warning Event deduplication: %s", logs.String())
	}
}

func TestStartupValidationRetriesTransientFailures(t *testing.T) {
	config := testConfig()
	config.WritesEnabled = true
	state := &memoryStateStore{state: PersistentState{Target: config.PagesTarget}}
	client := &fakeRecordClient{
		getErrors: []error{fmt.Errorf("temporary Cloudflare error: %w", context.DeadlineExceeded)},
		records:   []DNSRecord{testRecord(config, config.PagesTarget)},
	}
	var logs bytes.Buffer
	controller, err := NewController(context.Background(), config, client, state, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	if !controller.SafetyLocked() {
		t.Fatal("startup write access must remain locked after a transient record read failure")
	}
	controller.retryRecordValidation(context.Background())
	if controller.SafetyLocked() || controller.CurrentTarget() != config.PagesTarget {
		t.Fatal("record validation did not recover after the transient Cloudflare error")
	}
	if !strings.Contains(logs.String(), "event=record_validation_recovered") {
		t.Fatalf("recovered validation was not logged: %s", logs.String())
	}

	state = &memoryStateStore{
		state:      PersistentState{Target: config.PagesTarget},
		loadErrors: []error{fmt.Errorf("temporary Kubernetes error: %w", context.DeadlineExceeded)},
	}
	client = &fakeRecordClient{records: []DNSRecord{
		testRecord(config, config.PagesTarget),
		testRecord(config, config.PagesTarget),
	}}
	controller, err = NewController(context.Background(), config, client, state, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	if !controller.SafetyLocked() {
		t.Fatal("startup write access must remain locked after a transient state read failure")
	}
	controller.retryRecordValidation(context.Background())
	if controller.SafetyLocked() || controller.CurrentTarget() != config.PagesTarget {
		t.Fatal("record validation did not recover after the transient Kubernetes error")
	}
}

func TestPendingTransitionReconcilesAfterFinalStateSaveFailure(t *testing.T) {
	config := testConfig()
	config.WritesEnabled = true
	config.InitialTarget = config.TunnelTarget
	state := &memoryStateStore{
		state:      PersistentState{Target: config.TunnelTarget},
		saveErrors: []error{nil, nil, errors.New("simulated final state save failure")},
	}
	client := &mutableRecordClient{record: testRecord(config, config.TunnelTarget)}
	var logs bytes.Buffer
	controller, err := NewController(context.Background(), config, client, state, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now().Add(-failbackWindow)
	controller.observe(context.Background(), start, nil)
	controller.observe(context.Background(), start.Add(failbackWindow), nil)
	if client.record.Content != config.PagesTarget {
		t.Fatalf("Cloudflare target after failback = %q, want Pages target", client.record.Content)
	}
	if controller.recordSafe {
		t.Fatal("failed final state save must keep writes locked until reconciliation")
	}
	if state.state.Pending == nil || state.state.Pending.To != config.PagesTarget {
		t.Fatalf("failed final state save lost its pending transition: %#v", state.state)
	}
	if !state.state.Pending.PatchVerified {
		t.Fatalf("failed final state save lost the verified PATCH marker: %#v", state.state.Pending)
	}

	restarted, err := NewController(context.Background(), config, client, state, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	if restarted.SafetyLocked() || restarted.CurrentTarget() != config.PagesTarget {
		t.Fatal("monitor did not reconcile its own DNS transition after restart")
	}
	if state.state.Pending != nil || state.state.Target != config.PagesTarget || len(state.state.Changes) != 1 {
		t.Fatalf("reconciled state did not commit the failback exactly once: %#v", state.state)
	}
}

func TestPatchErrorThatAppliedTransitionRecoversOnRevalidation(t *testing.T) {
	config := testConfig()
	config.WritesEnabled = true
	state := &memoryStateStore{state: PersistentState{Target: config.PagesTarget}}
	client := &mutableRecordClient{
		record:           testRecord(config, config.PagesTarget),
		patchErrors:      []error{errors.New("simulated Cloudflare timeout")},
		applyPatchErrors: true,
	}
	var logs bytes.Buffer
	controller, err := NewController(context.Background(), config, client, state, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	for attempt := 0; attempt < 3; attempt++ {
		controller.observe(context.Background(), start.Add(time.Duration(attempt)*probeInterval), errors.New("probe failed"))
	}
	if client.record.Content != config.TunnelTarget || !controller.SafetyLocked() {
		t.Fatalf("ambiguous PATCH did not leave the monitor locked on the applied target: record=%q locked=%t", client.record.Content, controller.SafetyLocked())
	}
	if state.state.Pending == nil || state.state.Pending.PatchVerified {
		t.Fatalf("failed PATCH did not leave an unverified journal entry: %#v", state.state)
	}

	controller.retryRecordValidation(context.Background())
	if controller.SafetyLocked() || controller.CurrentTarget() != config.TunnelTarget {
		t.Fatalf("revalidation did not recover the applied PATCH: locked=%t target=%q logs=%s", controller.SafetyLocked(), controller.CurrentTarget(), logs.String())
	}
	if state.state.Pending != nil || state.state.Target != config.TunnelTarget || len(state.state.Changes) != 1 {
		t.Fatalf("revalidation did not persist the verified transition exactly once: %#v", state.state)
	}
	if !strings.Contains(logs.String(), "event=record_patch_recovered") {
		t.Fatalf("recovered PATCH was not logged: %s", logs.String())
	}
}

func TestRejectedPatchDoesNotRecoverFromOperatorEdit(t *testing.T) {
	config := testConfig()
	config.WritesEnabled = true
	state := &memoryStateStore{state: PersistentState{Target: config.PagesTarget}}
	client := &mutableRecordClient{
		record:      testRecord(config, config.PagesTarget),
		patchErrors: []error{safePatchRejection("cloudflare_http_status_403")},
	}
	var logs bytes.Buffer
	controller, err := NewController(context.Background(), config, client, state, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	for attempt := 0; attempt < 3; attempt++ {
		controller.observe(context.Background(), start.Add(time.Duration(attempt)*probeInterval), errors.New("probe failed"))
	}
	if client.record.Content != config.PagesTarget || !controller.SafetyLocked() {
		t.Fatalf("rejected PATCH changed the target or unlocked writes: record=%q locked=%t", client.record.Content, controller.SafetyLocked())
	}
	if state.state.Pending == nil || state.state.Pending.PatchVerified {
		t.Fatalf("rejected PATCH did not leave an unverified journal entry: %#v", state.state)
	}

	client.record.Content = config.TunnelTarget
	controller.retryRecordValidation(context.Background())
	if !controller.SafetyLocked() || controller.recordSafe || state.state.Pending == nil || state.state.Pending.PatchVerified {
		t.Fatalf("operator edit was trusted as a rejected PATCH: locked=%t recordSafe=%t state=%#v logs=%s", controller.SafetyLocked(), controller.recordSafe, state.state, logs.String())
	}
	if !strings.Contains(logs.String(), "event=pending_state_unsubmitted") {
		t.Fatalf("rejected PATCH followed by an operator edit was not reported: %s", logs.String())
	}
}

func TestPendingSaveThatPersistsBeforeErrorRecoversAndRestarts(t *testing.T) {
	config := testConfig()
	config.WritesEnabled = true
	state := &memoryStateStore{
		state:                  PersistentState{Target: config.PagesTarget},
		saveErrorsAfterPersist: []error{errors.New("simulated timeout after journal persisted")},
	}
	client := &mutableRecordClient{record: testRecord(config, config.PagesTarget)}
	var logs bytes.Buffer
	controller, err := NewController(context.Background(), config, client, state, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	for attempt := 0; attempt < 3; attempt++ {
		controller.observe(context.Background(), start.Add(time.Duration(attempt)*probeInterval), errors.New("probe failed"))
	}
	if !controller.SafetyLocked() || state.state.Pending == nil || len(client.patched) != 0 {
		t.Fatalf("timed-out journal save did not leave an unsubmitted intent safely locked: locked=%t state=%#v patches=%v", controller.SafetyLocked(), state.state, client.patched)
	}

	controller.retryRecordValidation(context.Background())
	if controller.SafetyLocked() || state.state.Pending != nil || state.state.Target != config.PagesTarget {
		t.Fatalf("revalidation did not clear the unsubmitted intent after the timeout: locked=%t state=%#v logs=%s", controller.SafetyLocked(), state.state, logs.String())
	}

	restarted, err := NewController(context.Background(), config, client, state, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	if restarted.SafetyLocked() {
		t.Fatalf("restart remained locked after revalidation cleared the pending intent: %#v", state.state)
	}
}

func TestVerifiedPendingSaveRetriesOnRevalidation(t *testing.T) {
	config := testConfig()
	config.WritesEnabled = true
	state := &memoryStateStore{
		state:      PersistentState{Target: config.PagesTarget},
		saveErrors: []error{nil, errors.New("simulated verified state save failure")},
	}
	client := &mutableRecordClient{record: testRecord(config, config.PagesTarget)}
	var logs bytes.Buffer
	controller, err := NewController(context.Background(), config, client, state, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	for attempt := 0; attempt < 3; attempt++ {
		controller.observe(context.Background(), start.Add(time.Duration(attempt)*probeInterval), errors.New("probe failed"))
	}
	if client.record.Content != config.TunnelTarget || !controller.SafetyLocked() {
		t.Fatalf("verified-state save failure did not keep writes locked: record=%q locked=%t", client.record.Content, controller.SafetyLocked())
	}
	if state.state.Pending == nil || state.state.Pending.PatchVerified {
		t.Fatalf("failed verified-state save unexpectedly updated the journal: %#v", state.state)
	}

	controller.retryRecordValidation(context.Background())
	if controller.SafetyLocked() || state.state.Pending != nil || state.state.Target != config.TunnelTarget || len(state.state.Changes) != 1 {
		t.Fatalf("validation did not retry the verified-state save: locked=%t state=%#v logs=%s", controller.SafetyLocked(), state.state, logs.String())
	}
}

func TestDNSWriteRequiresPendingStateToBeSaved(t *testing.T) {
	config := testConfig()
	config.WritesEnabled = true
	state := &memoryStateStore{
		state:      PersistentState{Target: config.PagesTarget},
		saveErrors: []error{errors.New("simulated pending state save failure")},
	}
	client := &mutableRecordClient{record: testRecord(config, config.PagesTarget)}
	controller, err := NewController(context.Background(), config, client, state, log.New(&bytes.Buffer{}, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	for attempt := 0; attempt < 3; attempt++ {
		controller.observe(context.Background(), start.Add(time.Duration(attempt)*probeInterval), errors.New("probe failed"))
	}
	if len(client.patched) != 0 || client.record.Content != config.PagesTarget {
		t.Fatalf("DNS changed without persisted pending state: patches=%v record=%q", client.patched, client.record.Content)
	}
	if controller.recordSafe || state.state.Pending != nil {
		t.Fatal("failed pending-state save must block writes without persisting an incomplete transition")
	}
}

func TestDNSWriteRevalidatesRecordAfterSavingPendingState(t *testing.T) {
	config := testConfig()
	config.WritesEnabled = true
	client := &mutableRecordClient{record: testRecord(config, config.PagesTarget)}
	state := &memoryStateStore{
		state: PersistentState{Target: config.PagesTarget},
		saveHook: func(saved PersistentState) {
			if saved.Pending != nil {
				client.record.Content = config.TunnelTarget
			}
		},
	}
	var logs bytes.Buffer
	controller, err := NewController(context.Background(), config, client, state, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	for attempt := 0; attempt < 3; attempt++ {
		controller.observe(context.Background(), start.Add(time.Duration(attempt)*probeInterval), errors.New("probe failed"))
	}
	if len(client.patched) != 0 {
		t.Fatalf("Cloudflare patch was submitted after the record changed during intent save: %v", client.patched)
	}
	if state.state.Pending != nil || state.state.Target != config.PagesTarget || len(state.state.Changes) != 0 {
		t.Fatalf("unsubmitted transition was not canceled: %#v", state.state)
	}
	if !controller.SafetyLocked() || client.getCalls != 3 {
		t.Fatalf("drift was not revalidated and locked: safetyLocked=%t recordReads=%d", controller.SafetyLocked(), client.getCalls)
	}
	if !strings.Contains(logs.String(), "event=record_drift_after_intent") {
		t.Fatalf("post-intent record drift was not reported: %s", logs.String())
	}
}

func TestUnsubmittedPendingIntentCannotUnlockAfterCancelSaveFailure(t *testing.T) {
	config := testConfig()
	config.WritesEnabled = true
	state := &memoryStateStore{
		state:      PersistentState{Target: config.PagesTarget},
		saveErrors: []error{nil, errors.New("simulated pending cancellation save failure")},
	}
	client := &mutableRecordClient{record: testRecord(config, config.PagesTarget)}
	state.saveHook = func(saved PersistentState) {
		if saved.Pending != nil {
			client.record.Content = config.TunnelTarget
		}
	}
	var logs bytes.Buffer
	controller, err := NewController(context.Background(), config, client, state, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	for attempt := 0; attempt < 3; attempt++ {
		controller.observe(context.Background(), start.Add(time.Duration(attempt)*probeInterval), errors.New("probe failed"))
	}
	if len(client.patched) != 0 || state.state.Pending == nil {
		t.Fatalf("drifted record was patched or cancellation failure lost the pending intent: patches=%v state=%#v", client.patched, state.state)
	}
	if !controller.SafetyLocked() {
		t.Fatal("cancellation save failure did not lock writes")
	}

	controller.retryRecordValidation(context.Background())
	if !controller.SafetyLocked() || state.state.Pending == nil || len(client.patched) != 0 {
		t.Fatalf("revalidation trusted an unsubmitted pending transition: locked=%t state=%#v patches=%v logs=%s", controller.SafetyLocked(), state.state, client.patched, logs.String())
	}

	restarted, err := NewController(context.Background(), config, client, state, log.New(&logs, "", 0), NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	if !restarted.SafetyLocked() || state.state.Pending == nil {
		t.Fatalf("restart trusted an unsubmitted pending transition: locked=%t state=%#v logs=%s", restarted.SafetyLocked(), state.state, logs.String())
	}
	if !strings.Contains(logs.String(), "event=pending_state_unsubmitted") {
		t.Fatalf("unsubmitted pending transition was not reported: %s", logs.String())
	}
}

func TestRestartWithUnverifiedPendingIntentLocksAtOriginalTarget(t *testing.T) {
	config := testConfig()
	config.WritesEnabled = true
	state := &memoryStateStore{
		state: PersistentState{
			Target: config.PagesTarget,
			Pending: &PendingTransition{
				From: config.PagesTarget,
				To:   config.TunnelTarget,
				At:   time.Now(),
			},
		},
	}
	var logs bytes.Buffer
	controller, err := NewController(
		context.Background(), config,
		&mutableRecordClient{record: testRecord(config, config.PagesTarget)},
		state,
		log.New(&logs, "", 0),
		NewMetrics(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !controller.SafetyLocked() || state.state.Pending == nil {
		t.Fatalf("restart unlocked an unverified pending intent at its original target: locked=%t state=%#v", controller.SafetyLocked(), state.state)
	}
	if !strings.Contains(logs.String(), "event=pending_state_unsubmitted") {
		t.Fatalf("restart did not report its unverified pending intent: %s", logs.String())
	}
}

func testRecord(config Config, target string) DNSRecord {
	return DNSRecord{
		ID:      config.RecordID,
		Name:    recordName,
		Type:    recordType,
		Content: target,
		Proxied: true,
	}
}

type fakeRecordClient struct {
	records   []DNSRecord
	patched   []string
	getErr    error
	getErrors []error
	patchErr  error
}

func (client *fakeRecordClient) GetRecord(context.Context) (DNSRecord, error) {
	if len(client.getErrors) != 0 {
		err := client.getErrors[0]
		client.getErrors = client.getErrors[1:]
		if err != nil {
			return DNSRecord{}, err
		}
	}
	if client.getErr != nil {
		return DNSRecord{}, client.getErr
	}
	if len(client.records) == 0 {
		return DNSRecord{}, fmt.Errorf("no fake record left")
	}
	record := client.records[0]
	client.records = client.records[1:]
	return record, nil
}

func (client *fakeRecordClient) PatchTarget(_ context.Context, target string) (DNSRecord, error) {
	client.patched = append(client.patched, target)
	if client.patchErr != nil {
		return DNSRecord{}, client.patchErr
	}
	return DNSRecord{}, nil
}

type memoryStateStore struct {
	state                  PersistentState
	loadErrors             []error
	saveErrors             []error
	saveErrorsAfterPersist []error
	saveHook               func(PersistentState)
}

type mutableRecordClient struct {
	record           DNSRecord
	getCalls         int
	patched          []string
	patchErrors      []error
	applyPatchErrors bool
}

func (client *mutableRecordClient) GetRecord(context.Context) (DNSRecord, error) {
	client.getCalls++
	return client.record, nil
}

func (client *mutableRecordClient) PatchTarget(_ context.Context, target string) (DNSRecord, error) {
	client.patched = append(client.patched, target)
	if len(client.patchErrors) != 0 {
		err := client.patchErrors[0]
		client.patchErrors = client.patchErrors[1:]
		if err != nil {
			if client.applyPatchErrors {
				client.record.Content = target
				client.record.Proxied = true
			}
			return DNSRecord{}, err
		}
	}
	client.record.Content = target
	client.record.Proxied = true
	return client.record, nil
}

type recordingAlertSink struct {
	keys []string
}

func (sink *recordingAlertSink) PublishWarning(_ context.Context, key, _ string) error {
	sink.keys = append(sink.keys, key)
	return nil
}

func (sink *recordingAlertSink) count(key string) int {
	count := 0
	for _, eventKey := range sink.keys {
		if eventKey == key {
			count++
		}
	}
	return count
}

func (store *memoryStateStore) Load(context.Context) (PersistentState, stateLoadStatus, error) {
	if len(store.loadErrors) != 0 {
		err := store.loadErrors[0]
		store.loadErrors = store.loadErrors[1:]
		if err != nil {
			return PersistentState{}, stateLoadExisting, err
		}
	}
	return store.state, stateLoadExisting, nil
}

func (store *memoryStateStore) Save(_ context.Context, state PersistentState) error {
	if len(store.saveErrors) != 0 {
		err := store.saveErrors[0]
		store.saveErrors = store.saveErrors[1:]
		if err != nil {
			return err
		}
	}
	store.state = state
	if store.saveHook != nil {
		store.saveHook(state)
	}
	if len(store.saveErrorsAfterPersist) != 0 {
		err := store.saveErrorsAfterPersist[0]
		store.saveErrorsAfterPersist = store.saveErrorsAfterPersist[1:]
		if err != nil {
			return err
		}
	}
	return nil
}
