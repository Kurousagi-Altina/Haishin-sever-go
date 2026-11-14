// 跑团桌面：DM 备团工具（第二批）
// 1. 按房间揭示迷雾：迷雾工具「🏠 房间」，点房间里任意一点，沿墙围出的区域揭开（或盖上）
// 2. 触发区域：📌 工具的「触发区域」，玩家棋子走进去时提醒 GM（只给 GM 看），可一键结算陷阱效果
// 3. 遭遇预设：选中怪物「编入遭遇」，团本里按 2024 规则算难度，一键显示 + 掷先攻 + 开战
// 4. 进入场景时：自动换音乐、弹讲义、移到开场镜头
// 5. 随机表：GM 自定义可掷的表，结果写进记录（可暗骰）
// 6. 场景模板：单个场景导出成 zip，在任何房间导入

// ===================== 1. 按房间揭示迷雾 =====================
var fogRoom = { key: '', mask: null, hover: null };

function fogRoomGrid() {
    var p = scene.props, g = gridSize();
    var walls = wallItems();
    if (!walls.length) return null;
    var key = wallsVersion + '|' + g + '|' + (p.mapW || 0) + '|' + (p.mapH || 0);
    if (fogRoom.key === key && fogRoom.mask) return fogRoom;
    var b = null;
    walls.forEach(function(w) {
        wallAbsPts(w).forEach(function(q) {
            if (!b) b = { x0: q[0], y0: q[1], x1: q[0], y1: q[1] };
            else { b.x0 = Math.min(b.x0, q[0]); b.y0 = Math.min(b.y0, q[1]); b.x1 = Math.max(b.x1, q[0]); b.y1 = Math.max(b.y1, q[1]); }
        });
    });
    if (p.mapAsset && p.mapW) { b.x0 = Math.min(b.x0, 0); b.y0 = Math.min(b.y0, 0); b.x1 = Math.max(b.x1, p.mapW); b.y1 = Math.max(b.y1, p.mapH); }
    b.x0 -= g; b.y0 -= g; b.x1 += g; b.y1 += g;
    var res = Math.max(2, g / 6, (b.x1 - b.x0) / 1400, (b.y1 - b.y0) / 1400);
    var W = Math.ceil((b.x1 - b.x0) / res) + 2, H = Math.ceil((b.y1 - b.y0) / res) + 2;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var cx = c.getContext('2d');
    cx.setTransform(1 / res, 0, 0, 1 / res, -b.x0 / res + 1, -b.y0 / res + 1);
    cx.lineWidth = res * 1.6;
    cx.lineCap = 'round'; cx.lineJoin = 'round';
    cx.strokeStyle = '#000';
    walls.forEach(function(w) { // 门、窗、暗门都算房间的边界
        var pts = wallAbsPts(w);
        cx.beginPath();
        pts.forEach(function(q, i) { if (i) cx.lineTo(q[0], q[1]); else cx.moveTo(q[0], q[1]); });
        cx.stroke();
    });
    var d = cx.getImageData(0, 0, W, H).data, mask = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) mask[i] = d[i * 4 + 3] > 40 ? 1 : 0;
    fogRoom = { key: key, mask: mask, W: W, H: H, x0: b.x0 - res, y0: b.y0 - res, res: res, hover: null };
    return fogRoom;
}

// 点 w 所在的房间：{ pts: 世界坐标多边形, cells: 区域 } 或 { err }
function fogRoomRegion(w) {
    var R = fogRoomGrid();
    if (!R) return { err: '这个场景还没有墙：先画墙（或用「🪄 自动」画墙）再按房间揭示' };
    var W = R.W, H = R.H, x = Math.floor((w.x - R.x0) / R.res), y = Math.floor((w.y - R.y0) / R.res);
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return { err: '这里没有被墙围住' };
    var at = y * W + x;
    if (R.mask[at]) return { err: '点在墙上了，往房间里面点一点' };
    var reg = new Uint8Array(W * H), q = new Int32Array(W * H), qh = 0, qt = 0, leak = false;
    reg[at] = 1; q[qt++] = at;
    while (qh < qt) {
        var k = q[qh++], kx = k % W, ky = (k - kx) / W;
        if (kx === 0 || ky === 0 || kx === W - 1 || ky === H - 1) { leak = true; break; }
        var nb = [k - 1, k + 1, k - W, k + W];
        for (var n = 0; n < 4; n++) { var j = nb[n]; if (!reg[j] && !R.mask[j]) { reg[j] = 1; q[qt++] = j; } }
    }
    if (leak) return { err: '这里没有被墙围住（墙有缺口，或者点在房间外面）。可以先用「🚪 找门洞」把门补上' };
    var grown = awDilate(reg, W, H, 1); // 揭到墙线上，不留一道黑边
    var cs = awContours(grown, W, H), best = null, bl = 0;
    cs.forEach(function(c) { var l = awLen(c); if (l > bl) { bl = l; best = c; } });
    if (!best || best.length < 4) return { err: '房间太小了' };
    var pts = awSimplify(best, 0.8).map(function(p) { return [R.x0 + p[0] * R.res, R.y0 + p[1] * R.res]; });
    var f = pts[0], l = pts[pts.length - 1];
    if (pts.length > 3 && Math.abs(f[0] - l[0]) < 0.01 && Math.abs(f[1] - l[1]) < 0.01) pts.pop();
    return { pts: pts, cells: reg };
}

function fogRoomActive() { return me.gm && tool === 'fog' && fogOpts.shape === 'room'; }

function fogRoomHover(w) {
    if (!fogRoomActive()) return;
    var R = fogRoomGrid();
    if (R && fogRoom.hover && fogRoom.hover.cells) { // 还在同一个房间里：不用重算
        var x = Math.floor((w.x - R.x0) / R.res), y = Math.floor((w.y - R.y0) / R.res);
        if (x >= 0 && y >= 0 && x < R.W && y < R.H && fogRoom.hover.cells[y * R.W + x]) return;
    }
    var r = fogRoomRegion(w);
    fogRoom.hover = r.pts ? r : null;
    requestRender();
}

function fogRoomClick(w) {
    var r = fogRoomRegion(w);
    if (r.err) { notice(r.err, true, 5000); return; }
    var o = r.pts[0], cut = fogOpts.mode === 'reveal';
    var f = { id: genId(), kind: 'fog', shape: 'poly', x: r1(o[0]), y: r1(o[1]), z: nextZ(),
        points: r.pts.map(function(p) { return [r1(p[0] - o[0]), r1(p[1] - o[1])]; }) };
    if (cut) f.cut = true;
    createItems([f]);
    notice(cut ? '已揭开这个房间（Ctrl+Z 撤销）' : '已盖上这个房间（Ctrl+Z 撤销）');
}

function drawFogRoomPreview() {
    if (!fogRoomActive() || !fogRoom.hover) return;
    var pts = fogRoom.hover.pts, cut = fogOpts.mode === 'reveal';
    ctx.save();
    ctx.beginPath();
    pts.forEach(function(p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
    ctx.closePath();
    ctx.fillStyle = cut ? 'rgba(129,199,132,0.18)' : 'rgba(0,0,0,0.35)';
    ctx.fill();
    ctx.strokeStyle = cut ? '#81c784' : '#bdbdbd';
    ctx.lineWidth = 2 / view.s;
    ctx.setLineDash([8 / view.s, 5 / view.s]);
    ctx.stroke();
    ctx.restore();
}

// ===================== 2. 触发区域 =====================
var dmNoteMode = 'note'; // 📌 工具：note 放笔记 / trigger 画触发区域

function setNoteMode(m) {
    dmNoteMode = m;
    document.querySelectorAll('[data-notemode]').forEach(function(b) { b.classList.toggle('active', b.dataset.notemode === m); });
    $('noteHint').textContent = m === 'trigger' ? '拖一个矩形画触发区域：玩家的棋子走进去时只提醒 GM' : '单击地图放置编号笔记（只有 GM 看得到）；点已有的笔记可以拖动、编辑';
}

function trigRect(it) {
    var x = it.x || 0, y = it.y || 0, w = it.w || 0, h = it.h || 0;
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    return { x0: x, y0: y, x1: x + w, y1: y + h };
}

function trigHit(it, w) {
    var b = trigRect(it), tol = 7 / view.s;
    var inside = w.x >= b.x0 && w.x <= b.x1 && w.y >= b.y0 && w.y <= b.y1;
    if (selected[it.id] || tool === 'note') return inside; // 选中后 / 📌 工具下点里面也能拖
    var nearX = w.x >= b.x0 - tol && w.x <= b.x1 + tol, nearY = w.y >= b.y0 - tol && w.y <= b.y1 + tol;
    return (nearX && nearY) && (Math.abs(w.x - b.x0) <= tol || Math.abs(w.x - b.x1) <= tol || Math.abs(w.y - b.y0) <= tol || Math.abs(w.y - b.y1) <= tol);
}

function trigDown(w, start) { gesture = { type: 'trig', start: start, a: w, b: w }; }

function trigUp(g) {
    if (!g.start.moved) { notice('按住拖一个矩形来画触发区域'); return; }
    var x0 = Math.min(g.a.x, g.b.x), y0 = Math.min(g.a.y, g.b.y), w = Math.abs(g.b.x - g.a.x), h = Math.abs(g.b.y - g.a.y);
    if (w < 4 || h < 4) return;
    var n = Object.keys(scene.items).filter(function(id) { return scene.items[id].kind === 'trigger'; }).length + 1;
    var it = { id: genId(), kind: 'trigger', x: r1(x0), y: r1(y0), w: r1(w), h: r1(h), z: nextZ(), label: '触发区域 ' + n, once: true, hidden: true };
    createItems([it]);
    selectOnly([it.id]);
    setTimeout(function() { var el = $('selPanel').querySelector('[data-prop=label]'); if (el) { el.focus(); el.select(); } }, 30);
}

function drawTriggers(items) {
    if (!me.gm || $('fogPreview').checked) return;
    items.forEach(function(it) {
        if (it.kind !== 'trigger') return;
        var b = trigRect(it), spent = it.off || (it.once && it.fired);
        ctx.save();
        ctx.fillStyle = spent ? 'rgba(158,158,158,0.08)' : 'rgba(255,112,67,0.10)';
        ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        ctx.strokeStyle = spent ? '#9e9e9e' : '#ff7043';
        ctx.lineWidth = (selected[it.id] ? 3 : 2) / view.s;
        ctx.setLineDash([10 / view.s, 6 / view.s]);
        ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        ctx.restore();
        drawLabel('⚠ ' + (it.label || '触发区域') + (it.off ? '（停用）' : it.once && it.fired ? '（已触发）' : ''), b.x0 + (b.x1 - b.x0) / 2, b.y0, spent ? '#9e9e9e' : '#ff7043');
    });
    if (gesture && gesture.type === 'trig') {
        var g = gesture;
        ctx.save();
        ctx.strokeStyle = '#ff7043';
        ctx.lineWidth = 2 / view.s;
        ctx.setLineDash([10 / view.s, 6 / view.s]);
        ctx.strokeRect(Math.min(g.a.x, g.b.x), Math.min(g.a.y, g.b.y), Math.abs(g.b.x - g.a.x), Math.abs(g.b.y - g.a.y));
        ctx.restore();
    }
}

function trigSelHtml(it) {
    var row = function(label, inner) { return '<div class="prop-row"><label>' + label + '</label>' + inner + '</div>'; };
    return row('名称', '<input class="tt-input" data-prop="label" maxlength="40" value="' + escapeHtml(it.label || '') + '" style="flex:1;">') +
        '<div class="note-field"><label>提醒 GM 的内容</label><textarea class="tt-input" data-prop="text" rows="2" maxlength="1000" placeholder="如：踩到压力板，天花板落下尖刺">' + escapeHtml(it.text || '') + '</textarea></div>' +
        '<div class="note-field"><label>效果（可一键结算）</label><textarea class="tt-input" data-prop="effect" rows="2" maxlength="1000" placeholder="如：DC 13 敏捷豁免，失败受到 2d10 穿刺伤害，成功减半">' + escapeHtml(it.effect || '') + '</textarea></div>' +
        row('', '<label><input type="checkbox" data-prop="once"' + (it.once ? ' checked' : '') + '> 只触发一次</label>' +
            '<label><input type="checkbox" data-prop="off"' + (it.off ? ' checked' : '') + '> 停用</label>') +
        (it.fired ? '<div class="prop-btns"><span class="tt-hint">已经触发过</span><button class="tt-btn small" data-act="trigReset">重新启用</button></div>' : '') +
        '<div class="tt-hint">只有 GM 看得到。玩家控制的棋子（中心点）走进区域时，记录里只给 GM 提示，可以「定位」或「⚡ 结算」效果。拖动可移动。</div>';
}

// 记录里触发提示后面的按钮
function trigLogBtns(e) {
    if (!me.gm || !e.ref || e.ref.indexOf('trig:') !== 0) return '';
    var p = e.ref.split(':'), tr = scene.items[p[1]];
    return ' <button class="tt-btn small" data-trigfocus="' + escapeHtml(p[2]) + '">定位</button>' +
        (tr && (tr.effect || '').trim() ? '<button class="tt-btn small primary" data-trigact="' + escapeHtml(p[1] + ':' + p[2]) + '">⚡ 结算</button>' : '');
}

function dmLogClick(el) {
    if (el.dataset.trigfocus) {
        if (scene.items[el.dataset.trigfocus]) focusToken(el.dataset.trigfocus); else notice('这个棋子不在当前场景', true);
        return;
    }
    var p = el.dataset.trigact.split(':'), tr = scene.items[p[0]];
    if (!tr) { notice('触发区域不在当前场景了', true); return; }
    var a = parseActionText(tr.label || '陷阱', tr.effect || '');
    a.name = tr.label || '陷阱';
    if (!a.kind) a.kind = a.dc ? 'save' : a.attack ? 'attack' : a.damage ? 'auto' : 'effect';
    openActionDialog(a, null);
    act.presetTargets = scene.items[p[1]] ? [p[1]] : [];
}

function onTrigLog(e) {
    if (me.gm && e.ref && e.ref.indexOf('trig:') === 0) notice('⚠ ' + e.text, true, 7000);
}

// ===================== 3. 遭遇预设与难度 =====================
var XP_BY_CR = { '0': 10, '1/8': 25, '1/4': 50, '1/2': 100, '1': 200, '2': 450, '3': 700, '4': 1100, '5': 1800, '6': 2300, '7': 2900, '8': 3900,
    '9': 5000, '10': 5900, '11': 7200, '12': 8400, '13': 10000, '14': 11500, '15': 13000, '16': 15000, '17': 18000, '18': 20000, '19': 22000,
    '20': 25000, '21': 33000, '22': 41000, '23': 50000, '24': 62000, '25': 75000, '26': 90000, '27': 105000, '28': 120000, '29': 135000, '30': 155000 };
// 2024 城主指南：每个角色的经验预算（低 / 中 / 高）
var XP_BUDGET = [null, [50, 75, 100], [100, 150, 200], [150, 225, 400], [250, 375, 500], [500, 750, 1100], [600, 1000, 1400], [750, 1300, 1700],
    [1000, 1700, 2100], [1300, 2000, 2600], [1600, 2300, 3100], [1900, 2900, 4100], [2200, 3700, 4700], [2600, 4200, 5400], [2900, 4900, 6200],
    [3300, 5400, 7800], [3800, 6100, 9800], [4500, 7200, 11700], [5000, 8700, 14200], [5500, 10700, 17200], [6400, 13200, 22000]];

function tokenXP(t) {
    var sh = t.sheet && sheets[t.sheet];
    if (!sh || sh.cr == null || sh.cr === '') return null;
    var cr = String(sh.cr).replace(/\s/g, '').replace(/[（(].*$/, '').replace('⅛', '1/8').replace('¼', '1/4').replace('½', '1/2');
    return XP_BY_CR[cr] != null ? XP_BY_CR[cr] : null;
}

function encNames() {
    var set = {};
    Object.keys(scene.items).forEach(function(id) { var t = scene.items[id]; if (t.kind === 'token' && t.enc) set[t.enc] = true; });
    return Object.keys(set).sort(function(a, b) { return a.localeCompare(b, 'zh', { numeric: true }); });
}
function encMembers(name) { return Object.keys(scene.items).map(function(id) { return scene.items[id]; }).filter(function(t) { return t.kind === 'token' && t.enc === name; }); }

function sheetLevel(sh) { var m = String(sh && sh.level || '').match(/\d+/); var n = m ? parseInt(m[0], 10) : 0; return n >= 1 && n <= 20 ? n : 0; }

// 队伍：场景里玩家控制、关联了角色卡的棋子；没有时用房间里已分配给玩家的人物卡
function partyLevels() {
    var seen = {}, lv = [];
    Object.keys(scene.items).forEach(function(id) {
        var t = scene.items[id], sh = t.kind === 'token' && t.owner && t.sheet && sheets[t.sheet];
        if (sh && sh.kind === 'pc' && !seen[sh.id] && sheetLevel(sh)) { seen[sh.id] = true; lv.push(sheetLevel(sh)); }
    });
    if (!lv.length) Object.keys(sheets).forEach(function(id) { var sh = sheets[id]; if (sh.kind === 'pc' && sh.owner && sheetLevel(sh)) lv.push(sheetLevel(sh)); });
    return lv;
}

function partyBudget() {
    var lv = partyLevels(), b = [0, 0, 0];
    lv.forEach(function(l) { var r = XP_BUDGET[l]; b[0] += r[0]; b[1] += r[1]; b[2] += r[2]; });
    return { levels: lv, low: b[0], mid: b[1], high: b[2] };
}

function encDifficulty(xp, pb) {
    if (!pb.levels.length) return { text: '未知（没有队伍等级）', cls: '' };
    if (xp > pb.high) return { text: '超出高难度', cls: 'deadly' };
    if (xp > pb.mid) return { text: '高', cls: 'high' };
    if (xp > pb.low) return { text: '中', cls: 'mid' };
    return { text: '低', cls: 'low' };
}

function encSelHtml(ids) {
    if (!me.gm) return '';
    var toks = ids.map(function(id) { return scene.items[id]; }).filter(function(t) { return t && t.kind === 'token' && !t.owner; });
    if (!toks.length) return '';
    var same = toks.every(function(t) { return t.enc && t.enc === toks[0].enc; });
    if (same) return '<div class="prop-btns"><span class="tt-hint">遭遇：' + escapeHtml(toks[0].enc) + '</span><button class="tt-btn small" data-act="encClear">移出遭遇</button></div>';
    return '<div class="prop-row"><label>遭遇</label><input class="tt-input" data-encname list="encList" maxlength="30" placeholder="如：守卫室伏击" style="flex:1;">' +
        '<datalist id="encList">' + encNames().map(function(n) { return '<option value="' + escapeHtml(n) + '">'; }).join('') + '</datalist>' +
        '<button class="tt-btn small" data-act="encSet" title="把选中的 GM 棋子编进这个遭遇，在「📌 团本」里一键开战">编入</button></div>';
}

function encStart(name) {
    var mem = encMembers(name);
    if (!mem.length) return;
    var unhide = mem.filter(function(t) { return t.hidden; }).map(function(t) { return { id: t.id, hidden: null }; });
    if (unhide.length) patchItems(unhide);
    var pcs = Object.keys(scene.items).map(function(id) { return scene.items[id]; }).filter(function(t) { return t.kind === 'token' && t.owner && !inInit(t); });
    if (pcs.length) patchItems(pcs.map(function(t) { return { id: t.id, init: 0, initTie: Math.random() }; }));
    var roll = mem.filter(function(t) { return !inInit(t); }).map(function(t) { return t.id; });
    var go = function() { if (!combatState()) startCombatWith('prep'); };
    if (roll.length) op({ op: 'init', action: 'roll', ids: roll }).then(function() { setTimeout(go, 300); });
    else go();
    notice('遭遇「' + name + '」开始：' + mem.length + ' 个单位现身并掷了先攻');
}

function encPaneHtml() {
    var names = encNames(), pb = partyBudget();
    var h = '<div class="side-section"><h5>遭遇</h5>';
    h += '<div class="tt-hint" style="margin-bottom:6px;">' + (pb.levels.length ?
        '队伍 ' + pb.levels.length + ' 人（' + pb.levels.join('、') + ' 级）· 经验预算：低 ' + pb.low + ' / 中 ' + pb.mid + ' / 高 ' + pb.high :
        '队伍等级从场景里玩家棋子关联的人物卡读取（人物卡要填等级）') + '</div>';
    if (!names.length) {
        return h + '<div class="tt-hint">在地图上选中一个或多个怪物，属性面板里「遭遇 → 编入」，就能在这里看难度、一键现身开战。怪物卡要有 CR 才能算经验。</div></div>';
    }
    h += '<ul class="enc-list">' + names.map(function(n) {
        var mem = encMembers(n), xp = 0, unknown = 0, hidden = 0;
        mem.forEach(function(t) { var v = tokenXP(t); if (v == null) unknown++; else xp += v; if (t.hidden) hidden++; });
        var d = encDifficulty(xp, pb);
        return '<li><div class="enc-main"><b>' + escapeHtml(n) + '</b> <span class="enc-diff ' + d.cls + '">' + d.text + '</span>' +
            '<div class="tt-hint">' + mem.length + ' 个单位 · ' + xp + ' XP' + (unknown ? '（' + unknown + ' 个没有 CR）' : '') + (hidden ? ' · ' + hidden + ' 个隐藏中' : '') + '</div></div>' +
            '<span class="ho-btns"><button class="tt-btn small primary" data-encstart="' + escapeHtml(n) + '" title="全部现身、加入先攻并掷先攻；没在战斗时连同玩家一起开战">开战</button>' +
            '<button class="tt-btn small" data-encsel="' + escapeHtml(n) + '">选中</button>' +
            '<button class="tt-btn small" data-enchide="' + escapeHtml(n) + '" title="' + (hidden === mem.length ? '对玩家显示' : '对玩家隐藏') + '">' + (hidden === mem.length ? '👁' : '🙈') + '</button>' +
            '<button class="tt-btn small danger" data-encdel="' + escapeHtml(n) + '" title="解散遭遇（棋子保留）">✕</button></span></li>';
    }).join('') + '</ul></div>';
    return h;
}

// ===================== 5. 随机表 =====================
var tables = [], tbEdit = null;

function onTablesState(list) { tables = list || []; }
function onTablesMsg(m) { tables = m.tables || []; renderNotesPane(); }

function tablePaneHtml() {
    var h = '<div class="side-section"><h5>随机表 <button class="tt-btn small" data-tbnew="1">＋ 新建</button></h5>';
    if (!tables.length) return h + '<div class="tt-hint">随机遭遇、宝藏、NPC 名字、天气……每行一个条目，可以写「1-3 两只哥布林」这样的范围，条目里的 [[2d6]] 会掷出结果。掷出的结果写进记录，可以暗骰。</div></div>';
    h += '<ul class="ho-list">' + tables.map(function(t) {
        var n = t.rows.split('\n').filter(function(l) { return l.trim(); }).length;
        return '<li><div class="ho-main"><div>' + escapeHtml(t.name) + '</div><div class="tt-hint">' + n + ' 条' + (t.dice ? ' · ' + escapeHtml(t.dice) : '') + '</div></div>' +
            '<span class="ho-btns"><button class="tt-btn small primary" data-tbroll="' + t.id + '" title="掷这张表，所有人看得到结果">🎲</button>' +
            '<button class="tt-btn small" data-tbroll="' + t.id + '" data-hide="1" title="暗骰：只有 GM 看得到">暗</button>' +
            '<button class="tt-btn small" data-tbedit="' + t.id + '">编辑</button>' +
            '<button class="tt-btn small danger" data-tbdel="' + t.id + '">✕</button></span></li>';
    }).join('') + '</ul></div>';
    return h;
}

function openTableEditor(t) {
    tbEdit = t ? JSON.parse(JSON.stringify(t)) : { id: '', name: '', dice: '', rows: '' };
    $('tbName').value = tbEdit.name;
    $('tbDice').value = tbEdit.dice || '';
    $('tbRows').value = tbEdit.rows;
    $('tbDialog').style.display = '';
    setTimeout(function() { $('tbName').focus(); }, 30);
}
function closeTableEditor() { $('tbDialog').style.display = 'none'; tbEdit = null; }
function saveTable() {
    if (!tbEdit) return;
    var body = { id: tbEdit.id || genId(), name: $('tbName').value.trim(), dice: $('tbDice').value.trim(), rows: $('tbRows').value };
    if (!body.rows.trim()) { notice('至少写一个条目', true); return; }
    op({ op: 'table', table: body }).then(function(r) { if (r) { notice('已保存随机表'); closeTableEditor(); } });
}

// ===================== 团本侧栏里的遭遇 / 随机表 =====================
function dmPaneHtml() { return me.gm ? encPaneHtml() + tablePaneHtml() : ''; }

function dmPaneClick(e) {
    var el = e.target.closest('[data-encstart],[data-encsel],[data-enchide],[data-encdel],[data-tbnew],[data-tbroll],[data-tbedit],[data-tbdel]');
    if (!el) return false;
    var d = el.dataset;
    if (d.encstart) encStart(d.encstart);
    else if (d.encsel) { var ms = encMembers(d.encsel); if (ms.length) { focusToken(ms[0].id); selectOnly(ms.map(function(t) { return t.id; })); } }
    else if (d.enchide) {
        var mh = encMembers(d.enchide), allHidden = mh.every(function(t) { return t.hidden; });
        patchItems(mh.map(function(t) { return { id: t.id, hidden: allHidden ? null : true }; }));
        notice(allHidden ? '遭遇「' + d.enchide + '」对玩家显示了' : '遭遇「' + d.enchide + '」已对玩家隐藏');
    } else if (d.encdel) {
        var encName = d.encdel;
        ttAsk({ title: '解散遭遇', text: '解散遭遇「' + encName + '」？棋子保留在地图上。', ok: '解散' }).then(function(ok) {
            if (ok) patchItems(encMembers(encName).map(function(t) { return { id: t.id, enc: null }; }));
        });
    } else if (d.tbnew) openTableEditor(null);
    else if (d.tbroll) op({ op: 'table.roll', text: d.tbroll, hidden: !!d.hide });
    else if (d.tbedit) openTableEditor(tables.find(function(t) { return t.id === d.tbedit; }));
    else if (d.tbdel) {
        var tb = tables.find(function(t) { return t.id === d.tbdel; });
        if (tb) ttAsk({ title: '删除随机表', text: '删除随机表「' + tb.name + '」？', ok: '删除', danger: true }).then(function(ok) { if (ok) op({ op: 'table.delete', ids: [tb.id] }); });
    }
    notesDirty();
    return true;
}

// 属性面板按钮：遭遇 / 触发区域
function dmSelAct(act, ids) {
    if (act === 'encSet') {
        var name = (($('selPanel').querySelector('[data-encname]') || {}).value || '').trim().slice(0, 30);
        if (!name) { notice('先填遭遇的名字', true); return true; }
        var toks = ids.filter(function(id) { var t = scene.items[id]; return t && t.kind === 'token' && !t.owner; });
        patchItems(toks.map(function(id) { return { id: id, enc: name }; }));
        notice('已把 ' + toks.length + ' 个单位编入遭遇「' + name + '」');
    } else if (act === 'encClear') {
        patchItems(ids.filter(function(id) { return scene.items[id] && scene.items[id].enc; }).map(function(id) { return { id: id, enc: null }; }));
    } else if (act === 'trigReset') {
        patchItems([{ id: ids[0], fired: null }]);
    } else return false;
    $('selPanel').dataset.ids = '';
    renderSelPanel();
    notesDirty();
    return true;
}

// ===================== 4. 进入场景时 =====================
function startView() {
    var c = scene.props.cam;
    if (!c || !(c.w > 0) || !canvas || canvas.clientWidth < 10) { fitView(); return; }
    view.s = Math.min(8, Math.max(0.05, canvas.clientWidth / c.w));
    view.x = canvas.clientWidth / 2 - c.x * view.s;
    view.y = canvas.clientHeight / 2 - c.y * view.s;
    requestRender();
}

function renderSceneEnter() {
    var box = $('sceneEnterBox');
    if (!box || !me.gm) return;
    if (box.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
    var cfg = scene.props.onEnter || {}, m = cfg.music;
    var tracks = (room.assets || []).filter(function(a) { return a.kind === 'audio'; });
    var mv = !m ? '' : m === 'stop' ? 'stop' : m.asset || '';
    var hv = cfg.handout || '';
    box.innerHTML = '<h5>进入这个场景时</h5>' +
        '<div class="set-row"><label>音乐</label><select class="tt-select" data-se="music"><option value="">不变</option><option value="stop"' + (mv === 'stop' ? ' selected' : '') + '>停止音乐</option>' +
        tracks.map(function(a) { return '<option value="' + escapeHtml(a.id) + '"' + (mv === a.id ? ' selected' : '') + '>播放：' + escapeHtml(a.name) + '</option>'; }).join('') + '</select></div>' +
        '<div class="set-row"><label>弹出讲义</label><select class="tt-select" data-se="handout"><option value="">不弹</option>' +
        handouts.map(function(h) { return '<option value="' + escapeHtml(h.id) + '"' + (hv === h.id ? ' selected' : '') + '>' + escapeHtml(h.title) + '（' + escapeHtml(hoToText(h)) + '）</option>'; }).join('') + '</select></div>' +
        '<div class="set-row"><label>开场镜头</label><button class="tt-btn small" data-se="cam">用我现在的视角</button>' +
        (scene.props.cam ? '<button class="tt-btn small" data-se="camclear">清除</button><span class="tt-hint">已设置</span>' : '<span class="tt-hint">未设置（自动适配地图）</span>') + '</div>' +
        '<div class="tt-hint">GM 切换到这个场景时自动生效（所有人的镜头都移到开场镜头）。黑暗环境、动态视野本来就是每个场景各自的设置。</div>';
}

function onSceneEnterInput(e) {
    var el = e.target.closest('[data-se]');
    if (!el) return;
    var k = el.dataset.se, cfg = JSON.parse(JSON.stringify(scene.props.onEnter || {}));
    if (k === 'cam' || k === 'camclear') {
        if (e.type !== 'click') return;
        var cam = null;
        if (k === 'cam') { var c = toWorld(canvas.clientWidth / 2, canvas.clientHeight / 2); cam = { x: r1(c.x), y: r1(c.y), w: r1(canvas.clientWidth / view.s) }; }
        op({ op: 'props', props: { cam: cam } });
        notice(cam ? '已把现在的视角设为开场镜头' : '已清除开场镜头');
        return;
    }
    if (e.type !== 'change') return;
    if (k === 'music') {
        if (!el.value) delete cfg.music;
        else if (el.value === 'stop') cfg.music = 'stop';
        else { var a = (room.assets || []).find(function(x) { return x.id === el.value; }); cfg.music = { asset: el.value, name: a ? a.name : '', loop: true }; }
    } else if (k === 'handout') {
        if (el.value) cfg.handout = el.value; else delete cfg.handout;
    }
    op({ op: 'props', props: { onEnter: Object.keys(cfg).length ? cfg : null } });
}

// ===================== 6. 场景模板 =====================
function exportScene(id) {
    window.location.href = '/api/tabletop/export?room=' + enc(roomId) + '&scene=' + enc(id) + '&token=' + enc(authToken);
}

function importSceneFile(input) {
    var f = input.files && input.files[0];
    input.value = '';
    if (!f) return;
    var fd = new FormData();
    fd.append('file', f);
    notice('正在导入场景…');
    api('/api/tabletop/import?room=' + enc(roomId), 'POST', fd).then(function(d) {
        if (d && d.scene) notice('已导入场景，在列表里点「切换」即可使用');
        else if (d && d.id) notice('这是整个房间的备份，已经导入成了一个新房间（在房间列表里）', true, 6000);
    }).catch(apiError);
}

function initDm() {
    $('tbCancel').addEventListener('click', closeTableEditor);
    $('tbSave').addEventListener('click', saveTable);
    $('sceneEnterBox').addEventListener('change', onSceneEnterInput);
    $('sceneEnterBox').addEventListener('click', onSceneEnterInput);
    $('optsNote').addEventListener('click', function(e) { var b = e.target.closest('[data-notemode]'); if (b) setNoteMode(b.dataset.notemode); });
    window.addEventListener('keydown', function(e) { if (e.key === 'Escape' && $('tbDialog').style.display !== 'none') closeTableEditor(); });
    setNoteMode('note');
}
