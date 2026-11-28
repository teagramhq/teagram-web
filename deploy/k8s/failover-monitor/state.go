package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	stateDataKey = "state.json"
	// This separate ConfigMap persists if the mutable runtime state is lost.
	stateInitializationMarker = "web-failover-state-initialized"
	serviceAccountTokenPath   = "/var/run/secrets/kubernetes.io/serviceaccount/token"
)

var (
	errStateConfigMapAlreadyExists            = errors.New("state ConfigMap already exists")
	errStateInitializationMarkerAlreadyExists = errors.New("state initialization marker already exists")
)

type stateLoadStatus uint8

const (
	stateLoadExisting stateLoadStatus = iota
	stateLoadInitialized
	stateLoadLost
)

type PersistentState struct {
	Target  string             `json:"target"`
	Changes []time.Time        `json:"changes"`
	Pending *PendingTransition `json:"pending,omitempty"`
}

type PendingTransition struct {
	From string    `json:"from"`
	To   string    `json:"to"`
	At   time.Time `json:"at"`
}

type StateStore interface {
	Load(context.Context) (state PersistentState, status stateLoadStatus, err error)
	Save(context.Context, PersistentState) error
}

type KubernetesStateStore struct {
	endpoint                    string
	tokenPath                   string
	podName                     string
	podUID                      string
	resourceVersion             string
	initializationMarkerEnsured bool
	client                      *http.Client
}

func NewKubernetesStateStore() (*KubernetesStateStore, error) {
	host := strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_HOST"))
	if host == "" {
		return nil, fmt.Errorf("KUBERNETES_SERVICE_HOST is required")
	}
	port := strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_PORT_HTTPS"))
	if port == "" {
		port = "443"
	}
	ca, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
	if err != nil {
		return nil, fmt.Errorf("Kubernetes service account CA is unavailable")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		return nil, fmt.Errorf("Kubernetes service account CA is invalid")
	}
	dialer := &net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
	return &KubernetesStateStore{
		endpoint:  "https://" + net.JoinHostPort(host, port),
		tokenPath: serviceAccountTokenPath,
		podName:   strings.TrimSpace(os.Getenv("POD_NAME")),
		podUID:    strings.TrimSpace(os.Getenv("POD_UID")),
		client: &http.Client{
			Timeout: 8 * time.Second,
			Transport: &http.Transport{
				Proxy:               nil,
				TLSClientConfig:     &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
				TLSHandshakeTimeout: 4 * time.Second,
				DialContext:         dialer.DialContext,
			},
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

func (store *KubernetesStateStore) PublishWarning(ctx context.Context, key, message string) error {
	if store.podName == "" || store.podUID == "" {
		return fmt.Errorf("pod identity is unavailable")
	}
	now := time.Now().UTC()
	reason := eventReason(key)
	name := "web-failover-" + strings.ToLower(reason) + "-" + strconv.FormatInt(now.UnixNano(), 36)
	body, err := json.Marshal(struct {
		APIVersion string `json:"apiVersion"`
		Kind       string `json:"kind"`
		Metadata   struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
		} `json:"metadata"`
		InvolvedObject struct {
			APIVersion string `json:"apiVersion"`
			Kind       string `json:"kind"`
			Name       string `json:"name"`
			Namespace  string `json:"namespace"`
			UID        string `json:"uid"`
		} `json:"involvedObject"`
		Reason  string `json:"reason"`
		Message string `json:"message"`
		Source  struct {
			Component string `json:"component"`
		} `json:"source"`
		FirstTimestamp time.Time `json:"firstTimestamp"`
		LastTimestamp  time.Time `json:"lastTimestamp"`
		Count          int       `json:"count"`
		Type           string    `json:"type"`
	}{
		APIVersion: "v1",
		Kind:       "Event",
		Metadata: struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
		}{Name: name, Namespace: monitorNamespace},
		InvolvedObject: struct {
			APIVersion string `json:"apiVersion"`
			Kind       string `json:"kind"`
			Name       string `json:"name"`
			Namespace  string `json:"namespace"`
			UID        string `json:"uid"`
		}{APIVersion: "v1", Kind: "Pod", Name: store.podName, Namespace: monitorNamespace, UID: store.podUID},
		Reason:  reason,
		Message: message,
		Source: struct {
			Component string `json:"component"`
		}{Component: "web-failover-monitor"},
		FirstTimestamp: now,
		LastTimestamp:  now,
		Count:          1,
		Type:           "Warning",
	})
	if err != nil {
		return fmt.Errorf("could not encode Kubernetes warning event")
	}
	endpoint := store.endpoint + "/api/v1/namespaces/" + url.PathEscape(monitorNamespace) + "/events"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return fmt.Errorf("could not construct Kubernetes warning event")
	}
	if err := store.authorize(request); err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := store.client.Do(request)
	if err != nil {
		return fmt.Errorf("Kubernetes warning event request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("Kubernetes warning event returned HTTP status %d", response.StatusCode)
	}
	return nil
}

func (store *KubernetesStateStore) Load(ctx context.Context) (PersistentState, stateLoadStatus, error) {
	for attempt := 0; attempt < 3; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, store.endpoint+statePath(), nil)
		if err != nil {
			return PersistentState{}, stateLoadExisting, fmt.Errorf("could not construct state request")
		}
		if err := store.authorize(request); err != nil {
			return PersistentState{}, stateLoadExisting, err
		}
		response, err := store.client.Do(request)
		if err != nil {
			return PersistentState{}, stateLoadExisting, fmt.Errorf("Kubernetes state request failed: %w", err)
		}
		if response.StatusCode == http.StatusNotFound {
			response.Body.Close()
			markerExists, err := store.stateInitializationMarkerExists(ctx)
			if err != nil {
				return PersistentState{}, stateLoadExisting, err
			}
			if markerExists {
				return PersistentState{}, stateLoadLost, nil
			}
			created, err := store.createStateConfigMap(ctx)
			if errors.Is(err, errStateConfigMapAlreadyExists) {
				continue
			}
			if err != nil {
				return PersistentState{}, stateLoadExisting, err
			}
			state, err := store.decodeStateConfigMap(created)
			if markerErr := store.ensureStateInitializationMarker(ctx); markerErr != nil {
				return state, stateLoadInitialized, markerErr
			}
			return state, stateLoadInitialized, err
		}
		if response.StatusCode < 200 || response.StatusCode > 299 {
			response.Body.Close()
			return PersistentState{}, stateLoadExisting, fmt.Errorf("Kubernetes state request returned HTTP status %d", response.StatusCode)
		}
		state, stateErr := store.decodeStateConfigMap(response)
		if err := store.ensureStateInitializationMarker(ctx); err != nil {
			return state, stateLoadExisting, err
		}
		if stateErr != nil {
			return state, stateLoadExisting, stateErr
		}
		return state, stateLoadExisting, nil
	}
	return PersistentState{}, stateLoadExisting, fmt.Errorf("state ConfigMap creation conflicted repeatedly")
}

func (store *KubernetesStateStore) stateInitializationMarkerExists(ctx context.Context) (bool, error) {
	if store.initializationMarkerEnsured {
		return true, nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, store.endpoint+stateInitializationMarkerPath(), nil)
	if err != nil {
		return false, fmt.Errorf("could not construct state initialization marker request")
	}
	if err := store.authorize(request); err != nil {
		return false, err
	}
	response, err := store.client.Do(request)
	if err != nil {
		return false, fmt.Errorf("Kubernetes state initialization marker request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return false, fmt.Errorf("Kubernetes state initialization marker returned HTTP status %d", response.StatusCode)
	}
	store.initializationMarkerEnsured = true
	return true, nil
}

func (store *KubernetesStateStore) ensureStateInitializationMarker(ctx context.Context) error {
	markerExists, err := store.stateInitializationMarkerExists(ctx)
	if err != nil {
		return err
	}
	if markerExists {
		return nil
	}
	err = store.createStateInitializationMarker(ctx)
	if errors.Is(err, errStateInitializationMarkerAlreadyExists) {
		store.initializationMarkerEnsured = true
		return nil
	}
	if err != nil {
		return err
	}
	store.initializationMarkerEnsured = true
	return nil
}

func (store *KubernetesStateStore) createStateInitializationMarker(ctx context.Context) error {
	body, err := json.Marshal(struct {
		APIVersion string            `json:"apiVersion"`
		Kind       string            `json:"kind"`
		Metadata   map[string]string `json:"metadata"`
		Data       map[string]string `json:"data"`
	}{
		APIVersion: "v1",
		Kind:       "ConfigMap",
		Metadata:   map[string]string{"name": stateInitializationMarker, "namespace": monitorNamespace},
		Data:       map[string]string{"initialized": "true"},
	})
	if err != nil {
		return fmt.Errorf("could not encode state initialization marker")
	}
	endpoint := store.endpoint + "/api/v1/namespaces/" + url.PathEscape(monitorNamespace) + "/configmaps"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return fmt.Errorf("could not construct state initialization marker request")
	}
	if err := store.authorize(request); err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := store.client.Do(request)
	if err != nil {
		return fmt.Errorf("Kubernetes state initialization marker request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusConflict {
		return errStateInitializationMarkerAlreadyExists
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("Kubernetes state initialization marker returned HTTP status %d", response.StatusCode)
	}
	return nil
}

func (store *KubernetesStateStore) createStateConfigMap(ctx context.Context) (*http.Response, error) {
	initialState, err := json.Marshal(PersistentState{Changes: []time.Time{}})
	if err != nil {
		return nil, fmt.Errorf("could not encode initial Kubernetes state")
	}
	body, err := json.Marshal(struct {
		APIVersion string            `json:"apiVersion"`
		Kind       string            `json:"kind"`
		Metadata   map[string]string `json:"metadata"`
		Data       map[string]string `json:"data"`
	}{
		APIVersion: "v1",
		Kind:       "ConfigMap",
		Metadata:   map[string]string{"name": stateConfigMap, "namespace": monitorNamespace},
		Data:       map[string]string{stateDataKey: string(initialState)},
	})
	if err != nil {
		return nil, fmt.Errorf("could not encode initial Kubernetes state resource")
	}
	endpoint := store.endpoint + "/api/v1/namespaces/" + url.PathEscape(monitorNamespace) + "/configmaps"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return nil, fmt.Errorf("could not construct state creation request")
	}
	if err := store.authorize(request); err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := store.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("Kubernetes state creation request failed: %w", err)
	}
	if response.StatusCode == http.StatusConflict {
		response.Body.Close()
		return nil, errStateConfigMapAlreadyExists
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		response.Body.Close()
		return nil, fmt.Errorf("Kubernetes state creation returned HTTP status %d", response.StatusCode)
	}
	return response, nil
}

func (store *KubernetesStateStore) decodeStateConfigMap(response *http.Response) (PersistentState, error) {
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	if err != nil || len(body) > 64*1024 {
		return PersistentState{}, fmt.Errorf("Kubernetes state response could not be read")
	}
	var configMap struct {
		Metadata struct {
			ResourceVersion string `json:"resourceVersion"`
		} `json:"metadata"`
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal(body, &configMap); err != nil {
		return PersistentState{}, fmt.Errorf("Kubernetes state response was not valid JSON")
	}
	if configMap.Metadata.ResourceVersion == "" {
		return PersistentState{}, fmt.Errorf("Kubernetes state resource version was missing")
	}
	store.resourceVersion = configMap.Metadata.ResourceVersion
	stateJSON := configMap.Data[stateDataKey]
	if stateJSON == "" {
		return PersistentState{}, nil
	}
	var state PersistentState
	if err := json.Unmarshal([]byte(stateJSON), &state); err != nil {
		return PersistentState{}, fmt.Errorf("Kubernetes state data was invalid")
	}
	return state, nil
}

func (store *KubernetesStateStore) authorize(request *http.Request) error {
	token, err := os.ReadFile(store.tokenPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return safeDiagnosticWrap("token_file_missing", err)
		}
		if errors.Is(err, os.ErrPermission) {
			return safeDiagnosticWrap("token_file_permission_denied", err)
		}
		return safeDiagnosticWrap("token_file_read_failed", err)
	}
	tokenValue := strings.TrimSpace(string(token))
	if tokenValue == "" {
		return safeDiagnostic("token_file_empty")
	}
	request.Header.Set("Authorization", "Bearer "+tokenValue)
	return nil
}

func (store *KubernetesStateStore) Save(ctx context.Context, state PersistentState) error {
	if store.resourceVersion == "" {
		return fmt.Errorf("Kubernetes state must be loaded before it is saved")
	}
	stateJSON, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("could not encode Kubernetes state")
	}
	body, err := json.Marshal(struct {
		Metadata map[string]string `json:"metadata"`
		Data     map[string]string `json:"data"`
	}{
		Metadata: map[string]string{"resourceVersion": store.resourceVersion},
		Data:     map[string]string{stateDataKey: string(stateJSON)},
	})
	if err != nil {
		return fmt.Errorf("could not encode Kubernetes state resource")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPatch, store.endpoint+statePath(), strings.NewReader(string(body)))
	if err != nil {
		return fmt.Errorf("could not construct state update")
	}
	if err := store.authorize(request); err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/merge-patch+json")
	response, err := store.client.Do(request)
	if err != nil {
		return fmt.Errorf("Kubernetes state update failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("Kubernetes state update returned HTTP status %d", response.StatusCode)
	}
	var updated struct {
		Metadata struct {
			ResourceVersion string `json:"resourceVersion"`
		} `json:"metadata"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&updated); err != nil || updated.Metadata.ResourceVersion == "" {
		return fmt.Errorf("Kubernetes state update response was invalid")
	}
	store.resourceVersion = updated.Metadata.ResourceVersion
	return nil
}

func statePath() string {
	return "/api/v1/namespaces/" + monitorNamespace + "/configmaps/" + stateConfigMap
}

func stateInitializationMarkerPath() string {
	return "/api/v1/namespaces/" + monitorNamespace + "/configmaps/" + stateInitializationMarker
}

func eventReason(key string) string {
	var reason strings.Builder
	for _, part := range strings.FieldsFunc(key, func(character rune) bool {
		return character == '_' || character == '-'
	}) {
		if part == "" {
			continue
		}
		reason.WriteString(strings.ToUpper(part[:1]))
		reason.WriteString(part[1:])
	}
	if reason.Len() == 0 {
		return "FailoverAlert"
	}
	return reason.String()
}
