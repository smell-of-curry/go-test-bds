package gotestbds

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/instruction"
	"github.com/smell-of-curry/go-test-bds/gotestbds/viewer"
)

// DefaultInstructionPrefix prefixes inbound action chat messages.
const DefaultInstructionPrefix = "[RUN_ACTION]"

// TestingHandler routes inbound chat actions to registered instructions.
type TestingHandler struct {
	actor.NopHandler
	pull   *instruction.Pull
	b      *bot.Bot
	logger *slog.Logger
	callbacks

	cfg    *Test
	stream *viewer.Stream
}

// NewTestingHandler creates a TestingHandler bound to bot b and test config t.
func NewTestingHandler(b *bot.Bot, t *Test) actor.Handler {
	handler := &TestingHandler{
		pull:   t.Instructions,
		b:      b,
		logger: t.Logger,
		cfg:    t,
	}
	handler.pull.Callbacker = handler
	if t.Viewer != nil {
		handler.stream = t.Viewer.Register(t.Dialer.IdentityData.DisplayName)
	}
	return handler
}

// RawTextMessage represents the structure of a raw text message from Minecraft
type RawTextMessage struct {
	RawText []struct {
		Text string `json:"text"`
	} `json:"rawtext"`
}

// actionEnvelope is the inbound [RUN_ACTION] JSON body.
type actionEnvelope struct {
	Action     string          `json:"action"`
	Parameters json.RawMessage `json:"parameters"`
	Id         string          `json:"id"`
	TimeoutMs  int             `json:"timeoutMs"`
}

// HandleReceiveMessage stores ordinary chat and dispatches [RUN_ACTION] instructions.
//
// @param a The actor that received the message.
// @param msg The packet.Text Message field.
// @param parameters Optional translation Parameters from the Text packet.
func (h *TestingHandler) HandleReceiveMessage(a *actor.Actor, msg string, parameters []string) {
	h.logger.Debug("received message", "message", msg)

	actualMessage := h.extractMessageContent(msg)

	if strings.HasPrefix(actualMessage, StatusMessagePrefix) {
		return
	}

	actionData, isAction := strings.CutPrefix(actualMessage, h.cfg.InstructionPrefix)
	if isAction {
		h.logger.Debug("received action", "action", actionData)
		go h.runAction(actionData)
		return
	}

	a.RecordMessage(actualMessage, parameters...)
}

// extractMessageContent extracts the actual message from either plain string or raw text format
func (h *TestingHandler) extractMessageContent(msg string) string {
	// Try to parse as raw text message first
	var rawTextMsg RawTextMessage
	if err := json.Unmarshal([]byte(msg), &rawTextMsg); err == nil {
		// Successfully parsed as raw text, extract the first text entry
		h.logger.Debug("parsed raw text message", "rawTextMsg", rawTextMsg)
		if len(rawTextMsg.RawText) > 0 {
			return rawTextMsg.RawText[0].Text
		}
	}

	// If parsing failed or no text entries, return the original message as-is
	return msg
}

// runAction runs encoded instruction.
func (h *TestingHandler) runAction(data string) {
	h.logger.Debug("running action", "action", data)

	var env actionEnvelope
	if err := json.Unmarshal([]byte(data), &env); err != nil {
		broadcastStatus("", StatusError, err.Error(), nil, h.b)
		h.logger.Error("error decoding action envelope", "error", err)
		return
	}

	timeout := h.instructionTimeout(env.TimeoutMs)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	status, message, payload := Dispatch(ctx, h.pull, h.b, env.Action, env.Parameters)
	if status != StatusSuccess {
		h.logger.Error("instruction failed", "action", env.Action, "status", status, "message", message)
	} else {
		h.logger.Debug("instruction completed successfully, broadcasting success")
	}
	broadcastStatus(env.Id, status, message, payload, h.b)
}

// instructionTimeout resolves the effective timeout for an action.
func (h *TestingHandler) instructionTimeout(timeoutMs int) time.Duration {
	if h.cfg == nil {
		if timeoutMs > 0 {
			return time.Duration(timeoutMs) * time.Millisecond
		}
		return DefaultInstructionTimeout
	}
	return h.cfg.InstructionTimeout(timeoutMs)
}

// HandleReceiveForm keeps the form open for later observation/response instructions.
func (h *TestingHandler) HandleReceiveForm(ctx *actor.Context, form *actor.Form) {
	ctx.Cancel()
}

// HandleReceiveDialogue keeps the dialogue open for later response instructions.
func (h *TestingHandler) HandleReceiveDialogue(ctx *actor.Context, _ *actor.Dialogue) {
	ctx.Cancel()
}

// HandleTick forwards the tick to the viewer stream when one is attached.
//
// Encoding and fan-out happen here because World is only safe to read from the
// bot goroutine that calls Actor.Tick. A nil stream is a no-op so runs without
// a viewer pay only this one nil check. Wire registries are decoded on the
// first viewer tick so headless runs never touch GameData.CustomBlocks/Items.
func (h *TestingHandler) HandleTick(a *actor.Actor, _ uint64) {
	if h.stream == nil {
		return
	}
	a.EnsureWireRegistries()
	h.stream.Tick(a)
}

// HandleChangeDimension asks the stream for a keyframe after a dimension switch.
func (h *TestingHandler) HandleChangeDimension(_ *actor.Actor, from, to int32) {
	if h.stream == nil {
		return
	}
	h.stream.DimensionChanged(from, to)
}

// statusEnvelope is the outbound [STATUS] JSON body.
type statusEnvelope struct {
	Id      string `json:"id,omitempty"`
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
	Data    any    `json:"data,omitempty"`
}

// MarshalStatusEnvelope marshals a status payload for tests and broadcastStatus.
func MarshalStatusEnvelope(id, status, message string, data any) ([]byte, error) {
	return json.Marshal(statusEnvelope{
		Id:      id,
		Status:  status,
		Message: message,
		Data:    data,
	})
}

// statusFragmentInterval spaces out the fragments of a chunked status
// envelope. BDS drops chat that arrives faster than a real client could type,
// so back-to-back Text packets from one tick never all survive.
const statusFragmentInterval = 60 * time.Millisecond

// broadcastStatus broadcasts status. Large envelopes (e.g. a form snapshot
// with dozens of buttons) are split into chat-sized fragments because BDS
// silently drops oversized inbound chat; fragments are paced one per
// statusFragmentInterval for the same reason.
//
// Chat is enqueued on Bot's background writer — never via Execute→Actor.Chat on
// the tick loop. Live hang: battle-phase 12-fragment getForm replies made
// WritePacket(*packet.Text) the slowestPacket while ticks fell to ~11/s, then
// total silence (tick loop stuck in a blocked write / task queue).
func broadcastStatus(id, status, message string, data any, b *bot.Bot) {
	payload, _ := MarshalStatusEnvelope(id, status, message, data)
	msgs := EncodeStatusMessages(id, string(payload))
	b.EnqueueChat(msgs[0])
	if len(msgs) == 1 {
		return
	}
	slog.Info("chunked status", "id", id, "fragments", len(msgs), "bytes", len(payload))
	go func() {
		for _, msg := range msgs[1:] {
			select {
			case <-time.After(statusFragmentInterval):
			case <-b.Closed():
				return
			}
			b.EnqueueChat(msg)
		}
	}()
}
