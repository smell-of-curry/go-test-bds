package instruction

import (
	"encoding/json"

	"github.com/df-mc/dragonfly/server/block/cube"
)

// Pos is a position of the block.
type Pos cube.Pos

// UnmarshalJSON supports both array-style and object-style position inputs.
//
// @param data The raw JSON value, either `[x, y, z]` or `{"x":…,"y":…,"z":…}`.
// @returns nil once one of the two shapes decodes.
// @throws if neither shape decodes.
func (p *Pos) UnmarshalJSON(data []byte) error {
	// [x, y, z]. Decoded through a plain array, never through Pos itself:
	// unmarshalling into `p` re-enters this method, and the recursion overflowed
	// the stack and killed the bot outright on the first instruction carrying a
	// position.
	var array [3]int
	if err := json.Unmarshal(data, &array); err == nil {
		*p = Pos{array[0], array[1], array[2]}
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
