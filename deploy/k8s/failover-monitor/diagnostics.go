package main

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
)

type safeDiagnosticError struct {
	detail string
	cause  error
}

func (err safeDiagnosticError) Error() string {
	return err.detail
}

func (err safeDiagnosticError) SafeFailureCause() string {
	return err.detail
}

func (err safeDiagnosticError) Unwrap() error {
	return err.cause
}

func safeDiagnostic(detail string) error {
	return safeDiagnosticError{detail: detail}
}

func safeDiagnosticWrap(detail string, cause error) error {
	return safeDiagnosticError{detail: detail, cause: cause}
}

func safeFailureCause(err error) string {
	if err == nil {
		return "unknown"
	}
	var safe interface{ SafeFailureCause() string }
	if errors.As(err, &safe) {
		return safe.SafeFailureCause()
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	var verificationErr *tls.CertificateVerificationError
	if errors.As(err, &verificationErr) {
		return "tls_verification_failed"
	}
	var networkErr net.Error
	if errors.As(err, &networkErr) && networkErr.Timeout() {
		return "timeout"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "dns_lookup_failed"
	}
	var operationErr *net.OpError
	if errors.As(err, &operationErr) {
		return "connection_failed"
	}
	return "request_failed"
}

func messageWithSafeCause(message string, err error) string {
	return message + "; cause=" + safeFailureCause(err)
}
