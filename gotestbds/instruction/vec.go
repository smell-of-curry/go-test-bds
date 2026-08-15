package instruction

// Vec3JSON is a float vector used in observation instruction payloads.
type Vec3JSON struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

// RotationJSON is a yaw/pitch pair used in observation instruction payloads.
type RotationJSON struct {
	Yaw   float64 `json:"yaw"`
	Pitch float64 `json:"pitch"`
}
