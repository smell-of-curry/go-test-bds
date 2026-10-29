package actor

import (
	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// CommandResult is a CommandOutput correlated to the request that caused it.
type CommandResult struct {
	SuccessCount uint32
	Messages     []protocol.CommandOutputMessage
}

// WriteCommandRequest sends pk and returns a buffered channel that receives
// the CommandOutput whose origin UUID matches, if one arrives.
// The channel is not closed. A missing output is not an error — the caller
// decides how long to wait.
func (a *Actor) WriteCommandRequest(pk *packet.CommandRequest) (<-chan CommandResult, error) {
	ch := make(chan CommandResult, 1)
	id := pk.CommandOrigin.UUID
	a.cmdMu.Lock()
	if a.cmdWait == nil {
		a.cmdWait = make(map[uuid.UUID]chan CommandResult)
	}
	a.cmdWait[id] = ch
	a.cmdMu.Unlock()
	if err := a.conn.WritePacket(pk); err != nil {
		a.UnwatchCommand(id)
		return nil, err
	}
	return ch, nil
}

// UnwatchCommand drops a waiter. Safe to call twice and from any goroutine.
func (a *Actor) UnwatchCommand(id uuid.UUID) {
	a.cmdMu.Lock()
	delete(a.cmdWait, id)
	a.cmdMu.Unlock()
}

// DeliverCommandOutput keeps the existing handler hook and wakes a correlated waiter.
func (a *Actor) DeliverCommandOutput(pk *packet.CommandOutput) {
	if pk == nil {
		return
	}
	a.ReceiveCommandOutput(pk.OutputMessages)
	a.cmdMu.Lock()
	ch := a.cmdWait[pk.CommandOrigin.UUID]
	delete(a.cmdWait, pk.CommandOrigin.UUID)
	a.cmdMu.Unlock()
	if ch == nil {
		return
	}
	res := CommandResult{SuccessCount: pk.SuccessCount, Messages: pk.OutputMessages}
	select {
	case ch <- res:
	default:
	}
}
