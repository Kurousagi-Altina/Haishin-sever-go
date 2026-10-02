package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"unicode"
)

const (
	diceDefaultRoom = "默认"
	diceMaxRoomLen  = 24
	diceMaxLabelLen = 32
	diceMaxLimit    = 100
)

// POST /api/dice/roll — 投掷一次并广播给同房间所有人
func (h *Handler) HandleDiceRoll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Expression string `json:"expression"`
		Character  string `json:"character"`
		RollName   string `json:"roll_name"`
		Room       string `json:"room"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "invalid request body"})
		return
	}

	result, err := RollDice(req.Expression)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": err.Error()})
		return
	}

	info := getTokenInfo(r)
	character := sanitizeLabel(req.Character, diceMaxLabelLen)
	if character == "" {
		character = info.Username
	}
	if character == "" {
		character = "访客"
	}
	rollName := sanitizeLabel(req.RollName, diceMaxLabelLen)
	room := normalizeDiceRoom(req.Room)

	detail, err := json.Marshal(result)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "结果序列化失败"})
		return
	}

	roll, err := h.db.InsertDiceRoll(room, info.UserID, info.Username, character, rollName, result.Expression, string(detail), result.Total, result.Crit)
	if err != nil {
		log.Printf("[DICE] insert error: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "保存投掷记录失败"})
		return
	}

	ip := getClientIP(r)
	summary := result.Expression + " = " + strconv.Itoa(result.Total)
	if rollName != "" {
		summary = rollName + " " + summary
	}
	h.db.RecordAction(ip, info.Username, "dice_roll", character+" @"+room+" "+summary)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"roll":    roll,
	})
}

// GET /api/dice/rolls?room=&since=&limit= — 拉取房间内的投掷记录
// DELETE /api/dice/rolls?id= — 删除一条记录（自己的，或管理员任意一条）
func (h *Handler) HandleDiceRolls(w http.ResponseWriter, r *http.Request) {
	room := normalizeDiceRoom(r.URL.Query().Get("room"))

	switch r.Method {
	case http.MethodGet:
		since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit <= 0 || limit > diceMaxLimit {
			limit = 50
		}

		rolls, latest, err := h.db.ListDiceRolls(room, since, limit)
		if err != nil {
			log.Printf("[DICE] list error: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "读取投掷记录失败"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"rolls":     rolls,
			"latest_id": latest,
			"room":      room,
		})

	case http.MethodDelete:
		info := getTokenInfo(r)
		id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
		if err != nil || id <= 0 {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "记录 id 无效"})
			return
		}

		if err := h.db.DeleteDiceRoll(id, info.UserID, info.Role == "admin"); err != nil {
			writeJSON(w, http.StatusForbidden, map[string]interface{}{"error": err.Error()})
			return
		}
		h.db.RecordAction(getClientIP(r), info.Username, "dice_delete", "roll #"+strconv.FormatInt(id, 10)+" @"+room)
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})

	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

// POST /api/dice/clear — 清空房间记录（仅管理员）
func (h *Handler) HandleDiceClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	info := getTokenInfo(r)
	if info.Role != "admin" {
		writeJSON(w, http.StatusForbidden, map[string]interface{}{"error": "仅管理员可清空记录"})
		return
	}

	var req struct {
		Room string `json:"room"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "invalid request body"})
		return
	}
	room := normalizeDiceRoom(req.Room)

	deleted, err := h.db.ClearDiceRoom(room)
	if err != nil {
		log.Printf("[DICE] clear error: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "清空失败"})
		return
	}

	h.db.RecordAction(getClientIP(r), info.Username, "dice_clear", room+" 清空 "+strconv.FormatInt(deleted, 10)+" 条")
	log.Printf("[DICE] admin %s cleared room %q (%d rolls)", info.Username, room, deleted)
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "deleted": deleted})
}

// GET /api/dice/rooms — 最近活跃的房间列表
func (h *Handler) HandleDiceRooms(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	rooms, err := h.db.ListDiceRooms()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "读取房间列表失败"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"rooms": rooms})
}

// GET|POST|DELETE /api/dice/presets — 骰子组合预设
func (h *Handler) HandleDicePresets(w http.ResponseWriter, r *http.Request) {
	info := getTokenInfo(r)
	if info.UserID == 0 {
		writeJSON(w, http.StatusForbidden, map[string]interface{}{"error": "访客无法保存预设，请登录后使用"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		presets, err := h.db.ListDicePresets(info.UserID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "读取预设失败"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"presets": presets})

	case http.MethodPost:
		var req struct {
			Name       string `json:"name"`
			Expression string `json:"expression"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "invalid request body"})
			return
		}

		name := sanitizeLabel(req.Name, diceMaxLabelLen)
		if name == "" {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "请填写预设名称"})
			return
		}

		expression := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(req.Expression), " ", ""))
		if err := ValidateExpression(expression); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": err.Error()})
			return
		}

		preset, err := h.db.SaveDicePreset(info.UserID, info.Username, name, expression)
		if err != nil {
			log.Printf("[DICE] save preset error: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "保存预设失败"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "preset": preset})

	case http.MethodDelete:
		id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
		if err != nil || id <= 0 {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "预设 id 无效"})
			return
		}
		if err := h.db.DeleteDicePreset(info.UserID, id); err != nil {
			writeJSON(w, http.StatusNotFound, map[string]interface{}{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})

	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

// normalizeDiceRoom 归一化房间名，空值落到默认房间。
func normalizeDiceRoom(room string) string {
	room = sanitizeLabel(room, diceMaxRoomLen)
	if room == "" {
		return diceDefaultRoom
	}
	return room
}

// sanitizeLabel 去掉控制字符、折叠空白并截断到 max 个字符。
func sanitizeLabel(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")

	if runes := []rune(s); len(runes) > max {
		s = string(runes[:max])
	}
	return s
}
