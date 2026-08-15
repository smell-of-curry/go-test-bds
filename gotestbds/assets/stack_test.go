package assets

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStackServerPackWins(t *testing.T) {
	vanilla := filepath.Join("testdata", "vanilla")
	server := filepath.Join("testdata", "server")
	st, err := BuildStack([]StackEntry{
		{ID: PackIDVanilla, Dir: vanilla},
		{ID: "22222222-2222-2222-2222-222222222222", UUID: "22222222-2222-2222-2222-222222222222", Version: "1.2.3", Dir: server},
	}, 5)
	if err != nil {
		t.Fatal(err)
	}

	if got := st.Winner("textures/blocks/stone.png"); got != "22222222-2222-2222-2222-222222222222" {
		t.Fatalf("winner=%q, want server pack (later in ResourcePackStack apply order)", got)
	}
	_, data, _, err := st.Resolve("textures/blocks/stone.png")
	if err != nil {
		t.Fatal(err)
	}
	// Device tier 5 selects subpack "full" (memory_performance_tier 5), which
	// overrides the server pack root — evidence for the subpack rule.
	if string(data) != "server-stone-full" {
		t.Fatalf("stone bytes=%q, want server-stone-full (server pack + full subpack)", data)
	}

	if got := st.Winner("textures/blocks/dirt.png"); got != PackIDVanilla {
		t.Fatalf("dirt winner=%q, want vanilla (only baseline defines it)", got)
	}
}

func TestSubpackMemoryPerformanceTier(t *testing.T) {
	server := filepath.Join("testdata", "server")
	st, err := BuildStack([]StackEntry{{ID: "srv", Dir: server}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	_, data, _, err := st.Resolve("textures/blocks/stone.png")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "server-stone-lite" {
		t.Fatalf("tier1 stone=%q, want server-stone-lite", data)
	}
}

// Sidebar ball + species sprite URLs the viewer builds
// (`textures/ui/sidebar/balls/poke.png`, `textures/sprites/default/bulbasaur.png`)
// must resolve from the pack ROOT — PokeBedrock keeps 2D sprites outside subpacks/3d.
func TestSidebarSpritePathsResolveFromPackRoot(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, body string) {
		t.Helper()
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("manifest.json", `{"format_version":2,"header":{"name":"t","uuid":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","version":[1,0,0]},"modules":[{"type":"resources","uuid":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","version":[1,0,0]}]}`)
	write("textures/sprites/default/bulbasaur.png", "SPRITE")
	write("textures/ui/sidebar/balls/poke.png", "BALL")
	// 3D subpack must not be required for 2D sidebar art.
	write("subpacks/3d/textures/sprites/default/bulbasaur.png", "WRONG")

	st, err := BuildStack([]StackEntry{{ID: "pb", Dir: dir}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"textures/sprites/default/bulbasaur.png",
		"textures/ui/sidebar/balls/poke.png",
	} {
		_, data, _, err := st.Resolve(path)
		if err != nil {
			t.Fatalf("Resolve(%s): %v", path, err)
		}
		want := "SPRITE"
		if strings.Contains(path, "balls") {
			want = "BALL"
		}
		if string(data) != want {
			t.Fatalf("Resolve(%s)=%q, want %q (pack root, not subpacks/3d)", path, data, want)
		}
	}
}

func TestNormalizePathTraversal(t *testing.T) {
	for _, p := range []string{"../secret", "..\\secret", "/etc/passwd", "a/../../b", ""} {
		if _, err := NormalizePath(p); err == nil {
			t.Fatalf("NormalizePath(%q) succeeded, want error", p)
		}
	}
	got, err := NormalizePath(`Textures\Blocks\Stone.PNG`)
	if err != nil {
		t.Fatal(err)
	}
	if got != "textures/blocks/stone.png" {
		t.Fatalf("got %q", got)
	}
}
