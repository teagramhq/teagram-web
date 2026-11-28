package main

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

type Probe func(context.Context, Config) error

type AlertSink interface {
	PublishWarning(context.Context, string, string) error
}

type Controller struct {
	config       Config
	recordClient RecordClient
	stateStore   StateStore
	logger       *log.Logger
	metrics      *Metrics
	alertSink    AlertSink
	target       string
	history      []time.Time
	failures     int
	healthySince time.Time
	recordSafe   bool
	// pendingPatchRecovery records this process's pending intent and verified outcome.
	// A readback can resolve ambiguous API results, while a restart stays fail-closed.
	pendingPatchRecovery  *PendingTransition
	pendingPatchAttempted bool
	alerts                map[string]bool
	mu                    sync.Mutex
}

func NewController(ctx context.Context, config Config, recordClient RecordClient, stateStore StateStore, logger *log.Logger, metrics *Metrics) (*Controller, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if logger == nil {
		logger = log.Default()
	}
	if metrics == nil {
		metrics = NewMetrics()
	}
	initialTarget, _ := normalizeTarget(config.InitialTarget)
	controller := &Controller{
		config:       config,
		recordClient: recordClient,
		stateStore:   stateStore,
		logger:       logger,
		metrics:      metrics,
		target:       initialTarget,
		alerts:       make(map[string]bool),
	}
	if sink, ok := stateStore.(AlertSink); ok {
		controller.alertSink = sink
	}
	finish := func() (*Controller, error) {
		controller.updateMetrics(time.Now())
		return controller, nil
	}
	if recordClient == nil {
		if config.WritesEnabled {
			return nil, fmt.Errorf("Cloudflare token is required when writes are enabled")
		}
		controller.logger.Printf("level=info event=record_validation_skipped reason=token_missing mode=dry-run")
		return finish()
	}
	if stateStore == nil {
		controller.alert("state_store_missing", "persistent switch state is unavailable; record writes are disabled")
		return finish()
	}
	controller.validateRecordState(ctx)
	return finish()
}

func (controller *Controller) validateRecordState(ctx context.Context) bool {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if controller.recordClient == nil || controller.stateStore == nil {
		return false
	}

	record, err := controller.recordClient.GetRecord(ctx)
	if err != nil {
		controller.recordSafe = false
		controller.alert("record_read_failed", messageWithSafeCause("startup record validation failed; record writes are disabled", err))
		return false
	}
	currentTarget, err := validateRecord(record, controller.config)
	if err != nil {
		controller.recordSafe = false
		controller.alert("record_invalid", "startup record validation refused the configured record")
		return false
	}

	state, loadStatus, err := controller.stateStore.Load(ctx)
	switch loadStatus {
	case stateLoadInitialized:
		controller.alertEvery("state_configmap_initialized", "persistent state ConfigMap was initialized for first use")
	case stateLoadLost:
		controller.recordSafe = false
		controller.alert("state_configmap_lost", "state ConfigMap or its state.json data is missing; change history or a pending transition may have been lost; record writes are disabled")
		return false
	}
	if err != nil {
		controller.recordSafe = false
		controller.alert("state_read_failed", messageWithSafeCause("persistent switch state could not be read; record writes are disabled", err))
		return false
	}
	now := time.Now()
	state.Changes = recentChanges(state.Changes, now)
	recoveredPatch := false
	clearPendingRecovery := false
	if state.Pending == nil && controller.pendingPatchRecovery != nil {
		pending := controller.pendingPatchRecovery
		switch {
		case pending.PatchVerified && currentTarget == pending.To && state.Target == currentTarget:
			recoveredPatch = true
		case !pending.PatchVerified && currentTarget == pending.From && state.Target == currentTarget:
			controller.pendingPatchRecovery = nil
			controller.pendingPatchAttempted = false
		default:
			controller.recordSafe = false
			controller.alert("pending_state_unsubmitted", "DNS transition state does not match the attempted PATCH; record writes are disabled")
			return false
		}
	}
	if state.Pending != nil {
		from, fromErr := normalizeTarget(state.Pending.From)
		to, toErr := normalizeTarget(state.Pending.To)
		if fromErr != nil || toErr != nil || from == to || from != state.Target || state.Pending.At.IsZero() ||
			(from != normalizedPagesTarget(controller.config) && from != normalizedTunnelTarget(controller.config)) ||
			(to != normalizedPagesTarget(controller.config) && to != normalizedTunnelTarget(controller.config)) {
			controller.recordSafe = false
			controller.alert("pending_state_invalid", "pending DNS transition state was invalid; record writes are disabled")
			return false
		}
		if currentTarget != from && currentTarget != to {
			controller.recordSafe = false
			controller.alert("record_drift", "Cloudflare record changed outside the monitor; record writes are disabled")
			return false
		}
		matchesPatchRecovery := samePendingTransition(controller.pendingPatchRecovery, state.Pending)
		patchVerifiedInMemory := matchesPatchRecovery && controller.pendingPatchRecovery.PatchVerified
		if state.Pending.PatchVerified || patchVerifiedInMemory {
			if currentTarget != to {
				controller.recordSafe = false
				controller.alert("record_drift", "Cloudflare record changed outside the monitor; record writes are disabled")
				return false
			}
			if matchesPatchRecovery {
				recoveredPatch = true
			}
			if !state.Pending.PatchVerified {
				verifiedPending := *state.Pending
				verifiedPending.PatchVerified = true
				state.Pending = &verifiedPending
				controller.pendingPatchRecovery = &verifiedPending
				if err := controller.stateStore.Save(ctx, state); err != nil {
					controller.recordSafe = false
					controller.alert("state_pending_verify_failed", messageWithSafeCause("DNS changed but its verified transition could not be persisted; future writes are disabled", err))
					return false
				}
			}
			state.Target = to
			state.Changes = append(state.Changes, state.Pending.At)
		} else if currentTarget == to {
			if !matchesPatchRecovery || !controller.pendingPatchAttempted {
				controller.recordSafe = false
				controller.alert("pending_state_unsubmitted", "DNS target matches a transition without a verified PATCH; record writes are disabled")
				return false
			}
			verifiedPending := *state.Pending
			verifiedPending.PatchVerified = true
			state.Pending = &verifiedPending
			controller.pendingPatchRecovery = &verifiedPending
			recoveredPatch = true
			if err := controller.stateStore.Save(ctx, state); err != nil {
				controller.recordSafe = false
				controller.alert("state_pending_verify_failed", messageWithSafeCause("DNS changed but its verified transition could not be persisted; future writes are disabled", err))
				return false
			}
			state.Target = to
			state.Changes = append(state.Changes, state.Pending.At)
		} else if matchesPatchRecovery {
			clearPendingRecovery = true
		} else {
			controller.recordSafe = false
			controller.alert("pending_state_unsubmitted", "pending DNS transition has no process-local PATCH evidence; record writes are disabled")
			return false
		}
		state.Pending = nil
		if err := controller.stateStore.Save(ctx, state); err != nil {
			controller.recordSafe = false
			controller.alert("state_reconcile_failed", messageWithSafeCause("pending DNS transition could not be reconciled; record writes are disabled", err))
			return false
		}
		if clearPendingRecovery {
			controller.pendingPatchRecovery = nil
			controller.pendingPatchAttempted = false
		}
		controller.logger.Printf("level=info event=pending_dns_transition_reconciled target=%s", currentTarget)
	}

	if state.Target == "" {
		state.Target = currentTarget
		if err := controller.stateStore.Save(ctx, state); err != nil {
			controller.recordSafe = false
			controller.alert("state_initialize_failed", messageWithSafeCause("persistent switch state could not be initialized; record writes are disabled", err))
			return false
		}
	} else {
		storedTarget, normalizeErr := normalizeTarget(state.Target)
		if normalizeErr != nil || storedTarget != currentTarget {
			controller.recordSafe = false
			controller.alert("record_drift", "Cloudflare record changed outside the monitor; record writes are disabled")
			return false
		}
	}
	if len(state.Changes) >= maxChanges && currentTarget != normalizedTunnelTarget(controller.config) {
		controller.recordSafe = false
		controller.alert("change_cap_state_invalid", "DNS change cap is exhausted while the current target is not the tunnel")
		return false
	}
	controller.target = currentTarget
	controller.history = state.Changes
	controller.recordSafe = true
	controller.updateMetrics(time.Now())
	if recoveredPatch {
		if controller.clearAlert("record_patch_failed") {
			controller.logger.Printf("level=info event=record_patch_recovered")
		}
		controller.pendingPatchRecovery = nil
		controller.pendingPatchAttempted = false
	}
	if controller.clearValidationAlerts() {
		controller.logger.Printf("level=info event=record_validation_recovered")
	}
	return true
}

func (controller *Controller) retryRecordValidation(ctx context.Context) {
	controller.mu.Lock()
	needsValidation := controller.recordClient != nil && controller.stateStore != nil && !controller.recordSafe
	controller.mu.Unlock()
	if needsValidation {
		controller.validateRecordState(ctx)
	}
}

func (controller *Controller) clearValidationAlerts() bool {
	cleared := false
	for _, key := range []string{
		"record_read_failed", "record_invalid", "state_read_failed", "state_initialize_failed", "state_configmap_lost",
		"state_reconcile_failed", "pending_state_invalid", "record_drift", "change_cap_state_invalid",
		"record_read_before_write_failed", "record_invalid_before_write", "record_drift_before_write",
		"record_read_after_intent_failed", "record_invalid_after_intent", "record_drift_after_intent",
		"state_pending_cancel_failed", "pending_state_unsubmitted",
		"state_pending_failed", "state_pending_verify_failed", "record_patch_unverified", "state_write_failed",
		"record_write_blocked",
	} {
		if controller.alerts[key] {
			delete(controller.alerts, key)
			cleared = true
		}
	}
	return cleared
}

func (controller *Controller) clearAlert(key string) bool {
	if !controller.alerts[key] {
		return false
	}
	delete(controller.alerts, key)
	return true
}

func (controller *Controller) Run(ctx context.Context, probe Probe) {
	ticker := time.NewTicker(probeInterval)
	defer ticker.Stop()
	for {
		controller.retryRecordValidation(ctx)
		probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
		err := probe(probeCtx, controller.config)
		cancel()
		controller.observe(ctx, time.Now(), err)

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (controller *Controller) observe(ctx context.Context, now time.Time, probeErr error) {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if probeErr != nil {
		controller.failures++
		controller.healthySince = time.Time{}
		controller.metrics.setProbe(false, now)
		controller.updateMetrics(now)
		controller.logger.Printf("level=warn event=pages_probe result=unhealthy consecutive_failures=%d reason=%q", controller.failures, safeFailureCause(probeErr))
		if controller.failures >= 3 && controller.target == normalizedPagesTarget(controller.config) {
			controller.switchTo(ctx, normalizedTunnelTarget(controller.config), "pages_unhealthy", now)
		}
		return
	}

	controller.failures = 0
	controller.metrics.setProbe(true, now)
	controller.updateMetrics(now)
	if controller.healthySince.IsZero() {
		controller.healthySince = now
	}
	if controller.target == normalizedTunnelTarget(controller.config) && controller.config.FailbackEnabled && now.Sub(controller.healthySince) >= failbackWindow {
		controller.switchTo(ctx, normalizedPagesTarget(controller.config), "pages_healthy_for_failback_window", now)
	}
}

func (controller *Controller) switchTo(ctx context.Context, target, reason string, now time.Time) {
	defer controller.updateMetrics(now)
	target, err := normalizeTarget(target)
	if err != nil || target == controller.target {
		return
	}
	controller.history = recentChanges(controller.history, now)
	controller.clearExpiredChangeCapAlerts()
	if len(controller.history) >= maxChanges {
		if controller.target == normalizedTunnelTarget(controller.config) {
			controller.alert("change_cap_exhausted", "DNS change cap reached; holding the tunnel target")
		} else {
			controller.alert("change_cap_state_invalid", "DNS change cap is exhausted while the current target is not the tunnel")
		}
		return
	}
	if target == normalizedPagesTarget(controller.config) && len(controller.history) >= maxChanges-1 {
		controller.alert("change_cap_reserve", "DNS change cap reserve is holding the tunnel target")
		return
	}
	if !controller.config.WritesEnabled {
		controller.logger.Printf("level=info event=failover_decision mode=dry-run message=%q reason=%s", "would switch to "+target, reason)
		controller.target = target
		controller.history = append(controller.history, now)
		controller.metrics.recordSwitch(targetLabel(target, controller.config), true)
		controller.updateMetrics(now)
		if len(controller.history) >= maxChanges && target == normalizedTunnelTarget(controller.config) {
			controller.alert("change_cap_exhausted", "DNS change cap reached; holding the tunnel target")
		}
		return
	}
	if !controller.recordSafe || controller.recordClient == nil || controller.stateStore == nil {
		controller.alert("record_write_blocked", "record write refused because startup validation did not pass")
		return
	}

	currentRecord, err := controller.recordClient.GetRecord(ctx)
	if err != nil {
		controller.recordSafe = false
		controller.alert("record_read_before_write_failed", messageWithSafeCause("record write refused because the current record could not be read", err))
		return
	}
	currentTarget, err := validateRecord(currentRecord, controller.config)
	if err != nil {
		controller.recordSafe = false
		controller.alert("record_invalid_before_write", "record write refused because the record no longer matches the allowed configuration")
		return
	}
	if currentTarget != controller.target {
		controller.recordSafe = false
		controller.alert("record_drift_before_write", "record write refused because the DNS target changed outside the monitor")
		return
	}

	pendingState := PersistentState{
		Target:  controller.target,
		Changes: controller.history,
		Pending: &PendingTransition{From: controller.target, To: target, At: now},
	}
	attemptedPending := *pendingState.Pending
	controller.pendingPatchRecovery = &attemptedPending
	controller.pendingPatchAttempted = false
	if err := controller.stateStore.Save(ctx, pendingState); err != nil {
		controller.recordSafe = false
		controller.alert("state_pending_failed", messageWithSafeCause("DNS update was not attempted because its pending transition could not be saved", err))
		return
	}
	intentCheckRecord, err := controller.recordClient.GetRecord(ctx)
	if err != nil {
		controller.cancelPendingTransition(
			ctx,
			"record_read_after_intent_failed",
			messageWithSafeCause("record write was refused because the DNS record could not be revalidated after saving its transition intent", err),
		)
		return
	}
	intentCheckTarget, err := validateRecord(intentCheckRecord, controller.config)
	if err != nil {
		controller.cancelPendingTransition(
			ctx,
			"record_invalid_after_intent",
			"record write was refused because the DNS record changed after saving its transition intent",
		)
		return
	}
	if intentCheckTarget != controller.target {
		controller.cancelPendingTransition(
			ctx,
			"record_drift_after_intent",
			"record write was refused because the DNS target changed after saving its transition intent",
		)
		return
	}

	controller.pendingPatchAttempted = true
	updatedRecord, err := controller.recordClient.PatchTarget(ctx, target)
	if err != nil {
		controller.recordSafe = false
		if isDefinitivePatchRejection(err) {
			controller.pendingPatchAttempted = false
		}
		controller.alert("record_patch_failed", messageWithSafeCause("Cloudflare refused the DNS record update", err))
		return
	}
	updatedTarget, err := validateRecord(updatedRecord, controller.config)
	if err != nil || updatedTarget != target {
		controller.recordSafe = false
		controller.alert("record_patch_unverified", "DNS record update response did not match the requested safe target")
		return
	}
	verifiedPending := *pendingState.Pending
	verifiedPending.PatchVerified = true
	controller.pendingPatchRecovery = &verifiedPending
	verifiedState := pendingState
	verifiedState.Pending = &verifiedPending
	if err := controller.stateStore.Save(ctx, verifiedState); err != nil {
		controller.recordSafe = false
		controller.alert("state_pending_verify_failed", messageWithSafeCause("DNS changed but its verified transition could not be persisted; future writes are disabled", err))
		return
	}
	if controller.clearAlert("record_patch_failed") {
		controller.logger.Printf("level=info event=record_patch_recovered")
	}

	newState := PersistentState{
		Target:  target,
		Changes: append(controller.history, now),
		Pending: nil,
	}
	if err := controller.stateStore.Save(ctx, newState); err != nil {
		controller.recordSafe = false
		controller.alert("state_write_failed", "DNS changed but persistent switch state could not be saved; future writes are disabled")
		return
	}
	controller.target = target
	controller.history = newState.Changes
	controller.pendingPatchRecovery = nil
	controller.pendingPatchAttempted = false
	controller.metrics.recordSwitch(targetLabel(target, controller.config), false)
	controller.updateMetrics(now)
	controller.logger.Printf("level=info event=dns_record_switched target=%s reason=%s", target, reason)
	if len(recentChanges(controller.history, now)) >= maxChanges && target == normalizedTunnelTarget(controller.config) {
		controller.alert("change_cap_exhausted", "DNS change cap reached; holding the tunnel target")
	}
}

func (controller *Controller) clearExpiredChangeCapAlerts() {
	if len(controller.history) < maxChanges {
		controller.clearAlert("change_cap_exhausted")
	}
	if len(controller.history) < maxChanges-1 {
		controller.clearAlert("change_cap_reserve")
	}
}

func (controller *Controller) cancelPendingTransition(ctx context.Context, key, message string) {
	controller.recordSafe = false
	state := PersistentState{Target: controller.target, Changes: controller.history}
	if err := controller.stateStore.Save(ctx, state); err != nil {
		controller.alert("state_pending_cancel_failed", messageWithSafeCause("unsubmitted DNS transition could not be canceled; record writes are disabled", err))
	} else {
		controller.pendingPatchRecovery = nil
		controller.pendingPatchAttempted = false
	}
	controller.alert(key, message)
}

func (controller *Controller) alert(key, message string) {
	if controller.alerts[key] {
		return
	}
	controller.alerts[key] = true
	controller.emitAlert(key, message)
}

func (controller *Controller) alertEvery(key, message string) {
	controller.emitAlert(key, message)
}

func (controller *Controller) emitAlert(key, message string) {
	controller.logger.Printf("level=alert event=%s message=%q", key, message)
	if controller.alertSink != nil {
		if err := controller.alertSink.PublishWarning(context.Background(), key, message); err != nil {
			controller.logger.Printf("level=warn event=alert_event_publish_failed reason=%q", alertReason(err))
		}
	}
}

func recentChanges(changes []time.Time, now time.Time) []time.Time {
	recent := make([]time.Time, 0, len(changes))
	for _, changedAt := range changes {
		if !changedAt.After(now) && now.Sub(changedAt) < changeWindow {
			recent = append(recent, changedAt)
		}
	}
	return recent
}

func samePendingTransition(first, second *PendingTransition) bool {
	return first != nil && second != nil && first.From == second.From && first.To == second.To && first.At.Equal(second.At)
}

func normalizedPagesTarget(config Config) string {
	target, _ := normalizeTarget(config.PagesTarget)
	return target
}

func normalizedTunnelTarget(config Config) string {
	target, _ := normalizeTarget(config.TunnelTarget)
	return target
}

func (controller *Controller) CurrentTarget() string {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	return controller.target
}

func (controller *Controller) SafetyLocked() bool {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	return !controller.recordSafe && controller.config.WritesEnabled
}

func (controller *Controller) ChangeCount(now time.Time) int {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	return len(recentChanges(controller.history, now))
}

func (controller *Controller) metricsHandler() *Metrics {
	return controller.metrics
}

func (controller *Controller) updateMetrics(now time.Time) {
	controller.metrics.setSafety(controller.config.WritesEnabled && !controller.recordSafe, targetLabel(controller.target, controller.config), len(recentChanges(controller.history, now)))
}

func targetLabel(target string, config Config) string {
	target, _ = normalizeTarget(target)
	if target == normalizedPagesTarget(config) {
		return "pages"
	}
	return "tunnel"
}

func alertReason(err error) string {
	if err == nil {
		return "unknown"
	}
	return strings.ReplaceAll(err.Error(), "\n", " ")
}
