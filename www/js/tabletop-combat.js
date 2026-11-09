// 跑团桌面：战斗
// - 生物体型与占格：棋子图片可以比占格大或小，距离、吸附、触及都按占格算
// - 测距规则：斜向 5-10-5 交替 / 斜向 = 1 格 / 直线距离，尺子和拖动棋子时显示经过的格子
// - 先攻与回合（兼容 Owlbear 先攻插件导出的数据）
// - 目标：距离、触及 / 射程、掩护（墙体按 DMG 角对角规则，生物提供半身掩护），攻击检定由服务器对目标 AC 结算
// - 棋子资源（兼容 obr-suite 资源追踪：法术位、职业资源等）
// 依赖 tabletop.js / tabletop-sheets.js 的全局状态与函数

var STD_CELLS = [0.5, 1, 2, 3, 4];
var SIZE_OPTS = [['', '按图片'], ['0.5', '微型'], ['1', '小型 / 中型'], ['2', '大型'], ['3', '巨型'], ['4', '超巨型']];
var target = { id: '' };      // 本机选中的攻击目标
var coverCache = { key: '', info: null };
var lastTurn = null;

// ===== 体型 / 占格 =====
function sheetSizeCells(sh) {
    var text = (sh.size || '') + ' ' + (sh.meta || '');
    for (var i = 0; i < SIZE_CELLS.length; i++) if (text.indexOf(SIZE_CELLS[i][0]) >= 0) return SIZE_CELLS[i][1];
    return 0;
}

// 占格边长（格）：棋子设置 > 关联角色卡的体型 > 按图片尺寸取最接近的标准体型
function tokenCells(it) {
    var fp = num(it.fp, 0);
    if (fp > 0) return fp;
    var sh = it.sheet && sheets[it.sheet];
    var c = sh ? sheetSizeCells(sh) : 0;
    if (c) return c;
    var g = gridSize(), m = Math.min(it.w || g, it.h || g) / g, best = 1, bd = Infinity;
    STD_CELLS.forEach(function(s) {
        var d = Math.abs(Math.log(m / s));
        if (d < bd) { bd = d; best = s; }
    });
    return best;
}

function tokenCenter(it) {
    var g = gridSize();
    return { x: (it.x || 0) + (it.w || g) / 2, y: (it.y || 0) + (it.h || g) / 2 };
}

// 占据的格子：ix0/iy0 起始格，n 每边格数（微型生物按 1 格算距离），x0/y0/size 为世界坐标方框
function footprint(it, center) {
    var g = gridSize(), p = scene.props, ox = num(p.gridOffX, 0), oy = num(p.gridOffY, 0);
    var c = center || tokenCenter(it), cells = tokenCells(it);
    var n = Math.max(1, Math.round(cells));
    var ix0 = cells < 1 ? Math.floor((c.x - ox) / g) : Math.round((c.x - ox) / g - cells / 2);
    var iy0 = cells < 1 ? Math.floor((c.y - oy) / g) : Math.round((c.y - oy) / g - cells / 2);
    var size = cells < 1 ? g * cells : n * g;
    return { ix0: ix0, iy0: iy0, n: n, cells: cells, x0: cells < 1 ? c.x - size / 2 : ox + ix0 * g, y0: cells < 1 ? c.y - size / 2 : oy + iy0 * g, size: size };
}

// 松手时让占格对齐网格（图片相对占格居中）；微型生物按半格对齐
function snapTokenPos(it, x, y) {
    var g = gridSize(), w = it.w || g, h = it.h || g, cells = tokenCells(it);
    var cx = x + w / 2, cy = y + h / 2, c;
    if (cells < 1) {
        var half = g / 2;
        c = snapToGrid(cx - half / 2, cy - half / 2, half);
        cx = c.x + half / 2; cy = c.y + half / 2;
    } else {
        var F = cells * g;
        c = snapToGrid(cx - F / 2, cy - F / 2);
        cx = c.x + F / 2; cy = c.y + F / 2;
    }
    return { x: cx - w / 2, y: cy - h / 2 };
}

// 体型变化时把图片缩放到占格大小（保持比例）
function fitTokenToCells(it, cells) {
    var g = gridSize(), ratio = (it.h || g) / (it.w || g);
    var w = ratio > 1 ? cells * g / ratio : cells * g;
    var c = tokenCenter(it);
    return { w: w, h: w * ratio, x: c.x - w / 2, y: c.y - w * ratio / 2 };
}

// ===== 测距 =====
function measureRule() { return scene.props.measure || 'alternating'; }

// dx / dy 为格数，返回走过的格数（5-10-5 规则下第 2、4… 个斜步多算 1 格）
function gridSteps(dx, dy) {
    dx = Math.abs(dx); dy = Math.abs(dy);
    var m = measureRule();
    if (m === 'euclidean') return Math.sqrt(dx * dx + dy * dy);
    if (m === 'chebyshev') return Math.max(dx, dy);
    return Math.max(dx, dy) + Math.floor(Math.min(dx, dy) / 2);
}

function stepsToUnits(steps) { return steps * num(scene.props.gridScale, 5); }
function unitName() { return scene.props.gridUnit || 'ft'; }

// 生物之间的距离：两块占格之间最近的格子
function creatureDist(a, b, aCenter, bCenter) {
    var fa = footprint(a, aCenter), fb = footprint(b, bCenter);
    var dx = Math.max(0, fb.ix0 - (fa.ix0 + fa.n - 1), fa.ix0 - (fb.ix0 + fb.n - 1));
    var dy = Math.max(0, fb.iy0 - (fa.iy0 + fa.n - 1), fa.iy0 - (fb.iy0 + fb.n - 1));
    return stepsToUnits(gridSteps(dx, dy));
}

// 从格子 a 走到格子 b 经过的格子（先走斜线再走直线，与计数方式一致）
function gridPath(ax, ay, bx, by) {
    var cells = [], x = ax, y = ay, sx = Math.sign(bx - ax), sy = Math.sign(by - ay);
    var diag = Math.min(Math.abs(bx - ax), Math.abs(by - ay)), total = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    for (var i = 0; i < total && cells.length < 400; i++) {
        if (i < diag) { x += sx; y += sy; } else if (Math.abs(bx - x) > 0) x += sx; else y += sy;
        cells.push([x, y]);
    }
    return cells;
}

function cellIndex(wx, wy) {
    var g = gridSize(), p = scene.props;
    return [Math.floor((wx - num(p.gridOffX, 0)) / g), Math.floor((wy - num(p.gridOffY, 0)) / g)];
}

// 高亮路径上的格子（一块 n×n 的占格沿路径移动）
function drawPathCells(cells, n, color) {
    var g = gridSize(), p = scene.props, ox = num(p.gridOffX, 0), oy = num(p.gridOffY, 0);
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.18;
    cells.forEach(function(c) { ctx.fillRect(ox + c[0] * g, oy + c[1] * g, g * n, g * n); });
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1 / view.s;
    cells.forEach(function(c) { ctx.strokeRect(ox + c[0] * g + 1 / view.s, oy + c[1] * g + 1 / view.s, g * n - 2 / view.s, g * n - 2 / view.s); });
    ctx.restore();
}

// 尺子：起点终点都吸附格心时显示经过的格子和斜步规则
function rulerText(a, b) {
    var g = gridSize();
    var dx = Math.round(Math.abs(b.x - a.x) / g * 1000) / 1000, dy = Math.round(Math.abs(b.y - a.y) / g * 1000) / 1000;
    var t = fmtDist(stepsToUnits(gridSteps(dx, dy)));
    var diag = Math.min(dx, dy);
    if (measureRule() === 'alternating' && diag >= 1 && Math.abs(diag - Math.round(diag)) < 0.01) t += '（斜 ' + Math.round(diag) + ' 步）';
    return t;
}

function drawRulerCells(a, b, color) {
    var ia = cellIndex(a.x, a.y), ib = cellIndex(b.x, b.y);
    if (ia[0] === ib[0] && ia[1] === ib[1]) return;
    drawPathCells([ia].concat(gridPath(ia[0], ia[1], ib[0], ib[1])), 1, color);
}

// ===== 移动 =====
function tokenSpeed(it) {
    var sh = it.sheet && sheets[it.sheet];
    var m = sh && String(sh.speed || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
}

// 拖动棋子时：显示占格经过的格子、移动距离（对比速度）
function drawMoveGuide(g0) {
    var ids = Object.keys(g0.orig);
    if (ids.length !== 1) return;
    var it = scene.items[ids[0]];
    if (!it || it.kind !== 'token') return;
    var o = g0.orig[ids[0]], gs = gridSize();
    var from = footprint(it, { x: o.x + (it.w || gs) / 2, y: o.y + (it.h || gs) / 2 });
    var snapped = snapTokenPos(it, it.x, it.y);
    var to = footprint(it, { x: snapped.x + (it.w || gs) / 2, y: snapped.y + (it.h || gs) / 2 });
    var dist = stepsToUnits(gridSteps(to.ix0 - from.ix0, to.iy0 - from.iy0));
    var speed = tokenSpeed(it);
    var over = speed && dist > speed;
    var color = over ? '#ef5350' : '#42a5f5';
    if (from.cells >= 1) drawPathCells(gridPath(from.ix0, from.iy0, to.ix0, to.iy0), from.n, color);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 / view.s;
    ctx.setLineDash([6 / view.s, 4 / view.s]);
    ctx.strokeRect(from.x0, from.y0, from.size, from.size);
    ctx.restore();
    if (dist > 0) drawLabel('移动 ' + fmtDist(dist) + (speed ? ' / ' + speed : ''), to.x0 + to.size / 2, to.y0, over ? '#ef9a9a' : '#fff');
}

// ===== 目标 / 掩护 =====
function myTokens() {
    return sortedItems().filter(function(t) { return t.kind === 'token' && canEdit(t); });
}

// 攻击者：选中的、自己能控制的棋子 > 当前回合中自己的棋子 > 自己的第一个棋子
function attackerToken() {
    var ids = selectedIds();
    if (ids.length === 1) {
        var s = scene.items[ids[0]];
        if (s && s.kind === 'token' && canEdit(s) && s.id !== target.id) return s;
    }
    var c = combatState(), cur = c && scene.items[c.turn];
    if (cur && canEdit(cur) && cur.id !== target.id) return cur;
    var mine = sortedItems().filter(function(t) { return t.kind === 'token' && t.owner === me.name && t.id !== target.id; });
    return mine[0] || null;
}

function targetToken() {
    var t = target.id && scene.items[target.id];
    if (!t) target.id = '';
    return t || null;
}

function setTarget(id) {
    target.id = target.id === id ? '' : (id || '');
    coverCache.key = '';
    renderCombatHud();
    requestRender();
}

// 线段与矩形是否相交（Liang–Barsky）
function segHitsRect(ax, ay, bx, by, x0, y0, x1, y1) {
    var t0 = 0, t1 = 1, dx = bx - ax, dy = by - ay;
    var p = [-dx, dx, -dy, dy], q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
    for (var i = 0; i < 4; i++) {
        if (p[i] === 0) { if (q[i] < 0) return false; continue; }
        var r = q[i] / p[i];
        if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
        else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return t0 < t1;
}

// DMG 掩护规则：从攻击者占格的某个角向目标某一格的四个角连线，被墙挡住 1–2 条 = 半身掩护，
// 3 条 = 四分之三掩护，4 条 = 完全掩护；攻击者取最有利的角和格子。中间隔着其他生物 = 半身掩护。
function coverInfo(att, tgt) {
    var key = wallsVersion + '|' + [att, tgt].map(function(t) { return t.id + ',' + Math.round(t.x) + ',' + Math.round(t.y) + ',' + (t.w || 0) + ',' + (t.fp || ''); }).join('|') +
        '|' + sortedItems().filter(function(t) { return t.kind === 'token'; }).length;
    if (coverCache.key === key) return coverCache.info;
    var g = gridSize(), p = scene.props, ox = num(p.gridOffX, 0), oy = num(p.gridOffY, 0);
    var fa = footprint(att), ft = footprint(tgt);
    var bx0 = Math.min(fa.x0, ft.x0) - g, by0 = Math.min(fa.y0, ft.y0) - g;
    var bx1 = Math.max(fa.x0 + fa.size, ft.x0 + ft.size) + g, by1 = Math.max(fa.y0 + fa.size, ft.y0 + ft.size) + g;
    var segs = wallSegments(false).filter(function(s) {
        return Math.max(s[0], s[2]) >= bx0 && Math.min(s[0], s[2]) <= bx1 && Math.max(s[1], s[3]) >= by0 && Math.min(s[1], s[3]) <= by1;
    });
    var inset = g * 0.03;
    function squares(f) {
        var list = [];
        if (f.cells < 1) { list.push([f.x0, f.y0, f.size]); return list; }
        for (var i = 0; i < f.n; i++) for (var j = 0; j < f.n; j++) list.push([ox + (f.ix0 + i) * g, oy + (f.iy0 + j) * g, g]);
        return list;
    }
    function corners(sq) {
        var x = sq[0], y = sq[1], s = sq[2];
        return [[x + inset, y + inset], [x + s - inset, y + inset], [x + s - inset, y + s - inset], [x + inset, y + s - inset]];
    }
    var best = 4;
    if (segs.length) {
        var aSq = squares(fa), tSq = squares(ft);
        outer:
        for (var i = 0; i < aSq.length; i++) {
            var ac = corners(aSq[i]);
            for (var k = 0; k < 4; k++) {
                for (var j = 0; j < tSq.length; j++) {
                    var blocked = 0;
                    corners(tSq[j]).forEach(function(tc) {
                        for (var s = 0; s < segs.length; s++) {
                            if (segmentsCross(ac[k][0], ac[k][1], tc[0], tc[1], segs[s])) { blocked++; return; }
                        }
                    });
                    if (blocked < best) best = blocked;
                    if (best === 0) break outer;
                }
            }
        }
    } else best = 0;
    var level = best === 0 ? 0 : best <= 2 ? 2 : best === 3 ? 5 : -1; // -1 = 完全掩护
    var a = tokenCenter(att), b = tokenCenter(tgt), by = '';
    if (level >= 0 && level < 2) {
        sortedItems().some(function(t) {
            if (t.kind !== 'token' || t.id === att.id || t.id === tgt.id || (t.hidden && !me.gm) || !isCreature(t)) return false;
            var f = footprint(t), sh = f.size * 0.1;
            if (segHitsRect(a.x, a.y, b.x, b.y, f.x0 + sh, f.y0 + sh, f.x0 + f.size - sh, f.y0 + f.size - sh)) { by = t.label || '其他生物'; return true; }
            return false;
        });
        if (by) level = 2;
    }
    var info = { level: level, dist: creatureDist(att, tgt), by: by, walls: best };
    coverCache = { key: key, info: info };
    return info;
}

// 能提供掩护的生物：有血量 / 角色卡 / 在先攻里 / 有控制者，且没有倒下（法术范围图片、道具不算）
function isCreature(t) {
    if (t.hpMax > 0 && num(t.hp, t.hpMax) <= 0) return false;
    return t.hpMax > 0 || !!t.sheet || inInit(t) || !!t.owner;
}

function coverText(level) {
    return level === 2 ? '半身掩护（AC +2）' : level === 5 ? '四分之三掩护（AC +5）' : level < 0 ? '完全掩护（无法直接攻击）' : '无掩护';
}

// 攻击描述里的触及 / 射程：「触及5尺」「射程 80/320」「投掷（射程 20/60）」；近战武器默认触及 5 尺
function parseAttackRange(text) {
    text = String(text || '');
    var r = {}, m = text.match(/射程\s*(\d+)\s*[\/／]\s*(\d+)/);
    if (m) { r.normal = +m[1]; r.long = +m[2]; }
    else if ((m = text.match(/射程\s*(\d+)\s*尺/))) { r.normal = r.long = +m[1]; }
    var t = text.match(/触及\s*(\d+)\s*尺/);
    if (t) r.reach = +t[1];
    else if (/触及/.test(text)) r.reach = 10;
    if (!r.reach && (/投掷/.test(text) || !r.normal)) r.reach = 5;
    return r;
}

function rangeVerdict(rng, dist) {
    if (!rng) return null;
    var u = function(n) { return n + ' ' + unitName(); };
    if (rng.reach && dist <= rng.reach) return { ok: true, text: '在触及范围内（' + u(rng.reach) + '）' };
    if (rng.normal && dist <= rng.normal) return { ok: true, text: '在射程内（' + u(rng.normal) + '）' };
    if (rng.long && dist <= rng.long) return { ok: true, dis: true, text: '远射程（' + rng.normal + '–' + u(rng.long) + '）：攻击具有劣势' };
    if (rng.normal) return { ok: false, text: '超出射程（最远 ' + u(rng.long) + '）' };
    if (rng.reach) return { ok: false, text: '超出触及（' + u(rng.reach) + '），需要先移动' };
    return null;
}

// 远程攻击时 5 尺内有敌对生物（GM 控制、未隐藏）：劣势
function hostileAdjacent(att) {
    if (!att.owner) return false;
    return sortedItems().some(function(t) {
        return t.kind === 'token' && !t.owner && !t.hidden && t.id !== att.id && isCreature(t) && creatureDist(att, t) <= 5;
    });
}

// 掷骰确认框里的目标说明；返回 { target, cover, html, dis, blocked }
function attackContext(o) {
    var tgt = targetToken(), att = attackerToken();
    if (!tgt) return null;
    var ctxInfo = { target: tgt, cover: 0, dis: false, blocked: false, lines: [] };
    var name = escapeHtml(tgt.label || '目标');
    if (!att) {
        ctxInfo.lines.push('🎯 <b>' + name + '</b>');
        return ctxInfo;
    }
    var ci = coverInfo(att, tgt);
    ctxInfo.cover = ci.level > 0 ? ci.level : 0;
    ctxInfo.blocked = ci.level < 0;
    ctxInfo.lines.push('🎯 <b>' + name + '</b> · 距 ' + escapeHtml(att.label || '攻击者') + ' ' + escapeHtml(fmtDist(ci.dist)));
    ctxInfo.lines.push(escapeHtml(coverText(ci.level)) + (ci.by ? '（' + escapeHtml(ci.by) + ' 挡在中间）' : ''));
    var v = rangeVerdict(o.range, ci.dist);
    if (v) {
        ctxInfo.lines.push('<span class="' + (v.ok ? (v.dis ? 'warn' : 'ok') : 'bad') + '">' + escapeHtml(v.text) + '</span>');
        if (v.dis) ctxInfo.dis = true;
    }
    if (o.range && o.range.normal && !(o.range.reach && ci.dist <= o.range.reach) && hostileAdjacent(att)) {
        ctxInfo.lines.push('<span class="warn">5 尺内有敌人：远程攻击具有劣势</span>');
        ctxInfo.dis = true;
    }
    return ctxInfo;
}

function drawTarget() {
    var tgt = targetToken();
    if (!tgt) return;
    var f = footprint(tgt), pad = gridSize() * 0.08, x0 = f.x0 - pad, y0 = f.y0 - pad, s = f.size + pad * 2, l = s * 0.28;
    ctx.save();
    ctx.strokeStyle = '#ff5252';
    ctx.lineWidth = 3 / view.s;
    ctx.beginPath();
    [[x0, y0, 1, 1], [x0 + s, y0, -1, 1], [x0 + s, y0 + s, -1, -1], [x0, y0 + s, 1, -1]].forEach(function(c) {
        ctx.moveTo(c[0] + c[2] * l, c[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(c[0], c[1] + c[3] * l);
    });
    ctx.stroke();
    var att = attackerToken();
    if (att) {
        var a = tokenCenter(att), b = tokenCenter(tgt), ci = coverInfo(att, tgt);
        ctx.setLineDash([8 / view.s, 6 / view.s]);
        ctx.lineWidth = 2 / view.s;
        ctx.strokeStyle = ci.level < 0 ? 'rgba(158,158,158,0.9)' : 'rgba(255,82,82,0.85)';
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.restore();
        drawLabel(fmtDist(ci.dist) + (ci.level ? ' · ' + coverText(ci.level).replace(/（.*）/, '') : ''), (a.x + b.x) / 2, (a.y + b.y) / 2, ci.level < 0 ? '#bdbdbd' : '#ff8a80');
        return;
    }
    ctx.restore();
}

// ===== 先攻 / 回合 =====
function combatState() {
    var c = scene.props.combat;
    return c && c.turn ? c : null;
}

function inInit(it) { return it.kind === 'token' && it.init != null && it.init !== '' && isFinite(parseFloat(it.init)); }

function initOrder() {
    return sortedItems().filter(inInit).sort(function(a, b) {
        return num(b.init, 0) - num(a.init, 0) || num(b.initMod, 0) - num(a.initMod, 0) ||
            num(b.initTie, 0) - num(a.initTie, 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
}

function initBonus(it) {
    if (it.initMod != null && it.initMod !== '') return num(it.initMod, 0);
    var sh = it.sheet && sheets[it.sheet];
    return sh ? num(String(sh.init || '0').replace('+', ''), 0) : 0;
}

function joinInit(ids) {
    var patches = ids.map(function(id) { return scene.items[id]; }).filter(function(it) {
        return it && it.kind === 'token' && canEdit(it) && !inInit(it);
    }).map(function(it) { return { id: it.id, init: 0, initTie: Math.random() }; });
    if (!patches.length) { notice('选中的棋子已经在先攻里了', true); return; }
    patchItems(patches);
    renderCombat();
}

function leaveInit(id) {
    var it = scene.items[id];
    if (!it || !canEdit(it)) return;
    patchItems([{ id: id, init: null, initRolled: null }]);
    renderCombat();
}

function rollInit(ids, mode) {
    ids = ids.filter(function(id) { return scene.items[id] && canEdit(scene.items[id]); });
    if (!ids.length) return;
    op({ op: 'init', action: 'roll', ids: ids, mode: mode || advMode || '', hidden: false });
    if (advMode) { advMode = ''; renderDiceButtons(); }
}

function combatAction(action) {
    if (action === 'end' && !confirm('结束战斗？先攻列表会保留，下次开战需要重新掷先攻。')) return;
    op({ op: 'combat', action: action });
}

function focusToken(id) {
    var it = scene.items[id];
    if (!it) return;
    var c = tokenCenter(it);
    view.x = canvas.clientWidth / 2 - c.x * view.s;
    view.y = canvas.clientHeight / 2 - c.y * view.s;
    selectOnly([id]);
}

function hpMini(it) {
    if (!(it.hpMax > 0)) return '';
    var cur = Math.max(0, num(it.hp, it.hpMax)), r = Math.min(1, cur / it.hpMax);
    var color = r > 0.5 ? '#43a047' : r > 0.25 ? '#fb8c00' : '#e53935';
    var showNum = me.gm || canEdit(it) || (it.sheet && sheets[it.sheet] && sheets[it.sheet].kind === 'pc');
    return '<span class="hp-mini" title="' + (showNum ? 'HP ' + cur + ' / ' + it.hpMax : '') + '"><i style="width:' + Math.round(r * 100) + '%;background:' + color + '"></i></span>' +
        (showNum ? '<span class="tt-hint">' + cur + '/' + it.hpMax + '</span>' : '');
}

function renderCombat() {
    var pane = $('combatPane');
    if (!pane) return;
    if (pane.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    var order = initOrder(), c = combatState(), cur = c ? c.turn : '';
    var h = '';
    if (c) {
        var mineTurn = scene.items[cur] && canEdit(scene.items[cur]) && !me.gm;
        h += '<div class="combat-head"><b>⚔ 第 ' + num(c.round, 1) + ' 轮</b>' +
            (me.gm ? '<button class="tt-btn small" data-cact="prev">上一位</button><button class="tt-btn small primary" data-cact="next">下一位</button>' +
                '<button class="tt-btn small danger" data-cact="end">结束战斗</button>' : '') +
            (mineTurn ? '<button class="tt-btn small primary" data-cact="next">结束我的回合</button>' : '') + '</div>';
        if (cur && !scene.items[cur]) h += '<div class="tt-hint">隐藏单位行动中…</div>';
    } else {
        h += '<div class="combat-head"><b>先攻</b>' +
            (me.gm ? '<button class="tt-btn small primary" data-cact="start"' + (order.length ? '' : ' disabled') + '>开始战斗</button>' : '') + '</div>';
    }
    var unrolled = order.filter(function(t) { return !t.initRolled && canEdit(t); });
    h += '<div class="lobby-row" style="gap:6px;">' +
        '<button class="tt-btn small" data-cact="join" title="把地图上选中的棋子加入先攻">加入选中棋子</button>' +
        (unrolled.length ? '<button class="tt-btn small" data-cact="rollall" title="为' + (me.gm ? '还没掷先攻的' : '你的') + '棋子掷先攻（使用骰子栏的优势 / 劣势）">掷先攻（' + unrolled.length + '）</button>' : '') +
        '</div>';
    if (!order.length) {
        h += '<div class="tt-hint">还没有棋子加入先攻。在地图上选中棋子后点「加入选中棋子」，或在棋子属性面板里加入。</div>';
    }
    h += '<div class="init-list">' + order.map(function(it) {
        var edit = canEdit(it), active = it.id === cur;
        return '<div class="init-row' + (active ? ' active' : '') + (it.owner === me.name ? ' mine' : '') + (it.hidden ? ' hidden-tok' : '') + '" data-id="' + escapeHtml(it.id) + '">' +
            (edit ? '<input class="tt-input init-val" type="number" data-init="' + escapeHtml(it.id) + '" value="' + num(it.init, 0) + '" title="先攻值">' :
                '<span class="init-val">' + num(it.init, 0) + '</span>') +
            '<div class="init-info" data-focus="' + escapeHtml(it.id) + '" title="定位到棋子"><div class="name">' + (active ? '▶ ' : '') + escapeHtml(it.label || '未命名') +
            (it.hidden ? ' <span class="tt-hint">隐藏</span>' : '') + (!it.initRolled ? ' <span class="tt-hint">未掷</span>' : '') + '</div>' +
            '<div class="sub">' + hpMini(it) + (it.ac != null && it.ac !== '' ? '<span class="ac-mini" title="护甲等级">🛡' + escapeHtml(String(it.ac)) + '</span>' : '') +
            '<span class="tt-hint">先攻 ' + (signed(initBonus(it)) || '+0') + '</span></div></div>' +
            (edit ? '<button class="tt-btn small" data-cact="roll" data-id="' + escapeHtml(it.id) + '" title="掷先攻 d20' + (signed(initBonus(it)) || '') + '">🎲</button>' +
                '<button class="tt-btn small" data-cact="leave" data-id="' + escapeHtml(it.id) + '" title="移出先攻">✕</button>' : '') +
            (target.id === it.id ? '<span title="你的目标">🎯</span>' : '') +
            '</div>';
    }).join('') + '</div>';
    h += '<div class="side-section"><h5>目标</h5><div class="tt-hint">把鼠标放在棋子上按 <b>T</b>（或在棋子属性面板点「设为目标」）选择攻击目标。' +
        '之后从角色卡发起攻击检定会显示距离、触及 / 射程和掩护，并自动对目标 AC 结算命中。</div></div>';
    pane.innerHTML = h;
}

function onCombatPaneClick(e) {
    var f = e.target.closest('[data-focus]');
    if (f && !e.target.closest('button')) { focusToken(f.dataset.focus); return; }
    var b = e.target.closest('[data-cact]');
    if (!b) return;
    switch (b.dataset.cact) {
    case 'start': case 'next': case 'prev': case 'end': combatAction(b.dataset.cact); break;
    case 'join': joinInit(selectedIds()); break;
    case 'roll': rollInit([b.dataset.id], e.shiftKey ? 'adv' : ''); break;
    case 'leave': leaveInit(b.dataset.id); break;
    case 'rollall':
        rollInit(initOrder().filter(function(t) { return !t.initRolled && canEdit(t); }).map(function(t) { return t.id; }));
        break;
    }
}

function onCombatPaneChange(e) {
    var id = e.target.dataset.init;
    if (!id || !scene.items[id]) return;
    var v = parseFloat(e.target.value);
    if (!isFinite(v)) return;
    patchItems([{ id: id, init: v, initRolled: true }]);
    e.target.blur();
    renderCombat();
}

// 舞台顶部：回合信息 + 当前目标
function renderCombatHud() {
    var hud = $('combatHud');
    if (!hud) return;
    var c = combatState(), parts = [];
    if (c) {
        var order = initOrder(), idx = -1;
        order.forEach(function(t, i) { if (t.id === c.turn) idx = i; });
        var cur = scene.items[c.turn], next = order.length ? order[(idx + 1) % order.length] : null;
        var mine = cur && canEdit(cur);
        parts.push('<span class="hud-round">⚔ 第 ' + num(c.round, 1) + ' 轮</span>' +
            '<span class="hud-cur' + (mine ? ' mine' : '') + '">当前：' + escapeHtml(cur ? cur.label || '未命名' : '隐藏单位') + '</span>' +
            (next && next.id !== c.turn ? '<span class="tt-hint">下一位：' + escapeHtml(next.label || '未命名') + '</span>' : '') +
            ((me.gm || (mine && cur)) ? '<button class="tt-btn small primary" data-cact="next">' + (me.gm ? '下一位' : '结束回合') + '</button>' : ''));
    }
    var tgt = targetToken();
    if (tgt) {
        var att = attackerToken(), ci = att ? coverInfo(att, tgt) : null;
        parts.push('<span class="hud-target">🎯 ' + escapeHtml(tgt.label || '目标') +
            (ci ? ' · ' + escapeHtml(fmtDist(ci.dist)) + ' · ' + escapeHtml(coverText(ci.level).replace(/（.*）/, '')) : '') +
            ' <i data-cact="untarget" title="取消目标">✕</i></span>');
    }
    hud.innerHTML = parts.join('');
    hud.style.display = parts.length ? '' : 'none';
}

function onCombatHudClick(e) {
    var b = e.target.closest('[data-cact]');
    if (!b) return;
    if (b.dataset.cact === 'untarget') setTarget('');
    else combatAction(b.dataset.cact);
}

// 场景属性变化：回合切换到自己的棋子时提醒
function onCombatChanged() {
    var c = combatState(), turn = c ? c.turn + '#' + c.round : '';
    if (turn !== lastTurn) {
        var cur = c && scene.items[c.turn];
        if (lastTurn !== null && cur && cur.owner === me.name) notice('⚔ 轮到你了：' + (cur.label || ''), false, 4000);
        lastTurn = turn;
    }
    renderCombat();
    renderCombatHud();
}

function drawTurnRing() {
    var c = combatState(), it = c && scene.items[c.turn];
    if (!it) return;
    var f = footprint(it), cx = f.x0 + f.size / 2, cy = f.y0 + f.size / 2, r = Math.max(f.size, gridSize() * 0.6) * 0.62;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 6 / view.s;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#ffd54f';
    ctx.lineWidth = 3 / view.s;
    ctx.setLineDash([10 / view.s, 5 / view.s]);
    ctx.stroke();
    ctx.restore();
}

// ===== 棋子上的小标记：AC、资源 =====
function drawTokenBadges(it) {
    var g = gridSize(), w = it.w || g, h = it.h || g, x = it.x || 0, y = it.y || 0;
    if (Math.min(w, h) * view.s < 26) return;
    if (it.ac != null && it.ac !== '') {
        var s = toScreen(x + w, y);
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        var bx = s.x - 4, by = s.y + 2;
        ctx.beginPath();
        ctx.moveTo(bx - 9, by); ctx.lineTo(bx + 9, by); ctx.lineTo(bx + 9, by + 9);
        ctx.quadraticCurveTo(bx + 9, by + 17, bx, by + 21);
        ctx.quadraticCurveTo(bx - 9, by + 17, bx - 9, by + 9);
        ctx.closePath();
        ctx.fillStyle = 'rgba(38,50,56,0.92)';
        ctx.fill();
        ctx.strokeStyle = '#90a4ae';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(it.ac), bx, by + 9);
        ctx.restore();
    }
    var res = (it.res || []).filter(function(r) { return r.type === 'count' && num(r.max, 0) > 0 && num(r.max, 0) <= 12; });
    var c = combatState();
    if (res.length && (selected[it.id] || (c && c.turn === it.id))) {
        var p = toScreen(x + w / 2, y + h);
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        res.slice(0, 3).forEach(function(r, row) {
            var max = num(r.max, 0), cur = num(r.cur, 0), py = p.y + (it.label ? 26 : 6) + row * 10;
            for (var i = 0; i < max; i++) {
                ctx.beginPath();
                ctx.arc(p.x + (i - (max - 1) / 2) * 9, py, 3.5, 0, Math.PI * 2);
                ctx.fillStyle = i < cur ? '#b39ddb' : 'rgba(0,0,0,0.6)';
                ctx.fill();
                ctx.strokeStyle = '#d1c4e9';
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        });
        ctx.restore();
    }
}

// ===== 属性面板：战斗相关 =====
function combatPanelHtml(it, row) {
    var h = '';
    var cells = num(it.fp, 0);
    h += row('体型', '<select class="tt-select" data-prop="fp" style="flex:1;">' + SIZE_OPTS.map(function(o) {
        return '<option value="' + o[0] + '"' + (String(cells || '') === o[0] ? ' selected' : '') + '>' + o[1] + (o[0] ? '（' + o[0] + ' 格）' : '（' + tokenCells(it) + ' 格）') + '</option>';
    }).join('') + '</select><button class="tt-btn small" data-act="fitsize" title="把图片缩放到占格大小">贴合</button>');
    h += row('AC', '<input class="tt-input narrow" data-prop="ac" type="number" min="0" value="' + (it.ac != null ? escapeHtml(String(it.ac)) : '') + '" placeholder="—">' +
        '<span class="tt-hint">' + (it.owner ? '' : '玩家看不到') + '</span>');
    if (inInit(it)) {
        h += row('先攻', '<input class="tt-input narrow" data-prop="init" type="number" value="' + num(it.init, 0) + '">' +
            '<span class="tt-hint">加值</span><input class="tt-input narrow" data-prop="initMod" type="number" value="' + (it.initMod != null ? it.initMod : '') + '" placeholder="' + initBonus(it) + '">' +
            '<button class="tt-btn small" data-act="initroll" title="掷先攻">🎲</button><button class="tt-btn small" data-act="initleave" title="移出先攻">✕</button>');
    } else {
        h += row('先攻', '<button class="tt-btn small" data-act="initjoin">加入先攻</button>' +
            '<span class="tt-hint">加值</span><input class="tt-input narrow" data-prop="initMod" type="number" value="' + (it.initMod != null ? it.initMod : '') + '" placeholder="' + initBonus(it) + '">');
    }
    // 资源（法术位、职业资源…）
    var res = it.res || [];
    h += '<div class="prop-sub">资源</div>';
    h += res.map(function(r, i) {
        var cur = num(r.cur, 0), max = num(r.max, 0), shown;
        if (r.type === 'count' && max <= 12) {
            shown = '<span class="res-pips">' + Array.apply(null, Array(Math.max(0, max))).map(function(_, k) { return '<i class="' + (k < cur ? 'on' : '') + '"></i>'; }).join('') + '</span>';
        } else shown = '<b>' + cur + ' / ' + max + '</b>';
        return '<div class="prop-row res-row"><label title="' + escapeHtml(r.name) + '">' + escapeHtml(r.name) + '</label>' + shown +
            '<button class="tt-btn small" data-res="' + i + '" data-delta="-1">−</button><button class="tt-btn small" data-res="' + i + '" data-delta="1">+</button>' +
            '<button class="tt-btn small" data-resdel="' + i + '" title="删除">✕</button></div>';
    }).join('');
    h += '<div class="prop-row"><input class="tt-input" data-resname placeholder="新资源，如：一环法术位" maxlength="20" style="flex:1;">' +
        '<input class="tt-input narrow" data-resmax type="number" min="1" placeholder="上限"><button class="tt-btn small" data-act="resadd">添加</button></div>';
    return h;
}

// 属性面板里战斗相关按钮；返回 true 表示已处理
function onCombatPanelClick(b, it) {
    if (b.dataset.res != null) {
        var res = JSON.parse(JSON.stringify(it.res || [])), r = res[parseInt(b.dataset.res, 10)];
        if (!r) return true;
        r.cur = Math.max(0, Math.min(num(r.max, 0) || Infinity, num(r.cur, 0) + parseInt(b.dataset.delta, 10)));
        patchItems([{ id: it.id, res: res }]);
        return true;
    }
    if (b.dataset.resdel != null) {
        var list = (it.res || []).slice();
        list.splice(parseInt(b.dataset.resdel, 10), 1);
        patchItems([{ id: it.id, res: list.length ? list : null }]);
        return true;
    }
    switch (b.dataset.act) {
    case 'resadd':
        var panel = $('selPanel'), name = panel.querySelector('[data-resname]').value.trim(), max = parseInt(panel.querySelector('[data-resmax]').value, 10);
        if (!name || !(max > 0)) { notice('填写资源名称和上限', true); return true; }
        patchItems([{ id: it.id, res: (it.res || []).concat([{ id: genId(), name: name.slice(0, 20), type: 'count', cur: max, max: max, icon: 'gem' }]) }]);
        return true;
    case 'fitsize':
        var fit = fitTokenToCells(it, tokenCells(it));
        fit.id = it.id;
        patchItems([fit]);
        return true;
    case 'initjoin': joinInit([it.id]); return true;
    case 'initleave': leaveInit(it.id); return true;
    case 'initroll': rollInit([it.id]); return true;
    case 'target': setTarget(it.id); return true;
    }
    return false;
}

// 从角色卡放置棋子时带上 AC、体型和法术位
function sheetTokenExtras(sh, it) {
    var ac = parseFloat(sh.ac);
    if (ac > 0) it.ac = ac;
    var cells = sheetSizeCells(sh);
    if (cells) it.fp = cells;
    if (sh.kind === 'pc') {
        var res = [];
        (sh.slots || []).forEach(function(s) {
            var max = num(s.max, 0);
            if (max > 0) res.push({ id: genId(), name: s.level + '环法术位', type: 'count', cur: num(s.cur, max), max: max, icon: 'spellbook' });
        });
        (sh.resources || []).forEach(function(r) {
            var max = num(r.max, 0);
            if (max > 0) res.push({ id: genId(), name: String(r.name).slice(0, 20), type: 'count', cur: num(r.cur, max), max: max, icon: 'gem' });
        });
        if (res.length) it.res = res.slice(0, 12);
    }
}

function initCombat() {
    $('combatPane').addEventListener('click', onCombatPaneClick);
    $('combatPane').addEventListener('change', onCombatPaneChange);
    $('combatHud').addEventListener('click', onCombatHudClick);
}
