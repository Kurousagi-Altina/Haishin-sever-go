// 跑团桌面：状态效果、Boss 血条、全局搜索
// - 状态挂在棋子上：item.status = [{ id, name, color, icon, rounds?, lv? }]（兼容 obr-suite 状态追踪导入）
//   带轮数的状态在该棋子的回合结束时由服务器递减，到 0 自动移除
// - 状态参与攻击判定：目盲、隐形、倒地、束缚、麻痹等自动给出优势 / 劣势，麻痹 / 昏迷目标 5 尺内命中即重击
// - 专注中的棋子受伤时提醒专注豁免 DC
// - Boss 血条：GM 标记的棋子在画面上方显示大血条（玩家默认只看比例）
// - 全局搜索（Ctrl+K）：棋子、角色卡 / 怪物 / 物品、法术、状态说明、不全书
// 依赖 tabletop.js / tabletop-sheets.js / tabletop-combat.js 的全局状态与函数

// 说明文字为规则要点的简述
var STATUS_DEFS = [
    { id: 'blinded', name: '目盲', icon: '🙈', color: '#78909c', desc: '看不见，依赖视觉的检定自动失败。自己的攻击检定劣势；针对它的攻击检定优势。' },
    { id: 'charmed', name: '魅惑', icon: '💘', color: '#ff00d0', desc: '不能攻击魅惑者，也不能以有害能力或魔法效应指定魅惑者为目标；魅惑者与其社交互动的检定具有优势。' },
    { id: 'deafened', name: '耳聋', icon: '🔇', color: '#90a4ae', desc: '听不见，依赖听觉的检定自动失败。' },
    { id: 'exhaustion', name: '力竭', icon: '😩', color: '#8d6e63', lv: true, desc: '每级力竭：d20 检定 −2，速度 −5 尺（2024 规则）；6 级死亡。长休减少 1 级。' },
    { id: 'frightened', name: '恐慌', icon: '😱', color: '#7e57c2', desc: '能看见恐惧来源时，属性检定和攻击检定劣势；不能主动靠近恐惧来源。' },
    { id: 'grappled', name: '受擒', icon: '🤼', color: '#a1887f', desc: '速度为 0；攻击擒抱者以外的目标时劣势。擒抱者移动时可以拖着它走。' },
    { id: 'incapacitated', name: '失能', icon: '💤', color: '#9e9e9e', desc: '不能执行动作、附赠动作和反应；专注中断；先攻检定劣势。' },
    { id: 'invisible', name: '隐形', icon: '👻', color: '#cfd8dc', desc: '不会被看见。先攻优势；自己的攻击检定优势；针对它的攻击检定劣势（对方能看见它时除外）。' },
    { id: 'paralyzed', name: '麻痹', icon: '⚡', color: '#fdd835', desc: '失能，速度为 0；力量、敏捷豁免自动失败；针对它的攻击检定优势；5 尺内命中即为重击。' },
    { id: 'petrified', name: '石化', icon: '🗿', color: '#bdbdbd', desc: '变成石头：失能、速度为 0；针对它的攻击检定优势；力量、敏捷豁免自动失败；对所有伤害有抗性，免疫毒素。' },
    { id: 'poisoned', name: '中毒', icon: '🤢', color: '#7cb342', desc: '攻击检定和属性检定劣势。' },
    { id: 'prone', name: '倒地', icon: '🛌', color: '#6d4c41', desc: '只能爬行或花一半移动站起；自己的攻击检定劣势；5 尺内对它的攻击检定优势，更远的攻击检定劣势。' },
    { id: 'restrained', name: '束缚', icon: '🔗', color: '#8b4513', desc: '速度为 0；自己的攻击检定劣势，针对它的攻击检定优势；敏捷豁免劣势。' },
    { id: 'stunned', name: '震慑', icon: '💫', color: '#f5deb3', desc: '失能；力量、敏捷豁免自动失败；针对它的攻击检定优势。' },
    { id: 'unconscious', name: '昏迷', icon: '😵', color: '#5c6bc0', desc: '失能、倒地、松开手中物品；力量、敏捷豁免自动失败；针对它的攻击检定优势；5 尺内命中即为重击。' },
    { id: 'concentration', name: '专注', icon: '🧠', color: '#4682b4', desc: '维持专注法术。受到伤害时进行体质豁免，DC 为 10 或伤害的一半（取高，最高 30），失败则法术结束。' },
    { id: 'blessed', name: '祝福', icon: '✨', color: '#fff176', desc: '攻击检定和豁免检定额外 +1d4。' },
    { id: 'baned', name: '灾祸', icon: '🌀', color: '#5e35b1', desc: '攻击检定和豁免检定额外 −1d4。' },
    { id: 'hexed', name: '侵扰', icon: '😈', color: '#7a1e9c', desc: '受到侵扰者攻击命中时额外受到伤害；所选属性的检定劣势。' },
    { id: 'hasted', name: '加速', icon: '⏩', color: '#26c6da', desc: '速度翻倍，AC +2，敏捷豁免优势，每回合多一个有限动作；结束时失去一回合。' },
    { id: 'dodging', name: '闪避', icon: '🌪', color: '#4dd0e1', desc: '直到下回合开始：针对它的攻击检定劣势（能看见攻击者时），敏捷豁免优势。' },
    { id: 'raging', name: '狂暴', icon: '😡', color: '#e53935', desc: '力量检定和豁免优势，近战伤害加值，对钝击、穿刺、挥砍伤害有抗性。' },
    { id: 'bardic', name: '诗人激励', icon: '🎵', color: '#7300ff', desc: '持有一枚诗人激励骰，可加到一次 d20 检定上。' },
    { id: 'guidance', name: '神导术', icon: '👍', color: '#fff59d', desc: '下一次属性检定可额外加 1d4。' },
    { id: 'advantage', name: '优势', icon: '⬆', color: '#ffcc00', desc: '自己的攻击检定具有优势（通用标记）。' },
    { id: 'disadvantage', name: '劣势', icon: '⬇', color: '#3b82f6', desc: '自己的攻击检定具有劣势（通用标记）。' },
    { id: 'hidden', name: '躲藏', icon: '🫥', color: '#607d8b', desc: '躲藏中（隐匿检定成功）：被发现前视为隐形。GM 的单位躲藏时，玩家地图和先攻条上都看不到它。' },
    { id: 'stable', name: '稳定', icon: '💤', color: '#90a4ae', desc: '0 生命值但伤势稳定，不用再做死亡豁免。' },
    { id: 'dead', name: '死亡', icon: '💀', color: '#424242', desc: '已死亡：先攻里自动跳过。' }
];
var STATUS_BY_ID = {};
STATUS_DEFS.forEach(function(d) { STATUS_BY_ID[d.id] = d; });

function statusList(it) { return Array.isArray(it && it.status) ? it.status : []; }
function hasStatus(it, id) { return statusList(it).some(function(s) { return s.id === id; }); }
function statusLevel(it, id) {
    var s = statusList(it).filter(function(x) { return x.id === id; })[0];
    return s ? Math.max(1, num(s.lv, 1)) : 0;
}
function statusIcon(s) { return s.icon || (STATUS_BY_ID[s.id] || {}).icon || '🏷'; }
function statusLabel(s) {
    return (s.name || '状态') + (s.lv > 1 ? ' ' + s.lv + '级' : '') + (s.rounds > 0 ? '（' + s.rounds + ' 轮）' : '');
}

function addStatus(it, id, rounds, custom) {
    var def = STATUS_BY_ID[id];
    var list = statusList(it).slice();
    var existing = list.filter(function(s) { return s.id === (def ? def.id : id); })[0];
    if (existing && def && def.lv) { // 力竭可叠加等级
        existing = JSON.parse(JSON.stringify(existing));
        existing.lv = Math.min(6, num(existing.lv, 1) + 1);
        list = list.map(function(s) { return s.id === existing.id ? existing : s; });
    } else if (existing) {
        notice('已经有「' + existing.name + '」了', true);
        return;
    } else {
        var st = def ? { id: def.id, name: def.name, color: def.color, icon: def.icon } :
            { id: 'c' + genId().slice(-6), name: String(custom || '').slice(0, 12), color: '#9e9e9e' };
        if (def && def.lv) st.lv = 1;
        if (rounds > 0) st.rounds = rounds;
        list.push(st);
    }
    patchItems([{ id: it.id, status: list.slice(0, 12) }]);
}

function removeStatus(it, idx) {
    var list = statusList(it).slice();
    list.splice(idx, 1);
    patchItems([{ id: it.id, status: list.length ? list : null }]);
}

// ===== 地图：状态图标 =====
function drawStatusIcons(it) {
    var list = statusList(it);
    if (!list.length) return;
    var g = gridSize(), w = it.w || g, x = it.x || 0, y = it.y || 0;
    var size = Math.max(14, Math.min(22, w * view.s * 0.22));
    if (w * view.s < 22) return;
    var p = toScreen(x, y);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var max = Math.max(1, Math.floor(w * view.s / (size + 2)));
    list.slice(0, max).forEach(function(s, i) {
        var cx = p.x + size / 2 + i * (size + 2), cy = p.y - size / 2 + 2;
        if (it.hpMax > 0) cy -= Math.max(4, h8(it)) + 2;
        ctx.beginPath();
        ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(20,20,24,0.88)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = s.color || '#9e9e9e';
        ctx.stroke();
        ctx.font = Math.round(size * 0.62) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText(statusIcon(s), cx, cy + 1);
        var tag = s.lv > 1 ? String(s.lv) : s.rounds > 0 ? String(s.rounds) : '';
        if (tag) {
            ctx.font = 'bold 9px sans-serif';
            ctx.fillStyle = '#ffd54f';
            ctx.fillText(tag, cx + size / 2 - 2, cy + size / 2 - 2);
        }
    });
    if (list.length > max) {
        ctx.font = 'bold 11px sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.fillText('+' + (list.length - max), p.x + max * (size + 2), p.y - size / 2);
    }
    ctx.restore();

    function h8(t) { return (t.h || g) * 0.08 * view.s; }
}

// ===== 属性面板 =====
function statusPanelHtml(it, row) {
    var h = '<div class="prop-sub">状态</div><div class="status-chips">' + statusList(it).map(function(s, i) {
        var def = STATUS_BY_ID[s.id];
        return '<span class="status-chip" style="border-color:' + escapeHtml(s.color || '#9e9e9e') + '" title="' + escapeHtml(def ? def.desc : '') + '">' +
            escapeHtml(statusIcon(s) + ' ' + statusLabel(s)) + '<button class="st-x" data-stdel="' + i + '" title="移除">✕</button></span>';
    }).join('') + (statusList(it).length ? '' : '<span class="tt-hint">无</span>') + '</div>';
    // 不带左侧标签，下拉框才有足够宽度
    h += '<div class="prop-row"><select class="tt-select" data-stsel style="flex:1;min-width:0;"><option value="">添加状态…</option>' +
        STATUS_DEFS.map(function(d) { return '<option value="' + d.id + '">' + d.icon + ' ' + d.name + '</option>'; }).join('') +
        '<option value="custom">自定义…</option></select>' +
        '<input class="tt-input narrow" data-strounds type="number" min="0" placeholder="轮数" title="持续轮数（该棋子的回合结束时减 1，留空 = 不限）" style="width:52px;">' +
        '<button class="tt-btn small" data-act="stadd">添加</button></div>';
    if (me.gm) {
        h += row('Boss', '<label><input type="checkbox" data-prop="boss"' + (it.boss ? ' checked' : '') + '> 顶部大血条</label>' +
            '<label title="勾选后玩家也能看到具体血量"><input type="checkbox" data-prop="bossExact"' + (it.bossExact ? ' checked' : '') + '> 公开数值</label>');
    }
    return h;
}

function onStatusPanelClick(b, it) {
    if (b.dataset.stdel != null) { removeStatus(it, parseInt(b.dataset.stdel, 10)); return true; }
    if (b.dataset.act !== 'stadd') return false;
    var panel = $('selPanel'), id = panel.querySelector('[data-stsel]').value;
    var rounds = parseInt(panel.querySelector('[data-strounds]').value, 10) || 0;
    if (!id) { notice('先选择要添加的状态', true); return true; }
    if (id === 'custom') {
        var name = prompt('状态名称：');
        if (!name || !name.trim()) return true;
        addStatus(it, '', rounds, name.trim());
    } else addStatus(it, id, rounds);
    return true;
}

// ===== 攻击判定中的状态 =====
// 返回 { adv: [原因], dis: [原因], autoCrit, adj, extra }
function statusAttackMods(att, tgt, dist) {
    var r = { adv: [], dis: [], autoCrit: false, adj: 0, extra: '' };
    var aName = att.label || '攻击者', tName = tgt.label || '目标';
    [['blinded', '目盲'], ['poisoned', '中毒'], ['prone', '倒地'], ['restrained', '束缚'], ['frightened', '恐慌'], ['disadvantage', '劣势']].forEach(function(c) {
        if (hasStatus(att, c[0])) r.dis.push(aName + c[1]);
    });
    [['invisible', '隐形'], ['hidden', '躲藏'], ['advantage', '优势']].forEach(function(c) {
        if (hasStatus(att, c[0])) r.adv.push(aName + c[1]);
    });
    [['blinded', '目盲'], ['paralyzed', '麻痹'], ['petrified', '石化'], ['restrained', '束缚'], ['stunned', '震慑'], ['unconscious', '昏迷']].forEach(function(c) {
        if (hasStatus(tgt, c[0])) r.adv.push(tName + c[1]);
    });
    [['invisible', '隐形'], ['hidden', '躲藏'], ['dodging', '闪避']].forEach(function(c) {
        if (hasStatus(tgt, c[0])) r.dis.push(tName + c[1]);
    });
    if (hasStatus(tgt, 'prone')) {
        if (dist <= 5) r.adv.push(tName + '倒地（5 尺内）'); else r.dis.push(tName + '倒地（远处）');
    }
    if (dist <= 5 && (hasStatus(tgt, 'paralyzed') || hasStatus(tgt, 'unconscious'))) r.autoCrit = true;
    var ex = statusLevel(att, 'exhaustion');
    if (ex) r.adj = -2 * ex;
    if (hasStatus(att, 'blessed')) r.extra = '+1d4';
    else if (hasStatus(att, 'baned')) r.extra = '-1d4';
    return r;
}

// 专注中的棋子受伤：提醒体质豁免
function concentrationCheck(it, damage) {
    if (!(damage > 0) || !hasStatus(it, 'concentration')) return;
    var dc = Math.min(30, Math.max(10, Math.floor(damage / 2)));
    var text = '⚠ ' + (it.label || '棋子') + ' 受到 ' + damage + ' 点伤害，需要进行专注豁免（体质 DC ' + dc + '）';
    if (it.hidden) notice(text, false, 5000);
    else op({ op: 'chat', text: text });
}

// ===== Boss 血条 =====
function renderBossBars() {
    var el = $('bossBars');
    if (!el) return;
    var list = sortedItems().filter(function(t) { return t.kind === 'token' && t.boss && t.hpMax > 0; }).slice(0, 3);
    el.innerHTML = list.map(function(t) {
        var cur = Math.max(0, num(t.hp, t.hpMax)), ratio = Math.min(1, cur / t.hpMax), temp = Math.max(0, num(t.hpTemp, 0));
        var show = me.gm || t.bossExact;
        return '<div class="boss-bar' + (cur <= 0 ? ' down' : '') + '" data-boss="' + escapeHtml(t.id) + '">' +
            '<div class="boss-name">' + escapeHtml(t.label || 'Boss') + statusList(t).map(function(s) { return ' <span title="' + escapeHtml(statusLabel(s)) + '">' + escapeHtml(statusIcon(s)) + '</span>'; }).join('') +
            (show ? '<span class="boss-num">' + cur + ' / ' + t.hpMax + (temp ? ' +' + temp : '') + '</span>' : '') +
            (me.gm && !t.bossExact ? '<span class="tt-hint">玩家只看到比例</span>' : '') + '</div>' +
            '<div class="boss-track"><i style="width:' + (ratio * 100).toFixed(1) + '%"></i>' + (temp ? '<b style="width:' + Math.min(100, temp / t.hpMax * 100).toFixed(1) + '%"></b>' : '') + '</div></div>';
    }).join('');
    el.style.display = list.length ? '' : 'none';
}

// ===== 全局搜索 =====
var searchState = { results: [], idx: 0 };

function searchAll(q) {
    var key = q.toLowerCase(), out = [];
    var has = function(s) { return String(s || '').toLowerCase().indexOf(key) >= 0; };
    sortedItems().forEach(function(t) {
        if (t.kind === 'token' && has(t.label) && seeable(t)) out.push({ kind: '棋子', text: t.label, sub: t.hidden ? '隐藏' : '', run: function() { focusToken(t.id); } });
    });
    Object.keys(sheets).forEach(function(id) {
        var sh = sheets[id];
        if (has(sh.name)) out.push({ kind: sh.kind === 'pc' ? '角色' : sh.kind === 'monster' ? '怪物' : '物品', text: sh.name, sub: sheetSub(sh), run: function() { openSheet(id, ''); } });
    });
    var seenSpell = {};
    Object.keys(sheets).forEach(function(id) {
        (sheets[id].spells || []).forEach(function(s) {
            if (!has(s.name) || seenSpell[s.name]) return;
            seenSpell[s.name] = true;
            out.push({ kind: '法术', text: s.name, sub: (s.level === '0' ? '戏法' : s.level ? s.level + '环' : '') + (s.meta ? ' · ' + s.meta : ''), run: function() {
                if (s.text) {
                    sheetView = { mode: 'preview', tmp: { kind: 'item', name: s.name, en: s.en || '', meta: (s.level === '0' ? '戏法' : s.level + '环') + (s.meta ? ' · ' + s.meta : ''), text: s.text }, back: { mode: 'list' } };
                    switchPane('sheets');
                    renderSheets();
                } else openSpell(s.name, s.level);
            } });
        });
    });
    STATUS_DEFS.forEach(function(d) {
        if (has(d.name)) out.push({ kind: '状态', text: d.icon + ' ' + d.name, sub: d.desc, run: function() {
            sheetView = { mode: 'preview', tmp: { kind: 'item', name: d.name, meta: '状态', text: d.desc }, back: { mode: 'list' } };
            switchPane('sheets');
            renderSheets();
        } });
    });
    out = out.slice(0, 30);
    out.push({ kind: '不全书', text: '在不全书中搜索「' + q + '」', sub: '怪物、魔法物品、法术、规则…', run: function() {
        var el = $('lkQ');
        if (el) el.value = q;
        openLookup(q);
    } });
    return out;
}

function renderSearch() {
    var box = $('searchResults'), q = $('globalSearch').value.trim();
    if (!q) { box.style.display = 'none'; searchState.results = []; return; }
    searchState.results = searchAll(q);
    searchState.idx = Math.min(searchState.idx, searchState.results.length - 1);
    box.innerHTML = searchState.results.map(function(r, i) {
        return '<div class="sr-row' + (i === searchState.idx ? ' active' : '') + '" data-sr="' + i + '"><span class="sr-kind">' + escapeHtml(r.kind) + '</span>' +
            '<span class="sr-text">' + escapeHtml(r.text) + '</span>' + (r.sub ? '<span class="sr-sub">' + escapeHtml(r.sub) + '</span>' : '') + '</div>';
    }).join('');
    box.style.display = '';
}

function runSearchResult(i) {
    var r = searchState.results[i];
    if (!r) return;
    $('searchResults').style.display = 'none';
    $('globalSearch').blur();
    r.run();
}

function initStatus() {
    var input = $('globalSearch'), box = $('searchResults');
    input.addEventListener('input', function() { searchState.idx = 0; renderSearch(); });
    input.addEventListener('focus', renderSearch);
    input.addEventListener('blur', function() { setTimeout(function() { box.style.display = 'none'; }, 150); });
    input.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            var n = searchState.results.length;
            if (!n) return;
            searchState.idx = (searchState.idx + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
            renderSearch();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            runSearchResult(searchState.idx);
        } else if (e.key === 'Escape') {
            input.value = '';
            renderSearch();
            input.blur();
        }
        e.stopPropagation();
    });
    box.addEventListener('mousedown', function(e) {
        var row = e.target.closest('[data-sr]');
        if (row) { e.preventDefault(); runSearchResult(parseInt(row.dataset.sr, 10)); }
    });
    window.addEventListener('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K') && $('table').style.display !== 'none') {
            e.preventDefault();
            input.focus();
            input.select();
        }
    });
    $('bossBars').addEventListener('click', function(e) {
        var b = e.target.closest('[data-boss]');
        if (b) focusToken(b.dataset.boss);
    });
}
