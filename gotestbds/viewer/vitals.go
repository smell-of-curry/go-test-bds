package viewer

import (
	"fmt"
	"math"
	"strings"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// collectVitals reads already-tracked actor survival state into a wire frame.
//
// @param bot Stream bot name.
// @param a Live actor on the bot goroutine.
// @returns the vitals frame (armor always 0 — no cheap armor-points source).
func collectVitals(bot string, a *actor.Actor) VitalsFrame {
	attrs := a.Attributes()
	st := a.State()
	hotbar := make([]*VitalsHotbarSlot, 9)
	for i := 0; i < 9; i++ {
		stack, err := a.Inventory().Item(i)
		if err != nil || stack.Empty() {
			continue
		}
		name, _ := stack.Item().EncodeItem()
		if name == "" || name == "minecraft:air" {
			continue
		}
		hotbar[i] = &VitalsHotbarSlot{TypeID: name, Count: stack.Count()}
	}
	return VitalsFrame{
		V:            SchemaVersion,
		Type:         "vitals",
		Bot:          bot,
		Tick:         a.CurrentTick(),
		Health:       roundVitalsFloat(attrs.Health()),
		MaxHealth:    roundVitalsFloat(attrs.MaxHealth()),
		Food:         roundVitalsFloat(attrs.Food()),
		Air:          int(st.Air()),
		MaxAir:       int(st.MaxAir()),
		Armor:        0, // stub: no cheap armor-points attribute/computation
		XPLevel:      int(math.Round(attrs.Level())),
		XPProgress:   roundVitalsFloat(attrs.Experience()),
		SelectedSlot: a.HeldSlot(),
		Hotbar:       hotbar,
	}
}

// roundVitalsFloat knocks float32 attribute noise down to 4 decimal places.
//
// @param v Raw attribute value.
// @returns v rounded to 4 decimals.
func roundVitalsFloat(v float64) float64 {
	return math.Round(v*1e4) / 1e4
}

// vitalsFingerprint is a cheap compare key for change detection.
//
// @param vf Frame to fingerprint.
// @returns a stable string of the survival fields.
func vitalsFingerprint(vf VitalsFrame) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%g|%g|%g|%d|%d|%d|%d|%g|%d",
		vf.Health, vf.MaxHealth, vf.Food, vf.Air, vf.MaxAir, vf.Armor,
		vf.XPLevel, vf.XPProgress, vf.SelectedSlot)
	for _, slot := range vf.Hotbar {
		if slot == nil {
			b.WriteString("|.")
			continue
		}
		fmt.Fprintf(&b, "|%s:%d", slot.TypeID, slot.Count)
	}
	return b.String()
}
