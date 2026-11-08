package network

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
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
	access chan struct{}
	kind   resourceKind // protected by access
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
// request. Once identified, the same route keeps its representation across
// methods. Typed playlist references never need a classification request.
func (r *relay) open(req *http.Request, target *url.URL, kind resourceKind, identity string) (resourceKind, *http.Response, error) {
	if kind != resourceUnknown {
		resp, err := r.request(req, target, kind)
		return kind, resp, err
	}
	// Entries exist only for signed targets actually requested by a player.
	// A failed probe is not cached, so a later attempt can recover.
	value, _ := r.types.LoadOrStore(identity, &resourceType{access: make(chan struct{}, 1)})
	state := value.(*resourceType)
	deadline := time.Now().Add(r.probeTimeout)
	wait := time.NewTimer(r.probeTimeout)
	defer wait.Stop()
	select {
	case state.access <- struct{}{}:
	case <-req.Context().Done():
		return resourceUnknown, nil, req.Context().Err()
	case <-wait.C:
		return resourceUnknown, nil, errProbeTimeout
	}
	unlock := func() { <-state.access }
	if state.kind != resourceUnknown && state.kind != "" {
		kind = state.kind
		unlock()
		resp, err := r.request(req, target, kind)
		return kind, resp, err
	}
	kind, resp, err := r.probe(req, target, time.Until(deadline))
	if err == nil && kind != resourceUnknown {
		state.kind = kind
	}
	unlock()
	if err != nil || kind == resourceUnknown {
		return kind, resp, err
	}
	if kind == resourceBinary && req.Method == http.MethodGet && req.Header.Get("Range") != "" {
		// No ranged response has been requested yet. Only after the type is
		// known do we issue a binary range request; nothing can replace a
		// successful response with the outcome of a speculative refetch.
		resp.Body.Close()
		resp, err = r.request(req, target, kind)
	}
	return kind, resp, err
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
