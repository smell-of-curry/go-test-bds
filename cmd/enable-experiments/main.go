// Command enable-experiments turns on Script API experiment toggles in a
// Bedrock level.dat. Used by CI before restarting BDS with a script pack.
//
// Usage: go run ./cmd/enable-experiments <path/to/level.dat>
package main

import (
	"fmt"
	"os"

	"github.com/smell-of-curry/go-test-bds/internal/leveldat"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintf(os.Stderr, "usage: %s <path/to/level.dat>\n", os.Args[0])
		os.Exit(2)
	}
	path := os.Args[1]
	if err := leveldat.EnsureExperiments(path); err != nil {
		fmt.Fprintf(os.Stderr, "enable-experiments: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("enabled Script API experiments in %s\n", path)
}
