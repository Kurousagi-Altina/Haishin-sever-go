package main

import (
	"database/sql"
	"encoding/json"
	"errors"
)

// === 掷骰记录 ===

// InsertDiceRoll 保存一次投掷并返回带 id/时间的记录。
func (db *DB) InsertDiceRoll(room string, userID int64, username, character, rollName, expression, detail string, total int, crit string) (map[string]interface{}, error) {
	var id int64
	var createdAt string
	err := db.conn.QueryRow(
		`INSERT INTO dice_rolls (room, user_id, username, character_name, roll_name, expression, detail, total, crit)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 RETURNING id, created_at`,
		room, userID, username, character, rollName, expression, detail, total, crit,
	).Scan(&id, &createdAt)
	if err != nil {
		return nil, err
	}

	return map[string]interface{}{
		"id":             id,
		"room":           room,
		"user_id":        userID,
		"username":       username,
		"character_name": character,
		"roll_name":      rollName,
		"expression":     expression,
		"detail":         json.RawMessage(detail),
		"total":          total,
		"crit":           crit,
		"created_at":     createdAt,
	}, nil
}

// ListDiceRolls 返回某房间的投掷记录（按 id 倒序，最新在前）。
// since > 0 时只返回 id 大于 since 的记录；同时返回该房间当前最大 id 供前端对账。
func (db *DB) ListDiceRolls(room string, since int64, limit int) ([]map[string]interface{}, int64, error) {
	var latest int64
	db.conn.QueryRow("SELECT COALESCE(MAX(id), 0) FROM dice_rolls WHERE room=?", room).Scan(&latest)

	const columns = `id, user_id, username, character_name, roll_name, expression, detail, total, crit, created_at`

	var (
		rows *sql.Rows
		err  error
	)
	if since > 0 {
		rows, err = db.conn.Query(
			`SELECT `+columns+` FROM dice_rolls WHERE room=? AND id>? ORDER BY id DESC LIMIT ?`,
			room, since, limit,
		)
	} else {
		rows, err = db.conn.Query(
			`SELECT `+columns+` FROM dice_rolls WHERE room=? ORDER BY id DESC LIMIT ?`,
			room, limit,
		)
	}
	if err != nil {
		return nil, latest, err
	}
	defer rows.Close()

	rolls := make([]map[string]interface{}, 0)
	for rows.Next() {
		var (
			id, userID, total       int64
			username, character     string
			rollName, expression    string
			detail, crit, createdAt string
		)
		if err := rows.Scan(&id, &userID, &username, &character, &rollName, &expression, &detail, &total, &crit, &createdAt); err != nil {
			continue
		}
		rolls = append(rolls, map[string]interface{}{
			"id":             id,
			"room":           room,
			"user_id":        userID,
			"username":       username,
			"character_name": character,
			"roll_name":      rollName,
			"expression":     expression,
			"detail":         json.RawMessage(detail),
			"total":          total,
			"crit":           crit,
			"created_at":     createdAt,
		})
	}
	return rolls, latest, rows.Err()
}

// DeleteDiceRoll 删除一条记录。非管理员只能删自己的（door 访客 user_id=0，不可删）。
func (db *DB) DeleteDiceRoll(id, userID int64, isAdmin bool) error {
	var (
		result sql.Result
		err    error
	)
	if isAdmin {
		result, err = db.conn.Exec("DELETE FROM dice_rolls WHERE id=?", id)
	} else {
		result, err = db.conn.Exec("DELETE FROM dice_rolls WHERE id=? AND user_id=? AND user_id!=0", id, userID)
	}
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return errors.New("记录不存在或无权删除")
	}
	return nil
}

// ClearDiceRoom 清空一个房间的全部记录，返回删除条数。
func (db *DB) ClearDiceRoom(room string) (int64, error) {
	result, err := db.conn.Exec("DELETE FROM dice_rolls WHERE room=?", room)
	if err != nil {
		return 0, err
	}
	n, _ := result.RowsAffected()
	return n, nil
}

// ListDiceRooms 列出最近活跃的房间。
func (db *DB) ListDiceRooms() ([]map[string]interface{}, error) {
	rows, err := db.conn.Query(
		`SELECT room, COUNT(*) AS rolls, MAX(created_at) AS last_at
		 FROM dice_rolls GROUP BY room ORDER BY last_at DESC LIMIT 50`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	rooms := make([]map[string]interface{}, 0)
	for rows.Next() {
		var room, lastAt string
		var count int64
		if err := rows.Scan(&room, &count, &lastAt); err != nil {
			continue
		}
		rooms = append(rooms, map[string]interface{}{
			"room":    room,
			"rolls":   count,
			"last_at": lastAt,
		})
	}
	return rooms, rows.Err()
}

// === 骰子预设（可保存的骰子组合） ===

// SaveDicePreset 新建或覆盖同名预设。
func (db *DB) SaveDicePreset(userID int64, username, name, expression string) (map[string]interface{}, error) {
	var (
		id        int64
		createdAt string
	)
	err := db.conn.QueryRow(
		`INSERT INTO dice_presets (user_id, username, name, expression) VALUES (?, ?, ?, ?)
		 ON CONFLICT(user_id, name) DO UPDATE SET expression=excluded.expression, username=excluded.username
		 RETURNING id, created_at`,
		userID, username, name, expression,
	).Scan(&id, &createdAt)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"id":         id,
		"name":       name,
		"expression": expression,
		"created_at": createdAt,
	}, nil
}

// ListDicePresets 返回该用户的全部预设，最近保存的在前。
func (db *DB) ListDicePresets(userID int64) ([]map[string]interface{}, error) {
	rows, err := db.conn.Query(
		`SELECT id, name, expression, created_at FROM dice_presets WHERE user_id=? ORDER BY id DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	presets := make([]map[string]interface{}, 0)
	for rows.Next() {
		var id int64
		var name, expression, createdAt string
		if err := rows.Scan(&id, &name, &expression, &createdAt); err != nil {
			continue
		}
		presets = append(presets, map[string]interface{}{
			"id":         id,
			"name":       name,
			"expression": expression,
			"created_at": createdAt,
		})
	}
	return presets, rows.Err()
}

// DeleteDicePreset 删除该用户名下的一个预设。
func (db *DB) DeleteDicePreset(userID, id int64) error {
	result, err := db.conn.Exec("DELETE FROM dice_presets WHERE id=? AND user_id=?", id, userID)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return errors.New("预设不存在")
	}
	return nil
}
