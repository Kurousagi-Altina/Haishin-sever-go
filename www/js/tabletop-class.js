// 跑团桌面：职业 / 子职特性（按角色卡的职业等级和子职识别，房间设置 hintClass）
// 规则见 docs/战斗规则.md「职业特性」。只提示、不强制：按钮帮忙扣次数、挂状态、打开行动框，数值都可以改。
// 第 1 步：战士（1–20 级）、符文骑士（塔莎）、巨武器战斗、化兽者（化兽 / 迅捷）
// 依赖 tabletop.js / tabletop-sheets.js / tabletop-action.js / tabletop-fight.js 的全局状态与函数

// ===== 通用 =====
function subclassOf(sh) { return String(sh && sh.subclass || ''); }
// 子职：卡上「子职」栏，或特性 / 资源里出现子职特有的名字
function hasSub(sh, re) {
    if (!sh) return false;
    if (re.test(subclassOf(sh))) return true;
    return (sh.features || []).concat(sh.resources || []).some(function(f) { return re.test(String(f.name || '')); });
}
function clsLv(sh, cn) { return classLevel(sh, cn); }
function abilMod(sh, k) { return sheetAbilityMod(sh, k); }

// 棋子资源：按正则找（卡上导入的资源名各不相同，如「火之符文」），没有就按 name / max 新建
function cxRes(tok, re, name, max) {
    var res = JSON.parse(JSON.stringify(tok.res || [])), r = res.filter(function(x) { return re.test(String(x.name || '')); })[0];
    if (!r && max > 0) { r = { id: genId(), name: name, type: 'count', cur: max, max: max, icon: 'gem' }; res.push(r); }
    return r ? { res: res, r: r } : null;
}
function cxLeft(tok, re, name, max) { var fr = cxRes(tok, re, name, max); return fr ? num(fr.r.cur, 0) + '/' + num(fr.r.max, 0) : ''; }
function cxHas(tok, re, name, max) { var fr = cxRes(tok, re, name, max); return !fr || num(fr.r.cur, 0) > 0; }
function cxSpend(tok, re, name, max) {
    var fr = cxRes(tok, re, name, max);
    if (!fr) return true;
    if (num(fr.r.cur, 0) <= 0) { notice('「' + fr.r.name + '」已经用完了（可以在棋子资源里改次数）', true); return false; }
    fr.r.cur = num(fr.r.cur, 0) - 1;
    patchItems([{ id: tok.id, res: fr.res }]);
    notice(fr.r.name + '：剩 ' + fr.r.cur + '/' + fr.r.max);
    return true;
}
function cxBtn(act, label, title, extra) {
    return '<button class="tt-btn small" data-act="' + act + '"' + (extra || '') + ' title="' + escapeHtml(title) + '">' + label + '</button>';
}
function cxStatus(it, st) { addStatusTo(it, st); }
function cxDropStatus(it, id) { patchItems([{ id: it.id, status: statusList(it).filter(function(s) { return s.id !== id; }) }]); }
function cxRefUsed(ref) { return logEntries.some(function(x) { return x.ref === ref; }); }
function cxBase(extra) { return Object.assign({ area: { shape: '', size: 0, width: 5 }, targets: 1, cost: 'n' }, extra); }

// ===== 额外攻击：攻击动作打几下（econAfterAction 用来计数） =====
function attacksPerAction(sh) {
    if (!sh) return 1;
    var f = clsLv(sh, '战士');
    if (f >= 20) return 4;
    if (f >= 11) return 3;
    if (f >= 5) return 2;
    return sheetHasEntry(sh, /额外攻击|extraattack/i) ? 2 : 1;
}

// ===== 战士 =====
var FIGHTER = {
    indomitable: [[9, 1], [13, 2], [17, 3]]
};
var RE_WIND = /回气|secondwind/i, RE_INDOM = /不屈|indomitable/i;

// ===== 符文骑士（塔莎的万事坩埚） =====
var RUNES = [
    { key: 'fire', re: /火(?:之|焰)符文|fire\s*rune/i, name: '火焰符文', lv: 3 },
    { key: 'cloud', re: /云(?:之|雾)符文|cloud\s*rune/i, name: '云雾符文', lv: 3 },
    { key: 'frost', re: /(?:寒霜|冰霜|霜)之?符文|frost\s*rune/i, name: '寒霜符文', lv: 3 },
    { key: 'stone', re: /(?:岩石|石)之?符文|stone\s*rune/i, name: '岩石符文', lv: 3 },
    { key: 'hill', re: /(?:山丘|丘)之?符文|hill\s*rune/i, name: '山丘符文', lv: 7 },
    { key: 'storm', re: /风暴之?符文|storm\s*rune/i, name: '风暴符文', lv: 7 }
];
var RE_RK = /符文骑士|rune\s*knight/i, RE_GIANT = /巨人之力|giant'?s\s*might/i, RE_RSHIELD = /符文之盾|runic\s*shield/i;
function isRuneKnight(sh) { return hasSub(sh, RE_RK) || sheetHasEntry(sh, RE_GIANT); }
function knownRune(sh, key) {
    var r = RUNES.filter(function(x) { return x.key === key; })[0];
    return !!r && !!sh && (sh.features || []).concat(sh.resources || []).some(function(f) { return r.re.test(String(f.name || '')); });
}
function runeUses(sh) { return clsLv(sh, '战士') >= 15 ? 2 : 1; } // 15 级符文大师：每种两次
function runeDC(sh) { return 8 + sheetProf(sh) + abilMod(sh, 'con'); }
function giantDie(sh) { var f = clsLv(sh, '战士'); return f >= 18 ? '1d10' : f >= 10 ? '1d8' : '1d6'; }
function runeRes(tok, key) { var r = RUNES.filter(function(x) { return x.key === key; })[0]; return { re: r.re, name: r.name }; }

// ===== 化兽者 =====
var RE_SHIFT = /^化兽$|化兽|shifting/i, RE_SWIFT = /迅捷|swiftstride/i;
function isShifter(sh) { return !!sh && (/化兽者|shifter/i.test(String(sh.race || '')) || (sh.resources || []).some(function(r) { return /化兽/.test(r.name || ''); })); }

// ===== 属性面板「职业」行：追加的按钮 =====
function cxPanelBtns(it, sh) {
    var b = [], f = clsLv(sh, '战士'), pb = sheetProf(sh);
    if (f >= 2 && sheetHasEntry(sh, RE_WIND))
        b.push(cxBtn('cx-tmind', '🧠 战术思维', '战术思维（战士 2 级）：属性检定失败时花一次回气，掷 1d10 加到检定结果上；加上后仍然失败就不消耗（把回气加回去）'));
    if (f >= 9)
        b.push(cxBtn('cx-indom', '不屈（' + cxLeft(it, RE_INDOM, '不屈', byLevel(FIGHTER.indomitable, f)) + '）',
            '不屈（战士 9 级）：豁免失败时重掷，加上战士等级 ' + f + '，必须用新结果。服务器掷的豁免请点记录里的「不屈」按钮；这里是给自己掷的豁免用的：掷 1d20 + ' + f + '，再加上该豁免的加值'));
    if (isRuneKnight(sh)) {
        var gm = hasStatus(it, 'giantmight');
        b.push(gm ? cxBtn('cx-giantend', '结束巨人之力', '结束巨人之力，恢复原来的体型') :
            cxBtn('cx-giant', '🗿 巨人之力（' + cxLeft(it, RE_GIANT, '巨人之力', pb) + '）', '巨人之力（附赠动作，1 分钟）：体型变为大型，力量检定和力量豁免优势，每回合一次武器或徒手命中额外 ' + giantDie(sh) + '（命中后在记录里点按钮）'));
        if (!gm && it.gmSize) b.push(cxBtn('cx-giantsize', '恢复原体型', '巨人之力已经结束：把棋子缩回原来的大小'));
        var u = runeUses(sh), dc = runeDC(sh);
        if (knownRune(sh, 'frost')) b.push(hasStatus(it, 'frostrune') ? '' : cxBtn('cx-rune-frost', '❄ 寒霜符文（' + cxLeft(it, runeRes(it, 'frost').re, '寒霜符文', u) + '）', '寒霜符文（附赠动作，10 分钟）：力量和体质的检定与豁免 +2（豁免由服务器自动加）'));
        if (knownRune(sh, 'stone')) b.push(cxBtn('cx-rune-stone', '🪨 岩石符文（' + cxLeft(it, runeRes(it, 'stone').re, '岩石符文', u) + '）', '岩石符文（反应）：30 尺内你看得见的生物结束回合时，令它感知豁免（DC ' + dc + '），失败则被你魅惑 1 分钟（失能、速度 0），每回合结束重复豁免'));
        if (knownRune(sh, 'hill')) b.push(hasStatus(it, 'hillrune') ? '' : cxBtn('cx-rune-hill', '⛰ 山丘符文（' + cxLeft(it, runeRes(it, 'hill').re, '山丘符文', u) + '）', '山丘符文（附赠动作，1 分钟）：钝击、穿刺、挥砍伤害抗性'));
        if (knownRune(sh, 'storm')) b.push(hasStatus(it, 'stormrune') ? '' : cxBtn('cx-rune-storm', '🌩 风暴符文（' + cxLeft(it, runeRes(it, 'storm').re, '风暴符文', u) + '）', '风暴符文（附赠动作，1 分钟）：先知状态，60 尺内你看得见的生物做攻击、检定或豁免时，可以用反应让它具有优势或劣势（由 GM 结算）'));
    }
    if (isShifter(sh) && !hasStatus(it, 'shifted'))
        b.push(cxBtn('cx-shift', '🐾 化兽（' + cxLeft(it, RE_SHIFT, '化兽', pb) + '）', '化兽（附赠动作，1 分钟）：获得 ' + (2 * pb) + ' 点临时生命值（2 × 熟练加值）' + (sheetHasEntry(sh, RE_SWIFT) ? '；迅捷：速度 +10 尺，敌人在你 5 尺内结束回合时可以用反应移动至多 10 尺（不引发借机攻击）' : '')));
    return b.filter(Boolean);
}

function cxSelAct(act0, ids) {
    if (!/^cx-/.test(act0 || '')) return false;
    var it = scene.items[ids[0]], sh = it && it.sheet && sheets[it.sheet];
    if (!it || !sh) return true;
    var f = clsLv(sh, '战士'), pb = sheetProf(sh), dc = runeDC(sh), u = runeUses(sh);
    var rune = function(key) { var r = runeRes(it, key); return cxSpend(it, r.re, r.name, u); };
    switch (act0) {
    case 'cx-tmind':
        if (!cxSpend(it, RE_WIND, '回气', byLevel(CF.windUses, f || 1))) break;
        sheetRoll(sh, '战术思维（加到失败的属性检定上）', '1d10');
        notice('战术思维：把 1d10 加到刚才失败的属性检定上；加上后仍然失败的话，回气不消耗（在棋子资源里加回 1）', false, 6000);
        break;
    case 'cx-indom':
        if (!cxSpend(it, RE_INDOM, '不屈', byLevel(FIGHTER.indomitable, f))) break;
        sheetRoll(sh, '不屈：重掷豁免（再加该豁免的加值）', '1d20+' + f);
        break;
    case 'cx-giant':
        if (!cxSpend(it, RE_GIANT, '巨人之力', pb)) break;
        var patch = { id: it.id };
        var fp = num(it.fp, 0) || (it.w || gridSize()) / gridSize();
        if (fp < 2) { // 变为大型：棋子放大到 2×2，中心不动；记下原来的大小，结束时恢复
            var g = gridSize(), w0 = it.w || g, h0 = it.h || g;
            patch.gmSize = { w: w0, h: h0, fp: it.fp || null };
            patch.fp = 2; patch.w = 2 * g; patch.h = 2 * g;
            patch.x = r1((it.x || 0) - (2 * g - w0) / 2); patch.y = r1((it.y || 0) - (2 * g - h0) / 2);
        }
        patch.status = statusList(it).filter(function(s) { return s.id !== 'giantmight'; }).concat([{ id: 'giantmight', name: '巨人之力', icon: '🗿', color: '#8d6e63', rounds: 10, die: giantDie(sh) }]);
        patchItems([patch]);
        econAfterAction({ cost: 'b' }, it);
        notice('巨人之力：变为大型，力量检定 / 豁免优势；每回合一次武器命中后在记录里点「巨人之力 +' + giantDie(sh) + '」' + (f >= 18 ? '（18 级可以改为巨型、触及 +5 尺，请手动调整）' : ''), false, 6000);
        break;
    case 'cx-giantend':
        giantRestore(it, true);
        break;
    case 'cx-giantsize':
        giantRestore(it, false);
        break;
    case 'cx-rune-frost':
        if (!rune('frost')) break;
        cxStatus(it, { id: 'frostrune', name: '寒霜符文', icon: '❄', color: '#81d4fa', rounds: 100 });
        econAfterAction({ cost: 'b' }, it);
        notice('寒霜符文：10 分钟内力量和体质的检定与豁免 +2（豁免自动加；自己掷检定时记得 +2）');
        break;
    case 'cx-rune-stone':
        if (!rune('stone')) break;
        openActionDialog(cxBase({ name: '岩石符文', kind: 'save', save: 'wis', dc: dc, status: 'charmed', repeatSave: true, rounds: 10, range: 30, cost: 'r',
            scaleNote: '岩石符文：失败则被你魅惑 1 分钟——陷入恍惚，失能且速度为 0；每个回合结束重复豁免。DC = 8 + 熟练 ' + pb + ' + 体质 ' + signed(abilMod(sh, 'con')) }), it, sh);
        break;
    case 'cx-rune-hill':
        if (!rune('hill')) break;
        cxStatus(it, { id: 'hillrune', name: '山丘符文', icon: '⛰', color: '#a1887f', rounds: 10, resist: ['钝击', '穿刺', '挥砍'] });
        econAfterAction({ cost: 'b' }, it);
        notice('山丘符文：1 分钟内钝击、穿刺、挥砍伤害抗性（自动结算）');
        break;
    case 'cx-rune-storm':
        if (!rune('storm')) break;
        cxStatus(it, { id: 'stormrune', name: '风暴符文', icon: '🌩', color: '#9575cd', rounds: 10 });
        econAfterAction({ cost: 'b' }, it);
        notice('风暴符文：1 分钟内，60 尺内你看得见的生物做攻击、检定或豁免时，可以用反应让它具有优势或劣势（告诉 GM）', false, 6000);
        break;
    case 'cx-shift':
        if (!cxSpend(it, RE_SHIFT, '化兽', pb)) break;
        var temp = 2 * pb, p2 = { id: it.id, status: statusList(it).filter(function(s) { return s.id !== 'shifted'; }).concat([{ id: 'shifted', name: '化兽', icon: '🐾', color: '#a1887f', rounds: 10, swift: sheetHasEntry(sh, RE_SWIFT) || undefined }]) };
        if (num(it.hpTemp, 0) < temp) p2.hpTemp = temp;
        patchItems([p2]);
        econAfterAction({ cost: 'b' }, it);
        notice('化兽：临时生命值 ' + temp + (num(it.hpTemp, 0) >= temp ? '（已有的临时生命更多，保留原来的）' : '') + (p2.status.slice(-1)[0].swift ? '；迅捷：速度 +10 尺' : ''));
        break;
    }
    $('selPanel').dataset.ids = '';
    renderSelPanel();
    renderCombatHud();
    return true;
}

function giantRestore(it, endStatus) {
    var patch = { id: it.id };
    if (endStatus) patch.status = statusList(it).filter(function(s) { return s.id !== 'giantmight'; });
    var o = it.gmSize;
    if (o) {
        patch.w = o.w; patch.h = o.h; patch.fp = o.fp || null; patch.gmSize = null;
        patch.x = r1((it.x || 0) + ((it.w || 0) - o.w) / 2); patch.y = r1((it.y || 0) + ((it.h || 0) - o.h) / 2);
    }
    patchItems([patch]);
}

// ===== 记录里的按钮 =====
// 出手的一方：巨人之力加伤（每回合一次）、火焰符文、究明攻击（13 级，失手后）
// 被打的一方：不屈（服务器掷的豁免失败）
// 旁边的符文骑士：符文之盾（让攻击者重掷）、云雾符文（把命中改给别人）
function cxTargetBtns(e, t, r) {
    if (!t.id || !e.id || !hintOn('hintClass')) return '';
    var h = '', tok = scene.items[t.id], c = r.casterId && scene.items[r.casterId], csh = c && c.sheet && sheets[c.sheet];
    var hit = t.hit === 'hit' || t.hit === 'crit', mine = me.gm || e.who === me.name;
    var btn = function(kind, label, title, attrs) {
        return '<button class="tt-btn small react-btn" data-cx="' + kind + '" data-log="' + escapeHtml(e.id) + '" data-tok="' + escapeHtml(t.id) + '"' + (attrs || '') + ' title="' + escapeHtml(title) + '">' + label + '</button>';
    };
    if (r.kind === 'attack' && c && csh && mine && !r.spell) {
        var weapon = !/法术|戏法/.test(r.name || '');
        if (hit && weapon && hasStatus(c, 'giantmight') && !masteryDone[e.id + ':gm'] && !(c.econ && c.econ.gmKey && c.econ.gmKey === turnKey()))
            h += btn('giant', '巨人之力 +' + giantDie(csh), '巨人之力：每回合一次，武器或徒手命中时额外 ' + giantDie(csh) + ' 伤害（与武器同类型）');
        if (hit && weapon && knownRune(csh, 'fire') && !masteryDone[e.id + ':' + t.id + ':fire'] && cxHas(c, runeRes(c, 'fire').re, '火焰符文', runeUses(csh)))
            h += btn('fire', '🔥 火焰符文', '火焰符文：武器命中后发动——目标力量豁免（DC ' + runeDC(csh) + '），失败则被火焰镣铐束缚 1 分钟，每回合开始受到 2d6 火焰伤害，每回合结束重复豁免');
        if (t.hit === 'miss' && clsLv(csh, '战士') >= 13 && !masteryDone[e.id + ':' + t.id + ':study'])
            h += btn('study', '究明攻击', '究明攻击（战士 13 级）：攻击失手后，直到你下个回合结束，你对这个生物的下一次攻击具有优势');
    }
    if (tok && r.kind === 'save' && t.saved === 'no' && (me.gm || (tok.owner && tok.owner === me.name))) {
        var tsh = tok.sheet && sheets[tok.sheet], fl = clsLv(tsh, '战士');
        if (fl >= 9 && !cxRefUsed(e.id + ':' + t.id + ':ind') && cxHas(tok, RE_INDOM, '不屈', byLevel(FIGHTER.indomitable, fl)))
            h += btn('indom', '不屈（重掷 +' + fl + '）', '不屈（战士 9 级）：由服务器重掷这次豁免并加战士等级 ' + fl + '，成功则重新结算伤害和状态（必须用新结果）', ' data-react-ref="' + escapeHtml(e.id + ':' + t.id + ':ind') + '"');
    }
    if (tok && r.kind === 'attack' && hit) {
        sortedItems().forEach(function(o) {
            var osh = o.kind === 'token' && o.sheet && sheets[o.sheet];
            if (!osh || !mineTok(o) || !isCreatureToken(o) || !canReact(o) || o.id === r.casterId || !isRuneKnight(osh)) return;
            var d = o.id === tok.id ? 0 : creatureDist(o, tok);
            if (o.id !== tok.id && clsLv(osh, '战士') >= 7 && d <= 60 && !cxRefUsed(e.id + ':' + t.id + ':rs') && cxHas(o, RE_RSHIELD, '符文之盾', sheetProf(osh)))
                h += btn('rshield', '符文之盾（' + escapeHtml(chipName(o.label)) + '）', '符文之盾（反应）：让攻击者重掷 d20 并采用新结果；不再命中则这次伤害和状态作废', ' data-by="' + escapeHtml(o.id) + '" data-react-ref="' + escapeHtml(e.id + ':' + t.id + ':rs') + '"');
            if (knownRune(osh, 'cloud') && d <= 30 && !cxRefUsed(e.id + ':' + t.id + ':cr') && cxHas(o, runeRes(o, 'cloud').re, '云雾符文', runeUses(osh)))
                h += btn('cloud', '☁ 云雾符文（' + escapeHtml(chipName(o.label)) + '）', '云雾符文（反应）：你或 30 尺内的生物被攻击命中时，把这次攻击改给你 30 尺内另一个生物（攻击者除外），用同一个命中值', ' data-by="' + escapeHtml(o.id) + '" data-react-ref="' + escapeHtml(e.id + ':' + t.id + ':cr') + '"');
        });
    }
    return h;
}

function cxClick(el) {
    var d = el.dataset, ent = logEntries.filter(function(x) { return x.id === d.log; })[0];
    if (!ent || !ent.act) return true;
    var r = ent.act, c = r.casterId && scene.items[r.casterId], csh = c && c.sheet && sheets[c.sheet], tgt = scene.items[d.tok];
    switch (d.cx) {
    case 'giant':
        if (!c || !tgt) { notice('出手的棋子或目标不在当前场景', true); return true; }
        masteryDone[d.log + ':gm'] = true;
        el.remove();
        var e2 = JSON.parse(JSON.stringify(c.econ || {}));
        e2.gmKey = turnKey() || ('t' + Date.now());
        patchItems([{ id: c.id, econ: e2 }]);
        openActionDialog(cxBase({ name: '巨人之力（' + r.name + '）', kind: 'auto', damage: giantDie(csh), dtype: r.damageType || '',
            scaleNote: '巨人之力：每回合一次额外伤害，与武器同类型（重击时请自己把骰子翻倍）' }), c, csh || null);
        act.presetTargets = [tgt.id];
        break;
    case 'fire':
        if (!c || !tgt) { notice('出手的棋子或目标不在当前场景', true); return true; }
        var fr = runeRes(c, 'fire');
        if (!cxSpend(c, fr.re, fr.name, runeUses(csh))) return true;
        masteryDone[d.log + ':' + d.tok + ':fire'] = true;
        el.remove();
        openActionDialog(cxBase({ name: '火焰符文', kind: 'save', save: 'str', dc: runeDC(csh), status: 'restrained', repeatSave: true, dot: '2d6 火焰', rounds: 10,
            scaleNote: '火焰符文：失败则被火焰镣铐束缚 1 分钟，每回合开始受到 2d6 火焰伤害，每回合结束重复力量豁免。DC = 8 + 熟练 ' + sheetProf(csh) + ' + 体质 ' + signed(abilMod(csh, 'con')) }), c, csh);
        act.presetTargets = [tgt.id];
        break;
    case 'study':
        if (!c || !tgt) return true;
        masteryDone[d.log + ':' + d.tok + ':study'] = true;
        el.remove();
        addStatusTo(c, { id: 'vex', name: '究明攻击', icon: '🎯', color: '#ffb74d', vs: tgt.id, vsName: tgt.label || '', rounds: 2 });
        notice('究明攻击：直到你下个回合结束，对「' + (tgt.label || '') + '」的下一次攻击具有优势（自动计入）');
        break;
    case 'indom':
        if (!tgt) return true;
        var tsh = tgt.sheet && sheets[tgt.sheet];
        if (!cxSpend(tgt, RE_INDOM, '不屈', byLevel(FIGHTER.indomitable, clsLv(tsh, '战士')))) return true;
        el.disabled = true;
        op({ op: 'action.react', text: d.log, target: d.tok, mode: 'indomitable' });
        break;
    case 'rshield':
        var by = scene.items[d.by], bsh = by && by.sheet && sheets[by.sheet];
        if (!by || !cxSpend(by, RE_RSHIELD, '符文之盾', sheetProf(bsh))) return true;
        el.disabled = true;
        op({ op: 'action.react', text: d.log, target: d.tok, mode: 'runeshield', ids: [d.by] });
        break;
    case 'cloud':
        cloudPick(el, d);
        break;
    }
    return true;
}

// 云雾符文：选一个新目标（符文骑士 30 尺内，攻击者和原目标除外）
function cloudPick(el, d) {
    var by = scene.items[d.by], ent = logEntries.filter(function(x) { return x.id === d.log; })[0];
    if (!by || !ent) return;
    var list = sortedItems().filter(function(o) {
        return o.kind === 'token' && isCreatureToken(o) && o.id !== d.tok && o.id !== ent.act.casterId && seeable(o) && creatureDist(by, o) <= 30 &&
            !hasStatus(o, 'dead') && !(o.hpMax > 0 && num(o.hp, o.hpMax) <= 0);
    });
    if (!list.length) { notice('符文骑士 30 尺内没有可以改成的目标', true); return; }
    var old = document.getElementById('cxPick');
    if (old) old.remove();
    var box = document.createElement('div'), rc = el.getBoundingClientRect();
    box.id = 'cxPick';
    box.style.cssText = 'position:fixed;z-index:9999;left:' + Math.round(rc.left) + 'px;top:' + Math.round(rc.bottom + 4) + 'px;background:#22252c;border:1px solid #555;border-radius:8px;padding:6px;display:flex;flex-wrap:wrap;gap:4px;max-width:320px;';
    box.innerHTML = '<span class="tt-hint" style="width:100%;">改给谁（同一个命中值）：</span>' + list.map(function(o) {
        return '<button class="tt-btn small" data-pick="' + escapeHtml(o.id) + '">' + escapeHtml(o.label || '未命名') + '</button>';
    }).join('') + '<button class="tt-btn small" data-pick="">取消</button>';
    box.addEventListener('click', function(ev) {
        var b = ev.target.closest('[data-pick]');
        if (!b) return;
        box.remove();
        if (!b.dataset.pick) return;
        var bsh = by.sheet && sheets[by.sheet], rr = runeRes(by, 'cloud');
        if (!cxSpend(by, rr.re, rr.name, runeUses(bsh))) return;
        el.disabled = true;
        op({ op: 'action.react', text: d.log, target: d.tok, mode: 'cloud', ids: [d.by, b.dataset.pick] });
    });
    document.body.appendChild(box);
}

// ===== 行动框：巨武器战斗（双手近战武器，伤害骰掷出 1 或 2 按 3 算） =====
var RE_GWF = /巨武器战斗|great\s*weapon\s*fighting/i;
function gwfSync(a, caster, sh) {
    var lab = $('acGwfWrap');
    if (!lab) return false;
    lab.style.display = 'none';
    $('acGwf').checked = false;
    var s = sh || (caster && caster.sheet && sheets[caster.sheet]);
    if (!caster || a.kind !== 'attack' || a.isSpell || a.gwfAdded || !s || !hintOn('hintFeat') || !sheetHasEntry(s, RE_GWF)) return false;
    var props = String(a.props || ''), melee = !(a.range > 0) || a.reach > 0;
    if (!melee || !/双手|多用|two-?handed|versatile/i.test(props)) return false;
    $('acGwf').checked = /双手|two-?handed/i.test(props); // 多用武器默认不勾（双手握持时自己勾上）
    lab.style.display = '';
    return true;
}
function gwfApply(a) {
    if (!$('acGwfWrap') || $('acGwfWrap').style.display === 'none' || !$('acGwf').checked || a.gwfAdded) return;
    var mi = function(s) { return String(s || '').replace(/(\d*d\d+)(?![\dmr!k])/gi, '$1mi3'); };
    a.damage = mi(a.damage);
    (a.parts || []).forEach(function(p) { p.dice = mi(p.dice); });
    a.gwfAdded = true;
}

// ===== 角色卡：子职 =====
function classHeadHtml(sh, edit) {
    var raw = sheets[sh.id] || sh;
    if (raw.kind !== 'pc' || !edit) return '';
    return '<div class="lobby-row" style="gap:6px;"><span class="tt-hint">子职</span><input class="tt-input" data-sheetsub="' + escapeHtml(raw.id) + '" value="' + escapeHtml(raw.subclass || '') +
        '" placeholder="如 符文骑士、星辰结社" style="max-width:160px;" title="职业特性按这里的子职识别（导入的人物卡没写时可以手动填）"></div>';
}

function initClassFeats() {
    $('sheetPane').addEventListener('change', function(e) {
        var id = e.target.dataset && e.target.dataset.sheetsub;
        if (!id || !sheets[id]) return;
        op({ op: 'sheet', sheet: { id: id, subclass: e.target.value.trim() || null } });
        notice('子职已改为「' + (e.target.value.trim() || '（空）') + '」');
    });
}
