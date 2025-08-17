# GO TEST BDS

![Logo](images/logo.png)

## Overview

GoTestBDS is a designed to be a complete end-to-end testing framework for Minecraft Bedrock Dedicated Servers written in Go. GoTestBDS is built on top of [GopherTunnel](https://github.com/Sandertv/gophertunnel) and gives the ability to register fake clients to test your Script API BDS Addons.

## Features

- [x] Connect Fake Clients to a BDS Server
- [x] Implements all [clientOriginating](https://github.com/Sandertv/gophertunnel/blob/master/minecraft/protocol/packet/pool.go#L279) packets to simple JSON interfaces
- [x] Parses text packets from the BDS Server to JSON
- [x] Sends text JSON packets to the BDS Server
- [x] Smooth Navigation simulation
- [x] Full UI and Form Automation

## Example
```go
package main

import (
	"context"
	"log/slog"

	"github.com/FDUTCH/dummy_item_blocks/dummy"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/smell-of-curry/go-test-bds/gotestbds"
)

func main() {
	//This is recommended so that the bot has more information about the blocks, making its actions more accurate.
	dummy.Register()

	err := gotestbds.Test{
		Dialer: minecraft.Dialer{
			// your Dialer settings
		},
		RemoteAddress: "your_server.com:19132",
		Logger:        slog.Default(),
	}.RunCtx(context.Background())
	
	if err != nil {
		slog.Error(err.Error())
	}
}
```

## License

...

## API

To call the API from the server side, you must send a JSON message with the prefix `[RUN_ACTION]`, which must contain two fields:
first: “action” — this is like the name of the function,
second: “parameters” — theis is like the parameters that you pass to the function.

Example: `[RUN_ACTION]{"action":"placeBlock","parameters":{"pos":[100,60,-10]}}`

And the bot will respond with another JSON message with the prefix ```[STATUS]```, which may contain 2 fields:
first (mandatory) field: "status" which can have one of three values: "success", "error" or "timeout",
second (optional) field "message" which may contain some information.

Example: ```[STATUS]{"status":"error","message":"main hand is empty"}```

For list of all instructions follow https://github.com/smell-of-curry/go-test-bds/tree/main/gotestbds/instruction

Documentation for all packages may be found [here](https://pkg.go.dev/github.com/smell-of-curry/go-test-bds/gotestbds) 

