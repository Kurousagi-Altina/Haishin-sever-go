package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
)

// GET /api/admin/stats — admin stats (same as public, admin-only)
func (h *Handler) HandleAdminStats(w http.ResponseWriter, r *http.Request) {
	stats, err := h.db.VisitorStats()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "获取统计数据失败"})
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

// GET /api/admin/visitors — paginated action log (key actions)
func (h *Handler) HandleAdminVisitors(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	limit := 50
	offset := (page - 1) * limit

	actions, err := h.db.RecentActions(limit, offset)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "查询失败"})
		return
	}
	total := h.db.CountActions()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"data":  actions,
		"total": total,
		"page":  page,
	})
}

// GET /api/admin/auth-attempts — paginated auth attempt log
func (h *Handler) HandleAdminAuthAttempts(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	limit := 50
	offset := (page - 1) * limit

	attempts, err := h.db.RecentAuthAttempts(limit, offset)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "查询失败"})
		return
	}
	total := h.db.CountAuthAttempts()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"data":  attempts,
		"total": total,
		"page":  page,
	})
}

// GET /api/admin/stream-views — paginated stream view log
func (h *Handler) HandleAdminStreamViews(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	limit := 50
	offset := (page - 1) * limit

	views, err := h.db.RecentStreamViews(limit, offset)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "查询失败"})
		return
	}
	total := h.db.CountStreamViews()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"data":  views,
		"total": total,
		"page":  page,
	})
}

// GET /api/admin/users — list all users
func (h *Handler) HandleAdminUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.db.ListUsers()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "查询失败"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"users": users})
}

// GET /api/admin/pending-users — list pending registrations
func (h *Handler) HandleAdminPendingUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.db.ListPendingUsers()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "查询失败"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"users": users})
}

// POST /api/admin/approve-user — approve a pending user
func (h *Handler) HandleAdminApproveUser(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		UserID int64 `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "invalid request"})
		return
	}

	if err := h.db.ApproveUser(req.UserID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "审核失败"})
		return
	}
	log.Printf("[ADMIN] approved user id=%d", req.UserID)
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

// POST /api/admin/reject-user — reject (delete) a pending user
func (h *Handler) HandleAdminRejectUser(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		UserID int64 `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "invalid request"})
		return
	}

	if err := h.db.RejectUser(req.UserID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "操作失败"})
		return
	}
	log.Printf("[ADMIN] rejected user id=%d", req.UserID)
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

// DELETE /api/admin/users — delete a user
func (h *Handler) HandleAdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	userIDStr := strings.TrimPrefix(r.URL.Path, "/api/admin/users/")
	userID, err := strconv.ParseInt(userIDStr, 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "invalid user id"})
		return
	}

	if err := h.db.DeleteUser(userID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "删除失败"})
		return
	}
	log.Printf("[ADMIN] deleted user id=%d", userID)
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

// POST /api/admin/change-password — admin changes own password
func (h *Handler) HandleAdminChangePassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	info := getTokenInfo(r)

	var req struct {
		NewPassword string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "invalid request"})
		return
	}

	if len(req.NewPassword) < 6 {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "密码至少需要6个字符"})
		return
	}

	if err := h.db.ChangePassword(info.UserID, req.NewPassword); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "修改失败"})
		return
	}
	log.Printf("[ADMIN] user %s changed password", info.Username)
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}
