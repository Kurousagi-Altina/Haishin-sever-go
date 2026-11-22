package main

import (
	"errors"
	"math/rand/v2"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// COC 7 版（克苏鲁的呼唤）检定。房间设置 rules = "coc" 时前端显示 COC 人物卡（sheet kind pc，system "coc"）。
// 服务器负责掷 d100（含奖励骰 / 惩罚骰）并判定成功等级，客户端只传目标值。
//
// op "coc"，mode：
//   ""/check  技能 / 属性检定：coc.value 目标值，coc.bonus（+N 奖励骰 / -N 惩罚骰，最多 2），coc.diff（0 普通 / 1 困难 / 2 极难）；
//             coc.sheet + coc.skill：成功后给这张卡上的该技能打「成长」标记
//   san       理智检定：coc.sheet 的 san.cur 为目标值，coc.loss = "成功损失/失败损失"（如 "1/1d6"），扣到卡上
//   grow      成长检定：coc.sheet 上所有打了标记的技能，d100 > 技能值或 > 95 则 +1d10，清掉标记

type TTCocReq struct {
	Sheet string `json:"sheet"`
	Skill string `json:"skill"`
	Value int    `json:"value"`
	Bonus int    `json:"bonus"`
	Diff  int    `json:"diff"`
	Loss  string `json:"loss"`
}

type TTCocGrow struct {
	Name string `json:"name"`
	From int    `json:"from"`
	Roll int    `json:"roll"`
	Gain int    `json:"gain"` // 0 = 没有成长
}

type TTCocResult struct {
	Mode  string `json:"mode,omitempty"` // "" 检定 / san / grow
	Value int    `json:"value"`
	Roll  int    `json:"roll"`
	Units int    `json:"units"`
	Tens  []int  `json:"tens,omitempty"` // 十位骰（0、10 … 90），奖励 / 惩罚骰时有多个
	Bonus int    `json:"bonus,omitempty"`
	Diff  int    `json:"diff,omitempty"`
	Level string `json:"level"` // crit / extreme / hard / regular / fail / fumble
	Pass  bool   `json:"pass"`  // 达到要求的难度
	Mark  bool   `json:"mark,omitempty"`
	// 理智检定
	Loss     string        `json:"loss,omitempty"`
	LossRoll *TTDiceResult `json:"lossRoll,omitempty"`
	SanFrom  int           `json:"sanFrom,omitempty"`
	SanTo    int           `json:"sanTo,omitempty"`
	// 成长检定
	Grow []TTCocGrow `json:"grow,omitempty"`
}

var ttCocLevelRank = map[string]int{"fumble": -1, "fail": 0, "regular": 1, "hard": 2, "extreme": 3, "crit": 4}

// ttCocD100 掷 d100：一颗个位骰 + (1 + |bonus|) 颗十位骰，奖励骰取最小、惩罚骰取最大（00 + 0 = 100）。
func ttCocD100(bonus int) (roll, units int, tens []int) {
	if bonus > 2 {
		bonus = 2
	} else if bonus < -2 {
		bonus = -2
	}
	units = rand.IntN(10)
	n := 1 + bonus
	if bonus < 0 {
		n = 1 - bonus
	}
	val := func(t int) int {
		if t == 0 && units == 0 {
			return 100
		}
		return t + units
	}
	roll = -1
	for i := 0; i < n; i++ {
		t := rand.IntN(10) * 10
		tens = append(tens, t)
		v := val(t)
		if roll < 0 || (bonus > 0 && v < roll) || (bonus < 0 && v > roll) {
			roll = v
		}
	}
	return roll, units, tens
}

// ttCocLevel COC 7 版成功等级：01 大成功；技能 < 50 时 96–100 大失败，否则只有 100；
// ≤ 1/5 极难，≤ 1/2 困难，≤ 技能值 普通成功。
func ttCocLevel(roll, value int) string {
	fumble := 100
	if value < 50 {
		fumble = 96
	}
	switch {
	case roll == 1:
		return "crit"
	case roll >= fumble:
		return "fumble"
	case roll <= value/5:
		return "extreme"
	case roll <= value/2:
		return "hard"
	case roll <= value:
		return "regular"
	}
	return "fail"
}

func ttCocCheck(value, bonus, diff int) *TTCocResult {
	if diff < 0 || diff > 2 {
		diff = 0
	}
	roll, units, tens := ttCocD100(bonus)
	lv := ttCocLevel(roll, value)
	return &TTCocResult{Value: value, Roll: roll, Units: units, Tens: tens, Bonus: bonus, Diff: diff, Level: lv, Pass: ttCocLevelRank[lv] >= diff+1}
}

func ttCocInt(v interface{}) int {
	f, _ := ttNum(v)
	return int(f)
}

// ttCocSkillValue 技能总值 = 初始 + 职业 + 兴趣 + 成长
func ttCocSkillValue(s map[string]interface{}) int {
	return ttCocInt(s["base"]) + ttCocInt(s["occ"]) + ttCocInt(s["int"]) + ttCocInt(s["grow"])
}

// 不能获得成长标记的技能
var ttCocNoMark = map[string]bool{"信用评级": true, "克苏鲁神话": true}

var ttCocDiceRe = regexp.MustCompile(`(\d*)d(\d+)`)

// ttCocDiceMax 骰子表达式的最大值（大失败时理智损失取最大）
func ttCocDiceMax(expr string) (int, bool) {
	s := strings.ToLower(strings.Join(strings.Fields(expr), ""))
	s = strings.ReplaceAll(s, "d%", "d100")
	s = ttCocDiceRe.ReplaceAllStringFunc(s, func(m string) string {
		p := ttCocDiceRe.FindStringSubmatch(m)
		n := 1
		if p[1] != "" {
			n, _ = strconv.Atoi(p[1])
		}
		sides, _ := strconv.Atoi(p[2])
		return strconv.Itoa(n * sides)
	})
	res, err := RollTabletopDice(s)
	if err != nil {
		return 0, false
	}
	return res.Total, true
}

func (room *TTRoom) cocSheet(id string, u ttUser, gm bool) (map[string]interface{}, int, string) {
	sh := room.Sheets[id]
	if sh == nil {
		return nil, http.StatusNotFound, "角色卡不存在"
	}
	if owner, _ := sh["owner"].(string); !gm && owner != u.name {
		return nil, http.StatusForbidden, "只能操作自己的角色卡"
	}
	return sh, 0, ""
}

func (room *TTRoom) applyCoc(u ttUser, gm bool, req *ttOpRequest) (int, string) {
	c := req.Coc
	if c == nil {
		return http.StatusBadRequest, "缺少检定参数"
	}
	e := newLogEntry("coc", u.name)
	e.Label = ttCleanName(req.Label, 40, "")
	e.Hidden = req.Hidden
	switch req.Mode {
	case "", "check":
		if c.Value < 0 || c.Value > 999 {
			return http.StatusBadRequest, "无效的目标值"
		}
		r := ttCocCheck(c.Value, c.Bonus, c.Diff)
		// 技能检定成功：打成长标记（只给自己能改的卡）
		if c.Sheet != "" && c.Skill != "" && !ttCocNoMark[c.Skill] && ttCocLevelRank[r.Level] >= 1 {
			if sh, st, _ := room.cocSheet(c.Sheet, u, gm); st == 0 {
				if list, ok := sh["cskills"].([]interface{}); ok {
					for _, x := range list {
						s, _ := x.(map[string]interface{})
						if s != nil && s["n"] == c.Skill {
							if !ttBool(s["mark"]) {
								s["mark"] = true
								r.Mark = true
								room.broadcastSheet(sh)
							}
							break
						}
					}
				}
			}
		}
		e.Coc = r

	case "san":
		sh, st, msg := room.cocSheet(c.Sheet, u, gm)
		if st != 0 {
			return st, msg
		}
		parts := strings.SplitN(strings.ReplaceAll(c.Loss, "／", "/"), "/", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
			return http.StatusBadRequest, "理智损失格式应为「成功/失败」，如 1/1d6"
		}
		san, _ := sh["san"].(map[string]interface{})
		if san == nil {
			san = map[string]interface{}{}
		}
		cur := ttCocInt(san["cur"])
		r := ttCocCheck(cur, c.Bonus, 0)
		r.Mode = "san"
		r.Loss = strings.TrimSpace(parts[0]) + "/" + strings.TrimSpace(parts[1])
		expr := strings.TrimSpace(parts[1])
		if r.Pass {
			expr = strings.TrimSpace(parts[0])
		}
		loss := 0
		if r.Level == "fumble" {
			m, ok := ttCocDiceMax(expr)
			if !ok {
				return http.StatusBadRequest, "无效的理智损失：" + expr
			}
			loss = m
			r.LossRoll = &TTDiceResult{Expr: expr + "（取最大）", Total: m}
		} else {
			lr, err := RollTabletopDice(expr)
			if err != nil {
				return http.StatusBadRequest, "无效的理智损失：" + err.Error()
			}
			loss = lr.Total
			r.LossRoll = lr
		}
		if loss < 0 {
			loss = 0
		}
		next := cur - loss
		if next < 0 {
			next = 0
		}
		r.SanFrom, r.SanTo = cur, next
		ns := map[string]interface{}{}
		for k, v := range san {
			ns[k] = v
		}
		ns["cur"] = next
		sh["san"] = ns
		room.broadcastSheet(sh)
		e.Coc = r

	case "grow":
		sh, st, msg := room.cocSheet(c.Sheet, u, gm)
		if st != 0 {
			return st, msg
		}
		list, _ := sh["cskills"].([]interface{})
		r := &TTCocResult{Mode: "grow"}
		for _, x := range list {
			s, _ := x.(map[string]interface{})
			if s == nil || !ttBool(s["mark"]) {
				continue
			}
			name, _ := s["n"].(string)
			v := ttCocSkillValue(s)
			roll := rand.IntN(100) + 1
			g := TTCocGrow{Name: name, From: v, Roll: roll}
			if roll > v || roll > 95 {
				g.Gain = rand.IntN(10) + 1
				s["grow"] = ttCocInt(s["grow"]) + g.Gain
			}
			delete(s, "mark")
			r.Grow = append(r.Grow, g)
		}
		if len(r.Grow) == 0 {
			return http.StatusBadRequest, "没有打了成长标记的技能"
		}
		room.broadcastSheet(sh)
		e.Coc = r
		e.Hidden = false

	default:
		return http.StatusBadRequest, "未知的检定类型"
	}
	room.addLog(e)
	return 0, ""
}

// ===== Excel 人物卡导入 =====
// 中文 COC 7 版 Excel 人物卡（工作表「人物卡」，固定单元格，读缓存值），转换成 system "coc" 的 pc 卡。
// 技能表两栏（行 16–49）：左栏 B 成长标记 / C 本职★ / D 名称 / E 专攻 / G 初始 / H 成长 / I 职业 / J 兴趣；
// 右栏 N / O / P / Q / R / S / T / U 同理。武器表从第 53 行起，背景故事在 O61–O77、M79。

var ttCocCircled = strings.NewReplacer("①", "", "②", "", "③", "", "④", "", "⑤", "")

func ttCocMarked(s string) bool {
	return strings.ContainsAny(s, "☑✔√■☒✓▣")
}

func parseCocCard(c xlsxCells) (map[string]interface{}, error) {
	if !strings.HasPrefix(c.str("J3"), "力量") || c.str("B14") != "技能表" || !strings.HasPrefix(c.str("P3"), "意志") {
		return nil, errors.New("不是可识别的 COC 7 版人物卡（工作表「人物卡」的格式不对）")
	}
	n := func(r string) int { return ttCocInt(c.num(r)) }
	name := c.str("C3")
	if name == "" {
		name = "未命名调查员"
	}
	era := c.str("D8")
	if era != "" {
		era += "年"
	}
	info := map[string]interface{}{
		"player": c.str("C4"), "occupation": c.str("C5"), "age": c.num("C6"), "sex": c.str("G6"),
		"residence": c.str("C7"), "birthplace": c.str("G7"), "era": era,
	}
	for k, v := range info {
		if v == "" {
			delete(info, k)
		}
	}
	attrs := map[string]interface{}{
		"str": n("K3"), "dex": n("N3"), "pow": n("Q3"), "con": n("K5"), "app": n("N5"), "edu": n("Q5"), "siz": n("K7"), "int": n("N7"),
	}
	skills := []interface{}{}
	seen := map[string]bool{}
	for _, col := range [][8]string{{"B", "C", "D", "E", "G", "H", "I", "J"}, {"N", "O", "P", "Q", "R", "S", "T", "U"}} {
		for row := 16; row <= 49; row++ {
			raw := c.str(ref(col[2], row))
			if raw == "" || raw == "自定义技能" {
				continue
			}
			base, grow, occ, intr := n(ref(col[4], row)), n(ref(col[5], row)), n(ref(col[6], row)), n(ref(col[7], row))
			raw = strings.TrimSpace(strings.ReplaceAll(raw, "Ω", "")) // Ω = 仅现代
			nm := strings.TrimSpace(ttCocCircled.Replace(raw))
			spec := c.str(ref(col[3], row))
			placeholder := nm != raw || strings.HasSuffix(nm, "：")
			nm = strings.TrimSuffix(nm, "：")
			if spec != "" {
				nm += "：" + spec
			} else if placeholder && nm != "母语" {
				nm += "："
			}
			// 没填专攻、也没加点的空白专攻行（技艺② 之类）只留一行
			if seen[nm] && grow+occ+intr == 0 {
				continue
			}
			seen[nm] = true
			s := map[string]interface{}{"n": nm, "base": base}
			if grow > 0 {
				s["grow"] = grow
			}
			if occ > 0 {
				s["occ"] = occ
			}
			if intr > 0 {
				s["int"] = intr
			}
			if c.str(ref(col[1], row)) == "★" {
				s["job"] = true
			}
			if ttCocMarked(c.str(ref(col[0], row))) {
				s["mark"] = true
			}
			switch {
			case nm == "闪避":
				s["auto"] = "dodge"
			case strings.HasPrefix(nm, "母语"):
				s["auto"] = "edu"
			}
			skills = append(skills, s)
		}
	}
	weapons := []interface{}{}
	for row := 53; row <= 59; row++ {
		wn := c.str(ref("B", row))
		if wn == "" || strings.HasPrefix(c.str(ref("E", row)), "←") {
			continue
		}
		if wn == "无" {
			wn = "徒手"
		}
		skill := c.str(ref("E", row))
		if skill == "斗殴" {
			skill = "格斗：斗殴"
		} else if skill == "手枪" || skill == "步枪/霰弹枪" || skill == "冲锋枪" || skill == "机枪" || skill == "弓" || skill == "重武器" || skill == "火焰喷射器" {
			skill = "射击：" + skill
		}
		w := map[string]interface{}{"name": wn, "skill": skill, "dmg": c.str(ref("J", row)), "range": c.str(ref("L", row)),
			"rof": c.num(ref("O", row)), "ammo": c.str(ref("Q", row)), "malf": c.str(ref("S", row))}
		for k, v := range w {
			if v == "" || v == "——" && k != "range" {
				delete(w, k)
			}
		}
		weapons = append(weapons, w)
	}
	story := map[string]interface{}{}
	for k, r := range map[string]string{"desc": "O61", "belief": "O63", "people": "O65", "places": "O67", "items": "O69", "traits": "O71",
		"secret": "O73", "scars": "O75", "phobia": "O77", "bg": "M79"} {
		if v := c.str(r); v != "" && !strings.HasPrefix(v, "***") {
			story[k] = v
		}
	}
	var gear []string
	for row := 79; row <= 94; row++ {
		for _, col := range []string{"D", "G"} {
			if v := c.str(ref(col, row)); v != "" {
				gear = append(gear, v)
			}
		}
	}
	if len(gear) > 0 {
		story["gear"] = strings.Join(gear, "\n")
	}
	if v := c.str("G63"); v != "" && !strings.HasPrefix(v, "请在这里") {
		story["assets"] = v
	}
	hpMax := n("E10")
	if hpMax == 0 {
		hpMax = (n("K5") + n("K7")) / 10
	}
	sh := map[string]interface{}{
		"kind": "pc", "system": "coc", "name": name, "info": info, "attrs": attrs,
		"hp":      map[string]interface{}{"cur": n("D10"), "max": hpMax},
		"san":     map[string]interface{}{"cur": n("I10"), "max": n("J10"), "start": n("Q3")},
		"mp":      map[string]interface{}{"cur": n("Q10"), "max": n("R10")},
		"luck":    map[string]interface{}{"cur": n("M10")},
		"cskills": skills, "weapons": weapons, "story": story,
	}
	if mov := n("Q7"); mov > 0 {
		attrs["mov"] = mov
	}
	return sh, nil
}
