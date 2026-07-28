package assets

import (
	"path/filepath"
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
