package main

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// 掷骰表达式限制 —— 防止手滑或恶意表达式变成一次百万颗骰子的投掷。
const (
	maxDicePerTerm = 100
	maxTotalDice   = 200
	maxSides       = 1000
	maxExprLen     = 200
	maxExplosions  = 200
)

// 支持写法: 2d6 / d20 / 4d6dl1 / 2d20kh1 / 1d6! / +3 / -1
var diceTermRe = regexp.MustCompile(`^(\d*)d(\d+)(?:(kh|kl|dh|dl)(\d*))?(!)?$`)

// DieRoll 是一颗实际掷出的骰子。
type DieRoll struct {
	Value   int  `json:"value"`
	Kept    bool `json:"kept"`
	Explode bool `json:"explode,omitempty"` // 由"爆炸"追加的骰子
}

// DiceTerm 是表达式中由 + / - 分隔的一段。
type DiceTerm struct {
	Expression string    `json:"expression"`
	Dice       []DieRoll `json:"dice,omitempty"`
	Modifier   int       `json:"modifier,omitempty"`
	IsModifier bool      `json:"is_modifier,omitempty"`
	Value      int       `json:"value"`
}

// RollResult 是一次完整投掷的结果。
type RollResult struct {
	Expression string     `json:"expression"`
	Terms      []DiceTerm `json:"terms"`
	Total      int        `json:"total"`
	Crit       string     `json:"crit,omitempty"` // "success"(大成功) | "fumble"(大失败)
}

type diceTermSpec struct {
	sign     int
	count    int
	sides    int
	keepMode string // "" | "kh" | "kl" | "dh" | "dl"
	keepN    int
	explode  bool
	flat     int
	isFlat   bool
	raw      string
}

// ValidateExpression 只解析不投掷，用于保存预设时校验。
func ValidateExpression(expression string) error {
	_, err := parseExpression(expression)
	return err
}

// RollDice 解析并投掷一个骰子表达式。
func RollDice(expression string) (*RollResult, error) {
	specs, err := parseExpression(expression)
	if err != nil {
		return nil, err
	}

	totalDice := 0
	for _, s := range specs {
		if !s.isFlat {
			totalDice += s.count
		}
	}
	if totalDice > maxTotalDice {
		return nil, fmt.Errorf("单次最多投掷 %d 颗骰子", maxTotalDice)
	}

	normalized := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(expression), " ", ""))
	result := &RollResult{Expression: normalized, Terms: make([]DiceTerm, 0, len(specs))}

	total := 0
	explosionBudget := maxExplosions

	for _, spec := range specs {
		term := DiceTerm{Expression: spec.raw}

		if spec.isFlat {
			term.IsModifier = true
			term.Modifier = spec.sign * spec.flat
			term.Value = term.Modifier
			total += term.Value
			result.Terms = append(result.Terms, term)
			continue
		}

		dice := make([]DieRoll, 0, spec.count)
		for i := 0; i < spec.count; i++ {
			value := rand.IntN(spec.sides) + 1
			dice = append(dice, DieRoll{Value: value, Kept: true})
			// 爆炸骰：掷出最大点数时追加一颗，直到不再是最大点或达到上限
			for spec.explode && value == spec.sides && explosionBudget > 0 {
				explosionBudget--
				value = rand.IntN(spec.sides) + 1
				dice = append(dice, DieRoll{Value: value, Kept: true, Explode: true})
			}
		}

		applyKeepDrop(dice, spec.keepMode, spec.keepN)

		sum := 0
		for _, d := range dice {
			if d.Kept {
				sum += d.Value
			}
		}
		term.Dice = dice
		term.Value = spec.sign * sum
		total += term.Value
		result.Terms = append(result.Terms, term)
	}

	result.Total = total
	result.Crit = detectCrit(result, specs)
	return result, nil
}

// parseExpression 把 "2d6+1d4-1" 拆成带符号的若干项。
func parseExpression(expression string) ([]diceTermSpec, error) {
	clean := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(expression), " ", ""))
	if clean == "" {
		return nil, errors.New("表达式为空")
	}
	if len(clean) > maxExprLen {
		return nil, fmt.Errorf("表达式过长（最多 %d 个字符）", maxExprLen)
	}

	specs := make([]diceTermSpec, 0, 4)
	sign := 1
	i := 0
	for i < len(clean) {
		if c := clean[i]; c == '+' || c == '-' {
			sign = 1
			if c == '-' {
				sign = -1
			}
			i++
			if i >= len(clean) {
				return nil, errors.New("表达式不能以运算符结尾")
			}
			if next := clean[i]; next == '+' || next == '-' {
				return nil, errors.New("表达式中运算符重复")
			}
			continue
		}

		j := i
		for j < len(clean) && clean[j] != '+' && clean[j] != '-' {
			j++
		}

		spec, err := parseTerm(clean[i:j], sign)
		if err != nil {
			return nil, err
		}
		specs = append(specs, spec)

		sign = 1
		i = j
	}

	if len(specs) == 0 {
		return nil, errors.New("表达式为空")
	}
	return specs, nil
}

func parseTerm(chunk string, sign int) (diceTermSpec, error) {
	if chunk == "" {
		return diceTermSpec{}, errors.New("表达式中有多余的运算符")
	}

	raw := chunk
	if sign < 0 {
		raw = "-" + chunk
	}

	if m := diceTermRe.FindStringSubmatch(chunk); m != nil {
		count := 1
		if m[1] != "" {
			n, err := strconv.Atoi(m[1])
			if err != nil {
				return diceTermSpec{}, fmt.Errorf("骰子数量无效：%s", chunk)
			}
			count = n
		}
		sides, err := strconv.Atoi(m[2])
		if err != nil {
			return diceTermSpec{}, fmt.Errorf("骰子面数无效：%s", chunk)
		}

		if count > maxDicePerTerm {
			return diceTermSpec{}, fmt.Errorf("单个骰子项最多 %d 颗", maxDicePerTerm)
		}
		if sides < 1 || sides > maxSides {
			return diceTermSpec{}, fmt.Errorf("骰子面数需在 1-%d 之间", maxSides)
		}

		keepN := 1
		if m[4] != "" {
			n, err := strconv.Atoi(m[4])
			if err != nil {
				return diceTermSpec{}, fmt.Errorf("保留/丢弃数量无效：%s", chunk)
			}
			keepN = n
		}

		return diceTermSpec{
			sign:     sign,
			count:    count,
			sides:    sides,
			keepMode: m[3],
			keepN:    keepN,
			explode:  m[5] == "!",
			raw:      raw,
		}, nil
	}

	n, err := strconv.Atoi(chunk)
	if err != nil {
		return diceTermSpec{}, fmt.Errorf("无法识别的骰子写法：%s", chunk)
	}
	return diceTermSpec{sign: sign, flat: n, isFlat: true, raw: raw}, nil
}

// applyKeepDrop 按 kh/kl/dh/dl 标记哪些骰子参与合计。
func applyKeepDrop(dice []DieRoll, mode string, n int) {
	if mode == "" || len(dice) == 0 {
		return
	}
	if n < 0 {
		n = 0
	}

	order := make([]int, len(dice))
	for i := range order {
		order[i] = i
	}
	// 稳定排序：点数相同时保持原始顺序，结果可复现
	sort.SliceStable(order, func(a, b int) bool {
		return dice[order[a]].Value < dice[order[b]].Value
	})

	switch mode {
	case "kh": // 保留最高的 n 颗
		dropRange(dice, order, 0, len(order)-n)
	case "kl": // 保留最低的 n 颗
		dropRange(dice, order, n, len(order))
	case "dh": // 丢弃最高的 n 颗
		dropRange(dice, order, len(order)-n, len(order))
	case "dl": // 丢弃最低的 n 颗
		dropRange(dice, order, 0, n)
	}
}

// dropRange 把 order[from:to] 区间内的骰子标记为不保留，越界部分自动夹紧。
func dropRange(dice []DieRoll, order []int, from, to int) {
	if from < 0 {
		from = 0
	}
	if to > len(order) {
		to = len(order)
	}
	for _, i := range order[from:to] {
		dice[i].Kept = false
	}
}

// detectCrit 只在"结果由恰好一颗 d20 决定"时判定大成功/大失败（优势/劣势也算）。
func detectCrit(result *RollResult, specs []diceTermSpec) string {
	d20Terms := 0
	var natural []int

	for i, spec := range specs {
		if spec.isFlat {
			continue
		}
		if spec.sides != 20 {
			return ""
		}
		d20Terms++
		for _, d := range result.Terms[i].Dice {
			if d.Kept {
				natural = append(natural, d.Value)
			}
		}
	}

	if d20Terms == 0 || len(natural) != 1 {
		return ""
	}
	switch natural[0] {
	case 20:
		return "success"
	case 1:
		return "fumble"
	}
	return ""
}
