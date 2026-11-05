package app

import (
	"errors"
	"net/url"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/transfer"
)

// CopyText uses the native clipboard, including on webviews without the
// browser Clipboard API.
func (s *Service) CopyText(text string) error {
	return mygo.Clipboard.Write(transfer.TextData(text))
}

// OpenHomepage opens station links in the default browser.
func (s *Service) OpenHomepage(rawURL string) error {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return errors.New("radio:invalidURL")
	}
	return mygo.Shell.OpenExternal(u.String())
}
