package app

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"radio-desktop/internal/directory"
	"radio-desktop/internal/icy"
)

// Use a fresh process: Go caches proxy environment variables, and GIO
// initializes its resolver once. A local proxy serves an unresolvable host
// so a working internet connection cannot mask a bypass.
func TestProxyRouting(t *testing.T) {
	if os.Getenv("RADIO_PROXY_CHILD") == "1" {
		checkProxyRequests(t)
		return
	}
	for _, mode := range []string{"environment", "system"} {
		t.Run(mode, func(t *testing.T) {
			if mode == "system" && (runtime.GOOS != "linux" || os.Getenv("RADIO_SYSTEM_PROXY_TEST") != "1") {
				t.Skip("set RADIO_SYSTEM_PROXY_TEST=1 on Linux with the GIO GNOME proxy resolver installed")
			}
			var mu sync.Mutex
			seen := map[string]int{}
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !r.URL.IsAbs() || r.URL.Hostname() != "radio-proxy.invalid" {
					t.Errorf("unexpected proxy request: %s", r.URL)
					http.Error(w, "unexpected host", http.StatusBadGateway)
					return
				}
				mu.Lock()
				seen[r.Method+" "+r.URL.Path]++
				mu.Unlock()
				switch r.URL.Path {
				case "/servers":
					fmt.Fprint(w, `[{"name":"http://radio-proxy.invalid"}]`)
				case "/json/stations/search":
					fmt.Fprint(w, `[{"stationuuid":"aaaaaaaa-1111-2222-3333-444444444444","name":"Proxy FM"}]`)
				case "/json/url/aaaaaaaa-1111-2222-3333-444444444444":
					fmt.Fprint(w, `{}`)
				case "/stream":
					w.Header().Set("icy-name", "Proxy FM")
				case "/cover.png":
					w.Write(pngHeader)
				default:
					http.Error(w, "proxy failure", http.StatusBadGateway)
				}
			}))
			defer proxy.Close()
			var directRequests atomic.Int32
			local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				directRequests.Add(1)
				w.Write(pngHeader)
			}))
			defer local.Close()

			root := t.TempDir()
			env := []string{}
			for _, entry := range os.Environ() {
				key, _, _ := strings.Cut(entry, "=")
				switch strings.ToUpper(key) {
				case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "REQUEST_METHOD",
					"XDG_CONFIG_HOME", "XDG_CURRENT_DESKTOP", "GSETTINGS_BACKEND", "GIO_USE_PROXY_RESOLVER",
					"RADIO_PROXY_CHILD", "RADIO_PROXY_LOCAL":
					continue
				}
				env = append(env, entry)
			}
			env = append(env, "RADIO_PROXY_CHILD=1", "RADIO_PROXY_LOCAL="+local.URL,
				"XDG_CONFIG_HOME="+root, "GSETTINGS_BACKEND=keyfile")
			if mode == "environment" {
				env = append(env, "HTTP_PROXY="+proxy.URL, "HTTPS_PROXY="+proxy.URL)
			} else {
				// Keep the real user's desktop settings untouched. GIO reads
				// this private keyfile as if the proxy were set in GNOME.
				p, _ := url.Parse(proxy.URL)
				configDir := filepath.Join(root, "glib-2.0", "settings")
				if err := os.MkdirAll(configDir, 0o700); err != nil {
					t.Fatal(err)
				}
				config := fmt.Sprintf("[system/proxy]\nmode='manual'\n[system/proxy/http]\nhost='127.0.0.1'\nport=%s\n", p.Port())
				if err := os.WriteFile(filepath.Join(configDir, "keyfile"), []byte(config), 0o600); err != nil {
					t.Fatal(err)
				}
				env = append(env, "GIO_USE_PROXY_RESOLVER=gnome", "XDG_CURRENT_DESKTOP=GNOME")
			}
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, executable, "-test.run=^TestProxyRouting$", "-test.v")
			cmd.Env = env
			if output, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("proxy subprocess: %v\n%s", err, output)
			}
			mu.Lock()
			defer mu.Unlock()
			for path, want := range map[string]int{
				"GET /servers": 1, "GET /json/stations/search": 2,
				"POST /json/url/aaaaaaaa-1111-2222-3333-444444444444": 1,
				"GET /stream": 1, "GET /cover.png": 1, "GET /failed": 1,
			} {
				if seen[path] != want {
					t.Errorf("proxy received %s %d times; want %d", path, seen[path], want)
				}
			}
			if directRequests.Load() != 1 {
				t.Errorf("loopback requests = %d; want 1", directRequests.Load())
			}
		})
	}
}

func checkProxyRequests(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := directory.New(directory.Options{ServersURL: "http://radio-proxy.invalid/servers"})
	if stations, err := c.Bootstrap(ctx); err != nil || len(stations) != 1 {
		t.Fatalf("bootstrap through proxy: %v, %v", stations, err)
	}
	if stations, err := c.FetchAll(ctx, nil); err != nil || len(stations) != 1 {
		t.Fatalf("sync through proxy: %v, %v", stations, err)
	}
	c.ReportClick("aaaaaaaa-1111-2222-3333-444444444444")
	metadata := make(chan icy.Meta, 1)
	sidecar := icy.Start("http://radio-proxy.invalid/stream", "test", func(m icy.Meta) { metadata <- m })
	defer sidecar.Stop()
	select {
	case m := <-metadata:
		if m.Name != "Proxy FM" {
			t.Fatalf("metadata through proxy: %+v", m)
		}
	case <-ctx.Done():
		t.Fatal("no ICY metadata through proxy")
	}
	for _, rawURL := range []string{"http://radio-proxy.invalid/cover.png", os.Getenv("RADIO_PROXY_LOCAL")} {
		if art, err := fetchArtwork(rawURL); err != nil || !bytes.Equal(art, pngHeader) {
			t.Fatalf("artwork %s: %x, %v", rawURL, art, err)
		}
	}
	if _, err := fetchArtwork("http://radio-proxy.invalid/failed"); err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("proxy failure was not preserved: %v", err)
	}
}
