package gotestbds

import "time"

const (
	// StatusSuccess indicates the instruction completed without error.
	StatusSuccess = "success"
	// StatusError indicates the instruction failed.
	StatusError = "error"
	// StatusTimeOut indicates the instruction exceeded its timeout.
	StatusTimeOut = "timeout"
)

const (
	// StatusMessagePrefix prefixes outbound status chat messages.
	StatusMessagePrefix = "[STATUS]"
)

// DefaultInstructionTimeout is used when a request omits timeoutMs and Test.DefaultInstructionTimeout is zero.
const DefaultInstructionTimeout = 20 * time.Second
