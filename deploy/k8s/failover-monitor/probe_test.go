package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestDirectProbeUsesHostnameAndRejectsUntrustedCertificate(t *testing.T) {
	certificate, roots := directProbeTestCertificate(t)
	var sawHost atomic.Bool
	var sawServerName atomic.Bool
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		sawHost.Store(request.Host == recordName)
		sawServerName.Store(request.TLS != nil && request.TLS.ServerName == recordName)
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(deploymentVersion{
			SourceCommit:   "0123456789abcdef0123456789abcdef01234567",
			ArtifactDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		})
	}))
	server.TLS = &tls.Config{Certificates: []tls.Certificate{certificate}}
	server.StartTLS()
	defer server.Close()

	_, port, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	config := testConfig()
	client := newProbeClient(roots, directPageDialContext(config, port))
	if err := probeWithClient(context.Background(), client); err != nil {
		t.Fatalf("verified Pages probe failed: %v", err)
	}
	if !sawHost.Load() || !sawServerName.Load() {
		t.Fatalf("probe host=%t SNI=%t, want both to use %s", sawHost.Load(), sawServerName.Load(), recordName)
	}

	untrustedClient := newProbeClient(x509.NewCertPool(), directPageDialContext(config, port))
	if err := probeWithClient(context.Background(), untrustedClient); err == nil {
		t.Fatal("probe accepted a certificate outside the configured trust roots")
	}
}

func directProbeTestCertificate(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: recordName},
		DNSNames:              []string{recordName},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &privateKey.PublicKey, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	certificate := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: privateKey}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(parsed)
	return certificate, roots
}
