package viewer

import (
	"encoding/json"
	"testing"

	"github.com/go-gl/mathgl/mgl32"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

func TestEncodeCameraOverrideAndClear(t *testing.T) {
	a := testActor(t, "CamBot")
	a.ApplyCameraPresets([]protocol.CameraPreset{{Name: "free"}})

	set := protocol.CameraInstructionSet{Preset: 0}
	pos := mgl32.Vec3{10, 70, 12}
	set.Position = protocol.Option(pos)
	rot := mgl32.Vec2{15, 90} // pitch, yaw
	set.Rotation = protocol.Option(rot)
	ease := protocol.CameraEase{Type: 0, Duration: 0.5}
	set.Ease = protocol.Option(ease)

	a.ApplyCameraInstruction(&packet.CameraInstruction{
		Set: protocol.Option(set),
	})

	enc := newEncoder("CamBot", 4, 4)
	event, payload, err := enc.frame(a)
	if err != nil {
		t.Fatal(err)
	}
	if event != "keyframe" {
		t.Fatalf("event=%s", event)
	}
	var kf Keyframe
	if err := json.Unmarshal(payload, &kf); err != nil {
		t.Fatal(err)
	}
	if kf.Camera == nil {
		t.Fatal("expected camera on keyframe")
	}
	if kf.Camera.Preset != "free" {
		t.Fatalf("preset=%q", kf.Camera.Preset)
	}
	if kf.Camera.Pos == nil || (*kf.Camera.Pos)[0] != 10 || (*kf.Camera.Pos)[1] != 70 {
		t.Fatalf("pos=%v", kf.Camera.Pos)
	}
	if kf.Camera.Rot == nil || (*kf.Camera.Rot)[0] != 90 || (*kf.Camera.Rot)[1] != 15 {
		t.Fatalf("rot=%v want [yaw=90,pitch=15]", kf.Camera.Rot)
	}
	if kf.Camera.EaseDurationMs != 500 {
		t.Fatalf("ease=%d", kf.Camera.EaseDurationMs)
	}
	if kf.Time != nil {
		t.Fatal("time should be absent without SetTime")
	}

	a.SetWorldTime(6000)
	a.ApplyCameraInstruction(&packet.CameraInstruction{
		Clear: protocol.Option(true),
	})
	event, payload, err = enc.frame(a)
	if err != nil {
		t.Fatal(err)
	}
	if event != "delta" {
		t.Fatalf("event=%s want delta", event)
	}
	var d Delta
	if err := json.Unmarshal(payload, &d); err != nil {
		t.Fatal(err)
	}
	if !d.CameraCleared {
		t.Fatalf("want cameraCleared, got camera=%v", d.Camera)
	}
	if d.Time == nil || *d.Time != 6000 {
		t.Fatalf("time=%v", d.Time)
	}
}

func TestEncodeTimeOnKeyframe(t *testing.T) {
	a := testActor(t, "TimeBot")
	a.SetWorldTime(18000)
	enc := newEncoder("TimeBot", 4, 4)
	_, payload, err := enc.frame(a)
	if err != nil {
		t.Fatal(err)
	}
	var kf Keyframe
	if err := json.Unmarshal(payload, &kf); err != nil {
		t.Fatal(err)
	}
	if kf.Time == nil || *kf.Time != 18000 {
		t.Fatalf("time=%v", kf.Time)
	}
	if kf.Camera != nil {
		t.Fatal("camera should be absent")
	}
}
