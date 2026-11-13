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
	Note     string `json:"note"`     // judgement notes from the client (神射手 ignoring cover etc.)
	// set by the server only (手动豁免结算): "yes" / "no" = the player's own roll, "roll" = roll it now even if the token saves manually
	Forced string `json:"-"`
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
	Spell         bool                   `json:"spell"`     // a spell (Magic Resistance etc.)
	Magic         bool                   `json:"magic"`     // a magical attack / effect (beats 非魔法 resistances; spells always are)
	School        string                 `json:"school"`    // spell school (防护 / 咒法 / … ) for school-specific save advantage
	Parts         []TTDamagePart         `json:"parts"`     // extra damage of other types (weapon + 2d6 火焰, 冰风暴's 钝击 + 寒冷)
	Mastery       string                 `json:"mastery"`   // weapon mastery (2024): 侵扰 / 削弱 / 失衡 / 推离 / 擦掠 / 横扫 / 缓速 / 迅击
	SlotLevel     int                    `json:"slotLevel"` // spell slot spent on it (法术反制 gives it back)
	Melee         bool                   `json:"melee"`     // a melee attack (防御式决斗, 顺势斩)
	OnceDice      string                 `json:"onceDice"`  // 多目标攻击只加一次的骰子（奥法火器 +1d8）：加在第一个命中的目标上
	Targets       []TTActionTarget       `json:"targets"`
	Ref           string                 `json:"-"` // server only: log ref of the resulting entry (手动豁免结算)
}

// TTDamagePart: one extra damage component, resisted separately.
type TTDamagePart struct {
	Dice string `json:"dice"`
	Type string `json:"type"`
}

// TTPartRoll: a shared roll of an extra damage component (save / auto actions).
type TTPartRoll struct {
	Type string        `json:"type"`
	Roll *TTDiceResult `json:"roll"`
}

type TTActionHit struct {
	ID     string          `json:"id,omitempty"` // token id (reactions refer to it)
	Name   string          `json:"name"`
	Attack *TTDiceResult   `json:"attack,omitempty"`
	Hit    string          `json:"hit,omitempty"` // hit / miss / crit / fumble
	Save   *TTDiceResult   `json:"save,omitempty"`
	Saved  string          `json:"saved,omitempty"` // yes / no / auto (automatic failure)
	Damage *TTDiceResult   `json:"damage,omitempty"`
	Parts  []*TTDiceResult `json:"parts,omitempty"` // extra damage components (attack rolls)
	Phys   bool            `json:"phys,omitempty"`  // the damage included 钝击 / 穿刺 / 挥砍 (Deflect Attacks)
	Cover  int             `json:"cover,omitempty"` // cover bonus used against the attack (Shield re-check)
	Amount int             `json:"amount"`          // HP change actually applied (−damage / +healing / temp HP)
	Note   string          `json:"note,omitempty"`
	Status string          `json:"status,omitempty"`
	Types  map[string]int  `json:"types,omitempty"` // damage dealt per type after resistances (吸收元素)
}

type TTActionResult struct {
	Name       string        `json:"name"`
	Caster     string        `json:"caster,omitempty"` // the acting token's name (when players may see it)
	Kind       string        `json:"kind"`
	Roll       *TTDiceResult `json:"roll,omitempty"` // shared damage / healing roll (save, auto, heal, temp)
	DamageType string        `json:"damageType,omitempty"`
	Save       string        `json:"save,omitempty"`
	DC         int           `json:"dc,omitempty"`
	Parts      []TTPartRoll  `json:"parts,omitempty"` // shared rolls of the extra damage components
	Magic      bool          `json:"magic,omitempty"`
	Half       bool          `json:"half,omitempty"`      // save for half damage (Legendary Resistance re-resolves with it)
	Mastery    string        `json:"mastery,omitempty"`   // weapon mastery of the attack (the client offers its follow-up)
	CasterID   string        `json:"casterId,omitempty"`  // acting token id (push direction, Vex)
	Spell      bool          `json:"spell,omitempty"`     // a spell (法术反制 can answer it)
	SlotLevel  int           `json:"slotLevel,omitempty"` // slot level spent on the spell
	Melee      bool          `json:"melee,omitempty"`     // a melee attack
	// the attack / save's damage dice, extra parts and condition (导引打击 / 预兆 re-apply a miss or a failed save)
	DmgExpr   string                 `json:"dmgExpr,omitempty"`
	DmgParts  []TTDamagePart         `json:"dmgParts,omitempty"`
	StatusDef map[string]interface{} `json:"statusDef,omitempty"`
	Targets   []*TTActionHit         `json:"targets"`
	Note      string                 `json:"note,omitempty"`
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

// ttDamageAliases: the 2014 and 2024 Chinese translations spell some damage types differently.
var ttDamageAliases = map[string]string{"黯蚀": "暗蚀", "暗蚀": "黯蚀"}

// ttHasDamageType reports whether a resistance / immunity text mentions dtype (or its alias).
func ttHasDamageType(text, dtype string) bool {
	if strings.Contains(text, dtype) {
		return true
	}
	alt, ok := ttDamageAliases[dtype]
	return ok && strings.Contains(text, alt)
}

// damageFactor reads 抗性 / 免疫 / 易伤 from the linked sheet's props for a damage type.
// Qualified entries: 「非魔法攻击造成的钝击、穿刺和挥砍伤害」 apply only to non-magical attacks;
// 「除力场、心灵外的所有伤害」 applies to every type it doesn't list.
func (room *TTRoom) damageFactor(it map[string]interface{}, dtype string, magic bool) (float64, string) {
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
	resist, vuln, skipped := false, false, ""
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
		hit, qual := false, ""
		for _, part := range strings.FieldsFunc(value, func(r rune) bool { return r == '；' || r == ';' }) {
			nonmagic := strings.Contains(part, "非魔法") || strings.Contains(part, "未被魔法") || strings.Contains(part, "非魔化")
			allExcept := (strings.Contains(part, "所有") || strings.Contains(part, "全部")) && strings.Contains(part, "除")
			var match bool
			if allExcept {
				match = strings.Contains(part, "伤害") && !ttHasDamageType(part, dtype)
			} else {
				// 「…，镀银武器除外」 style qualifiers on a non-magic entry are ignored (weapon material isn't tracked)
				match = ttHasDamageType(part, dtype) && (nonmagic || !strings.Contains(part, "除"))
			}
			if !match {
				continue
			}
			if nonmagic && magic {
				skipped = label
				continue
			}
			hit = true
			if nonmagic {
				qual = "（非魔法）"
			}
		}
		if !hit {
			continue
		}
		switch {
		case strings.Contains(label, "免疫"):
			return 0, "免疫" + dtype + qual
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
	case skipped != "":
		return 1, "魔法攻击，无视非魔法" + skipped
	}
	return 1, ""
}

func ttScaleDmg(v int, s float64) int {
	switch s {
	case 0:
		return 0
	case 0.5:
		return v / 2
	}
	return v
}

func ttPhysicalType(t string) bool {
	t = strings.TrimSuffix(strings.TrimSpace(t), "伤害")
	return t == "钝击" || t == "穿刺" || t == "挥砍"
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
	res := &TTActionResult{Name: ttCleanName(a.Name, 40, "行动"), Kind: a.Kind, DamageType: ttCleanName(a.DamageType, 8, ""), Save: a.Save, DC: a.DC, Half: a.Half,
		Mastery: ttCleanName(a.Mastery, 8, ""), Spell: a.Spell, Melee: a.Kind == "attack" && a.Melee}
	if a.Spell && a.SlotLevel >= 1 && a.SlotLevel <= 9 {
		res.SlotLevel = a.SlotLevel
	}
	if a.Kind == "attack" || a.Kind == "save" {
		res.DmgExpr, res.DmgParts, res.StatusDef = a.Damage, a.Parts, a.Status
	}
	if _, ok := ttAbilityCN[a.Save]; a.Kind == "save" && !ok && a.Save != "strdex" { // strdex：力量或敏捷，目标选高的（擒抱 / 推撞）
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
			res.CasterID = a.Caster
		}
	}
	if a.OnceDice != "" {
		if _, err := RollTabletopDice(a.OnceDice); err != nil || len(a.OnceDice) > 20 {
			a.OnceDice = ""
		}
	}
	onceUsed := false
	if a.Kind == "attack" && a.Damage != "" { // a crit doubles the dice: make sure that still rolls
		if _, err := RollTabletopDice(ttDoubleDice(a.Damage)); err != nil {
			return http.StatusBadRequest, err.Error()
		}
	}
	bonus, _ := ttNum(a.Attack)
	var parts []TTDamagePart
	if a.Kind == "attack" || a.Kind == "save" || a.Kind == "auto" {
		for _, p := range a.Parts {
			d := strings.ReplaceAll(strings.TrimSpace(p.Dice), " ", "")
			if d == "" || len(parts) >= 4 {
				continue
			}
			test := d
			if a.Kind == "attack" {
				test = ttDoubleDice(d)
			}
			if _, err := RollTabletopDice(test); err != nil {
				return http.StatusBadRequest, "附加伤害：" + err.Error()
			}
			parts = append(parts, TTDamagePart{Dice: d, Type: ttCleanName(strings.TrimSuffix(strings.TrimSpace(p.Type), "伤害"), 8, "")})
		}
	}
	magic := a.Magic || a.Spell
	res.Magic = magic
	var sharedParts []*TTDiceResult
	if a.Kind == "save" || a.Kind == "auto" {
		for _, p := range parts {
			r, err := RollTabletopDice(p.Dice)
			if err != nil {
				return http.StatusBadRequest, err.Error()
			}
			sharedParts = append(sharedParts, r)
			res.Parts = append(res.Parts, TTPartRoll{Type: p.Type, Roll: r})
		}
	}

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
			ttCopyStatusExtras(status, a.Status)
			// 「直到施放者的下一回合结束 / 开始」：记下施放者和施加时的回合（战斗中才有意义）
			if ex, ok := a.Status["exp"].(map[string]interface{}); ok && a.Caster != "" {
				if c, _ := sc.Props["combat"].(map[string]interface{}); c != nil {
					when := "end"
					if ex["when"] == "start" {
						when = "start"
					}
					status["exp"] = map[string]interface{}{"id": a.Caster, "when": when, "k": ttCombatTurnKey(c)}
					delete(status, "rounds")
				}
			}
		}
	}

	mageSlayer := false // 巫师杀手：被它伤害的专注者，专注豁免劣势
	if a.Caster != "" {
		if c := sc.Items[a.Caster]; c != nil {
			mageSlayer = ttSheetHas(room.tokenSheet(c), "巫师杀手", "法师杀手", "mageslayer")
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
		h := &TTActionHit{ID: t.ID, Name: ttCleanName(ttItemLabel(it), 40, "目标")}
		res.Targets = append(res.Targets, h)
		conds := ttStatusIDs(it)
		tr := room.traitsOf(it)
		addNote := func(s string) {
			if s != "" {
				h.Note = strings.TrimSpace(h.Note + " " + s)
			}
		}
		addNote(ttCleanName(t.Note, 80, ""))
		landed := false // the effect applies (hit / failed save / always)
		dmg := 0
		var extra []int // amounts of the extra damage parts (same order as parts)
		statusID := ""
		if status != nil {
			statusID, _ = status["id"].(string)
		}

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
			if hasAC && tr.ac != 0 {
				ac += float64(tr.ac)
				addNote("AC " + ttJoinNotes(tr.acSrc))
			}
			cover := 0
			if t.Cover == 2 || t.Cover == 5 {
				cover = t.Cover
			}
			h.Cover = cover
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
				if a.OnceDice != "" && !onceUsed {
					expr += "+" + a.OnceDice
					onceUsed = true
				}
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
			if landed {
				for _, p := range parts {
					expr := p.Dice
					if crit {
						expr = ttDoubleDice(expr)
					}
					d, err := RollTabletopDice(expr)
					if err != nil {
						return http.StatusBadRequest, err.Error()
					}
					h.Parts = append(h.Parts, d)
					extra = append(extra, d.Total)
				}
			}

		case "save":
			if t.Forced == "" && ttBool(it["manualSave"]) { // 这个角色自己掷豁免：先不结算，记录里提示
				h.Saved = "pending"
				addNote("等玩家自己掷豁免")
				continue
			}
			ab := a.Save
			if ab == "strdex" { // 擒抱 / 推撞：目标自己选力量或敏捷豁免 → 用加值高的那个
				ab = "str"
				if room.saveBonus(it, "dex") > room.saveBonus(it, "str") {
					ab = "dex"
				}
				addNote("选择" + ttAbilityCN[ab] + "豁免")
			}
			sb := room.saveBonus(it, ab)
			if ab == "dex" && (t.Cover == 2 || t.Cover == 5) {
				sb += t.Cover
			}
			autoFail := (ab == "str" || ab == "dex") && (conds["paralyzed"] || conds["stunned"] || conds["unconscious"] || conds["petrified"])
			if t.Forced == "yes" || t.Forced == "no" { // 玩家用自己的骰子掷的结果
				h.Saved = t.Forced
				addNote(map[bool]string{true: "玩家自己掷：成功", false: "玩家自己掷：失败"}[t.Forced == "yes"])
			} else if autoFail {
				h.Saved = "auto"
			} else {
				// advantage / disadvantage from the target's conditions and traits (they cancel out)
				more, bonusNotes, advSrc := tr.saveMods(ab, a.Spell, magic, a.School, statusID, conds)
				sb += more
				if conds["lucky"] { // 幸运：用掉一个幸运点换来的优势
					advSrc = append(advSrc, "幸运")
					ttRemoveStatus(it, "lucky")
					changed = append(changed, it)
				}
				adv := ab == "dex" && (conds["hasted"] || conds["dodging"]) || len(advSrc) > 0
				dis := ab == "dex" && conds["restrained"]
				if len(bonusNotes) > 0 {
					addNote("豁免 " + ttJoinNotes(bonusNotes))
				}
				if len(advSrc) > 0 {
					addNote("优势：" + ttJoinNotes(advSrc))
				}
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
			if h.Saved == "no" && tr.legendary {
				addNote("可用传奇抗性改为成功（GM 撤销后手动结算）")
			}
			// Evasion: a Dex save for half damage → no damage on a success, half on a failure
			evasion := tr.evasion != "" && ab == "dex" && a.Half && !ttIncapacitated(conds)
			hasDmg := shared != nil || len(sharedParts) > 0
			scale := 1.0 // applies to every damage part
			switch {
			case evasion && !landed:
				scale = 0
				if hasDmg {
					addNote(tr.evasion + "：成功不受伤害")
				}
			case evasion:
				scale = 0.5
				if hasDmg {
					addNote(tr.evasion + "：失败只受一半")
				}
			case !landed && a.Half:
				scale = 0.5
			case !landed:
				scale = 0
			}
			if shared != nil {
				dmg = ttScaleDmg(shared.Total, scale)
			}
			for _, r := range sharedParts {
				extra = append(extra, ttScaleDmg(r.Total, scale))
			}

		case "auto":
			landed = true
			if shared != nil {
				dmg = shared.Total
			}
			for _, r := range sharedParts {
				extra = append(extra, r.Total)
			}

		case "heal", "temp", "effect":
			landed = true

		default:
			return http.StatusBadRequest, "未知的行动类型"
		}

		// damage → resistances (each part by its own type) → HP
		if dmg > 0 || len(extra) > 0 {
			types := []string{a.DamageType}
			amts := []int{dmg}
			for i, v := range extra {
				types = append(types, parts[i].Type)
				amts = append(amts, v)
			}
			total, noted := 0, map[string]bool{}
			for i, amt := range amts {
				if amt <= 0 {
					continue
				}
				if ttPhysicalType(types[i]) {
					h.Phys = true
				}
				f, note := room.damageFactor(it, types[i], magic)
				f, note = tr.damageMod(f, note, types[i], magic)
				if f == -1 {
					amt = (amt / 2) * 2
				} else if f != 1 {
					amt = int(float64(amt) * f)
				}
				if note != "" {
					if ty := strings.TrimSuffix(types[i], "伤害"); len(amts) > 1 && ty != "" && !strings.Contains(note, ty) {
						if strings.HasPrefix(note, "抗性") || strings.HasPrefix(note, "易伤") {
							note = ty + note // 「挥砍抗性」
						} else {
							note = ty + "：" + note // 「挥砍：魔法攻击，无视非魔法抗性」
						}
					}
					if !noted[note] {
						noted[note] = true
						addNote(note)
					}
				}
				if amt > 0 { // 按类型记下实际造成的伤害（吸收元素按这个减半）
					if h.Types == nil {
						h.Types = map[string]int{}
					}
					ty := strings.TrimSuffix(strings.TrimSpace(types[i]), "伤害")
					if ty == "" {
						ty = "无类型"
					}
					h.Types[ty] += amt
				}
				total += amt
			}
			dmg = total
		}
		if dmg > 0 {
			if applied, ok := ttApplyHP(it, -dmg); ok {
				h.Amount = applied
				changed = append(changed, it)
				if hpBefore <= 0 && dmg > 0 {
					if note := ttDamageAtZero(it, dmg, crit, room.isPC(it)); note != "" {
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
				if mageSlayer {
					h.Note += "（巫师杀手：劣势）"
				}
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
		if landed && status != nil && tr.condImmune[statusID] != "" {
			name, _ := status["name"].(string)
			addNote("免疫" + name + ttSrcTag(tr.condImmune[statusID]))
		} else if landed && status != nil {
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
			ttAddStatus(c, map[string]interface{}{"id": "concentration", "name": "专注", "color": "#4682b4", "icon": "🧠", "spell": a.Name})
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
	e.Ref = a.Ref
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
	name, ok := room.revertAction(logID)
	if !ok {
		return http.StatusBadRequest, "这次结算已经撤销过，或者太久远（只保留最近 30 次）"
	}
	e := newLogEntry("sys", u.name)
	e.Text = "撤销了「" + name + "」的结算（生命值、状态已恢复）"
	room.addLog(e)
	return 0, ""
}

// revertAction restores the tokens an action touched to their state before it (GM undo, 法术反制).
func (room *TTRoom) revertAction(logID string) (string, bool) {
	recs, ok := room.actUndo[logID]
	if !ok {
		return "", false
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
	return name, true
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
	if !room.isPC(it) { // 非玩家角色没有死亡豁免：直接死亡
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

// ttCopyStatusExtras keeps the validated extras of a status sent with an action: repeated save
// (save {ab, dc, when}), ongoing damage (dot {dice, type, when}) and a grapple's escape DC / grappler (dc, by).
func ttCopyStatusExtras(dst, src map[string]interface{}) {
	if sv, ok := src["save"].(map[string]interface{}); ok {
		ab, _ := sv["ab"].(string)
		dc, _ := ttNum(sv["dc"])
		if _, known := ttAbilityCN[ab]; known && dc > 0 && dc <= 40 {
			when := "end"
			if sv["when"] == "start" {
				when = "start"
			}
			dst["save"] = map[string]interface{}{"ab": ab, "dc": dc, "when": when}
		}
	}
	if dot, ok := src["dot"].(map[string]interface{}); ok {
		dice, _ := dot["dice"].(string)
		typ, _ := dot["type"].(string)
		if _, err := RollTabletopDice(dice); err == nil && len(dice) <= 20 {
			when := "start"
			if dot["when"] == "end" {
				when = "end"
			}
			dst["dot"] = map[string]interface{}{"dice": dice, "type": ttCleanName(typ, 8, ""), "when": when}
		}
	}
	if dc, ok := ttNum(src["dc"]); ok && dc > 0 && dc <= 40 {
		dst["dc"] = dc
	}
	if by, _ := src["by"].(string); ttIDRe.MatchString(by) {
		dst["by"] = by
	}
}
