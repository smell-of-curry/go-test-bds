package gotestbds

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/instruction"
)

// DefaultInstructionPrefix ...
const DefaultInstructionPrefix = "[RUN_ACTION]"

// TestingHandler ...
type TestingHandler struct {
	actor.NopHandler
	pull   *instruction.Pull
	b      *bot.Bot
	logger *slog.Logger
	callbacks

	cfg *Test
}

// NewTestingHandler ...
func NewTestingHandler(b *bot.Bot, t *Test) actor.Handler {

	handler := &TestingHandler{
		pull:   t.Instructions,
		b:      b,
		logger: t.Logger,
		cfg:    t,
	}
	handler.pull.Callbacker = handler

	return handler
}

// RawTextMessage represents the structure of a raw text message from Minecraft
type RawTextMessage struct {
	RawText []struct {
		Text string `json:"text"`
	} `json:"rawtext"`
}

// HandleReceiveMessage ...
func (h *TestingHandler) HandleReceiveMessage(a *actor.Actor, msg string) {
	h.logger.Debug("received message", "message", msg)

	// Extract the actual message content, handling both plain string and raw text format
	actualMessage := h.extractMessageContent(msg)

	actionData := strings.TrimPrefix(actualMessage, h.cfg.InstructionPrefix)
	if actionData != actualMessage {
		h.logger.Debug("received action", "action", actionData)
		go h.runAction(actionData)
	}
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
	i, err := h.pull.Decode(data)
	if err != nil {
		broadcastStatus(StatusError, err.Error(), h.b)
		h.logger.Error("error decoding instruction", "error", err)
		return
	}

	h.logger.Debug("decoded instruction successfully", "instruction", fmt.Sprintf("%#v", i))

	ctx, cancel := context.WithTimeout(context.Background(), time.Second*20)
	defer cancel()
	err = i.Run(ctx, h.b)

	if err != nil {
		h.logger.Error("error running instruction", "instruction", fmt.Sprintf("%#v", i), "error", err)
		if errors.Is(err, context.DeadlineExceeded) {
			broadcastStatus(StatusTimeOut, err.Error(), h.b)
			return
		}
		broadcastStatus(StatusError, err.Error(), h.b)
	} else {
		h.logger.Debug("instruction completed successfully, broadcasting success")
		broadcastStatus(StatusSuccess, "", h.b)
	}
}

// HandleReceiveForm ...
func (h *TestingHandler) HandleReceiveForm(ctx *actor.Context, form *actor.Form) {
	ctx.Cancel()
}

// HandleReceiveDialogue ...
func (h *TestingHandler) HandleReceiveDialogue(ctx *actor.Context, _ *actor.Dialogue) {
	ctx.Cancel()
}

// broadcastStatus broadcasts status.
func broadcastStatus(status, message string, b *bot.Bot) {
	b.Execute(func(a *actor.Actor) {
		data, _ := json.Marshal(struct {
			Status  string `json:"status"`
			Message string `json:"message,omitempty"`
		}{Status: status, Message: message})
		statusMsg := StatusMessagePrefix + string(data)
		a.Chat(statusMsg)
	})
}
