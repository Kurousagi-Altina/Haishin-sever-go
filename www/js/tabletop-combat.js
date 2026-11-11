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

// ===== 吸附档位（每人各自设置，存在本机）=====
// 自由：停在任意位置；1/4 格、半格、整格：占格的边对齐到对应的细分网格
var SNAP_OPTS = [['free', '自由放置'], ['quarter', '吸附 1/4 格'], ['half', '吸附半格'], ['cell', '吸附整格']];
var snapMode = (function() { try { return localStorage.getItem('ttSnap') || 'free'; } catch (e) { return 'free'; } })();

function snapDiv() { return snapMode === 'cell' ? 1 : snapMode === 'half' ? 2 : snapMode === 'quarter' ? 4 : 0; }

// 网格细分后一步的长度（自由模式下用于挪位 / 方向键的步长）
function snapStep() { var d = snapDiv(); return gridSize() / (d || 4); }

function setSnapMode(m) {
    snapMode = m;
    try { localStorage.setItem('ttSnap', m); } catch (e) { /* 无痕模式等 */ }
    var sel = $('snapSel');
    if (sel) sel.value = m;
    requestRender();
}

// 松手时的位置：按吸附档位让占格对齐细分网格（图片相对占格居中）
function snapTokenPos(it, x, y) {
    var div = snapDiv();
    if (!div) return { x: x, y: y };
    if (isHex()) { // 六角格：格心对齐
        var gg = gridSize(), hc = hexCenterNear(x + (it.w || gg) / 2, y + (it.h || gg) / 2);
        return { x: hc.x - (it.w || gg) / 2, y: hc.y - (it.h || gg) / 2 };
    }
    var g = gridSize(), w = it.w || g, h = it.h || g, cells = tokenCells(it), step = g / div;
    var cx = x + w / 2, cy = y + h / 2, c;
    var F = cells < 1 ? g * cells : cells * g;
    if (cells < 1) step = Math.min(step, g / 2);
    c = snapToGrid(cx - F / 2, cy - F / 2, step);
    cx = c.x + F / 2; cy = c.y + F / 2;
    return { x: cx - w / 2, y: cy - h / 2 };
}

// 松手时的落点：按吸附档位对齐；按住 Alt 不吸附。停在哪就是哪，不会自动挪开
function dropSpot(it, x, y, from, alt) {
    var c = alt ? { x: x, y: y } : snapTokenPos(it, x, y);
    c.moved = false;
    return c;
}

// ===== 判定圆 =====
// 判定圆 = 生物身体在地面上实际占的范围（俯视的身体宽度），和图片大小无关。
// 默认按体型取一个小圆（半径）：微型 0.5 尺、小型 0.75 尺、中型 1 尺（约两尺宽的成人肩宽），
// 更大的按占格边长等比放大：大型 2 尺、巨型 3 尺、超巨型 4 尺；每个棋子都可以单独调整（item.hitR，单位尺）。
// 缩放棋子图片不影响判定圆：没定体型的棋子第一次缩放时会先把当时的体型记进 fp（pinTokenCells）。
// 距离、触及、射程、掩护、范围是否波及都按判定圆计算。
function feetToPx(ft) { return ft / num(scene.props.gridScale, 5) * gridSize(); }

function defaultHitFt(it) {
    var c = tokenCells(it);
    if (c < 1) return 0.5;
    if (c >= 2) return c; // 按体型等比放大：大型 2 尺、巨型 3 尺、超巨型 4 尺（中型 1 尺 × 边长格数）
    var sh = it.sheet && sheets[it.sheet];
    if (sh && /小型/.test((sh.size || '') + ' ' + (sh.meta || ''))) return 0.75;
    return 1;
}

// 改图片大小前调用：体型还是从图片大小推出来的棋子，先把当前体型固定下来，判定圆就不会跟着图片变
function pinTokenCells(it, patch) {
    if (!it || it.kind !== 'token' || num(it.fp, 0) > 0) return;
    var sh = it.sheet && sheets[it.sheet];
    if (sh && sheetSizeCells(sh)) return;
    patch.fp = tokenCells(it);
}

function hitFt(it) { var r = num(it.hitR, 0); return r > 0 ? r : defaultHitFt(it); }
function hitPx(it) { return feetToPx(hitFt(it)); }

function drawHitCircle(it, color, dashed, center) {
    var c = center || tokenCenter(it), r = Math.max(hitPx(it), 3 / view.s);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = dashed ? 0.12 : 0.28;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5 / view.s;
    if (dashed) ctx.setLineDash([4 / view.s, 3 / view.s]);
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();
}

// 体型变化时把图片缩放到占格大小（保持比例）
function fitTokenToCells(it, cells) {
    var g = gridSize(), ratio = (it.h || g) / (it.w || g);
    var w = ratio > 1 ? cells * g / ratio : cells * g;
    var c = tokenCenter(it);
    return { w: w, h: w * ratio, x: c.x - w / 2, y: c.y - w * ratio / 2 };
}

// ===== 测距 =====
// 默认按实际长度（直线距离）计算，格子只作参考；设置里可改回按格子计数的 5-10-5 / 斜向 = 1 格
function measureRule() { return scene.props.measure || 'euclidean'; }
function realDistance() { return measureRule() === 'euclidean'; }

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

// 生物之间的距离：判定圆边缘之间（按测距规则计算圆心距离，再减去两个半径）
function creatureDist(a, b, aCenter, bCenter) {
    var ca = aCenter || tokenCenter(a), cb = bCenter || tokenCenter(b), g = gridSize();
    var steps = isHex() ? Math.hypot(cb.x - ca.x, cb.y - ca.y) / g : gridSteps(Math.abs(cb.x - ca.x) / g, Math.abs(cb.y - ca.y) / g);
    var d = stepsToUnits(steps) - hitFt(a) - hitFt(b);
    return Math.max(0, Math.round(d * 2) / 2);
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
    if (isHex()) return fmtDist(stepsToUnits(hexDist(a.x, a.y, b.x, b.y)));
    var g = gridSize();
    var dx = Math.round(Math.abs(b.x - a.x) / g * 1000) / 1000, dy = Math.round(Math.abs(b.y - a.y) / g * 1000) / 1000;
    var t = fmtDist(stepsToUnits(gridSteps(dx, dy)));
    var diag = Math.min(dx, dy);
    if (measureRule() === 'alternating' && diag >= 1 && Math.abs(diag - Math.round(diag)) < 0.01) t += '（斜 ' + Math.round(diag) + ' 步）';
    return t;
}

function drawRulerCells(a, b, color) {
    if (isHex() || realDistance()) return; // 按实际长度时不画格子路径
    var ia = cellIndex(a.x, a.y), ib = cellIndex(b.x, b.y);
    if (ia[0] === ib[0] && ia[1] === ib[1]) return;
    drawPathCells([ia].concat(gridPath(ia[0], ia[1], ib[0], ib[1])), 1, color);
}

// ===== 移动 =====
function tokenSpeed(it) {
    if (num(it.speed, 0) > 0) return num(it.speed, 0);
    var sh = it.sheet && sheets[it.sheet];
    var m = sh && String(sh.speed || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
}

// ===== 移动距离 =====
// 按实际长度时，拖动的移动距离 = 实际拖过的路径长度（绕开障碍走的弯路也算）；
// 按格子规则时 = 起点到落点的格数。战斗中自己的回合里，移动会累计到「本回合已移动」，并对比速度。
function pxToFt(px) { return px / gridSize() * num(scene.props.gridScale, 5); }

function movePathFt(trail, endOff) {
    var pts = (trail || [{ x: 0, y: 0 }]).concat([endOff]), len = 0;
    for (var i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return Math.round(pxToFt(len) * 2) / 2;
}

function moveDistFt(c0, c1, trail) {
    var gs = gridSize();
    if (realDistance()) return movePathFt(trail, { x: c1.x - c0.x, y: c1.y - c0.y });
    var steps = isHex() ? Math.hypot(c1.x - c0.x, c1.y - c0.y) / gs : gridSteps(Math.abs(c1.x - c0.x) / gs, Math.abs(c1.y - c0.y) / gs);
    return Math.round(stepsToUnits(steps) * 2) / 2;
}

// 本回合（战斗中、轮到它时）已经移动了多少
function turnKey() { var c = combatState(); return c ? c.round + ':' + c.turn : ''; }
function movedThisTurn(it) { var k = turnKey(); return k && it.movedKey === k ? num(it.moved, 0) : 0; }

// 移动后要一起写进棋子的「本回合已移动」（只在它自己的回合，且自己能改这个棋子时）
function movedPatch(it, ft) {
    var c = combatState();
    if (!c || c.turn !== it.id || !canEdit(it) || !(ft > 0)) return null;
    return { moved: Math.round((movedThisTurn(it) + ft) * 2) / 2, movedKey: turnKey() };
}

// 拖动棋子时：显示实际路径、起点和落点的判定圆、移动距离（对比速度）
function drawMoveGuide(g0) {
    var ids = Object.keys(g0.orig);
    if (ids.length !== 1) return;
    var it = scene.items[ids[0]];
    if (!it || it.kind !== 'token') return;
    var o = g0.orig[ids[0]], gs = gridSize(), w = it.w || gs, h = it.h || gs;
    var spot = dropSpot(it, it.x, it.y, o, g0.alt);
    var c0 = { x: o.x + w / 2, y: o.y + h / 2 }, c1 = { x: spot.x + w / 2, y: spot.y + h / 2 };
    var dist = moveDistFt(c0, c1, g0.trail);
    var c = combatState(), mine = c && c.turn === it.id;
    var used = mine ? movedThisTurn(it) : 0, total = used + dist;
    var speed = tokenSpeed(it);
    var over = speed && total > speed;
    var color = over ? '#ef5350' : '#42a5f5';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 / view.s;
    ctx.setLineDash([6 / view.s, 4 / view.s]);
    ctx.beginPath();
    ctx.moveTo(c0.x, c0.y);
    if (realDistance()) (g0.trail || []).forEach(function(p) { ctx.lineTo(c0.x + p.x, c0.y + p.y); }); // 实际走过的路线
    ctx.lineTo(c1.x, c1.y);
    ctx.stroke();
    ctx.restore();
    drawHitCircle(it, color, true, c0);
    drawHitCircle(it, color, false, c1);
    if (dist > 0) {
        var text = '移动 ' + fmtDist(dist);
        if (mine && used) text += '（本回合共 ' + fmtDist(total) + '）';
        if (speed) text += ' / 速度 ' + speed + (over ? (total <= speed * 2 ? ' · 需要疾走' : ' · 超出') : '');
        drawLabel(text, c1.x, spot.y, over ? '#ef9a9a' : '#fff');
    }
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

// 掩护（参照 DMG 角对角规则，用判定圆代替格子）：从攻击者判定圆的圆心或边缘四点之一，
// 连线到目标判定圆边缘的四点，被墙挡住 1–2 条 = 半身掩护，3 条 = 四分之三，4 条 = 完全掩护；
// 攻击者取最有利的起点。连线穿过其他生物的判定圆 = 半身掩护。
function coverInfo(att, tgt) {
    var key = wallsVersion + '|' + att.id + '|' + tgt.id + '|' + num(scene.props.gridScale, 5) + measureRule() + '|' +
        sortedItems().filter(function(t) { return t.kind === 'token'; }).map(function(t) {
            return [t.id, Math.round(t.x), Math.round(t.y), t.w || 0, t.h || 0, t.hitR || '', t.fp || '', t.hp, t.hpMax, t.hidden ? 1 : 0].join(',');
        }).join(';');
    if (coverCache.key === key) return coverCache.info;
    var a = tokenCenter(att), b = tokenCenter(tgt), ra = hitPx(att) * 0.9, rt = hitPx(tgt) * 0.9;
    var ring = function(c, r) { return [[c.x + r, c.y], [c.x - r, c.y], [c.x, c.y + r], [c.x, c.y - r]]; };
    var pad = Math.max(ra, rt) + gridSize();
    var segs = wallSegments(false).filter(function(s) {
        return Math.max(s[0], s[2]) >= Math.min(a.x, b.x) - pad && Math.min(s[0], s[2]) <= Math.max(a.x, b.x) + pad &&
            Math.max(s[1], s[3]) >= Math.min(a.y, b.y) - pad && Math.min(s[1], s[3]) <= Math.max(a.y, b.y) + pad;
    });
    var best = 0;
    if (segs.length) {
        best = 4;
        var from = [[a.x, a.y]].concat(ring(a, ra)), to = ring(b, rt);
        for (var i = 0; i < from.length && best > 0; i++) {
            var blocked = 0;
            to.forEach(function(tc) {
                for (var s = 0; s < segs.length; s++) {
                    if (segmentsCross(from[i][0], from[i][1], tc[0], tc[1], segs[s])) { blocked++; return; }
                }
            });
            if (blocked < best) best = blocked;
        }
    }
    var level = best === 0 ? 0 : best <= 2 ? 2 : best === 3 ? 5 : -1; // -1 = 完全掩护
    var by = '';
    if (level >= 0 && level < 2) {
        sortedItems().some(function(t) {
            if (t.kind !== 'token' || t.id === att.id || t.id === tgt.id || (t.hidden && !me.gm) || !isCreature(t) || !visibleToMe(t)) return false;
            var c = tokenCenter(t);
            if (distToSeg(c.x, c.y, a.x, a.y, b.x, b.y) < hitPx(t)) { by = t.label || '其他生物'; return true; }
            return false;
        });
        if (by) level = 2;
    }
    var info = { level: level, dist: creatureDist(att, tgt), by: by, walls: best };
    coverCache = { key: key, info: info };
    return info;
}

// 生物棋子：有血量 / 角色卡 / 在先攻里 / 有控制者（法术范围图片、道具不算）——0 血的也算，可以被治疗或攻击
function isCreatureToken(t) { return t.hpMax > 0 || !!t.sheet || inInit(t) || !!t.owner; }

// 能提供掩护的生物：没有倒下的生物
function isCreature(t) {
    if (t.hpMax > 0 && num(t.hp, t.hpMax) <= 0) return false;
    return isCreatureToken(t);
}

// 玩家能不能看见这个棋子：自己的总能看见；动态视野外、或被迷雾盖住的看不见（GM 全都能看见）
function fogCovers(x, y) {
    var covered = false;
    sortedItems().forEach(function(f) {
        if (f.kind !== 'fog') return;
        var lx = x - (f.x || 0), ly = y - (f.y || 0), inside = false;
        if (f.shape === 'brush') {
            var pts = f.points || [], half = (f.width || gridSize()) / 2;
            for (var i = 0; i < pts.length && !inside; i++) {
                var a = pts[i], b = pts[i + 1] || a;
                if (distToSeg(lx, ly, a[0], a[1], b[0], b[1]) <= half) inside = true;
            }
        } else if (f.shape === 'circle') inside = Math.hypot(lx, ly) <= (f.r || 0);
        else inside = pointInPoly(lx, ly, shapePoints(f));
        if (inside) covered = !f.cut;
    });
    return covered;
}

function visibleToMe(t) {
    if (me.gm || (t.owner && t.owner === me.name)) return true;
    var c = tokenCenter(t);
    if (visionActive() && !pointVisible(c.x, c.y, computeVision())) return false;
    return !fogCovers(c.x, c.y);
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
        return t.kind === 'token' && !t.owner && !t.hidden && t.id !== att.id && isCreature(t) && visibleToMe(t) && creatureDist(att, t) <= 5;
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
    var adv = [], dis = [];
    if (ctxInfo.dis) dis.push('远射程');
    if (o.range && o.range.normal && !(o.range.reach && ci.dist <= o.range.reach) && hostileAdjacent(att)) dis.push('5 尺内有敌人（远程攻击）');
    // 状态：目盲、隐形、倒地、束缚、麻痹…（优势与劣势同时存在时相互抵消）
    var sm = statusAttackMods(att, tgt, ci.dist);
    adv = adv.concat(sm.adv);
    dis = dis.concat(sm.dis);
    ctxInfo.adv = adv.length > 0;
    ctxInfo.dis = dis.length > 0;
    ctxInfo.mode = ctxInfo.adv && ctxInfo.dis ? '' : ctxInfo.adv ? 'adv' : ctxInfo.dis ? 'dis' : '';
    if (adv.length) ctxInfo.lines.push('<span class="ok">优势：' + escapeHtml(adv.join('、')) + '</span>');
    if (dis.length) ctxInfo.lines.push('<span class="warn">劣势：' + escapeHtml(dis.join('、')) + '</span>');
    if (adv.length && dis.length) ctxInfo.lines.push('<span class="tt-hint">优势与劣势相互抵消 → 普通</span>');
    ctxInfo.autoCrit = sm.autoCrit;
    if (sm.autoCrit) ctxInfo.lines.push('<span class="ok">目标麻痹 / 昏迷且在 5 尺内：命中即重击</span>');
    ctxInfo.adj = sm.adj;
    if (sm.adj) ctxInfo.lines.push('<span class="warn">力竭：调整值 ' + sm.adj + '</span>');
    ctxInfo.extra = sm.extra;
    if (sm.extra) ctxInfo.lines.push('<span class="ok">' + (sm.extra === '+1d4' ? '祝福 +1d4' : '灾祸 −1d4') + '</span>');
    return ctxInfo;
}

function drawTarget() {
    var tgt = targetToken();
    if (!tgt) return;
    var bb = itemBBox(tgt), pad = gridSize() * 0.08, x0 = bb.x0 - pad, y0 = bb.y0 - pad, s = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) + pad * 2, l = s * 0.28;
    drawHitCircle(tgt, '#ff5252', false);
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

// 在先攻条中对玩家隐藏：GM 设置的，或 GM 控制的生物正处于「躲藏」（玩家端收不到这些先攻数据）
function initHiddenFor(it) { return !!it.initHidden || (!it.owner && hasStatus(it, 'hidden')); }

// GM 偏好（存在本机）：加入先攻时默认隐藏 / 从资料放置的棋子默认隐藏
function gmPref(key, def) {
    try { var v = localStorage.getItem(key); return v == null ? def : v === '1'; } catch (e) { return def; }
}
function setGmPref(key, on) { try { localStorage.setItem(key, on ? '1' : '0'); } catch (e) { /* 无痕模式等 */ } }

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
    }).map(function(it) {
        var p = { id: it.id, init: 0, initTie: Math.random() };
        if (me.gm && gmPref('ttInitHidden', false)) p.initHidden = true;
        return p;
    });
    if (!patches.length) {
        var picked = ids.filter(function(id) { var it = scene.items[id]; return it && it.kind === 'token'; });
        notice(!picked.length ? '先在地图上选中要加入先攻的棋子' : picked.some(function(id) { return !canEdit(scene.items[id]); }) ?
            '只能把自己控制的棋子加入先攻' : '选中的棋子已经在先攻里了', true);
        return;
    }
    patchItems(patches);
    renderCombat();
}

// GM 调整顺序：把先攻值改到相邻两者之间（可能出现 .5 之类的小数），排在前面 / 后面
function moveInit(id, dir) {
    var order = initOrder(), i = -1;
    order.forEach(function(t, k) { if (t.id === id) i = k; });
    if (i < 0) return;
    var j = i + dir;
    if (j < 0 || j >= order.length) return;
    var other = num(order[j].init, 0), beyond = order[j + dir], v;
    if (beyond) v = (other + num(beyond.init, 0)) / 2;
    else v = other + (dir < 0 ? 1 : -1);
    if (v === other) v = other + (dir < 0 ? 0.5 : -0.5); // 相邻两者同值时也能分开
    v = Math.round(v * 100) / 100;
    // 同值时决胜：上移排在对方前面，下移排在后面
    var tie = num(order[j].initTie, 0.5) + (dir < 0 ? 0.001 : -0.001);
    patchItems([{ id: id, init: v, initRolled: true, initTie: tie, initMod: order[i].initMod != null ? order[i].initMod : null }]);
    renderCombat();
    renderCombatHud();
}

function leaveInit(id) {
    var it = scene.items[id];
    if (!it || !canEdit(it)) return;
    patchItems([{ id: id, init: null, initRolled: null, initHidden: null }]);
    renderCombat();
}

function rollInit(ids, mode) {
    ids = ids.filter(function(id) { return scene.items[id] && canEdit(scene.items[id]); });
    if (!ids.length) return;
    op({ op: 'init', action: 'roll', ids: ids, mode: mode || advMode || '', hidden: false });
    if (advMode) { advMode = ''; renderDiceButtons(); }
}

function combatAction(action) {
    if (action === 'death') { var cs = combatState(); if (cs) op({ op: 'death', ids: [cs.turn] }); return; }
    if (action === 'follow') {
        var on = !gmPref('ttFollowTurn', true);
        setGmPref('ttFollowTurn', on);
        if ($('prefFollowTurn')) $('prefFollowTurn').checked = on;
        notice(on ? '🎥 镜头会跟随当前行动者' : '🎥 镜头不再自动跟随');
        renderCombatHud();
        return;
    }
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
            (me.gm ? '<button class="tt-btn small" data-cact="round" data-delta="-1" title="轮数 −1">−</button><button class="tt-btn small" data-cact="round" data-delta="1" title="轮数 +1">+</button>' : '') +
            (me.gm ? '<button class="tt-btn small" data-cact="prev">上一位</button><button class="tt-btn small primary" data-cact="next">下一位</button>' +
                '<button class="tt-btn small danger" data-cact="end">结束战斗</button>' : '') +
            (mineTurn ? '<button class="tt-btn small primary" data-cact="next">结束我的回合</button>' : '') + '</div>';
        if (cur && !scene.items[cur]) h += '<div class="tt-hint">隐藏单位行动中…</div>';
    } else {
        h += '<div class="combat-head"><b>先攻</b>' +
            (me.gm ? '<button class="tt-btn small" data-cact="prep"' + (order.length ? '' : ' disabled') + ' title="给还没掷的单位掷先攻，全员显示「准备战斗」后开战">准备</button>' +
                '<button class="tt-btn small danger" data-cact="ambush"' + (order.length ? '' : ' disabled') + ' title="突袭开战：全员显示「伏击」">伏击</button>' +
                '<button class="tt-btn small primary" data-cact="start"' + (order.length ? '' : ' disabled') + '>开始战斗</button>' : '') + '</div>';
    }
    var unrolled = order.filter(function(t) { return !t.initRolled && canEdit(t); });
    h += '<div class="lobby-row" style="gap:6px;">' +
        '<button class="tt-btn small" data-cact="join" title="把地图上选中的棋子加入先攻">加入选中棋子</button>' +
        '<button class="tt-btn small" data-cact="custom" title="手动填写一个攻击 / 法术 / 治疗，在地图上选目标并自动结算">⚡ 自定义行动</button>' +
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
            (it.hidden ? ' <span class="tt-hint">隐藏</span>' : initHiddenFor(it) ? ' <span class="tt-hint" title="玩家的先攻条里看不到它">先攻隐藏</span>' : '') +
            (!it.initRolled ? ' <span class="tt-hint">未掷</span>' : '') +
            statusList(it).map(function(s) { return ' <span title="' + escapeHtml(statusLabel(s)) + '">' + escapeHtml(statusIcon(s)) + '</span>'; }).join('') + '</div>' +
            '<div class="sub">' + hpMini(it) + (it.ac != null && it.ac !== '' ? '<span class="ac-mini" title="护甲等级">🛡' + escapeHtml(String(it.ac)) + '</span>' : '') +
            '<span class="tt-hint">先攻 ' + (signed(initBonus(it)) || '+0') + '</span></div></div>' +
            (edit ? '<button class="tt-btn small" data-cact="roll" data-id="' + escapeHtml(it.id) + '" title="掷先攻 d20' + (signed(initBonus(it)) || '') + '">🎲</button>' +
                '<button class="tt-btn small" data-cact="leave" data-id="' + escapeHtml(it.id) + '" title="移出先攻">✕</button>' : '') +
            (me.gm ? '<span class="init-move"><button class="tt-btn small" data-cact="up" data-id="' + escapeHtml(it.id) + '" title="在先攻顺序中上移">▲</button>' +
                '<button class="tt-btn small" data-cact="down" data-id="' + escapeHtml(it.id) + '" title="在先攻顺序中下移">▼</button></span>' +
                (c && !active ? '<button class="tt-btn small" data-cact="setturn" data-id="' + escapeHtml(it.id) + '" title="直接切换到它的回合">▶</button>' : '') : '') +
            (me.gm && !it.hidden ? '<button class="tt-btn small' + (it.initHidden ? ' primary' : '') + '" data-cact="inithide" data-id="' + escapeHtml(it.id) + '" title="' +
                (it.initHidden ? '当前在玩家的先攻条中隐藏，点击显示' : '在玩家的先攻条中隐藏') + '">' + (it.initHidden ? '🙈' : '👁') + '</button>' : '') +
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
    case 'prep': startCombatWith('prep'); break;
    case 'ambush': startCombatWith('ambush'); break;
    case 'join': joinInit(selectedIds()); break;
    case 'custom': openActionDialog(null, attackerToken(), null); break;
    case 'roll': rollInit([b.dataset.id], e.shiftKey ? 'adv' : ''); break;
    case 'leave': leaveInit(b.dataset.id); break;
    case 'up': case 'down': moveInit(b.dataset.id, b.dataset.cact === 'up' ? -1 : 1); break;
    case 'setturn': op({ op: 'combat', action: 'set', ids: [b.dataset.id] }); break;
    case 'round':
        var cs = combatState();
        if (cs) op({ op: 'combat', action: 'round', round: Math.max(1, num(cs.round, 1) + parseInt(b.dataset.delta, 10)) });
        break;
    case 'inithide':
        var ih = scene.items[b.dataset.id];
        if (ih) patchItems([{ id: ih.id, initHidden: !ih.initHidden || null }]);
        renderCombat();
        renderCombatHud();
        break;
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
    var order = initOrder();
    if (c || order.length) {
        // 先攻条：所有人可见。玩家端没有被隐藏单位的数据；GM 端用暗色和 🙈 标出
        var idx = -1;
        order.forEach(function(t, i) { if (c && t.id === c.turn) idx = i; });
        var list = idx > 0 ? order.slice(idx).concat(order.slice(0, idx)) : order; // 从当前行动者开始
        var cur = c && scene.items[c.turn], curShown = cur && idx >= 0;
        var mine = cur && canEdit(cur);
        var portrait = initViewPortrait();
        var chips = list.map(function(t) {
            var down = (t.hpMax > 0 && num(t.hp, t.hpMax) <= 0) || hasStatus(t, 'dead');
            var cls = 'init-chip' + (c && t.id === c.turn ? ' active' : '') + (t.owner && t.owner === me.name ? ' mine' : '') +
                (t.hidden || initHiddenFor(t) ? ' hid' : '') + (down ? ' down' : '');
            var tip = escapeHtml((t.label || '未命名') + ' · 先攻 ' + num(t.init, 0) + (t.hidden ? ' · 地图上隐藏' : initHiddenFor(t) ? ' · 玩家看不到' : ''));
            var col = escapeHtml(t.color || (t.owner ? '#1e88e5' : '#c62828'));
            if (portrait) { // 带立绘：棋子图片 + 先攻值 + 名字
                return '<span class="' + cls + ' pt" data-focus="' + escapeHtml(t.id) + '" title="' + tip + '"><span class="pt-img" style="border-color:' + col + '">' +
                    (t.asset ? '<img src="' + escapeHtml(assetURL(t.asset)) + '" alt="" draggable="false">' : '<i style="background:' + col + '">' + escapeHtml((t.label || '?').slice(0, 1)) + '</i>') +
                    '<b>' + num(t.init, 0) + '</b>' + (t.hidden || initHiddenFor(t) ? '<em>🙈</em>' : '') + '</span><span class="nm">' + escapeHtml(chipName(t.label)) + '</span></span>';
            }
            return '<span class="' + cls + '" data-focus="' + escapeHtml(t.id) + '" title="' + tip + '">' +
                '<i style="background:' + escapeHtml(t.color || (t.owner ? '#1e88e5' : '#c62828')) + '">' + escapeHtml((t.label || '?').slice(0, 1)) + '</i>' +
                '<span class="nm">' + escapeHtml(chipName(t.label)) + '</span><b>' + num(t.init, 0) + '</b>' +
                (t.hidden || initHiddenFor(t) ? '🙈' : '') + '</span>';
        }).join('');
        // 每一行包在 .hud-line 里：外层容器不接收鼠标（不挡地图），行本身可点击
        parts.push('<div class="hud-line init-strip' + (portrait ? ' portrait' : '') + '"><span class="hud-grip" data-drag title="拖动移动先攻条（双击恢复默认位置）">⠿</span>' +
            '<span class="hud-round">' + (c ? '⚔ 第 ' + num(c.round, 1) + ' 轮' : '先攻') + '</span>' +
            (c && !curShown ? '<span class="init-chip active hid"><i>?</i><span class="nm">隐藏单位</span></span>' : '') +
            '<span class="init-chips">' + chips + '</span>' +
            (curShown && cur && isCreatureToken(cur) ? '<span class="hud-move" title="本回合已移动 / 速度">🏃 ' + fmtDist(movedThisTurn(cur)) + (tokenSpeed(cur) ? ' / ' + tokenSpeed(cur) : '') + '</span>' : '') +
            (curShown ? econHudHtml(cur) : '') +
            (curShown && cur.owner === me.name && isPC(cur) && cur.hpMax > 0 && num(cur.hp, cur.hpMax) <= 0 && !hasStatus(cur, 'dead') && !hasStatus(cur, 'stable') ?
                '<button class="tt-btn small" data-cact="death" title="0 生命值：掷死亡豁免">💀 死亡豁免</button>' : '') +
            (c && (me.gm || (mine && curShown)) ? '<button class="tt-btn small primary" data-cact="next" title="快捷键 N">' + (me.gm ? '下一位' : '结束回合') + '</button>' : '') +
            (c ? '<i class="hud-follow' + (gmPref('ttFollowTurn', true) ? ' on' : '') + '" data-cact="follow" title="镜头跟随当前行动者（点击开关）">🎥</i>' : '') +
            '<i class="hud-follow on" data-cact="initview" title="' + (portrait ? '切换到简化先攻条' : '切换到带立绘的先攻条') + '">' + (portrait ? '≡' : '🖼') + '</i></div>');
    }
    var tgt = targetToken();
    if (tgt) {
        var att = attackerToken(), ci = att ? coverInfo(att, tgt) : null;
        parts.push('<div class="hud-line hud-target">🎯 ' + escapeHtml(tgt.label || '目标') +
            (ci ? ' · ' + escapeHtml(fmtDist(ci.dist)) + ' · ' + escapeHtml(coverText(ci.level).replace(/（.*）/, '')) : '') +
            ' <i data-cact="untarget" title="取消目标">✕</i></div>');
    }
    hud.innerHTML = parts.join('');
    var wasHidden = hud.style.display === 'none';
    hud.style.display = parts.length ? '' : 'none';
    if (wasHidden && parts.length && combatFloat) combatFloat.reclamp(); // 拖过的位置在显示出来后再校正一次
}

// 先攻条上的名字：太长时截短，但保留末尾编号（「狗头人武者 2」→「狗头人…2」）
function chipName(label) {
    label = label || '未命名';
    if (label.length <= 6) return label;
    var m = label.match(/\s*(\d+)$/);
    return m ? label.slice(0, Math.max(2, 5 - m[1].length)) + '…' + m[1] : label.slice(0, 6);
}

function onCombatHudDblClick(e) {
    var f = e.target.closest('[data-focus]');
    if (f && me.gm && combatState()) op({ op: 'combat', action: 'set', ids: [f.dataset.focus] });
}

function onCombatHudClick(e) {
    var ec = e.target.closest('[data-econ]');
    if (ec) { toggleEcon(ec.dataset.econ); return; } // 动作经济（tabletop-fight.js）
    var f = e.target.closest('[data-focus]');
    if (f) { focusToken(f.dataset.focus); return; }
    var b = e.target.closest('[data-cact]');
    if (!b) return;
    if (b.dataset.cact === 'untarget') setTarget('');
    else if (b.dataset.cact === 'initview') toggleInitView();
    else combatAction(b.dataset.cact);
}

// 场景属性变化：回合切换到自己的棋子时提醒
function onCombatChanged() {
    var c = combatState(), turn = c ? c.turn + '#' + c.round : '';
    if (turn !== lastTurn) {
        var cur = c && scene.items[c.turn];
        if (lastTurn !== null && c) {
            if (cur && cur.owner === me.name) notice('⚔ 轮到你了：' + (cur.label || ''), false, 4000);
            else {
                // 下一位是自己的棋子：提前提醒
                var order = initOrder(), i = -1;
                order.forEach(function(t, k) { if (t.id === c.turn) i = k; });
                var nx = i >= 0 && order.length > 1 ? order[(i + 1) % order.length] : null;
                if (nx && nx.owner === me.name) notice('⏳ 下一个就是你：' + (nx.label || ''), false, 3500);
            }
            // 镜头跟随当前行动者（设置里可关）
            if (cur && visibleToMe(cur) && gmPref('ttFollowTurn', true) && canvas && !gesture && !actionMode) {
                var cc = tokenCenter(cur);
                view.x = canvas.clientWidth / 2 - cc.x * view.s;
                view.y = canvas.clientHeight / 2 - cc.y * view.s;
            }
        }
        lastTurn = turn;
    }
    renderCombat();
    renderCombatHud();
    renderBossBars();
}

function drawTurnRing() {
    var c = combatState(), it = c && scene.items[c.turn];
    if (!it) return;
    var bb = itemBBox(it), cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2, r = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0, gridSize() * 0.6) * 0.62;
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
    h += row('判定圈', '<input class="tt-input narrow" data-prop="hitR" type="number" min="0.25" step="0.25" value="' + (it.hitR > 0 ? it.hitR : '') +
        '" placeholder="' + defaultHitFt(it) + '"> 尺半径<span class="tt-hint">（距离、触及、范围按它算）</span>');
    var others = sortedItems().filter(function(t) { return t.kind === 'token' && t.id !== it.id && (t.label || '').trim(); });
    h += row('跟随', '<select class="tt-select" data-prop="follow" style="flex:1;min-width:0;"><option value="">（不跟随）</option>' + others.map(function(t) {
        return '<option value="' + escapeHtml(t.id) + '"' + (it.follow === t.id ? ' selected' : '') + '>' + escapeHtml(t.label) + '</option>';
    }).join('') + '</select>');
    h += row('速度', '<input class="tt-input narrow" data-prop="speed" type="number" min="0" step="5" value="' + (it.speed > 0 ? it.speed : '') + '" placeholder="' + (tokenSpeed(it) || '—') + '"> 尺' +
        (combatState() && combatState().turn === it.id ? '<span class="tt-hint">本回合已移动 ' + fmtDist(movedThisTurn(it)) + '</span>' : ''));
    h += row('阵营', '<select class="tt-select" data-prop="side" title="借机攻击按阵营判断：自动 = 玩家控制的是友方，GM 控制的是敌方">' +
        [['', '自动'], ['ally', '友方'], ['enemy', '敌方'], ['neutral', '中立']].map(function(o) { return '<option value="' + o[0] + '"' + ((it.side || '') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
        '</select><span class="tt-hint">触及</span><input class="tt-input narrow" data-prop="reach" type="number" min="0" step="5" value="' + (it.reach > 0 ? it.reach : '') + '" placeholder="' + meleeReach(it) + '"> 尺');
    h += row('AC', '<input class="tt-input narrow" data-prop="ac" type="number" min="0" value="' + (it.ac != null ? escapeHtml(String(it.ac)) : '') + '" placeholder="—">' +
        '<span class="tt-hint">' + (it.owner ? '' : '玩家看不到') + '</span>');
    if (inInit(it)) {
        h += row('先攻', '<input class="tt-input narrow" data-prop="init" type="number" value="' + num(it.init, 0) + '">' +
            '<span class="tt-hint">加值</span><input class="tt-input narrow" data-prop="initMod" type="number" value="' + (it.initMod != null ? it.initMod : '') + '" placeholder="' + initBonus(it) + '">' +
            '<button class="tt-btn small" data-act="initroll" title="掷先攻">🎲</button><button class="tt-btn small" data-act="initleave" title="移出先攻">✕</button>');
        if (me.gm) h += row('', '<label title="玩家的先攻条和战斗栏里看不到这个单位（地图上仍可见）"><input type="checkbox" data-prop="initHidden"' + (it.initHidden ? ' checked' : '') + '> 在玩家的先攻条中隐藏</label>');
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
    $('combatHud').addEventListener('dblclick', onCombatHudDblClick);
}
