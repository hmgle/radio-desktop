package app

import "github.com/egoist/mygo"

// EventPlaybackRecovery asks the active player to use its normal bounded
// reconnect path. It never starts a paused or exhausted playback session.
var EventPlaybackRecovery = mygo.NewEvent[string]("playbackRecovery")

// WatchPlaybackRecovery connects native lifecycle signals to the player.
// Call once after App is ready; all native callbacks run on the main thread.
func WatchPlaybackRecovery() {
	online := mygo.Network.Status().Online
	mygo.Network.OnChanged(func(status mygo.NetworkStatus) {
		wasOnline := online
		online = status.Online
		if online && !wasOnline {
			_ = EventPlaybackRecovery.Broadcast("online")
		}
	})
	mygo.Power.OnResume(func() {
		_ = EventPlaybackRecovery.Broadcast("resume")
	})
}
