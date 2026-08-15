package actor

import (
	"sync"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// CameraOverride is the minimal server-driven camera state exported to the viewer.
// Absent / inactive means the client uses its default follow / first-person camera.
type CameraOverride struct {
	Preset         string
	Pos            *[3]float32
	Rot            *[2]float32 // [yaw, pitch] degrees (Bedrock RotY / RotX)
	EaseDurationMs int
	FOV            *float32
	Fade           *CameraFade
	Active         bool
	Seq            uint64
}

// CameraFade is a screen fade instruction (times in seconds from the packet).
type CameraFade struct {
	FadeInSec  float32
	WaitSec    float32
	FadeOutSec float32
	R, G, B    uint8
}

type cameraState struct {
	mu       sync.Mutex
	presets  []protocol.CameraPreset
	override CameraOverride
}

func newCameraState() *cameraState {
	return &cameraState{}
}

// CameraOverride returns a snapshot of the active server camera override.
func (a *Actor) CameraOverride() CameraOverride {
	if a.camera == nil {
		return CameraOverride{}
	}
	a.camera.mu.Lock()
	defer a.camera.mu.Unlock()
	return a.camera.override
}

// ApplyCameraPresets replaces the preset list from a CameraPresets packet.
func (a *Actor) ApplyCameraPresets(presets []protocol.CameraPreset) {
	if a.camera == nil {
		a.camera = newCameraState()
	}
	a.camera.mu.Lock()
	defer a.camera.mu.Unlock()
	a.camera.presets = append([]protocol.CameraPreset(nil), presets...)
}

// ApplyCameraInstruction applies one CameraInstruction packet.
func (a *Actor) ApplyCameraInstruction(pk *packet.CameraInstruction) {
	if a.camera == nil {
		a.camera = newCameraState()
	}
	a.camera.mu.Lock()
	defer a.camera.mu.Unlock()
	o := &a.camera.override

	if clear, ok := pk.Clear.Value(); ok && clear {
		*o = CameraOverride{Seq: o.Seq + 1}
		return
	}

	if set, ok := pk.Set.Value(); ok {
		o.Active = true
		o.Seq++
		if int(set.Preset) < len(a.camera.presets) {
			o.Preset = a.camera.presets[set.Preset].Name
		} else {
			o.Preset = ""
		}
		if ease, ok := set.Ease.Value(); ok {
			o.EaseDurationMs = int(ease.Duration * 1000)
		} else {
			o.EaseDurationMs = 0
		}
		if pos, ok := set.Position.Value(); ok {
			p := [3]float32{pos.X(), pos.Y(), pos.Z()}
			o.Pos = &p
		}
		if rot, ok := set.Rotation.Value(); ok {
			// protocol: RotX = pitch, RotY = yaw
			r := [2]float32{rot.Y(), rot.X()}
			o.Rot = &r
		}
		if int(set.Preset) < len(a.camera.presets) {
			pr := a.camera.presets[set.Preset]
			if o.Pos == nil {
				if x, okX := pr.PosX.Value(); okX {
					y, _ := pr.PosY.Value()
					z, _ := pr.PosZ.Value()
					p := [3]float32{x, y, z}
					o.Pos = &p
				}
			}
			if o.Rot == nil {
				if pitch, okP := pr.RotX.Value(); okP {
					yaw, _ := pr.RotY.Value()
					r := [2]float32{yaw, pitch}
					o.Rot = &r
				}
			}
		}
	}

	if fov, ok := pk.FieldOfView.Value(); ok {
		o.Active = true
		o.Seq++
		if fov.Clear {
			o.FOV = nil
		} else {
			f := fov.FieldOfView
			o.FOV = &f
			if fov.EaseTime > 0 && o.EaseDurationMs == 0 {
				o.EaseDurationMs = int(fov.EaseTime * 1000)
			}
		}
	}

	if fade, ok := pk.Fade.Value(); ok {
		o.Seq++
		cf := &CameraFade{}
		if td, ok := fade.TimeData.Value(); ok {
			cf.FadeInSec = td.FadeInDuration
			cf.WaitSec = td.WaitDuration
			cf.FadeOutSec = td.FadeOutDuration
		}
		if col, ok := fade.Colour.Value(); ok {
			cf.R, cf.G, cf.B = col.R, col.G, col.B
		}
		o.Fade = cf
	}
}
