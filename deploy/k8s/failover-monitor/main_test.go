package main

import (
	"bytes"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMissingTokenAllowsDryRunButNotWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing-token")
	var logs bytes.Buffer
	logger := log.New(&logs, "", 0)

	client, err := loadRecordClient(Config{}, path, logger)
	if err != nil || client != nil {
		t.Fatalf("dry-run without a token should continue without a Cloudflare client: client=%v err=%v", client, err)
	}
	if !strings.Contains(logs.String(), "record_validation_skipped reason=token_missing mode=dry-run") {
		t.Fatalf("missing token should be explicit in logs: %s", logs.String())
	}

	_, err = loadRecordClient(Config{WritesEnabled: true}, path, logger)
	if err == nil {
		t.Fatal("writes must fail closed when the Cloudflare token is missing")
	}
}

func TestEmptyTokenAllowsDryRunButNotWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	logger := log.New(&logs, "", 0)

	client, err := loadRecordClient(Config{}, path, logger)
	if err != nil || client != nil {
		t.Fatalf("dry-run with an empty token should continue without a Cloudflare client: client=%v err=%v", client, err)
	}
	if !strings.Contains(logs.String(), "record_validation_skipped reason=token_empty mode=dry-run") {
		t.Fatalf("empty token should be explicit in logs: %s", logs.String())
	}

	_, err = loadRecordClient(Config{WritesEnabled: true}, path, logger)
	if err == nil {
		t.Fatal("writes must fail closed when the Cloudflare token is empty")
	}
}
