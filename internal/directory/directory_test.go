package directory

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"radio-desktop/internal/model"
)

const uuidA = "aaaaaaaa-1111-2222-3333-444444444444"
const uuidB = "bbbbbbbb-1111-2222-3333-444444444444"

func stationJSON(uuid, name string) string {
	b, _ := json.Marshal(model.Station{StationUUID: uuid, Name: name, URL: "https://s/" + uuid})
	return string(b)
}

// fakeAPI serves /json/servers and a paginated /json/stations/search.
func fakeAPI(t *testing.T, pages [][]string, clickPath *atomic.Int32) *httptest.Server {
	t.Helper()
	var api *httptest.Server
	api = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/json/servers":
			w.Write([]byte(`[{"name":"` + api.URL + `"}]`))
		case r.URL.Path == "/json/url/"+uuidA:
			if r.Method != http.MethodPost {
				t.Errorf("click must be POST, got %s", r.Method)
			}
			clickPath.Add(1)
			w.Write([]byte(`{"ok":true}`))
		case r.URL.Path == "/json/stations/search":
			offset := r.URL.Query().Get("offset")
			if r.URL.Query().Get("hidebroken") != "true" {
				t.Errorf("hidebroken missing")
			}
			page := 0
			if offset != "" {
				for _, c := range offset {
					page = page*10 + int(c-'0')
				}
				page /= PageSize
			}
			if page >= len(pages) {
				w.Write([]byte(`[]`))
				return
			}
			w.Write([]byte("[" + strings.Join(pages[page], ",") + "]"))
		default:
			http.NotFound(w, r)
		}
	}))
	return api
}

func TestFetchAllPaginatesAndValidates(t *testing.T) {
	full := make([]string, PageSize)
	for i := range full {
		full[i] = stationJSON(uuidA, "Station")
	}
	short := []string{
		stationJSON(uuidA, "Kept"),
		stationJSON(uuidB, ""),              // dropped: empty name
		`{"stationuuid":"nope","name":"X"}`, // dropped: bad uuid
	}
	clicks := &atomic.Int32{}
	api := fakeAPI(t, [][]string{full, short}, clicks)
	client := New(Options{ServersURL: api.URL + "/json/servers", UserAgent: "test"})

	var progress []Progress
	stations, err := client.FetchAll(context.Background(), func(p Progress) { progress = append(progress, p) })
	if err != nil {
		t.Fatal(err)
	}
	if len(stations) != PageSize+1 {
		t.Fatalf("stations = %d, want %d", len(stations), PageSize+1)
	}
	if len(progress) != 2 || progress[1].Pages != 2 {
		t.Fatalf("progress = %+v", progress)
	}
	if stations[PageSize].Name != "Kept" {
		t.Fatalf("last station = %+v", stations[PageSize])
	}
}

func TestBootstrapUsesClickcount(t *testing.T) {
	var orderSeen atomic.Value
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/json/stations/search":
			orderSeen.Store(r.URL.Query().Encode())
			w.Write([]byte("[" + stationJSON(uuidA, "Top") + "]"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer api.Close()
	client := New(Options{APIURL: api.URL, UserAgent: "test"})
	stations, err := client.Bootstrap(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(stations) != 1 || stations[0].Name != "Top" {
		t.Fatalf("bootstrap = %+v", stations)
	}
	q := orderSeen.Load().(string)
	if !strings.Contains(q, "order=clickcount") || !strings.Contains(q, "reverse=true") {
		t.Fatalf("bootstrap must order by clickcount desc, got %q", q)
	}
}

func TestClickReporting(t *testing.T) {
	clicks := &atomic.Int32{}
	api := fakeAPI(t, nil, clicks)
	client := New(Options{APIURL: api.URL, UserAgent: "test"})
	client.ReportClick(uuidA)
	deadline := time.Now().Add(2 * time.Second)
	for clicks.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if clicks.Load() != 1 {
		t.Fatalf("click not reported")
	}
}

func TestFixedAPIURLSkipsDiscovery(t *testing.T) {
	clicks := &atomic.Int32{}
	api := fakeAPI(t, [][]string{{stationJSON(uuidA, "S")}}, clicks)
	discovery := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("servers endpoint must not be called when APIURL is set")
	}))
	defer discovery.Close()

	client := New(Options{ServersURL: discovery.URL, APIURL: api.URL, UserAgent: "test"})
	if _, err := client.Bootstrap(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestFailoverBetweenServers(t *testing.T) {
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusInternalServerError)
	}))
	defer bad.Close()
	clicks := &atomic.Int32{}
	good := fakeAPI(t, [][]string{{stationJSON(uuidA, "Ok")}}, clicks)

	discovery := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"name":"` + bad.URL + `"},{"name":"` + good.URL + `"}]`))
	}))
	defer discovery.Close()

	client := New(Options{ServersURL: discovery.URL, UserAgent: "test"})
	stations, err := client.Bootstrap(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(stations) != 1 {
		t.Fatalf("failover stations = %+v", stations)
	}
}
