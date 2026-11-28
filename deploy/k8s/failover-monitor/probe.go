package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

type deploymentVersion struct {
	SourceCommit   string `json:"sourceCommit"`
	ArtifactDigest string `json:"artifactDigest"`
}

func probePages(ctx context.Context, config Config) error {
	client := newProbeClient(nil, directPageDialContext(config, "443"))
	return probeWithClient(ctx, client)
}

func directPageDialContext(config Config, port string) func(context.Context, string, string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
	return func(ctx context.Context, network, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, network, net.JoinHostPort(config.PagesIP, port))
	}
}

func newProbeClient(roots *x509.CertPool, dialContext func(context.Context, string, string) (net.Conn, error)) *http.Client {
	transport := &http.Transport{
		Proxy:               nil,
		DisableKeepAlives:   true,
		TLSHandshakeTimeout: 4 * time.Second,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			ServerName: recordName,
			RootCAs:    roots,
		},
		DialContext: dialContext,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   time.Duration(probeTimeout),
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func probeWithClient(ctx context.Context, client *http.Client) error {
	pageURL, err := url.Parse("https://" + recordName + versionPath)
	if err != nil {
		return safeDiagnostic("pages_probe_url_invalid")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL.String(), nil)
	if err != nil {
		return safeDiagnostic("pages_probe_request_invalid")
	}
	request.Host = recordName
	request.Header.Set("Accept", "application/json")

	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("Pages HTTPS probe failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return safeDiagnostic(fmt.Sprintf("pages_http_status_%d", response.StatusCode))
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 16*1024+1))
	if err != nil {
		return fmt.Errorf("Pages version response read failed: %w", err)
	}
	if len(body) > 16*1024 {
		return safeDiagnostic("pages_version_response_too_large")
	}
	var version deploymentVersion
	if err := json.Unmarshal(body, &version); err != nil {
		return safeDiagnostic("pages_version_response_invalid_json")
	}
	if !commitPattern.MatchString(version.SourceCommit) || !digestPattern.MatchString(version.ArtifactDigest) {
		return safeDiagnostic("pages_version_identity_invalid")
	}
	return nil
}
