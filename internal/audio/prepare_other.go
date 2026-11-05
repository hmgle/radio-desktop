//go:build !linux

package audio

// Prepare needs no platform setup outside Linux.
func Prepare() error { return nil }
