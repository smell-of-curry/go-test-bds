package viewer

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	dfworld "github.com/df-mc/dragonfly/server/world"
)

// TestHTTPStreamAndArtifact covers GET /stream hello+keyframe and POST /artifact.
func TestHTTPStreamAndArtifact(t *testing.T) {
	dir := t.TempDir()
	hub, err := New(Options{Address: "127.0.0.1:0", ArtifactDir: dir, Radius: 4})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("TestBot")
	a := testActor(t, "TestBot")
	addColumn(a.World(), dfworld.ChunkPos{0, 0})
	a.World().SetBlock(cube.Pos{1, 70, 1}, block.Gold{})

	// Drive ticks in the background so the stream gets a keyframe after hello.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 40; i++ {
			s.Tick(a)
			time.Sleep(25 * time.Millisecond)
		}
	}()

	resp, err := http.Get("http://" + hub.Addr() + "/stream?bot=TestBot")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("Content-Type=%s", ct)
	}

	events := readSSEEvents(t, resp.Body, 2, 3*time.Second)
	if events[0].event != "hello" {
		t.Fatalf("first event=%s", events[0].event)
	}
	var hello Hello
	if err := json.Unmarshal(events[0].data, &hello); err != nil {
		t.Fatal(err)
	}
	if hello.Bot != "TestBot" || hello.Schema != 1 || hello.Radius != 4 {
		t.Fatalf("hello=%+v", hello)
	}
	if events[1].event != "keyframe" {
		t.Fatalf("second event=%s", events[1].event)
	}
	var kf Keyframe
	if err := json.Unmarshal(events[1].data, &kf); err != nil {
		t.Fatal(err)
	}
	if kf.Type != "keyframe" || kf.Bot != "TestBot" {
		t.Fatalf("keyframe=%+v", kf)
	}

	body := []byte("fake-png-bytes")
	req, err := http.NewRequest(http.MethodPost, "http://"+hub.Addr()+"/artifact", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Artifact-Kind", "screenshot")
	req.Header.Set("X-Artifact-Ext", "png")
	req.Header.Set("X-Artifact-Bot", "TestBot")
	req.Header.Set("X-Artifact-Label", "failure")
	req.Header.Set("X-Artifact-Run", "run-7")
	req.Header.Set("X-Artifact-Suite", "machines")
	req.Header.Set("X-Artifact-Test", "places a crate")
	artResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer artResp.Body.Close()
	if artResp.StatusCode != 200 {
		b, _ := io.ReadAll(artResp.Body)
		t.Fatalf("status=%d body=%s", artResp.StatusCode, b)
	}
	var artJSON struct {
		V     int    `json:"v"`
		Path  string `json:"path"`
		Bytes int    `json:"bytes"`
	}
	if err := json.NewDecoder(artResp.Body).Decode(&artJSON); err != nil {
		t.Fatal(err)
	}
	if artJSON.V != 1 || artJSON.Bytes != len(body) {
		t.Fatalf("artifact response=%+v", artJSON)
	}
	// PROTOCOL.md: the reported path is relative to the run's artefact
	// directory, with forward slashes. bds-manager rejects anything else, so an
	// absolute or CWD-relative path here is a broken download route in prod.
	if artJSON.Path != "machines/places-a-crate/failure.png" {
		t.Fatalf("path=%q, want run-relative machines/places-a-crate/failure.png", artJSON.Path)
	}
	if _, err := os.Stat(filepath.Join(dir, "run-7", filepath.FromSlash(artJSON.Path))); err != nil {
		t.Fatalf("artifact file missing: %v", err)
	}

	<-done
}

type sseEvent struct {
	event string
	data  []byte
}

func readSSEEvents(t *testing.T, r io.Reader, n int, timeout time.Duration) []sseEvent {
	t.Helper()
	type result struct {
		events []sseEvent
		err    error
	}
	ch := make(chan result, 1)
	go func() {
		var events []sseEvent
		sc := bufio.NewScanner(r)
		var event string
		var data []byte
		for sc.Scan() {
			line := sc.Text()
			if strings.HasPrefix(line, "event: ") {
				event = strings.TrimPrefix(line, "event: ")
				continue
			}
			if strings.HasPrefix(line, "data: ") {
				data = []byte(strings.TrimPrefix(line, "data: "))
				continue
			}
			if line == "" && event != "" {
				events = append(events, sseEvent{event: event, data: data})
				event, data = "", nil
				if len(events) >= n {
					ch <- result{events: events}
					return
				}
			}
		}
		ch <- result{events: events, err: sc.Err()}
	}()
	select {
	case res := <-ch:
		if res.err != nil {
			t.Fatal(res.err)
		}
		if len(res.events) < n {
			t.Fatalf("got %d events, want %d", len(res.events), n)
		}
		return res.events
	case <-time.After(timeout):
		t.Fatal("timeout reading SSE events")
		return nil
	}
}
