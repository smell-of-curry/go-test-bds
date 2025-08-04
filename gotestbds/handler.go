package gotestbds

import (
	"encoding/json"
	"fmt"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/instruction"
	"log/slog"
)

// RunTest runs tests.
func RunTest(addr string, dialer minecraft.Dialer, logger *slog.Logger, instructionPull *instruction.Pull) error {
	conn, err := dialer.Dial("raknet", addr)
	if err != nil {
		return err
	}

	err = conn.DoSpawn()
	if err != nil {
		return err
	}

	b := bot.NewBot(conn, logger)
	h := NewTestingHandler(instructionPull, b, logger).(*TestingHandler)
	b.Execute(func(a *actor.Actor) {
		a.Handle(h)

		// broadcasting “ready” status.
		// this should be handled on the server side.
		data, _ := json.Marshal(struct {
			Status string `json:"status"`
		}{"ready"})
		a.Chat(string(data))
	})
	return <-h.ch
}

// TestingHandler ...
type TestingHandler struct {
	actor.NopHandler
	pull   *instruction.Pull
	b      *bot.Bot
	logger *slog.Logger
	ch     chan error
}

// NewTestingHandler ...
func NewTestingHandler(pull *instruction.Pull, b *bot.Bot, logger *slog.Logger) actor.Handler {
	return &TestingHandler{pull: pull, b: b, logger: logger, ch: make(chan error)}
}

// HandleReceiveMessage ...
func (h *TestingHandler) HandleReceiveMessage(_ *actor.Actor, msg string) {
	err := json.Unmarshal([]byte(msg), h.pull)
	if err != nil {
		h.logger.Error("error decoding message", "err", err)
		return
	}
	go func() {
		h.ch <- h.runInstructions()
	}()
}

// runInstructions ...
func (h *TestingHandler) runInstructions() error {
	for i, ok := h.pull.NextInstruction(); ok; {
		if i.Run(h.b) {
			h.logger.Info("success running instruction", "instruction", i.Name())
		} else {
			return fmt.Errorf("error running instruction %v", i.Name())
		}
	}
	return nil
}
