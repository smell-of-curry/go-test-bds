package actor

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"math"
	"sort"
)

// BossBar is server-owned HUD state, retained for late viewer attachments.
type BossBar struct {
	ID      int64   `json:"id"`
	Title   string  `json:"title"`
	Health  float32 `json:"health"`
	Colour  uint8   `json:"colour"`
	Overlay uint8   `json:"overlay"`
}

// ApplyBossEvent runs on the actor goroutine. Unknown updates never create bars.
func (a *Actor) ApplyBossEvent(p *packet.BossEvent) {
	if a.bossBars == nil {
		a.bossBars = make(map[int64]BossBar)
	}
	bar, exists := a.bossBars[p.BossEntityUniqueID]
	switch p.EventType {
	case packet.BossEventShow:
		bar = BossBar{ID: p.BossEntityUniqueID, Title: p.BossBarTitle, Health: p.HealthPercentage, Colour: p.Colour, Overlay: p.Overlay}
	case packet.BossEventHide:
		delete(a.bossBars, p.BossEntityUniqueID)
		return
	case packet.BossEventTitle:
		if !exists {
			return
		}
		bar.Title = p.BossBarTitle
	case packet.BossEventHealthPercentage:
		if !exists {
			return
		}
		bar.Health = p.HealthPercentage
	case packet.BossEventAppearanceProperties, packet.BossEventTexture:
		if !exists {
			return
		}
		bar.Colour = p.Colour
		bar.Overlay = p.Overlay
	default:
		return
	}
	if math.IsNaN(float64(bar.Health)) || math.IsInf(float64(bar.Health), 0) {
		bar.Health = 0
	}
	bar.Health = max(0, min(1, bar.Health))
	a.bossBars[p.BossEntityUniqueID] = bar
}

// BossBars returns a detached, deterministic snapshot on the actor goroutine.
func (a *Actor) BossBars() []BossBar {
	bars := make([]BossBar, 0, len(a.bossBars))
	for _, b := range a.bossBars {
		bars = append(bars, b)
	}
	sort.Slice(bars, func(i, j int) bool { return bars[i].ID < bars[j].ID })
	return bars
}
