package network

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type resourceKind string

const (
	resourceUnknown     resourceKind = "media"
	resourcePlaylist    resourceKind = "playlist.m3u8"
	resourceBinary      resourceKind = "resource"
	defaultProbeTimeout              = 2 * time.Second
)

type resourceType struct {
	probe    chan struct{}
	mu       sync.Mutex
	kind     resourceKind
	revision uint64
}

// An observation proposes a type for one response. Only a validated result
// may replace the cache version it observed; older in-flight responses cannot
// overwrite a newer result. The object itself belongs to one request.
type typeObservation struct {
	state          *resourceType
	revision       uint64
	binaryVerified bool
	done           bool
}

func (s *resourceType) observe() (resourceKind, *typeObservation) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kind, &typeObservation{state: s, revision: s.revision, binaryVerified: s.kind == resourceBinary}
}

func (o *typeObservation) publish(kind resourceKind) {
	if kind == resourceBinary {
		o.binaryVerified = true
	}
	o.state.mu.Lock()
	defer o.state.mu.Unlock()
	if o.revision == o.state.revision {
		o.state.kind = kind
		o.state.revision++
		o.revision = o.state.revision
	}
}

func (o *typeObservation) finish(kind resourceKind) {
	if o == nil || o.done {
		return
	}
	o.done = true
	o.publish(kind)
}

func (o *typeObservation) acceptBinary(resp *http.Response) {
	if o == nil {
		return
	}
	// Multipart and 416 responses can preserve an established type, but
	// cannot establish it after a non-media probe such as an HTML page.
	if resp.StatusCode == http.StatusOK && cacheableBinaryResponse(resp) ||
		o.binaryVerified && (resp.StatusCode == http.StatusPartialContent || resp.StatusCode == http.StatusRequestedRangeNotSatisfiable) {
		o.finish(resourceBinary)
	}
}

var errProbeTimeout = errors.New("media type probe timed out")

func (r *relay) request(req *http.Request, target *url.URL, kind resourceKind) (*http.Response, error) {
	method := req.Method
	if kind == resourcePlaylist {
		method = http.MethodGet
	}
	upstream, err := http.NewRequestWithContext(req.Context(), method, target.String(), nil)
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"Range", "If-Range", "Accept"} {
		if kind == resourcePlaylist && key != "Accept" {
			continue
		}
		if value := req.Header.Get(key); value != "" {
			upstream.Header.Set(key, value)
		}
	}
	upstream.Header.Set("User-Agent", "radio-desktop/0.2.1")
	upstream.Header.Set("Accept-Encoding", "identity")
	return r.client.Do(upstream)
}

// open classifies an unknown signed target before issuing its HEAD or Range
// request. Recognized media types are shared across methods, but an error
// page cannot establish a lasting binary classification. Typed playlist
// references never need a classification request.
func (r *relay) open(req *http.Request, target *url.URL, kind resourceKind, identity string) (resourceKind, *http.Response, *typeObservation, error) {
	if kind != resourceUnknown {
		resp, err := r.request(req, target, kind)
		return kind, resp, nil, err
	}
	// Entries exist only for signed targets actually requested by a player.
	// A failed probe is not cached, so a later attempt can recover.
	value, _ := r.types.LoadOrStore(identity, &resourceType{probe: make(chan struct{}, 1), kind: resourceUnknown})
	state := value.(*resourceType)
	kind, observation := state.observe()
	if kind != resourceUnknown {
		return r.requestDetected(req, target, kind, observation)
	}
	deadline := time.Now().Add(r.probeTimeout)
	wait := time.NewTimer(r.probeTimeout)
	defer wait.Stop()
	select {
	case state.probe <- struct{}{}:
	case <-req.Context().Done():
		return resourceUnknown, nil, nil, req.Context().Err()
	case <-wait.C:
		return resourceUnknown, nil, nil, errProbeTimeout
	}
	unlock := func() { <-state.probe }
	kind, observation = state.observe()
	if kind != resourceUnknown {
		unlock()
		return r.requestDetected(req, target, kind, observation)
	}
	kind, resp, err := r.probe(req, target, time.Until(deadline))
	if err == nil && kind == resourceBinary && cacheableBinaryResponse(resp) {
		// Binary streams need not end. The successful full response and
		// prefix probe establish their type before concurrent ranges start.
		observation.publish(resourceBinary)
	}
	unlock()
	if err != nil || kind == resourceUnknown {
		return kind, resp, observation, err
	}
	if kind == resourceBinary && req.Method == http.MethodGet && req.Header.Get("Range") != "" {
		// No ranged response has been requested yet. Only after the type is
		// known do we issue a binary range request; nothing can replace a
		// successful response with the outcome of a speculative refetch.
		resp.Body.Close()
		return r.requestDetected(req, target, kind, observation)
	}
	return kind, resp, observation, err
}

// requestDetected rechecks header-level HLS signals on learned binary routes.
// Explicitly signed segments and keys bypass this path: their MIME type or
// byte prefix cannot change their role in the playlist.
func (r *relay) requestDetected(req *http.Request, target *url.URL, kind resourceKind, observation *typeObservation) (resourceKind, *http.Response, *typeObservation, error) {
	resp, err := r.request(req, target, kind)
	if err != nil || kind != resourceBinary || !playlistResponse(resp) {
		return kind, resp, observation, err
	}
	if (resp.StatusCode < 200 || resp.StatusCode >= 300) && resp.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		return kind, resp, observation, err
	}
	if req.Method == http.MethodHead || resp.StatusCode == http.StatusPartialContent || resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		// Only a positive playlist signal can trigger a full refetch.
		// A complete GET response can be rewritten without another request.
		resp.Body.Close()
		resp, err = r.request(req, target, resourcePlaylist)
	}
	return resourcePlaylist, resp, observation, err
}

func cacheableBinaryResponse(resp *http.Response) bool {
	typeName := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	// A successful HTML/JSON/text error page is not evidence of binary
	// media. Unrecognized types stay eligible for a later bounded probe.
	switch typeName {
	case "application/octet-stream", "binary/octet-stream", "application/ogg", "application/mp4":
		return true
	}
	return strings.HasPrefix(typeName, "audio/") || strings.HasPrefix(typeName, "video/") || strings.HasPrefix(typeName, "image/")
}

func (r *relay) probe(req *http.Request, target *url.URL, timeout time.Duration) (resourceKind, *http.Response, error) {
	ctx, cancel := context.WithCancel(req.Context())
	expired := make(chan struct{})
	timer := time.AfterFunc(timeout, func() { cancel(); close(expired) })
	stopTimer := func() {
		if !timer.Stop() {
			<-expired
		}
	}
	probeError := func(err error) (resourceKind, *http.Response, error) {
		stopTimer()
		if req.Context().Err() == nil && ctx.Err() != nil {
			err = errProbeTimeout
		}
		cancel()
		return resourceUnknown, nil, err
	}
	// Fetch from byte zero, even when the first client request is HEAD,
	// a short range, or a nonzero range. Never inspect a partial prefix.
	resp, err := r.request(req.WithContext(ctx), target, resourcePlaylist)
	if err != nil {
		return probeError(err)
	}
	body := bufio.NewReader(resp.Body)
	kind := resourceUnknown
	if resp.StatusCode == http.StatusOK {
		kind = resourcePlaylist
		if !playlistResponse(resp) {
			prefix, peekErr := body.Peek(7)
			if peekErr != nil && peekErr != io.EOF {
				resp.Body.Close()
				return probeError(peekErr)
			}
			if string(prefix) != "#EXTM3U" {
				kind = resourceBinary
			}
		}
	} else if resp.StatusCode == http.StatusPartialContent {
		resp.Body.Close()
		return probeError(errors.New("incomplete media type probe"))
	}
	stopTimer()
	if ctx.Err() != nil {
		resp.Body.Close()
		err := ctx.Err()
		if req.Context().Err() == nil {
			err = errProbeTimeout
		}
		cancel()
		return resourceUnknown, nil, err
	}
	// Stop only the probe deadline. The active response remains cancellable
	// by the downstream request, with the prefix available for streaming.
	resp.Body = &probeBody{Reader: body, Closer: resp.Body, cancel: cancel}
	return kind, resp, nil
}

type probeBody struct {
	io.Reader
	io.Closer
	cancel context.CancelFunc
}

func (b *probeBody) Close() error {
	b.cancel()
	return b.Closer.Close()
}

func playlistURL(u *url.URL) bool {
	path := strings.ToLower(u.Path)
	return strings.HasSuffix(path, ".m3u8") || strings.HasSuffix(path, ".m3u")
}

func playlistResponse(resp *http.Response) bool {
	typeName := strings.ToLower(strings.Split(resp.Header.Get("Content-Type"), ";")[0])
	return strings.Contains(typeName, "mpegurl") || playlistURL(resp.Request.URL)
}
