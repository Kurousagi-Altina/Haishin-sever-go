// 跑团桌面：战斗提示（规则见 docs/战斗规则.md）。原则：只提示、不强制，每类都能在设置里关掉。
// 1. 动作经济：先攻条上显示当前行动者的 动作 / 附赠 / 反应，结算行动时按「消耗」自动勾选
// 2. 借机攻击：拖动棋子离开敌人的触及范围时提示，一键用对方的近战攻击结算
// 3. 专注豁免、状态的回合结束豁免 / 回合开始伤害：记录里一键掷 / 结算
// 4. 传奇动作 / 传奇抗性 / 充能（服务器在回合开始 / 结束时处理，这里是按钮）
// 5. 多重攻击：怪物卡上一键列出这次要做的攻击

function hintOn(key) { return roomSetting(key, true) !== false; }

// ===================== 1. 动作经济 =====================
var ECON = [['a', '动作'], ['b', '附赠'], ['r', '反应']];

function econHudHtml(cur) {
    if (!hintOn('hintEcon') || !cur || !isCreatureToken(cur)) return '';
    var e = cur.econ || {}, edit = canEdit(cur);
    return '<span class="hud-econ">' + ECON.map(function(k) {
        return '<i class="econ' + (e[k[0]] ? ' used' : '') + (edit ? ' click' : '') + '"' + (edit ? ' data-econ="' + k[0] + '"' : '') +
            ' title="' + k[1] + (e[k[0]] ? '：已用（点击取消）' : '：可用（点击标记为已用）') + '">' + k[1] + '</i>';
    }).join('') + '</span>';
}

function toggleEcon(key) {
    var c = combatState(), cur = c && scene.items[c.turn];
    if (!cur || !canEdit(cur)) return;
    var e = JSON.parse(JSON.stringify(cur.econ || {}));
    if (e[key]) delete e[key]; else e[key] = true;
    patchItems([{ id: cur.id, econ: Object.keys(e).length ? e : null }]);
    renderCombatHud();
}

// 从说明文字判断行动消耗：附赠动作 / 反应 / 动作
function guessCost(a, text) {
    var t = String(text || '') + ' ' + (a.castTime || '');
    if (/施法时间[：:]?\s*1?\s*个?\s*附赠动作|附赠动作/.test(t) && !/作为[^。]{0,8}动作的一部分/.test(t)) return 'b';
    if (/施法时间[：:]?\s*1?\s*个?\s*反应|以反应|用反应|作为反应/.test(t)) return 'r';
    return 'a';
}

// 行动结算后：给施放者记上消耗；一回合只能用法术位施放一个法术（2024）
function econAfterAction(a, caster) {
    if (!hintOn('hintEcon') || !caster || !canEdit(caster) || !combatState() || !inInit(caster)) return;
    var cost = a.cost || 'a';
    var e = JSON.parse(JSON.stringify(caster.econ || {}));
    if (cost !== 'n') e[cost] = true;
    if (a.useSlot && a.slotLevel > 0) {
        if (e.slot) notice('2024 规则：一回合只能用法术位施放一个法术（戏法不受限）。这次照样结算了，请 GM 斟酌', true, 6000);
        e.slot = true;
    }
    patchItems([{ id: caster.id, econ: e }]);
}

// ===================== 2. 借机攻击 =====================
function tokenSide(t) { return t.side || (t.owner ? 'ally' : 'enemy'); }

function canReact(t) {
    if (hasStatus(t, 'dead') || (t.hpMax > 0 && num(t.hp, t.hpMax) <= 0)) return false;
    if (['incapacitated', 'paralyzed', 'stunned', 'unconscious', 'petrified'].some(function(id) { return hasStatus(t, id); })) return false;
    return !(t.econ && t.econ.r);
}

// 近战触及：棋子属性里填的 > 角色卡 / 怪物卡上近战攻击写的触及 > 5 尺
function meleeReach(t) {
    if (num(t.reach, 0) > 0) return num(t.reach, 0);
    var sh = t.sheet && sheets[t.sheet], best = 0;
    if (sh) {
        (sh.attacks || []).forEach(function(at) {
            var r = parseAttackRange((at.props || '') + ' ' + (at.range || ''));
            if (r.reach && !r.normal) best = Math.max(best, r.reach);
        });
        (sh.sections || []).forEach(function(sec) {
            (sec.entries || []).forEach(function(en) {
                var m = /近战/.test(en.text || '') && String(en.text).match(/触及\s*(\d+)\s*尺/);
                if (m) best = Math.max(best, +m[1]);
            });
        });
    }
    return best || 5;
}

function noOA(t) {
    var sh = t.sheet && sheets[t.sheet];
    return hasStatus(t, 'disengaged') || (sh && sheetHasEntry(sh, /飞掠|flyby/i));
}

// 一次拖动结束：按实际路线检查有没有离开某个敌人的触及范围
function oaCheckMove(id, orig, trail) {
    if (!hintOn('hintOA') || !combatState()) return;
    var t = scene.items[id];
    if (!t || t.kind !== 'token' || !isCreatureToken(t) || noOA(t) || tokenSide(t) === 'neutral') return;
    var g = gridSize(), hw = (t.w || g) / 2, hh = (t.h || g) / 2;
    var pts = [{ x: orig.x + hw, y: orig.y + hh }];
    (trail || []).forEach(function(p) { pts.push({ x: orig.x + hw + p.x, y: orig.y + hh + p.y }); });
    pts.push({ x: t.x + hw, y: t.y + hh });
    if (Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1 && pts.length < 3) return;
    var side = tokenSide(t), invisible = hasStatus(t, 'invisible') || hasStatus(t, 'hidden');
    sortedItems().forEach(function(en) {
        if (en.kind !== 'token' || en.id === t.id || !isCreatureToken(en) || !canReact(en) || invisible) return;
        var es = tokenSide(en);
        if (es === 'neutral' || es === side) return;
        var reach = meleeReach(en), inside = false, left = false;
        for (var i = 0; i < pts.length && !left; i++) {
            var d = creatureDist(en, t, null, pts[i]);
            if (d <= reach) inside = true;
            else if (inside) left = true;
        }
        if (left) op({ op: 'oa.hint', ids: [en.id, t.id] });
    });
}

// 借机攻击者的近战攻击：角色卡的近战武器 / 怪物卡「动作」里第一个近战攻击
function meleeAttackOf(en) {
    var sh = en.sheet && sheets[en.sheet];
    if (!sh) return null;
    var atk = null;
    (sh.attacks || []).some(function(at, i) {
        var r = parseAttackRange((at.props || '') + ' ' + (at.range || ''));
        if (r.reach && !r.normal) { atk = { kind: 'atk', idx: i }; return true; }
        return false;
    });
    if (atk) return atk;
    (sh.sections || []).some(function(sec, si) {
        return (sec.entries || []).some(function(e, ei) {
            if (/近战/.test(e.text || '') && /攻击检定|命中/.test(e.text || '')) { atk = { kind: 'entry', sec: si, idx: ei }; return true; }
            return false;
        });
    });
    if (atk) return atk;
    if (sh.attacks && sh.attacks.length) return { kind: 'atk', idx: 0 };
    return null;
}

function startOA(enemyId, moverId) {
    var en = scene.items[enemyId];
    if (!en) { notice('借机攻击者不在当前场景', true); return; }
    var sh = en.sheet && sheets[en.sheet], src = meleeAttackOf(en);
    if (sh && src) castFromSheet(sh, { kind: src.kind, idx: String(src.idx), sec: String(src.sec) });
    else openActionDialog({ name: '借机攻击', kind: 'attack', attack: '+0', area: { shape: '', size: 0, width: 5 }, targets: 1, reach: meleeReach(en) }, en, null);
    if (!act) return;
    act.caster = en;
    $('acCaster').textContent = en.label || '未命名棋子';
    act.a.cost = 'r';
    act.a.name = (act.a.name || '攻击') + '（借机）';
    $('acName').value = act.a.name;
    if ($('acCost')) $('acCost').value = 'r';
    act.presetTargets = scene.items[moverId] ? [moverId] : [];
}

// ===================== 3/4. 记录里的按钮 =====================
// 系统提示（借机、回合效果、传奇动作）后面的按钮
function fightLogBtns(e) {
    if (!e.ref) return '';
    var p = e.ref.split(':');
    var mine = function(id) { var t = scene.items[id]; return t && (me.gm || (t.owner && t.owner === me.name)); };
    if (p[0] === 'oa' && mine(p[1])) return ' <button class="tt-btn small primary" data-oa="' + escapeHtml(p[1] + ':' + p[2]) + '">⚔ 借机攻击</button>' +
        '<button class="tt-btn small" data-trigfocus="' + escapeHtml(p[2]) + '">定位</button>';
    if (p[0] === 'ssave' && mine(p[1])) return ' <button class="tt-btn small primary" data-ssave="' + escapeHtml(p[1]) + '" data-st="' + escapeHtml(p.slice(2).join(':')) + '">🎲 豁免</button>';
    if (p[0] === 'dot' && mine(p[1])) return ' <button class="tt-btn small primary" data-dot="' + escapeHtml(p[1]) + '" data-st="' + escapeHtml(p.slice(2).join(':')) + '">🔥 结算伤害</button>';
    if (p[0] === 'la' && me.gm) return ' ' + p[1].split(',').map(function(id) {
        var t = scene.items[id];
        return t ? '<button class="tt-btn small" data-lause="' + escapeHtml(id) + '" title="扣一次传奇动作并打开怪物卡">' + escapeHtml(chipName(t.label)) + ' 用一次</button>' : '';
    }).join('');
    return '';
}

// 行动记录里每个目标后面的按钮：专注豁免、传奇抗性
function fightTargetBtns(e, t, r) {
    if (!t.id || !e.id) return '';
    var tok = scene.items[t.id];
    if (!tok || !(me.gm || (tok.owner && tok.owner === me.name))) return '';
    var h = '', m = String(t.note || '').match(/(?:需专注豁免|专注豁免改为) DC (\d+)/);
    if (m && hasStatus(tok, 'concentration') && !logEntries.some(function(x) { return x.ref === 'conc:' + e.id + ':' + t.id; }))
        h += '<button class="tt-btn small react-btn" data-concsave="' + escapeHtml(t.id) + '" data-dc="' + m[1] + '" data-log="' + escapeHtml(e.id) + '" title="由服务器掷体质豁免，失败自动结束专注">🎲 专注豁免</button>';
    if (me.gm && r.kind === 'save' && t.saved === 'no') {
        var lr = (tok.res || []).filter(function(x) { return x.lr || x.name === '传奇抗性'; })[0];
        if (lr && num(lr.cur, 0) > 0 && !logEntries.some(function(x) { return x.ref === e.id + ':' + t.id; }))
            h += '<button class="tt-btn small react-btn" data-react="legendary" data-log="' + escapeHtml(e.id) + '" data-tok="' + escapeHtml(t.id) +
                '" data-react-ref="' + escapeHtml(e.id + ':' + t.id) + '" title="扣一次传奇抗性，把这次豁免改为成功并重新结算伤害和状态">传奇抗性（剩 ' + num(lr.cur, 0) + '）</button>';
    }
    return h;
}

function fightLogClick(el) {
    var d = el.dataset;
    if (d.oa) { var p = d.oa.split(':'); startOA(p[0], p[1]); return true; }
    if (d.ssave) { op({ op: 'fight.save', ids: [d.ssave], mode: 'status', text: d.st }); el.disabled = true; return true; }
    if (d.dot) { op({ op: 'fight.dot', ids: [d.dot], text: d.st }); el.disabled = true; return true; }
    if (d.concsave) { op({ op: 'fight.save', ids: [d.concsave], mode: 'conc', dc: parseInt(d.dc, 10) || 10, text: d.log || '' }); el.remove(); return true; }
    if (d.lause) {
        var t = scene.items[d.lause];
        if (!t) return true;
        var res = JSON.parse(JSON.stringify(t.res || [])), r = res.filter(function(x) { return x.la || x.name === '传奇动作'; })[0];
        if (!r || num(r.cur, 0) <= 0) { notice('传奇动作已经用完了', true); return true; }
        r.cur = num(r.cur, 0) - 1;
        patchItems([{ id: t.id, res: res }]);
        notice(t.label + '：传奇动作剩 ' + r.cur + '/' + r.max);
        if (t.sheet && sheets[t.sheet]) openSheet(t.sheet, t.id);
        return true;
    }
    return false;
}

// ===================== 状态的回合效果设置 =====================
var ABIL_CN = { str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力' };
var ABIL_BY_CN = { '力量': 'str', '敏捷': 'dex', '体质': 'con', '智力': 'int', '感知': 'wis', '魅力': 'cha' };

function statusTimerText(s) {
    var p = [];
    if (s.save) p.push((s.save.when === 'start' ? '开始' : '结束') + '豁免 ' + (ABIL_CN[s.save.ab] || '') + ' ' + s.save.dc);
    if (s.dot) p.push((s.dot.when === 'end' ? '结束' : '开始') + '伤害 ' + s.dot.dice + (s.dot.type ? ' ' + s.dot.type : ''));
    return p.join('，');
}

function editStatusTimer(it, i) {
    var list = JSON.parse(JSON.stringify(statusList(it))), s = list[i];
    if (!s) return;
    var cur = [s.save ? (ABIL_CN[s.save.ab] || '') + ' ' + s.save.dc + (s.save.when === 'start' ? ' 开始' : '') : '',
        s.dot ? s.dot.dice + ' ' + (s.dot.type || '') + (s.dot.when === 'end' ? ' 结束' : '') : ''].filter(Boolean).join('；');
    var v = prompt('「' + (s.name || '状态') + '」的回合效果（用分号隔开，留空 = 清除）：\n' +
        '· 回合结束时重复豁免：如「感知 15」（加「开始」改为回合开始时）\n' +
        '· 回合开始时受到伤害：如「1d6 火焰」（加「结束」改为回合结束时）', cur);
    if (v == null) return;
    delete s.save; delete s.dot;
    String(v).split(/[；;]/).forEach(function(part) {
        part = part.trim();
        if (!part) return;
        var m = part.match(/(力量|敏捷|体质|智力|感知|魅力)\s*(?:豁免)?\s*(?:DC)?\s*(\d+)/i);
        if (m) { s.save = { ab: ABIL_BY_CN[m[1]], dc: +m[2], when: /开始/.test(part) ? 'start' : 'end' }; return; }
        var d = part.match(/(\d*d\d+(?:\s*[+\-]\s*\d+)?)\s*([^\s开始结束]*)/i);
        if (d) s.dot = { dice: d[1].replace(/\s/g, ''), type: (d[2] || '').replace(/伤害$/, ''), when: /结束/.test(part) ? 'end' : 'start' };
    });
    patchItems([{ id: it.id, status: list }]);
    $('selPanel').dataset.ids = '';
    renderSelPanel();
}

// 行动框：从说明里认出「每个回合结束时重复豁免」「每个回合开始时受到 XdY 伤害」
function parseTurnEffects(a, text) {
    var t = String(text || '');
    if (/回合结束时[^。]{0,24}(?:重复|再次|再进行)[^。]{0,8}豁免|在其每个回合结束时[^。]{0,16}豁免/.test(t)) a.repeatSave = true;
    var m = t.match(new RegExp('回合开始时[^。]{0,20}?(\\d+d\\d+(?:\\s*[+＋]\\s*\\d+)?)\\s*点?\\s*(' + DMG_TYPES + ')?\\s*伤害'));
    if (m) a.dot = m[1].replace(/\s|＋/g, function(c) { return c === '＋' ? '+' : ''; }) + (m[2] ? ' ' + m[2] : '');
}

// 附加到目标身上的状态：带上回合效果
function statusWithTurnEffects(st, a) {
    if (!st) return st;
    if (a.repeatSave && a.kind === 'save' && a.save && a.dc) st.save = { ab: a.save, dc: a.dc, when: 'end' };
    var d = String(a.dot || '').trim().match(/^(\d*d\d+(?:[+\-]\d+)?)\s*(\S*)/i);
    if (d) st.dot = { dice: d[1], type: (d[2] || '').replace(/伤害$/, ''), when: 'start' };
    return st;
}

// ===================== 5. 多重攻击 =====================
var CN_COUNT = { '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
var multi = null;

// 名字前面最近的「X 次」：「一次啮咬和两次爪击」里爪击是 2 次
function countBefore(text, at) {
    var before = text.slice(Math.max(0, at - 8), at), re = /([一两二三四五六\d])\s*次/g, m, last = null;
    while ((m = re.exec(before))) last = m;
    if (!last || /[，。；、和与及]/.test(before.slice(last.index + last[0].length))) return 1;
    return CN_COUNT[last[1]] || parseInt(last[1], 10) || 1;
}

function multiattackPlan(sh, si, ei) {
    var text = String(sh.sections[si].entries[ei].text || ''), plan = [];
    (sh.sections || []).forEach(function(sec, s2) {
        (sec.entries || []).forEach(function(en, e2) {
            if (s2 === si && e2 === ei) return;
            var name = String(en.name || '').replace(/[（(][^）)]*[）)]/g, '').replace(/[。.]$/, '').trim();
            if (!name || name.length > 12 || !entryActionable(en.text)) return;
            var at = text.indexOf(name);
            if (at < 0) return;
            plan.push({ name: name, sec: s2, idx: e2, left: countBefore(text, at) });
        });
    });
    (sh.attacks || []).forEach(function(at, i) {
        var pos = text.indexOf(at.name);
        if (pos < 0 || plan.some(function(p) { return p.name === at.name; })) return;
        plan.push({ name: at.name, atk: i, left: countBefore(text, pos) });
    });
    if (!plan.length) { // 没认出来：列出所有能结算的攻击
        (sh.sections || []).forEach(function(sec, s2) {
            (sec.entries || []).forEach(function(en, e2) {
                if ((s2 !== si || e2 !== ei) && /攻击检定|命中/.test(en.text || '') && entryActionable(en.text))
                    plan.push({ name: String(en.name || '攻击').replace(/[。.]$/, ''), sec: s2, idx: e2, left: 0 });
            });
        });
        (sh.attacks || []).forEach(function(at, i) { plan.push({ name: at.name, atk: i, left: 0 }); });
    }
    return plan;
}

function openMultiattack(sh, si, ei) {
    multi = { sheet: sh.id, plan: multiattackPlan(sh, si, ei), name: sh.name || '' };
    renderMultiBar();
}

function renderMultiBar() {
    var bar = $('multiBar');
    if (!multi) { bar.style.display = 'none'; return; }
    var sh = sheets[multi.sheet];
    if (!sh) { multi = null; bar.style.display = 'none'; return; }
    bar.innerHTML = '<b>⚔ ' + escapeHtml(multi.name) + ' · 多重攻击</b>' + (multi.plan.length ? multi.plan.map(function(p, i) {
        return '<button class="tt-btn small' + (p.left > 0 ? ' primary' : '') + '" data-mi="' + i + '">' + escapeHtml(p.name) + (p.left > 0 ? ' ×' + p.left : '') + '</button>';
    }).join('') : '<span class="tt-hint">卡上没有可结算的攻击</span>') +
        '<span class="tt-hint">点一次打开一次攻击；顺序、目标由你决定</span><button class="tt-btn small" data-mi="close">✕</button>';
    bar.style.display = '';
}

function onMultiBarClick(e) {
    var b = e.target.closest('[data-mi]');
    if (!b || !multi) return;
    if (b.dataset.mi === 'close') { multi = null; renderMultiBar(); return; }
    var p = multi.plan[+b.dataset.mi], sh = sheets[multi.sheet];
    if (!p || !sh) return;
    castFromSheet(sh, p.atk != null ? { kind: 'atk', idx: String(p.atk) } : { kind: 'entry', sec: String(p.sec), idx: String(p.idx) });
    if (p.left > 0) p.left--;
    renderMultiBar();
}

// ===================== 设置：战斗提示开关 =====================
var HINT_KEYS = [['hintOA', '借机攻击提示', '拖动棋子离开敌人触及范围时提示'], ['hintEcon', '动作经济', '先攻条显示动作 / 附赠 / 反应，结算时自动勾选'],
    ['hintTurn', '回合开始 / 结束效果', '闪避 / 撤离自动结束，重复豁免和持续伤害提示'], ['hintLegend', '传奇动作与充能', '传奇动作提示与恢复、传奇抗性按钮、充能自动掷骰']];

function renderFightHints() {
    var box = $('fightHintBox');
    if (!box || !me.gm) return;
    box.innerHTML = '<h5>战斗提示</h5>' + HINT_KEYS.map(function(k) {
        return '<div class="set-row"><label title="' + escapeHtml(k[2]) + '">' + k[1] + '</label><input type="checkbox" data-hint="' + k[0] + '"' + (hintOn(k[0]) ? ' checked' : '') + '></div>';
    }).join('') + '<div class="tt-hint">都只是提示，不会拦住任何操作；规则说明见项目里的 docs/战斗规则.md。</div>';
}

function initFight() {
    $('multiBar').addEventListener('click', onMultiBarClick);
    $('fightHintBox').addEventListener('change', function(e) {
        var k = e.target.dataset.hint;
        if (k) setRoomSetting(k, e.target.checked ? null : false);
    });
    renderFightHints();
}
