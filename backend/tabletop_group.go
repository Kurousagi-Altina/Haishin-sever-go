package main

import (
	"net/http"
	"strings"
)

// 群体区域（GM）：圈好一批有属性的棋子，同时投豁免 / 属性检定，结果合成一条记录（www/js/tabletop-group.js）。
//
//	{op:"group", ids:[棋子], group:{mode: save|check, ab: str…cha, roll: ""|adv|dis, dc}, hidden}
//
// 豁免走 rollTokenSave（角色卡豁免加值、判定修正、状态、祝福 / 灾祸、力竭，和行动结算一样）；
// 属性检定 = d20 + 角色卡属性调整值。没有关联角色卡（没有属性）的棋子跳过。
// 记录 kind "group"，Group = TTGroupResult；玩家看不到隐藏棋子那几行（logEntryFor）。

type TTGroupReq struct {
	Mode string `json:"mode"` // save / check
	Ab   string `json:"ab"`
	Roll string `json:"roll"` // "" / adv / dis
	DC   int    `json:"dc"`
}

type TTGroupRow struct {
	ID     string        `json:"id"`
	Name   string        `json:"name"`
	Roll   *TTDiceResult `json:"roll,omitempty"`
	Total  int           `json:"total"`
	Pass   string        `json:"pass,omitempty"` // yes / no（设了 DC 才有）
	Auto   bool          `json:"auto,omitempty"` // 自动失败（麻痹、震慑、昏迷、石化时的力量 / 敏捷豁免）
	Note   string        `json:"note,omitempty"`
	Secret bool          `json:"secret,omitempty"` // 对玩家隐藏的棋子：这一行不发给玩家
}

type TTGroupResult struct {
	Mode    string        `json:"mode"`
	Ab      string        `json:"ab"`
	Roll    string        `json:"roll,omitempty"`
	DC      int           `json:"dc,omitempty"`
	Rows    []*TTGroupRow `json:"rows"`
	Skipped int           `json:"skipped,omitempty"` // 没有属性、跳过的棋子数
}

func (room *TTRoom) applyGroup(u ttUser, gm bool, req *ttOpRequest) (int, string) {
	if !gm {
		return http.StatusForbidden, "只有 GM 可以用群体区域"
	}
	g := req.Group
	if g == nil || (g.Mode != "save" && g.Mode != "check") || ttAbilityCN[g.Ab] == "" {
		return http.StatusBadRequest, "请选择豁免 / 检定和属性"
	}
	if len(req.IDs) == 0 || len(req.IDs) > 100 {
		return http.StatusBadRequest, "要圈 1-100 个单位"
	}
	if g.Roll != "adv" && g.Roll != "dis" {
		g.Roll = ""
	}
	if g.DC < 0 || g.DC > 60 {
		g.DC = 0
	}
	sc := room.activeScene()
	res := &TTGroupResult{Mode: g.Mode, Ab: g.Ab, Roll: g.Roll, DC: g.DC}
	seen := map[string]bool{}
	var changed []map[string]interface{}
	for _, id := range req.IDs {
		it := sc.Items[id]
		if it == nil || it["kind"] != "token" || seen[id] {
			continue
		}
		seen[id] = true
		sh := room.tokenSheet(it)
		if sh == nil || len(ttSheetList(sh, "abilities")) == 0 {
			res.Skipped++
			continue
		}
		row := &TTGroupRow{ID: id, Name: ttCleanName(ttItemLabel(it), 40, "单位"), Secret: ttConcealed(it)}
		var adv, dis []string
		if g.Roll == "adv" {
			adv = []string{"群体优势"}
		} else if g.Roll == "dis" {
			dis = []string{"群体劣势"}
		}
		if g.Mode == "save" {
			hadLucky := ttStatusIDs(it)["lucky"]
			r, notes, err := room.rollTokenSave(it, g.Ab, adv, dis)
			if err != nil {
				return http.StatusBadRequest, err.Error()
			}
			if hadLucky && !ttStatusIDs(it)["lucky"] {
				changed = append(changed, it)
			}
			row.Note = strings.Join(notes, "；")
			if r == nil { // 自动失败
				row.Auto = true
			} else {
				row.Roll, row.Total = r, r.Total
			}
		} else {
			expr := "1d20"
			if g.Roll == "adv" {
				expr = "2d20kh1"
			} else if g.Roll == "dis" {
				expr = "2d20kl1"
			}
			if m := ttSheetAbilityMod(sh, g.Ab); m != 0 {
				expr += ttSigned(m)
			}
			if lv := ttStatusLevel(it, "exhaustion"); lv > 0 {
				expr += ttSigned(-2 * lv)
			}
			r, err := RollTabletopDice(expr)
			if err != nil {
				return http.StatusBadRequest, err.Error()
			}
			row.Roll, row.Total = r, r.Total
		}
		if g.DC > 0 {
			if !row.Auto && row.Total >= g.DC {
				row.Pass = "yes"
			} else {
				row.Pass = "no"
			}
		}
		res.Rows = append(res.Rows, row)
	}
	if len(res.Rows) == 0 {
		return http.StatusBadRequest, "圈到的单位都没有属性（没关联角色卡）"
	}
	if len(changed) > 0 {
		room.broadcastItems(changed)
	}
	kind := map[string]string{"save": "豁免", "check": "检定"}[g.Mode]
	e := newLogEntry("group", u.name)
	e.Label = "群体" + ttAbilityCN[g.Ab] + kind
	e.Group = res
	e.Hidden = req.Hidden
	room.addLog(e)
	return 0, ""
}

// ttGroupFor: players don't get the rows of tokens hidden from them.
func ttGroupFor(sub *ttSub, e TTLogEntry) TTLogEntry {
	if e.Group == nil || sub.gm {
		return e
	}
	cp := *e.Group
	cp.Rows = nil
	for _, r := range e.Group.Rows {
		if !r.Secret {
			cp.Rows = append(cp.Rows, r)
		}
	}
	e.Group = &cp
	return e
}
