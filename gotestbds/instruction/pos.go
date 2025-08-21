package instruction

import (
	"encoding/json"

	"github.com/df-mc/dragonfly/server/block/cube"
)

// Pos is a position of the block.
type Pos cube.Pos

// UnmarshalJSON ...
func (p *Pos) UnmarshalJSON(data []byte) error {
	if err := json.Unmarshal(data, p); err == nil {
		return nil
	}
	var position = struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
		Z float64 `json:"z"`
	}{}
	err := json.Unmarshal(data, &position)
	*p = Pos{int(position.X), int(position.Y), int(position.Z)}
	return err
}
