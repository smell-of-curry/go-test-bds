package viewer

import (
	"encoding/json"
	"testing"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// TestAnimateEntityEmitsEvent covers packet → event-lane frame. The tick on
// the frame is what a recording uses to replay the animation.
func TestAnimateEntityEmitsEvent(t *testing.T) {
	hub, err := New(Options{
		EncodeEveryTick: true,
		Address:         "127.0.0.1:0",
		ArtifactDir:     t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("AnimBot")
	sub := s.attach()
	defer s.detach(sub)

	a := testActor(t, "AnimBot")
	s.Tick(a)
	for {
		if _, ok := sub.next(); !ok {
			break
		}
	}

	if err := (&bot.AnimateEntityHandler{}).Handle(&packet.AnimateEntity{
		Animation:            "animation.ball.capture",
		NextState:            "success3",
		StopCondition:        "query.any_animation_finished",
		StopConditionVersion: 0,
		Controller:           "controller.animation.ball",
		BlendOutTime:         0.25,
		EntityRuntimeIDs:     []uint64{41, 42},
	}, nil, a); err != nil {
		t.Fatal(err)
	}
	// Empty payload and unknown-only skips must not emit.
	if err := (&bot.AnimateEntityHandler{}).Handle(&packet.AnimateEntity{}, nil, a); err != nil {
		t.Fatal(err)
	}
	s.Tick(a)

	var got []EntityAnimateFrame
	for {
		fr, ok := sub.next()
		if !ok {
			break
		}
		if fr.event != "entityAnimate" {
			continue
		}
		var af EntityAnimateFrame
		if err := json.Unmarshal(fr.data, &af); err != nil {
			t.Fatal(err)
		}
		got = append(got, af)
	}
	if len(got) != 1 {
		t.Fatalf("entityAnimate frames = %+v, want 1", got)
	}
	af := got[0]
	if af.Type != "entityAnimate" || af.V != SchemaVersion || af.Bot != "AnimBot" {
		t.Fatalf("envelope %+v", af)
	}
	if af.Tick != a.CurrentTick() {
		t.Fatalf("tick %d, actor %d", af.Tick, a.CurrentTick())
	}
	if af.Animation != "animation.ball.capture" || af.NextState != "success3" {
		t.Fatalf("anim %+v", af)
	}
	if af.StopExpression != "query.any_animation_finished" || af.Controller != "controller.animation.ball" {
		t.Fatalf("stop/controller %+v", af)
	}
	if af.BlendOutTime != 0.25 || len(af.Rids) != 2 || af.Rids[0] != 41 || af.Rids[1] != 42 {
		t.Fatalf("blend/rids %+v", af)
	}

	s.Tick(a)
	for {
		fr, ok := sub.next()
		if !ok {
			break
		}
		if fr.event == "entityAnimate" {
			t.Fatalf("duplicate entityAnimate after cursor advance: %s", fr.data)
		}
	}
}
