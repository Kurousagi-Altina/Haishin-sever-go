package main

import (
	"math"
	"math/rand/v2"
	"net/http"
)

// 传送门（item kind "portal"，GM 用 🌀 工具放置；客户端在 www/js/tabletop-portal.js）：
//   x, y      中心点
//   name      名字（默认「传送门1」「传送门2」……）；nameHidden = 只有 GM 看得到名字
//   to        指向的传送门 id 列表（单向：A 指向 B 不代表 B 能回到 A）
//   pick      "" = 由使用的人选目的地，"random" = 随机一个
//   mode      "" = 手动（棋子在一格内点击传送门），"auto" = 走进判定圈自动传送
//   r         自动传送的判定圈半径（场景像素）
// {op:"portal", scene:<传送门 id>, ids:[棋子], target:<目的地 id，可空>}：服务器校验距离、选目的地，
// 把棋子（和跟随它的东西）移到目的地中心。隐藏的传送门玩家看不到也用不了，但可以当作别的门的出口。

// ttPlayerPortal hides a portal's name from players when the GM marked it secret.
func ttPlayerPortal(it map[string]interface{}) map[string]interface{} {
	if !ttBool(it["nameHidden"]) {
		return it
	}
	cp := make(map[string]interface{}, len(it))
	for k, v := range it {
		if k != "name" {
			cp[k] = v
		}
	}
	return cp
}

func (room *TTRoom) usePortal(u ttUser, gm bool, sc *TTScene, from map[string]interface{}, req *ttOpRequest) (int, string) {
	if !gm && ttHiddenFrom(from, u.name) {
		return http.StatusBadRequest, "不是传送门"
	}
	if len(req.IDs) == 0 {
		return http.StatusBadRequest, "没有要传送的棋子"
	}
	var targets []map[string]interface{}
	if list, ok := from["to"].([]interface{}); ok {
		seen := map[string]bool{}
		for _, v := range list {
			id, _ := v.(string)
			if t := sc.Items[id]; t != nil && t["kind"] == "portal" && id != from["id"] && !seen[id] {
				seen[id] = true
				targets = append(targets, t)
			}
		}
	}
	if len(targets) == 0 {
		return http.StatusBadRequest, "这个传送门没有通往任何地方"
	}
	var dest map[string]interface{}
	if from["pick"] == "random" {
		dest = targets[rand.IntN(len(targets))]
	} else {
		for _, t := range targets {
			if t["id"] == req.Target {
				dest = t
			}
		}
		if dest == nil {
			if len(targets) != 1 {
				return http.StatusBadRequest, "请选择要去的传送门"
			}
			dest = targets[0]
		}
	}

	g, ok := ttNum(sc.Props["gridSize"])
	if !ok || g < 4 {
		g = 70
	}
	fx, _ := ttNum(from["x"])
	fy, _ := ttNum(from["y"])
	autoR, ok := ttNum(from["r"])
	if !ok || autoR <= 0 {
		autoR = g * 0.5
	}
	dx, _ := ttNum(dest["x"])
	dy, _ := ttNum(dest["y"])

	var moved []ttMove
	var changed []map[string]interface{}
	n := 0
	for _, id := range req.IDs {
		it := sc.Items[id]
		if it == nil || it["kind"] != "token" || it["portal"] != nil {
			continue
		}
		owner, _ := it["owner"].(string)
		if !gm && (ttHiddenFrom(it, u.name) || ((owner == "" || owner != u.name) && (ttBool(it["locked"]) || !room.setting("playerMoveOthers", true)))) {
			continue
		}
		w, ok := ttNum(it["w"])
		if !ok {
			w = g
		}
		h, ok := ttNum(it["h"])
		if !ok {
			h = w
		}
		cx, cy := ttItemCenter(it)
		d := math.Hypot(cx-fx, cy-fy)
		// 手动：棋子边缘离传送门（占一格）不超过一格；自动：中心在判定圈里（都留一点余量）
		if d-math.Max(w, h)/2 > g*1.75 && !(from["mode"] == "auto" && d <= autoR+g*0.25) {
			continue
		}
		ox, oy := 0.0, 0.0
		if n > 0 { // 几个人一起过去时错开一点
			a := float64(n) * 2.4
			ox, oy = math.Cos(a)*g*(0.3+0.12*float64(n)), math.Sin(a)*g*(0.3+0.12*float64(n))
		}
		n++
		mx, my := dx+ox-cx, dy+oy-cy
		x, _ := ttNum(it["x"])
		y, _ := ttNum(it["y"])
		it["x"], it["y"] = x+mx, y+my
		moved = append(moved, ttMove{id, mx, my})
		changed = append(changed, it)
	}
	if len(changed) == 0 {
		return http.StatusBadRequest, "没有可以传送的棋子（要在传送门一格以内）"
	}
	inBatch := map[string]bool{}
	for _, m := range moved {
		inBatch[m.id] = true
	}
	changed = append(changed, sc.moveFollowers(moved, inBatch)...)
	room.broadcastItems(changed)
	if !ttConcealed(dest) {
		room.broadcastAll(ttMsg(map[string]interface{}{"type": "fx", "from": u.name, "color": ttColorFor(u.name),
			"fx": map[string]interface{}{"t": "portal", "x": dx, "y": dy}}))
	}
	return 0, ""
}
