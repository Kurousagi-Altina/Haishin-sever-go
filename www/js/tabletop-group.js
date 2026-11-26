// ===== 群体区域（GM）：圈一批棋子，同时投豁免 / 属性检定，再统一加减生命值、生命上限、AC =====
// 工具 👥（快捷键 U）：拖一个圆 / 矩形圈住棋子（中心在圈里的算；Shift = 加进已有的），单击棋子 = 加入 / 移出。
// 面板里点名字后面的 × 单独移除。投掷走服务器 op "group"（backend/tabletop_group.go），结果是一条 kind "group" 的记录，
// 每个单位的结果也标在面板和地图上；调整走 patchItems（一步 Ctrl+Z 撤销），扣血先扣临时生命（tokenHpPatch）。

var groupOpts = { shape: 'circle' }; // circle / rect
var groupSel = { ids: [], area: null, results: {}, label: '', hideNums: false, quiet: false };

function groupHasAbilities(t) {
    var sh = t && t.sheet && sheets[t.sheet];
    return !!(sh && Array.isArray(sh.abilities) && sh.abilities.length);
}

function groupTokens() {
    return groupSel.ids.map(function(id) { return scene.items[id]; }).filter(function(t) { return t && t.kind === 'token'; });
}

function groupAreaFrom(a, b, shape) {
    if (shape === 'rect') return { shape: 'rect', x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
    return { shape: 'circle', x: a.x, y: a.y, r: Math.hypot(b.x - a.x, b.y - a.y) };
}

function groupInside(c, A) {
    if (A.shape === 'rect') return c.x >= A.x0 && c.x <= A.x1 && c.y >= A.y0 && c.y <= A.y1;
    return Math.hypot(c.x - A.x, c.y - A.y) <= A.r;
}

function groupSet(ids) {
    var seen = {};
    groupSel.ids = ids.filter(function(id) { if (seen[id] || !scene.items[id]) return false; seen[id] = true; return true; }).slice(0, 100);
    Object.keys(groupSel.results).forEach(function(id) { if (!seen[id]) delete groupSel.results[id]; });
    groupRender();
    requestRender();
}

function groupClear() {
    groupSel.ids = []; groupSel.area = null; groupSel.results = {}; groupSel.label = '';
    groupRender();
    requestRender();
}

// ===== 地图上圈选 =====
function groupPointerDown(w, start, e) {
    gesture = { type: 'garea', start: start, a: w, b: w, add: e.shiftKey };
    requestRender();
}

function groupPointerUp(g, w) {
    if (!g.start.moved) { // 单击：棋子加入 / 移出
        var hit = hitTest(w, ['token']);
        if (!hit) return;
        var i = groupSel.ids.indexOf(hit.id);
        groupSet(i >= 0 ? groupSel.ids.filter(function(x) { return x !== hit.id; }) : groupSel.ids.concat([hit.id]));
        return;
    }
    var A = groupAreaFrom(g.a, w, groupOpts.shape);
    var inside = sortedItems().filter(function(t) { return t.kind === 'token' && groupInside(tokenCenter(t), A); }).map(function(t) { return t.id; });
    groupSel.area = A;
    if (!g.add) groupSel.results = {};
    groupSet(g.add ? groupSel.ids.concat(inside) : inside);
    if (!inside.length && !groupSel.quiet) notice('圈里没有棋子（棋子中心在圈里才算）', true);
}

// 👥 工具里右键轻点棋子：从群体里移除
function groupRightTap(start) {
    var hit = hitTest(start.w, ['token']);
    if (hit && groupSel.ids.indexOf(hit.id) >= 0) groupSet(groupSel.ids.filter(function(x) { return x !== hit.id; }));
}

function drawGroupArea(A, live) {
    ctx.save();
    ctx.setLineDash([8 / view.s, 5 / view.s]);
    ctx.lineWidth = 2 / view.s;
    ctx.strokeStyle = live ? '#ffb74d' : 'rgba(255,183,77,0.75)';
    ctx.fillStyle = 'rgba(255,152,0,0.07)';
    ctx.beginPath();
    if (A.shape === 'rect') ctx.rect(A.x0, A.y0, A.x1 - A.x0, A.y1 - A.y0);
    else ctx.arc(A.x, A.y, A.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

function drawGroup() {
    if (!me.gm) return;
    if (gesture && gesture.type === 'garea') drawGroupArea(groupAreaFrom(gesture.a, gesture.b, groupOpts.shape), true);
    else if (groupSel.area && groupSel.ids.length) drawGroupArea(groupSel.area, false);
    groupTokens().forEach(function(t) {
        var c = tokenCenter(t), r = Math.max(t.w || gridSize(), t.h || gridSize()) / 2 + 4 / view.s, res = groupSel.results[t.id];
        ctx.save();
        ctx.lineWidth = 3 / view.s;
        ctx.strokeStyle = res && res.pass === 'yes' ? '#66bb6a' : res && res.pass === 'no' ? '#ef5350' : '#ffb74d';
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        if (res && !groupSel.hideNums) drawLabel((res.auto ? '自动失败' : String(res.total)) + (res.pass === 'yes' ? ' ✓' : res.pass === 'no' ? ' ✗' : ''),
            c.x, c.y - r - 4 / view.s, res.pass === 'yes' ? '#a5d6a7' : res.pass === 'no' ? '#ef9a9a' : '#ffe0b2', false, true);
    });
}

// ===== 面板 =====
function groupRender() {
    var el = $('groupPanel');
    if (!el) return;
    var toks = groupTokens();
    el.style.display = me.gm && (toks.length || tool === 'group') ? '' : 'none';
    if (el.style.display === 'none') return;
    var ab = groupField('gpAb', 'dex'), mode = groupField('gpMode', 'save'), roll = groupField('gpRoll', ''), dc = groupField('gpDc', ''),
        hidden = groupCheck('gpHidden', false), target = groupField('gpTarget', 'all'), field = groupField('gpField', 'hp'), eff = groupField('gpEff', 'sub'),
        val = groupField('gpVal', ''), half = groupCheck('gpHalf', false);
    var sel = function(id, cur, opts) {
        return '<select class="tt-select" id="' + id + '">' + opts.map(function(o) { return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>';
    };
    var rollable = toks.filter(groupHasAbilities).length, hasRes = Object.keys(groupSel.results).length > 0;
    var h = '<div class="gp-head" data-drag><b>👥 群体区域</b><span class="tt-hint">' + toks.length + ' 个单位</span>' +
        '<label class="tt-hint" title="不在地图和面板上显示每个单位的投掷数字（记录里照常有）"><input type="checkbox" id="gpHideNums"' + (groupSel.hideNums ? ' checked' : '') + '> 隐藏数字</label>' +
        '<button class="tt-btn small" data-gp="close" title="清空并关闭">关闭</button></div>';
    if (!toks.length) return void (el.innerHTML = h + '<div class="tt-hint">在地图上拖一个' + (groupOpts.shape === 'rect' ? '矩形' : '圆') + '圈住目标（Shift 加选），或单击棋子加入 / 移出</div>');
    h += '<div class="gp-row"><span>投掷</span>' + sel('gpMode', mode, [['save', '群体豁免'], ['check', '属性检定']]) +
        '<span>属性</span>' + sel('gpAb', ab, Object.keys(ABILITY_NAMES).map(function(k) { return [k, ABILITY_NAMES[k]]; })) +
        '<span>方式</span>' + sel('gpRoll', roll, [['', '普通'], ['adv', '优势'], ['dis', '劣势']]) +
        '<span>DC</span><input class="tt-input narrow" id="gpDc" type="number" min="0" max="60" value="' + escapeHtml(dc) + '" placeholder="可空" style="width:52px;">' +
        '<label class="tt-hint"><input type="checkbox" id="gpHidden"' + (hidden ? ' checked' : '') + '> 本次全暗骰</label>' +
        '<button class="tt-btn small primary" data-gp="roll"' + (rollable ? '' : ' disabled') + '>同时投掷</button></div>';
    if (rollable < toks.length) h += '<div class="tt-hint">' + (toks.length - rollable) + ' 个单位没关联角色卡（没有属性），投掷时跳过，调整照样生效</div>';
    h += '<div class="gp-units">' + toks.map(function(t) {
        var r = groupSel.results[t.id], cls = r ? (r.pass === 'yes' ? ' pass' : r.pass === 'no' ? ' fail' : ' done') : groupHasAbilities(t) ? '' : ' noab';
        var num = r && !groupSel.hideNums ? ' <b>' + (r.auto ? '自动失败' : r.total) + '</b>' : '';
        return '<span class="gp-unit' + cls + '" title="' + escapeHtml(r && r.note ? r.note : groupHasAbilities(t) ? '' : '没有属性') + '">' +
            '<span data-gp="focus" data-id="' + escapeHtml(t.id) + '">' + escapeHtml(t.label || '单位') + '</span>' + num +
            '<i data-gp="drop" data-id="' + escapeHtml(t.id) + '" title="从群体里移除">×</i></span>';
    }).join('') + '</div>';
    h += '<div class="gp-row"><span>对象</span>' + sel('gpTarget', target, [['all', '全部'], ['fail', '豁免 / 检定失败的'], ['pass', '成功的']]) +
        '<span>字段</span>' + sel('gpField', field, [['hp', '生命值 HP'], ['hpMax', '生命值上限 Max HP'], ['ac', '护甲等级 AC'], ['hpTemp', '临时生命']]) +
        '<span>效果</span>' + sel('gpEff', eff, [['sub', '减少'], ['add', '增加'], ['set', '设置']]) +
        '<span>数值</span><input class="tt-input narrow" id="gpVal" type="number" min="0" value="' + escapeHtml(val) + '" style="width:60px;">' +
        (hasRes ? '<label class="tt-hint" title="对象选「全部」、减少生命值时：成功的单位只减一半（向下取整），如火球术"><input type="checkbox" id="gpHalf"' + (half ? ' checked' : '') + '> 成功者减半</label>' : '') +
        '<button class="tt-btn small" data-gp="apply">应用调整</button></div>';
    h += '<label class="tt-hint"><input type="checkbox" id="gpQuiet"' + (groupSel.quiet ? ' checked' : '') + '> DM 不提示消息</label>';
    el.innerHTML = h;
}

function groupField(id, def) { var e = $(id); return e ? e.value : def; }
function groupCheck(id, def) { var e = $(id); return e ? e.checked : def; }

function groupRoll() {
    var ids = groupTokens().filter(groupHasAbilities).map(function(t) { return t.id; });
    if (!ids.length) { notice('圈到的单位都没有属性（没关联角色卡）', true); return; }
    var dc = parseInt(groupField('gpDc', ''), 10) || 0;
    groupSel.results = {};
    op({ op: 'group', ids: ids, hidden: groupCheck('gpHidden', false),
        group: { mode: groupField('gpMode', 'save'), ab: groupField('gpAb', 'dex'), roll: groupField('gpRoll', ''), dc: dc } });
}

// 自己投的群体记录到了：结果挂到面板和地图上
function groupOnLog(e) {
    if (!e || e.kind !== 'group' || !e.group || e.who !== me.name) return;
    groupSel.results = {};
    (e.group.rows || []).forEach(function(r) { groupSel.results[r.id] = r; });
    groupSel.label = e.label || '';
    groupRender();
    requestRender();
}

function groupApply() {
    var amt = parseInt(groupField('gpVal', ''), 10);
    if (!(amt >= 0)) { notice('先填数值', true); return; }
    var target = groupField('gpTarget', 'all'), field = groupField('gpField', 'hp'), eff = groupField('gpEff', 'sub'), half = groupCheck('gpHalf', false);
    var toks = groupTokens().filter(function(t) {
        var r = groupSel.results[t.id];
        return target === 'all' || (r && r.pass === (target === 'fail' ? 'no' : 'yes'));
    });
    if (!toks.length) { notice(target === 'all' ? '群体里没有单位' : '没有符合条件的单位（先设 DC 投一次）', true); return; }
    var noHp = 0;
    if (field === 'hp' && eff !== 'set') { // 没填生命值的棋子没法加减，跳过
        toks = toks.filter(function(t) { var ok = t.hp != null || t.hpMax != null; if (!ok) noHp++; return ok; });
        if (!toks.length) { notice('这些单位都没有生命值', true); return; }
    }
    var patches = toks.map(function(t) {
        var r = groupSel.results[t.id], v = amt;
        if (half && field === 'hp' && eff === 'sub' && r && r.pass === 'yes') v = Math.floor(amt / 2);
        if (field === 'hp') {
            if (eff === 'set') { var mx = num(t.hpMax, 0); return { id: t.id, hp: mx > 0 ? Math.min(v, mx) : v }; }
            return tokenHpPatch(t, eff === 'sub' ? -v : v);
        }
        var cur = num(t[field], field === 'ac' && t.sheet && sheets[t.sheet] ? num(sheets[t.sheet].ac, 0) : 0);
        var nv = eff === 'set' ? v : eff === 'add' ? cur + v : Math.max(0, cur - v);
        var p = { id: t.id };
        p[field] = field === 'hpTemp' && !nv ? null : nv;
        if (field === 'hpMax' && t.hp != null && num(t.hp, 0) > nv) p.hp = nv;
        return p;
    });
    patchItems(patches);
    if (!groupSel.quiet) notice('已调整 ' + patches.length + ' 个单位的' + { hp: '生命值', hpMax: '生命值上限', ac: 'AC', hpTemp: '临时生命' }[field] + '（Ctrl+Z 撤销）' +
        (noHp ? '；' + noHp + ' 个没有生命值的单位跳过' : ''));
    groupRender();
}

// 记录里的群体投掷
function groupLogHtml(e) {
    var g = e.group, hideNum = function(r) { return r.auto ? '自动失败' : String(r.total); };
    var rows = (g.rows || []).map(function(r) {
        var d = r.roll ? rollDetail(r.roll).html : '';
        return '<div class="gp-log-row"><span class="nm">' + escapeHtml(r.name) + '</span>' + (d ? '<span class="detail">' + d + '</span>' : '') +
            ' = <b class="' + (r.pass === 'yes' ? 'pass' : r.pass === 'no' ? 'fail' : '') + '">' + escapeHtml(hideNum(r)) + (r.pass === 'yes' ? ' ✓' : r.pass === 'no' ? ' ✗' : '') + '</b>' +
            (r.note ? ' <span class="tt-hint">' + escapeHtml(r.note) + '</span>' : '') + '</div>';
    }).join('');
    var head = (g.dc ? 'DC ' + g.dc : '') + (g.roll === 'adv' ? ' · 优势' : g.roll === 'dis' ? ' · 劣势' : '');
    var pass = (g.rows || []).filter(function(r) { return r.pass === 'yes'; }).length, fail = (g.rows || []).filter(function(r) { return r.pass === 'no'; }).length;
    return '<div class="gp-log">' + (head ? '<div class="tt-hint">' + escapeHtml(head.replace(/^ · /, '')) + (g.dc ? '　成功 ' + pass + ' · 失败 ' + fail : '') + '</div>' : '') + rows +
        (g.skipped ? '<div class="tt-hint">' + g.skipped + ' 个没有属性的单位跳过</div>' : '') + '</div>';
}

function setGroupShape(s) {
    groupOpts.shape = s;
    document.querySelectorAll('[data-groupshape]').forEach(function(b) { b.classList.toggle('active', b.dataset.groupshape === s); });
    groupRender();
}

function initGroup() {
    var bar = $('optsGroup'), el = $('groupPanel');
    if (!bar || !el) return;
    bar.addEventListener('click', function(e) {
        var b = e.target.closest('[data-groupshape]');
        if (b) setGroupShape(b.dataset.groupshape);
        if (e.target.closest('[data-gpclear]')) groupClear();
    });
    el.addEventListener('click', function(e) {
        var b = e.target.closest('[data-gp]');
        if (!b) return;
        var a = b.dataset.gp;
        if (a === 'close') { groupClear(); if (tool === 'group') setTool('select'); }
        else if (a === 'roll') groupRoll();
        else if (a === 'apply') groupApply();
        else if (a === 'drop') groupSet(groupSel.ids.filter(function(x) { return x !== b.dataset.id; }));
        else if (a === 'focus') {
            var t = scene.items[b.dataset.id];
            if (t) { var c = tokenCenter(t); view.x = canvas.clientWidth / 2 - c.x * view.s; view.y = canvas.clientHeight / 2 - c.y * view.s; requestRender(); }
        }
    });
    el.addEventListener('change', function(e) {
        if (e.target.id === 'gpHideNums') { groupSel.hideNums = e.target.checked; groupRender(); requestRender(); }
        if (e.target.id === 'gpQuiet') groupSel.quiet = e.target.checked;
    });
    if (typeof makeFloat === 'function') makeFloat(el, 'group', {});
    setGroupShape(groupOpts.shape);
}
