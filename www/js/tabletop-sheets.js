// 跑团桌面：角色卡 / 怪物 / 物品
// - 玩家导入 Excel 人物卡（服务器解析 DND 5E2024 人物卡模板的「主要」工作表）
// - GM 从「DND5e 不全书」搜索并导入怪物、物品（服务器代理抓取页面，这里解析 HTML）
// - 角色卡上的属性、豁免、技能、攻击，以及描述文字里的骰子表达式都可以点击直接掷骰
// 依赖 tabletop.js 中的全局状态与函数（me, scene, op, roll, api, gridSize, createItems ...）

var sheets = {};
var sheetView = { mode: 'list', id: '', tokenId: '', tmp: null, back: null };
var lookup = { q: '', filter: 'all', results: null, page: null, loading: false, monsters: null, mLoading: false, mMore: false };

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
    var ranges = (String(text || '').match(/触及\s*\d+\s*尺|射程\s*\d+\s*[\/／]\s*\d+\s*尺?|射程\s*\d+\s*尺/g) || []).join(' ');
    h = h.replace(/(\d{0,3}[dD]\d{1,3}(?:\s*[+\-−]\s*\d+)?)(?![\w])/g, function(m) {
        var expr = m.replace(/\s/g, '').replace('−', '-').toLowerCase();
        return '<button class="roll-btn dmg" data-roll="' + expr + '" data-label="' + escapeHtml(label || '') + '">' + m + '</button>';
    });
    h = h.replace(/(命中|攻击检定[：:]?|攻击：)\s*([+＋\-－]\s*\d+)/g, function(m, a, b) {
        return a + '<button class="roll-btn atk" data-d20="' + b.replace(/\s/g, '') + '" data-atk="1" data-range="' + escapeHtml(ranges) + '" data-label="' + escapeHtml((label || '') + ' 命中') + '">' + b + '</button>';
    });
    return h.replace(/\n/g, '<br>');
}

function onSheetPaneClick(e) {
    var b = e.target.closest('button, [data-act]');
    if (!b) return;
    var sh = currentSheet();
    // 先弹出确认框（普通 / 优势 / 劣势、调整值、暴击、暗骰）；Shift+点击直接掷
    if (b.dataset.d20 != null) {
        var req = { who: sh && sh.name, label: b.dataset.label, bonus: b.dataset.d20 };
        if (b.dataset.atk != null) {
            req.attack = true;
            req.range = b.dataset.range != null ? parseAttackRange(b.dataset.range) : null;
        }
        if (e.shiftKey) quickRoll(req);
        else openRollDialog(req);
        return;
    }
    if (b.dataset.roll) {
        if (e.shiftKey) sheetRoll(sh, b.dataset.label, b.dataset.roll);
        else openRollDialog({ who: sh && sh.name, label: b.dataset.label, expr: b.dataset.roll });
        return;
    }
    var id = b.dataset.id;
    if (onSummonClick(b, sh)) return;
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
    case 'spell':
        var own = sh && (sh.spells || []).filter(function(x) { return x.name === b.dataset.name && x.text; })[0];
        if (own) {
            var back = { mode: sheetView.mode, id: sheetView.id, tokenId: sheetView.tokenId, back: sheetView.back };
            sheetView = { mode: 'preview', tmp: { kind: 'item', name: own.name, en: own.en || '', meta: (own.level === '0' ? '戏法' : own.level + '环') + (own.meta ? ' · ' + own.meta : ''), text: own.text }, back: back };
            renderSheets();
        } else openSpell(b.dataset.name, b.dataset.level);
        break;
    case 'hp': changeHp(sh, parseInt(b.dataset.delta, 10)); break;
    case 'slot': changeSlot(sh, parseInt(b.dataset.idx, 10), parseInt(b.dataset.delta, 10)); break;
    case 'res': changeResource(sh, parseInt(b.dataset.idx, 10), parseInt(b.dataset.delta, 10)); break;
    case 'cast': e.preventDefault(); castFromSheet(sh, b.dataset); break;
    case 'multi': e.preventDefault(); openMultiattack(sh, +b.dataset.sec, +b.dataset.idx); break;
    case 'search': runLookup(); break;
    case 'deploy': deployMonster(b.dataset.key, b); break;
    case 'lkfilter': lookup.filter = b.dataset.filter; renderSheets(); break;
    case 'lkpage': loadLookupPage(b.dataset.path, b.dataset.title); break;
    case 'lkback': lookup.page = null; renderSheets(); break;
    case 'lkview': previewEntry(parseInt(b.dataset.idx, 10)); break;
    case 'lkimport': importEntry(parseInt(b.dataset.idx, 10)); break;
    case 'lkpaste': parsePasted(); break;
    case 'import-tmp': importSheet(sheetView.tmp); break;
    case 'modadd': addSheetMod(sh); break;
    case 'moddel': delSheetMod(sh, parseInt(b.dataset.idx, 10)); break;
    case 'modoff': toggleAutoMod(sh, b.dataset.name, true); break;
    case 'modon': toggleAutoMod(sh, b.dataset.name, false); break;
    }
}

function currentSheet() {
    if (sheetView.mode === 'preview') return sheetView.tmp;
    return sheets[sheetView.id] || null;
}

// HP：从棋子打开时改棋子血量（同一怪物的多个棋子各自独立），否则改角色卡
function changeHp(sh, delta) {
    var tok = sheetView.tokenId && scene.items[sheetView.tokenId];
    if (tok && tok.hpMax > 0) {
        patchItems([tokenHpPatch(tok, delta)]);
        renderSheets();
        return;
    }
    if (!sh || !canEditSheet(sh) || !sh.hp) return;
    var r = applyHpDelta(sh.hp.cur, sh.hp.max, sh.hp.temp, delta);
    saveSheetHp(sh, { cur: String(r.hp), temp: String(r.temp) });
}

function setTempHp(sh, value) {
    var t = Math.max(0, parseInt(value, 10) || 0);
    var tok = sheetView.tokenId && scene.items[sheetView.tokenId];
    if (tok && tok.hpMax > 0) {
        patchItems([{ id: tok.id, hpTemp: t || null }]);
        renderSheets();
        return;
    }
    if (sh && canEditSheet(sh) && sh.hp) saveSheetHp(sh, { temp: String(t) });
}

function saveSheetHp(sh, change) {
    var hp = JSON.parse(JSON.stringify(sh.hp));
    for (var k in change) hp[k] = change[k];
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
    else if (sheetView.mode === 'newsummon') pane.innerHTML = newSummonHtml();
    else { sheetView.mode = 'list'; pane.innerHTML = listHtml(); scroll = 0; }
    pane.scrollTop = scroll;
    renderCharQuick();
}

function listHtml() {
    var all = Object.keys(sheets).map(function(id) { return sheets[id]; });
    all.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
    var groups = [['pc', '角色'], ['summon', '随从 / 召唤物'], ['monster', '怪物 / NPC'], ['item', '物品 / 资料']];
    var h = '<div class="lobby-row" style="gap:6px;">' +
        '<button class="tt-btn primary" data-act="xlsx" title="DND 5E2024 人物卡（.xlsx），或 obr-suite 角色卡的 data.json">导入人物卡 (Excel / JSON)</button>' +
        '<button class="tt-btn" data-act="lookup">📖 不全书图鉴</button>' +
        (masterChoices().length ? '<button class="tt-btn" data-act="newsummon" title="魔能炮台这类没有独立怪物卡的召唤物：攻击和 DC 跟随主控">＋ 随从</button>' : '') + '</div>';
    groups.forEach(function(g) {
        var list = all.filter(function(sh) { return sh.kind === g[0]; });
        if (!list.length && g[0] !== 'pc') return;
        h += '<div class="side-section"><h5>' + g[1] + '</h5>';
        if (!list.length) h += '<div class="tt-hint">还没有角色卡。点「导入人物卡」选择你的 Excel 人物卡，或 obr-suite 角色卡导出的 JSON。</div>';
        list.forEach(function(sh) {
            h += '<div class="sheet-row"><div class="info" data-act="open" data-id="' + escapeHtml(sh.id) + '">' +
                '<div class="name">' + escapeHtml(sh.name) + (sh.shared && sh.kind !== 'pc' && sh.kind !== 'summon' ? ' <span class="tt-hint">已共享</span>' : '') + (masterSheet(sh) ? ' <span class="tt-hint">主控：' + escapeHtml(masterSheet(sh).name) + '</span>' : '') + '</div>' +
                '<div class="sub">' + escapeHtml(sheetSub(sh)) + '</div></div>' +
                (sh.kind !== 'item' && canEditSheet(sh) ? '<button class="tt-btn small" data-act="place" data-id="' + escapeHtml(sh.id) + '" title="在地图中央放置关联棋子">放置</button>' : '') +
                (me.gm && sh.kind !== 'pc' && sh.kind !== 'summon' ? '<button class="tt-btn small" data-act="share" data-id="' + escapeHtml(sh.id) + '" title="让玩家也能看到这张卡">' + (sh.shared ? '取消共享' : '共享') + '</button>' : '') +
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
    if (!preview) sh = viewSheet(sh); // 随从：【…】按主控换算
    var tok = sheetView.tokenId && scene.items[sheetView.tokenId];
    var h = '<div class="sheet-head"><button class="tt-btn small" data-act="back">←</button>' +
        '<div class="title"><div class="name">' + escapeHtml(sh.name) + '</div><div class="sub">' + escapeHtml(sheetSub(sh)) + '</div></div></div>';
    if (sh.portrait) h += '<div class="sheet-portrait"><a href="' + escapeHtml(assetURL(sh.portrait)) + '" target="_blank" rel="noopener" title="查看大图">' +
        '<img src="' + escapeHtml(assetURL(sh.portrait)) + '" alt="' + escapeHtml(sh.name) + '"></a></div>';
    if (preview) {
        h += '<div class="lobby-row" style="gap:6px;">' + (me.gm ? '<button class="tt-btn primary" data-act="import-tmp">导入到房间</button>' : '') +
            '<span class="tt-hint">预览（未保存）· 点击数值可直接掷骰</span></div>';
    }
    if (!preview && me.gm && sh.kind === 'pc') {
        var players = users.filter(function(u) { return !u.gm; }).map(function(u) { return u.name; });
        if (sh.owner && players.indexOf(sh.owner) < 0) players.push(sh.owner);
        h += '<div class="lobby-row" style="gap:6px;"><span class="tt-hint">分配给</span><select class="tt-select" data-sheetowner="' + escapeHtml(sh.id) + '"><option value="">（未分配）</option>' +
            players.map(function(n) { return '<option value="' + escapeHtml(n) + '"' + (n === sh.owner ? ' selected' : '') + '>' + escapeHtml(n) + '</option>'; }).join('') +
            '</select><span class="tt-hint">关联的棋子也归他控制</span></div>';
    }
    if (preview) {
    } else if (sh.kind !== 'item' && edit) {
        h += '<div class="lobby-row" style="gap:6px;"><button class="tt-btn small" data-act="place" data-id="' + escapeHtml(sh.id) + '">放置棋子</button>' +
            (tok ? '<span class="tt-hint">正在查看棋子「' + escapeHtml(tok.label || '') + '」</span>' : '') + '</div>';
    }

    if (!preview) h += summonHeadHtml(sh, edit) + classHeadHtml(sh, edit);
    if (!preview && edit && sheetView.edit && isSummonSheet(sh)) h += summonEditHtml(sh);

    if (sh.kind === 'item') {
        if (sh.meta) h += '<div class="item-meta">' + escapeHtml(sh.meta) + '</div>';
        h += '<div class="entry-text">' + rollify(sh.text, sh.name) + '</div>';
        return h + sourceHtml(sh);
    }

    // HP（从棋子打开时显示该棋子的血量）
    var hpCur, hpMax, hpTemp = 0;
    if (tok && tok.hpMax) { hpCur = num(tok.hp, tok.hpMax); hpMax = tok.hpMax; hpTemp = num(tok.hpTemp, 0); }
    else if (sh.hp) { hpCur = num(sh.hp.cur, num(sh.hp.max, 0)); hpMax = num(sh.hp.max, 0); hpTemp = num(sh.hp.temp, 0); }
    var canHp = tok ? canEdit(tok) : edit;
    h += '<div class="stat-chips">' + chip('AC', escapeHtml(sh.ac || '')) +
        (hpMax != null ? '<div class="stat-chip hp"><span>HP</span><b>' + hpCur + ' / ' + hpMax +
            (hpTemp > 0 ? ' <span class="temp-hp">+' + hpTemp + ' 临时</span>' : '') + '</b>' +
            (canHp ? '<div><button class="tt-btn small" data-act="hp" data-delta="-5">-5</button><button class="tt-btn small" data-act="hp" data-delta="-1">-1</button>' +
                '<button class="tt-btn small" data-act="hp" data-delta="1">+1</button><button class="tt-btn small" data-act="hp" data-delta="5">+5</button></div>' +
                '<div>临时 <input class="tt-input narrow" data-temp type="number" min="0" value="' + (hpTemp || '') + '" placeholder="0" title="临时生命值：受到伤害时先扣除"></div>' : '') +
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
        h += '<div class="side-section"><h5>武器攻击</h5>' + sh.attacks.map(function(a, ai) {
            return '<div class="attack-row"><div class="name">' + escapeHtml(a.name) + '</div>' +
                (a.atk || a.damage ? '<button class="tt-btn small cast-btn" data-act="cast" data-kind="atk" data-idx="' + ai + '" title="选择目标、显示射程并自动结算命中与伤害">⚡</button>' : '') +
                (a.atk ? '<button class="roll-btn" data-d20="' + escapeHtml(a.atk) + '" data-atk="1" data-range="' + escapeHtml((a.props || '') + ' ' + (a.range || '')) +
                    '" data-label="' + escapeHtml(a.name + ' 命中') + '">命中 ' + escapeHtml(a.atk) + '</button>' : '') +
                (a.damage ? rollBtn('roll', a.damage, a.name + ' 伤害' + (a.type ? '（' + a.type + '）' : ''), a.damage + (a.type ? ' ' + a.type : '')) : '') +
                (a.props || a.mastery ? '<div class="tt-hint">' + escapeHtml([a.props, a.mastery ? '精通：' + a.mastery : ''].filter(Boolean).join(' · ')) + '</div>' : '') +
                '</div>';
        }).join('') + '</div>';
    }

    if ((sh.casting && sh.casting.length) || (sh.slots && sh.slots.length) || (sh.spells && sh.spells.length)) {
        h += '<div class="side-section"><h5>施法</h5>';
        (sh.casting || []).forEach(function(c) {
            h += '<div class="attack-row"><div class="name">' + escapeHtml(c.ability) + '</div><span class="tt-hint">DC ' + escapeHtml(c.dc) + '</span>' +
                '<button class="roll-btn" data-d20="' + escapeHtml(c.atk || '') + '" data-atk="1" data-label="' + escapeHtml(c.ability + '法术攻击') + '">法术攻击 ' +
                escapeHtml(normBonus(c.atk) || '+0') + '</button></div>';
        });
        (sh.slots || []).forEach(function(s, i) {
            h += '<div class="attack-row"><div class="name">' + escapeHtml(s.level) + '环法术位</div><b>' + escapeHtml(s.cur) + ' / ' + escapeHtml(s.max) + '</b>' +
                (edit ? '<button class="tt-btn small" data-act="slot" data-idx="' + i + '" data-delta="-1">用</button><button class="tt-btn small" data-act="slot" data-idx="' + i + '" data-delta="1">回</button>' : '') + '</div>';
        });
        if (sh.spells && sh.spells.length) {
            h += '<div class="spell-chips">' + sh.spells.map(function(s, si) {
                return '<span class="spell-pair"><button class="tt-btn small" data-act="spell" data-name="' + escapeHtml(s.name) + '" data-level="' + escapeHtml(String(s.level == null ? '' : s.level).trim()) + '" title="查看法术效果">' +
                    (s.level === '0' || s.level === 0 ? '戏法·' : s.level ? s.level + '环·' : '') + escapeHtml(s.name) + '</button>' +
                    '<button class="tt-btn small cast-btn" data-act="cast" data-kind="spell" data-idx="' + si + '" title="施放：显示范围 / 选择目标并自动结算">⚡</button></span>';
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

    h += modsHtml(sh, edit);

    (sh.sections || []).forEach(function(sec, si) {
        h += '<div class="side-section"><h5>' + escapeHtml(sec.title) + '</h5>' + sec.entries.map(function(en, ei) {
            var label = (en.name || sec.title).replace(/。$/, '');
            var multiBtn = /多重攻击|multiattack/i.test(en.name || '') ? '<button class="tt-btn small cast-btn" data-act="multi" data-sec="' + si + '" data-idx="' + ei + '" title="列出这次多重攻击要做的攻击，逐个结算">⚡</button>' : '';
            return '<div class="entry">' + (multiBtn || (!en.noCast && entryActionable(en.text) ? '<button class="tt-btn small cast-btn" data-act="cast" data-kind="entry" data-sec="' + si + '" data-idx="' + ei + '" title="选择目标、显示范围并自动结算">⚡</button>' : '')) +
                (en.name ? '<b>' + escapeHtml(en.name.replace(/。$/, '')) + '。</b>' : '') + rollify(en.text, label) + '</div>';
        }).join('') + '</div>';
    });

    if (sh.features && sh.features.length) {
        h += '<div class="side-section"><h5>特性与专长</h5>' + sh.features.map(function(f, fi) {
            return '<details class="feature"><summary>' + escapeHtml(f.name) + (entryActionable(f.text) ? ' <button class="tt-btn small cast-btn" data-act="cast" data-kind="feat" data-idx="' + fi + '" title="选择目标并自动结算">⚡</button>' : '') +
                '</summary><div class="entry-text">' + rollify(f.text, f.name) + '</div></details>';
        }).join('') + '</div>';
    }
    return h + sourceHtml(sh);
}

function sourceHtml(sh) {
    if (!sh.source) return '';
    var text = /^bestiary\//.test(sh.source)
        ? '来源：Owlbear 怪物图鉴插件（不全书翻译）· ' + sh.source.replace(/^bestiary\//, '')
        : '来源：DND5e 不全书 · ' + sh.source.replace(/^topics\//, '').replace(/\.html?$/, '');
    return '<div class="tt-hint" style="margin-top:12px;">' + escapeHtml(text) + '</div>';
}

// ===== 放置棋子 =====
function sizeCells(sh) {
    var text = (sh.size || '') + ' ' + (sh.meta || '');
    for (var i = 0; i < SIZE_CELLS.length; i++) if (text.indexOf(SIZE_CELLS[i][0]) >= 0) return SIZE_CELLS[i][1];
    return 1;
}

function placeSheetToken(sh, asset) {
    if (!sh) return;
    asset = asset || sh.tokenImg || '';
    var g = gridSize(), cells = sizeCells(sh), w = g * cells;
    var c = toWorld(canvas.clientWidth / 2, canvas.clientHeight / 2);
    var pos = snapToGrid(c.x - w / 2, c.y - w / 2);
    var same = sortedItems().filter(function(it) { return it.sheet === sh.id; }).length;
    var it = { id: genId(), kind: 'token', x: pos.x, y: pos.y, w: w, h: w, circle: true, sheet: sh.id, z: nextZ(),
        color: sh.kind === 'pc' ? '#1e88e5' : '#c62828', label: sh.name + (sh.kind !== 'pc' && same ? ' ' + (same + 1) : '') };
    if (asset) { it.asset = asset; it.circle = false; } // 怪物图鉴的头像本身就是圆形棋子图
    sheetTokenExtras(sh, it);
    if (it.fp) { it.w = it.h = it.fp * g; it.x = pos.x + (w - it.w) / 2; it.y = pos.y + (w - it.h) / 2; }
    var max = sh.hp ? num(sh.hp.max, 0) : 0;
    if (max > 0) { it.hpMax = max; it.hp = num(sh.hp.cur, max); }
    if (sh.hp && num(sh.hp.temp, 0) > 0) it.hpTemp = num(sh.hp.temp, 0);
    if (me.gm && sh.kind === 'pc' && sh.owner) it.owner = sh.owner;
    summonPlaceAdjust(sh, it);
    if (me.gm && gmPref('ttPlaceHidden', true) && !it.owner && sh.kind !== 'summon') it.hidden = true; // GM 从资料拉出来的棋子默认先对玩家隐藏（已分配给玩家的角色除外）
    var joining = me.gm && combatState() && sh.kind !== 'item' && !(sh.kind === 'summon' && sh.initMode !== 'own'); // 跟随主控的随从在主控回合行动，不自动掷先攻
    if (joining) { it.init = 0; it.initTie = Math.random(); }
    createItems([it]);
    if (joining) setTimeout(function() { rollInit([it.id]); }, 600); // 战斗中放下的单位自动掷先攻加入
    setTool('select');
    selectOnly([it.id]);
    notice('已放置「' + it.label + '」' + (it.hidden ? '（对玩家隐藏，在属性面板取消勾选「对玩家隐藏」即可公开）' : '') + '，可把资产库里的图片拖到棋子上更换头像', false, 5000);
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
    if (q) { lookup.q = q; lookup.page = null; if ($('lkQ')) $('lkQ').value = q; runLookup(); } // 图鉴页已打开时输入框里是旧词
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
    if (me.gm && (lookup.monsters || lookup.mLoading) && (lookup.filter === 'all' || lookup.filter === 'monster')) h += bestiaryHtml();
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
    var q = lookup.q;
    if (me.gm) searchBestiary(q);
    api('/api/tabletop/5e/search?q=' + enc(q), 'GET').then(function(data) {
        var results = (data.results || []).map(function(r) { return { title: r.title || r.rawTitle, path: r.path }; })
            .filter(function(r) { return r.path && /^topics\//.test(r.path) && !is2014Core(r.path); });
        if (results.length || lookup.q !== q) return results;
        // 法术没有独立页面（按环阶放在一起），标题搜不到时去法术详述里找
        return findSpell(q, '').then(function(spell) {
            if (spell && lookup.q === q) lookup.page = { path: spell.source, title: spell.name, loading: false, entries: [spell] };
            return results;
        });
    }).then(function(results) {
        lookup.loading = false;
        lookup.results = results || [];
        renderSheets();
    }).catch(function(e) { lookup.loading = false; renderSheets(); apiError(e); });
}

// ===== 判定修正（反射闪避、豁免加值 / 优势、额外抗性免疫、状态免疫、额外 AC）=====
// 服务器结算行动时用（backend/tabletop_traits.go）：角色卡上按名字自动识别的特性 + 这里手动加的修正 + 狂暴 / 石化等状态。
// AUTO_TRAITS 要和 tabletop_traits.go 的 ttAutoTraits 保持一致（这里只用来显示）。
var MOD_TYPES = { evasion: '反射闪避', save: '豁免加值', saveAdv: '豁免优势', resist: '伤害抗性', immune: '伤害免疫', vuln: '伤害易伤', condImmune: '状态免疫', ac: '额外 AC' };
var MOD_FIELDS = { evasion: [], save: ['ab', 'v'], saveAdv: ['ab', 'vs'], resist: ['dt', 'nm'], immune: ['dt', 'nm'], vuln: ['dt'], condImmune: ['id'], ac: ['v'] };
var SPELL_SCHOOLS = ['防护', '咒法', '预言', '附魔', '塑能', '幻术', '死灵', '变化'];
var COND_IDS = ['blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'grappled', 'incapacitated', 'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious'];
var COND_CN = { '目盲': 'blinded', '魅惑': 'charmed', '耳聋': 'deafened', '力竭': 'exhaustion', '恐慌': 'frightened', '恐惧': 'frightened', '受擒': 'grappled', '擒抱': 'grappled',
    '失能': 'incapacitated', '隐形': 'invisible', '麻痹': 'paralyzed', '石化': 'petrified', '中毒': 'poisoned', '倒地': 'prone', '束缚': 'restrained', '震慑': 'stunned', '昏迷': 'unconscious' };
var AUTO_TRAITS = [
    { names: ['反射闪避', '引导闪避', 'evasion', 'leadingevasion'], skip: ['戒指', 'ring'], desc: '敏捷豁免的半伤效果：成功不受伤害，失败只受一半（失能时无效）' },
    { names: ['闪避'], exact: true, desc: '敏捷豁免的半伤效果：成功不受伤害，失败只受一半（失能时无效）' },
    { names: ['侏儒魔法抗性', '侏儒狡黠', 'gnomishcunning', 'gnomishmagicresistance'], desc: '智力、感知、魅力豁免优势（正文写了「对抗魔法」等就只在那时）', scope: true },
    { names: ['魔法抗性', 'magicresistance'], skip: ['侏儒', 'gnomish'], desc: '豁免优势，按正文识别范围（默认：对抗法术和魔法效应）', scope: true },
    { names: ['危机感应', 'dangersense'], desc: '敏捷豁免优势（失能时无效）' },
    { names: ['矮人体魄', '矮人抗性', '矮人韧性', 'dwarvenresilience'], desc: '毒素抗性；避免中毒的豁免优势' },
    { names: ['妖精血统', '精类血统', 'feyancestry'], desc: '避免魅惑的豁免优势' },
    { names: ['勇气', 'brave'], exact: true, desc: '避免恐慌的豁免优势' },
    { names: ['勇气灵光', '勇气光环', 'auraofcourage'], desc: '免疫恐慌' },
    { names: ['守护灵光', '守护光环', 'auraofprotection'], desc: '自己的豁免 + 魅力调整值（至少 +1）' },
    { names: ['传奇抗性', 'legendaryresistance'], desc: '豁免失败时提示可用传奇抗性' }
];

function traitKey(name) {
    return String(name || '').replace(/[（(\[【].*?[）)\]】]|[\s·・。．.，,：:0-9\/／]+/g, '').toLowerCase();
}
function traitMatch(key, names, exact) {
    return (names || []).some(function(n) {
        if (exact) return key === n || key.replace(/[\x00-\x7f]+$/, '') === n;
        return key.indexOf(n) >= 0;
    });
}

// 自动识别：[{name, desc, off, fixed}]
function autoMods(sh) {
    var out = [], names = [];
    (sh.features || []).forEach(function(f) { if (f.name) names.push(f.name); });
    (sh.sections || []).forEach(function(sec) { (sec.entries || []).forEach(function(e) { if (e.name) names.push(e.name); }); });
    var off = {};
    (sh.modsOff || []).forEach(function(n) { off[traitKey(n)] = true; });
    names.forEach(function(n) {
        var key = traitKey(n);
        AUTO_TRAITS.forEach(function(r) {
            if (traitMatch(key, r.names, r.exact) && !traitMatch(key, r.skip, false))
                out.push({ name: n.replace(/。$/, '').trim(), desc: r.desc, off: !!off[key] });
        });
    });
    (sh.props || []).forEach(function(p) {
        var label = p.label || '', value = p.value || '';
        if (label.indexOf('免疫') >= 0) {
            var cs = Object.keys(COND_CN).filter(function(cn) { return value.indexOf(cn) >= 0; });
            if (cs.length) out.push({ name: '免疫栏', desc: '状态免疫：' + cs.join('、'), fixed: true });
        } else if (label === '优势') {
            value.split(/[、，,；;]/).forEach(function(part) {
                if (part.indexOf('豁免') >= 0) out.push({ name: '优势栏', desc: part.trim(), fixed: true });
            });
        }
    });
    return out;
}

function modDesc(m) {
    var ab = m.ab && ABILITY_NAMES[m.ab] ? ABILITY_NAMES[m.ab] : '所有';
    var cond = function(id) { return (STATUS_BY_ID[id] || {}).name || id; };
    switch (m.t) {
    case 'evasion': return '反射闪避';
    case 'save': return ab + '豁免 ' + (m.v >= 0 ? '+' : '') + m.v;
    case 'saveAdv': return ab + '豁免优势' + (m.vs === 'spell' ? '（对抗法术）' : m.vs === 'magic' ? '（对抗法术和魔法效应）' :
        /^school:/.test(m.vs || '') ? '（对抗' + m.vs.slice(7) + '学派法术）' : m.vs ? '（避免' + cond(m.vs) + '）' : '');
    case 'resist': case 'immune': case 'vuln': return (m.nm ? '非魔法' : '') + (m.dt || '?') + MOD_TYPES[m.t].replace('伤害', '');
    case 'condImmune': return '免疫' + cond(m.id);
    case 'ac': return 'AC ' + (m.v >= 0 ? '+' : '') + m.v;
    }
    return m.t;
}

function modsHtml(sh, edit) {
    var auto = autoMods(sh), mods = Array.isArray(sh.mods) ? sh.mods : [];
    if (!auto.length && !mods.length && !edit) return '';
    var h = '<div class="side-section mods-box"><h5>判定修正 <span class="tt-hint">结算攻击 / 豁免 / 伤害时自动生效，日志里会注明</span></h5>';
    auto.forEach(function(m) {
        h += '<div class="mod-row' + (m.off ? ' off' : '') + '"><span class="mod-tag auto">自动</span><b>' + escapeHtml(m.name) + '</b> <span class="tt-hint">' + escapeHtml(m.desc) + '</span>' +
            (edit && !m.fixed ? '<button class="tt-btn small" data-act="' + (m.off ? 'modon' : 'modoff') + '" data-name="' + escapeHtml(m.name) + '" title="' +
                (m.off ? '重新启用' : '停用（角色卡上的数值已经算进去了 / 识别错了）') + '">' + (m.off ? '启用' : '停用') + '</button>' : '') + '</div>';
    });
    mods.forEach(function(m, i) {
        h += '<div class="mod-row"><span class="mod-tag">手动</span><b>' + escapeHtml(modDesc(m)) + '</b>' + (m.name ? ' <span class="tt-hint">' + escapeHtml(m.name) + '</span>' : '') +
            (edit ? '<button class="tt-btn small" data-act="moddel" data-idx="' + i + '" title="删除">✕</button>' : '') + '</div>';
    });
    if (edit) {
        var abOpts = '<option value="">所有</option>' + Object.keys(ABILITY_NAMES).map(function(k) { return '<option value="' + k + '">' + ABILITY_NAMES[k] + '</option>'; }).join('');
        var condName = function(id) { return escapeHtml((STATUS_BY_ID[id] || {}).name || id); };
        var dts = ['物理', '全部'].concat(DMG_TYPES.split('|').filter(function(d, i, arr) { return d !== '暗蚀' && arr.indexOf(d) === i; }));
        h += '<div class="mod-form" id="mdForm"><select class="tt-select" id="mdT">' + Object.keys(MOD_TYPES).map(function(k) { return '<option value="' + k + '">' + MOD_TYPES[k] + '</option>'; }).join('') + '</select>' +
            '<select class="tt-select" id="mdAb" data-f="ab" title="哪个属性的豁免" style="display:none">' + abOpts + '</select>' +
            '<select class="tt-select" id="mdVs" data-f="vs" title="什么时候有优势" style="display:none"><option value="">总是</option><option value="spell">对抗法术</option><option value="magic">对抗法术和魔法效应</option>' +
                SPELL_SCHOOLS.map(function(s) { return '<option value="school:' + s + '">对抗' + s + '学派法术</option>'; }).join('') +
                COND_IDS.map(function(id) { return '<option value="' + id + '">避免' + condName(id) + '</option>'; }).join('') + '</select>' +
            '<input class="tt-input narrow" id="mdV" data-f="v" type="number" min="-10" max="10" value="1" title="加值" style="display:none">' +
            '<select class="tt-select" id="mdDt" data-f="dt" title="伤害类型（物理 = 钝击、穿刺、挥砍）" style="display:none">' + dts.map(function(d) { return '<option>' + d + '</option>'; }).join('') + '</select>' +
            '<label data-f="nm" style="display:none" title="只对非魔法攻击有效（如「非魔法攻击造成的钝击、穿刺、挥砍伤害」）"><input type="checkbox" id="mdNm"> 仅非魔法</label>' +
            '<select class="tt-select" id="mdId" data-f="id" style="display:none">' + COND_IDS.map(function(id) { return '<option value="' + id + '">' + condName(id) + '</option>'; }).join('') + '</select>' +
            '<input class="tt-input" id="mdName" placeholder="来源（如 防护斗篷）" maxlength="20">' +
            '<button class="tt-btn small primary" data-act="modadd">添加</button></div>' +
            '<div class="tt-hint">装备 / 天赋 / 法术给的修正：只加角色卡数值里还没算进去的（比如人物卡的豁免已经含防护斗篷 +1，就别再加）</div>';
    }
    return h + '</div>';
}

function syncModForm() {
    var t = $('mdT'), form = $('mdForm');
    if (!t || !form) return;
    var need = MOD_FIELDS[t.value] || [];
    form.querySelectorAll('[data-f]').forEach(function(el) { el.style.display = need.indexOf(el.dataset.f) >= 0 ? '' : 'none'; });
}

function saveSheetMods(sh, mods, modsOff) {
    var upd = { id: sh.id };
    if (mods) { sh.mods = mods; upd.mods = mods.length ? mods : null; }
    if (modsOff) { sh.modsOff = modsOff; upd.modsOff = modsOff.length ? modsOff : null; }
    op({ op: 'sheet', sheet: upd });
    renderSheets();
}

function addSheetMod(sh) {
    if (!sh || !canEditSheet(sh) || !$('mdT')) return;
    var t = $('mdT').value, m = { t: t }, need = MOD_FIELDS[t] || [];
    if (need.indexOf('ab') >= 0 && $('mdAb').value) m.ab = $('mdAb').value;
    if (need.indexOf('vs') >= 0 && $('mdVs').value) m.vs = $('mdVs').value;
    if (need.indexOf('v') >= 0) {
        m.v = Math.max(-10, Math.min(10, parseInt($('mdV').value, 10) || 0));
        if (!m.v) { notice('加值不能是 0', true); return; }
    }
    if (need.indexOf('dt') >= 0) m.dt = $('mdDt').value;
    if (need.indexOf('nm') >= 0 && $('mdNm').checked) m.nm = true;
    if (need.indexOf('id') >= 0) m.id = $('mdId').value;
    var name = $('mdName').value.trim().slice(0, 20);
    if (name) m.name = name;
    var list = (Array.isArray(sh.mods) ? sh.mods : []).slice(0, 29);
    list.push(m);
    saveSheetMods(sh, list);
}

function delSheetMod(sh, idx) {
    if (!sh || !canEditSheet(sh) || !Array.isArray(sh.mods)) return;
    var list = sh.mods.slice();
    list.splice(idx, 1);
    saveSheetMods(sh, list);
}

function toggleAutoMod(sh, name, off) {
    if (!sh || !canEditSheet(sh) || !name) return;
    var key = traitKey(name);
    var list = (Array.isArray(sh.modsOff) ? sh.modsOff : []).filter(function(n) { return traitKey(n) !== key; });
    if (off) list.push(name);
    saveSheetMods(sh, null, list);
}

// ===== 怪物一键部署（5e.kiwee.top 中文 5etools，Owlbear 怪物图鉴插件同款数据）=====
// 搜到后点「部署」：服务器把怪物转成怪物卡、下载棋子头像和立绘存进房间，棋子放到镜头中心（GM 默认对玩家隐藏）
function searchBestiary(q) {
    lookup.mLoading = true;
    api('/api/tabletop/5e/bestiary?q=' + enc(q), 'GET').then(function(data) {
        if (lookup.q !== q) return;
        lookup.mLoading = false;
        lookup.monsters = data.results || [];
        lookup.mMore = !!data.loading;
        renderSheets();
    }).catch(function() { lookup.mLoading = false; lookup.monsters = []; renderSheets(); });
}

function bestiaryHtml() {
    var h = '<div class="side-section bestiary-box"><h5>👹 怪物（一键部署到镜头中心' + (gmPref('ttPlaceHidden', true) ? '，默认对玩家隐藏' : '') + '）</h5>';
    if (lookup.mLoading) return h + '<div class="tt-hint">正在查找怪物…</div></div>';
    var list = lookup.monsters || [];
    if (!list.length) h += '<div class="tt-hint">怪物图鉴里没有找到' + (lookup.mMore ? '（其他书目还在后台加载，稍后再搜一次）' : '') + '</div>';
    h += list.slice(0, 12).map(function(m) {
        var own = Object.keys(sheets).map(function(id) { return sheets[id]; }).filter(function(s) { return s.source === 'bestiary/' + m.key; })[0];
        return '<div class="sheet-row"><div class="info"><div class="name">' + escapeHtml(m.name) + (m.en && m.en !== m.name ? ' <span class="tt-hint">' + escapeHtml(m.en) + '</span>' : '') + '</div>' +
            '<div class="sub">' + escapeHtml([m.size, m.type, m.cr ? 'CR ' + m.cr : '', m.source].filter(Boolean).join(' · ')) + (m.token ? ' · 有头像' : '') + (m.art ? ' · 有立绘' : '') +
            (own ? ' · 房间里已有怪物卡' : '') + '</div></div>' +
            '<button class="tt-btn small primary" data-act="deploy" data-key="' + escapeHtml(m.key) + '" data-art="' + (m.art ? 1 : 0) + '" title="放到当前镜头中心' + (own ? '（沿用房间里已有的怪物卡）' : '') + '">部署</button></div>';
    }).join('');
    if (list.length > 12) h += '<div class="tt-hint">还有 ' + (list.length - 12) + ' 个结果，输入更完整的名字缩小范围</div>';
    if (lookup.mMore && list.length) h += '<div class="tt-hint">其他书目还在后台加载，结果可能不全</div>';
    return h + '</div>';
}

function deployMonster(key, btn) {
    if (!me.gm || !key) return;
    // 房间里已有这只怪的卡：直接再放一个棋子（不重复下载、不重复建卡）
    var own = Object.keys(sheets).map(function(id) { return sheets[id]; }).filter(function(s) { return s.source === 'bestiary/' + key; })[0];
    if (own && own.tokenImg && (own.portrait || !btn || btn.dataset.art !== '1')) { placeSheetToken(own); return; }
    if (btn) { btn.disabled = true; btn.textContent = '部署中…'; }
    api('/api/tabletop/5e/deploy?room=' + enc(roomId), 'POST', { key: key }).then(function(data) {
        var sh = data.sheet;
        if (!sh) throw new Error('没有拿到怪物数据');
        if (own) { // 旧卡没有头像 / 立绘：补上
            var upd = { id: own.id };
            if (data.token) upd.tokenImg = data.token;
            if (data.art && !own.portrait) upd.portrait = data.art;
            op({ op: 'sheet', sheet: upd });
            own.tokenImg = data.token || own.tokenImg; if (data.art && !own.portrait) own.portrait = data.art;
            placeSheetToken(own, data.token);
            return;
        }
        sh.id = genId();
        return op({ op: 'sheet', sheet: sh }).then(function(ok) {
            if (!ok) return;
            if (!sheets[sh.id]) sheets[sh.id] = sh; // 等服务器回显前先用
            placeSheetToken(sheets[sh.id], data.token);
            renderSheets();
        });
    }).catch(apiError).then(function() { if (btn) { btn.disabled = false; btn.textContent = '部署'; } });
}

// ===== 法术 =====
// 不全书里法术按环阶整页存放（<H4>疗伤术｜Cure Wounds</H4>）。规则统一按 2024 版：先查 2024 玩家手册，
// 2024 版没有收录的法术再查 XGE、TCE；不查 2014 玩家手册
var SPELL_SOURCES = [
    function(l) { return 'topics/玩家手册2024/法术详述/' + l + '环.htm'; },
    function(l) { return 'topics/珊娜萨的万事指南/法术/法术详述/' + (l === 0 ? '戏法' : l + '环') + '.html'; },
    function(l) { return 'topics/塔莎的万事坩埚/法术/法术详述/' + (l === 0 ? '戏法' : l + '环') + '.html'; }
];
// 2014 版核心三书（不带年份的目录）：搜索结果里不显示
function is2014Core(path) { return /^topics\/(玩家手册|怪物图鉴|城主指南)\//.test(path || ''); }
var pageEntryCache = {};

function fetch5eHtml(path) {
    return fetch('/api/tabletop/5e/page?path=' + enc(path), { headers: { 'Authorization': 'Bearer ' + authToken } }).then(function(r) {
        if (!r.ok) return r.json().then(function(d) { throw d.error || '获取失败'; });
        return r.text();
    });
}

function spellEntries(path) {
    if (!pageEntryCache[path]) {
        pageEntryCache[path] = fetch5eHtml(path).then(function(html) {
            return parseItems(new DOMParser().parseFromString(html, 'text/html'), path);
        }).catch(function() { delete pageEntryCache[path]; return []; });
    }
    return pageEntryCache[path];
}

function spellKey(s) { return String(s || '').replace(/[\s｜|·・]/g, '').toLowerCase(); }

// 人物卡里的译名常和不全书略有出入（弹射 / 弹射术，塔莎腐蚀酿 / 塔莎酸蚀酿）：
// 一方包含另一方，或等长且只差一个字，都算近似匹配
function spellNear(a, b) {
    if (a.length < 2 || b.length < 2) return false;
    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
    if (a.length !== b.length || a.length < 3) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) if (a.charAt(i) !== b.charAt(i)) diff++;
    return diff <= 1;
}

// level 已知时只查对应环阶页（角色卡里有），未知时查 0-9 环；先找完全同名，再找近似名
function findSpell(name, level) {
    var key = spellKey(name), lv = parseInt(level, 10);
    if (!key) return Promise.resolve(null);
    var levels = lv >= 0 && lv <= 9 ? [lv] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    var seen = [];
    var scan = function(test) {
        for (var i = 0; i < seen.length; i++) if (test(seen[i])) return seen[i];
        return null;
    };
    var exact = function(e) { return spellKey(e.name) === key || spellKey(e.en) === key; };
    return SPELL_SOURCES.reduce(function(prev, src) {
        return prev.then(function(found) {
            if (found) return found;
            return Promise.all(levels.map(function(l) { return spellEntries(src(l)); })).then(function(pages) {
                pages.forEach(function(list) { seen = seen.concat(list); });
                return scan(exact);
            });
        });
    }, Promise.resolve(null)).then(function(found) {
        return found || scan(function(e) { return spellNear(spellKey(e.name), key); });
    });
}

function openSpell(name, level) {
    var back = { mode: sheetView.mode, id: sheetView.id, tokenId: sheetView.tokenId, back: sheetView.back };
    sheetView = { mode: 'preview', tmp: { kind: 'item', name: name, meta: '', text: '正在查找法术…' }, back: back };
    switchPane('sheets');
    renderSheets();
    findSpell(name, level).then(function(spell) {
        if (sheetView.mode !== 'preview' || sheetView.tmp.name !== name) return;
        if (spell) {
            sheetView.tmp = spell;
            renderSheets();
        } else {
            notice('不全书法术详述里没找到「' + name + '」，改为全文搜索', true);
            openLookup(name);
        }
    });
}

function loadLookupPage(path, title) {
    lookup.page = { path: path, title: title, loading: true, entries: [] };
    renderSheets();
    fetch5eHtml(path).then(function(html) {
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
        if (lines.length && /(普通|珍稀|稀有|传说|神器|同调|多种稀有度|药水|武器|护甲|戒指|法杖|权杖|魔杖|奇物|卷轴|[一二三四五六七八九]环|戏法)/.test(lines[0]) && lines[0].length < 80) meta = lines.shift();
        var cn = (cnName(name) || name).replace(/[｜|\s]+$/, '');
        return { kind: 'item', name: cn, en: name.replace(cnName(name), '').replace(/^[｜|\s]+/, '').trim(), meta: meta, text: lines.join('\n').trim(), source: path };
    }).filter(function(it) { return it.name && it.text; });
}

function initSheets() {
    $('sheetPane').addEventListener('click', onSheetPaneClick);
    $('sheetPane').addEventListener('change', function(e) {
        if (e.target.dataset.temp != null) setTempHp(currentSheet(), e.target.value);
        if (e.target.id === 'mdT') syncModForm();
    });
    $('sheetPane').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && e.target.id === 'lkQ') runLookup();
    });
    renderSheets();
}
