// 跑团桌面：角色卡 / 怪物 / 物品
// - 玩家导入 Excel 人物卡（服务器解析 DND 5E2024 人物卡模板的「主要」工作表）
// - GM 从「DND5e 不全书」搜索并导入怪物、物品（服务器代理抓取页面，这里解析 HTML）
// - 角色卡上的属性、豁免、技能、攻击，以及描述文字里的骰子表达式都可以点击直接掷骰
// 依赖 tabletop.js 中的全局状态与函数（me, scene, op, roll, api, gridSize, createItems ...）

var sheets = {};
var sheetView = { mode: 'list', id: '', tokenId: '', tmp: null, back: null };
var lookup = { q: '', filter: 'all', results: null, page: null, loading: false };

var ABILITY_NAMES = { str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力' };
var ABILITY_KEYS = { '力量': 'str', '敏捷': 'dex', '体质': 'con', '智力': 'int', '感知': 'wis', '魅力': 'cha' };
var SIZE_CELLS = [['超巨型', 4], ['巨型', 3], ['大型', 2], ['中型', 1], ['小型', 1], ['微型', 0.5]];

function onSheetsState(list) {
    sheets = {};
    list.forEach(function(sh) { sheets[sh.id] = sh; });
    if (sheetView.mode === 'sheet' && !sheets[sheetView.id]) sheetView.mode = 'list';
    renderSheets();
}

function canEditSheet(sh) { return me.gm || (sh.owner && sh.owner === me.name); }

function sheetSub(sh) {
    if (sh.kind === 'pc') {
        return [sh.race, sh.class + (sh.subclass ? '（' + sh.subclass + '）' : '') + (sh.level ? ' ' + sh.level + '级' : ''), sh.player ? '玩家：' + sh.player : '']
            .filter(Boolean).join(' · ');
    }
    return sh.meta || '';
}

// ===== 掷骰 =====
function normBonus(b) {
    b = String(b == null ? '' : b).replace(/\s/g, '').replace(/＋/g, '+').replace(/[－−]/g, '-');
    if (!b || b === '+0' || b === '-0' || b === '0') return '';
    if (!/^[+-]/.test(b)) b = '+' + b;
    return /^[+-]\d+$/.test(b) ? b : '';
}

// d20 检定会消耗骰子栏里的优势 / 劣势开关
function d20Expr(bonus) {
    var base = advMode === 'adv' ? '2d20kh1' : advMode === 'dis' ? '2d20kl1' : '1d20';
    if (advMode) { advMode = ''; renderDiceButtons(); }
    return base + normBonus(bonus);
}

function sheetRoll(sh, label, expr) {
    roll(expr, (sh ? sh.name + '·' : '') + label, $('diceHidden').checked);
}

function rollBtn(kind, value, label, text) {
    return '<button class="roll-btn" data-' + kind + '="' + escapeHtml(value) + '" data-label="' + escapeHtml(label) + '">' + escapeHtml(text) + '</button>';
}

// 把描述文字里的「命中+4」「攻击检定：+14」以及「1d6+2」之类变成可点击的掷骰按钮
function rollify(text, label) {
    var h = escapeHtml(text || '');
    h = h.replace(/(\d{0,3}[dD]\d{1,3}(?:\s*[+\-−]\s*\d+)?)(?![\w])/g, function(m) {
        var expr = m.replace(/\s/g, '').replace('−', '-').toLowerCase();
        return '<button class="roll-btn dmg" data-roll="' + expr + '" data-label="' + escapeHtml(label || '') + '">' + m + '</button>';
    });
    h = h.replace(/(命中|攻击检定[：:]?|攻击：)\s*([+＋\-－]\s*\d+)/g, function(m, a, b) {
        return a + '<button class="roll-btn atk" data-d20="' + b.replace(/\s/g, '') + '" data-label="' + escapeHtml((label || '') + ' 命中') + '">' + b + '</button>';
    });
    return h.replace(/\n/g, '<br>');
}

function onSheetPaneClick(e) {
    var b = e.target.closest('button, [data-act]');
    if (!b) return;
    var sh = currentSheet();
    if (b.dataset.d20 != null) { sheetRoll(sh, b.dataset.label, d20Expr(b.dataset.d20)); return; }
    if (b.dataset.roll) { sheetRoll(sh, b.dataset.label, b.dataset.roll); return; }
    var id = b.dataset.id;
    switch (b.dataset.act) {
    case 'back': sheetView = sheetView.back || { mode: 'list' }; renderSheets(); break;
    case 'open': openSheet(id, ''); break;
    case 'place': placeSheetToken(sheets[id] || sh); break;
    case 'share': op({ op: 'sheet', sheet: { id: id, shared: !sheets[id].shared || null } }); break;
    case 'del':
        if (confirm('删除「' + sheets[id].name + '」？已放置的棋子会保留，但不再关联这张卡。')) op({ op: 'sheet.delete', ids: [id] });
        break;
    case 'xlsx': $('xlsxFile').click(); break;
    case 'lookup': openLookup(''); break;
    case 'spell': openLookup(b.dataset.name); break;
    case 'hp': changeHp(sh, parseInt(b.dataset.delta, 10)); break;
    case 'slot': changeSlot(sh, parseInt(b.dataset.idx, 10), parseInt(b.dataset.delta, 10)); break;
    case 'res': changeResource(sh, parseInt(b.dataset.idx, 10), parseInt(b.dataset.delta, 10)); break;
    case 'search': runLookup(); break;
    case 'lkfilter': lookup.filter = b.dataset.filter; renderSheets(); break;
    case 'lkpage': loadLookupPage(b.dataset.path, b.dataset.title); break;
    case 'lkback': lookup.page = null; renderSheets(); break;
    case 'lkview': previewEntry(parseInt(b.dataset.idx, 10)); break;
    case 'lkimport': importEntry(parseInt(b.dataset.idx, 10)); break;
    case 'lkpaste': parsePasted(); break;
    case 'import-tmp': importSheet(sheetView.tmp); break;
    }
}

function currentSheet() {
    if (sheetView.mode === 'preview') return sheetView.tmp;
    return sheets[sheetView.id] || null;
}

// HP：从棋子打开时改棋子血量（同一怪物的多个棋子各自独立），否则改角色卡
function changeHp(sh, delta) {
    var tok = sheetView.tokenId && scene.items[sheetView.tokenId];
    if (tok) {
        patchItems([{ id: tok.id, hp: (num(tok.hp, num(tok.hpMax, 0))) + delta }]);
        renderSheets();
        return;
    }
    if (!sh || !canEditSheet(sh) || !sh.hp) return;
    var hp = { cur: String(num(sh.hp.cur, num(sh.hp.max, 0)) + delta), max: sh.hp.max };
    sh.hp = hp;
    op({ op: 'sheet', sheet: { id: sh.id, hp: hp } });
    renderSheets();
}

function changeSlot(sh, idx, delta) {
    if (!sh || !canEditSheet(sh)) return;
    var slots = JSON.parse(JSON.stringify(sh.slots || []));
    var s = slots[idx];
    if (!s) return;
    s.cur = String(Math.max(0, Math.min(num(s.max, 0), num(s.cur, 0) + delta)));
    sh.slots = slots;
    op({ op: 'sheet', sheet: { id: sh.id, slots: slots } });
    renderSheets();
}

function changeResource(sh, idx, delta) {
    if (!sh || !canEditSheet(sh)) return;
    var res = JSON.parse(JSON.stringify(sh.resources || []));
    var r = res[idx];
    if (!r) return;
    r.cur = String(Math.max(0, Math.min(num(r.max, 0), num(r.cur, 0) + delta)));
    sh.resources = res;
    op({ op: 'sheet', sheet: { id: sh.id, resources: res } });
    renderSheets();
}

// ===== 视图 =====
function openSheet(id, tokenId) {
    if (!sheets[id]) return;
    sheetView = { mode: 'sheet', id: id, tokenId: tokenId || '', back: { mode: 'list' } };
    switchPane('sheets');
    renderSheets();
}

function renderSheets() {
    var pane = $('sheetPane');
    if (!pane) return;
    var scroll = pane.scrollTop;
    if (sheetView.mode === 'sheet' && sheets[sheetView.id]) pane.innerHTML = sheetHtml(sheets[sheetView.id], false);
    else if (sheetView.mode === 'preview' && sheetView.tmp) pane.innerHTML = sheetHtml(sheetView.tmp, true);
    else if (sheetView.mode === 'lookup') pane.innerHTML = lookupHtml();
    else { sheetView.mode = 'list'; pane.innerHTML = listHtml(); scroll = 0; }
    pane.scrollTop = scroll;
}

function listHtml() {
    var all = Object.keys(sheets).map(function(id) { return sheets[id]; });
    all.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
    var groups = [['pc', '角色'], ['monster', '怪物 / NPC'], ['item', '物品 / 资料']];
    var h = '<div class="lobby-row" style="gap:6px;">' +
        '<button class="tt-btn primary" data-act="xlsx" title="DND 5E2024 人物卡（.xlsx）">导入人物卡 (Excel)</button>' +
        '<button class="tt-btn" data-act="lookup">📖 不全书图鉴</button></div>';
    groups.forEach(function(g) {
        var list = all.filter(function(sh) { return sh.kind === g[0]; });
        if (!list.length && g[0] !== 'pc') return;
        h += '<div class="side-section"><h5>' + g[1] + '</h5>';
        if (!list.length) h += '<div class="tt-hint">还没有角色卡。点「导入人物卡」选择你的 Excel 人物卡。</div>';
        list.forEach(function(sh) {
            h += '<div class="sheet-row"><div class="info" data-act="open" data-id="' + escapeHtml(sh.id) + '">' +
                '<div class="name">' + escapeHtml(sh.name) + (sh.shared && sh.kind !== 'pc' ? ' <span class="tt-hint">已共享</span>' : '') + '</div>' +
                '<div class="sub">' + escapeHtml(sheetSub(sh)) + '</div></div>' +
                (sh.kind !== 'item' && canEditSheet(sh) ? '<button class="tt-btn small" data-act="place" data-id="' + escapeHtml(sh.id) + '" title="在地图中央放置关联棋子">放置</button>' : '') +
                (me.gm && sh.kind !== 'pc' ? '<button class="tt-btn small" data-act="share" data-id="' + escapeHtml(sh.id) + '" title="让玩家也能看到这张卡">' + (sh.shared ? '取消共享' : '共享') + '</button>' : '') +
                (canEditSheet(sh) ? '<button class="tt-btn small danger" data-act="del" data-id="' + escapeHtml(sh.id) + '">✕</button>' : '') +
                '</div>';
        });
        h += '</div>';
    });
    return h;
}

function chip(label, value) {
    return value === '' || value == null ? '' : '<div class="stat-chip"><span>' + label + '</span><b>' + value + '</b></div>';
}

function sheetHtml(sh, preview) {
    var edit = !preview && canEditSheet(sh);
    var tok = sheetView.tokenId && scene.items[sheetView.tokenId];
    var h = '<div class="sheet-head"><button class="tt-btn small" data-act="back">←</button>' +
        '<div class="title"><div class="name">' + escapeHtml(sh.name) + '</div><div class="sub">' + escapeHtml(sheetSub(sh)) + '</div></div></div>';
    if (preview) {
        h += '<div class="lobby-row" style="gap:6px;">' + (me.gm ? '<button class="tt-btn primary" data-act="import-tmp">导入到房间</button>' : '') +
            '<span class="tt-hint">预览（未保存）· 点击数值可直接掷骰</span></div>';
    } else if (sh.kind !== 'item' && edit) {
        h += '<div class="lobby-row" style="gap:6px;"><button class="tt-btn small" data-act="place" data-id="' + escapeHtml(sh.id) + '">放置棋子</button>' +
            (tok ? '<span class="tt-hint">正在查看棋子「' + escapeHtml(tok.label || '') + '」</span>' : '') + '</div>';
    }

    if (sh.kind === 'item') {
        if (sh.meta) h += '<div class="item-meta">' + escapeHtml(sh.meta) + '</div>';
        h += '<div class="entry-text">' + rollify(sh.text, sh.name) + '</div>';
        return h + sourceHtml(sh);
    }

    // HP（从棋子打开时显示该棋子的血量）
    var hpCur, hpMax;
    if (tok && tok.hpMax) { hpCur = num(tok.hp, tok.hpMax); hpMax = tok.hpMax; }
    else if (sh.hp) { hpCur = num(sh.hp.cur, num(sh.hp.max, 0)); hpMax = num(sh.hp.max, 0); }
    var canHp = tok ? canEdit(tok) : edit;
    h += '<div class="stat-chips">' + chip('AC', escapeHtml(sh.ac || '')) +
        (hpMax != null ? '<div class="stat-chip hp"><span>HP</span><b>' + hpCur + ' / ' + hpMax + '</b>' +
            (canHp ? '<div><button class="tt-btn small" data-act="hp" data-delta="-5">-5</button><button class="tt-btn small" data-act="hp" data-delta="-1">-1</button>' +
                '<button class="tt-btn small" data-act="hp" data-delta="1">+1</button><button class="tt-btn small" data-act="hp" data-delta="5">+5</button></div>' : '') +
            (sh.hp && sh.hp.formula ? '<div>' + rollBtn('roll', sh.hp.formula.replace(/\s/g, ''), '生命值', sh.hp.formula) + '</div>' : '') + '</div>' : '') +
        chip('速度', escapeHtml(sh.speed || '')) +
        (sh.init != null && sh.init !== '' ? '<div class="stat-chip"><span>先攻</span>' + rollBtn('d20', sh.init, '先攻', normBonus(sh.init) || '+0') + '</div>' : '') +
        chip('熟练', escapeHtml(sh.prof || '')) + chip('被动察觉', escapeHtml(sh.passive || '')) + chip('CR', escapeHtml(sh.cr || '')) +
        '</div>';

    // 属性：点名字 = 检定，点「豁免」= 豁免
    if (sh.abilities && sh.abilities.length) {
        h += '<div class="abil-grid">' + sh.abilities.map(function(a) {
            var name = a.name || ABILITY_NAMES[a.key] || a.key;
            return '<div class="abil-cell' + (a.saveProf ? ' prof' : '') + '">' +
                '<button class="roll-btn big" data-d20="' + escapeHtml(a.mod || '') + '" data-label="' + escapeHtml(name + '检定') + '">' +
                '<span>' + escapeHtml(name) + '</span><b>' + escapeHtml(normBonus(a.mod) || '+0') + '</b><small>' + escapeHtml(a.score || '') + '</small></button>' +
                '<button class="roll-btn" data-d20="' + escapeHtml(a.save || a.mod || '') + '" data-label="' + escapeHtml(name + '豁免') + '">豁免 ' +
                escapeHtml(normBonus(a.save || a.mod) || '+0') + '</button></div>';
        }).join('') + '</div>';
    }

    if (sh.skills && sh.skills.length) {
        h += '<div class="side-section"><h5>技能</h5><div class="skill-grid">' + sh.skills.map(function(s) {
            return '<button class="roll-btn skill' + (s.prof ? ' prof' : '') + '" data-d20="' + escapeHtml(s.bonus) + '" data-label="' + escapeHtml(s.name) + '">' +
                '<span>' + escapeHtml(s.name) + '</span><b>' + escapeHtml(normBonus(s.bonus) || '+0') + '</b></button>';
        }).join('') + '</div></div>';
    }

    if (sh.attacks && sh.attacks.length) {
        h += '<div class="side-section"><h5>武器攻击</h5>' + sh.attacks.map(function(a) {
            return '<div class="attack-row"><div class="name">' + escapeHtml(a.name) + '</div>' +
                (a.atk ? rollBtn('d20', a.atk, a.name + ' 命中', '命中 ' + a.atk) : '') +
                (a.damage ? rollBtn('roll', a.damage, a.name + ' 伤害' + (a.type ? '（' + a.type + '）' : ''), a.damage + (a.type ? ' ' + a.type : '')) : '') +
                (a.props || a.mastery ? '<div class="tt-hint">' + escapeHtml([a.props, a.mastery ? '精通：' + a.mastery : ''].filter(Boolean).join(' · ')) + '</div>' : '') +
                '</div>';
        }).join('') + '</div>';
    }

    if ((sh.casting && sh.casting.length) || (sh.slots && sh.slots.length) || (sh.spells && sh.spells.length)) {
        h += '<div class="side-section"><h5>施法</h5>';
        (sh.casting || []).forEach(function(c) {
            h += '<div class="attack-row"><div class="name">' + escapeHtml(c.ability) + '</div><span class="tt-hint">DC ' + escapeHtml(c.dc) + '</span>' +
                rollBtn('d20', c.atk, c.ability + '法术攻击', '法术攻击 ' + (normBonus(c.atk) || '+0')) + '</div>';
        });
        (sh.slots || []).forEach(function(s, i) {
            h += '<div class="attack-row"><div class="name">' + escapeHtml(s.level) + '环法术位</div><b>' + escapeHtml(s.cur) + ' / ' + escapeHtml(s.max) + '</b>' +
                (edit ? '<button class="tt-btn small" data-act="slot" data-idx="' + i + '" data-delta="-1">用</button><button class="tt-btn small" data-act="slot" data-idx="' + i + '" data-delta="1">回</button>' : '') + '</div>';
        });
        if (sh.spells && sh.spells.length) {
            h += '<div class="spell-chips">' + sh.spells.map(function(s) {
                return '<button class="tt-btn small" data-act="spell" data-name="' + escapeHtml(s.name) + '" title="在不全书中查看">' +
                    (s.level === '0' || s.level === 0 ? '戏法·' : s.level ? s.level + '环·' : '') + escapeHtml(s.name) + '</button>';
            }).join('') + '</div>';
        }
        h += '</div>';
    }

    if (sh.resources && sh.resources.length) {
        h += '<div class="side-section"><h5>特殊资源</h5>' + sh.resources.map(function(r, i) {
            return '<div class="attack-row"><div class="name">' + escapeHtml(r.name) + '</div><b>' + escapeHtml(r.cur) + ' / ' + escapeHtml(r.max) + '</b>' +
                (edit ? '<button class="tt-btn small" data-act="res" data-idx="' + i + '" data-delta="-1">-</button><button class="tt-btn small" data-act="res" data-idx="' + i + '" data-delta="1">+</button>' : '') + '</div>';
        }).join('') + '</div>';
    }

    if (sh.props && sh.props.length) {
        h += '<div class="side-section">' + sh.props.map(function(p) {
            return '<div class="prop-line"><b>' + escapeHtml(p.label) + '</b> ' + rollify(p.value, p.label) + '</div>';
        }).join('') + '</div>';
    }

    (sh.sections || []).forEach(function(sec) {
        h += '<div class="side-section"><h5>' + escapeHtml(sec.title) + '</h5>' + sec.entries.map(function(en) {
            var label = (en.name || sec.title).replace(/。$/, '');
            return '<div class="entry">' + (en.name ? '<b>' + escapeHtml(en.name.replace(/。$/, '')) + '。</b>' : '') + rollify(en.text, label) + '</div>';
        }).join('') + '</div>';
    });

    if (sh.features && sh.features.length) {
        h += '<div class="side-section"><h5>特性与专长</h5>' + sh.features.map(function(f) {
            return '<details class="feature"><summary>' + escapeHtml(f.name) + '</summary><div class="entry-text">' + rollify(f.text, f.name) + '</div></details>';
        }).join('') + '</div>';
    }
    return h + sourceHtml(sh);
}

function sourceHtml(sh) {
    return sh.source ? '<div class="tt-hint" style="margin-top:12px;">来源：DND5e 不全书 · ' + escapeHtml(sh.source.replace(/^topics\//, '').replace(/\.html?$/, '')) + '</div>' : '';
}

// ===== 放置棋子 =====
function sizeCells(sh) {
    var text = (sh.size || '') + ' ' + (sh.meta || '');
    for (var i = 0; i < SIZE_CELLS.length; i++) if (text.indexOf(SIZE_CELLS[i][0]) >= 0) return SIZE_CELLS[i][1];
    return 1;
}

function placeSheetToken(sh) {
    if (!sh) return;
    var g = gridSize(), cells = sizeCells(sh), w = g * cells;
    var c = toWorld(canvas.clientWidth / 2, canvas.clientHeight / 2);
    var pos = snapToGrid(c.x - w / 2, c.y - w / 2);
    var same = sortedItems().filter(function(it) { return it.sheet === sh.id; }).length;
    var it = { id: genId(), kind: 'token', x: pos.x, y: pos.y, w: w, h: w, circle: true, sheet: sh.id, z: nextZ(),
        color: sh.kind === 'pc' ? '#1e88e5' : '#c62828', label: sh.name + (sh.kind !== 'pc' && same ? ' ' + (same + 1) : '') };
    var max = sh.hp ? num(sh.hp.max, 0) : 0;
    if (max > 0) { it.hpMax = max; it.hp = num(sh.hp.cur, max); }
    if (me.gm && sh.kind === 'pc' && sh.owner) it.owner = sh.owner;
    createItems([it]);
    setTool('select');
    selectOnly([it.id]);
    notice('已放置「' + it.label + '」，可把资产库里的图片拖到棋子上更换头像');
}

// ===== Excel 人物卡 =====
function importXlsx(input) {
    var file = input.files[0];
    input.value = '';
    if (!file) return;
    var fd = new FormData();
    fd.append('file', file);
    notice('正在解析 ' + file.name + '...');
    api('/api/tabletop/charsheet', 'POST', fd).then(function(data) {
        var sh = data.sheet;
        // 同名且属于自己的角色卡：直接更新（升级后重新导入）
        var existing = Object.keys(sheets).map(function(id) { return sheets[id]; }).filter(function(x) {
            return x.kind === 'pc' && x.name === sh.name && canEditSheet(x);
        })[0];
        if (existing && confirm('已存在角色「' + sh.name + '」，用新文件覆盖更新吗？（取消则另建一张）')) sh.id = existing.id;
        else sh.id = genId();
        importSheet(sh);
    }).catch(apiError);
}

function importSheet(sh) {
    if (!sh) return;
    sh = JSON.parse(JSON.stringify(sh));
    if (!sh.id || !/^[A-Za-z0-9_-]{1,40}$/.test(sh.id)) sh.id = genId();
    if (sheets[sh.id] && sheets[sh.id].kind !== sh.kind) sh.id = genId();
    op({ op: 'sheet', sheet: sh }).then(function(ok) {
        if (!ok) return;
        if (!sheets[sh.id]) sheets[sh.id] = sh; // 等服务器回显前先显示
        notice('已导入「' + sh.name + '」');
        openSheet(sh.id, '');
    });
}

// ===== 不全书图鉴 =====
function openLookup(q) {
    var back = sheetView.mode === 'lookup' ? sheetView.back : JSON.parse(JSON.stringify({ mode: sheetView.mode, id: sheetView.id, tokenId: sheetView.tokenId }));
    sheetView = { mode: 'lookup', back: back.mode === 'preview' ? { mode: 'list' } : back };
    switchPane('sheets');
    if (q) { lookup.q = q; lookup.page = null; runLookup(); }
    renderSheets();
}

function lookupCategory(path) {
    if (/怪物图鉴|生物|怪物/.test(path)) return 'monster';
    if (/法术/.test(path)) return 'spell';
    if (/魔法物品|宝藏|装备|物品/.test(path)) return 'item';
    return 'other';
}

function lookupHtml() {
    var h = '<div class="sheet-head"><button class="tt-btn small" data-act="back">←</button><div class="title"><div class="name">📖 不全书图鉴</div>' +
        '<div class="sub">数据来自 5echm.kagangtuya.top（DND5e 不全书）</div></div></div>';
    if (lookup.page) return h + lookupPageHtml();
    h += '<div class="dice-row"><input class="tt-input" id="lkQ" placeholder="怪物 / 物品 / 法术名，如：地精、成年红龙、治疗药水" value="' + escapeHtml(lookup.q) + '">' +
        '<button class="tt-btn primary" data-act="search">搜索</button></div>';
    h += '<div class="filter-row">' + [['all', '全部'], ['monster', '怪物'], ['item', '物品'], ['spell', '法术']].map(function(f) {
        return '<button class="tt-btn small' + (lookup.filter === f[0] ? ' active' : '') + '" data-act="lkfilter" data-filter="' + f[0] + '">' + f[1] + '</button>';
    }).join('') + '</div>';
    if (lookup.loading) h += '<div class="tt-hint">加载中...</div>';
    else if (lookup.results) {
        var list = lookup.results.filter(function(r) { return lookup.filter === 'all' || lookupCategory(r.path) === lookup.filter; });
        if (!list.length) h += '<div class="tt-hint">没有找到结果</div>';
        h += list.map(function(r) {
            var parts = r.path.replace(/^topics\//, '').split('/');
            return '<div class="sheet-row"><div class="info" data-act="lkpage" data-path="' + escapeHtml(r.path) + '" data-title="' + escapeHtml(r.title) + '">' +
                '<div class="name">' + escapeHtml(r.title) + '</div><div class="sub">' + escapeHtml(parts.slice(0, -1).join(' / ')) + '</div></div></div>';
        }).join('');
    }
    h += '<div class="side-section" style="margin-top:16px;"><h5>或粘贴文本</h5>' +
        '<textarea class="tt-input" id="lkPaste" rows="5" style="width:100%;" placeholder="从任意网页 / 文档复制一段怪物数据或物品描述粘贴到这里"></textarea>' +
        '<button class="tt-btn" data-act="lkpaste" style="margin-top:6px;">解析文本</button></div>';
    return h;
}

function lookupPageHtml() {
    var p = lookup.page;
    var h = '<div class="lobby-row" style="gap:6px;"><button class="tt-btn small" data-act="lkback">← 搜索结果</button><b>' + escapeHtml(p.title) + '</b></div>';
    if (p.loading) return h + '<div class="tt-hint">正在获取页面...</div>';
    if (!p.entries.length) return h + '<div class="tt-hint">这个页面里没有识别出怪物数据或物品条目。</div>';
    return h + p.entries.map(function(en, i) {
        return '<div class="sheet-row"><div class="info" data-act="lkview" data-idx="' + i + '"><div class="name">' +
            (en.kind === 'monster' ? '👹 ' : '📜 ') + escapeHtml(en.name) + '</div><div class="sub">' + escapeHtml(sheetSub(en).slice(0, 60)) + '</div></div>' +
            '<button class="tt-btn small" data-act="lkview" data-idx="' + i + '">查看</button>' +
            (me.gm ? '<button class="tt-btn small primary" data-act="lkimport" data-idx="' + i + '">导入</button>' : '') + '</div>';
    }).join('');
}

function runLookup() {
    var el = $('lkQ');
    if (el) lookup.q = el.value.trim();
    if (!lookup.q) return;
    lookup.loading = true;
    lookup.page = null;
    renderSheets();
    api('/api/tabletop/5e/search?q=' + enc(lookup.q), 'GET').then(function(data) {
        lookup.loading = false;
        lookup.results = (data.results || []).map(function(r) { return { title: r.title || r.rawTitle, path: r.path }; })
            .filter(function(r) { return r.path && /^topics\//.test(r.path); });
        renderSheets();
    }).catch(function(e) { lookup.loading = false; renderSheets(); apiError(e); });
}

function loadLookupPage(path, title) {
    lookup.page = { path: path, title: title, loading: true, entries: [] };
    renderSheets();
    fetch('/api/tabletop/5e/page?path=' + enc(path), { headers: { 'Authorization': 'Bearer ' + authToken } }).then(function(r) {
        if (!r.ok) return r.json().then(function(d) { throw d.error || '获取失败'; });
        return r.text();
    }).then(function(html) {
        if (!lookup.page || lookup.page.path !== path) return;
        var entries = parse5ePage(html, path);
        var q = lookup.q;
        entries.sort(function(a, b) { return (b.name.indexOf(q) >= 0) - (a.name.indexOf(q) >= 0); });
        lookup.page.entries = entries;
        lookup.page.loading = false;
        renderSheets();
    }).catch(function(e) { lookup.page = null; renderSheets(); apiError(typeof e === 'string' ? e : '获取失败'); });
}

function previewEntry(i) {
    var en = lookup.page && lookup.page.entries[i];
    if (!en) return;
    sheetView = { mode: 'preview', tmp: en, back: { mode: 'lookup', back: sheetView.back } };
    renderSheets();
}

function importEntry(i) {
    var en = lookup.page && lookup.page.entries[i];
    if (en) importSheet(en);
}

function parsePasted() {
    var text = ($('lkPaste').value || '').trim();
    if (!text) return;
    var list = parseMonsterText(normalizeText(text), '');
    if (!list.length) {
        var lines = text.split('\n');
        list = [{ kind: 'item', name: lines[0].trim().slice(0, 40), meta: '', text: lines.slice(1).join('\n').trim() }];
    }
    lookup.page = { path: '', title: '粘贴的文本', loading: false, entries: list };
    renderSheets();
}

// ===== 不全书页面解析 =====
var BLOCK_TAGS = /^(P|DIV|BR|TR|TABLE|H[1-6]|LI|UL|OL|SECTION|BLOCKQUOTE)$/;

// 近似 innerText：文本内换行折叠为空格，块级元素换行，表格单元格用 | 分隔
function domText(node) {
    var out = [];
    (function walk(n) {
        if (n.nodeType === 3) { out.push(n.nodeValue.replace(/[\s ]+/g, ' ')); return; }
        if (n.nodeType !== 1 || /^(SCRIPT|STYLE|HEAD|TITLE)$/.test(n.tagName)) return;
        var block = BLOCK_TAGS.test(n.tagName);
        if (block) out.push('\n');
        if (n.tagName === 'TD' || n.tagName === 'TH') out.push(' | ');
        for (var c = n.firstChild; c; c = c.nextSibling) walk(c);
        if (block) out.push('\n');
    })(node);
    return normalizeText(out.join(''));
}

function normalizeText(t) {
    return t.split('\n').map(function(l) { return l.replace(/^[\s|]+|[\s|]+$/g, '').replace(/\s*\|\s*(\|\s*)+/g, ' | '); })
        .filter(Boolean).join('\n');
}

function cnName(s) {
    var m = (s || '').trim().match(/^[^A-Za-z]+/);
    return (m ? m[0] : s || '').trim();
}

function parse5ePage(html, path) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var out = [];
    doc.querySelectorAll('.stat-block').forEach(function(b) { out.push(parseStatBlock(b, path)); });
    if (!out.length) out = parseMonsterText(domText(doc.body), path);
    if (!out.length) out = parseItems(doc, path);
    return out;
}

function splitList(s) {
    return (s || '').split(/[，,、；;]/).map(function(x) { return x.trim(); }).filter(Boolean);
}

function parseSkills(s) {
    return splitList(s).map(function(x) {
        var m = x.match(/^(.+?)\s*([+＋\-－−]\s*\d+)$/);
        return m ? { name: m[1].trim(), bonus: normBonus(m[2]) || '+0', prof: true } : null;
    }).filter(Boolean);
}

// 2024 怪物图鉴：<div class="stat-block">
function parseStatBlock(b, path) {
    var t = function(el) { return el ? domText(el).replace(/\n/g, ' ').trim() : ''; };
    var full = t(b.querySelector('h5, h4, h3'));
    var sh = { kind: 'monster', name: cnName(full) || full, en: full.replace(cnName(full), '').trim(), meta: t(b.querySelector('.sub-line')),
        source: path, abilities: [], props: [], sections: [] };

    var abil = b.querySelector('table.stat-abilities');
    if (abil) {
        var tds = Array.prototype.slice.call(abil.querySelectorAll('td'));
        tds.forEach(function(td, i) {
            var key = ABILITY_KEYS[t(td)];
            if (key && td.querySelector('strong, b')) {
                sh.abilities.push({ key: key, name: ABILITY_NAMES[key], score: t(tds[i + 1]), mod: normBonus(t(tds[i + 2])) || '+0',
                    save: normBonus(t(tds[i + 3])) || '+0', saveProf: t(tds[i + 2]) !== t(tds[i + 3]) });
            }
        });
    }
    b.querySelectorAll('table').forEach(function(tb) {
        if (tb === abil) return;
        tb.querySelectorAll('td').forEach(function(td) {
            var st = td.querySelector('strong, b');
            if (!st) return;
            var label = t(st), value = t(td).slice(label.length).trim();
            switch (label) {
            case 'AC': sh.ac = value; break;
            case '先攻': sh.init = normBonus((value.match(/[+\-−]\s*\d+/) || [''])[0]); break;
            case 'HP':
                var m = value.match(/(\d+)\s*[（(]([^）)]+)[）)]/);
                sh.hp = m ? { max: m[1], cur: m[1], formula: m[2].replace(/\s/g, '') } : { max: (value.match(/\d+/) || ['0'])[0] };
                break;
            case '速度': sh.speed = value; break;
            case '技能': sh.skills = parseSkills(value); break;
            case 'CR': sh.cr = value.replace(/（.*$/, ''); sh.props.push({ label: label, value: value }); break;
            default: sh.props.push({ label: label, value: value });
            }
        });
    });
    b.querySelectorAll('h6').forEach(function(h6) {
        var sec = { title: cnName(t(h6)) || t(h6), entries: [] };
        for (var n = h6.nextElementSibling; n && n.tagName !== 'H6'; n = n.nextElementSibling) {
            n.innerHTML.split(/<br\s*\/?>/i).forEach(function(piece) {
                var div = document.createElement('div');
                div.innerHTML = piece;
                var text = t(div);
                if (!text) return;
                var st = div.querySelector('strong, b');
                var name = st && text.indexOf(t(st)) === 0 ? t(st) : '';
                var rest = text.slice(name.length).trim();
                // 「随意：」「1/日：」这类施法子条目并入上一条
                if (name && /[：:]$/.test(name) && sec.entries.length) { sec.entries[sec.entries.length - 1].text += '\n' + name + rest; return; }
                sec.entries.push({ name: name, text: rest });
            });
        }
        if (sec.entries.length) sh.sections.push(sec);
    });
    return sh;
}

// 旧版（2014）怪物图鉴及粘贴文本：以「护甲等级：」行定位每个怪物，上两行是名称和体型阵营
function parseMonsterText(text, path) {
    var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
    var starts = [];
    lines.forEach(function(l, i) { if (/^(护甲等级|AC)\s*[：:]?\s*\d/.test(l) && i >= 1) starts.push(i); });
    return starts.map(function(k, n) {
        var end = n + 1 < starts.length ? starts[n + 1] - 2 : lines.length;
        var hasMeta = k >= 2 && /型/.test(lines[k - 1]);
        var full = hasMeta ? lines[k - 2] : lines[k - 1];
        var sh = { kind: 'monster', name: cnName(full) || full, en: full.replace(cnName(full), '').trim(), meta: hasMeta ? lines[k - 1] : '',
            source: path, abilities: [], props: [], sections: [] };
        var body = lines.slice(k, end);
        var joined = body.join('\n');
        var m;
        if ((m = joined.match(/(?:护甲等级|AC)\s*[：:]?\s*(\d+)\s*([^\n]*)/))) sh.ac = m[1] + (m[2] ? ' ' + m[2] : '');
        if ((m = joined.match(/(?:生命值|HP)\s*[：:]?\s*(\d+)\s*[（(]([^）)]+)[）)]/))) sh.hp = { max: m[1], cur: m[1], formula: m[2].replace(/\s/g, '') };
        if ((m = joined.match(/速度\s*[：:]?\s*([^\n]+)/))) sh.speed = m[1];
        Object.keys(ABILITY_KEYS).forEach(function(name) {
            var r = joined.match(new RegExp(name + '\\s*(\\d+)\\s*[（(]\\s*([+\\-−]?\\s*\\d+)\\s*[）)]'));
            if (r) sh.abilities.push({ key: ABILITY_KEYS[name], name: name, score: r[1], mod: normBonus(r[2]) || '+0', save: normBonus(r[2]) || '+0' });
        });
        if ((m = joined.match(/豁免\s*[：:]\s*([^\n]+)/))) {
            parseSkills(m[1]).forEach(function(s) {
                sh.abilities.forEach(function(a) { if (s.name.indexOf(a.name) >= 0) { a.save = s.bonus; a.saveProf = true; } });
            });
        }
        if ((m = joined.match(/技能\s*[：:]\s*([^\n]+)/))) sh.skills = parseSkills(m[1]);
        var dex = sh.abilities.filter(function(a) { return a.key === 'dex'; })[0];
        if (dex) sh.init = dex.mod;

        var propRe = /^(伤害抗性|伤害免疫|伤害易伤|状态免疫|抗性|免疫|易伤|感官|语言|挑战等级|CR)\s*[：:]\s*(.+)$/;
        var sec = { title: '特质', entries: [] }, startIdx = 0;
        body.forEach(function(l, i) { if (propRe.test(l) || /^(护甲等级|生命值|速度|技能|豁免|力量|敏捷|体质|智力|感知|魅力)/.test(l)) startIdx = i + 1; });
        body.forEach(function(l, i) {
            var pm = l.match(propRe);
            if (pm && i < startIdx) {
                sh.props.push({ label: pm[1], value: pm[2] });
                if (pm[1] === '挑战等级' || pm[1] === 'CR') sh.cr = pm[2].replace(/[（(].*$/, '').trim();
                return;
            }
            if (i < startIdx) return;
            if (/^(动作|附赠动作|反应|传奇动作|巢穴动作|区域效应|神话动作)$/.test(l)) {
                if (sec.entries.length) sh.sections.push(sec);
                sec = { title: l, entries: [] };
                return;
            }
            var dot = l.indexOf('。');
            if (dot > 0 && dot <= 40) sec.entries.push({ name: l.slice(0, dot), text: l.slice(dot + 1).trim() });
            else if (sec.entries.length) sec.entries[sec.entries.length - 1].text += '\n' + l;
            else sec.entries.push({ name: '', text: l });
        });
        if (sec.entries.length) sh.sections.push(sec);
        return sh;
    }).filter(function(sh) { return sh.name && (sh.hp || sh.abilities.length); });
}

// 物品：2024 版每个物品是 <H6 id>，2014 版是 <strong><font color=#800000>；用标记切分页面文本
function parseItems(doc, path) {
    var heads = Array.prototype.slice.call(doc.querySelectorAll('h6, h5, h4'));
    if (!heads.length) {
        heads = Array.prototype.slice.call(doc.querySelectorAll('strong font[color], b font[color]')).map(function(f) { return f.closest('strong, b'); });
    }
    var pageTitle = cnName((doc.title || '').trim()) || path.split('/').pop().replace(/\.html?$/, '');
    if (!heads.length) {
        var all = domText(doc.body);
        return all ? [{ kind: 'item', name: pageTitle, meta: '', text: all, source: path }] : [];
    }
    heads.forEach(function(h) { h.textContent = '\u0001' + domText(h).replace(/\n/g, ' ') + '\u0002'; });
    var text = domText(doc.body);
    return text.split('\u0001').slice(1).map(function(piece) {
        var end = piece.indexOf('\u0002');
        var name = piece.slice(0, end).trim();
        var body = piece.slice(end + 1).replace(/\u0001|\u0002/g, '').trim();
        var lines = body.split('\n');
        var meta = '';
        if (lines.length && /(普通|珍稀|稀有|传说|神器|同调|多种稀有度|药水|武器|护甲|戒指|法杖|权杖|魔杖|奇物|卷轴)/.test(lines[0]) && lines[0].length < 80) meta = lines.shift();
        return { kind: 'item', name: cnName(name) || name, en: name.replace(cnName(name), '').trim(), meta: meta, text: lines.join('\n').trim(), source: path };
    }).filter(function(it) { return it.name && it.text; });
}

function initSheets() {
    $('sheetPane').addEventListener('click', onSheetPaneClick);
    $('sheetPane').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && e.target.id === 'lkQ') runLookup();
    });
    renderSheets();
}
