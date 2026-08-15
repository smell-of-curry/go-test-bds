package actor

import "sync"

type worldTimeState struct {
	mu      sync.Mutex
	time    int32
	known   bool
	seq     uint64
}

// SetWorldTime records the absolute world time from a SetTime packet.
//
// @param t Absolute world time ticks (not limited to 24000).
func (a *Actor) SetWorldTime(t int32) {
	if a.worldTime == nil {
		a.worldTime = &worldTimeState{}
	}
	a.worldTime.mu.Lock()
	defer a.worldTime.mu.Unlock()
	a.worldTime.time = t
	a.worldTime.known = true
	a.worldTime.seq++
}

// WorldTime returns absolute world time ticks and whether SetTime was ever received.
//
// @returns time ticks, known flag.
func (a *Actor) WorldTime() (time int32, known bool) {
	if a.worldTime == nil {
		return 0, false
	}
	a.worldTime.mu.Lock()
	defer a.worldTime.mu.Unlock()
	return a.worldTime.time, a.worldTime.known
}
