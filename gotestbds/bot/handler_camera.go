package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// CameraPresetsHandler stores custom camera presets for later CameraInstruction sets.
type CameraPresetsHandler struct{}

// Handle applies a CameraPresets packet.
func (*CameraPresetsHandler) Handle(p packet.Packet, _ *Bot, a *actor.Actor) error {
	pk := p.(*packet.CameraPresets)
	a.ApplyCameraPresets(pk.Presets)
	return nil
}

// CameraInstructionHandler applies server camera overrides for the viewer.
type CameraInstructionHandler struct{}

// Handle applies a CameraInstruction packet.
func (*CameraInstructionHandler) Handle(p packet.Packet, _ *Bot, a *actor.Actor) error {
	a.ApplyCameraInstruction(p.(*packet.CameraInstruction))
	return nil
}
