package main

import (
	"fmt"
	"net/http"
	"sync"
	"time"
)

type Metrics struct {
	mu                sync.RWMutex
	probeSuccess      bool
	lastProbe         time.Time
	currentTarget     string
	changesInLastHour int
	safetyLocked      bool
	dryRunSwitches    map[string]uint64
	writeSwitches     map[string]uint64
}

func NewMetrics() *Metrics {
	return &Metrics{
		currentTarget:  "pages",
		dryRunSwitches: map[string]uint64{"pages": 0, "tunnel": 0},
		writeSwitches:  map[string]uint64{"pages": 0, "tunnel": 0},
	}
}

func (metrics *Metrics) setProbe(success bool, now time.Time) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.probeSuccess = success
	metrics.lastProbe = now
}

func (metrics *Metrics) recordSwitch(shortTarget string, dryRun bool) {
	if shortTarget != "pages" && shortTarget != "tunnel" {
		return
	}
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.currentTarget = shortTarget
	if dryRun {
		metrics.dryRunSwitches[shortTarget]++
	} else {
		metrics.writeSwitches[shortTarget]++
	}
}

func (metrics *Metrics) setSafety(locked bool, shortTarget string, changes int) {
	if shortTarget != "pages" && shortTarget != "tunnel" {
		shortTarget = "pages"
	}
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.safetyLocked = locked
	metrics.currentTarget = shortTarget
	metrics.changesInLastHour = changes
}

func (metrics *Metrics) ServeHTTP(response http.ResponseWriter, _ *http.Request) {
	metrics.mu.RLock()
	defer metrics.mu.RUnlock()
	probe := 0
	if metrics.probeSuccess {
		probe = 1
	}
	locked := 0
	if metrics.safetyLocked {
		locked = 1
	}
	lastProbe := float64(0)
	if !metrics.lastProbe.IsZero() {
		lastProbe = float64(metrics.lastProbe.Unix())
	}
	_, _ = fmt.Fprintf(response,
		"# HELP web_failover_pages_probe_success Whether the last direct Pages probe succeeded.\n"+
			"# TYPE web_failover_pages_probe_success gauge\n"+
			"web_failover_pages_probe_success %d\n"+
			"# HELP web_failover_current_target Current simulated or observed origin.\n"+
			"# TYPE web_failover_current_target gauge\n"+
			"web_failover_current_target{target=\"pages\"} %d\n"+
			"web_failover_current_target{target=\"tunnel\"} %d\n"+
			"# HELP web_failover_changes_last_hour DNS record changes in the rolling hour.\n"+
			"# TYPE web_failover_changes_last_hour gauge\n"+
			"web_failover_changes_last_hour %d\n"+
			"# HELP web_failover_safety_locked Whether DNS writes have been stopped by a validation failure.\n"+
			"# TYPE web_failover_safety_locked gauge\n"+
			"web_failover_safety_locked %d\n"+
			"# HELP web_failover_last_probe_timestamp_seconds Unix timestamp of the last probe.\n"+
			"# TYPE web_failover_last_probe_timestamp_seconds gauge\n"+
			"web_failover_last_probe_timestamp_seconds %.0f\n"+
			"# HELP web_failover_switches_total Switch decisions by destination and mode.\n"+
			"# TYPE web_failover_switches_total counter\n"+
			"web_failover_switches_total{target=\"pages\",mode=\"dry_run\"} %d\n"+
			"web_failover_switches_total{target=\"tunnel\",mode=\"dry_run\"} %d\n"+
			"web_failover_switches_total{target=\"pages\",mode=\"write\"} %d\n"+
			"web_failover_switches_total{target=\"tunnel\",mode=\"write\"} %d\n",
		probe,
		boolInt(metrics.currentTarget == "pages"),
		boolInt(metrics.currentTarget == "tunnel"),
		metrics.changesInLastHour,
		locked,
		lastProbe,
		metrics.dryRunSwitches["pages"], metrics.dryRunSwitches["tunnel"],
		metrics.writeSwitches["pages"], metrics.writeSwitches["tunnel"],
	)
}

func (metrics *Metrics) HealthHandler(response http.ResponseWriter, _ *http.Request) {
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write([]byte("ok\n"))
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
