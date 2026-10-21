package main

import (
	"archive/zip"
	"encoding/xml"
	"errors"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"
)

// Character sheet import for the "DND 5E2024 人物卡" Excel template.
// Reads cached cell values from the 主要 sheet with archive/zip + encoding/xml
// (no third-party xlsx library), so formulas are taken as last calculated by Excel/WPS.

const ttMaxSheetXML = 64 << 20

type xlsxCells map[string]string

// readXlsxSheet returns the cached values of every non-empty cell of the named sheet.
func readXlsxSheet(zr *zip.Reader, sheetName string) (xlsxCells, error) {
	files := make(map[string]*zip.File)
	for _, f := range zr.File {
		files[f.Name] = f
	}
	open := func(name string) (io.ReadCloser, error) {
		f := files[name]
		if f == nil {
			return nil, errors.New("缺少 " + name)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		return struct {
			io.Reader
			io.Closer
		}{io.LimitReader(rc, ttMaxSheetXML), rc}, nil
	}

	// workbook.xml: sheet name → relationship id
	var wb struct {
		Sheets []struct {
			Name string `xml:"name,attr"`
			RID  string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
		} `xml:"sheets>sheet"`
	}
	if err := decodeZipXML(open, "xl/workbook.xml", &wb); err != nil {
		return nil, err
	}
	rid := ""
	for _, s := range wb.Sheets {
		if s.Name == sheetName {
			rid = s.RID
		}
	}
	if rid == "" {
		return nil, errors.New("找不到工作表「" + sheetName + "」")
	}

	var rels struct {
		Rels []struct {
			ID     string `xml:"Id,attr"`
			Target string `xml:"Target,attr"`
		} `xml:"Relationship"`
	}
	if err := decodeZipXML(open, "xl/_rels/workbook.xml.rels", &rels); err != nil {
		return nil, err
	}
	sheetPath := ""
	for _, r := range rels.Rels {
		if r.ID == rid {
			if strings.HasPrefix(r.Target, "/") {
				sheetPath = strings.TrimPrefix(r.Target, "/")
			} else {
				sheetPath = path.Join("xl", r.Target)
			}
		}
	}

	shared, err := readSharedStrings(open)
	if err != nil {
		return nil, err
	}

	rc, err := open(sheetPath)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	cells := make(xlsxCells)
	dec := xml.NewDecoder(rc)
	var ref, typ, val string
	var inV, inT bool
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, errors.New("工作表解析失败")
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "c":
				ref, typ, val = "", "", ""
				for _, a := range t.Attr {
					if a.Name.Local == "r" {
						ref = a.Value
					} else if a.Name.Local == "t" {
						typ = a.Value
					}
				}
			case "v":
				inV = true
			case "t":
				inT = typ == "inlineStr"
			}
		case xml.CharData:
			if inV || inT {
				val += string(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "v":
				inV = false
			case "t":
				inT = false
			case "c":
				if typ == "s" {
					if i, err := strconv.Atoi(val); err == nil && i >= 0 && i < len(shared) {
						val = shared[i]
					} else {
						val = ""
					}
				}
				if v := strings.TrimSpace(val); v != "" && ref != "" {
					cells[ref] = v
				}
			}
		}
	}
	return cells, nil
}

func decodeZipXML(open func(string) (io.ReadCloser, error), name string, v interface{}) error {
	rc, err := open(name)
	if err != nil {
		return err
	}
	defer rc.Close()
	if err := xml.NewDecoder(rc).Decode(v); err != nil {
		return errors.New(name + " 解析失败")
	}
	return nil
}

// readSharedStrings concatenates all <t> runs of each <si>, skipping phonetic (<rPh>) runs.
func readSharedStrings(open func(string) (io.ReadCloser, error)) ([]string, error) {
	rc, err := open("xl/sharedStrings.xml")
	if err != nil {
		return nil, nil // workbooks without any text have no sharedStrings part
	}
	defer rc.Close()
	var out []string
	var cur strings.Builder
	inT, inPh := false, false
	dec := xml.NewDecoder(rc)
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, errors.New("sharedStrings 解析失败")
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "si":
				cur.Reset()
			case "rPh":
				inPh = true
			case "t":
				inT = !inPh
			}
		case xml.CharData:
			if inT {
				cur.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "si":
				out = append(out, cur.String())
			case "rPh":
				inPh = false
			case "t":
				inT = false
			}
		}
	}
	return out, nil
}

// cell value helpers: Excel stores 16 as "16" but computed values may come out as "16.000000000000004"
func (c xlsxCells) str(ref string) string { return strings.TrimSpace(c[ref]) }

func (c xlsxCells) num(ref string) string {
	s := c.str(ref)
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return s
}

func (c xlsxCells) bonus(ref string) string {
	s := strings.ToLower(strings.ReplaceAll(c.num(ref), " ", ""))
	s = strings.TrimPrefix(s, "d20")
	if s == "" {
		return ""
	}
	if !strings.HasPrefix(s, "+") && !strings.HasPrefix(s, "-") {
		s = "+" + s
	}
	return s
}

var dnd5eAbilities = []struct{ key, name string }{
	{"str", "力量"}, {"dex", "敏捷"}, {"con", "体质"}, {"int", "智力"}, {"wis", "感知"}, {"cha", "魅力"},
}

func ref(col string, row int) string { return col + strconv.Itoa(row) }

// parseDnd5eCard maps the 主要 sheet of the template to the tabletop sheet format.
func parseDnd5eCard(c xlsxCells) (map[string]interface{}, error) {
	if c.str("C13") != "力量" || c.str("C18") != "魅力" || c.str("B23") != "AC" {
		return nil, errors.New("不是支持的人物卡模板（需要「DND 5E2024 人物卡」的「主要」工作表）")
	}

	abilities := make([]map[string]interface{}, 0, 6)
	for i, a := range dnd5eAbilities {
		row := 13 + i
		abilities = append(abilities, map[string]interface{}{
			"key": a.key, "name": a.name,
			"score":    c.num(ref("F", row)),
			"mod":      c.bonus(ref("R", row)),
			"save":     c.bonus(ref("T", row)),
			"saveProf": c.str(ref("B", row)) == "O",
		})
	}

	// skills: rows under 技能, grouped by ability header rows (B = ability name)
	var skills []map[string]interface{}
	group := ""
	for row := 39; row <= 63; row++ {
		b, name := c.str(ref("B", row)), c.str(ref("C", row))
		for _, a := range dnd5eAbilities {
			if b == a.name {
				group = a.name
			}
		}
		if (b == "O" || b == "X") && name != "" && c.str(ref("I", row)) != "" {
			skills = append(skills, map[string]interface{}{
				"name": name, "ability": group, "bonus": c.bonus(ref("I", row)), "prof": b == "O",
			})
		}
	}

	var attacks []map[string]interface{}
	for row := 32; row <= 36; row++ {
		name := c.str(ref("B", row))
		if name == "" {
			continue
		}
		dmg := strings.ReplaceAll(c.num(ref("AB", row))+c.bonus(ref("AD", row)), " ", "")
		attacks = append(attacks, map[string]interface{}{
			"name": name, "atk": c.bonus(ref("Z", row)), "damage": strings.TrimPrefix(dmg, "+"),
			"type": c.str(ref("AF", row)), "props": c.str(ref("M", row)),
			"mastery": c.str(ref("AN", row)), "effect": c.str(ref("AP", row)),
		})
	}

	var casting []map[string]interface{}
	for row := 66; row <= 68; row++ {
		if a := c.str(ref("B", row)); a != "" {
			casting = append(casting, map[string]interface{}{"ability": a, "dc": c.num(ref("G", row)), "atk": c.bonus(ref("K", row))})
		}
	}

	var slots []map[string]interface{}
	for row := 72; row <= 80; row++ {
		if max := c.num(ref("H", row)); max != "" && max != "0" {
			cur := c.num(ref("E", row))
			if cur == "" {
				cur = max
			}
			slots = append(slots, map[string]interface{}{"level": c.num(ref("B", row)), "cur": cur, "max": max})
		}
	}

	// spells: (level, name) column pairs in the prepared (rows 66-74) and cantrip (rows 77-82) tables
	var spells []map[string]interface{}
	for _, rows := range [][2]int{{66, 74}, {77, 82}} {
		for _, pair := range [][2]string{{"P", "Q"}, {"X", "Y"}, {"AF", "AG"}, {"AN", "AO"}} {
			for row := rows[0]; row <= rows[1]; row++ {
				name := c.str(ref(pair[1], row))
				if name == "" || name == "法术名称" {
					continue
				}
				spells = append(spells, map[string]interface{}{"level": c.num(ref(pair[0], row)), "name": name})
			}
		}
	}

	var resources []map[string]interface{}
	for row := 26; row <= 28; row++ {
		for _, cols := range [][3]string{{"B", "J", "M"}, {"Q", "Y", "AB"}, {"AF", "AN", "AQ"}} {
			name := c.str(ref(cols[0], row))
			max := c.num(ref(cols[2], row))
			if name == "" || name == "特殊能力" || max == "" || max == "0" {
				continue
			}
			resources = append(resources, map[string]interface{}{"name": name, "cur": c.num(ref(cols[1], row)), "max": max})
		}
	}

	// features: class features (AX/BC), race traits & feats (BT/BU + BZ)
	headers := map[string]bool{"名称": true, "描述": true, "Lv": true, "名字": true}
	var features []map[string]interface{}
	addFeature := func(name, text string) {
		if name != "" && text != "" && !headers[name] {
			features = append(features, map[string]interface{}{"name": name, "text": text})
		}
	}
	for row := 3; row <= 101; row++ {
		addFeature(c.str(ref("AX", row)), c.str(ref("BC", row)))
		name := c.str(ref("BU", row))
		if name == "" {
			name = c.str(ref("BT", row))
		}
		addFeature(name, c.str(ref("BZ", row)))
	}

	name := c.str("E3")
	if name == "" {
		name = "未命名角色"
	}
	return map[string]interface{}{
		"kind":      "pc",
		"name":      name,
		"player":    c.str("E4"),
		"class":     c.str("E6"),
		"subclass":  c.str("I6"),
		"level":     c.num("O6"),
		"race":      strings.TrimSpace(c.str("T6") + " " + c.str("T7")),
		"alignment": c.str("T8"),
		"prof":      c.bonus("S3"),
		"init":      c.bonus("D22"),
		"ac":        c.num("D23"),
		"dc":        c.num("D24"),
		"passive":   c.num("L23"),
		"speed":     c.str("AR24"),
		"size":      c.str("AR23"),
		"hp":        map[string]interface{}{"cur": c.num("R22"), "max": c.num("V22")},
		"hd":        strings.TrimSpace(c.num("R23") + "/" + c.num("U23") + " " + c.str("W23")),
		"abilities": abilities,
		"skills":    skills,
		"attacks":   attacks,
		"casting":   casting,
		"slots":     slots,
		"spells":    spells,
		"resources": resources,
		"features":  features,
	}, nil
}

// POST /api/tabletop/charsheet — parse an uploaded .xlsx character card (stateless)
func (t *Tabletop) HandleCharSheet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 40<<20)
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "文件无效或超过 40MB"})
		return
	}
	defer file.Close()
	zr, err := zip.NewReader(file, header.Size)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": "不是有效的 .xlsx 文件（旧版 .xls 请先另存为 .xlsx）"})
		return
	}
	cells, err := readXlsxSheet(zr, "主要")
	if err == nil {
		var sheet map[string]interface{}
		if sheet, err = parseDnd5eCard(cells); err == nil {
			t.db.RecordAction(getClientIP(r), getTokenInfo(r).Username, "tabletop_charsheet", header.Filename)
			writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "sheet": sheet})
			return
		}
	}
	writeJSON(w, http.StatusBadRequest, map[string]interface{}{"error": err.Error()})
}
