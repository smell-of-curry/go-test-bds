package assets

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// DefaultBaselineTag is the pinned Mojang/bedrock-samples tag shipped in
// viewer/baseline.tag. Override via config / GOTESTBDS_VIEWER_BASELINE.
const DefaultBaselineTag = "v1.26.30.5"

// Fetcher retrieves a bedrock-samples tag into a destination directory.
// Tests inject a fake; production uses HTTPFetcher.
type Fetcher interface {
	// Fetch downloads and extracts the given tag so that dest contains
	// version.json and resource_pack/ at its root (not nested in a zipball folder).
	Fetch(ctx context.Context, tag, dest string) error
}

// HTTPFetcher downloads GitHub tag zipballs of Mojang/bedrock-samples.
type HTTPFetcher struct {
	Client  *http.Client
	BaseURL string // default https://github.com/Mojang/bedrock-samples
}

func (f *HTTPFetcher) client() *http.Client {
	if f.Client != nil {
		return f.Client
	}
	return &http.Client{Timeout: 10 * time.Minute}
}

func (f *HTTPFetcher) base() string {
	if f.BaseURL != "" {
		return strings.TrimRight(f.BaseURL, "/")
	}
	return "https://github.com/Mojang/bedrock-samples"
}

// Fetch downloads archive/refs/tags/<tag>.zip and extracts it into dest.
func (f *HTTPFetcher) Fetch(ctx context.Context, tag, dest string) error {
	url := f.base() + "/archive/refs/tags/" + tag + ".zip"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := f.client().Do(req)
	if err != nil {
		return fmt.Errorf("assets: download bedrock-samples %s: %w", tag, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("assets: download bedrock-samples %s: HTTP %d: %s", tag, resp.StatusCode, body)
	}
	tmpZip := dest + ".zip.tmp"
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	out, err := os.Create(tmpZip)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, resp.Body); err != nil {
		_ = out.Close()
		_ = os.Remove(tmpZip)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmpZip)
		return err
	}
	tmpDir := dest + ".extract"
	_ = os.RemoveAll(tmpDir)
	if err := unzipTo(tmpZip, tmpDir); err != nil {
		_ = os.RemoveAll(tmpDir)
		_ = os.Remove(tmpZip)
		return err
	}
	_ = os.Remove(tmpZip)
	root, err := findSamplesRoot(tmpDir)
	if err != nil {
		_ = os.RemoveAll(tmpDir)
		return err
	}
	_ = os.RemoveAll(dest)
	if err := os.Rename(root, dest); err != nil {
		if err := copyDir(root, dest); err != nil {
			_ = os.RemoveAll(tmpDir)
			_ = os.RemoveAll(dest)
			return err
		}
	}
	_ = os.RemoveAll(tmpDir)
	return nil
}

func findSamplesRoot(dir string) (string, error) {
	if _, err := os.Stat(filepath.Join(dir, "version.json")); err == nil {
		if _, err := os.Stat(filepath.Join(dir, "resource_pack")); err == nil {
			return dir, nil
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		candidate := filepath.Join(dir, e.Name())
		if _, err := os.Stat(filepath.Join(candidate, "version.json")); err != nil {
			continue
		}
		if _, err := os.Stat(filepath.Join(candidate, "resource_pack")); err != nil {
			continue
		}
		return candidate, nil
	}
	return "", fmt.Errorf("assets: bedrock-samples zip missing version.json/resource_pack under %s", dir)
}

// samplesVersionJSON is the shape of Mojang/bedrock-samples version.json:
//
//	{ "latest": { "version": "1.26.30.5", "date": "…" }, "1.26.30.5": { … }, … }
type samplesVersionJSON struct {
	Latest *struct {
		Version string `json:"version"`
		Date    string `json:"date"`
	} `json:"latest"`
}

// TagVersion strips a leading "v" from a git tag to match version.json keys.
func TagVersion(tag string) string {
	return strings.TrimPrefix(strings.TrimSpace(tag), "v")
}

// VerifyBaseline checks that dir is a bedrock-samples checkout matching tag.
//
// @param dir Extracted baseline directory.
// @param tag Pinned tag (e.g. v1.26.30.5).
// @returns nil when version.json's latest.version matches the tag.
// @throws with an actionable message when missing or mismatched.
func VerifyBaseline(dir, tag string) error {
	want := TagVersion(tag)
	versionPath := filepath.Join(dir, "version.json")
	b, err := os.ReadFile(versionPath)
	if err != nil {
		return fmt.Errorf("assets: vanilla baseline missing at %s (pin %s). Fetch with the viewer enabled, or set Viewer.CacheDir / -viewer-cache. Underlying error: %w", dir, tag, err)
	}
	var v samplesVersionJSON
	if err := json.Unmarshal(b, &v); err != nil {
		return fmt.Errorf("assets: invalid baseline version.json at %s: %w", versionPath, err)
	}
	if v.Latest == nil || v.Latest.Version == "" {
		return fmt.Errorf("assets: baseline version.json at %s has no latest.version (pin %s)", versionPath, tag)
	}
	got := v.Latest.Version
	if got != want {
		return fmt.Errorf("assets: baseline version mismatch at %s: got %s, want %s (pin %s). Delete the cache entry and re-fetch", dir, got, want, tag)
	}
	rp := filepath.Join(dir, "resource_pack", "manifest.json")
	if _, err := os.Stat(rp); err != nil {
		return fmt.Errorf("assets: baseline resource_pack/manifest.json missing under %s (pin %s): %w", dir, tag, err)
	}
	return nil
}

// EnsureBaseline makes sure the pinned baseline is present under cacheRoot.
// Offline mode refuses to fetch and fails if the cache entry is absent/mismatched.
//
// @param ctx Cancellation for the network fetch.
// @param cacheRoot Viewer cache root.
// @param tag Pinned tag.
// @param fetcher Network fetcher; unused when the cache already verifies.
// @param offline When true, never call fetcher.
// @returns the absolute path to the extracted baseline directory.
// @throws when the baseline cannot be obtained or does not match the pin.
func EnsureBaseline(ctx context.Context, cacheRoot, tag string, fetcher Fetcher, offline bool) (string, error) {
	if tag == "" {
		tag = DefaultBaselineTag
	}
	dir := filepath.Join(cacheRoot, "baseline", tag)
	if err := VerifyBaseline(dir, tag); err == nil {
		return dir, nil
	} else if offline {
		return "", fmt.Errorf("%v\nassets: offline mode is on — will not fetch. Populate %s first", err, dir)
	}
	if fetcher == nil {
		fetcher = &HTTPFetcher{}
	}
	_ = os.RemoveAll(dir)
	if err := fetcher.Fetch(ctx, tag, dir); err != nil {
		return "", fmt.Errorf("assets: failed to fetch bedrock-samples %s into %s: %w", tag, dir, err)
	}
	if err := VerifyBaseline(dir, tag); err != nil {
		return "", err
	}
	return dir, nil
}

// ReadPinFile reads a baseline tag from a one-line pin file.
func ReadPinFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	tag := strings.TrimSpace(string(b))
	if tag == "" {
		return "", fmt.Errorf("assets: empty pin file %s", path)
	}
	return tag, nil
}
