package main

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// 战斗提示（docs/战斗规则.md）：回合开始 / 结束时的处理、专注豁免、状态的重复豁免与持续伤害、
// 借机攻击提示、怪物的传奇动作 / 传奇抗性 / 充能。原则是只提示、不强制，每类都能在房间设置里关掉：
// hintOA（借机攻击）、hintEcon（动作经济）、hintTurn（回合开始 / 结束效果）、hintLegend（传奇 / 充能）。

var (
	ttLRRe       = regexp.MustCompile(`传奇抗性\s*[（(]\s*(\d+)\s*[/／]\s*日`)
	ttLARe       = regexp.MustCompile(`(?:传奇动作使用次数|使用次数)\s*[：:]\s*(\d+)|(\d+)\s*次传奇动作`)
	ttRechargeRe = regexp.MustCompile(`充能\s*(\d)(?:\s*[-–—~～]\s*6)?`)
)

// ttStatusMaps returns the token's status entries as maps (in place, so changes stick).
func ttStatusMaps(it map[string]interface{}) []map[string]interface{} {
	var out []map[string]interface{}
	for _, x := range ttStatusList(it) {
		if m, ok := x.(map[string]interface{}); ok {
			out = append(out, m)
		}
	}
	return out
}

func ttStatusByName(it map[string]interface{}, name string) map[string]interface{} {
	for _, m := range ttStatusMaps(it) {
		if n, _ := m["name"].(string); n == name {
			return m
		}
	}
	return nil
}

func ttRemoveStatusNamed(it map[string]interface{}, name string) {
	var keep []interface{}
	for _, x := range ttStatusList(it) {
		if m, ok := x.(map[string]interface{}); ok && m["name"] == name {
			continue
		}
		keep = append(keep, x)
	}
	if len(keep) > 0 {
		it["status"] = keep
	} else {
		delete(it, "status")
	}
}

// ===================== 怪物资源：传奇动作 / 传奇抗性 / 充能 =====================

type ttMonRes struct {
	name   string
	max    int
	kind   string // la / lr / rc
	rcMin  int
	sortBy int
}

// ttMonsterRes reads a monster sheet's Legendary Actions (uses per round), Legendary Resistance (x/day)
// and Recharge abilities.
func ttMonsterRes(sh map[string]interface{}) []ttMonRes {
	if sh == nil || sh["kind"] == "pc" {
		return nil
	}
	var out []ttMonRes
	seen := map[string]bool{}
	add := func(r ttMonRes) {
		if !seen[r.name] && r.max > 0 && len(out) < 8 {
			seen[r.name] = true
			out = append(out, r)
		}
	}
	scan := func(title string, entries []map[string]interface{}) {
		for _, e := range entries {
			name, _ := e["name"].(string)
			text, _ := e["text"].(string)
			if m := ttLRRe.FindStringSubmatch(name + " " + text); m != nil && strings.Contains(name, "传奇抗性") {
				n, _ := strconv.Atoi(m[1])
				add(ttMonRes{name: "传奇抗性", max: n, kind: "lr"})
			}
			if m := ttRechargeRe.FindStringSubmatch(name); m != nil {
				min, _ := strconv.Atoi(m[1])
				base := strings.TrimSpace(regexp.MustCompile(`[（(][^）)]*充能[^）)]*[）)]`).ReplaceAllString(name, ""))
				base = strings.TrimSuffix(base, "。")
				if base == "" {
					base = "充能能力"
				}
				if min >= 2 && min <= 6 {
					add(ttMonRes{name: ttCleanName("充能·"+base, 20, "充能能力"), max: 1, kind: "rc", rcMin: min})
				}
			}
		}
		if strings.Contains(title, "传奇动作") {
			n := 0
			for _, e := range entries {
				text, _ := e["text"].(string)
				name, _ := e["name"].(string)
				if m := ttLARe.FindStringSubmatch(name + " " + text); m != nil {
					if m[1] != "" {
						n, _ = strconv.Atoi(m[1])
					} else {
						n, _ = strconv.Atoi(m[2])
					}
					break
				}
			}
			if n <= 0 || n > 9 {
				n = 3
			}
			add(ttMonRes{name: "传奇动作", max: n, kind: "la"})
		}
	}
	for _, sec := range ttSheetList(sh, "sections") {
		title, _ := sec["title"].(string)
		scan(title, ttSheetList(sec, "entries"))
	}
	scan("", ttSheetList(sh, "features"))
	return out
}

// ensureMonsterRes adds the monster's legendary / recharge counters to the token once (they can be
// edited or deleted afterwards like any token resource). Reports whether the token changed.
func (room *TTRoom) ensureMonsterRes(it map[string]interface{}) bool {
	if ttBool(it["monRes"]) {
		return false
	}
	defs := ttMonsterRes(room.tokenSheet(it))
	if len(defs) == 0 {
		return false
	}
	it["monRes"] = true
	res, _ := it["res"].([]interface{})
	have := map[string]bool{}
	for _, x := range res {
		if m, ok := x.(map[string]interface{}); ok {
			n, _ := m["name"].(string)
			have[n] = true
		}
	}
	for _, d := range defs {
		if have[d.name] || len(res) >= 12 {
			continue
		}
		r := map[string]interface{}{"id": ttRandomID(6), "name": d.name, "type": "count", "cur": float64(d.max), "max": float64(d.max), "icon": "gem", d.kind: true}
		if d.kind == "rc" {
			r["rc"] = float64(d.rcMin)
		}
		res = append(res, r)
	}
	it["res"] = res
	return true
}

func ttResList(it map[string]interface{}) []map[string]interface{} {
	var out []map[string]interface{}
	if list, ok := it["res"].([]interface{}); ok {
		for _, x := range list {
			if m, ok := x.(map[string]interface{}); ok {
				out = append(out, m)
			}
		}
	}
	return out
}

// ttLegendRes finds the token's legendary-action ("la") / legendary-resistance ("lr") counter.
func ttLegendRes(it map[string]interface{}, kind string) map[string]interface{} {
	name := map[string]string{"la": "传奇动作", "lr": "传奇抗性"}[kind]
	for _, r := range ttResList(it) {
		if ttBool(r[kind]) || r["name"] == name {
			return r
		}
	}
	return nil
}

// ===================== 回合开始 / 结束 =====================

func (room *TTRoom) hint(it map[string]interface{}, text, ref string) {
	e := newLogEntry("sys", "⏱")
	e.Text = text
	e.GMOnly = true
	e.For, _ = it["owner"].(string)
	e.Ref = ref
	room.addLog(e)
}

// turnStart runs when a creature's turn begins (combat start / next).
func (room *TTRoom) turnStart(sc *TTScene, it map[string]interface{}) {
	if it == nil {
		return
	}
	changed := false
	if _, ok := it["econ"]; ok { // 动作、附赠动作、反应在自己回合开始时恢复
		delete(it, "econ")
		changed = true
	}
	id, _ := it["id"].(string)
	label := ttItemLabel(it)
	if room.setting("hintTurn", true) {
		if ttStatusIDs(it)["dodging"] { // 闪避持续到自己下个回合开始
			ttRemoveStatus(it, "dodging")
			changed = true
		}
		for _, st := range ttStatusMaps(it) {
			name, _ := st["name"].(string)
			if dot, ok := st["dot"].(map[string]interface{}); ok && dot["when"] != "end" {
				dice, _ := dot["dice"].(string)
				typ, _ := dot["type"].(string)
				room.hint(it, label+" 回合开始：「"+name+"」造成 "+dice+" "+typ+"伤害", "dot:"+id+":"+name)
			}
			if sv, ok := st["save"].(map[string]interface{}); ok && sv["when"] == "start" {
				room.hint(it, label+" 回合开始：「"+name+"」"+ttSaveText(sv), "ssave:"+id+":"+name)
			}
		}
	}
	if room.setting("hintLegend", true) {
		if room.ensureMonsterRes(it) {
			changed = true
		}
		for _, r := range ttResList(it) {
			max, _ := ttNum(r["max"])
			cur, _ := ttNum(r["cur"])
			if ttBool(r["la"]) && cur < max { // 传奇动作在自己回合开始时全部恢复
				r["cur"] = max
				changed = true
			}
			if min, ok := ttNum(r["rc"]); ok && min > 0 && cur < max {
				res, err := RollTabletopDice("1d6")
				if err != nil {
					continue
				}
				name, _ := r["name"].(string)
				e := newLogEntry("roll", "⏱")
				e.Label = ttCleanName(label+"·"+name+" 充能", 50, "充能")
				e.Roll = res
				if float64(res.Total) >= min {
					r["cur"] = max
					e.Text = "掷出 " + strconv.Itoa(res.Total) + "（需要 " + strconv.Itoa(int(min)) + "–6）：恢复了"
					changed = true
				} else {
					e.Text = "掷出 " + strconv.Itoa(res.Total) + "（需要 " + strconv.Itoa(int(min)) + "–6）：还没恢复"
				}
				e.Hidden = ttConcealed(it) || it["owner"] == nil || it["owner"] == ""
				room.addLog(e)
			}
		}
	}
	if changed {
		room.broadcastItems([]map[string]interface{}{it})
	}
}

func ttSaveText(sv map[string]interface{}) string {
	ab, _ := sv["ab"].(string)
	dc, _ := ttNum(sv["dc"])
	return "需要" + ttAbilityCN[ab] + "豁免 DC " + strconv.Itoa(int(dc)) + "，成功则结束"
}

// turnEnd runs when a creature ends its turn (before "next" moves on).
func (room *TTRoom) turnEnd(sc *TTScene, it map[string]interface{}, order []map[string]interface{}) {
	if it == nil {
		return
	}
	id, _ := it["id"].(string)
	label := ttItemLabel(it)
	if room.setting("hintTurn", true) {
		if ttStatusIDs(it)["disengaged"] { // 撤离只在本回合有效
			ttRemoveStatus(it, "disengaged")
			room.broadcastItems([]map[string]interface{}{it})
		}
		for _, st := range ttStatusMaps(it) {
			name, _ := st["name"].(string)
			if sv, ok := st["save"].(map[string]interface{}); ok && sv["when"] != "start" {
				room.hint(it, label+" 回合结束：「"+name+"」"+ttSaveText(sv), "ssave:"+id+":"+name)
			}
			if dot, ok := st["dot"].(map[string]interface{}); ok && dot["when"] == "end" {
				dice, _ := dot["dice"].(string)
				typ, _ := dot["type"].(string)
				room.hint(it, label+" 回合结束：「"+name+"」造成 "+dice+" "+typ+"伤害", "dot:"+id+":"+name)
			}
		}
	}
	if room.setting("hintLegend", true) { // 另一个生物的回合结束：传奇动作的使用时机
		var names, ids []string
		for _, o := range order {
			if o["id"] == id {
				continue
			}
			conds := ttStatusIDs(o)
			if conds["dead"] || ttIncapacitated(conds) {
				continue
			}
			if r := ttLegendRes(o, "la"); r != nil {
				if cur, _ := ttNum(r["cur"]); cur > 0 {
					max, _ := ttNum(r["max"])
					names = append(names, ttItemLabel(o)+"（剩 "+strconv.Itoa(int(cur))+"/"+strconv.Itoa(int(max))+"）")
					ids = append(ids, o["id"].(string))
				}
			}
		}
		if len(ids) > 0 {
			e := newLogEntry("sys", "⏱")
			e.Text = label + " 的回合结束：可以使用传奇动作 —— " + strings.Join(names, "、")
			e.GMOnly = true
			e.Ref = "la:" + strings.Join(ids, ",")
			room.addLog(e)
		}
	}
}

// ensureCombatRes gives every monster in the tracker its legendary / recharge counters at combat start.
func (room *TTRoom) ensureCombatRes(order []map[string]interface{}) {
	if !room.setting("hintLegend", true) {
		return
	}
	var changed []map[string]interface{}
	for _, it := range order {
		if room.ensureMonsterRes(it) {
			changed = append(changed, it)
		}
	}
	if len(changed) > 0 {
		room.broadcastItems(changed)
	}
}

// ===================== 豁免、持续伤害、借机攻击 =====================

// rollTokenSave rolls a saving throw for a token like actions do: the sheet's save bonus, judgement
// modifiers (bonuses and advantage), conditions, bless / bane and exhaustion. adv adds sources of advantage.
func (room *TTRoom) rollTokenSave(it map[string]interface{}, ab string, adv []string) (*TTDiceResult, []string, error) {
	conds := ttStatusIDs(it)
	if (ab == "str" || ab == "dex") && (conds["paralyzed"] || conds["stunned"] || conds["unconscious"] || conds["petrified"]) {
		return nil, []string{"自动失败"}, nil
	}
	tr := room.traitsOf(it)
	sb := room.saveBonus(it, ab)
	more, bonusNotes, advSrc := tr.saveMods(ab, false, false, "", "", conds)
	sb += more
	advSrc = append(advSrc, adv...)
	hasAdv := ab == "dex" && (conds["hasted"] || conds["dodging"]) || len(advSrc) > 0
	dis := ab == "dex" && conds["restrained"]
	var notes []string
	if len(bonusNotes) > 0 {
		notes = append(notes, "豁免 "+ttJoinNotes(bonusNotes))
	}
	if len(advSrc) > 0 {
		notes = append(notes, "优势："+ttJoinNotes(advSrc))
	}
	expr := "1d20"
	if hasAdv && !dis {
		expr = "2d20kh1"
	} else if dis && !hasAdv {
		expr = "2d20kl1"
	}
	if sb != 0 {
		expr += ttSigned(sb)
	}
	if conds["blessed"] {
		expr += "+1d4"
	} else if conds["baned"] {
		expr += "-1d4"
	}
	if lv := ttStatusLevel(it, "exhaustion"); lv > 0 {
		expr += ttSigned(-2 * lv)
	}
	r, err := RollTabletopDice(expr)
	return r, notes, err
}

// applyFight: ops "fight.save" (Mode conc: concentration save at DC; Mode status: the repeated save of the
// status named Text), "fight.dot" (ongoing damage of the status named Text) and "oa.hint" (IDs = [enemy, mover]).
func (room *TTRoom) applyFight(u ttUser, gm bool, req *ttOpRequest) (int, string) {
	sc := room.activeScene()
	if len(req.IDs) == 0 {
		return http.StatusBadRequest, "缺少目标"
	}
	it := sc.Items[req.IDs[0]]
	if it == nil || it["kind"] != "token" {
		return http.StatusBadRequest, "棋子不在当前场景"
	}
	owner, _ := it["owner"].(string)
	mine := gm || (owner != "" && owner == u.name)
	label := ttItemLabel(it)
	switch req.Op {
	case "fight.save":
		if !mine {
			return http.StatusForbidden, "只能替自己的棋子掷豁免"
		}
		var ab, title, statusName string
		var dc int
		var adv []string
		if req.Mode == "conc" {
			if !ttStatusIDs(it)["concentration"] {
				return http.StatusBadRequest, label + " 已经不在专注了"
			}
			ab, dc, title = "con", req.DC, "专注豁免"
			if dc < 10 {
				dc = 10
			}
			if dc > 30 {
				dc = 30
			}
			if ttSheetHas(room.tokenSheet(it), "战争施法者", "warcaster") {
				adv = append(adv, "战争施法者")
			}
		} else {
			st := ttStatusByName(it, req.Text)
			sv, _ := st["save"].(map[string]interface{})
			if sv == nil {
				return http.StatusBadRequest, "这个状态已经结束了"
			}
			ab, _ = sv["ab"].(string)
			v, _ := ttNum(sv["dc"])
			dc, statusName, title = int(v), req.Text, "「"+req.Text+"」豁免"
			if _, ok := ttAbilityCN[ab]; !ok || dc <= 0 {
				return http.StatusBadRequest, "状态的豁免设置不完整"
			}
		}
		r, notes, err := room.rollTokenSave(it, ab, adv)
		if err != nil {
			return http.StatusBadRequest, err.Error()
		}
		ok := r != nil && r.Total >= dc
		e := newLogEntry("roll", u.name)
		if req.Mode == "conc" && ttIDRe.MatchString(req.Text) {
			e.Ref = "conc:" + req.Text + ":" + req.IDs[0] // 这次受伤的专注豁免已经掷过：按钮不再显示
		}
		e.Label = ttCleanName(label+"·"+title+" DC "+strconv.Itoa(dc), 50, title)
		e.Roll = r
		e.Hidden = ttConcealed(it)
		res := "失败"
		if ok {
			res = "成功"
		} else if r == nil {
			res = "自动失败"
		}
		if req.Mode == "conc" {
			if ok {
				res += "，保持专注"
			} else {
				spell := ""
				if st := ttStatusByName(it, "专注"); st != nil {
					spell, _ = st["spell"].(string)
				}
				ttRemoveStatus(it, "concentration")
				res += "，专注结束" + map[bool]string{true: "（" + spell + "）", false: ""}[spell != ""]
				room.broadcastItems([]map[string]interface{}{it})
			}
		} else if ok {
			ttRemoveStatusNamed(it, statusName)
			res += "，「" + statusName + "」结束"
			room.broadcastItems([]map[string]interface{}{it})
		} else {
			res += "，「" + statusName + "」继续"
		}
		e.Text = strings.TrimSpace(res + " " + strings.Join(notes, " "))
		room.addLog(e)

	case "fight.dot":
		if !mine {
			return http.StatusForbidden, "只能替自己的棋子结算"
		}
		st := ttStatusByName(it, req.Text)
		dot, _ := st["dot"].(map[string]interface{})
		if dot == nil {
			return http.StatusBadRequest, "这个状态已经结束了"
		}
		dice, _ := dot["dice"].(string)
		typ, _ := dot["type"].(string)
		return room.applyAction(u, true, &ttOpRequest{Act: &TTActionReq{Name: req.Text + "（持续伤害）", Kind: "auto", Damage: dice, DamageType: typ,
			Targets: []TTActionTarget{{ID: req.IDs[0]}}}})

	case "fight.escape": // 挣脱擒抱：力量（运动）或敏捷（特技）检定，取高的，对抗擒抱时的 DC
		if !mine {
			return http.StatusForbidden, "只能替自己的棋子挣脱"
		}
		var st map[string]interface{}
		for _, m := range ttStatusMaps(it) {
			if m["id"] == "grappled" {
				st = m
			}
		}
		if st == nil {
			return http.StatusBadRequest, label + " 没有被擒抱"
		}
		dc := 0
		if v, ok := ttNum(st["dc"]); ok {
			dc = int(v)
		}
		if dc <= 0 && req.DC > 0 {
			dc = req.DC
		}
		if dc <= 0 {
			return http.StatusBadRequest, "不知道这次擒抱的 DC（在状态的 ⏱ 里设置，或由 GM 处理）"
		}
		sh := room.tokenSheet(it)
		best, how := -99, ""
		for _, c := range []struct{ skill, ab string }{{"运动", "str"}, {"特技", "dex"}} {
			v, found := 0, false
			for _, sk := range ttSheetList(sh, "skills") {
				if n, _ := sk["name"].(string); strings.Contains(n, c.skill) {
					if b, ok := ttNum(strings.ReplaceAll(ttStr(sk["bonus"]), "+", "")); ok {
						v, found = int(b), true
					}
				}
			}
			if !found {
				v = ttSheetAbilityMod(sh, c.ab)
			}
			if v > best {
				best, how = v, c.skill
			}
		}
		expr := "1d20"
		if lv := ttStatusLevel(it, "exhaustion"); lv > 0 {
			best -= 2 * lv
		}
		if best != 0 {
			expr += ttSigned(best)
		}
		r, err := RollTabletopDice(expr)
		if err != nil {
			return http.StatusBadRequest, err.Error()
		}
		e := newLogEntry("roll", u.name)
		e.Label = ttCleanName(label+"·挣脱擒抱（"+how+"）DC "+strconv.Itoa(dc), 50, "挣脱擒抱")
		e.Roll = r
		e.Hidden = ttConcealed(it)
		if r.Total >= dc {
			ttRemoveStatus(it, "grappled")
			room.broadcastItems([]map[string]interface{}{it})
			e.Text = "成功，挣脱了擒抱"
		} else {
			e.Text = "失败，仍被擒抱"
		}
		room.addLog(e)

	case "oa.hint":
		if len(req.IDs) < 2 || !room.setting("hintOA", true) {
			return 0, ""
		}
		mover := sc.Items[req.IDs[1]]
		if mover == nil {
			return http.StatusBadRequest, "棋子不在当前场景"
		}
		if mo, _ := mover["owner"].(string); !gm && (mo == "" || mo != u.name) {
			return http.StatusForbidden, "无权操作"
		}
		ref := "oa:" + req.IDs[0] + ":" + req.IDs[1]
		for i := len(room.Log) - 1; i >= 0 && i >= len(room.Log)-5; i-- { // 同一次移动不重复提示
			if room.Log[i].Ref == ref {
				return 0, ""
			}
		}
		e := newLogEntry("sys", "⚔")
		e.Text = ttItemLabel(mover) + " 离开了 " + label + " 的触及范围：" + label + " 可以用反应借机攻击"
		e.GMOnly = true
		e.For = owner
		e.Ref = ref
		room.addLog(e)
	}
	return 0, ""
}
