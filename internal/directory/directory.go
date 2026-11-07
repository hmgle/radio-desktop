// Package directory talks to the Radio Browser API: server discovery,
// catalog bootstrap, full sync and click reporting. The protocol follows
// radio-cli's src/directory.rs — pagination by name, up to 200k rows,
// body caps and server failover.
package directory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo/netproxy"

	"radio-desktop/internal/model"
)

const (
	defaultServersURL = "https://all.api.radio-browser.info/json/servers"
	// MaxRows caps a full sync, as radio-cli does.
	MaxRows = 200_000
	// PageSize is the Radio Browser page size; a page larger than this
	// means pagination broke and offsets are skipping rows.
	PageSize = 1000
	// maxBodyBytes caps one page response.
	maxBodyBytes = 16 << 20
	// requestTimeout bounds one HTTP request.
	requestTimeout = 20 * time.Second
	// maxServerTries limits failover attempts per request.
	maxServerTries = 3
)

// Options configures a Client. Zero values get production defaults.
type Options struct {
	ServersURL string // endpoint listing API servers
	APIURL     string // fixed API base URL, overriding discovery
	UserAgent  string
	Transport  http.RoundTripper
}

// Client is a Radio Browser API client with sticky-server failover.
type Client struct {
	opts        Options
	httpClient  *http.Client
	mu          sync.Mutex
	servers     []string // base URLs like https://de1.api.radio-browser.info
	current     int      // index of the sticky server
	serverKnown bool
}

// New creates a client.
func New(opts Options) *Client {
	if opts.ServersURL == "" {
		opts.ServersURL = defaultServersURL
	}
	if opts.UserAgent == "" {
		opts.UserAgent = "radio-desktop/0.2.1"
	}
	if opts.Transport == nil {
		opts.Transport = netproxy.Transport()
	}
	return &Client{
		opts:       opts,
		httpClient: &http.Client{Transport: opts.Transport, Timeout: requestTimeout},
	}
}

// Progress reports sync progress after each fetched page.
type Progress struct {
	Pages    int `json:"pages"`
	Fetched  int `json:"fetched"`
	Accepted int `json:"accepted"` // rows that passed validation
}

// ErrNoServers means no usable API server was found.
var ErrNoServers = errors.New("directory: no usable radio-browser server")

type serverEntry struct {
	Name string `json:"name"`
}

func (c *Client) serverList(ctx context.Context) ([]string, error) {
	if c.opts.APIURL != "" {
		return []string{strings.TrimRight(c.opts.APIURL, "/")}, nil
	}
	c.mu.Lock()
	known := c.serverKnown
	c.mu.Unlock()
	if known {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.servers, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.opts.ServersURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", c.opts.UserAgent)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("directory: servers endpoint: %s", resp.Status)
	}
	var entries []serverEntry
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBodyBytes)).Decode(&entries); err != nil {
		return nil, err
	}
	servers := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.Name == "" {
			continue
		}
		if strings.HasPrefix(e.Name, "http://") || strings.HasPrefix(e.Name, "https://") {
			servers = append(servers, strings.TrimRight(e.Name, "/"))
		} else {
			servers = append(servers, "https://"+e.Name)
		}
	}
	if len(servers) == 0 {
		return nil, ErrNoServers
	}
	rand.Shuffle(len(servers), func(i, j int) { servers[i], servers[j] = servers[j], servers[i] })

	c.mu.Lock()
	c.servers = servers
	c.current = 0
	c.serverKnown = true
	c.mu.Unlock()
	return servers, nil
}

// getJSON fetchs path from one of the servers, failing over to the next
// on error. The successful server becomes sticky.
func (c *Client) getJSON(ctx context.Context, path string, out any) error {
	servers, err := c.serverList(ctx)
	if err != nil {
		return err
	}
	c.mu.Lock()
	start := c.current
	c.mu.Unlock()

	var lastErr error
	for try := 0; try < maxServerTries && try < len(servers); try++ {
		idx := (start + try) % len(servers)
		base := servers[idx]
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", c.opts.UserAgent)
		resp, err := c.httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			lastErr = fmt.Errorf("directory: %s: %s", base, resp.Status)
			continue
		}
		err = json.NewDecoder(io.LimitReader(resp.Body, maxBodyBytes)).Decode(out)
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}
		c.mu.Lock()
		c.current = idx
		c.mu.Unlock()
		return nil
	}
	return lastErr
}

// fetchPage downloads one search page.
func (c *Client) fetchPage(ctx context.Context, order string, reverse bool, offset int) ([]model.Station, error) {
	q := url.Values{}
	q.Set("limit", strconv.Itoa(PageSize))
	q.Set("offset", strconv.Itoa(offset))
	q.Set("hidebroken", "true")
	q.Set("order", order)
	q.Set("reverse", strconv.FormatBool(reverse))
	var stations []model.Station
	if err := c.getJSON(ctx, "/json/stations/search?"+q.Encode(), &stations); err != nil {
		return nil, err
	}
	return stations, nil
}

// valid filters rows the same way radio-cli does: a name and a well-formed
// stationuuid.
func valid(st model.Station) bool {
	return strings.TrimSpace(st.Name) != "" && model.ValidUUID(st.StationUUID)
}

// Bootstrap fetches the top PageSize stations by click count so a fresh
// install has something to play within seconds.
func (c *Client) Bootstrap(ctx context.Context) ([]model.Station, error) {
	page, err := c.fetchPage(ctx, "clickcount", true, 0)
	if err != nil {
		return nil, err
	}
	out := make([]model.Station, 0, len(page))
	for _, st := range page {
		if valid(st) {
			out = append(out, st)
		}
	}
	return out, nil
}

// FetchAll walks the whole directory ordered by name (stable pagination)
// and reports progress after each page. It stops on a short page, when the
// row cap is reached, or when a page looks over-sized (pagination error).
func (c *Client) FetchAll(ctx context.Context, onProgress func(Progress)) ([]model.Station, error) {
	var all []model.Station
	seen := 0
	for offset := 0; offset < MaxRows; offset += PageSize {
		page, err := c.fetchPage(ctx, "name", false, offset)
		if err != nil {
			return nil, err
		}
		if len(page) > PageSize {
			return nil, fmt.Errorf("directory: page at offset %d returned %d rows (pagination error)", offset, len(page))
		}
		accepted := 0
		for _, st := range page {
			if valid(st) {
				all = append(all, st)
				accepted++
			}
		}
		seen += len(page)
		if onProgress != nil {
			onProgress(Progress{Pages: offset/PageSize + 1, Fetched: seen, Accepted: len(all)})
		}
		if len(page) < PageSize {
			break
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return all, nil
}

// ReportClick tells Radio Browser the station was played. Best effort:
// errors are ignored and the call never blocks for long.
func (c *Client) ReportClick(uuid string) {
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()
	servers, err := c.serverList(ctx)
	if err != nil {
		return
	}
	c.mu.Lock()
	base := servers[c.current%len(servers)]
	c.mu.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		base+"/json/url/"+url.PathEscape(uuid), nil)
	if err != nil {
		return
	}
	req.Header.Set("User-Agent", c.opts.UserAgent)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
}
