package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"syscall"
	"testing"
)

func TestSafeFailureCauseClassifiesNetworkAndTimeout(t *testing.T) {
	timeout := fmt.Errorf("request wrapper: %w", context.DeadlineExceeded)
	if got := safeFailureCause(timeout); got != "timeout" {
		t.Fatalf("timeout cause = %q, want timeout", got)
	}

	connection := fmt.Errorf("request wrapper: %w", &url.Error{
		Op:  "Get",
		URL: "https://api.example.test/records",
		Err: &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED},
	})
	if got := safeFailureCause(connection); got != "connection_failed" {
		t.Fatalf("connection cause = %q, want connection_failed", got)
	}
	if errors.Is(connection, syscall.ECONNREFUSED) == false {
		t.Fatal("test connection error did not preserve its underlying cause")
	}
}
