package main

import (
	"database/sql"
	"errors"
	"log"
	"strings"
	"time"

	_ "modernc.org/sqlite"
	"golang.org/x/crypto/bcrypt"
)

var ErrUserExists = errors.New("username already exists")

type DB struct {
	conn *sql.DB
}

func NewDB(path string) (*DB, error) {
	conn, err := sql.Open("sqlite", path+"?_journal_mode=delete&_foreign_keys=on&_pragma=busy_timeout=5000")
	if err != nil {
		return nil, err
	}

	conn.SetMaxOpenConns(1)
	conn.SetMaxIdleConns(1)
	conn.SetConnMaxLifetime(time.Hour)

	db := &DB{conn: conn}
	if err := db.migrate(); err != nil {
		return nil, err
	}
	db.seedAdmin()
	return db, nil
}

func (db *DB) migrate() error {
	schema := `
		CREATE TABLE IF NOT EXISTS visitors (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ip TEXT NOT NULL,
			user_agent TEXT NOT NULL DEFAULT '',
			path TEXT NOT NULL DEFAULT '/',
			visit_time DATETIME NOT NULL DEFAULT (datetime('now', 'localtime'))
		);

		CREATE TABLE IF NOT EXISTS auth_attempts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ip TEXT NOT NULL,
			password TEXT NOT NULL,
			success INTEGER NOT NULL DEFAULT 0,
			attempt_time DATETIME NOT NULL DEFAULT (datetime('now', 'localtime'))
		);

		CREATE TABLE IF NOT EXISTS stream_views (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ip TEXT NOT NULL,
			app TEXT NOT NULL,
			stream TEXT NOT NULL,
			view_time DATETIME NOT NULL DEFAULT (datetime('now', 'localtime'))
		);

		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'user',
			status TEXT NOT NULL DEFAULT 'pending',
			created_at DATETIME NOT NULL DEFAULT (datetime('now', 'localtime'))
		);

		CREATE INDEX IF NOT EXISTS idx_visitors_time ON visitors(visit_time);
		CREATE INDEX IF NOT EXISTS idx_auth_time ON auth_attempts(attempt_time);
		CREATE INDEX IF NOT EXISTS idx_stream_views_time ON stream_views(view_time);
		CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

		CREATE TABLE IF NOT EXISTS cloud_files (
			filepath TEXT PRIMARY KEY,
			uploader TEXT NOT NULL,
			updated_at DATETIME NOT NULL DEFAULT (datetime('now', 'localtime'))
		);

		CREATE TABLE IF NOT EXISTS action_logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ip TEXT NOT NULL,
			username TEXT NOT NULL DEFAULT '',
			action TEXT NOT NULL,
			detail TEXT NOT NULL DEFAULT '',
			created_at DATETIME NOT NULL DEFAULT (datetime('now', 'localtime'))
		);
		CREATE INDEX IF NOT EXISTS idx_action_logs_time ON action_logs(created_at);
		`
	_, err := db.conn.Exec(schema)
	return err
}

func (db *DB) seedAdmin() {
	var count int
	db.conn.QueryRow("SELECT COUNT(*) FROM users WHERE role='admin'").Scan(&count)
	if count > 0 {
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte("krusgaltn"), bcrypt.DefaultCost)
	if err != nil {
		log.Printf("[DB] seed admin hash error: %v", err)
		return
	}
	_, err = db.conn.Exec(
		"INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, ?, ?)",
		"admin", string(hash), "admin", "active",
	)
	if err != nil {
		log.Printf("[DB] seed admin error: %v", err)
		return
	}
	log.Printf("[DB] seeded admin user (admin/krusgaltn)")
}

// === User CRUD ===

func (db *DB) CreateUser(username, password string) (int64, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return 0, err
	}
	result, err := db.conn.Exec(
		"INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, 'user', 'pending')",
		username, string(hash),
	)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint") {
			return 0, ErrUserExists
		}
		return 0, err
	}
	return result.LastInsertId()
}

func (db *DB) GetUserByUsername(username string) (map[string]interface{}, error) {
	var id int64
	var pwHash, role, status, createdAt string
	err := db.conn.QueryRow(
		"SELECT id, password_hash, role, status, created_at FROM users WHERE username=?",
		username,
	).Scan(&id, &pwHash, &role, &status, &createdAt)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"id":            id,
		"username":      username,
		"password_hash": pwHash,
		"role":          role,
		"status":        status,
		"created_at":    createdAt,
	}, nil
}

func (db *DB) VerifyUserPassword(username, password string) (map[string]interface{}, error) {
	user, err := db.GetUserByUsername(username)
	if err != nil {
		return nil, err
	}
	if user["status"] != "active" {
		return nil, sql.ErrNoRows
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user["password_hash"].(string)), []byte(password)); err != nil {
		return nil, err
	}
	return user, nil
}

func (db *DB) ListUsers() ([]map[string]interface{}, error) {
	rows, err := db.conn.Query("SELECT id, username, role, status, created_at FROM users ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanUsers(rows)
}

func (db *DB) ListPendingUsers() ([]map[string]interface{}, error) {
	rows, err := db.conn.Query("SELECT id, username, role, status, created_at FROM users WHERE status='pending' ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanUsers(rows)
}

func (db *DB) ApproveUser(userID int64) error {
	_, err := db.conn.Exec("UPDATE users SET status='active' WHERE id=?", userID)
	return err
}

func (db *DB) RejectUser(userID int64) error {
	result, err := db.conn.Exec("DELETE FROM users WHERE id=? AND status='pending'", userID)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return errors.New("user not found or not pending")
	}
	if n > 1 {
		log.Printf("[DB] WARNING: RejectUser id=%d affected %d rows", userID, n)
	}
	return nil
}

func (db *DB) DeleteUser(userID int64) error {
	result, err := db.conn.Exec("DELETE FROM users WHERE id=? AND role!='admin'", userID)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return errors.New("user not found or is admin")
	}
	return nil
}

func (db *DB) ChangePassword(userID int64, newPassword string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	_, err = db.conn.Exec("UPDATE users SET password_hash=? WHERE id=?", string(hash), userID)
	return err
}

func scanUsers(rows *sql.Rows) ([]map[string]interface{}, error) {
	var results []map[string]interface{}
	for rows.Next() {
		var id int64
		var username, role, status, createdAt string
		if err := rows.Scan(&id, &username, &role, &status, &createdAt); err != nil {
			continue
		}
		results = append(results, map[string]interface{}{
			"id":         id,
			"username":   username,
			"role":       role,
			"status":     status,
			"created_at": createdAt,
		})
	}
	return results, nil
}

// === Action logging (replaces per-request visitor recording) ===

func (db *DB) RecordAction(ip, username, action, detail string) {
	_, err := db.conn.Exec(
		"INSERT INTO action_logs (ip, username, action, detail) VALUES (?, ?, ?, ?)",
		ip, username, action, detail,
	)
	if err != nil {
		log.Printf("[DB] record action error: %v", err)
	}
}

// === Existing record functions (kept for dedicated audit trails) ===

func (db *DB) RecordVisit(ip, userAgent, path string) {
	_, err := db.conn.Exec(
		"INSERT INTO visitors (ip, user_agent, path) VALUES (?, ?, ?)",
		ip, userAgent, path,
	)
	if err != nil {
		log.Printf("[DB] record visit error: %v", err)
	}
}

func (db *DB) RecordAuthAttempt(ip, password string, success bool) {
	successInt := 0
	if success {
		successInt = 1
	}
	_, err := db.conn.Exec(
		"INSERT INTO auth_attempts (ip, password, success) VALUES (?, ?, ?)",
		ip, password, successInt,
	)
	if err != nil {
		log.Printf("[DB] record auth error: %v", err)
	}
}

func (db *DB) RecordStreamView(ip, app, stream string) {
	_, err := db.conn.Exec(
		"INSERT INTO stream_views (ip, app, stream) VALUES (?, ?, ?)",
		ip, app, stream,
	)
	if err != nil {
		log.Printf("[DB] record stream view error: %v", err)
	}
}

// === Admin query methods ===

func (db *DB) RecentActions(limit, offset int) ([]map[string]interface{}, error) {
	rows, err := db.conn.Query(
		"SELECT ip, username, action, detail, created_at FROM action_logs ORDER BY created_at DESC LIMIT ? OFFSET ?",
		limit, offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []map[string]interface{}
	for rows.Next() {
		var ip, username, action, detail, createdAt string
		if err := rows.Scan(&ip, &username, &action, &detail, &createdAt); err != nil {
			continue
		}
		results = append(results, map[string]interface{}{
			"ip":         ip,
			"username":   username,
			"action":     action,
			"detail":     detail,
			"created_at": createdAt,
		})
	}
	return results, nil
}

func (db *DB) CountActions() int {
	var n int
	db.conn.QueryRow("SELECT COUNT(*) FROM action_logs").Scan(&n)
	return n
}

func (db *DB) RecentVisitors(limit, offset int) ([]map[string]interface{}, error) {
	rows, err := db.conn.Query(
		"SELECT ip, user_agent, path, visit_time FROM visitors ORDER BY visit_time DESC LIMIT ? OFFSET ?",
		limit, offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []map[string]interface{}
	for rows.Next() {
		var ip, ua, path, visitTime string
		if err := rows.Scan(&ip, &ua, &path, &visitTime); err != nil {
			continue
		}
		results = append(results, map[string]interface{}{
			"ip":         ip,
			"user_agent": ua,
			"path":       path,
			"visit_time": visitTime,
		})
	}
	return results, nil
}

func (db *DB) RecentAuthAttempts(limit, offset int) ([]map[string]interface{}, error) {
	rows, err := db.conn.Query(
		"SELECT id, ip, password, success, attempt_time FROM auth_attempts ORDER BY attempt_time DESC LIMIT ? OFFSET ?",
		limit, offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []map[string]interface{}
	for rows.Next() {
		var id, success int
		var ip, password, attemptTime string
		if err := rows.Scan(&id, &ip, &password, &success, &attemptTime); err != nil {
			continue
		}
		results = append(results, map[string]interface{}{
			"id":           id,
			"ip":           ip,
			"password":     password,
			"success":      success == 1,
			"attempt_time": attemptTime,
		})
	}
	return results, nil
}

func (db *DB) RecentStreamViews(limit, offset int) ([]map[string]interface{}, error) {
	rows, err := db.conn.Query(
		"SELECT id, ip, app, stream, view_time FROM stream_views ORDER BY view_time DESC LIMIT ? OFFSET ?",
		limit, offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []map[string]interface{}
	for rows.Next() {
		var id int
		var ip, app, stream, viewTime string
		if err := rows.Scan(&id, &ip, &app, &stream, &viewTime); err != nil {
			continue
		}
		results = append(results, map[string]interface{}{
			"id":        id,
			"ip":        ip,
			"app":       app,
			"stream":    stream,
			"view_time": viewTime,
		})
	}
	return results, nil
}

func (db *DB) CountVisitors() int {
	var n int
	db.conn.QueryRow("SELECT COUNT(*) FROM visitors").Scan(&n)
	return n
}

func (db *DB) CountAuthAttempts() int {
	var n int
	db.conn.QueryRow("SELECT COUNT(*) FROM auth_attempts").Scan(&n)
	return n
}

func (db *DB) CountStreamViews() int {
	var n int
	db.conn.QueryRow("SELECT COUNT(*) FROM stream_views").Scan(&n)
	return n
}

func (db *DB) VisitorStats() (map[string]interface{}, error) {
	var totalActions, totalAuthAttempts, totalStreamViews int

	db.conn.QueryRow("SELECT COUNT(*) FROM action_logs").Scan(&totalActions)
	db.conn.QueryRow("SELECT COUNT(*) FROM auth_attempts").Scan(&totalAuthAttempts)
	db.conn.QueryRow("SELECT COUNT(*) FROM stream_views").Scan(&totalStreamViews)

	var authSuccess int
	db.conn.QueryRow("SELECT COUNT(*) FROM auth_attempts WHERE success=1").Scan(&authSuccess)

	var uniqueIPs int
	db.conn.QueryRow("SELECT COUNT(DISTINCT ip) FROM action_logs").Scan(&uniqueIPs)

	return map[string]interface{}{
		"total_visits":    totalActions,
		"unique_visitors": uniqueIPs,
		"auth_attempts":   totalAuthAttempts,
		"auth_success":    authSuccess,
		"stream_views":    totalStreamViews,
	}, nil
}

// === Cloud file uploader tracking ===

func (db *DB) SetFileUploader(filepath, uploader string) error {
	_, err := db.conn.Exec(
		"INSERT INTO cloud_files (filepath, uploader, updated_at) VALUES (?, ?, datetime('now','localtime')) ON CONFLICT(filepath) DO UPDATE SET uploader=excluded.uploader, updated_at=datetime('now','localtime')",
		filepath, uploader,
	)
	return err
}

func (db *DB) UpdateFilePath(oldPath, newPath, uploader string) error {
	_, err := db.conn.Exec("DELETE FROM cloud_files WHERE filepath=?", oldPath)
	if err != nil {
		return err
	}
	_, err = db.conn.Exec(
		"INSERT INTO cloud_files (filepath, uploader, updated_at) VALUES (?, ?, datetime('now','localtime'))",
		newPath, uploader,
	)
	return err
}

func (db *DB) BatchGetUploaders(paths []string) map[string]string {
	result := make(map[string]string)
	for _, p := range paths {
		var uploader string
		err := db.conn.QueryRow("SELECT uploader FROM cloud_files WHERE filepath=?", p).Scan(&uploader)
		if err != nil {
			result[p] = "admin"
		} else {
			result[p] = uploader
		}
	}
	return result
}

func (db *DB) Close() error {
	return db.conn.Close()
}
