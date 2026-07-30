package actor

import "sync"

// Default title fade timings (ticks) when the server has not sent SetDurations.
const (
	DefaultTitleFadeInTicks  int32 = 10
	DefaultTitleStayTicks    int32 = 70
	DefaultTitleFadeOutTicks int32 = 20
)

// ScreenTitle is the bot's current title / subtitle / action-bar text plus the
// fade timings from the last SetTitle durations packet.
type ScreenTitle struct {
	Title        string
	Subtitle     string
	ActionBar    string
	FadeInTicks  int32
	StayTicks    int32
	FadeOutTicks int32
	// Seq increments on every mutation so a stream can emit once per change.
	Seq uint64
}

// titleWriteRingCap bounds retained title-channel writes for the viewer's
// phud lane. Generous: PokeBedrock's HUD feeders write a handful of tokens per
// tick and the stream drains every tick it runs.
const titleWriteRingCap = 256

type titleState struct {
	mu sync.Mutex
	ScreenTitle
	// writes retains every title-channel set action. PokeBedrock smuggles HUD
	// state through SetTitle ("&_token:value"), and several writes can land
	// between stream ticks — the latest-state ScreenTitle snapshot alone would
	// lose all but the last.
	writes    []string
	writeSeqs []uint64
	writeSeq  uint64
}

func newTitleState() *titleState {
	return &titleState{ScreenTitle: ScreenTitle{
		FadeInTicks:  DefaultTitleFadeInTicks,
		StayTicks:    DefaultTitleStayTicks,
		FadeOutTicks: DefaultTitleFadeOutTicks,
	}}
}

// ScreenTitle returns a snapshot of the current on-screen title state.
func (a *Actor) ScreenTitle() ScreenTitle {
	if a.title == nil {
		return ScreenTitle{
			FadeInTicks:  DefaultTitleFadeInTicks,
			StayTicks:    DefaultTitleStayTicks,
			FadeOutTicks: DefaultTitleFadeOutTicks,
		}
	}
	a.title.mu.Lock()
	defer a.title.mu.Unlock()
	return a.title.ScreenTitle
}

// TitleSeq returns the mutation sequence of the screen title.
func (a *Actor) TitleSeq() uint64 {
	if a.title == nil {
		return 0
	}
	a.title.mu.Lock()
	defer a.title.mu.Unlock()
	return a.title.Seq
}

// TitleWriteSeq returns the write counter of the title-channel ring.
// Writes recorded after this call receive a strictly greater sequence number.
func (a *Actor) TitleWriteSeq() uint64 {
	if a.title == nil {
		return 0
	}
	a.title.mu.Lock()
	defer a.title.mu.Unlock()
	return a.title.writeSeq
}

// TitleWritesFromSeq returns buffered title-channel writes with sequence >
// afterSeq, oldest first, plus the highest sequence included in the batch.
// Callers must advance their cursor to that returned seq (not TitleWriteSeq):
// advancing to the live counter races new writes and drops them forever —
// live showcase-07 lost `&_loadingScreen:TUTORIAL COMPLETE` under sidebar flood.
//
// Subtitle/action-bar sets are not recorded — the PokeBedrock HUD convention
// rides the title channel only.
//
// @param afterSeq The last sequence the caller has already consumed.
// @returns the raw title texts written since (oldest first), and the max seq
// among them (or afterSeq when the batch is empty).
func (a *Actor) TitleWritesFromSeq(afterSeq uint64) (writes []string, lastSeq uint64) {
	lastSeq = afterSeq
	if a.title == nil {
		return nil, lastSeq
	}
	a.title.mu.Lock()
	defer a.title.mu.Unlock()
	for i, seq := range a.title.writeSeqs {
		if seq > afterSeq {
			writes = append(writes, a.title.writes[i])
			if seq > lastSeq {
				lastSeq = seq
			}
		}
	}
	return writes, lastSeq
}

// recordWriteLocked appends one title-channel write. Caller holds t.mu.
//
// @param text The raw title text from the wire.
func (t *titleState) recordWriteLocked(text string) {
	t.writeSeq++
	t.writes = append(t.writes, text)
	t.writeSeqs = append(t.writeSeqs, t.writeSeq)
	if len(t.writes) > titleWriteRingCap {
		trim := len(t.writes) - titleWriteRingCap
		t.writes = append([]string(nil), t.writes[trim:]...)
		t.writeSeqs = append([]uint64(nil), t.writeSeqs[trim:]...)
	}
}

// ApplyTitleAction applies one SetTitle action (see packet.TitleAction*).
//
// @param action SetTitle ActionType constant.
// @param text Title / subtitle / action-bar text for set actions.
// @param fadeIn Fade-in duration in ticks (SetDurations only).
// @param stay Stay duration in ticks (SetDurations only).
// @param fadeOut Fade-out duration in ticks (SetDurations only).
func (a *Actor) ApplyTitleAction(action int32, text string, fadeIn, stay, fadeOut int32) {
	if a.title == nil {
		a.title = newTitleState()
	}
	a.title.mu.Lock()
	defer a.title.mu.Unlock()
	t := &a.title.ScreenTitle
	switch action {
	case 0: // Clear
		t.Title = ""
		t.Subtitle = ""
		t.ActionBar = ""
	case 1: // Reset
		t.Title = ""
		t.Subtitle = ""
		t.ActionBar = ""
		t.FadeInTicks = DefaultTitleFadeInTicks
		t.StayTicks = DefaultTitleStayTicks
		t.FadeOutTicks = DefaultTitleFadeOutTicks
	case 2, 6: // SetTitle / TitleTextObject
		t.Title = text
		a.title.recordWriteLocked(text)
	case 3, 7: // SetSubtitle / SubtitleTextObject
		t.Subtitle = text
	case 4, 8: // SetActionBar / ActionbarTextObject
		t.ActionBar = text
	case 5: // SetDurations
		t.FadeInTicks = fadeIn
		t.StayTicks = stay
		t.FadeOutTicks = fadeOut
	default:
		return
	}
	t.Seq++
}
