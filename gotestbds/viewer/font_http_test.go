package viewer

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestFontUnset404AndTraversalRejected(t *testing.T) {
	t.Setenv("GOTESTBDS_VIEWER_FONT_DIR", "")
	hub, err := New(Options{Address: "127.0.0.1:0", ArtifactDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	base := "http://" + hub.Addr()

	resp, err := http.Get(base + "/font/Mojangles.ttf")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unset font dir: status %d, want 404", resp.StatusCode)
	}

	for _, path := range []string{
		"/font/..%2Ffont_http.go",
		"/font/..%2ffont_http.go",
		"/font/%2e%2e%2ffont_http.go",
	} {
		resp, err := http.Get(base + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			t.Fatalf("GET %s: 200 body %q; traversal must be rejected", path, body)
		}
		if resp.StatusCode != http.StatusBadRequest && resp.StatusCode != http.StatusNotFound {
			t.Fatalf("GET %s: status %d, want 400 or 404", path, resp.StatusCode)
		}
	}
}

func TestFontServesBasename(t *testing.T) {
	dir := t.TempDir()
	body := []byte("fake-ttf")
	if err := os.WriteFile(filepath.Join(dir, "Mojangles.ttf"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	// A sibling outside the directory must not be readable via the route.
	outside := filepath.Join(filepath.Dir(dir), "secret-font-probe.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(outside) })

	hub, err := New(Options{
		Address:     "127.0.0.1:0",
		ArtifactDir: t.TempDir(),
		FontDir:     dir,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	base := "http://" + hub.Addr()

	resp, err := http.Get(base + "/font/Mojangles.ttf")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if string(got) != string(body) {
		t.Fatalf("body %q", got)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "font/ttf" {
		t.Fatalf("content-type %q", ct)
	}
	if origin := resp.Header.Get("Access-Control-Allow-Origin"); origin != "*" {
		t.Fatalf("cors %q", origin)
	}
}
