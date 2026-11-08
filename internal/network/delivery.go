package network

import (
	"errors"
	"net/url"
	"strconv"
	"strings"
)

// Only these HLS Delivery Directives may be added to a signed relay URL.
// The signed target, authentication parameters, and all other query fields
// remain under the control of the original URL or the upstream playlist.
func mergeDeliveryDirectives(target *url.URL, rawQuery string) error {
	if rawQuery == "" {
		return nil
	}
	invalid := errors.New("invalid HLS delivery directives")
	added, err := url.ParseQuery(rawQuery)
	if err != nil {
		return invalid
	}
	for key, values := range added {
		if len(values) != 1 {
			return invalid
		}
		switch key {
		case "_HLS_msn", "_HLS_part":
			if !deliverySequence(values[0]) {
				return invalid
			}
		case "_HLS_skip":
			if values[0] != "YES" && values[0] != "v2" {
				return invalid
			}
		default:
			return invalid
		}
	}
	if added.Has("_HLS_part") {
		msn := added.Get("_HLS_msn")
		if !added.Has("_HLS_msn") {
			msn = target.Query().Get("_HLS_msn")
		}
		if !deliverySequence(msn) {
			return invalid
		}
	}
	// Keep the original query's ordering, duplicate authentication fields
	// and exact escaping. Re-encoding it can invalidate signed URLs.
	fields := make([]string, 0)
	if target.RawQuery != "" {
		for _, field := range strings.Split(target.RawQuery, "&") {
			key, _, _ := strings.Cut(field, "=")
			key, _ = url.QueryUnescape(key)
			if !added.Has(key) {
				fields = append(fields, field)
			}
		}
	}
	if encoded := added.Encode(); encoded != "" {
		fields = append(fields, encoded)
	}
	target.RawQuery = strings.Join(fields, "&")
	return nil
}

func deliverySequence(value string) bool {
	if value == "" || strings.IndexFunc(value, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
		return false
	}
	_, err := strconv.ParseUint(value, 10, 64)
	return err == nil
}
