package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Character cards as stored by obr-suite's character-cards module (served as
// https://obr.dnd.center/characters/<room>/<card>/data.json, "schema_version": "0.3").
// The same JSON can be uploaded directly in the 角色 pane.

type cardJSON struct {
	Identity struct {
		CharacterName string `json:"character_name"`
		DisplayName   string `json:"display_name"`
		Player        string `json:"player"`
		Race          struct {
			Name    string `json:"name"`
			Subrace string `json:"subrace"`
		} `json:"race"`
		Alignment string `json:"alignment"`
	} `json:"identity"`
	Classes []struct {
		Name     string      `json:"name"`
		Subclass string      `json:"subclass"`
		Level    interface{} `json:"level"`
	} `json:"classes"`
	TotalLevel interface{} `json:"total_level"`
	Abilities  map[string]struct {
		Total    interface{} `json:"total"`
		Modifier interface{} `json:"modifier"`
		Save     struct {
			Proficient bool        `json:"proficient"`
			Bonus      interface{} `json:"bonus"`
		} `json:"save"`
	} `json:"abilities"`
	CoreStats struct {
		Prof       interface{} `json:"proficiency_bonus"`
		Initiative interface{} `json:"initiative"`
		AC         interface{} `json:"ac"`
		DC         interface{} `json:"dc"`
		Passive    interface{} `json:"passive_perception"`
		Speed      interface{} `json:"speed"`
		Size       string      `json:"size"`
		HP         struct {
			Current interface{} `json:"current"`
			Max     interface{} `json:"max"`
			Temp    interface{} `json:"temp"`
		} `json:"hp"`
		HitDice struct {
			Current interface{} `json:"current"`
			Max     interface{} `json:"max"`
			DieSize interface{} `json:"die_size"`
		} `json:"hit_dice"`
	} `json:"core_stats"`
	Defenses map[string][]string `json:"defenses"`
	Skills   []struct {
		Name        string      `json:"name"`
		Ability     string      `json:"ability"`
		Proficiency string      `json:"proficiency"`
		Total       interface{} `json:"total"`
	} `json:"skills"`
	Combat struct {
		Weapons []struct {
			Name            string `json:"name"`
			AttackBonus     string `json:"attack_bonus"`
			Damage          string `json:"damage"`
			DamageType      string `json:"damage_type"`
			ExtraDamage     string `json:"extra_damage"`
			ExtraDamageType string `json:"extra_damage_type"`
			Mastery         string `json:"mastery"`
			MasteryEffect   string `json:"mastery_effect"`
			Properties      string `json:"properties"`
		} `json:"weapons"`
	} `json:"combat"`
	Spellcasting struct {
		Ability   string      `json:"spellcasting_ability"`
		SaveDC    interface{} `json:"save_dc"`
		AttackBon interface{} `json:"attack_bonus"`
		Slots     map[string]struct {
			Current interface{} `json:"current"`
			Max     interface{} `json:"max"`
		} `json:"spell_slots"`
		SorceryPoints *struct {
			Current interface{} `json:"current"`
			Max     interface{} `json:"max"`
		} `json:"sorcery_points"`
		Always   []cardSpell `json:"always_known"`
		Cantrips []cardSpell `json:"cantrips_known"`
		Prepared []cardSpell `json:"prepared"`
	} `json:"spellcasting"`
	Features         map[string][]cardFeature `json:"features"`
	SpecialResources []map[string]interface{} `json:"special_resources"`
	AutoResources    []map[string]interface{} `json:"auto_resources"`
	Background       struct {
		Name        string `json:"background_name"`
		Personality string `json:"personality"`
		Appearance  string `json:"appearance"`
		Ideals      string `json:"ideals"`
		Bonds       string `json:"bonds"`
		Flaws       string `json:"flaws"`
		Story       string `json:"story"`
	} `json:"background"`
}

type cardSpell struct {
	Level       interface{} `json:"level"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Meta        struct {
		School        string `json:"school"`
		CastingTime   string `json:"casting_time"`
		Range         string `json:"range"`
		Components    string `json:"components"`
		Duration      string `json:"duration"`
		Concentration bool   `json:"concentration"`
		Ritual        bool   `json:"ritual"`
		English       string `json:"english"`
	} `json:"meta"`
}

type cardFeature struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// cardStr renders numbers / numeric strings without trailing ".0"; nil → "".
func cardStr(v interface{}) string {
	switch x := v.(type) {
	case nil:
		return ""
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case string:
		return strings.TrimSpace(x)
	case bool:
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(v))
}

// cardBonus: 3 → "+3", "D20+6" → "+6", "-1" → "-1".
func cardBonus(v interface{}) string {
	s := strings.ToLower(strings.ReplaceAll(cardStr(v), " ", ""))
	s = strings.TrimPrefix(s, "d20")
	if s == "" {
		return ""
	}
	if !strings.HasPrefix(s, "+") && !strings.HasPrefix(s, "-") {
		s = "+" + s
	}
	return s
}

var cardAbilityNames = map[string]string{"str": "力量", "dex": "敏捷", "con": "体质", "int": "智力", "wis": "感知", "cha": "魅力"}

// looksLikeCardJSON reports whether data is an obr-suite character card.
func looksLikeCardJSON(raw map[string]json.RawMessage) bool {
	_, a := raw["identity"]
	_, b := raw["abilities"]
	_, c := raw["core_stats"]
	return a && b && c
}

// convertCardJSON maps an obr-suite character card to the tabletop sheet format
// (same fields as parseDnd5eCard, plus spell texts so they show without a lookup).
func convertCardJSON(data []byte) (map[string]interface{}, error) {
	var raw map[string]json.RawMessage
	if json.Unmarshal(data, &raw) != nil || !looksLikeCardJSON(raw) {
		return nil, errors.New("不是支持的角色卡 JSON（需要 obr-suite 角色卡的 data.json）")
	}
	var c cardJSON
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, errors.New("角色卡 JSON 格式错误：" + err.Error())
	}

	name := strings.TrimSpace(c.Identity.DisplayName)
	if name == "" {
		name = strings.TrimSpace(c.Identity.CharacterName)
	}
	if name == "" {
		name = "未命名角色"
	}

	var abilities []map[string]interface{}
	for _, key := range []string{"str", "dex", "con", "int", "wis", "cha"} {
		a, ok := c.Abilities[key]
		if !ok {
			continue
		}
		abilities = append(abilities, map[string]interface{}{
			"key": key, "name": cardAbilityNames[key],
			"score": cardStr(a.Total), "mod": cardBonus(a.Modifier), "save": cardBonus(a.Save.Bonus), "saveProf": a.Save.Proficient,
		})
	}

	var skills []map[string]interface{}
	for _, s := range c.Skills {
		if s.Name == "" {
			continue
		}
		skills = append(skills, map[string]interface{}{
			"name": s.Name, "ability": cardAbilityNames[s.Ability], "bonus": cardBonus(s.Total),
			"prof": s.Proficiency != "" && s.Proficiency != "none",
		})
	}

	var attacks []map[string]interface{}
	for _, w := range c.Combat.Weapons {
		if strings.TrimSpace(w.Name) == "" {
			continue
		}
		props := w.Properties
		if w.ExtraDamage != "" {
			props = strings.Trim(props+" · 额外伤害 "+w.ExtraDamage+" "+w.ExtraDamageType, " ·")
		}
		attacks = append(attacks, map[string]interface{}{
			"name": w.Name, "atk": cardBonus(w.AttackBonus), "damage": strings.ReplaceAll(w.Damage, " ", ""),
			"type": w.DamageType, "props": props, "mastery": w.Mastery, "effect": w.MasteryEffect,
		})
	}

	sp := c.Spellcasting
	var casting []map[string]interface{}
	if sp.Ability != "" {
		casting = append(casting, map[string]interface{}{"ability": sp.Ability, "dc": cardStr(sp.SaveDC), "atk": cardBonus(sp.AttackBon)})
	}
	var slots []map[string]interface{}
	levels := make([]string, 0, len(sp.Slots))
	for lv := range sp.Slots {
		levels = append(levels, lv)
	}
	sort.Slice(levels, func(i, j int) bool { a, _ := strconv.Atoi(levels[i]); b, _ := strconv.Atoi(levels[j]); return a < b })
	for _, lv := range levels {
		s := sp.Slots[lv]
		if max := cardStr(s.Max); max != "" && max != "0" {
			cur := cardStr(s.Current)
			if cur == "" {
				cur = max
			}
			slots = append(slots, map[string]interface{}{"level": lv, "cur": cur, "max": max})
		}
	}
	var spells []map[string]interface{}
	seen := map[string]bool{}
	for _, list := range [][]cardSpell{sp.Cantrips, sp.Always, sp.Prepared} {
		for _, s := range list {
			n := strings.TrimSpace(s.Name)
			if n == "" || seen[n] {
				continue
			}
			seen[n] = true
			m := s.Meta
			var meta []string
			for _, part := range []string{m.School, m.CastingTime, m.Range, m.Components, m.Duration} {
				if strings.TrimSpace(part) != "" {
					meta = append(meta, strings.TrimSpace(part))
				}
			}
			if m.Concentration && !strings.Contains(m.Duration, "专注") {
				meta = append(meta, "专注")
			}
			if m.Ritual {
				meta = append(meta, "仪式")
			}
			spell := map[string]interface{}{"level": cardStr(s.Level), "name": n}
			if s.Description != "" {
				spell["text"] = s.Description
			}
			if len(meta) > 0 {
				spell["meta"] = strings.Join(meta, " · ")
			}
			if m.English != "" {
				spell["en"] = m.English
			}
			spells = append(spells, spell)
		}
	}

	var resources []map[string]interface{}
	for _, r := range c.SpecialResources {
		n := cardStr(r["name"])
		max := cardStr(r["max"])
		cur := cardStr(r["current"])
		if cur == "" {
			cur = cardStr(r["cur"])
		}
		if n == "" || n == "特殊能力" || max == "" || max == "0" {
			continue
		}
		resources = append(resources, map[string]interface{}{"name": n, "cur": cur, "max": max})
	}
	// the template fills sorcery points for everyone; only sorcerers have them
	isSorcerer := false
	for _, cl := range c.Classes {
		if strings.Contains(cl.Name, "术士") {
			isSorcerer = true
		}
	}
	if p := sp.SorceryPoints; p != nil && isSorcerer {
		if max := cardStr(p.Max); max != "" && max != "0" {
			resources = append(resources, map[string]interface{}{"name": "术法点", "cur": cardStr(p.Current), "max": max})
		}
	}

	var features []map[string]interface{}
	for _, key := range []string{"class_features", "race_features", "feats", "fighting_style_feats", "special_abilities"} {
		for _, f := range c.Features[key] {
			if strings.TrimSpace(f.Name) != "" && strings.TrimSpace(f.Description) != "" {
				features = append(features, map[string]interface{}{"name": f.Name, "text": f.Description})
			}
		}
	}
	bg := c.Background
	var bgText []string
	for _, kv := range [][2]string{{"性格", bg.Personality}, {"理想", bg.Ideals}, {"牵绊", bg.Bonds}, {"缺点", bg.Flaws}, {"外貌", bg.Appearance}, {"背景故事", bg.Story}} {
		if strings.TrimSpace(kv[1]) != "" {
			bgText = append(bgText, kv[0]+"："+strings.TrimSpace(kv[1]))
		}
	}
	if len(bgText) > 0 {
		title := "背景"
		if bg.Name != "" {
			title += " · " + bg.Name
		}
		features = append(features, map[string]interface{}{"name": title, "text": strings.Join(bgText, "\n\n")})
	}

	var props []map[string]interface{}
	for _, kv := range [][2]string{{"resistances", "抗性"}, {"immunities", "免疫"}, {"advantages", "优势"}, {"disadvantages", "劣势"}} {
		if list := c.Defenses[kv[0]]; len(list) > 0 {
			props = append(props, map[string]interface{}{"label": kv[1], "value": strings.Join(list, "、")})
		}
	}

	var classes []string
	class, subclass := "", ""
	for i, cl := range c.Classes {
		if strings.TrimSpace(cl.Name) == "" {
			continue
		}
		if i == 0 || class == "" {
			class, subclass = cl.Name, cl.Subclass
		}
		classes = append(classes, strings.TrimSpace(cl.Name+" "+cardStr(cl.Level)))
	}
	if len(classes) > 1 {
		class, subclass = strings.Join(classes, " / "), ""
	}

	hpMax := cardStr(c.CoreStats.HP.Max)
	hpCur := cardStr(c.CoreStats.HP.Current)
	if hpMax == "" || hpMax == "0" {
		hpMax = hpCur
	}
	hd := ""
	if max := cardStr(c.CoreStats.HitDice.Max); max != "" && max != "0" {
		hd = cardStr(c.CoreStats.HitDice.Current) + "/" + max
		if d := cardStr(c.CoreStats.HitDice.DieSize); d != "" {
			hd += " d" + strings.TrimPrefix(strings.ToLower(d), "d")
		}
	}
	speed := cardStr(c.CoreStats.Speed)
	if _, err := strconv.ParseFloat(speed, 64); err == nil {
		speed += " 尺"
	}

	sheet := map[string]interface{}{
		"kind": "pc", "name": ttCleanName(name, 60, "未命名角色"),
		"player":    c.Identity.Player,
		"class":     class,
		"subclass":  subclass,
		"level":     cardStr(c.TotalLevel),
		"race":      strings.TrimSpace(c.Identity.Race.Name + " " + c.Identity.Race.Subrace),
		"alignment": c.Identity.Alignment,
		"prof":      cardBonus(c.CoreStats.Prof),
		"init":      cardBonus(c.CoreStats.Initiative),
		"ac":        cardStr(c.CoreStats.AC),
		"dc":        cardStr(c.CoreStats.DC),
		"passive":   cardStr(c.CoreStats.Passive),
		"speed":     speed,
		"size":      c.CoreStats.Size,
		"hp":        map[string]interface{}{"cur": hpCur, "max": hpMax, "temp": cardStr(c.CoreStats.HP.Temp)},
		"hd":        hd,
		"abilities": abilities,
		"skills":    skills,
		"attacks":   attacks,
		"casting":   casting,
		"slots":     slots,
		"spells":    spells,
		"resources": resources,
		"features":  features,
		"props":     props,
	}
	if sheet["init"] == "" {
		sheet["init"] = "+0"
	}
	// trim to the sheet size limit: long descriptions go first
	for _, key := range []string{"features", "spells"} {
		if b, _ := json.Marshal(sheet); len(b) <= ttMaxSheetSize-(8<<10) {
			break
		}
		list, _ := sheet[key].([]map[string]interface{})
		for _, it := range list {
			for _, f := range []string{"text"} {
				if t, _ := it[f].(string); len([]rune(t)) > 300 {
					it[f] = string([]rune(t)[:300]) + "…"
				}
			}
		}
	}
	return sheet, nil
}

// ===== Fetching cards referenced by an Owlbear export =====

var (
	cardURLRe  = regexp.MustCompile(`^/characters/([0-9a-fA-F]{16,128})/([0-9a-zA-Z_-]{4,40})/(index\.html)?$`)
	cardOrigin = "https://obr.dnd.center"
)

type ob2Card struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	URL        string `json:"url"`
	UploadedAt string `json:"uploaded_at"`
	UpdatedAt  string `json:"updated_at"`
}

// stamp: RFC 3339 times compare as strings
func (c ob2Card) stamp() string {
	if c.UpdatedAt > c.UploadedAt {
		return c.UpdatedAt
	}
	return c.UploadedAt
}

// cardDataURL turns the list entry's "/characters/<room>/<card>/index.html" into the data.json URL.
func cardDataURL(c ob2Card) string {
	m := cardURLRe.FindStringSubmatch(c.URL)
	if m == nil || m[2] != c.ID {
		return ""
	}
	return cardOrigin + "/characters/" + m[1] + "/" + m[2] + "/data.json"
}

// fetchCards downloads character cards (a few at a time) → card id → sheet.
func fetchCards(cards []ob2Card, stats *OB2ImportStats) map[string]map[string]interface{} {
	out := make(map[string]map[string]interface{})
	var mu sync.Mutex
	jobs := make(chan ob2Card)
	var wg sync.WaitGroup
	for w := 0; w < 3; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for c := range jobs {
				sh, err := fetchCard(c)
				mu.Lock()
				if err != nil {
					stats.Failed = append(stats.Failed, "角色卡 "+c.ID+"："+err.Error())
				} else {
					out[c.ID] = sh
				}
				mu.Unlock()
			}
		}()
	}
	for _, c := range cards {
		jobs <- c
	}
	close(jobs)
	wg.Wait()
	return out
}

func fetchCard(c ob2Card) (map[string]interface{}, error) {
	u := cardDataURL(c)
	if u == "" {
		return nil, errors.New("地址无效")
	}
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("User-Agent", "Haishin-Tabletop/1.0 (+self-hosted VTT)")
	req.Header.Set("Accept", "application/json")
	resp, err := ob2Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 8<<20 {
		return nil, errors.New("文件过大")
	}
	return convertCardJSON(data)
}
