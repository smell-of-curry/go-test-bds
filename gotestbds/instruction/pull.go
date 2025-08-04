package instruction

import (
	"encoding/json"
	"fmt"
)

// Pull stores all instructions
type Pull struct {
	pull         map[string]func() Instruction
	instructions []Instruction
}

// NewPull ...
func NewPull() *Pull {
	return &Pull{pull: make(map[string]func() Instruction)}
}

// UnmarshalJSON ...
func (pull *Pull) UnmarshalJSON(data []byte) error {
	var types []struct {
		Action     string          `json:"action"`
		Parameters json.RawMessage `json:"parameters"`
	}

	if err := json.Unmarshal(data, &types); err != nil {
		return err
	}

	for _, t := range types {
		f, ok := pull.pull[t.Action]
		if !ok {
			panic(fmt.Sprintf("unregistered instruction %v", t.Action))
		}
		instruction := f()
		err := json.Unmarshal(t.Parameters, instruction)
		if err != nil {
			panic(err)
		}

		pull.instructions = append(pull.instructions, instruction)
	}

	return nil
}

// Register registers Instructions.
func (pull *Pull) Register(f func() Instruction) {
	i := f()
	pull.pull[i.Name()] = f
}

// NextInstruction ...
func (pull *Pull) NextInstruction() (Instruction, bool) {
	if len(pull.instructions) == 0 {
		return nil, false
	}
	instruction := pull.instructions[0]
	pull.instructions = pull.instructions[1:]
	return instruction, true
}
