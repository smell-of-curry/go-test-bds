package control

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/smell-of-curry/go-test-bds/gotestbds"
)

// Server is the external instruction API. It is off unless started.
type Server struct {
	token string
	fleet *gotestbds.Fleet
	ln    net.Listener
	srv   *http.Server
	log   *slog.Logger
}

// New builds a server. token empty means no Authorization check.
// A non-empty token must match the Authorization header exactly (no Bearer prefix).
func New(token string, fleet *gotestbds.Fleet, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	s := &Server{token: token, fleet: fleet, log: log}
	s.srv = &http.Server{Handler: s.Handler()}
	return s
}

// Handler is the HTTP mux, for tests and for Start.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /bots", s.handleBots)
	mux.HandleFunc("POST /bots/{name}/instruction", s.handleInstruction)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// Start listens on addr and serves in the background.
func (s *Server) Start(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	s.ln = ln
	s.srv.Addr = addr
	go func() {
		if err := s.srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			s.log.Error("control http", "error", err)
		}
	}()
	s.log.Info("control listening", "address", ln.Addr().String())
	return nil
}

// Addr returns the bound address, or "" before Start.
func (s *Server) Addr() string {
	if s.ln == nil {
		return ""
	}
	return s.ln.Addr().String()
}

// Close stops the server.
func (s *Server) Close() error {
	if s.srv == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.srv.Shutdown(ctx)
}

func (s *Server) authorized(r *http.Request) bool {
	if s.token == "" {
		return true
	}
	got := r.Header.Get("Authorization")
	if len(got) != len(s.token) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1
}

func (s *Server) handleBots(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"bots": s.fleet.List()})
}

func (s *Server) handleInstruction(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": gotestbds.StatusError, "message": err.Error()})
		return
	}
	action, id, params, timeoutMs, err := splitInstruction(body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": gotestbds.StatusError, "message": err.Error()})
		return
	}
	res := s.fleet.Run(r.Context(), name, id, action, params, timeoutMs)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(res.Code)
	_, _ = w.Write(res.Body)
}

// splitInstruction reads {"name":"<instruction>", "timeoutMs":N, "id":"...", ...args}.
// name, timeoutMs and id are envelope fields and are not passed as parameters.
func splitInstruction(body []byte) (action, id string, params json.RawMessage, timeoutMs int, err error) {
	if len(strings.TrimSpace(string(body))) == 0 {
		return "", "", nil, 0, errMissingName
	}
	var raw map[string]json.RawMessage
	if err = json.Unmarshal(body, &raw); err != nil {
		return "", "", nil, 0, err
	}
	nameRaw, ok := raw["name"]
	if !ok {
		return "", "", nil, 0, errMissingName
	}
	if err = json.Unmarshal(nameRaw, &action); err != nil || action == "" {
		return "", "", nil, 0, errMissingName
	}
	delete(raw, "name")
	if t, ok := raw["timeoutMs"]; ok {
		_ = json.Unmarshal(t, &timeoutMs)
		delete(raw, "timeoutMs")
	}
	if rawID, ok := raw["id"]; ok {
		_ = json.Unmarshal(rawID, &id)
		delete(raw, "id")
	}
	if len(raw) == 0 {
		return action, id, json.RawMessage(`{}`), timeoutMs, nil
	}
	params, err = json.Marshal(raw)
	return action, id, params, timeoutMs, err
}

type missingNameError struct{}

func (missingNameError) Error() string { return "missing instruction name" }

var errMissingName missingNameError

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	_ = enc.Encode(v)
}
