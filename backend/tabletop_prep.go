package main

import (
	"net/http"
	"strings"
	"time"
)

// 讲义（handout）：GM 推送给全体或指定玩家的图片 / 文字（信件、告示、线索图），
// 玩家收到时弹出，之后可以在「线索」里反复查看。图片单独存放，不进房间资产库，
// 所以玩家在 GM 展示之前看不到。

const ttMaxHandouts = 200

type TTHandout struct {
	ID    string   `json:"id"`
	Time  string   `json:"t"`
	Title string   `json:"title"`
	Text  string   `json:"text,omitempty"`
	Img   string   `json:"img,omitempty"` // asset id
	To    []string `json:"to,omitempty"`  // player names; empty = everyone
	Shown bool     `json:"shown,omitempty"`
}

// handoutFor: whether sub may see h. Unshown drafts are GM-only.
func handoutFor(sub *ttSub, h *TTHandout) bool {
	if sub.gm {
		return true
	}
	if !h.Shown {
		return false
	}
	if len(h.To) == 0 {
		return true
	}
	for _, n := range h.To {
		if n == sub.name {
			return true
		}
	}
	return false
}

func (room *TTRoom) handoutsFor(sub *ttSub) []*TTHandout {
	out := make([]*TTHandout, 0)
	for i := range room.Handouts {
		h := &room.Handouts[i]
		if handoutFor(sub, h) {
			out = append(out, h)
		}
	}
	return out
}

func (room *TTRoom) handoutIndex(id string) int {
	for i := range room.Handouts {
		if room.Handouts[i].ID == id {
			return i
		}
	}
	return -1
}

// broadcastHandout sends h to everyone allowed to see it (popup: show it on screen now)
// and withdraws it from the players who no longer may.
func (room *TTRoom) broadcastHandout(h *TTHandout, popup bool) {
	add := ttMsg(map[string]interface{}{"type": "handout", "h": h, "popup": popup})
	quiet := ttMsg(map[string]interface{}{"type": "handout", "h": h})
	del := ttMsg(map[string]interface{}{"type": "handoutdel", "ids": []string{h.ID}})
	for sub := range room.subs {
		switch {
		case !handoutFor(sub, h):
			room.send(sub, del)
		case popup && !sub.gm:
			room.send(sub, add)
		default:
			room.send(sub, quiet)
		}
	}
}

// applyHandout: op "handout" (save, Mode "show" also pushes it to the players),
// "handout.show" (show again, Text = id) and "handout.delete" (IDs). GM only.
func (room *TTRoom) applyHandout(u ttUser, req *ttOpRequest) (int, string) {
	switch req.Op {
	case "handout":
		in := req.Handout
		if in == nil {
			return http.StatusBadRequest, "无效的讲义"
		}
		title := ttCleanName(in.Title, 60, "")
		text := strings.TrimSpace(in.Text)
		if len([]rune(text)) > 4000 {
			return http.StatusBadRequest, "讲义文字太长（最多 4000 字）"
		}
		if in.Img != "" && !ttAssetRe.MatchString(in.Img) {
			return http.StatusBadRequest, "无效的图片"
		}
		if title == "" && text == "" && in.Img == "" {
			return http.StatusBadRequest, "讲义是空的"
		}
		if title == "" {
			title = "讲义"
		}
		var to []string
		seen := map[string]bool{}
		for _, n := range in.To {
			n = ttCleanName(n, 40, "")
			if n != "" && !seen[n] && len(to) < 30 {
				seen[n] = true
				to = append(to, n)
			}
		}
		idx := -1
		if in.ID != "" {
			if !ttIDRe.MatchString(in.ID) {
				return http.StatusBadRequest, "无效的讲义ID"
			}
			idx = room.handoutIndex(in.ID)
		}
		if idx < 0 {
			if len(room.Handouts) >= ttMaxHandouts {
				return http.StatusBadRequest, "讲义数量已达上限，先删掉一些旧的"
			}
			id := in.ID
			if id == "" {
				id = ttRandomID(6)
			}
			room.Handouts = append(room.Handouts, TTHandout{ID: id})
			idx = len(room.Handouts) - 1
		}
		h := &room.Handouts[idx]
		h.Title, h.Text, h.Img, h.To = title, text, in.Img, to
		h.Time = time.Now().Format(ttTimeFormat)
		show := req.Mode == "show"
		if show {
			h.Shown = true
		}
		room.broadcastHandout(h, show)
		if show {
			room.logHandout(u, h)
		}

	case "handout.show":
		idx := room.handoutIndex(req.Text)
		if idx < 0 {
			return http.StatusNotFound, "讲义不存在"
		}
		h := &room.Handouts[idx]
		h.Shown = true
		room.broadcastHandout(h, true)
		room.logHandout(u, h)

	case "handout.delete":
		var ids []string
		for _, id := range req.IDs {
			if idx := room.handoutIndex(id); idx >= 0 {
				room.Handouts = append(room.Handouts[:idx], room.Handouts[idx+1:]...)
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			return 0, ""
		}
		room.broadcastAll(ttMsg(map[string]interface{}{"type": "handoutdel", "ids": ids}))
	}
	return 0, ""
}

// logHandout notes in the log that a handout was shown. A handout for some players only
// is logged for the GM (and the single recipient), so the others don't learn of it.
func (room *TTRoom) logHandout(u ttUser, h *TTHandout) {
	e := newLogEntry("sys", u.name)
	e.Text = "展示了讲义「" + h.Title + "」"
	if len(h.To) > 0 {
		e.Text += "（给 " + strings.Join(h.To, "、") + "）"
		e.GMOnly = true
		if len(h.To) == 1 {
			e.For = h.To[0]
		}
	}
	room.addLog(e)
}
