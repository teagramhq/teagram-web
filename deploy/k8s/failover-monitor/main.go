package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	logger := log.New(os.Stdout, "", log.LstdFlags|log.LUTC)
	config, err := loadConfig()
	if err != nil {
		logger.Printf("level=alert event=configuration_invalid reason=%q", alertReason(err))
		os.Exit(1)
	}

	recordClient, err := loadRecordClient(config, tokenFile, logger)
	if err != nil {
		logger.Printf("level=alert event=token_invalid reason=%q", alertReason(err))
		os.Exit(1)
	}

	stateStore, err := NewKubernetesStateStore()
	if err != nil {
		logger.Printf("level=alert event=state_client_unavailable reason=%q", alertReason(err))
		os.Exit(1)
	}
	metrics := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	controller, err := NewController(ctx, config, recordClient, stateStore, logger, metrics)
	if err != nil {
		logger.Printf("level=alert event=monitor_start_failed reason=%q", alertReason(err))
		os.Exit(1)
	}

	go serveMetrics(logger, controller)
	logger.Printf("level=info event=monitor_started mode=%s failback_enabled=%t", mode(config.WritesEnabled), config.FailbackEnabled)
	controller.Run(ctx, probePages)
}

func loadRecordClient(config Config, path string, logger *log.Logger) (RecordClient, error) {
	tokenBytes, err := os.ReadFile(path)
	if err != nil {
		if config.WritesEnabled {
			return nil, errors.New("Cloudflare token file is required when writes are enabled")
		}
		if errors.Is(err, os.ErrNotExist) {
			logger.Printf("level=alert event=record_validation_skipped reason=token_missing mode=dry-run")
		} else {
			logger.Printf("level=alert event=record_validation_skipped reason=token_unreadable mode=dry-run")
		}
		return nil, nil
	}

	token := strings.TrimSpace(string(tokenBytes))
	if token == "" {
		if config.WritesEnabled {
			return nil, errors.New("Cloudflare token file is empty")
		}
		logger.Printf("level=alert event=record_validation_skipped reason=token_empty mode=dry-run")
		return nil, nil
	}
	return NewCloudflareClient(config, token), nil
}

func serveMetrics(logger *log.Logger, controller *Controller) {
	mux := http.NewServeMux()
	mux.Handle("/metrics", controller.metricsHandler())
	mux.HandleFunc("/healthz", controller.metricsHandler().HealthHandler)
	server := &http.Server{
		Addr:              ":9090",
		Handler:           mux,
		ReadHeaderTimeout: 3 * time.Second,
	}
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Printf("level=alert event=metrics_server_failed reason=%q", alertReason(err))
		os.Exit(1)
	}
}

func mode(writesEnabled bool) string {
	if writesEnabled {
		return "write"
	}
	return "dry-run"
}
