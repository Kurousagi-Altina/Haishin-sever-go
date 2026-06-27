# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

```bash
cd backend
go build -o build/server.exe .       # Windows
CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o build/liveserver .  # Linux
air                                   # hot-reload (reads .air.toml)
```

No tests exist. Verify by building + starting the server.

## Architecture

Go backend (`net/http` stdlib, no framework) + static HTML/JS frontend + ZLMediaKit streaming server + SQLite (pure-Go `modernc.org/sqlite`).

### Routing (main.go)

Three-tier `http.ServeMux` sub-mux pattern:

| Tier | Pattern | Middleware | Purpose |
|------|---------|-----------|---------|
| Public | `/api/verify`, `/api/register`, `/api/login` | none | Auth endpoints |
| Protected | `/api/me`, `/api/streams`, `/api/cloud/*`, `/api/vod/*` | `AuthMiddleware` | Any valid token (door/user/admin) |
| Admin | `/api/admin/*` | `AuthMiddleware` + `AdminMiddleware` | role="admin" only |
| Files | `/videos/`, `/game/`, `/` | varies | Static file serving |

**Key routing detail**: Protected routes are on a `protected` sub-mux, wrapped per-route via `mux.Handle("/api/streams", AuthMiddleware(tm)(protected))`. The download route (`/api/cloud/download`) is the exception — registered directly on root mux and handles its own auth via query param `?token=` or `Authorization` header, because `<a>` / `window.location` download redirects can't set headers.

### Auth (token.go + middleware.go)

- In-memory token store, no JWT, no persistence. Restart invalidates all sessions.
- `TokenInfo{UserID, Username, Role}` stored in request context under `tokenInfoKey`.
- Three roles: `door` (gate password), `user` (registered), `admin`.
- `getTokenInfo(r)` extracts it in handlers; `getClientIP(r)` handles X-Forwarded-For.

### Database (db.go)

- `SetMaxOpenConns(1)` — serialized single-connection access.
- `migrate()` runs multi-statement schema creation with `IF NOT EXISTS`.
- `seedAdmin()` creates admin/krusgaltn on first run.
- Users: `CreateUser` returns `ErrUserExists` sentinel for UNIQUE violations — handlers should check with `errors.Is`.
- `RejectUser`/`DeleteUser` check `RowsAffected()` and return error if 0.
- Action logging: `RecordAction()` is fire-and-forget (errors logged but not returned).

### Config (config.go)

Priority: `config.json` → environment variables → hardcoded defaults.
First run auto-creates `config.json` with defaults. `TokenExpiry` is a string ("72h" or "259200"), converted by `TokenExpiryDuration()`.

### ZLM Integration (zlm.go)

Minimal — only `GetMediaList()` calling `/index/api/getMediaList?secret=...`. Stream playback is direct from ZLM to browser (FLV), not proxied.

## Frontend Pages

| Page | File | Player | Notes |
|------|------|--------|-------|
| Live | `www/index.html` | flv.js 1.6.2 | Gate password + user login, 5s stream polling |
| VOD | `www/vod.html` | native `<video>` | Direct MP4 via `/videos/` route, no hls.js |
| Cloud | `www/cloud.html` | native `<video>`/`<img>` | Preview modal for images/videos, `?preview=1` on download endpoint |
| Admin | `www/admin.html` | — | Separate login, tabbed dashboard, paginated logs |

Shared: `www/css/common.css` (frosted-glass theme), `www/js/utils.js` (`$()`, `escapeHtml()`, `escapeAttr()`, `formatSize()`).

## Key Conventions

- Handlers return JSON via `writeJSON(w, status, map[string]interface{}{...})`.
- Path traversal prevention: `safeResolvePath(base, sub)` in handler.go.
- Cloud download endpoint: `?preview=1` skips `Content-Disposition: attachment` for inline browser rendering.
- All destructive admin operations require `confirm()` dialogs in frontend.
- Token in localStorage as `authToken` (main site) or `adminToken` (admin page). Door tokens are not persisted.
- `interface{}` over `any` is the codebase style — don't modernize unless asked.
