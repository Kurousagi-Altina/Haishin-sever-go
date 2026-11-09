package main

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// Actions (行动): an attack / spell / ability resolved against one or more tokens in one
// go — attack rolls vs AC, saving throws vs DC (half damage on success), damage with
// resistance / immunity / vulnerability, healing, temporary HP and conditions. Everything
// is rolled here; the client only chooses the targets (it computes areas, range and cover).

type TTActionTarget struct {
	ID       string `json:"id"`
	Cover    int    `json:"cover"`    // +2 / +5 to AC (attacks) or to Dex saves
	Mode     string `json:"mode"`     // attack roll: "" / adv / dis
	AutoCrit bool   `json:"autoCrit"` // paralysed / unconscious target within 5 ft
	Extra    string `json:"extra"`    // attacker's +1d4 (bless) / -1d4 (bane)
	Adj      int    `json:"adj"`      // attacker's flat adjustment (exhaustion)
}

type TTActionReq struct {
	Name          string                 `json:"name"`
	Kind          string                 `json:"kind"`   // attack / save / auto / heal / temp / effect
	Attack        string                 `json:"attack"` // attack bonus, "+5"
	Damage        string                 `json:"damage"` // damage / healing dice
	DamageType    string                 `json:"damageType"`
	Save          string                 `json:"save"` // str / dex / con / int / wis / cha
	DC            int                    `json:"dc"`
	Half          bool                   `json:"half"`
	Status        map[string]interface{} `json:"status"` // condition applied on hit / failed save / always
	Caster        string                 `json:"caster"` // token id
	Concentration bool                   `json:"concentration"`
	Targets       []TTActionTarget       `json:"targets"`
}

type TTActionHit struct {
	Name   string        `json:"name"`
	Attack *TTDiceResult `json:"attack,omitempty"`
	Hit    string        `json:"hit,omitempty"` // hit / miss / crit / fumble
	Save   *TTDiceResult `json:"save,omitempty"`
	Saved  string        `json:"saved,omitempty"` // yes / no / auto (automatic failure)
	Damage *TTDiceResult `json:"damage,omitempty"`
	Amount int           `json:"amount"` // HP change actually applied (−damage / +healing / temp HP)
	Note   string        `json:"note,omitempty"`
	Status string        `json:"status,omitempty"`
}

type TTActionResult struct {
	Name       string         `json:"name"`
	Caster     string         `json:"caster,omitempty"` // the acting token's name (when players may see it)
	Kind       string         `json:"kind"`
	Roll       *TTDiceResult  `json:"roll,omitempty"` // shared damage / healing roll (save, auto, heal, temp)
	DamageType string         `json:"damageType,omitempty"`
	Save       string         `json:"save,omitempty"`
	DC         int            `json:"dc,omitempty"`
	Targets    []*TTActionHit `json:"targets"`
	Note       string         `json:"note,omitempty"`
}

var (
	ttAbilityCN = map[string]string{"str": "力量", "dex": "敏捷", "con": "体质", "int": "智力", "wis": "感知", "cha": "魅力"}
	ttDiceTerm  = regexp.MustCompile(`(\d*)d(\d+)`)
)

func ttDoubleDice(expr string) string {
	return ttDiceTerm.ReplaceAllStringFunc(expr, func(m string) string {
		p := ttDiceTerm.FindStringSubmatch(m)
		n, _ := strconv.Atoi(p[1])
		if n == 0 {
			n = 1
		}
		return strconv.Itoa(n*2) + "d" + p[2]
	})
}

// ttStatusIDs lists the condition ids on a token (status list may be []interface{} or []map).
func ttStatusIDs(it map[string]interface{}) map[string]bool {
	out := map[string]bool{}
	add := func(m map[string]interface{}) {
		if id, _ := m["id"].(string); id != "" {
			out[id] = true
		}
	}
	switch v := it["status"].(type) {
	case []interface{}:
		for _, x := range v {
			if m, ok := x.(map[string]interface{}); ok {
				add(m)
			}
		}
	case []map[string]interface{}:
		for _, m := range v {
			add(m)
		}
	}
	return out
}

func ttStatusList(it map[string]interface{}) []interface{} {
	switch v := it["status"].(type) {
	case []interface{}:
		return v
	case []map[string]interface{}:
		out := make([]interface{}, 0, len(v))
		for _, m := range v {
			out = append(out, m)
		}
		return out
	}
	return nil
}

// addStatus puts (or refreshes) a condition on a token.
func ttAddStatus(it map[string]interface{}, st map[string]interface{}) {
	id, _ := st["id"].(string)
	list := ttStatusList(it)
	out := make([]interface{}, 0, len(list)+1)
	for _, x := range list {
		if m, ok := x.(map[string]interface{}); ok && m["id"] == id {
			continue
		}
		out = append(out, x)
	}
	cp := make(map[string]interface{}, len(st))
	for k, v := range st {
		cp[k] = v
	}
	if len(out) < 12 || id == "dead" || id == "stable" || id == "unconscious" {
		out = append(out, cp)
	}
	it["status"] = out
}

func (room *TTRoom) tokenSheet(it map[string]interface{}) map[string]interface{} {
	if id, _ := it["sheet"].(string); id != "" {
		return room.Sheets[id]
	}
	return nil
}

// saveBonus: the linked sheet's saving throw for the ability (else its modifier).
func (room *TTRoom) saveBonus(it map[string]interface{}, ability string) int {
	sh := room.tokenSheet(it)
	if sh == nil {
		return 0
	}
	var list []interface{}
	switch v := sh["abilities"].(type) {
	case []interface{}:
		list = v
	case []map[string]interface{}:
		for _, m := range v {
			list = append(list, m)
		}
	}
	for _, x := range list {
		a, ok := x.(map[string]interface{})
		if !ok || (a["key"] != ability && a["name"] != ttAbilityCN[ability]) {
			continue
		}
		if v, ok := ttNum(a["save"]); ok {
			return int(v)
		}
		if v, ok := ttNum(a["mod"]); ok {
			return int(v)
		}
	}
	return 0
}

// damageFactor reads 抗性 / 免疫 / 易伤 from the linked sheet's props for a damage type.
func (room *TTRoom) damageFactor(it map[string]interface{}, dtype string) (float64, string) {
	dtype = strings.TrimSuffix(strings.TrimSpace(dtype), "伤害")
	sh := room.tokenSheet(it)
	if sh == nil || dtype == "" {
		return 1, ""
	}
	var props []interface{}
	switch v := sh["props"].(type) {
	case []interface{}:
		props = v
	case []map[string]interface{}:
		for _, m := range v {
			props = append(props, m)
		}
	}
	resist, vuln := false, false
	for _, x := range props {
		p, ok := x.(map[string]interface{})
		if !ok {
			continue
		}
		label, _ := p["label"].(string)
		value, _ := p["value"].(string)
		if strings.Contains(label, "状态") {
			continue
		}
		// only unconditional entries: skip the part after "；" / "（非魔法…）" style qualifiers
		hit := false
		for _, part := range strings.FieldsFunc(value, func(r rune) bool { return r == '；' || r == ';' }) {
			if strings.Contains(part, dtype) && !strings.Contains(part, "非魔法") && !strings.Contains(part, "未被") && !strings.Contains(part, "除") {
				hit = true
			}
		}
		if !hit {
			continue
		}
		switch {
		case strings.Contains(label, "免疫"):
			return 0, "免疫" + dtype
		case strings.Contains(label, "抗性"):
			resist = true
		case strings.Contains(label, "易伤"):
			vuln = true
		}
	}
	switch {
	case resist && vuln:
		return -1, "抗性+易伤" // halve, then double
	case resist:
		return 0.5, "抗性"
	case vuln:
		return 2, "易伤"
	}
	return 1, ""
}

// applyHP changes a token's HP (temp HP absorbs damage first; healing is capped at max).
// Returns the HP change applied and whether the token has HP at all.
func ttApplyHP(it map[string]interface{}, delta int) (int, bool) {
	max, ok := ttNum(it["hpMax"])
	if !ok || max <= 0 {
		return 0, false
	}
	hp, ok := ttNum(it["hp"])
	if !ok {
		hp = max
	}
	temp, _ := ttNum(it["hpTemp"])
	before := hp
	if delta < 0 {
		dmg := float64(-delta)
		absorbed := temp
		if absorbed > dmg {
			absorbed = dmg
		}
		temp -= absorbed
		hp -= dmg - absorbed
		if hp < 0 {
			hp = 0
		}
	} else {
		hp += float64(delta)
		if hp > max {
			hp = max
		}
	}
	it["hp"] = hp
	if temp > 0 {
		it["hpTemp"] = temp
	} else {
		delete(it, "hpTemp")
	}
	if delta < 0 {
		return delta, true // damage taken counts in full (concentration etc.)
	}
	return int(hp - before), true
}

func (room *TTRoom) applyAction(u ttUser, gm bool, req *ttOpRequest) (int, string) {
	a := req.Act
	if a == nil || len(a.Targets) > 40 {
		return http.StatusBadRequest, "无效的行动"
	}
	sc := room.activeScene()
	res := &TTActionResult{Name: ttCleanName(a.Name, 40, "行动"), Kind: a.Kind, DamageType: ttCleanName(a.DamageType, 8, ""), Save: a.Save, DC: a.DC}
	if _, ok := ttAbilityCN[a.Save]; a.Kind == "save" && !ok {
		return http.StatusBadRequest, "请选择豁免属性"
	}
	if a.Kind == "attack" && strings.TrimSpace(a.Attack) == "" {
		a.Attack = "+0"
	}
	if a.Caster != "" {
		c := sc.Items[a.Caster]
		if c == nil || c["kind"] != "token" {
			a.Caster = ""
		} else if owner, _ := c["owner"].(string); !gm && (owner == "" || owner != u.name) {
			return http.StatusForbidden, "只能用自己控制的棋子行动"
		} else if !ttConcealed(c) && !ttInitHidden(c) {
			res.Caster = ttCleanName(ttItemLabel(c), 40, "")
		}
	}
	if a.Kind == "attack" && a.Damage != "" { // a crit doubles the dice: make sure that still rolls
		if _, err := RollTabletopDice(ttDoubleDice(a.Damage)); err != nil {
			return http.StatusBadRequest, err.Error()
		}
	}
	bonus, _ := ttNum(a.Attack)

	// one shared roll for area / save / healing effects
	var shared *TTDiceResult
	if a.Damage != "" && a.Kind != "attack" && a.Kind != "effect" {
		r, err := RollTabletopDice(a.Damage)
		if err != nil {
			return http.StatusBadRequest, err.Error()
		}
		shared = r
		res.Roll = r
	}
	var status map[string]interface{}
	if a.Status != nil {
		if id, _ := a.Status["id"].(string); ttIDRe.MatchString(id) {
			name, _ := a.Status["name"].(string)
			status = map[string]interface{}{"id": id, "name": ttCleanName(name, 12, "状态")}
			for _, k := range []string{"color", "icon"} {
				if s, _ := a.Status[k].(string); s != "" && len(s) <= 16 {
					status[k] = s
				}
			}
			if r, ok := ttNum(a.Status["rounds"]); ok && r > 0 {
				status["rounds"] = r
			}
		}
	}

	hidden := req.Hidden
	var changed []map[string]interface{}
	var undo []ttUndoRec
	seen := map[string]bool{}
	for _, t := range a.Targets {
		it := sc.Items[t.ID]
		if it == nil || it["kind"] != "token" || seen[t.ID] || (!gm && ttHiddenFrom(it, u.name)) {
			continue
		}
		seen[t.ID] = true
		undo = append(undo, ttSnapHP(sc, it))
		if ttBool(it["hidden"]) {
			hidden = true
		}
		hpBefore, hasHP := ttNum(it["hp"])
		if !hasHP { // no hp yet = full health
			hpBefore, _ = ttNum(it["hpMax"])
		}
		crit := false
		h := &TTActionHit{Name: ttCleanName(ttItemLabel(it), 40, "目标")}
		res.Targets = append(res.Targets, h)
		conds := ttStatusIDs(it)
		landed := false // the effect applies (hit / failed save / always)
		dmg := 0

		switch a.Kind {
		case "attack":
			expr := "1d20"
			switch t.Mode {
			case "adv":
				expr = "2d20kh1"
			case "dis":
				expr = "2d20kl1"
			}
			if bonus != 0 {
				expr += ttSigned(int(bonus))
			}
			if t.Extra == "+1d4" || t.Extra == "-1d4" {
				expr += t.Extra
			}
			if t.Adj != 0 && t.Adj >= -20 && t.Adj <= 20 {
				expr += ttSigned(t.Adj)
			}
			r, err := RollTabletopDice(expr)
			if err != nil {
				return http.StatusBadRequest, err.Error()
			}
			h.Attack = r
			nat := ttNaturalD20(r)
			ac, hasAC := ttNum(it["ac"])
			if hasAC && conds["hasted"] {
				ac += 2
			}
			cover := 0
			if t.Cover == 2 || t.Cover == 5 {
				cover = t.Cover
			}
			switch {
			case nat == 20:
				h.Hit = "crit"
			case nat == 1:
				h.Hit = "fumble"
			case !hasAC || ac <= 0:
				h.Hit = "hit"
				h.Note = "目标没有 AC，按命中处理"
			case float64(r.Total) >= ac+float64(cover):
				h.Hit = "hit"
			default:
				h.Hit = "miss"
			}
			if h.Hit == "hit" && t.AutoCrit {
				h.Hit = "crit"
			}
			landed = h.Hit == "hit" || h.Hit == "crit"
			crit = h.Hit == "crit"
			if landed && a.Damage != "" {
				expr := a.Damage
				if h.Hit == "crit" {
					expr = ttDoubleDice(expr)
				}
				d, err := RollTabletopDice(expr)
				if err != nil {
					return http.StatusBadRequest, err.Error()
				}
				h.Damage = d
				dmg = d.Total
			}

		case "save":
			sb := room.saveBonus(it, a.Save)
			if a.Save == "dex" && (t.Cover == 2 || t.Cover == 5) {
				sb += t.Cover
			}
			autoFail := (a.Save == "str" || a.Save == "dex") && (conds["paralyzed"] || conds["stunned"] || conds["unconscious"] || conds["petrified"])
			if autoFail {
				h.Saved = "auto"
			} else {
				// advantage / disadvantage from the target's conditions (they cancel out)
				adv := a.Save == "dex" && (conds["hasted"] || conds["dodging"])
				dis := a.Save == "dex" && conds["restrained"]
				expr := "1d20"
				if adv && !dis {
					expr = "2d20kh1"
				} else if dis && !adv {
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
				if err != nil {
					return http.StatusBadRequest, err.Error()
				}
				h.Save = r
				if r.Total >= a.DC {
					h.Saved = "yes"
				} else {
					h.Saved = "no"
				}
			}
			landed = h.Saved != "yes"
			if shared != nil {
				dmg = shared.Total
				if !landed {
					if a.Half {
						dmg /= 2
					} else {
						dmg = 0
					}
				}
			}

		case "auto":
			landed = true
			if shared != nil {
				dmg = shared.Total
			}

		case "heal", "temp", "effect":
			landed = true

		default:
			return http.StatusBadRequest, "未知的行动类型"
		}

		// damage → resistances → HP
		if dmg > 0 {
			f, note := room.damageFactor(it, a.DamageType)
			if f == -1 {
				dmg = (dmg / 2) * 2
			} else if f != 1 {
				dmg = int(float64(dmg) * f)
			}
			if note != "" {
				h.Note = strings.TrimSpace(h.Note + " " + note)
			}
			if applied, ok := ttApplyHP(it, -dmg); ok {
				h.Amount = applied
				changed = append(changed, it)
				if hpBefore <= 0 && dmg > 0 {
					if note := ttDamageAtZero(it, dmg, crit); note != "" {
						h.Note = strings.TrimSpace(h.Note + " " + note)
					}
				} else if note := room.dropToZero(it, hpBefore, dmg); note != "" {
					h.Note = strings.TrimSpace(h.Note + " " + note)
				}
			} else {
				h.Amount = -dmg
				h.Note = strings.TrimSpace(h.Note + " 没有血量，未扣除")
			}
			if dmg > 0 && conds["concentration"] {
				dc := dmg / 2
				if dc < 10 {
					dc = 10
				}
				if dc > 30 {
					dc = 30
				}
				h.Note = strings.TrimSpace(h.Note + " 需专注豁免 DC " + strconv.Itoa(dc))
			}
		}
		switch {
		case a.Kind == "heal" && shared != nil:
			heal := shared.Total
			if heal < 0 {
				heal = 0
			}
			if conds["dead"] {
				h.Note = "已经死亡，治疗无效"
			} else if applied, ok := ttApplyHP(it, heal); ok {
				h.Amount = applied
				changed = append(changed, it)
				if hp, _ := ttNum(it["hp"]); hp > 0 { // back on their feet: death saves reset
					delete(it, "ds")
					ttRemoveStatus(it, "stable", "unconscious")
				}
			}
		case a.Kind == "temp" && shared != nil:
			cur, _ := ttNum(it["hpTemp"])
			if float64(shared.Total) > cur {
				it["hpTemp"] = float64(shared.Total)
				h.Amount = shared.Total
				changed = append(changed, it)
			} else {
				h.Note = "已有更多临时生命，不叠加"
			}
		}
		if landed && status != nil {
			ttAddStatus(it, status)
			h.Status, _ = status["name"].(string)
			changed = append(changed, it)
		}
	}

	// concentration on the caster
	if a.Concentration && a.Caster != "" {
		if c := sc.Items[a.Caster]; c != nil && c["kind"] == "token" {
			if !seen[a.Caster] {
				undo = append(undo, ttSnapHP(sc, c))
			}
			ttAddStatus(c, map[string]interface{}{"id": "concentration", "name": "专注", "color": "#4682b4", "icon": "🧠"})
			changed = append(changed, c)
			if ttConcealed(c) {
				hidden = true // a hidden caster isn't revealed by the log
			} else {
				res.Note = ttItemLabel(c) + " 开始专注"
			}
		}
	}

	if len(changed) > 0 {
		uniq := map[string]bool{}
		var list []map[string]interface{}
		for _, it := range changed {
			if id, _ := it["id"].(string); !uniq[id] {
				uniq[id] = true
				list = append(list, it)
			}
		}
		room.broadcastItems(list)
	}
	e := newLogEntry("action", u.name)
	e.Label = res.Name
	e.Act = res
	e.Hidden = hidden
	room.addLog(e)
	if len(changed) > 0 {
		room.rememberUndo(e.ID, undo)
	}
	return 0, ""
}

// ===== GM: undo a resolved action =====

// ttUndoRec: one token's HP / temp HP / conditions / death saves before an action changed them.
type ttUndoRec struct {
	scene *TTScene
	id    string
	vals  map[string]interface{} // nil value = the key was absent
}

var ttUndoKeys = []string{"hp", "hpTemp", "status", "ds"}

func ttSnapHP(sc *TTScene, it map[string]interface{}) ttUndoRec {
	r := ttUndoRec{scene: sc, id: it["id"].(string), vals: map[string]interface{}{}}
	for _, k := range ttUndoKeys {
		v, ok := it[k]
		if !ok {
			r.vals[k] = nil
			continue
		}
		var cp interface{} // deep copy (status lists / ds maps are mutated in place later)
		if b, err := json.Marshal(v); err == nil && json.Unmarshal(b, &cp) == nil {
			r.vals[k] = cp
		}
	}
	return r
}

func (room *TTRoom) rememberUndo(id string, recs []ttUndoRec) {
	if room.actUndo == nil {
		room.actUndo = map[string][]ttUndoRec{}
	}
	room.actUndo[id] = recs
	room.actUndoOrder = append(room.actUndoOrder, id)
	if len(room.actUndoOrder) > 30 {
		delete(room.actUndo, room.actUndoOrder[0])
		room.actUndoOrder = room.actUndoOrder[1:]
	}
}

func (room *TTRoom) undoAction(u ttUser, logID string) (int, string) {
	recs, ok := room.actUndo[logID]
	if !ok {
		return http.StatusBadRequest, "这次结算已经撤销过，或者太久远（只保留最近 30 次）"
	}
	delete(room.actUndo, logID)
	name := "行动"
	for _, e := range room.Log {
		if e.ID == logID && e.Act != nil {
			name = e.Act.Name
		}
	}
	active := room.activeScene()
	var changed []map[string]interface{}
	for _, r := range recs {
		it := r.scene.Items[r.id]
		if it == nil {
			continue
		}
		for k, v := range r.vals {
			if v == nil {
				delete(it, k)
			} else {
				it[k] = v
			}
		}
		if r.scene == active {
			changed = append(changed, it)
		}
	}
	if len(changed) > 0 {
		room.broadcastItems(changed)
	}
	e := newLogEntry("sys", u.name)
	e.Text = "撤销了「" + name + "」的结算（生命值、状态已恢复）"
	room.addLog(e)
	return 0, ""
}

// dropToZero: a creature knocked from above 0 to 0 HP. Player characters fall unconscious
// (or die outright when the leftover damage reaches their HP maximum); GM creatures die.
// Concentration ends either way.
func (room *TTRoom) dropToZero(it map[string]interface{}, hpBefore float64, dmg int) string {
	hp, _ := ttNum(it["hp"])
	if hp > 0 || hpBefore <= 0 {
		return ""
	}
	ttRemoveStatus(it, "concentration")
	owner, _ := it["owner"].(string)
	pc := owner != ""
	if sh := room.tokenSheet(it); sh != nil && sh["kind"] == "pc" {
		pc = true
	}
	if !pc {
		ttAddStatus(it, ttDeadStatus)
		return "倒下了"
	}
	max, _ := ttNum(it["hpMax"])
	if max > 0 && float64(dmg)-hpBefore >= max {
		ttAddStatus(it, ttDeadStatus)
		return "溢出伤害不低于生命上限：当场死亡"
	}
	ttAddStatus(it, ttUnconsciousStatus)
	return "倒地昏迷，需要死亡豁免"
}

var ttUnconsciousStatus = map[string]interface{}{"id": "unconscious", "name": "昏迷", "color": "#5d4037", "icon": "😵"}

// ttStatusLevel: level of a stacking condition (exhaustion), 0 when absent.
func ttStatusLevel(it map[string]interface{}, id string) int {
	for _, x := range ttStatusList(it) {
		if m, ok := x.(map[string]interface{}); ok && m["id"] == id {
			if lv, ok := ttNum(m["lv"]); ok && lv >= 1 {
				return int(lv)
			}
			return 1
		}
	}
	return 0
}
