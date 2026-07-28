package main

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/restartfu/gophig"
)

// Config controls how the runner connects bots to a server.
type Config struct {
	// LogLevel is one of debug, info, warn or error.
	LogLevel string
	Network  struct {
		// ServerAddress is the host:port the bots dial. Point this at the
		// Bedrock server directly rather than at a proxy that terminates Xbox
		// authentication: bots have no Xbox identity.
		ServerAddress string
	}
	Bots struct {
		// Name is the display name of the first bot. Additional bots append
		// their index, e.g. TestBot, TestBot2, TestBot3.
		//
		// The addon finds its bots by name, so this has to match whatever the
		// test suite expects.
		Name string
		// Count is how many bots to connect. Suites that exercise trading,
		// battling or any other two-player feature need more than one.
		Count int
	}
	// Viewer configures the optional state-export HTTP server. Disabled by
	// default so a run behaves identically whether or not anyone is watching.
	Viewer struct {
		Enabled       bool
		Address       string
		Radius        int
		SectionRadius int
		// ColumnBudget caps columns per stream frame; leftover columns arrive
		// on later deltas as columnsAdded. Default 4 (~few hundred KB/frame).
		ColumnBudget int
		ArtifactDir  string
		AppDir       string
		// CacheDir holds the gitignored pack/baseline cache. Empty defaults to
		// <ArtifactDir>/.cache so artefacts and packs share one root.
		CacheDir string
		// BaselineTag pins Mojang/bedrock-samples (e.g. v1.26.30.5).
		BaselineTag string
		// AcceptServerPacks downloads the server's resource pack stack when
		// the viewer is enabled. Ignored when the viewer is off.
		AcceptServerPacks bool
		// Offline refuses network fetches; only the existing cache is used.
		Offline bool
		// MemoryPerformanceTier selects resource-pack subpacks (1–5). Default 5.
		MemoryPerformanceTier int
	}
}

// DefaultConfig returns the configuration used when no config file or flag is
// supplied.
func DefaultConfig() Config {
	c := Config{}
	c.LogLevel = "info"
	c.Network.ServerAddress = "127.0.0.1:19132"
	c.Bots.Name = "TestBot"
	c.Bots.Count = 1
	c.Viewer.Enabled = false
	c.Viewer.Address = "127.0.0.1:24680"
	c.Viewer.Radius = 4
	c.Viewer.SectionRadius = 4
	c.Viewer.ColumnBudget = 4
	c.Viewer.ArtifactDir = "artifacts"
	c.Viewer.AppDir = ""
	c.Viewer.CacheDir = ""
	c.Viewer.BaselineTag = "v1.26.30.5"
	c.Viewer.AcceptServerPacks = true
	c.Viewer.Offline = false
	c.Viewer.MemoryPerformanceTier = 5
	return c
}

// ReadConfig resolves the runner's configuration.
//
// Sources are applied in increasing order of precedence: the defaults, then
// config.toml (created with the defaults when absent), then GOTESTBDS_*
// environment variables, then command line flags. CI passes flags; a developer
// running locally gets the config file.
//
// @returns the resolved configuration.
// @throws an error if config.toml exists but cannot be read or written.
func ReadConfig() (Config, error) {
	g := gophig.NewGophig[Config]("./config.toml", gophig.TOMLMarshaler{}, os.ModePerm)
	c, err := g.LoadConf()
	if os.IsNotExist(err) {
		c = DefaultConfig()
		if err = g.SaveConf(c); err != nil {
			return Config{}, err
		}
	} else if err != nil {
		return Config{}, err
	}

	// A config file written by an older version leaves these zeroed.
	def := DefaultConfig()
	if c.Bots.Name == "" {
		c.Bots.Name = def.Bots.Name
	}
	if c.Bots.Count <= 0 {
		c.Bots.Count = 1
	}
	if c.Viewer.Address == "" {
		c.Viewer.Address = def.Viewer.Address
	}
	if c.Viewer.Radius <= 0 {
		c.Viewer.Radius = def.Viewer.Radius
	}
	if c.Viewer.SectionRadius <= 0 {
		c.Viewer.SectionRadius = def.Viewer.SectionRadius
	}
	if c.Viewer.ColumnBudget <= 0 {
		c.Viewer.ColumnBudget = def.Viewer.ColumnBudget
	}
	if c.Viewer.ArtifactDir == "" {
		c.Viewer.ArtifactDir = def.Viewer.ArtifactDir
	}
	// Older config.toml files omit the stage-5 fields. A missing bool is
	// indistinguishable from false, so treat "all asset knobs zeroed" as
	// absent and apply DefaultConfig for AcceptServerPacks.
	assetsFieldsAbsent := c.Viewer.CacheDir == "" && c.Viewer.BaselineTag == "" && c.Viewer.MemoryPerformanceTier <= 0
	if c.Viewer.BaselineTag == "" {
		c.Viewer.BaselineTag = def.Viewer.BaselineTag
	}
	if c.Viewer.MemoryPerformanceTier <= 0 {
		c.Viewer.MemoryPerformanceTier = def.Viewer.MemoryPerformanceTier
	}
	if assetsFieldsAbsent {
		c.Viewer.AcceptServerPacks = def.Viewer.AcceptServerPacks
	}

	applyEnv(&c)
	if err := applyFlags(&c); err != nil {
		return Config{}, err
	}
	return c, nil
}

// applyEnv overlays GOTESTBDS_* environment variables onto a configuration.
//
// @param c The configuration to modify in place.
func applyEnv(c *Config) {
	if v := os.Getenv("GOTESTBDS_ADDRESS"); v != "" {
		c.Network.ServerAddress = v
	}
	if v := os.Getenv("GOTESTBDS_BOT_NAME"); v != "" {
		c.Bots.Name = v
	}
	if v := os.Getenv("GOTESTBDS_LOG_LEVEL"); v != "" {
		c.LogLevel = v
	}
	if v := os.Getenv("GOTESTBDS_BOTS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.Bots.Count = n
		}
	}
	if v := os.Getenv("GOTESTBDS_VIEWER"); v != "" {
		// "1"/"true" enables on the default address; host:port enables and sets it.
		switch strings.ToLower(v) {
		case "1", "true", "yes", "on":
			c.Viewer.Enabled = true
		case "0", "false", "no", "off":
			c.Viewer.Enabled = false
		default:
			c.Viewer.Enabled = true
			c.Viewer.Address = v
		}
	}
	if v := os.Getenv("GOTESTBDS_VIEWER_ADDRESS"); v != "" {
		c.Viewer.Address = v
	}
	if v := os.Getenv("GOTESTBDS_VIEWER_RADIUS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.Viewer.Radius = n
		}
	}
	if v := os.Getenv("GOTESTBDS_VIEWER_SECTION_RADIUS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.Viewer.SectionRadius = n
		}
	}
	if v := os.Getenv("GOTESTBDS_VIEWER_COLUMN_BUDGET"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.Viewer.ColumnBudget = n
		}
	}
	if v := os.Getenv("GOTESTBDS_VIEWER_ARTIFACTS"); v != "" {
		c.Viewer.ArtifactDir = v
	}
	if v := os.Getenv("GOTESTBDS_VIEWER_APP"); v != "" {
		c.Viewer.AppDir = v
	}
	if v := os.Getenv("GOTESTBDS_VIEWER_CACHE"); v != "" {
		c.Viewer.CacheDir = v
	}
	if v := os.Getenv("GOTESTBDS_VIEWER_BASELINE"); v != "" {
		c.Viewer.BaselineTag = v
	}
	if v := os.Getenv("GOTESTBDS_VIEWER_PACKS"); v != "" {
		switch strings.ToLower(v) {
		case "1", "true", "yes", "on":
			c.Viewer.AcceptServerPacks = true
		case "0", "false", "no", "off":
			c.Viewer.AcceptServerPacks = false
		}
	}
	if v := os.Getenv("GOTESTBDS_VIEWER_OFFLINE"); v != "" {
		switch strings.ToLower(v) {
		case "1", "true", "yes", "on":
			c.Viewer.Offline = true
		case "0", "false", "no", "off":
			c.Viewer.Offline = false
		}
	}
	if v := os.Getenv("GOTESTBDS_VIEWER_MEMORY_TIER"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.Viewer.MemoryPerformanceTier = n
		}
	}
}

// applyFlags overlays command line flags onto a configuration.
//
// @param c The configuration to modify in place. Its current values become the
// flag defaults, so an unspecified flag changes nothing.
// @returns an error if the flags could not be parsed or are invalid.
func applyFlags(c *Config) error {
	set := flag.NewFlagSet(os.Args[0], flag.ContinueOnError)
	address := set.String("address", c.Network.ServerAddress, "host:port of the Bedrock server to dial")
	name := set.String("name", c.Bots.Name, "display name of the first bot")
	count := set.Int("bots", c.Bots.Count, "number of bots to connect")
	logLevel := set.String("log-level", c.LogLevel, "debug, info, warn or error")
	viewer := set.Bool("viewer", c.Viewer.Enabled, "enable the viewer state-export HTTP server")
	viewerAddress := set.String("viewer-address", c.Viewer.Address, "host:port for the viewer HTTP server")
	viewerRadius := set.Int("viewer-radius", c.Viewer.Radius, "column radius carried by the viewer stream")
	viewerSectionRadius := set.Int("viewer-section-radius", c.Viewer.SectionRadius, "vertical section window (±N) around the actor")
	viewerColumnBudget := set.Int("viewer-column-budget", c.Viewer.ColumnBudget, "max columns per viewer stream frame")
	viewerArtifacts := set.String("viewer-artifacts", c.Viewer.ArtifactDir, "directory for viewer artefacts")
	viewerApp := set.String("viewer-app", c.Viewer.AppDir, "optional built viewer app directory to serve at /")
	viewerCache := set.String("viewer-cache", c.Viewer.CacheDir, "gitignored cache for vanilla baseline and server packs")
	viewerBaseline := set.String("viewer-baseline", c.Viewer.BaselineTag, "pinned Mojang/bedrock-samples tag")
	viewerPacks := set.Bool("viewer-packs", c.Viewer.AcceptServerPacks, "download server resource packs when the viewer is enabled")
	viewerOffline := set.Bool("viewer-offline", c.Viewer.Offline, "use only the existing pack cache; never fetch")
	viewerMemoryTier := set.Int("viewer-memory-tier", c.Viewer.MemoryPerformanceTier, "memory_performance_tier for subpack selection (1-5)")

	if err := set.Parse(os.Args[1:]); err != nil {
		return err
	}
	if *count <= 0 {
		return fmt.Errorf("bots must be at least 1, got %d", *count)
	}
	if *address == "" {
		return fmt.Errorf("address must not be empty")
	}

	c.Network.ServerAddress = *address
	c.Bots.Name = *name
	c.Bots.Count = *count
	c.LogLevel = *logLevel
	c.Viewer.Enabled = *viewer
	c.Viewer.Address = *viewerAddress
	c.Viewer.Radius = *viewerRadius
	c.Viewer.SectionRadius = *viewerSectionRadius
	c.Viewer.ColumnBudget = *viewerColumnBudget
	c.Viewer.ArtifactDir = *viewerArtifacts
	c.Viewer.AppDir = *viewerApp
	c.Viewer.CacheDir = *viewerCache
	c.Viewer.BaselineTag = *viewerBaseline
	c.Viewer.AcceptServerPacks = *viewerPacks
	c.Viewer.Offline = *viewerOffline
	c.Viewer.MemoryPerformanceTier = *viewerMemoryTier
	return nil
}

// BotName returns the display name for the bot at a zero-based index.
//
// @param index Zero-based bot index.
// @returns the first bot's configured name for index 0, and that name suffixed
// with the one-based index for the rest.
func (c Config) BotName(index int) string {
	if index == 0 {
		return c.Bots.Name
	}
	return fmt.Sprintf("%s%d", c.Bots.Name, index+1)
}
