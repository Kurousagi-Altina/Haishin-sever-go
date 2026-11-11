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

### Tabletop (tabletop.go + tabletop_dice.go)

- Rooms live in memory, saved every 2s (dirty flag) to `TabletopDir/rooms/<id>.json`; images in `TabletopDir/assets/` named by sha256 (`ttAssetRe`).
- Sync: `GET /api/tabletop/events` (SSE, `?token=` auth) pushes a full `state` snapshot on connect, then deltas (`items`/`del`/`props`/`room`/`log`/`users`/`fx`). Clients send `POST /api/tabletop/op` with `{op, ...}`; all permission checks are in `TTRoom.apply`.
- GM = room owner or admin. Players may create `token`/`draw` items (owner forced to them), fully edit their own items, and only move (x/y, numbers only) unlocked tokens. Visibility is per player: `ttConcealed` (GM-`hidden`, or an unowned token with the 躲藏 `hidden` status) items are never sent to non-GMs (sent as `del`) except to the token's owner (`ttHiddenFrom`; `sceneView` / `broadcastItems` work per subscriber name). Hidden rolls are masked by `logEntryFor`. `HandleOp` runs `apply` with a deferred unlock + recover, so a panicking op can't leave the room locked.
- Door users have no identity: they join with a nickname, shown as `访客·<nick>`, and cannot create/import rooms.
- Items and scene props are free-form `map[string]interface{}` — the client defines the shape; the server only reads `id/kind/hidden/locked/owner/asset`.
- Dice are rolled server-side (`RollTabletopDice`): `NdM`, `d%`, `kh/kl/dh/dl/k`, `!`, reroll-once `r<=n` (also `<`, `>`, `>=`, `=`), per-die `mi n` / `ma n` clamps, `+/-` constants.
- Walls are items with `kind:"wall"` (`wtype` wall/window/door, `open`); GM-only to create. Players may only toggle `open` on unlocked doors. Line-of-sight / dynamic vision and move-blocking are computed client-side (`computeVision` in tabletop.js) — walls are sent to everyone.
- Sheets (`room.Sheets`, op `sheet` / `sheet.delete`) are free-form maps with `kind` pc/monster/item. Players may only create `pc` sheets (owner forced) and edit their own; non-GMs see pc, `shared`, or own sheets (`sheetVisible`). Tokens link via `item["sheet"]`.
- charsheet.go parses the "DND 5E2024 人物卡" .xlsx (sheet 主要, fixed cell layout, cached values) with archive/zip + encoding/xml. The embedded `obr-suite-card` JSON cell is often stale — don't rely on it.
- owlbear.go imports Owlbear Rodeo 2 exports (.ob2 = zip with manifest.json + assets/scenes/docs/*.json; `isOB2` in HandleImport). Scene units are used as-is (gridSize = scene grid dpi) and everything is shifted so the MAP image sits at (0,0). Image items: top-left = position − grid.offset × sceneDpi/itemDpi × scale. Linked images are downloaded at import time from an allowlist only (`ob2ImageHosts`). Tokens bound to character cards keep `pcName`; `linkPCTokens` attaches a later-imported PC sheet with the same name (`ttNameKey`). fivetools.go converts the bestiary extension's 5etools monsters (`{@tag}` markup → text that `rollify` turns into roll buttons).
- Combat (tabletop_combat.go + www/js/tabletop-combat.js): token fields `init`/`initMod`/`initRolled`/`initTie` (presence of `init` = in the tracker), scene prop `combat` = `{round, turn}`. Ops `init` (action `roll`: server rolls d20 + bonus, falls back to the sheet's `init`) and `combat` (start/next/prev/end; players may only `next` on their own turn). Rolls may carry `target` (token id) + `cover` (2/5): `resolveAttack` compares the kept d20 / total with the token's `ac` and logs `target`/`hit`/`cover` — the AC itself stays server-side because `ttPlayerItem` strips `ac` from tokens without an owner in everything sent to players. Distances, reach, cover and area hits use each creature's hit circle (`hitR` in ft, else a size-based default from `defaultHitFt`: medium 1 ft radius, larger sizes scale with their cells — large 2, huge 3, gargantuan 4; resizing a token image never changes it: `pinTokenCells` writes the current size into `fp` first) — distance = centre distance under the measure rule (scene prop `measure`, default `euclidean` = actual length, grid only a reference; `alternating` 5-10-5 / `chebyshev` count cells via `gridSteps`) minus both radii; `fp` (size in cells) only drives snapping and the default radius. Token drops go through `dropSpot`: per-user snap mode (`ttSnap` in localStorage: free / quarter / half / cell); tokens are never nudged. Movement: a drag records `gesture.trail` and its length is the move distance (`moveDistFt`); during combat the acting token's moves (drag / arrow keys) accumulate into `moved` + `movedKey` (`round:turn`, so it resets each turn; `movedPatch`, only when the client can edit the token), compared with `tokenSpeed` (token `speed`, else the sheet). Followers: token `follow` = leader id; `moveFollowers` (server, items op) shifts followers by the leader's delta.
- Actions (tabletop_action.go + www/js/tabletop-action.js): op `action` with `act` = {name, kind attack|save|auto|heal|temp|effect, attack, damage, damageType, save, dc, half, status, caster, concentration, targets:[{id, cover, mode, autoCrit}]}. The server rolls everything per target, reads save bonuses / 抗性·免疫·易伤 from the linked sheet, mutates token `hp`/`hpTemp`/`status` and logs kind `action` with `act` results. The client parses actions from Chinese rules text (`parseActionText`), draws range circles / area templates and picks targets; areas and cover are client-side.
- Player view (`ttPlayerItem(it, hpStep)`): GM-controlled tokens (no owner) lose `ac`, and their HP is replaced by a percentage rounded up to the scene's `hpStep` (default 25, 0 = exact; `hpPct: true`, `hpMax: 100`) unless `bossExact`. Scene props go out through `propsFor(gm)`: players never get the combat sort `key`, and `combat.turn` is `"?"` while the acting token is hidden / initHidden (`broadcastProps`; `broadcastItems` re-sends props when the acting token changes). `combat.key` lets next/prev continue after the acting token leaves the tracker. Timed statuses tick at the END of the affected token's turn. `resolveAttack` gives no verdict unless exactly one kept d20 (no AC probing with flat rolls). Unowned tokens also lose `forms` / `obr` for players (they carry exact HP / AC).
- Room settings (`room.Settings`, op `room.settings`, GM-only, keys in `ttSettingKeys`): player permissions `playerTokens`/`playerDraw`/`playerMoveOthers`/`playerDoors` (absent = allowed, enforced in `apply` / `ttCanEdit`), `timeStop` (players' items/delete/action/portal/combat ops are refused), `music` ({asset, name, playing, loop, at}; audio assets are kind `audio`, stored by `storeAudio`). Door guests' nicknames are bound to their door token (`guestUser`), so they can't impersonate each other. Player-imported PC sheets link same-name tokens but only a GM import assigns `owner`.
- Map extras (www/js/tabletop-extra.js): hex grids (`gridType` hexRows / hexCols, g = centre distance), ruler waypoints (fx `ruler` carries `p`), text items (`kind:"draw", shape:"text"`), secret doors (`wtype:"secret"` — `ttPlayerItem` sends them to players as a plain wall, or an open locked door once opened), darkness (`dark` scene prop + token `light {bright, dim}` ft; `cutDarkness`), portals (token `portal {tag, r}`, op `portal` moves the token and followers server-side), transform (`forms` stack on the token), short rest (an `action` heal), banners / time stop / music UI.
- 0 HP: `dropToZero` (actions) / `zeroHpStatus` (client, manual HP edits) — a PC (owned or pc sheet) going from >0 to 0 gets 昏迷 `unconscious` (dead outright if the leftover damage ≥ hpMax), anything else gets 💀 `dead`; concentration ends. Combat next/prev skip tokens with `dead`. `ttAddStatus` always allows dead/stable/unconscious past the 12-status cap. Action `caster` must be the player's own token (403 otherwise); its label goes out as `act.caster` unless concealed.
- Spells (tabletop-action.js): `parseScaling` reads 升环 (`upcast {from, dice, extra}`) and 戏法强化 tiers; `applySpellScaling` picks the cantrip dice by sheet `level`, `applySlotLevel` re-derives damage (`addDice` merges same-size dice) / targets from `baseDamage` / `baseTargets`; `consumeSlot` spends a sheet slot (`slotOf`). Parsing notes for real 2024 不全书 text (checked against the live server — 不全书 is unreachable from the dev machine while its VPN is on): the duration comes from the text's `持续时间：` line (2024 meta is just "二环 塑能（德鲁伊）"); the area is the earliest-occurring area phrase (妖火's 20尺立方 beats its 10尺半径 light); squares include 见方 / 方格 / 方状 (obr-suite card text); walls accept 不过 / 最多 qualifiers and panels (`十个10尺×10尺`) win over a stray 长X尺; a status mention right after 免疫 / 无法受益于 / 结束 / 解除 etc. is ignored and the earliest remaining one wins; 暗蚀 (2024) = 黯蚀 (`ttHasDamageType` on the server). Lasting area spells become zones: a `draw` item (shape circle / poly, fill) with `zone {act, caster, conc}`, `follow` = caster for self-centred auras; `hitItem` only hits a zone's border; `zoneRetrigger` re-resolves on creatures inside; `cleanupZones` (GM or zone owner's client) deletes a zone once its caster stops concentrating.
- Custom areas: area shapes `wall` (two clicks, ≤ size), `path` (free polyline, total ≤ size) and `ring` (diameter `size`, thickness `width`) plus non-self `line` are placed point by point (`isPathShape`, `actionMode.pts`, `clampNext` / `clampPath` / `pathLen`, `undoPathPoint`, `redrawArea`); `actionShape` returns `{type:'path', pts, w}` / `{type:'ring', x, y, r, w}` and `tokenInShape` handles both. The action bar adjusts size / width live (`adjustArea`). Nothing resolves until the player confirms; `placeZoneOnly` casts (slot + concentration via an `effect` action with no targets) and leaves the zone. Moving a zone prompts a re-resolve (`zoneRetrigger(z, true)`). Rules are 2024-only: `SPELL_SOURCES` has no 2014 PHB and lookup results drop `is2014Core` paths.
- Action undo: `applyAction` snapshots hp/hpTemp/status/ds of every touched token (`ttSnapHP`) into the in-memory `room.actUndo` (last 30); GM op `action.undo` (`text` = log id) restores them. Manual HP edits through the `items` op are logged by `logHPChanges` (coarse for GM tokens; entries for concealed tokens are `GMOnly` + `For` = owner). Combat start/next/prev/set store `turnStart {x, y, k: "round:id"}` on the acting token; the client draws it until the turn changes (`drawTurnStart`).
- Zone bookkeeping: `zone.act.oncePerTurn` (parsed from 「一回合只……一次」, editable in the dialog / zone panel) and `zone.hits = {k: turnKey(), ids: {id: count}}` written by `recordZoneHits` after each resolve (first cast via `createZone(..., hitIds)`); `zoneRetrigger` skips this turn's hits when once-per-turn, and manual picks are refused. A selected zone is hit anywhere inside (`selectedZoneAt` wins over tokens under it) so it can be dragged from its middle. The server stores the spell name on the concentration status (`spell`); starting a new concentration spell deletes the caster's older concentration zones (`endOldConcZones`).
- Floating UI (tabletop-extra.js): `renderStatusBar` (top-right; player = own tokens, GM = selection or the acting token; HP, buff/debuff chips, concentration spell + zone links), `makeFloat(el, key, opts)` makes `#logWin` (the log + chat, moved out of the sidebar) and `#combatHud` draggable via `[data-drag]` handles with event delegation; position / size / collapsed state live in localStorage `ttFloat:<key>`, double-click the handle to reset. The initiative strip has a portrait mode (token images, default) and a simple mode (`ttInitView`).
- One "hand" tool (`select`): left drag on empty map pans (Shift = marquee), right drag = pointer trail (gesture `rpointer`), right tap = ping or the token quick menu (`openTokenMenu` in tabletop-extra.js; touch long-press does the same). `pan` / `pointer` tool names map to `select`.
- Death saves: op `death` (GM or token owner, token at 0 HP) rolls 1d20 and keeps `item.ds = {s, f}`; 3 successes → status `stable`, 3 failures → `dead`; damage at 0 HP (`ttDamageAtZero`) adds failures, healing clears them. Undo/redo, copy/paste and long rest are client-side (patchItems / createItems / deleteItems record snapshots; patches and gestures snapshot only the touched keys via `__keys`, so undo never reverts someone else's concurrent change). Client-side UI mirrors the room settings (`canMove` checks playerMoveOthers / timeStop, doors check playerDoors, the D key checks playerDraw); `seeable` keeps players from hitting / selecting / searching tokens they can't see. Movement over speed is only a hint; walls are checked along the dragged path (`pathBlocked`).
- Initiative visibility: `ttInitHidden` (token `initHidden`, or an unowned token with the 躲藏 `hidden` status) makes `ttPlayerItem` strip all `init*` fields for players, so hidden combatants never reach player clients. Combat ops also accept `set` (GM: jump to `ids[0]`'s turn) and `round` (GM: set `round`). GM-only local prefs `ttPlaceHidden` / `ttInitHidden` (localStorage) default sheet-placed tokens to hidden / new combatants to initHidden.
- Status effects (www/js/tabletop-status.js): `item["status"] = [{id, name, color, icon, rounds?, lv?}]`; ids from `STATUS_DEFS` drive the attack-roll automation (`statusAttackMods`). The server counts `rounds` down in `tickStatus` when the token's turn ends (combat next) and removes expired ones. Rolls may send `autoCrit` (paralysed / unconscious target within 5 ft) to turn a hit into a crit. Boss bars use token `boss` / `bossExact`. The same file holds the Ctrl+K global search.
- cardjson.go converts obr-suite character cards (`data.json`, schema 0.3) to pc sheets — used by the 角色 pane upload and by the .ob2 import, which downloads cards from `obr.dnd.center/characters/<room>/<card>/data.json` (newest upload per character name wins) and links tokens via `boundCardId` → `item["cardId"]`. Unknown small Owlbear item metadata is kept in `item["obr"]`.
- kiwee.go — monster quick-deploy from 5e.kiwee.top (the Chinese 5etools the Owlbear bestiary extension uses; fixed host, `kiweeClient` refuses redirects elsewhere). `GET /api/tabletop/5e/bestiary?q=` searches an in-memory index (XMM loads first, other books in a background goroutine; `kiweeSkip` drops MM/PHB/DMG 2014 and VGM/MTF; duplicates by English name keep the best `kiweeRank`). `POST /api/tabletop/5e/deploy?room=` (GM only) converts with `convert5etoolsMonster`, downloads the token (`img/bestiary/tokens/<src>/<en>.webp`, or the monster's `token` override) and portrait (fluff file, following `_copy` / `_mod.images` via `kiweeArtFind`) into assets registered in the room, and returns the sheet (`tokenImg`, `portrait` asset ids) — the client creates it and calls `placeSheetToken`, which uses `tokenImg` as the token image. Data files are cached in `<tabletop_dir>/kiwee/` for 7 days.
- Judgement modifiers (tabletop_traits.go): `room.traitsOf(token)` merges (1) the sheet's manual `mods` list (`{t: evasion|save|saveAdv|resist|immune|vuln|condImmune|ac, ab, v, vs, dt, id, name}`), (2) traits recognised by NAME in the sheet's features / section entries (`ttAutoTraits`: 反射闪避 Evasion, 魔法抗性, 危机感应, 侏儒狡黠, 矮人体魄, 妖精血统, 勇气 (exact), 守护灵光 (+CHA), 勇气灵光, 传奇抗性 → a note only), skipped when listed in the sheet's `modsOff`, plus prop rows (免疫 → condition immunities, obr card 优势 → save advantage), and (3) conditions (raging, petrified). `applyAction` uses it for save bonus / advantage (`act.spell` from the client's `a.isSpell` gates "vs spell"), Evasion (Dex + half only), extra AC, `damageMod` on top of `damageFactor`, and condition immunity (status not applied). Every applied modifier is written into the target's `note`. The client mirrors the name table as `AUTO_TRAITS` in tabletop-sheets.js for the sheet's 判定修正 section — keep them in sync. Magic Resistance / Gnomish Cunning read the trait TEXT via `ttAdvScope` (abilities named next to 豁免, `school:<学派>`, condition names, 魔法 → `magic` = spells + magical effects, 法术 → `spell`). Manual resist / immune entries may carry `nm` (non-magical attacks only).
- Damage parts & magic: `act.parts = [{dice, type}]` (≤ 4) are rolled per target for attacks (doubled on a crit) or shared for save / auto, scaled by the same save / Evasion factor, and each part goes through `damageFactor(it, type, magic)` + `damageMod` separately. `act.magic` (spells always) makes 「非魔法攻击…」 resistances not apply (note 魔法攻击，无视非魔法…); 「除X、Y外的所有伤害」 resists every unlisted type. `parseDamageParts` (tabletop-action.js) extracts extra typed damage from rules text (skips the main type and 「或 / 改为」 alternatives); `TTActionHit` records `id`, `parts`, `phys` (any 钝穿挥 part dealt damage) and `cover`.
- Reactions (op `action.react`, `reactAction` in tabletop_traits.go): `text` = action log id, `target` = token id, `mode` deflect (拨挡攻击 / 拨挡飞弹: needs `phys`, reduces the whole attack's damage by 1d10 + Dex + monk level from `class` 「武僧 N」 or `level`) / uncanny (直觉闪避: half) / shield (盾牌术 in `spells`: re-checks the stored attack total vs AC + 5 + `cover`, nat 20 can't be blocked; a miss also removes the status the hit applied). GM or the token's owner only; the damage avoided is given back as HP, a new `action` log entry (kind `react`) carries `ref` = `<log id>:<token id>` (one reaction per target per attack; the client removes the buttons when it sees the ref) and is undoable. Buttons come from `reactButtons` in tabletop-action.js; the client spends the Shield slot.
- Auto walls (www/js/tabletop-autowall.js, wall tool mode `auto`): client-only image processing on the map asset (same-origin, so `getImageData` works), downscaled to ≤ 1024 px. Line mode: luminance < Otsu threshold → opening (drop thin grid lines) → closing → large dark blobs become `solid` and contribute only their outline (marching squares), the rest is Zhang-Suen thinned and traced into polylines. Floor mode: box-blur by ~5% of a cell, grow from the clicked seed while neighbouring pixels differ ≤ tol/5 and stay ≤ 3·tol from the seed, fill small holes, then marching squares. Segments on the box edge are dropped; RDP simplification; preview in `drawAutoWall`, `autoWallCommit` creates plain `wall` items in one `createItems` batch.
- bestiary.go proxies DND5e 不全书 (fixed hosts only: page paths must be `topics/…htm(l)`); HTML is parsed in www/js/tabletop-sheets.js (2024 `.stat-block`, 2014 text split on 护甲等级, items split on H6 / red `<font>` headings).
### Dice module (dice.go / dice_db.go / dice_handler.go)

D&D-style dice roller; every roll is persisted and visible to everyone in the same room.

- Grammar: `NdM` with keep/drop (`kh`/`kl`/`dh`/`dl`), explode (`!`), flat `±N`, multi-term (`2d6+1d4-1`). Limits: 100 dice/term, 200 dice/roll, 1000 sides, 200 chars.
- 优势/劣势 is a **client-side** mode, not a server concept: `applyRollMode()` in `dice.html` expands the *first* dice term before POSTing (`1d20+5` + 优势 → `2d20kh1+5`), so the user never types `2d` themselves. Only the first dice term is expanded — damage dice in `1d20+5+3d6` are untouched. The server stays a plain expression evaluator, and the log records exactly what was rolled. Presets save the expanded form so they replay identically.
- `RollDice()` returns `RollResult{Terms[], Total, Crit}`. `Crit` ("success"/"fumble") is set only when exactly one kept d20 decides the result — so `2d20kh1` (advantage) still counts, `2d20` does not.
- Delivery is polling, not push: `GET /api/dice/rolls?room=&since=<id>` returns rows newer than `since` plus `latest_id`. The client resets its cursor when `latest_id < since` (room cleared elsewhere). Client polls every 2s, pauses on `visibilitychange`.
- Rooms (`默认` by default) isolate tables. Switching is **explicit** — typing a name in the top bar only highlights the 进入 button; nothing moves until it's clicked (or Enter). There's deliberately no on-blur auto-switch, and `doRoll()` refuses to roll while the input holds an uncommitted name, so a stray keystroke can't silently send rolls to the wrong room. Presets are per-account — door guests get 403 and the UI hides the save box.
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
| Tabletop | `www/tabletop.html` + `js/tabletop.js` + `js/tabletop-sheets.js` + `js/tabletop-combat.js` + `js/tabletop-status.js` + `js/tabletop-action.js` + `js/tabletop-extra.js` + `js/tabletop-autowall.js` + `css/tabletop.css` | `<canvas>` | Virtual tabletop (maps, tokens, fog, walls/vision, sheets, dice, initiative/targeting), live via SSE. Bump the `?v=` query on the CSS/JS links when changing them |

Shared: `www/css/common.css` (frosted-glass theme), `www/js/utils.js` (`$()`, `escapeHtml()`, `escapeAttr()`, `formatSize()`).

## Key Conventions

- Handlers return JSON via `writeJSON(w, status, map[string]interface{}{...})`.
- Path traversal prevention: `safeResolvePath(base, sub)` in handler.go.
- Cloud download endpoint: `?preview=1` skips `Content-Disposition: attachment` for inline browser rendering.
- All destructive admin operations require `confirm()` dialogs in frontend.
- Token in localStorage as `authToken` (main site) or `adminToken` (admin page). Door tokens are not persisted.
- `interface{}` over `any` is the codebase style — don't modernize unless asked.
