// 跑团桌面：DM 备团工具
// 1. 墙体编辑：拖拐点（相连的墙一起动、吸附别的拐点）、双击加 / 删拐点、右键拐点断开、
//    批量改类型、拆成单段、合并相连、框选墙
// 2. 找门洞：墙线之间一格左右的缺口，点一下补成门（或窗、墙）
// 3. 房间笔记：地图上的编号标记（kind 'note'，服务器永远不发给玩家），写描述和朗读文字
// 4. 讲义：GM 把图片 / 文字推给全体或指定玩家，玩家在「线索」里随时翻看

// ===================== 通用 =====================
var WALL_EPS = 0.75; // 世界坐标：两个拐点算重合的距离

function wallItems() { return sortedItems().filter(function(it) { return it.kind === 'wall'; }); }
function wallAbsPts(it) { return (it.points || []).map(function(p) { return [(it.x || 0) + p[0], (it.y || 0) + p[1]]; }); }
function wallNear(a, b, tol) { return Math.hypot(a[0] - b[0], a[1] - b[1]) <= (tol || WALL_EPS); }
function r1(v) { return Math.round(v * 10) / 10; }

// 新墙：从 src 复制类型 / 门的状态，pts 为世界坐标
function wallFrom(src, pts, z) {
    var o = pts[0];
    var it = { id: genId(), kind: 'wall', wtype: src.wtype || 'wall', x: r1(o[0]), y: r1(o[1]), z: z,
        points: pts.map(function(p) { return [r1(p[0] - o[0]), r1(p[1] - o[1])]; }) };
    if (it.wtype === 'door' || it.wtype === 'secret') { it.open = !!src.open; if (src.locked) it.locked = true; }
    return it;
}

// 一步完成的复合修改（改 + 建 + 删），Ctrl+Z 一次全部退回
function prepCommit(patches, creates, dels) {
    var snaps = [];
    patches.forEach(function(p) { snaps.push(snapshotItems([p.id], Object.keys(p).filter(function(k) { return k !== 'id'; }))[0]); });
    creates.forEach(function(it) { snaps.push({ id: it.id, __absent: true }); });
    snaps = snaps.concat(snapshotItems(dels));
    undoBusy = true;
    try {
        if (patches.length) patchItems(patches);
        if (creates.length) createItems(creates);
        if (dels.length) deleteItems(dels);
    } finally { undoBusy = false; }
    pushUndo(snaps);
}

function segCross(a, b, c, d) { // 线段 ab 与 cd 是否相交（含端点）
    var o = function(p, q, r) { return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); };
    var d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    var on = function(p, q, r) { return Math.min(p[0], q[0]) - 1e-9 <= r[0] && r[0] <= Math.max(p[0], q[0]) + 1e-9 && Math.min(p[1], q[1]) - 1e-9 <= r[1] && r[1] <= Math.max(p[1], q[1]) + 1e-9; };
    return (d1 === 0 && on(c, d, a)) || (d2 === 0 && on(c, d, b)) || (d3 === 0 && on(a, b, c)) || (d4 === 0 && on(a, b, d));
}

// ===================== 1. 墙体编辑 =====================
function wallVertexAt(w, skip) {
    var tol = 8 / view.s, best = null, bd = tol;
    wallItems().reverse().forEach(function(it) {
        wallAbsPts(it).forEach(function(p, i) {
            if (skip && skip[it.id + ':' + i]) return;
            var d = Math.hypot(p[0] - w.x, p[1] - w.y);
            if (d <= bd) { bd = d; best = { id: it.id, i: i, x: p[0], y: p[1] }; }
        });
    });
    return best;
}

function wallSegAt(w) {
    var tol = 7 / view.s, best = null, bd = tol;
    wallItems().reverse().forEach(function(it) {
        var p = wallAbsPts(it);
        for (var i = 1; i < p.length; i++) {
            var d = distToSeg(w.x, w.y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
            if (d <= bd) {
                var ax = p[i - 1][0], ay = p[i - 1][1], dx = p[i][0] - ax, dy = p[i][1] - ay, l = dx * dx + dy * dy || 1;
                var t = Math.max(0, Math.min(1, ((w.x - ax) * dx + (w.y - ay) * dy) / l));
                bd = d; best = { id: it.id, seg: i - 1, x: ax + t * dx, y: ay + t * dy };
            }
        }
    });
    return best;
}

// ===== 选中折线里的某一段（两个拐点之间）：单独删掉 / 单独改成门窗 =====
var wallSeg = null; // { id, seg }：第 seg 段 = 第 seg 和 seg+1 个拐点之间
function wallSegSel() {
    var s = wallSeg, it = s && scene.items[s.id];
    if (!it || !selected[s.id] || Object.keys(selected).length !== 1 || !it.points || s.seg >= it.points.length - 1) return null;
    return { it: it, seg: s.seg };
}

// 把折线在第 seg 段处拆开：返回 { before, mid, after }（世界坐标点列；闭合的折线转一圈成一条：mid 之后接回 mid 之前）
function wallSegSplit(it, seg) {
    var p = wallAbsPts(it), closed = p.length > 3 && wallNear(p[0], p[p.length - 1]);
    var mid = [p[seg], p[seg + 1]];
    if (closed) return { before: [], mid: mid, after: p.slice(seg + 1).concat(p.slice(1, seg + 1)) };
    return { before: p.slice(0, seg + 1), mid: mid, after: p.slice(seg + 1) };
}

// type 为空 = 删掉这一段；否则这一段改成 type（单独成一条），其余部分保持原类型
function wallSegApply(type) {
    var s = wallSegSel();
    if (!s) return false;
    var it = s.it, parts = wallSegSplit(it, s.seg), z = nextZ(), creates = [], name = (WALL_STYLE[it.wtype] || WALL_STYLE.wall).name;
    if (type && (it.wtype || 'wall') === type) return true;
    if (it.points.length === 2) { // 只有一段：整条删 / 整条改
        if (!type) { deleteItems([it.id]); notice('已删除这段' + name + '（Ctrl+Z 撤销）'); }
        else {
            var isDoor = type === 'door' || type === 'secret';
            patchItems([{ id: it.id, wtype: type, open: isDoor ? !!it.open : null, locked: isDoor && it.locked ? true : null }]);
            notice('已改为' + WALL_STYLE[type].name);
        }
        wallSeg = null; $('selPanel').dataset.ids = ''; renderSelPanel();
        return true;
    }
    [parts.before, parts.after].forEach(function(pts) { if (pts.length >= 2) creates.push(wallFrom(it, pts, z + creates.length)); });
    var midIt = null;
    if (type) {
        midIt = wallFrom({ wtype: type, open: false, locked: false }, parts.mid, z + creates.length);
        if (type === 'door' && wallOpts.lockDoor) midIt.locked = true;
        creates.push(midIt);
    }
    prepCommit([], creates, [it.id]);
    wallSeg = midIt ? { id: midIt.id, seg: 0 } : null;
    selectOnly(midIt ? [midIt.id] : []);
    $('selPanel').dataset.ids = ''; renderSelPanel();
    notice(type ? '这一段已改为' + WALL_STYLE[type].name + '（Ctrl+Z 撤销）' : '已删除这一段' + name + '（Ctrl+Z 撤销）');
    return true;
}

// 墙体「选择」模式下按住拐点：拖动它（和它重合的其他墙的拐点一起动；按住 Alt 只拖这一条）
function wallVertexDown(w, start, e) {
    var v = wallVertexAt(w);
    if (!v) return false;
    var refs = [];
    if (e.altKey) refs.push({ id: v.id, i: v.i });
    else wallItems().forEach(function(it) {
        wallAbsPts(it).forEach(function(p, i) { if (wallNear(p, [v.x, v.y])) refs.push({ id: it.id, i: i }); });
    });
    var ids = {}, skip = {};
    refs.forEach(function(r) { ids[r.id] = true; skip[r.id + ':' + r.i] = true; });
    gesture = { type: 'wvert', start: start, refs: refs, ids: ids, skip: skip, lastSent: 0, snap: snapshotItems(Object.keys(ids), ['points']) };
    if (!selected[v.id]) selectOnly([v.id]);
    return true;
}

function wallVertexMove(w, e) {
    var g = gesture;
    if (!g.start.moved) return;
    var p = wallSnap(w, e.altKey, g.skip); // 默认自由拖动、靠近别的拐点吸上去；Alt = 吸附半格
    g.target = p;
    g.refs.forEach(function(r) {
        var it = scene.items[r.id];
        if (!it || !it.points || !it.points[r.i]) return;
        it.points[r.i] = [r1(p.x - (it.x || 0)), r1(p.y - (it.y || 0))];
    });
    wallsVersion++;
    if (performance.now() - g.lastSent > 80) { g.lastSent = performance.now(); wallVertexSend(g); }
}

function wallVertexSend(g) {
    queueItems(Object.keys(g.ids).filter(function(id) { return scene.items[id]; }).map(function(id) {
        return { id: id, points: scene.items[id].points.map(function(p) { return p.slice(); }) };
    }));
}

function wallVertexUp(g) {
    if (!g.start.moved) return;
    wallVertexSend(g);
    pushUndo(g.snap);
    wallsVersion++;
}

// 双击：拐点上 = 删掉这个拐点（只剩一段时删掉整段墙），线段上 = 加一个拐点
function wallDblClick(w) {
    var v = wallVertexAt(w);
    if (v) {
        var it = scene.items[v.id], pts = it.points.map(function(p) { return p.slice(); });
        if (pts.length <= 2) { deleteItems([it.id]); notice('已删除这段墙（Ctrl+Z 撤销）'); return; }
        pts.splice(v.i, 1);
        patchItems([{ id: it.id, points: pts }]);
        return;
    }
    var s = wallSegAt(w);
    if (!s) return;
    var it2 = scene.items[s.id], p2 = it2.points.map(function(p) { return p.slice(); });
    p2.splice(s.seg + 1, 0, [r1(s.x - (it2.x || 0)), r1(s.y - (it2.y || 0))]);
    patchItems([{ id: it2.id, points: p2 }]);
    selectOnly([it2.id]);
}

// 右键中间的拐点：在这里断开成两段
function wallSplitAt(w) {
    var v = wallVertexAt(w);
    if (!v) return false;
    var it = scene.items[v.id], abs = wallAbsPts(it);
    if (v.i === 0 || v.i === abs.length - 1) { notice('墙的端点不用断开；在中间的拐点上右键才会断成两段', true); return true; }
    var keep = it.points.slice(0, v.i + 1).map(function(p) { return p.slice(); });
    var nw = wallFrom(it, abs.slice(v.i), nextZ());
    prepCommit([{ id: it.id, points: keep }], [nw], []);
    selectOnly([it.id, nw.id]);
    notice('已在这个拐点断开成两段（Ctrl+Z 撤销）');
    return true;
}

// 框选：碰到框的墙都选上
function wallsInBox(x0, y0, x1, y1) {
    var box = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    var inside = function(p) { return p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1; };
    return wallItems().filter(function(it) {
        var p = wallAbsPts(it);
        for (var i = 0; i < p.length; i++) {
            if (inside(p[i])) return true;
            if (i && box.some(function(b, k) { return segCross(p[i - 1], p[i], b, box[(k + 1) % 4]); })) return true;
        }
        return false;
    }).map(function(it) { return it.id; });
}

// 属性面板里的墙体编辑按钮
function wallSelHtml(ids) {
    if (!me.gm) return '';
    var ws = ids.filter(function(id) { return scene.items[id] && scene.items[id].kind === 'wall'; });
    if (!ws.length) return '';
    var h = '';
    if (ids.length > 1) {
        h += '<div class="prop-btns"><span class="tt-hint">' + ws.length + ' 段墙改为</span>' + ['wall', 'window', 'door', 'secret'].map(function(t) {
            return '<button class="tt-btn small" data-act="wset-' + t + '">' + WALL_STYLE[t].name + '</button>';
        }).join('') + '</div>';
    }
    var sg = wallSegSel();
    if (sg && sg.it.points.length > 2) {
        h += '<div class="prop-btns"><span class="tt-hint">黄色这一段：</span><button class="tt-btn small danger" data-act="wsegdel" title="只删这一段（Delete 键也一样）；整条删掉用上面的删除">删除这一段</button>' +
            ['wall', 'window', 'door', 'secret'].filter(function(t) { return t !== (sg.it.wtype || 'wall'); }).map(function(t) {
                return '<button class="tt-btn small" data-act="wseg-' + t + '">改为' + WALL_STYLE[t].name + '</button>';
            }).join('') + '</div>';
    }
    var multi = ws.some(function(id) { return (scene.items[id].points || []).length > 2; });
    h += '<div class="prop-btns">' +
        (multi ? '<button class="tt-btn small" data-act="wexplode" title="把折线拆成一段一段，方便单独删掉或改成门">拆成单段</button>' : '') +
        (ws.length > 1 ? '<button class="tt-btn small" data-act="wmerge" title="首尾相连的同类墙合并成一条折线">合并相连</button>' : '') + '</div>';
    h += '<div class="tt-hint">点在线上 = 选中那一段（黄色），Delete 只删这一段。拖拐点移动（相连的墙一起动，靠近别的拐点会接上；Alt 只拖这一条、不吸附）。双击线段加拐点，双击拐点删除；右键中间的拐点在此断开。Shift+拖动框选多段墙</div>';
    return h;
}

function wallSelAct(act, ids) {
    if (act === 'wsegdel') { wallSegApply(''); return; }
    if (act.indexOf('wseg-') === 0) { wallSegApply(act.slice(5)); return; }
    var ws = ids.filter(function(id) { return scene.items[id] && scene.items[id].kind === 'wall'; }).map(function(id) { return scene.items[id]; });
    if (!ws.length) return;
    if (act.indexOf('wset-') === 0) {
        var t = act.slice(5), isDoor = t === 'door' || t === 'secret';
        patchItems(ws.map(function(it) { return { id: it.id, wtype: t, open: isDoor ? !!it.open : null, locked: isDoor && it.locked ? true : null }; }));
        notice('已把 ' + ws.length + ' 段改为' + WALL_STYLE[t].name);
    } else if (act === 'wexplode') {
        var creates = [], dels = [], z = nextZ();
        ws.forEach(function(it) {
            var p = wallAbsPts(it);
            if (p.length <= 2) return;
            dels.push(it.id);
            for (var i = 1; i < p.length; i++) creates.push(wallFrom(it, [p[i - 1], p[i]], z + creates.length));
        });
        if (!creates.length) return;
        prepCommit([], creates, dels);
        selectOnly(creates.map(function(c) { return c.id; }));
        notice('已拆成 ' + creates.length + ' 段，点选某一段即可单独删掉或改成门');
    } else if (act === 'wmerge') {
        var lines = ws.map(function(it) { return { src: [it.id], it: it, pts: wallAbsPts(it) }; });
        var tol = WALL_EPS * 2, changed = true;
        while (changed) {
            changed = false;
            for (var i = 0; i < lines.length && !changed; i++) {
                for (var j = i + 1; j < lines.length && !changed; j++) {
                    var A = lines[i], B = lines[j];
                    if ((A.it.wtype || 'wall') !== (B.it.wtype || 'wall')) continue;
                    var a0 = A.pts[0], a1 = A.pts[A.pts.length - 1], b0 = B.pts[0], b1 = B.pts[B.pts.length - 1];
                    if (wallNear(a0, a1, tol) || wallNear(b0, b1, tol)) continue; // 已经闭合
                    var m = null;
                    if (wallNear(a1, b0, tol)) m = A.pts.concat(B.pts.slice(1));
                    else if (wallNear(a1, b1, tol)) m = A.pts.concat(B.pts.slice().reverse().slice(1));
                    else if (wallNear(a0, b1, tol)) m = B.pts.concat(A.pts.slice(1));
                    else if (wallNear(a0, b0, tol)) m = A.pts.slice().reverse().concat(B.pts.slice(1));
                    if (m) { A.pts = m; A.src = A.src.concat(B.src); lines.splice(j, 1); changed = true; }
                }
            }
        }
        var mc = [], md = [], keep = [], z2 = nextZ();
        lines.forEach(function(L) {
            if (L.src.length < 2) { keep.push(L.it.id); return; }
            md = md.concat(L.src);
            mc.push(wallFrom(L.it, L.pts, z2 + mc.length));
        });
        if (!mc.length) { notice('选中的墙没有首尾相连的同类墙', true); return; }
        prepCommit([], mc, md);
        selectOnly(mc.map(function(c) { return c.id; }).concat(keep));
        notice('已把 ' + md.length + ' 段合并成 ' + mc.length + ' 条');
    }
    $('selPanel').dataset.ids = '';
    renderSelPanel();
}

// ===================== 2. 找门洞 =====================
var doorGap = { list: [], ver: -1, gs: 0, maxCells: 1.5, type: 'door', ignored: {}, hover: -1 };

function doorGapActive() { return me.gm && tool === 'wall' && wallOpts.mode === 'doors'; }
function doorGapKey(c) { return Math.round(c.a[0]) + ',' + Math.round(c.a[1]) + ',' + Math.round(c.b[0]) + ',' + Math.round(c.b[1]); }

function doorGapCompute() {
    var g = gridSize(), minD = 0.35 * g, maxD = doorGap.maxCells * g + 0.5;
    var segs = [], ends = [], walls = wallItems();
    walls.forEach(function(it) {
        var p = wallAbsPts(it);
        for (var i = 1; i < p.length; i++) segs.push({ id: it.id, i: i - 1, a: p[i - 1], b: p[i] });
    });
    var ctol = Math.max(1.5, g * 0.04);
    walls.forEach(function(it) {
        if (it.wtype === 'door' || it.wtype === 'secret') return; // 门本身不算缺口端点
        var p = wallAbsPts(it), n = p.length;
        if (n < 2 || (n > 2 && wallNear(p[0], p[n - 1], ctol))) return; // 闭合的墙没有端点
        [[0, 1, 0], [n - 1, n - 2, n - 2]].forEach(function(e) {
            var E = p[e[0]], F = p[e[1]], own = e[2];
            var linked = segs.some(function(s) { // 端点接在别的墙（或自己别的段）上：不是缺口
                if (s.id === it.id && s.i === own) return false;
                return distToSeg(E[0], E[1], s.a[0], s.a[1], s.b[0], s.b[1]) <= ctol;
            });
            if (linked) return;
            var dx = E[0] - F[0], dy = E[1] - F[1], L = Math.hypot(dx, dy) || 1;
            ends.push({ id: it.id, e: e[0], own: own, x: E[0], y: E[1], dx: dx / L, dy: dy / L });
        });
    });
    var blocked = function(a, b) { // 缺口连线（两头各缩一点）穿过别的墙：不是门洞
        var d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / d, uy = (b[1] - a[1]) / d, k = Math.min(2, d / 4);
        var a2 = [a[0] + ux * k, a[1] + uy * k], b2 = [b[0] - ux * k, b[1] - uy * k];
        return segs.some(function(s) { return segCross(a2, b2, s.a, s.b); });
    };
    var cands = [];
    for (var i = 0; i < ends.length; i++) {
        for (var j = i + 1; j < ends.length; j++) {
            var A = ends[i], B = ends[j];
            var vx = B.x - A.x, vy = B.y - A.y, d = Math.hypot(vx, vy);
            if (d < minD || d > maxD) continue;
            var ux = vx / d, uy = vy / d, da = A.dx * ux + A.dy * uy, db = -(B.dx * ux + B.dy * uy);
            if (Math.max(da, db) < 0.5 || Math.min(da, db) < -0.3) continue; // 两头的墙要大致朝着对方
            if (blocked([A.x, A.y], [B.x, B.y])) continue;
            cands.push({ a: [A.x, A.y], b: [B.x, B.y], ka: A.id + ':' + A.e, kb: B.id + ':' + B.e, score: d - (da + db) * 0.1 * g });
        }
    }
    // 墙头正对着另一面墙（门开在拐角 / 丁字路口）：沿墙的方向找最近的墙
    ends.forEach(function(A) {
        var best = null;
        segs.forEach(function(s) {
            if (s.id === A.id && s.i === A.own) return;
            var ex = s.b[0] - s.a[0], ey = s.b[1] - s.a[1], den = A.dx * ey - A.dy * ex;
            if (Math.abs(den) < 1e-6) return;
            var qx = s.a[0] - A.x, qy = s.a[1] - A.y;
            var t = (qx * ey - qy * ex) / den, u = (qx * A.dy - qy * A.dx) / den;
            if (t > 1 && u >= 0 && u <= 1 && (!best || t < best.t)) best = { t: t, x: A.x + A.dx * t, y: A.y + A.dy * t };
        });
        if (best && best.t >= minD && best.t <= maxD) cands.push({ a: [A.x, A.y], b: [best.x, best.y], ka: A.id + ':' + A.e, kb: null, score: best.t + 0.15 * g });
    });
    cands.sort(function(p, q) { return p.score - q.score; });
    var used = {}, out = [];
    cands.forEach(function(c) {
        if (used[c.ka] || (c.kb && used[c.kb]) || doorGap.ignored[doorGapKey(c)]) return;
        used[c.ka] = true;
        if (c.kb) used[c.kb] = true;
        out.push(c);
    });
    doorGap.list = out;
    doorGap.ver = wallsVersion;
    doorGap.gs = g;
    doorGap.hover = -1;
    doorGapSync();
}

function doorGapEnsure() { if (doorGap.ver !== wallsVersion || doorGap.gs !== gridSize()) doorGapCompute(); }

function doorGapAt(w) {
    var tol = 9 / view.s, best = -1, bd = tol;
    doorGap.list.forEach(function(c, i) {
        var d = distToSeg(w.x, w.y, c.a[0], c.a[1], c.b[0], c.b[1]);
        if (d <= bd) { bd = d; best = i; }
    });
    return best;
}

function doorGapItem(c, z) {
    var it = { id: genId(), kind: 'wall', wtype: doorGap.type, x: r1(c.a[0]), y: r1(c.a[1]), z: z,
        points: [[0, 0], [r1(c.b[0] - c.a[0]), r1(c.b[1] - c.a[1])]] };
    if (it.wtype === 'door') it.open = false;
    return it;
}

function doorGapPointerDown(w, e) {
    doorGapEnsure();
    var i = doorGapAt(w);
    if (i < 0) return;
    var c = doorGap.list[i];
    if (e.shiftKey) { doorGap.ignored[doorGapKey(c)] = true; doorGap.ver = -1; requestRender(); return; } // Shift+点：忽略
    createItems([doorGapItem(c, nextZ())]);
}

function doorGapHover(w) {
    if (!doorGapActive()) return;
    doorGapEnsure();
    var i = doorGapAt(w);
    canvas.style.cursor = i >= 0 ? 'pointer' : 'default';
    if (i !== doorGap.hover) { doorGap.hover = i; requestRender(); }
}

function doorGapAll() {
    doorGapEnsure();
    if (!doorGap.list.length) return;
    var z = nextZ();
    createItems(doorGap.list.map(function(c, i) { return doorGapItem(c, z + i); }));
    notice('已补上 ' + doorGap.list.length + ' 处（Ctrl+Z 可整批撤销）');
}

function drawDoorGaps() {
    if (!doorGapActive()) return;
    doorGapEnsure();
    var color = doorGap.type === 'window' ? '#4fc3f7' : doorGap.type === 'wall' ? '#ff9800' : '#ffd54f';
    ctx.save();
    ctx.lineCap = 'round';
    doorGap.list.forEach(function(c, i) {
        var hot = i === doorGap.hover;
        ctx.strokeStyle = hot ? '#ffffff' : color;
        ctx.lineWidth = (hot ? 7 : 5) / view.s;
        ctx.setLineDash([7 / view.s, 5 / view.s]);
        ctx.beginPath(); ctx.moveTo(c.a[0], c.a[1]); ctx.lineTo(c.b[0], c.b[1]); ctx.stroke();
        ctx.setLineDash([]);
        var mx = (c.a[0] + c.b[0]) / 2, my = (c.a[1] + c.b[1]) / 2;
        ctx.fillStyle = hot ? '#ffffff' : color;
        ctx.beginPath(); ctx.arc(mx, my, 6 / view.s, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#222';
        ctx.font = 'bold ' + (10 / view.s) + 'px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('+', mx, my + 0.5 / view.s);
    });
    ctx.restore();
}

function doorGapSync() {
    var p = $('doorGapPanel');
    if (!p) return;
    p.style.display = doorGapActive() ? '' : 'none';
    if (!doorGapActive()) return;
    if (doorGap.ver !== wallsVersion || doorGap.gs !== gridSize()) { doorGapCompute(); return; } // compute 里会再同步一次
    $('dgMax').value = String(doorGap.maxCells);
    $('dgType').value = doorGap.type;
    var n = doorGap.list.length;
    $('dgAll').disabled = !n;
    $('dgAll').textContent = '全部补上' + (n ? '（' + n + '）' : '');
    $('dgInfo').textContent = n ? '黄色虚线是找到的缺口：点一下补一处，Shift+点忽略' :
        '没有找到缺口（只认得开放的墙线之间的缺口；闭合的房间轮廓请在「选择」里双击加拐点、拆成单段后把门洞那段改成门）';
}

// ===================== 3. 房间笔记 =====================
function noteRadius() { return Math.max(gridSize() * 0.3, 11 / view.s); }
function noteItems() {
    return Object.keys(scene.items).map(function(id) { return scene.items[id]; }).filter(function(it) { return it.kind === 'note'; })
        .sort(function(a, b) { return String(a.num || '').localeCompare(String(b.num || ''), 'zh', { numeric: true }) || (a.z || 0) - (b.z || 0); });
}
function nextNoteNum() {
    var max = 0;
    noteItems().forEach(function(it) { var n = parseInt(it.num, 10); if (n > max) max = n; });
    return String(max + 1);
}

function createNoteAt(w) {
    var it = { id: genId(), kind: 'note', x: Math.round(w.x), y: Math.round(w.y), z: nextZ(), num: nextNoteNum(), hidden: true };
    createItems([it]);
    selectOnly([it.id]);
    renderNotesPane();
    setTimeout(function() { var el = $('selPanel').querySelector('[data-prop=title]'); if (el) el.focus(); }, 30);
}

function drawNotes(items) {
    if (!me.gm || $('fogPreview').checked) return;
    var r = noteRadius();
    items.forEach(function(it) {
        if (it.kind !== 'note') return;
        var label = String(it.num || '').slice(0, 6) || '📌';
        ctx.save();
        ctx.beginPath(); ctx.arc(it.x, it.y, r, 0, Math.PI * 2);
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = it.color || '#ffca28';
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = (selected[it.id] ? 3 : 1.5) / view.s;
        ctx.strokeStyle = selected[it.id] ? '#ffffff' : 'rgba(0,0,0,0.7)';
        ctx.stroke();
        ctx.fillStyle = '#1b1d22';
        ctx.font = 'bold ' + (r * (label.length > 2 ? 0.75 : 1.05)) + 'px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, it.x, it.y + r * 0.06);
        ctx.restore();
        if (it.title && (selected[it.id] || r * view.s >= 10)) drawLabel(it.title, it.x, it.y + r, it.color || '#ffca28', true);
    });
}

function noteSelHtml(it) {
    var row = function(label, inner) { return '<div class="prop-row"><label>' + label + '</label>' + inner + '</div>'; };
    return row('编号', '<input class="tt-input narrow" data-prop="num" maxlength="6" value="' + escapeHtml(it.num || '') + '">' +
            '<input class="tt-input narrow" type="color" data-prop="color" value="' + escapeHtml(it.color || '#ffca28') + '" title="标记颜色">') +
        row('标题', '<input class="tt-input" data-prop="title" maxlength="60" placeholder="如：守卫室" value="' + escapeHtml(it.title || '') + '" style="flex:1;">') +
        '<div class="note-field"><label>GM 笔记（怪物、陷阱、宝藏、剧情）</label><textarea class="tt-input" data-prop="text" rows="5" maxlength="4000">' + escapeHtml(it.text || '') + '</textarea></div>' +
        '<div class="note-field"><label>朗读 / 给玩家看的文字</label><textarea class="tt-input" data-prop="read" rows="3" maxlength="4000">' + escapeHtml(it.read || '') + '</textarea></div>' +
        '<div class="prop-btns"><button class="tt-btn small primary" data-act="noteShow" title="把朗读文字做成讲义推给玩家">📢 展示给玩家</button>' +
        '<button class="tt-btn small" data-act="notePane">笔记列表</button></div>' +
        '<div class="tt-hint">只有 GM 看得到。拖动可移动；工具栏 📌 单击地图继续放置。</div>';
}

function focusNote(id) {
    var it = scene.items[id];
    if (!it) return;
    view.x = canvas.clientWidth / 2 - it.x * view.s;
    view.y = canvas.clientHeight / 2 - it.y * view.s;
    if (tool !== 'select' && tool !== 'note') setTool('select');
    selectOnly([id]);
}

// 属性面板按钮（墙体编辑 / 笔记）；处理了返回 true
function prepSelAct(act, ids) {
    if (!act) return false;
    if (/^w(set-|seg-|segdel$|explode$|merge$)/.test(act)) { wallSelAct(act, ids); return true; }
    var it = scene.items[ids[0]];
    if (act === 'noteShow' && it) {
        openHandoutEditor(null, { title: it.title || ('笔记 ' + (it.num || '')), text: it.read || '' });
        return true;
    }
    if (act === 'notePane') { switchPane('notes'); return true; }
    return false;
}

// ===================== 4. 讲义 / 侧栏「团本 / 线索」 =====================
var handouts = [], hoEdit = null, notesPaneTimer = null, noteQuery = '';

function onHandoutsState(list) { handouts = list || []; renderNotesPane(); }

function onHandoutMsg(m) {
    if (m.type === 'handout') {
        var i = handouts.findIndex(function(h) { return h.id === m.h.id; });
        if (i >= 0) handouts[i] = m.h; else handouts.push(m.h);
        if (m.popup && !me.gm) {
            showHandout(m.h);
            var tab = document.querySelector('.side-tab[data-pane="notes"]');
            if (tab && !tab.classList.contains('active')) tab.classList.add('has-new');
        }
    } else {
        handouts = handouts.filter(function(h) { return m.ids.indexOf(h.id) < 0; });
        if ($('hoView').dataset.id && m.ids.indexOf($('hoView').dataset.id) >= 0) closeHandoutView();
    }
    renderNotesPane();
}

function notesDirty() {
    clearTimeout(notesPaneTimer);
    notesPaneTimer = setTimeout(renderNotesPane, 120);
}

function hoToText(h) { return h.to && h.to.length ? '给 ' + h.to.join('、') : '全体'; }

function renderNotesPane() {
    var pane = $('notesPane');
    if (!pane) return;
    var tab = document.querySelector('.side-tab[data-pane="notes"]');
    if (tab) tab.textContent = me.gm ? '📌 团本' : '📌 线索';
    var a = document.activeElement;
    if (a && a.id === 'noteFilter') { if ($('noteListBox')) $('noteListBox').innerHTML = noteListHtml(); return; } // 正在输入搜索词
    var h = '';
    if (me.gm) {
        h += '<div class="side-section"><h5>本场景笔记 <button class="tt-btn small" data-np="newnote" title="切到 📌 工具，在地图上单击放置">＋ 放置笔记</button></h5>' +
            '<input class="tt-input" id="noteFilter" placeholder="搜索笔记" value="' + escapeHtml(noteQuery) + '" style="width:100%;margin-bottom:6px;">' +
            '<div id="noteListBox">' + noteListHtml() + '</div>';
        h += '</div><div class="side-section"><h5>讲义 <button class="tt-btn small" data-np="newho">＋ 新建讲义</button></h5>';
        if (handouts.length) {
            h += '<ul class="ho-list">' + handouts.slice().reverse().map(function(x) {
                return '<li data-hoview="' + x.id + '">' + (x.img ? '<img src="' + escapeHtml(assetURL(x.img)) + '" alt="">' : '<span class="ho-icon">📜</span>') +
                    '<div class="ho-main"><div>' + escapeHtml(x.title) + '</div><div class="tt-hint">' + escapeHtml(hoToText(x)) + ' · ' + (x.shown ? '已展示' : '未展示') + '</div></div>' +
                    '<span class="ho-btns"><button class="tt-btn small" data-hoshow="' + x.id + '" title="弹到玩家屏幕上">展示</button>' +
                    '<button class="tt-btn small" data-hoedit="' + x.id + '">编辑</button>' +
                    '<button class="tt-btn small danger" data-hodel="' + x.id + '">✕</button></span></li>';
            }).join('') + '</ul>';
        } else {
            h += '<div class="tt-hint">把信件、告示、线索图、NPC 画像提前做成讲义，跑团时一键弹到全体或指定玩家的屏幕上，玩家之后可以在「线索」里反复看。</div>';
        }
        h += '</div>' + dmPaneHtml();
    } else {
        h += '<div class="side-section"><h5>收到的讲义与线索</h5>';
        if (handouts.length) {
            h += '<ul class="ho-list">' + handouts.slice().reverse().map(function(x) {
                return '<li data-hoview="' + x.id + '">' + (x.img ? '<img src="' + escapeHtml(assetURL(x.img)) + '" alt="">' : '<span class="ho-icon">📜</span>') +
                    '<div class="ho-main"><div>' + escapeHtml(x.title) + '</div><div class="tt-hint">' + escapeHtml((x.text || '').replace(/\s+/g, ' ').slice(0, 50)) + '</div></div></li>';
            }).join('') + '</ul>';
        } else h += '<div class="tt-hint">GM 展示给你的信件、告示、线索图会出现在这里，可以随时点开再看。</div>';
        h += '</div>';
    }
    pane.innerHTML = h;
}

function noteListHtml() {
    var q = noteQuery.trim().toLowerCase();
    var notes = noteItems().filter(function(it) {
        return !q || [it.num, it.title, it.text, it.read].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    if (!notes.length) return '<div class="tt-hint">' + (q ? '没有匹配的笔记' : '用工具栏的 📌 在地图上单击放置编号笔记（只有 GM 看得到），写上房间描述、朗读文字、怪物和宝藏。跑团时点列表就能跳到那个房间。') + '</div>';
    return '<ul class="note-list">' + notes.map(function(it) {
        var ex = (it.text || it.read || '').replace(/\s+/g, ' ').slice(0, 60);
        return '<li data-note="' + it.id + '"' + (selected[it.id] ? ' class="active"' : '') + '><b class="note-num" style="background:' + escapeHtml(it.color || '#ffca28') + '">' +
            escapeHtml(String(it.num || '•').slice(0, 6)) + '</b><div><div>' + escapeHtml(it.title || '（未命名）') + '</div>' +
            (ex ? '<div class="tt-hint">' + escapeHtml(ex) + '</div>' : '') + '</div></li>';
    }).join('') + '</ul>';
}

function onNotesPaneClick(e) {
    if (dmPaneClick(e)) return; // 遭遇 / 随机表（tabletop-dm.js）
    var el = e.target.closest('[data-np],[data-note],[data-hoshow],[data-hoedit],[data-hodel],[data-hoview]');
    if (!el) return;
    if (el.dataset.np === 'newnote') { setTool('note'); notice('在地图上单击放置笔记'); return; }
    if (el.dataset.np === 'newho') { openHandoutEditor(null); return; }
    if (el.dataset.note) { focusNote(el.dataset.note); return; }
    if (el.dataset.hoshow) { op({ op: 'handout.show', text: el.dataset.hoshow }).then(function(r) { if (r) notice('已展示给玩家'); }); return; }
    if (el.dataset.hoedit) { openHandoutEditor(handouts.find(function(h) { return h.id === el.dataset.hoedit; })); return; }
    if (el.dataset.hodel) {
        var hd = handouts.find(function(h) { return h.id === el.dataset.hodel; });
        if (hd) ttAsk({ title: '删除讲义', text: '删除讲义「' + hd.title + '」？玩家那边也会一起消失。', ok: '删除', danger: true }).then(function(ok) { if (ok) op({ op: 'handout.delete', ids: [hd.id] }); });
        return;
    }
    if (el.dataset.hoview) { var hv = handouts.find(function(h) { return h.id === el.dataset.hoview; }); if (hv) showHandout(hv); }
}

// ---------- 讲义查看 ----------
function showHandout(h) {
    var v = $('hoView');
    v.dataset.id = h.id;
    $('hvTitle').textContent = h.title || '讲义';
    $('hvImg').innerHTML = h.img ? '<a href="' + escapeHtml(assetURL(h.img)) + '" target="_blank" rel="noopener" title="点击在新标签页查看原图"><img src="' + escapeHtml(assetURL(h.img)) + '" alt=""></a>' : '';
    $('hvText').textContent = h.text || '';
    $('hvText').style.display = h.text ? '' : 'none';
    $('hvMeta').textContent = me.gm ? hoToText(h) + (h.shown ? ' · 已展示' : ' · 还没展示') : '';
    v.style.display = '';
}
function closeHandoutView() { $('hoView').style.display = 'none'; $('hoView').dataset.id = ''; }

// ---------- 讲义编辑（GM） ----------
function hoRecipients(extra) {
    var names = {};
    (users || []).forEach(function(u) { if (!u.gm) names[u.name] = true; });
    Object.keys(sheets || {}).forEach(function(id) { var o = sheets[id].owner; if (o) names[o] = true; });
    Object.keys(scene.items).forEach(function(id) { var o = scene.items[id].owner; if (o) names[o] = true; });
    (extra || []).forEach(function(n) { names[n] = true; });
    delete names[me.name];
    return Object.keys(names).sort();
}

function openHandoutEditor(h, prefill) {
    hoEdit = h ? JSON.parse(JSON.stringify(h)) : { id: '', title: '', text: '', img: '', to: [] };
    if (prefill) { hoEdit.title = prefill.title || ''; hoEdit.text = prefill.text || ''; }
    $('hoTitle').value = hoEdit.title || '';
    $('hoText').value = hoEdit.text || '';
    var lib = (room.assets || []).filter(function(a) { return a.kind === 'map' || a.kind === 'token'; });
    $('hoLib').innerHTML = '<option value="">从资产库选图…</option>' + lib.map(function(a) { return '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + '</option>'; }).join('');
    var names = hoRecipients(hoEdit.to), all = !hoEdit.to || !hoEdit.to.length;
    $('hoTo').innerHTML = '<label><input type="checkbox" data-hoall' + (all ? ' checked' : '') + '> 全体玩家</label>' + names.map(function(n) {
        return '<label><input type="checkbox" data-hoto="' + escapeHtml(n) + '"' + (!all && hoEdit.to.indexOf(n) >= 0 ? ' checked' : '') + (all ? ' disabled' : '') + '> ' + escapeHtml(n) + '</label>';
    }).join('') + (names.length ? '' : '<span class="tt-hint">（还没有玩家进过房间，只能发给全体）</span>');
    hoImgPreview();
    $('hoDialog').style.display = '';
    setTimeout(function() { $('hoTitle').focus(); }, 30);
}

function hoImgPreview() {
    $('hoImgPrev').innerHTML = hoEdit.img ? '<img src="' + escapeHtml(assetURL(hoEdit.img)) + '" alt="">' : '';
    $('hoNoImg').style.display = hoEdit.img ? '' : 'none';
}

function closeHandoutEditor() { $('hoDialog').style.display = 'none'; hoEdit = null; }

function saveHandout(show) {
    if (!hoEdit) return;
    var to = [];
    if (!$('hoTo').querySelector('[data-hoall]').checked) {
        $('hoTo').querySelectorAll('[data-hoto]').forEach(function(c) { if (c.checked) to.push(c.dataset.hoto); });
        if (!to.length) { notice('选择要给哪些玩家，或者勾上「全体玩家」', true); return; }
    }
    var body = { id: hoEdit.id || genId(), title: $('hoTitle').value.trim(), text: $('hoText').value, img: hoEdit.img || '', to: to };
    if (!body.title && !body.text.trim() && !body.img) { notice('讲义是空的：写点文字或放一张图', true); return; }
    op({ op: 'handout', handout: body, mode: show ? 'show' : '' }).then(function(r) {
        if (!r) return;
        notice(show ? '已展示给' + (to.length ? ' ' + to.join('、') : '全体玩家') : '已保存讲义（还没给玩家看）');
        closeHandoutEditor();
        switchPane('notes');
    });
}

function initPrep() {
    $('notesPane').addEventListener('click', onNotesPaneClick);
    $('notesPane').addEventListener('input', function(e) { if (e.target.id === 'noteFilter') { noteQuery = e.target.value; $('noteListBox').innerHTML = noteListHtml(); } });
    document.querySelector('.side-tabs').addEventListener('click', function(e) {
        var t = e.target.closest('[data-pane="notes"]');
        if (t) t.classList.remove('has-new');
    });
    $('hoView').addEventListener('click', function(e) { if (e.target === this || e.target.closest('[data-hvclose]')) closeHandoutView(); });
    $('hoCancel').addEventListener('click', closeHandoutEditor);
    $('hoSave').addEventListener('click', function() { saveHandout(false); });
    $('hoShow').addEventListener('click', function() { saveHandout(true); });
    $('hoPick').addEventListener('click', function() { $('hoFile').click(); });
    $('hoNoImg').addEventListener('click', function() { if (hoEdit) { hoEdit.img = ''; hoImgPreview(); } });
    $('hoLib').addEventListener('change', function() { if (hoEdit && this.value) { hoEdit.img = this.value; hoImgPreview(); } this.value = ''; });
    $('hoFile').addEventListener('change', function() {
        var f = this.files && this.files[0];
        this.value = '';
        if (!f || !hoEdit) return;
        notice('正在上传图片…');
        uploadAsset(f, 'handout').then(function(a) { if (a && hoEdit) { hoEdit.img = a.id; hoImgPreview(); notice('图片已上传'); } }).catch(function(err) { notice(String(err && err.message || err || '上传失败'), true); });
    });
    $('hoTo').addEventListener('change', function(e) {
        if (e.target.dataset.hoall === undefined) return;
        var all = e.target.checked;
        this.querySelectorAll('[data-hoto]').forEach(function(c) { c.disabled = all; });
    });
    $('dgMax').addEventListener('change', function() { doorGap.maxCells = parseFloat(this.value) || 1.5; doorGap.ver = -1; requestRender(); });
    $('dgType').addEventListener('change', function() { doorGap.type = this.value; doorGapSync(); requestRender(); });
    $('dgAll').addEventListener('click', doorGapAll);
    $('dgReset').addEventListener('click', function() { doorGap.ignored = {}; doorGap.ver = -1; requestRender(); });
    window.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && $('hoView').style.display !== 'none') closeHandoutView();
        if (e.key === 'Escape' && $('hoDialog').style.display !== 'none') closeHandoutEditor();
    });
    renderNotesPane();
}
