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
    var mb = masteryBtns(e, t, r) + shoveBtns(e, t, r); // 武器精通 / 推撞（出手的人看得到）
    var tok = scene.items[t.id];
    if (mb && !(tok && (me.gm || (tok.owner && tok.owner === me.name)))) return mb;
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
    return mb + h;
}

function fightLogClick(el) {
    var d = el.dataset;
    if (d.oa) { var p = d.oa.split(':'); startOA(p[0], p[1]); return true; }
    if (d.ssave) { op({ op: 'fight.save', ids: [d.ssave], mode: 'status', text: d.st }); el.disabled = true; return true; }
    if (d.dot) { op({ op: 'fight.dot', ids: [d.dot], text: d.st }); el.disabled = true; return true; }
    if (d.concsave) { op({ op: 'fight.save', ids: [d.concsave], mode: 'conc', dc: parseInt(d.dc, 10) || 10, text: d.log || '' }); el.remove(); return true; }
    if (d.mst) return masteryClick(el);
    if (d.shove) { masteryDone[d.log + ':' + d.shove + ':push'] = true; el.remove(); pushToken(d.shove, d.from, 5); return true; }
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
    if (a.grapple && st.id === 'grappled') { st.dc = a.dc; if (a.casterId) st.by = a.casterId; } // 挣脱时对抗的 DC
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
    ['hintTurn', '回合开始 / 结束效果', '闪避 / 撤离自动结束，重复豁免和持续伤害提示'], ['hintLegend', '传奇动作与充能', '传奇动作提示与恢复、传奇抗性按钮、充能自动掷骰'],
    ['hintMastery', '武器精通', '攻击命中 / 失手后按武器精通给出后续按钮（侵扰、削弱、失衡、推离、擦掠、横扫、缓速）']];

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

// ===================== 6. 武器精通（2024）与徒手打击 =====================
var MASTERY = {
    '侵扰': '命中并造成伤害后，你对该生物的下一次攻击检定具有优势（到你下回合结束）',
    '削弱': '命中后，该生物的下一次攻击检定具有劣势（到你下回合开始）',
    '失衡': '命中后，目标进行体质豁免（DC 8 + 属性调整值 + 熟练加值），失败则倒地',
    '推离': '命中体型不超过大型的生物时，可以把它直线推离至多 10 尺',
    '擦掠': '攻击失手时，仍造成等于属性调整值的伤害（同武器伤害类型）',
    '横扫': '近战命中后，可以对它 5 尺内、你触及内的另一个生物再攻击一次（伤害不加属性调整值，每回合一次）',
    '缓速': '命中并造成伤害时，目标速度 −10 尺，直到你下回合开始（不叠加）',
    '迅击': '轻型武器的额外攻击改为攻击动作的一部分，不占附赠动作（每回合一次）'
};
var MASTERY_EN = { vex: '侵扰', sap: '削弱', topple: '失衡', push: '推离', graze: '擦掠', cleave: '横扫', slow: '缓速', nick: '迅击' };

function normMastery(s) {
    s = String(s || '').trim();
    if (!s) return '';
    for (var k in MASTERY) if (s.indexOf(k) >= 0) return k;
    var en = s.toLowerCase().match(/[a-z]+/);
    return en && MASTERY_EN[en[0]] || '';
}

// 武器名 → 规则库里的武器（去掉 +1、括号）
function weaponBaseName(n) { return String(n || '').replace(/[+＋]\s*\d/g, '').replace(/[（(][^）)]*[）)]/g, '').replace(/^\s*(魔法|精制)\s*/, '').trim(); }

// 角色卡的武器攻击没写精通、但角色有「武器精通」时，从规则库的武器表补上
function fillMasteryFromRules(a, sh) {
    if (a.mastery || !sh || !sheetHasEntry(sh, /武器精通|weaponmastery/i)) return;
    ruleLookup('装备', weaponBaseName(a.name)).then(function(w) {
        var m = w && normMastery(w.mastery);
        if (!m || !act || act.a !== a || a.mastery) return;
        a.mastery = m;
        $('acMastery').value = m;
        syncActionDialog();
    });
}

function sheetAbilityMod(sh, key) {
    var cn = { str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力' }[key];
    var ab = (sh && sh.abilities || []).filter(function(x) { return x.key === key || x.name === cn; })[0];
    if (!ab) return 0;
    if (ab.mod != null && ab.mod !== '') return num(String(ab.mod).replace('+', ''), 0);
    return Math.floor((num(ab.score, 10) - 10) / 2);
}
function sheetProf(sh) {
    var p = parseInt(String(sh && sh.prof || '').replace('+', ''), 10);
    if (p > 0) return p;
    var cr = String(sh && sh.cr || '').replace(/\s/g, ''), c = cr.indexOf('/') > 0 ? 0 : parseInt(cr, 10) || 0;
    if (sh && sh.kind !== 'pc' && cr) return c >= 29 ? 9 : c >= 25 ? 8 : c >= 21 ? 7 : c >= 17 ? 6 : c >= 13 ? 5 : c >= 9 ? 4 : c >= 5 ? 3 : 2;
    var lv = parseInt(sh && sh.level, 10) || 1;
    return 2 + Math.floor((Math.max(1, lv) - 1) / 4);
}

// 攻击记录里的命中加值：「1d20 + 5」「2d20kh1 + 5 + 1d4」→ 5
function attackBonusOf(t) {
    var m = String(t && t.attack && t.attack.expr || '').replace(/\s/g, '').match(/^\d*d20(?:k[hl]1)?([+\-]\d+)/i);
    return m ? parseInt(m[1], 10) : 0;
}

// 推开：沿施加者 → 目标的方向推 ft 尺
function pushToken(tid, fromId, ft) {
    var t = scene.items[tid], f = scene.items[fromId];
    if (!t || !f) { notice('找不到推的方向（施加者不在当前场景）', true); return; }
    var a = tokenCenter(f), b = tokenCenter(t), dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, px = ftToPx(ft);
    patchItems([{ id: t.id, x: r1((t.x || 0) + dx / d * px), y: r1((t.y || 0) + dy / d * px) }]);
    notice('已把「' + (t.label || '目标') + '」推开 ' + ft + ' 尺（Ctrl+Z 撤销）');
}

function addStatusTo(tok, st) {
    if (!tok) return;
    var list = statusList(tok).filter(function(s) { return !(s.id === st.id && (st.vs == null || s.vs === st.vs)); }).concat([st]);
    patchItems([{ id: tok.id, status: list }]);
}

// 记录里攻击目标后面的精通按钮（出手的人和 GM 看得到）
function masteryBtns(e, t, r) {
    if (r.kind !== 'attack' || !r.mastery || !hintOn('hintMastery') || !(me.gm || e.who === me.name) || !t.id) return '';
    var key = e.id + ':' + t.id;
    if (masteryDone[key]) return '';
    var hit = t.hit === 'hit' || t.hit === 'crit', dealt = t.amount < 0, m = r.mastery, b = '';
    var btn = function(kind, label) {
        return '<button class="tt-btn small react-btn" data-mst="' + kind + '" data-log="' + escapeHtml(e.id) + '" data-tok="' + escapeHtml(t.id) + '" title="' + escapeHtml('武器精通「' + m + '」：' + (MASTERY[m] || '')) + '">' + label + '</button>';
    };
    if (hit) {
        if (m === '侵扰' && dealt) b = btn('vex', '侵扰：下次攻击优势');
        else if (m === '削弱') b = btn('sap', '削弱：它下次攻击劣势');
        else if (m === '失衡') b = btn('topple', '失衡：体质豁免');
        else if (m === '推离') b = btn('push', '推离 10 尺');
        else if (m === '缓速' && dealt) b = btn('slow', '缓速 −10 尺');
        else if (m === '横扫') b = btn('cleave', '横扫：再打一个');
    } else if (m === '擦掠' && (t.hit === 'miss' || t.hit === 'fumble')) b = btn('graze', '擦掠伤害');
    return b;
}
var masteryDone = {};

function masteryClick(el) {
    var d = el.dataset, ent = logEntries.filter(function(x) { return x.id === d.log; })[0];
    if (!ent || !ent.act) return true;
    var r = ent.act, t = (r.targets || []).filter(function(x) { return x.id === d.tok; })[0] || {};
    var caster = r.casterId && scene.items[r.casterId], tgt = scene.items[d.tok];
    if (!tgt) { notice('目标不在当前场景', true); return true; }
    var sh = caster && caster.sheet && sheets[caster.sheet];
    var bonus = attackBonusOf(t), prof = sheetProf(sh);
    masteryDone[d.log + ':' + d.tok] = true;
    el.remove();
    switch (d.mst) {
    case 'vex':
        if (!caster) { notice('找不到出手的棋子', true); return true; }
        addStatusTo(caster, { id: 'vex', name: '精通·侵扰', icon: '🎯', color: '#ffb74d', vs: tgt.id, vsName: tgt.label || '', rounds: 2 });
        notice((caster.label || '') + ' 对「' + (tgt.label || '目标') + '」的下一次攻击具有优势');
        break;
    case 'sap':
        addStatusTo(tgt, { id: 'sapped', name: '削弱', icon: '🫠', color: '#8d6e63', rounds: 1 });
        break;
    case 'slow':
        addStatusTo(tgt, { id: 'slowed', name: '缓速', icon: '🐌', color: '#90a4ae', rounds: 1 });
        break;
    case 'push':
        if (!caster) { notice('找不到出手的棋子（推的方向）', true); return true; }
        pushToken(tgt.id, caster.id, 10);
        break;
    case 'topple':
        openActionDialog({ name: '失衡（' + r.name + '）', kind: 'save', save: 'con', dc: 8 + bonus, status: 'prone', reach: 0, cost: 'n', area: { shape: '', size: 0, width: 5 }, targets: 1,
            scaleNote: '失衡：DC = 8 + 属性调整值 + 熟练加值，默认按命中加值估算（魔法武器加值要减掉）' }, caster || null, sh || null);
        act.presetTargets = [tgt.id];
        break;
    case 'graze':
        openActionDialog({ name: '擦掠（' + r.name + '）', kind: 'auto', damage: String(Math.max(0, bonus - prof)), dtype: r.damageType || '', cost: 'n', area: { shape: '', size: 0, width: 5 }, targets: 1,
            scaleNote: '擦掠：伤害 = 属性调整值，默认按命中加值 − 熟练加值估算' }, caster || null, sh || null);
        act.presetTargets = [tgt.id];
        break;
    case 'cleave':
        var dmg = String(t.damage && t.damage.expr || '').replace(/\s/g, '').replace(/([+\-]\d+)$/, '');
        openActionDialog({ name: r.name + '（横扫）', kind: 'attack', attack: (bonus >= 0 ? '+' : '') + bonus, damage: dmg, dtype: r.damageType || '', reach: 5, cost: 'n', mastery: '',
            area: { shape: '', size: 0, width: 5 }, targets: 1, scaleNote: '横扫：攻击原目标 5 尺内、你触及内的另一个生物；伤害不加属性调整值（为负时照加），每回合一次' }, caster || null, sh || null);
        break;
    }
    return true;
}

// 攻击之后：用掉施放者身上的「侵扰」（对这些目标）和「削弱」
function masteryAfterAttack(a, caster, ids) {
    if (a.kind !== 'attack' || !caster) return;
    var list = statusList(caster), keep = list.filter(function(s) { return !(s.id === 'vex' && ids.indexOf(s.vs) >= 0) && s.id !== 'sapped'; });
    if (keep.length !== list.length) patchItems([{ id: caster.id, status: keep.length ? keep : null }]);
}

// 属性面板「徒手」：徒手打击 / 擒抱 / 推撞（2024：目标力量或敏捷豁免，DC 8 + 力量调整值 + 熟练加值）
function unarmedRowHtml(it) {
    if (!canEdit(it) || !isCreatureToken(it)) return '';
    return '<div class="prop-row"><label>徒手</label><button class="tt-btn small" data-act="unarmed" title="徒手打击：命中 1 + 力量调整值 钝击">👊 打击</button>' +
        '<button class="tt-btn small" data-act="grapple" title="擒抱：目标力量或敏捷豁免（取高），失败则受擒；需要一只空手，目标至多大你一个体型">🤼 擒抱</button>' +
        '<button class="tt-btn small" data-act="shove" title="推撞：目标力量或敏捷豁免（取高），失败则倒地或被推开 5 尺">推撞</button></div>';
}

function fightSelAct(act0, ids) {
    if (act0 !== 'unarmed' && act0 !== 'grapple' && act0 !== 'shove') return false;
    var it = scene.items[ids[0]];
    if (!it) return true;
    var sh = it.sheet && sheets[it.sheet], str = sheetAbilityMod(sh, 'str'), pb = sheetProf(sh), dc = 8 + str + pb;
    var base = { area: { shape: '', size: 0, width: 5 }, targets: 1, reach: 5, cost: 'a' };
    if (act0 === 'unarmed') {
        var ui = sh && (sh.attacks || []).findIndex(function(x) { return /徒手/.test(x.name || ''); });
        if (sh && ui >= 0) { castFromSheet(sh, { kind: 'atk', idx: String(ui) }); return true; }
        openActionDialog(Object.assign(base, { name: '徒手打击', kind: 'attack', attack: signed(str + pb) || '+0', damage: String(Math.max(1, 1 + str)), dtype: '钝击',
            scaleNote: '徒手打击：命中 = 力量调整值 + 熟练加值，伤害 = 1 + 力量调整值（武僧等可在这里改成武艺骰）' }), it, sh || null);
    } else {
        var g = act0 === 'grapple';
        openActionDialog(Object.assign(base, { name: g ? '擒抱' : '推撞', kind: 'save', save: 'strdex', dc: dc, status: g ? 'grappled' : 'prone', grapple: g, casterId: it.id,
            scaleNote: (g ? '擒抱：需要一只空手；目标至多大你一个体型。失败受擒，可以用动作挣脱（运动或特技对抗 DC ' + dc + '）' :
                '推撞：目标至多大你一个体型。默认失败则倒地；想推开 5 尺就把附加状态改成（无），结算后点记录里的「推开 5 尺」') + '。DC = 8 + 力量 ' + signed(str) + ' + 熟练 ' + pb }), it, sh || null);
    }
    return true;
}

// 推撞失败：推开 5 尺
function shoveBtns(e, t, r) {
    if (r.kind !== 'save' || !/^推撞/.test(r.name || '') || !(t.saved === 'no' || t.saved === 'auto') || !r.casterId || !(me.gm || e.who === me.name)) return '';
    if (masteryDone[e.id + ':' + t.id + ':push']) return '';
    return '<button class="tt-btn small react-btn" data-shove="' + escapeHtml(t.id) + '" data-log="' + escapeHtml(e.id) + '" data-from="' + escapeHtml(r.casterId) + '">推开 5 尺</button>';
}
