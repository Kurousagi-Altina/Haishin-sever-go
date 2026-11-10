package main

// Monster quick-deploy: search the Chinese 5etools mirror used by the Owlbear bestiary
// extension (5e.kiwee.top) and turn a monster into a sheet + token image + portrait.
//
//   GET  /api/tabletop/5e/bestiary?q=地精      → matching monsters (any logged-in user)
//   POST /api/tabletop/5e/deploy?room=ID       {"key":"XMM::Goblin Warrior"} (GM only)
//        → {sheet, token, art}: the converted sheet (no id) and asset ids already stored
//          and registered in the room; the client creates the sheet and places the token.
//
// Data files are cached under <tabletop_dir>/kiwee/ (refreshed after 7 days). The 2025
// Monster Manual (XMM) loads first; the other books load in the background. Rules are
// 2024-only, so the 2014 core books and the monster books MPMM replaced are skipped, and
// a monster reprinted in several books is listed once (best-ranked source).

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	kiweeBase    = "https://5e.kiwee.top/"
	kiweeMaxFile = 30 << 20
	kiweeMaxImg  = 10 << 20
	kiweeTTL     = 7 * 24 * time.Hour
)

// 2014 core books and the monster books superseded by MPMM / XMM
var kiweeSkip = map[string]bool{"MM": true, "PHB": true, "DMG": true, "VGM": true, "MTF": true}

// lower = preferred when the same monster appears in several books
var kiweeRank = map[string]int{"XMM": 0, "XPHB": 1, "XDMG": 1, "MPMM": 2, "BGG": 2, "FTD": 2, "BMT": 2}

var (
	kiweeSourceRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,24}$`)
	kiweeFileRe   = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,80}\.json$`)
)

var kiweeClient = &http.Client{
	Timeout: 60 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 || req.URL.Scheme != "https" || req.URL.Hostname() != "5e.kiwee.top" {
			return errors.New("redirect not allowed")
		}
		return nil
	},
}

type kiweeMon struct {
	Key    string `json:"key"`
	Name   string `json:"name"`
	En     string `json:"en"`
	Source string `json:"source"`
	CR     string `json:"cr"`
	Type   string `json:"type"`
	Size   string `json:"size"`
	Token  bool   `json:"token"`
	Art    bool   `json:"art"`
	rank   int
}

type kiweeStore struct {
	dir string

	mu       sync.Mutex
	files    map[string]string // source → data file name
	list     []kiweeMon
	loaded   map[string]bool
	loading  bool
	started  bool
	fileLock sync.Mutex
}

var kiwee = &kiweeStore{}

func (t *Tabletop) kiweeInit() {
	kiwee.mu.Lock()
	if kiwee.dir == "" {
		kiwee.dir = filepath.Join(filepath.Dir(t.roomsDir), "kiwee")
		os.MkdirAll(kiwee.dir, 0755)
	}
	kiwee.mu.Unlock()
}

// kiweeGet downloads a data file / image from the mirror (fixed host, sanitised path).
func kiweeGet(path string, limit int64) ([]byte, error) {
	resp, err := kiweeClient.Get(kiweeBase + path)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("file too large")
	}
	return data, nil
}

// kiweeData returns a cached data file (data/bestiary/<name>), downloading it when missing or stale.
func kiweeData(name string) ([]byte, error) {
	if !kiweeFileRe.MatchString(name) {
		return nil, errors.New("bad file name")
	}
	kiwee.fileLock.Lock()
	defer kiwee.fileLock.Unlock()
	path := filepath.Join(kiwee.dir, name)
	if st, err := os.Stat(path); err == nil && time.Since(st.ModTime()) < kiweeTTL {
		return os.ReadFile(path)
	}
	data, err := kiweeGet("data/bestiary/"+name, kiweeMaxFile)
	if err != nil {
		if old, rerr := os.ReadFile(path); rerr == nil { // offline: keep using the stale copy
			return old, nil
		}
		return nil, err
	}
	if !json.Valid(data) {
		return nil, errors.New("invalid JSON")
	}
	writeFileAtomic(path, data)
	return data, nil
}

func kiweeStr(v interface{}) string {
	switch x := v.(type) {
	case string:
		return x
	case map[string]interface{}:
		if s, ok := x["cr"].(string); ok {
			return s
		}
		if s, ok := x["type"].(string); ok {
			return s
		}
	}
	return ""
}

func kiweeEntry(m map[string]interface{}, source string) kiweeMon {
	en, _ := m["ENG_name"].(string)
	name, _ := m["name"].(string)
	if en == "" {
		en = name
	}
	if name == "" {
		name = en
	}
	size := ""
	if arr, ok := m["size"].([]interface{}); ok && len(arr) > 0 {
		if s, ok := arr[0].(string); ok {
			size = fiveSize[s]
		}
	}
	typ := kiweeStr(m["type"])
	if zh := fiveType[typ]; zh != "" {
		typ = zh
	}
	tok, _ := m["hasToken"].(bool)
	if _, ok := m["token"].(map[string]interface{}); ok {
		tok = true
	}
	art, _ := m["hasFluffImages"].(bool)
	rank, ok := kiweeRank[source]
	if !ok {
		rank = 5
	}
	return kiweeMon{Key: source + "::" + en, Name: name, En: en, Source: source, CR: kiweeStr(m["cr"]), Type: typ, Size: size, Token: tok, Art: art, rank: rank}
}

// kiweeLoadSource indexes one book's monsters.
func kiweeLoadSource(source string) error {
	kiwee.mu.Lock()
	file, done := kiwee.files[source], kiwee.loaded[source]
	kiwee.mu.Unlock()
	if done || file == "" {
		return nil
	}
	data, err := kiweeData(file)
	if err != nil {
		return err
	}
	var doc struct {
		Monster []map[string]interface{} `json:"monster"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return err
	}
	var add []kiweeMon
	for _, m := range doc.Monster {
		src, _ := m["source"].(string)
		if src == "" {
			src = source
		}
		if kiweeSkip[src] {
			continue
		}
		e := kiweeEntry(m, src)
		if e.En != "" {
			add = append(add, e)
		}
	}
	kiwee.mu.Lock()
	kiwee.list = append(kiwee.list, add...)
	kiwee.loaded[source] = true
	kiwee.mu.Unlock()
	return nil
}

// kiweeEnsure loads the index file and XMM synchronously, the rest in the background.
func kiweeEnsure() error {
	kiwee.mu.Lock()
	if kiwee.started {
		kiwee.mu.Unlock()
		return nil
	}
	kiwee.mu.Unlock()
	data, err := kiweeData("index.json")
	if err != nil {
		return err
	}
	var files map[string]string
	if err := json.Unmarshal(data, &files); err != nil {
		return err
	}
	kiwee.mu.Lock()
	if kiwee.started {
		kiwee.mu.Unlock()
		return nil
	}
	kiwee.started = true
	kiwee.files = map[string]string{}
	kiwee.loaded = map[string]bool{}
	var rest []string
	for src, f := range files {
		if kiweeSkip[src] || !kiweeSourceRe.MatchString(src) {
			continue
		}
		kiwee.files[src] = f
		if src != "XMM" {
			rest = append(rest, src)
		}
	}
	kiwee.loading = true
	kiwee.mu.Unlock()

	if err := kiweeLoadSource("XMM"); err != nil {
		log.Printf("[KIWEE] failed to load XMM: %v", err)
	}
	sort.Slice(rest, func(i, j int) bool {
		ri, rj := kiweeRank[rest[i]], kiweeRank[rest[j]]
		if _, ok := kiweeRank[rest[i]]; !ok {
			ri = 5
		}
		if _, ok := kiweeRank[rest[j]]; !ok {
			rj = 5
		}
		if ri != rj {
			return ri < rj
		}
		return rest[i] < rest[j]
	})
	go func() {
		for _, src := range rest {
			if err := kiweeLoadSource(src); err != nil {
				log.Printf("[KIWEE] failed to load %s: %v", src, err)
			}
			time.Sleep(200 * time.Millisecond)
		}
		kiwee.mu.Lock()
		kiwee.loading = false
		n := len(kiwee.list)
		kiwee.mu.Unlock()
		log.Printf("[KIWEE] bestiary index ready: %d monsters", n)
	}()
	return nil
}

// GET /api/tabletop/5e/bestiary?q=
func (t *Tabletop) HandleBestiary(w http.ResponseWriter, r *http.Request) {
	t.kiweeInit()
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if q == "" || len([]rune(q)) > 40 {
		writeJSON(w, http.StatusOK, map[string]interface{}{"results": []kiweeMon{}})
		return
	}
	if err := kiweeEnsure(); err != nil {
		log.Printf("[KIWEE] index unavailable: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]interface{}{"error": "怪物图鉴暂时无法访问"})
		return
	}
	kiwee.mu.Lock()
	all := append([]kiweeMon(nil), kiwee.list...)
	loading := kiwee.loading
	kiwee.mu.Unlock()

	best := map[string]kiweeMon{} // English name → best-ranked entry
	score := func(m kiweeMon) int {
		n, e := strings.ToLower(m.Name), strings.ToLower(m.En)
		switch {
		case n == q || e == q:
			return 0
		case strings.HasPrefix(n, q) || strings.HasPrefix(e, q):
			return 1
		case strings.Contains(n, q) || strings.Contains(e, q):
			return 2
		}
		return -1
	}
	for _, m := range all {
		if score(m) < 0 {
			continue
		}
		k := strings.ToLower(m.En)
		if cur, ok := best[k]; !ok || m.rank < cur.rank {
			best[k] = m
		}
	}
	out := make([]kiweeMon, 0, len(best))
	for _, m := range best {
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool {
		si, sj := score(out[i]), score(out[j])
		if si != sj {
			return si < sj
		}
		if out[i].rank != out[j].rank {
			return out[i].rank < out[j].rank
		}
		if len([]rune(out[i].Name)) != len([]rune(out[j].Name)) {
			return len([]rune(out[i].Name)) < len([]rune(out[j].Name))
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > 40 {
		out = out[:40]
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"results": out, "loading": loading})
}

// kiweeMonster returns the full 5etools object for "SOURCE::English name" (resolving a simple _copy).
func kiweeMonster(key string, depth int) (map[string]interface{}, string, error) {
	src, en, ok := strings.Cut(key, "::")
	if !ok || !kiweeSourceRe.MatchString(src) || en == "" || depth > 3 {
		return nil, "", errors.New("bad monster key")
	}
	kiwee.mu.Lock()
	file := kiwee.files[src]
	kiwee.mu.Unlock()
	if file == "" {
		return nil, "", errors.New("unknown source")
	}
	data, err := kiweeData(file)
	if err != nil {
		return nil, "", err
	}
	var doc struct {
		Monster []map[string]interface{} `json:"monster"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, "", err
	}
	for _, m := range doc.Monster {
		e, _ := m["ENG_name"].(string)
		n, _ := m["name"].(string)
		if e != en && n != en {
			continue
		}
		if cp, ok := m["_copy"].(map[string]interface{}); ok { // variant: base fields + its own overrides
			bn, _ := cp["ENG_name"].(string)
			if bn == "" {
				bn, _ = cp["name"].(string)
			}
			bs, _ := cp["source"].(string)
			if base, _, err := kiweeMonster(bs+"::"+bn, depth+1); err == nil {
				merged := map[string]interface{}{}
				for k, v := range base {
					merged[k] = v
				}
				for k, v := range m {
					if k != "_copy" {
						merged[k] = v
					}
				}
				m = merged
			}
		}
		return m, src, nil
	}
	return nil, "", errors.New("monster not found")
}

// kiweeArtPath finds the portrait image path in the book's fluff file. Fluff entries often
// borrow a group entry's images ("Kobold Warrior" → _copy "Kobolds"), sometimes prepending
// their own through _copy._mod.images.
func kiweeArtPath(src, en, name string) string {
	return kiweeArtFind(src, en, name, 0)
}

func kiweeImgPaths(v interface{}) []string {
	var out []string
	arr, _ := v.([]interface{})
	for _, x := range arr {
		im, _ := x.(map[string]interface{})
		href, _ := im["href"].(map[string]interface{})
		if p, _ := href["path"].(string); p != "" && !strings.Contains(p, "..") {
			out = append(out, p)
		}
	}
	return out
}

func kiweeArtFind(src, en, name string, depth int) string {
	if depth > 4 || !kiweeSourceRe.MatchString(src) {
		return ""
	}
	data, err := kiweeData("fluff-bestiary-" + strings.ToLower(src) + ".json")
	if err != nil {
		return ""
	}
	var doc struct {
		Fluff []map[string]interface{} `json:"monsterFluff"`
	}
	if json.Unmarshal(data, &doc) != nil {
		return ""
	}
	for _, f := range doc.Fluff {
		e, _ := f["ENG_name"].(string)
		n, _ := f["name"].(string)
		if !((en != "" && e == en) || (name != "" && n == name)) {
			continue
		}
		if p := kiweeImgPaths(f["images"]); len(p) > 0 {
			return p[0]
		}
		cp, ok := f["_copy"].(map[string]interface{})
		if !ok {
			return ""
		}
		if mod, ok := cp["_mod"].(map[string]interface{}); ok { // images added on top of the borrowed entry
			if im, ok := mod["images"].(map[string]interface{}); ok {
				if p := kiweeImgPaths(im["items"]); len(p) > 0 {
					return p[0]
				}
			}
		}
		be, _ := cp["ENG_name"].(string)
		bn, _ := cp["name"].(string)
		bs, _ := cp["source"].(string)
		if bs == "" {
			bs = src
		}
		return kiweeArtFind(bs, be, bn, depth+1)
	}
	return ""
}

func kiweeImagePath(p string) string {
	parts := strings.Split(p, "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return "img/" + strings.Join(parts, "/")
}

// POST /api/tabletop/5e/deploy?room=ID  {"key": "XMM::Goblin Warrior"}
func (t *Tabletop) HandleDeploy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	t.kiweeInit()
	info := getTokenInfo(r)
	room := t.getRoom(r.URL.Query().Get("room"))
	if room == nil {
		writeJSON(w, http.StatusNotFound, map[string]interface{}{"error": "房间不存在"})
		return
	}
	u := t.userFrom(info, "")
	room.mu.Lock()
	gm := room.isGM(u)
	room.mu.Unlock()
	if !gm {
		writeJSON(w, http.StatusForbidden, map[string]interface{}{"error": "只有 GM 可以部署怪物"})
		return
	}
	var req struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req); err != nil || req.Key == "" {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "请求无效"})
		return
	}
	if err := kiweeEnsure(); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]interface{}{"error": "怪物图鉴暂时无法访问"})
		return
	}
	m, src, err := kiweeMonster(req.Key, 0)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]interface{}{"error": "没有找到这个怪物"})
		return
	}
	entry := kiweeEntry(m, src)
	sheet := convert5etoolsMonster(m, entry.Key)

	var added []TTAsset
	fetchImg := func(path, label string) string {
		data, err := kiweeGet(path, kiweeMaxImg)
		if err != nil {
			return ""
		}
		id, err := t.storeAsset(data)
		if err != nil {
			return ""
		}
		added = append(added, TTAsset{ID: id, Name: ttCleanName(label, 60, "怪物"), Kind: "token", By: u.name})
		return id
	}
	tokenID, artID := "", ""
	if entry.Token {
		tn, ts := entry.En, src
		if tk, ok := m["token"].(map[string]interface{}); ok { // token borrowed from another monster
			if s, _ := tk["name"].(string); s != "" {
				tn = s
			}
			if s, _ := tk["source"].(string); kiweeSourceRe.MatchString(s) {
				ts = s
			}
		}
		tokenID = fetchImg(kiweeImagePath("bestiary/tokens/"+ts+"/"+tn+".webp"), entry.Name)
	}
	if entry.Art {
		if p := kiweeArtPath(src, entry.En, entry.Name); p != "" {
			artID = fetchImg(kiweeImagePath(p), entry.Name+"·立绘")
		}
	}
	if artID != "" {
		sheet["portrait"] = artID
	}
	if tokenID != "" {
		sheet["tokenImg"] = tokenID
	}
	if len(added) > 0 {
		room.mu.Lock()
		changed := false
		for _, a := range added {
			exists := false
			for _, b := range room.Assets {
				if b.ID == a.ID && b.Kind == a.Kind {
					exists = true
					break
				}
			}
			if !exists {
				room.Assets = append(room.Assets, a)
				changed = true
			}
		}
		if changed {
			room.broadcastMeta()
			room.touch()
		}
		room.mu.Unlock()
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "sheet": sheet, "token": tokenID, "art": artID})
}
