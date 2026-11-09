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

type TTDieRoll struct {
	Value    int  `json:"v"`
	Dropped  bool `json:"d,omitempty"`
	Exploded bool `json:"x,omitempty"`
	Rerolled bool `json:"r,omitempty"`
}

type TTDiceTerm struct {
	Sign  int         `json:"sign"`
	Expr  string      `json:"expr"`
	Sides int         `json:"sides,omitempty"` // 0 for constants
	Rolls []TTDieRoll `json:"rolls,omitempty"`
	Value int         `json:"value"`
}

type TTDiceResult struct {
	Expr  string       `json:"expr"`
	Terms []TTDiceTerm `json:"terms"`
	Total int          `json:"total"`
}

// NdM[kh|kl|dh|dl|k n][!][r(<|<=|>|>=|=)n][mi n][ma n]
//
//	r…  reroll each die matching the condition once (Great Weapon Fighting: 2d6r<=2)
//	mi / ma  per-die minimum / maximum (Reliable Talent: 1d20mi10)
var ttDiceTermRe = regexp.MustCompile(`^(\d*)d(\d+|%)(kh|kl|dh|dl|k)?(\d*)(!)?(?:r(<=|>=|<|>|=)?(\d+))?(?:mi(\d+))?(?:ma(\d+))?$`)

const (
	maxDiceCount    = 200
	maxDiceSides    = 10000
	maxDiceTerms    = 20
	maxDiceExplode  = 100
	maxDiceConstant = 1000000
)

func RollTabletopDice(expr string) (*TTDiceResult, error) {
	s := strings.ToLower(strings.Join(strings.Fields(expr), ""))
	s = strings.ReplaceAll(s, "＋", "+")
	s = strings.ReplaceAll(s, "－", "-")
	if s == "" {
		return nil, errors.New("骰子表达式为空")
	}
	if len(s) > 120 {
		return nil, errors.New("骰子表达式过长")
	}

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
		return nil, errors.New("骰子表达式不完整")
	}
	raw = append(raw, cur)
	signs = append(signs, sign)
	if len(raw) > maxDiceTerms {
		return nil, errors.New("骰子表达式项数过多")
	}

	res := &TTDiceResult{}
	diceUsed := 0
	parts := make([]string, 0, len(raw))
	for i, t := range raw {
		term, n, err := ttRollTerm(t, maxDiceCount-diceUsed)
		if err != nil {
			return nil, err
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
	return res, nil
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
	extra := 0
	for i := 0; i < count; i++ {
		v := rand.IntN(sides) + 1
		roll := TTDieRoll{Value: v}
		if explode && v == sides && extra < maxDiceExplode && count < budget {
			roll.Exploded = true
			count++
			extra++
		}
		term.Rolls = append(term.Rolls, roll)
	}

	// reroll once, then clamp (before keep / drop so "2d20kh1" + "mi10" behaves per die)
	if m[7] != "" {
		lim, _ := strconv.Atoi(m[7])
		match := func(v int) bool {
			switch m[6] {
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
	if m[8] != "" {
		lo, _ := strconv.Atoi(m[8])
		for i := range term.Rolls {
			if term.Rolls[i].Value < lo {
				term.Rolls[i].Value = lo
			}
		}
	}
	if m[9] != "" {
		hi, _ := strconv.Atoi(m[9])
		for i := range term.Rolls {
			if term.Rolls[i].Value > hi {
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
