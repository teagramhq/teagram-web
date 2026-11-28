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
	"time"
)

func TestStateStoreCreatesMissingRuntimeConfigMap(t *testing.T) {
	tokenPath := writeProjectedTestToken(t, "state-token")
	var created bool
	var markerCreated bool
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer state-token" {
			t.Error("state request did not use the projected token")
		}
		switch {
		case request.Method == http.MethodGet && request.URL.Path == stateInitializationMarkerPath():
			response.WriteHeader(http.StatusNotFound)
		case request.Method == http.MethodGet && request.URL.Path == statePath():
			response.WriteHeader(http.StatusNotFound)
		case request.Method == http.MethodPost && request.URL.Path == "/api/v1/namespaces/"+monitorNamespace+"/configmaps":
			var resource struct {
				Metadata map[string]string `json:"metadata"`
				Data     map[string]string `json:"data"`
			}
			if err := json.NewDecoder(request.Body).Decode(&resource); err != nil {
				t.Errorf("ConfigMap create body was invalid: %v", err)
			}
			if resource.Metadata["namespace"] != monitorNamespace {
				t.Errorf("created ConfigMap namespace = %#v", resource.Metadata)
			}
			if resource.Metadata["name"] == stateInitializationMarker {
				if resource.Data["initialized"] != "true" {
					t.Errorf("created initialization marker = %#v", resource.Data)
				}
				markerCreated = true
				response.WriteHeader(http.StatusCreated)
				return
			}
			if resource.Metadata["name"] != stateConfigMap {
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
	state, status, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !markerCreated || !created || status != stateLoadInitialized || state.Target != "" || store.resourceVersion != "7" {
		t.Fatalf("Load did not report initialized runtime state: marker=%t created=%t status=%d state=%#v version=%q", markerCreated, created, status, state, store.resourceVersion)
	}
}

func TestControllerRecoversWhenFirstStateCreationFails(t *testing.T) {
	tokenPath := writeProjectedTestToken(t, "state-token")
	config := testConfig()
	config.WritesEnabled = true
	stateConfigMapExists := false
	markerExists := false
	stateCreateAttempts := 0
	stateJSON := ""
	resourceVersion := 7
	var createOrder []string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer state-token" {
			t.Error("Kubernetes request did not use the projected token")
		}
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == statePath():
			if !stateConfigMapExists {
				http.NotFound(response, request)
				return
			}
			_ = json.NewEncoder(response).Encode(map[string]any{
				"metadata": map[string]string{"resourceVersion": strconv.Itoa(resourceVersion)},
				"data":     map[string]string{stateDataKey: stateJSON},
			})
		case request.Method == http.MethodGet && request.URL.Path == stateInitializationMarkerPath():
			if !markerExists {
				http.NotFound(response, request)
				return
			}
			_ = json.NewEncoder(response).Encode(map[string]any{"metadata": map[string]string{"name": stateInitializationMarker}})
		case request.Method == http.MethodPost && request.URL.Path == "/api/v1/namespaces/"+monitorNamespace+"/configmaps":
			var resource struct {
				Metadata map[string]string `json:"metadata"`
				Data     map[string]string `json:"data"`
			}
			if err := json.NewDecoder(request.Body).Decode(&resource); err != nil {
				t.Errorf("ConfigMap create body was invalid: %v", err)
			}
			switch resource.Metadata["name"] {
			case stateConfigMap:
				createOrder = append(createOrder, "state")
				stateCreateAttempts++
				if stateCreateAttempts == 1 {
					response.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				stateJSON = resource.Data[stateDataKey]
				stateConfigMapExists = true
				resourceVersion++
				_ = json.NewEncoder(response).Encode(map[string]any{
					"metadata": map[string]string{"resourceVersion": strconv.Itoa(resourceVersion)},
					"data":     map[string]string{stateDataKey: stateJSON},
				})
			case stateInitializationMarker:
				if !stateConfigMapExists {
					t.Error("initialization marker was created before the runtime state ConfigMap")
				}
				createOrder = append(createOrder, "marker")
				markerExists = true
				response.WriteHeader(http.StatusCreated)
			default:
				t.Errorf("unexpected ConfigMap create name %q", resource.Metadata["name"])
				http.NotFound(response, request)
			}
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
	if !controller.SafetyLocked() {
		t.Fatal("writes must stay locked after the first state creation attempt fails")
	}
	controller.retryRecordValidation(context.Background())
	if controller.SafetyLocked() || controller.CurrentTarget() != config.PagesTarget {
		t.Fatalf("monitor did not recover after state creation retry: locked=%t target=%q logs=%s", controller.SafetyLocked(), controller.CurrentTarget(), logs.String())
	}
	if !stateConfigMapExists || !markerExists || stateCreateAttempts != 2 || len(createOrder) != 3 || createOrder[0] != "state" || createOrder[1] != "state" || createOrder[2] != "marker" {
		t.Fatalf("initial state creation did not retry before marking initialized: state=%t marker=%t attempts=%d order=%v", stateConfigMapExists, markerExists, stateCreateAttempts, createOrder)
	}
}

func TestControllerRestartWithMissingStateKeepsWritesLocked(t *testing.T) {
	tokenPath := writeProjectedTestToken(t, "state-token")
	config := testConfig()
	config.WritesEnabled = true
	configMapExists := false
	initializationMarkerExists := false
	stateConfigMapCreates := 0
	stateDataKeyPresent := true
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
		case request.Method == http.MethodGet && request.URL.Path == stateInitializationMarkerPath():
			if !initializationMarkerExists {
				http.NotFound(response, request)
				return
			}
			_ = json.NewEncoder(response).Encode(map[string]any{"metadata": map[string]string{"name": stateInitializationMarker}})
		case request.Method == http.MethodGet && request.URL.Path == statePath():
			if !configMapExists {
				http.NotFound(response, request)
				return
			}
			data := map[string]string{}
			if stateDataKeyPresent {
				data[stateDataKey] = stateJSON
			}
			_ = json.NewEncoder(response).Encode(map[string]any{
				"metadata": map[string]string{"resourceVersion": strconv.Itoa(resourceVersion)},
				"data":     data,
			})
		case request.Method == http.MethodPost && request.URL.Path == "/api/v1/namespaces/"+monitorNamespace+"/configmaps":
			var resource struct {
				Metadata map[string]string `json:"metadata"`
				Data     map[string]string `json:"data"`
			}
			if err := json.NewDecoder(request.Body).Decode(&resource); err != nil {
				t.Errorf("ConfigMap create body was invalid: %v", err)
			}
			switch resource.Metadata["name"] {
			case stateInitializationMarker:
				if initializationMarkerExists {
					response.WriteHeader(http.StatusConflict)
					return
				}
				initializationMarkerExists = true
				response.WriteHeader(http.StatusCreated)
			case stateConfigMap:
				if configMapExists {
					response.WriteHeader(http.StatusConflict)
					return
				}
				stateJSON = resource.Data[stateDataKey]
				stateDataKeyPresent = true
				configMapExists = true
				stateConfigMapCreates++
				resourceVersion++
				_ = json.NewEncoder(response).Encode(map[string]any{
					"metadata": map[string]string{"resourceVersion": strconv.Itoa(resourceVersion)},
					"data":     map[string]string{stateDataKey: stateJSON},
				})
			default:
				t.Errorf("unexpected ConfigMap create name %q", resource.Metadata["name"])
				http.NotFound(response, request)
			}
		case request.Method == http.MethodPatch && request.URL.Path == statePath():
			var patch struct {
				Data map[string]string `json:"data"`
			}
			if err := json.NewDecoder(request.Body).Decode(&patch); err != nil {
				t.Errorf("state ConfigMap patch body was invalid: %v", err)
			}
			stateJSON = patch.Data[stateDataKey]
			stateDataKeyPresent = true
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
	_, err := NewController(
		context.Background(), config,
		&mutableRecordClient{record: testRecord(config, config.PagesTarget)},
		store,
		log.New(&logs, "", 0),
		NewMetrics(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !initializationMarkerExists || !configMapExists || stateConfigMapCreates != 1 {
		t.Fatalf("initial state initialization did not create its marker and ConfigMap: marker=%t state=%t creates=%d", initializationMarkerExists, configMapExists, stateConfigMapCreates)
	}
	if len(warningEvents) != 1 || warningEvents[0].Type != "Warning" || warningEvents[0].Reason != "StateConfigmapInitialized" {
		t.Fatalf("initial state initialization events = %#v, want one StateConfigmapInitialized Warning Event", warningEvents)
	}
	if strings.Count(logs.String(), "event=state_configmap_initialized") != 1 {
		t.Fatalf("initial state initialization was not logged: %s", logs.String())
	}

	lastChange := time.Now().Add(-time.Minute)
	persistedState, err := json.Marshal(PersistentState{
		Target: config.PagesTarget,
		Changes: []time.Time{
			lastChange.Add(-2 * time.Minute),
			lastChange.Add(-time.Minute),
			lastChange,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	stateJSON = string(persistedState)
	var historicalState PersistentState
	if err := json.Unmarshal(persistedState, &historicalState); err != nil {
		t.Fatal(err)
	}
	if len(historicalState.Changes) != maxChanges {
		t.Fatalf("test did not prepare a full change history: %#v", historicalState.Changes)
	}
	stateDataKeyPresent = false
	missingStateDataStore := &KubernetesStateStore{
		endpoint:  server.URL,
		tokenPath: tokenPath,
		podName:   "monitor-test-missing-state-data",
		podUID:    "pod-uid-missing-state-data",
		client:    server.Client(),
	}
	missingStateDataController, err := NewController(
		context.Background(), config,
		&mutableRecordClient{record: testRecord(config, config.PagesTarget)},
		missingStateDataStore,
		log.New(&logs, "", 0),
		NewMetrics(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !missingStateDataController.SafetyLocked() {
		t.Fatal("initialized state with a missing state.json key must keep DNS writes locked")
	}
	if !configMapExists || stateDataKeyPresent || stateConfigMapCreates != 1 {
		t.Fatalf("missing state data was recreated or lost its ConfigMap: configmap=%t data-key=%t creates=%d", configMapExists, stateDataKeyPresent, stateConfigMapCreates)
	}
	if len(warningEvents) != 2 || warningEvents[1].Type != "Warning" || warningEvents[1].Reason != "StateConfigmapLost" {
		t.Fatalf("missing state.json events = %#v, want one StateConfigmapLost Warning Event", warningEvents)
	}
	if strings.Count(logs.String(), "event=state_configmap_lost") != 1 {
		t.Fatalf("missing state.json data loss was not logged: %s", logs.String())
	}

	configMapExists = false
	restartedStore := &KubernetesStateStore{
		endpoint:  server.URL,
		tokenPath: tokenPath,
		podName:   "monitor-test-restarted",
		podUID:    "pod-uid-restarted",
		client:    server.Client(),
	}
	restarted, err := NewController(
		context.Background(), config,
		&mutableRecordClient{record: testRecord(config, config.PagesTarget)},
		restartedStore,
		log.New(&logs, "", 0),
		NewMetrics(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !restarted.SafetyLocked() {
		t.Fatal("restart with a missing initialized state ConfigMap must keep DNS writes locked")
	}
	if configMapExists || stateConfigMapCreates != 1 {
		t.Fatalf("state-loss recovery recreated an empty ConfigMap: state=%t creates=%d", configMapExists, stateConfigMapCreates)
	}
	if len(warningEvents) != 3 || warningEvents[2].Type != "Warning" || warningEvents[2].Reason != "StateConfigmapLost" {
		t.Fatalf("missing initialized state events = %#v, want a StateConfigmapLost Warning Event", warningEvents)
	}
	if !strings.Contains(warningEvents[2].Message, "change history") || !strings.Contains(warningEvents[2].Message, "record writes are disabled") {
		t.Fatalf("state-loss Warning Event omitted the lost history or write lock: %#v", warningEvents[2])
	}
	if strings.Count(logs.String(), "event=state_configmap_lost") != 2 {
		t.Fatalf("state loss was not logged: %s", logs.String())
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
	expectedTokens := []string{"token-one", "token-one", "token-one", "token-two", "token-three"}
	requestIndex := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if requestIndex >= len(expectedTokens) || request.Header.Get("Authorization") != "Bearer "+expectedTokens[requestIndex] {
			t.Error("Kubernetes API request did not use the current projected token")
		}
		requestIndex++
		switch {
		case request.Method == http.MethodGet && request.URL.Path == stateInitializationMarkerPath():
			http.NotFound(response, request)
		case request.Method == http.MethodGet && request.URL.Path == statePath():
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"metadata":{"resourceVersion":"1"},"data":{"state.json":"{\"target\":\"pages.example.test\",\"changes\":[]}"}}`))
		case request.Method == http.MethodPatch:
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"metadata":{"resourceVersion":"2"}}`))
		case request.Method == http.MethodPost:
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
	if _, status, err := store.Load(context.Background()); err != nil {
		t.Fatal(err)
	} else if status != stateLoadExisting {
		t.Fatalf("existing ConfigMap load status = %d, want existing", status)
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
