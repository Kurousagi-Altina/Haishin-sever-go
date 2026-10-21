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

### Tabletop (tabletop.go + dice.go)

- Rooms live in memory, saved every 2s (dirty flag) to `TabletopDir/rooms/<id>.json`; images in `TabletopDir/assets/` named by sha256 (`ttAssetRe`).
- Sync: `GET /api/tabletop/events` (SSE, `?token=` auth) pushes a full `state` snapshot on connect, then deltas (`items`/`del`/`props`/`room`/`log`/`users`/`fx`). Clients send `POST /api/tabletop/op` with `{op, ...}`; all permission checks are in `TTRoom.apply`.
- GM = room owner or admin. Players may create `token`/`draw` items (owner forced to them), fully edit their own items, and only move (x/y) unlocked tokens. Hidden items are never sent to non-GMs (sent as `del`); hidden rolls are masked by `logEntryFor`.
- Door users have no identity: they join with a nickname, shown as `访客·<nick>`, and cannot create/import rooms.
- Items and scene props are free-form `map[string]interface{}` — the client defines the shape; the server only reads `id/kind/hidden/locked/owner/asset`.
- Dice are rolled server-side (`RollDice`): `NdM`, `d%`, `kh/kl/dh/dl/k`, `!`, `+/-` constants.
- Walls are items with `kind:"wall"` (`wtype` wall/window/door, `open`); GM-only to create. Players may only toggle `open` on unlocked doors. Line-of-sight / dynamic vision and move-blocking are computed client-side (`computeVision` in tabletop.js) — walls are sent to everyone.
- Sheets (`room.Sheets`, op `sheet` / `sheet.delete`) are free-form maps with `kind` pc/monster/item. Players may only create `pc` sheets (owner forced) and edit their own; non-GMs see pc, `shared`, or own sheets (`sheetVisible`). Tokens link via `item["sheet"]`.
- charsheet.go parses the "DND 5E2024 人物卡" .xlsx (sheet 主要, fixed cell layout, cached values) with archive/zip + encoding/xml. The embedded `obr-suite-card` JSON cell is often stale — don't rely on it.
- bestiary.go proxies DND5e 不全书 (fixed hosts only: page paths must be `topics/…htm(l)`); HTML is parsed in www/js/tabletop-sheets.js (2024 `.stat-block`, 2014 text split on 护甲等级, items split on H6 / red `<font>` headings).

## Frontend Pages

| Page | File | Player | Notes |
|------|------|--------|-------|
| Live | `www/index.html` | flv.js 1.6.2 | Gate password + user login, 5s stream polling |
| VOD | `www/vod.html` | native `<video>` | Direct MP4 via `/videos/` route, no hls.js |
| Cloud | `www/cloud.html` | native `<video>`/`<img>` | Preview modal for images/videos, `?preview=1` on download endpoint |
| Admin | `www/admin.html` | — | Separate login, tabbed dashboard, paginated logs |
| Tabletop | `www/tabletop.html` + `js/tabletop.js` + `js/tabletop-sheets.js` + `css/tabletop.css` | `<canvas>` | Virtual tabletop (maps, tokens, fog, walls/vision, sheets, dice), live via SSE |

Shared: `www/css/common.css` (frosted-glass theme), `www/js/utils.js` (`$()`, `escapeHtml()`, `escapeAttr()`, `formatSize()`).

## Key Conventions

- Handlers return JSON via `writeJSON(w, status, map[string]interface{}{...})`.
- Path traversal prevention: `safeResolvePath(base, sub)` in handler.go.
- Cloud download endpoint: `?preview=1` skips `Content-Disposition: attachment` for inline browser rendering.
- All destructive admin operations require `confirm()` dialogs in frontend.
- Token in localStorage as `authToken` (main site) or `adminToken` (admin page). Door tokens are not persisted.
- `interface{}` over `any` is the codebase style — don't modernize unless asked.
