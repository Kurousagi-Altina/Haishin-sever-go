package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
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
	h.db.RecordAction(ip, "", "verify", "door password " + map[bool]string{true: "success", false: "failed"}[success])

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
		if errors.Is(err, ErrUserExists) {
			writeJSON(w, http.StatusOK, map[string]interface{}{"success": false, "error": "用户名已存在"})
		} else {
			log.Printf("[REGISTER] error creating user %s: %v", req.Username, err)
			writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "注册失败，请稍后重试"})
		}
		return
	}

	ip := getClientIP(r)
	h.db.RecordAction(ip, req.Username, "register", "user registered, pending approval")
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
			h.db.RecordAction(ip, req.Username, "login", "failed: account pending or wrong credentials")
			writeJSON(w, http.StatusUnauthorized, map[string]interface{}{"success": false, "error": "账号未审核通过或用户名密码错误"})
		} else {
			h.db.RecordAction(ip, req.Username, "login", "failed: wrong password")
			writeJSON(w, http.StatusUnauthorized, map[string]interface{}{"success": false, "error": "用户名或密码错误"})
		}
		return
	}

	userID := user["id"].(int64)
	username := user["username"].(string)
	role := user["role"].(string)

	token := h.tm.GenerateUser(userID, username, role)
	h.db.RecordAuthAttempt(ip, req.Username, true)
	h.db.RecordAction(ip, username, "login", "user logged in")
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
	info := getTokenInfo(r)
	h.db.RecordStreamView(ip, app, stream)
	h.db.RecordAction(ip, info.Username, "watch_stream", app+"/"+stream)

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

// GET /api/cloud/list
func (h *Handler) HandleCloudList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	subPath := r.URL.Query().Get("path")
	targetDir, err := safeResolvePath(h.cfg.DownloadDir, subPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "路径无效"})
		return
	}

	entries, err := os.ReadDir(targetDir)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"error": "读取目录失败",
		})
		return
	}

	fileNames := make([]string, 0, len(entries))
	fileInfos := make([]os.FileInfo, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		fileNames = append(fileNames, entry.Name())
		fileInfos = append(fileInfos, info)
	}

	filePaths := make([]string, len(fileNames))
	for i, name := range fileNames {
		if subPath == "" {
			filePaths[i] = name
		} else {
			filePaths[i] = subPath + "/" + name
		}
	}
	uploaders := h.db.BatchGetUploaders(filePaths)

	files := make([]map[string]interface{}, 0, len(fileNames))
	for i, name := range fileNames {
		info := fileInfos[i]
		files = append(files, map[string]interface{}{
			"name":     name,
			"size":     info.Size(),
			"isDir":    info.IsDir(),
			"modTime":  info.ModTime().Format("2006-01-02 15:04:05"),
			"uploader": uploaders[filePaths[i]],
		})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"files": files,
		"path":  subPath,
	})
}

// GET /api/cloud/download?file=xxx&path=xxx&token=xxx
func (h *Handler) HandleCloudDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	// Validate auth: check query param token first, then Authorization header
	tokenStr := r.URL.Query().Get("token")
	if tokenStr == "" {
		if authHeader := r.Header.Get("Authorization"); authHeader != "" {
			var ok bool
			tokenStr, ok = strings.CutPrefix(authHeader, "Bearer ")
			if !ok {
				tokenStr = ""
			}
		}
	}
	tokenInfo, valid := h.tm.Validate(tokenStr)
	if !valid {
		http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
		return
	}

	filename := r.URL.Query().Get("file")
	if filename == "" {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "missing file parameter"})
		return
	}

	safeName := filepath.Base(filename)
	if safeName != filename || safeName == "." || safeName == "/" {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "invalid filename"})
		return
	}

	subPath := r.URL.Query().Get("path")
	targetDir, err := safeResolvePath(h.cfg.DownloadDir, subPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "路径无效"})
		return
	}

	filePath := filepath.Join(targetDir, safeName)
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		writeJSON(w, http.StatusNotFound, map[string]interface{}{"error": "file not found"})
		return
	}

	ip := getClientIP(r)
	h.db.RecordAction(ip, tokenInfo.Username, "download", safeName)

	if r.URL.Query().Get("preview") != "1" {
		w.Header().Set("Content-Disposition", `attachment; filename="`+safeName+`"`)
	}
	http.ServeFile(w, r, filePath)
}

// POST /api/cloud/upload?path=xxx
func (h *Handler) HandleCloudUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	info := getTokenInfo(r)
	if !roleAtLeast(info.Role, h.cfg.CloudUploadMinRole) {
		writeJSON(w, http.StatusForbidden, map[string]interface{}{"error": "无上传权限"})
		return
	}

	ip := getClientIP(r)

	if err := r.ParseMultipartForm(100 << 20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "文件过大或请求无效"})
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "未找到上传文件"})
		return
	}
	defer file.Close()

	safeName := filepath.Base(header.Filename)
	if safeName != header.Filename || safeName == "." || safeName == "/" {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "文件名无效"})
		return
	}

	subPath := r.URL.Query().Get("path")
	targetDir, err := safeResolvePath(h.cfg.DownloadDir, subPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "路径无效"})
		return
	}

	dstPath := filepath.Join(targetDir, safeName)
	dst, err := os.Create(dstPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "创建文件失败"})
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "写入文件失败"})
		return
	}

	fileKey := safeName
	if subPath != "" {
		fileKey = subPath + "/" + safeName
	}
	uploader := info.Username
	if info.Role == "door" || uploader == "" {
		uploader = "访客(" + ip + ")"
	}
	h.db.SetFileUploader(fileKey, uploader)
	h.db.RecordAction(ip, info.Username, "upload", safeName)

	log.Printf("[CLOUD] uploader=%s uploaded file: %s", uploader, safeName)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"filename": safeName,
	})
}

// POST /api/cloud/mkdir?path=xxx — admin only
func (h *Handler) HandleCloudMkdir(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	info := getTokenInfo(r)
	if info.Role != "admin" {
		writeJSON(w, http.StatusForbidden, map[string]interface{}{"error": "仅管理员可操作"})
		return
	}

	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "invalid request body"})
		return
	}

	safeName := filepath.Base(req.Name)
	if safeName != req.Name || safeName == "." || safeName == "/" || safeName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "文件夹名无效"})
		return
	}

	subPath := r.URL.Query().Get("path")
	targetDir, err := safeResolvePath(h.cfg.DownloadDir, subPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "路径无效"})
		return
	}

	dirPath := filepath.Join(targetDir, safeName)
	if err := os.Mkdir(dirPath, 0755); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "创建文件夹失败: " + err.Error()})
		return
	}

	log.Printf("[CLOUD] admin %s created directory: %s", info.Username, safeName)

	dirKey := safeName
	if subPath != "" {
		dirKey = subPath + "/" + safeName
	}
	h.db.SetFileUploader(dirKey, info.Username)

	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

// DELETE /api/cloud/delete?name=xxx&path=xxx — admin only
func (h *Handler) HandleCloudDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	info := getTokenInfo(r)
	if info.Role != "admin" {
		writeJSON(w, http.StatusForbidden, map[string]interface{}{"error": "仅管理员可操作"})
		return
	}

	name := r.URL.Query().Get("name")
	safeName := filepath.Base(name)
	if safeName != name || safeName == "." || safeName == "/" || safeName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "名称无效"})
		return
	}

	subPath := r.URL.Query().Get("path")
	targetDir, err := safeResolvePath(h.cfg.DownloadDir, subPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "路径无效"})
		return
	}

	targetPath := filepath.Join(targetDir, safeName)
	info_, err := os.Stat(targetPath)
	if os.IsNotExist(err) {
		writeJSON(w, http.StatusNotFound, map[string]interface{}{"error": "文件或文件夹不存在"})
		return
	}

	if info_.IsDir() {
		if err := os.RemoveAll(targetPath); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "删除文件夹失败"})
			return
		}
	} else {
		if err := os.Remove(targetPath); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "删除文件失败"})
			return
		}
	}

	log.Printf("[CLOUD] admin %s deleted: %s", info.Username, safeName)
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

// POST /api/cloud/move?path=xxx — admin only
func (h *Handler) HandleCloudMove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	info := getTokenInfo(r)
	if info.Role != "admin" {
		writeJSON(w, http.StatusForbidden, map[string]interface{}{"error": "仅管理员可操作"})
		return
	}

	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "invalid request body"})
		return
	}

	safeFrom := filepath.Base(req.From)
	safeTo := filepath.Base(req.To)
	if safeFrom != req.From || safeFrom == "." || safeFrom == "/" || safeFrom == "" {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "源文件名称无效"})
		return
	}
	if safeTo != req.To || safeTo == "." || safeTo == "/" || safeTo == "" {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "目标名称无效"})
		return
	}

	subPath := r.URL.Query().Get("path")
	targetDir, err := safeResolvePath(h.cfg.DownloadDir, subPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "路径无效"})
		return
	}

	fromPath := filepath.Join(targetDir, safeFrom)
	toPath := filepath.Join(targetDir, safeTo)

	if _, err := os.Stat(fromPath); os.IsNotExist(err) {
		writeJSON(w, http.StatusNotFound, map[string]interface{}{"error": "源文件不存在"})
		return
	}
	if _, err := os.Stat(toPath); err == nil {
		writeJSON(w, http.StatusConflict, map[string]interface{}{"error": "目标名称已存在"})
		return
	}

	if err := os.Rename(fromPath, toPath); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "移动/重命名失败"})
		return
	}

	fromKey := safeFrom
	toKey := safeTo
	if subPath != "" {
		fromKey = subPath + "/" + safeFrom
		toKey = subPath + "/" + safeTo
	}
	h.db.UpdateFilePath(fromKey, toKey, info.Username)

	log.Printf("[CLOUD] admin %s moved %s -> %s", info.Username, safeFrom, safeTo)
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

// GET /api/cloud/space
func (h *Handler) HandleCloudSpace(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	_, avail, err := getDiskSpace(h.cfg.DownloadDir)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "获取空间信息失败"})
		return
	}

	// 预留 4GB 系统空间，计算可用空间
	const reserved uint64 = 4 * 1024 * 1024 * 1024
	var free uint64
	if avail > reserved {
		free = avail - reserved
	}

	used, _ := dirSize(h.cfg.DownloadDir)

	// total = 实际占用 + 实际可用（云盘可用空间，非磁盘总大小）
	total := used + int64(free)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"total": total,
		"used":  used,
		"free":  int64(free),
	})
}

// GET /api/vod/list
func (h *Handler) HandleVodList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	entries, err := os.ReadDir(h.cfg.VideoDir)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "读取视频目录失败"})
		return
	}

	type vodFile struct {
		Name string `json:"name"`
		Size int64  `json:"size"`
	}
	files := make([]vodFile, 0)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		if ext == ".mp4" || ext == ".m4v" || ext == ".mp4v" || ext == ".f4v" || ext == ".3gp" || ext == ".3g2" || ext == ".mkv" || ext == ".avi" || ext == ".mov" || ext == ".webm" {
			info, err := e.Info()
			if err != nil {
				continue
			}
			files = append(files, vodFile{Name: e.Name(), Size: info.Size()})
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"files": files})
}

// GET /api/vod/play
func (h *Handler) HandleVodPlay(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	fileName := filepath.Base(r.URL.Query().Get("file"))
	if fileName == "" || fileName == "." || fileName == ".." {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "文件参数无效"})
		return
	}

	filePath := filepath.Join(h.cfg.VideoDir, fileName)
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		writeJSON(w, http.StatusNotFound, map[string]interface{}{"error": "视频文件不存在"})
		return
	}

	mp4URL := "/videos/" + fileName
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"url":  mp4URL,
		"name": fileName,
	})
}

var roleLevel = map[string]int{"door": 0, "user": 1, "admin": 2}

func roleAtLeast(role, minRole string) bool {
	return roleLevel[role] >= roleLevel[minRole]
}

func safeResolvePath(base, sub string) (string, error) {
	base = filepath.Clean(base)
	if sub == "" {
		return base, nil
	}
	resolved := filepath.Clean(filepath.Join(base, sub))
	sep := string(filepath.Separator)
	if !strings.HasPrefix(resolved, base+sep) && resolved != base {
		return "", errors.New("path traversal detected")
	}
	return resolved, nil
}

func dirSize(path string) (int64, error) {
	var size int64
	err := filepath.Walk(path, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			size += info.Size()
		}
		return nil
	})
	return size, err
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
