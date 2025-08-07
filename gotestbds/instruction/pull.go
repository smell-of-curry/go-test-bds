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

// DefaultPull returns new instance of default Pull.
func DefaultPull(callbacker Callbacker) *Pull {
	pull := NewPull()
	pull.Register(create[Attack]())
	pull.Register(create[AttackEntity]())
	pull.Register(func() Instruction {
		return &BreakBlock{Callbacker: callbacker}
	})
	pull.Register(create[Chat]())
	pull.Register(create[Disconnect]())
	pull.Register(create[DropSelectedItem]())
	pull.Register(create[Interact]())
	pull.Register(create[InteractWithBlock]())
	pull.Register(create[Jump]())
	pull.Register(create[LookAtBlock]())
	pull.Register(create[LookAtEntity]())
	pull.Register(create[LookAtLocation]())
	pull.Register(create[MoveRawInput]())
	pull.Register(func() Instruction {
		return &NavigateToBlock{Callbacker: callbacker}
	})
	pull.Register(create[PlaceBlock]())
	pull.Register(create[Respawn]())
	pull.Register(create[Rotate]())
	pull.Register(create[SetHeldSlot]())
	pull.Register(create[StopBreakingBlock]())
	pull.Register(create[StopNavigating]())
	pull.Register(create[StopUsingItem]())
	return pull
}

// create creates new instance of the Instruction.
func create[T any]() func() Instruction {
	return func() Instruction {
		return any(new(T)).(Instruction)
	}
}
