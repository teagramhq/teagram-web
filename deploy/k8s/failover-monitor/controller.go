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
	alerts       map[string]bool
	mu           sync.Mutex
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

	record, err := recordClient.GetRecord(ctx)
	if err != nil {
		controller.alert("record_read_failed", "startup record validation failed; record writes are disabled")
		return finish()
	}
	currentTarget, err := validateRecord(record, config)
	if err != nil {
		controller.alert("record_invalid", "startup record validation refused the configured record")
		return finish()
	}
	controller.target = currentTarget

	state, err := stateStore.Load(ctx)
	if err != nil {
		controller.alert("state_read_failed", "persistent switch state could not be read; record writes are disabled")
		return finish()
	}
	controller.history = recentChanges(state.Changes, time.Now())
	if state.Target == "" {
		state.Target = currentTarget
		state.Changes = controller.history
		if err := stateStore.Save(ctx, state); err != nil {
			controller.alert("state_initialize_failed", "persistent switch state could not be initialized; record writes are disabled")
			return finish()
		}
	} else {
		storedTarget, normalizeErr := normalizeTarget(state.Target)
		if normalizeErr != nil || storedTarget != currentTarget {
			controller.alert("record_drift", "Cloudflare record changed outside the monitor; record writes are disabled")
			return finish()
		}
	}
	if len(controller.history) >= maxChanges && currentTarget != normalizedTunnelTarget(config) {
		controller.alert("change_cap_state_invalid", "DNS change cap is exhausted while the current target is not the tunnel")
		return finish()
	}
	controller.recordSafe = true
	return finish()
}

func (controller *Controller) Run(ctx context.Context, probe Probe) {
	ticker := time.NewTicker(probeInterval)
	defer ticker.Stop()
	for {
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
		controller.logger.Printf("level=warn event=pages_probe result=unhealthy consecutive_failures=%d reason=%q", controller.failures, probeErr.Error())
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
	target, err := normalizeTarget(target)
	if err != nil || target == controller.target {
		return
	}
	controller.history = recentChanges(controller.history, now)
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
		controller.alert("record_read_before_write_failed", "record write refused because the current record could not be read")
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

	updatedRecord, err := controller.recordClient.PatchTarget(ctx, target)
	if err != nil {
		controller.alert("record_patch_failed", "Cloudflare refused the DNS record update")
		return
	}
	updatedTarget, err := validateRecord(updatedRecord, controller.config)
	if err != nil || updatedTarget != target {
		controller.recordSafe = false
		controller.alert("record_patch_unverified", "DNS record update response did not match the requested safe target")
		return
	}

	newState := PersistentState{
		Target:  target,
		Changes: append(controller.history, now),
	}
	if err := controller.stateStore.Save(ctx, newState); err != nil {
		controller.recordSafe = false
		controller.alert("state_write_failed", "DNS changed but persistent switch state could not be saved; future writes are disabled")
		return
	}
	controller.target = target
	controller.history = newState.Changes
	controller.metrics.recordSwitch(targetLabel(target, controller.config), false)
	controller.updateMetrics(now)
	controller.logger.Printf("level=info event=dns_record_switched target=%s reason=%s", target, reason)
	if len(recentChanges(controller.history, now)) >= maxChanges && target == normalizedTunnelTarget(controller.config) {
		controller.alert("change_cap_exhausted", "DNS change cap reached; holding the tunnel target")
	}
}

func (controller *Controller) alert(key, message string) {
	if controller.alerts[key] {
		return
	}
	controller.alerts[key] = true
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
