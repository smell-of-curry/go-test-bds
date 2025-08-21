package main

import (
	"os"

	"github.com/restartfu/gophig"
)

// Config ...
type Config struct {
	LogLevel string
	Network  struct {
		ServerAddress string
	}
}

// DefaultConfig ...
func DefaultConfig() Config {
	c := Config{}

	c.LogLevel = "debug"
	c.Network.ServerAddress = "127.0.0.1:19132"

	return c
}

// ReadConfig ...
func ReadConfig() (Config, error) {
	g := gophig.NewGophig[Config]("./config.toml", gophig.TOMLMarshaler{}, os.ModePerm)
	_, err := g.LoadConf()
	if os.IsNotExist(err) {
		err = g.SaveConf(DefaultConfig())
		if err != nil {
			return Config{}, err
		}
	}
	c, err := g.LoadConf()
	return c, err
}
