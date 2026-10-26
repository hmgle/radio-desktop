// Package app wires the store, directory client and ICY sidecar into the
// service mygo.Bind exposes to the frontend: the typed IPC surface of the
// app, plus the events pushed to the page.
package app

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"radio-desktop/internal/directory"
	"radio-desktop/internal/icy"
	"radio-desktop/internal/model"
	"radio-desktop/internal/store"
)

const (
	// autoSyncDays refreshes a catalog older than this on startup
	// (radio-cli's auto_sync_days).
	autoSyncDays = 7
	// defaultVolume matches radio-cli's default.
	defaultVolume = 80
	userAgent     = "radio-desktop/0.1.0"
)

// Events pushed to the frontend. Subscribe with the generated client.
var (
	// EventICYMeta carries ICY name/genre/title of the playing stream.
	EventICYMeta = mygo.NewEvent[icy.Meta]("icyMeta")
	// EventSyncProgress reports catalog sync page progress.
	EventSyncProgress = mygo.NewEvent[directory.Progress]("syncProgress")
	// EventSyncDone fires when a sync finishes (Error == "" on success).
	EventSyncDone = mygo.NewEvent[SyncResult]("syncDone")
)

// SyncResult is the outcome of a catalog sync.
type SyncResult struct {
	Error string `json:"error"`
	Total int    `json:"total"`
	// Phase is "bootstrap" for the quick first-run top list, "full" for
	// the complete catalog.
	Phase string `json:"phase"`
}

// PlayInfo is returned by PlayStation/PlayURL: what to load into the
// <audio> element and in which order to fall back.
type PlayInfo struct {
	Station    model.Station `json:"station"`
	Candidates []string      `json:"candidates"`
}

// Status is the startup snapshot for resuming the previous session.
type Status struct {
	Volume          int    `json:"volume"`
	LastStationUUID string `json:"lastStationUUID"`
	LastSyncAt      int64  `json:"lastSyncAt"` // unix seconds, 0 = never
	CatalogSize     int    `json:"catalogSize"`
	Syncing         bool   `json:"syncing"`
}

// Service is bound to the frontend with mygo.Bind. All methods are safe
// to call from the UI.
type Service struct {
	store *store.Store
	dir   *directory.Client

	mu         sync.Mutex
	sidecar    *icy.Sidecar
	playingURL string
	syncing    bool
	syncCancel context.CancelFunc
}

// New creates the service.
func New(st *store.Store, dir *directory.Client) *Service {
	return &Service{store: st, dir: dir}
}

// StartupSync kicks a background sync when the catalog is empty or stale.
// Call once after the app is ready.
func (s *Service) StartupSync() {
	last, _ := s.lastSyncTime()
	size, err := s.store.CatalogSize()
	if err != nil {
		log.Printf("startup sync: %v", err)
		return
	}
	stale := time.Since(last) > autoSyncDays*24*time.Hour
	if size == 0 || stale {
		go s.SyncNow()
	}
}

// ---- station queries ----

// Search runs a station list query.
func (s *Service) Search(req store.SearchRequest) (store.SearchResult, error) {
	if req.Limit <= 0 || req.Limit > 500 {
		req.Limit = 50
	}
	if req.Offset < 0 {
		req.Offset = 0
	}
	return s.store.Search(req)
}

// GetStation returns one station by uuid.
func (s *Service) GetStation(uuid string) (model.Station, error) {
	st, ok, err := s.store.GetStation(uuid)
	if err != nil {
		return model.Station{}, err
	}
	if !ok {
		return model.Station{}, fmt.Errorf("station %s not found", uuid)
	}
	return st, nil
}

// Countries lists country facets for the filter dropdown.
func (s *Service) Countries(prefix string) ([]store.Facet, error) {
	return s.store.Countries(prefix, 300)
}

// Languages lists language facets for the filter dropdown.
func (s *Service) Languages(prefix string) ([]store.Facet, error) {
	return s.store.Languages(prefix, 300)
}

// Tags lists tag facets for the filter dropdown.
func (s *Service) Tags(prefix string) ([]store.Facet, error) {
	return s.store.Tags(prefix, 300)
}

// ---- favorites ----

// AddFavorite marks a station favorite.
func (s *Service) AddFavorite(uuid string) error { return s.store.AddFavorite(uuid) }

// RemoveFavorite unmarks a station.
func (s *Service) RemoveFavorite(uuid string) error { return s.store.RemoveFavorite(uuid) }

// ---- custom stations ----

// AddCustomStation adds a user-defined station.
func (s *Service) AddCustomStation(name, url, homepage string) (model.Station, error) {
	name = strings.TrimSpace(name)
	url = strings.TrimSpace(url)
	if name == "" {
		return model.Station{}, errors.New("名称不能为空")
	}
	st := model.Station{
		Name:     name,
		URL:      url,
		Homepage: strings.TrimSpace(homepage),
	}
	if st.StreamCandidates(nil) == nil {
		return model.Station{}, errors.New("URL 必须是 http(s) 地址")
	}
	if err := s.store.AddCustomStation(&st); err != nil {
		return model.Station{}, err
	}
	st.TagsList = st.TagList()
	return st, nil
}

// RemoveCustomStation deletes a user-defined station.
func (s *Service) RemoveCustomStation(uuid string) error { return s.store.RemoveCustomStation(uuid) }

// ---- playback ----

// GetPlayInfo returns a station with its candidate URLs without starting
// playback — used to arm the last session's station on startup.
func (s *Service) GetPlayInfo(uuid string) (PlayInfo, error) {
	st, ok, err := s.store.GetStation(uuid)
	if err != nil {
		return PlayInfo{}, err
	}
	if !ok {
		return PlayInfo{}, fmt.Errorf("station %s not found", uuid)
	}
	return PlayInfo{Station: st, Candidates: st.StreamCandidates(nil)}, nil
}

// PlayStation selects a station for playback: the ICY sidecar starts and
// the last-station preference is saved; the frontend <audio> plays
// Candidates in order.
func (s *Service) PlayStation(uuid string) (PlayInfo, error) {
	info, err := s.GetPlayInfo(uuid)
	if err != nil {
		return PlayInfo{}, err
	}
	if len(info.Candidates) == 0 {
		return PlayInfo{}, errors.New("该电台没有可播放的 http(s) 地址")
	}
	s.startSidecar(info.Candidates[0])
	if err := s.store.SetMeta("pref_last_station", uuid); err != nil {
		log.Printf("save last station: %v", err)
	}
	return info, nil
}

// PlayURL plays an arbitrary stream URL without adding it to the catalog.
func (s *Service) PlayURL(url string) (PlayInfo, error) {
	url = strings.TrimSpace(url)
	st := model.Station{Name: hostOf(url), URL: url}
	candidates := st.StreamCandidates(nil)
	if len(candidates) == 0 {
		return PlayInfo{}, errors.New("URL 必须是 http(s) 地址")
	}
	st.TagsList = []string{}
	info := PlayInfo{Station: st, Candidates: candidates}
	s.startSidecar(candidates[0])
	// Ephemeral streams are not persisted as the last station.
	return info, nil
}

// ReportStarted is called by the frontend once the <audio> element is
// actually playing: it records history and reports the click to
// Radio Browser. Ephemeral URL plays pass an empty uuid and do nothing.
func (s *Service) ReportStarted(uuid string) error {
	if uuid == "" {
		return nil
	}
	if err := s.store.AddPlay(uuid); err != nil {
		return err
	}
	if model.ValidUUID(uuid) { // only catalog stations are known upstream
		go s.dir.ReportClick(uuid)
	}
	return nil
}

// StopPlayback stops the ICY sidecar (the audio element stops itself).
func (s *Service) StopPlayback() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sidecar != nil {
		s.sidecar.Stop()
		s.sidecar = nil
	}
	s.playingURL = ""
}

// SetVolume persists the volume preference.
func (s *Service) SetVolume(volume int) error {
	if volume < 0 {
		volume = 0
	}
	if volume > 100 {
		volume = 100
	}
	return s.store.SetMeta("pref_volume", strconv.Itoa(volume))
}

// GetStatus returns the startup snapshot: volume, last station, sync state.
func (s *Service) GetStatus() (Status, error) {
	vol := defaultVolume
	if v, ok, err := s.store.GetMeta("pref_volume"); err != nil {
		return Status{}, err
	} else if ok {
		if n, err := strconv.Atoi(v); err == nil {
			vol = n
		}
	}
	lastUUID, _, _ := s.store.GetMeta("pref_last_station")
	size, err := s.store.CatalogSize()
	if err != nil {
		return Status{}, err
	}
	lastSync, _ := s.lastSyncTime()
	s.mu.Lock()
	syncing := s.syncing
	s.mu.Unlock()
	return Status{
		Volume:          vol,
		LastStationUUID: lastUUID,
		LastSyncAt:      lastSync.Unix(),
		CatalogSize:     size,
		Syncing:         syncing,
	}, nil
}

// ---- sync ----

// SyncNow starts a background catalog sync. It returns immediately; the
// UI follows progress via the syncProgress/syncDone events. On an empty
// catalog the quick bootstrap lands first so stations are playable within
// seconds, then the full sync continues.
func (s *Service) SyncNow() {
	s.mu.Lock()
	if s.syncing {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.syncing = true
	s.syncCancel = cancel
	s.mu.Unlock()

	go func() {
		result := s.sync(ctx)
		if result.Error != "" {
			log.Printf("sync: %s", result.Error)
		}
		s.mu.Lock()
		s.syncing = false
		s.syncCancel = nil
		s.mu.Unlock()
		EventSyncDone.Broadcast(result)
	}()
}

func (s *Service) sync(ctx context.Context) SyncResult {
	size, err := s.store.CatalogSize()
	if err != nil {
		return SyncResult{Error: err.Error()}
	}
	if size == 0 {
		top, err := s.dir.Bootstrap(ctx)
		if err != nil {
			return SyncResult{Error: "bootstrap 失败: " + err.Error()}
		}
		if err := s.store.PublishCatalog(top); err != nil {
			return SyncResult{Error: "bootstrap 写入失败: " + err.Error()}
		}
		EventSyncDone.Broadcast(SyncResult{Total: len(top), Phase: "bootstrap"})
	}

	stations, err := s.dir.FetchAll(ctx, func(p directory.Progress) {
		EventSyncProgress.Broadcast(p)
	})
	if err != nil {
		if ctx.Err() != nil {
			return SyncResult{Error: "同步已取消"}
		}
		return SyncResult{Error: "同步失败: " + err.Error()}
	}
	if err := s.store.PublishCatalog(stations); err != nil {
		if errors.Is(err, store.ErrShrink) {
			return SyncResult{Error: "同步中止：新目录数量异常缩减，已保留旧目录（" + err.Error() + "）"}
		}
		return SyncResult{Error: "写入失败: " + err.Error()}
	}
	if err := s.store.SetMeta("last_sync", strconv.FormatInt(time.Now().Unix(), 10)); err != nil {
		log.Printf("save last_sync: %v", err)
	}
	return SyncResult{Total: len(stations), Phase: "full"}
}

// ---- helpers ----

func (s *Service) startSidecar(url string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sidecar != nil {
		s.sidecar.Stop()
	}
	s.playingURL = url
	s.sidecar = icy.Start(url, userAgent, func(m icy.Meta) {
		EventICYMeta.Broadcast(m)
	})
}

func (s *Service) lastSyncTime() (time.Time, error) {
	v, ok, err := s.store.GetMeta("last_sync")
	if err != nil || !ok {
		return time.Time{}, err
	}
	sec, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return time.Time{}, nil
	}
	return time.Unix(sec, 0), nil
}

func hostOf(rawURL string) string {
	if u, err := url.Parse(rawURL); err == nil && u.Host != "" {
		return u.Host
	}
	return rawURL
}
