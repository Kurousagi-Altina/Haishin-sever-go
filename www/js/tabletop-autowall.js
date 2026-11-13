// ===== 自动画墙（墙体工具 → 🪄 自动）=====
// 全部在浏览器里算：把框内的地图图片画到离屏 canvas 上取像素（地图是同源的 /tabletop-assets/，不会污染 canvas）。
//   墙体模式（默认，适合写实 / 彩色地图）：墙 = 两条方向相反、间距等于墙厚的平行边缘，中间比较平整，并沿墙方向延续。
//     横墙、竖墙各做一次匹配滤波（墙厚 0.08~0.45 格逐个试），沿墙方向平滑压掉短纹理 → 横跨墙的方向取极大值（= 墙的中线）
//     → 只留全图主导墙厚附近的 → 聚成横平竖直的线段 → 共线的接上、端点接到垂直的墙上 → 去掉孤立的短段（家具、楼梯）
//   线条模式：深色像素 → 开运算去掉网格等细线 → 闭运算补小缺口 → 去小斑点 → Zhang-Suen 细化成中心线 → 追踪成折线 → 道格拉斯-普克精简
//   地板模式：先拖框，再点地板（可点多个房间）→ 按颜色相近程度泛洪填充 → 填掉小洞（家具） → marching squares 取边界 → 精简
// 结果先画成青色虚线预览，滑块实时重算，满意了点「生成墙体」才真正创建（一次撤销可撤回）。

var autoWall = { mode: 'band', box: null, work: null, fill: null, seeds: [], lines: [], thr: -1, thick: 1, simp: 3, tol: 30, sens: 17, timer: 0 };
var AW_MAX = 1024; // 处理用的最大边长（像素），太大的框会先缩小

function autoWallActive() { return tool === 'wall' && wallOpts.mode === 'auto'; }

function autoWallSync() {
    var p = $('autoWallPanel');
    if (!p) return;
    p.style.display = autoWallActive() ? '' : 'none';
    p.querySelectorAll('[data-aw]').forEach(function(b) { b.classList.toggle('active', b.dataset.aw === autoWall.mode); });
    p.querySelectorAll('[data-awfor]').forEach(function(el) { el.style.display = el.dataset.awfor === autoWall.mode ? '' : 'none'; });
    $('awThr').value = autoWall.thr >= 0 ? autoWall.thr : (autoWall.work ? autoWall.work.otsu : 100);
    $('awThrV').textContent = autoWall.thr >= 0 ? autoWall.thr : '自动';
    $('awThick').value = autoWall.thick; $('awThickV').textContent = autoWall.thick;
    $('awSimp').value = autoWall.simp; $('awSimpV').textContent = autoWall.simp;
    $('awTol').value = autoWall.tol; $('awTolV').textContent = autoWall.tol;
    if ($('awSens')) { $('awSens').value = autoWall.sens; $('awSensV').textContent = autoWall.sens; }
    var n = autoWall.lines.length;
    $('awGo').disabled = !n;
    $('awGo').textContent = n ? '生成墙体（' + n + ' 段）' : '生成墙体';
    $('awInfo').textContent = !autoWall.box ? (autoWall.mode === 'band' ? '在地图上拖一个框，自动找出框里的墙，沿墙中间画线（右键取消）'
        : autoWall.mode === 'line' ? '在地图上拖一个框，自动找出框里的墙线' : '先拖框圈住房间，再点框里的地板（可点多个房间）')
        : autoWall.mode === 'floor' && !autoWall.seeds.length ? '点一下框里的地面（洞穴、岩浆图也可以点墙外的虚空 / 岩浆）；右键撤销上一个点'
        : n ? '青色虚线是预览：调滑块，或重新拖框' + (autoWall.skipped ? '（已跳过和现有墙重合的部分）' : '')
        : autoWall.skipped ? '识别到的墙都已经画过了'
        : autoWall.mode === 'band' ? '没找到横平竖直的墙：洞穴等不规则的墙用「点地板」（点地面，或点墙外的虚空 / 岩浆）' : '没有识别到墙，调一下滑块试试';
}

function autoWallClear() {
    autoWall.box = null; autoWall.work = null; autoWall.fill = null; autoWall.seeds = []; autoWall.lines = [];
    autoWallSync();
    requestRender();
}

// 手势：拖框 = 新的识别范围；地板模式下在框里单击 = 点地板
function autoWallPointerDown(w, start) {
    var b = autoWall.box;
    var inBox = autoWall.mode === 'floor' && b && autoWall.work && w.x >= b.x0 && w.x <= b.x1 && w.y >= b.y0 && w.y <= b.y1;
    gesture = { type: 'marquee', start: start, a: w, b: w, auto: true, click: inBox ? w : null };
}

function autoWallPointerUp(g) {
    if (g.start.moved) autoWallBox(g.a, g.b);
    else if (g.click) autoWallSeed(g.click);
}

function autoWallBox(a, b) {
    var p = scene.props;
    if (!p.mapAsset) { notice('当前场景没有地图图片', true); return; }
    var img = getImg(p.mapAsset);
    if (!imgReady(img)) { notice('地图还没加载完，稍等再试', true); return; }
    var mw = p.mapW || img.naturalWidth, mh = p.mapH || img.naturalHeight;
    var x0 = Math.max(0, Math.min(a.x, b.x)), y0 = Math.max(0, Math.min(a.y, b.y));
    var x1 = Math.min(mw, Math.max(a.x, b.x)), y1 = Math.min(mh, Math.max(a.y, b.y));
    var g = gridSize();
    if (x1 - x0 < g / 2 || y1 - y0 < g / 2) { notice('框太小了（至少半格）', true); return; }
    var ips = img.naturalWidth / mw; // 图片像素 / 世界单位
    var sw = (x1 - x0) * ips, sh = (y1 - y0) * ips;
    var k = Math.min(1, AW_MAX / Math.max(sw, sh));
    var W = Math.max(8, Math.round(sw * k)), H = Math.max(8, Math.round(sh * k));
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, x0 * ips, y0 * ips, sw, sh, 0, 0, W, H);
    var data;
    try { data = cx.getImageData(0, 0, W, H).data; } catch (e) { notice('无法读取地图像素', true); return; }
    var lum = new Uint8Array(W * H);
    for (var i = 0, j = 0; i < lum.length; i++, j += 4) lum[i] = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
    autoWall.box = { x0: x0, y0: y0, x1: x1, y1: y1 };
    autoWall.work = { W: W, H: H, sc: W / (x1 - x0), rgb: data, lum: lum, otsu: awOtsu(lum), blur: null };
    autoWall.fill = null; autoWall.seeds = [];
    autoWall.lines = [];
    if (autoWall.mode !== 'floor') awRun();
    autoWallSync();
    requestRender();
}

function autoWallSeed(w) {
    var wk = autoWall.work, b = autoWall.box;
    if (!wk) return;
    var px = Math.floor((w.x - b.x0) * wk.sc), py = Math.floor((w.y - b.y0) * wk.sc);
    if (px < 0 || py < 0 || px >= wk.W || py >= wk.H) return;
    autoWall.seeds.push({ x: w.x, y: w.y, px: px, py: py });
    awRun();
    autoWallSync();
    requestRender();
}

function awSchedule() {
    clearTimeout(autoWall.timer);
    autoWall.timer = setTimeout(function() { awRun(); autoWallSync(); requestRender(); }, 60);
}

function awRun() {
    var wk = autoWall.work;
    if (!wk) return;
    var paths = autoWall.mode === 'band' ? awBand(wk) : autoWall.mode === 'line' ? awLines(wk) : awFloor(wk);
    var b = autoWall.box, g = gridSize();
    var eps = Math.max(0.7, g * autoWall.simp / (autoWall.mode === 'floor' ? 8 : 20) * wk.sc), minLen = g * 0.4 * wk.sc; // 点地板只要大致轮廓，精简得狠一些
    var out = [];
    paths.forEach(function(pts) {
        if (pts.length < 2) return;
        var closed = pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
        var s = awSimplify(pts, eps);
        if (s.length < 2 || awLen(s) < minLen) return;
        if (closed && s.length < 4) return;
        out.push(s.map(function(p) { return [b.x0 + (p[0] + 0.5) / wk.sc, b.y0 + (p[1] + 0.5) / wk.sc]; }));
    });
    autoWall.lines = awDropExisting(out, g * 0.25, g * 0.3).slice(0, 400);
}

// 去掉和现有墙重合的部分（反复框同一块地方不会画出重复的墙）：沿线每隔一小段取样，离现有墙 tol 以内的算已经画过
function awDropExisting(lines, tol, minLen) {
    var segs = [];
    Object.keys(scene.items).forEach(function(id) {
        var it = scene.items[id];
        if (it.kind !== 'wall' || !it.points) return;
        for (var i = 1; i < it.points.length; i++) segs.push([it.x + it.points[i - 1][0], it.y + it.points[i - 1][1], it.x + it.points[i][0], it.y + it.points[i][1]]);
    });
    autoWall.skipped = false;
    if (!segs.length) return lines;
    var near = function(x, y, ux, uy) { // (ux, uy)：新线这一段的单位方向；只有方向基本平行的现有墙才算重合（垂直接上的不算）
        return segs.some(function(s) {
            var dx = s[2] - s[0], dy = s[3] - s[1], L2 = dx * dx + dy * dy;
            if (L2 && Math.abs(dx * uy - dy * ux) / Math.sqrt(L2) > 0.34) return false;
            var t = L2 ? Math.max(0, Math.min(1, ((x - s[0]) * dx + (y - s[1]) * dy) / L2)) : 0;
            return Math.hypot(x - s[0] - t * dx, y - s[1] - t * dy) <= tol;
        });
    };
    var out = [];
    lines.forEach(function(pts) {
        var cur = null, tail = null; // cur：当前这段没画过的部分；tail：它最后一个取样点（还不是拐点）
        var close = function() {
            if (cur) { if (tail) cur.push(tail); if (awLen(cur) >= minLen) out.push(cur); }
            cur = null; tail = null;
        };
        for (var i = 1; i < pts.length; i++) {
            var a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, k = Math.max(1, Math.ceil(L / tol));
            var ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
            for (var j = i === 1 ? 0 : 1; j <= k; j++) {
                var q = [a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k];
                if (near(q[0], q[1], ux, uy)) { autoWall.skipped = true; close(); continue; }
                if (!cur) { cur = [q]; tail = null; } else if (j === k) { cur.push(q); tail = null; } else tail = q;
            }
        }
        close();
    });
    return out;
}

function autoWallCommit() {
    var lines = autoWall.lines;
    if (!lines.length) return;
    var z = nextZ(), items = [];
    lines.forEach(function(pts) {
        for (var s = 0; s < pts.length - 1; s += 199) { // 太长的折线拆开
            var part = pts.slice(s, s + 200);
            if (part.length < 2) continue;
            var o = part[0];
            items.push({ id: genId(), kind: 'wall', wtype: 'wall', x: Math.round(o[0] * 10) / 10, y: Math.round(o[1] * 10) / 10, z: z + items.length,
                points: part.map(function(p) { return [Math.round((p[0] - o[0]) * 10) / 10, Math.round((p[1] - o[1]) * 10) / 10]; }) });
        }
    });
    createItems(items);
    notice('已生成 ' + items.length + ' 段墙体（Ctrl+Z 可撤销）；门洞可以用「🚪 找门洞」一键补门，多余的墙在「选择」里框选删除', false, 6000);
    autoWallClear();
}

// ---------- 墙体模式 ----------
// 一维滑动平均（越界当 0）：horiz = 沿行方向
function awBox1D(src, W, H, k, horiz) {
    var out = new Float32Array(W * H), r = k >> 1, x, y, s, i;
    if (k <= 1) { out.set(src); return out; }
    if (horiz) {
        for (y = 0; y < H; y++) {
            var row = y * W;
            s = 0;
            for (x = 0; x < Math.min(r, W); x++) s += src[row + x];
            for (x = 0; x < W; x++) {
                if (x + r < W) s += src[row + x + r];
                if (x - r - 1 >= 0) s -= src[row + x - r - 1];
                out[row + x] = s / k;
            }
        }
    } else {
        for (x = 0; x < W; x++) {
            s = 0;
            for (y = 0; y < Math.min(r, H); y++) s += src[y * W + x];
            for (y = 0; y < H; y++) {
                if (y + r < H) s += src[(y + r) * W + x];
                if (y - r - 1 >= 0) s -= src[(y - r - 1) * W + x];
                out[y * W + x] = s / k;
            }
        }
    }
    return out;
}

// 墙带匹配滤波：axis 0 = 横墙（看上下方向的亮度变化），1 = 竖墙。返回每个像素的最佳响应和对应的半墙厚
function awBandResp(L, W, H, axis, hmin, hmax, along) {
    var n = W * H, gd = new Float32Array(n), ag = new Float32Array(n), i, x, y;
    var st = axis === 0 ? W : 1;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
        i = y * W + x;
        var c = axis === 0 ? y : x, lim = axis === 0 ? H : W;
        if (c > 0 && c < lim - 1) { gd[i] = (L[i + st] - L[i - st]) / 2; ag[i] = Math.abs(gd[i]); }
    }
    var best = new Float32Array(n), bh = new Uint8Array(n), r = new Float32Array(n);
    for (var h = hmin; h <= hmax; h++) {
        var inner = awBox1D(ag, W, H, Math.max(1, 2 * h - 3) | 1, axis === 1);
        for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
            i = y * W + x;
            var c2 = axis === 0 ? y : x, lim2 = axis === 0 ? H : W, v = 0;
            if (c2 - h >= 0 && c2 + h < lim2) {
                var a = gd[i - h * st], b = gd[i + h * st];
                if (a * b < 0) v = Math.max(0, Math.min(Math.abs(a), Math.abs(b)) - inner[i] * 0.5); // 两侧边缘方向相反，中间平整
            }
            r[i] = v;
        }
        var sm = awBox1D(r, W, H, along, axis === 0); // 沿墙方向平滑：短纹理被压下去
        for (i = 0; i < n; i++) if (sm[i] > best[i]) { best[i] = sm[i]; bh[i] = h; }
    }
    return { R: best, Hh: bh };
}

function awBand(wk) {
    var W = wk.W, H = wk.H, n = W * H, cell = gridSize() * wk.sc, i, x, y;
    if (!wk.band) {
        var L0 = new Float32Array(n);
        for (i = 0; i < n; i++) L0[i] = wk.lum[i];
        var L = awBox1D(awBox1D(L0, W, H, 3, true), W, H, 3, false);
        var hmin = Math.max(2, Math.floor(cell * 0.08)), hmax = Math.max(hmin + 1, Math.min(40, Math.floor(cell * 0.45)));
        var along = Math.max(5, Math.floor(cell * 0.6)) | 1;
        wk.band = [awBandResp(L, W, H, 0, hmin, hmax, along), awBandResp(L, W, H, 1, hmin, hmax, along)];
    }
    var thr = Math.max(1, 22 - autoWall.sens);
    // 横跨墙的方向取极大值 = 墙的中线
    var masks = wk.band.map(function(b, axis) {
        var st = axis === 0 ? W : 1, m = new Uint8Array(n);
        for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
            i = y * W + x;
            var v = b.R[i];
            if (v > thr && v >= b.R[i - st] && v > b.R[i + st]) m[i] = 1;
        }
        return m;
    });
    // 全图主导墙厚：同一张地图的墙一般一样厚，厚度差太多的（地板缝、家具）去掉
    var hist = [];
    wk.band.forEach(function(b, axis) { for (i = 0; i < n; i++) if (masks[axis][i]) hist[b.Hh[i]] = (hist[b.Hh[i]] || 0) + b.R[i]; });
    var hd = 0, hb = -1;
    hist.forEach(function(v, h) { if (v > hb) { hb = v; hd = h; } });
    var hdTol = Math.max(2, hd * 0.4);
    wk.band.forEach(function(b, axis) { for (i = 0; i < n; i++) if (masks[axis][i] && Math.abs(b.Hh[i] - hd) > hdTol) masks[axis][i] = 0; });
    var segs = awBandSegs(masks[0], W, H, 0, cell).concat(awBandSegs(masks[1], W, H, 1, cell));
    segs = awBandPrune(awBandJoin(segs, cell), cell);
    return segs.map(function(s) {
        return s.o === 'h' ? [[s.a, s.p], [s.b, s.p]] : [[s.p, s.a], [s.p, s.b]];
    });
}

// 中线像素 → 横平竖直的线段 {o: 'h'|'v', p: 横墙的 y / 竖墙的 x, a, b: 沿墙方向的起止}
function awBandSegs(m, W, H, axis, cell) {
    var gap = Math.max(1, Math.round(cell * 0.15)), n = W * H;
    var lab = new Int32Array(n), id = 0, stack = [], out = [];
    for (var i0 = 0; i0 < n; i0++) {
        if (!m[i0] || lab[i0]) continue;
        id++;
        lab[i0] = id; stack.length = 0; stack.push(i0);
        var ps = [], mn = 1e9, mx = -1e9, cmn = 1e9, cmx = -1e9;
        while (stack.length) {
            var p = stack.pop(), x = p % W, y = (p - x) / W;
            var al = axis === 0 ? x : y, cr = axis === 0 ? y : x;
            ps.push(cr);
            if (al < mn) mn = al; if (al > mx) mx = al; if (cr < cmn) cmn = cr; if (cr > cmx) cmx = cr;
            // 沿墙方向跨过 gap 个像素的小缺口，横跨方向只允许 1 像素抖动
            for (var da = -gap; da <= gap; da++) for (var dc = -1; dc <= 1; dc++) {
                var nx = axis === 0 ? x + da : x + dc, ny = axis === 0 ? y + dc : y + da;
                if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                var q = ny * W + nx;
                if (m[q] && !lab[q]) { lab[q] = id; stack.push(q); }
            }
        }
        var len = mx - mn;
        if (len < cell * 0.7 || cmx - cmn > Math.max(3, len * 0.25)) continue;
        ps.sort(function(a, b) { return a - b; });
        out.push({ o: axis === 0 ? 'h' : 'v', p: ps[ps.length >> 1], a: mn, b: mx });
    }
    return out;
}

// 共线且离得近的接成一段；端点接到附近垂直的墙上（补拐角、丁字口）
function awBandJoin(S, cell) {
    var tol = cell * 0.15, gap = cell * 0.6, i, j, changed = true;
    while (changed) {
        changed = false;
        for (i = 0; i < S.length && !changed; i++) for (j = i + 1; j < S.length; j++) {
            var a = S[i], b = S[j];
            if (a.o !== b.o || Math.abs(a.p - b.p) > tol || b.a - a.b > gap || a.a - b.b > gap) continue;
            var la = a.b - a.a || 1, lb = b.b - b.a || 1;
            S[i] = { o: a.o, p: (a.p * la + b.p * lb) / (la + lb), a: Math.min(a.a, b.a), b: Math.max(a.b, b.b) };
            S.splice(j, 1);
            changed = true;
            break;
        }
    }
    S.forEach(function(s) {
        ['a', 'b'].forEach(function(e) {
            var best = null;
            S.forEach(function(t) {
                if (t.o === s.o || s.p < t.a - gap || s.p > t.b + gap) return;
                var d = t.p - s[e];
                if (Math.abs(d) <= gap && (best === null || Math.abs(d) < Math.abs(best - s[e]))) best = t.p;
            });
            if (best !== null) s[e] = best;
        });
        if (s.a > s.b) { var tmp = s.a; s.a = s.b; s.b = tmp; }
    });
    return S;
}

// 去掉孤立的短段：至少 1.5 格长，或者端点连着保留下来的墙
function awBandPrune(S, cell) {
    var touch = cell * 0.2;
    var ends = function(s) { return s.o === 'h' ? [[s.a, s.p], [s.b, s.p]] : [[s.p, s.a], [s.p, s.b]]; };
    var near = function(pt, t) {
        var al = t.o === 'h' ? pt[0] : pt[1], cr = t.o === 'h' ? pt[1] : pt[0];
        return al >= t.a - touch && al <= t.b + touch && Math.abs(cr - t.p) <= touch;
    };
    var keep = S.map(function(s) { return s.b - s.a >= cell * 1.5; }), changed = true;
    while (changed) {
        changed = false;
        S.forEach(function(s, i) {
            if (keep[i]) return;
            var hit = S.some(function(t, j) { return j !== i && keep[j] && ends(s).some(function(pt) { return near(pt, t); }); });
            if (hit) { keep[i] = true; changed = true; }
        });
    }
    return S.filter(function(s, i) { return keep[i]; });
}

// ---------- 线条模式 ----------
function awLines(wk) {
    var W = wk.W, H = wk.H, n = W * H, thr = autoWall.thr >= 0 ? autoWall.thr : wk.otsu;
    var m = new Uint8Array(n);
    for (var i = 0; i < n; i++) m[i] = wk.lum[i] < thr ? 1 : 0;
    var r = autoWall.thick;
    if (r > 0) m = awDilate(awErode(m, W, H, r), W, H, r); // 开运算：去掉比 2r+1 像素还细的线（网格线、纹理）
    m = awErode(awDilate(m, W, H, 1), W, H, 1);             // 闭运算：补上 1~2 像素的小缺口
    var g = gridSize() * wk.sc;
    awRemoveSmall(m, W, H, 1, Math.max(12, g * 0.6 * (2 * r + 1)));
    // 大片的深色（写实地图房间外的黑色虚空、实心墙体）按「块」处理：只取边缘；细的深色线才细化成中心线
    var R = Math.max(3, Math.round(g * 0.3));
    var solid = awDilate(awErode(m, W, H, R), W, H, R);
    awRemoveSmall(solid, W, H, 1, g * g * 0.5);
    var near = awDilate(solid, W, H, 2), thin = new Uint8Array(n), hasSolid = false;
    for (i = 0; i < n; i++) {
        if (solid[i]) hasSolid = true;
        thin[i] = m[i] && !near[i] ? 1 : 0;
    }
    awRemoveSmall(thin, W, H, 1, Math.max(12, g * 0.6 * (2 * r + 1)));
    awThin(thin, W, H);
    var out = awTrace(thin, W, H, g * 0.4);
    return hasSolid ? awContours(solid, W, H).concat(out) : out;
}

// Otsu：自动挑一个把「深色线」和「背景」分开的亮度阈值
function awOtsu(lum) {
    var hist = new Array(256).fill(0), n = lum.length, sum = 0;
    for (var i = 0; i < n; i++) hist[lum[i]]++;
    for (var t = 0; t < 256; t++) sum += t * hist[t];
    var sumB = 0, wB = 0, best = 0, thr = 100;
    for (t = 0; t < 256; t++) {
        wB += hist[t];
        if (!wB) continue;
        var wF = n - wB;
        if (!wF) break;
        sumB += t * hist[t];
        var mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
        if (v > best) { best = v; thr = t; }
    }
    return thr;
}

function awIntegral(m, W, H) {
    var S = new Int32Array((W + 1) * (H + 1));
    for (var y = 0; y < H; y++) {
        var row = 0;
        for (var x = 0; x < W; x++) {
            row += m[y * W + x];
            S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
        }
    }
    return S;
}

function awWindow(S, W, H, x, y, r) {
    var xa = Math.max(0, x - r), ya = Math.max(0, y - r), xb = Math.min(W, x + r + 1), yb = Math.min(H, y + r + 1);
    var sum = S[yb * (W + 1) + xb] - S[ya * (W + 1) + xb] - S[yb * (W + 1) + xa] + S[ya * (W + 1) + xa];
    return [sum, (xb - xa) * (yb - ya)];
}

function awErode(m, W, H, r) {
    var S = awIntegral(m, W, H), out = new Uint8Array(W * H);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        if (!m[y * W + x]) continue;
        var s = awWindow(S, W, H, x, y, r);
        out[y * W + x] = s[0] === s[1] ? 1 : 0;
    }
    return out;
}

function awDilate(m, W, H, r) {
    var S = awIntegral(m, W, H), out = new Uint8Array(W * H);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) out[y * W + x] = awWindow(S, W, H, x, y, r)[0] > 0 ? 1 : 0;
    return out;
}

// 去掉面积小于 minArea 的连通块（值为 v 的像素，8 连通）；keepBorder = 碰到边框的块保留
function awRemoveSmall(m, W, H, v, minArea, keepBorder, setTo) {
    var seen = new Uint8Array(W * H), stack = [], comp = [];
    for (var i = 0; i < W * H; i++) {
        if (seen[i] || m[i] !== v) continue;
        stack.length = 0; comp.length = 0;
        stack.push(i); seen[i] = 1;
        var border = false;
        while (stack.length) {
            var p = stack.pop(), x = p % W, y = (p - x) / W;
            comp.push(p);
            if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
            for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
                var nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                var q = ny * W + nx;
                if (!seen[q] && m[q] === v) { seen[q] = 1; stack.push(q); }
            }
        }
        if (comp.length < minArea && !(keepBorder && border)) comp.forEach(function(q) { m[q] = setTo == null ? 0 : setTo; });
    }
}

// Zhang-Suen 细化，再去掉阶梯拐角上的多余像素（让每段线上的点都只有两个邻居）
function awThin(m, W, H) {
    var changed = true, del = [];
    var at = function(x, y) { return x < 0 || y < 0 || x >= W || y >= H ? 0 : m[y * W + x]; };
    for (var iter = 0; changed && iter < 200; iter++) {
        changed = false;
        for (var pass = 0; pass < 2; pass++) {
            del.length = 0;
            for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
                if (!m[y * W + x]) continue;
                var p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1),
                    p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
                var B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
                if (B < 2 || B > 6) continue;
                var seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2], A = 0;
                for (var k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++;
                if (A !== 1) continue;
                if (pass === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
                del.push(y * W + x);
            }
            if (del.length) { changed = true; del.forEach(function(i) { m[i] = 0; }); }
        }
    }
    // 简单点：环上的邻居只构成一个 8 连通块、且不是端点 → 删掉不影响连通（阶梯拐角上的多余像素）
    var ring = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]; // N NE E SE S SW W NW
    for (var y2 = 0; y2 < H; y2++) for (var x2 = 0; x2 < W; x2++) {
        if (!m[y2 * W + x2]) continue;
        var v = ring.map(function(d) { return at(x2 + d[0], y2 + d[1]); });
        var cnt = v.reduce(function(s, a) { return s + a; }, 0);
        if (cnt < 2) continue;
        var par = [0, 1, 2, 3, 4, 5, 6, 7];
        var find = function(a) { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
        var join = function(a, b) { par[find(a)] = find(b); };
        for (var k2 = 0; k2 < 8; k2++) {
            if (v[k2] && v[(k2 + 1) % 8]) join(k2, (k2 + 1) % 8);          // 环上相邻的两个点总是 8 相邻
            if (k2 % 2 === 0 && v[k2] && v[(k2 + 2) % 8]) join(k2, (k2 + 2) % 8); // 两个 4 邻居（如 上、右）斜着相邻
        }
        var roots = {};
        for (k2 = 0; k2 < 8; k2++) if (v[k2]) roots[find(k2)] = 1;
        if (Object.keys(roots).length === 1) m[y2 * W + x2] = 0;
    }
}

// 骨架 → 折线：度数 ≠ 2 的点是节点（端点 / 岔口），节点之间走一遍；剩下的是闭环
function awTrace(m, W, H, minLen) {
    var N = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]]; // 4 邻居优先
    var nb = function(i) {
        var x = i % W, y = (i - x) / W, out = [];
        N.forEach(function(d) {
            var nx = x + d[0], ny = y + d[1];
            if (nx >= 0 && ny >= 0 && nx < W && ny < H && m[ny * W + nx]) out.push(ny * W + nx);
        });
        return out;
    };
    var deg = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) if (m[i]) deg[i] = nb(i).length;
    var isNode = function(i) { return deg[i] !== 2; };
    var used = new Uint8Array(W * H), edgeSeen = {}, paths = [];
    var xy = function(i) { var x = i % W; return [x, (i - x) / W]; };
    var walk = function(a, b) {
        var path = [a, b], prev = a, cur = b;
        while (!isNode(cur)) {
            used[cur] = 1;
            var next = nb(cur).filter(function(q) { return q !== prev && (!used[q] || isNode(q)); })[0];
            if (next == null) break;
            prev = cur; cur = next; path.push(cur);
            if (cur === a) break;
        }
        return path;
    };
    for (i = 0; i < W * H; i++) {
        if (!m[i] || !isNode(i) || deg[i] === 0) continue;
        nb(i).forEach(function(q) {
            if (isNode(q)) {
                var key = Math.min(i, q) + ':' + Math.max(i, q);
                if (edgeSeen[key]) return;
                edgeSeen[key] = 1;
                paths.push({ px: [i, q], a: i, b: q });
                return;
            }
            if (used[q]) return;
            var p = walk(i, q);
            paths.push({ px: p, a: i, b: p[p.length - 1] });
        });
    }
    for (i = 0; i < W * H; i++) { // 没有节点的闭环
        if (!m[i] || used[i] || isNode(i)) continue;
        var nn = nb(i);
        var p2 = walk(i, nn[0]);
        p2.push(i);
        used[i] = 1;
        paths.push({ px: p2, a: -1, b: -1 });
    }
    // 去掉短的毛刺（一头是端点的短分支）和孤立的短线
    return paths.filter(function(p) {
        if (p.px.length * 1.2 >= minLen) return true;
        var endA = p.a >= 0 && deg[p.a] <= 1, endB = p.b >= 0 && deg[p.b] <= 1;
        return !(endA || endB);
    }).map(function(p) { return p.px.map(xy); });
}

// ---------- 地板模式 ----------
// 点一块地面（或墙外的虚空、岩浆），把和它连成一片的区域找出来，沿边缘围墙。可走的像素要同时满足：
//   不在强边缘上（先按 0.08 格模糊抹掉砖缝、木纹，再取梯度最大的那部分当屏障——洞穴的岩石边、墙的轮廓线），
//   颜色和点到的地方接近（按点击处周围半格的中位数 / 离散程度算，光照渐变也容得下）。
// 防漏：可走区域先腐蚀约 0.25 格再从点击处连通，窄于半格的缝（墙上的小缺口、边缘断开处）过不去，连通后再膨胀回来。
// 「容差」越大：边缘屏障越少、颜色范围越宽（填得更满，也更容易漏）
function awFloor(wk) {
    var W = wk.W, H = wk.H, n = W * H, i, x, y;
    if (!autoWall.seeds.length) return [];
    var cell = gridSize() * wk.sc, br = Math.max(1, Math.round(cell * 0.08));
    if (!wk.blur || wk.blurR !== br) { wk.blur = awBlurRGB(wk.rgb, W, H, br); wk.blurR = br; wk.grad = null; }
    var bl = wk.blur;
    if (!wk.grad) { // 模糊后的颜色梯度
        var gr = new Float32Array(n);
        for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
            i = y * W + x;
            var s2 = 0;
            for (var c = 0; c < 3; c++) {
                var gx = (bl[(i + 1) * 3 + c] - bl[(i - 1) * 3 + c]) / 2, gy = (bl[(i + W) * 3 + c] - bl[(i - W) * 3 + c]) / 2;
                s2 += gx * gx + gy * gy;
            }
            gr[i] = Math.sqrt(s2);
        }
        var smp = [];
        for (i = 0; i < n; i += 7) smp.push(gr[i]);
        smp.sort(function(a, b) { return a - b; });
        wk.grad = gr; wk.gradSorted = smp;
    }
    var tol = autoWall.tol, pct = Math.min(0.97, 0.8 + tol / 600), capk = Math.max(1, tol / 10) * Math.sqrt(3);
    var T = wk.gradSorted[Math.floor(wk.gradSorted.length * pct)];
    var r = Math.max(1, Math.round(cell * 0.25)), fill = new Uint8Array(n), lost = 0;
    autoWall.seeds.forEach(function(sd) {
        // 点击处周围半格的颜色：中位数 + 绝对偏差（不怕旁边有家具、灯光）
        var rr = Math.max(2, Math.round(cell * 0.5)), cols = [[], [], []];
        for (var yy = Math.max(0, sd.py - rr); yy < Math.min(H, sd.py + rr); yy++) for (var xx = Math.max(0, sd.px - rr); xx < Math.min(W, sd.px + rr); xx++) {
            var k = (yy * W + xx) * 3;
            cols[0].push(bl[k]); cols[1].push(bl[k + 1]); cols[2].push(bl[k + 2]);
        }
        var med = function(a) { a = a.slice().sort(function(p, q) { return p - q; }); return a[a.length >> 1]; };
        var mu = cols.map(med), sdv = cols.map(function(a, ci) { return med(a.map(function(v) { return Math.abs(v - mu[ci]); })) * 1.4826 + 4; });
        var free = new Uint8Array(n);
        for (i = 0; i < n; i++) {
            if (wk.grad[i] > T) continue;
            var d0 = (bl[i * 3] - mu[0]) / sdv[0], d1 = (bl[i * 3 + 1] - mu[1]) / sdv[1], d2 = (bl[i * 3 + 2] - mu[2]) / sdv[2];
            if (d0 * d0 + d1 * d1 + d2 * d2 < capk * capk) free[i] = 1;
        }
        var ero = awErode(free, W, H, r);
        // 点击处附近（2r 以内）最近的一个腐蚀后仍可走的像素作为起点
        var start = -1, bd = 1e9;
        for (var y2 = Math.max(0, sd.py - 2 * r); y2 <= Math.min(H - 1, sd.py + 2 * r); y2++) for (var x2 = Math.max(0, sd.px - 2 * r); x2 <= Math.min(W - 1, sd.px + 2 * r); x2++) {
            var d = (x2 - sd.px) * (x2 - sd.px) + (y2 - sd.py) * (y2 - sd.py);
            if (ero[y2 * W + x2] && d < bd) { bd = d; start = y2 * W + x2; }
        }
        if (start < 0) { lost++; return; }
        var reg = new Uint8Array(n), stack = [start];
        reg[start] = 1;
        while (stack.length) {
            var p = stack.pop(), px = p % W, py = (p - px) / W;
            if (px > 0 && ero[p - 1] && !reg[p - 1]) { reg[p - 1] = 1; stack.push(p - 1); }
            if (px < W - 1 && ero[p + 1] && !reg[p + 1]) { reg[p + 1] = 1; stack.push(p + 1); }
            if (py > 0 && ero[p - W] && !reg[p - W]) { reg[p - W] = 1; stack.push(p - W); }
            if (py < H - 1 && ero[p + W] && !reg[p + W]) { reg[p + W] = 1; stack.push(p + W); }
        }
        var grow = awDilate(reg, W, H, r), edge = awDilate(reg, W, H, 1);
        for (i = 0; i < n; i++) if (grow[i] && (free[i] || edge[i])) fill[i] = 1;
    });
    if (lost) notice('有 ' + lost + ' 个点附近太杂（纹理、家具），找不到成片的地面——换个空一点的地方点，或调大容差', true);
    // 只要大致轮廓（和手画一样沿边缘拉直线）：闭运算抹平小凹口、连上纹理处没填满的地方，开运算去掉细毛刺，2×2 格以内的障碍直接填掉
    var cr = Math.max(1, Math.round(cell * 0.4)), orr = Math.max(1, Math.round(cell * 0.2));
    fill = awErode(awDilate(fill, W, H, cr), W, H, cr);
    fill = awDilate(awErode(fill, W, H, orr), W, H, orr);
    awRemoveSmall(fill, W, H, 0, cell * cell * 4, true, 1);   // 区域里的小洞（家具、骨堆、花纹）填掉；大的石柱 / 岛保留
    awRemoveSmall(fill, W, H, 1, cell * cell * 0.25);         // 小碎块
    autoWall.fill = fill;
    return awContours(fill, W, H);
}

function awBlurRGB(rgb, W, H, r) {
    var out = new Float32Array(W * H * 3);
    for (var c = 0; c < 3; c++) {
        var ch = new Uint8Array(W * H);
        for (var i = 0; i < W * H; i++) ch[i] = rgb[i * 4 + c];
        var S = new Int32Array((W + 1) * (H + 1));
        for (var y = 0; y < H; y++) {
            var row = 0;
            for (var x = 0; x < W; x++) { row += ch[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; }
        }
        for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
            var s = awWindow(S, W, H, x, y, r);
            out[(y * W + x) * 3 + c] = s[0] / s[1];
        }
    }
    return out;
}

// marching squares：填充区域的边界（像素中心坐标，半像素处）；贴着框边的那几段不算墙
function awContours(m, W, H) {
    var at = function(x, y) { return x < 0 || y < 0 || x >= W || y >= H ? 0 : m[y * W + x]; };
    var segs = [];
    var edgePt = function(x, y, e) { // 单元格 (x,y)-(x+1,y+1) 的边中点：0 上 1 右 2 下 3 左
        return e === 0 ? [x + 0.5, y] : e === 1 ? [x + 1, y + 0.5] : e === 2 ? [x + 0.5, y + 1] : [x, y + 0.5];
    };
    var TABLE = { 1: [[3, 2]], 2: [[2, 1]], 3: [[3, 1]], 4: [[0, 1]], 5: [[3, 0], [2, 1]], 6: [[0, 2]], 7: [[3, 0]],
        8: [[0, 3]], 9: [[0, 2]], 10: [[0, 1], [3, 2]], 11: [[0, 1]], 12: [[3, 1]], 13: [[2, 1]], 14: [[3, 2]] };
    for (var y = -1; y < H; y++) for (var x = -1; x < W; x++) {
        var code = (at(x, y) ? 8 : 0) | (at(x + 1, y) ? 4 : 0) | (at(x + 1, y + 1) ? 2 : 0) | (at(x, y + 1) ? 1 : 0);
        var t = TABLE[code];
        if (!t) continue;
        t.forEach(function(e) {
            var a = edgePt(x, y, e[0]), b = edgePt(x, y, e[1]);
            var onEdge = function(p) { return p[0] < 1.5 || p[1] < 1.5 || p[0] > W - 2.5 || p[1] > H - 2.5; };
            if (onEdge(a) && onEdge(b)) return;
            segs.push([a, b]);
        });
    }
    // 把线段串成折线
    var key = function(p) { return p[0] * 2 + ',' + p[1] * 2; };
    var adj = {};
    segs.forEach(function(s, i) {
        [0, 1].forEach(function(k) { var kk = key(s[k]); (adj[kk] = adj[kk] || []).push(i); });
    });
    var used = new Uint8Array(segs.length), out = [];
    var chain = function(start) {
        var s = segs[start];
        used[start] = 1;
        var pts = [s[0], s[1]];
        [1, 0].forEach(function(dir) { // 先往后接，再往前接
            for (;;) {
                var end = dir ? pts[pts.length - 1] : pts[0];
                var next = (adj[key(end)] || []).filter(function(i) { return !used[i]; })[0];
                if (next == null) break;
                used[next] = 1;
                var sg = segs[next], other = key(sg[0]) === key(end) ? sg[1] : sg[0];
                if (dir) pts.push(other); else pts.unshift(other);
            }
        });
        return pts;
    };
    // 先从端点（只连一条线段的点）开始，剩下的是闭合轮廓
    segs.forEach(function(s, i) {
        if (used[i]) return;
        if ((adj[key(s[0])] || []).length === 1 || (adj[key(s[1])] || []).length === 1) out.push(chain(i));
    });
    segs.forEach(function(s, i) { if (!used[i]) out.push(chain(i)); });
    return out;
}

// ---------- 折线工具 ----------
function awLen(pts) {
    var l = 0;
    for (var i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return l;
}

function awSimplify(pts, eps) {
    if (pts.length < 3) return pts.slice();
    var closed = pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
    if (closed) { // 闭合的：从离起点最远的点切成两半分别精简
        var far = 0, fd = -1;
        pts.forEach(function(p, i) { var d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]); if (d > fd) { fd = d; far = i; } });
        var a = awRDP(pts.slice(0, far + 1), eps), b = awRDP(pts.slice(far), eps);
        return a.concat(b.slice(1));
    }
    return awRDP(pts, eps);
}

function awRDP(pts, eps) {
    if (pts.length < 3) return pts.slice();
    var keep = new Uint8Array(pts.length), stack = [[0, pts.length - 1]];
    keep[0] = keep[pts.length - 1] = 1;
    while (stack.length) {
        var r = stack.pop(), a = pts[r[0]], b = pts[r[1]], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9;
        var best = -1, bi = -1;
        for (var i = r[0] + 1; i < r[1]; i++) {
            var d = Math.abs(dy * (pts[i][0] - a[0]) - dx * (pts[i][1] - a[1])) / L;
            if (d > best) { best = d; bi = i; }
        }
        if (best > eps) { keep[bi] = 1; stack.push([r[0], bi], [bi, r[1]]); }
    }
    return pts.filter(function(p, i) { return keep[i]; });
}

// ---------- 绘制预览 ----------
function drawAutoWall() {
    if (!me.gm || (!autoWall.box && !autoWall.lines.length)) return;
    var b = autoWall.box;
    ctx.save();
    if (b) {
        ctx.strokeStyle = 'rgba(0,229,255,0.6)';
        ctx.lineWidth = 1 / view.s;
        ctx.setLineDash([6 / view.s, 4 / view.s]);
        ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    }
    var wk = autoWall.work;
    if (autoWall.mode === 'floor' && autoWall.fill && wk && b) { // 填充区域淡淡地铺一层
        if (!wk.fillCanvas || wk.fillSrc !== autoWall.fill) {
            var c = wk.fillCanvas || document.createElement('canvas');
            c.width = wk.W; c.height = wk.H;
            var cx = c.getContext('2d'), id = cx.createImageData(wk.W, wk.H);
            for (var i = 0; i < autoWall.fill.length; i++) if (autoWall.fill[i]) { id.data[i * 4 + 1] = 229; id.data[i * 4 + 2] = 255; id.data[i * 4 + 3] = 60; }
            cx.putImageData(id, 0, 0);
            wk.fillCanvas = c; wk.fillSrc = autoWall.fill;
        }
        ctx.drawImage(wk.fillCanvas, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    }
    ctx.setLineDash([8 / view.s, 5 / view.s]);
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 3 / view.s;
    ctx.lineJoin = 'round';
    autoWall.lines.forEach(function(pts) {
        ctx.beginPath();
        pts.forEach(function(p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
        ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.fillStyle = '#00e5ff';
    autoWall.seeds.forEach(function(s) { ctx.beginPath(); ctx.arc(s.x, s.y, 5 / view.s, 0, Math.PI * 2); ctx.fill(); });
    ctx.restore();
}

function initAutoWall() {
    var p = $('autoWallPanel');
    if (!p) return;
    p.addEventListener('click', function(e) {
        var b = e.target.closest('button');
        if (!b) return;
        e.stopPropagation();
        if (b.dataset.aw) {
            if (autoWall.mode !== b.dataset.aw) {
                autoWall.mode = b.dataset.aw;
                autoWall.seeds = []; autoWall.fill = null; autoWall.lines = [];
                if (autoWall.mode !== 'floor' && autoWall.work) awRun();
            }
        } else if (b.id === 'awGo') autoWallCommit();
        else if (b.id === 'awClear') autoWallClear();
        else if (b.id === 'awUndoSeed') { autoWall.seeds.pop(); awRun(); }
        else if (b.id === 'awAuto') { autoWall.thr = -1; awRun(); }
        autoWallSync();
        requestRender();
    });
    p.addEventListener('input', function(e) {
        var t = e.target;
        if (t.id === 'awThr') autoWall.thr = parseInt(t.value, 10);
        else if (t.id === 'awThick') autoWall.thick = parseInt(t.value, 10);
        else if (t.id === 'awSimp') autoWall.simp = parseInt(t.value, 10);
        else if (t.id === 'awTol') autoWall.tol = parseInt(t.value, 10);
        else if (t.id === 'awSens') autoWall.sens = parseInt(t.value, 10);
        else return;
        autoWallSync();
        awSchedule();
    });
    // 右键轻点 = 取消当前的识别（拖框 / 预览 / 地板点）；右键拖动仍然是平移
    var board = $('board'), rdown = null;
    if (board) {
        board.addEventListener('pointerdown', function(e) {
            rdown = e.button === 2 && autoWallActive() ? { x: e.clientX, y: e.clientY } : null;
        }, true);
        board.addEventListener('pointerup', function(e) {
            var d = rdown;
            rdown = null;
            if (!d || e.button !== 2 || !autoWallActive() || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
            if (gesture && gesture.auto) gesture = null;
            if (autoWall.mode === 'floor' && autoWall.seeds.length) { autoWall.seeds.pop(); awRun(); autoWallSync(); requestRender(); notice('已撤销上一个地面点（没有点了再右键 = 取消）'); }
            else if (autoWall.box || autoWall.lines.length) { autoWallClear(); notice('已取消自动识别'); }
        }, true);
    }
    window.addEventListener('keydown', function(e) {
        if (!autoWallActive() || /INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return;
        if (e.key === 'Escape' && (autoWall.box || autoWall.lines.length)) { autoWallClear(); e.preventDefault(); }
        else if (e.key === 'Enter' && autoWall.lines.length) { autoWallCommit(); e.preventDefault(); }
    });
    autoWallSync();
}
