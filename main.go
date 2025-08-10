package main

import (
	"log/slog"
	"os"

	"github.com/FDUTCH/dummy_item_blocks/dummy"
	"github.com/smell-of-curry/go-test-bds/gotestbds"
)

// example
func main() {
	//This is recommended so that the bot has more information about the blocks, making its actions more accurate.
	dummy.Register()

	err := gotestbds.RunTest(os.Args[1])
	if err != nil {
		slog.Error(err.Error())
	}
}
