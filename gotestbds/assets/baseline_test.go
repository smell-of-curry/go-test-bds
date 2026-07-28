package assets

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeFetcher struct {
	src     string
	calls   int
	failMsg string
}

func (f *fakeFetcher) Fetch(_ context.Context, _, dest string) error {
	f.calls++
	if f.failMsg != "" {
		return &fetchError{f.failMsg}
	}
	return copyDir(f.src, dest)
}

type fetchError struct{ s string }

func (e *fetchError) Error() string { return e.s }

func TestMissingBaselineFailsLoudly(t *testing.T) {
	cache := t.TempDir()
	_, err := EnsureBaseline(context.Background(), cache, "v1.26.30.5", &fakeFetcher{failMsg: "network down"}, false)
	if err == nil {
		t.Fatal("expected error for missing baseline")
	}
	msg := err.Error()
	if !strings.Contains(msg, "v1.26.30.5") && !strings.Contains(msg, "1.26.30.5") {
		t.Fatalf("error should name the pin: %v", err)
	}
	if !strings.Contains(msg, "fetch") && !strings.Contains(msg, "network") && !strings.Contains(msg, "missing") {
		t.Fatalf("error should be actionable, got: %v", err)
	}

	_, err = New(context.Background(), Options{
		CacheDir:    cache,
		BaselineTag: "v1.26.30.5",
		Offline:     true,
		Fetcher:     &fakeFetcher{failMsg: "should not be called"},
	})
	if err == nil {
		t.Fatal("offline New with empty cache must fail")
	}
	if !strings.Contains(err.Error(), "offline") && !strings.Contains(err.Error(), "missing") {
		t.Fatalf("want loud offline/missing error, got: %v", err)
	}
}

func TestFetchedBaselineMatchesPin(t *testing.T) {
	cache := t.TempDir()
	src := filepath.Join("testdata", "samples")
	f := &fakeFetcher{src: src}
	dir, err := EnsureBaseline(context.Background(), cache, "v1.26.30.5", f, false)
	if err != nil {
		t.Fatal(err)
	}
	if f.calls != 1 {
		t.Fatalf("fetcher calls=%d, want 1", f.calls)
	}
	if err := VerifyBaseline(dir, "v1.26.30.5"); err != nil {
		t.Fatal(err)
	}

	// Second call uses cache — no re-fetch.
	dir2, err := EnsureBaseline(context.Background(), cache, "v1.26.30.5", f, false)
	if err != nil {
		t.Fatal(err)
	}
	if dir2 != dir {
		t.Fatalf("cache path drifted: %s vs %s", dir, dir2)
	}
	if f.calls != 1 {
		t.Fatalf("fetcher calls=%d after cache hit, want 1", f.calls)
	}

	// Wrong pin against an existing cache entry must fail verification.
	wrong := filepath.Join(cache, "baseline", "v9.9.9.9")
	if err := copyDir(src, wrong); err != nil {
		t.Fatal(err)
	}
	if err := VerifyBaseline(wrong, "v9.9.9.9"); err == nil {
		t.Fatal("expected version mismatch error")
	} else if !strings.Contains(err.Error(), "mismatch") {
		t.Fatalf("want mismatch error, got: %v", err)
	}
}

func TestVerifyBaselineMissingFile(t *testing.T) {
	dir := t.TempDir()
	err := VerifyBaseline(dir, "v1.26.30.5")
	if err == nil {
		t.Fatal("expected missing baseline error")
	}
	if !strings.Contains(err.Error(), "missing") {
		t.Fatalf("got: %v", err)
	}
	// Actionable: names the pin and the path.
	if !strings.Contains(err.Error(), "v1.26.30.5") {
		t.Fatalf("error should mention pin: %v", err)
	}
	_ = os.WriteFile(filepath.Join(dir, "version.json"), []byte(`{"latest":{"version":"1.26.30.5"}}`), 0o644)
	err = VerifyBaseline(dir, "v1.26.30.5")
	if err == nil || !strings.Contains(err.Error(), "resource_pack") {
		t.Fatalf("want resource_pack missing error, got: %v", err)
	}
}
