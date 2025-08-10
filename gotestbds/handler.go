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

// ActionHeader ...
const ActionHeader = "[RUN_ACTION]"

// TestingHandler ...
type TestingHandler struct {
	actor.NopHandler
	pull   *instruction.Pull
	b      *bot.Bot
	logger *slog.Logger
	callbacks

	cancelForms bool
}

// NewTestingHandler ...
func NewTestingHandler(pull *instruction.Pull, b *bot.Bot, logger *slog.Logger) actor.Handler {
	_, ok1 := pull.Instruction("customFormRespond")
	_, ok2 := pull.Instruction("menuFormRespond")
	_, ok3 := pull.Instruction("modalFormRespond")

	handler := &TestingHandler{
		pull:   pull,
		b:      b,
		logger: logger,

		cancelForms: ok1 || ok2 || ok3,
	}
	pull.Callbacker = handler

	return handler
}

// HandleReceiveMessage ...
func (h *TestingHandler) HandleReceiveMessage(a *actor.Actor, msg string) {
	actionData := strings.TrimPrefix(msg, ActionHeader)
	if actionData != msg {
		go h.runAction(actionData)
	} else {
		fmt.Println(actionData)
	}
}

// runAction ...
func (h *TestingHandler) runAction(data string) {
	i, err := h.pull.Decode(data)
	if err != nil {
		broadcastStatus(StatusError, err.Error(), h.b)
		h.logger.Error("error decoding instruction")
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second*20)
	defer cancel()
	err = i.Run(ctx, h.b)

	if err != nil {
		h.logger.Error("error running instruction", "instruction", fmt.Sprintf("%#v", i))
		if errors.Is(err, context.DeadlineExceeded) {
			broadcastStatus(StatusTimeOut, err.Error(), h.b)
			return
		}
		broadcastStatus(StatusError, err.Error(), h.b)
	} else {
		broadcastStatus(StatusSuccess, "", h.b)
	}
}

// HandleReceiveForm ...
func (h *TestingHandler) HandleReceiveForm(ctx *actor.Context, form *actor.Form) {
	if h.cancelForms {
		ctx.Cancel()
	}
}

// broadcastStatus ...
func broadcastStatus(status, message string, b *bot.Bot) {
	b.Execute(func(a *actor.Actor) {
		data, _ := json.Marshal(struct {
			Status  string `json:"status"`
			Message string `json:"message,omitempty"`
		}{Status: status, Message: message})
		a.Chat(StatusMessagePrefix + string(data))
	})
}
