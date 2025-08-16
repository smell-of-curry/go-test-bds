package bot

import (
	"encoding/json"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// NpcDialogueHandler handles NpcDialogue packet.
type NpcDialogueHandler struct{}

// Handle ...
func (*NpcDialogueHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	dialogue := p.(*packet.NPCDialogue)
	d := actor.NewDialogue(dialogue.NPCName, dialogue.Dialogue, dialogue.SceneName, dialogue.EntityUniqueID, b.Conn())
	err := json.Unmarshal([]byte(dialogue.ActionJSON), d)
	if err != nil {
		return err
	}
	a.ReceiveDialogue(d)
	return nil
}
