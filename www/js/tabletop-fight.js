// 跑团桌面：战斗提示（规则见 docs/战斗规则.md）。原则：只提示、不强制，每类都能在设置里关掉。
// 1. 动作经济：先攻条上显示当前行动者的 动作 / 附赠 / 反应，结算行动时按「消耗」自动勾选
// 2. 借机攻击：拖动棋子离开敌人的触及范围时提示，一键用对方的近战攻击结算
// 3. 专注豁免、状态的回合结束豁免 / 回合开始伤害：记录里一键掷 / 结算
// 4. 传奇动作 / 传奇抗性 / 充能（服务器在回合开始 / 结束时处理，这里是按钮）
// 5. 多重攻击：怪物卡上一键列出这次要做的攻击

function hintOn(key) { return roomSetting(key, true) !== false; }
function clsOn(key) { return hintOn('hintClass') && hintOn(key); } // 职业特性：总开关 + 分职业开关

// ===================== 1. 动作经济 =====================
var ECON = [['a', '动作'], ['b', '附赠'], ['r', '反应']];

function econHudHtml(cur) {
    if (!hintOn('hintEcon') || !cur || !isCreatureToken(cur)) return '';
    var e = cur.econ || {}, edit = canEdit(cur);
    return '<span class="hud-econ">' + (e.surge ? '<i class="econ" title="动作如潮：本回合多一个动作">如潮</i>' : '') + ECON.map(function(k) {
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
    caster = econOwner(caster); // 先攻外的随从记在主控身上
    if (!hintOn('hintEcon') || !caster || !canEdit(caster) || !combatState() || !inInit(caster)) return;
    var cost = a.cost || 'a';
    var e = JSON.parse(JSON.stringify(caster.econ || {}));
    var csh = caster.sheet && sheets[caster.sheet], per = a.kind === 'attack' && cost === 'a' && !a.isSpell ? attacksPerAction(csh) : 1;
    if (per > 1 && !e.a) { // 额外攻击：攻击动作打满 per 下才算用掉动作
        e.atk = (e.atk || 0) + 1;
        if (e.atk < per) notice('额外攻击：攻击动作第 ' + e.atk + '/' + per + ' 击，还可以再攻击 ' + (per - e.atk) + ' 次', false, 3500);
        else { e.a = true; delete e.atk; }
    } else if (cost !== 'n') e[cost] = true;
    if (a.useSlot && a.slotLevel > 0) {
        if (e.slot) notice('2024 规则：一回合只能用法术位施放一个法术（戏法不受限）。这次照样结算了，请 GM 斟酌', true, 6000);
        e.slot = true;
    }
    patchItems([{ id: caster.id, econ: e }]);
}

// 用了「（充能 5~6）」这类能力：扣掉棋子上的「充能·X」计数，服务器在它回合开始时掷充能；还没充好只提示
function rechargeAfterAction(a, caster) {
    if (!caster || !canEdit(caster) || !hintOn('hintLegend')) return;
    var base = String(a.name || '').replace(/[（(]\s*充能[^）)]*[)）]/, '').replace(/（借机）$/, '').trim();
    if (!base) return;
    var res = JSON.parse(JSON.stringify(caster.res || [])), hit = null;
    res.forEach(function(r) {
        var nm = /^充能·/.test(r.name || '') ? r.name.slice(3) : '';
        if (!hit && nm && (base.indexOf(nm) >= 0 || nm.indexOf(base) >= 0)) hit = r;
    });
    if (!hit) return;
    if (num(hit.cur, 0) <= 0) { notice('「' + base + '」还没充能好（只提示，这次照样结算了）', true, 5000); return; }
    hit.cur = num(hit.cur, 0) - 1;
    patchItems([{ id: caster.id, res: res }]);
    if (combatState()) notice('「' + base + '」已用掉，它回合开始时自动掷充能', false, 3500);
}

// 行动框：这次的消耗（动作 / 附赠 / 反应）本回合已经用过、或这回合已用法术位施过法 → 提醒（不拦）
function econWarnSync() {
    var el = $('acEconWarn');
    if (!el) return;
    var w = [], c = act && act.caster, o = c && econOwner(c), e = (o && o.econ) || {}, cost = $('acCost').value;
    if (o && hintOn('hintEcon') && combatState() && inInit(o)) {
        if (cost === 'a' && e.a) w.push('本回合的动作已经用过');
        if (cost === 'b' && e.b) w.push('本回合的附赠动作已经用过');
        if (cost === 'r' && e.r) w.push('反应已经用过（到它下回合开始才恢复）');
        if (act.a && act.a.spellLevel > 0 && $('acUseSlot') && $('acUseSlot').checked && e.slot) w.push('本回合已用法术位施过一次法（2024：每回合只能用法术位施一个法术）');
    }
    el.textContent = w.length ? '⚠ ' + w.join('；') + '（只提示，可以照常结算）' : '';
    el.style.display = w.length ? '' : 'none';
}

// 记录到达时：自己的角色可以借机攻击、要做专注豁免 → 弹提示（只给控制它的玩家，GM 看记录）
function fightNotice(entry) {
    if (!entry || me.gm) return;
    var own = function(id) { var t = scene.items[id]; return t && t.owner && t.owner === me.name ? t : null; };
    var p = String(entry.ref || '').split(':');
    if (p[0] === 'oa' && own(p[1])) { var mv = scene.items[p[2]]; notice('⚔ ' + (own(p[1]).label || '') + ' 可以借机攻击' + (mv ? '「' + (mv.label || '') + '」' : '') + '（在记录里点「借机攻击」，用掉反应）', false, 9000); }
    var r = entry.act;
    (r && r.targets || []).forEach(function(t) {
        var m = String(t.note || '').match(/(?:需专注豁免|专注豁免改为) DC (\d+)/), tok = m && own(t.id);
        if (tok) notice('🧠 ' + (tok.label || '') + ' 受伤了：需要专注豁免 DC ' + m[1] + '（在记录里点「专注豁免」）', false, 9000);
    });
}

// ===================== 2. 借机攻击 =====================
// 敌我：棋子上手动设的阵营 > 玩家控制 / 关联玩家角色卡（GM 代管的队友也算）/ 玩家角色的随从 = 友方 > 其他 = 敌方
function tokenSide(t) {
    if (!t) return 'enemy';
    if (t.side) return t.side;
    if (t.owner || isPC(t)) return 'ally';
    var sh = t.sheet && sheets[t.sheet], m = sh && sh.kind === 'summon' && sh.master && sheets[sh.master];
    return m && m.kind === 'pc' ? 'ally' : 'enemy';
}
function hostileTo(a, b) { var sa = tokenSide(a), sb = tokenSide(b); return sa !== sb && sa !== 'neutral' && sb !== 'neutral'; }
// 已经死了（玩家角色倒地只是昏迷，不算）：不再是攻击 / 范围 / 后续效果的目标
function isDeadToken(t) { return !!t && (hasStatus(t, 'dead') || (!isPC(t) && t.hpMax > 0 && num(t.hp, t.hpMax) <= 0)); }

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

// 一次拖动结束：按实际路线检查有没有离开某个敌人的触及范围
function oaCheckMove(id, orig, trail) {
    if (!hintOn('hintOA') || !combatState()) return;
    var t = scene.items[id];
    if (!t || t.kind !== 'token' || !isCreatureToken(t) || tokenSide(t) === 'neutral') return;
    var tsh = t.sheet && sheets[t.sheet], flyby = !!(tsh && sheetHasEntry(tsh, /飞掠|flyby/i)), dis = hasStatus(t, 'disengaged');
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
        var sent = dis && tokenFeat(en, 'sentinel'), canOA = !flyby && (!dis || sent), pam = tokenFeat(en, 'pam') && polearmHeld(en);
        if (!canOA && !pam) return;
        var reach = meleeReach(en), inside = false, left = false, out = false, entered = false;
        for (var i = 0; i < pts.length; i++) {
            var d = creatureDist(en, t, null, pts[i]);
            if (d <= reach) { inside = true; if (out) entered = true; }
            else { out = true; if (inside) left = true; }
        }
        if (canOA && left) op({ op: 'oa.hint', ids: [en.id, t.id], mode: sent ? 'sentinel' : '' });
        else if (pam && entered) op({ op: 'oa.hint', ids: [en.id, t.id], mode: 'enter' });
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
    act.a.oa = true;
    act.a.name = (act.a.name || '攻击') + '（借机）';
    $('acName').value = act.a.name;
    if ($('acCost')) $('acCost').value = 'r';
    econWarnSync();
    act.presetTargets = scene.items[moverId] ? [moverId] : [];
}

// ===================== 3/4. 记录里的按钮 =====================
// 系统提示（借机、回合效果、传奇动作）后面的按钮
function fightLogBtns(e) {
    if (!e.ref) return '';
    var p = e.ref.split(':');
    var mine = function(id) { var t = scene.items[id]; return t && (me.gm || (t.owner && t.owner === me.name)); };
    if (p[0] === 'oa' && mine(p[1])) return ' <button class="tt-btn small primary" data-oa="' + escapeHtml(p[1] + ':' + p[2]) + '">⚔ 借机攻击</button>' +
        warCasterBtn(p[1], p[2]) + '<button class="tt-btn small" data-trigfocus="' + escapeHtml(p[2]) + '">定位</button>';
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
    var mb = masteryBtns(e, t, r) + sneakBtns(e, t, r) + shoveBtns(e, t, r) + featAtkBtns(e, t, r); // 武器精通 / 偷袭 / 推撞 / 顺势斩 / 阻拦（出手的人看得到）
    var tok = scene.items[t.id], ic = interceptBtns(e, t, r) + cxTargetBtns(e, t, r); // 拦截、职业特性（各自判断谁看得到）
    var ps = pendingSaveHtml(e, t, r); // 手动豁免：提示要掷什么（tabletop-class.js）
    if (!tok || !(me.gm || (tok.owner && tok.owner === me.name))) return ps + mb + ic;
    var h = '', m = String(t.note || '').match(/(?:需专注豁免|专注豁免改为) DC (\d+)/);
    if (m && hasStatus(tok, 'concentration') && !logEntries.some(function(x) { return x.ref === 'conc:' + e.id + ':' + t.id; }))
        h += '<button class="tt-btn small react-btn" data-concsave="' + escapeHtml(t.id) + '" data-dc="' + m[1] + '" data-log="' + escapeHtml(e.id) + '" title="由服务器掷体质豁免，失败自动结束专注">🎲 专注豁免</button>';
    if (me.gm && r.kind === 'save' && t.saved === 'no') {
        var lr = (tok.res || []).filter(function(x) { return x.lr || x.name === '传奇抗性'; })[0];
        if (lr && num(lr.cur, 0) > 0 && !logEntries.some(function(x) { return x.ref === e.id + ':' + t.id; }))
            h += '<button class="tt-btn small react-btn" data-react="legendary" data-log="' + escapeHtml(e.id) + '" data-tok="' + escapeHtml(t.id) +
                '" data-react-ref="' + escapeHtml(e.id + ':' + t.id) + '" title="扣一次传奇抗性，把这次豁免改为成功并重新结算伤害和状态">传奇抗性（剩 ' + num(lr.cur, 0) + '）</button>';
    }
    return ps + mb + h + reactSpellBtns(e, t, r, tok) + featDefBtns(e, t, r, tok) + ic; // 炼狱叱喝 / 吸收元素 / 招架 / 介入盾牌 / 拦截
}

function fightLogClick(el) {
    var d = el.dataset;
    if (d.oa) { var p = d.oa.split(':'); startOA(p[0], p[1]); return true; }
    if (d.ssave) { op({ op: 'fight.save', ids: [d.ssave], mode: 'status', text: d.st }); el.disabled = true; return true; }
    if (d.dot) { op({ op: 'fight.dot', ids: [d.dot], text: d.st }); el.disabled = true; return true; }
    if (d.concsave) { op({ op: 'fight.save', ids: [d.concsave], mode: 'conc', dc: parseInt(d.dc, 10) || 10, text: d.log || '' }); el.remove(); return true; }
    if (d.mst) return masteryClick(el);
    if (d.cs || d.hr) return reactSpellClick(el);
    if (d.ft) return featClick(el);
    if (d.cx) return cxClick(el);
    if (d.psv) return pendingSaveClick(el);
    if (d.oaspell) return warCasterClick(el);
    if (d.sa) return sneakClick(el);
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
    if (a.until === 'srcEnd' || a.until === 'srcStart') st.exp = { when: a.until === 'srcEnd' ? 'end' : 'start' }; // 服务器记下施放者和回合
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
    bar.innerHTML = '<b>⚔ ' + escapeHtml(multi.name) + ' · ' + escapeHtml(multi.title || '多重攻击') + '</b>' + (multi.plan.length ? multi.plan.map(function(p, i) {
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
    var pc = p.caster && scene.items[p.caster];
    if (p.unarmed && pc) monkUnarmed(pc, sh, p.cost || 'n'); // 疾风连击（卡上没有徒手攻击时）
    else {
        if (p.cost) actPreset = { caster: pc || null, cost: p.cost, at: Date.now() }; // 疾风连击的每一下不再记消耗
        castFromSheet(sh, p.atk != null ? { kind: 'atk', idx: String(p.atk) } : { kind: 'entry', sec: String(p.sec), idx: String(p.idx) });
    }
    if (p.left > 0) p.left--;
    if (multi && multi.title && multi.plan.every(function(x) { return !(x.left > 0); })) multi = null; // 疾风连击等次数打完：收起
    renderMultiBar();
}

// ===================== 设置：战斗提示开关 =====================
// 自动化分类（都默认开，关掉的写 false 存进房间设置）；规则和完整清单见 docs/战斗规则.md 第 13 节
var AUTO_GROUPS = [
    { title: '判定与结算', items: [
        ['autoTraits', '按特性名自动识别判定修正', '角色卡上的特性名自动生效：反射闪避、魔法抗性、矮人体魄、守护灵光、战俑构装坚韧、龙裔血统抗性、战争化身等。关掉后只用卡上手动加的「判定修正」'],
        ['autoCond', '状态对攻击的影响', '攻击时按双方状态自动给优势 / 劣势 / 近身自动重击，以及祝福 / 灾祸 / 力竭的加减值'],
        ['autoCover', '自动掩护', '确认目标时按墙、门窗和挡路的生物自动算半身 / 四分之三 / 完全掩护']] },
    { title: '回合流程', items: [
        ['hintEcon', '动作经济', '先攻条显示动作 / 附赠 / 反应，结算时自动勾选；额外攻击按攻击动作计数'],
        ['hintTurn', '回合开始 / 结束效果', '闪避 / 撤离 / 疾走自动结束，「直到回合结束 / 开始」的状态自动去掉，重复豁免和持续伤害提示'],
        ['hintLegend', '传奇动作与充能', '传奇动作提示与恢复、传奇抗性按钮、充能自动掷骰']] },
    { title: '战斗提示', items: [
        ['hintOA', '借机攻击', '拖动棋子离开敌人触及范围时提示（哨兵、长柄武器大师、战地施法者也在这里）'],
        ['hintMastery', '武器精通', '攻击命中 / 失手后按武器精通给出后续按钮（侵扰、削弱、失衡、推离、擦掠、横扫、缓速）'],
        ['hintReact', '反应法术', '施法后的法术反制按钮，受伤后的炼狱叱喝 / 吸收元素按钮']] },
    { title: '职业特性', master: ['hintClass', '职业特性（总开关）', '关掉后下面所有职业的按钮和自动处理都停止'], items: [
        ['hcFighter', '战士 / 符文骑士', '回气、动作如潮、战术思维、战术转进、不屈、究明攻击；巨人之力、各种符文、符文之盾'],
        ['hcMonk', '武僧 / 四象武者', '功力、武艺、疾风连击、坚强防御、疾步如风、运转周天、拨挡反弹、震慑拳、圆融自在；元素同调、元素爆破拳'],
        ['hcCleric', '牧师 / 战争领域', '神圣火花、驱散亡灵、神圣打击、强力施法、神圣干预；战争祭司、导引打击、战神祝福'],
        ['hcDruid', '德鲁伊 / 星辰结社', '荒野变形、荒野伙伴、荒野复苏、原力蛮击；星图、星耀形态（巨龙座专注豁免）、宇宙预兆'],
        ['hcWizard', '法师 / 预言师', '奥术回想、招牌法术；预兆、专业预言、天眼通'],
        ['hcArtificer', '奇械师 / 魔炮师', '灵光一闪；魔能炮台、奥法火器、要塞阵地'],
        ['hcOther', '野蛮人 / 游荡者 / 吟游诗人', '狂暴（狂暴伤害自动加）、偷袭、诗人激励']] },
    { title: '专长与种族', items: [
        ['hintFeat', '专长', '巨武器大师 / 巨武器战斗、长柄武器大师、哨兵、神射手 / 强弩专家 / 擒抱者、战地施法者、幸运、防御式决斗、拦截、盾牌大师、徒手战斗 / 酒馆斗殴者'],
        ['hintRace', '种族特性', '龙裔吐息武器 / 龙族飞翼、化兽者化兽 / 迅捷']] }
];
var HINT_KEYS = [];
AUTO_GROUPS.forEach(function(g) { if (g.master) HINT_KEYS.push(g.master); HINT_KEYS = HINT_KEYS.concat(g.items); });

function renderFightHints() {
    var box = $('fightHintBox');
    if (!box || !me.gm) return;
    var row = function(k, sub, off) {
        return '<div class="set-row"' + (sub ? ' style="padding-left:14px;' + (off ? 'opacity:.5;' : '') + '"' : '') + '><label title="' + escapeHtml(k[2]) + '">' + k[1] + '</label>' +
            '<input type="checkbox" data-hint="' + k[0] + '"' + (hintOn(k[0]) ? ' checked' : '') + '></div>';
    };
    box.innerHTML = '<h5>战斗自动化</h5>' + AUTO_GROUPS.map(function(g) {
        var off = g.master && !hintOn(g.master[0]);
        return '<div class="tt-hint" style="margin:8px 0 2px;font-weight:bold;">' + g.title + '</div>' + (g.master ? row(g.master, false) : '') +
            g.items.map(function(k) { return row(k, !!g.master, off); }).join('');
    }).join('') + '<div class="tt-hint">都只是辅助，不会拦住任何操作；每个角色是否自动掷豁免在它的属性面板里设置。规则说明见项目里的 docs/战斗规则.md。</div>';
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
    if (masterSheet(sh)) return sheetProf(masterSheet(sh)); // 随从用主控的熟练加值
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
    var list = statusList(caster), keep = list.filter(function(s) { return !(s.id === 'vex' && ids.indexOf(s.vs) >= 0) && s.id !== 'sapped' && s.id !== 'lucky'; });
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
    if (classSelAct(act0, ids) || featSelAct(act0, ids) || cxSelAct(act0, ids)) return true; // 职业特性 / 专长一键
    if (act0 !== 'unarmed' && act0 !== 'grapple' && act0 !== 'shove') return false;
    var it = scene.items[ids[0]];
    if (!it) return true;
    var sh = it.sheet && sheets[it.sheet], str = sheetAbilityMod(sh, 'str'), pb = sheetProf(sh), dc = 8 + str + pb;
    var base = { area: { shape: '', size: 0, width: 5 }, targets: 1, reach: 5, cost: 'a' };
    if (act0 === 'unarmed') {
        var ui = sh && (sh.attacks || []).findIndex(function(x) { return /徒手/.test(x.name || ''); });
        if (sh && ui >= 0) { castFromSheet(sh, { kind: 'atk', idx: String(ui) }); return true; }
        if (sh && monkLv(sh)) { monkUnarmed(it, sh, 'a'); return true; } // 武僧：武艺骰（tabletop-class.js）
        var ufs = sheetFeat(sh, 'unarmedFS'), tb = sheetFeat(sh, 'brawler');
        openActionDialog(Object.assign(base, { name: '徒手打击', kind: 'attack', attack: signed(str + pb) || '+0', dtype: '钝击',
            damage: ufs ? '1d6' + signed(str) : tb ? '1d4' + signed(str) : String(Math.max(1, 1 + str)),
            scaleNote: ufs ? '徒手战斗：伤害 1d6 + 力量调整值（没拿武器和盾牌时可以改成 1d8）' : tb ? '酒馆斗殴者：伤害 1d4 + 力量调整值，伤害骰掷出 1 可以重掷；命中后可以把目标推开 5 尺' :
                '徒手打击：命中 = 力量调整值 + 熟练加值，伤害 = 1 + 力量调整值（武僧等可在这里改成武艺骰）' }), it, sh || null);
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

// ===================== 7. 职业特性一键（2024 玩家手册） =====================
// 偷袭（命中后记录里一键加伤，每回合一次）、狂暴（进入 / 结束；狂暴伤害在行动框里自动加）、
// 回气、动作如潮、诗人激励。次数记在棋子资源里（没有就按等级表新建），都可以手动改。
function byLevel(table, lv) { var v = table[0][1]; table.forEach(function(t) { if (lv >= t[0]) v = t[1]; }); return v; }
var CF = {
    rageUses: [[1, 2], [3, 3], [6, 4], [12, 5], [17, 6]],
    rageDmg: [[1, 2], [9, 3], [16, 4]],
    windUses: [[1, 2], [4, 3], [10, 4]],
    surgeUses: [[2, 1], [17, 2]],
    bardDie: [[1, 'd6'], [5, 'd8'], [10, 'd10'], [15, 'd12']]
};

// 职业等级：「战士 5」「战士 3 / 游荡者 2」；只写了职业名时用总等级
function classLevel(sh, cn) {
    if (!sh) return 0;
    var cls = String(sh.class || '') + ' ' + String(sh.subclass || ''), m = cls.match(new RegExp(cn + '\\s*(\\d+)'));
    if (m) return parseInt(m[1], 10);
    return cls.indexOf(cn) >= 0 ? (parseInt(sh.level, 10) || 1) : 0;
}

// 棋子资源：按名字找（比如「回气」），没有就按等级表新建；返回 { res, r } 或 null
function featRes(tok, name, max) {
    var res = JSON.parse(JSON.stringify(tok.res || [])), r = res.filter(function(x) { return String(x.name || '').indexOf(name) >= 0; })[0];
    if (!r && max > 0) { r = { id: genId(), name: name, type: 'count', cur: max, max: max, icon: 'gem' }; res.push(r); }
    return r ? { res: res, r: r } : null;
}
function spendFeat(tok, name, max) {
    var fr = featRes(tok, name, max);
    if (!fr) return true;
    if (num(fr.r.cur, 0) <= 0) { notice('「' + name + '」已经用完了（可以在棋子资源里改次数）', true); return false; }
    fr.r.cur = num(fr.r.cur, 0) - 1;
    patchItems([{ id: tok.id, res: fr.res }]);
    notice(name + '：剩 ' + fr.r.cur + '/' + fr.r.max);
    return true;
}
function featLeft(tok, name, max) { var fr = featRes(tok, name, max); return fr ? num(fr.r.cur, 0) + '/' + num(fr.r.max, 0) : ''; }

function classRowHtml(it) {
    var sh = it.sheet && sheets[it.sheet];
    if (!sh || !canEdit(it) || !hintOn('hintClass')) return '';
    var b = [], bar = classLevel(sh, '野蛮人'), fig = classLevel(sh, '战士'), bard = classLevel(sh, '吟游诗人');
    if (clsOn('hcOther') && sheetHasEntry(sh, /狂暴|rage/i) && (bar || /狂暴/.test(JSON.stringify(sh.features || [])))) {
        var lvB = bar || parseInt(sh.level, 10) || 1;
        b.push(hasStatus(it, 'raging') ? '<button class="tt-btn small" data-act="cf-rageend">结束狂暴</button>' :
            '<button class="tt-btn small" data-act="cf-rage" title="附赠动作：钝穿挥抗性、力量检定与豁免优势、力量近战加伤 +' + byLevel(CF.rageDmg, lvB) + '">😡 狂暴（' + featLeft(it, '狂暴', byLevel(CF.rageUses, lvB)) + '）</button>');
    }
    if (clsOn('hcFighter') && sheetHasEntry(sh, /回气|secondwind/i)) {
        var lvF = fig || parseInt(sh.level, 10) || 1;
        b.push('<button class="tt-btn small" data-act="cf-wind" title="附赠动作：恢复 1d10 + 战士等级（' + lvF + '）生命">回气（' + featLeft(it, '回气', byLevel(CF.windUses, lvF)) + '）</button>');
    }
    if (clsOn('hcFighter') && sheetHasEntry(sh, /动作如潮|actionsurge/i)) {
        var lvS = fig || parseInt(sh.level, 10) || 2;
        b.push('<button class="tt-btn small" data-act="cf-surge" title="本回合额外获得一个动作（不能是魔法动作）">动作如潮（' + featLeft(it, '动作如潮', byLevel(CF.surgeUses, Math.max(2, lvS))) + '）</button>');
    }
    if (clsOn('hcOther') && sheetHasEntry(sh, /诗人激励|吟游诗人激励|bardicinspiration/i)) {
        var lvD = bard || parseInt(sh.level, 10) || 1, cha = Math.max(1, sheetAbilityMod(sh, 'cha'));
        b.push('<button class="tt-btn small" data-act="cf-bardic" title="附赠动作：60 尺内一名其他生物获得一颗诗人激励骰（' + byLevel(CF.bardDie, lvD) + '）">🎵 诗人激励（' + featLeft(it, '诗人激励', cha) + '）</button>');
    }
    b = b.concat(cxPanelBtns(it, sh)); // tabletop-class.js：战士 / 符文骑士 / 化兽…
    return b.length ? '<div class="prop-row"><label>职业</label><span class="prop-btns" style="margin:0;">' + b.join('') + '</span></div>' : '';
}

function classSelAct(act0, ids) {
    if (!/^cf-/.test(act0 || '')) return false;
    var it = scene.items[ids[0]], sh = it && it.sheet && sheets[it.sheet];
    if (!it || !sh) return true;
    var lv = function(cn, d) { return classLevel(sh, cn) || parseInt(sh.level, 10) || d; };
    if (act0 === 'cf-rage') {
        if (!spendFeat(it, '狂暴', byLevel(CF.rageUses, lv('野蛮人', 1)))) return true;
        var st = statusList(it).filter(function(s) { return s.id !== 'raging'; }).concat([{ id: 'raging', name: '狂暴', icon: '😡', color: '#e53935' }]);
        patchItems([{ id: it.id, status: st }]);
        econAfterAction({ cost: 'b' }, it);
    } else if (act0 === 'cf-rageend') {
        patchItems([{ id: it.id, status: statusList(it).filter(function(s) { return s.id !== 'raging'; }) }]);
    } else if (act0 === 'cf-wind') {
        var lf = lv('战士', 1);
        if (!spendFeat(it, '回气', byLevel(CF.windUses, lf))) return true;
        openActionDialog({ name: '回气', kind: 'heal', damage: '1d10+' + lf, cost: 'b', area: { shape: '', size: 0, width: 5 }, targets: 1, scaleNote: '回气：1d10 + 战士等级 ' + lf }, it, sh);
        act.presetTargets = [it.id];
        if (lf >= 5 && clsOn('hcFighter')) { // 战术转进：用回气时可以移动至多一半速度，不引发借机攻击
            var dg = STATUS_BY_ID.disengaged;
            addStatusTo(it, { id: 'disengaged', name: dg.name, icon: dg.icon, color: dg.color });
            notice('战术转进：本回合可以移动至多一半速度，不会引发借机攻击（已挂上「撤离」）', false, 5000);
        }
    } else if (act0 === 'cf-surge') {
        if (!spendFeat(it, '动作如潮', byLevel(CF.surgeUses, Math.max(2, lv('战士', 2))))) return true;
        var e = JSON.parse(JSON.stringify(it.econ || {}));
        delete e.a;
        delete e.atk; // 新的动作可以重新执行攻击动作（额外攻击重新计数）
        e.surge = true;
        patchItems([{ id: it.id, econ: e }]);
        notice((it.label || '') + ' 动作如潮：本回合多一个动作（不能是魔法动作）');
    } else if (act0 === 'cf-bardic') {
        var die = byLevel(CF.bardDie, lv('吟游诗人', 1));
        if (!spendFeat(it, '诗人激励', Math.max(1, sheetAbilityMod(sh, 'cha')))) return true;
        openActionDialog({ name: '诗人激励（' + die + '）', kind: 'effect', status: 'bardic', range: 60, cost: 'b', area: { shape: '', size: 0, width: 5 }, targets: 1,
            scaleNote: '诗人激励：目标之后 1 小时内可以把一颗 ' + die + ' 加到一次 d20 检定上' }, it, sh);
    }
    $('selPanel').dataset.ids = '';
    renderSelPanel();
    renderCombatHud();
    return true;
}

// 行动框：狂暴中的野蛮人用力量近战攻击时，伤害加狂暴伤害（勾选框，可取消）
function classDialogSync(a, caster, sh) {
    var row = $('acClassRow');
    if (!row) return;
    row.style.display = 'none';
    $('acRage').checked = false;
    if (!clsOn('hcOther') || !caster || a.kind !== 'attack' || !hasStatus(caster, 'raging')) return;
    var s = sh || (caster.sheet && sheets[caster.sheet]);
    var n = byLevel(CF.rageDmg, classLevel(s, '野蛮人') || parseInt(s && s.level, 10) || 1);
    $('acRageN').textContent = '+' + n;
    $('acRage').dataset.n = n;
    $('acRage').checked = !(a.range > 0 && !a.reach); // 远程（敏捷）攻击默认不加
    row.style.display = '';
}
function classDialogApply(a) {
    if ($('acClassRow').style.display === 'none' || !$('acRage').checked || a.rageAdded) return;
    a.damage = addToDamage(a.damage || '', '+' + $('acRage').dataset.n);
    a.rageAdded = true;
}

// 偷袭：命中后记录里的按钮（出手的人和 GM），每回合一次（任何人的回合都算一回合）
function sneakBtns(e, t, r) {
    if (r.kind !== 'attack' || !(t.hit === 'hit' || t.hit === 'crit') || !r.casterId || !(me.gm || e.who === me.name) || !clsOn('hcOther')) return '';
    var c = scene.items[r.casterId], sh = c && c.sheet && sheets[c.sheet];
    if (!sh || !sheetHasEntry(sh, /偷袭|sneakattack/i) || masteryDone[e.id + ':sa']) return '';
    if (c.econ && c.econ.saKey && c.econ.saKey === turnKey()) return '';
    var lvR = classLevel(sh, '游荡者') || parseInt(sh.level, 10) || 1, n = Math.ceil(lvR / 2) * (t.hit === 'crit' ? 2 : 1), tgt = scene.items[t.id];
    var why = [], adv = /^2d20kh1/i.test(String(t.attack && t.attack.expr || '').replace(/\s/g, ''));
    if (adv) why.push('有优势');
    if (tgt && sortedItems().some(function(o) {
        return o.kind === 'token' && o.id !== c.id && o.id !== tgt.id && isCreature(o) && tokenSide(o) === tokenSide(c) &&
            !['incapacitated', 'paralyzed', 'stunned', 'unconscious', 'petrified'].some(function(s) { return hasStatus(o, s); }) && creatureDist(o, tgt) <= 5;
    })) why.push('目标 5 尺内有盟友');
    var ok = why.length > 0 && !/^2d20kl1/i.test(String(t.attack && t.attack.expr || '').replace(/\s/g, ''));
    return '<button class="tt-btn small react-btn" data-sa="' + escapeHtml(t.id) + '" data-log="' + escapeHtml(e.id) + '" data-n="' + n + '" title="' +
        escapeHtml('偷袭（每回合一次）：灵巧或远程武器命中，且有优势、或目标 5 尺内有你的盟友（且你没有劣势）。' + (why.length ? '当前：' + why.join('、') : '当前看不出满足条件，由 GM 判断')) + '">' +
        '偷袭 +' + n + 'd6' + (ok ? '' : '？') + '</button>';
}

function sneakClick(el) {
    var d = el.dataset, ent = logEntries.filter(function(x) { return x.id === d.log; })[0];
    if (!ent || !ent.act) return true;
    var r = ent.act, c = scene.items[r.casterId], tgt = scene.items[d.sa];
    if (!c || !tgt) { notice('出手的棋子或目标不在当前场景', true); return true; }
    masteryDone[d.log + ':sa'] = true;
    el.remove();
    var e = JSON.parse(JSON.stringify(c.econ || {}));
    e.saKey = turnKey() || ('t' + Date.now());
    patchItems([{ id: c.id, econ: e }]);
    openActionDialog({ name: '偷袭（' + r.name + '）', kind: 'auto', damage: d.n + 'd6', dtype: r.damageType || '', cost: 'n', area: { shape: '', size: 0, width: 5 }, targets: 1,
        scaleNote: '偷袭伤害与武器同类型；重击时骰子已经翻倍' }, c, c.sheet && sheets[c.sheet] || null);
    act.presetTargets = [tgt.id];
    return true;
}

// ===================== 8. 反应法术：法术反制、炼狱叱喝、吸收元素 =====================
// 羽落术等不依赖触发的反应法术照常从角色卡施放（施法时间是反应的会自动把消耗设为反应）
var ELEMENTAL = { '强酸': 1, '寒冷': 1, '火焰': 1, '闪电': 1, '雷鸣': 1 };

function tokenHasSpell(t, name) {
    var sh = t && t.sheet && sheets[t.sheet];
    return !!sh && ((sh.spells || []).some(function(s) { return String(s.name || '').indexOf(name) >= 0; }) || sheetHasEntry(sh, new RegExp(name)));
}

// 用掉一个不低于 minLv 环的法术位（最低能用的那个）
function spendSlotAtLeast(t, minLv) {
    var sh = t && t.sheet && sheets[t.sheet];
    if (!sh || !canEditSheet(sh) || !(sh.slots || []).length) return;
    for (var lv = minLv; lv <= 9; lv++) {
        var s = slotOf(sh, lv);
        if (s && s.cur > 0) { changeSlot(sh, s.idx, -1); notice('已消耗 1 个 ' + lv + ' 环法术位（剩 ' + (s.cur - 1) + '）'); return; }
    }
    notice('没有剩余的 ' + minLv + ' 环或更高的法术位（仍然施放了，可在角色卡上调整）', true);
}

// 施法记录后面：附近能用「法术反制」的单位（自己控制的；GM 看得到所有）
function counterBtns(e, r) {
    if (!r.spell || !e.id || !hintOn('hintReact')) return '';
    if (logEntries.some(function(x) { return x.ref === 'cs:' + e.id; })) return '';
    var caster = r.casterId && scene.items[r.casterId];
    var list = sortedItems().filter(function(t) {
        return t.kind === 'token' && t.id !== r.casterId && (me.gm || (t.owner && t.owner === me.name)) && isCreatureToken(t) &&
            canReact(t) && tokenHasSpell(t, '法术反制') && (!caster || (hostileTo(t, caster) && creatureDist(t, caster) <= 60));
    });
    if (!list.length) return '';
    return '<div class="act-target">⛔ ' + list.map(function(t) {
        return '<button class="tt-btn small react-btn" data-cs="' + escapeHtml(t.id) + '" data-log="' + escapeHtml(e.id) + '" title="用反应施放法术反制（三环）：施法者体质豁免对抗你的法术 DC，失败则这道法术作废、不消耗法术位">法术反制（' + escapeHtml(chipName(t.label)) + '）</button>';
    }).join('') + '</div>';
}

// 受伤的目标后面：炼狱叱喝（反击伤害来源）、吸收元素（减半元素伤害）
function reactSpellBtns(e, t, r, tok) {
    if (!hintOn('hintReact') || !tok || !canReact(tok)) return '';
    var h = '', caster = r.casterId && scene.items[r.casterId], ref = e.id + ':' + t.id;
    var elem = Object.keys(t.types || {}).filter(function(ty) { return ELEMENTAL[ty] && t.types[ty] > 0; });
    if (elem.length && tokenHasSpell(tok, '吸收元素') && !logEntries.some(function(x) { return x.ref === ref; }))
        h += '<button class="tt-btn small react-btn" data-react="absorb" data-log="' + escapeHtml(e.id) + '" data-tok="' + escapeHtml(t.id) + '" data-react-ref="' + escapeHtml(ref) +
            '" title="用反应施放吸收元素（一环）：这次的' + escapeHtml(elem.join('、')) + '伤害减半，直到你下回合开始有抗性">吸收元素</button>';
    if (t.amount < 0 && caster && caster.id !== tok.id && creatureDist(tok, caster) <= 60 && tokenHasSpell(tok, '炼狱叱喝') && !masteryDone[ref + ':hr'])
        h += '<button class="tt-btn small react-btn" data-hr="' + escapeHtml(t.id) + '" data-log="' + escapeHtml(e.id) + '" title="用反应施放炼狱叱喝：伤害来源敏捷豁免，失败受火焰伤害">炼狱叱喝</button>';
    return h;
}

function reactSpellClick(el) {
    var d = el.dataset;
    if (d.cs) {
        var t = scene.items[d.cs];
        el.remove();
        op({ op: 'fight.counter', ids: [d.cs], text: d.log }).then(function(ok) { if (ok) spendSlotAtLeast(t, 3); });
        return true;
    }
    if (d.hr) {
        var ent = logEntries.filter(function(x) { return x.id === d.log; })[0], tok = scene.items[d.hr];
        var sh = tok && tok.sheet && sheets[tok.sheet], src = ent && ent.act && ent.act.casterId;
        var i = sh ? (sh.spells || []).findIndex(function(s) { return String(s.name || '').indexOf('炼狱叱喝') >= 0; }) : -1;
        if (i < 0 || !src) { notice('角色卡上没有「炼狱叱喝」，或找不到伤害来源', true); return true; }
        masteryDone[d.log + ':' + d.hr + ':hr'] = true;
        el.remove();
        actPreset = { caster: tok, targets: [src], cost: 'r' };
        castFromSheet(sh, { kind: 'spell', idx: String(i) });
        return true;
    }
    return false;
}

// 打开行动框时套用预设（反应法术：施放者、预选目标、消耗）
var actPreset = null;
function applyActPreset() {
    if (!actPreset || !act) return;
    var p = actPreset;
    actPreset = null;
    if (p.at && Date.now() - p.at > 180000) return; // 太久之前的预设（打开角色卡后没有施法）
    if (p.caster) { act.caster = p.caster; $('acCaster').textContent = p.caster.label || '未命名棋子'; }
    if (p.targets) act.presetTargets = p.targets.slice();
    if (p.cost) { act.a.cost = p.cost; $('acCost').value = p.cost; }
    if (p.noConc) { act.a.conc = false; $('acConc').checked = false; } // 战神祝福：不需要专注
    if (p.noSlot) { act.a.useSlot = false; if ($('acUseSlot')) $('acUseSlot').checked = false; } // 免费施放：不扣法术位
}

// ===================== 9. 专长（2024 玩家手册） =====================
// 巨武器大师（重型武器加熟练加值伤害、顺势斩）、长柄武器大师（长柄打击、进入触及时反击）、
// 哨兵（撤离也能借机、打别人时借机、阻拦）、神射手 / 强弩专家（掩护、远距离、近身射击）、擒抱者、
// 战地施法者（用法术代替借机攻击）、幸运、防御式决斗、拦截、盾牌大师（介入盾牌）、酒馆斗殴者 / 徒手战斗。
// 都看角色卡上有没有这个专长（特性 / 条目名字）；战斗风格的固定加值（箭术、对决、防御）默认已经算在卡上的数字里。
var FEAT = {
    gwm: /巨武器大师|greatweaponmaster/i,
    pam: /长柄武器大师|polearmmaster/i,
    sentinel: /哨兵|sentinel/i,
    sharp: /神射手|sharpshooter/i,
    xbow: /强弩专家|弩炮专家|crossbowexpert/i,
    grappler: /擒抱者|擒抱手|grappler/i,
    warcaster: /战地施法者|战争施法者|warcaster/i,
    lucky: /^(专长[：:·]?)?幸运(专长)?$|^lucky$/i,
    duelist: /防御式决斗|防御决斗|defensiveduelist/i,
    intercept: /拦截|interception/i,
    shieldmaster: /盾牌大师|介入盾牌|shieldmaster/i,
    brawler: /酒馆斗殴者|酒馆斗士|tavernbrawler/i,
    unarmedFS: /徒手战斗|unarmedfighting/i
};
var POLEARM = /长棍|矛|戟|长柄刀|骑枪|quarterstaff|spear|halberd|glaive|pike|lance/i;
var HEAVY_WEAPON = /巨斧|巨剑|巨锤|重弩|长弓|戟|长柄刀|长矛|骑枪|greataxe|greatsword|maul|heavycrossbow|longbow|halberd|glaive|pike|lance/i;

function tokenFeat(t, key) {
    var sh = t && t.sheet && sheets[t.sheet];
    return !!sh && hintOn('hintFeat') && sheetHasEntry(sh, FEAT[key]);
}
function sheetFeat(sh, key) { return !!sh && hintOn('hintFeat') && sheetHasEntry(sh, FEAT[key]); }
function mineTok(t) { return t && (me.gm || (t.owner && t.owner === me.name)); }
function polearmHeld(t) {
    var sh = t && t.sheet && sheets[t.sheet];
    return !!sh && (sh.attacks || []).some(function(at) { return POLEARM.test(at.name || ''); });
}
function isHeavyAttack(a) { return /重型|heavy/i.test(a.props || '') || HEAVY_WEAPON.test(String(a.name || '').replace(/\s/g, '')); }

// 行动框：巨武器大师——重型武器命中加熟练加值伤害（攻击动作的一部分，默认在消耗为「动作」时勾上）
function featDialogSync(a, caster, sh) {
    var row = $('acFeatRow');
    if (!row) return;
    $('acGwm').checked = false;
    $('acGwmWrap').style.display = 'none';
    var gwf = gwfSync(a, caster, sh); // 巨武器战斗（tabletop-class.js）
    var s = sh || (caster && caster.sheet && sheets[caster.sheet]);
    var gwm = !!caster && a.kind === 'attack' && !a.gwmAdded && !a.isSpell && sheetFeat(s, 'gwm') && isHeavyAttack(a);
    if (gwm) {
        var pb = sheetProf(s);
        $('acGwmN').textContent = '+' + pb;
        $('acGwm').dataset.n = pb;
        $('acGwm').checked = (a.cost || 'a') === 'a';
        $('acGwmWrap').style.display = '';
    }
    row.style.display = gwm || gwf ? '' : 'none';
}
function featDialogApply(a) {
    if ($('acFeatRow').style.display === 'none') return;
    if ($('acGwmWrap').style.display !== 'none' && $('acGwm').checked && !a.gwmAdded) {
        a.damage = addToDamage(a.damage || '', '+' + $('acGwm').dataset.n);
        a.gwmAdded = true;
    }
    gwfApply(a);
}

// 确认目标时：神射手 / 强弩专家 / 擒抱者对掩护、优劣势的修正（只在这次真的改了判定时写进记录）
function featAttackAdjust(a, caster, tgt, dist) {
    var fx = { noCover: '', noLong: '', noAdj: '', adv: '' };
    var sh = caster && caster.sheet && sheets[caster.sheet];
    if (!sh || a.kind !== 'attack' || !hintOn('hintFeat')) return fx;
    var ranged = a.range > 0 && !a.isSpell && !(a.reach && dist <= a.reach);
    if (ranged && sheetHasEntry(sh, FEAT.sharp)) fx.noCover = fx.noLong = fx.noAdj = '神射手';
    else if (ranged && /弩|crossbow/i.test(a.name || '') && sheetHasEntry(sh, FEAT.xbow)) fx.noAdj = '强弩专家';
    if (sheetHasEntry(sh, FEAT.grappler) && statusList(tgt).some(function(s) { return s.id === 'grappled' && s.by === caster.id; })) fx.adv = '擒抱者：攻击自己擒住的目标有优势';
    return fx;
}

// 记录里整次行动后面：长柄打击、哨兵（打了别人）
function featActBtns(e, r) {
    if (r.kind !== 'attack' || !e.id || !r.casterId || !hintOn('hintFeat')) return '';
    var c = scene.items[r.casterId];
    if (!c) return '';
    var h = '', hitIds = (r.targets || []).filter(function(t) { return t.hit === 'hit' || t.hit === 'crit'; }).map(function(t) { return t.id; });
    if ((me.gm || e.who === me.name) && POLEARM.test(r.name || '') && !/长柄打击/.test(r.name || '') && tokenFeat(c, 'pam') && !masteryDone[e.id + ':pam'])
        h += '<button class="tt-btn small react-btn" data-ft="pam" data-log="' + escapeHtml(e.id) + '" title="长柄武器大师：攻击动作用长柄武器攻击后，附赠动作用另一端再攻击一次，伤害 1d4 钝击">长柄打击（附赠）</button>';
    if (hitIds.length) sortedItems().forEach(function(t) {
        if (t.kind !== 'token' || t.id === c.id || !mineTok(t) || !isCreatureToken(t) || !canReact(t) || hitIds.every(function(id) { return id === t.id; })) return;
        var side = tokenSide(t);
        if (side === 'neutral' || side === tokenSide(c) || creatureDist(t, c) > 5 || !tokenFeat(t, 'sentinel') || masteryDone[e.id + ':guard:' + t.id]) return;
        h += '<button class="tt-btn small react-btn" data-ft="guard" data-log="' + escapeHtml(e.id) + '" data-tok="' + escapeHtml(t.id) + '" title="哨兵·守护者：5 尺内的生物攻击命中了你以外的目标，你可以用反应对它借机攻击">哨兵：借机（' + escapeHtml(chipName(t.label)) + '）</button>';
    });
    return h ? '<div class="act-target">🛡 ' + h + '</div>' : '';
}

// 记录里每个目标后面（出手的一方）：顺势斩、阻拦
function featAtkBtns(e, t, r) {
    if (r.kind !== 'attack' || !t.id || !r.casterId || !(me.gm || e.who === me.name) || !hintOn('hintFeat')) return '';
    var c = scene.items[r.casterId], tok = scene.items[t.id], h = '';
    if (!c || !tok) return '';
    var hit = t.hit === 'hit' || t.hit === 'crit', down = tok.hpMax > 0 && num(tok.hp, tok.hpMax) <= 0 && t.amount < 0;
    if (r.melee && (t.hit === 'crit' || down) && tokenFeat(c, 'gwm') && !masteryDone[e.id + ':cleave'] && !(c.econ && c.econ.gwmKey && c.econ.gwmKey === turnKey()))
        h += '<button class="tt-btn small react-btn" data-ft="cleave" data-log="' + escapeHtml(e.id) + '" data-tok="' + escapeHtml(t.id) + '" title="巨武器大师·顺势斩：近战重击或把目标打到 0 生命值后，附赠动作再用这把武器攻击一次（每回合一次）">顺势斩（附赠攻击）</button>';
    if (hit && /（借机）/.test(r.name || '') && tokenFeat(c, 'sentinel') && !hasStatus(tok, 'halted') && !masteryDone[e.id + ':' + t.id + ':halt'])
        h += '<button class="tt-btn small react-btn" data-ft="halt" data-log="' + escapeHtml(e.id) + '" data-tok="' + escapeHtml(t.id) + '" title="哨兵·阻拦：借机攻击命中后，目标本回合剩余时间速度变为 0">阻拦：速度 0</button>';
    return h;
}

// 记录里每个目标后面（被打的一方）：防御式决斗、介入盾牌
function featDefBtns(e, t, r, tok) {
    if (!tok || !hintOn('hintFeat') || !canReact(tok)) return '';
    var ref = e.id + ':' + t.id;
    if (logEntries.some(function(x) { return x.ref === ref; })) return '';
    var btn = function(mode, label, title) {
        return '<button class="tt-btn small react-btn" data-react="' + mode + '" data-log="' + escapeHtml(e.id) + '" data-tok="' + escapeHtml(t.id) + '" data-react-ref="' + escapeHtml(ref) + '" title="' + escapeHtml(title) + '">' + label + '</button>';
    };
    if (r.kind === 'attack' && r.melee && t.hit === 'hit' && tokenFeat(tok, 'duelist'))
        return btn('parry', '招架（防御式决斗）', '防御式决斗：持灵巧武器被近战攻击命中时用反应，AC 加熟练加值重新判定，不再命中则这次伤害和状态作废');
    if (r.kind === 'save' && r.save === 'dex' && r.half && t.saved === 'yes' && t.amount < 0 && tokenFeat(tok, 'shieldmaster'))
        return btn('interpose', '介入盾牌', '盾牌大师·介入盾牌：持盾、敏捷豁免成功本该受一半伤害时用反应，改为不受伤害');
    return '';
}

// 记录里每个目标后面（旁边的盟友）：拦截
function interceptBtns(e, t, r) {
    if (r.kind !== 'attack' || !(t.hit === 'hit' || t.hit === 'crit') || !(t.amount < 0) || !t.id || !e.id || !hintOn('hintFeat')) return '';
    var tok = scene.items[t.id], ref = e.id + ':' + t.id + ':ic';
    if (!tok || logEntries.some(function(x) { return x.ref === ref; })) return '';
    return sortedItems().filter(function(o) {
        return o.kind === 'token' && o.id !== t.id && o.id !== r.casterId && mineTok(o) && isCreatureToken(o) && tokenSide(o) === tokenSide(tok) &&
            canReact(o) && creatureDist(o, tok) <= 5 && tokenFeat(o, 'intercept');
    }).map(function(o) {
        return '<button class="tt-btn small react-btn" data-react="intercept" data-by="' + escapeHtml(o.id) + '" data-log="' + escapeHtml(e.id) + '" data-tok="' + escapeHtml(t.id) +
            '" data-react-ref="' + escapeHtml(ref) + '" title="拦截（战斗风格）：持盾或武器，5 尺内的另一个生物被命中时用反应，减伤 1d10 + 熟练加值">拦截（' + escapeHtml(chipName(o.label)) + '）</button>';
    }).join('');
}

function featClick(el) {
    var d = el.dataset, ent = logEntries.filter(function(x) { return x.id === d.log; })[0];
    if (!ent || !ent.act) return true;
    var r = ent.act, c = r.casterId && scene.items[r.casterId], tgt = d.tok && scene.items[d.tok];
    var sh = c && c.sheet && sheets[c.sheet];
    if (d.ft === 'guard') {
        masteryDone[d.log + ':guard:' + d.tok] = true;
        el.remove();
        if (c) startOA(d.tok, c.id);
        return true;
    }
    if (!c) { notice('出手的棋子不在当前场景', true); return true; }
    var t = (r.targets || []).filter(function(x) { return x.id === d.tok; })[0] || {};
    var name = String(r.name || '').replace(/（[^）]*）$/, '');
    var base = { area: { shape: '', size: 0, width: 5 }, targets: 1, reach: meleeReach(c), cost: 'b', mastery: '' };
    if (d.ft === 'pam') {
        masteryDone[d.log + ':pam'] = true;
        el.remove();
        var bonus = (r.targets || []).map(attackBonusOf).filter(function(x) { return x; })[0] || 0;
        var sa = sh && (sh.attacks || []).filter(function(x) { return x.name === name; })[0], dt = (r.targets || []).filter(function(x) { return x.damage; })[0];
        var dm = String(sa ? sa.damage || '' : dt ? dt.damage.expr || '' : '').replace(/\s/g, '').match(/([+\-]\d+)$/); // 卡上武器伤害的固定加值（不含巨武器大师等）
        openActionDialog(Object.assign(base, { name: '长柄打击（' + name + '）', kind: 'attack', attack: signed(bonus) || '+0', damage: '1d4' + (dm ? dm[1] : ''), dtype: '钝击',
            scaleNote: '长柄武器大师：用武器的另一端攻击，伤害 1d4 钝击 + 属性调整值（默认取角色卡上这把武器伤害的固定加值）' }), c, sh || null);
    } else if (d.ft === 'cleave') {
        masteryDone[d.log + ':cleave'] = true;
        el.remove();
        var e2 = JSON.parse(JSON.stringify(c.econ || {}));
        e2.gwmKey = turnKey() || ('t' + Date.now());
        patchItems([{ id: c.id, econ: e2 }]);
        var ai = sh ? (sh.attacks || []).findIndex(function(x) { return x.name === name; }) : -1;
        actPreset = { caster: c, cost: 'b', at: Date.now() };
        if (ai >= 0) castFromSheet(sh, { kind: 'atk', idx: String(ai) });
        else {
            actPreset = null;
            openActionDialog(Object.assign(base, { name: name + '（顺势斩）', kind: 'attack', attack: signed(attackBonusOf(t)) || '+0', damage: '', dtype: r.damageType || '',
                scaleNote: '顺势斩：再用这把武器攻击一次；角色卡上没找到同名攻击，伤害请自己填' }), c, sh || null);
        }
    } else if (d.ft === 'halt') {
        masteryDone[d.log + ':' + d.tok + ':halt'] = true;
        el.remove();
        if (tgt) addStatusTo(tgt, { id: 'halted', name: '阻拦', icon: '⛔', color: '#b71c1c', until: 'end' });
    }
    return true;
}

// 借机提示后面：战地施法者可以用法术代替借机攻击
function warCasterBtn(enId, moverId) {
    var en = scene.items[enId];
    if (!en || !tokenFeat(en, 'warcaster')) return '';
    return '<button class="tt-btn small" data-oaspell="' + escapeHtml(enId + ':' + moverId) + '" title="战地施法者：用反应施放一道施法时间为一个动作、只以这个生物为目标的法术，代替借机攻击">🪄 用法术</button>';
}
function warCasterClick(el) {
    var p = el.dataset.oaspell.split(':'), en = scene.items[p[0]];
    if (!en || !en.sheet || !sheets[en.sheet]) { notice('找不到施法者的角色卡', true); return true; }
    actPreset = { caster: en, targets: scene.items[p[1]] ? [p[1]] : [], cost: 'r', at: Date.now() };
    openSheet(en.sheet, en.id);
    notice('在角色卡上选一道法术（施法时间一个动作、只指定这个生物）：打开时会自动设为反应并预选目标', false, 5000);
    return true;
}

// 属性面板「专长」：幸运
function featRowHtml(it) {
    var sh = it.sheet && sheets[it.sheet];
    if (!sh || !canEdit(it) || !sheetFeat(sh, 'lucky')) return '';
    var pb = sheetProf(sh), b = hasStatus(it, 'lucky') ? '<button class="tt-btn small" disabled title="下一次攻击检定 / 豁免自动取优势">🍀 幸运已备好</button>' :
        '<button class="tt-btn small" data-act="ft-lucky" title="幸运：花一个幸运点，下一次 D20 检定具有优势（攻击、由服务器掷的豁免会自动取优势；属性检定请在掷骰框选优势）。也可以在被攻击时花一点让攻击者劣势（由 GM 处理）">🍀 幸运（' + featLeft(it, '幸运点', pb) + '）</button>';
    return '<div class="prop-row"><label>专长</label><span class="prop-btns" style="margin:0;">' + b + '</span></div>';
}
function featSelAct(act0, ids) {
    if (act0 !== 'ft-lucky') return false;
    var it = scene.items[ids[0]], sh = it && it.sheet && sheets[it.sheet];
    if (!it || !sh) return true;
    if (spendFeat(it, '幸运点', sheetProf(sh))) addStatusTo(it, { id: 'lucky', name: '幸运', icon: '🍀', color: '#66bb6a' });
    $('selPanel').dataset.ids = '';
    renderSelPanel();
    return true;
}
