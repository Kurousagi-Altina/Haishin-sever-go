package main

import (
	"archive/zip"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
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
	"unicode"
)

// Tabletop (跑团桌面): rooms with scenes; each scene has a map, tokens, drawings and fog.
// Clients receive live updates over Server-Sent Events (GET /api/tabletop/events) and
// send changes as JSON ops (POST /api/tabletop/op). Rooms persist as JSON files,
// uploaded images are stored content-addressed (sha256) in the assets directory.

const (
	ttMaxLog        = 300
	ttMaxItems      = 5000
	ttMaxAssetSize  = 25 << 20
	ttMaxImportSize = 500 << 20
	ttMaxOpBody     = 2 << 20
	ttMaxSheets     = 500
	ttMaxSheetSize  = 300 << 10
	ttTimeFormat    = "2006-01-02 15:04:05"
)

var (
	ttIDRe     = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)
	ttAssetRe  = regexp.MustCompile(`^[0-9a-f]{32}\.(png|jpg|gif|webp)$`)
	ttColors   = []string{"#e57373", "#64b5f6", "#81c784", "#ffb74d", "#ba68c8", "#4dd0e1", "#f06292", "#aed581", "#ffd54f", "#90a4ae"}
	ttImageExt = map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}

	errTTUnsupported = errors.New("仅支持 PNG / JPG / GIF / WebP 图片")
)

type TTLogEntry struct {
	ID     string      `json:"id"`
	Time   string      `json:"t"`
	Kind   string      `json:"kind"` // roll / chat / sys
	Who    string      `json:"who"`
	Text   string      `json:"text,omitempty"`
	Label  string      `json:"label,omitempty"`
	Roll   *DiceResult `json:"roll,omitempty"`
	Hidden bool        `json:"hidden,omitempty"`
}

type TTAsset struct {
	ID   string `json:"id"` // file name in the assets directory
	Name string `json:"name"`
	Kind string `json:"kind"` // map / token
	By   string `json:"by"`
}

type TTScene struct {
	ID    string                            `json:"id"`
	Name  string                            `json:"name"`
	Props map[string]interface{}            `json:"props"`
	Items map[string]map[string]interface{} `json:"items"`
}

type TTRoom struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	Owner     string       `json:"owner"`
	CreatedAt string       `json:"created_at"`
	UpdatedAt string       `json:"updated_at"`
	Active    string       `json:"active"`
	Scenes    []*TTScene   `json:"scenes"`
	Assets    []TTAsset    `json:"assets"`
	Log       []TTLogEntry `json:"log"`
	// character / monster / item sheets; tokens link to them via item["sheet"]
	Sheets map[string]map[string]interface{} `json:"sheets"`

	mu      sync.Mutex
	dirty   bool
	deleted bool
	subs    map[*ttSub]struct{}
}

type ttSub struct {
	name  string
	color string
	gm    bool
	ch    chan []byte
}

type ttUser struct {
	name string
	role string
}

type ttOpRequest struct {
	Op     string                   `json:"op"`
	Name   string                   `json:"name"` // nickname for door users
	Items  []map[string]interface{} `json:"items"`
	IDs    []string                 `json:"ids"`
	Props  map[string]interface{}   `json:"props"`
	Scene  string                   `json:"scene"`
	Text   string                   `json:"text"`
	Expr   string                   `json:"expr"`
	Label  string                   `json:"label"`
	Hidden bool                     `json:"hidden"`
	FX     map[string]interface{}   `json:"fx"`
	Sheet  map[string]interface{}   `json:"sheet"`
}

type Tabletop struct {
	roomsDir  string
	assetsDir string
	db        *DB
	tm        *TokenManager

	mu    sync.RWMutex
	rooms map[string]*TTRoom
}

func NewTabletop(dir string, db *DB, tm *TokenManager) (*Tabletop, error) {
	t := &Tabletop{
		roomsDir:  filepath.Join(dir, "rooms"),
		assetsDir: filepath.Join(dir, "assets"),
		db:        db,
		tm:        tm,
		rooms:     make(map[string]*TTRoom),
	}
	for _, d := range []string{t.roomsDir, t.assetsDir} {
		if err := os.MkdirAll(d, 0755); err != nil {
			return nil, err
		}
	}

	entries, err := os.ReadDir(t.roomsDir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(t.roomsDir, e.Name()))
		if err != nil {
			log.Printf("[TABLETOP] failed to read %s: %v", e.Name(), err)
			continue
		}
		room := &TTRoom{}
		if err := json.Unmarshal(data, room); err != nil {
			log.Printf("[TABLETOP] failed to parse %s: %v", e.Name(), err)
			continue
		}
		room.ID = strings.TrimSuffix(e.Name(), ".json")
		room.normalize()
		t.rooms[room.ID] = room
	}
	log.Printf("[TABLETOP] loaded %d rooms from %s", len(t.rooms), t.roomsDir)

	go t.saveLoop()
	return t, nil
}

// ===== Persistence =====

func (t *Tabletop) saveLoop() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		t.saveDirty()
	}
}

func (t *Tabletop) saveDirty() {
	t.mu.RLock()
	rooms := make([]*TTRoom, 0, len(t.rooms))
	for _, room := range t.rooms {
		rooms = append(rooms, room)
	}
	t.mu.RUnlock()

	for _, room := range rooms {
		room.mu.Lock()
		if !room.dirty || room.deleted {
			room.mu.Unlock()
			continue
		}
		data, err := json.Marshal(room)
		room.dirty = false
		room.mu.Unlock()
		if err != nil {
			log.Printf("[TABLETOP] failed to encode room %s: %v", room.ID, err)
			continue
		}
		if err := writeFileAtomic(filepath.Join(t.roomsDir, room.ID+".json"), data); err != nil {
			log.Printf("[TABLETOP] failed to save room %s: %v", room.ID, err)
		}
	}
}

func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".part"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// storeAsset saves an image under its content hash and returns the asset id.
func (t *Tabletop) storeAsset(data []byte) (string, error) {
	ext, ok := ttImageExt[http.DetectContentType(data)]
	if !ok {
		return "", errTTUnsupported
	}
	sum := sha256.Sum256(data)
	id := hex.EncodeToString(sum[:16]) + ext
	path := filepath.Join(t.assetsDir, id)
	if _, err := os.Stat(path); err == nil {
		return id, nil
	}
	if err := writeFileAtomic(path, data); err != nil {
		return "", err
	}
	return id, nil
}

// ===== Room helpers =====

func newTTRoom(name, owner string) *TTRoom {
	now := time.Now().Format(ttTimeFormat)
	sc := newTTScene("场景 1")
	return &TTRoom{
		ID:        ttRandomID(6),
		Name:      name,
		Owner:     owner,
		CreatedAt: now,
		UpdatedAt: now,
		Active:    sc.ID,
		Scenes:    []*TTScene{sc},
		Assets:    []TTAsset{},
		Log:       []TTLogEntry{},
		Sheets:    make(map[string]map[string]interface{}),
		subs:      make(map[*ttSub]struct{}),
	}
}

func newTTScene(name string) *TTScene {
	return &TTScene{
		ID:    ttRandomID(4),
		Name:  name,
		Props: defaultSceneProps(),
		Items: make(map[string]map[string]interface{}),
	}
}

func defaultSceneProps() map[string]interface{} {
	return map[string]interface{}{
		"gridSize":  70.0,
		"gridOffX":  0.0,
		"gridOffY":  0.0,
		"gridShow":  true,
		"gridColor": "#000000",
		"gridAlpha": 0.35,
		"gridScale": 5.0,
		"gridUnit":  "ft",
		"measure":   "chebyshev",
		"bg":        "#1b1d22",
	}
}

// normalize repairs rooms loaded from disk or imported from a zip.
func (room *TTRoom) normalize() {
	if room.subs == nil {
		room.subs = make(map[*ttSub]struct{})
	}
	seen := make(map[string]bool)
	scenes := room.Scenes[:0]
	for _, sc := range room.Scenes {
		if sc == nil {
			continue
		}
		if !ttIDRe.MatchString(sc.ID) || seen[sc.ID] {
			sc.ID = ttRandomID(4)
		}
		seen[sc.ID] = true
		if sc.Props == nil {
			sc.Props = defaultSceneProps()
		}
		if sc.Items == nil {
			sc.Items = make(map[string]map[string]interface{})
		}
		for id, it := range sc.Items {
			if it == nil || !ttIDRe.MatchString(id) {
				delete(sc.Items, id)
				continue
			}
			it["id"] = id
		}
		scenes = append(scenes, sc)
	}
	room.Scenes = scenes
	if len(room.Scenes) == 0 {
		room.Scenes = []*TTScene{newTTScene("场景 1")}
	}
	if room.scene(room.Active) == nil {
		room.Active = room.Scenes[0].ID
	}
	if room.Assets == nil {
		room.Assets = []TTAsset{}
	}
	if room.Log == nil {
		room.Log = []TTLogEntry{}
	}
	if room.Sheets == nil {
		room.Sheets = make(map[string]map[string]interface{})
	}
	for id, sh := range room.Sheets {
		if sh == nil || !ttIDRe.MatchString(id) {
			delete(room.Sheets, id)
			continue
		}
		sh["id"] = id
	}
}

func (room *TTRoom) scene(id string) *TTScene {
	for _, sc := range room.Scenes {
		if sc.ID == id {
			return sc
		}
	}
	return nil
}

func (room *TTRoom) activeScene() *TTScene {
	if sc := room.scene(room.Active); sc != nil {
		return sc
	}
	return room.Scenes[0]
}

func (room *TTRoom) isGM(u ttUser) bool {
	return u.role == "admin" || (u.role != "door" && u.name == room.Owner)
}

func (room *TTRoom) touch() {
	room.dirty = true
	room.UpdatedAt = time.Now().Format(ttTimeFormat)
}

func (room *TTRoom) onlineCount() int {
	names := make(map[string]bool)
	for sub := range room.subs {
		names[sub.name] = true
	}
	return len(names)
}

// assetRefs lists every asset the room uses (library + placed tokens + scene maps).
func (room *TTRoom) assetRefs() []string {
	set := make(map[string]bool)
	for _, a := range room.Assets {
		set[a.ID] = true
	}
	for _, sc := range room.Scenes {
		if s, ok := sc.Props["mapAsset"].(string); ok {
			set[s] = true
		}
		for _, it := range sc.Items {
			if s, ok := it["asset"].(string); ok {
				set[s] = true
			}
		}
	}
	refs := make([]string, 0, len(set))
	for id := range set {
		if ttAssetRe.MatchString(id) {
			refs = append(refs, id)
		}
	}
	sort.Strings(refs)
	return refs
}

// ===== Views & broadcasting (caller holds room.mu) =====

func (room *TTRoom) meta() map[string]interface{} {
	scenes := make([]map[string]interface{}, 0, len(room.Scenes))
	for _, sc := range room.Scenes {
		scenes = append(scenes, map[string]interface{}{"id": sc.ID, "name": sc.Name})
	}
	return map[string]interface{}{
		"id":     room.ID,
		"name":   room.Name,
		"owner":  room.Owner,
		"active": room.Active,
		"scenes": scenes,
		"assets": room.Assets,
	}
}

func (room *TTRoom) sceneView(sc *TTScene, gm bool) map[string]interface{} {
	items := make([]map[string]interface{}, 0, len(sc.Items))
	for _, it := range sc.Items {
		if !gm && ttBool(it["hidden"]) {
			continue
		}
		items = append(items, it)
	}
	return map[string]interface{}{"id": sc.ID, "name": sc.Name, "props": sc.Props, "items": items}
}

// logEntryFor masks hidden rolls for everyone except GMs and the roller.
func logEntryFor(sub *ttSub, e TTLogEntry) TTLogEntry {
	if !e.Hidden || sub.gm || sub.name == e.Who {
		return e
	}
	return TTLogEntry{ID: e.ID, Time: e.Time, Kind: e.Kind, Who: e.Who, Hidden: true, Text: "进行了一次暗骰"}
}

// sheetVisible: GMs see everything; players see PC sheets, shared sheets and their own.
func sheetVisible(sub *ttSub, sh map[string]interface{}) bool {
	owner, _ := sh["owner"].(string)
	return sub.gm || sh["kind"] == "pc" || ttBool(sh["shared"]) || (owner != "" && owner == sub.name)
}

func (room *TTRoom) sheetsFor(sub *ttSub) []map[string]interface{} {
	list := make([]map[string]interface{}, 0, len(room.Sheets))
	for _, sh := range room.Sheets {
		if sheetVisible(sub, sh) {
			list = append(list, sh)
		}
	}
	return list
}

func (room *TTRoom) broadcastSheet(sh map[string]interface{}) {
	show := ttMsg(map[string]interface{}{"type": "sheets", "sheets": []map[string]interface{}{sh}})
	hide := ttMsg(map[string]interface{}{"type": "sheetdel", "ids": []string{sh["id"].(string)}})
	for sub := range room.subs {
		if sheetVisible(sub, sh) {
			room.send(sub, show)
		} else {
			room.send(sub, hide)
		}
	}
}

func (room *TTRoom) userList() []map[string]interface{} {
	byName := make(map[string]*ttSub)
	for sub := range room.subs {
		if prev, ok := byName[sub.name]; !ok || (!prev.gm && sub.gm) {
			byName[sub.name] = sub
		}
	}
	list := make([]map[string]interface{}, 0, len(byName))
	for _, sub := range byName {
		list = append(list, map[string]interface{}{"name": sub.name, "color": sub.color, "gm": sub.gm})
	}
	sort.Slice(list, func(i, j int) bool { return list[i]["name"].(string) < list[j]["name"].(string) })
	return list
}

func (room *TTRoom) stateMsg(sub *ttSub) []byte {
	entries := make([]TTLogEntry, 0, len(room.Log))
	for _, e := range room.Log {
		entries = append(entries, logEntryFor(sub, e))
	}
	return ttMsg(map[string]interface{}{
		"type":   "state",
		"me":     map[string]interface{}{"name": sub.name, "color": sub.color, "gm": sub.gm},
		"room":   room.meta(),
		"scene":  room.sceneView(room.activeScene(), sub.gm),
		"log":    entries,
		"users":  room.userList(),
		"sheets": room.sheetsFor(sub),
	})
}

// send queues a message; a subscriber that can't keep up is disconnected
// (its EventSource reconnects and receives a fresh snapshot).
func (room *TTRoom) send(sub *ttSub, msg []byte) {
	if _, ok := room.subs[sub]; !ok {
		return
	}
	select {
	case sub.ch <- msg:
	default:
		close(sub.ch)
		delete(room.subs, sub)
	}
}

func (room *TTRoom) broadcastAll(msg []byte) {
	for sub := range room.subs {
		room.send(sub, msg)
	}
}

func (room *TTRoom) broadcastState() {
	for sub := range room.subs {
		room.send(sub, room.stateMsg(sub))
	}
}

func (room *TTRoom) broadcastMeta() {
	room.broadcastAll(ttMsg(map[string]interface{}{"type": "room", "room": room.meta()}))
}

func (room *TTRoom) broadcastUsers() {
	room.broadcastAll(ttMsg(map[string]interface{}{"type": "users", "users": room.userList()}))
}

// broadcastItems sends full items; non-GMs get hidden items as deletions instead.
func (room *TTRoom) broadcastItems(items []map[string]interface{}) {
	all := ttMsg(map[string]interface{}{"type": "items", "items": items})
	var visible []map[string]interface{}
	var hiddenIDs []string
	for _, it := range items {
		if ttBool(it["hidden"]) {
			hiddenIDs = append(hiddenIDs, it["id"].(string))
		} else {
			visible = append(visible, it)
		}
	}
	playerMsgs := [][]byte{all}
	if len(hiddenIDs) > 0 {
		playerMsgs = nil
		if len(visible) > 0 {
			playerMsgs = append(playerMsgs, ttMsg(map[string]interface{}{"type": "items", "items": visible}))
		}
		playerMsgs = append(playerMsgs, ttMsg(map[string]interface{}{"type": "del", "ids": hiddenIDs}))
	}
	for sub := range room.subs {
		if sub.gm {
			room.send(sub, all)
			continue
		}
		for _, m := range playerMsgs {
			room.send(sub, m)
		}
	}
}

func (room *TTRoom) appendLog(e TTLogEntry) {
	room.Log = append(room.Log, e)
	if len(room.Log) > ttMaxLog {
		room.Log = append([]TTLogEntry(nil), room.Log[len(room.Log)-ttMaxLog:]...)
	}
}

func (room *TTRoom) addLog(e TTLogEntry) {
	room.appendLog(e)
	for sub := range room.subs {
		room.send(sub, ttMsg(map[string]interface{}{"type": "log", "entry": logEntryFor(sub, e)}))
	}
}

func newLogEntry(kind, who string) TTLogEntry {
	return TTLogEntry{ID: ttRandomID(6), Time: time.Now().Format(ttTimeFormat), Kind: kind, Who: who}
}

// ===== Ops =====

// ttCanEdit decides whether a non-GM may apply patch to an existing item:
// players fully control their own items, and may move unlocked tokens.
func ttCanEdit(item map[string]interface{}, u ttUser, patch map[string]interface{}) bool {
	if ttBool(item["hidden"]) {
		return false
	}
	if owner, _ := item["owner"].(string); owner != "" && owner == u.name {
		return true
	}
	allowed := map[string]bool{}
	switch {
	case item["kind"] == "token" && !ttBool(item["locked"]):
		allowed = map[string]bool{"id": true, "x": true, "y": true}
	case item["kind"] == "wall" && item["wtype"] == "door" && !ttBool(item["locked"]):
		allowed = map[string]bool{"id": true, "open": true}
	default:
		return false
	}
	for k := range patch {
		if !allowed[k] {
			return false
		}
	}
	return true
}

// apply runs one op with room.mu held. Returns (status, error message) on failure.
func (room *TTRoom) apply(u ttUser, gm bool, req *ttOpRequest) (int, string) {
	sc := room.activeScene()
	gmOnly := map[string]bool{
		"props": true, "scene.add": true, "scene.duplicate": true, "scene.rename": true,
		"scene.delete": true, "scene.activate": true, "room.rename": true,
		"asset.delete": true, "log.clear": true,
	}
	if gmOnly[req.Op] && !gm {
		return http.StatusForbidden, "仅 GM 可执行该操作"
	}

	switch req.Op {
	case "items":
		if len(req.Items) == 0 || len(req.Items) > 500 {
			return http.StatusBadRequest, "无效的物件"
		}
		// validate everything first so a rejected batch changes nothing
		created := 0
		for _, patch := range req.Items {
			id, _ := patch["id"].(string)
			if !ttIDRe.MatchString(id) {
				return http.StatusBadRequest, "无效的物件ID"
			}
			if item := sc.Items[id]; item != nil {
				if !gm && !ttCanEdit(item, u, patch) {
					return http.StatusForbidden, "无权修改该物件"
				}
				continue
			}
			kind, _ := patch["kind"].(string)
			if kind != "token" && kind != "draw" && !((kind == "fog" || kind == "wall") && gm) {
				return http.StatusForbidden, "无权创建该物件"
			}
			created++
		}
		if len(sc.Items)+created > ttMaxItems {
			return http.StatusBadRequest, "物件数量已达上限"
		}

		changed := make([]map[string]interface{}, 0, len(req.Items))
		for _, patch := range req.Items {
			id := patch["id"].(string)
			item := sc.Items[id]
			if item == nil {
				item = map[string]interface{}{"id": id, "kind": patch["kind"]}
				if !gm {
					item["owner"] = u.name
				}
				sc.Items[id] = item
			}
			for k, v := range patch {
				if k == "id" || k == "kind" {
					continue
				}
				if !gm && (k == "hidden" || k == "locked" || k == "owner") {
					continue
				}
				if v == nil {
					delete(item, k)
				} else {
					item[k] = v
				}
			}
			changed = append(changed, item)
		}
		room.broadcastItems(changed)

	case "delete":
		var deleted []string
		for _, id := range req.IDs {
			item := sc.Items[id]
			if item == nil {
				continue
			}
			if !gm {
				owner, _ := item["owner"].(string)
				if owner != u.name || ttBool(item["hidden"]) {
					continue
				}
			}
			delete(sc.Items, id)
			deleted = append(deleted, id)
		}
		if len(deleted) == 0 {
			return 0, ""
		}
		room.broadcastAll(ttMsg(map[string]interface{}{"type": "del", "ids": deleted}))

	case "props":
		if len(req.Props) == 0 {
			return http.StatusBadRequest, "无效的场景设置"
		}
		for k, v := range req.Props {
			if v == nil {
				delete(sc.Props, k)
			} else {
				sc.Props[k] = v
			}
		}
		room.broadcastAll(ttMsg(map[string]interface{}{"type": "props", "props": sc.Props}))

	case "scene.add":
		if len(room.Scenes) >= 100 {
			return http.StatusBadRequest, "场景数量已达上限"
		}
		room.Scenes = append(room.Scenes, newTTScene(ttCleanName(req.Text, 40, "新场景")))
		room.broadcastMeta()

	case "scene.duplicate":
		src := room.scene(req.Scene)
		if src == nil {
			return http.StatusNotFound, "场景不存在"
		}
		if len(room.Scenes) >= 100 {
			return http.StatusBadRequest, "场景数量已达上限"
		}
		data, _ := json.Marshal(src)
		dup := &TTScene{}
		json.Unmarshal(data, dup)
		dup.ID = ttRandomID(4)
		dup.Name = ttCleanName(src.Name+" 副本", 40, "新场景")
		for i, s := range room.Scenes {
			if s == src {
				room.Scenes = append(room.Scenes[:i+1], append([]*TTScene{dup}, room.Scenes[i+1:]...)...)
				break
			}
		}
		room.broadcastMeta()

	case "scene.rename":
		target := room.scene(req.Scene)
		if target == nil {
			return http.StatusNotFound, "场景不存在"
		}
		target.Name = ttCleanName(req.Text, 40, target.Name)
		room.broadcastMeta()

	case "scene.delete":
		if len(room.Scenes) <= 1 {
			return http.StatusBadRequest, "至少保留一个场景"
		}
		idx := -1
		for i, s := range room.Scenes {
			if s.ID == req.Scene {
				idx = i
			}
		}
		if idx < 0 {
			return http.StatusNotFound, "场景不存在"
		}
		room.Scenes = append(room.Scenes[:idx], room.Scenes[idx+1:]...)
		if room.Active == req.Scene {
			room.Active = room.Scenes[0].ID
			room.broadcastState()
		} else {
			room.broadcastMeta()
		}

	case "scene.activate":
		target := room.scene(req.Scene)
		if target == nil {
			return http.StatusNotFound, "场景不存在"
		}
		room.Active = target.ID
		e := newLogEntry("sys", u.name)
		e.Text = "切换到场景「" + target.Name + "」"
		room.appendLog(e)
		room.broadcastState()

	case "room.rename":
		room.Name = ttCleanName(req.Text, 40, room.Name)
		room.broadcastMeta()

	case "asset.delete":
		drop := make(map[string]bool)
		for _, id := range req.IDs {
			drop[id] = true
		}
		kept := make([]TTAsset, 0, len(room.Assets))
		for _, a := range room.Assets {
			if !drop[a.ID] {
				kept = append(kept, a)
			}
		}
		room.Assets = kept
		room.broadcastMeta()

	case "sheet":
		id, _ := req.Sheet["id"].(string)
		if !ttIDRe.MatchString(id) {
			return http.StatusBadRequest, "无效的角色卡ID"
		}
		sh := room.Sheets[id]
		if sh == nil {
			kind, _ := req.Sheet["kind"].(string)
			if !gm && kind != "pc" {
				return http.StatusForbidden, "玩家只能导入自己的角色卡"
			}
			if len(room.Sheets) >= ttMaxSheets {
				return http.StatusBadRequest, "角色卡数量已达上限"
			}
			sh = map[string]interface{}{"id": id, "kind": kind}
			if !gm {
				sh["owner"] = u.name
			}
		} else if owner, _ := sh["owner"].(string); !gm && owner != u.name {
			return http.StatusForbidden, "只能修改自己的角色卡"
		}
		if data, _ := json.Marshal(req.Sheet); len(data) > ttMaxSheetSize {
			return http.StatusBadRequest, "角色卡内容过大"
		}
		for k, v := range req.Sheet {
			if k == "id" || (!gm && (k == "owner" || k == "shared" || k == "kind")) {
				continue
			}
			if v == nil {
				delete(sh, k)
			} else {
				sh[k] = v
			}
		}
		room.Sheets[id] = sh
		room.broadcastSheet(sh)

	case "sheet.delete":
		var deleted []string
		for _, id := range req.IDs {
			sh := room.Sheets[id]
			if sh == nil {
				continue
			}
			if owner, _ := sh["owner"].(string); !gm && owner != u.name {
				continue
			}
			delete(room.Sheets, id)
			deleted = append(deleted, id)
		}
		if len(deleted) == 0 {
			return 0, ""
		}
		room.broadcastAll(ttMsg(map[string]interface{}{"type": "sheetdel", "ids": deleted}))

	case "roll":
		res, err := RollDice(req.Expr)
		if err != nil {
			return http.StatusBadRequest, err.Error()
		}
		e := newLogEntry("roll", u.name)
		e.Label = ttCleanName(req.Label, 40, "")
		e.Roll = res
		e.Hidden = req.Hidden
		room.addLog(e)

	case "chat":
		text := strings.TrimSpace(req.Text)
		if text == "" || len([]rune(text)) > 500 {
			return http.StatusBadRequest, "消息为空或过长"
		}
		e := newLogEntry("chat", u.name)
		e.Text = text
		room.addLog(e)

	case "log.clear":
		room.Log = []TTLogEntry{}
		e := newLogEntry("sys", u.name)
		e.Text = "清空了记录"
		room.appendLog(e)
		room.broadcastState()

	case "fx":
		// ephemeral (pointer, ping, shared ruler) — relayed, never stored
		if req.FX == nil {
			return http.StatusBadRequest, "无效的操作"
		}
		msg := ttMsg(map[string]interface{}{"type": "fx", "from": u.name, "color": ttColorFor(u.name), "fx": req.FX})
		for sub := range room.subs {
			if sub.name != u.name {
				room.send(sub, msg)
			}
		}
		return 0, ""

	default:
		return http.StatusBadRequest, "未知操作"
	}

	room.touch()
	return 0, ""
}

// ===== HTTP handlers =====

func (t *Tabletop) getRoom(id string) *TTRoom {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.rooms[id]
}

func (t *Tabletop) userFrom(info TokenInfo, nick string) ttUser {
	if info.Role == "door" || info.Username == "" {
		return ttUser{name: "访客·" + ttCleanName(nick, 16, "无名"), role: "door"}
	}
	return ttUser{name: info.Username, role: info.Role}
}

// authFromQuery validates ?token= (EventSource / <img> / downloads can't set headers),
// falling back to the Authorization header.
func (t *Tabletop) authFromQuery(r *http.Request) (TokenInfo, bool) {
	token := r.URL.Query().Get("token")
	if token == "" {
		token, _ = strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	return t.tm.Validate(token)
}

// GET / POST / DELETE /api/tabletop/rooms — list, create, delete rooms
func (t *Tabletop) HandleRooms(w http.ResponseWriter, r *http.Request) {
	info := getTokenInfo(r)
	ip := getClientIP(r)

	switch r.Method {
	case http.MethodGet:
		t.mu.RLock()
		list := make([]map[string]interface{}, 0, len(t.rooms))
		for _, room := range t.rooms {
			room.mu.Lock()
			list = append(list, map[string]interface{}{
				"id":         room.ID,
				"name":       room.Name,
				"owner":      room.Owner,
				"updated_at": room.UpdatedAt,
				"scenes":     len(room.Scenes),
				"online":     room.onlineCount(),
			})
			room.mu.Unlock()
		}
		t.mu.RUnlock()
		sort.Slice(list, func(i, j int) bool {
			return list[i]["updated_at"].(string) > list[j]["updated_at"].(string)
		})
		writeJSON(w, http.StatusOK, map[string]interface{}{"rooms": list, "can_create": info.Role != "door"})

	case http.MethodPost:
		if info.Role == "door" {
			writeJSON(w, http.StatusForbidden, map[string]interface{}{"error": "游客无法创建房间，请登录后操作"})
			return
		}
		var req struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "invalid request body"})
			return
		}
		name := ttCleanName(req.Name, 40, "")
		if name == "" {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "请输入房间名"})
			return
		}
		room := newTTRoom(name, info.Username)
		room.dirty = true
		t.mu.Lock()
		t.rooms[room.ID] = room
		t.mu.Unlock()
		t.db.RecordAction(ip, info.Username, "tabletop_create", name)
		log.Printf("[TABLETOP] room %s (%s) created by %s", room.ID, name, info.Username)
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "id": room.ID})

	case http.MethodDelete:
		room := t.getRoom(r.URL.Query().Get("id"))
		if room == nil {
			writeJSON(w, http.StatusNotFound, map[string]interface{}{"error": "房间不存在"})
			return
		}
		room.mu.Lock()
		if !room.isGM(t.userFrom(info, "")) {
			room.mu.Unlock()
			writeJSON(w, http.StatusForbidden, map[string]interface{}{"error": "仅房主或管理员可删除房间"})
			return
		}
		room.deleted = true
		room.broadcastAll(ttMsg(map[string]interface{}{"type": "closed"}))
		for sub := range room.subs {
			close(sub.ch)
			delete(room.subs, sub)
		}
		name := room.Name
		room.mu.Unlock()

		t.mu.Lock()
		delete(t.rooms, room.ID)
		t.mu.Unlock()
		if err := os.Remove(filepath.Join(t.roomsDir, room.ID+".json")); err != nil && !os.IsNotExist(err) {
			log.Printf("[TABLETOP] failed to remove room file %s: %v", room.ID, err)
		}
		t.db.RecordAction(ip, info.Username, "tabletop_delete", name)
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})

	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

// GET /api/tabletop/events?room=xxx&token=xxx&name=xxx — SSE stream (own auth)
func (t *Tabletop) HandleEvents(w http.ResponseWriter, r *http.Request) {
	info, valid := t.authFromQuery(r)
	if !valid {
		http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
		return
	}
	room := t.getRoom(r.URL.Query().Get("room"))
	if room == nil {
		http.Error(w, `{"error":"room not found"}`, http.StatusNotFound)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, `{"error":"streaming unsupported"}`, http.StatusInternalServerError)
		return
	}

	u := t.userFrom(info, r.URL.Query().Get("name"))
	sub := &ttSub{name: u.name, color: ttColorFor(u.name), ch: make(chan []byte, 512)}

	room.mu.Lock()
	if room.deleted {
		room.mu.Unlock()
		http.Error(w, `{"error":"room not found"}`, http.StatusNotFound)
		return
	}
	sub.gm = room.isGM(u)
	room.subs[sub] = struct{}{}
	snapshot := room.stateMsg(sub)
	room.broadcastUsers()
	room.mu.Unlock()

	defer func() {
		room.mu.Lock()
		if _, ok := room.subs[sub]; ok {
			delete(room.subs, sub)
			room.broadcastUsers()
		}
		room.mu.Unlock()
	}()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "retry: 2000\ndata: %s\n\n", snapshot)
	flusher.Flush()

	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg, ok := <-sub.ch:
			if !ok {
				return
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", msg); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// POST /api/tabletop/op?room=xxx — apply an op (see TTRoom.apply)
func (t *Tabletop) HandleOp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	room := t.getRoom(r.URL.Query().Get("room"))
	if room == nil {
		writeJSON(w, http.StatusNotFound, map[string]interface{}{"error": "房间不存在"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, ttMaxOpBody)
	var req ttOpRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "invalid request body"})
		return
	}
	u := t.userFrom(getTokenInfo(r), req.Name)

	room.mu.Lock()
	status, msg := http.StatusNotFound, "房间不存在"
	if !room.deleted {
		status, msg = room.apply(u, room.isGM(u), &req)
	}
	room.mu.Unlock()

	if msg != "" {
		writeJSON(w, status, map[string]interface{}{"error": msg})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

// POST /api/tabletop/upload?room=xxx&kind=map|token&name=xxx — add an image to the room library
func (t *Tabletop) HandleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	info := getTokenInfo(r)
	room := t.getRoom(r.URL.Query().Get("room"))
	if room == nil {
		writeJSON(w, http.StatusNotFound, map[string]interface{}{"error": "房间不存在"})
		return
	}
	kind := r.URL.Query().Get("kind")
	if kind != "map" {
		kind = "token"
	}
	u := t.userFrom(info, r.URL.Query().Get("name"))

	r.Body = http.MaxBytesReader(w, r.Body, ttMaxAssetSize+(1<<20))
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "文件无效或超过 25MB"})
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, ttMaxAssetSize+1))
	if err != nil || len(data) > ttMaxAssetSize {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "文件无效或超过 25MB"})
		return
	}

	room.mu.Lock()
	allowed := !room.deleted && (kind == "token" || room.isGM(u))
	room.mu.Unlock()
	if !allowed {
		writeJSON(w, http.StatusForbidden, map[string]interface{}{"error": "仅 GM 可上传地图"})
		return
	}

	id, err := t.storeAsset(data)
	if err != nil {
		if !errors.Is(err, errTTUnsupported) {
			log.Printf("[TABLETOP] failed to store asset: %v", err)
		}
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": err.Error()})
		return
	}

	name := ttCleanName(strings.TrimSuffix(header.Filename, filepath.Ext(header.Filename)), 60, "未命名")
	asset := TTAsset{ID: id, Name: name, Kind: kind, By: u.name}
	room.mu.Lock()
	exists := false
	for _, a := range room.Assets {
		if a.ID == id && a.Kind == kind {
			asset, exists = a, true
			break
		}
	}
	if !exists {
		room.Assets = append(room.Assets, asset)
		room.broadcastMeta()
		room.touch()
	}
	room.mu.Unlock()

	t.db.RecordAction(getClientIP(r), info.Username, "tabletop_upload", name)
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "asset": asset})
}

// GET /tabletop-assets/<id>?token=xxx — serve an uploaded image (own auth)
func (t *Tabletop) HandleAsset(w http.ResponseWriter, r *http.Request) {
	if _, valid := t.authFromQuery(r); !valid {
		http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/tabletop-assets/")
	if !ttAssetRe.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, filepath.Join(t.assetsDir, id))
}

// GET /api/tabletop/export?room=xxx&token=xxx — download room + assets as zip (GM only, own auth)
func (t *Tabletop) HandleExport(w http.ResponseWriter, r *http.Request) {
	info, valid := t.authFromQuery(r)
	if !valid {
		http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
		return
	}
	room := t.getRoom(r.URL.Query().Get("room"))
	if room == nil {
		http.Error(w, `{"error":"room not found"}`, http.StatusNotFound)
		return
	}

	room.mu.Lock()
	if !room.isGM(t.userFrom(info, "")) {
		room.mu.Unlock()
		http.Error(w, `{"error":"仅 GM 可导出房间"}`, http.StatusForbidden)
		return
	}
	data, err := json.MarshalIndent(room, "", "  ")
	refs := room.assetRefs()
	name := room.Name
	room.mu.Unlock()
	if err != nil {
		http.Error(w, `{"error":"export failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=\"room.zip\"; filename*=UTF-8''"+url.PathEscape(name)+".zip")
	zw := zip.NewWriter(w)
	if f, err := zw.Create("room.json"); err == nil {
		f.Write(data)
	}
	for _, id := range refs {
		src, err := os.Open(filepath.Join(t.assetsDir, id))
		if err != nil {
			continue
		}
		// images are already compressed — store them as-is
		if dst, err := zw.CreateHeader(&zip.FileHeader{Name: "assets/" + id, Method: zip.Store}); err == nil {
			io.Copy(dst, src)
		}
		src.Close()
	}
	if err := zw.Close(); err != nil {
		log.Printf("[TABLETOP] export of %s failed: %v", room.ID, err)
	}
	t.db.RecordAction(getClientIP(r), info.Username, "tabletop_export", name)
}

// POST /api/tabletop/import — create a new room from an exported zip
func (t *Tabletop) HandleImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	info := getTokenInfo(r)
	if info.Role == "door" {
		writeJSON(w, http.StatusForbidden, map[string]interface{}{"error": "游客无法导入房间，请登录后操作"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, ttMaxImportSize)
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "文件无效或过大"})
		return
	}
	defer file.Close()
	zr, err := zip.NewReader(file, header.Size)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "不是有效的 zip 文件"})
		return
	}

	var room *TTRoom
	for _, f := range zr.File {
		switch {
		case f.Name == "room.json":
			rc, err := f.Open()
			if err != nil {
				continue
			}
			data, err := io.ReadAll(io.LimitReader(rc, 50<<20))
			rc.Close()
			if err != nil {
				continue
			}
			room = &TTRoom{}
			if err := json.Unmarshal(data, room); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "room.json 格式错误"})
				return
			}
		case strings.HasPrefix(f.Name, "assets/"):
			id := strings.TrimPrefix(f.Name, "assets/")
			if !ttAssetRe.MatchString(id) {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				continue
			}
			data, err := io.ReadAll(io.LimitReader(rc, ttMaxAssetSize+1))
			rc.Close()
			if err != nil || len(data) > ttMaxAssetSize {
				continue
			}
			// only keep files whose content matches their hash name
			if stored, err := t.storeAsset(data); err != nil || stored != id {
				log.Printf("[TABLETOP] import: skipped asset %s", id)
			}
		}
	}
	if room == nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "压缩包中缺少 room.json"})
		return
	}

	now := time.Now().Format(ttTimeFormat)
	room.ID = ttRandomID(6)
	room.Name = ttCleanName(room.Name, 40, "导入的房间")
	room.Owner = info.Username
	room.CreatedAt = now
	room.UpdatedAt = now
	room.normalize()
	room.dirty = true
	t.mu.Lock()
	t.rooms[room.ID] = room
	t.mu.Unlock()

	t.db.RecordAction(getClientIP(r), info.Username, "tabletop_import", room.Name)
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "id": room.ID})
}

// ===== Small utilities =====

func ttMsg(v interface{}) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		log.Printf("[TABLETOP] encode error: %v", err)
		return []byte(`{"type":"noop"}`)
	}
	return data
}

func ttBool(v interface{}) bool {
	b, _ := v.(bool)
	return b
}

func ttRandomID(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func ttColorFor(name string) string {
	h := fnv.New32a()
	h.Write([]byte(name))
	return ttColors[h.Sum32()%uint32(len(ttColors))]
}

// ttCleanName trims, strips control characters and truncates to max runes.
func ttCleanName(s string, max int, def string) string {
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s))
	if runes := []rune(s); len(runes) > max {
		s = string(runes[:max])
	}
	if s == "" {
		return def
	}
	return s
}
