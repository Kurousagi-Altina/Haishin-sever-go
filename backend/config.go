package main

import (
	"os"
	"time"
)

type Config struct {
	ServerAddr    string
	ZLMBaseURL    string
	ZLMSecret     string
	AdminPassword string
	DBPath        string
	StaticDir     string
	TokenExpiry   time.Duration
	DownloadDir   string
}

func LoadConfig() *Config {
	return &Config{
		ServerAddr:    getEnv("SERVER_ADDR", ":80"),
		ZLMBaseURL:    getEnv("ZLM_BASE_URL", "http://47.97.153.51"),
		ZLMSecret:     getEnv("ZLM_SECRET", "AQzyGOxCEtDHpCRVSh40UJWvNVLtqjU4"),
		AdminPassword: getEnv("ADMIN_PASSWORD", "114514"),
		DBPath:        getEnv("DB_PATH", "./data.db"),
		StaticDir:     getEnv("STATIC_DIR", "./www"),
		TokenExpiry:   getEnvDuration("TOKEN_EXPIRY", 72*time.Hour),
		DownloadDir:   getEnv("DOWNLOAD_DIR", "./userdata/download"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvDuration(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return fallback
}
