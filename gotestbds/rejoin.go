package gotestbds

// Rejoin reruns the test.
func (h *TestingHandler) Rejoin() error {
	h.cfg.rejoin = true
	return h.b.Close()
}
