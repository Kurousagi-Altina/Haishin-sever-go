// 跑团桌面：地图网格识别、多张地形拼接
// 1. mapGridDetect：识别地图图片自带的方格（周期 + 偏移）
// 2. 地形（kind tile）：一个场景里放多张地形图，每块单独对齐网格
// 3. 框一格：手动框出一个格子设网格

// 识别地图图片自带的方格：返回 { p: 每格像素, ox, oy: 第一条竖线 / 横线的位置（0 ≤ o < p）, conf: 可信度 }，像素都是传入图片的像素
// 思路：竖线 → 每一列「比左右两边暗 / 亮多少」累加成一条曲线，横线同理；网格线让曲线按周期 p 出现尖峰。
// 两条曲线做自相关找周期（取最小的那个基频，别选成 2 格、3 格），再用「梳子」在 ±1.5 像素里按 0.02 像素细调周期和起点。
function mapGridDetect(rgba, W, H) {
    var N = W * H, L = new Float32Array(N);
    for (var i = 0, j = 0; i < N; i++, j += 4) L[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    // 每个像素的「线条感」：和隔 1~2 像素的两侧平均比（取两种距离里大的），截掉最强的 5%（文字、墙这种粗边别压过网格）
    var line = function(horiz) {
        var v = new Float32Array(N), hist = new Uint32Array(256);
        for (var y = 2; y < H - 2; y++) for (var x = 2; x < W - 2; x++) {
            var i = y * W + x, s = horiz ? W : 1;
            var a = Math.abs(L[i] - (L[i - s] + L[i + s]) / 2), b = Math.abs(L[i] - (L[i - 2 * s] + L[i + 2 * s]) / 2);
            var m = a > b ? a : b;
            v[i] = m; hist[Math.min(255, m | 0)]++;
        }
        var tot = (W - 4) * (H - 4), acc = 0, cap = 255;
        for (var k = 0; k < 256; k++) { acc += hist[k]; if (acc >= tot * 0.95) { cap = Math.max(1, k); break; } }
        var prof = new Float64Array(horiz ? H : W);
        for (y = 2; y < H - 2; y++) for (x = 2; x < W - 2; x++) { var vv = v[y * W + x]; prof[horiz ? y : x] += vv > cap ? cap : vv; }
        // 去掉缓慢变化（地图明暗分区），只留尖峰
        var n = prof.length, out = new Float64Array(n), r = 6;
        for (k = 0; k < n; k++) {
            var s2 = 0, c = 0;
            for (var t = Math.max(0, k - r); t <= Math.min(n - 1, k + r); t++) { s2 += prof[t]; c++; }
            out[k] = prof[k] - s2 / c;
        }
        out[0] = out[1] = out[n - 1] = out[n - 2] = 0;
        return out;
    };
    var px = line(false), py = line(true);
    var acf = function(p, maxLag) {
        var n = p.length, a = new Float64Array(maxLag + 1), e = 0;
        for (var k = 0; k < n; k++) e += p[k] * p[k];
        if (!e) return a;
        for (var L2 = 1; L2 <= maxLag; L2++) { var s = 0; for (k = 0; k + L2 < n; k++) s += p[k] * p[k + L2]; a[L2] = s / e * n / (n - L2); }
        return a;
    };
    var minLag = 8, maxLag = Math.floor(Math.min(W, H) / 3);
    if (maxLag <= minLag + 2) return null;
    var ax = acf(px, maxLag), ay = acf(py, maxLag), A = new Float64Array(maxLag + 1);
    for (var l = 1; l <= maxLag; l++) A[l] = ax[l] + ay[l];
    // 候选 L 的分数 = min(A(L), A(2L))：真的格子在 1 倍、2 倍周期都有峰；碰巧的小峰到 2 倍就没了。
    // 2 格、3 格处分数一样高，取够高（≥ 最高的 70%）里最小的那个局部峰
    var Hs = new Float64Array(maxLag + 1), best = 0, bl = 0, half = Math.floor(maxLag / 2);
    for (l = minLag; l <= half; l++) {
        var a1 = Math.max(A[l - 1], A[l], A[l + 1]), a2 = Math.max(A[2 * l - 1], A[2 * l], A[Math.min(maxLag, 2 * l + 1)]);
        Hs[l] = Math.min(a1, a2);
        if (Hs[l] > best) { best = Hs[l]; bl = l; }
    }
    if (best <= 0) return null;
    for (l = minLag + 1; l < half; l++) if (Hs[l] >= best * 0.7 && A[l] >= A[l - 1] && A[l] >= A[l + 1]) { bl = l; break; }
    // 梳子：周期 p、起点 o 时，所有线位置上曲线值的平均（线性插值）
    var comb = function(prof, p, o) {
        var s = 0, c = 0, n = prof.length;
        for (var x = o; x < n - 1; x += p) { var i0 = Math.floor(x), f = x - i0; s += prof[i0] * (1 - f) + prof[i0 + 1] * f; c++; }
        return c ? s / c : 0;
    };
    var bestP = bl, bestS = -Infinity, bo = { x: 0, y: 0 };
    var phase = function(prof, p) { // 起点：先 0.5 像素一档粗找，再 0.05 细找
        var bo2 = 0, bs = -Infinity;
        for (var o = 0; o < p; o += 0.5) { var s = comb(prof, p, o); if (s > bs) { bs = s; bo2 = o; } }
        for (o = bo2 - 0.5; o <= bo2 + 0.5; o += 0.05) { s = comb(prof, p, (o + p) % p); if (s > bs) { bs = s; bo2 = (o + p) % p; } }
        return { o: bo2, s: bs };
    };
    for (var p = bl - 1.5; p <= bl + 1.5; p += 0.05) {
        var fx = phase(px, p), fy = phase(py, p), sc = fx.s + fy.s;
        if (sc > bestS) { bestS = sc; bestP = p; bo = { x: fx.o, y: fy.o }; }
    }
    for (p = bestP - 0.06; p <= bestP + 0.06; p += 0.01) {
        fx = phase(px, p); fy = phase(py, p); sc = fx.s + fy.s;
        if (sc > bestS) { bestS = sc; bestP = p; bo = { x: fx.o, y: fy.o }; }
    }
    // 可信度：网格线上的平均值比整体的标准差大多少
    var sd = function(prof) { var s = 0; for (var k = 0; k < prof.length; k++) s += prof[k] * prof[k]; return Math.sqrt(s / prof.length) || 1; };
    var conf = (comb(px, bestP, bo.x) / sd(px) + comb(py, bestP, bo.y) / sd(py)) / 2;
    return { p: bestP, ox: bo.x, oy: bo.y, conf: conf, ac: best };
}

// ===================== 地形（一个场景里拼多张地形图） =====================
// 物件 kind 'tile'：{ asset, name, x, y, w, h, nw, nh（原图像素）, gp（原图每格像素）, gox, goy（原图里第一条网格线的位置）, locked }
// 画在主地图之上、网格之下；只有 GM 能选中（锁定后点不到，在「设置 → 地图」的列表里解锁）。属于当前地图，换图时跟着收起来。
var MAP_CONF_OK = 2.2; // 网格识别可信度：低于这个算「不太确定」

function tileItems() { return sortedItems().filter(function(it) { return it.kind === 'tile'; }); }

// 主地图 + 所有地形的外框（世界坐标）；都没有时 null
function mapBounds() {
    var p = scene.props, b = null;
    var add = function(x0, y0, x1, y1) {
        if (!b) b = { x0: x0, y0: y0, x1: x1, y1: y1 };
        else { b.x0 = Math.min(b.x0, x0); b.y0 = Math.min(b.y0, y0); b.x1 = Math.max(b.x1, x1); b.y1 = Math.max(b.y1, y1); }
    };
    if (p.mapAsset && p.mapW) add(0, 0, p.mapW, p.mapH);
    tileItems().forEach(function(t) { add(t.x || 0, t.y || 0, (t.x || 0) + (t.w || 0), (t.y || 0) + (t.h || 0)); });
    return b;
}
function mapBoundsKey() { var b = mapBounds(); return b ? [b.x0, b.y0, b.x1, b.y1].map(Math.round).join(',') : '0'; }

function drawMapTiles() {
    var tiles = tileItems();
    tiles.forEach(function(t) {
        var img = getImg(t.asset);
        if (imgReady(img)) ctx.drawImage(img, t.x || 0, t.y || 0, t.w || img.naturalWidth, t.h || img.naturalHeight);
        else { ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(t.x || 0, t.y || 0, t.w || 0, t.h || 0); }
    });
    if (me.gm) tileListSync();
}

// GM：选中的地形画个框（在网格、棋子之上，方便看清边界）
function drawTileOutlines() {
    if (!me.gm) return;
    tileItems().forEach(function(t) {
        if (!selected[t.id]) return;
        ctx.save();
        ctx.strokeStyle = '#ffb300';
        ctx.lineWidth = 2 / view.s;
        ctx.setLineDash([8 / view.s, 6 / view.s]);
        ctx.strokeRect(t.x || 0, t.y || 0, t.w || 0, t.h || 0);
        ctx.restore();
    });
}

// 取图片像素（缩到 ≤ max 边长），缓存
var mapPixCache = {};
function mapImgData(asset, max) {
    var key = asset + '|' + max;
    if (mapPixCache[key]) return Promise.resolve(mapPixCache[key]);
    return new Promise(function(resolve, reject) {
        var img = getImg(asset), go = function() {
            var k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
            var W = Math.max(8, Math.round(img.naturalWidth * k)), H = Math.max(8, Math.round(img.naturalHeight * k));
            var c = document.createElement('canvas');
            c.width = W; c.height = H;
            var cx = c.getContext('2d', { willReadFrequently: true });
            cx.drawImage(img, 0, 0, W, H);
            try { mapPixCache = {}; mapPixCache[key] = { rgba: cx.getImageData(0, 0, W, H).data, W: W, H: H, nw: img.naturalWidth, nh: img.naturalHeight }; }
            catch (e) { reject('无法读取图片像素'); return; }
            resolve(mapPixCache[key]);
        };
        if (imgReady(img)) go();
        else { img.addEventListener('load', go, { once: true }); img.addEventListener('error', function() { reject('图片加载失败'); }, { once: true }); }
    });
}

// 识别一张图的网格，结果换算成原图像素：{ p, ox, oy, conf }
function mapDetectAsset(asset) {
    return mapImgData(asset, 2048).then(function(d) {
        var r = mapGridDetect(d.rgba, d.W, d.H);
        if (!r) return null;
        var k = d.nw / d.W;
        return { p: r.p * k, ox: r.ox * k, oy: r.oy * k, conf: r.conf, nw: d.nw, nh: d.nh };
    });
}

// 识别结果不太确定时问一句：用它，还是自己框一格
function mapConfirmDetect(r, what) {
    if (!r) { notice('没在' + what + '上找到规则的方格线：可以点「▢ 框一格」手动框出一个格子', true, 6000); return Promise.resolve(false); }
    if (r.conf >= MAP_CONF_OK) return Promise.resolve(true);
    return ttAsk({ title: '网格识别不太确定', text: what + '上像是每格约 ' + Math.round(r.p * 10) / 10 + ' 像素，但线条不太明显（可能认成了 2 格或半格）。\n要用这个结果吗？也可以取消后点「▢ 框一格」手动框出一个格子。', ok: '就用这个' });
}

// 网格吸附：world 坐标 v 处有一条图里的网格线，挪到最近的场景网格线上要移动多少
function mapSnapDelta(v, off) {
    var g = gridSize();
    var d = ((v - off) % g + g) % g;
    return d > g / 2 ? g - d : -d;
}

// 地形按「原图每格 gp 像素、第一条线在 gox / goy」缩放到场景格子大小，并对齐网格线
function tileFeetRatio(t) { var sf = num(scene.props.gridScale, 5) || 5; return (t.gft || sf) / sf; } // 这块图一格代表的尺数 / 场景一格的尺数
function tilePatchFit(t, gp, gox, goy) {
    var g = gridSize(), p = scene.props, s = g * tileFeetRatio(t) / gp, nw = t.nw || (t.w || 0), nh = t.nh || (t.h || 0);
    var x = t.x || 0, y = t.y || 0;
    x += mapSnapDelta(x + gox * s, num(p.gridOffX, 0));
    y += mapSnapDelta(y + goy * s, num(p.gridOffY, 0));
    var r = function(v) { return Math.round(v * 100) / 100; };
    return { id: t.id, gp: r(gp), gox: r(gox), goy: r(goy), w: r(nw * s), h: r(nh * s), x: r(x), y: r(y) };
}

function tileFit(id) {
    var t = scene.items[id];
    if (!t || t.kind !== 'tile') return;
    notice('正在识别这块地形的网格…');
    mapDetectAsset(t.asset).then(function(r) {
        return mapConfirmDetect(r, '这块地形').then(function(ok) {
            t = scene.items[id];
            if (!ok || !t) return;
            patchItems([tilePatchFit(t, r.p, r.ox, r.oy)]);
            notice('已对齐：原图每格 ' + Math.round(r.p * 10) / 10 + ' 像素 → 缩放到场景的 1 格');
            renderSelPanel();
        });
    }).catch(apiError);
}

// 只挪位置，让它的网格线落到场景网格上（不改大小）
function tileSnap(id) {
    var t = scene.items[id];
    if (!t || t.kind !== 'tile') return;
    if (!t.gp) { notice('这块地形还没识别 / 设置网格：先点「🔍 识别网格」或「▢ 框一格」', true); return; }
    var s = (t.w || 1) / (t.nw || t.w || 1), p = scene.props;
    patchItems([{ id: t.id, x: Math.round(((t.x || 0) + mapSnapDelta((t.x || 0) + t.gox * s, num(p.gridOffX, 0))) * 100) / 100,
        y: Math.round(((t.y || 0) + mapSnapDelta((t.y || 0) + t.goy * s, num(p.gridOffY, 0))) * 100) / 100 }]);
}

// 这块图一格代表多少尺（默认和场景一样）：10 尺 / 格的图在 5 尺 / 格的场景里会放大成 2 格
function tileSetFeet(id, v) {
    var t = scene.items[id], ft = parseFloat(v), sf = num(scene.props.gridScale, 5) || 5;
    if (!t) return;
    var gft = ft > 0 && Math.abs(ft - sf) > 1e-6 ? ft : null;
    t = Object.assign({}, t, { gft: gft });
    patchItems([t.gp ? Object.assign(tilePatchFit(t, t.gp, t.gox || 0, t.goy || 0), { gft: gft }) : { id: t.id, gft: gft }]);
    renderSelPanel();
}

// 手动改「原图每格多少像素」
function tileSetCell(id, v) {
    var t = scene.items[id], gp = parseFloat(v);
    if (!t || !(gp >= 2)) return;
    patchItems([tilePatchFit(t, gp, t.gox || 0, t.goy || 0)]);
    renderSelPanel();
}

// 场景网格变了（主地图识别 / 框格）：已经设过网格的地形重新缩放对齐
function tilesRefit() {
    var patches = tileItems().filter(function(t) { return t.gp && !t.locked; }).map(function(t) { return tilePatchFit(t, t.gp, t.gox || 0, t.goy || 0); });
    if (patches.length) patchItems(patches);
    return patches.length;
}

// 主地图：识别自带网格 → 设场景的格子大小和偏移
function mapFitMain() {
    var p = scene.props;
    if (!p.mapAsset) { notice('当前场景没有主地图：地形在它的属性里单独识别', true); return; }
    notice('正在识别地图自带的网格…');
    mapDetectAsset(p.mapAsset).then(function(r) {
        return mapConfirmDetect(r, '这张地图').then(function(ok) {
            if (!ok) return;
            var k = (scene.props.mapW || r.nw) / r.nw, g = r.p * k;
            setProps({ gridSize: Math.round(g * 100) / 100, gridOffX: Math.round((r.ox * k % g) * 100) / 100, gridOffY: Math.round((r.oy * k % g) * 100) / 100 });
            var n = tilesRefit();
            notice('已按地图自带的网格对齐：每格 ' + Math.round(r.p * 10) / 10 + ' 像素' + (n ? '；' + n + ' 块地形也跟着重新对齐了' : ''));
        });
    }).catch(apiError);
}

// 没有自带网格的地形默认跟第一张地图同样的比例（世界坐标 / 原图像素）：主地图，没有主地图就用第一块地形
function tileBaseScale() {
    var p = scene.props, mi = p.mapAsset && getImg(p.mapAsset);
    if (p.mapW && mi && mi.naturalWidth) return p.mapW / mi.naturalWidth;
    var first = tileItems()[0];
    return first && first.nw && first.w ? first.w / first.nw : 1;
}

// 放一块地形：放在现在看着的地方（可以和别的地图不相连），左上角对齐网格；
// 先按第一张地图的比例，再试着识别它自带的网格，认得准就自动缩放对齐
function tileAdd(a, at) { // at：放置中心（世界坐标，拖到地图上的落点）；不给就放在视图中心
    var img = getImg(a.id);
    var place = function() {
        var p = scene.props, k = tileBaseScale();
        var nw = img.naturalWidth, nh = img.naturalHeight, c = at || toWorld(canvas.clientWidth / 2, canvas.clientHeight / 2);
        var x = c.x - nw * k / 2, y = c.y - nh * k / 2;
        x += mapSnapDelta(x, num(p.gridOffX, 0)); y += mapSnapDelta(y, num(p.gridOffY, 0));
        var t = { id: genId(), kind: 'tile', asset: a.id, name: a.name || '', x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, w: Math.round(nw * k * 100) / 100, h: Math.round(nh * k * 100) / 100, nw: nw, nh: nh, z: nextZ() };
        createItems([t]);
        selectOnly([t.id]);
        notice('已放上地形「' + (a.name || '') + '」，正在识别它自带的网格…');
        mapDetectAsset(a.id).then(function(r) {
            var cur = scene.items[t.id];
            if (!cur) return;
            if (r && r.conf >= MAP_CONF_OK) {
                patchItems([tilePatchFit(cur, r.p, r.ox, r.oy)]);
                notice('已放上地形并对齐网格（原图每格 ' + Math.round(r.p * 10) / 10 + ' 像素）；拖动可以挪位置，松手后可点「吸附到网格」');
            } else notice('已放上地形，按第一张地图的比例缩放（没认出它自带的网格）；要单独调就在属性里点「🔍 识别网格」「▢ 框一格」或拖四角缩放', false, 6000);
            renderSelPanel();
        }).catch(function() {});
    };
    if (imgReady(img)) place(); else img.addEventListener('load', place, { once: true });
}

// 属性面板
function tileSelHtml(t) {
    var g = gridSize(), cols = t.w ? Math.round(t.w / g * 10) / 10 : 0, rows = t.h ? Math.round(t.h / g * 10) / 10 : 0;
    var id = escapeHtml(t.id);
    return '<h4>⛰ 地形 <button class="tt-btn small" data-act="close">✕</button></h4>' +
        '<div class="tt-hint">' + escapeHtml(t.name || '') + (t.nw ? '<br>原图 ' + t.nw + ' × ' + t.nh + ' px，现在约 ' + cols + ' × ' + rows + ' 格' : '') + '</div>' +
        '<div class="prop-row"><label>原图每格</label><input class="tt-input narrow" type="number" min="2" step="0.1" value="' + (t.gp || '') + '" placeholder="未设置" onchange="tileSetCell(\'' + id + '\', this.value)"> 像素</div>' +
        '<div class="prop-row"><label>这张图一格</label><input class="tt-input narrow" type="number" min="0.5" step="0.5" value="' + (t.gft || num(scene.props.gridScale, 5)) + '" onchange="tileSetFeet(\'' + id + '\', this.value)"> 尺</div>' +
        '<div class="prop-btns">' +
        '<button class="tt-btn small" data-act="tileFit" title="识别这张图自带的方格线，按它缩放到场景的格子大小并对齐">🔍 识别网格</button>' +
        '<button class="tt-btn small" data-act="tileBox" title="在这块图上拖框框住正好一个格子（或几个格子再填格数），手动设网格">▢ 框一格</button>' +
        '<button class="tt-btn small" data-act="tileSnap" title="不改大小，只把它的网格线挪到场景网格上">吸附到网格</button>' +
        '</div><div class="prop-btns">' +
        '<button class="tt-btn small" data-act="tileLock" title="锁定后在地图上点不到它（防止误拖），在「设置 → 地图」的地形列表里解锁">🔒 锁定</button>' +
        '<button class="tt-btn small" data-act="tileBack" title="画到其他地形下面">置于底层</button>' +
        '<button class="tt-btn small danger" data-act="del">删除</button>' +
        '</div><div class="tt-hint">拖动挪位置（方向键按格挪），拖四角自由缩放（Shift 按半格）。每块地图的网格单独设置：一格的尺数和场景一样就缩放成场景的 1 格，比如 10 尺一格的图会放大成 2 格</div>';
}

function tileSelAct(act, ids) {
    var t = ids.length === 1 && scene.items[ids[0]];
    if (!t || t.kind !== 'tile' || !/^tile/.test(act || '')) return false;
    if (act === 'tileFit') tileFit(t.id);
    else if (act === 'tileSnap') tileSnap(t.id);
    else if (act === 'tileBox') mapBoxStart(t.id);
    else if (act === 'tileLock') { patchItems([{ id: t.id, locked: true }]); selectOnly([]); notice('已锁定地形：在「设置 → 地图」的列表里可以解锁'); }
    else if (act === 'tileBack') {
        var minZ = Math.min.apply(null, tileItems().map(function(x) { return x.z || 0; }));
        patchItems([{ id: t.id, z: minZ - 1 }]);
    }
    return true;
}

// 设置 → 地图：地形列表（选中 / 识别 / 锁定 / 删除）
var tileListSig = '';
function tileListSync() {
    var box = $('tileList');
    if (!box) return;
    var tiles = tileItems(), sig = tiles.map(function(t) { return t.id + (t.locked ? 'L' : '') + (t.gp || '') + (t.name || ''); }).join('|');
    if (sig === tileListSig) return;
    tileListSig = sig;
    if (!box.dataset.bound) {
        box.dataset.bound = '1';
        box.addEventListener('click', function(e) {
            var b = e.target.closest('button');
            if (!b) return;
            var t = scene.items[b.dataset.tid];
            if (!t) return;
            if (b.dataset.tl === 'sel') { if (t.locked) patchItems([{ id: t.id, locked: null }]); selectOnly([t.id]); }
            else if (b.dataset.tl === 'lock') patchItems([{ id: t.id, locked: t.locked ? null : true }]);
            else if (b.dataset.tl === 'fit') tileFit(t.id);
            else if (b.dataset.tl === 'del') deleteItems([t.id]);
        });
    }
    box.innerHTML = tiles.length ? tiles.map(function(t, i) {
        var tid = escapeHtml(t.id);
        return '<div class="lobby-row" style="gap:4px;align-items:center;margin:2px 0;"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHtml(t.name || '') + '">' +
            (i + 1) + '. ' + escapeHtml(t.name || '地形') + (t.gp ? '' : ' <span class="tt-hint">（未对齐）</span>') + '</span>' +
            '<button class="tt-btn small" data-tl="sel" data-tid="' + tid + '" title="选中（锁着的会先解锁）">选中</button>' +
            '<button class="tt-btn small" data-tl="fit" data-tid="' + tid + '" title="识别它自带的网格并对齐">🔍</button>' +
            '<button class="tt-btn small" data-tl="lock" data-tid="' + tid + '" title="' + (t.locked ? '解锁' : '锁定') + '">' + (t.locked ? '🔒' : '🔓') + '</button>' +
            '<button class="tt-btn small danger" data-tl="del" data-tid="' + tid + '" title="删除（Ctrl+Z 撤销）">✕</button></div>';
    }).join('') : '<div class="tt-hint">还没有地形：在资产库图片上点「放地形」，可以在同一张地图上放多张地形图（连着拼或分开放都行）；自带网格的会自动对齐，没有的按第一张地图的比例</div>';
}

// ===== 框一格：在图上拖框框住一个格子（或几个格子），手动设网格 =====
// target：'main' = 主地图（改场景网格），否则地形 id（改这块的缩放 / 对齐）
var mapBox = null;
function mapBoxStart(target) {
    if (target === 'main' && !scene.props.mapAsset) { notice('当前场景没有主地图', true); return; }
    mapBox = { target: target, a: null, b: null };
    if (!mapBoxStart.bound) {
        mapBoxStart.bound = true;
        var pos = function(e) { var s = eventPos(e); return toWorld(s.x, s.y); };
        canvas.addEventListener('pointerdown', function(e) {
            if (!mapBox) return;
            e.stopImmediatePropagation(); e.preventDefault();
            if (e.button === 2) { mapBox = null; notice('已取消框格'); requestRender(); return; }
            if (e.button !== 0) return;
            mapBox.a = mapBox.b = pos(e);
            try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件 */ }
        }, true);
        canvas.addEventListener('pointermove', function(e) {
            if (!mapBox || !mapBox.a) return;
            e.stopImmediatePropagation();
            mapBox.b = pos(e);
            requestRender();
        }, true);
        canvas.addEventListener('pointerup', function(e) {
            if (!mapBox || !mapBox.a) return;
            e.stopImmediatePropagation();
            mapBox.b = pos(e);
            mapBoxFinish();
        }, true);
        window.addEventListener('keydown', function(e) { if (mapBox && e.key === 'Escape') { mapBox = null; requestRender(); } });
    }
    notice('在' + (target === 'main' ? '地图' : '这块地形') + '上拖一个框，正好框住一个格子（框住几个格子也行，松手后填格数）；右键 / Esc 取消', false, 8000);
    requestRender();
}

function mapBoxFinish() {
    var mb = mapBox;
    mapBox = null;
    requestRender();
    var x0 = Math.min(mb.a.x, mb.b.x), y0 = Math.min(mb.a.y, mb.b.y), bw = Math.abs(mb.b.x - mb.a.x), bh = Math.abs(mb.b.y - mb.a.y);
    if (bw * view.s < 6 || bh * view.s < 6) { notice('框太小了，重新点「▢ 框一格」', true); return; }
    var apply = function(n) {
        var cell = (bw / n.c + bh / n.r) / 2;
        if (mb.target === 'main') {
            setProps({ gridSize: Math.round(cell * 100) / 100, gridOffX: Math.round((x0 % cell + cell) % cell * 100) / 100, gridOffY: Math.round((y0 % cell + cell) % cell * 100) / 100 });
            var k = tilesRefit();
            notice('已按框的格子设置网格：每格 ' + Math.round(cell * 10) / 10 + ' 像素' + (k ? '；' + k + ' 块地形也跟着重新对齐了' : ''));
            return;
        }
        var t = scene.items[mb.target];
        if (!t) return;
        var s = (t.w || 1) / (t.nw || t.w || 1), gp = cell / s; // 框住的是这块图自己的一格（当前缩放下的原图像素）
        var gox = (((x0 - (t.x || 0)) / s) % gp + gp) % gp, goy = (((y0 - (t.y || 0)) / s) % gp + gp) % gp;
        patchItems([tilePatchFit(t, gp, gox, goy)]);
        notice('已按框的格子对齐这块地形：原图每格 ' + Math.round(gp * 10) / 10 + ' 像素');
        renderSelPanel();
    };
    var ratio = bw / bh;
    if (ratio > 0.8 && ratio < 1.25) { apply({ c: 1, r: 1 }); return; } // 接近正方形：当一格
    var guess = Math.max(1, Math.round(ratio >= 1 ? ratio : 1 / ratio));
    ttAsk({ title: '框了几个格子？', text: '框的是 ' + (ratio >= 1 ? guess + ' 格宽 × 1 格高' : '1 格宽 × ' + guess + ' 格高') + ' 吗？\n（不对就取消，重新框一个正方形的格子）', ok: '对' })
        .then(function(ok) { if (ok) apply(ratio >= 1 ? { c: guess, r: 1 } : { c: 1, r: guess }); });
}

function drawMapBox() {
    if (!mapBox || !mapBox.a) return;
    var a = mapBox.a, b = mapBox.b;
    ctx.save();
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 2 / view.s;
    ctx.setLineDash([6 / view.s, 4 / view.s]);
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.restore();
}
