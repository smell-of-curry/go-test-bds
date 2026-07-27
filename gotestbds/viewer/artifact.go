package viewer

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
)

// maxArtifactBytes rejects uploads that would blow memory. 256 MB is well
// above a screenshot or short webm and far below "read the body unbounded".
const maxArtifactBytes = 256 << 20

// artifactStore owns the on-disk layout and pending capture waiters.
type artifactStore struct {
	dir string

	mu      sync.Mutex
	runID   string
	suite   string
	test    string
	pending map[string]chan captureResult
	ready   []Artifact
	capSeq  atomic.Uint64
}

type captureResult struct {
	art Artifact
	err error
}

func newArtifactStore(dir string) (*artifactStore, error) {
	if dir == "" {
		dir = "artifacts"
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &artifactStore{
		dir:     dir,
		pending: make(map[string]chan captureResult),
	}, nil
}

// setMarkContext records the current run/suite/test for path building.
func (s *artifactStore) setMarkContext(m Mark) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if m.RunID != "" {
		s.runID = m.RunID
	}
	switch m.Phase {
	case "suiteStart":
		s.suite = m.Suite
		s.test = ""
	case "testStart":
		if m.Suite != "" {
			s.suite = m.Suite
		}
		s.test = m.Test
	case "runStart":
		s.suite = ""
		s.test = ""
	}
}

func (s *artifactStore) nextCaptureID() string {
	n := s.capSeq.Add(1)
	return fmt.Sprintf("cap-%d", n)
}

func (s *artifactStore) beginCapture(id string) <-chan captureResult {
	ch := make(chan captureResult, 1)
	s.mu.Lock()
	s.pending[id] = ch
	s.mu.Unlock()
	return ch
}

func (s *artifactStore) failCapture(id, message string) bool {
	s.mu.Lock()
	ch, ok := s.pending[id]
	if ok {
		delete(s.pending, id)
	}
	s.mu.Unlock()
	if !ok {
		return false
	}
	ch <- captureResult{err: fmt.Errorf("%s", message)}
	return true
}

func (s *artifactStore) resolveCapture(id string, art Artifact) bool {
	s.mu.Lock()
	ch, ok := s.pending[id]
	if ok {
		delete(s.pending, id)
	}
	s.mu.Unlock()
	if !ok {
		return false
	}
	ch <- captureResult{art: art}
	return true
}

// writeArtifact persists bytes under the PROTOCOL naming scheme.
func (s *artifactStore) writeArtifact(meta Artifact, body []byte) (Artifact, error) {
	s.mu.Lock()
	runID, suite, test := s.runID, s.suite, s.test
	s.mu.Unlock()

	if meta.RunID != "" {
		runID = meta.RunID
	}
	if meta.Suite != "" {
		suite = meta.Suite
	}
	if meta.Test != "" {
		test = meta.Test
	}
	if runID == "" {
		runID = "no-run"
	}
	label := meta.Label
	if label == "" {
		label = meta.Kind
	}
	if label == "" {
		label = "artifact"
	}
	ext := meta.Ext
	if ext == "" {
		ext = "bin"
	}

	rel, abs, err := s.uniquePath(runID, suite, test, label, ext)
	if err != nil {
		return Artifact{}, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return Artifact{}, err
	}
	if err := os.WriteFile(abs, body, 0o644); err != nil {
		return Artifact{}, err
	}

	art := meta
	art.Path = rel
	art.Bytes = len(body)
	if art.RunID == "" {
		art.RunID = runID
	}
	if art.Suite == "" {
		art.Suite = suite
	}
	if art.Test == "" {
		art.Test = test
	}

	s.mu.Lock()
	s.ready = append(s.ready, art)
	s.mu.Unlock()
	return art, nil
}

func (s *artifactStore) pull() []Artifact {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.ready
	s.ready = nil
	return out
}

// uniquePath writes to <ArtifactDir>/<runId>/<suite-slug>/<test-slug>/<label-slug>.<ext>
// with -2, -3 suffixes on collision rather than overwriting.
//
// rel is the part below <runId>, with forward slashes: PROTOCOL.md defines a
// reported path as relative to the run's artefact directory, because that is the
// directory a consumer already knows. Reporting the absolute path instead would
// name a location that means nothing on the machine fetching it.
func (s *artifactStore) uniquePath(runID, suite, test, label, ext string) (rel, abs string, err error) {
	runDir := filepath.Join(s.dir, slug(runID))
	var prefix []string
	if suite != "" {
		prefix = append(prefix, slug(suite))
	}
	if test != "" {
		prefix = append(prefix, slug(test))
	}
	base := slug(label)
	if base == "" {
		base = "artifact"
	}
	for n := 0; ; n++ {
		name := base
		if n > 0 {
			name = fmt.Sprintf("%s-%d", base, n+1)
		}
		parts := append(append([]string{}, prefix...), name+"."+ext)
		rel = path.Join(parts...)
		abs = filepath.Join(runDir, filepath.Join(parts...))
		_, statErr := os.Stat(abs)
		if os.IsNotExist(statErr) {
			return rel, abs, nil
		}
		if statErr != nil {
			return "", "", statErr
		}
		if n > 10000 {
			return "", "", fmt.Errorf("artifact name collision: %s", abs)
		}
	}
}

func slug(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return ""
	}
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if ok {
			b.WriteRune(r)
			prevDash = false
			continue
		}
		if !prevDash {
			b.WriteByte('-')
			prevDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}
