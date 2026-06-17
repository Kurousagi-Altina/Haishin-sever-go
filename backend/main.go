package main

import (
	"log"
	"net/http"
	"os"
)

func main() {
	cfg := LoadConfig()

	db, err := NewDB(cfg.DBPath)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer db.Close()
	log.Printf("[DB] SQLite connected: %s", cfg.DBPath)

	zlm := NewZLMClient(cfg.ZLMBaseURL, cfg.ZLMSecret)
	tm := NewTokenManager(cfg.TokenExpiryDuration())

	handler := NewHandler(cfg, db, zlm, tm)

	// Ensure download directory exists
	if err := os.MkdirAll(cfg.DownloadDir, 0755); err != nil {
		log.Fatalf("Failed to create download directory %s: %v", cfg.DownloadDir, err)
	}

	// Ensure video directory exists
	if err := os.MkdirAll(cfg.VideoDir, 0755); err != nil {
		log.Fatalf("Failed to create video directory %s: %v", cfg.VideoDir, err)
	}

	mux := http.NewServeMux()

	// Public routes
	mux.HandleFunc("/api/verify", handler.HandleVerify)
	mux.HandleFunc("/api/register", handler.HandleRegister)
	mux.HandleFunc("/api/login", handler.HandleLogin)

	// Protected routes (any valid token)
	protected := http.NewServeMux()
	protected.HandleFunc("/api/me", handler.HandleMe)
	protected.HandleFunc("/api/streams", handler.HandleStreams)
	protected.HandleFunc("/api/stream-url", handler.HandleStreamURL)
	protected.HandleFunc("/api/cloud/list", handler.HandleCloudList)
	protected.HandleFunc("/api/cloud/upload", handler.HandleCloudUpload)
	protected.HandleFunc("/api/cloud/mkdir", handler.HandleCloudMkdir)
	protected.HandleFunc("/api/cloud/delete", handler.HandleCloudDelete)
	protected.HandleFunc("/api/cloud/move", handler.HandleCloudMove)
	protected.HandleFunc("/api/cloud/space", handler.HandleCloudSpace)
	protected.HandleFunc("/api/vod/list", handler.HandleVodList)
	protected.HandleFunc("/api/vod/play", handler.HandleVodPlay)

	mux.Handle("/api/me", AuthMiddleware(tm)(protected))
	mux.Handle("/api/streams", AuthMiddleware(tm)(protected))
	mux.Handle("/api/stream-url", AuthMiddleware(tm)(protected))
	mux.Handle("/api/cloud/list", AuthMiddleware(tm)(protected))
	mux.HandleFunc("/api/cloud/download", handler.HandleCloudDownload)
	mux.Handle("/api/cloud/upload", AuthMiddleware(tm)(protected))
	mux.Handle("/api/cloud/mkdir", AuthMiddleware(tm)(protected))
	mux.Handle("/api/cloud/delete", AuthMiddleware(tm)(protected))
	mux.Handle("/api/cloud/move", AuthMiddleware(tm)(protected))
	mux.Handle("/api/cloud/space", AuthMiddleware(tm)(protected))
	mux.Handle("/api/vod/list", AuthMiddleware(tm)(protected))
	mux.Handle("/api/vod/play", AuthMiddleware(tm)(protected))

	// Admin routes (admin token required)
	admin := http.NewServeMux()
	admin.HandleFunc("/api/admin/stats", handler.HandleAdminStats)
	admin.HandleFunc("/api/admin/visitors", handler.HandleAdminVisitors)
	admin.HandleFunc("/api/admin/auth-attempts", handler.HandleAdminAuthAttempts)
	admin.HandleFunc("/api/admin/stream-views", handler.HandleAdminStreamViews)
	admin.HandleFunc("/api/admin/users", handler.HandleAdminUsers)
	admin.HandleFunc("/api/admin/pending-users", handler.HandleAdminPendingUsers)
	admin.HandleFunc("/api/admin/approve-user", handler.HandleAdminApproveUser)
	admin.HandleFunc("/api/admin/reject-user", handler.HandleAdminRejectUser)
	admin.HandleFunc("/api/admin/users/", handler.HandleAdminDeleteUser)
	admin.HandleFunc("/api/admin/change-password", handler.HandleAdminChangePassword)

	// admin = AuthMiddleware + AdminMiddleware
	adminStack := AuthMiddleware(tm)(AdminMiddleware(admin))
	mux.Handle("/api/admin/", adminStack)

	// Game (WASM) — COOP/COEP headers scoped to this sub-route only
	// Games are organized as subdirectories under GameDir (e.g. game/doom/, game/quake/).
	// Access via /game/<name>/ — adding a new game just means creating its subdirectory.
	gameFS := http.FileServer(http.Dir(cfg.GameDir))
	mux.Handle("/game/", http.StripPrefix("/game/", gameHeaders(gameFS)))

	// Static video files (direct MP4 serving)
	videoFS := http.FileServer(http.Dir(cfg.VideoDir))
	mux.Handle("/videos/", http.StripPrefix("/videos/", videoFS))

	// Static files (frontend)
	fs := http.FileServer(http.Dir(cfg.StaticDir))
	mux.Handle("/", fs)

	// Apply global middleware
	var app http.Handler = mux
	app = enableCORS(app)
	app = loggingMiddleware(app)

	log.Printf("[SERVER] starting on %s", cfg.ServerAddr)
	log.Printf("[SERVER] ZLM upstream: %s", cfg.ZLMBaseURL)
	if err := http.ListenAndServe(cfg.ServerAddr, app); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
