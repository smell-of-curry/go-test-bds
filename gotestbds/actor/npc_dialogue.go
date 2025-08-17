package actor

import (
	"encoding/json"
	"fmt"
	"slices"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// Dialogue represents NPC dialogue.
type Dialogue struct {
	title    string
	dialogue string
	scene    string
	entity   uint64
	buttons  []DialogueButton

	used bool
	conn Conn
}

// NewDialogue ...
func NewDialogue(title string, dialogue string, scene string, entity uint64, conn Conn) *Dialogue {
	return &Dialogue{title: title, dialogue: dialogue, scene: scene, entity: entity, conn: conn}
}

// UnmarshalJSON ...
func (n *Dialogue) UnmarshalJSON(data []byte) error {
	err := json.Unmarshal(data, &n.buttons)
	for i := range n.buttons {
		n.buttons[i].dialogue = n
	}
	return err
}

// Title returns title of the Dialogue.
func (n *Dialogue) Title() string {
	return n.title
}

// use ...
func (n *Dialogue) use() error {
	if n.used {
		return fmt.Errorf("dialog has been already used")
	}
	n.used = true
	return nil
}

// Ignore ignores Dialogue.
func (n *Dialogue) Ignore() error {
	if err := n.use(); err != nil {
		return err
	}
	return n.conn.WritePacket(&packet.NPCRequest{
		EntityRuntimeID: n.entity,
		RequestType:     packet.NPCRequestActionExecuteClosingCommands,
		SceneName:       n.scene,
	})
}

// DialogueButton represents button in the NPC dialogue.
type DialogueButton struct {
	text     string
	dialogue *Dialogue
}

// UnmarshalJSON ...
func (d *DialogueButton) UnmarshalJSON(data []byte) error {
	var internals struct {
		Text string `json:"button_name"`
	}
	err := json.Unmarshal(data, &internals)
	d.text = internals.Text
	return err
}

// Press ...
func (d *DialogueButton) Press() error {
	idx := slices.IndexFunc(d.dialogue.buttons, func(button DialogueButton) bool {
		return d.text == button.text
	})
	if idx < 0 {
		return fmt.Errorf("unknown button")
	}

	if err := d.dialogue.use(); err != nil {
		return err
	}

	return d.dialogue.conn.WritePacket(&packet.NPCRequest{
		EntityRuntimeID: d.dialogue.entity,
		RequestType:     packet.NPCRequestActionExecuteAction,
		ActionType:      0,
		SceneName:       d.dialogue.scene,
	})
}
