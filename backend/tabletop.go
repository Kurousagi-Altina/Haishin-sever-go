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
	"strconv"
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
	ttAssetRe  = regexp.MustCompile(`^[0-9a-f]{32}\.(png|jpg|gif|webp|mp3|ogg|wav|m4a)$`)
	ttColors   = []string{"#e57373", "#64b5f6", "#81c784", "#ffb74d", "#ba68c8", "#4dd0e1", "#f06292", "#aed581", "#ffd54f", "#90a4ae"}
	ttImageExt = map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}
	ttAudioExt = map[string]string{"audio/mpeg": ".mp3", "application/ogg": ".ogg", "audio/ogg": ".ogg", "audio/wave": ".wav", "video/mp4": ".m4a", "audio/mp4": ".m4a"}

	errTTUnsupported = errors.New("仅支持 PNG / JPG / GIF / WebP 图片")
)

type TTLogEntry struct {
	ID     string        `json:"id"`
	Time   string        `json:"t"`
	Kind   string        `json:"kind"` // roll / chat / sys
	Who    string        `json:"who"`
	Text   string        `json:"text,omitempty"`
	Label  string        `json:"label,omitempty"`
	Roll   *TTDiceResult `json:"roll,omitempty"`
	Hidden bool          `json:"hidden,omitempty"`
	Ref    string        `json:"ref,omitempty"` // reaction entries: "<action log id>:<token id>" they answer
	// attack rolls aimed at a token: target name, result vs its AC (hit/miss/crit/fumble), cover
	Target string `json:"target,omitempty"`
	Hit    string `json:"hit,omitempty"`
	Cover  string `json:"cover,omitempty"`
	// kind "action": an attack / spell resolved against several tokens
	Act *TTActionResult `json:"act,omitempty"`
	// only the GM (and the player named in For) receives it, e.g. HP changes of hidden tokens
	GMOnly bool   `json:"gmOnly,omitempty"`
	For    string `json:"for,omitempty"`
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
	// room-wide settings: player permissions (playerTokens / playerDraw / playerMoveOthers /
	// playerDoors), timeStop, music — see ttSettingKeys
	Settings map[string]interface{} `json:"settings"`
	// 讲义：GM 推送给玩家的图片 / 文字（tabletop_prep.go）
	Handouts []TTHandout `json:"handouts,omitempty"`
	// 随机表（GM 专用，tabletop_dm.go）
	Tables []TTTable `json:"tables,omitempty"`

	mu      sync.Mutex
	dirty   bool
	deleted bool
	subs    map[*ttSub]struct{}
	// GM undo of resolved actions: log entry id → the targets' HP / status before (memory only)
	actUndo      map[string][]ttUndoRec
	actUndoOrder []string
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
	Action string                   `json:"action"` // init / combat
	Mode   string                   `json:"mode"`   // init: "" / adv / dis
	Target string                   `json:"target"` // roll: token id the attack is aimed at
	Cover  int                      `json:"cover"`  // roll: cover bonus to the target's AC (2 / 5)
	// roll: a hit counts as a critical (paralysed / unconscious target within 5 ft)
	AutoCrit bool `json:"autoCrit"`
	// action: attack / spell / ability with targets (tabletop_action.go)
	Act *TTActionReq `json:"act"`
	// combat "round": the round number to set
	Round int `json:"round"`
	// handout: create / update a handout (tabletop_prep.go)
	Handout *TTHandout `json:"handout"`
	// table: create / update a random table (tabletop_dm.go)
	Table *TTTable `json:"table"`
	// fight.save (concentration): the DC
	DC int `json:"dc"`
}

type Tabletop struct {
	roomsDir  string
	assetsDir string
	db        *DB
	tm        *TokenManager

	mu    sync.RWMutex
	rooms map[string]*TTRoom

	rules *ttRuleSet // 本地规则库（tabletop_rules.go），没有 data/5e 时为 nil

	// door guests: nickname ↔ door token, so one guest can't act as another
	guestMu      sync.Mutex
	guestByToken map[string]string
	guestByNick  map[string]string
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
	return t.writeAsset(data, ext)
}

// storeAudio stores background music / sound effects (MP3 / OGG / WAV / M4A).
func (t *Tabletop) storeAudio(data []byte) (string, error) {
	ext, ok := ttAudioExt[http.DetectContentType(data)]
	// MP3 without an ID3 tag starts directly with a frame sync (0xFFEx / 0xFFFx)
	if !ok && len(data) > 2 && data[0] == 0xFF && data[1]&0xE0 == 0xE0 {
		ext, ok = ".mp3", true
	}
	if !ok {
		return "", errors.New("仅支持 MP3 / OGG / WAV / M4A 音频")
	}
	return t.writeAsset(data, ext)
}

func (t *Tabletop) writeAsset(data []byte, ext string) (string, error) {
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
		Settings:  make(map[string]interface{}),
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
		"measure":   "euclidean",
		"bg":        "#1b1d22",
	}
}

// normalize repairs rooms loaded from disk or imported from a zip.
func (room *TTRoom) normalize() {
	if room.subs == nil {
		room.subs = make(map[*ttSub]struct{})
	}
	if room.Settings == nil {
		room.Settings = make(map[string]interface{})
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
	for _, h := range room.Handouts {
		if h.Img != "" {
			set[h.Img] = true
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
		"id":       room.ID,
		"name":     room.Name,
		"owner":    room.Owner,
		"active":   room.Active,
		"scenes":   scenes,
		"assets":   room.Assets,
		"settings": room.Settings,
	}
}

// setting reads a boolean room setting.
func (room *TTRoom) setting(key string, def bool) bool {
	if v, ok := room.Settings[key].(bool); ok {
		return v
	}
	return def
}

func (room *TTRoom) sceneView(sc *TTScene, gm bool, name string) map[string]interface{} {
	items := make([]map[string]interface{}, 0, len(sc.Items))
	for _, it := range sc.Items {
		if !gm && ttHiddenFrom(it, name) {
			continue
		}
		if !gm {
			it = ttPlayerItem(it, ttHPStep(sc.Props), room.partyToken(it))
		}
		items = append(items, it)
	}
	return map[string]interface{}{"id": sc.ID, "name": sc.Name, "props": sc.propsFor(gm), "items": items}
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
	return sub.gm || sh["kind"] == "pc" || sh["kind"] == "summon" || ttBool(sh["shared"]) || (owner != "" && owner == sub.name)
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

// ttNameKey normalises character names for matching ("德斯克 · 拉赫兰" == "德斯克·拉赫兰").
func ttNameKey(s string) string {
	return strings.ToLower(strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || strings.ContainsRune("·・.*＊•", r) {
			return -1
		}
		return r
	}, s))
}

// linkPCTokens attaches a newly imported PC sheet to tokens that were bound to a character
// card of the same name in Owlbear (item["pcName"], set by the .ob2 import), in every scene.
// The token also becomes the sheet owner's, so their vision and control follow.
// Only a GM import also hands the tokens to the sheet's owner — otherwise any player could
// claim another character's tokens by importing a card with the same name.
func (room *TTRoom) linkPCTokens(sh map[string]interface{}, byGM bool) int {
	name, _ := sh["name"].(string)
	key := ttNameKey(name)
	if key == "" {
		return 0
	}
	linked := 0
	owner, _ := sh["owner"].(string)
	active := room.activeScene()
	var changed []map[string]interface{}
	for _, sc := range room.Scenes {
		for _, it := range sc.Items {
			pc, _ := it["pcName"].(string)
			if pc == "" || ttNameKey(pc) != key || it["sheet"] != nil {
				continue
			}
			it["sheet"] = sh["id"]
			linked++
			if _, has := it["owner"]; !has && owner != "" && byGM {
				it["owner"] = owner
			}
			if sc == active {
				changed = append(changed, it)
			}
		}
	}
	if len(changed) > 0 {
		room.broadcastItems(changed)
	}
	return linked
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
		if e.GMOnly && !sub.gm && (e.For == "" || e.For != sub.name) {
			continue
		}
		entries = append(entries, logEntryFor(sub, e))
	}
	return ttMsg(map[string]interface{}{
		"type":     "state",
		"me":       map[string]interface{}{"name": sub.name, "color": sub.color, "gm": sub.gm},
		"room":     room.meta(),
		"scene":    room.sceneView(room.activeScene(), sub.gm, sub.name),
		"log":      entries,
		"users":    room.userList(),
		"sheets":   room.sheetsFor(sub),
		"handouts": room.handoutsFor(sub),
		"tables":   room.tablesFor(sub),
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

// broadcastItems sends full items; non-GMs get items hidden from them as deletions instead
// (a token's owner still sees it while the GM hides it from everyone else).
func (room *TTRoom) broadcastItems(items []map[string]interface{}) {
	all := ttMsg(map[string]interface{}{"type": "items", "items": items})
	hpStep := ttHPStep(room.activeScene().Props)
	cache := map[string][][]byte{} // per player name
	for sub := range room.subs {
		if sub.gm {
			room.send(sub, all)
			continue
		}
		msgs, ok := cache[sub.name]
		if !ok {
			var visible []map[string]interface{}
			var hiddenIDs []string
			for _, it := range items {
				if ttHiddenFrom(it, sub.name) {
					hiddenIDs = append(hiddenIDs, it["id"].(string))
				} else {
					visible = append(visible, it)
				}
			}
			if len(visible) > 0 {
				msgs = append(msgs, ttMsg(map[string]interface{}{"type": "items", "items": room.ttPlayerItems(visible, hpStep)}))
			}
			if len(hiddenIDs) > 0 {
				msgs = append(msgs, ttMsg(map[string]interface{}{"type": "del", "ids": hiddenIDs}))
			}
			cache[sub.name] = msgs
		}
		for _, m := range msgs {
			room.send(sub, m)
		}
	}
	// the acting token was hidden / un-hidden: players' view of the turn changes too
	sc := room.activeScene()
	if c, _ := sc.Props["combat"].(map[string]interface{}); c != nil {
		for _, it := range items {
			if it["id"] == c["turn"] {
				room.broadcastProps(sc)
				break
			}
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
		if e.GMOnly && !sub.gm && (e.For == "" || e.For != sub.name) {
			continue
		}
		room.send(sub, ttMsg(map[string]interface{}{"type": "log", "entry": logEntryFor(sub, e)}))
	}
}

func newLogEntry(kind, who string) TTLogEntry {
	return TTLogEntry{ID: ttRandomID(6), Time: time.Now().Format(ttTimeFormat), Kind: kind, Who: who}
}

// ===== Ops =====

// ttCanEdit decides whether a non-GM may apply patch to an existing item:
// players fully control their own items, and may move unlocked tokens.
func ttCanEdit(room *TTRoom, item map[string]interface{}, u ttUser, patch map[string]interface{}) bool {
	if ttHiddenFrom(item, u.name) {
		return false
	}
	if owner, _ := item["owner"].(string); owner != "" && owner == u.name {
		return true
	}
	// someone else's item: only positions (numbers) / a door's open flag (bool)
	for _, k := range []string{"x", "y"} {
		if v, in := patch[k]; in {
			if _, ok := v.(float64); !ok {
				return false
			}
		}
	}
	if v, in := patch["open"]; in {
		if _, ok := v.(bool); !ok {
			return false
		}
	}
	allowed := map[string]bool{}
	switch {
	case item["kind"] == "token" && !ttBool(item["locked"]) && room.setting("playerMoveOthers", true):
		allowed = map[string]bool{"id": true, "x": true, "y": true}
	case item["kind"] == "wall" && item["wtype"] == "door" && !ttBool(item["locked"]) && room.setting("playerDoors", true):
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
		"scene.delete": true, "scene.activate": true, "room.rename": true, "room.settings": true,
		"asset.delete": true, "log.clear": true, "action.undo": true,
		"handout": true, "handout.show": true, "handout.delete": true,
		"table": true, "table.delete": true, "table.roll": true,
	}
	if gmOnly[req.Op] && !gm {
		return http.StatusForbidden, "仅 GM 可执行该操作"
	}
	if !gm && room.setting("timeStop", false) {
		switch req.Op {
		case "items", "delete", "action", "portal", "combat":
			return http.StatusForbidden, "时间停止中"
		}
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
				if !gm && !ttCanEdit(room, item, u, patch) {
					return http.StatusForbidden, "无权修改该物件"
				}
				continue
			}
			kind, _ := patch["kind"].(string)
			if kind != "token" && kind != "draw" && !((kind == "fog" || kind == "wall" || kind == "note" || kind == "trigger") && gm) {
				return http.StatusForbidden, "无权创建该物件"
			}
			if !gm && ((kind == "token" && !room.setting("playerTokens", true)) || (kind == "draw" && !room.setting("playerDraw", true))) {
				return http.StatusForbidden, "GM 关闭了玩家放置棋子 / 绘制"
			}
			created++
		}
		if len(sc.Items)+created > ttMaxItems {
			return http.StatusBadRequest, "物件数量已达上限"
		}

		changed := make([]map[string]interface{}, 0, len(req.Items))
		inBatch := make(map[string]bool, len(req.Items))
		for _, patch := range req.Items {
			inBatch[patch["id"].(string)] = true
		}
		var moved []ttMove
		var hpChanges []ttHPChange
		for _, patch := range req.Items {
			id := patch["id"].(string)
			item := sc.Items[id]
			if _, hasHP := patch["hp"]; hasHP && item != nil && item["kind"] == "token" {
				before, ok := ttNum(item["hp"])
				if !ok {
					before, _ = ttNum(item["hpMax"])
				}
				hpChanges = append(hpChanges, ttHPChange{item, before})
			}
			if item != nil {
				ox, _ := ttNum(item["x"])
				oy, _ := ttNum(item["y"])
				nx, okx := ttNum(patch["x"])
				ny, oky := ttNum(patch["y"])
				if !okx {
					nx = ox
				}
				if !oky {
					ny = oy
				}
				if (okx || oky) && (nx != ox || ny != oy) {
					moved = append(moved, ttMove{id, nx - ox, ny - oy})
				}
			}
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
				if !gm && k == "follow" && v != nil { // players can only follow tokens they can see
					lid, _ := v.(string)
					if leader := sc.Items[lid]; leader == nil || ttHiddenFrom(leader, u.name) {
						continue
					}
				}
				if v == nil {
					delete(item, k)
				} else {
					item[k] = v
				}
			}
			if item["kind"] == "note" || item["kind"] == "trigger" { // GM 的房间笔记 / 触发区域：永远不发给玩家
				item["hidden"] = true
			}
			changed = append(changed, item)
		}
		changed = append(changed, sc.moveFollowers(moved, inBatch)...)
		room.broadcastItems(changed)
		room.checkTriggers(sc, moved)
		room.logHPChanges(u, sc, hpChanges)

	case "fight.save", "fight.dot", "oa.hint", "fight.escape", "fight.counter", "fight.portent": // 战斗提示（tabletop_fight.go）
		if st, msg := room.applyFight(u, gm, req); st != 0 {
			return st, msg
		}

	case "table", "table.delete", "table.roll":
		if st, msg := room.applyTable(u, req); st != 0 {
			return st, msg
		}

	case "handout", "handout.show", "handout.delete":
		if st, msg := room.applyHandout(u, req); st != 0 {
			return st, msg
		}

	case "action.resolve": // 手动豁免：玩家自己掷完后结算（tabletop_traits.go）
		if st, msg := room.resolveManualSave(u, gm, req.Text, req.Target, req.Mode); st != 0 {
			return st, msg
		}

	case "action.undo":
		if st, msg := room.undoAction(u, req.Text); st != 0 {
			return st, msg
		}

	case "action.react": // 拨挡攻击 / 直觉闪避 / 盾牌术 after being hit (tabletop_traits.go)
		rid, xid := "", "" // 拦截 / 符文之盾 / 云雾符文：用反应的是另一个棋子；云雾符文的新目标在 ids[1]
		if len(req.IDs) > 0 {
			rid = req.IDs[0]
		}
		if len(req.IDs) > 1 {
			xid = req.IDs[1]
		}
		if st, msg := room.reactAction(u, gm, req.Text, req.Target, req.Mode, rid, xid); st != 0 {
			return st, msg
		}

	case "delete":
		var deleted []string
		for _, id := range req.IDs {
			item := sc.Items[id]
			if item == nil {
				continue
			}
			if !gm {
				owner, _ := item["owner"].(string)
				if owner != u.name || ttHiddenFrom(item, u.name) {
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
		room.broadcastProps(sc)

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
		room.sceneEnter(u, target) // 场景联动：换音乐、弹讲义

	case "room.settings":
		for k, v := range req.Props {
			if !ttSettingKeys[k] {
				continue
			}
			if v == nil {
				delete(room.Settings, k)
			} else {
				room.Settings[k] = v
			}
		}
		room.broadcastMeta()

	case "portal":
		if st, msg := room.applyPortal(u, gm, req); st != 0 {
			return st, msg
		}

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
		created := sh == nil
		if sh == nil {
			kind, _ := req.Sheet["kind"].(string)
			if !gm && kind != "pc" && kind != "summon" {
				return http.StatusForbidden, "玩家只能导入自己的角色卡或随从卡"
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
		if created && sh["kind"] == "pc" {
			if n := room.linkPCTokens(sh, gm); n > 0 && !gm {
				e := newLogEntry("sys", u.name)
				e.Text = "导入了角色卡「" + ttCleanName(fmt.Sprint(sh["name"]), 40, "") + "」，已关联 " + strconv.Itoa(n) + " 个同名棋子，请 GM 在角色卡里「分配给」玩家"
				room.addLog(e)
			}
		}

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
		res, err := RollTabletopDice(req.Expr)
		if err != nil {
			return http.StatusBadRequest, err.Error()
		}
		e := newLogEntry("roll", u.name)
		e.Label = ttCleanName(req.Label, 40, "")
		e.Roll = res
		e.Hidden = req.Hidden
		if req.Target != "" {
			room.resolveAttack(&e, gm, req)
		}
		room.addLog(e)

	case "init":
		if st, msg := room.applyInit(u, gm, req); st != 0 {
			return st, msg
		}

	case "death":
		if st, msg := room.applyDeath(u, gm, req); st != 0 {
			return st, msg
		}

	case "action":
		if st, msg := room.applyAction(u, gm, req); st != 0 {
			return st, msg
		}

	case "combat":
		if st, msg := room.applyCombat(u, gm, req); st != 0 {
			return st, msg
		}

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

	u, nerr := t.guestUser(info, ttRequestToken(r), r.URL.Query().Get("name"))
	if nerr != nil {
		http.Error(w, `{"error":"`+nerr.Error()+`"}`, http.StatusConflict)
		return
	}
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
	u, nerr := t.guestUser(getTokenInfo(r), ttRequestToken(r), req.Name)
	if nerr != nil {
		writeJSON(w, http.StatusConflict, map[string]interface{}{"error": nerr.Error()})
		return
	}

	status, msg := func() (st int, m string) {
		room.mu.Lock()
		defer room.mu.Unlock() // a panic in an op must never leave the room locked
		defer func() {
			if p := recover(); p != nil {
				log.Printf("tabletop op %q panicked: %v", req.Op, p)
				st, m = http.StatusInternalServerError, "服务器处理出错"
			}
		}()
		if room.deleted {
			return http.StatusNotFound, "房间不存在"
		}
		return room.apply(u, room.isGM(u), &req)
	}()

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
	if kind != "map" && kind != "audio" && kind != "handout" {
		kind = "token"
	}
	u, nerr := t.guestUser(info, ttRequestToken(r), r.URL.Query().Get("name"))
	if nerr != nil {
		writeJSON(w, http.StatusConflict, map[string]interface{}{"error": nerr.Error()})
		return
	}

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

	store := t.storeAsset
	if kind == "audio" {
		store = t.storeAudio
	}
	id, err := store(data)
	if err != nil {
		if !errors.Is(err, errTTUnsupported) {
			log.Printf("[TABLETOP] failed to store asset: %v", err)
		}
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": err.Error()})
		return
	}

	name := ttCleanName(strings.TrimSuffix(header.Filename, filepath.Ext(header.Filename)), 60, "未命名")
	asset := TTAsset{ID: id, Name: name, Kind: kind, By: u.name}
	if kind == "handout" { // 讲义图片不进资产库：GM 展示之前玩家看不到
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "asset": asset})
		return
	}
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
	jsonName := "room.json"
	var data []byte
	var err error
	var refs []string
	name := room.Name
	if sid := r.URL.Query().Get("scene"); sid != "" { // 场景模板：只导出这个场景（连同关联的角色卡和图片）
		pack, prefs := room.scenePack(sid)
		if pack == nil {
			room.mu.Unlock()
			http.Error(w, `{"error":"scene not found"}`, http.StatusNotFound)
			return
		}
		jsonName, refs, name = "scene.json", prefs, pack.Scene.Name
		data, err = json.MarshalIndent(pack, "", "  ")
	} else {
		data, err = json.MarshalIndent(room, "", "  ")
		refs = room.assetRefs()
	}
	room.mu.Unlock()
	if err != nil {
		http.Error(w, `{"error":"export failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+strings.TrimSuffix(jsonName, ".json")+".zip\"; filename*=UTF-8''"+url.PathEscape(name)+".zip")
	zw := zip.NewWriter(w)
	if f, err := zw.Create(jsonName); err == nil {
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
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "不是有效的 zip / .ob2 文件"})
		return
	}

	// Owlbear Rodeo 2 export (.ob2)
	if isOB2(zr) {
		room, stats, err := t.importOB2(zr, header.Filename, info.Username)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": err.Error()})
			return
		}
		room.dirty = true
		t.mu.Lock()
		t.rooms[room.ID] = room
		t.mu.Unlock()
		t.db.RecordAction(getClientIP(r), info.Username, "tabletop_import", room.Name+" (Owlbear)")
		log.Printf("[TABLETOP] imported Owlbear export as room %s: %+v", room.ID, *stats)
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "id": room.ID, "owlbear": stats})
		return
	}

	var room *TTRoom
	var scenePack []byte
	for _, f := range zr.File {
		switch {
		case f.Name == "scene.json":
			if rc, err := f.Open(); err == nil {
				scenePack, _ = io.ReadAll(io.LimitReader(rc, 50<<20))
				rc.Close()
			}
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
			store := t.storeAsset
			if regexp.MustCompile(`\.(mp3|ogg|wav|m4a)$`).MatchString(id) {
				store = t.storeAudio
			}
			if stored, err := store(data); err != nil || stored != id {
				log.Printf("[TABLETOP] import: skipped asset %s", id)
			}
		}
	}
	if room == nil && scenePack != nil { // 场景模板：加进当前房间
		target := t.getRoom(r.URL.Query().Get("room"))
		if target == nil {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "这是单个场景的模板，请进入房间后在「🗺 场景」里导入"})
			return
		}
		pack := &ttScenePack{}
		if err := json.Unmarshal(scenePack, pack); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "scene.json 格式错误"})
			return
		}
		target.mu.Lock()
		if target.deleted || !target.isGM(t.userFrom(info, "")) {
			target.mu.Unlock()
			writeJSON(w, http.StatusForbidden, map[string]interface{}{"error": "仅 GM 可导入场景"})
			return
		}
		sid, err := target.importScenePack(pack)
		if err == nil {
			target.touch()
		}
		target.mu.Unlock()
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": err.Error()})
			return
		}
		t.db.RecordAction(getClientIP(r), info.Username, "tabletop_import_scene", pack.Scene.Name)
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "scene": sid})
		return
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

// ttRandomFloat returns a random number in [0,1) (initiative tiebreakers).
func ttRandomFloat() float64 {
	b := make([]byte, 7)
	rand.Read(b)
	var v uint64
	for _, x := range b {
		v = v<<8 | uint64(x)
	}
	return float64(v>>3) / float64(uint64(1)<<53)
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

var ttSettingKeys = map[string]bool{
	"playerTokens": true, "playerDraw": true, "playerMoveOthers": true, "playerDoors": true,
	"timeStop": true, "music": true,
	// 战斗提示开关（tabletop_fight.go，默认开）
	"hintOA": true, "hintEcon": true, "hintTurn": true, "hintLegend": true, "hintMastery": true, "hintClass": true, "hintReact": true, "hintFeat": true,
	// 自动化分类（www/js/tabletop-fight.js AUTO_GROUPS）：判定、种族、分职业
	"autoTraits": true, "autoCond": true, "autoCover": true, "hintRace": true,
	"hcFighter": true, "hcMonk": true, "hcCleric": true, "hcDruid": true, "hcWizard": true, "hcArtificer": true, "hcOther": true,
}

func ttRequestToken(r *http.Request) string {
	if tok := r.URL.Query().Get("token"); tok != "" {
		return tok
	}
	tok, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return tok
}

// guestUser resolves the acting user. Door guests have no account, so a nickname is bound
// to the door token that first used it: another guest can't take it while that token is
// still valid, and a guest who changes nickname releases the old one.
func (t *Tabletop) guestUser(info TokenInfo, token, nick string) (ttUser, error) {
	u := t.userFrom(info, nick)
	if u.role != "door" || token == "" {
		return u, nil
	}
	t.guestMu.Lock()
	defer t.guestMu.Unlock()
	if t.guestByToken == nil {
		t.guestByToken = make(map[string]string)
		t.guestByNick = make(map[string]string)
	}
	if other, ok := t.guestByNick[u.name]; ok && other != token {
		if _, valid := t.tm.Validate(other); valid {
			return u, errors.New("昵称「" + strings.TrimPrefix(u.name, "访客·") + "」已被其他访客使用，请换一个")
		}
		delete(t.guestByToken, other)
	}
	if old, ok := t.guestByToken[token]; ok && old != u.name {
		delete(t.guestByNick, old)
	}
	t.guestByToken[token] = u.name
	t.guestByNick[u.name] = token
	return u, nil
}
