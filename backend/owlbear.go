package main

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Import of Owlbear Rodeo 2 exports (.ob2): a zip with manifest.json (assets incl. SCENE
// entries) and one JSON doc per scene. Item coordinates are in scene units where one grid
// cell = scene grid dpi, which we use directly as the tabletop's gridSize.
// Images are either bundled (assets/images/items/...) or links to Owlbear's / the bestiary
// extension's CDN; links are downloaded now so the room keeps working when Owlbear is down.
// Extension data we understand: Smoke & Spectre vision lines (→ walls/doors), obr-suite
// health bubbles (→ HP), the bestiary extension's 5etools monsters (→ monster sheets) and
// character-cards bindings (→ linked by name when a PC sheet with that name is imported).

const ob2MaxDownload = 60 << 20

// hosts whose images we fetch while importing — never arbitrary user-supplied URLs
var ob2ImageHosts = map[string]bool{"images.owlbear.rodeo": true, "5e.kiwee.top": true, "obr.dnd.center": true}

var ob2Client = &http.Client{
	Timeout: 90 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 || req.URL.Scheme != "https" || !ob2ImageHosts[req.URL.Hostname()] {
			return errors.New("redirect not allowed")
		}
		return nil
	},
}

type ob2Vec struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type ob2Item struct {
	ID       string                     `json:"id"`
	Type     string                     `json:"type"`
	Name     string                     `json:"name"`
	Layer    string                     `json:"layer"`
	Position ob2Vec                     `json:"position"`
	Rotation float64                    `json:"rotation"`
	Scale    ob2Vec                     `json:"scale"`
	Visible  bool                       `json:"visible"`
	Locked   bool                       `json:"locked"`
	ZIndex   float64                    `json:"zIndex"`
	Metadata map[string]json.RawMessage `json:"metadata"`
	Image    *struct {
		Width  float64 `json:"width"`
		Height float64 `json:"height"`
		URL    string  `json:"url"`
	} `json:"image"`
	Grid *struct {
		DPI    float64 `json:"dpi"`
		Offset ob2Vec  `json:"offset"`
	} `json:"grid"`
	Text *struct {
		PlainText string `json:"plainText"`
	} `json:"text"`
	Points    []ob2Vec        `json:"points"`
	Commands  [][]float64     `json:"commands"`
	Width     float64         `json:"width"`
	Height    float64         `json:"height"`
	ShapeType string          `json:"shapeType"`
	StartPos  *ob2Vec         `json:"startPosition"`
	EndPos    *ob2Vec         `json:"endPosition"`
	Style     json.RawMessage `json:"style"`
}

type ob2Style struct {
	FillColor     string  `json:"fillColor"`
	FillOpacity   float64 `json:"fillOpacity"`
	StrokeColor   string  `json:"strokeColor"`
	StrokeOpacity float64 `json:"strokeOpacity"`
	StrokeWidth   float64 `json:"strokeWidth"`
	Closed        bool    `json:"closed"`
}

type ob2SceneDoc struct {
	Items map[string]*ob2Item `json:"items"`
	Grid  struct {
		DPI         float64 `json:"dpi"`
		Scale       string  `json:"scale"`
		Measurement string  `json:"measurement"`
		Style       struct {
			LineColor   string  `json:"lineColor"`
			LineOpacity float64 `json:"lineOpacity"`
		} `json:"style"`
	} `json:"grid"`
	Fog struct {
		Filled bool `json:"filled"`
	} `json:"fog"`
	Metadata map[string]json.RawMessage `json:"metadata"`
}

type ob2Manifest struct {
	Assets map[string]struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Type     string `json:"type"`
		Metadata struct {
			Doc string `json:"doc"`
		} `json:"metadata"`
		CreatedAt string `json:"createdAt"`
	} `json:"assets"`
}

// OB2ImportStats is reported back to the importing user.
type OB2ImportStats struct {
	Scenes     int      `json:"scenes"`
	Tokens     int      `json:"tokens"`
	Walls      int      `json:"walls"`
	Doors      int      `json:"doors"`
	Monsters   int      `json:"monsters"`
	Cards      int      `json:"cards"`
	Combatants int      `json:"combatants"`
	Images     int      `json:"images"`
	Downloaded int      `json:"downloaded"`
	Failed     []string `json:"failed,omitempty"`
}

func isOB2(zr *zip.Reader) bool {
	hasManifest, hasRoom := false, false
	for _, f := range zr.File {
		switch f.Name {
		case "manifest.json":
			hasManifest = true
		case "room.json":
			hasRoom = true
		}
	}
	return hasManifest && !hasRoom
}

func readZipFile(zr *zip.Reader, name string, limit int64) ([]byte, error) {
	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()
		data, err := io.ReadAll(io.LimitReader(rc, limit+1))
		if err != nil {
			return nil, err
		}
		if int64(len(data)) > limit {
			return nil, errors.New(name + " 过大")
		}
		return data, nil
	}
	return nil, errors.New("缺少 " + name)
}

// ob2Images resolves image URLs (bundled paths or allowed CDN links) to stored asset ids.
type ob2Images struct {
	t     *Tabletop
	zr    *zip.Reader
	mu    sync.Mutex
	ids   map[string]string // url → asset id ("" = failed)
	stats *OB2ImportStats
}

func (im *ob2Images) collect(urls []string) {
	var remote []string
	for _, u := range urls {
		if _, ok := im.ids[u]; ok {
			continue
		}
		im.ids[u] = ""
		clean := strings.SplitN(u, "?", 2)[0]
		if strings.HasPrefix(clean, "assets/") {
			data, err := readZipFile(im.zr, clean, ob2MaxDownload)
			if err == nil {
				if id, err := im.t.storeAsset(data); err == nil {
					im.ids[u] = id
					im.stats.Images++
					continue
				}
			}
			im.stats.Failed = append(im.stats.Failed, clean)
			continue
		}
		remote = append(remote, u)
	}

	// download links concurrently (a few at a time — be polite to the CDNs)
	jobs := make(chan string)
	var wg sync.WaitGroup
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for u := range jobs {
				id, err := im.download(u)
				im.mu.Lock()
				if err != nil {
					log.Printf("[TABLETOP] ob2 image %s: %v", u, err)
					im.stats.Failed = append(im.stats.Failed, u)
				} else {
					im.ids[u] = id
					im.stats.Images++
					im.stats.Downloaded++
				}
				im.mu.Unlock()
			}
		}()
	}
	for _, u := range remote {
		jobs <- u
	}
	close(jobs)
	wg.Wait()
	sort.Strings(im.stats.Failed)
}

func (im *ob2Images) download(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || !ob2ImageHosts[u.Hostname()] {
		return "", errors.New("不允许的图片地址")
	}
	req, _ := http.NewRequest(http.MethodGet, u.String(), nil)
	req.Header.Set("User-Agent", "Haishin-Tabletop/1.0 (+self-hosted VTT)")
	resp, err := ob2Client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, ob2MaxDownload+1))
	if err != nil {
		return "", err
	}
	if len(data) > ob2MaxDownload {
		return "", errors.New("图片过大")
	}
	return im.t.storeAsset(data)
}

func (im *ob2Images) id(u string) string { return im.ids[u] }

// importOB2 converts an Owlbear Rodeo 2 export into a new room.
func (t *Tabletop) importOB2(zr *zip.Reader, filename, owner string) (*TTRoom, *OB2ImportStats, error) {
	data, err := readZipFile(zr, "manifest.json", 20<<20)
	if err != nil {
		return nil, nil, err
	}
	var man ob2Manifest
	if err := json.Unmarshal(data, &man); err != nil {
		return nil, nil, errors.New("manifest.json 格式错误")
	}

	type sceneSrc struct {
		name, created string
		doc           *ob2SceneDoc
	}
	var srcs []sceneSrc
	for id, a := range man.Assets {
		if a.Type != "SCENE" {
			continue
		}
		path := a.Metadata.Doc
		if path == "" {
			path = "assets/scenes/docs/" + id + ".json"
		}
		raw, err := readZipFile(zr, path, 50<<20)
		if err != nil {
			continue
		}
		var doc ob2SceneDoc
		if err := json.Unmarshal(raw, &doc); err != nil || doc.Items == nil {
			continue
		}
		srcs = append(srcs, sceneSrc{name: a.Name, created: a.CreatedAt, doc: &doc})
	}
	if len(srcs) == 0 {
		return nil, nil, errors.New("导出文件中没有场景")
	}
	if len(srcs) > 100 {
		srcs = srcs[:100]
	}
	// scenes with content first (they are the ones actually played), then by name
	sort.SliceStable(srcs, func(i, j int) bool {
		ni, nj := len(srcs[i].doc.Items), len(srcs[j].doc.Items)
		if (ni > 1) != (nj > 1) {
			return ni > 1
		}
		return srcs[i].name < srcs[j].name
	})

	stats := &OB2ImportStats{}
	images := &ob2Images{t: t, zr: zr, ids: make(map[string]string), stats: stats}
	var urls []string
	for _, s := range srcs {
		for _, it := range s.doc.Items {
			if it.Type == "IMAGE" && it.Image != nil && it.Image.URL != "" && it.Layer != "ATTACHMENT" {
				urls = append(urls, it.Image.URL)
			}
		}
	}
	images.collect(urls)

	// character cards bound to tokens live on obr-suite's server — fetch them now.
	// The same character is often uploaded several times (one card per scene/room):
	// keep the newest upload per name and point every older card id at it.
	newest := make(map[string]ob2Card) // name key → newest card
	cardKey := make(map[string]string) // card id → name key
	for _, s := range srcs {
		var list []ob2Card
		json.Unmarshal(s.doc.Metadata["com.character-cards/list"], &list)
		for _, c := range list {
			if c.ID == "" {
				continue
			}
			key := ttNameKey(c.Name)
			if key == "" {
				key = "#" + c.ID
			}
			cardKey[c.ID] = key
			if cur, ok := newest[key]; !ok || c.stamp() > cur.stamp() {
				newest[key] = c
			}
		}
	}
	var cards []ob2Card
	for _, c := range newest {
		if len(cards) < 60 {
			cards = append(cards, c)
		}
	}
	sort.Slice(cards, func(i, j int) bool { return cards[i].Name < cards[j].Name })
	cardSheets := fetchCards(cards, stats)

	room := newTTRoom(ob2RoomName(filename, len(srcs)), owner)
	room.Scenes = nil
	assetSeen := make(map[string]bool)
	addAsset := func(id, name, kind string) {
		if id == "" || assetSeen[id+kind] {
			return
		}
		assetSeen[id+kind] = true
		room.Assets = append(room.Assets, TTAsset{ID: id, Name: ttCleanName(name, 60, "未命名"), Kind: kind, By: owner})
	}
	monsterSheets := make(map[string]string) // bestiary slug → sheet id
	cardSheetIDs := make(map[string]string)  // character card id → sheet id
	byKey := make(map[string]string)         // name key → sheet id
	for _, c := range cards {
		sh := cardSheets[c.ID]
		if sh == nil || len(room.Sheets) >= ttMaxSheets {
			continue
		}
		sh["id"] = ttRandomID(6)
		sh["cardId"] = c.ID
		room.Sheets[sh["id"].(string)] = sh
		byKey[cardKey[c.ID]] = sh["id"].(string)
		stats.Cards++
	}
	for id, key := range cardKey {
		if sid := byKey[key]; sid != "" {
			cardSheetIDs[id] = sid
		}
	}

	for _, s := range srcs {
		sc := convertOB2Scene(s.name, s.doc, images, addAsset, stats)
		// monster stat blocks stored by the bestiary extension, keyed "SOURCE::Name"
		var monsters map[string]map[string]interface{}
		if raw, ok := s.doc.Metadata["com.bestiary/monsters"]; ok {
			json.Unmarshal(raw, &monsters)
		}
		for slug, m := range monsters {
			if _, done := monsterSheets[slug]; done || len(room.Sheets) >= ttMaxSheets {
				continue
			}
			sh := convert5etoolsMonster(m, slug)
			sh["id"] = ttRandomID(6)
			room.Sheets[sh["id"].(string)] = sh
			monsterSheets[slug] = sh["id"].(string)
			stats.Monsters++
		}
		room.Scenes = append(room.Scenes, sc)
	}
	// link monster tokens and character-card tokens to their sheets
	for _, sc := range room.Scenes {
		for _, it := range sc.Items {
			if slug, ok := it["bestiary"].(string); ok {
				if id := monsterSheets[slug]; id != "" {
					it["sheet"] = id
				}
				delete(it, "bestiary")
			}
			// size from the linked sheet, stored on the token so players (who may not see
			// the monster sheet) compute the same hit circle as the GM
			if id, _ := it["sheet"].(string); id != "" && it["fp"] == nil {
				if c := ttSheetSizeCells(room.Sheets[id]); c > 0 {
					it["fp"] = c
				}
			}
			if card, ok := it["cardId"].(string); ok {
				if id := cardSheetIDs[card]; id != "" {
					it["sheet"] = id
					delete(it, "pcName")
					if _, has := it["ac"]; !has {
						if ac, ok := ttNum(room.Sheets[id]["ac"]); ok && ac > 0 {
							it["ac"] = ac
						}
					}
				}
			}
		}
	}
	stats.Scenes = len(room.Scenes)
	room.Active = room.Scenes[0].ID
	room.normalize()
	return room, stats, nil
}

func convertOB2Scene(name string, doc *ob2SceneDoc, images *ob2Images, addAsset func(id, name, kind string), stats *OB2ImportStats) *TTScene {
	sc := newTTScene(ttCleanName(name, 40, "场景"))
	g := doc.Grid.DPI
	if g <= 0 {
		g = 150
	}
	p := sc.Props
	p["gridSize"] = g
	if m := regexp.MustCompile(`^([\d.]+)\s*(.*)$`).FindStringSubmatch(strings.TrimSpace(doc.Grid.Scale)); m != nil {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			p["gridScale"] = v
		}
		if m[2] != "" {
			p["gridUnit"] = m[2]
		}
	}
	// distances are measured by actual length (the grid is only a reference); Owlbear's
	// CHEBYSHEV made diagonals free. The grid-counting rules stay available in 设置.
	p["measure"] = "euclidean"
	if doc.Grid.Style.LineColor == "DARK" {
		p["gridColor"] = "#000000"
	} else {
		p["gridColor"] = "#ffffff"
	}
	if doc.Grid.Style.LineOpacity > 0 {
		p["gridAlpha"] = doc.Grid.Style.LineOpacity
	}

	items := make([]*ob2Item, 0, len(doc.Items))
	for _, it := range doc.Items {
		items = append(items, it)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ZIndex < items[j].ZIndex })

	// the lowest MAP-layer image becomes the scene map; everything is shifted so it sits at (0,0)
	var origin ob2Vec
	for _, it := range items {
		if it.Layer == "MAP" && it.Type == "IMAGE" && it.Image != nil {
			x, y, w, h := ob2ImageRect(it, g)
			origin = ob2Vec{x, y}
			if id := images.id(it.Image.URL); id != "" {
				p["mapAsset"] = id
				p["mapW"] = round2(w)
				p["mapH"] = round2(h)
				addAsset(id, it.Name, "map")
			} else {
				p["mapW"] = round2(w) // keep the size so tokens / walls still line up
				p["mapH"] = round2(h)
			}
			break
		}
	}

	z := 0
	put := func(m map[string]interface{}) {
		z++
		id := ttRandomID(6)
		m["id"] = id
		m["z"] = z
		sc.Items[id] = m
	}
	// initiative: the tracker marks the acting token with data.active
	var combat struct {
		InCombat bool    `json:"inCombat"`
		Round    float64 `json:"round"`
	}
	json.Unmarshal(doc.Metadata["com.initiative-tracker/combat"], &combat)
	turn := &ob2Turn{}
	mapDone := false
	for _, it := range items {
		sx, sy := it.Scale.X, it.Scale.Y
		if sx == 0 {
			sx = 1
		}
		if sy == 0 {
			sy = 1
		}
		switch {
		case it.Type == "IMAGE" && it.Layer == "MAP" && !mapDone && it.Image != nil:
			mapDone = true

		case it.Type == "IMAGE" && it.Image != nil && it.Layer != "ATTACHMENT":
			x, y, w, h := ob2ImageRect(it, g)
			tok := map[string]interface{}{
				"kind": "token", "x": round2(x - origin.X), "y": round2(y - origin.Y), "w": round2(w), "h": round2(h),
			}
			if id := images.id(it.Image.URL); id != "" {
				tok["asset"] = id
				kind := "token"
				if it.Layer == "MAP" {
					kind = "map"
				}
				addAsset(id, ob2Label(it), kind)
			} else {
				tok["circle"] = true
				tok["color"] = "#607d8b"
			}
			if label := ob2Label(it); label != "" {
				tok["label"] = label
			}
			if it.Rotation != 0 {
				tok["rot"] = it.Rotation
			}
			if !it.Visible {
				tok["hidden"] = true
			}
			if it.Locked && it.Layer != "CHARACTER" {
				tok["locked"] = true
			}
			var hp struct {
				Health    *float64 `json:"health"`
				MaxHealth *float64 `json:"max health"`
				TempHP    float64  `json:"temporary health"`
			}
			if raw, ok := it.Metadata["com.obr-suite/bubbles/data"]; ok && json.Unmarshal(raw, &hp) == nil && hp.MaxHealth != nil && *hp.MaxHealth > 0 {
				tok["hpMax"] = *hp.MaxHealth
				if hp.Health != nil {
					tok["hp"] = *hp.Health
				} else {
					tok["hp"] = *hp.MaxHealth
				}
				if hp.TempHP > 0 {
					tok["hpTemp"] = hp.TempHP
				}
			}
			if ob2Bool(it.Metadata["com.battle-system.smoke/hasVision"]) {
				if r := ob2Number(it.Metadata["com.battle-system.smoke/visionRange"]); r > 0 {
					tok["sight"] = r
				}
			}
			if slug := ob2String(it.Metadata["com.bestiary/slug"]); slug != "" {
				tok["bestiary"] = slug
			}
			if card := ob2String(it.Metadata["com.character-cards/boundCardId"]); card != "" {
				tok["cardId"] = card
				if n := ob2CardName(doc, card); n != "" {
					tok["pcName"] = n
					if _, ok := tok["label"]; !ok { // Owlbear showed the card name over the token
						tok["label"] = n
					}
				}
			}
			if ob2TokenExtras(it, tok, turn) {
				stats.Combatants++
			}
			put(tok)
			if turn.id == it.ID && turn.newID == "" {
				turn.newID = tok["id"].(string)
			}
			stats.Tokens++

		case it.Type == "CURVE" && ob2Bool(it.Metadata["com.battle-system.smoke/isVisionLine"]):
			pts := ob2Points(it, it.Points, sx, sy, origin)
			var st ob2Style
			json.Unmarshal(it.Style, &st)
			if st.Closed && len(pts) > 2 {
				pts = append(pts, pts[0])
			}
			if len(pts) < 2 {
				continue
			}
			wall := ob2Poly(pts)
			wall["kind"] = "wall"
			blocking, hasBlocking := it.Metadata["com.battle-system.smoke/blocking"]
			switch {
			case ob2Bool(it.Metadata["com.battle-system.smoke/isDoor"]):
				wall["wtype"] = "door"
				if ob2Bool(it.Metadata["com.battle-system.smoke/doorOpen"]) {
					wall["open"] = true
				}
				stats.Doors++
			case hasBlocking && !ob2Bool(blocking): // non-blocking vision line: see through, can't pass
				wall["wtype"] = "window"
				stats.Walls++
			default:
				wall["wtype"] = "wall"
				stats.Walls++
			}
			put(wall)

		case it.Layer == "DRAWING" && (it.Type == "CURVE" || it.Type == "LINE" || it.Type == "SHAPE"):
			var st ob2Style
			json.Unmarshal(it.Style, &st)
			color := st.StrokeColor
			if color == "" || st.StrokeOpacity == 0 || (it.Type == "SHAPE" && st.FillOpacity > 0) {
				color = st.FillColor // filled shapes: the tabletop uses one colour, keep the fill
			}
			d := map[string]interface{}{"kind": "draw", "color": ob2Color(color), "width": math.Max(1, st.StrokeWidth)}
			if !it.Visible {
				d["hidden"] = true
			}
			switch it.Type {
			case "CURVE":
				pts := ob2Points(it, it.Points, sx, sy, origin)
				if len(pts) == 0 {
					continue
				}
				for k, v := range ob2Poly(pts) {
					d[k] = v
				}
				d["shape"] = "pen"
			case "LINE":
				if it.StartPos == nil || it.EndPos == nil {
					continue
				}
				pts := ob2Points(it, []ob2Vec{*it.StartPos, *it.EndPos}, sx, sy, origin)
				for k, v := range ob2Poly(pts) {
					d[k] = v
				}
				d["shape"] = "line"
			case "SHAPE":
				w, h := it.Width*sx, it.Height*sy
				x, y := it.Position.X-origin.X, it.Position.Y-origin.Y
				switch it.ShapeType {
				case "CIRCLE":
					d["shape"], d["x"], d["y"], d["r"] = "circle", round2(x), round2(y), round2(math.Max(w, h)/2)
				case "RECTANGLE":
					d["shape"], d["x"], d["y"] = "rect", round2(x), round2(y)
					d["points"] = [][]float64{{0, 0}, {round2(w), round2(h)}}
				default:
					continue
				}
				if st.FillOpacity > 0 {
					d["fill"] = true
				}
			}
			put(d)

		case it.Type == "PATH" && it.Layer == "FOG" && it.Visible:
			// evenodd path: first sub-path covers, the following ones are holes (revealed)
			for i, poly := range ob2PathPolys(it, sx, sy, origin) {
				f := ob2Poly(poly)
				f["kind"], f["shape"] = "fog", "poly"
				if i > 0 {
					f["cut"] = true
				}
				put(f)
			}
		}
	}

	if combat.InCombat && turn.newID != "" {
		round := combat.Round
		if round < 1 {
			round = 1
		}
		p["combat"] = map[string]interface{}{"round": round, "turn": turn.newID}
	}

	// Owlbear's "fill fog" covers the whole map; drawn fog paths are applied on top of it
	if doc.Fog.Filled {
		w, _ := p["mapW"].(float64)
		h, _ := p["mapH"].(float64)
		if w > 0 && h > 0 {
			id := ttRandomID(6)
			sc.Items[id] = map[string]interface{}{"id": id, "kind": "fog", "shape": "rect", "x": 0.0, "y": 0.0, "z": 0,
				"points": [][]float64{{0, 0}, {w, h}}}
		}
	}
	return sc
}

// ob2ImageRect returns an image item's top-left and size in scene units.
// The image's grid offset (in image pixels) is the point placed at item.position.
func ob2ImageRect(it *ob2Item, sceneDPI float64) (x, y, w, h float64) {
	dpi := sceneDPI
	var off ob2Vec
	if it.Grid != nil && it.Grid.DPI > 0 {
		dpi = it.Grid.DPI
		off = it.Grid.Offset
	}
	sx, sy := it.Scale.X, it.Scale.Y
	if sx == 0 {
		sx = 1
	}
	if sy == 0 {
		sy = 1
	}
	k := sceneDPI / dpi
	w, h = it.Image.Width*k*math.Abs(sx), it.Image.Height*k*math.Abs(sy)
	x = it.Position.X - off.X*k*math.Abs(sx)
	y = it.Position.Y - off.Y*k*math.Abs(sy)
	return
}

// ob2Points maps item-local points to scene units relative to the map origin.
func ob2Points(it *ob2Item, pts []ob2Vec, sx, sy float64, origin ob2Vec) [][]float64 {
	rad := it.Rotation * math.Pi / 180
	cos, sin := math.Cos(rad), math.Sin(rad)
	out := make([][]float64, 0, len(pts))
	for _, p := range pts {
		x, y := p.X*sx, p.Y*sy
		x, y = x*cos-y*sin, x*sin+y*cos
		out = append(out, []float64{x + it.Position.X - origin.X, y + it.Position.Y - origin.Y})
	}
	return out
}

// ob2Poly turns absolute points into the tabletop's {x, y, points relative to x/y} form.
func ob2Poly(pts [][]float64) map[string]interface{} {
	ox, oy := pts[0][0], pts[0][1]
	rel := make([][]float64, len(pts))
	for i, p := range pts {
		rel[i] = []float64{round2(p[0] - ox), round2(p[1] - oy)}
	}
	return map[string]interface{}{"x": round2(ox), "y": round2(oy), "points": rel}
}

// ob2PathPolys splits Owlbear path commands into polygons:
// [0,x,y] move, [1,x,y] line, [2..4,…,x,y] curves (end point kept), [5] close.
func ob2PathPolys(it *ob2Item, sx, sy float64, origin ob2Vec) [][][]float64 {
	var polys [][]ob2Vec
	var cur []ob2Vec
	flush := func() {
		if len(cur) >= 3 {
			polys = append(polys, cur)
		}
		cur = nil
	}
	for _, c := range it.Commands {
		if len(c) == 0 {
			continue
		}
		switch int(c[0]) {
		case 0:
			flush()
			if len(c) >= 3 {
				cur = []ob2Vec{{c[1], c[2]}}
			}
		case 5:
			flush()
		default:
			if n := len(c); n >= 3 {
				cur = append(cur, ob2Vec{c[n-2], c[n-1]})
			}
		}
	}
	flush()
	out := make([][][]float64, 0, len(polys))
	for _, poly := range polys {
		out = append(out, ob2Points(it, poly, sx, sy, origin))
	}
	return out
}

func ob2Label(it *ob2Item) string {
	if it.Text != nil && strings.TrimSpace(it.Text.PlainText) != "" {
		return ttCleanName(it.Text.PlainText, 40, "")
	}
	if n := ob2String(it.Metadata["com.owlbear-rodeo-bubbles-extension/name"]); n != "" {
		return ttCleanName(n, 40, "")
	}
	// "圆形图片-1787…" is an auto-generated upload name, not a label
	if regexp.MustCompile(`^圆形图片-\d+$`).MatchString(it.Name) {
		return ""
	}
	return ttCleanName(it.Name, 40, "")
}

func ob2CardName(doc *ob2SceneDoc, cardID string) string {
	var cards []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	json.Unmarshal(doc.Metadata["com.character-cards/list"], &cards)
	for _, c := range cards {
		if c.ID == cardID {
			return ttCleanName(c.Name, 40, "")
		}
	}
	return ""
}

func ob2Color(c string) string {
	if regexp.MustCompile(`^#[0-9a-fA-F]{6}$`).MatchString(c) {
		return c
	}
	switch c {
	case "black":
		return "#000000"
	case "white":
		return "#ffffff"
	}
	return "#e53935"
}

func ob2Bool(raw json.RawMessage) bool {
	var b bool
	return json.Unmarshal(raw, &b) == nil && b
}

func ob2String(raw json.RawMessage) string {
	var s string
	json.Unmarshal(raw, &s)
	return s
}

// ob2Number accepts both numbers and numeric strings (Smoke stores "30").
func ob2Number(raw json.RawMessage) float64 {
	var f float64
	if json.Unmarshal(raw, &f) == nil {
		return f
	}
	f, _ = strconv.ParseFloat(ob2String(raw), 64)
	return f
}

func round2(f float64) float64 { return math.Round(f*100) / 100 }

func ob2RoomName(filename string, scenes int) string {
	base := strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
	if base == "" || regexp.MustCompile(`^[0-9a-fA-F-]{20,}$`).MatchString(base) {
		return fmt.Sprintf("Owlbear 导入（%d 个场景）", scenes)
	}
	return base
}

// ob2Turn tracks which converted token holds the initiative tracker's active turn.
type ob2Turn struct {
	id    string // Owlbear item id of the active token
	newID string // its id in the tabletop scene
}

// metadata keys converted into tabletop fields; everything else is kept under item["obr"]
var ob2KnownMeta = map[string]bool{
	"com.obr-suite/bubbles/data": true, "com.owlbear-rodeo-bubbles-extension/name": true,
	"com.bestiary/slug": true, "com.character-cards/boundCardId": true,
	"com.initiative-tracker/data": true, "com.initiative-tracker/dexMod": true,
	"com.obr-suite/resources/data": true,
	"com.obr-suite/status/buffs":   true, "com.obr-suite/status/buff-rounds": true,
	"com.obr-suite/boss-bar/config":     true,
	"com.battle-system.smoke/hasVision": true, "com.battle-system.smoke/visionRange": true,
}

// ob2TokenExtras converts obr-suite token data (AC, initiative, resources) and keeps the
// remaining extension metadata so a later Owlbear export can carry it back.
// Returns true when the token is in the initiative tracker.
func ob2TokenExtras(it *ob2Item, tok map[string]interface{}, turn *ob2Turn) bool {
	var bub struct {
		AC *float64 `json:"armor class"`
	}
	if raw, ok := it.Metadata["com.obr-suite/bubbles/data"]; ok && json.Unmarshal(raw, &bub) == nil && bub.AC != nil && *bub.AC > 0 {
		tok["ac"] = *bub.AC
	}
	if raw, ok := it.Metadata["com.initiative-tracker/dexMod"]; ok {
		if v, ok := ttNum(ob2Number(raw)); ok {
			tok["initMod"] = v
		}
	}
	inTracker := false
	var ini struct {
		Count    *float64 `json:"count"`
		Active   bool     `json:"active"`
		Rolled   bool     `json:"rolled"`
		Tiebreak *float64 `json:"tiebreak"`
	}
	if raw, ok := it.Metadata["com.initiative-tracker/data"]; ok && json.Unmarshal(raw, &ini) == nil && ini.Count != nil {
		inTracker = true
		tok["init"] = *ini.Count
		if ini.Rolled {
			tok["initRolled"] = true
		}
		if ini.Tiebreak != nil {
			tok["initTie"] = *ini.Tiebreak
		}
		if ini.Active {
			turn.id = it.ID
		}
	}
	// obr-suite resource tracker: [{id,name,type,current,max,icon,...}]
	var res []map[string]interface{}
	if raw, ok := it.Metadata["com.obr-suite/resources/data"]; ok && json.Unmarshal(raw, &res) == nil && len(res) > 0 {
		var out []map[string]interface{}
		for _, r := range res {
			name := ttCleanName(fmt.Sprint(r["name"]), 20, "")
			max, ok := ttNum(r["max"])
			if name == "" || !ok || len(out) >= 20 {
				continue
			}
			cur, _ := ttNum(r["current"])
			kind, _ := r["type"].(string)
			if kind != "bar" && kind != "number" {
				kind = "count"
			}
			icon, _ := r["icon"].(string)
			id, _ := r["id"].(string)
			if !ttIDRe.MatchString(id) {
				id = ttRandomID(4)
			}
			out = append(out, map[string]interface{}{"id": id, "name": name, "type": kind, "cur": cur, "max": max, "icon": icon})
		}
		if len(out) > 0 {
			tok["res"] = out
		}
	}
	// obr-suite status tracker: buff ids (+ remaining rounds) → item["status"]
	var buffs []string
	if raw, ok := it.Metadata["com.obr-suite/status/buffs"]; ok && json.Unmarshal(raw, &buffs) == nil && len(buffs) > 0 {
		var rounds map[string]float64
		json.Unmarshal(it.Metadata["com.obr-suite/status/buff-rounds"], &rounds)
		var out []map[string]interface{}
		for _, id := range buffs {
			def, ok := ob2Buffs[id]
			if !ok {
				def = ob2Buff{statusCustomName(id), "#9e9e9e"}
			}
			if def.name == "" || len(out) >= 12 {
				continue
			}
			st := map[string]interface{}{"id": ob2StatusID(id), "name": def.name, "color": def.color}
			if r := rounds[id]; r > 0 {
				st["rounds"] = r
			}
			out = append(out, st)
		}
		if len(out) > 0 {
			tok["status"] = out
		}
	}
	// obr-suite boss bar
	var boss struct {
		Enabled bool `json:"enabled"`
		Exact   bool `json:"exact"`
	}
	if raw, ok := it.Metadata["com.obr-suite/boss-bar/config"]; ok && json.Unmarshal(raw, &boss) == nil && boss.Enabled {
		tok["boss"] = true
		if boss.Exact {
			tok["bossExact"] = true
		}
	}
	// keep other (small) extension metadata
	keep := map[string]interface{}{}
	total := 0
	for k, raw := range it.Metadata {
		if ob2KnownMeta[k] || len(raw) > 2048 || total+len(raw) > 8192 {
			continue
		}
		var v interface{}
		if json.Unmarshal(raw, &v) == nil {
			keep[k] = v
			total += len(raw)
		}
	}
	if len(keep) > 0 {
		tok["obr"] = keep
	}
	return inTracker
}

type ob2Buff struct{ name, color string }

// obr-suite's built-in status buffs, mapped onto the tabletop's condition ids
var ob2Buffs = map[string]ob2Buff{
	"u_paralyzed": {"麻痹", "#fdd835"}, "u_stunned": {"震慑", "#f5deb3"}, "u_charmed": {"魅惑", "#ff00d0"},
	"u_invisible": {"隐形", "#cccccc"}, "u_bardic": {"诗人激励", "#7300ff"}, "u_disadvantage": {"劣势", "#3b82f6"},
	"u_advantage": {"优势", "#ffcc00"}, "u_restrained": {"束缚", "#8b4513"}, "u_blessing": {"祝福", "#fff176"},
	"u_guidance": {"神导术", "#fff59d"}, "u_hex": {"侵扰", "#7a1e9c"}, "u_focused": {"专注", "#4682b4"},
}

var ob2StatusIDs = map[string]string{
	"u_paralyzed": "paralyzed", "u_stunned": "stunned", "u_charmed": "charmed", "u_invisible": "invisible",
	"u_bardic": "bardic", "u_disadvantage": "disadvantage", "u_advantage": "advantage", "u_restrained": "restrained",
	"u_blessing": "blessed", "u_guidance": "guidance", "u_hex": "hexed", "u_focused": "concentration",
}

func ob2StatusID(id string) string {
	if v := ob2StatusIDs[id]; v != "" {
		return v
	}
	if ttIDRe.MatchString(id) {
		return id
	}
	return ttRandomID(4)
}

// custom buffs are scene-catalog entries we don't import; keep a readable name
func statusCustomName(id string) string {
	return ttCleanName(strings.TrimPrefix(strings.TrimPrefix(id, "u_"), "c_"), 20, "")
}

// ttSheetSizeCells: creature size (Chinese size words in size / meta) → cells.
func ttSheetSizeCells(sh map[string]interface{}) float64 {
	if sh == nil {
		return 0
	}
	size, _ := sh["size"].(string)
	meta, _ := sh["meta"].(string)
	text := size + " " + meta
	for _, s := range []struct {
		word  string
		cells float64
	}{{"超巨型", 4}, {"巨型", 3}, {"大型", 2}, {"中型", 1}, {"小型", 1}, {"微型", 0.5}} {
		if strings.Contains(text, s.word) {
			return s.cells
		}
	}
	return 0
}
