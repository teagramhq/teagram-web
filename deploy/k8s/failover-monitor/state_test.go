package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestStateStoreCreatesMissingRuntimeConfigMap(t *testing.T) {
	tokenPath := writeProjectedTestToken(t, "state-token")
	var created bool
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer state-token" {
			t.Error("state request did not use the projected token")
		}
		switch {
		case request.Method == http.MethodGet && request.URL.Path == statePath():
			response.WriteHeader(http.StatusNotFound)
		case request.Method == http.MethodPost && request.URL.Path == "/api/v1/namespaces/"+monitorNamespace+"/configmaps":
			var resource struct {
				Metadata map[string]string `json:"metadata"`
				Data     map[string]string `json:"data"`
			}
			if err := json.NewDecoder(request.Body).Decode(&resource); err != nil {
				t.Errorf("state ConfigMap create body was invalid: %v", err)
			}
			if resource.Metadata["name"] != stateConfigMap || resource.Metadata["namespace"] != monitorNamespace {
				t.Errorf("created ConfigMap metadata = %#v", resource.Metadata)
			}
			if resource.Data[stateDataKey] != `{"target":"","changes":[]}` {
				t.Errorf("created runtime state = %q", resource.Data[stateDataKey])
			}
			created = true
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"metadata":{"resourceVersion":"7"},"data":{"state.json":"{\"target\":\"\",\"changes\":[]}"}}`))
		default:
			t.Errorf("unexpected state API request: %s %s", request.Method, request.URL.Path)
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	store := &KubernetesStateStore{endpoint: server.URL, tokenPath: tokenPath, client: server.Client()}
	state, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !created || state.Target != "" || store.resourceVersion != "7" {
		t.Fatalf("Load did not initialize runtime state: created=%t state=%#v version=%q", created, state, store.resourceVersion)
	}
}

func TestStateStoreReloadsProjectedTokenForEachRequest(t *testing.T) {
	tokenPath := writeProjectedTestToken(t, "token-one")
	expectedTokens := []string{"token-one", "token-two", "token-three"}
	requestIndex := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if requestIndex >= len(expectedTokens) || request.Header.Get("Authorization") != "Bearer "+expectedTokens[requestIndex] {
			t.Error("Kubernetes API request did not use the current projected token")
		}
		requestIndex++
		switch request.Method {
		case http.MethodGet:
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"metadata":{"resourceVersion":"1"},"data":{"state.json":"{\"target\":\"pages.example.test\",\"changes\":[]}"}}`))
		case http.MethodPatch:
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"metadata":{"resourceVersion":"2"}}`))
		case http.MethodPost:
			response.WriteHeader(http.StatusCreated)
		default:
			t.Errorf("unexpected Kubernetes API method: %s", request.Method)
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	store := &KubernetesStateStore{
		endpoint:  server.URL,
		tokenPath: tokenPath,
		podName:   "monitor-test",
		podUID:    "pod-uid-test",
		client:    server.Client(),
	}
	if _, err := store.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenPath, []byte("token-two"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(context.Background(), PersistentState{Target: "pages.example.test"}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenPath, []byte("token-three"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.PublishWarning(context.Background(), "test_alert", "test event"); err != nil {
		t.Fatal(err)
	}
	if requestIndex != len(expectedTokens) {
		t.Fatalf("Kubernetes API request count = %d, want %d", requestIndex, len(expectedTokens))
	}
}

func writeProjectedTestToken(t *testing.T, token string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte(token), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
