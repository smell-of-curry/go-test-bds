package gotestbds

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/instruction"
)

// Dispatch runs one instruction from pull the same way the chat [RUN_ACTION]
// path does, and returns the status, message and data the [STATUS] envelope
// would carry. It does not send chat.
//
// A nil ctx is treated as a background context. timeout and cancellation are
// the caller's job: a DeadlineExceeded from Run is StatusTimeOut, any other
// error is StatusError.
func Dispatch(ctx context.Context, pull *instruction.Pull, b *bot.Bot, action string, params json.RawMessage) (status, message string, data any) {
	if ctx == nil {
		ctx = context.Background()
	}
	if pull == nil {
		return StatusError, "no instruction registry", nil
	}
	i, err := pull.DecodeAction(action, params)
	if err != nil {
		return StatusError, err.Error(), nil
	}
	if err = i.Run(ctx, b); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return StatusTimeOut, err.Error(), nil
		}
		return StatusError, err.Error(), nil
	}
	if di, ok := i.(instruction.DataInstruction); ok {
		return StatusSuccess, "", di.Data()
	}
	return StatusSuccess, "", nil
}
