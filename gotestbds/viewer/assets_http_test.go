package viewer

import (
	"context"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/smell-of-curry/go-test-bds/gotestbds/assets"
)

type copyFetcher struct{ src string }

func (f copyFetcher) Fetch(_ context.Context, _, dest string) error {
	return copyTree(f.src, dest)
}

func copyTree(src, dest string) error {
	return filepath.WalkDir(src, func(fpath string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, fpath)
		if err != nil {
			return err
		}
		target := filepath.Join(dest, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(fpath)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
}

func TestAssetHTTPPathTraversalRejected(t *testing.T) {
	cache := t.TempDir()
	samples := filepath.Join("..", "assets", "testdata", "samples")
	mgr, err := assets.New(context.Background(), assets.Options{
		CacheDir:    cache,
		BaselineTag: "v1.26.30.5",
		Fetcher:     copyFetcher{src: samples},
	})
	if err != nil {
		t.Fatal(err)
	}

	hub, err := New(Options{Address: "127.0.0.1:0", ArtifactDir: t.TempDir(), Assets: mgr})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	base := "http://" + hub.Addr()

	for _, path := range []string{
		"/asset/../viewer.go",
		"/asset/..%2Fviewer.go",
		"/pack/vanilla/../viewer.go",
		"/pack/vanilla/..%2Fviewer.go",
		"/pack/vanilla/foo/../../viewer.go",
	} {
		resp, err := http.Get(base + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			t.Fatalf("GET %s: status 200 with body %q; traversal must be rejected", path, body)
		}
		if resp.StatusCode != http.StatusBadRequest && resp.StatusCode != http.StatusNotFound {
			t.Fatalf("GET %s: status %d, want 400 or 404", path, resp.StatusCode)
		}
	}

	// Positive control: a real asset path works.
	resp, err := http.Get(base + "/asset/textures/blocks/stone.png")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /asset/textures/blocks/stone.png: status %d", resp.StatusCode)
	}
}
