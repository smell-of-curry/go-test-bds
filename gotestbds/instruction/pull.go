package instruction

import (
	"encoding/json"
	"fmt"
)

// Pull stores all instructions.
type Pull struct {
	pull        map[string]func() Instruction
	instruction Instruction
}

// NewPull ...
func NewPull() *Pull {
	return &Pull{pull: make(map[string]func() Instruction)}
}

// UnmarshalJSON ...
func (pull *Pull) UnmarshalJSON(data []byte) error {
	var definition struct {
		Action     string          `json:"action"`
		Parameters json.RawMessage `json:"parameters"`
	}

	if err := json.Unmarshal(data, &definition); err != nil {
		return err
	}

	f, ok := pull.pull[definition.Action]
	if !ok {
		return fmt.Errorf("unregistered instruction %v", definition.Action)
	}
	instruction := f()
	err := json.Unmarshal(definition.Parameters, instruction)
	if err != nil {
		return err
	}

	pull.instruction = instruction

	return nil
}

// Register registers Instructions.
func (pull *Pull) Register(f func() Instruction) {
	i := f()
	pull.pull[i.Name()] = f
}

// Decode ...
func (pull *Pull) Decode(msg string) (Instruction, error) {
	err := json.Unmarshal([]byte(msg), pull)
	if err != nil {
		return nil, err
	}
	return pull.instruction, nil
}
