package main

import (
	"encoding/json"
	"log"
	"os"
	"strconv"
	"time"
)

type Config struct {
	ServerAddr    string `json:"server_addr"`
	ZLMBaseURL    string `json:"zlm_base_url"`
	ZLMSecret     string `json:"zlm_secret"`
	AdminPassword string `json:"admin_password"`
	DBPath        string `json:"db_path"`
	StaticDir     string `json:"static_dir"`
	TokenExpiry   string `json:"token_expiry"` // stored as string for JSON friendliness
	DownloadDir   string `json:"download_dir"`
	GameDir       string `json:"game_dir"`
	VideoDir      string `json:"video_dir"`
}

func (c *Config) TokenExpiryDuration() time.Duration {
	d, err := time.ParseDuration(c.TokenExpiry)
	if err != nil {
		// try as seconds (e.g. "259200")
		if secs, e2 := strconv.ParseInt(c.TokenExpiry, 10, 64); e2 == nil {
			return time.Duration(secs) * time.Second
		}
		return 72 * time.Hour
	}
	return d
}

func LoadConfig() *Config {
	cfg := &Config{
		ServerAddr:    ":80",
		ZLMBaseURL:    "http://47.96.99.181:8080",
		ZLMSecret:     "035c73f7-bb6b-4889-a715-d9eb2d1925cc",
		AdminPassword: "114514",
		DBPath:        "./data.db",
		StaticDir:     "../www",
		TokenExpiry:   "72h",
		DownloadDir:   "../userdata/download",
		GameDir:       "../game",
		VideoDir:      "../userdata/videos",
	}

	// 1. Load from config.json, or create it on first run
	if f, err := os.Open("config.json"); err == nil {
		defer f.Close()
		if err := json.NewDecoder(f).Decode(cfg); err != nil {
			log.Printf("[CONFIG] failed to parse config.json: %v, using defaults", err)
		} else {
			log.Printf("[CONFIG] loaded config.json")
		}
	} else {
		// config.json not found — create one with defaults
		if f, err := os.Create("config.json"); err == nil {
			enc := json.NewEncoder(f)
			enc.SetIndent("", "  ")
			enc.Encode(cfg)
			f.Close()
			log.Printf("[CONFIG] created config.json with defaults")
		} else {
			log.Printf("[CONFIG] could not create config.json: %v", err)
		}
	}

	// 2. Environment variables override config file values
	if v := os.Getenv("SERVER_ADDR"); v != "" {
		cfg.ServerAddr = v
	}
	if v := os.Getenv("ZLM_BASE_URL"); v != "" {
		cfg.ZLMBaseURL = v
	}
	if v := os.Getenv("ZLM_SECRET"); v != "" {
		cfg.ZLMSecret = v
	}
	if v := os.Getenv("ADMIN_PASSWORD"); v != "" {
		cfg.AdminPassword = v
	}
	if v := os.Getenv("DB_PATH"); v != "" {
		cfg.DBPath = v
	}
	if v := os.Getenv("STATIC_DIR"); v != "" {
		cfg.StaticDir = v
	}
	if v := os.Getenv("TOKEN_EXPIRY"); v != "" {
		cfg.TokenExpiry = v
	}
	if v := os.Getenv("DOWNLOAD_DIR"); v != "" {
		cfg.DownloadDir = v
	}
	if v := os.Getenv("GAME_DIR"); v != "" {
		cfg.GameDir = v
	}
	if v := os.Getenv("VIDEO_DIR"); v != "" {
		cfg.VideoDir = v
	}

	return cfg
}
