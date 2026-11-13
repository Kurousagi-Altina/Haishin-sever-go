// 跑团桌面：其余地图与房间功能
// - 六角格（横排 / 竖排）：画格、吸附格心、按格数测距
// - 尺子拐点：单击开始逐点测量，双击 / 右键 / Enter 结束（拖动仍是一段直尺）
// - 文字物件、暗门（玩家看不到也打不开）
// - 黑暗环境与光源：只有被光照到、或在黑暗视觉范围内的地方才看得见
// - 战斗准备 / 伏击横幅、时间停止、传送门、变身、短休
// - 共享背景音乐、房间级玩家权限、记录里一键重掷
// 依赖 tabletop.js 与其他 tabletop-*.js 的全局状态与函数

// ===== 六角格 =====
function isHex() { var t = scene.props.gridType; return t === 'hexRows' || t === 'hexCols'; }

// 世界坐标 → 小数轴坐标（g = 相邻格心距离）
function hexAxial(x, y) {
    var g = gridSize(), p = scene.props, ox = num(p.gridOffX, 0), oy = num(p.gridOffY, 0), k = Math.sqrt(3) / 2;
    x -= ox; y -= oy;
    if (p.gridType === 'hexCols') { var q = x / (g * k); return { q: q, r: y / g - q / 2 }; }
    var r = y / (g * k);
    return { q: x / g - r / 2, r: r };
}

function hexRound(a) {
    var x = a.q, z = a.r, y = -x - z, rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
    var dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dy <= dz) rz = -rx - ry;
    return { q: rx, r: rz };
}

function hexToWorld(h) {
    var g = gridSize(), p = scene.props, k = Math.sqrt(3) / 2;
    if (p.gridType === 'hexCols') return { x: num(p.gridOffX, 0) + h.q * g * k, y: num(p.gridOffY, 0) + (h.r + h.q / 2) * g };
    return { x: num(p.gridOffX, 0) + (h.q + h.r / 2) * g, y: num(p.gridOffY, 0) + h.r * g * k };
}

function hexCenterNear(x, y) { return hexToWorld(hexRound(hexAxial(x, y))); }

function hexDist(ax, ay, bx, by) {
    var a = hexRound(hexAxial(ax, ay)), b = hexRound(hexAxial(bx, by));
    return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
}

function drawHexGrid(x0, y0, x1, y1) {
    var g = gridSize(), s = g / Math.sqrt(3), cols = scene.props.gridType === 'hexCols';
    var a = hexAxial(x0, y0), b = hexAxial(x1, y1), c = hexAxial(x0, y1), d = hexAxial(x1, y0);
    var qs = [a.q, b.q, c.q, d.q], rs = [a.r, b.r, c.r, d.r];
    var q0 = Math.floor(Math.min.apply(null, qs)) - 1, q1 = Math.ceil(Math.max.apply(null, qs)) + 1;
    var r0 = Math.floor(Math.min.apply(null, rs)) - 1, r1 = Math.ceil(Math.max.apply(null, rs)) + 1;
    if ((q1 - q0) * (r1 - r0) > 20000) return;
    ctx.beginPath();
    for (var q = q0; q <= q1; q++) {
        for (var r = r0; r <= r1; r++) {
            var c0 = hexToWorld({ q: q, r: r });
            if (c0.x < x0 - g || c0.x > x1 + g || c0.y < y0 - g || c0.y > y1 + g) continue;
            for (var i = 0; i <= 6; i++) {
                var ang = Math.PI / 3 * i + (cols ? 0 : Math.PI / 6);
                var px = c0.x + s * Math.cos(ang), py = c0.y + s * Math.sin(ang);
                if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
            }
        }
    }
}

// ===== 尺子拐点 =====
var rulerPath = null; // { pts:[{x,y}...], b:{x,y} } 单击模式

function rulerPoint(w, alt) { return alt ? { x: w.x, y: w.y } : cellCenter(w.x, w.y); }

function rulerPathDist(points) {
    var total = 0, g = gridSize();
    for (var i = 1; i < points.length; i++) {
        var a = points[i - 1], b = points[i];
        if (isHex()) total += hexDist(a.x, a.y, b.x, b.y);
        else total += gridSteps(Math.round(Math.abs(b.x - a.x) / g * 1000) / 1000, Math.round(Math.abs(b.y - a.y) / g * 1000) / 1000);
    }
    return stepsToUnits(total);
}

function drawRulerPath(points, color, who) {
    if (points.length < 2) return;
    if (!isHex() && gridSize() * view.s >= 8) {
        for (var i = 1; i < points.length; i++) drawRulerCells(points[i - 1], points[i], color);
    }
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3 / view.s;
    ctx.setLineDash([10 / view.s, 6 / view.s]);
    ctx.beginPath();
    points.forEach(function(p, i) { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
    ctx.stroke();
    ctx.setLineDash([]);
    points.forEach(function(p) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 / view.s, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
    });
    ctx.restore();
    // 每段的距离小标签 + 终点总距离
    if (points.length > 2) {
        for (var k = 1; k < points.length - 1; k++) drawLabel(fmtDist(rulerPathDist([points[k - 1], points[k]])), points[k].x, points[k].y, '#ddd');
    }
    var end = points[points.length - 1];
    drawLabel((who ? who + '：' : '') + (points.length > 2 ? '共 ' : '') + fmtDist(rulerPathDist(points)), end.x, end.y, color);
}

function rulerPathPoints() { return rulerPath ? rulerPath.pts.concat([rulerPath.b]) : []; }

function sendRulerPath() {
    var pts = rulerPathPoints();
    sendFx({ t: 'ruler', a: [pts[0].x, pts[0].y], b: [rulerPath.b.x, rulerPath.b.y], p: pts.slice(0, -1).map(function(p) { return [p.x, p.y]; }) });
}

function endRulerPath() {
    if (!rulerPath) return;
    rulerPath = null;
    sendFx({ t: 'ruler-end' });
    requestRender();
}

// ===== 文字物件 =====
function textFont(it) { return 'bold ' + Math.max(6, num(it.size, gridSize() * 0.45)) + 'px sans-serif'; }

function textBBox(it) {
    ctx.save();
    ctx.font = textFont(it);
    var lines = String(it.text || '').split('\n'), size = num(it.size, gridSize() * 0.45);
    var w = Math.max.apply(null, lines.map(function(l) { return ctx.measureText(l).width; }).concat([size]));
    ctx.restore();
    return { x0: it.x || 0, y0: it.y || 0, x1: (it.x || 0) + w, y1: (it.y || 0) + lines.length * size * 1.25 };
}

function drawTextItem(c, it) {
    var size = num(it.size, gridSize() * 0.45);
    c.save();
    c.font = textFont(it);
    c.textBaseline = 'top';
    c.lineJoin = 'round';
    c.lineWidth = Math.max(2, size * 0.12);
    c.strokeStyle = 'rgba(0,0,0,0.75)';
    c.fillStyle = it.color || '#ffffff';
    String(it.text || '').split('\n').forEach(function(line, i) {
        c.strokeText(line, it.x || 0, (it.y || 0) + i * size * 1.25);
        c.fillText(line, it.x || 0, (it.y || 0) + i * size * 1.25);
    });
    c.restore();
}

function createTextAt(w) {
    var text = prompt('输入文字（换行用 \\n）：');
    if (!text || !text.trim()) return;
    var it = { id: genId(), kind: 'draw', shape: 'text', x: w.x, y: w.y, text: text.replace(/\\n/g, '\n').slice(0, 500),
        size: Math.round(gridSize() * 0.45), color: drawOpts.color, z: nextZ() };
    createItems([it]);
    selectOnly([it.id]);
}

// ===== 黑暗环境与光源 =====
// 光源：棋子的 light = { bright, dim }（尺）。黑暗场景下，玩家只看得见视线内且被光照到、
// 或在黑暗视觉（棋子「视野」距离）范围内的地方；明亮光照完全可见，微光处半暗。
var litCanvas = null, litCtx = null;

function lightTokens() {
    return sortedItems().filter(function(t) { return t.kind === 'token' && t.light && (num(t.light.bright, 0) + num(t.light.dim, 0)) > 0; });
}

function computeLights(segs, b) {
    return lightTokens().map(function(t) {
        var c = tokenCenter(t), br = feetToPx(num(t.light.bright, 0)), all = feetToPx(num(t.light.bright, 0) + num(t.light.dim, 0));
        return { x: c.x, y: c.y, bright: br, r: all, pts: visibilityPolygon(c.x, c.y, segs, b) };
    });
}

function fillClipped(c, x, y, r, pts) {
    c.save();
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.clip();
    c.beginPath();
    pts.forEach(function(q, i) { if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); });
    c.closePath();
    c.fill();
    c.restore();
}

// 在 vctx 的黑暗层上挖出：每个观察者的视线范围 ∩（光照 ∪ 黑暗视觉）
function cutDarkness(polys) {
    if (!litCanvas) { litCanvas = document.createElement('canvas'); litCtx = litCanvas.getContext('2d'); }
    if (litCanvas.width !== canvas.width || litCanvas.height !== canvas.height) { litCanvas.width = canvas.width; litCanvas.height = canvas.height; }
    var lights = polys.lights || [];
    [['dim', 0.62], ['bright', 1]].forEach(function(pass) {
        polys.forEach(function(v) {
            litCtx.setTransform(1, 0, 0, 1, 0, 0);
            litCtx.globalCompositeOperation = 'source-over';
            litCtx.clearRect(0, 0, litCanvas.width, litCanvas.height);
            applyView(litCtx);
            litCtx.fillStyle = '#000';
            lights.forEach(function(L) {
                var r = pass[0] === 'dim' ? L.r : L.bright;
                if (r > 0) fillClipped(litCtx, L.x, L.y, r, L.pts);
            });
            if (pass[0] === 'dim' && v.r) { litCtx.beginPath(); litCtx.arc(v.x, v.y, v.r, 0, Math.PI * 2); litCtx.fill(); } // 黑暗视觉
            litCtx.globalCompositeOperation = 'destination-in';
            litCtx.beginPath();
            v.pts.forEach(function(q, i) { if (i) litCtx.lineTo(q[0], q[1]); else litCtx.moveTo(q[0], q[1]); });
            litCtx.closePath();
            litCtx.fill();
            vctx.save();
            vctx.setTransform(1, 0, 0, 1, 0, 0);
            vctx.globalCompositeOperation = 'destination-out';
            vctx.globalAlpha = pass[1];
            vctx.drawImage(litCanvas, 0, 0);
            vctx.restore();
        });
    });
}

function inLight(x, y, polys) {
    return (polys.lights || []).some(function(L) { return Math.hypot(x - L.x, y - L.y) <= L.r && pointInPoly(x, y, L.pts); });
}

// ===== 横幅 / 时间停止 =====
function showBanner(text, color) {
    var el = $('bannerFx');
    el.textContent = text;
    el.style.color = color || '#ffd54f';
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
}

function startCombatWith(kind) {
    var text = kind === 'ambush' ? '⚠ 伏击！' : '⚔ 准备战斗！';
    showBanner(text, kind === 'ambush' ? '#ef5350' : '#ffd54f');
    sendFx({ t: 'banner', text: text, color: kind === 'ambush' ? '#ef5350' : '#ffd54f' });
    if (kind === 'ambush') op({ op: 'chat', text: '⚠ 伏击！被突袭的生物以劣势进行先攻检定（2024 规则）' });
    var order = initOrder();
    var unrolled = order.filter(function(t) { return !t.initRolled && canEdit(t) && autoInitOK(t); }).map(function(t) { return t.id; });
    var waiting = order.filter(function(t) { return !t.initRolled && t.manualInit; }); // 设为自己掷先攻的：不替他们掷
    if (unrolled.length) rollInit(unrolled);
    if (waiting.length) {
        sendFx({ t: 'initask' }); // 让这些角色的玩家弹提示
        notice('⏳ 等待 ' + waiting.map(function(t) { return t.label || '未命名'; }).join('、') + ' 自己掷先攻；都掷完后点「开始战斗」', false, 10000);
        renderCombat();
        return;
    }
    setTimeout(function() { op({ op: 'combat', action: 'start' }); }, unrolled.length ? 700 : 0);
}

function roomSetting(key, def) {
    var s = room.settings || {};
    return s[key] == null ? def : s[key];
}

function setRoomSetting(key, value) {
    var o = {};
    o[key] = value;
    room.settings = room.settings || {};
    if (value == null) delete room.settings[key]; else room.settings[key] = value;
    op({ op: 'room.settings', props: o });
    applyRoomSettings();
}

function timeStopped() { return !!roomSetting('timeStop', false); }

function applyRoomSettings() {
    var ts = timeStopped();
    $('timeStopFx').style.display = ts ? '' : 'none';
    $('timeStopFx').querySelector('.ts-text').textContent = me.gm ? '⏸ 时间停止中（玩家无法操作地图）' : '⏸ 时间停止';
    var btn = $('timeStopBtn');
    if (btn) { btn.classList.toggle('primary', ts); btn.textContent = ts ? '▶ 恢复时间' : '⏸ 时间停止'; }
    ['playerTokens', 'playerDraw', 'playerMoveOthers', 'playerDoors'].forEach(function(k) {
        var el = $('perm_' + k);
        if (el && document.activeElement !== el) el.checked = roomSetting(k, true) !== false;
    });
    var drawBtn = document.querySelector('.tool-btn[data-tool="draw"]');
    if (drawBtn) drawBtn.style.display = !me.gm && roomSetting('playerDraw', true) === false ? 'none' : '';
    applyMusic();
    renderMusicPanel();
}

// ===== 传送门 =====
function portalOf(it) { return it && it.kind === 'token' && it.portal && typeof it.portal === 'object' ? it.portal : null; }

function drawPortal(it) {
    var p = portalOf(it);
    if (!p) return;
    var c = tokenCenter(it), r = num(p.r, gridSize() * 0.6), t = performance.now() / 1000;
    ctx.save();
    ctx.strokeStyle = '#b388ff';
    ctx.lineWidth = 3 / view.s;
    ctx.setLineDash([r * 0.5, r * 0.25]);
    ctx.lineDashOffset = -t * r;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    if (me.gm) drawLabel('⭘ 传送门 ' + (p.tag || ''), c.x, c.y - r - 22 / view.s, '#d1c4e9');
}

// 棋子停在传送门上：选择目的地后由服务器传送（隐藏的传送门可以当作单向出口）
function checkPortals(movedIds) {
    if (movedIds.length !== 1) return;
    var tok = scene.items[movedIds[0]];
    if (!tok || tok.kind !== 'token' || portalOf(tok) || !isCreatureToken(tok)) return;
    var c = tokenCenter(tok);
    var gate = sortedItems().filter(function(p) {
        var po = portalOf(p);
        if (!po || (p.hidden && !me.gm)) return false;
        var pc = tokenCenter(p);
        return Math.hypot(c.x - pc.x, c.y - pc.y) <= num(po.r, gridSize() * 0.6);
    })[0];
    if (!gate) return;
    var tag = portalOf(gate).tag || '';
    var dests = sortedItems().filter(function(p) { return p.id !== gate.id && portalOf(p) && (portalOf(p).tag || '') === tag; });
    var target = '';
    if (dests.length > 1) {
        var choice = prompt('传送到哪里？\n' + dests.map(function(d, i) { return (i + 1) + '. ' + (d.label || '传送门 ' + (i + 1)); }).join('\n'), '1');
        if (choice == null) return;
        var d = dests[parseInt(choice, 10) - 1];
        if (!d) { notice('没有这个选项', true); return; }
        target = d.id;
    } else if (!confirm('进入传送门「' + (gate.label || tag || '传送门') + '」？')) return;
    else if (dests.length === 1) target = dests[0].id;
    var ids = [tok.id];
    op({ op: 'portal', scene: gate.id, ids: ids, target: target });
}

// ===== 变身 =====
// 把当前形态压栈后换成另一张卡的数值（HP、AC、体型、名字，可选外观图片）；「恢复」逐层退回
function transformToken(it, sheetId, assetId) {
    var sh = sheets[sheetId];
    if (!sh) return;
    var keep = ['sheet', 'label', 'hp', 'hpMax', 'hpTemp', 'ac', 'fp', 'w', 'h', 'x', 'y', 'asset', 'hitR'];
    var form = {};
    keep.forEach(function(k) { if (it[k] != null) form[k] = it[k]; });
    var p = { id: it.id, forms: (it.forms || []).concat([form]).slice(-5), sheet: sh.id, label: (it.forms && it.forms.length ? it.forms[0].label : it.label) + '（' + sh.name + '）' };
    var max = sh.hp ? num(sh.hp.max, 0) : 0;
    if (max > 0) { p.hp = max; p.hpMax = max; p.hpTemp = null; }
    var ac = parseFloat(sh.ac);
    if (ac > 0) p.ac = ac;
    var cells = sheetSizeCells(sh) || 1;
    p.fp = cells;
    p.hitR = null;
    var fit = fitTokenToCells(it, cells);
    p.w = fit.w; p.h = fit.h; p.x = fit.x; p.y = fit.y;
    if (assetId) p.asset = assetId;
    patchItems([p]);
    notice('「' + (it.label || '') + '」变身为「' + sh.name + '」');
}

function revertToken(it) {
    var forms = (it.forms || []).slice();
    var f = forms.pop();
    if (!f) return;
    var p = { id: it.id, forms: forms.length ? forms : null };
    ['sheet', 'label', 'hp', 'hpMax', 'hpTemp', 'ac', 'fp', 'w', 'h', 'asset', 'hitR'].forEach(function(k) { p[k] = f[k] != null ? f[k] : null; });
    // 原地恢复（保持当前位置，按原大小居中）
    var c = tokenCenter(it), g = gridSize();
    p.x = c.x - (f.w || g) / 2;
    p.y = c.y - (f.h || g) / 2;
    patchItems([p]);
}

function transformPanelHtml(it, row) {
    var list = Object.keys(sheets).map(function(id) { return sheets[id]; }).filter(function(sh) { return sh.kind !== 'item' && sh.id !== it.sheet; });
    if (!list.length && !(it.forms && it.forms.length)) return '';
    var imgs = (room.assets || []).filter(function(a) { return a.kind === 'token'; });
    return row('变身', '<select class="tt-select" data-tfsheet style="flex:1;min-width:0;"><option value="">选择形态…</option>' +
        list.map(function(sh) { return '<option value="' + escapeHtml(sh.id) + '">' + escapeHtml(sh.name) + '</option>'; }).join('') + '</select>' +
        (imgs.length ? '<select class="tt-select" data-tfasset style="width:70px;" title="变身后的外观（可不选）"><option value="">外观</option>' +
            imgs.map(function(a) { return '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + '</option>'; }).join('') + '</select>' : '') +
        '<button class="tt-btn small" data-act="transform">变</button>' +
        (it.forms && it.forms.length ? '<button class="tt-btn small" data-act="revert" title="恢复上一个形态">恢复</button>' : ''));
}

// ===== 短休：花费生命骰回血 =====
function shortRest(it) {
    var sh = it.sheet && sheets[it.sheet];
    var m = sh && String(sh.hd || '').match(/(\d+)\s*\/\s*(\d+)\s*(?:d(\d+))?/i);
    var cur = m ? parseInt(m[1], 10) : 0, max = m ? parseInt(m[2], 10) : 0, die = m && m[3] ? parseInt(m[3], 10) : 0;
    if (!die) {
        var d = prompt('生命骰是几面骰？（如 8 表示 d8）', '8');
        if (!d) return;
        die = parseInt(d, 10);
        if (!(die >= 4 && die <= 12)) { notice('生命骰面数不对', true); return; }
    }
    var n = prompt('花费几个生命骰？' + (max ? '（剩余 ' + cur + ' / ' + max + '）' : ''), '1');
    if (!n) return;
    n = parseInt(n, 10);
    if (!(n > 0) || (max && n > cur)) { notice('生命骰不够', true); return; }
    var con = 0;
    if (sh && sh.abilities) {
        var ab = sh.abilities.filter(function(a) { return a.key === 'con' || a.name === '体质'; })[0];
        if (ab) con = num(String(ab.mod || '0').replace('+', ''), 0);
    }
    var expr = n + 'd' + die + (con ? signed(con * n) : '');
    op({ op: 'action', act: { name: '短休（' + n + ' 个生命骰）', kind: 'heal', damage: expr, targets: [{ id: it.id }] } });
    if (sh && max && canEditSheet(sh)) op({ op: 'sheet', sheet: { id: sh.id, hd: (cur - n) + '/' + max + ' d' + die } });
}

// ===== 共享背景音乐 =====
var bgm = null, bgmKey = '';

function musicVolume() { try { return parseFloat(localStorage.getItem('ttVolume') || '0.6'); } catch (e) { return 0.6; } }

function applyMusic() {
    var m = roomSetting('music', null);
    if (!bgm) { bgm = new Audio(); bgm.preload = 'auto'; }
    var muted = false;
    try { muted = localStorage.getItem('ttMuted') === '1'; } catch (e) { muted = false; }
    bgm.volume = Math.max(0, Math.min(1, musicVolume()));
    bgm.muted = muted;
    var bar = $('musicBar');
    if (!m || !m.playing || !m.asset) {
        if (!bgm.paused) bgm.pause();
        bgmKey = '';
        bar.style.display = 'none';
        return;
    }
    bar.style.display = '';
    $('musicName').textContent = '🎵 ' + (m.name || '背景音乐');
    $('musicMute').textContent = muted ? '🔇' : '🔊';
    $('musicVol').value = String(musicVolume());
    var key = m.asset + '|' + (m.at || '');
    bgm.loop = m.loop !== false;
    if (key !== bgmKey) {
        bgmKey = key;
        bgm.src = assetURL(m.asset);
        bgm.currentTime = 0;
    }
    if (bgm.paused) {
        bgm.play().then(function() { $('musicUnlock').style.display = 'none'; }).catch(function() { $('musicUnlock').style.display = ''; });
    }
}

function renderMusicPanel() {
    var el = $('musicPanel');
    if (!el) return;
    var cur = roomSetting('music', null) || {};
    var tracks = (room.assets || []).filter(function(a) { return a.kind === 'audio'; });
    el.innerHTML = (tracks.length ? tracks.map(function(a) {
        var on = cur.playing && cur.asset === a.id;
        return '<div class="sheet-row"><div class="info"><div class="name">' + (on ? '▶ ' : '') + escapeHtml(a.name) + '</div></div>' +
            '<button class="tt-btn small' + (on ? ' primary' : '') + '" data-mplay="' + escapeHtml(a.id) + '">' + (on ? '重新播放' : '播放') + '</button></div>';
    }).join('') : '<div class="tt-hint">还没有音乐，点上面的按钮上传 MP3 / OGG / WAV / M4A。</div>') +
        (cur.playing ? '<div class="lobby-row" style="gap:6px;"><button class="tt-btn small danger" data-mstop="1">停止</button>' +
            '<label><input type="checkbox" data-mloop' + (cur.loop !== false ? ' checked' : '') + '> 循环</label></div>' : '');
}

function onMusicPanel(e) {
    var b = e.target.closest('[data-mplay], [data-mstop], [data-mloop]');
    if (!b) return;
    var cur = roomSetting('music', null) || {};
    if (b.dataset.mplay) {
        var a = (room.assets || []).filter(function(x) { return x.id === b.dataset.mplay; })[0];
        setRoomSetting('music', { asset: b.dataset.mplay, name: a ? a.name : '', playing: true, loop: cur.loop !== false, at: Date.now() });
    } else if (b.dataset.mstop) setRoomSetting('music', null);
    else if (b.dataset.mloop != null && e.type === 'change') { cur.loop = b.checked; setRoomSetting('music', cur); }
}

function uploadMusic(input) {
    var files = Array.prototype.slice.call(input.files || []);
    input.value = '';
    files.forEach(function(file) {
        notice('正在上传 ' + file.name + '...');
        uploadAsset(file, 'audio').then(function() { notice('已上传 ' + file.name); }).catch(apiError);
    });
}

// ===== 记录：重掷 =====
function onLogClick(e) {
    var fb = e.target.closest('[data-oa],[data-ssave],[data-dot],[data-concsave],[data-lause],[data-mst],[data-shove],[data-sa],[data-cs],[data-hr],[data-ft],[data-oaspell],[data-cx],[data-psv]');
    if (fb && fightLogClick(fb)) return; // 战斗提示（tabletop-fight.js）
    var tg = e.target.closest('[data-trigfocus],[data-trigact]');
    if (tg) { dmLogClick(tg); return; } // 触发区域提示（tabletop-dm.js）
    var rb = e.target.closest('[data-react]');
    if (rb) { useReaction(rb); return; }
    var u = e.target.closest('[data-undo]');
    if (u) {
        if (confirm('撤销这次结算？目标的生命值、临时生命、状态和死亡豁免会恢复到结算前。')) op({ op: 'action.undo', text: u.dataset.undo });
        return;
    }
    var b = e.target.closest('[data-reroll]');
    if (!b) return;
    roll(b.dataset.reroll, b.dataset.label || '', b.dataset.hidden === '1');
}

// ===== 棋子快捷菜单（右键 / 触屏长按）=====
var tokMenuEl = null;
function closeTokenMenu() { if (tokMenuEl) { tokMenuEl.remove(); tokMenuEl = null; } }


// ===== 绘制的缩放 / 旋转（和棋子一样：选中后四角等比缩放、顶上的圆点旋转；直接改写坐标，撤销可回退）=====
var DX_KEYS = ['x', 'y', 'points', 'r', 'width', 'size', 'shape'];
function drawXformable(it) { return !!it && it.kind === 'draw' && !it.zone && !it.locked && canEdit(it); }

function drawHandles(it) {
    var b = itemBBox(it), pad = 6 / view.s, c = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
    var x0 = b.x0 - pad, y0 = b.y0 - pad, x1 = b.x1 + pad, y1 = b.y1 + pad;
    var corners = [[x0, y0, -1, -1], [x1, y0, 1, -1], [x1, y1, 1, 1], [x0, y1, -1, 1]].map(function(q) { return { x: q[0], y: q[1], k: [q[2], q[3]] }; });
    var top = { x: c.x, y: y0 };
    return { id: it.id, c: c, a: 0, r: 6 / view.s, corners: corners, top: top, draw: true, box: [x0, y0, x1, y1],
        rot: it.shape === 'text' ? null : { x: c.x, y: y0 - 28 / view.s } };
}

// 从原始几何 o 出发，绕 c 缩放 s 倍、旋转 deg 度，写回 it
function drawXformApply(it, o, c, s, deg) {
    var a = deg * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    var tf = function(x, y) { var dx = (x - c.x) * s, dy = (y - c.y) * s; return [c.x + dx * cos - dy * sin, c.y + dx * sin + dy * cos]; };
    var ox = o.x || 0, oy = o.y || 0, anc = tf(ox, oy);
    it.x = r1(anc[0]); it.y = r1(anc[1]);
    if (o.shape === 'text') { it.size = r1(Math.max(4, num(o.size, gridSize() * 0.45) * s)); return; }
    if (o.width != null) it.width = Math.max(0.5, r1(o.width * s));
    if (o.shape === 'circle') { it.r = r1((o.r || 0) * s); return; }
    var pts = o.points || [];
    if (o.shape === 'cone') { // 顶点在 x,y，points[0] 是指向锥底中心的向量
        it.points = pts.map(function(p) { return [r1((p[0] * cos - p[1] * sin) * s), r1((p[0] * sin + p[1] * cos) * s)]; });
        return;
    }
    it.shape = o.shape;
    if (o.shape === 'rect' && Math.round(deg) % 360 !== 0) { pts = shapePoints({ shape: 'rect', points: pts }); it.shape = 'poly'; } // 转过的矩形改成四边形
    it.points = pts.map(function(p) { var q = tf(ox + p[0], oy + p[1]); return [r1(q[0] - it.x), r1(q[1] - it.y)]; });
}

function dxPatch(it) {
    var p = { id: it.id };
    DX_KEYS.forEach(function(k) { if (k in it) p[k] = it[k]; });
    return p;
}

function dxStart(hh, start) {
    var it = scene.items[hh.h.id], o = {};
    DX_KEYS.forEach(function(k) { if (k in it) o[k] = JSON.parse(JSON.stringify(it[k])); });
    var c = hh.h.c, p = hh.kind === 'rot' ? hh.h.rot : hh.corner;
    return { type: 'dxform', mode: hh.kind === 'rot' ? 'rot' : 'scale', start: start, id: it.id, ids: idSet([it.id]), orig: o, c: c,
        a0: Math.atan2(p.y - c.y, p.x - c.x), d0: Math.hypot(p.x - c.x, p.y - c.y) || 1, s: 1, deg: 0, lastSent: 0,
        snap: snapshotItems([it.id], DX_KEYS) };
}

function dxMove(g, w, e) {
    var it = scene.items[g.id];
    if (!it) return;
    if (g.mode === 'scale') {
        g.s = Math.max(0.05, Math.hypot(w.x - g.c.x, w.y - g.c.y) / g.d0);
        if (e.shiftKey) g.s = Math.max(0.25, Math.round(g.s * 4) / 4); // Shift：按 0.25 倍吸附
    } else {
        var deg = (Math.atan2(w.y - g.c.y, w.x - g.c.x) - g.a0) * 180 / Math.PI;
        g.deg = e.altKey ? Math.round(deg) : Math.round(deg / 15) * 15; // 默认吸附 15°，Alt 自由
    }
    drawXformApply(it, g.orig, g.c, g.s, g.deg);
    if (performance.now() - g.lastSent > 80) { g.lastSent = performance.now(); queueItems([dxPatch(it)]); }
}

function dxEnd(g) {
    var it = scene.items[g.id];
    if (!it || !g.start.moved) return;
    queueItems([dxPatch(it)]);
    pushUndo(g.snap || []);
}

function dxLabel(g) {
    return g.mode === 'scale' ? '×' + (Math.round(g.s * 100) / 100) : (((g.deg % 360) + 360) % 360) + '°';
}

// 右键轻点 / 触屏长按：点到已选中的多个物件之一（或选区范围里的空地）→ 批量菜单；点到单个物件 → 它的菜单
function rightTapMenu(w, sx, sy) {
    var sel = selectedIds(), rh = hitTest(w, me.gm ? ['token', 'note', 'trigger', 'draw'] : ['token', 'draw']);
    if (sel.length > 1 && (rh ? selected[rh.id] : pointInSelection(w, sel))) { openItemsMenu(sel, sx, sy); return true; }
    if (rh) { openTokenMenu(rh, sx, sy); return true; }
    return false;
}

function pointInSelection(w, ids) {
    var b = null;
    ids.forEach(function(id) {
        var it = scene.items[id];
        if (!it || it.kind === 'wall') return;
        var r = itemBBox(it);
        b = b ? { x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) } : r;
    });
    return !!b && w.x >= b.x0 && w.x <= b.x1 && w.y >= b.y0 && w.y <= b.y1;
}

function itemKindName(it) {
    if (it.kind === 'token') return it.label || '棋子';
    if (it.kind === 'note') return '笔记' + (it.title ? '：' + it.title : '');
    if (it.kind === 'trigger') return '触发区域' + (it.label ? '：' + it.label : '');
    if (it.kind === 'fog') return '迷雾';
    if (it.kind === 'wall') return '墙';
    if (it.zone) return '区域：' + (it.label || '');
    if (it.shape === 'text') return '文字：' + String(it.text || '').slice(0, 12);
    return ({ pen: '画笔', line: '直线', rect: '矩形', circle: '圆形', cone: '锥形', poly: '多边形' })[it.shape] || '绘制';
}

function showItemMenu(h, sx, sy, data) {
    var el = document.createElement('div');
    el.className = 'token-menu';
    el.innerHTML = h;
    for (var k in data) el.dataset[k] = data[k];
    $('stage').appendChild(el);
    var st = $('stage');
    el.style.left = Math.max(4, Math.min(sx, st.clientWidth - el.offsetWidth - 4)) + 'px';
    el.style.top = Math.max(4, Math.min(sy, st.clientHeight - el.offsetHeight - 4)) + 'px';
    tokMenuEl = el;
    el.addEventListener('pointerdown', function(e) { e.stopPropagation(); });
    el.addEventListener('click', onTokenMenu);
    el.addEventListener('change', onTokenMenu);
    el.addEventListener('keydown', function(e) {
        e.stopPropagation();
        if (e.key === 'Enter' && e.target.dataset.tmAmt !== undefined) el.querySelector('[data-tm=dmg]').click();
        if (e.key === 'Escape') closeTokenMenu();
    });
    return el;
}

// 框选后的批量菜单
function openItemsMenu(ids, sx, sy) {
    closeTokenMenu();
    var items = ids.map(function(id) { return scene.items[id]; }).filter(Boolean);
    var edit = items.filter(function(it) { return canEdit(it); });
    var h = '<div class="tm-title">已选 ' + items.length + ' 个物件</div>';
    if (edit.length) h += '<button data-tm="bdel" class="tm-danger">🗑 删除' + (edit.length < items.length ? '可删的 ' : '这 ') + edit.length + ' 个</button>';
    if (me.gm) {
        var anyShown = items.some(function(it) { return !it.hidden; }), anyFree = items.some(function(it) { return !it.locked; });
        h += '<button data-tm="bhide">' + (anyShown ? '🙈 全部对玩家隐藏' : '👁 全部对玩家显示') + '</button>' +
            '<button data-tm="block">' + (anyFree ? '🔒 全部锁定' : '🔓 全部解锁') + '</button>';
    }
    h += '<button data-tm="bnone">✖ 取消选择</button>';
    showItemMenu(h, sx, sy, { ids: items.map(function(it) { return it.id; }).join(',') });
}

// 批量删除：删得多（> 3）或有在先攻里的，按钮要再点一次确认（内嵌浏览器会吞掉 confirm）
function menuBatchDelete(b, ids) {
    var del = ids.filter(function(id) { return scene.items[id] && canEdit(scene.items[id]); });
    if (!del.length) return true;
    var fighters = del.filter(function(id) { return inInit(scene.items[id]); }).length;
    if ((del.length > 3 || fighters) && !b.dataset.armed) {
        b.dataset.armed = '1';
        b.textContent = '⚠ 再点一次删除 ' + del.length + ' 个' + (fighters ? '（' + fighters + ' 个在先攻里）' : '');
        return false;
    }
    deleteItems(del);
    selectOnly([]);
    notice('已删除 ' + del.length + ' 个物件，Ctrl+Z 撤销');
    return true;
}

function openTokenMenu(it, sx, sy) {
    closeTokenMenu();
    if (!it) return;
    if (it.kind !== 'token') { openOtherMenu(it, sx, sy); return; }
    var edit = canEdit(it), h = '<div class="tm-title">' + escapeHtml(it.label || '棋子') + '</div>';
    if (edit && it.hpMax > 0) h += '<div class="tm-row"><input class="tt-input narrow" data-tm-amt type="number" min="0" placeholder="数值">' +
        '<button class="tt-btn small danger" data-tm="dmg">伤害</button><button class="tt-btn small" data-tm="heal">治疗</button></div>';
    if (edit) h += '<div class="tm-row"><select class="tt-select" data-tm-status><option value="">＋ 添加状态…</option>' +
        STATUS_DEFS.map(function(d) { return '<option value="' + d.id + '">' + d.icon + ' ' + d.name + '</option>'; }).join('') + '</select></div>';
    h += '<button data-tm="target">' + (target.id === it.id ? '✖ 取消目标' : '🎯 设为目标') + '</button>';
    if (edit && isCreatureToken(it)) h += '<button data-tm="init">' + (inInit(it) ? '🎲 重掷先攻' : '⚔ 加入先攻并掷骰') + '</button>';
    if (edit) h += '<button data-tm="act">⚡ 以它行动…</button>';
    if (it.sheet && sheets[it.sheet]) h += '<button data-tm="sheet">📜 查看角色卡</button>';
    if (me.gm) h += '<button data-tm="hide">' + (it.hidden ? '👁 对玩家显示' : '🙈 对玩家隐藏') + '</button>' +
        '<button data-tm="lock">' + (it.locked ? '🔓 解锁' : '🔒 锁定位置') + '</button>';
    if (edit) h += '<button data-tm="del" class="tm-danger">🗑 删除</button>';
    var el = showItemMenu(h, sx, sy, { id: it.id });
    var amt = el.querySelector('[data-tm-amt]');
    if (amt && e2IsMouse()) amt.focus();
}

// 绘制 / 文字 / 区域 / 笔记 / 触发区域的右键菜单
function openOtherMenu(it, sx, sy) {
    var edit = canEdit(it), h = '<div class="tm-title">' + escapeHtml(itemKindName(it)) + '</div>';
    if (it.kind === 'draw' && it.zone && edit) h += '<button data-tm="zone">⚡ 对区域内的生物结算</button>';
    if (it.kind === 'draw' && edit && !it.zone && !it.locked) h += '<div class="tm-hint">' + (it.shape === 'text' ? '选中后拖四角缩放' : '选中后拖四角缩放、拖顶上的圆点旋转') + '</div>';
    if (me.gm && it.kind === 'draw') h += '<button data-tm="hide">' + (it.hidden ? '👁 对玩家显示' : '🙈 对玩家隐藏') + '</button>';
    if (me.gm) h += '<button data-tm="lock">' + (it.locked ? '🔓 解锁' : '🔒 锁定位置') + '</button>';
    if (edit && it.kind === 'draw') h += '<button data-tm="top">⬆ 移到最上层</button><button data-tm="bottom">⬇ 移到最下层</button>';
    if (edit) h += '<button data-tm="del" class="tm-danger">🗑 删除</button>';
    else h += '<div class="tm-hint">这是别人画的，不能修改</div>';
    showItemMenu(h, sx, sy, { id: it.id });
}
function e2IsMouse() { return !window.matchMedia || !window.matchMedia('(pointer: coarse)').matches; }

function onTokenMenu(e) {
    if (tokMenuEl && tokMenuEl.dataset.ids) { // 批量菜单
        var bb = e.type === 'click' && e.target.closest('[data-tm]');
        if (!bb) return;
        var ids = tokMenuEl.dataset.ids.split(',').filter(function(id) { return scene.items[id]; }), bk = bb.dataset.tm;
        if (bk === 'bdel' && !menuBatchDelete(bb, ids)) return;
        if (bk === 'bhide') {
            var hideAll = ids.some(function(id) { return !scene.items[id].hidden; });
            patchItems(ids.map(function(id) { return { id: id, hidden: hideAll || null }; }));
        }
        if (bk === 'block') {
            var lockAll = ids.some(function(id) { return !scene.items[id].locked; });
            patchItems(ids.map(function(id) { return { id: id, locked: lockAll || null }; }));
        }
        if (bk === 'bnone') selectOnly([]);
        closeTokenMenu();
        requestRender();
        return;
    }
    var it = tokMenuEl && scene.items[tokMenuEl.dataset.id];
    if (!it) { closeTokenMenu(); return; }
    if (e.type === 'change' && e.target.dataset.tmStatus !== undefined) {
        if (e.target.value) addStatus(it, e.target.value);
        closeTokenMenu();
        return;
    }
    var b = e.type === 'click' && e.target.closest('[data-tm]');
    if (!b) return;
    var act2 = b.dataset.tm;
    if (act2 === 'dmg' || act2 === 'heal') {
        var n = Math.abs(parseInt(tokMenuEl.querySelector('[data-tm-amt]').value, 10) || 0);
        if (!n) { notice('先填写数值', true); return; }
        patchItems([tokenHpPatch(it, act2 === 'dmg' ? -n : n)]);
    } else if (act2 === 'target') setTarget(target.id === it.id ? '' : it.id);
    else if (act2 === 'init') rollInit([it.id]);
    else if (act2 === 'act') { selectOnly([it.id]); openActionDialog(null, it, it.sheet && sheets[it.sheet] || null); }
    else if (act2 === 'sheet') openSheet(it.sheet, it.id);
    else if (act2 === 'hide') patchItems([{ id: it.id, hidden: !it.hidden || null }]);
    else if (act2 === 'lock') patchItems([{ id: it.id, locked: !it.locked || null }]);
    else if (act2 === 'zone') zoneRetrigger(it);
    else if (act2 === 'top' || act2 === 'bottom') {
        var zs = sortedItems().filter(function(x) { return x.id !== it.id && x.kind === it.kind; }).map(function(x) { return x.z || 0; });
        patchItems([{ id: it.id, z: act2 === 'top' ? (zs.length ? Math.max.apply(null, zs) + 1 : 0) : (zs.length ? Math.min.apply(null, zs) - 1 : 0) }]);
    }
    else if (act2 === 'del') {
        if (inInit(it) && !confirm('「' + (it.label || '棋子') + '」在先攻里，确定删除？')) return;
        deleteItems([it.id]);
        notice('已删除，Ctrl+Z 撤销');
    }
    closeTokenMenu();
}

function initExtra() {
    $('musicPanel').addEventListener('click', onMusicPanel);
    $('musicPanel').addEventListener('change', onMusicPanel);
    $('musicMute').addEventListener('click', function() {
        var m = false;
        try { m = localStorage.getItem('ttMuted') === '1'; localStorage.setItem('ttMuted', m ? '0' : '1'); } catch (e2) { /* 无痕模式 */ }
        applyMusic();
    });
    $('musicVol').addEventListener('input', function() {
        try { localStorage.setItem('ttVolume', this.value); } catch (e2) { /* 无痕模式 */ }
        if (bgm) bgm.volume = parseFloat(this.value);
    });
    $('musicUnlock').addEventListener('click', function() { applyMusic(); });
    $('logList').addEventListener('click', onLogClick);
    initFloatWins();
    ['playerTokens', 'playerDraw', 'playerMoveOthers', 'playerDoors'].forEach(function(k) {
        $('perm_' + k).addEventListener('change', function() { setRoomSetting(k, this.checked ? null : false); });
    });
    $('timeStopBtn').addEventListener('click', function() { setRoomSetting('timeStop', timeStopped() ? null : true); });
    $('setGridType').addEventListener('change', function() { setProps({ gridType: this.value === 'square' ? null : this.value }); });
    $('setDark').addEventListener('change', function() { setProps({ dark: this.checked || null }); });
}

// ===== 角色状态栏 =====
// 右上角：自己控制的角色（GM：选中的棋子，没选就看当前行动者）的生命值、增益 / 减益、专注的法术与留在地图上的区域
var SB_BUFFS = { blessed: 1, hasted: 1, dodging: 1, raging: 1, bardic: 1, guidance: 1, advantage: 1, invisible: 1, hidden: 1, stable: 1 };
var sbCollapsed = false, sbBound = false;
try { sbCollapsed = localStorage.getItem('ttStatusBar') === 'min'; } catch (e) { /* 无痕模式等 */ }

// 已分配的角色（棋子或它的角色卡分配给了玩家）常驻显示：选目标、施法时清掉选择也不会消失
function sbAssignedTo(t) {
    var sh = t.sheet && sheets[t.sheet];
    return t.owner || (sh && sh.kind === 'pc' && sh.owner) || '';
}

function statusBarTokens() {
    if (!scene || !scene.items) return [];
    var toks = sortedItems().filter(function(t) { return t.kind === 'token'; }), list = [], seen = {};
    var add = function(t) { if (t && t.kind === 'token' && !seen[t.id]) { seen[t.id] = 1; list.push(t); } };
    if (me.gm) {
        toks.forEach(function(t) { if (sbAssignedTo(t)) add(t); });
        var cs = actionMode && actionMode.caster; // 正在施法 / 行动的角色（棋子对象）
        if (cs) add(scene.items[typeof cs === 'string' ? cs : cs.id]);
        selectedIds().forEach(function(id) { add(scene.items[id]); });
        var c = combatState();
        if (c) add(scene.items[c.turn]);
    } else {
        toks.forEach(function(t) { if (sbAssignedTo(t) === me.name) add(t); });
    }
    return list.slice(0, 10);
}

function sbStatusChip(s) {
    var d = STATUS_BY_ID[s.id] || {};
    var name = s.name || d.name || s.id, icon = s.icon || d.icon || '•';
    var extra = (s.lv ? ' ' + s.lv + '级' : '') + (s.rounds ? ' ·' + s.rounds + '轮' : '');
    return '<span class="sb-chip ' + (SB_BUFFS[s.id] ? 'buff' : 'debuff') + '" title="' + escapeHtml((d.desc || name) + (s.rounds ? '（还剩 ' + s.rounds + ' 轮）' : '')) + '">' +
        escapeHtml(icon + ' ' + name + extra) + '</span>';
}

function renderStatusBar() {
    var el = $('statusBar');
    if (!el) return;
    var toks = typeof roomId !== 'undefined' && roomId ? statusBarTokens() : [];
    if (!toks.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
    if (!sbBound) { sbBound = true; el.addEventListener('click', onStatusBarClick); el.addEventListener('pointerdown', function(e) { e.stopPropagation(); }); }
    var mb = $('musicBar');
    el.style.top = (mb && mb.style.display !== 'none' ? 52 : 10) + 'px';
    el.style.display = '';
    var c = combatState(), h = '<div class="sb-top"><b>角色状态</b><button class="sb-min" data-sb="min" title="' + (sbCollapsed ? '展开' : '收起') + '">' + (sbCollapsed ? '▸' : '▾') + '</button></div>';
    if (!sbCollapsed) h += toks.map(function(t) {
        var st = Array.isArray(t.status) ? t.status : [];
        var conc = st.filter(function(s) { return s.id === 'concentration'; })[0];
        var zones = sortedItems().filter(function(z) { return z.zone && z.zone.conc === t.id && seeable(z); });
        var others = sortedItems().filter(function(z) { return z.zone && !z.zone.conc && z.zone.caster === t.id && seeable(z); });
        var hp = '';
        if (t.hpMax > 0) {
            var pct = Math.max(0, Math.min(100, (t.hp || 0) / t.hpMax * 100));
            hp = '<span class="sb-hp">' + (t.hpPct ? Math.round(t.hp || 0) + '%' : hpNumText(t)) + '</span>';
            hp += '</div><div class="sb-hpbar"><i style="width:' + pct + '%;background:' + (pct > 50 ? '#43a047' : pct > 25 ? '#fbc02d' : '#e53935') + '"></i>';
        }
        var x = '<div class="sb-card' + (c && c.turn === t.id ? ' cur' : '') + '"><div class="sb-head"><a class="sb-name" data-sbfocus="' + t.id + '" title="选中并居中">' +
            escapeHtml(t.label || '未命名') + '</a>' + hp + '</div>';
        if (conc || zones.length) {
            var names = zones.map(function(z) { return '<a data-sbzone="' + z.id + '" title="选中这个区域（之后在区域里任意一点拖动即可移动）">' + escapeHtml(z.label || '区域') + '</a>'; });
            if (!names.length && conc && conc.spell) names.push(escapeHtml(conc.spell));
            x += '<div class="sb-conc">🧠 专注：' + (names.join('、') || '（未记录法术）') +
                (canEdit(t) && conc ? ' <button class="sb-x" data-sbendconc="' + t.id + '" title="结束专注（留在地图上的专注区域会一起移除）">✕</button>' : '') + '</div>';
        }
        if (others.length) x += '<div class="sb-conc">✨ 区域：' + others.map(function(z) { return '<a data-sbzone="' + z.id + '">' + escapeHtml(z.label || '区域') + '</a>'; }).join('、') + '</div>';
        var chips = st.filter(function(s) { return s.id !== 'concentration'; });
        chips.sort(function(a, b) { return (SB_BUFFS[a.id] ? 0 : 1) - (SB_BUFFS[b.id] ? 0 : 1); });
        x += chips.length ? '<div class="sb-st">' + chips.map(sbStatusChip).join('') + '</div>' : '<div class="sb-st sb-none">无状态</div>';
        return x + '</div>';
    }).join('');
    el.innerHTML = h;
}

function onStatusBarClick(e) {
    var a = e.target.closest('[data-sbfocus],[data-sbzone],[data-sbendconc],[data-sb]');
    if (!a) return;
    if (a.dataset.sb === 'min') {
        sbCollapsed = !sbCollapsed;
        try { localStorage.setItem('ttStatusBar', sbCollapsed ? 'min' : ''); } catch (err) { /* ignore */ }
        renderStatusBar();
        return;
    }
    if (a.dataset.sbfocus) { focusToken(a.dataset.sbfocus); return; }
    if (a.dataset.sbzone) {
        var z = scene.items[a.dataset.sbzone];
        if (!z) return;
        var s = zoneShapeOf(z), cx = s.type === 'circle' || s.type === 'ring' ? s.x : null, cy = cx != null ? s.y : null;
        if (cx == null && s.pts && s.pts.length) {
            cx = s.pts.reduce(function(v, p) { return v + p[0]; }, 0) / s.pts.length;
            cy = s.pts.reduce(function(v, p) { return v + p[1]; }, 0) / s.pts.length;
        }
        if (cx != null) { view.x = canvas.clientWidth / 2 - cx * view.s; view.y = canvas.clientHeight / 2 - cy * view.s; }
        selectOnly([z.id]);
        if (canMove(z)) notice('已选中「' + (z.label || '区域') + '」：在区域里任意一点拖动即可移动', false, 3000);
        return;
    }
    if (a.dataset.sbendconc) {
        var t = scene.items[a.dataset.sbendconc];
        if (!t || !canEdit(t)) return;
        if (!confirm('结束「' + (t.label || '') + '」的专注？留在地图上的专注区域会一起移除。')) return;
        patchItems([{ id: t.id, status: (t.status || []).filter(function(s) { return s.id !== 'concentration'; }) }]);
    }
}


// ===== 可拖动的浮窗（历史记录、先攻条）=====
// 位置 / 大小 / 收起状态只存在本机（localStorage，读写失败就用默认位置）；双击把手恢复默认位置
function floatLoad(key) { try { return JSON.parse(localStorage.getItem('ttFloat:' + key) || 'null') || {}; } catch (e) { return {}; } }
function floatSave(key, st) { try { localStorage.setItem('ttFloat:' + key, JSON.stringify(st)); } catch (e) { /* ignore */ } }

function makeFloat(el, key, opts) {
    opts = opts || {};
    var st = floatLoad(key);
    var parent = el.parentElement;
    function clampApply() {
        if (st.l == null) { el.style.left = el.style.top = el.style.right = el.style.bottom = el.style.transform = ''; if (opts.keepWidth) el.style.width = ''; return; }
        var pw = parent.clientWidth, ph = parent.clientHeight, l = st.l, t = st.t;
        // 默认靠左右两边撑开宽度的（先攻条）：拖走后保持拖动前的宽度，内容多了在条内横向滚动
        if (opts.keepWidth && st.w) el.style.width = (pw ? Math.min(st.w, pw - 10) : st.w) + 'px';
        if (pw && ph) { // 画布还没显示（在大厅）时先按记下的位置放，进房后再校正
            l = Math.max(0, Math.min(st.l, pw - Math.min(el.offsetWidth || 60, pw)));
            t = Math.max(0, Math.min(st.t, ph - 30));
        }
        el.style.left = l + 'px'; el.style.top = t + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'none';
    }
    if (opts.resizable) {
        if (st.w) el.style.width = st.w + 'px';
        if (st.h) el.style.height = st.h + 'px';
        if (window.ResizeObserver) {
            var timer = null;
            new ResizeObserver(function() {
                if (el.classList.contains('min') || !el.offsetWidth) return;
                clearTimeout(timer);
                timer = setTimeout(function() { st.w = el.offsetWidth; st.h = el.offsetHeight; floatSave(key, st); }, 300);
            }).observe(el);
        }
    }
    if (opts.minimizable && st.min) el.classList.add('min');
    clampApply();
    var drag = null;
    el.addEventListener('pointerdown', function(e) {
        e.stopPropagation(); // 不要让地图收到（平移 / 选择）
        var h = e.target.closest('[data-drag]');
        if (!h || e.button !== 0 || e.target.closest('button, input, select, [data-cact], [data-focus], [data-fw]')) return;
        drag = { x: e.clientX, y: e.clientY, l: el.offsetLeft, t: el.offsetTop, id: e.pointerId };
        if (opts.keepWidth && !st.w) st.w = el.offsetWidth;
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        e.preventDefault();
    });
    el.addEventListener('pointermove', function(e) {
        if (!drag || e.pointerId !== drag.id) return;
        st.l = drag.l + e.clientX - drag.x; st.t = drag.t + e.clientY - drag.y;
        clampApply();
    });
    function end(e) {
        if (!drag || e.pointerId !== drag.id) return;
        drag = null;
        st.l = el.offsetLeft; st.t = el.offsetTop;
        floatSave(key, st);
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', function(e) {
        if (!e.target.closest('[data-drag]') || e.target.closest('button, [data-focus], [data-cact]')) return;
        delete st.l; delete st.t; if (opts.keepWidth) delete st.w; floatSave(key, st); clampApply();
    });
    el.addEventListener('click', function(e) {
        var b = e.target.closest('[data-fw="min"]');
        if (!b) return;
        el.classList.toggle('min');
        st.min = el.classList.contains('min'); floatSave(key, st);
        b.textContent = st.min ? '▸' : '▾';
        if (!st.min && el.id === 'logWin') { var ll = $('logList'); ll.scrollTop = ll.scrollHeight; }
    });
    var mb = el.querySelector('[data-fw="min"]');
    if (mb) mb.textContent = st.min ? '▸' : '▾';
    window.addEventListener('resize', clampApply);
    return { reclamp: clampApply };
}

var combatFloat = null, logFloat = null;
function initFloatWins() {
    logFloat = makeFloat($('logWin'), 'log', { resizable: true, minimizable: true });
    combatFloat = makeFloat($('combatHud'), 'initiative', { keepWidth: true });
}
function reclampFloats() { if (logFloat) logFloat.reclamp(); if (combatFloat) combatFloat.reclamp(); }

// 先攻条样式：带立绘（默认）/ 简化，只存在本机
function initViewPortrait() { try { return localStorage.getItem('ttInitView') !== 'simple'; } catch (e) { return true; } }
function toggleInitView() {
    try { localStorage.setItem('ttInitView', initViewPortrait() ? 'simple' : 'portrait'); } catch (e) { /* ignore */ }
    renderCombatHud();
}
