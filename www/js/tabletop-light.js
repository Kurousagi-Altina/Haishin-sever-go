// ===== 光源：角色光源 + 环境光源 =====
// 角色光源：棋子的 light = { bright, dim, off }（尺），跟着棋子走；黑暗场景里总是照亮。
// 环境光源：item kind "light"（GM 用 💡 工具放，快捷键 G），x, y = 位置（火把标记）：
//   圆形   bright / dim（尺；和棋子一样被墙挡）
//   自画   pts = 相对 (x, y) 的多边形，dimOnly = 只是微光（不被墙挡：画多大就照多大）
//   off = 熄灭；showIcon = 玩家也看得到火把标记（默认隐藏：GM 在 💡 工具里 / 选中时才看得到）；name
//   trig = 感应范围（尺，像感应灯）：玩家角色在这个半径内、且和光源之间没有墙挡着才亮；不设 = 等于光照范围
// 环境光源只有在有玩家角色（有控制者的棋子，或关联了玩家角色卡的棋子）进入它的感应范围时才显现（照亮黑暗）。
// 黑暗只在场景开了「黑暗环境」+ 动态视野时生效（玩家视角 / GM 的玩家视角预览）。

var lightOpts = { mode: 'place' }; // place 放圆形光源 / area 画范围
var lightDraft = null; // 画范围：已经点下的点（世界坐标）
var LIGHT_PRESETS = [['20/20', '火把'], ['30/30', '提灯'], ['60/60', '牛眼提灯'], ['20/20', '光亮术'], ['60/60', '日光术'], ['5/5', '蜡烛'], ['0/40', '只有微光']];

function isLightItem(it) { return !!it && it.kind === 'light'; }
function lightTitle(L) { return (L && L.name) || '光源'; }
function sceneLightItems() { return sortedItems().filter(isLightItem); }
function lightIsArea(L) { return Array.isArray(L.pts) && L.pts.length >= 3; }
function lightPresetOpts(cur) {
    return '<option value="">预设</option>' + LIGHT_PRESETS.map(function(p) { return '<option value="' + p[0] + '">' + p[1] + '（' + p[0].replace('/', ' / ') + '）</option>'; }).join('');
}

function nextLightName() {
    var n = 0;
    sceneLightItems().forEach(function(L) { var m = /^光源(\d+)$/.exec(L.name || ''); if (m) n = Math.max(n, +m[1]); });
    return '光源' + (n + 1);
}

// 「玩家角色」：有控制者的棋子，或关联了玩家角色卡的棋子（不算对玩家隐藏的）
function partyLightTokens() {
    return sortedItems().filter(function(t) {
        return t.kind === 'token' && !t.hidden && !offField(t) && (t.owner || (t.sheet && sheets[t.sheet] && sheets[t.sheet].kind === 'pc'));
    });
}

// 环境光源的照亮范围：圆形 = 半径 + 视线多边形（墙挡）；自画 = 多边形
function envLightShape(L, segs, b) {
    if (lightIsArea(L)) {
        return { area: L.pts.map(function(q) { return [L.x + q[0], L.y + q[1]]; }), dimOnly: !!L.dimOnly, env: L.id };
    }
    var br = feetToPx(num(L.bright, 0)), all = feetToPx(num(L.bright, 0) + num(L.dim, 0));
    if (all <= 0) return null;
    return { x: L.x, y: L.y, bright: br, r: all, pts: visibilityPolygon(L.x, L.y, segs, b), env: L.id };
}

function lightCovers(S, x, y) {
    if (S.area) return pointInPoly(x, y, S.area);
    return Math.hypot(x - S.x, y - S.y) <= S.r && pointInPoly(x, y, S.pts);
}

// 黑暗场景的光照：角色光源全部 + 有玩家角色在范围里的环境光源（computeVision 调用）
function computeLights(segs, b) {
    var out = lightTokens().map(function(t) {
        var c = tokenCenter(t), br = feetToPx(num(t.light.bright, 0)), all = feetToPx(num(t.light.bright, 0) + num(t.light.dim, 0));
        return { x: c.x, y: c.y, bright: br, r: all, pts: visibilityPolygon(c.x, c.y, segs, b) };
    });
    var party = partyLightTokens().map(tokenCenter);
    sceneLightItems().forEach(function(L) {
        if (L.off) return;
        var S = envLightShape(L, segs, b);
        if (S && envLightTriggered(L, S, party, segs, b)) out.push(S);
    });
    return out;
}

// 感应：设了 trig = 玩家角色在 trig 尺内且光源看得到它（墙挡住不算）；没设 = 玩家角色在光照范围内（圆形光源同样被墙挡）
function envLightTriggered(L, S, party, segs, b) {
    var t = num(L.trig, 0);
    if (t > 0) {
        var r = feetToPx(t), near = party.filter(function(p) { return Math.hypot(p.x - L.x, p.y - L.y) <= r; });
        if (!near.length) return false;
        var los = S.pts && !S.area ? S.pts : visibilityPolygon(L.x, L.y, segs, b);
        return near.some(function(p) { return pointInPoly(p.x, p.y, los); });
    }
    return party.some(function(p) { return lightCovers(S, p.x, p.y); });
}

// 哪些环境光源现在被触发（亮着）：GM 在 💡 工具里看状态用（按光源 / 玩家角色位置 / 墙缓存）
var envLitCache = { key: '', ids: {} }, envLitNow = {};
function envLitIds() {
    var key = wallsVersion + '|' + lightsKey() + '|' + partyLightTokens().map(function(t) { return Math.round(t.x) + ',' + Math.round(t.y); }).join(';');
    if (envLitCache.key === key) return envLitCache.ids;
    var g = gridSize(), vb = typeof mapBounds === 'function' ? mapBounds() : null;
    var b = vb ? { x0: vb.x0 - g, y0: vb.y0 - g, x1: vb.x1 + g, y1: vb.y1 + g } : { x0: -20000, y0: -20000, x1: 20000, y1: 20000 };
    var segs = wallSegments(false), party = partyLightTokens().map(tokenCenter), ids = {};
    sceneLightItems().forEach(function(L) {
        if (L.off) return;
        var S = envLightShape(L, segs, b);
        if (S && envLightTriggered(L, S, party, segs, b)) ids[L.id] = true;
    });
    envLitCache = { key: key, ids: ids };
    return ids;
}

// 视野缓存的键：光源、环境光源和玩家角色的位置变了都要重算
function lightsKey() {
    var k = lightTokens().map(function(t) { return t.id + ',' + Math.round(t.x) + ',' + Math.round(t.y) + ',' + num(t.light.bright, 0) + ',' + num(t.light.dim, 0); }).join(';');
    var env = sceneLightItems().filter(function(L) { return !L.off; });
    if (env.length) {
        k += '|' + env.map(function(L) { return L.id + ',' + Math.round(L.x) + ',' + Math.round(L.y) + ',' + num(L.bright, 0) + ',' + num(L.dim, 0) + ',' + num(L.trig, 0) + ',' + (L.dimOnly ? 1 : 0) + ',' + JSON.stringify(L.pts || ''); }).join(';');
        k += '|' + partyLightTokens().map(function(t) { return Math.round(t.x) + ',' + Math.round(t.y); }).join(';');
    }
    return k;
}

// ===== 创建 =====
function newLightPreset() {
    var v = ($('lightPresetNew') && $('lightPresetNew').value) || '20/20', p = v.split('/');
    return { bright: +p[0] || 0, dim: +p[1] || 0 };
}

function createLightAt(w) {
    var pr = newLightPreset();
    var it = { id: genId(), kind: 'light', x: Math.round(w.x), y: Math.round(w.y), z: nextZ(), name: nextLightName() };
    if (pr.bright) it.bright = pr.bright;
    if (pr.dim) it.dim = pr.dim;
    createItems([it]);
    selectOnly([it.id]);
    lightSyncUI();
    if (!scene.props.dark) notice('已放「' + it.name + '」。场景还没开黑暗环境：在 💡 工具栏勾上「黑暗环境」后光源才起作用', false, 5000);
}

// 画范围：单击加点，点回第一个点 / 双击 / Enter 结束，右键回退一个点，Esc 取消
function lightAreaClick(w) {
    var g = gridSize();
    if (!lightDraft) lightDraft = [];
    if (lightDraft.length >= 3 && Math.hypot(w.x - lightDraft[0][0], w.y - lightDraft[0][1]) <= g * 0.3) { finishLightArea(); return; }
    lightDraft.push([Math.round(w.x), Math.round(w.y)]);
    lightSyncUI();
    requestRender();
}

function finishLightArea() {
    var d = lightDraft;
    lightDraft = null;
    if (!d || d.length < 3) { notice('至少点三个点才能围成范围', true); lightSyncUI(); requestRender(); return; }
    var cx = 0, cy = 0;
    d.forEach(function(q) { cx += q[0]; cy += q[1]; });
    cx = Math.round(cx / d.length); cy = Math.round(cy / d.length);
    var it = { id: genId(), kind: 'light', x: cx, y: cy, z: nextZ(), name: nextLightName(), pts: d.map(function(q) { return [q[0] - cx, q[1] - cy]; }) };
    createItems([it]);
    selectOnly([it.id]);
    lightSyncUI();
    requestRender();
}

function cancelLightArea() {
    if (!lightDraft) return false;
    lightDraft = null;
    lightSyncUI();
    requestRender();
    return true;
}

// ===== 绘制 =====
// 火把标记：GM 在 💡 工具里 / 选中时看得到，或者设了「玩家也看得到」；玩家只看得到设了显示的
function lightMarkerShown(L) {
    if (L.showIcon) return true;
    return me.gm && !$('fogPreview').checked && (tool === 'light' || !!selected[L.id]);
}

function drawLights(items) {
    var env = items.filter(isLightItem), g = gridSize();
    var gmTool = me.gm && !$('fogPreview').checked && tool === 'light';
    if (gmTool) { // 💡 工具里：所有光源的照亮范围（角色光源也画）
        items.forEach(function(it) {
            if (it.kind === 'token' && it.light && !it.light.off && num(it.light.bright, 0) + num(it.light.dim, 0) > 0) {
                var c = tokenCenter(it);
                drawLightRange(c.x, c.y, feetToPx(num(it.light.bright, 0)), feetToPx(num(it.light.bright, 0) + num(it.light.dim, 0)), 'rgba(129,212,250,');
            }
        });
    }
    envLitNow = env.length && me.gm ? envLitIds() : {};
    env.forEach(function(L) {
        var show = gmTool || (me.gm && selected[L.id] && !$('fogPreview').checked);
        if (show) {
            ctx.save();
            if (L.off) ctx.globalAlpha = 0.35;
            else if (!envLitNow[L.id]) ctx.globalAlpha = 0.55; // 没被触发：平时不亮
            if (lightIsArea(L)) {
                ctx.beginPath();
                L.pts.forEach(function(q, i) { if (i) ctx.lineTo(L.x + q[0], L.y + q[1]); else ctx.moveTo(L.x + q[0], L.y + q[1]); });
                ctx.closePath();
                ctx.fillStyle = L.dimOnly ? 'rgba(255,213,79,0.08)' : 'rgba(255,213,79,0.16)';
                ctx.fill();
                ctx.setLineDash([8 / view.s, 5 / view.s]);
                ctx.lineWidth = 2 / view.s;
                ctx.strokeStyle = 'rgba(255,213,79,0.85)';
                ctx.stroke();
                ctx.setLineDash([]);
            } else {
                drawLightRange(L.x, L.y, feetToPx(num(L.bright, 0)), feetToPx(num(L.bright, 0) + num(L.dim, 0)), 'rgba(255,213,79,');
            }
            if (num(L.trig, 0) > 0) { // 感应范围：绿色点线
                ctx.beginPath();
                ctx.arc(L.x, L.y, feetToPx(num(L.trig, 0)), 0, Math.PI * 2);
                ctx.setLineDash([3 / view.s, 5 / view.s]);
                ctx.lineWidth = 2 / view.s;
                ctx.strokeStyle = 'rgba(105,240,174,0.85)';
                ctx.stroke();
                ctx.setLineDash([]);
            }
            ctx.restore();
        }
        if (lightMarkerShown(L)) drawTorch(L, g);
    });
    if (lightDraft && lightDraft.length) { // 正在画的范围
        ctx.save();
        ctx.beginPath();
        lightDraft.forEach(function(q, i) { if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
        if (cursorWorld) ctx.lineTo(cursorWorld.x, cursorWorld.y);
        ctx.lineWidth = 2 / view.s;
        ctx.strokeStyle = '#ffd54f';
        ctx.setLineDash([6 / view.s, 4 / view.s]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffd54f';
        lightDraft.forEach(function(q, i) { ctx.beginPath(); ctx.arc(q[0], q[1], (i ? 3 : 5) / view.s, 0, Math.PI * 2); ctx.fill(); });
        ctx.restore();
    }
}

function drawLightRange(x, y, br, all, rgba) {
    if (all > 0) {
        ctx.beginPath();
        ctx.arc(x, y, all, 0, Math.PI * 2);
        ctx.fillStyle = rgba + '0.06)';
        ctx.fill();
        ctx.setLineDash([8 / view.s, 6 / view.s]);
        ctx.lineWidth = 1.5 / view.s;
        ctx.strokeStyle = rgba + '0.7)';
        ctx.stroke();
        ctx.setLineDash([]);
    }
    if (br > 0) {
        ctx.beginPath();
        ctx.arc(x, y, br, 0, Math.PI * 2);
        ctx.fillStyle = rgba + '0.10)';
        ctx.fill();
        ctx.lineWidth = 1.5 / view.s;
        ctx.strokeStyle = rgba + '0.9)';
        ctx.stroke();
    }
}

// 小火把：木柄 + 火焰（熄灭时灰掉；玩家看不到的标记加虚线圈）
function drawTorch(L, g) {
    var s = g * 0.42, x = L.x, y = L.y;
    ctx.save();
    if (L.hidden) ctx.globalAlpha = 0.5;
    if (me.gm && !L.showIcon) { // 只有 GM 看得到
        ctx.beginPath();
        ctx.arc(x, y, s * 0.75, 0, Math.PI * 2);
        ctx.setLineDash([4 / view.s, 3 / view.s]);
        ctx.lineWidth = 1.5 / view.s;
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.stroke();
        ctx.setLineDash([]);
    }
    if (selected[L.id]) {
        ctx.beginPath();
        ctx.arc(x, y, s * 0.85, 0, Math.PI * 2);
        ctx.lineWidth = 2.5 / view.s;
        ctx.strokeStyle = '#ffd54f';
        ctx.stroke();
    }
    ctx.lineCap = 'round'; // 木柄
    ctx.beginPath();
    ctx.moveTo(x + s * 0.18, y + s * 0.55);
    ctx.lineTo(x - s * 0.05, y - s * 0.05);
    ctx.lineWidth = s * 0.16;
    ctx.strokeStyle = '#6d4c41';
    ctx.stroke();
    ctx.beginPath(); // 火焰
    var fx = x - s * 0.1, fy = y - s * 0.2;
    ctx.moveTo(fx, fy - s * 0.5);
    ctx.quadraticCurveTo(fx + s * 0.32, fy - s * 0.1, fx + s * 0.12, fy + s * 0.12);
    ctx.quadraticCurveTo(fx, fy + s * 0.2, fx - s * 0.12, fy + s * 0.12);
    ctx.quadraticCurveTo(fx - s * 0.32, fy - s * 0.1, fx, fy - s * 0.5);
    ctx.fillStyle = L.off ? '#9e9e9e' : envLitNow[L.id] || !me.gm ? '#ff9800' : '#a1887f';
    ctx.fill();
    if (!L.off && (envLitNow[L.id] || !me.gm)) {
        ctx.beginPath();
        ctx.moveTo(fx, fy - s * 0.25);
        ctx.quadraticCurveTo(fx + s * 0.14, fy - s * 0.02, fx, fy + s * 0.1);
        ctx.quadraticCurveTo(fx - s * 0.14, fy - s * 0.02, fx, fy - s * 0.25);
        ctx.fillStyle = '#ffeb3b';
        ctx.fill();
    }
    ctx.restore();
    if (me.gm && (tool === 'light' || selected[L.id])) drawLabel(lightTitle(L) + (L.off ? '（熄灭）' : envLitNow[L.id] ? '（亮着）' : '（未触发）'), x, y + s * 0.6, L.off ? '#aaa' : envLitNow[L.id] ? '#ffe082' : '#bbb', true, true);
}

function lightHit(L, w) {
    return lightMarkerShown(L) && Math.hypot(w.x - L.x, w.y - L.y) <= gridSize() * 0.32 + 3 / view.s;
}

// ===== 工具栏：模式、列表（统一管理所有光源）=====
function setLightMode(m) {
    lightOpts.mode = m;
    cancelLightArea();
    lightSyncUI();
    updateCursor();
}

function lightSyncUI() {
    document.querySelectorAll('[data-lightmode]').forEach(function(b) { b.classList.toggle('active', b.dataset.lightmode === lightOpts.mode); });
    if ($('lightDarkTool')) $('lightDarkTool').checked = !!scene.props.dark;
    var hint = $('lightHint');
    if (hint) hint.textContent = lightOpts.mode === 'area' ?
        (lightDraft && lightDraft.length ? '已点 ' + lightDraft.length + ' 个点：继续点；点回第一个点 / 双击 / Enter 结束，右键回退，Esc 取消' : '逐点围出光照范围（不被墙挡）') :
        '单击地图放一个环境光源（火把标记默认只有你看得到）；拖动移动；右键点光源 = 菜单，右键点空地 = 撤回刚放的';
    if ($('lightList') && $('lightList').style.display !== 'none') renderLightList();
}

function lightRowsData() {
    var rows = [];
    sortedItems().forEach(function(it) {
        if (it.kind === 'token' && it.light && num(it.light.bright, 0) + num(it.light.dim, 0) > 0) rows.push({ kind: 'token', it: it });
        else if (isLightItem(it)) rows.push({ kind: 'env', it: it });
    });
    return rows;
}

function renderLightList() {
    var el = $('lightList');
    if (!el) return;
    var rows = lightRowsData();
    var num0 = function(v) { return v ? v : ''; };
    var h = '<div class="light-list-head"><b>本场景的光源（' + rows.length + '）</b>' +
        '<button class="tt-btn small" data-lact="allon">全部点亮</button><button class="tt-btn small" data-lact="alloff">全部熄灭</button></div>';
    var tokRows = rows.filter(function(r) { return r.kind === 'token'; }), envRows = rows.filter(function(r) { return r.kind === 'env'; });
    var row = function(r) {
        var it = r.it, L = r.kind === 'token' ? it.light : it, off = !!L.off, id = escapeHtml(it.id);
        var name = r.kind === 'token' ? ttTokenName(it) : lightTitle(it);
        var vals = r.kind === 'env' && lightIsArea(it) ?
            '<span class="tt-hint">自画范围</span><label class="tt-hint" title="只是微光（不勾 = 明亮）"><input type="checkbox" data-lf="dimOnly" data-lid="' + id + '"' + (it.dimOnly ? ' checked' : '') + '> 微光</label>' :
            '<input class="tt-input narrow" type="number" min="0" step="5" data-lf="bright" data-lid="' + id + '" value="' + num0(L.bright) + '" placeholder="明亮" title="明亮光照半径（尺）">' +
            '<input class="tt-input narrow" type="number" min="0" step="5" data-lf="dim" data-lid="' + id + '" value="' + num0(L.dim) + '" placeholder="微光" title="明亮之外再延伸的微光（尺）">' +
            '<select class="tt-select" data-lf="preset" data-lid="' + id + '">' + lightPresetOpts() + '</select>';
        return '<div class="light-row' + (off ? ' off' : '') + '"><span class="lname" title="' + escapeHtml(name) + '">' + (r.kind === 'token' ? '👤 ' : '🔥 ') + escapeHtml(name) + '</span>' + vals +
            '<button class="tt-btn small" data-lact="toggle" data-lid="' + id + '" title="' + (off ? '点亮' : '熄灭') + '">' + (off ? '点亮' : '熄灭') + '</button>' +
            (r.kind === 'env' ? '<button class="tt-btn small" data-lact="icon" data-lid="' + id + '" title="' + (it.showIcon ? '火把标记：玩家看得到（点击隐藏）' : '火把标记：只有 GM 看得到（点击对玩家显示）') + '">' + (it.showIcon ? '👁' : '🙈') + '</button>' : '') +
            '<button class="tt-btn small" data-lact="focus" data-lid="' + id + '" title="定位">📍</button>' +
            (r.kind === 'env' ? '<button class="tt-btn small danger" data-lact="del" data-lid="' + id + '" title="删除">✕</button>' : '') + '</div>';
    };
    h += '<div class="light-group">角色光源 <span class="tt-hint">跟着棋子走，总是照亮</span></div>' + (tokRows.length ? tokRows.map(row).join('') : '<div class="tt-hint">还没有：在棋子的属性面板里设「光源」</div>');
    h += '<div class="light-group">环境光源 <span class="tt-hint">有玩家角色进入感应范围（默认 = 光照范围，墙挡住不算）时才对玩家显现</span></div>' + (envRows.length ? envRows.map(row).join('') : '<div class="tt-hint">还没有：用上面的「放置」/「画范围」加</div>');
    if (!scene.props.vision) h += '<div class="tt-hint warn">场景没开动态视野：黑暗和光源都不会生效（⚙ 设置 → 动态视野）</div>';
    el.innerHTML = h;
}

function ttTokenName(t) { return t.label || (t.sheet && sheets[t.sheet] && sheets[t.sheet].name) || '棋子'; }

function lightPatchFor(it, fields) { // 角色光源改 token.light，环境光源改它自己
    if (it.kind === 'token') {
        var l = Object.assign({}, it.light || {});
        Object.keys(fields).forEach(function(k) { if (fields[k] == null) delete l[k]; else l[k] = fields[k]; });
        return { id: it.id, light: num(l.bright, 0) + num(l.dim, 0) > 0 ? l : null };
    }
    var p = { id: it.id };
    Object.keys(fields).forEach(function(k) { p[k] = fields[k]; });
    return p;
}

function onLightListChange(e) {
    var el = e.target, it = scene.items[el.dataset.lid];
    if (!it || !el.dataset.lf || !me.gm) return;
    var f = el.dataset.lf, fields = {};
    if (f === 'preset') { if (!el.value) return; var p = el.value.split('/'); fields.bright = +p[0] || null; fields.dim = +p[1] || null; }
    else if (f === 'bright' || f === 'dim') { var v = Math.max(0, Math.min(1000, parseInt(el.value, 10) || 0)); fields[f] = v || null; }
    else if (f === 'dimOnly') fields.dimOnly = el.checked || null;
    patchItems([lightPatchFor(it, fields)]);
    setTimeout(renderLightList, 0);
}

function onLightListClick(e) {
    var b = e.target.closest('[data-lact]');
    if (!b || !me.gm) return;
    var a = b.dataset.lact, it = b.dataset.lid && scene.items[b.dataset.lid];
    if (a === 'allon' || a === 'alloff') {
        var patches = [];
        lightRowsData().forEach(function(r) {
            var L = r.kind === 'token' ? r.it.light : r.it;
            if (!!L.off !== (a === 'alloff')) patches.push(lightPatchFor(r.it, { off: a === 'alloff' ? true : null }));
        });
        if (patches.length) patchItems(patches);
        notice(a === 'alloff' ? '已熄灭全部光源' : '已点亮全部光源');
    } else if (!it) {
        return;
    } else if (a === 'toggle') {
        var cur = it.kind === 'token' ? it.light || {} : it;
        patchItems([lightPatchFor(it, { off: cur.off ? null : true })]);
    } else if (a === 'icon') {
        patchItems([{ id: it.id, showIcon: it.showIcon ? null : true }]);
    } else if (a === 'focus') {
        var c = it.kind === 'token' ? tokenCenter(it) : { x: it.x, y: it.y };
        view.x = canvas.clientWidth / 2 - c.x * view.s;
        view.y = canvas.clientHeight / 2 - c.y * view.s;
        selectOnly([it.id]);
    } else if (a === 'del') {
        deleteItems([it.id]);
    }
    setTimeout(renderLightList, 0);
    requestRender();
}

// 💡 工具里右键轻点：画范围中 = 回退一个点；点到光源 = 菜单；空地 = 撤回自己刚放的光源
function lightRightTap(start) {
    if (lightDraft) {
        lightDraft.pop();
        if (!lightDraft.length) lightDraft = null;
        lightSyncUI();
        requestRender();
        return;
    }
    var hit = hitTest(start.w, ['light']);
    if (hit) { openTokenMenu(hit, start.s.x, start.s.y); return; }
    toolRightUndo('light');
}

// 键盘：画范围时 Enter 结束、Esc 取消、Backspace 回退
function lightKey(e) {
    if (!lightDraft || tool !== 'light') return false;
    if (e.key === 'Enter') { finishLightArea(); e.preventDefault(); return true; }
    if (e.key === 'Escape') { cancelLightArea(); e.preventDefault(); return true; }
    if (e.key === 'Backspace') { lightDraft.pop(); if (!lightDraft.length) lightDraft = null; lightSyncUI(); requestRender(); e.preventDefault(); return true; }
    return false;
}

// ===== 属性面板（选中环境光源）=====
function lightSelHtml(it) {
    var row = function(label, inner) { return '<div class="prop-row"><label>' + label + '</label>' + inner + '</div>'; };
    var h = row('名字', '<input class="tt-input" data-lt="name" maxlength="30" value="' + escapeHtml(it.name || '') + '" placeholder="光源" style="flex:1;">');
    if (lightIsArea(it)) {
        h += row('范围', '<span class="tt-hint">自己画的范围（不被墙挡）</span><label><input type="checkbox" data-lt="dimOnly"' + (it.dimOnly ? ' checked' : '') + '> 只是微光</label>');
    } else {
        h += row('光照', '<input class="tt-input narrow" data-lt="bright" type="number" min="0" step="5" value="' + (it.bright || '') + '" placeholder="明亮" title="明亮光照半径（尺）" style="width:52px;">' +
            '<input class="tt-input narrow" data-lt="dim" type="number" min="0" step="5" value="' + (it.dim || '') + '" placeholder="微光" title="明亮之外再延伸的微光（尺）" style="width:52px;">' +
            '<select class="tt-select" data-lt="preset" style="width:80px;">' + lightPresetOpts() + '</select>');
    }
    h += row('感应', '<input class="tt-input narrow" data-lt="trig" type="number" min="0" step="5" value="' + (it.trig || '') + '" placeholder="同光照" title="感应范围（尺）：玩家角色走进这个半径、而且和光源之间没有墙挡着，光源才亮；空着 = 等于光照范围" style="width:60px;"> 尺' +
        '<span class="tt-hint">（像感应灯；墙挡住不算）</span>');
    h += row('', '<label><input type="checkbox" data-lt="off"' + (it.off ? ' checked' : '') + '> 熄灭</label>' +
        '<label title="不勾 = 火把标记只有 GM 看得到（在 💡 工具里 / 选中时）"><input type="checkbox" data-lt="showIcon"' + (it.showIcon ? ' checked' : '') + '> 玩家看得到火把标记</label>');
    h += '<div class="tt-hint">环境光源只有在有玩家角色进入感应范围（默认 = 光照范围；墙挡住不算）时，才会照亮黑暗给玩家看。黑暗要在 💡 工具栏或 ⚙ 设置里开「黑暗环境」（还要开动态视野）。</div>';
    return h;
}

function lightSelChange(el) {
    if (!el.dataset.lt) return false;
    var ids = selectedIds(), it = ids.length === 1 && scene.items[ids[0]];
    if (!isLightItem(it) || !me.gm) return true;
    var p = { id: it.id }, f = el.dataset.lt;
    if (f === 'name') p.name = el.value.trim().slice(0, 30) || null;
    else if (f === 'bright' || f === 'dim' || f === 'trig') { var v = Math.max(0, Math.min(1000, parseInt(el.value, 10) || 0)); p[f] = v || null; }
    else if (f === 'preset') { if (!el.value) return true; var q = el.value.split('/'); p.bright = +q[0] || null; p.dim = +q[1] || null; }
    else if (f === 'dimOnly' || f === 'off' || f === 'showIcon') p[f] = el.checked || null;
    patchItems([p]);
    $('selPanel').dataset.ids = '';
    renderSelPanel();
    requestRender();
    return true;
}

function initLights() {
    var bar = $('optsLight');
    if (!bar) return;
    bar.addEventListener('click', function(e) {
        var b = e.target.closest('[data-lightmode]');
        if (b) { setLightMode(b.dataset.lightmode); return; }
        if (e.target.id === 'lightListBtn') {
            var el = $('lightList');
            el.style.display = el.style.display === 'none' ? '' : 'none';
            if (el.style.display !== 'none') renderLightList();
        }
    });
    $('lightDarkTool').addEventListener('change', function() { setProps({ dark: this.checked || null }); });
    $('lightList').addEventListener('change', onLightListChange);
    $('lightList').addEventListener('click', onLightListClick);
    lightSyncUI();
}
