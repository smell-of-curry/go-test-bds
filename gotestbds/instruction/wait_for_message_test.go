package instruction

import (
	"regexp"
	"testing"
)

func TestMessageMatches(t *testing.T) {
	re := regexp.MustCompile(`player\s+\w+`)

	cases := []struct {
		name     string
		text     string
		contains string
		re       *regexp.Regexp
		want     bool
	}{
		{"contains hit", "Hello World", "hello", nil, true},
		{"contains miss", "Hello World", "bye", nil, false},
		{"regex hit", "player Steve joined", "", re, true},
		{"regex miss", "nobody here", "", re, false},
		{"both hit", "player Steve joined", "steve", re, true},
		{"both contains miss", "player Steve joined", "alex", re, false},
		{"both regex miss", "Steve joined", "steve", re, false},
		{"neither configured", "anything", "", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := messageMatches(tc.text, tc.contains, tc.re)
			if got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}
