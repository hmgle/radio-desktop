// Package network supplies one outbound policy for API and media requests.
package network

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/egoist/mygo/netproxy"
)

// Config is fixed for a process so a saved change cannot split an active
// playback session across two different network policies.
type Config struct {
	Mode string
	URL  string
}

func (c Config) Validate() error {
	if c.Mode != "auto" && c.Mode != "manual" && c.Mode != "direct" {
		return errors.New("radio:invalidSettings")
	}
	if c.URL == "" && c.Mode != "manual" {
		return nil
	}
	u, err := url.Parse(c.URL)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("radio:invalidSettings")
	}
	switch u.Scheme {
	case "http", "https", "socks5", "socks5h":
	default:
		return errors.New("radio:invalidSettings")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 || strings.TrimSpace(c.URL) != c.URL {
		return errors.New("radio:invalidSettings")
	}
	return nil
}

// Session owns its transport and, when overriding system settings, a
// loopback relay for media components with no configurable proxy API.
type Session struct {
	Transport *http.Transport
	relay     *relay
}

func New(c Config) (*Session, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	t := netproxy.Transport().Clone()
	switch c.Mode {
	case "direct":
		t.Proxy = nil
	case "manual":
		u, _ := url.Parse(c.URL)
		t.Proxy = http.ProxyURL(u)
	}
	s := &Session{Transport: t}
	if c.Mode != "auto" {
		var err error
		s.relay, err = newRelay(t)
		if err != nil {
			t.CloseIdleConnections()
			return nil, err
		}
	}
	return s, nil
}

// MediaURL keeps the original URL for automatic platform networking, or
// signs a relay URL when all media must follow an explicit policy.
func (s *Session) MediaURL(raw string) string {
	if s == nil || s.relay == nil || raw == "" {
		return raw
	}
	return s.relay.mediaURL(raw)
}

// StreamURL carries the directory's HLS hint even for extensionless URLs.
func (s *Session) StreamURL(raw string, hls bool) string {
	if s == nil || s.relay == nil || raw == "" || !hls {
		return s.MediaURL(raw)
	}
	return s.relay.typedURL(raw, resourcePlaylist)
}

// ResourceURL signs artwork as binary so HEAD and ranges need no body probe.
func (s *Session) ResourceURL(raw string) string {
	if s == nil || s.relay == nil || raw == "" {
		return raw
	}
	return s.relay.typedURL(raw, resourceBinary)
}

func (s *Session) Close() {
	if s.relay != nil {
		s.relay.server.Close()
		s.relay.client.CloseIdleConnections()
	}
	s.Transport.CloseIdleConnections()
}
