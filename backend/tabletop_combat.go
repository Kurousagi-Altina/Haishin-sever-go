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

// ttPlayerItem strips GM-only fields: players don't learn the AC of tokens they don't control.
func ttPlayerItem(it map[string]interface{}) map[string]interface{} {
	if _, has := it["ac"]; !has {
		return it
	}
	if owner, _ := it["owner"].(string); owner != "" {
		return it
	}
	cp := make(map[string]interface{}, len(it))
	for k, v := range it {
		if k != "ac" {
			cp[k] = v
		}
	}
	return cp
}

func ttPlayerItems(items []map[string]interface{}) []map[string]interface{} {
	out := make([]map[string]interface{}, len(items))
	for i, it := range items {
		out[i] = ttPlayerItem(it)
	}
	return out
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
		e.Hidden = ttBool(it["hidden"]) || req.Hidden
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
		sc.Props["combat"] = map[string]interface{}{"round": 1.0, "turn": order[0]["id"]}
		sys("开始了战斗 · 第 1 轮")
	case "next", "prev":
		if state == nil || len(order) == 0 {
			return http.StatusBadRequest, "战斗尚未开始"
		}
		if req.Action == "next" {
			idx++
			if idx >= len(order) {
				idx = 0
				round++
				sys("第 " + strconv.Itoa(round) + " 轮")
			}
		} else {
			idx--
			if idx < 0 {
				if round > 1 {
					round--
				}
				idx = len(order) - 1
			}
		}
		sc.Props["combat"] = map[string]interface{}{"round": float64(round), "turn": order[idx]["id"]}
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
	room.broadcastAll(ttMsg(map[string]interface{}{"type": "props", "props": sc.Props}))
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
	switch {
	case nat == 20:
		e.Hit = "crit"
	case nat == 1:
		e.Hit = "fumble"
	case float64(e.Roll.Total) >= ac+float64(cover):
		e.Hit = "hit"
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
