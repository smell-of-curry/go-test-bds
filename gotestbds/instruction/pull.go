package instruction

import (
	"encoding/json"
	"fmt"
)

// Pull stores all instructions.
type Pull struct {
	pull        map[string]func() Instruction
	instruction Instruction
	Callbacker
}

// NewPull creates a new empty Pull with a no-op Callbacker.
func NewPull() *Pull {
	return &Pull{pull: make(map[string]func() Instruction), Callbacker: NopCallbacker{}}
}

// UnmarshalJSON decodes a message into a specific Instruction instance.
func (pull *Pull) UnmarshalJSON(data []byte) error {
	var definition struct {
		Action     string          `json:"action"`
		Parameters json.RawMessage `json:"parameters"`
	}

	if err := json.Unmarshal(data, &definition); err != nil {
		return err
	}

	instruction, ok := pull.Instruction(definition.Action)
	if !ok {
		return fmt.Errorf("unregistered instruction %v", definition.Action)
	}
	err := json.Unmarshal(definition.Parameters, instruction)
	if err != nil {
		return err
	}

	pull.instruction = instruction

	return nil
}

// Instruction returns a new instance of an instruction by name.
func (pull *Pull) Instruction(name string) (Instruction, bool) {
	f, ok := pull.pull[name]
	if !ok {
		return nil, false
	}
	return f(), true
}

// Register registers Instructions.
func (pull *Pull) Register(f func() Instruction) {
	i := f()
	pull.pull[i.Name()] = f
}

// Decode parses a JSON message into an Instruction instance.
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
	if callbacker == nil {
		callbacker = pull
	}
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
	pull.Register(create[CustomFormRespond]())
	pull.Register(create[MenuFormRespond]())
	pull.Register(create[ModalFormRespond]())
	pull.Register(create[RunCommand]())
	pull.Register(create[Rejoin]())
	pull.Register(create[EditSign]())
	pull.Register(create[ToggleCrafterSlot]())
	pull.Register(create[InventoryAction]())
	pull.Register(create[DialogueResponse]())
	return pull
}

// create creates new instance of the Instruction.
func create[T any]() func() Instruction {
	return func() Instruction {
		return any(new(T)).(Instruction)
	}
}
