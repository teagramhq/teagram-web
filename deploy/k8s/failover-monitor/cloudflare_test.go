package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCloudflarePatchChangesOnlyTargetAndForcesProxy(t *testing.T) {
	config := testConfig()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPatch {
			t.Errorf("method = %s, want PATCH", request.Method)
		}
		if request.URL.Path != "/client/v4/zones/"+config.ZoneID+"/dns_records/"+config.RecordID {
			t.Errorf("path = %s, want the configured record path", request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer test-only-token" {
			t.Error("Cloudflare request did not use its authorization header")
		}
		var fields map[string]json.RawMessage
		if err := json.NewDecoder(request.Body).Decode(&fields); err != nil {
			t.Errorf("request body was invalid JSON: %v", err)
		}
		if len(fields) != 2 || string(fields["content"]) != `"tunnel.example.test"` || string(fields["proxied"]) != "true" {
			t.Errorf("patch fields = %s, want only content and proxied:true", mustJSON(fields))
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"success":true,"result":{"id":"` + config.RecordID + `","name":"web.teagram.io","type":"CNAME","content":"tunnel.example.test","proxied":true}}`))
	}))
	defer server.Close()

	client := NewCloudflareClient(config, "test-only-token")
	client.baseURL = server.URL + "/client/v4"
	client.client = server.Client()
	record, err := client.PatchTarget(context.Background(), config.TunnelTarget)
	if err != nil {
		t.Fatal(err)
	}
	if target, err := validateRecord(record, config); err != nil || target != config.TunnelTarget {
		t.Fatalf("updated record validation = %q, %v", target, err)
	}
}

func TestCloudflareRequestPreservesTransportCause(t *testing.T) {
	transportCause := errors.New("transport failure detail")
	client := NewCloudflareClient(testConfig(), "test-only-token")
	client.client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, transportCause
	})}

	_, err := client.GetRecord(context.Background())
	if !errors.Is(err, transportCause) {
		t.Fatalf("Cloudflare request error = %v, want wrapped transport cause", err)
	}
	if got := safeFailureCause(err); got != "request_failed" {
		t.Fatalf("safe cause = %q, want request_failed", got)
	}
	if strings.Contains(safeFailureCause(err), "transport failure detail") {
		t.Fatal("safe cause exposed the underlying transport error")
	}
}

func TestCloudflarePatchHTTPRejectionIsDefinitive(t *testing.T) {
	config := testConfig()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()

	client := NewCloudflareClient(config, "test-only-token")
	client.baseURL = server.URL
	client.client = server.Client()
	_, err := client.PatchTarget(context.Background(), config.TunnelTarget)
	if got := safeFailureCause(err); got != "cloudflare_http_status_403" {
		t.Fatalf("safe cause = %q, want cloudflare_http_status_403", got)
	}
	if !isDefinitivePatchRejection(err) {
		t.Fatalf("HTTP 403 PATCH error is not classified as definitive: %v", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (roundTrip roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func mustJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return strings.TrimSpace(err.Error())
	}
	return string(encoded)
}
