package icy

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

// cleanTitle follows radio-cli's ICY decoding: preserve UTF-8, repair
// Latin-1-wrapped UTF-8 and conservative GBK candidates, then sanitize.
// Repair must precede sanitizing because C1 controls may encode UTF-8 bytes.
func cleanTitle(b []byte) string {
	var decoded strings.Builder
	start := 0
	for i, c := range b {
		if c < utf8.RuneSelf {
			decodeTitleRun(b[start:i], &decoded)
			decoded.WriteByte(c)
			start = i + 1
		}
	}
	decodeTitleRun(b[start:], &decoded)

	text := decoded.String()
	hasHan := strings.ContainsFunc(text, isCJK)
	var repaired strings.Builder
	var run []byte
	flush := func() {
		if text, ok := repairLatin1Run(run, hasHan); ok {
			repaired.WriteString(text)
		} else {
			for _, b := range run {
				repaired.WriteRune(rune(b))
			}
		}
		run = run[:0]
	}
	for _, c := range text {
		if c >= 0x80 && c <= 0xff {
			run = append(run, byte(c))
		} else {
			flush()
			repaired.WriteRune(c)
		}
	}
	flush()
	return cleanText(repaired.String())
}

// Decode whole non-ASCII runs first: GBK can contain valid UTF-8 subsequences.
// Existing UTF-8 Han characters take priority over a GBK guess for the run.
func decodeTitleRun(b []byte, out *strings.Builder) {
	if utf8.Valid(b) {
		out.Write(b)
		return
	}
	if !strings.ContainsFunc(string(b), isCJK) {
		if repaired, ok := repairLatin1Run(b, false); ok {
			out.WriteString(repaired)
			return
		}
	}
	var previous rune
	for len(b) > 0 {
		c, size := utf8.DecodeRune(b)
		if c == utf8.RuneError && size == 1 {
			// A lone 3/4-byte lead after Han and before ASCII/end is a
			// truncated UTF-8 character. Two-byte leads remain ambiguous.
			if len(b) == 1 && b[0] >= 0xe0 && b[0] <= 0xf4 && isCJK(previous) {
				c = utf8.RuneError
			} else {
				c = rune(b[0]) // Latin-1 fallback preserves repairable bytes.
			}
		}
		out.WriteRune(c)
		previous = c
		b = b[size:]
	}
}

// b holds byte values recovered from a Latin-1 run, or raw stream bytes.
func repairLatin1Run(b []byte, hasHan bool) (string, bool) {
	i := 0
	for i < len(b) {
		c, size := utf8.DecodeRune(b[i:])
		if c == utf8.RuneError && size == 1 {
			break
		}
		i += size
	}
	if i == len(b) {
		return string(b), true
	}
	incomplete := !utf8.FullRune(b[i:])
	prefix := string(b[:i])
	if incomplete && strings.ContainsFunc(prefix, isCJK) {
		return prefix + "\ufffd", true
	}

	// Require at least two double-byte Han characters and evidence beyond
	// letters. This avoids turning genuine accents (e.g. Lääke or éééé)
	// into Chinese. A lone GBK pair is too ambiguous to guess safely.
	hasSymbol := false
	for _, c := range b {
		r := rune(c)
		if !unicode.IsLetter(r) && !unicode.IsControl(r) && !unicode.IsSpace(r) {
			hasSymbol = true
			break
		}
	}
	if len(b) >= 4 && hasSymbol {
		decoded, err := simplifiedchinese.GB18030.NewDecoder().Bytes(b)
		text := string(decoded)
		// Invalid GB18030 becomes U+FFFD, which fails the all-Han check.
		if err == nil && utf8.RuneCountInString(text)*2 == len(b) &&
			!strings.ContainsFunc(text, func(c rune) bool { return !isCJK(c) }) {
			return text, true
		}
	}
	if incomplete && hasHan && len(b)-i >= 2 {
		return prefix + "\ufffd", true
	}
	return "", false
}

func isCJK(c rune) bool {
	return c >= 0x3400 && c <= 0x9fff || c >= 0xf900 && c <= 0xfaff
}

// Keep the existing byte limit without cutting a UTF-8 character in half.
func cleanText(text string) string {
	var out strings.Builder
	for _, c := range text {
		if unicode.IsControl(c) {
			continue
		}
		out.WriteRune(c)
	}
	text = strings.TrimSpace(out.String())
	if len(text) > 1024 {
		end := 1024
		for !utf8.RuneStart(text[end]) {
			end--
		}
		text = text[:end]
	}
	return text
}
