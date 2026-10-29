package instruction

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Command asks the server to run a slash command as the player.
// A leading slash is optional. When a CommandOutput comes back with the same
// origin UUID it is returned as Data; if none arrives before the instruction
// context ends, the instruction still succeeds with no data.
type Command struct {
	Command string `json:"command"`
	out     *CommandOutputData
}

// CommandOutputData is the correlated CommandOutput, when one arrived.
type CommandOutputData struct {
	SuccessCount uint32           `json:"successCount"`
	Messages     []CommandMessage `json:"messages"`
}

// CommandMessage is one line of command output.
type CommandMessage struct {
	Success    bool     `json:"success"`
	Message    string   `json:"message"`
	Parameters []string `json:"parameters,omitempty"`
}

// Name is the instruction name.
func (*Command) Name() string { return "command" }

// Data returns the correlated output, or nil when none arrived.
func (c *Command) Data() any {
	if c.out == nil {
		return nil
	}
	return c.out
}

// Run sends the command and waits for a correlated output until ctx ends.
func (c *Command) Run(ctx context.Context, b *bot.Bot) error {
	id := uuid.New()
	var (
		ch   <-chan actor.CommandResult
		stop func()
	)
	err := execute(b, func(a *actor.Actor) error {
		pk, err := CommandPacket(c.Command, id, a.PlayerUniqueID())
		if err != nil {
			return err
		}
		ch, err = a.WriteCommandRequest(pk)
		if err != nil {
			return err
		}
		origin := pk.CommandOrigin.UUID
		stop = func() { a.UnwatchCommand(origin) }
		return nil
	})
	if stop != nil {
		defer stop()
	}
	if err != nil {
		return err
	}
	if ch == nil {
		return nil
	}
	select {
	case res := <-ch:
		c.out = commandData(res)
		return nil
	case <-ctx.Done():
		select {
		case res := <-ch:
			c.out = commandData(res)
		default:
		}
		return nil
	case <-b.Closed():
		return nil
	}
}

func commandData(res actor.CommandResult) *CommandOutputData {
	msgs := make([]CommandMessage, len(res.Messages))
	for i, m := range res.Messages {
		msgs[i] = CommandMessage{Success: m.Success, Message: m.Message, Parameters: m.Parameters}
	}
	if msgs == nil {
		msgs = []CommandMessage{}
	}
	return &CommandOutputData{SuccessCount: res.SuccessCount, Messages: msgs}
}

// CommandPacket builds a player-origin CommandRequest.
// A missing leading slash is added. An empty line is an error.
func CommandPacket(line string, origin uuid.UUID, playerUniqueID int64) (*packet.CommandRequest, error) {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil, errEmptyCommand
	}
	if !strings.HasPrefix(line, "/") {
		line = "/" + line
	}
	return &packet.CommandRequest{
		CommandLine: line,
		CommandOrigin: protocol.CommandOrigin{
			Origin:         protocol.CommandOriginPlayer,
			UUID:           origin,
			PlayerUniqueID: playerUniqueID,
		},
		Internal: false,
	}, nil
}

type emptyCommandError struct{}

func (emptyCommandError) Error() string { return "command is empty" }

var errEmptyCommand emptyCommandError
