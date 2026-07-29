// Command fetch-baseline ensures the pinned Mojang/bedrock-samples tag from
// viewer/baseline.tag is present under the viewer cache (default .cache).
//
// Usage: go run ./cmd/fetch-baseline [cacheRoot]
// Prints the absolute path of the extracted baseline directory on success.
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/smell-of-curry/go-test-bds/gotestbds/assets"
)

func main() {
	cacheRoot := ".cache"
	if len(os.Args) > 1 {
		cacheRoot = os.Args[1]
	}
	pinPath := filepath.Join("viewer", "baseline.tag")
	if env := os.Getenv("GOTESTBDS_BASELINE_PIN"); env != "" {
		pinPath = env
	}
	tag, err := assets.ReadPinFile(pinPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fetch-baseline: %v\n", err)
		os.Exit(1)
	}
	dir, err := assets.EnsureBaseline(context.Background(), cacheRoot, tag, nil, false)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fetch-baseline: %v\n", err)
		os.Exit(1)
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fetch-baseline: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(abs)
}
