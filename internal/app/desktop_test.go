package app

import "testing"

func TestOpenHomepageRejectsInvalidURLs(t *testing.T) {
	var svc Service
	for _, rawURL := range []string{"", "example.com", "https://", "javascript:alert(1)", "file:///tmp/test", "mailto:radio@example.com", "https://%zz"} {
		t.Run(rawURL, func(t *testing.T) {
			if err := svc.OpenHomepage(rawURL); err == nil || err.Error() != "radio:invalidURL" {
				t.Fatalf("OpenHomepage(%q) = %v, want invalidURL", rawURL, err)
			}
		})
	}
}
