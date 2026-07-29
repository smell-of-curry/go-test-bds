package viewer

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/smell-of-curry/go-test-bds/gotestbds/assets"
)

func installTestLang(t *testing.T, table map[string]string) {
	t.Helper()
	activeLang.Store(&table)
	t.Cleanup(func() { activeLang.Store(nil) })
}

func TestParseLang(t *testing.T) {
	got := map[string]string{}
	parseLang([]byte("## comment\r\nfoo.bar=Hello %1!\r\n\r\nbad line\nwith.eq=a=b\ttail\t## note\n"), got)
	if got["foo.bar"] != "Hello %1!" {
		t.Fatalf("foo.bar=%q", got["foo.bar"])
	}
	if got["with.eq"] != "a=b\ttail" {
		t.Fatalf("with.eq=%q (inline comment must strip, value tabs stay)", got["with.eq"])
	}
	if _, ok := got["bad line"]; ok {
		t.Fatal("line without = must be skipped")
	}
}

func TestSubstituteLang(t *testing.T) {
	cases := []struct {
		tmpl string
		args []string
		want string
	}{
		{"%1 sent out %2!", []string{"TestBot", "Bulbasaur"}, "TestBot sent out Bulbasaur!"},
		{"%s used %s!", []string{"Munchlax", "Tackle"}, "Munchlax used Tackle!"},
		{"Turn %1", nil, "Turn %1"},
		{"%2 then %1", []string{"a", "b"}, "b then a"},
		{"%1 and %s", []string{"x", "y"}, "x and y"},
		{"100%% plain", []string{"z"}, "100%% plain"},
	}
	for _, c := range cases {
		if got := substituteLang(c.tmpl, c.args); got != c.want {
			t.Fatalf("substituteLang(%q,%v)=%q want %q", c.tmpl, c.args, got, c.want)
		}
	}
}

func TestFlattenRawtextResolvesThroughLangTable(t *testing.T) {
	installTestLang(t, map[string]string{
		"models.showdown.switch.actor": "%1 sent out %2!",
	})
	in := `{"rawtext":[{"translate":"models.showdown.switch.actor","with":["TestBot","Bulbasaur"]}]}`
	if got := flattenRawtext(in); got != "TestBot sent out Bulbasaur!" {
		t.Fatalf("flattenRawtext=%q", got)
	}
	// Unknown key keeps the readable fallback (key + args).
	in = `{"rawtext":[{"translate":"no.such.key","with":["x"]}]}`
	if got := flattenRawtext(in); got != "no.such.key x" {
		t.Fatalf("fallback=%q", got)
	}
}

// TestInstallLangTableFromStack drives the production path end to end: a
// built assets.Stack whose pack ships texts/en_US.lang must install a table
// that flattenRawtext resolves through. Run 27 shipped raw keys with the
// table code deployed, so the unit fixtures alone clearly weren't enough.
func TestInstallLangTableFromStack(t *testing.T) {
	dir := t.TempDir()
	writeLangPack(t, dir)
	st, err := assets.BuildStack([]assets.StackEntry{{ID: "srv", Dir: dir}}, 5)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { activeLang.Store(nil) })
	installLangTable(st)
	got, ok := translateKey("models.showdown.switch.actorSentOut", []string{"TestBot", "Bulbasaur"})
	if !ok {
		t.Fatal("table not installed from stack")
	}
	if got != "TestBot sent out Bulbasaur!" {
		t.Fatalf("translateKey=%q", got)
	}
}

// writeLangPack lays out a minimal resource pack with one lang file.
//
// @param t The test.
// @param dir Pack root to populate.
func writeLangPack(t *testing.T, dir string) {
	t.Helper()
	manifest := `{
  "format_version": 2,
  "header": {
    "name": "Lang Fixture",
    "description": "test",
    "uuid": "33333333-3333-3333-3333-333333333333",
    "version": [1, 0, 0],
    "min_engine_version": [1, 20, 0]
  },
  "modules": [
    {"type": "resources", "uuid": "33333333-3333-3333-3333-333333333334", "version": [1, 0, 0]}
  ]
}`
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "texts"), 0o755); err != nil {
		t.Fatal(err)
	}
	lang := "models.showdown.switch.actorSentOut=%1 sent out %2!\n"
	if err := os.WriteFile(filepath.Join(dir, "texts", "en_US.lang"), []byte(lang), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestResolveLangLines(t *testing.T) {
	installTestLang(t, map[string]string{
		"showdown.moves.growl.shortDesc": "Lowers the foe's Attack.",
	})
	in := "b:1_normal .growl\nshowdown.moves.growl.shortDesc"
	want := "b:1_normal .growl\nLowers the foe's Attack."
	if got := resolveLangLines(in); got != want {
		t.Fatalf("resolveLangLines=%q want %q", got, want)
	}
	// No table → untouched.
	activeLang.Store(nil)
	if got := resolveLangLines(in); got != in {
		t.Fatalf("nil table changed text: %q", got)
	}
}
