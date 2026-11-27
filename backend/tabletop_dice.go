package main

import (
	"errors"
	"math/rand/v2"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// 跑团桌面专用的掷骰实现。它与 dice.go 里的骰子页面实现是两套独立代码：
// dice.go 服务 /api/dice/*，本文件服务 /api/tabletop/op 的 roll 操作。
// 符号统一加 TT 前缀以避免与 dice.go 冲突。

// Dice expressions: terms joined by + / -, each term a constant or NdM with optional
// keep/drop (kh, kl, dh, dl, k = kh) and exploding (!). e.g. "2d20kh1+5", "4d6dl1", "d%".
//
// 函数写法（玩家在聊天框 / 掷骰框里直接写，中文括号、逗号也认）：先从最里层往外展开成上面的内部写法再掷
//
//	adv(1d20) → 2d20kh1（优势）       dis(1d20) → 2d20kl1（劣势）
//	max(1d20,10) → 1d20mi10（保底）    min(1d20,15) → 1d20ma15（封顶）
//	reset(1d20,12) → 1d20r=12、resetmin(1d20,5) → 1d20r<=5、resetmax(1d20,18) → 1d20r>=18（各只重投一次）
//	burst(2d6) → 2d6!（掷到最大点再追加一颗，追加的也会再爆；burst(1d8,3) 最多追加 3 颗）
//	same(2d20) → 2d20s（点数相同的骰子标记出来，客户端高亮）
//	repeat(3,1d20+5) → 只能写在最外层：掷 3 次，每次的总数单独显示（Repeats）
// 函数可以嵌套，如 max(adv(1d20),10)+5；函数写法的结果 Expr 记原样（日志的重投按钮直接再掷一次）。

type TTDieRoll struct {
	Value    int  `json:"v"`
	Dropped  bool `json:"d,omitempty"`
	Exploded bool `json:"x,omitempty"`
	Rerolled bool `json:"r,omitempty"`
	Same     bool `json:"s,omitempty"` // same()：和别的骰子点数相同
	Orig     int  `json:"o,omitempty"` // 保底 / 封顶改过点数时，原来掷出的点数
}

type TTDiceTerm struct {
	Sign  int         `json:"sign"`
	Expr  string      `json:"expr"`
	Sides int         `json:"sides,omitempty"` // 0 for constants
	Rolls []TTDieRoll `json:"rolls,omitempty"`
	Value int         `json:"value"`
}

type TTDiceResult struct {
	Expr    string          `json:"expr"`
	Terms   []TTDiceTerm    `json:"terms"`
	Total   int             `json:"total"`
	Repeats []*TTDiceResult `json:"repeats,omitempty"` // repeat(n, …)：每次的结果（Total = 各次之和）
}

// NdM[kh|kl|dh|dl|k n][![n]][r(<|<=|>|>=|=)n][mi n][ma n]
//
//	!n  a die showing its maximum adds one more die, at most n extra dice per term (Sorcerous Burst: 1d8!3)
//	r…  reroll each die matching the condition once (Great Weapon Fighting: 2d6r<=2)
//	mi / ma  per-die minimum / maximum (Reliable Talent: 1d20mi10)
//
//	s   mark dice that show the same value (same())
//
// Groups: 1 count, 2 sides, 3 keep, 4 keep n, 5 "!", 6 explode cap, 7 reroll op, 8 reroll value, 9 mi, 10 ma, 11 "s".
var ttDiceTermRe = regexp.MustCompile(`^(\d*)d(\d+|%)(kh|kl|dh|dl|k)?(\d*)(?:(!)(\d*))?(?:r(<=|>=|<|>|=)?(\d+))?(?:mi(\d+))?(?:ma(\d+))?(s)?$`)

const (
	maxDiceCount    = 200
	maxDiceSides    = 10000
	maxDiceTerms    = 20
	maxDiceExplode  = 100
	maxDiceConstant = 1000000
)

var ttDiceNorm = strings.NewReplacer("＋", "+", "－", "-", "（", "(", "）", ")", "，", ",", "、", ",")

func RollTabletopDice(expr string) (*TTDiceResult, error) {
	s := ttDiceNorm.Replace(strings.ToLower(strings.Join(strings.Fields(expr), "")))
	if s == "" {
		return nil, errors.New("骰子表达式为空")
	}
	if len(s) > 200 {
		return nil, errors.New("骰子表达式过长")
	}
	if m := ttDiceRepeatRe.FindStringSubmatch(s); m != nil { // repeat(n, …)：同一个公式掷 n 次
		n, _ := strconv.Atoi(m[1])
		if n < 1 || n > 20 {
			return nil, errors.New("repeat 的次数需在 1-20 之间")
		}
		inner, err := ttExpandDiceFuncs(m[2])
		if err != nil {
			return nil, err
		}
		res := &TTDiceResult{Expr: s, Terms: []TTDiceTerm{}}
		used := 0
		for i := 0; i < n; i++ {
			r, u, err := ttRollExpanded(inner, maxDiceCount-used)
			if err != nil {
				return nil, err
			}
			used += u
			res.Repeats = append(res.Repeats, r)
			res.Total += r.Total
		}
		return res, nil
	}
	inner, err := ttExpandDiceFuncs(s)
	if err != nil {
		return nil, err
	}
	res, _, err := ttRollExpanded(inner, maxDiceCount)
	if err == nil && inner != s {
		res.Expr = s
	}
	return res, err
}

// ttRollExpanded rolls an expression in the internal grammar (no functions) with at most budget dice.
func ttRollExpanded(s string, budget int) (*TTDiceResult, int, error) {

	// Split into signed terms
	var raw []string
	var signs []int
	sign := 1
	cur := ""
	for _, c := range s {
		if c == '+' || c == '-' {
			if cur != "" {
				raw = append(raw, cur)
				signs = append(signs, sign)
				cur = ""
				sign = 1
			}
			if c == '-' {
				sign = -sign
			}
			continue
		}
		cur += string(c)
	}
	if cur == "" {
		return nil, 0, errors.New("骰子表达式不完整")
	}
	raw = append(raw, cur)
	signs = append(signs, sign)
	if len(raw) > maxDiceTerms {
		return nil, 0, errors.New("骰子表达式项数过多")
	}

	res := &TTDiceResult{}
	diceUsed := 0
	parts := make([]string, 0, len(raw))
	for i, t := range raw {
		term, n, err := ttRollTerm(t, budget-diceUsed)
		if err != nil {
			return nil, 0, err
		}
		diceUsed += n
		term.Sign = signs[i]
		res.Total += term.Sign * term.Value
		res.Terms = append(res.Terms, *term)

		op := "+"
		if term.Sign < 0 {
			op = "-"
		}
		if i == 0 {
			if term.Sign < 0 {
				parts = append(parts, "-"+term.Expr)
			} else {
				parts = append(parts, term.Expr)
			}
		} else {
			parts = append(parts, op, term.Expr)
		}
	}
	res.Expr = strings.Join(parts, " ")
	return res, diceUsed, nil
}

// ttRollTerm evaluates one term; budget is the number of dice still allowed.
// Returns the term and how many dice it used.
func ttRollTerm(t string, budget int) (*TTDiceTerm, int, error) {
	if n, err := strconv.Atoi(t); err == nil {
		if n > maxDiceConstant {
			return nil, 0, errors.New("常数过大")
		}
		return &TTDiceTerm{Expr: t, Value: n}, 0, nil
	}

	m := ttDiceTermRe.FindStringSubmatch(t)
	if m == nil {
		return nil, 0, errors.New("无法识别的骰子: " + t)
	}
	count := 1
	if m[1] != "" {
		count, _ = strconv.Atoi(m[1])
	}
	sides := 100
	if m[2] != "%" {
		sides, _ = strconv.Atoi(m[2])
	}
	if count < 1 || count > budget {
		return nil, 0, errors.New("骰子数量需在 1-" + strconv.Itoa(maxDiceCount) + " 之间")
	}
	if sides < 2 || sides > maxDiceSides {
		return nil, 0, errors.New("骰子面数需在 2-" + strconv.Itoa(maxDiceSides) + " 之间")
	}

	term := &TTDiceTerm{Expr: t, Sides: sides}
	explode := m[5] == "!"
	maxExtra := maxDiceExplode
	if m[6] != "" {
		maxExtra, _ = strconv.Atoi(m[6])
		if maxExtra > maxDiceExplode {
			maxExtra = maxDiceExplode
		}
	}
	extra := 0
	for i := 0; i < count; i++ {
		v := rand.IntN(sides) + 1
		roll := TTDieRoll{Value: v}
		if explode && v == sides && extra < maxExtra && count < budget {
			roll.Exploded = true
			count++
			extra++
		}
		term.Rolls = append(term.Rolls, roll)
	}

	// reroll once, then clamp (before keep / drop so "2d20kh1" + "mi10" behaves per die)
	if m[8] != "" {
		lim, _ := strconv.Atoi(m[8])
		match := func(v int) bool {
			switch m[7] {
			case "<":
				return v < lim
			case "<=":
				return v <= lim
			case ">":
				return v > lim
			case ">=":
				return v >= lim
			}
			return v == lim
		}
		for i := range term.Rolls {
			if match(term.Rolls[i].Value) {
				term.Rolls[i].Value = rand.IntN(sides) + 1
				term.Rolls[i].Rerolled = true
			}
		}
	}
	if m[9] != "" {
		lo, _ := strconv.Atoi(m[9])
		for i := range term.Rolls {
			if term.Rolls[i].Value < lo {
				if term.Rolls[i].Orig == 0 {
					term.Rolls[i].Orig = term.Rolls[i].Value
				}
				term.Rolls[i].Value = lo
			}
		}
	}
	if m[10] != "" {
		hi, _ := strconv.Atoi(m[10])
		for i := range term.Rolls {
			if term.Rolls[i].Value > hi {
				if term.Rolls[i].Orig == 0 {
					term.Rolls[i].Orig = term.Rolls[i].Value
				}
				term.Rolls[i].Value = hi
			}
		}
	}

	if mode := m[3]; mode != "" {
		n := 1
		if m[4] != "" {
			n, _ = strconv.Atoi(m[4])
		}
		ttApplyKeepDrop(term.Rolls, mode, n)
	} else if m[4] != "" {
		return nil, 0, errors.New("无法识别的骰子: " + t)
	}

	if m[11] == "s" { // same()：留下来的骰子里点数相同的标出来
		cnt := map[int]int{}
		for _, r := range term.Rolls {
			if !r.Dropped {
				cnt[r.Value]++
			}
		}
		for i := range term.Rolls {
			if !term.Rolls[i].Dropped && cnt[term.Rolls[i].Value] > 1 {
				term.Rolls[i].Same = true
			}
		}
	}
	for _, r := range term.Rolls {
		if !r.Dropped {
			term.Value += r.Value
		}
	}
	return term, len(term.Rolls), nil
}

func ttApplyKeepDrop(rolls []TTDieRoll, mode string, n int) {
	idx := make([]int, len(rolls))
	for i := range idx {
		idx[i] = i
	}
	// ascending by value; stable so ties drop the earlier die first
	sort.SliceStable(idx, func(a, b int) bool { return rolls[idx[a]].Value < rolls[idx[b]].Value })

	if n < 0 {
		n = 0
	}
	if n > len(rolls) {
		n = len(rolls)
	}
	var drop []int
	switch mode {
	case "kh", "k": // keep highest n → drop lowest len-n
		drop = idx[:len(rolls)-n]
	case "kl": // keep lowest n → drop highest len-n
		drop = idx[n:]
	case "dh": // drop highest n
		drop = idx[len(rolls)-n:]
	case "dl": // drop lowest n
		drop = idx[:n]
	}
	for _, i := range drop {
		rolls[i].Dropped = true
	}
}

// ===== 函数写法 → 内部写法 =====

var (
	ttDiceRepeatRe = regexp.MustCompile(`^repeat\((\d+),(.+)\)$`)
	ttDiceFuncRe   = regexp.MustCompile(`([a-z]+)\(([^()]*)\)`)
)

// ttTermParts is one NdM term split into its pieces (see ttDiceTermRe), so functions can add modifiers.
type ttTermParts struct {
	count, sides, keep, keepN, bang, exCap, rop, rlim string
	mi, ma                                            int
	same                                              bool
}

func ttParseTerm(t string) (*ttTermParts, bool) {
	m := ttDiceTermRe.FindStringSubmatch(t)
	if m == nil {
		return nil, false
	}
	p := &ttTermParts{count: m[1], sides: m[2], keep: m[3], keepN: m[4], bang: m[5], exCap: m[6], rop: m[7], rlim: m[8], same: m[11] == "s"}
	p.mi, _ = strconv.Atoi(m[9])
	p.ma, _ = strconv.Atoi(m[10])
	return p, true
}

func (p *ttTermParts) String() string {
	s := p.count + "d" + p.sides + p.keep + p.keepN + p.bang + p.exCap
	if p.rlim != "" {
		s += "r" + p.rop + p.rlim
	}
	if p.mi > 0 {
		s += "mi" + strconv.Itoa(p.mi)
	}
	if p.ma > 0 {
		s += "ma" + strconv.Itoa(p.ma)
	}
	if p.same {
		s += "s"
	}
	return s
}

func (p *ttTermParts) nSides() int {
	if p.sides == "%" {
		return 100
	}
	n, _ := strconv.Atoi(p.sides)
	return n
}

// ttExpandDiceFuncs expands the function forms from the innermost call outwards.
func ttExpandDiceFuncs(s string) (string, error) {
	for i := 0; i < 30 && strings.Contains(s, "("); i++ {
		var ferr error
		next := ttDiceFuncRe.ReplaceAllStringFunc(s, func(call string) string {
			m := ttDiceFuncRe.FindStringSubmatch(call)
			out, err := ttDiceFunc(m[1], strings.Split(m[2], ","))
			if err != nil && ferr == nil {
				ferr = err
			}
			return out
		})
		if ferr != nil {
			return "", ferr
		}
		if next == s {
			break
		}
		s = next
	}
	if strings.ContainsAny(s, "(),") {
		return "", errors.New("括号不配对，或者用了不认识的写法（可用 adv、dis、max、min、reset、resetmin、resetmax、burst、same、repeat）")
	}
	return s, nil
}

func ttDiceFunc(name string, args []string) (string, error) {
	need := func(n ...int) error {
		for _, k := range n {
			if len(args) == k {
				return nil
			}
		}
		return errors.New(name + "() 的参数个数不对")
	}
	term := func() (*ttTermParts, error) {
		p, ok := ttParseTerm(args[0])
		if !ok {
			return nil, errors.New(name + "() 里要写一种骰子，如 " + name + "(1d20…)")
		}
		return p, nil
	}
	num := func(i, lo, hi int) (int, error) {
		n, err := strconv.Atoi(args[i])
		if err != nil || n < lo || n > hi {
			return 0, errors.New(name + "() 的数字需在 " + strconv.Itoa(lo) + "-" + strconv.Itoa(hi) + " 之间")
		}
		return n, nil
	}
	switch name {
	case "repeat":
		return "", errors.New("repeat 只能写在最外层，如 repeat(3,1d20+5)")
	case "adv", "dis", "max", "min", "reset", "resetmin", "resetmax", "burst", "same":
	default:
		return "", errors.New("不认识的写法：" + name + "()")
	}
	switch name {
	case "adv", "dis", "same":
		if err := need(1); err != nil {
			return "", err
		}
	case "burst":
		if err := need(1, 2); err != nil {
			return "", err
		}
	default:
		if err := need(2); err != nil {
			return "", err
		}
	}
	p, err := term()
	if err != nil {
		return "", err
	}
	sides := p.nSides()
	switch name {
	case "adv", "dis":
		if (p.count != "" && p.count != "1") || p.keep != "" {
			return "", errors.New(name + "() 只能用于一颗骰子，如 " + name + "(1d20)")
		}
		p.count, p.keepN = "2", "1"
		p.keep = map[string]string{"adv": "kh", "dis": "kl"}[name]
	case "max":
		n, err := num(1, 1, sides)
		if err != nil {
			return "", err
		}
		if n > p.mi {
			p.mi = n
		}
	case "min":
		n, err := num(1, 1, sides)
		if err != nil {
			return "", err
		}
		if p.ma == 0 || n < p.ma {
			p.ma = n
		}
	case "reset", "resetmin", "resetmax":
		n, err := num(1, 1, sides)
		if err != nil {
			return "", err
		}
		if p.rlim != "" {
			return "", errors.New("同一种骰子只能设一个重投条件")
		}
		p.rop = map[string]string{"reset": "=", "resetmin": "<=", "resetmax": ">="}[name]
		p.rlim = strconv.Itoa(n)
	case "burst":
		p.bang, p.exCap = "!", ""
		if len(args) == 2 {
			n, err := num(1, 1, maxDiceExplode)
			if err != nil {
				return "", err
			}
			p.exCap = strconv.Itoa(n)
		}
	case "same":
		p.same = true
	}
	return p.String(), nil
}

// ttEmpower: 强效法术 — reroll (once) up to n dice that rolled below their average, the lowest first;
// the new results stand. Terms with keep / drop are skipped. Returns how many dice were rerolled.
func ttEmpower(r *TTDiceResult, n int) int {
	if r == nil || n <= 0 {
		return 0
	}
	type ref struct{ t, i int }
	var cand []ref
	for ti := range r.Terms {
		tm := &r.Terms[ti]
		m := ttDiceTermRe.FindStringSubmatch(tm.Expr)
		if tm.Sides < 2 || tm.Sign < 0 || m == nil || m[3] != "" {
			continue
		}
		for i, d := range tm.Rolls {
			if !d.Dropped && float64(d.Value) < float64(tm.Sides+1)/2 {
				cand = append(cand, ref{ti, i})
			}
		}
	}
	rel := func(c ref) float64 { return float64(r.Terms[c.t].Rolls[c.i].Value) / float64(r.Terms[c.t].Sides) }
	sort.SliceStable(cand, func(a, b int) bool { return rel(cand[a]) < rel(cand[b]) })
	if len(cand) > n {
		cand = cand[:n]
	}
	for _, c := range cand {
		tm := &r.Terms[c.t]
		d := &tm.Rolls[c.i]
		nv := rand.IntN(tm.Sides) + 1
		if m := ttDiceTermRe.FindStringSubmatch(tm.Expr); m != nil && m[9] != "" { // 元素掌控的 mi2 照样保底
			if lo, _ := strconv.Atoi(m[9]); nv < lo {
				nv = lo
			}
		}
		if d.Orig == 0 {
			d.Orig = d.Value
		}
		delta := nv - d.Value
		d.Value = nv
		d.Rerolled = true
		tm.Value += delta
		r.Total += delta
	}
	return len(cand)
}
