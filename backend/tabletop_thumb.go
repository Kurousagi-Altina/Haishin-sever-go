package main

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// 资产库缩略图：浏览器把图片缩到 ≤ 320 像素（WebP / PNG / JPEG）上传，存在 assets/thumbs/<资产 id>。
// 资产 id 是内容哈希，缩略图各房间通用；只有 GM 或上传者能传，已经有了就不覆盖（防止被人换成别的图）。
// 服务器不解码大图（6720×11060 的地图解码要一百多 MB 内存）。

const ttMaxThumbSize = 512 << 10

func (t *Tabletop) thumbPath(id string) string {
	return filepath.Join(t.assetsDir, "thumbs", id)
}

// POST /api/tabletop/thumb?room=xxx&id=<资产 id>  (multipart file)
func (t *Tabletop) HandleThumb(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	info := getTokenInfo(r)
	room := t.getRoom(r.URL.Query().Get("room"))
	id := r.URL.Query().Get("id")
	if room == nil || !ttAssetRe.MatchString(id) {
		writeJSON(w, http.StatusNotFound, map[string]interface{}{"error": "资产不存在"})
		return
	}
	u, nerr := t.guestUser(info, ttRequestToken(r), r.URL.Query().Get("name"))
	if nerr != nil {
		writeJSON(w, http.StatusConflict, map[string]interface{}{"error": nerr.Error()})
		return
	}
	room.mu.Lock()
	allowed := false
	for _, a := range room.Assets {
		if a.ID == id && (a.By == u.name || room.isGM(u)) {
			allowed = true
			break
		}
	}
	room.mu.Unlock()
	if !allowed {
		writeJSON(w, http.StatusForbidden, map[string]interface{}{"error": "无权上传缩略图"})
		return
	}
	path := t.thumbPath(id)
	if _, err := os.Stat(path); err == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "exists": true})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, ttMaxThumbSize+(64<<10))
	file, _, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "缩略图无效或太大"})
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, ttMaxThumbSize+1))
	if err != nil || len(data) > ttMaxThumbSize {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "缩略图无效或太大"})
		return
	}
	if _, ok := ttImageExt[http.DetectContentType(data)]; !ok {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "缩略图格式不支持"})
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "保存失败"})
		return
	}
	if err := writeFileAtomic(path, data); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "保存失败"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

// serveThumb: GET /tabletop-assets/thumb/<资产 id>（HandleAsset 里转过来，已校验 token）；没有就 404，前端退回原图
func (t *Tabletop) serveThumb(w http.ResponseWriter, r *http.Request, rest string) {
	id := strings.TrimPrefix(rest, "thumb/")
	if !ttAssetRe.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	data, err := os.ReadFile(t.thumbPath(id))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", http.DetectContentType(data))
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Write(data)
}
