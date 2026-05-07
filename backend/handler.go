package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

type Handler struct {
	cfg *Config
	db  *DB
	zlm *ZLMClient
	tm  *TokenManager
}

func NewHandler(cfg *Config, db *DB, zlm *ZLMClient, tm *TokenManager) *Handler {
	return &Handler{cfg: cfg, db: db, zlm: zlm, tm: tm}
}

// POST /api/verify — door password verification
func (h *Handler) HandleVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"error": "invalid request body",
		})
		return
	}

	ip := getClientIP(r)
	success := req.Password == h.cfg.AdminPassword
	h.db.RecordAuthAttempt(ip, req.Password, success)

	if !success {
		log.Printf("[AUTH] failed door attempt from %s", ip)
		writeJSON(w, http.StatusUnauthorized, map[string]interface{}{
			"success": false,
			"error":   "口令错误",
		})
		return
	}

	token := h.tm.Generate()
	log.Printf("[AUTH] door access granted from %s", ip)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"token":   token,
		"role":    "door",
	})
}

// POST /api/register — user registration (pending approval)
func (h *Handler) HandleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "invalid request body"})
		return
	}

	req.Username = strings.TrimSpace(req.Username)
	if len(req.Username) < 2 || len(req.Username) > 32 {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "用户名需在2-32个字符之间"})
		return
	}
	if len(req.Password) < 6 {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "密码至少需要6个字符"})
		return
	}

	id, err := h.db.CreateUser(req.Username, req.Password)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]interface{}{"error": "用户名已存在"})
		return
	}

	log.Printf("[REGISTER] new user: %s (id=%d), pending approval", req.Username, id)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "注册申请已提交，请等待管理员审核通过",
	})
}

// POST /api/login — user login
func (h *Handler) HandleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "invalid request body"})
		return
	}

	ip := getClientIP(r)
	h.db.RecordAuthAttempt(ip, req.Username, false)

	user, err := h.db.VerifyUserPassword(req.Username, req.Password)
	if err != nil {
		if err == sql.ErrNoRows {
			writeJSON(w, http.StatusUnauthorized, map[string]interface{}{"success": false, "error": "账号未审核通过或用户名密码错误"})
		} else {
			writeJSON(w, http.StatusUnauthorized, map[string]interface{}{"success": false, "error": "用户名或密码错误"})
		}
		return
	}

	// Update auth attempt to success
	// (we use a separate dedicated insert for login success on verify path)

	userID := user["id"].(int64)
	username := user["username"].(string)
	role := user["role"].(string)

	token := h.tm.GenerateUser(userID, username, role)
	log.Printf("[LOGIN] user %s (%s) logged in from %s", username, role, ip)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"token":    token,
		"username": username,
		"role":     role,
	})
}

// GET /api/me — get current user info from token
func (h *Handler) HandleMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	info := getTokenInfo(r)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"user_id":  info.UserID,
		"username": info.Username,
		"role":     info.Role,
	})
}

// GET /api/streams
func (h *Handler) HandleStreams(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	streams, err := h.zlm.GetMediaList()
	if err != nil {
		log.Printf("[STREAMS] error: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]interface{}{
			"code":  -1,
				"error": "获取直播列表失败: " + err.Error(),
		})
		return
	}

	filtered := make([]map[string]interface{}, 0)
	seen := make(map[string]bool)
	for _, s := range streams {
		if s.Schema != "rtmp" {
			continue
		}
		key := s.App + "/" + s.Stream
		if seen[key] {
			continue
		}
		seen[key] = true
		filtered = append(filtered, map[string]interface{}{
			"app":              s.App,
			"stream":           s.Stream,
			"totalReaderCount": s.TotalReaderCount,
		})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"code":    0,
		"streams": filtered,
	})
}

// GET /api/stream-url
func (h *Handler) HandleStreamURL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	app := r.URL.Query().Get("app")
	stream := r.URL.Query().Get("stream")
	if app == "" || stream == "" {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"error": "missing app or stream parameter",
		})
		return
	}

	ip := getClientIP(r)
	h.db.RecordStreamView(ip, app, stream)

	url := h.cfg.ZLMBaseURL + "/" + app + "/" + stream + ".live.flv"
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"url": url,
	})
}

// GET /api/stats
func (h *Handler) HandleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	stats, err := h.db.VisitorStats()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"error": "获取统计数据失败",
		})
		return
	}

	writeJSON(w, http.StatusOK, stats)
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
