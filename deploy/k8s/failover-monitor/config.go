package main

import (
	"fmt"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	recordName       = "web.teagram.io"
	recordType       = "CNAME"
	versionPath      = "/mtproto-target.json"
	monitorNamespace = "web-failover"
	stateConfigMap   = "web-failover-state"
	tokenFile        = "/run/credentials/cloudflare/token"
	probeInterval    = 20 * time.Second
	probeTimeout     = 8 * time.Second
	failbackWindow   = 10 * time.Minute
	changeWindow     = time.Hour
	maxChanges       = 3
)

var (
	cloudflareIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
	dnsNamePattern      = regexp.MustCompile(`(?i)^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$`)
	commitPattern       = regexp.MustCompile(`^[0-9a-f]{40}$`)
	digestPattern       = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

type Config struct {
	ZoneID          string
	RecordID        string
	PagesTarget     string
	TunnelTarget    string
	PagesIP         string
	InitialTarget   string
	WritesEnabled   bool
	FailbackEnabled bool
}

func loadConfig() (Config, error) {
	var config Config
	var err error

	if config.ZoneID, err = requiredEnv("CLOUDFLARE_ZONE_ID"); err != nil {
		return config, err
	}
	if config.RecordID, err = requiredEnv("CLOUDFLARE_RECORD_ID"); err != nil {
		return config, err
	}
	if config.PagesTarget, err = requiredEnv("PAGES_TARGET"); err != nil {
		return config, err
	}
	if config.TunnelTarget, err = requiredEnv("TUNNEL_TARGET"); err != nil {
		return config, err
	}
	if config.PagesIP, err = requiredEnv("PAGES_IP"); err != nil {
		return config, err
	}
	if config.InitialTarget, err = requiredEnv("INITIAL_TARGET"); err != nil {
		return config, err
	}

	if config.WritesEnabled, err = optionalBool("WRITES_ENABLED", false); err != nil {
		return config, err
	}
	if config.FailbackEnabled, err = optionalBool("FAILBACK_ENABLED", true); err != nil {
		return config, err
	}
	if err := config.Validate(); err != nil {
		return config, err
	}
	return config, nil
}

func (config Config) Validate() error {
	if !cloudflareIDPattern.MatchString(config.ZoneID) {
		return fmt.Errorf("CLOUDFLARE_ZONE_ID must be a 32-character lowercase hexadecimal ID")
	}
	if !cloudflareIDPattern.MatchString(config.RecordID) {
		return fmt.Errorf("CLOUDFLARE_RECORD_ID must be a 32-character lowercase hexadecimal ID")
	}
	pagesTarget, err := normalizeTarget(config.PagesTarget)
	if err != nil {
		return fmt.Errorf("PAGES_TARGET is invalid: %w", err)
	}
	tunnelTarget, err := normalizeTarget(config.TunnelTarget)
	if err != nil {
		return fmt.Errorf("TUNNEL_TARGET is invalid: %w", err)
	}
	if pagesTarget == tunnelTarget {
		return fmt.Errorf("PAGES_TARGET and TUNNEL_TARGET must be different")
	}
	if net.ParseIP(config.PagesIP) == nil {
		return fmt.Errorf("PAGES_IP must be an IP address")
	}
	initialTarget, err := normalizeTarget(config.InitialTarget)
	if err != nil {
		return fmt.Errorf("INITIAL_TARGET is invalid: %w", err)
	}
	if initialTarget != pagesTarget && initialTarget != tunnelTarget {
		return fmt.Errorf("INITIAL_TARGET must match one of the two allowed targets")
	}
	return nil
}

func normalizeTarget(target string) (string, error) {
	target = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(target), "."))
	if !dnsNamePattern.MatchString(target) {
		return "", fmt.Errorf("expected a DNS name")
	}
	return target, nil
}

func requiredEnv(key string) (string, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return "", fmt.Errorf("%s is required", key)
	}
	return value, nil
}

func optionalBool(key string, fallback bool) (bool, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false", key)
	}
	return parsed, nil
}
