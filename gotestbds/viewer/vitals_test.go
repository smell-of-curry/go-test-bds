package viewer

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
)

// Vitals emit on change, throttle at 100ms, and replay latest on attach.
func TestVitalsLaneEmitDedupeThrottleAndAttachReplay(t *testing.T) {
	hub, err := New(Options{EncodeEveryTick: true, Address: "127.0.0.1:0", ArtifactDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("VitalsBot")
	a := testActor(t, "VitalsBot")

	sub := s.attach()
	defer s.detach(sub)

	// Opening Tick: keyframe first, then vitals replay.
	s.Tick(a)
	fr, ok := sub.next()
	if !ok || fr.event != "keyframe" {
		t.Fatalf("want opening keyframe, got %+v ok=%v", fr, ok)
	}
	fr, ok = sub.next()
	if !ok || fr.event != "vitals" {
		t.Fatalf("keyframe vitals replay = %+v ok=%v, want vitals", fr, ok)
	}
	var first VitalsFrame
	if err := json.Unmarshal(fr.data, &first); err != nil {
		t.Fatal(err)
	}
	if first.Type != "vitals" || first.Bot != "VitalsBot" || first.V != SchemaVersion {
		t.Fatalf("envelope = %+v", first)
	}
	if first.Air != 300 || first.MaxAir != 300 {
		t.Fatalf("default air = %d/%d, want 300/300", first.Air, first.MaxAir)
	}
	if len(first.Hotbar) != 9 {
		t.Fatalf("hotbar len=%d want 9", len(first.Hotbar))
	}
	if first.Armor != 0 {
		t.Fatalf("armor stub = %d, want 0", first.Armor)
	}

	// Unchanged vitals must not re-emit.
	s.Tick(a)
	for {
		fr, ok := sub.next()
		if !ok {
			break
		}
		if fr.event == "vitals" {
			t.Fatalf("duplicate vitals without change: %s", fr.data)
		}
	}

	a.Attributes().Decode([]protocol.Attribute{
		{AttributeValue: protocol.AttributeValue{Name: "minecraft:health", Value: 15, Max: 20}},
		{AttributeValue: protocol.AttributeValue{Name: "minecraft:player.hunger", Value: 18}},
		{AttributeValue: protocol.AttributeValue{Name: "minecraft:player.level", Value: 3}},
		{AttributeValue: protocol.AttributeValue{Name: "minecraft:player.experience", Value: 0.45}},
	})
	a.State().Decode(protocol.EntityMetadata{
		protocol.EntityDataKeyAirSupply:    int32(120),
		protocol.EntityDataKeyAirSupplyMax: int32(300),
	})
	if err := a.SetHeldSlot(2); err != nil {
		t.Fatal(err)
	}

	s.lastVitalsAt = time.Now().Add(-vitalsEmitInterval)
	s.Tick(a)
	vf := mustVitals(t, sub)
	if vf.Health != 15 || vf.MaxHealth != 20 || vf.Food != 18 {
		t.Fatalf("vitals survival = %+v", vf)
	}
	if vf.Air != 120 || vf.MaxAir != 300 {
		t.Fatalf("air = %d/%d", vf.Air, vf.MaxAir)
	}
	if vf.XPLevel != 3 || vf.XPProgress != 0.45 {
		t.Fatalf("xp = level=%d progress=%g", vf.XPLevel, vf.XPProgress)
	}
	if vf.SelectedSlot != 2 {
		t.Fatalf("selectedSlot=%d", vf.SelectedSlot)
	}

	// Land AirSupply=0 must normalize to a full tank (hide bubbles).
	a.State().Decode(protocol.EntityMetadata{
		protocol.EntityDataKeyAirSupply:    int32(0),
		protocol.EntityDataKeyAirSupplyMax: int32(300),
	})
	s.lastVitalsAt = time.Now().Add(-vitalsEmitInterval)
	s.Tick(a)
	land := mustVitals(t, sub)
	if land.Air != 300 || land.MaxAir != 300 {
		t.Fatalf("land air=0 normalize = %d/%d, want 300/300", land.Air, land.MaxAir)
	}

	// Same values within the throttle window must not emit again.
	a.Attributes().Decode([]protocol.Attribute{
		{AttributeValue: protocol.AttributeValue{Name: "minecraft:health", Value: 14, Max: 20}},
	})
	s.lastVitalsAt = time.Now()
	s.Tick(a)
	for {
		fr, ok := sub.next()
		if !ok {
			break
		}
		if fr.event == "vitals" {
			t.Fatalf("vitals emitted inside throttle window: %s", fr.data)
		}
	}

	// After the throttle window, the pending change emits.
	s.lastVitalsAt = time.Now().Add(-vitalsEmitInterval)
	s.Tick(a)
	vf = mustVitals(t, sub)
	if vf.Health != 14 {
		t.Fatalf("post-throttle health=%g want 14", vf.Health)
	}

	// A second attach gets a keyframe then the latest vitals replay.
	sub2 := s.attach()
	defer s.detach(sub2)
	s.lastVitalsAt = time.Now().Add(-vitalsEmitInterval)
	s.Tick(a)
	fr, ok = sub2.next()
	if !ok || fr.event != "keyframe" {
		t.Fatalf("second attach keyframe = %+v ok=%v", fr, ok)
	}
	fr, ok = sub2.next()
	if !ok || fr.event != "vitals" {
		t.Fatalf("second attach vitals = %+v ok=%v, want vitals", fr, ok)
	}
	var replayed VitalsFrame
	if err := json.Unmarshal(fr.data, &replayed); err != nil {
		t.Fatal(err)
	}
	if replayed.Health != 14 || replayed.SelectedSlot != 2 {
		t.Fatalf("replay = %+v", replayed)
	}
}

func mustVitals(t *testing.T, sub *subscriber) VitalsFrame {
	t.Helper()
	for {
		fr, ok := sub.next()
		if !ok {
			t.Fatal("expected vitals frame")
		}
		if fr.event != "vitals" {
			continue
		}
		var vf VitalsFrame
		if err := json.Unmarshal(fr.data, &vf); err != nil {
			t.Fatal(err)
		}
		return vf
	}
}

