package main

import (
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Proxy for the Chinese 5e reference "DND5e 不全书" (5echm.kagangtuya.top).
// The site sends no CORS headers, so the browser can't read its pages directly;
// the backend fetches them (fixed hosts only — never a user-supplied URL) and caches them.
// Parsing of monster / item stat blocks happens in the frontend (www/js/tabletop.js).

const (
	tt5eSiteBase  = "https://5echm.kagangtuya.top/"
	tt5eSearchAPI = "https://5echmsearch.kagangtuya.top/api/search"
	tt5eMaxPage   = 8 << 20
	tt5eCacheSize = 300
)

var tt5eClient = &http.Client{Timeout: 20 * time.Second}

type tt5eCache struct {
	mu    sync.Mutex
	data  map[string][]byte
	order []string
}

var tt5ePages = &tt5eCache{data: make(map[string][]byte)}

func (c *tt5eCache) get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.data[key]
	return v, ok
}

func (c *tt5eCache) put(key string, v []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.data[key]; !ok {
		c.order = append(c.order, key)
		if len(c.order) > tt5eCacheSize {
			delete(c.data, c.order[0])
			c.order = c.order[1:]
		}
	}
	c.data[key] = v
}

func tt5eFetch(target string) ([]byte, int, error) {
	if v, ok := tt5ePages.get(target); ok {
		return v, http.StatusOK, nil
	}
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", "Haishin-Tabletop/1.0 (+self-hosted VTT)")
	resp, err := tt5eClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, tt5eMaxPage))
	if err != nil {
		return nil, 0, err
	}
	if resp.StatusCode == http.StatusOK {
		tt5ePages.put(target, data)
	}
	return data, resp.StatusCode, nil
}

// GET /api/tabletop/5e/search?q=xxx — title search via the site's search API
func (t *Tabletop) Handle5eSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" || len([]rune(q)) > 40 {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "请输入要搜索的名称"})
		return
	}
	params := url.Values{"keyword": {q}, "titleOnly": {"true"}, "page": {"1"}, "pageSize": {"60"}, "category": {"all"}}
	data, status, err := tt5eFetch(tt5eSearchAPI + "?" + params.Encode())
	if err != nil || status != http.StatusOK {
		log.Printf("[TABLETOP] 5e search failed: status=%d err=%v", status, err)
		writeJSON(w, http.StatusBadGateway, map[string]interface{}{"error": "不全书搜索暂时不可用"})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Write(data)
}

// GET /api/tabletop/5e/page?path=topics/... — raw page HTML (UTF-8)
func (t *Tabletop) Handle5ePage(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if u, err := url.PathUnescape(p); err == nil {
		p = u
	}
	p = strings.TrimPrefix(strings.TrimSpace(p), "/")
	if i := strings.IndexAny(p, "?#"); i >= 0 {
		p = p[:i]
	}
	if !strings.HasPrefix(p, "topics/") || strings.Contains(p, "..") || strings.Contains(p, "\\") ||
		!(strings.HasSuffix(p, ".htm") || strings.HasSuffix(p, ".html")) {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "无效的不全书页面路径"})
		return
	}
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	data, status, err := tt5eFetch(tt5eSiteBase + strings.Join(segs, "/"))
	if err != nil || status != http.StatusOK {
		log.Printf("[TABLETOP] 5e page %s failed: status=%d err=%v", p, status, err)
		writeJSON(w, http.StatusBadGateway, map[string]interface{}{"error": "无法获取不全书页面"})
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8") // returned as text; parsed by the client
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Write(data)
}
