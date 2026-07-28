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

type titleState struct {
	mu sync.Mutex
	ScreenTitle
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
