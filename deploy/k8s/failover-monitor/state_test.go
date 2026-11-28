package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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
	state, recreated, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !created || !recreated || state.Target != "" || store.resourceVersion != "7" {
		t.Fatalf("Load did not report initialized runtime state: created=%t recreated=%t state=%#v version=%q", created, recreated, state, store.resourceVersion)
	}
}

func TestControllerAlertsOnEveryStateConfigMapRecreation(t *testing.T) {
	tokenPath := writeProjectedTestToken(t, "state-token")
	config := testConfig()
	config.WritesEnabled = true
	configMapExists := false
	stateJSON := ""
	resourceVersion := 7
	var warningEvents []struct {
		Type    string `json:"type"`
		Reason  string `json:"reason"`
		Message string `json:"message"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer state-token" {
			t.Error("Kubernetes request did not use the projected token")
		}
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == statePath():
			if !configMapExists {
				http.NotFound(response, request)
				return
			}
			_ = json.NewEncoder(response).Encode(map[string]any{
				"metadata": map[string]string{"resourceVersion": strconv.Itoa(resourceVersion)},
				"data":     map[string]string{stateDataKey: stateJSON},
			})
		case request.Method == http.MethodPost && request.URL.Path == "/api/v1/namespaces/"+monitorNamespace+"/configmaps":
			var resource struct {
				Data map[string]string `json:"data"`
			}
			if err := json.NewDecoder(request.Body).Decode(&resource); err != nil {
				t.Errorf("state ConfigMap create body was invalid: %v", err)
			}
			stateJSON = resource.Data[stateDataKey]
			configMapExists = true
			resourceVersion++
			_ = json.NewEncoder(response).Encode(map[string]any{
				"metadata": map[string]string{"resourceVersion": strconv.Itoa(resourceVersion)},
				"data":     map[string]string{stateDataKey: stateJSON},
			})
		case request.Method == http.MethodPatch && request.URL.Path == statePath():
			var patch struct {
				Data map[string]string `json:"data"`
			}
			if err := json.NewDecoder(request.Body).Decode(&patch); err != nil {
				t.Errorf("state ConfigMap patch body was invalid: %v", err)
			}
			stateJSON = patch.Data[stateDataKey]
			resourceVersion++
			_ = json.NewEncoder(response).Encode(map[string]any{
				"metadata": map[string]string{"resourceVersion": strconv.Itoa(resourceVersion)},
			})
		case request.Method == http.MethodPost && request.URL.Path == "/api/v1/namespaces/"+monitorNamespace+"/events":
			var event struct {
				Type    string `json:"type"`
				Reason  string `json:"reason"`
				Message string `json:"message"`
			}
			if err := json.NewDecoder(request.Body).Decode(&event); err != nil {
				t.Errorf("Warning Event body was invalid: %v", err)
			}
			warningEvents = append(warningEvents, event)
			response.WriteHeader(http.StatusCreated)
		default:
			t.Errorf("unexpected Kubernetes API request: %s %s", request.Method, request.URL.Path)
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
	var logs bytes.Buffer
	controller, err := NewController(
		context.Background(), config,
		&mutableRecordClient{record: testRecord(config, config.PagesTarget)},
		store,
		log.New(&logs, "", 0),
		NewMetrics(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(warningEvents) != 1 || warningEvents[0].Type != "Warning" || warningEvents[0].Reason != "StateConfigmapRecreated" {
		t.Fatalf("initial ConfigMap recreation events = %#v, want one StateConfigmapRecreated Warning Event", warningEvents)
	}
	if !strings.Contains(warningEvents[0].Message, "change history") || !strings.Contains(warningEvents[0].Message, "pending transition") {
		t.Fatalf("ConfigMap recreation Warning Event omitted the possible state loss: %#v", warningEvents[0])
	}
	if strings.Count(logs.String(), "event=state_configmap_recreated") != 1 {
		t.Fatalf("initial ConfigMap recreation was not logged: %s", logs.String())
	}

	configMapExists = false
	if !controller.validateRecordState(context.Background()) {
		t.Fatal("controller did not validate state after the ConfigMap was recreated")
	}
	if len(warningEvents) != 2 || warningEvents[1].Type != "Warning" || warningEvents[1].Reason != "StateConfigmapRecreated" {
		t.Fatalf("subsequent ConfigMap recreation events = %#v, want a Warning Event for each recreation", warningEvents)
	}
	if !strings.Contains(warningEvents[1].Message, "change history") || !strings.Contains(warningEvents[1].Message, "pending transition") {
		t.Fatalf("subsequent recreation Warning Event omitted the possible state loss: %#v", warningEvents[1])
	}
	if strings.Count(logs.String(), "event=state_configmap_recreated") != 2 {
		t.Fatalf("subsequent ConfigMap recreation was not logged: %s", logs.String())
	}
}

func TestControllerStateReadAlertPreservesTokenReadFailureKind(t *testing.T) {
	cases := []struct {
		name      string
		tokenPath string
		cause     string
	}{
		{name: "missing token file", tokenPath: filepath.Join(t.TempDir(), "missing-token"), cause: "token_file_missing"},
		{name: "unreadable token path", tokenPath: t.TempDir(), cause: "token_file_read_failed"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			config := testConfig()
			config.WritesEnabled = true
			store := &KubernetesStateStore{
				endpoint:  "https://127.0.0.1",
				tokenPath: testCase.tokenPath,
				podName:   "monitor-test",
				podUID:    "pod-uid-test",
				client:    &http.Client{},
			}
			var logs bytes.Buffer
			controller, err := NewController(
				context.Background(), config,
				&mutableRecordClient{record: testRecord(config, config.PagesTarget)},
				store,
				log.New(&logs, "", 0),
				NewMetrics(),
			)
			if err != nil {
				t.Fatal(err)
			}
			if !controller.SafetyLocked() {
				t.Fatal("writes must remain locked while the state token cannot be read")
			}
			if !strings.Contains(logs.String(), "event=state_read_failed") || !strings.Contains(logs.String(), "cause="+testCase.cause) {
				t.Fatalf("state read alert did not preserve token read cause %q: %s", testCase.cause, logs.String())
			}
			if strings.Contains(logs.String(), testCase.tokenPath) {
				t.Fatalf("state read alert exposed the token path: %s", logs.String())
			}
		})
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
	if _, recreated, err := store.Load(context.Background()); err != nil {
		t.Fatal(err)
	} else if recreated {
		t.Fatal("existing ConfigMap was incorrectly reported as recreated")
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
