package icy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTitleEncodingRepair(t *testing.T) {
	cases := []struct {
		name, raw, want string
	}{
		// Captured from goldfm.cn:8000/goldfm: valid UTF-8 containing
		// Latin-1 code points rather than the original Chinese title.
		{"goldfm live sample", "é»\u0084å\u0087¯è\u008a¹ - è\u009d¶æ\u0081\u008bè\u008a±", "黄凯芹 - 蝶恋花"},
		{"wrapped UTF-8 with C1 controls", "é\u0082\u009dç¾\u008eäº\u0091 - é\u009bªè\u008a±\x1b\n", "邝美云 - 雪花"},
		{"wrapped UTF-8 accent", "BeyoncÃ© - Café", "Beyoncé - Café"},
		{"wrapped UTF-8 beside Unicode", "CafÃ© — Live", "Café — Live"},
		{"wrapped GBK", "ºÓÍ¼ - ×Ï´¨Â¼", "河图 - 紫川录"},
		{"wrapped GBK beside Unicode", "Íõ·Æ\n - Café（中文电台）", "王菲 - Café（中文电台）"},
		{"raw GBK", "\xba\xd3\xcd\xbc - \xd7\xcf\xb4\xa8\xc2\xbc", "河图 - 紫川录"},
		{"raw GBK beside UTF-8", "\xcd\xf5\xb7\xc6 - 中文电台", "王菲 - 中文电台"},
		{"raw GBK adjacent to UTF-8", "\xcd\xf5\xb7\xc6中文", "王菲中文"},
		{"GBK with valid UTF-8 subsequence", "\xd5\xc5\xb9\xfa\xc8\xd9 - Björk（中文）", "张国荣 - Björk（中文）"},
		{"GBK with valid UTF-8 suffix", "\xba\xd3\xcd\xbc - 中文电台", "河图 - 中文电台"},
		{"wrapped GBK with UTF-8 prefix", "Ã©æ± - 中文电台", "茅姹 - 中文电台"},
		{"raw Latin-1", "Beyonc\xe9", "Beyoncé"},
		{"invalid bytes", "Track\x1b\n\xff", "Trackÿ"},
		{"truncated wrapped UTF-8", "ç\u008e\u008bä", "王�"},
		{"truncated UTF-8 beside Han", "李克\xe5\x8b?- 飞\xe8? (AsiaFM亚洲粤语\xe5\x8f?)", "李克�?- 飞�? (AsiaFM亚洲粤语�?)"},
		{"truncated UTF-8 beside GBK", "\xcd\xf5\xb7\xc6中文\xe8?", "王菲中文�?"},
		{"truncated wrapped UTF-8 beside Unicode", "Björk - Jóga（中文）å\u008f?", "Björk - Jóga（中文）�?"},
		{"ambiguous two-byte UTF-8 lead", "中\xc3?", "中Ã?"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			block := []byte("StreamTitle='" + tc.raw + "';")
			if got := ParseBlock(block)["StreamTitle"]; got != tc.want {
				t.Fatalf("title = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestTitleEncodingPreservesAmbiguousAndUnicodeText(t *testing.T) {
	for _, title := range []string{
		"Radio Swiss Jazz", "张柏芝 - 乱了感觉", "Café à côté",
		"Björk - Jóga", "Motörhead - Ace of Spades", "Sigur Rós - Hoppípolla",
		"ΩΩ - ŹŹ - Ελλάδα - Łódź", "Chloéë", "Chloéë - 中文电台",
		"Café - 中文电台", "Björk - Jóga（中文）", "Café? - 中文电台", "中文é?",
		"Lääke - 中文电台", "Lääke - Jää（中文电台）", "éééé - 中文电台",
		"éé - àà（中文电台）", "Íõ· - 中文电台", "ÖÐÎÄ", "â€™",
		"·Æ - 中文电台", "Íõ - 中文电台", "🎵 音乐 — Live",
	} {
		t.Run(title, func(t *testing.T) {
			if got := cleanTitle([]byte(title)); got != title {
				t.Fatalf("title = %q, want %q", got, title)
			}
		})
	}
}

func TestTitleRepairDoesNotChangeOtherAttributes(t *testing.T) {
	const artwork = "https://example.test/封面/BeyoncÃ©.png"
	block := []byte("StreamTitle='CafÃ©';StreamUrl='" + artwork + "';Other='\xff';")
	attrs := ParseBlock(block)
	if attrs["StreamTitle"] != "Café" || attrs["StreamUrl"] != artwork || !utf8.ValidString(attrs["Other"]) {
		t.Fatalf("attributes = %+v", attrs)
	}
}

func TestTitleLimitPreservesUTF8AfterRepair(t *testing.T) {
	for _, raw := range []string{
		strings.Repeat("é»\u0084", 1100),
		strings.Repeat("黄", 1100),
		strings.Repeat("x", 1023) + "黄",
	} {
		got := cleanTitle([]byte(raw))
		if len(got) > 1024 || !utf8.ValidString(got) || strings.ContainsRune(got, utf8.RuneError) {
			t.Fatalf("truncated invalid UTF-8: %q (%d bytes)", got, len(got))
		}
	}
	if got := cleanTitle([]byte("\t中文\u0085\x1b\n ")); got != "中文" {
		t.Fatalf("controls not removed: %q", got)
	}
}

func TestSidecarDecodesMetadata(t *testing.T) {
	titles := []string{
		"正常中文 - Café",
		"é»\u0084å\u0087¯è\u008a¹ - è\u009d¶æ\u0081\u008bè\u008a±",
		"\xd5\xc5\xb9\xfa\xc8\xd9 - 中文电台",
		"ºÓÍ¼ - ×Ï´¨Â¼",
		"李克\xe5\x8b?- 飞\xe8?",
	}
	want := []string{"正常中文 - Café", "黄凯芹 - 蝶恋花", "张国荣 - 中文电台", "河图 - 紫川录", "李克�?- 飞�?"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("icy-metaint", "8")
		w.Header().Set("icy-name", "AsiaFM亚洲经典台")
		w.Header().Set("icy-genre", "ç®\u0080å\u008d\u0095å\u0090¬é\u009f³ä¹\u0090")
		for _, title := range titles {
			_, _ = w.Write([]byte("12345678"))
			_, _ = w.Write(metaBlock(title))
		}
	}))
	defer srv.Close()

	var metas []Meta
	s := &Sidecar{url: srv.URL, userAgent: "test", onMeta: func(m Meta) {
		// Exercise the same JSON boundary used to send titles to the UI.
		data, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		var received Meta
		if err := json.Unmarshal(data, &received); err != nil {
			t.Fatal(err)
		}
		metas = append(metas, received)
	}}
	if err := s.connect(context.Background()); !errors.Is(err, io.EOF) {
		t.Fatalf("connect = %v, want EOF", err)
	}
	if len(metas) != len(want) {
		t.Fatalf("metas = %+v, want %d pushes", metas, len(want))
	}
	for i, title := range want {
		if m := metas[i]; m.Title != title || m.Name != "AsiaFM亚洲经典台" || m.Genre != "简单听音乐" {
			t.Errorf("meta[%d] = %+v, want title %q and decoded headers", i, m, title)
		}
	}
}
