package main

import "net/http"

// 角色棋子跨地图：把队伍角色（pc 卡 / pc 的随从）的棋子放到另一张地图时，客户端先问这里要它
// 最近一枚棋子（血量、状态、资源、头像、体型……）和跟着它的物件（跟随的棋子、光环区域），
// 再照着建新棋子（tabletop-sheets.js placeSheetToken）。场景只有当前那个会发给客户端，所以要服务器找。

const ttRecentMax = 30

// noteSceneLeft records the scene that just stopped being active (most recent first).
func (room *TTRoom) noteSceneLeft(old, next string) {
	if old == "" || old == next {
		return
	}
	list := []string{old}
	for _, id := range room.Recent {
		if id != old && id != next && len(list) < ttRecentMax {
			list = append(list, id)
		}
	}
	room.Recent = list
}

// carrySource finds the freshest token of a sheet: scenes left most recently first (the party just
// came from there), then the active scene (a token deleted and placed again), then the rest.
func (room *TTRoom) carrySource(sheetID string) (map[string]interface{}, *TTScene) {
	seen := make(map[string]bool, len(room.Scenes))
	order := make([]*TTScene, 0, len(room.Scenes))
	add := func(id string) {
		if sc := room.scene(id); sc != nil && !seen[sc.ID] {
			seen[sc.ID] = true
			order = append(order, sc)
		}
	}
	for _, id := range room.Recent {
		if id != room.Active {
			add(id)
		}
	}
	add(room.Active)
	for _, sc := range room.Scenes {
		add(sc.ID)
	}
	for _, sc := range order {
		var best map[string]interface{}
		bz := 0.0
		for _, it := range sc.Items {
			if it["kind"] != "token" || it["sheet"] != sheetID {
				continue
			}
			z, _ := ttNum(it["z"])
			if best == nil || z > bz {
				best, bz = it, z
			}
		}
		if best != nil {
			return best, sc
		}
	}
	return nil, nil
}

// GET /api/tabletop/carry?room=&sheet=[&name=] → {token, followers, grid, scene, sceneName, same}
// (empty object when there is nothing to carry or the user may not see it)
func (t *Tabletop) HandleCarry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	room := t.getRoom(r.URL.Query().Get("room"))
	if room == nil {
		writeJSON(w, http.StatusNotFound, map[string]interface{}{"error": "房间不存在"})
		return
	}
	u, nerr := t.guestUser(getTokenInfo(r), ttRequestToken(r), r.URL.Query().Get("name"))
	if nerr != nil {
		writeJSON(w, http.StatusConflict, map[string]interface{}{"error": nerr.Error()})
		return
	}
	sid := r.URL.Query().Get("sheet")

	room.mu.Lock()
	defer room.mu.Unlock()
	empty := map[string]interface{}{}
	sh := room.Sheets[sid]
	if room.deleted || sh == nil || (sh["kind"] != "pc" && sh["kind"] != "summon") {
		writeJSON(w, http.StatusOK, empty)
		return
	}
	src, ssc := room.carrySource(sid)
	if src == nil {
		writeJSON(w, http.StatusOK, empty)
		return
	}
	gm := room.isGM(u)
	shOwner, _ := sh["owner"].(string)
	tokOwner, _ := src["owner"].(string)
	if !gm && ((shOwner != u.name && tokOwner != u.name) || ttHiddenFrom(src, u.name)) {
		writeJSON(w, http.StatusOK, empty)
		return
	}
	hpStep := ttHPStep(ssc.Props)
	view := func(it map[string]interface{}) map[string]interface{} {
		if gm {
			return it
		}
		return ttPlayerItem(it, hpStep, room.partyToken(it))
	}
	followers := make([]map[string]interface{}, 0)
	for _, it := range ssc.Items {
		if it["follow"] != src["id"] || (it["kind"] != "token" && it["kind"] != "draw") {
			continue
		}
		if !gm && ttHiddenFrom(it, u.name) {
			continue
		}
		followers = append(followers, view(it))
	}
	grid, _ := ttNum(ssc.Props["gridSize"])
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"token": view(src), "followers": followers, "grid": grid,
		"scene": ssc.ID, "sceneName": ssc.Name, "same": ssc.ID == room.Active,
	})
}
