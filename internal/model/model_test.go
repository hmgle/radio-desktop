package model

import (
	"reflect"
	"strings"
	"testing"
)

func TestStationCandidatesAndSearch(t *testing.T) {
	s := Station{Name: "Jazz FM", Country: "France", URLResolved: "https://example.com/live", URL: "ftp://example.com/live"}
	got := s.StreamCandidates([]string{"https://example.com/live", "http://example.com/backup", "javascript:alert(1)"})
	want := []string{"https://example.com/live", "http://example.com/backup"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("candidates = %v", got)
	}
	if !strings.Contains(s.SearchText(), "jazz fm france") {
		t.Fatalf("search = %q", s.SearchText())
	}
}

func TestStationIDs(t *testing.T) {
	if !ValidUUID("aaaaaaaa-1111-2222-3333-444444444444") || ValidUUID("aaaaaaaa-1111-2222-3333-44444444444g") {
		t.Fatal("invalid UUID validation")
	}
	a, err := NewCustomUUID()
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewCustomUUID()
	if err != nil {
		t.Fatal(err)
	}
	if a == b || !strings.HasPrefix(a, "custom-") {
		t.Fatalf("custom IDs = %q, %q", a, b)
	}
}
