package main

import (
	"os"
	"testing"
)

func TestItemInteractionTransportConfiguration(t *testing.T) {
	old := os.Args
	t.Cleanup(func() { os.Args = old })
	for _, tc := range []struct {
		name, configured, env, flag, want string
	}{
		{"old config", "", "", "", "auth-input"},
		{"config", "inventory-transaction", "", "", "inventory-transaction"},
		{"environment", "auth-input", "inventory-transaction", "", "inventory-transaction"},
		{"flag wins", "inventory-transaction", "inventory-transaction", "auth-input", "auth-input"},
		{"legacy flag", "auth-input", "", "inventory-transaction", "inventory-transaction"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := DefaultConfig()
			if c.Network.ItemInteractionTransport != "auth-input" {
				t.Fatal("default transport is not auth-input")
			}
			c.Network.ItemInteractionTransport = tc.configured
			t.Setenv("GOTESTBDS_ITEM_INTERACTION_TRANSPORT", tc.env)
			applyEnv(&c)
			os.Args = []string{"gotestbds"}
			if tc.flag != "" {
				os.Args = append(os.Args, "--item-interaction-transport", tc.flag)
			}
			if err := applyFlags(&c); err != nil {
				t.Fatal(err)
			}
			if c.Network.ItemInteractionTransport != tc.want {
				t.Fatalf("transport = %q, want %q", c.Network.ItemInteractionTransport, tc.want)
			}
		})
	}
}

func TestItemInteractionTransportRejectsInvalidConfiguration(t *testing.T) {
	old := os.Args
	t.Cleanup(func() { os.Args = old })
	for _, source := range []string{"config", "environment", "flag"} {
		t.Run(source, func(t *testing.T) {
			c := DefaultConfig()
			os.Args = []string{"gotestbds"}
			switch source {
			case "config":
				c.Network.ItemInteractionTransport = "auto"
			case "environment":
				t.Setenv("GOTESTBDS_ITEM_INTERACTION_TRANSPORT", "auto")
				applyEnv(&c)
			case "flag":
				os.Args = append(os.Args, "--item-interaction-transport", "auto")
			}
			if err := applyFlags(&c); err == nil {
				t.Fatal("accepted unsupported automatic transport selection")
			}
		})
	}
}
