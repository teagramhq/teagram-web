package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type DNSRecord struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Content string `json:"content"`
	Proxied bool   `json:"proxied"`
}

type RecordClient interface {
	GetRecord(context.Context) (DNSRecord, error)
	PatchTarget(context.Context, string) (DNSRecord, error)
}

type CloudflareClient struct {
	baseURL string
	token   string
	client  *http.Client
	config  Config
}

func NewCloudflareClient(config Config, token string) *CloudflareClient {
	return &CloudflareClient{
		baseURL: "https://api.cloudflare.com/client/v4",
		token:   token,
		client: &http.Client{
			Timeout: 8 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		config: config,
	}
}

func (client *CloudflareClient) GetRecord(ctx context.Context) (DNSRecord, error) {
	return client.request(ctx, http.MethodGet, nil)
}

func (client *CloudflareClient) PatchTarget(ctx context.Context, target string) (DNSRecord, error) {
	body, err := json.Marshal(struct {
		Content string `json:"content"`
		Proxied bool   `json:"proxied"`
	}{Content: target, Proxied: true})
	if err != nil {
		return DNSRecord{}, safeDiagnostic("cloudflare_update_encoding_failed")
	}
	return client.request(ctx, http.MethodPatch, body)
}

func (client *CloudflareClient) request(ctx context.Context, method string, body []byte) (DNSRecord, error) {
	endpoint := client.baseURL + "/zones/" + url.PathEscape(client.config.ZoneID) + "/dns_records/" + url.PathEscape(client.config.RecordID)
	request, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return DNSRecord{}, safeDiagnostic("cloudflare_request_invalid")
	}
	request.Header.Set("Authorization", "Bearer "+client.token)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.client.Do(request)
	if err != nil {
		return DNSRecord{}, fmt.Errorf("Cloudflare request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		if method == http.MethodPatch && response.StatusCode >= 400 && response.StatusCode < 500 {
			return DNSRecord{}, safePatchRejection(fmt.Sprintf("cloudflare_http_status_%d", response.StatusCode))
		}
		return DNSRecord{}, safeDiagnostic(fmt.Sprintf("cloudflare_http_status_%d", response.StatusCode))
	}
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	if err != nil {
		return DNSRecord{}, fmt.Errorf("Cloudflare response read failed: %w", err)
	}
	if len(responseBody) > 64*1024 {
		return DNSRecord{}, safeDiagnostic("cloudflare_response_too_large")
	}
	var envelope struct {
		Success bool      `json:"success"`
		Result  DNSRecord `json:"result"`
	}
	if err := json.Unmarshal(responseBody, &envelope); err != nil {
		return DNSRecord{}, safeDiagnostic("cloudflare_invalid_response")
	}
	if !envelope.Success {
		if method == http.MethodPatch {
			return DNSRecord{}, safePatchRejection("cloudflare_rejected_request")
		}
		return DNSRecord{}, safeDiagnostic("cloudflare_rejected_request")
	}
	return envelope.Result, nil
}

func validateRecord(record DNSRecord, config Config) (string, error) {
	if record.ID != config.RecordID {
		return "", fmt.Errorf("record ID did not match the configured record")
	}
	if !strings.EqualFold(strings.TrimSuffix(record.Name, "."), recordName) {
		return "", fmt.Errorf("record name did not match the configured name")
	}
	if !strings.EqualFold(record.Type, recordType) {
		return "", fmt.Errorf("record type did not match the configured type")
	}
	if !record.Proxied {
		return "", fmt.Errorf("record proxy setting was disabled")
	}
	content, err := normalizeTarget(record.Content)
	if err != nil {
		return "", fmt.Errorf("record target was invalid")
	}
	pagesTarget, _ := normalizeTarget(config.PagesTarget)
	tunnelTarget, _ := normalizeTarget(config.TunnelTarget)
	if content != pagesTarget && content != tunnelTarget {
		return "", fmt.Errorf("record target was outside the two allowed targets")
	}
	return content, nil
}
