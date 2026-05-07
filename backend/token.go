package main

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

type TokenInfo struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
	Role     string `json:"role"` // "admin", "user", "door"
}

type tokenEntry struct {
	info    TokenInfo
	expires time.Time
}

type TokenManager struct {
	mu     sync.RWMutex
	tokens map[string]tokenEntry
	expiry time.Duration
}

func NewTokenManager(expiry time.Duration) *TokenManager {
	tm := &TokenManager{
		tokens: make(map[string]tokenEntry),
		expiry: expiry,
	}
	go tm.cleanupLoop()
	return tm
}

// Generate creates a token without user identity (door password token).
func (tm *TokenManager) Generate() string {
	return tm.generateToken(TokenInfo{Role: "door"})
}

// GenerateUser creates a token with user identity.
func (tm *TokenManager) GenerateUser(userID int64, username, role string) string {
	return tm.generateToken(TokenInfo{
		UserID:   userID,
		Username: username,
		Role:     role,
	})
}

func (tm *TokenManager) generateToken(info TokenInfo) string {
	b := make([]byte, 32)
	rand.Read(b)
	token := hex.EncodeToString(b)

	tm.mu.Lock()
	tm.tokens[token] = tokenEntry{info: info, expires: time.Now().Add(tm.expiry)}
	tm.mu.Unlock()

	return token
}

// Validate checks the token and returns its info if valid.
func (tm *TokenManager) Validate(token string) (TokenInfo, bool) {
	tm.mu.RLock()
	entry, ok := tm.tokens[token]
	tm.mu.RUnlock()

	if !ok {
		return TokenInfo{}, false
	}
	if time.Now().After(entry.expires) {
		tm.mu.Lock()
		delete(tm.tokens, token)
		tm.mu.Unlock()
		return TokenInfo{}, false
	}
	return entry.info, true
}

func (tm *TokenManager) cleanupLoop() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		tm.mu.Lock()
		now := time.Now()
		for token, entry := range tm.tokens {
			if now.After(entry.expires) {
				delete(tm.tokens, token)
			}
		}
		tm.mu.Unlock()
	}
}
