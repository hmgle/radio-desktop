// Package store persists the station catalog, favorites, history and
// preferences in SQLite. The schema follows radio-cli's store (src/store.rs):
// a stations table holding the full station JSON plus normalized columns
// for queries, and junction tables for exact language/tag token matching.
package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"radio-desktop/internal/model"
)

// ErrShrink is returned by PublishCatalog when the new catalog is less
// than 75% of the previous one, which almost certainly means a broken
// sync rather than a real directory shrink (radio-cli's catalog_shrink).
var ErrShrink = errors.New("store: catalog shrank below 75% of its previous size")

// Facet is a filter value with its station count.
type Facet struct {
	Value string `json:"value"`
	Label string `json:"label"`
	Count int    `json:"count"`
}

// SearchRequest describes a station list query.
type SearchRequest struct {
	Query      string `json:"query"`
	Country    string `json:"country"`  // uppercase ISO code, exact match
	Language   string `json:"language"` // lower-case token, exact match
	Tag        string `json:"tag"`      // lower-case token, exact match
	MinBitrate uint32 `json:"minBitrate"`
	Sort       string `json:"sort"`   // popularity|votes|name|bitrate|random
	Source     string `json:"source"` // all|favorites|history|custom
	Limit      int    `json:"limit"`
	Offset     int    `json:"offset"`
}

// SearchResult is one page of stations plus the total match count.
type SearchResult struct {
	Total int             `json:"total"`
	Items []model.Station `json:"items"`
}

const schemaV1 = `
CREATE TABLE IF NOT EXISTS stations (
	uuid       TEXT PRIMARY KEY,
	name       TEXT NOT NULL,
	search     TEXT NOT NULL DEFAULT '',
	country    TEXT NOT NULL DEFAULT '',
	countryname TEXT NOT NULL DEFAULT '',
	bitrate    INTEGER NOT NULL DEFAULT 0,
	votes      INTEGER NOT NULL DEFAULT 0,
	clickcount INTEGER NOT NULL DEFAULT 0,
	custom     INTEGER NOT NULL DEFAULT 0,
	active     INTEGER NOT NULL DEFAULT 1,
	json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stations_active_pop ON stations(active, custom, clickcount DESC, name);
CREATE INDEX IF NOT EXISTS idx_stations_active_name ON stations(active, custom, name);
CREATE INDEX IF NOT EXISTS idx_stations_active_bitrate ON stations(active, custom, bitrate DESC);
CREATE INDEX IF NOT EXISTS idx_stations_country ON stations(country);

CREATE TABLE IF NOT EXISTS station_lang (
	uuid TEXT NOT NULL,
	lang TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_station_lang_lang ON station_lang(lang, uuid);
CREATE INDEX IF NOT EXISTS idx_station_lang_uuid ON station_lang(uuid);

CREATE TABLE IF NOT EXISTS station_tag (
	uuid TEXT NOT NULL,
	tag  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_station_tag_tag ON station_tag(tag, uuid);
CREATE INDEX IF NOT EXISTS idx_station_tag_uuid ON station_tag(uuid);

CREATE TABLE IF NOT EXISTS favorites (
	uuid       TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
	id        INTEGER PRIMARY KEY AUTOINCREMENT,
	uuid      TEXT NOT NULL,
	played_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_played ON history(played_at DESC);

CREATE TABLE IF NOT EXISTS meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`

// Store wraps the SQLite database. WAL allows readers to continue while
// a catalog publication holds the write transaction.
type Store struct {
	db *sql.DB
}

// Open creates or opens the database at path and applies migrations.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

func migrate(db *sql.DB) error {
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > 1 {
		return fmt.Errorf("store: database schema v%d is newer than this app", version)
	}
	if _, err := db.Exec(schemaV1); err != nil {
		return err
	}
	if version < 1 {
		if _, err := db.Exec("PRAGMA user_version = 1"); err != nil {
			return err
		}
	}
	return nil
}

// ---- search ----

// Search runs a station query. The history source is always ordered by
// recency; other sources honor req.Sort (default popularity).
func (s *Store) Search(req SearchRequest) (SearchResult, error) {
	where, args := searchWhere(req)
	order := searchOrder(req)

	total := 0
	if err := s.db.QueryRow("SELECT COUNT(*) FROM stations "+where, args...).Scan(&total); err != nil {
		return SearchResult{}, err
	}
	if total == 0 {
		return SearchResult{Total: 0, Items: []model.Station{}}, nil
	}

	limit := req.Limit
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	offset := req.Offset
	if offset < 0 {
		offset = 0
	}

	query := "SELECT json, (SELECT COUNT(*) FROM favorites f WHERE f.uuid = stations.uuid) FROM stations " +
		where + " " + order + " LIMIT ? OFFSET ?"
	rows, err := s.db.Query(query, append(args, limit, offset)...)
	if err != nil {
		return SearchResult{}, err
	}
	defer rows.Close()

	items := make([]model.Station, 0, limit)
	for rows.Next() {
		var raw string
		var fav int
		if err := rows.Scan(&raw, &fav); err != nil {
			return SearchResult{}, err
		}
		var st model.Station
		if err := json.Unmarshal([]byte(raw), &st); err != nil {
			continue // skip corrupt rows
		}
		st.Favorite = fav != 0
		st.TagsList = st.TagList()
		items = append(items, st)
	}
	return SearchResult{Total: total, Items: items}, rows.Err()
}

func searchWhere(req SearchRequest) (string, []any) {
	conds := []string{"active = 1"}
	var args []any

	if req.Query != "" {
		conds = append(conds, "search LIKE ? ESCAPE '\\'")
		args = append(args, "%"+escapeLike(strings.ToLower(strings.TrimSpace(req.Query)))+"%")
	}
	if req.Country != "" {
		conds = append(conds, "country = ?")
		args = append(args, strings.ToUpper(req.Country))
	}
	if req.Language != "" {
		conds = append(conds, "uuid IN (SELECT uuid FROM station_lang WHERE lang = ?)")
		args = append(args, strings.ToLower(req.Language))
	}
	if req.Tag != "" {
		conds = append(conds, "uuid IN (SELECT uuid FROM station_tag WHERE tag = ?)")
		args = append(args, strings.ToLower(req.Tag))
	}
	if req.MinBitrate > 0 {
		conds = append(conds, "bitrate >= ?")
		args = append(args, req.MinBitrate)
	}
	switch req.Source {
	case "favorites":
		conds = append(conds, "uuid IN (SELECT uuid FROM favorites)")
	case "custom":
		conds = append(conds, "custom = 1")
	case "history":
		conds = append(conds, "uuid IN (SELECT uuid FROM history)")
	}
	return "WHERE " + strings.Join(conds, " AND "), args
}

func searchOrder(req SearchRequest) string {
	if req.Source == "history" {
		return "ORDER BY (SELECT MAX(played_at) FROM history h WHERE h.uuid = stations.uuid) DESC"
	}
	switch req.Sort {
	case "votes":
		return "ORDER BY votes DESC, name COLLATE NOCASE"
	case "name":
		return "ORDER BY name COLLATE NOCASE"
	case "bitrate":
		return "ORDER BY bitrate DESC, clickcount DESC"
	case "random":
		return "ORDER BY RANDOM()"
	default: // popularity
		return "ORDER BY clickcount DESC, votes DESC, name COLLATE NOCASE"
	}
}

func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// GetStation returns one station by uuid.
func (s *Store) GetStation(uuid string) (model.Station, bool, error) {
	var raw string
	var fav int
	err := s.db.QueryRow(
		"SELECT json, (SELECT COUNT(*) FROM favorites f WHERE f.uuid = stations.uuid) FROM stations WHERE uuid = ?",
		uuid).Scan(&raw, &fav)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Station{}, false, nil
	}
	if err != nil {
		return model.Station{}, false, err
	}
	var st model.Station
	if err := json.Unmarshal([]byte(raw), &st); err != nil {
		return model.Station{}, false, err
	}
	st.Favorite = fav != 0
	st.TagsList = st.TagList()
	return st, true, nil
}

// ---- favorites ----

// AddFavorite marks a station as favorite.
func (s *Store) AddFavorite(uuid string) error {
	_, err := s.db.Exec("INSERT INTO favorites(uuid, created_at) VALUES(?, ?) ON CONFLICT(uuid) DO NOTHING",
		uuid, time.Now().Unix())
	return err
}

// RemoveFavorite unmarks a station.
func (s *Store) RemoveFavorite(uuid string) error {
	_, err := s.db.Exec("DELETE FROM favorites WHERE uuid = ?", uuid)
	return err
}

// ---- history ----

// AddPlay records a play and trims history to the most recent 1000 rows.
func (s *Store) AddPlay(uuid string) error {
	if _, err := s.db.Exec("INSERT INTO history(uuid, played_at) VALUES(?, ?)", uuid, time.Now().Unix()); err != nil {
		return err
	}
	_, err := s.db.Exec(
		"DELETE FROM history WHERE id < (SELECT MIN(id) FROM (SELECT id FROM history ORDER BY played_at DESC, id DESC LIMIT 1000))")
	return err
}

// ---- custom stations ----

// AddCustomStation inserts a user-defined station and returns it with its
// uuid set.
func (s *Store) AddCustomStation(st *model.Station) error {
	if st.StationUUID == "" {
		st.StationUUID = model.NewCustomUUID()
	}
	st.Custom = true
	if _, err := s.db.Exec("INSERT INTO stations(uuid, name, search, country, countryname, bitrate, custom, active, json) "+
		"VALUES(?,?,?,?,?,?,1,1,?) ON CONFLICT(uuid) DO UPDATE SET name=excluded.name, search=excluded.search, "+
		"country=excluded.country, countryname=excluded.countryname, bitrate=excluded.bitrate, json=excluded.json, active=1",
		st.StationUUID, st.Name, st.SearchText(), strings.ToUpper(st.CountryCode), strings.ToLower(st.Country),
		st.Bitrate, stationJSON(*st)); err != nil {
		return err
	}
	return s.insertTokens(st)
}

// RemoveCustomStation deletes a user-defined station. Catalog stations
// cannot be removed this way.
func (s *Store) RemoveCustomStation(uuid string) error {
	res, err := s.db.Exec("DELETE FROM stations WHERE uuid = ? AND custom = 1", uuid)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("store: %s is not a custom station", uuid)
	}
	if _, err := s.db.Exec("DELETE FROM station_lang WHERE uuid = ?", uuid); err != nil {
		return err
	}
	if _, err := s.db.Exec("DELETE FROM station_tag WHERE uuid = ?", uuid); err != nil {
		return err
	}
	if _, err := s.db.Exec("DELETE FROM favorites WHERE uuid = ?", uuid); err != nil {
		return err
	}
	return nil
}

// ---- facets ----

// Countries lists country facets (value = ISO code) with station counts.
func (s *Store) Countries(prefix string, limit int) ([]Facet, error) {
	q := "SELECT country, MAX(countryname), COUNT(*) n FROM stations WHERE active = 1 AND country <> ''"
	args := []any{}
	if p := strings.TrimSpace(prefix); p != "" {
		q += " AND country LIKE ? ESCAPE '\\'"
		args = append(args, strings.ToUpper(p)+"%")
	}
	return s.queryFacets(q+" GROUP BY country ORDER BY n DESC, country", limit, args)
}

// Languages lists language facets from the lang junction table.
func (s *Store) Languages(prefix string, limit int) ([]Facet, error) {
	q := "SELECT lang, lang, COUNT(*) n FROM station_lang WHERE lang <> ''"
	args := []any{}
	if p := strings.TrimSpace(prefix); p != "" {
		q += " AND lang LIKE ? ESCAPE '\\'"
		args = append(args, escapeLike(strings.ToLower(p))+"%")
	}
	return s.queryFacets(q+" GROUP BY lang ORDER BY n DESC, lang", limit, args)
}

// Tags lists tag facets from the tag junction table.
func (s *Store) Tags(prefix string, limit int) ([]Facet, error) {
	q := "SELECT tag, tag, COUNT(*) n FROM station_tag WHERE tag <> ''"
	args := []any{}
	if p := strings.TrimSpace(prefix); p != "" {
		q += " AND tag LIKE ? ESCAPE '\\'"
		args = append(args, escapeLike(strings.ToLower(p))+"%")
	}
	return s.queryFacets(q+" GROUP BY tag ORDER BY n DESC, tag", limit, args)
}

func (s *Store) queryFacets(query string, limit int, args []any) ([]Facet, error) {
	if limit <= 0 || limit > 1000 {
		limit = 300
	}
	rows, err := s.db.Query(query+" LIMIT ?", append(args, limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Facet{}
	for rows.Next() {
		var f Facet
		if err := rows.Scan(&f.Value, &f.Label, &f.Count); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// ---- meta ----

// GetMeta reads a meta value.
func (s *Store) GetMeta(key string) (string, bool, error) {
	var v string
	err := s.db.QueryRow("SELECT value FROM meta WHERE key = ?", key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return v, err == nil, err
}

// SetMeta writes a meta value.
func (s *Store) SetMeta(key, value string) error {
	_, err := s.db.Exec("INSERT INTO meta(key, value) VALUES(?, ?) "+
		"ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
	return err
}

// CatalogSize returns the number of active catalog (non-custom) stations.
func (s *Store) CatalogSize() (int, error) {
	var n int
	err := s.db.QueryRow("SELECT COUNT(*) FROM stations WHERE active = 1 AND custom = 0").Scan(&n)
	return n, err
}

// ---- catalog publish ----

// PublishCatalog atomically replaces the catalog: non-custom stations are
// deactivated, the incoming set is upserted, and language/tag tokens are
// rebuilt. Favorites and history survive because rows are never deleted.
func (s *Store) PublishCatalog(stations []model.Station) error {
	// Dedup by uuid first; the directory occasionally returns duplicates.
	uniq := make(map[string]model.Station, len(stations))
	order := make([]string, 0, len(stations))
	for _, st := range stations {
		if _, dup := uniq[st.StationUUID]; !dup {
			uniq[st.StationUUID] = st
			order = append(order, st.StationUUID)
		}
	}

	var prev int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM stations WHERE active = 1 AND custom = 0").Scan(&prev); err != nil {
		return err
	}
	if prev > 1000 && len(uniq) < prev*3/4 {
		return fmt.Errorf("%w: previous %d, incoming %d", ErrShrink, prev, len(uniq))
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec("UPDATE stations SET active = 0 WHERE custom = 0"); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM station_lang"); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM station_tag"); err != nil {
		return err
	}

	upsert, err := tx.Prepare("INSERT INTO stations(uuid, name, search, country, countryname, bitrate, votes, clickcount, custom, active, json) " +
		"VALUES(?,?,?,?,?,?,?,?,0,1,?) ON CONFLICT(uuid) DO UPDATE SET name=excluded.name, search=excluded.search, " +
		"country=excluded.country, countryname=excluded.countryname, bitrate=excluded.bitrate, votes=excluded.votes, " +
		"clickcount=excluded.clickcount, json=excluded.json, active=1")
	if err != nil {
		return err
	}
	defer upsert.Close()
	insLang, err := tx.Prepare("INSERT INTO station_lang(uuid, lang) VALUES(?, ?)")
	if err != nil {
		return err
	}
	defer insLang.Close()
	insTag, err := tx.Prepare("INSERT INTO station_tag(uuid, tag) VALUES(?, ?)")
	if err != nil {
		return err
	}
	defer insTag.Close()

	for _, uuid := range order {
		st := uniq[uuid]
		if _, err := upsert.Exec(st.StationUUID, st.Name, st.SearchText(), strings.ToUpper(st.CountryCode),
			strings.ToLower(st.Country), st.Bitrate, st.Votes, st.ClickCount, stationJSON(st)); err != nil {
			return err
		}
		for _, lang := range st.Languages() {
			if _, err := insLang.Exec(st.StationUUID, lang); err != nil {
				return err
			}
		}
		for _, tag := range st.TagList() {
			if _, err := insTag.Exec(st.StationUUID, tag); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

// insertTokens writes language/tag rows for a single custom station.
func (s *Store) insertTokens(st *model.Station) error {
	for _, lang := range st.Languages() {
		if _, err := s.db.Exec("INSERT INTO station_lang(uuid, lang) VALUES(?, ?)", st.StationUUID, lang); err != nil {
			return err
		}
	}
	for _, tag := range st.TagList() {
		if _, err := s.db.Exec("INSERT INTO station_tag(uuid, tag) VALUES(?, ?)", st.StationUUID, tag); err != nil {
			return err
		}
	}
	return nil
}

func stationJSON(st model.Station) string {
	b, err := json.Marshal(st)
	if err != nil {
		return "{}"
	}
	return string(b)
}
