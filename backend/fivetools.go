package main

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Conversion of 5etools-format monsters (as stored by Owlbear's bestiary extension, translated
// by 不全书) into the tabletop's monster sheet format — the same shape that
// www/js/tabletop-sheets.js produces from 不全书 pages, so it renders with click-to-roll.

var (
	fiveSize = map[string]string{"T": "微型", "S": "小型", "M": "中型", "L": "大型", "H": "巨型", "G": "超巨型"}
	fiveType = map[string]string{
		"aberration": "异怪", "beast": "野兽", "celestial": "天界生物", "construct": "构装生物", "dragon": "龙类",
		"elemental": "元素", "fey": "妖精", "fiend": "邪魔", "giant": "巨人", "humanoid": "类人生物",
		"monstrosity": "怪兽", "ooze": "泥怪", "plant": "植物", "undead": "不死生物",
	}
	fiveAlign = map[string]string{"L": "守序", "N": "中立", "C": "混乱", "G": "善良", "E": "邪恶", "U": "无阵营", "A": "任意阵营"}
	fiveSkill = map[string]string{
		"athletics": "运动", "acrobatics": "特技", "sleight of hand": "巧手", "stealth": "隐匿",
		"arcana": "奥秘", "history": "历史", "investigation": "调查", "nature": "自然", "religion": "宗教",
		"animal handling": "驯兽", "insight": "洞悉", "medicine": "医药", "perception": "察觉", "survival": "求生",
		"deception": "欺瞒", "intimidation": "威吓", "performance": "表演", "persuasion": "游说",
	}
	fiveSpeed   = [][2]string{{"walk", ""}, {"burrow", "掘穴"}, {"climb", "攀爬"}, {"fly", "飞行"}, {"swim", "游泳"}}
	fiveAbility = [][2]string{{"str", "力量"}, {"dex", "敏捷"}, {"con", "体质"}, {"int", "智力"}, {"wis", "感知"}, {"cha", "魅力"}}
	fiveTagRe   = regexp.MustCompile(`\{@(\w+)\s*([^{}]*)\}`)
)

// fiveText resolves {@tag ...} markup into plain Chinese text that rollify() in the
// frontend turns into roll buttons ("攻击检定：+4", "命中+4", "1d6+2", "DC 13").
func fiveText(s string) string {
	for i := 0; i < 10 && strings.Contains(s, "{@"); i++ {
		s = fiveTagRe.ReplaceAllStringFunc(s, func(m string) string {
			sub := fiveTagRe.FindStringSubmatch(m)
			tag, arg := sub[1], strings.TrimSpace(sub[2])
			switch tag {
			case "atk":
				kinds := map[string]string{"mw": "近战武器攻击：", "rw": "远程武器攻击：", "ms": "近战法术攻击：", "rs": "远程法术攻击：",
					"mw,rw": "近战或远程武器攻击：", "ms,rs": "近战或远程法术攻击："}
				return kinds[arg]
			case "atkr":
				kinds := map[string]string{"m": "近战攻击检定：", "r": "远程攻击检定：", "m,r": "近战或远程攻击检定："}
				return kinds[arg]
			case "hit":
				if n, err := strconv.Atoi(arg); err == nil && n >= 0 {
					return "+" + arg
				}
				return arg
			case "h":
				return "命中："
			case "dc":
				return "DC " + arg
			case "actSave":
				for _, a := range fiveAbility {
					if a[0] == arg {
						return a[1] + "豁免检定："
					}
				}
				return "豁免检定："
			case "actSaveFail":
				return "失败："
			case "actSaveSuccess":
				return "成功："
			case "actSaveSuccessOrFail":
				return "成功或失败："
			case "actTrigger":
				return "触发："
			case "actResponse":
				return "反应："
			case "recharge":
				if arg == "" || arg == "6" {
					return "（充能 6）"
				}
				return "（充能 " + arg + "~6）"
			case "chance":
				return strings.SplitN(arg, "|", 2)[0] + "%"
			}
			// generic: {@tag display|source|display text}
			parts := strings.Split(arg, "|")
			if len(parts) >= 3 && parts[2] != "" {
				return parts[2]
			}
			return regexp.MustCompile(`\s*\[[^\]]*\]$`).ReplaceAllString(parts[0], "")
		})
	}
	return s
}

// fiveEntries flattens 5etools entry arrays (strings, lists, nested "entries" blocks) to text.
func fiveEntries(v interface{}) string {
	var lines []string
	var walk func(v interface{})
	walk = func(v interface{}) {
		switch e := v.(type) {
		case string:
			lines = append(lines, fiveText(e))
		case []interface{}:
			for _, x := range e {
				walk(x)
			}
		case map[string]interface{}:
			if name, ok := e["name"].(string); ok && name != "" {
				lines = append(lines, fiveText(name)+"。")
			}
			for _, k := range []string{"entries", "items", "entry"} {
				if x, ok := e[k]; ok {
					walk(x)
				}
			}
		}
	}
	walk(v)
	return strings.Join(lines, "\n")
}

func fiveNum(v interface{}) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case string:
		f, err := strconv.ParseFloat(n, 64)
		return f, err == nil
	}
	return 0, false
}

func fiveBonus(n int) string {
	if n >= 0 {
		return "+" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// fiveList joins damage/condition lists, which mix strings and {immune:[...], note} objects.
func fiveList(v interface{}) string {
	var parts []string
	if arr, ok := v.([]interface{}); ok {
		for _, x := range arr {
			switch e := x.(type) {
			case string:
				parts = append(parts, fiveText(e))
			case map[string]interface{}:
				for _, k := range []string{"immune", "resist", "vulnerable", "conditionImmune"} {
					if inner, ok := e[k]; ok {
						s := fiveList(inner)
						if note, ok := e["note"].(string); ok {
							s += "（" + fiveText(note) + "）"
						}
						parts = append(parts, s)
					}
				}
				if s, ok := e["special"].(string); ok {
					parts = append(parts, fiveText(s))
				}
			}
		}
	}
	return strings.Join(parts, "，")
}

func convert5etoolsMonster(m map[string]interface{}, slug string) map[string]interface{} {
	str := func(k string) string { s, _ := m[k].(string); return s }
	sh := map[string]interface{}{"kind": "monster", "source": "bestiary/" + slug}
	name := str("name")
	if name == "" {
		name = str("ENG_name")
	}
	sh["name"] = ttCleanName(name, 40, slug)
	sh["en"] = str("ENG_name")

	// 体型 + 类型（标签），阵营
	var meta []string
	if sizes, ok := m["size"].([]interface{}); ok {
		var s []string
		for _, x := range sizes {
			if c, ok := x.(string); ok {
				s = append(s, fiveSize[c])
			}
		}
		meta = append(meta, strings.Join(s, "或"))
	}
	typ := ""
	switch t := m["type"].(type) {
	case string:
		typ = fiveType[t]
		if typ == "" {
			typ = t
		}
	case map[string]interface{}:
		if s, ok := t["type"].(string); ok {
			typ = fiveType[s]
			if typ == "" {
				typ = s
			}
		}
		if tags, ok := t["tags"].([]interface{}); ok {
			var ts []string
			for _, x := range tags {
				if s, ok := x.(string); ok {
					ts = append(ts, s)
				}
			}
			if len(ts) > 0 {
				typ += "（" + strings.Join(ts, "，") + "）"
			}
		}
	}
	align := ""
	if al, ok := m["alignment"].([]interface{}); ok {
		for _, x := range al {
			if s, ok := x.(string); ok {
				align += fiveAlign[s]
			}
		}
	}
	sh["meta"] = strings.TrimSpace(strings.Join(meta, "") + typ + "，" + align)
	if len(meta) > 0 {
		sh["size"] = meta[0]
	}

	// AC
	if acs, ok := m["ac"].([]interface{}); ok && len(acs) > 0 {
		switch a := acs[0].(type) {
		case float64:
			sh["ac"] = strconv.Itoa(int(a))
		case map[string]interface{}:
			if n, ok := fiveNum(a["ac"]); ok {
				ac := strconv.Itoa(int(n))
				if from, ok := a["from"].([]interface{}); ok && len(from) > 0 {
					var fs []string
					for _, f := range from {
						if s, ok := f.(string); ok {
							fs = append(fs, fiveText(s))
						}
					}
					ac += "（" + strings.Join(fs, "，") + "）"
				}
				sh["ac"] = ac
			}
		}
	}
	if hp, ok := m["hp"].(map[string]interface{}); ok {
		avg, _ := fiveNum(hp["average"])
		formula, _ := hp["formula"].(string)
		sh["hp"] = map[string]interface{}{"max": strconv.Itoa(int(avg)), "cur": strconv.Itoa(int(avg)), "formula": strings.ReplaceAll(formula, " ", "")}
	}
	if sp, ok := m["speed"].(map[string]interface{}); ok {
		var parts []string
		for _, k := range fiveSpeed {
			v, ok := sp[k[0]]
			if !ok {
				continue
			}
			cond := ""
			if obj, ok := v.(map[string]interface{}); ok {
				v = obj["number"]
				if c, ok := obj["condition"].(string); ok {
					cond = fiveText(c)
				}
			}
			if n, ok := fiveNum(v); ok {
				parts = append(parts, k[1]+strconv.Itoa(int(n))+"尺"+cond)
			}
		}
		sh["speed"] = strings.Join(parts, "，")
	}

	// 属性 / 豁免
	saves, _ := m["save"].(map[string]interface{})
	var abilities []map[string]interface{}
	for _, a := range fiveAbility {
		score, ok := fiveNum(m[a[0]])
		if !ok {
			continue
		}
		mod := fiveBonus(int(math.Floor((score - 10) / 2)))
		save, prof := mod, false
		if s, ok := saves[a[0]].(string); ok && s != "" {
			save, prof = strings.ReplaceAll(s, " ", ""), true
		}
		abilities = append(abilities, map[string]interface{}{
			"key": a[0], "name": a[1], "score": strconv.Itoa(int(score)), "mod": mod, "save": save, "saveProf": prof,
		})
		if a[0] == "dex" {
			sh["init"] = mod
		}
	}
	sh["abilities"] = abilities

	if sk, ok := m["skill"].(map[string]interface{}); ok {
		keys := make([]string, 0, len(sk))
		for k := range sk {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var skills []map[string]interface{}
		for _, k := range keys {
			b, ok := sk[k].(string)
			if !ok {
				continue
			}
			n := fiveSkill[k]
			if n == "" {
				n = k
			}
			skills = append(skills, map[string]interface{}{"name": n, "bonus": strings.ReplaceAll(b, " ", ""), "prof": true})
		}
		sh["skills"] = skills
	}

	var props []map[string]interface{}
	add := func(label, value string) {
		if value != "" {
			props = append(props, map[string]interface{}{"label": label, "value": value})
		}
	}
	add("易伤", fiveList(m["vulnerable"]))
	add("抗性", fiveList(m["resist"]))
	add("免疫", strings.Trim(fiveList(m["immune"])+"；"+fiveList(m["conditionImmune"]), "；"))
	senses := fiveList(m["senses"])
	if p, ok := fiveNum(m["passive"]); ok {
		senses = strings.Trim(senses+"；被动察觉 "+strconv.Itoa(int(p)), "；")
	}
	add("感官", senses)
	add("语言", fiveList(m["languages"]))
	cr := ""
	switch c := m["cr"].(type) {
	case string:
		cr = c
	case map[string]interface{}:
		cr, _ = c["cr"].(string)
	}
	if cr != "" {
		sh["cr"] = cr
		add("CR", cr)
	}
	sh["props"] = props

	var sections []map[string]interface{}
	section := func(title string, list interface{}, header interface{}) {
		var entries []map[string]interface{}
		if header != nil {
			if t := fiveEntries(header); t != "" {
				entries = append(entries, map[string]interface{}{"name": "", "text": t})
			}
		}
		if arr, ok := list.([]interface{}); ok {
			for _, x := range arr {
				e, ok := x.(map[string]interface{})
				if !ok {
					continue
				}
				n, _ := e["name"].(string)
				entries = append(entries, map[string]interface{}{"name": fiveText(n), "text": fiveEntries(e["entries"])})
			}
		}
		if len(entries) > 0 {
			sections = append(sections, map[string]interface{}{"title": title, "entries": entries})
		}
	}
	section("特质", m["trait"], nil)
	if sc := fiveSpellcasting(m["spellcasting"]); len(sc) > 0 {
		sections = append(sections, map[string]interface{}{"title": "施法", "entries": sc})
	}
	section("动作", m["action"], nil)
	section("附赠动作", m["bonus"], nil)
	section("反应", m["reaction"], nil)
	section("传奇动作", m["legendary"], m["legendaryHeader"])
	section("神话动作", m["mythic"], m["mythicHeader"])
	sh["sections"] = sections
	return sh
}

// fiveSpellcasting renders spellcasting blocks: header, at-will, X/day and leveled spell lists.
func fiveSpellcasting(v interface{}) []map[string]interface{} {
	arr, _ := v.([]interface{})
	var out []map[string]interface{}
	names := func(x interface{}) string {
		var s []string
		if list, ok := x.([]interface{}); ok {
			for _, n := range list {
				switch e := n.(type) {
				case string:
					s = append(s, fiveText(e))
				case map[string]interface{}:
					if en, ok := e["entry"].(string); ok {
						s = append(s, fiveText(en))
					}
				}
			}
		}
		return strings.Join(s, "，")
	}
	for _, x := range arr {
		sc, ok := x.(map[string]interface{})
		if !ok {
			continue
		}
		var lines []string
		if h := fiveEntries(sc["headerEntries"]); h != "" {
			lines = append(lines, h)
		}
		if w := names(sc["will"]); w != "" {
			lines = append(lines, "随意："+w)
		}
		if daily, ok := sc["daily"].(map[string]interface{}); ok {
			keys := make([]string, 0, len(daily))
			for k := range daily {
				keys = append(keys, k)
			}
			sort.Sort(sort.Reverse(sort.StringSlice(keys)))
			for _, k := range keys {
				label := strings.TrimSuffix(k, "e") + "/日"
				if strings.HasSuffix(k, "e") {
					label += "（各）"
				}
				lines = append(lines, label+"："+names(daily[k]))
			}
		}
		if spells, ok := sc["spells"].(map[string]interface{}); ok {
			keys := make([]string, 0, len(spells))
			for k := range spells {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				lv, _ := spells[k].(map[string]interface{})
				label := k + "环"
				if k == "0" {
					label = "戏法"
				}
				if slots, ok := fiveNum(lv["slots"]); ok && slots > 0 {
					label += fmt.Sprintf("（%d 个法术位）", int(slots))
				}
				lines = append(lines, label+"："+names(lv["spells"]))
			}
		}
		if f := fiveEntries(sc["footerEntries"]); f != "" {
			lines = append(lines, f)
		}
		n, _ := sc["name"].(string)
		out = append(out, map[string]interface{}{"name": fiveText(n), "text": strings.Join(lines, "\n")})
	}
	return out
}
