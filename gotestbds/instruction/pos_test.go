package instruction

import (
	"encoding/json"
	"testing"
)

// TestPosUnmarshal covers both accepted shapes. The array case used to decode
// through Pos itself, which re-entered UnmarshalJSON until the stack overflowed
// and took the whole bot with it.
func TestPosUnmarshal(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   string
		want Pos
	}{
		{name: "array", in: `[66, 77, 0]`, want: Pos{66, 77, 0}},
		{name: "object", in: `{"x":66,"y":77,"z":0}`, want: Pos{66, 77, 0}},
		{name: "fractional object", in: `{"x":66.9,"y":77.2,"z":-1.5}`, want: Pos{66, 77, -1}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got Pos
			if err := json.Unmarshal([]byte(tc.in), &got); err != nil {
				t.Fatalf("unmarshal %s: %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}

	var got Pos
	if err := json.Unmarshal([]byte(`"nowhere"`), &got); err == nil {
		t.Error("a position that is neither shape should report an error")
	}
}
