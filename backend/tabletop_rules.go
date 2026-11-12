package main

import (
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// 本地规则库：data/5e 下按「分组 / 出处 / 类别.json」整理好的不全书数据（法术、职业特性、子职特性、
// 种族与背景、专长、装备、魔法物品）。启动时整个读进内存（约 3 MB），按名称 / 英文名 / 别名建索引。
//   GET /api/tabletop/5e/rules?type=法术&name=火球术   → 同名条目（2024 核心规则优先）
//   GET /api/tabletop/5e/rules?type=法术&q=火         → 名称包含关键字的条目摘要（最多 30 条）

type ttRuleSet struct {
	entries []map[string]interface{}
	byName  map[string][]int
}

var ttRuleParenRe = regexp.MustCompile(`[（(][^）)]*[）)]`)

func ttRuleKey(s string) string {
	s = ttRuleParenRe.ReplaceAllString(strings.TrimSpace(s), "")
	return strings.ToLower(strings.Join(strings.Fields(s), ""))
}

// ttRuleRank: 2024 核心规则 > 官方扩展 > 战役设定 > 模组；同组里 2024 版优先。
func ttRuleRank(e map[string]interface{}) int {
	r := map[string]int{"core": 0, "official": 1, "setting": 2, "adventure": 3}[ttStr(e["section"])]
	if ttStr(e["section"]) == "" {
		r = 4
	}
	r *= 10
	if strings.Contains(ttStr(e["source"]), "2024") || ttStr(e["edition"]) == "2024" {
		r -= 5
	}
	return r
}

func ttStr(v interface{}) string {
	s, _ := v.(string)
	return s
}

func loadRuleSet(dir string) (*ttRuleSet, error) {
	rs := &ttRuleSet{byName: map[string][]int{}}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".json") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		var doc struct {
			Type    string                   `json:"type"`
			Entries []map[string]interface{} `json:"entries"`
		}
		if json.Unmarshal(data, &doc) != nil {
			log.Printf("[RULES] skipped %s: not a rules file", path)
			return nil
		}
		typ := doc.Type
		if typ == "" {
			typ = strings.TrimSuffix(d.Name(), ".json")
		}
		for _, e := range doc.Entries {
			if e == nil {
				continue
			}
			e["_type"] = typ
			idx := len(rs.entries)
			rs.entries = append(rs.entries, e)
			keys := map[string]bool{ttRuleKey(ttStr(e["name"])): true, ttRuleKey(ttStr(e["en"])): true}
			if al, ok := e["aliases"].([]interface{}); ok {
				for _, a := range al {
					keys[ttRuleKey(ttStr(a))] = true
				}
			}
			for k := range keys {
				if k != "" {
					rs.byName[k] = append(rs.byName[k], idx)
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for k, list := range rs.byName {
		sort.SliceStable(list, func(i, j int) bool { return ttRuleRank(rs.entries[list[i]]) < ttRuleRank(rs.entries[list[j]]) })
		rs.byName[k] = list
	}
	return rs, nil
}

// LoadRules reads the rules library; a missing directory just leaves it empty (the tabletop falls back to the website).
func (t *Tabletop) LoadRules(dir string) {
	if _, err := os.Stat(dir); err != nil {
		log.Printf("[RULES] %s not found, local rules disabled", dir)
		return
	}
	rs, err := loadRuleSet(dir)
	if err != nil {
		log.Printf("[RULES] failed to load %s: %v", dir, err)
		return
	}
	t.rules = rs
	log.Printf("[RULES] loaded %d entries from %s", len(rs.entries), dir)
}

// GET /api/tabletop/5e/rules?type=&name= | ?type=&q=
func (t *Tabletop) HandleRules(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	rs := t.rules
	if rs == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"entries": []interface{}{}, "available": false})
		return
	}
	typ := strings.TrimSpace(r.URL.Query().Get("type"))
	out := []map[string]interface{}{}
	if name := r.URL.Query().Get("name"); name != "" {
		for _, i := range rs.byName[ttRuleKey(name)] {
			if e := rs.entries[i]; typ == "" || e["_type"] == typ {
				out = append(out, e)
			}
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"entries": out, "available": true})
		return
	}
	q := ttRuleKey(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, map[string]interface{}{"entries": out, "available": true})
		return
	}
	limit := 30
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 100 {
		limit = n
	}
	type hit struct {
		e     map[string]interface{}
		score int
	}
	var hits []hit
	for _, e := range rs.entries {
		if typ != "" && e["_type"] != typ {
			continue
		}
		n, en := ttRuleKey(ttStr(e["name"])), ttRuleKey(ttStr(e["en"]))
		score := -1
		switch {
		case n == q || en == q:
			score = 0
		case strings.HasPrefix(n, q) || strings.HasPrefix(en, q):
			score = 1
		case strings.Contains(n, q) || strings.Contains(en, q):
			score = 2
		}
		if score >= 0 {
			hits = append(hits, hit{e, score*100 + ttRuleRank(e)})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].score < hits[j].score })
	for i, h := range hits {
		if i >= limit {
			break
		}
		out = append(out, map[string]interface{}{"name": h.e["name"], "en": h.e["en"], "source": h.e["source"], "type": h.e["_type"],
			"summary": h.e["summary"], "level": h.e["level"]})
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"entries": out, "available": true})
}
