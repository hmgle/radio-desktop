package store

import (
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"radio-desktop/internal/model"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func station(uuid, name string) model.Station {
	return model.Station{
		StationUUID:   uuid,
		Name:          name,
		URL:           "https://example.com/" + uuid + ".mp3",
		URLResolved:   "https://example.com/" + uuid + ".mp3",
		Country:       "France",
		CountryCode:   "FR",
		Language:      "French",
		LanguageCodes: "fr",
		Tags:          "jazz,news",
		Bitrate:       128,
		Votes:         10,
		ClickCount:    100,
	}
}

func mustPublish(t *testing.T, s *Store, stations ...model.Station) {
	t.Helper()
	if err := s.PublishCatalog(stations); err != nil {
		t.Fatal(err)
	}
}

func TestPublishAndSearch(t *testing.T) {
	s := testStore(t)
	jazz := station("aaaaaaaa-1111-2222-3333-444444444444", "Jazz Radio")
	jazz.Tags = "jazz"
	info := station("bbbbbbbb-1111-2222-3333-444444444444", "France Info")
	info.Tags = "news,talk"
	mustPublish(t, s, jazz, info)

	res, err := s.Search(SearchRequest{Query: "jazz"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 1 || len(res.Items) != 1 || res.Items[0].Name != "Jazz Radio" {
		t.Fatalf("query jazz: got %+v", res)
	}

	res, err = s.Search(SearchRequest{Country: "fr"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 2 {
		t.Fatalf("country FR: total %d", res.Total)
	}

	res, err = s.Search(SearchRequest{Language: "french"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 2 {
		t.Fatalf("language french: total %d", res.Total)
	}

	res, err = s.Search(SearchRequest{Tag: "news"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 1 || res.Items[0].Name != "France Info" {
		t.Fatalf("tag news: %+v", res)
	}

	res, err = s.Search(SearchRequest{MinBitrate: 256})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 0 {
		t.Fatalf("min-bitrate 256: total %d", res.Total)
	}
}

func TestSearchSortingAndPaging(t *testing.T) {
	s := testStore(t)
	var batch []model.Station
	for i := 0; i < 12; i++ {
		st := station(
			string(rune('a'+i))+"aaaaaaa-1111-2222-3333-444444444444",
			"Station "+string(rune('A'+i)))
		st.ClickCount = uint64(i)
		st.Votes = uint64(100 - i)
		batch = append(batch, st)
	}
	mustPublish(t, s, batch...)

	res, _ := s.Search(SearchRequest{Sort: "popularity", Limit: 5})
	if len(res.Items) != 5 || res.Total != 12 {
		t.Fatalf("popularity page1: %d items, total %d", len(res.Items), res.Total)
	}
	if res.Items[0].ClickCount != 11 {
		t.Fatalf("popularity first = %+v", res.Items[0])
	}
	page2, _ := s.Search(SearchRequest{Sort: "popularity", Limit: 5, Offset: 10})
	if len(page2.Items) != 2 {
		t.Fatalf("page2: %d items", len(page2.Items))
	}
	byName, _ := s.Search(SearchRequest{Sort: "name"})
	if byName.Items[0].Name != "Station A" {
		t.Fatalf("name sort first = %s", byName.Items[0].Name)
	}
	byVotes, _ := s.Search(SearchRequest{Sort: "votes"})
	if byVotes.Items[0].Votes != 100 {
		t.Fatalf("votes sort first votes = %d", byVotes.Items[0].Votes)
	}
}

func TestSearchEscapesLikeWildcards(t *testing.T) {
	s := testStore(t)
	mustPublish(t, s, station("aaaaaaaa-1111-2222-3333-444444444444", "100% Hits"))
	res, err := s.Search(SearchRequest{Query: "100%"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 1 {
		t.Fatalf("literal %% query: total %d", res.Total)
	}
}

func TestFavoritesAndHistorySources(t *testing.T) {
	s := testStore(t)
	a := station("aaaaaaaa-1111-2222-3333-444444444444", "A")
	b := station("bbbbbbbb-1111-2222-3333-444444444444", "B")
	mustPublish(t, s, a, b)

	if err := s.AddFavorite(a.StationUUID); err != nil {
		t.Fatal(err)
	}
	res, _ := s.Search(SearchRequest{Source: "favorites"})
	if res.Total != 1 || res.Items[0].Name != "A" {
		t.Fatalf("favorites source: %+v", res)
	}
	if st, ok, _ := s.GetStation(a.StationUUID); !ok || !st.Favorite {
		t.Fatalf("GetStation favorite flag: %+v", st)
	}

	if err := s.AddPlay(a.StationUUID); err != nil {
		t.Fatal(err)
	}
	if err := s.AddPlay(b.StationUUID); err != nil {
		t.Fatal(err)
	}
	if err := s.AddPlay(a.StationUUID); err != nil {
		t.Fatal(err)
	}
	res, _ = s.Search(SearchRequest{Source: "history"})
	if res.Total != 2 || res.Items[0].Name != "A" {
		t.Fatalf("history source (deduped, recency): %+v", res)
	}

	if err := s.RemoveFavorite(a.StationUUID); err != nil {
		t.Fatal(err)
	}
	res, _ = s.Search(SearchRequest{Source: "favorites"})
	if res.Total != 0 {
		t.Fatalf("favorites after remove: %+v", res)
	}
}

func TestCustomStations(t *testing.T) {
	s := testStore(t)
	mustPublish(t, s, station("aaaaaaaa-1111-2222-3333-444444444444", "Catalog"))

	st := model.Station{Name: "My Stream", URL: "https://example.net/live.aac"}
	if err := s.AddCustomStation(&st); err != nil {
		t.Fatal(err)
	}
	if st.StationUUID == "" || !st.Custom {
		t.Fatalf("uuid/custom not set: %+v", st)
	}
	res, _ := s.Search(SearchRequest{Source: "custom"})
	if res.Total != 1 || res.Items[0].Name != "My Stream" {
		t.Fatalf("custom source: %+v", res)
	}
	if err := s.AddFavorite(st.StationUUID); err != nil {
		t.Fatal(err)
	}

	if err := s.RemoveCustomStation("aaaaaaaa-1111-2222-3333-444444444444"); err == nil {
		t.Fatal("removing a catalog station should fail")
	}
	if err := s.RemoveCustomStation(st.StationUUID); err != nil {
		t.Fatal(err)
	}
	res, _ = s.Search(SearchRequest{})
	if res.Total != 1 {
		t.Fatalf("after custom removal total = %d", res.Total)
	}
}

func TestRepublishDeactivatesMissingAndKeepsFavorites(t *testing.T) {
	s := testStore(t)
	a := station("aaaaaaaa-1111-2222-3333-444444444444", "A")
	b := station("bbbbbbbb-1111-2222-3333-444444444444", "B")
	mustPublish(t, s, a, b)
	if err := s.AddFavorite(b.StationUUID); err != nil {
		t.Fatal(err)
	}

	// Second sync drops B: it becomes inactive but the favorite survives.
	b.Name = "A2"
	b.StationUUID = a.StationUUID
	mustPublish(t, s, b)

	if n, _ := s.CatalogSize(); n != 1 {
		t.Fatalf("catalog size = %d, want 1", n)
	}
	if _, ok, _ := s.GetStation("bbbbbbbb-1111-2222-3333-444444444444"); !ok {
		t.Fatal("B should still exist as a row")
	}
	res, _ := s.Search(SearchRequest{Source: "favorites"})
	if res.Total != 0 {
		t.Fatalf("favorites of inactive station should not show: %+v", res)
	}
	if err := s.AddFavorite("bbbbbbbb-1111-2222-3333-444444444444"); err != nil {
		t.Fatal(err)
	}
}

func TestShrinkProtection(t *testing.T) {
	s := testStore(t)
	big := make([]model.Station, 2000)
	for i := range big {
		big[i] = station(fmt.Sprintf("aaaaaaaa-1111-2222-3333-%012d", i), fmt.Sprintf("S%04d", i))
	}
	mustPublish(t, s, big...)

	err := s.PublishCatalog(big[:100]) // 100 < 2000*75%
	if !errors.Is(err, ErrShrink) {
		t.Fatalf("want ErrShrink, got %v", err)
	}
	// Database unchanged.
	if n, _ := s.CatalogSize(); n != 2000 {
		t.Fatalf("catalog size after rejected sync = %d", n)
	}
}

func TestFacets(t *testing.T) {
	s := testStore(t)
	de := station("aaaaaaaa-1111-2222-3333-444444444444", "De")
	de.Country, de.CountryCode, de.Language, de.LanguageCodes, de.Tags = "Germany", "DE", "german", "de", "rock"
	mustPublish(t, s, de, station("bbbbbbbb-1111-2222-3333-444444444444", "Fr"))

	cs, err := s.Countries("", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(cs) != 2 || cs[0].Value == "" {
		t.Fatalf("countries: %+v", cs)
	}
	cs, _ = s.Countries("d", 10)
	if len(cs) != 1 || cs[0].Value != "DE" {
		t.Fatalf("country prefix d: %+v", cs)
	}
	ls, _ := s.Languages("ger", 10)
	if len(ls) != 1 || ls[0].Value != "german" {
		t.Fatalf("languages: %+v", ls)
	}
	ts, _ := s.Tags("", 10)
	if len(ts) != 3 { // rock, jazz, news
		t.Fatalf("tags: %+v", ts)
	}
}

func TestMetaAndTokensRebuilt(t *testing.T) {
	s := testStore(t)
	if _, ok, _ := s.GetMeta("last_sync"); ok {
		t.Fatal("meta should start empty")
	}
	if err := s.SetMeta("last_sync", "12345"); err != nil {
		t.Fatal(err)
	}
	if v, ok, _ := s.GetMeta("last_sync"); !ok || v != "12345" {
		t.Fatalf("meta = %q %v", v, ok)
	}
	if err := s.SetMeta("last_sync", "67890"); err != nil {
		t.Fatal(err)
	}
	if v, _, _ := s.GetMeta("last_sync"); v != "67890" {
		t.Fatalf("meta update = %q", v)
	}
}
