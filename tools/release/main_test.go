package main

import (
	"strings"
	"testing"
)

func TestReleaseNotes(t *testing.T) {
	for _, heading := range []string{"0.2.0", "v0.2.0", "[0.2.0]", "[v0.2.0](https://example.com/release)"} {
		t.Run(heading, func(t *testing.T) {
			changelog := "# Changelog\n\n## 未发布\n\n- Future\n\n## " + heading + " — 2026-11-05\n\n### Fixed\n\n- Released\n\n## 0.1.0\n\n- Old\n"
			for _, text := range []string{changelog, strings.ReplaceAll(changelog, "\n", "\r\n")} {
				got, err := releaseNotes("0.2.0", "v0.2.0", text)
				if err != nil || got != "### Fixed\n\n- Released" {
					t.Fatalf("notes = %q, err = %v", got, err)
				}
			}
		})
	}
}

func TestRejectInvalidRelease(t *testing.T) {
	for _, tc := range []struct{ version, tag, changelog string }{
		{"0.2.0", "v0.3.0", "## 0.2.0\n- Note"},
		{"0.2.0", "0.2.0", "## 0.2.0\n- Note"},
		{"", "v", "## v\n- Note"},
		{"0.2.0", "v0.2.0", "## 未发布\n- Future\n## 0.2.01\n- Other"},
		{"0.2.0", "v0.2.0", "## 0.2.0\n\n## 0.1.0\n- Old"},
	} {
		if notes, err := releaseNotes(tc.version, tc.tag, tc.changelog); err == nil {
			t.Errorf("accepted invalid release %+v: %q", tc, notes)
		}
	}
}

func TestPrereleaseNotes(t *testing.T) {
	got, err := releaseNotes("0.3.0-beta.1", "v0.3.0-beta.1", "## 0.3.0-beta.1\n- Preview\n")
	if err != nil || got != "- Preview" {
		t.Fatalf("notes = %q, err = %v", got, err)
	}
}
