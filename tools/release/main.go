// Command release validates version metadata and extracts release notes.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
)

func main() {
	tag := flag.String("tag", "", "release tag, v followed by mygo.json version")
	notesPath := flag.String("notes", "", "output Markdown file")
	flag.Parse()
	config, err := os.ReadFile("mygo.json")
	if err != nil {
		log.Fatal(err)
	}
	var cfg struct{ Version string }
	if err := json.Unmarshal(config, &cfg); err != nil {
		log.Fatal(err)
	}
	changelog, err := os.ReadFile("CHANGELOG.md")
	if err != nil {
		log.Fatal(err)
	}
	notes, err := releaseNotes(cfg.Version, *tag, string(changelog))
	if err != nil {
		log.Fatal(err)
	}
	if *notesPath == "" {
		log.Fatal("-notes is required")
	}
	if err := os.WriteFile(*notesPath, []byte(notes+"\n"), 0o644); err != nil {
		log.Fatal(err)
	}
}

func releaseNotes(version, tag, changelog string) (string, error) {
	if version == "" || tag != "v"+version {
		return "", fmt.Errorf("tag %q must match mygo.json version %q with a v prefix", tag, version)
	}
	// Match MyGo v0.7.4's changelog headings, including Keep a Changelog
	// links and optional dates. Do not include the unreleased section.
	var notes []string
	inside := false
	for _, line := range strings.Split(strings.ReplaceAll(changelog, "\r\n", "\n"), "\n") {
		if heading, ok := strings.CutPrefix(line, "## "); ok {
			if inside {
				break
			}
			fields := strings.Fields(heading)
			if len(fields) == 0 {
				continue
			}
			v := fields[0]
			if rest, ok := strings.CutPrefix(v, "["); ok {
				v, _, _ = strings.Cut(rest, "]")
			}
			inside = strings.TrimPrefix(v, "v") == version
			continue
		}
		if inside {
			notes = append(notes, line)
		}
	}
	text := strings.TrimSpace(strings.Join(notes, "\n"))
	if text == "" {
		return "", fmt.Errorf("CHANGELOG.md needs a nonempty ## %s section", version)
	}
	return text, nil
}
