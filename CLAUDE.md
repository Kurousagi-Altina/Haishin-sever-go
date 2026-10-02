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
| Protected | `/api/me`, `/api/streams`, `/api/cloud/*`, `/api/vod/*`, `/api/dice/*` | `AuthMiddleware` | Any valid token (door/user/admin) |
| Admin | `/api/admin/*` | `AuthMiddleware` + `AdminMiddleware` | role="admin" only |
| Files | `/videos/`, `/game/`, `/` | varies | Static file serving |

**Key routing detail**: Protected routes are on a `protected` sub-mux, wrapped per-route via `mux.Handle("/api/streams", AuthMiddleware(tm)(protected))`. The download route (`/api/cloud/download`) is the exception — registered directly on root mux and handles its own auth via query param `?token=` or `Authorization` header, because `<a>` / `window.location` download redirects can't set headers.

### Auth (token.go + middleware.go)

- In-memory token store, no JWT, no persistence. Restart invalidates all sessions.
- `TokenInfo{UserID, Username, Role}` stored in request context under `tokenInfoKey`.
- Three roles: `door` (gate password), `user` (registered), `admin`.
- `getTokenInfo(r)` extracts it in handlers; `getClientIP(r)` handles X-Forwarded-For.
- Passwords are **bcrypt-hashed** (`bcrypt.GenerateFromPassword`) — the plaintext is never stored and cannot be recovered. So "找回密码" is an admin-issued *reset* (`POST /api/admin/reset-password` sets a new password for a given `user_id`), never a password display. Don't add plaintext/reversible storage to make passwords viewable.
- Two ways a password changes: `POST /api/change-password` (self-service, any token with `user_id != 0`, requires the current password) and `POST /api/admin/reset-password` (admin, no current password needed). The self-service one returns **403** on a wrong current password, not 401 — the frontend `api()` helper treats 401 as "session expired" and would log the user out mid-typo.
- `/api/admin/change-password` still exists for the admin page's own 修改密码 modal and does *not* require the current password. It's redundant with `/api/change-password`; prefer the latter for new UI.
- Changing a password does **not** invalidate already-issued tokens — the token store is in-memory and keyed only by the token string, so an active session survives a reset. Relevant if a reset is meant to kick someone out.
- `/api/verify` records the attempted door password verbatim into `auth_attempts.password` (the `/api/login` path stores the username in that column instead). The admin 鉴权记录 tab renders it, so the door password is sitting in the DB in cleartext.

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

### Dice module (dice.go / dice_db.go / dice_handler.go)

D&D-style dice roller; every roll is persisted and visible to everyone in the same room.

- Grammar: `NdM` with keep/drop (`kh`/`kl`/`dh`/`dl`), explode (`!`), flat `±N`, multi-term (`2d6+1d4-1`). Limits: 100 dice/term, 200 dice/roll, 1000 sides, 200 chars.
- 优势/劣势 is a **client-side** mode, not a server concept: `applyRollMode()` in `dice.html` expands the *first* dice term before POSTing (`1d20+5` + 优势 → `2d20kh1+5`), so the user never types `2d` themselves. Only the first dice term is expanded — damage dice in `1d20+5+3d6` are untouched. The server stays a plain expression evaluator, and the log records exactly what was rolled. Presets save the expanded form so they replay identically.
- `RollDice()` returns `RollResult{Terms[], Total, Crit}`. `Crit` ("success"/"fumble") is set only when exactly one kept d20 decides the result — so `2d20kh1` (advantage) still counts, `2d20` does not.
- Delivery is polling, not push: `GET /api/dice/rolls?room=&since=<id>` returns rows newer than `since` plus `latest_id`. The client resets its cursor when `latest_id < since` (room cleared elsewhere). Client polls every 2s, pauses on `visibilitychange`.
- Rooms (`默认` by default) isolate tables. Presets are per-account — door guests get 403 and the UI hides the save box.
- **Dice activity is deliberately kept out of `action_logs`** — a session produces hundreds of rolls and would drown the admin 操作记录 tab. Only two things are recorded: `dice_room_create` (a roll landing in a room name that has no rows yet — rooms are implicit, so that *is* room creation) and `dice_clear`. Per-roll and per-delete logging was removed on purpose; don't add it back.
- `www/dice.html` has its own JS preview parser that mirrors the Go grammar; **keep `previewExpression()` in sync with `parseExpression()`** or the preview will accept expressions the server rejects. `applyRollMode()` must likewise stay consistent with the Go grammar — every expansion it produces has to be a valid expression.

### Registration notifications (notify.go)

Pushes a Server酱 Turbo message to the admin whenever someone registers.

- Off by default. Set `notify_sendkey` in `config.json` (or `NOTIFY_SENDKEY`) to enable; an empty key is a silent no-op.
- `NotifyRegistration()` does only in-memory checks synchronously — the HTTP POST runs in a goroutine with a 10s timeout, so a dead push provider can never slow down or fail a registration.
- **`/api/register` is public and unauthenticated with no rate limiting**, so anyone who finds the host can spam registrations. Two throttles protect the push quota: 5 min per source IP, 30 s globally. Suppressed registrations are counted and reported in the next notification ("另有 N 次注册被合并"). If you need a durable fix, gate registration behind the door password.
- Server酱 returns HTTP 200 even on business errors — `send()` parses `code`/`data.error` from the body and logs rejections (e.g. exhausted quota) instead of assuming success.

## Frontend Pages

| Page | File | Player | Notes |
|------|------|--------|-------|
| Live | `www/index.html` | flv.js 1.6.2 | Gate password + user login, 5s stream polling |
| VOD | `www/vod.html` | native `<video>` | Direct MP4 via `/videos/` route, no hls.js |
| Cloud | `www/cloud.html` | native `<video>`/`<img>` | Preview modal for images/videos, `?preview=1` on download endpoint |
| Dice | `www/dice.html` | — | D&D dice roller, 2s poll on `/api/dice/rolls?since=`, per-room shared log |
| Admin | `www/admin.html` | — | Separate login, tabbed dashboard, paginated logs |

Shared: `www/css/common.css` (frosted-glass theme), `www/js/utils.js` (`$()`, `escapeHtml()`, `escapeAttr()`, `formatSize()`).

## Key Conventions

- Handlers return JSON via `writeJSON(w, status, map[string]interface{}{...})`.
- Path traversal prevention: `safeResolvePath(base, sub)` in handler.go.
- Cloud download endpoint: `?preview=1` skips `Content-Disposition: attachment` for inline browser rendering.
- All destructive admin operations require `confirm()` dialogs in frontend.
- Token in localStorage as `authToken` (main site) or `adminToken` (admin page). Door tokens are not persisted.
- `interface{}` over `any` is the codebase style — don't modernize unless asked.
