package main

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// Judgement modifiers (判定修正): everything about a creature that changes how an action
// resolves against it — Evasion, save bonuses / advantage (Magic Resistance, Danger Sense,
// Fey Ancestry, Aura of Protection, items), extra damage resistances / immunities /
// vulnerabilities, condition immunities and extra AC. Three sources are merged:
//   1. the sheet's manual list `mods` (players / GM add them in the 判定修正 section);
//   2. traits recognised by NAME on the sheet (features / stat block entries / props) —
//      ttAutoTraits below, mirrored for display by autoMods() in www/js/tabletop-sheets.js;
//      Magic Resistance-like traits read their TEXT for the scope (which saves, against what);
//   3. the token's conditions (raging, petrified).
// Every modifier that changes a result is named in the action log, so nothing is silent.
// Reactions after a hit (拨挡攻击 / 直觉闪避 / 盾牌术) are at the bottom (op action.react).

type ttSaveAdv struct {
	ab    string // ability key, or "all"
	vs    string // "" = always, "spell" = against spells, "magic" = spells and magical effects, "school:<学派>", else a status id
	noInc bool   // not while incapacitated (Danger Sense)
	src   string
}

type ttTraits struct {
	evasion    string // source name; "" = none
	saveBonus  map[string]int
	bonusSrc   map[string][]string
	saveAdv    []ttSaveAdv
	resist     map[string]string // damage type (or "全部") -> source
	immune     map[string]string
	vuln       map[string]string
	nonmagic   map[string]bool   // "resist:火焰" etc.: only against non-magical attacks
	condImmune map[string]string // status id -> source
	ac         int
	acSrc      []string
	legendary  bool
}

func newTTTraits() *ttTraits {
	return &ttTraits{saveBonus: map[string]int{}, bonusSrc: map[string][]string{}, resist: map[string]string{}, immune: map[string]string{},
		vuln: map[string]string{}, nonmagic: map[string]bool{}, condImmune: map[string]string{}}
}

// condition names (2014 / 2024 translations) -> status ids
var ttCondNames = map[string]string{
	"目盲": "blinded", "魅惑": "charmed", "耳聋": "deafened", "力竭": "exhaustion", "恐慌": "frightened", "恐惧": "frightened",
	"受擒": "grappled", "擒抱": "grappled", "失能": "incapacitated", "隐形": "invisible", "麻痹": "paralyzed", "石化": "petrified",
	"中毒": "poisoned", "倒地": "prone", "束缚": "restrained", "震慑": "stunned", "昏迷": "unconscious",
}

var ttPhysical = []string{"钝击", "穿刺", "挥砍"}

var ttSchools = []string{"防护", "咒法", "预言", "附魔", "塑能", "幻术", "死灵", "变化"}

// ttAdvScope reads a save-advantage trait's text: which saves (abilities named next to 豁免,
// else defAb) against what (schools, conditions, 魔法 → spells and magical effects, 法术 → spells).
func ttAdvScope(text, src string, defAb []string, defVs string) []ttSaveAdv {
	seg := ""
	for _, s := range strings.FieldsFunc(text, func(r rune) bool { return r == '。' || r == '\n' }) {
		if strings.Contains(s, "豁免") {
			seg = s
			break
		}
	}
	var abs []string
	for _, k := range []string{"str", "dex", "con", "int", "wis", "cha"} {
		if seg != "" && strings.Contains(seg, ttAbilityCN[k]) {
			abs = append(abs, k)
		}
	}
	if len(abs) == 0 {
		abs = defAb
	}
	var vs []string
	for _, s := range ttSchools {
		if strings.Contains(seg, s+"学派") || strings.Contains(seg, s+"系") || strings.Contains(seg, s+"法术") {
			vs = append(vs, "school:"+s)
		}
	}
	for cn, id := range ttCondNames {
		if strings.Contains(seg, cn) {
			vs = append(vs, id)
		}
	}
	if len(vs) == 0 {
		switch {
		case seg == "":
			vs = []string{defVs}
		case strings.Contains(seg, "魔法"):
			vs = []string{"magic"}
		case strings.Contains(seg, "法术"):
			vs = []string{"spell"}
		default:
			vs = []string{""}
		}
	}
	var out []ttSaveAdv
	for _, ab := range abs {
		for _, v := range vs {
			out = append(out, ttSaveAdv{ab: ab, vs: v, src: src})
		}
	}
	return out
}

// ttAutoTraits: traits recognised by name. exact = the cleaned name must equal one of the
// names (for short words like 闪避 / 勇气 that also appear inside unrelated names).
// Keep in sync with AUTO_TRAITS in www/js/tabletop-sheets.js.
var ttAutoTraits = []struct {
	names []string
	exact bool
	skip  []string // a name containing one of these is not this trait
	apply func(t *ttTraits, src, text string, sh map[string]interface{})
}{
	{[]string{"反射闪避", "引导闪避", "evasion", "leadingevasion"}, false, []string{"戒指", "ring"}, func(t *ttTraits, src, _ string, _ map[string]interface{}) { t.evasion = src }},
	{[]string{"闪避"}, true, nil, func(t *ttTraits, src, _ string, _ map[string]interface{}) { t.evasion = src }},
	{[]string{"侏儒魔法抗性", "侏儒狡黠", "gnomishcunning", "gnomishmagicresistance"}, false, nil, func(t *ttTraits, src, text string, _ map[string]interface{}) {
		t.saveAdv = append(t.saveAdv, ttAdvScope(text, src, []string{"int", "wis", "cha"}, "")...)
	}},
	{[]string{"魔法抗性", "magicresistance"}, false, []string{"侏儒", "gnomish"}, func(t *ttTraits, src, text string, _ map[string]interface{}) {
		t.saveAdv = append(t.saveAdv, ttAdvScope(text, src, []string{"all"}, "magic")...)
	}},
	{[]string{"危机感应", "dangersense"}, false, nil, func(t *ttTraits, src, _ string, _ map[string]interface{}) {
		t.saveAdv = append(t.saveAdv, ttSaveAdv{ab: "dex", noInc: true, src: src})
	}},
	{[]string{"矮人体魄", "矮人抗性", "矮人韧性", "dwarvenresilience"}, false, nil, func(t *ttTraits, src, _ string, _ map[string]interface{}) {
		t.resist["毒素"] = src
		t.saveAdv = append(t.saveAdv, ttSaveAdv{ab: "all", vs: "poisoned", src: src})
	}},
	{[]string{"妖精血统", "精类血统", "feyancestry"}, false, nil, func(t *ttTraits, src, _ string, _ map[string]interface{}) {
		t.saveAdv = append(t.saveAdv, ttSaveAdv{ab: "all", vs: "charmed", src: src})
	}},
	{[]string{"勇气", "brave"}, true, nil, func(t *ttTraits, src, _ string, _ map[string]interface{}) {
		t.saveAdv = append(t.saveAdv, ttSaveAdv{ab: "all", vs: "frightened", src: src})
	}},
	{[]string{"勇气灵光", "勇气光环", "auraofcourage"}, false, nil, func(t *ttTraits, src, _ string, _ map[string]interface{}) { t.condImmune["frightened"] = src }},
	{[]string{"守护灵光", "守护光环", "auraofprotection"}, false, nil, func(t *ttTraits, src, _ string, sh map[string]interface{}) {
		v := ttSheetAbilityMod(sh, "cha")
		if v < 1 {
			v = 1
		}
		t.addSaveBonus("all", v, src)
	}},
	{[]string{"传奇抗性", "legendaryresistance"}, false, nil, func(t *ttTraits, _, _ string, _ map[string]interface{}) { t.legendary = true }},
}

var ttTraitNameStrip = regexp.MustCompile(`[（(\[【].*?[）)\]】]|[\s·・。．.，,：:0-9/／]+`)

// ttTraitKey normalises a feature name: drops parentheticals, digits, punctuation and spaces,
// lower-cases English ("反射闪避 Evasion" → "反射闪避evasion").
func ttTraitKey(name string) string {
	return strings.ToLower(ttTraitNameStrip.ReplaceAllString(name, ""))
}

func ttMatchTrait(key string, names []string, exact bool) bool {
	for _, n := range names {
		if exact {
			// exact: the Chinese part must be the whole name (an English name after it is fine)
			cn := strings.TrimRightFunc(key, func(r rune) bool { return r < 128 })
			if cn == n || key == n {
				return true
			}
		} else if strings.Contains(key, n) {
			return true
		}
	}
	return false
}

func (t *ttTraits) addSaveBonus(ab string, v int, src string) {
	if v == 0 || v < -10 || v > 10 {
		return
	}
	t.saveBonus[ab] += v
	t.bonusSrc[ab] = append(t.bonusSrc[ab], src+ttSigned(v))
}

func ttSheetList(sh map[string]interface{}, key string) []map[string]interface{} {
	var out []map[string]interface{}
	switch v := sh[key].(type) {
	case []interface{}:
		for _, x := range v {
			if m, ok := x.(map[string]interface{}); ok {
				out = append(out, m)
			}
		}
	case []map[string]interface{}:
		out = v
	}
	return out
}

// ttSheetAbilityMod: an ability modifier from the sheet's abilities (mod, else from score).
func ttSheetAbilityMod(sh map[string]interface{}, ability string) int {
	for _, a := range ttSheetList(sh, "abilities") {
		if a["key"] != ability && a["name"] != ttAbilityCN[ability] {
			continue
		}
		if v, ok := ttNum(a["mod"]); ok {
			return int(v)
		}
		if v, ok := ttNum(a["score"]); ok {
			return int(v)/2 - 5
		}
	}
	return 0
}

// ttSheetEntries: (name, text) of the sheet's features and stat block entries.
func ttSheetEntries(sh map[string]interface{}) [][2]string {
	var out [][2]string
	add := func(m map[string]interface{}) {
		n, _ := m["name"].(string)
		t, _ := m["text"].(string)
		if n != "" {
			out = append(out, [2]string{n, t})
		}
	}
	for _, f := range ttSheetList(sh, "features") {
		add(f)
	}
	for _, sec := range ttSheetList(sh, "sections") {
		for _, e := range ttSheetList(sec, "entries") {
			add(e)
		}
	}
	return out
}

// ttSheetHas: the sheet has a feature / stat block entry with one of these names.
func ttSheetHas(sh map[string]interface{}, names ...string) bool {
	if sh == nil {
		return false
	}
	for _, e := range ttSheetEntries(sh) {
		if ttMatchTrait(ttTraitKey(e[0]), names, false) {
			return true
		}
	}
	return false
}

// traitsOf collects a token's judgement modifiers (see the file comment).
func (room *TTRoom) traitsOf(it map[string]interface{}) *ttTraits {
	t := newTTTraits()
	conds := ttStatusIDs(it)
	sh := room.tokenSheet(it)
	if sh != nil {
		// 2. traits by name
		off := map[string]bool{} // auto traits switched off on the sheet (already counted in its numbers)
		if list, ok := sh["modsOff"].([]interface{}); ok {
			for _, x := range list {
				if s, ok := x.(string); ok {
					off[ttTraitKey(s)] = true
				}
			}
		}
		for _, e := range ttSheetEntries(sh) {
			key := ttTraitKey(e[0])
			if off[key] {
				continue
			}
			for _, r := range ttAutoTraits {
				if ttMatchTrait(key, r.names, r.exact) && !ttMatchTrait(key, r.skip, false) {
					r.apply(t, strings.TrimSpace(strings.TrimSuffix(e[0], "。")), e[1], sh)
				}
			}
		}
		// props: condition immunities (monsters: 免疫 "毒素；中毒、魅惑") and save advantages (cards: 优势 "…魅惑状态的豁免")
		for _, p := range ttSheetList(sh, "props") {
			label, _ := p["label"].(string)
			value, _ := p["value"].(string)
			switch {
			case strings.Contains(label, "免疫"):
				for cn, id := range ttCondNames {
					if strings.Contains(value, cn) {
						t.condImmune[id] = "状态免疫"
					}
				}
			case label == "优势":
				for _, part := range strings.FieldsFunc(value, func(r rune) bool { return strings.ContainsRune("、，,；;", r) }) {
					if strings.Contains(part, "豁免") {
						t.saveAdv = append(t.saveAdv, ttAdvScope(part, "优势："+part, []string{"all"}, "")...)
					}
				}
			}
		}
		// 1. manual modifiers
		for _, m := range ttSheetList(sh, "mods") {
			if ttBool(m["off"]) {
				continue
			}
			typ, _ := m["t"].(string)
			ab, _ := m["ab"].(string)
			if _, ok := ttAbilityCN[ab]; !ok {
				ab = "all"
			}
			src, _ := m["name"].(string)
			src = ttCleanName(src, 20, "")
			dt, _ := m["dt"].(string)
			dt = strings.TrimSuffix(strings.TrimSpace(dt), "伤害")
			v, _ := ttNum(m["v"])
			switch typ {
			case "evasion":
				t.evasion = ttFirst(src, "反射闪避")
			case "save":
				t.addSaveBonus(ab, int(v), ttFirst(src, "豁免加值"))
			case "saveAdv":
				vs, _ := m["vs"].(string)
				if vs != "" && vs != "spell" && vs != "magic" && !strings.HasPrefix(vs, "school:") && !ttIDRe.MatchString(vs) {
					vs = ""
				}
				t.saveAdv = append(t.saveAdv, ttSaveAdv{ab: ab, vs: vs, src: ttFirst(src, "豁免优势")})
			case "resist", "immune", "vuln":
				if dt == "" {
					continue
				}
				target := map[string]map[string]string{"resist": t.resist, "immune": t.immune, "vuln": t.vuln}[typ]
				list := []string{dt}
				if dt == "物理" {
					list = ttPhysical
				}
				for _, d := range list {
					target[d] = ttFirst(src, "")
					t.nonmagic[typ+":"+d] = ttBool(m["nm"])
				}
			case "condImmune":
				if id, _ := m["id"].(string); ttIDRe.MatchString(id) {
					t.condImmune[id] = ttFirst(src, "状态免疫")
				}
			case "ac":
				if v != 0 && v >= -10 && v <= 10 {
					t.ac += int(v)
					t.acSrc = append(t.acSrc, ttFirst(src, "AC")+ttSigned(int(v)))
				}
			}
		}
	}
	// 3. conditions
	if conds["raging"] {
		for _, d := range ttPhysical {
			if _, ok := t.resist[d]; !ok {
				t.resist[d] = "狂暴"
			}
		}
		t.saveAdv = append(t.saveAdv, ttSaveAdv{ab: "str", src: "狂暴"})
		if _, ok := t.condImmune["charmed"]; !ok && ttSheetHas(sh, "无我狂暴", "mindlessrage") {
			t.condImmune["charmed"], t.condImmune["frightened"] = "无我狂暴", "无我狂暴"
		}
	}
	if ttSheetHas(sh, "战争化身", "avatarofbattle") { // 战争领域 17 级：钝击 / 穿刺 / 挥砍抗性
		for _, d := range ttPhysical {
			if _, ok := t.resist[d]; !ok {
				t.resist[d] = "战争化身"
			}
		}
	}
	if race, _ := sh["race"].(string); sh != nil && (strings.Contains(race, "战俑") || strings.Contains(strings.ToLower(race), "warforged")) {
		if _, ok := t.resist["毒素"]; !ok { // 战俑·构装坚韧：毒素抗性，对抗中毒的豁免优势
			t.resist["毒素"] = "构装坚韧"
		}
		t.saveAdv = append(t.saveAdv, ttSaveAdv{ab: "all", vs: "poisoned", src: "构装坚韧"})
	}
	if conds["giantmight"] { // 符文骑士·巨人之力：力量豁免优势
		t.saveAdv = append(t.saveAdv, ttSaveAdv{ab: "str", src: "巨人之力"})
	}
	if conds["frostrune"] { // 符文骑士·寒霜符文：力量 / 体质豁免 +2
		t.addSaveBonus("str", 2, "寒霜符文")
		t.addSaveBonus("con", 2, "寒霜符文")
	}
	for _, st := range ttStatusMaps(it) { // 状态带的临时抗性（吸收元素等）
		if list, ok := st["resist"].([]interface{}); ok {
			name, _ := st["name"].(string)
			for _, x := range list {
				if d, _ := x.(string); d != "" {
					if _, has := t.resist[d]; !has {
						t.resist[d] = name
					}
				}
			}
		}
	}
	if conds["petrified"] {
		t.resist["全部"] = "石化"
		t.immune["毒素"] = "石化"
		t.condImmune["poisoned"] = "石化"
	}
	return t
}

func ttFirst(s, def string) string {
	if s != "" {
		return s
	}
	return def
}

// ttIncapacitated: Evasion / Danger Sense stop working while incapacitated.
func ttIncapacitated(conds map[string]bool) bool {
	return conds["incapacitated"] || conds["paralyzed"] || conds["stunned"] || conds["unconscious"] || conds["petrified"]
}

// saveMods: extra save bonus and the sources of advantage for this save.
func (t *ttTraits) saveMods(ability string, spell, magic bool, school, statusID string, conds map[string]bool) (bonus int, notes []string, adv []string) {
	bonus = t.saveBonus["all"] + t.saveBonus[ability]
	notes = append(append(notes, t.bonusSrc["all"]...), t.bonusSrc[ability]...)
	seen := map[string]bool{}
	for _, a := range t.saveAdv {
		if a.ab != "all" && a.ab != ability {
			continue
		}
		ok := false
		switch {
		case a.vs == "":
			ok = true
		case a.vs == "spell":
			ok = spell
		case a.vs == "magic":
			ok = spell || magic
		case strings.HasPrefix(a.vs, "school:"):
			ok = spell && school != "" && strings.TrimPrefix(a.vs, "school:") == school
		default:
			ok = a.vs == statusID
		}
		if !ok || (a.noInc && ttIncapacitated(conds)) {
			continue
		}
		if !seen[a.src] {
			seen[a.src] = true
			adv = append(adv, a.src)
		}
	}
	return
}

// damageMod merges the modifiers with the sheet's 抗性 / 免疫 / 易伤 (damageFactor).
func (t *ttTraits) damageMod(f float64, note, dtype string, magic bool) (float64, string) {
	dtype = strings.TrimSuffix(strings.TrimSpace(dtype), "伤害")
	if dtype == "" || f == 0 {
		return f, note
	}
	find := func(kind string, m map[string]string) (string, bool) {
		for k, src := range m {
			if (k == "全部" || ttHasDamageType(k, dtype) || ttHasDamageType(dtype, k)) && !(magic && t.nonmagic[kind+":"+k]) {
				return src, true
			}
		}
		return "", false
	}
	if src, ok := find("immune", t.immune); ok {
		return 0, "免疫" + dtype + ttSrcTag(src)
	}
	resist, vuln := f == 0.5 || f == -1, f == 2 || f == -1
	extra := ""
	if src, ok := find("resist", t.resist); ok && !resist {
		resist = true
		extra = "抗性" + ttSrcTag(src)
	}
	if src, ok := find("vuln", t.vuln); ok && !vuln {
		vuln = true
		extra = strings.TrimSpace(extra + " 易伤" + ttSrcTag(src))
	}
	if extra == "" {
		return f, note
	}
	switch {
	case resist && vuln:
		return -1, "抗性+易伤"
	case resist:
		return 0.5, extra
	default:
		return 2, extra
	}
}

func ttSrcTag(src string) string {
	if src == "" || src == "状态免疫" {
		return ""
	}
	return "（" + src + "）"
}

func ttJoinNotes(list []string) string {
	return strings.Join(list, "、")
}

// ===== reactions after being hit =====
// The attack has already been resolved; the target's controller (or the GM) answers with
//   deflect  拨挡攻击 / 拨挡飞弹: the attack's damage included 钝击 / 穿刺 / 挥砍 → reduce the WHOLE
//            attack's damage (magic parts too) by 1d10 + Dex mod + monk level;
//   uncanny  直觉闪避: halve the attack's damage;
//   shield   盾牌术 (in the sheet's spells): +5 AC — if the roll no longer hits, the attack misses.
// The damage taken is given back as HP (works even if other things happened since), a new
// log entry with ref "<log id>:<token id>" records it (one reaction per target per attack).

var ttMonkLevelRe = regexp.MustCompile(`武僧\s*(\d+)`)

func ttMonkLevel(sh map[string]interface{}) int {
	class, _ := sh["class"].(string)
	if m := ttMonkLevelRe.FindStringSubmatch(class); m != nil {
		n, _ := strconv.Atoi(m[1])
		return n
	}
	lv, _ := ttNum(sh["level"])
	return int(lv)
}

func ttSheetHasSpell(sh map[string]interface{}, name string) bool {
	if sh == nil {
		return false
	}
	for _, s := range ttSheetList(sh, "spells") {
		if n, _ := s["name"].(string); strings.Contains(n, name) {
			return true
		}
	}
	return false
}

// reduceHit re-applies a hit as if it had dealt `left` damage instead of `taken`, starting from the
// target's state right before the hit (kept in memory for GM undo): temporary HP absorbs first again,
// and dropping to 0 HP, instant death, death-save failures and lost concentration are re-derived from
// the reduced damage. Changes made to the token since the hit (healing, other damage) are kept.
// ok = false when the state before the hit is no longer known.
func (room *TTRoom) reduceHit(it map[string]interface{}, logID string, taken, left int, crit bool) (string, bool) {
	var pre map[string]interface{}
	for _, r := range room.actUndo[logID] {
		if r.id == it["id"] {
			pre = r.vals
		}
	}
	if pre == nil {
		return "", false
	}
	max, _ := ttNum(it["hpMax"])
	if max <= 0 {
		return "", false
	}
	hpBefore, ok := ttNum(pre["hp"])
	if !ok {
		hpBefore = max
	}
	tempBefore, _ := ttNum(pre["hpTemp"])
	split := func(d int) (float64, float64) { // damage → (taken by temp HP, taken by HP)
		t := float64(d)
		if t > tempBefore {
			t = tempBefore
		}
		h := float64(d) - t
		if h > hpBefore {
			h = hpBefore
		}
		return t, h
	}
	oldT, oldH := split(taken)
	newT, newH := split(left)
	hp, ok := ttNum(it["hp"])
	if !ok {
		hp = max
	}
	temp, _ := ttNum(it["hpTemp"])
	hp += oldH - newH
	if hp > max {
		hp = max
	}
	temp += oldT - newT
	it["hp"] = hp
	if temp > 0 {
		it["hpTemp"] = temp
	} else {
		delete(it, "hpTemp")
	}
	preStatus := map[string]map[string]interface{}{}
	if list, ok := pre["status"].([]interface{}); ok {
		for _, x := range list {
			if m, ok := x.(map[string]interface{}); ok {
				if id, _ := m["id"].(string); id != "" {
					preStatus[id] = m
				}
			}
		}
	}
	restoreDS := func() {
		if ds, ok := pre["ds"].(map[string]interface{}); ok {
			cp := map[string]interface{}{}
			for k, v := range ds {
				cp[k] = v
			}
			it["ds"] = cp
		} else {
			delete(it, "ds")
		}
	}
	// undo what the hit's damage did at 0 HP, then redo it with the reduced damage
	for _, id := range []string{"unconscious", "dead", "stable"} {
		if preStatus[id] == nil {
			ttRemoveStatus(it, id)
		}
	}
	restoreDS()
	if hpBefore > 0 {
		if c := preStatus["concentration"]; c != nil && !ttStatusIDs(it)["concentration"] && hp > 0 {
			ttAddStatus(it, c) // 不再倒地：专注也没有因为倒地而中断
		}
		return room.dropToZero(it, hpBefore, left-int(newT)), true // 溢出伤害 = 扣完临时生命后的伤害 − 原生命值
	}
	if left > 0 {
		return ttDamageAtZero(it, left, crit, room.isPC(it)), true
	}
	return "", true
}

func (room *TTRoom) reactAction(u ttUser, gm bool, logID, tokenID, mode, reactorID, extraID string) (int, string) {
	var e *TTLogEntry
	for i := range room.Log {
		if room.Log[i].ID == logID {
			e = &room.Log[i]
		}
	}
	if e == nil || e.Act == nil || (e.Act.Kind != "attack" && !((mode == "legendary" || mode == "interpose" || mode == "indomitable" || mode == "disciplined" || mode == "flash" || mode == "portent") && e.Act.Kind == "save") && mode != "absorb") {
		return http.StatusBadRequest, "找不到这次结算（太久远的记录不能再反应）"
	}
	var h *TTActionHit
	for _, x := range e.Act.Targets {
		if x.ID == tokenID {
			h = x
		}
	}
	if h == nil {
		return http.StatusBadRequest, "这次攻击没有打到这个棋子"
	}
	ref := logID + ":" + tokenID
	switch mode { // 别人的反应 / 不是反应的特性，和目标自己的反应互不影响
	case "intercept":
		ref += ":ic"
	case "runeshield":
		ref += ":rs"
	case "cloud":
		ref += ":cr"
	case "indomitable":
		ref += ":ind"
	case "disciplined":
		ref += ":dsc"
	case "guided":
		ref += ":gs"
	case "flash":
		ref += ":fg"
	case "portent":
		ref += ":pt"
	}
	for _, x := range room.Log {
		if x.Ref == ref {
			return http.StatusBadRequest, "这次攻击已经用过反应了"
		}
	}
	sc := room.activeScene()
	it := sc.Items[tokenID]
	if it == nil {
		return http.StatusBadRequest, "目标不在当前场景"
	}
	rx := it // the token spending its reaction (拦截 / 符文之盾 / 云雾符文: another token)
	if mode == "intercept" || mode == "runeshield" || mode == "cloud" || mode == "guided" || mode == "flash" || mode == "portent" {
		rx = sc.Items[reactorID]
		if rx == nil || rx["kind"] != "token" || (reactorID == tokenID && (mode == "intercept" || mode == "runeshield")) {
			return http.StatusBadRequest, "找不到用反应的棋子"
		}
	}
	if owner, _ := rx["owner"].(string); !gm && (owner == "" || owner != u.name) {
		return http.StatusForbidden, "只能替自己的棋子使用反应"
	}
	if mode != "legendary" && mode != "absorb" && mode != "interpose" && mode != "indomitable" && mode != "disciplined" && mode != "guided" && mode != "flash" && mode != "portent" && h.Hit != "hit" && h.Hit != "crit" {
		return http.StatusBadRequest, "这次攻击没有命中"
	}
	sh := room.tokenSheet(it)
	taken := 0
	if h.Amount < 0 {
		taken = -h.Amount
	}
	var roll *TTDiceResult
	name, note, back, after, removeStatus := "", "", 0, 0, false
	absorbType := ""
	var redirect map[string]interface{}                   // 云雾符文：改成的新目标
	reapply, reapplyCrit, failFlip := false, false, false // 导引打击 / 预兆：失手改命中、豁免成功改失败 → 重新结算
	noReaction := mode == "portent"                       // 预兆不是反应
	switch mode {
	case "deflect":
		if !ttSheetHas(sh, "拨挡攻击", "拨挡飞弹", "拨挡", "deflectattacks", "deflectmissiles") {
			return http.StatusBadRequest, "角色卡上没有「拨挡攻击」"
		}
		if !h.Phys && ttMonkLevel(sh) < 13 { // 13 级拨挡能量：任何伤害类型都能拨挡
			return http.StatusBadRequest, "这次攻击没有钝击 / 穿刺 / 挥砍伤害，不能拨挡（13 级拨挡能量后才可以）"
		}
		if taken <= 0 {
			return http.StatusBadRequest, "这次攻击没有造成伤害"
		}
		expr := "1d10"
		if v := ttSheetAbilityMod(sh, "dex"); v != 0 {
			expr += ttSigned(v)
		}
		if v := ttMonkLevel(sh); v > 0 {
			expr += ttSigned(v)
		}
		r, err := RollTabletopDice(expr)
		if err != nil {
			return http.StatusBadRequest, err.Error()
		}
		roll = r
		left := taken - r.Total
		if left < 0 {
			left = 0
		}
		back, after = taken-left, left
		name = "拨挡攻击"
		note = "减伤 " + strconv.Itoa(r.Total) + "：伤害 " + strconv.Itoa(taken) + " → " + strconv.Itoa(left)
	case "uncanny":
		if !ttSheetHas(sh, "直觉闪避", "uncannydodge") {
			return http.StatusBadRequest, "角色卡上没有「直觉闪避」"
		}
		if taken <= 0 {
			return http.StatusBadRequest, "这次攻击没有造成伤害"
		}
		left := taken / 2
		back, after = taken-left, left
		name = "直觉闪避"
		note = "伤害减半：" + strconv.Itoa(taken) + " → " + strconv.Itoa(left)
	case "shield":
		if !ttSheetHasSpell(sh, "盾牌术") && !ttSheetHas(sh, "盾牌术") {
			return http.StatusBadRequest, "角色卡上没有「盾牌术」"
		}
		if h.Attack == nil || ttNaturalD20(h.Attack) == 20 {
			return http.StatusBadRequest, "天然 20 必定命中，盾牌术挡不住"
		}
		ac, ok := ttNum(it["ac"])
		if !ok || ac <= 0 {
			return http.StatusBadRequest, "棋子没有 AC"
		}
		if ttStatusIDs(it)["hasted"] {
			ac += 2
		}
		ac += float64(room.traitsOf(it).ac) + 5
		if float64(h.Attack.Total) >= ac+float64(h.Cover) {
			return http.StatusBadRequest, "加上盾牌术后 AC " + strconv.Itoa(int(ac)) + "，攻击 " + strconv.Itoa(h.Attack.Total) + " 仍然命中"
		}
		back, after = taken, 0
		removeStatus = h.Status != ""
		name = "盾牌术"
		note = "AC " + strconv.Itoa(int(ac)) + "（+5），攻击 " + strconv.Itoa(h.Attack.Total) + " 改为未命中"
	case "parry": // 防御式决斗：持灵巧武器被近战攻击命中时，AC + 熟练加值
		if !ttSheetHas(sh, "防御式决斗", "防御决斗", "defensiveduelist") {
			return http.StatusBadRequest, "角色卡上没有「防御式决斗」"
		}
		if !e.Act.Melee {
			return http.StatusBadRequest, "防御式决斗只能对近战攻击使用"
		}
		if h.Attack == nil || ttNaturalD20(h.Attack) == 20 {
			return http.StatusBadRequest, "天然 20 必定命中，招架挡不住"
		}
		ac, ok := ttNum(it["ac"])
		if !ok || ac <= 0 {
			return http.StatusBadRequest, "棋子没有 AC"
		}
		if ttStatusIDs(it)["hasted"] {
			ac += 2
		}
		pb := ttSheetProf(sh)
		ac += float64(room.traitsOf(it).ac + pb)
		if float64(h.Attack.Total) >= ac+float64(h.Cover) {
			return http.StatusBadRequest, "加上熟练加值后 AC " + strconv.Itoa(int(ac)) + "，攻击 " + strconv.Itoa(h.Attack.Total) + " 仍然命中"
		}
		back, after = taken, 0
		removeStatus = h.Status != ""
		name = "防御式决斗"
		note = "AC " + strconv.Itoa(int(ac)) + "（+" + strconv.Itoa(pb) + "），攻击 " + strconv.Itoa(h.Attack.Total) + " 改为未命中"
	case "intercept": // 拦截（战斗风格）：5 尺内的盟友被命中时，减伤 1d10 + 熟练加值
		rsh := room.tokenSheet(rx)
		if !ttSheetHas(rsh, "拦截", "interception") {
			return http.StatusBadRequest, "角色卡上没有「拦截」"
		}
		if taken <= 0 {
			return http.StatusBadRequest, "这次攻击没有造成伤害"
		}
		r, err := RollTabletopDice("1d10" + ttSigned(ttSheetProf(rsh)))
		if err != nil {
			return http.StatusBadRequest, err.Error()
		}
		roll = r
		left := taken - r.Total
		if left < 0 {
			left = 0
		}
		back, after = taken-left, left
		name = "拦截"
		note = ttItemLabel(rx) + " 拦截，减伤 " + strconv.Itoa(r.Total) + "：伤害 " + strconv.Itoa(taken) + " → " + strconv.Itoa(left)
	case "interpose": // 盾牌大师·介入盾牌：敏捷豁免成功、本该受一半伤害时改为不受伤害
		if !ttSheetHas(sh, "盾牌大师", "介入盾牌", "shieldmaster") {
			return http.StatusBadRequest, "角色卡上没有「盾牌大师」"
		}
		if e.Act.Save != "dex" || !e.Act.Half || h.Saved != "yes" {
			return http.StatusBadRequest, "只有敏捷豁免成功、本该受一半伤害时才能用介入盾牌"
		}
		if taken <= 0 {
			return http.StatusBadRequest, "这次没有受到伤害"
		}
		back, after = taken, 0
		name = "介入盾牌"
		note = "敏捷豁免成功，伤害 " + strconv.Itoa(taken) + " → 0"
	case "absorb": // 吸收元素：这次的强酸 / 寒冷 / 火焰 / 闪电 / 雷鸣伤害减半，并抗性到下回合开始
		if !ttSheetHasSpell(sh, "吸收元素") && !ttSheetHas(sh, "吸收元素", "absorbelements") {
			return http.StatusBadRequest, "角色卡上没有「吸收元素」"
		}
		best, amt := "", 0
		for ty, v := range h.Types {
			if ttElemental[ty] && v > amt {
				best, amt = ty, v
			}
		}
		if amt <= 0 {
			return http.StatusBadRequest, "这次伤害里没有强酸 / 寒冷 / 火焰 / 闪电 / 雷鸣"
		}
		red := amt - amt/2
		back, after = red, taken-red
		absorbType = best
		name = "吸收元素"
		note = best + "伤害减半：" + strconv.Itoa(amt) + " → " + strconv.Itoa(amt/2) + "，直到下回合开始对" + best + "有抗性"
	case "indomitable", "disciplined": // 战士·不屈（9 级，加战士等级）/ 武僧·圆融自在（14 级，花 1 功力）：豁免失败时重掷，必须用新结果（不是反应）
		if h.Saved != "no" {
			return http.StatusBadRequest, "只有豁免失败时才能重掷"
		}
		flv := 0
		if mode == "indomitable" {
			flv = ttClassLevel(sh, "战士")
			if flv < 9 {
				return http.StatusBadRequest, "需要 9 级战士的「不屈」"
			}
		} else if ttClassLevel(sh, "武僧") < 14 {
			return http.StatusBadRequest, "需要 14 级武僧的「圆融自在」"
		}
		ab := e.Act.Save
		if ab == "strdex" {
			ab = "str"
			if room.saveBonus(it, "dex") > room.saveBonus(it, "str") {
				ab = "dex"
			}
		}
		r, notes, err := room.rollTokenSave(it, ab, nil, nil)
		if err != nil {
			return http.StatusBadRequest, err.Error()
		}
		if r == nil {
			return http.StatusBadRequest, "这次豁免是自动失败（麻痹 / 震慑等），重掷也没用"
		}
		roll = r
		total := r.Total + flv
		name = "不屈"
		note = "重掷豁免 " + strconv.Itoa(r.Total) + " + 战士等级 " + strconv.Itoa(flv) + " = " + strconv.Itoa(total)
		if mode == "disciplined" {
			name = "圆融自在"
			note = "花 1 功力重掷豁免：" + strconv.Itoa(total)
		}
		if len(notes) > 0 {
			note += "（" + strings.Join(notes, "；") + "）"
		}
		if total < e.Act.DC {
			note += "，仍低于 DC " + strconv.Itoa(e.Act.DC) + "：还是失败"
		} else {
			left := 0
			if e.Act.Half {
				left = taken / 2
			}
			back, after = taken-left, left
			removeStatus = h.Status != ""
			note += "，达到 DC " + strconv.Itoa(e.Act.DC) + "：豁免成功"
			if taken > 0 {
				note += "，伤害 " + strconv.Itoa(taken) + " → " + strconv.Itoa(left)
			}
		}
	case "runeshield": // 符文骑士·符文之盾（7 级）：60 尺内另一个生物被命中时，用反应让攻击者重掷 d20
		if !ttSheetHas(room.tokenSheet(rx), "符文之盾", "runicshield") && ttClassLevel(room.tokenSheet(rx), "战士") < 7 {
			return http.StatusBadRequest, "角色卡上没有「符文之盾」"
		}
		if h.Attack == nil {
			return http.StatusBadRequest, "这次攻击没有命中骰"
		}
		ac, ok := ttNum(it["ac"])
		if !ok || ac <= 0 {
			return http.StatusBadRequest, "棋子没有 AC"
		}
		if ttStatusIDs(it)["hasted"] {
			ac += 2
		}
		ac += float64(room.traitsOf(it).ac)
		r, err := RollTabletopDice("1d20")
		if err != nil {
			return http.StatusBadRequest, err.Error()
		}
		roll = r
		bonus := h.Attack.Total - ttNaturalD20(h.Attack)
		nt := r.Total + bonus
		name = "符文之盾"
		if r.Total == 20 || (r.Total != 1 && float64(nt) >= ac+float64(h.Cover)) {
			note = ttItemLabel(rx) + " 的符文之盾：攻击者重掷 d20 = " + strconv.Itoa(r.Total) + "，攻击 " + strconv.Itoa(nt) + "：仍然命中"
		} else {
			back, after = taken, 0
			removeStatus = h.Status != ""
			note = ttItemLabel(rx) + " 的符文之盾：攻击者重掷 d20 = " + strconv.Itoa(r.Total) + "，攻击 " + strconv.Itoa(nt) + "：改为未命中"
		}
	case "cloud": // 符文骑士·云雾符文：你或 30 尺内的生物被命中时，把这次攻击改给 30 尺内另一个生物（同一个命中值）
		if !ttSheetHas(room.tokenSheet(rx), "云之符文", "云雾符文", "cloudrune") {
			return http.StatusBadRequest, "角色卡上没有「云雾符文」"
		}
		redirect = sc.Items[extraID]
		if redirect == nil || redirect["kind"] != "token" || extraID == tokenID || extraID == e.Act.CasterID {
			return http.StatusBadRequest, "新目标无效（不能是原目标或攻击者）"
		}
		back, after = taken, 0
		removeStatus = h.Status != ""
		name = "云雾符文"
		note = ttItemLabel(rx) + " 的云雾符文：这次攻击改为指向 " + ttItemLabel(redirect)
	case "guided": // 战争领域·导引打击：你或 30 尺内的生物攻击失手时，花引导神力让这次攻击检定 +10（替别人用要花反应）
		if !ttSheetHas(room.tokenSheet(rx), "导引打击", "guidedstrike") {
			return http.StatusBadRequest, "角色卡上没有「导引打击」"
		}
		if h.Hit != "miss" || h.Attack == nil {
			return http.StatusBadRequest, "只有攻击失手（不是天然 1）时才能用导引打击"
		}
		ac, ok := room.ttTargetAC(it)
		if !ok {
			return http.StatusBadRequest, "目标没有 AC"
		}
		noReaction = reactorID == e.Act.CasterID
		nt := h.Attack.Total + 10
		name = "导引打击"
		if float64(nt) >= ac+float64(h.Cover) {
			reapply = true
			note = ttItemLabel(rx) + " 的导引打击：攻击 " + strconv.Itoa(h.Attack.Total) + " + 10 = " + strconv.Itoa(nt) + "，改为命中"
		} else {
			note = ttItemLabel(rx) + " 的导引打击：攻击 " + strconv.Itoa(nt) + "，仍然未命中"
		}
	case "flash": // 奇械师·灵光一闪：你或 30 尺内的生物豁免失败时，用反应加上你的智力调整值
		rsh := room.tokenSheet(rx)
		if !ttSheetHas(rsh, "灵光一闪", "flashofgenius") && ttClassLevel(rsh, "奇械师") < 7 {
			return http.StatusBadRequest, "角色卡上没有「灵光一闪」"
		}
		if h.Saved != "no" || h.Save == nil {
			return http.StatusBadRequest, "只有豁免失败时才能用灵光一闪"
		}
		im := ttSheetAbilityMod(rsh, "int")
		if im < 1 {
			im = 1
		}
		nt := h.Save.Total + im
		name = "灵光一闪"
		note = ttItemLabel(rx) + " 的灵光一闪：豁免 " + strconv.Itoa(h.Save.Total) + " + 智力 " + strconv.Itoa(im) + " = " + strconv.Itoa(nt)
		if nt >= e.Act.DC {
			left := 0
			if e.Act.Half {
				left = taken / 2
			}
			back, after = taken-left, left
			removeStatus = h.Status != ""
			note += "，达到 DC " + strconv.Itoa(e.Act.DC) + "：豁免成功"
		} else {
			note += "，仍低于 DC " + strconv.Itoa(e.Act.DC) + "：还是失败"
		}
	case "portent": // 预言师·预兆：用记下的一个 d20 替换这次豁免 / 攻击的 d20（不是反应）
		vals, _ := rx["portent"].([]interface{})
		idx, err := strconv.Atoi(extraID)
		if err != nil || idx < 0 || idx >= len(vals) {
			return http.StatusBadRequest, "这个预兆已经用掉了"
		}
		vf, _ := ttNum(vals[idx])
		val := int(vf)
		rest := append(append([]interface{}{}, vals[:idx]...), vals[idx+1:]...)
		if len(rest) > 0 {
			rx["portent"] = rest
		} else {
			delete(rx, "portent")
		}
		room.broadcastItems([]map[string]interface{}{rx})
		name = "预兆"
		if e.Act.Kind == "save" {
			if h.Save == nil {
				return http.StatusBadRequest, "这个目标没有掷豁免"
			}
			nat := ttNaturalD20(h.Save)
			nt := val + h.Save.Total - nat
			was, now := h.Saved == "yes", nt >= e.Act.DC
			note = ttItemLabel(rx) + " 的预兆 " + strconv.Itoa(val) + " 替换 d20（" + strconv.Itoa(nat) + "）：豁免 " + strconv.Itoa(nt)
			switch {
			case !was && now:
				left := 0
				if e.Act.Half {
					left = taken / 2
				}
				back, after = taken-left, left
				removeStatus = h.Status != ""
				note += "，改为成功"
			case was && !now:
				failFlip = true
				note += "，改为失败"
			default:
				note += "，结果不变"
			}
		} else {
			if h.Attack == nil {
				return http.StatusBadRequest, "这次攻击没有命中骰"
			}
			ac, ok := room.ttTargetAC(it)
			if !ok {
				return http.StatusBadRequest, "目标没有 AC"
			}
			nat := ttNaturalD20(h.Attack)
			nt := val + h.Attack.Total - nat
			wasHit, nowHit := h.Hit == "hit" || h.Hit == "crit", val == 20 || (val != 1 && float64(nt) >= ac+float64(h.Cover))
			note = ttItemLabel(rx) + " 的预兆 " + strconv.Itoa(val) + " 替换攻击者的 d20（" + strconv.Itoa(nat) + "）：攻击 " + strconv.Itoa(nt)
			switch {
			case wasHit && !nowHit:
				back, after = taken, 0
				removeStatus = h.Status != ""
				note += "，改为未命中"
			case !wasHit && nowHit:
				reapply, reapplyCrit = true, val == 20
				note += "，改为命中"
			default:
				note += "，结果不变"
			}
		}
	case "legendary": // 传奇抗性：豁免失败改为成功
		if h.Saved != "no" {
			return http.StatusBadRequest, "只有豁免失败时才能用传奇抗性"
		}
		lr := ttLegendRes(it, "lr")
		if lr == nil {
			return http.StatusBadRequest, "这个棋子没有「传奇抗性」资源"
		}
		cur, _ := ttNum(lr["cur"])
		if cur <= 0 {
			return http.StatusBadRequest, "传奇抗性已经用完了"
		}
		lr["cur"] = cur - 1
		left := 0
		if e.Act.Half {
			left = taken / 2
		}
		back, after = taken-left, left
		removeStatus = h.Status != ""
		name = "传奇抗性"
		max, _ := ttNum(lr["max"])
		note = "豁免改为成功（剩 " + strconv.Itoa(int(cur-1)) + "/" + strconv.Itoa(int(max)) + "）"
		if taken > 0 {
			note += "：伤害 " + strconv.Itoa(taken) + " → " + strconv.Itoa(left)
		}
	default:
		return http.StatusBadRequest, "未知的反应"
	}
	if mode != "legendary" && mode != "indomitable" && mode != "disciplined" && !noReaction && room.setting("hintEcon", true) { // 记下反应已用（自己回合开始时恢复）
		econ, _ := rx["econ"].(map[string]interface{})
		if econ == nil {
			econ = map[string]interface{}{}
		}
		econ["r"] = true
		rx["econ"] = econ
		if rx["id"] != it["id"] {
			room.broadcastItems([]map[string]interface{}{rx})
		}
	}
	snap := ttSnapHP(sc, it)
	concBefore := ttStatusIDs(it)["concentration"]
	if back > 0 {
		// 按减伤重新结算：从这次攻击之前的状态出发，用减少后的伤害重新扣一次
		if extra, ok := room.reduceHit(it, logID, taken, after, h.Hit == "crit"); ok {
			if extra != "" {
				note += "；" + extra
			}
		} else { // 攻击前的状态已经不在内存里（服务器重启过 / 太久远）：直接把减免的生命值加回去
			ttApplyHP(it, back)
			if hp, _ := ttNum(it["hp"]); hp > 0 {
				delete(it, "ds")
				ttRemoveStatus(it, "stable", "unconscious", "dead")
			}
			note += "（攻击太久远，按回血处理，临时生命值没有恢复）"
		}
		if ttStatusIDs(it)["concentration"] || concBefore {
			if after > 0 {
				dc := after / 2
				if dc < 10 {
					dc = 10
				}
				note += "；专注豁免改为 DC " + strconv.Itoa(dc)
			} else {
				note += "；不用再做专注豁免"
			}
		}
	}
	if removeStatus { // the attack missed: its condition doesn't apply
		var keep []interface{}
		for _, x := range ttStatusList(it) {
			if m, ok := x.(map[string]interface{}); ok && m["name"] == h.Status {
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
	if absorbType != "" { // 吸收元素：抗性持续到自己下回合开始（turnStart 去掉 until=start 的状态）
		ttAddStatus(it, map[string]interface{}{"id": "absorb", "name": "吸收" + absorbType, "icon": "🛡", "color": "#4fc3f7",
			"resist": []interface{}{absorbType}, "until": "start"})
	}
	room.broadcastItems([]map[string]interface{}{it})
	ne := newLogEntry("action", u.name)
	ne.Label = name
	ne.Ref = ref
	ne.Hidden = e.Hidden
	ne.Act = &TTActionResult{Name: name + "（" + e.Act.Name + "）", Kind: "react", Roll: roll,
		Targets: []*TTActionHit{{ID: tokenID, Name: h.Name, Amount: back, Note: note}}}
	room.addLog(ne)
	room.rememberUndo(ne.ID, []ttUndoRec{snap})
	if redirect != nil { // 云雾符文：同一个命中值对新目标判定，命中则重新掷伤害
		room.cloudRedirect(u, e, h, redirect)
	}
	if reapply { // 导引打击 / 预兆：失手改为命中——按原来的伤害骰和状态结算到这个目标
		room.reapplyAction(u, e, tokenID, name+"：改为命中", reapplyCrit, 0)
	}
	if failFlip { // 预兆：豁免成功改为失败——补上成功时少受的伤害和状态
		extra := 0
		if e.Act.Roll != nil {
			extra = e.Act.Roll.Total
			if e.Act.Half {
				extra -= e.Act.Roll.Total / 2
			}
		}
		room.reapplyAction(u, e, tokenID, name+"：豁免改为失败", false, extra)
	}
	return 0, ""
}

// reapplyAction re-resolves part of an action on one target: a miss that became a hit (flat < 0: roll the stored
// damage dice, doubled on a crit) or a save that became a failure (flat = the damage the success avoided, before
// resistances), plus the stored condition. Runs through applyAction kind auto / effect so resistances, temp HP,
// 0 HP and concentration all apply.
func (room *TTRoom) reapplyAction(u ttUser, e *TTLogEntry, id, why string, crit bool, flat int) {
	dmg, parts := e.Act.DmgExpr, e.Act.DmgParts
	if e.Act.Kind == "save" {
		dmg, parts = "", nil
		if flat > 0 {
			dmg = strconv.Itoa(flat)
		}
	} else if crit {
		dmg = ttDoubleDice(dmg)
		var ps []TTDamagePart
		for _, p := range parts {
			ps = append(ps, TTDamagePart{Dice: ttDoubleDice(p.Dice), Type: p.Type})
		}
		parts = ps
	}
	if dmg == "" && e.Act.StatusDef == nil {
		ne := newLogEntry("sys", u.name)
		ne.Text = why + "：没有记下伤害骰，请手动结算"
		ne.Hidden = e.Hidden
		room.addLog(ne)
		return
	}
	kind := "auto"
	if dmg == "" {
		kind = "effect"
	}
	req := &ttOpRequest{Op: "action", Hidden: e.Hidden, Act: &TTActionReq{Name: e.Act.Name + "（" + why + "）", Kind: kind, Damage: dmg, DamageType: e.Act.DamageType,
		Parts: parts, Status: e.Act.StatusDef, Caster: e.Act.CasterID, Magic: e.Act.Magic, Spell: e.Act.Spell, Targets: []TTActionTarget{{ID: id}}}}
	if st, msg := room.applyAction(u, true, req); st != 0 {
		ne := newLogEntry("sys", u.name)
		ne.Text = why + " 时出错：" + msg
		ne.Hidden = e.Hidden
		room.addLog(ne)
	}
}

// ttTargetAC: a token's AC for re-checks (haste and AC modifiers included, cover not).
func (room *TTRoom) ttTargetAC(it map[string]interface{}) (float64, bool) {
	ac, ok := ttNum(it["ac"])
	if !ok || ac <= 0 {
		return 0, false
	}
	if ttStatusIDs(it)["hasted"] {
		ac += 2
	}
	return ac + float64(room.traitsOf(it).ac), true
}

// cloudRedirect: 云雾符文把攻击改给新目标——同一个命中值对比新目标的 AC，命中则按原伤害骰重新掷（重击时骰子已翻倍）。
func (room *TTRoom) cloudRedirect(u ttUser, e *TTLogEntry, h *TTActionHit, nt map[string]interface{}) {
	id, _ := nt["id"].(string)
	label := ttItemLabel(nt)
	sys := func(text string) {
		ne := newLogEntry("sys", u.name)
		ne.Text = text
		ne.Hidden = e.Hidden
		room.addLog(ne)
	}
	if h.Attack == nil || h.Damage == nil || h.Damage.Expr == "" {
		sys("云雾符文：攻击改给 " + label + "，这次攻击没有可以重掷的伤害，请手动结算")
		return
	}
	ac, ok := ttNum(nt["ac"])
	if !ok || ac <= 0 {
		sys("云雾符文：攻击改给 " + label + "（命中值 " + strconv.Itoa(h.Attack.Total) + "），新目标没有 AC，请手动判定")
		return
	}
	if ttStatusIDs(nt)["hasted"] {
		ac += 2
	}
	ac += float64(room.traitsOf(nt).ac)
	nat := ttNaturalD20(h.Attack)
	if nat != 20 && float64(h.Attack.Total) < ac {
		sys("云雾符文：攻击改给 " + label + "，命中值 " + strconv.Itoa(h.Attack.Total) + " 未命中")
		return
	}
	req := &ttOpRequest{Op: "action", Hidden: e.Hidden, Act: &TTActionReq{Name: e.Act.Name + "（云雾符文转移）", Kind: "auto", Damage: h.Damage.Expr,
		DamageType: e.Act.DamageType, Caster: e.Act.CasterID, Magic: e.Act.Magic, Targets: []TTActionTarget{{ID: id}}}}
	if st, msg := room.applyAction(u, true, req); st != 0 {
		sys("云雾符文：攻击改给 " + label + " 时出错：" + msg)
	}
}

// ttClassLevel: the level in one class from the sheet's class text (「战士 5」「战士 3 / 游荡者 2」), else the total level
// when the class is named without a number, else 0.
func ttClassLevel(sh map[string]interface{}, cn string) int {
	if sh == nil {
		return 0
	}
	class, _ := sh["class"].(string)
	sub, _ := sh["subclass"].(string)
	s := class + " " + sub
	if m := regexp.MustCompile(regexp.QuoteMeta(cn) + `\s*(\d+)`).FindStringSubmatch(s); m != nil {
		n, _ := strconv.Atoi(m[1])
		return n
	}
	if strings.Contains(s, cn) {
		lv, _ := ttNum(sh["level"])
		if lv < 1 {
			lv = 1
		}
		return int(lv)
	}
	return 0
}

// ttSheetProf: the sheet's proficiency bonus (written on the sheet, else from level / CR).
func ttSheetProf(sh map[string]interface{}) int {
	if sh == nil {
		return 2
	}
	if v, ok := ttNum(sh["prof"]); ok && v > 0 {
		return int(v)
	}
	if cr, ok := ttNum(sh["cr"]); ok && sh["kind"] != "pc" && cr >= 1 {
		return 2 + (int(cr)-1)/4
	}
	lv := 1
	if v, ok := ttNum(sh["level"]); ok && v > 1 {
		lv = int(v)
	}
	return 2 + (lv-1)/4
}

// ttElemental: the damage types 吸收元素 can absorb.
var ttElemental = map[string]bool{"强酸": true, "寒冷": true, "火焰": true, "闪电": true, "雷鸣": true}
