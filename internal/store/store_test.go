package store

import (
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
	"time"

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

func TestReadDuringCatalogWrite(t *testing.T) {
	s := testStore(t)
	mustPublish(t, s, station("aaaaaaaa-1111-2222-3333-444444444444", "A"))
	tx, err := s.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec("UPDATE stations SET name = 'pending'"); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		res, err := s.Search(SearchRequest{})
		if err == nil && (res.Total != 1 || res.Items[0].Name != "A") {
			err = fmt.Errorf("unexpected snapshot: %+v", res)
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("read blocked behind write transaction")
	}
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
	if err := s.AddFavorite(""); err == nil {
		t.Fatal("accepted an empty favorite ID")
	}
	a := station("aaaaaaaa-1111-2222-3333-444444444444", "A")
	b := station("bbbbbbbb-1111-2222-3333-444444444444", "B")
	c := station("cccccccc-1111-2222-3333-444444444444", "Unplayed")
	mustPublish(t, s, a, b, c)

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

func TestCustomTokensSurviveUpdateAndPublish(t *testing.T) {
	s := testStore(t)
	catalog := station("aaaaaaaa-1111-2222-3333-444444444444", "Catalog")
	mustPublish(t, s, catalog)
	custom := model.Station{Name: "Custom", URL: "https://example.com", Tags: "unique-tag", Language: "unique-language"}
	if err := s.AddCustomStation(&custom); err != nil {
		t.Fatal(err)
	}
	if err := s.AddCustomStation(&custom); err != nil {
		t.Fatal(err)
	}
	mustPublish(t, s, catalog)
	for _, req := range []SearchRequest{{Tag: "unique-tag"}, {Language: "unique-language"}} {
		res, err := s.Search(req)
		if err != nil || res.Total != 1 {
			t.Fatalf("search %+v: %+v, %v", req, res, err)
		}
	}
	tags, err := s.Tags("unique-tag", 10)
	if err != nil || len(tags) != 1 || tags[0].Count != 1 {
		t.Fatalf("tags: %+v, %v", tags, err)
	}
	countries, err := s.Countries("_", 10)
	if err != nil || len(countries) != 0 {
		t.Fatalf("countries: %+v, %v", countries, err)
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

func TestCountryFacetsChinesePrefixes(t *testing.T) {
	s := testStore(t)
	var stations []model.Station
	for _, country := range []struct {
		code, name string
		count      int
	}{
		{"AU", "Australia", 4},
		{"CF", "Central African Republic", 1},
		{"CN", "China", 2},
		{"HK", "Hong Kong", 1},
		{"MO", "Macao", 1},
		{"TW", "Taiwan", 1},
		{"QZ", "Unrecognized country", 1},
		{"JP", "Japan", 1},
	} {
		for range country.count {
			st := station(fmt.Sprintf("country-%d", len(stations)), "Country fixture")
			st.Country, st.CountryCode = country.name, country.code
			stations = append(stations, st)
		}
	}
	mustPublish(t, s, stations...)
	if _, err := s.db.Exec("UPDATE stations SET active=0 WHERE country='JP'"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		prefix string
		limit  int
		codes  []string
	}{
		{"中", 10, []string{"CN", "CF", "HK", "MO"}},
		{" 中国　", 10, []string{"CN", "HK", "MO"}},
		{"中国香", 10, []string{"HK"}},
		{"台", 10, []string{"TW"}},
		{" c ", 10, []string{"CN", "CF"}},
		{"cn", 10, []string{"CN"}},
		{"CHi", 10, []string{"CN"}},
		{"central", 10, []string{"CF"}},
		{"qz", 10, []string{"QZ"}},
		{"香港", 10, []string{}},
		{"国", 10, []string{}},
		{"日本", 10, []string{}},
		{"%", 10, []string{}},
		{"_", 10, []string{}},
		{"' OR 1=1 --", 10, []string{}},
		{"", 1, []string{"AU"}},
		{"中国", 1, []string{"CN"}},
	} {
		t.Run(fmt.Sprintf("%s/%d", tc.prefix, tc.limit), func(t *testing.T) {
			facets, err := s.Countries(tc.prefix, tc.limit)
			if err != nil {
				t.Fatal(err)
			}
			codes := []string{}
			for _, facet := range facets {
				codes = append(codes, facet.Value)
				if facet.Value == "CN" && (facet.Count != 2 || facet.Label != "china") {
					t.Fatalf("country count or catalog label changed: %+v", facet)
				}
			}
			if !reflect.DeepEqual(codes, tc.codes) {
				t.Fatalf("codes = %v, want %v", codes, tc.codes)
			}
		})
	}
	selected, err := s.Search(SearchRequest{Country: "CN"})
	if err != nil || selected.Total != 2 || selected.Items[0].Country != "China" {
		t.Fatalf("country filter or original metadata changed: %+v, %v", selected, err)
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

func TestClearHistoryPreservesOtherData(t *testing.T) {
	s := testStore(t)
	custom := station("", "Custom")
	if err := s.AddCustomStation(&custom); err != nil {
		t.Fatal(err)
	}
	if err := s.AddFavorite(custom.StationUUID); err != nil {
		t.Fatal(err)
	}
	if err := s.AddPlay(custom.StationUUID); err != nil {
		t.Fatal(err)
	}
	if err := s.SetMeta("pref_last_station", custom.StationUUID); err != nil {
		t.Fatal(err)
	}
	if err := s.ClearHistory(); err != nil {
		t.Fatal(err)
	}
	result, err := s.Search(SearchRequest{Source: "history"})
	if err != nil || result.Total != 0 {
		t.Fatalf("history = %+v, %v", result, err)
	}
	st, ok, err := s.GetStation(custom.StationUUID)
	if err != nil || !ok || !st.Favorite || !st.Custom {
		t.Fatalf("station changed: %+v, %v", st, err)
	}
	last, _, err := s.GetMeta("pref_last_station")
	if err != nil || last != custom.StationUUID {
		t.Fatal("last selection changed")
	}
}
