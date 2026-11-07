package app

import (
	"net/http"
	"time"

	"radio-desktop/internal/directory"
	"radio-desktop/internal/network"
)

// StartNetwork initializes the persisted policy before any requests or UI
// callbacks start. Saved network settings take effect on the next launch.
func StartNetwork(s *Service) (*network.Session, error) {
	v := s.GetSettings()
	n, err := network.New(network.Config{Mode: v.ProxyMode, URL: v.ProxyURL})
	if err != nil {
		return nil, err
	}
	s.network = n
	s.dir = directory.New(directory.Options{UserAgent: userAgent, Transport: n.Transport})
	s.np.httpClient = &http.Client{Transport: n.Transport, Timeout: 10 * time.Second}
	return n, nil
}

func (s *Service) mediaURL(raw string) string {
	return s.network.MediaURL(raw)
}

func (s *Service) preparePlayInfo(info PlayInfo) PlayInfo {
	info.Station.Favicon = s.mediaURL(info.Station.Favicon)
	if s.network != nil {
		info.NativeCandidates = make([]string, len(info.Candidates))
		for i, raw := range info.Candidates {
			info.NativeCandidates[i] = s.mediaURL(raw)
		}
	}
	return info
}
