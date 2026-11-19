// ===== 传送门（item kind "portal"，服务器在 backend/tabletop_portal.go）=====
// GM 用 🌀 工具（快捷键 O）放置：单击地图放一个，「🔗 连线」模式里先点出发的门、再点要去的门 = 单向通路（Shift = 双向）。
// 选中传送门在属性面板里设置：名字（可只给 GM 看）、手动 / 自动、自动判定圈、目标（可多个）、指定 / 随机。
// 使用：手动 = 角色在传送门一格以内时点击传送门；自动 = 角色走进判定圈（拖动 / 方向键）立刻传送。

var portalOpts = { mode: 'place' }; // place 放置 / link 连线
var portalLinkSrc = '';

function isPortal(it) { return !!it && it.kind === 'portal'; }
function portalSize(p) { return Math.max(0.25, Math.min(20, num(p && p.size, 1))); } // 直径（格），默认 1 格
function portalR(p) { return gridSize() * portalSize(p) / 2; }
function portalAutoR(p) { return num(p.r, gridSize() * 0.5); }
function portalTitle(p) { return (p && p.name) || '传送门'; }
function scenePortals() { return sortedItems().filter(isPortal); }

function nextPortalName() {
    var n = 0;
    scenePortals().forEach(function(p) { var m = /^传送门(\d+)$/.exec(p.name || ''); if (m) n = Math.max(n, +m[1]); });
    return '传送门' + (n + 1);
}

function createPortalAt(w) {
    var it = { id: genId(), kind: 'portal', x: Math.round(w.x), y: Math.round(w.y), z: nextZ(), name: nextPortalName() };
    if ($('portalAutoNew') && $('portalAutoNew').checked) { it.mode = 'auto'; it.r = Math.round(gridSize() * 0.5); }
    createItems([it]);
    selectOnly([it.id]);
    portalSyncUI();
}

// ===== 绘制 =====
function drawPortals(items) {
    var ports = items.filter(isPortal);
    if (!ports.length) return;
    var gmView = me.gm && !$('fogPreview').checked;
    if (gmView) { // 通路箭头：🌀 工具里全部显示，平时只显示选中传送门的
        var showAll = tool === 'portal';
        ports.forEach(function(p) {
            (p.to || []).forEach(function(id) {
                var q = scene.items[id];
                if (!isPortal(q) || q.id === p.id) return;
                var hot = selected[p.id] || selected[q.id] || portalLinkSrc === p.id;
                if (showAll || hot) drawPortalLink(p, q, hot);
            });
        });
    }
    ports.forEach(function(p) {
        var r = portalR(p);
        ctx.save();
        if (p.hidden) ctx.globalAlpha = 0.5;
        if (p.mode === 'auto') { // 自动传送的判定圈
            ctx.beginPath();
            ctx.arc(p.x, p.y, portalAutoR(p), 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(179,136,255,0.10)';
            ctx.fill();
            ctx.setLineDash([8 / view.s, 6 / view.s]);
            ctx.lineWidth = 2 / view.s;
            ctx.strokeStyle = 'rgba(179,136,255,0.85)';
            ctx.stroke();
            ctx.setLineDash([]);
        }
        var grd = ctx.createRadialGradient(p.x, p.y, r * 0.1, p.x, p.y, r);
        grd.addColorStop(0, 'rgba(237,231,246,0.85)');
        grd.addColorStop(0.55, 'rgba(149,117,205,0.55)');
        grd.addColorStop(1, 'rgba(94,53,177,0.25)');
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.92, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();
        ctx.lineWidth = 3 / view.s;
        ctx.strokeStyle = '#b388ff';
        ctx.stroke();
        ctx.beginPath(); // 漩涡
        for (var k = 0; k <= 40; k++) {
            var a = k / 40 * Math.PI * 3.2, rr = r * 0.78 * k / 40;
            var x = p.x + Math.cos(a) * rr, y = p.y + Math.sin(a) * rr;
            if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.lineWidth = 2 / view.s;
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.stroke();
        if (selected[p.id] || portalLinkSrc === p.id) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, r + 4 / view.s, 0, Math.PI * 2);
            ctx.lineWidth = 2.5 / view.s;
            ctx.strokeStyle = portalLinkSrc === p.id ? '#ffd54f' : '#ffffff';
            ctx.stroke();
        }
        ctx.restore();
        var name = gmView ? portalTitle(p) + (p.nameHidden ? ' 🙈' : '') + ((p.to || []).length ? '' : ' ⚠') : p.name;
        if (name) drawLabel(name, p.x, p.y + r, p.hidden ? '#ba68c8' : '#d1c4e9', true, true);
    });
}

function drawPortalLink(p, q, hot) {
    var dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy);
    if (len < 1) return;
    var ux = dx / len, uy = dy / len, off = 5 / view.s, ra = portalR(p) + 4 / view.s, rb = portalR(q) + 4 / view.s;
    var ax = p.x + ux * ra - uy * off, ay = p.y + uy * ra + ux * off; // 往右偏一点：双向时两条线分开
    var bx = q.x - ux * rb - uy * off, by = q.y - uy * rb + ux * off;
    if (len <= ra + rb) return;
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = hot ? '#ffd54f' : 'rgba(179,136,255,0.75)';
    ctx.lineWidth = (hot ? 2.5 : 1.5) / view.s;
    ctx.setLineDash([10 / view.s, 6 / view.s]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.setLineDash([]);
    var h = 12 / view.s;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - ux * h - uy * h * 0.5, by - uy * h + ux * h * 0.5);
    ctx.lineTo(bx - ux * h + uy * h * 0.5, by - uy * h - ux * h * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

// ===== 使用 =====
// 手动：棋子边缘离传送门边缘不超过一格；自动传送门的判定圈里也算
function portalReach(tok, p) {
    var g = gridSize(), c = tokenCenter(tok), d = Math.hypot(c.x - p.x, c.y - p.y), half = Math.max(tok.w || g, tok.h || g) / 2;
    return d - half - portalR(p) <= g * 1.1 || (p.mode === 'auto' && d <= portalAutoR(p) + g * 0.2);
}

function portalTraveller(t) { return t && t.kind === 'token' && !portalOf(t) && isCreatureToken(t); }

// 能用这个传送门的棋子：先看选中的，玩家没选中时找自己控制的
function portalUsers(p) {
    var sel = selectedIds().map(function(id) { return scene.items[id]; }).filter(function(t) {
        return portalTraveller(t) && canMove(t) && portalReach(t, p);
    });
    if (sel.length || me.gm) return sel;
    return sortedItems().filter(function(t) { return portalTraveller(t) && canEdit(t) && !t.locked && portalReach(t, p); });
}

// 点击传送门（选择工具）。GM 只有在选中了附近的棋子时才算「使用」，否则照常选中传送门
function portalClick(p) {
    if (!me.gm && timeStopped()) { notice('时间停止中', true); return; }
    var toks = portalUsers(p);
    if (!toks.length) {
        notice(me.gm ? '先选中要传送的棋子（在传送门一格以内），再点传送门' : '角色要走到传送门一格以内，再点击传送门', true);
        return;
    }
    if (toks.length === 1 || selectedIds().length) { usePortal(p, toks.map(function(t) { return t.id; })); return; }
    ttAsk({ title: '🌀 ' + portalTitle(p), text: '谁进入传送门？', cancel: '算了',
        choices: toks.map(function(t) { return { label: t.label || '棋子', value: [t.id] }; })
            .concat([{ label: '全部 ' + toks.length + ' 个一起', value: toks.map(function(t) { return t.id; }) }]) })
        .then(function(ids) { if (ids) usePortal(p, ids); });
}

function usePortal(p, ids) {
    var to = (p.to || []).filter(function(id, i, a) { return id !== p.id && a.indexOf(id) === i; });
    if (!to.length) {
        notice(me.gm ? '「' + portalTitle(p) + '」还没有目标：选中它，在属性里勾选要去的传送门' : '传送门没有反应', true);
        return;
    }
    var go = function(target) {
        var r = op({ op: 'portal', scene: p.id, ids: ids, target: target || '' });
        if (r && r.then) r.then(function(res) { if (res) selectOnly(ids.filter(function(id) { return scene.items[id]; })); });
    };
    if (p.pick === 'random' || to.length === 1) { go(p.pick === 'random' ? '' : to[0]); return; }
    var who = ids.length === 1 ? '「' + ((scene.items[ids[0]] || {}).label || '棋子') + '」' : ids.length + ' 个棋子';
    var unnamed = 0;
    ttAsk({ title: '🌀 ' + portalTitle(p), text: who + '要传送到哪里？', cancel: '留在这里',
        choices: to.map(function(id) {
            var q = scene.items[id];
            return { label: q && q.name ? q.name : '未知的传送门 ' + (++unnamed), value: id };
        }) }).then(function(t) { if (t) go(t); });
}

// 移动结束后（拖动 / 方向键）：从判定圈外走进自动传送门的棋子立刻传送。orig = {id: {x, y}}（移动前）
function portalAfterMove(orig) {
    var ports = scenePortals().filter(function(p) { return p.mode === 'auto' && (p.to || []).length; });
    if (!ports.length) return false;
    var groups = {}, g = gridSize();
    Object.keys(orig).forEach(function(id) {
        var t = scene.items[id];
        if (!portalTraveller(t) || !canMove(t) || !orig[id]) return;
        var c = tokenCenter(t), o = { x: num(orig[id].x, 0) + (t.w || g) / 2, y: num(orig[id].y, 0) + (t.h || g) / 2 };
        for (var i = 0; i < ports.length; i++) {
            var p = ports[i], R = portalAutoR(p);
            if (Math.hypot(c.x - p.x, c.y - p.y) <= R && Math.hypot(o.x - p.x, o.y - p.y) > R) { (groups[p.id] = groups[p.id] || []).push(id); return; }
        }
    });
    var ids = Object.keys(groups);
    ids.forEach(function(pid) { usePortal(scene.items[pid], groups[pid]); });
    return ids.length > 0;
}

// ===== 🌀 工具：放置 / 连线 =====
function setPortalMode(m) {
    portalOpts.mode = m;
    portalLinkSrc = '';
    portalSyncUI();
    updateCursor();
    requestRender();
}

function portalLinkClick(w, both) {
    var hit = hitTest(w, ['portal']);
    var src = portalLinkSrc && scene.items[portalLinkSrc];
    if (!hit) { portalLinkSrc = ''; selectOnly([]); portalSyncUI(); requestRender(); return; }
    if (!isPortal(src) || src.id === hit.id) {
        portalLinkSrc = src && src.id === hit.id ? '' : hit.id;
        selectOnly(portalLinkSrc ? [portalLinkSrc] : []);
        portalSyncUI();
        requestRender();
        return;
    }
    var on = (src.to || []).indexOf(hit.id) < 0;
    var tog = function(list, id) {
        var l = (list || []).filter(function(x) { return x !== id; });
        if (on) l.push(id);
        return l.length ? l : null;
    };
    var patches = [{ id: src.id, to: tog(src.to, hit.id) }];
    if (both) patches.push({ id: hit.id, to: tog(hit.to, src.id) });
    patchItems(patches);
    notice((on ? '已连上：' : '已断开：') + portalTitle(src) + (both ? ' ⇄ ' : ' → ') + portalTitle(hit));
    portalSyncUI();
    requestRender();
}

function portalSyncUI() {
    document.querySelectorAll('[data-portalmode]').forEach(function(b) { b.classList.toggle('active', b.dataset.portalmode === portalOpts.mode); });
    var hint = $('portalHint');
    if (!hint) return;
    var src = portalLinkSrc && scene.items[portalLinkSrc];
    hint.textContent = portalOpts.mode === 'link' ?
        (isPortal(src) ? '从「' + portalTitle(src) + '」出发：点要去的传送门 = 加上 / 去掉通路（Shift+点 = 双向），点空地结束' : '先点出发的传送门') :
        '单击地图放一个传送门；拖动可以移动，拖四角缩放；右键点传送门 = 菜单（删除），右键点空地 = 撤回刚放的；点中传送门在左侧属性里改名字、方式和目标';
}

function portalJumpFill() {
    var sel = $('portalJump');
    if (!sel) return;
    sel.innerHTML = '<option value="">跳到传送门…</option>' + scenePortals().map(function(p) {
        return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(portalTitle(p)) + (p.hidden ? '（隐藏）' : '') + '</option>';
    }).join('');
}

function focusPortal(id) {
    var p = scene.items[id];
    if (!isPortal(p)) return;
    view.x = canvas.clientWidth / 2 - p.x * view.s;
    view.y = canvas.clientHeight / 2 - p.y * view.s;
    selectOnly([id]);
    requestRender();
}

// 🌀 工具里右键轻点：连线中 = 结束连线；点到传送门 = 它的菜单（删除、隐藏、锁定）；空地 = 撤回自己刚放的传送门
function portalRightTap(start) {
    if (portalLinkSrc) { portalLinkSrc = ''; selectOnly([]); portalSyncUI(); requestRender(); return; }
    var hit = hitTest(start.w, ['portal']);
    if (hit) { openTokenMenu(hit, start.s.x, start.s.y); return; }
    toolRightUndo('portal');
}

// ===== 缩放（和棋子一样拖四角；只有 GM）=====
function portalHandles(it) {
    if (!me.gm || it.locked) return null;
    var r = portalR(it) + 3 / view.s, c = { x: it.x || 0, y: it.y || 0 };
    return { id: it.id, c: c, a: 0, r: 6 / view.s, portal: true, rot: null, top: { x: c.x, y: c.y - r }, box: [c.x - r, c.y - r, c.x + r, c.y + r],
        corners: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function(k) { return { x: c.x + k[0] * r, y: c.y + k[1] * r, k: k }; }) };
}

function ptScaleStart(hh, start) {
    var it = scene.items[hh.h.id];
    return { type: 'pscale', start: start, id: it.id, ids: idSet([it.id]), c: { x: it.x || 0, y: it.y || 0 }, s0: portalSize(it),
        d0: Math.hypot(hh.corner.x - (it.x || 0), hh.corner.y - (it.y || 0)) || 1, lastSent: 0, snap: snapshotItems([it.id], ['size']) };
}

function ptScaleMove(g, w, e) {
    var it = scene.items[g.id];
    if (!it) return;
    var s = g.s0 * Math.hypot(w.x - g.c.x, w.y - g.c.y) / g.d0;
    s = e.shiftKey ? Math.round(s * 2) / 2 : Math.round(s * 20) / 20; // Shift：按半格吸附
    it.size = Math.max(0.25, Math.min(20, s));
    if (performance.now() - g.lastSent > 80) { g.lastSent = performance.now(); queueItems([{ id: it.id, size: it.size }]); }
}

function ptScaleEnd(g) {
    var it = scene.items[g.id];
    if (!it || !g.start.moved) return;
    if (it.size === 1) delete it.size;
    queueItems([{ id: it.id, size: it.size || null }]);
    pushUndo(g.snap || []);
}

function ptScaleLabel(g) {
    var it = scene.items[g.id];
    return '直径 ' + portalSize(it) + ' 格';
}

// ===== 属性面板 =====
function portalSelHtml(it) {
    var row = function(label, inner) { return '<div class="prop-row"><label>' + label + '</label>' + inner + '</div>'; };
    var g = gridSize(), to = it.to || [];
    var others = scenePortals().filter(function(q) { return q.id !== it.id; });
    var from = others.filter(function(q) { return (q.to || []).indexOf(it.id) >= 0; });
    var h = row('名字', '<input class="tt-input" data-pt="name" maxlength="30" value="' + escapeHtml(it.name || '') + '" placeholder="传送门" style="flex:1;">') +
        row('', '<label title="玩家看不到这个传送门的名字（目的地列表里显示成「未知的传送门」）"><input type="checkbox" data-pt="nameHidden"' + (it.nameHidden ? ' checked' : '') + '> 名字只有 GM 看得到</label>') +
        row('大小', '<input class="tt-input narrow" type="number" data-pt="size" min="0.25" max="20" step="0.25" value="' + portalSize(it) + '"><span class="tt-hint">格（直径）；也可以在选择工具里拖四角缩放</span>') +
        row('方式', '<select class="tt-select" data-pt="mode" style="flex:1;">' +
            '<option value=""' + (it.mode === 'auto' ? '' : ' selected') + '>手动：角色在一格内点击传送门</option>' +
            '<option value="auto"' + (it.mode === 'auto' ? ' selected' : '') + '>自动：角色走进判定圈就传送</option></select>');
    if (it.mode === 'auto') h += row('判定圈', '<input class="tt-input narrow" type="number" data-pt="rc" min="0.5" max="20" step="0.5" value="' +
        Math.round(portalAutoR(it) / g * 100) / 100 + '"><span class="tt-hint">格半径（' + distText(portalAutoR(it)) + '）</span>');
    h += row('去哪', '<select class="tt-select" data-pt="pick" style="flex:1;">' +
        '<option value=""' + (it.pick === 'random' ? '' : ' selected') + '>使用的人从目标里选（只有一个就直接去）</option>' +
        '<option value="random"' + (it.pick === 'random' ? ' selected' : '') + '>随机去一个目标</option></select>');
    h += '<div class="note-field"><label>目标传送门（可多选；单向，对面要回来得在它那边也勾上）</label>' + (others.length ? others.map(function(q) {
        return '<div class="pt-target"><label><input type="checkbox" data-ptto="' + escapeHtml(q.id) + '"' + (to.indexOf(q.id) >= 0 ? ' checked' : '') + '> ' +
            escapeHtml(portalTitle(q)) + (q.hidden ? ' 🙈' : '') + ((q.to || []).indexOf(it.id) >= 0 ? ' <span class="tt-hint">（能回到这里）</span>' : '') + '</label>' +
            '<button class="tt-btn small" data-act="ptfocus" data-ptid="' + escapeHtml(q.id) + '" title="定位">📍</button></div>';
    }).join('') : '<div class="tt-hint">场景里还没有别的传送门：用 🌀 工具再放一个</div>') + '</div>';
    if (from.length) h += '<div class="tt-hint">能传送到这里的：' + from.map(function(q) { return escapeHtml(portalTitle(q)); }).join('、') + '</div>';
    h += '<div class="tt-hint">玩家：角色在传送门一格以内时点击它就能用；自动传送门在角色走进虚线圈时触发。对玩家隐藏的传送门玩家看不到也用不了，但可以当作别的门的出口（单向暗门）。GM 先选中棋子再点传送门 = 让它通过。</div>';
    return h;
}

function portalSelChange(el) {
    if (!el.dataset.pt && el.dataset.ptto === undefined) return false;
    var ids = selectedIds(), it = ids.length === 1 && scene.items[ids[0]];
    if (!isPortal(it) || !me.gm) return true;
    var g = gridSize(), p = { id: it.id };
    if (el.dataset.ptto !== undefined) {
        var l = (it.to || []).filter(function(x) { return x !== el.dataset.ptto; });
        if (el.checked) l.push(el.dataset.ptto);
        p.to = l.length ? l : null;
    } else if (el.dataset.pt === 'name') p.name = el.value.trim().slice(0, 30) || null;
    else if (el.dataset.pt === 'nameHidden') p.nameHidden = el.checked || null;
    else if (el.dataset.pt === 'mode') { p.mode = el.value || null; if (el.value === 'auto' && !it.r) p.r = Math.round(Math.max(g * 0.5, portalR(it))); }
    else if (el.dataset.pt === 'size') { var sz = parseFloat(el.value); if (!(sz > 0)) return true; sz = Math.max(0.25, Math.min(20, Math.round(sz * 100) / 100)); p.size = sz === 1 ? null : sz; }
    else if (el.dataset.pt === 'rc') { var v = parseFloat(el.value); if (!(v > 0)) return true; p.r = Math.round(Math.min(20, Math.max(0.25, v)) * g); }
    else if (el.dataset.pt === 'pick') p.pick = el.value || null;
    patchItems([p]);
    $('selPanel').dataset.ids = '';
    renderSelPanel();
    requestRender();
    return true;
}

function portalSelAct(b) {
    if (b.dataset.act !== 'ptfocus') return false;
    focusPortal(b.dataset.ptid);
    return true;
}

function initPortals() {
    var bar = $('optsPortal');
    if (!bar) return;
    bar.addEventListener('click', function(e) { var b = e.target.closest('[data-portalmode]'); if (b) setPortalMode(b.dataset.portalmode); });
    $('portalJump').addEventListener('mousedown', portalJumpFill);
    $('portalJump').addEventListener('focus', portalJumpFill);
    $('portalJump').addEventListener('change', function() { if (this.value) focusPortal(this.value); this.value = ''; });
    portalSyncUI();
}
