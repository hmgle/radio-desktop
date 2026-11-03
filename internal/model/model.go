// Package model defines the station data model shared by the store,
// directory sync and the IPC surface. Fields mirror the Radio Browser
// station JSON (and radio-cli's src/model.rs) so directory responses
// decode directly into Station.
package model

import (
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"strings"
)

// Station is a radio station from the Radio Browser directory or one the
// user added. The JSON tags match the Radio Browser API.
type Station struct {
	StationUUID   string   `json:"stationuuid"`
	Name          string   `json:"name"`
	URL           string   `json:"url"`
	URLResolved   string   `json:"url_resolved"`
	Homepage      string   `json:"homepage"`
	Favicon       string   `json:"favicon"`
	Country       string   `json:"country"`
	CountryCode   string   `json:"countrycode"`
	State         string   `json:"state"`
	Language      string   `json:"language"`
	LanguageCodes string   `json:"languagecodes"`
	Tags          string   `json:"tags"`
	TagsList      []string `json:"tagsList"`
	Codec         string   `json:"codec"`
	Bitrate       uint32   `json:"bitrate"`
	// HLS is 0/1 in the Radio Browser API (not a bool).
	HLS        uint8  `json:"hls"`
	Votes      uint64 `json:"votes"`
	ClickCount uint64 `json:"clickcount"`
	Custom     bool   `json:"custom"`
	Favorite   bool   `json:"favorite"`
}

// StreamCandidates lists playable URLs in priority order: resolved URL,
// the original URL, then extras. Duplicates and non-http(s) URLs are
// dropped, mirroring radio-cli's Station::stream_candidates.
func (s *Station) StreamCandidates(extras []string) []string {
	all := append([]string{s.URLResolved, s.URL}, extras...)
	seen := make(map[string]bool, len(all))
	out := make([]string, 0, len(all))
	for _, u := range all {
		if u == "" || seen[u] || !httpURL(u) {
			continue
		}
		seen[u] = true
		out = append(out, u)
	}
	return out
}

func httpURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// splitList splits a comma-separated radio-browser field, dropping blanks
// and lower-casing the tokens.
func splitList(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.ToLower(strings.TrimSpace(p)); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// Languages returns the station's languages as lower-case tokens,
// combining the human-readable and ISO fields.
func (s *Station) Languages() []string {
	return splitList(s.Language + "," + s.LanguageCodes)
}

// TagList returns the station's tags as lower-case tokens.
func (s *Station) TagList() []string {
	return splitList(s.Tags)
}

// SearchText builds the normalized text the store's LIKE search runs over.
func (s *Station) SearchText() string {
	return strings.ToLower(strings.Join([]string{
		s.Name, s.Country, s.CountryCode, s.State, s.Language, s.LanguageCodes, s.Tags,
	}, " "))
}

// NewCustomUUID returns a uuid for user-added stations, namespaced so it
// can never collide with a Radio Browser uuid.
func NewCustomUUID() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "custom-" + hex.EncodeToString(b[:]), nil
}

// ValidUUID reports whether s looks like a Radio Browser stationuuid.
func ValidUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			isHex := c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
			if !isHex {
				return false
			}
		}
	}
	return true
}
