package viewer

import "testing"

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
