package main

import (
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// DM 备团工具（第二批）：触发区域、进入场景时的联动、随机表、场景模板。

// ===================== 触发区域 =====================
// item kind "trigger"：GM 画的隐藏矩形（x, y, w, h），玩家控制的棋子走进去时只提醒 GM。
// once = 只触发一次（fired 记录已触发），off = 停用。

func ttInRect(it map[string]interface{}, px, py float64) bool {
	x, _ := ttNum(it["x"])
	y, _ := ttNum(it["y"])
	w, _ := ttNum(it["w"])
	h, _ := ttNum(it["h"])
	if w < 0 {
		x, w = x+w, -w
	}
	if h < 0 {
		y, h = y+h, -h
	}
	return px >= x && px <= x+w && py >= y && py <= y+h
}

// checkTriggers runs after tokens moved: a player-controlled token whose centre entered a trigger fires it.
func (room *TTRoom) checkTriggers(sc *TTScene, moved []ttMove) {
	var trigs []map[string]interface{}
	for _, it := range sc.Items {
		if it["kind"] == "trigger" && !ttBool(it["off"]) && !(ttBool(it["once"]) && ttBool(it["fired"])) {
			trigs = append(trigs, it)
		}
	}
	if len(trigs) == 0 {
		return
	}
	gs, ok := ttNum(sc.Props["gridSize"])
	if !ok || gs <= 0 {
		gs = 70
	}
	var changed []map[string]interface{}
	for _, mv := range moved {
		tok := sc.Items[mv.id]
		if tok == nil || tok["kind"] != "token" {
			continue
		}
		owner, _ := tok["owner"].(string)
		if owner == "" {
			continue
		}
		x, _ := ttNum(tok["x"])
		y, _ := ttNum(tok["y"])
		w, ok := ttNum(tok["w"])
		if !ok || w <= 0 {
			w = gs
		}
		h, ok := ttNum(tok["h"])
		if !ok || h <= 0 {
			h = gs
		}
		cx, cy := x+w/2, y+h/2
		for _, tr := range trigs {
			if ttBool(tr["once"]) && ttBool(tr["fired"]) {
				continue
			}
			if !ttInRect(tr, cx, cy) || ttInRect(tr, cx-mv.dx, cy-mv.dy) {
				continue
			}
			name, _ := tr["label"].(string)
			if strings.TrimSpace(name) == "" {
				name = "触发区域"
			}
			e := newLogEntry("sys", "⚠")
			e.Text = "「" + strings.TrimSpace(name) + "」被触发：" + ttItemLabel(tok) + "（" + owner + "）走了进去"
			if note, _ := tr["text"].(string); strings.TrimSpace(note) != "" {
				e.Text += " —— " + strings.TrimSpace(note)
			}
			e.GMOnly = true
			e.Ref = "trig:" + tr["id"].(string) + ":" + mv.id
			room.addLog(e)
			if ttBool(tr["once"]) {
				tr["fired"] = true
				changed = append(changed, tr)
			}
		}
	}
	if len(changed) > 0 {
		room.broadcastItems(changed)
	}
}

// ===================== 进入场景时的联动 =====================
// scene props "onEnter": {music: {asset, name, loop} | "stop", handout: id}；开场镜头 props "cam" 由客户端处理。

func (room *TTRoom) sceneEnter(u ttUser, sc *TTScene) {
	cfg, _ := sc.Props["onEnter"].(map[string]interface{})
	if cfg == nil {
		return
	}
	switch m := cfg["music"].(type) {
	case string:
		if m == "stop" {
			delete(room.Settings, "music")
			room.broadcastMeta()
		}
	case map[string]interface{}:
		if a, _ := m["asset"].(string); ttAssetRe.MatchString(a) {
			name, _ := m["name"].(string)
			room.Settings["music"] = map[string]interface{}{"asset": a, "name": name, "playing": true,
				"loop": m["loop"] != false, "at": float64(time.Now().UnixMilli())}
			room.broadcastMeta()
		}
	}
	if id, _ := cfg["handout"].(string); id != "" {
		if idx := room.handoutIndex(id); idx >= 0 {
			h := &room.Handouts[idx]
			h.Shown = true
			room.broadcastHandout(h, true)
			room.logHandout(u, h)
		}
	}
}

// ===================== 随机表 =====================
// GM 的随机表（随机遭遇、宝藏、NPC 名字…）：每行一个条目，可写「1-3 两只哥布林」这样的范围，
// 不写范围则等概率；条目里的 [[2d6]] 掷出后替换成结果。只发给 GM。

const ttMaxTables = 100

type TTTable struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Dice string `json:"dice,omitempty"` // 留空：按条目自动（1dN）
	Rows string `json:"rows"`
}

type ttTableRow struct {
	lo, hi int
	text   string
}

var (
	ttTableRangeRe  = regexp.MustCompile(`^(\d{1,4})\s*(?:[-–—~～至]\s*(\d{1,4}))?\s*[.:：、)）|]?\s+(.+)$`)
	ttTableInlineRe = regexp.MustCompile(`\[\[([^\[\]]{1,40})\]\]`)
)

// ttTableRows parses the rows: every line "lo-hi text" (or "n text") when all lines have a range,
// otherwise each line is one equally likely entry.
func ttTableRows(rows string) []ttTableRow {
	var lines []string
	for _, l := range strings.Split(rows, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	var out []ttTableRow
	for _, l := range lines {
		m := ttTableRangeRe.FindStringSubmatch(l)
		if m == nil {
			out = nil
			break
		}
		lo, _ := strconv.Atoi(m[1])
		hi := lo
		if m[2] != "" {
			hi, _ = strconv.Atoi(m[2])
		}
		if hi < lo {
			lo, hi = hi, lo
		}
		out = append(out, ttTableRow{lo, hi, strings.TrimSpace(m[3])})
	}
	if out == nil {
		for i, l := range lines {
			out = append(out, ttTableRow{i + 1, i + 1, l})
		}
	}
	return out
}

func (room *TTRoom) tableIndex(id string) int {
	for i := range room.Tables {
		if room.Tables[i].ID == id {
			return i
		}
	}
	return -1
}

func (room *TTRoom) tablesFor(sub *ttSub) []TTTable {
	if !sub.gm {
		return []TTTable{}
	}
	if room.Tables == nil {
		return []TTTable{}
	}
	return room.Tables
}

func (room *TTRoom) broadcastTables() {
	msg := ttMsg(map[string]interface{}{"type": "tables", "tables": room.Tables})
	for sub := range room.subs {
		if sub.gm {
			room.send(sub, msg)
		}
	}
}

// applyTable: op "table" (save, Table = {id, name, dice, rows}), "table.delete" (IDs),
// "table.roll" (Text = id, Hidden = only the GM sees the result). GM only.
func (room *TTRoom) applyTable(u ttUser, req *ttOpRequest) (int, string) {
	switch req.Op {
	case "table":
		in := req.Table
		if in == nil {
			return http.StatusBadRequest, "无效的随机表"
		}
		name := ttCleanName(in.Name, 40, "随机表")
		rows := strings.TrimSpace(in.Rows)
		if len([]rune(rows)) > 8000 {
			return http.StatusBadRequest, "条目太多（最多 8000 字）"
		}
		if len(ttTableRows(rows)) == 0 {
			return http.StatusBadRequest, "随机表至少要有一个条目"
		}
		dice := strings.TrimSpace(in.Dice)
		if dice != "" {
			if _, err := RollTabletopDice(dice); err != nil {
				return http.StatusBadRequest, "骰子写法不对：" + err.Error()
			}
		}
		idx := -1
		if in.ID != "" {
			if !ttIDRe.MatchString(in.ID) {
				return http.StatusBadRequest, "无效的随机表ID"
			}
			idx = room.tableIndex(in.ID)
		}
		if idx < 0 {
			if len(room.Tables) >= ttMaxTables {
				return http.StatusBadRequest, "随机表数量已达上限"
			}
			id := in.ID
			if id == "" {
				id = ttRandomID(6)
			}
			room.Tables = append(room.Tables, TTTable{ID: id})
			idx = len(room.Tables) - 1
		}
		room.Tables[idx].Name, room.Tables[idx].Dice, room.Tables[idx].Rows = name, dice, rows
		room.broadcastTables()

	case "table.delete":
		for _, id := range req.IDs {
			if idx := room.tableIndex(id); idx >= 0 {
				room.Tables = append(room.Tables[:idx], room.Tables[idx+1:]...)
			}
		}
		room.broadcastTables()

	case "table.roll":
		idx := room.tableIndex(req.Text)
		if idx < 0 {
			return http.StatusNotFound, "随机表不存在"
		}
		tb := room.Tables[idx]
		rows := ttTableRows(tb.Rows)
		if len(rows) == 0 {
			return http.StatusBadRequest, "随机表是空的"
		}
		dice := tb.Dice
		if dice == "" {
			top := 0
			for _, r := range rows {
				if r.hi > top {
					top = r.hi
				}
			}
			dice = "1d" + strconv.Itoa(top)
		}
		res, err := RollTabletopDice(dice)
		if err != nil {
			return http.StatusBadRequest, err.Error()
		}
		text := "（没有对应的条目）"
		for _, r := range rows {
			if res.Total >= r.lo && res.Total <= r.hi {
				text = r.text
				break
			}
		}
		text = ttTableInlineRe.ReplaceAllStringFunc(text, func(s string) string {
			if r, err := RollTabletopDice(ttTableInlineRe.FindStringSubmatch(s)[1]); err == nil {
				return strconv.Itoa(r.Total)
			}
			return s
		})
		e := newLogEntry("roll", u.name)
		e.Label = ttCleanName("随机表·"+tb.Name, 50, "随机表")
		e.Roll = res
		e.Text = text
		e.Hidden = req.Hidden
		room.addLog(e)
	}
	return 0, ""
}

// ===================== 场景模板（单个场景导出 / 导入） =====================

type ttScenePack struct {
	Version int                      `json:"version"`
	Scene   *TTScene                 `json:"scene"`
	Sheets  []map[string]interface{} `json:"sheets,omitempty"`
	Assets  []TTAsset                `json:"assets,omitempty"`
}

// ttCollectAssets adds every asset-id-looking string inside v to set.
func ttCollectAssets(v interface{}, set map[string]bool) {
	switch x := v.(type) {
	case string:
		if ttAssetRe.MatchString(x) {
			set[x] = true
		}
	case map[string]interface{}:
		for _, e := range x {
			ttCollectAssets(e, set)
		}
	case []interface{}:
		for _, e := range x {
			ttCollectAssets(e, set)
		}
	}
}

// scenePack builds the template of one scene: the scene, the sheets its tokens link to, and their images.
func (room *TTRoom) scenePack(id string) (*ttScenePack, []string) {
	sc := room.scene(id)
	if sc == nil {
		return nil, nil
	}
	set := map[string]bool{}
	ttCollectAssets(map[string]interface{}(sc.Props), set)
	pack := &ttScenePack{Version: 1, Scene: sc}
	seen := map[string]bool{}
	for _, it := range sc.Items {
		ttCollectAssets(map[string]interface{}(it), set)
		if sid, _ := it["sheet"].(string); sid != "" && !seen[sid] {
			if sh := room.Sheets[sid]; sh != nil {
				seen[sid] = true
				pack.Sheets = append(pack.Sheets, sh)
				ttCollectAssets(map[string]interface{}(sh), set)
			}
		}
	}
	for _, a := range room.Assets {
		if set[a.ID] {
			pack.Assets = append(pack.Assets, a)
		}
	}
	refs := make([]string, 0, len(set))
	for a := range set {
		refs = append(refs, a)
	}
	sort.Strings(refs)
	return pack, refs
}

// importScenePack adds a scene template to the room (caller holds room.mu and checked GM).
func (room *TTRoom) importScenePack(pack *ttScenePack) (string, error) {
	if pack == nil || pack.Scene == nil {
		return "", errors.New("scene.json 格式错误")
	}
	if len(room.Scenes) >= 100 {
		return "", errors.New("场景数量已达上限")
	}
	sc := pack.Scene
	sc.ID = ttRandomID(4)
	for room.scene(sc.ID) != nil {
		sc.ID = ttRandomID(4)
	}
	sc.Name = ttCleanName(sc.Name, 40, "导入的场景")
	if sc.Props == nil {
		sc.Props = defaultSceneProps()
	}
	delete(sc.Props, "combat")
	if sc.Items == nil {
		sc.Items = make(map[string]map[string]interface{})
	}
	if len(sc.Items) > ttMaxItems {
		return "", errors.New("场景里的物件太多")
	}
	for id, it := range sc.Items {
		if it == nil || !ttIDRe.MatchString(id) {
			delete(sc.Items, id)
			continue
		}
		it["id"] = id
	}
	var added []map[string]interface{}
	for _, sh := range pack.Sheets {
		if sh == nil {
			continue
		}
		id, _ := sh["id"].(string)
		if !ttIDRe.MatchString(id) || room.Sheets[id] != nil {
			continue // 同一张卡已经在房间里（之前导入过）：沿用
		}
		room.Sheets[id] = sh
		added = append(added, sh)
	}
	for _, a := range pack.Assets {
		if !ttAssetRe.MatchString(a.ID) {
			continue
		}
		exists := false
		for _, b := range room.Assets {
			if b.ID == a.ID && b.Kind == a.Kind {
				exists = true
				break
			}
		}
		if !exists {
			kind := a.Kind
			if kind != "map" && kind != "audio" {
				kind = "token"
			}
			room.Assets = append(room.Assets, TTAsset{ID: a.ID, Name: ttCleanName(a.Name, 60, "未命名"), Kind: kind, By: a.By})
		}
	}
	room.Scenes = append(room.Scenes, sc)
	room.broadcastMeta()
	for _, sh := range added {
		room.broadcastSheet(sh)
	}
	return sc.ID, nil
}
