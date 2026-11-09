package main

import (
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// Combat helpers for the tabletop: initiative order, turns, attack resolution and
// the per-player view of tokens.
//
// Token fields (free-form item map, shape defined by the client):
//   init       initiative count (presence = the token is in the initiative tracker)
//   initMod    initiative bonus used when rolling (falls back to the linked sheet's "init")
//   initRolled true once rolled this combat
//   initTie    stable random tiebreaker in [0,1) (Owlbear initiative-tracker compatible)
//   ac         armour class — hidden from players on GM-controlled tokens
// Scene prop "combat": {"round": n, "turn": tokenId} while a combat is running.

// ttNum reads numbers that may arrive as JSON numbers or numeric strings ("+3", "15").
func ttNum(v interface{}) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, !math.IsNaN(x) && !math.IsInf(x, 0)
	case int:
		return float64(x), true
	case string:
		s := strings.TrimSpace(strings.TrimPrefix(strings.ReplaceAll(x, " ", ""), "+"))
		f, err := strconv.ParseFloat(s, 64)
		return f, err == nil
	}
	return 0, false
}

// ttInitHidden: the token's initiative entry is hidden from players — set by the GM
// (initHidden), or a GM-controlled creature that is hiding (躲藏 status).
func ttInitHidden(it map[string]interface{}) bool {
	if _, in := it["init"]; !in {
		return false
	}
	if ttBool(it["initHidden"]) {
		return true
	}
	owner, _ := it["owner"].(string)
	return owner == "" && ttStatusIDs(it)["hidden"]
}

var ttInitKeys = map[string]bool{"init": true, "initMod": true, "initRolled": true, "initTie": true, "initHidden": true}

// ttHPStep: how coarse players see the HP of GM-controlled tokens, in percent
// (scene prop hpStep; default 25 = the bar moves in quarters, 0 = exact numbers).
func ttHPStep(props map[string]interface{}) float64 {
	if v, ok := ttNum(props["hpStep"]); ok && v >= 0 && v <= 100 {
		return v
	}
	return 25
}

// ttPlayerItem strips GM-only fields: players don't learn the AC of tokens they don't
// control, nor the initiative of tokens hidden from the initiative bar, and see the HP
// of GM-controlled tokens only as a percentage rounded up to hpStep (exact HP stays
// server-side unless the boss bar is set to public numbers).
func ttPlayerItem(it map[string]interface{}, hpStep float64) map[string]interface{} {
	// secret doors: a closed one looks like a plain wall, an opened one like an open (locked) door
	if it["kind"] == "wall" && it["wtype"] == "secret" {
		cp := make(map[string]interface{}, len(it))
		for k, v := range it {
			cp[k] = v
		}
		if ttBool(it["open"]) {
			cp["wtype"], cp["locked"] = "door", true
		} else {
			cp["wtype"] = "wall"
			delete(cp, "open")
		}
		return cp
	}
	owner, _ := it["owner"].(string)
	_, hasAC := it["ac"]
	stripAC := hasAC && owner == ""
	stripInit := ttInitHidden(it)
	max, hasMax := ttNum(it["hpMax"])
	coarseHP := hasMax && max > 0 && owner == "" && hpStep > 0 && !ttBool(it["bossExact"])
	if !stripAC && !stripInit && !coarseHP {
		return it
	}
	cp := make(map[string]interface{}, len(it))
	for k, v := range it {
		if (stripAC && k == "ac") || (stripInit && ttInitKeys[k]) || (coarseHP && (k == "hpTemp" || k == "hp" || k == "hpMax")) {
			continue
		}
		cp[k] = v
	}
	if coarseHP {
		hp, ok := ttNum(it["hp"])
		if !ok {
			hp = max
		}
		pct := 0.0
		if hp > 0 {
			pct = math.Ceil(hp/max*100/hpStep) * hpStep
			if pct > 100 {
				pct = 100
			}
		}
		cp["hp"], cp["hpMax"], cp["hpPct"] = pct, 100.0, true
	}
	return cp
}

func ttPlayerItems(items []map[string]interface{}, hpStep float64) []map[string]interface{} {
	out := make([]map[string]interface{}, len(items))
	for i, it := range items {
		out[i] = ttPlayerItem(it, hpStep)
	}
	return out
}

// propsFor: players never get the initiative sort key, and see the acting token as "?"
// while it is hidden on the map or in the initiative bar.
func (sc *TTScene) propsFor(gm bool) map[string]interface{} {
	c, _ := sc.Props["combat"].(map[string]interface{})
	if gm || c == nil {
		return sc.Props
	}
	turn, _ := c["turn"].(string)
	if it := sc.Items[turn]; it == nil || ttBool(it["hidden"]) || ttInitHidden(it) {
		turn = "?"
	}
	cp := make(map[string]interface{}, len(sc.Props))
	for k, v := range sc.Props {
		cp[k] = v
	}
	cp["combat"] = map[string]interface{}{"round": c["round"], "turn": turn}
	return cp
}

func (room *TTRoom) broadcastProps(sc *TTScene) {
	gmMsg := ttMsg(map[string]interface{}{"type": "props", "props": sc.propsFor(true)})
	playerMsg := ttMsg(map[string]interface{}{"type": "props", "props": sc.propsFor(false)})
	for sub := range room.subs {
		if sub.gm {
			room.send(sub, gmMsg)
		} else {
			room.send(sub, playerMsg)
		}
	}
}

// ttInitKey / ttSortsAfter: initiative order (init desc, bonus desc, tiebreak desc, id asc),
// remembered in the combat state so "next" still works after the acting token leaves.
func ttInitKey(it map[string]interface{}) []interface{} {
	a, _ := ttNum(it["init"])
	m, _ := ttNum(it["initMod"])
	t, _ := ttNum(it["initTie"])
	return []interface{}{a, m, t, it["id"]}
}

func ttSortsAfter(it map[string]interface{}, key []interface{}) bool {
	if len(key) != 4 {
		return false
	}
	k := ttInitKey(it)
	for i := 0; i < 3; i++ {
		a, _ := ttNum(k[i])
		b, _ := ttNum(key[i])
		if a != b {
			return a < b
		}
	}
	ai, _ := k[3].(string)
	bi, _ := key[3].(string)
	return ai > bi
}

func ttCombatState(round int, it map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{"round": float64(round), "turn": it["id"], "key": ttInitKey(it)}
}

func ttItemLabel(it map[string]interface{}) string {
	if s, _ := it["label"].(string); strings.TrimSpace(s) != "" {
		return strings.TrimSpace(s)
	}
	return "未命名棋子"
}

// initOrder returns the tokens in the tracker, highest initiative first
// (ties: higher bonus, then the stored tiebreaker, then id for stability).
func (sc *TTScene) initOrder() []map[string]interface{} {
	var list []map[string]interface{}
	for _, it := range sc.Items {
		if it["kind"] != "token" {
			continue
		}
		if _, ok := ttNum(it["init"]); ok {
			list = append(list, it)
		}
	}
	sort.SliceStable(list, func(i, j int) bool {
		a, _ := ttNum(list[i]["init"])
		b, _ := ttNum(list[j]["init"])
		if a != b {
			return a > b
		}
		ma, _ := ttNum(list[i]["initMod"])
		mb, _ := ttNum(list[j]["initMod"])
		if ma != mb {
			return ma > mb
		}
		ta, _ := ttNum(list[i]["initTie"])
		tb, _ := ttNum(list[j]["initTie"])
		if ta != tb {
			return ta > tb
		}
		return list[i]["id"].(string) < list[j]["id"].(string)
	})
	return list
}

// initBonus: the token's own initiative bonus, else the linked sheet's.
func (room *TTRoom) initBonus(it map[string]interface{}) int {
	if v, ok := ttNum(it["initMod"]); ok {
		return int(v)
	}
	if id, _ := it["sheet"].(string); id != "" {
		if sh := room.Sheets[id]; sh != nil {
			if v, ok := ttNum(sh["init"]); ok {
				return int(v)
			}
		}
	}
	return 0
}

// applyInit handles {op:"init", action:"roll", ids, mode}: server-side initiative rolls.
func (room *TTRoom) applyInit(u ttUser, gm bool, req *ttOpRequest) (int, string) {
	sc := room.activeScene()
	if req.Action != "roll" || len(req.IDs) == 0 || len(req.IDs) > 200 {
		return http.StatusBadRequest, "无效的先攻操作"
	}
	var changed []map[string]interface{}
	for _, id := range req.IDs {
		it := sc.Items[id]
		if it == nil || it["kind"] != "token" {
			continue
		}
		owner, _ := it["owner"].(string)
		if !gm && (owner == "" || owner != u.name || ttBool(it["hidden"])) {
			continue
		}
		bonus := room.initBonus(it)
		expr := "1d20"
		switch req.Mode {
		case "adv":
			expr = "2d20kh1"
		case "dis":
			expr = "2d20kl1"
		}
		if bonus != 0 {
			expr += ttSigned(bonus)
		}
		res, err := RollTabletopDice(expr)
		if err != nil {
			return http.StatusBadRequest, err.Error()
		}
		it["init"] = float64(res.Total)
		it["initRolled"] = true
		if _, ok := ttNum(it["initTie"]); !ok {
			it["initTie"] = ttRandomFloat()
		}
		changed = append(changed, it)
		e := newLogEntry("roll", u.name)
		e.Label = ttCleanName(ttItemLabel(it)+"·先攻", 40, "先攻")
		e.Roll = res
		e.Hidden = ttBool(it["hidden"]) || ttInitHidden(it) || req.Hidden
		room.addLog(e)
	}
	if len(changed) == 0 {
		return http.StatusForbidden, "没有可以掷先攻的棋子"
	}
	room.broadcastItems(changed)
	return 0, ""
}

// applyCombat handles {op:"combat", action:"start"|"next"|"prev"|"end"}.
// GMs run the combat; a player may only end the turn of a token they control.
func (room *TTRoom) applyCombat(u ttUser, gm bool, req *ttOpRequest) (int, string) {
	sc := room.activeScene()
	state, _ := sc.Props["combat"].(map[string]interface{})
	order := sc.initOrder()
	turn := ""
	round := 1
	if state != nil {
		turn, _ = state["turn"].(string)
		if r, ok := ttNum(state["round"]); ok && r >= 1 {
			round = int(r)
		}
	}
	idx := -1
	for i, it := range order {
		if it["id"] == turn {
			idx = i
		}
	}
	// the acting token left the tracker (removed / deleted): continue from its old place
	var key []interface{}
	if state != nil {
		key, _ = state["key"].([]interface{})
	}
	gone := idx < 0 && state != nil && len(key) == 4
	after := len(order)
	if gone {
		for i, it := range order {
			if ttSortsAfter(it, key) {
				after = i
				break
			}
		}
	}
	if !gm {
		if req.Action != "next" || idx < 0 {
			return http.StatusForbidden, "仅 GM 可管理战斗"
		}
		if owner, _ := order[idx]["owner"].(string); owner == "" || owner != u.name {
			return http.StatusForbidden, "现在不是你的回合"
		}
	}
	sys := func(text string) {
		e := newLogEntry("sys", u.name)
		e.Text = text
		room.addLog(e)
	}
	switch req.Action {
	case "start":
		if len(order) == 0 {
			return http.StatusBadRequest, "先攻列表是空的"
		}
		sc.Props["combat"] = ttCombatState(1, order[0])
		sys("开始了战斗 · 第 1 轮")
	case "next", "prev":
		if state == nil || len(order) == 0 {
			return http.StatusBadRequest, "战斗尚未开始"
		}
		if req.Action == "next" {
			if idx >= 0 {
				// timed conditions count down at the END of the affected creature's turn,
				// so "1 round" lasts through its next turn
				room.tickStatus(order[idx])
			}
			if gone {
				idx = after - 1
			}
			idx++
			if idx >= len(order) {
				idx = 0
				round++
				sys("第 " + strconv.Itoa(round) + " 轮")
			}
		} else {
			if gone {
				idx = after
			}
			idx--
			if idx < 0 {
				if round > 1 {
					round--
				}
				idx = len(order) - 1
			}
		}
		sc.Props["combat"] = ttCombatState(round, order[idx])
	case "set": // GM: jump to a token's turn (no countdown — it's a correction, not a new turn)
		if state == nil {
			return http.StatusBadRequest, "战斗尚未开始"
		}
		var found map[string]interface{}
		for _, it := range order {
			if len(req.IDs) > 0 && it["id"] == req.IDs[0] {
				found = it
			}
		}
		if found == nil {
			return http.StatusBadRequest, "该单位不在先攻里"
		}
		sc.Props["combat"] = ttCombatState(round, found)
	case "round": // GM: correct the round counter
		if state == nil {
			return http.StatusBadRequest, "战斗尚未开始"
		}
		if req.Round < 1 || req.Round > 9999 {
			return http.StatusBadRequest, "无效的轮数"
		}
		next := map[string]interface{}{"round": float64(req.Round), "turn": turn}
		if key != nil {
			next["key"] = key
		}
		sc.Props["combat"] = next
	case "end":
		if state == nil {
			return 0, ""
		}
		delete(sc.Props, "combat")
		// a new combat rolls fresh initiative; the tracker list itself is kept
		var changed []map[string]interface{}
		for _, it := range order {
			if ttBool(it["initRolled"]) {
				delete(it, "initRolled")
				changed = append(changed, it)
			}
		}
		if len(changed) > 0 {
			room.broadcastItems(changed)
		}
		sys("结束了战斗")
	default:
		return http.StatusBadRequest, "无效的战斗操作"
	}
	room.broadcastProps(sc)
	return 0, ""
}

// resolveAttack fills e.Target / e.Hit for an attack roll aimed at a token.
// The AC never leaves the server for GM-controlled tokens; cover (+2 / +5) is
// computed by the client from walls and creatures in the way.
func (room *TTRoom) resolveAttack(e *TTLogEntry, gm bool, req *ttOpRequest) {
	it := room.activeScene().Items[req.Target]
	if it == nil || it["kind"] != "token" || (!gm && ttBool(it["hidden"])) {
		return
	}
	e.Target = ttCleanName(ttItemLabel(it), 40, "目标")
	switch req.Cover {
	case 2:
		e.Cover = "半身掩护"
	case 5:
		e.Cover = "四分之三掩护"
	}
	ac, ok := ttNum(it["ac"])
	if !ok || ac <= 0 || e.Roll == nil {
		return
	}
	cover := 0
	if req.Cover == 2 || req.Cover == 5 {
		cover = req.Cover
	}
	nat := ttNaturalD20(e.Roll)
	if nat == 0 { // not a single kept d20: no verdict (otherwise a flat roll would probe the AC)
		return
	}
	if ttStatusIDs(it)["hasted"] {
		ac += 2
	}
	switch {
	case nat == 20:
		e.Hit = "crit"
	case nat == 1:
		e.Hit = "fumble"
	case float64(e.Roll.Total) >= ac+float64(cover):
		e.Hit = "hit"
		if req.AutoCrit { // 麻痹 / 昏迷的目标被 5 尺内命中 = 重击
			e.Hit = "crit"
		}
	default:
		e.Hit = "miss"
	}
}

// ttNaturalD20 returns the kept d20 of an attack roll (0 when there isn't exactly one).
func ttNaturalD20(r *TTDiceResult) int {
	v, n := 0, 0
	for _, t := range r.Terms {
		if t.Sides != 20 {
			continue
		}
		for _, d := range t.Rolls {
			if !d.Dropped {
				v = d.Value
				n++
			}
		}
	}
	if n != 1 {
		return 0
	}
	return v
}

func ttSigned(n int) string {
	if n >= 0 {
		return "+" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// tickStatus counts down timed conditions (item["status"] = [{id,name,rounds,...}]) when
// the token's turn starts; expired ones are removed and announced.
func (room *TTRoom) tickStatus(it map[string]interface{}) {
	// clients send []interface{}; a freshly imported .ob2 room still holds the
	// importer's []map[string]interface{} until it is reloaded from disk
	var list []interface{}
	switch v := it["status"].(type) {
	case []interface{}:
		list = v
	case []map[string]interface{}:
		for _, m := range v {
			list = append(list, m)
		}
	}
	if len(list) == 0 {
		return
	}
	kept := make([]interface{}, 0, len(list))
	var ended []string
	changed := false
	for _, raw := range list {
		st, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		if r, ok := ttNum(st["rounds"]); ok && r > 0 {
			changed = true
			if r <= 1 {
				name, _ := st["name"].(string)
				ended = append(ended, name)
				continue
			}
			st["rounds"] = r - 1
		}
		kept = append(kept, st)
	}
	if !changed {
		return
	}
	if len(kept) == 0 {
		delete(it, "status")
	} else {
		it["status"] = kept
	}
	room.broadcastItems([]map[string]interface{}{it})
	if len(ended) > 0 && !ttBool(it["hidden"]) {
		e := newLogEntry("sys", ttItemLabel(it))
		e.Text = "的「" + strings.Join(ended, "」「") + "」结束了"
		room.addLog(e)
	}
}

// ttMove is a token that moved by (dx, dy) in an items op.
type ttMove struct {
	id     string
	dx, dy float64
}

// moveFollowers moves tokens that follow a moved token (item["follow"] = leader id) by the
// same offset — mounts, familiars, attached effects. Chains are followed (A ← B ← C), each
// token at most once; tokens moved in the same batch keep their own position.
func (sc *TTScene) moveFollowers(moved []ttMove, inBatch map[string]bool) []map[string]interface{} {
	var out []map[string]interface{}
	done := make(map[string]bool, len(inBatch))
	for id := range inBatch {
		done[id] = true
	}
	for len(moved) > 0 {
		m := moved[0]
		moved = moved[1:]
		for id, it := range sc.Items {
			if done[id] || it["follow"] != m.id {
				continue
			}
			x, _ := ttNum(it["x"])
			y, _ := ttNum(it["y"])
			it["x"] = x + m.dx
			it["y"] = y + m.dy
			done[id] = true
			out = append(out, it)
			moved = append(moved, ttMove{id, m.dx, m.dy})
		}
	}
	return out
}

// ===== Death saving throws =====

var ttStableStatus = map[string]interface{}{"id": "stable", "name": "稳定", "color": "#90a4ae", "icon": "💤"}
var ttDeadStatus = map[string]interface{}{"id": "dead", "name": "死亡", "color": "#424242", "icon": "💀"}

func ttDeathSaves(it map[string]interface{}) (s, f int) {
	if ds, ok := it["ds"].(map[string]interface{}); ok {
		a, _ := ttNum(ds["s"])
		b, _ := ttNum(ds["f"])
		return int(a), int(b)
	}
	return 0, 0
}

func ttRemoveStatus(it map[string]interface{}, ids ...string) {
	drop := map[string]bool{}
	for _, id := range ids {
		drop[id] = true
	}
	var out []interface{}
	for _, x := range ttStatusList(it) {
		if m, ok := x.(map[string]interface{}); ok {
			if id, _ := m["id"].(string); drop[id] {
				continue
			}
		}
		out = append(out, x)
	}
	if len(out) == 0 {
		delete(it, "status")
	} else {
		it["status"] = out
	}
}

// ttSetDeathSaves stores the tally and applies 稳定 / 死亡; returns a short outcome text.
func ttSetDeathSaves(it map[string]interface{}, s, f int) string {
	if f >= 3 {
		delete(it, "ds")
		ttRemoveStatus(it, "stable")
		ttAddStatus(it, ttDeadStatus)
		return "死亡"
	}
	if s >= 3 {
		delete(it, "ds")
		ttAddStatus(it, ttStableStatus)
		return "伤势稳定"
	}
	it["ds"] = map[string]interface{}{"s": float64(s), "f": float64(f)}
	return ""
}

// ttDamageAtZero: a creature at 0 HP that takes damage fails a death save (two on a
// critical hit); damage of at least its HP maximum kills it outright.
func ttDamageAtZero(it map[string]interface{}, dmg int, crit bool) string {
	if ttStatusIDs(it)["dead"] {
		return ""
	}
	max, _ := ttNum(it["hpMax"])
	if max > 0 && float64(dmg) >= max {
		delete(it, "ds")
		ttAddStatus(it, ttDeadStatus)
		return "伤害不低于生命上限：当场死亡"
	}
	s, f := ttDeathSaves(it)
	ttRemoveStatus(it, "stable")
	f++
	if crit {
		f++
	}
	if out := ttSetDeathSaves(it, s, f); out != "" {
		return "死亡豁免失败 → " + out
	}
	return "死亡豁免失败 " + strconv.Itoa(f) + "/3"
}

// applyDeath handles {op:"death", ids}: roll death saves for tokens at 0 HP
// (GM, or the player controlling the token).
func (room *TTRoom) applyDeath(u ttUser, gm bool, req *ttOpRequest) (int, string) {
	sc := room.activeScene()
	var changed []map[string]interface{}
	for _, id := range req.IDs {
		it := sc.Items[id]
		if it == nil || it["kind"] != "token" {
			continue
		}
		if owner, _ := it["owner"].(string); !gm && (owner == "" || owner != u.name) {
			continue
		}
		hp, _ := ttNum(it["hp"])
		max, _ := ttNum(it["hpMax"])
		conds := ttStatusIDs(it)
		if max <= 0 || hp > 0 || conds["dead"] || conds["stable"] {
			continue
		}
		res, err := RollTabletopDice("1d20")
		if err != nil {
			return http.StatusBadRequest, err.Error()
		}
		s, f := ttDeathSaves(it)
		nat := res.Total
		outcome := ""
		switch {
		case nat == 20:
			it["hp"] = 1.0
			delete(it, "ds")
			outcome = "天然 20：恢复 1 点生命值，醒了过来"
		case nat == 1:
			f += 2
		case nat >= 10:
			s++
		default:
			f++
		}
		if nat != 20 {
			if out := ttSetDeathSaves(it, s, f); out != "" {
				outcome = out
			} else {
				outcome = "成功 " + strconv.Itoa(s) + "/3 · 失败 " + strconv.Itoa(f) + "/3"
			}
		}
		changed = append(changed, it)
		e := newLogEntry("roll", u.name)
		e.Label = ttCleanName(ttItemLabel(it)+"·死亡豁免", 40, "死亡豁免")
		e.Roll = res
		e.Text = outcome
		e.Hidden = ttBool(it["hidden"]) || req.Hidden
		room.addLog(e)
	}
	if len(changed) == 0 {
		return http.StatusBadRequest, "没有需要进行死亡豁免的棋子（需要 0 生命值）"
	}
	room.broadcastItems(changed)
	return 0, ""
}

// ===== Portals =====
// A portal is a token with item["portal"] = {tag, r} (r = trigger radius in scene units).
// {op:"portal", ids:[token], from:portalId (scene), target:portalId (optional)} moves the
// token (and its followers) to another portal with the same tag. Hidden portals work as
// one-way exits: players can't see them, but a portal with a single partner sends them there.
func ttPortal(it map[string]interface{}) (tag string, r float64, ok bool) {
	p, is := it["portal"].(map[string]interface{})
	if !is || it["kind"] != "token" {
		return "", 0, false
	}
	tag, _ = p["tag"].(string)
	r, _ = ttNum(p["r"])
	return strings.TrimSpace(tag), r, true
}

func ttItemCenter(it map[string]interface{}) (float64, float64) {
	x, _ := ttNum(it["x"])
	y, _ := ttNum(it["y"])
	w, ok := ttNum(it["w"])
	if !ok {
		w = 70
	}
	h, ok := ttNum(it["h"])
	if !ok {
		h = w
	}
	return x + w/2, y + h/2
}

func (room *TTRoom) applyPortal(u ttUser, gm bool, req *ttOpRequest) (int, string) {
	sc := room.activeScene()
	from := sc.Items[req.Scene]
	tag, radius, ok := ttPortal(from)
	if !ok || len(req.IDs) == 0 || (!gm && ttBool(from["hidden"])) {
		return http.StatusBadRequest, "不是传送门"
	}
	var dest map[string]interface{}
	var candidates []map[string]interface{}
	for id, it := range sc.Items {
		if t2, _, ok := ttPortal(it); ok && it["id"] != from["id"] && t2 == tag {
			candidates = append(candidates, it)
			if id == req.Target {
				dest = it
			}
		}
	}
	if dest == nil {
		if len(candidates) != 1 {
			return http.StatusBadRequest, "请选择要去的传送门"
		}
		dest = candidates[0]
	}
	fx, fy := ttItemCenter(from)
	dx, dy := ttItemCenter(dest)
	var moved []ttMove
	var changed []map[string]interface{}
	for i, id := range req.IDs {
		it := sc.Items[id]
		if it == nil || it["kind"] != "token" || it["portal"] != nil {
			continue
		}
		owner, _ := it["owner"].(string)
		if !gm && (ttBool(it["hidden"]) || ((owner == "" || owner != u.name) && (ttBool(it["locked"]) || !room.setting("playerMoveOthers", true)))) {
			continue
		}
		cx, cy := ttItemCenter(it)
		if radius > 0 && math.Hypot(cx-fx, cy-fy) > radius*1.5 {
			continue // must be standing on the entrance
		}
		// arrivals spread out a little so several travellers don't stack
		ox, oy := 0.0, 0.0
		if i > 0 {
			a := float64(i) * 2.4
			ox, oy = math.Cos(a)*float64(20+i*8), math.Sin(a)*float64(20+i*8)
		}
		nx, ny := dx-cx+ox, dy-cy+oy
		x, _ := ttNum(it["x"])
		y, _ := ttNum(it["y"])
		it["x"], it["y"] = x+nx, y+ny
		moved = append(moved, ttMove{id, nx, ny})
		changed = append(changed, it)
	}
	if len(changed) == 0 {
		return http.StatusBadRequest, "没有可以传送的棋子（需要站在传送门上）"
	}
	inBatch := map[string]bool{}
	for _, m := range moved {
		inBatch[m.id] = true
	}
	changed = append(changed, sc.moveFollowers(moved, inBatch)...)
	room.broadcastItems(changed)
	if !ttBool(dest["hidden"]) {
		room.broadcastAll(ttMsg(map[string]interface{}{"type": "fx", "from": u.name, "color": ttColorFor(u.name),
			"fx": map[string]interface{}{"t": "portal", "x": dx, "y": dy}}))
	}
	return 0, ""
}
