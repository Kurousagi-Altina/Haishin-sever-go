// 跑团桌面：职业 / 子职特性（按角色卡的职业等级和子职识别，房间设置 hintClass）
// 规则见 docs/战斗规则.md「职业特性」。只提示、不强制：按钮帮忙扣次数、挂状态、打开行动框，数值都可以改。
// 第 1 步：战士（1–20 级）、符文骑士（塔莎）、巨武器战斗、化兽者（化兽 / 迅捷）
// 第 2 步：武僧（1–20 级，功力点 / 武艺骰）、四象武者
// 第 3–6 步：牧师·战争领域 + 龙裔、德鲁伊·星辰结社、法师·预言师、奇械师·魔炮师 + 战俑（服务器）
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
    var b = [], f = clsLv(sh, '战士'), pb = sheetProf(sh), F = clsOn('hcFighter');
    if (F && f >= 2 && sheetHasEntry(sh, RE_WIND))
        b.push(cxBtn('cx-tmind', '🧠 战术思维', '战术思维（战士 2 级）：属性检定失败时花一次回气，掷 1d10 加到检定结果上；加上后仍然失败就不消耗（把回气加回去）'));
    if (F && f >= 9)
        b.push(cxBtn('cx-indom', '不屈（' + cxLeft(it, RE_INDOM, '不屈', byLevel(FIGHTER.indomitable, f)) + '）',
            '不屈（战士 9 级）：豁免失败时重掷，加上战士等级 ' + f + '，必须用新结果。服务器掷的豁免请点记录里的「不屈」按钮；这里是给自己掷的豁免用的：掷 1d20 + ' + f + '，再加上该豁免的加值'));
    if (F && isRuneKnight(sh)) {
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
    if (hintOn('hintRace') && isShifter(sh) && !hasStatus(it, 'shifted'))
        b.push(cxBtn('cx-shift', '🐾 化兽（' + cxLeft(it, RE_SHIFT, '化兽', pb) + '）', '化兽（附赠动作，1 分钟）：获得 ' + (2 * pb) + ' 点临时生命值（2 × 熟练加值）' + (sheetHasEntry(sh, RE_SWIFT) ? '；迅捷：速度 +10 尺，敌人在你 5 尺内结束回合时可以用反应移动至多 10 尺（不引发借机攻击）' : '')));
    b = b.concat(monkPanelBtns(it, sh), casterPanelBtns(it, sh));
    return b.filter(Boolean);
}

function cxSelAct(act0, ids) {
    if (!/^cx-/.test(act0 || '')) return false;
    var it = scene.items[ids[0]], sh = it && it.sheet && sheets[it.sheet];
    if (!it || !sh) return true;
    var f = clsLv(sh, '战士'), pb = sheetProf(sh), dc = runeDC(sh), u = runeUses(sh);
    var rune = function(key) { var r = runeRes(it, key); return cxSpend(it, r.re, r.name, u); };
    if (monkSelAct(act0, it, sh) || casterSelAct(act0, it, sh)) act0 = ''; // 武僧 / 施法职业（下面的 switch 不再处理）
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
    if (clsOn('hcFighter') && r.kind === 'attack' && c && csh && mine && !r.spell) {
        var weapon = !/法术|戏法/.test(r.name || '');
        if (hit && weapon && hasStatus(c, 'giantmight') && !masteryDone[e.id + ':gm'] && !(c.econ && c.econ.gmKey && c.econ.gmKey === turnKey()))
            h += btn('giant', '巨人之力 +' + giantDie(csh), '巨人之力：每回合一次，武器或徒手命中时额外 ' + giantDie(csh) + ' 伤害（与武器同类型）');
        if (hit && weapon && knownRune(csh, 'fire') && !masteryDone[e.id + ':' + t.id + ':fire'] && cxHas(c, runeRes(c, 'fire').re, '火焰符文', runeUses(csh)))
            h += btn('fire', '🔥 火焰符文', '火焰符文：武器命中后发动——目标力量豁免（DC ' + runeDC(csh) + '），失败则被火焰镣铐束缚 1 分钟，每回合开始受到 2d6 火焰伤害，每回合结束重复豁免');
        if (t.hit === 'miss' && clsLv(csh, '战士') >= 13 && !masteryDone[e.id + ':' + t.id + ':study'])
            h += btn('study', '究明攻击', '究明攻击（战士 13 级）：攻击失手后，直到你下个回合结束，你对这个生物的下一次攻击具有优势');
    }
    if (clsOn('hcFighter') && tok && r.kind === 'save' && t.saved === 'no' && (me.gm || (tok.owner && tok.owner === me.name))) {
        var tsh = tok.sheet && sheets[tok.sheet], fl = clsLv(tsh, '战士');
        if (fl >= 9 && !cxRefUsed(e.id + ':' + t.id + ':ind') && cxHas(tok, RE_INDOM, '不屈', byLevel(FIGHTER.indomitable, fl)))
            h += btn('indom', '不屈（重掷 +' + fl + '）', '不屈（战士 9 级）：由服务器重掷这次豁免并加战士等级 ' + fl + '，成功则重新结算伤害和状态（必须用新结果）', ' data-react-ref="' + escapeHtml(e.id + ':' + t.id + ':ind') + '"');
    }
    if (tok && r.kind === 'attack' && hit) {
        sortedItems().forEach(function(o) {
            var osh = o.kind === 'token' && o.sheet && sheets[o.sheet];
            if (!clsOn('hcFighter') || !osh || !mineTok(o) || !isCreatureToken(o) || !canReact(o) || o.id === r.casterId || !isRuneKnight(osh)) return;
            var d = o.id === tok.id ? 0 : creatureDist(o, tok);
            if (o.id !== tok.id && clsLv(osh, '战士') >= 7 && d <= 60 && !cxRefUsed(e.id + ':' + t.id + ':rs') && cxHas(o, RE_RSHIELD, '符文之盾', sheetProf(osh)))
                h += btn('rshield', '符文之盾（' + escapeHtml(chipName(o.label)) + '）', '符文之盾（反应）：让攻击者重掷 d20 并采用新结果；不再命中则这次伤害和状态作废', ' data-by="' + escapeHtml(o.id) + '" data-react-ref="' + escapeHtml(e.id + ':' + t.id + ':rs') + '"');
            if (knownRune(osh, 'cloud') && d <= 30 && !cxRefUsed(e.id + ':' + t.id + ':cr') && cxHas(o, runeRes(o, 'cloud').re, '云雾符文', runeUses(osh)))
                h += btn('cloud', '☁ 云雾符文（' + escapeHtml(chipName(o.label)) + '）', '云雾符文（反应）：你或 30 尺内的生物被攻击命中时，把这次攻击改给你 30 尺内另一个生物（攻击者除外），用同一个命中值', ' data-by="' + escapeHtml(o.id) + '" data-react-ref="' + escapeHtml(e.id + ':' + t.id + ':cr') + '"');
        });
    }
    return h + monkTargetBtns(e, t, r) + casterTargetBtns(e, t, r);
}

function cxClick(el) {
    var d = el.dataset, ent = logEntries.filter(function(x) { return x.id === d.log; })[0];
    if (!ent || !ent.act) return true;
    if (/^mk/.test(d.cx)) return monkClick(el, d);
    if (/^cc/.test(d.cx)) return casterClick(el, d);
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

// ===== 武僧（2024 玩家手册）+ 四象武者 =====
var MONK_DIE = [[1, '1d6'], [5, '1d8'], [11, '1d10'], [17, '1d12']];
var RE_FOCUS = /功力|focus\s*point|ki\s*point/i, RE_META = /运转周天|uncanny\s*metabolism/i, RE_WOE = /四象武者|warrior\s*of\s*the\s*elements|元素同调/i;
var ELEM_TYPES = ['强酸', '寒冷', '火焰', '闪电', '雷鸣'];
function monkLv(sh) { return clsLv(sh, '武僧'); }
function maDie(sh) { return byLevel(MONK_DIE, Math.max(1, monkLv(sh))); }
function maDice(sh, n) { var d = maDie(sh).split('d'); return n + 'd' + d[1]; }
function monkDC(sh) { return 8 + abilMod(sh, 'wis') + sheetProf(sh); }
function focusMax(sh) { return monkLv(sh) >= 2 ? monkLv(sh) : 0; }
function focusCur(it, sh) { var fr = cxRes(it, RE_FOCUS, '功力', focusMax(sh)); return fr ? num(fr.r.cur, 0) : 0; }
function spendFocus(it, sh, n) {
    var fr = cxRes(it, RE_FOCUS, '功力', focusMax(sh));
    if (!fr) return true;
    if (num(fr.r.cur, 0) < n) { notice('功力不够：需要 ' + n + '，剩 ' + num(fr.r.cur, 0) + '（可以在棋子资源里改）', true); return false; }
    fr.r.cur = num(fr.r.cur, 0) - n;
    patchItems([{ id: it.id, res: fr.res }]);
    notice('功力：剩 ' + fr.r.cur + '/' + fr.r.max);
    return true;
}
function setFocus(it, sh, v) {
    var fr = cxRes(it, RE_FOCUS, '功力', focusMax(sh));
    if (!fr) return;
    fr.r.cur = Math.min(num(fr.r.max, 0), v);
    patchItems([{ id: it.id, res: fr.res }]);
}
function isWoE(sh) { return hasSub(sh, RE_WOE); }
function isUnarmedAct(r) { return /徒手/.test(String(r && r.name || '')); }
function stdStatus(id, extra) { var d = STATUS_BY_ID[id] || {}; return Object.assign({ id: id, name: d.name || id, icon: d.icon, color: d.color }, extra || {}); }

// 徒手打击：卡上有「徒手」攻击就用它，否则按武艺骰 + 敏捷 / 力量（取高）
function monkUnarmed(it, sh, cost, note) {
    var ui = sh ? (sh.attacks || []).findIndex(function(x) { return /徒手/.test(x.name || ''); }) : -1;
    if (ui >= 0) { actPreset = { caster: it, cost: cost, at: Date.now() }; castFromSheet(sh, { kind: 'atk', idx: String(ui) }); }
    else {
        var m = Math.max(abilMod(sh, 'str'), abilMod(sh, 'dex')), pb = sheetProf(sh);
        openActionDialog(cxBase({ name: '徒手打击', kind: 'attack', attack: signed(m + pb) || '+0', damage: maDie(sh) + signed(m), dtype: '钝击', reach: 5, cost: cost,
            scaleNote: '武艺：伤害 = 武艺骰 ' + maDie(sh) + ' + 敏捷或力量调整值（取高）' }), it, sh);
    }
    if (note) notice(note, false, 5000);
}

function monkPanelBtns(it, sh) {
    var lv = monkLv(sh), b = [];
    if (!lv || !clsOn('hcMonk')) return b;
    var fm = focusMax(sh), fl = fm ? '（功力 ' + cxLeft(it, RE_FOCUS, '功力', fm) + '）' : '';
    b.push(cxBtn('cx-mk-ma', '👊 武艺', '武艺：执行攻击动作后，可以用附赠动作进行一次徒手打击（伤害用武艺骰 ' + maDie(sh) + '）'));
    if (lv >= 2) {
        b.push(cxBtn('cx-mk-flurry', '疾风连击' + fl, '疾风连击（1 功力，附赠动作）：连续进行 ' + (lv >= 10 ? 3 : 2) + ' 次徒手打击（打开攻击条，逐次结算）'));
        b.push(cxBtn('cx-mk-patient', '🛡 坚强防御', '坚强防御（1 功力，附赠动作）：同时撤离和闪避' + (lv >= 10 ? '，并获得两颗武艺骰的临时生命值' : '') + '。不花功力只撤离：点「附赠撤离」'));
        b.push(cxBtn('cx-mk-step', '💨 疾步如风', '疾步如风（1 功力，附赠动作）：同时撤离和疾走，本回合跳跃距离翻倍。不花功力只疾走：点「附赠疾走」'));
        b.push(cxBtn('cx-mk-dis', '附赠撤离', '坚强防御（不花功力）：用附赠动作撤离'));
        b.push(cxBtn('cx-mk-dash', '附赠疾走', '疾步如风（不花功力）：用附赠动作疾走（本回合速度翻倍）'));
        var metaOk = cxHas(it, RE_META, '运转周天', 1);
        if (metaOk) b.push(cxBtn('cx-mk-meta', '☯ 运转周天（' + cxLeft(it, RE_META, '运转周天', 1) + '）', '运转周天（投先攻时，每长休一次）：功力全部恢复，并恢复 ' + maDie(sh) + ' + 武僧等级 ' + lv + ' 点生命值'));
        else if (lv >= 15) b.push(cxBtn('cx-mk-perfect', '明镜止水', '明镜止水（15 级）：投先攻且没有用运转周天时，功力不超过 3 点就恢复到 4 点'));
    }
    if (lv >= 18 && !hasStatus(it, 'superior')) b.push(cxBtn('cx-mk-superior', '无懈可击（3 功力）', '无懈可击（18 级，回合开始时）：1 分钟内对力场以外的所有伤害具有抗性（失能时结束）'));
    if (isWoE(sh) && lv >= 3) {
        b.push(hasStatus(it, 'attuned') ? cxBtn('cx-mk-attuneend', '结束元素同调', '结束元素同调') :
            cxBtn('cx-mk-attune', '🌀 元素同调（1 功力）', '元素同调（回合开始时，10 分钟）：徒手打击触及 +10 尺，伤害类型可以改为强酸 / 寒冷 / 火焰 / 闪电 / 雷鸣；命中时可以令目标力量豁免，失败则把它拉近或推开 10 尺' +
                (lv >= 11 ? '；四象遁术：获得等同步行速度的飞行和游泳速度' : '') + (lv >= 17 ? '；四象神通：选一种元素伤害抗性，疾步如风速度 +20 尺，每回合一次徒手命中额外一颗武艺骰' : '')));
        if (lv >= 6) b.push(cxBtn('cx-mk-burst', '💥 元素爆破拳（2 功力）', '元素爆破拳（魔法动作，2 功力）：120 尺内一点为中心的 20 尺球，敏捷豁免（DC ' + monkDC(sh) + '），失败受到 ' + maDice(sh, 3) + ' 所选元素伤害，成功减半'));
    }
    return b;
}

function monkSelAct(act0, it, sh) {
    if (!/^cx-mk-/.test(act0)) return false;
    var lv = monkLv(sh), dc = monkDC(sh);
    switch (act0) {
    case 'cx-mk-ma':
        monkUnarmed(it, sh, 'b', '武艺：附赠动作的徒手打击');
        break;
    case 'cx-mk-flurry':
        if (!spendFocus(it, sh, 1)) break;
        econAfterAction({ cost: 'b' }, it);
        var n = lv >= 10 ? 3 : 2, ui = (sh.attacks || []).findIndex(function(x) { return /徒手/.test(x.name || ''); });
        multi = { sheet: sh.id, name: it.label || sh.name || '', title: '疾风连击', plan: [ui >= 0 ? { name: sh.attacks[ui].name, atk: ui, left: n, cost: 'n', caster: it.id } : { name: '徒手打击', unarmed: true, left: n, cost: 'n', caster: it.id }] };
        renderMultiBar();
        notice('疾风连击：' + n + ' 次徒手打击，在上方攻击条里逐次点开结算（附赠动作已记上）', false, 5000);
        break;
    case 'cx-mk-patient':
        if (!spendFocus(it, sh, 1)) break;
        patchItems([{ id: it.id, status: statusList(it).filter(function(s) { return s.id !== 'disengaged' && s.id !== 'dodging'; }).concat([stdStatus('disengaged'), stdStatus('dodging')]) }]);
        econAfterAction({ cost: 'b' }, it);
        if (lv >= 10) {
            openActionDialog(cxBase({ name: '坚强防御（临时生命）', kind: 'temp', damage: maDice(sh, 2), scaleNote: '出神入化：坚强防御时获得两颗武艺骰的临时生命值' }), it, sh);
            act.presetTargets = [it.id];
        }
        notice('坚强防御：撤离 + 闪避（闪避到你下个回合开始）');
        break;
    case 'cx-mk-step':
        if (!spendFocus(it, sh, 1)) break;
        patchItems([{ id: it.id, status: statusList(it).filter(function(s) { return s.id !== 'disengaged' && s.id !== 'dashed'; }).concat([stdStatus('disengaged'), { id: 'dashed', name: '疾走', icon: '💨', color: '#4dd0e1', until: 'end' }]) }]);
        econAfterAction({ cost: 'b' }, it);
        notice('疾步如风：撤离 + 疾走（本回合速度翻倍），跳跃距离翻倍' + (lv >= 10 ? '；出神入化：可以带上 5 尺内一名体型不大于大型的自愿生物同行' : ''));
        break;
    case 'cx-mk-dis':
        addStatusTo(it, stdStatus('disengaged'));
        econAfterAction({ cost: 'b' }, it);
        break;
    case 'cx-mk-dash':
        addStatusTo(it, { id: 'dashed', name: '疾走', icon: '💨', color: '#4dd0e1', until: 'end' });
        econAfterAction({ cost: 'b' }, it);
        notice('疾走：本回合速度翻倍');
        break;
    case 'cx-mk-meta':
        if (!cxSpend(it, RE_META, '运转周天', 1)) break;
        setFocus(it, sh, focusMax(sh));
        openActionDialog(cxBase({ name: '运转周天', kind: 'heal', damage: maDie(sh) + '+' + lv, scaleNote: '运转周天：功力已全部恢复；生命恢复 武艺骰 + 武僧等级' }), it, sh);
        act.presetTargets = [it.id];
        break;
    case 'cx-mk-perfect':
        if (focusCur(it, sh) <= 3) { setFocus(it, sh, 4); notice('明镜止水：功力恢复到 4 点'); } else notice('功力多于 3 点，明镜止水不生效');
        break;
    case 'cx-mk-superior':
        if (!spendFocus(it, sh, 3)) break;
        cxStatus(it, { id: 'superior', name: '无懈可击', icon: '🛡', color: '#ffd54f', rounds: 10, resist: DMG_TYPES.split('|').filter(function(t) { return t !== '力场' && t !== '暗蚀'; }) });
        notice('无懈可击：1 分钟内对力场以外的所有伤害具有抗性（自动结算；失能时请手动移除）');
        break;
    case 'cx-mk-attune':
        if (!spendFocus(it, sh, 1)) break;
        cxStatus(it, { id: 'attuned', name: '元素同调', icon: '🌀', color: '#4fc3f7', rounds: 100 });
        notice('元素同调：徒手打击触及 +10 尺（行动框自动加），伤害类型可以改成元素；命中后记录里有「元素同调：推 / 拉」', false, 5000);
        break;
    case 'cx-mk-attuneend':
        cxDropStatus(it, 'attuned');
        break;
    case 'cx-mk-burst':
        if (!spendFocus(it, sh, 2)) break;
        openActionDialog(cxBase({ name: '元素爆破拳', kind: 'save', save: 'dex', dc: dc, half: true, damage: maDice(sh, 3), dtype: '火焰', range: 120, cost: 'a',
            area: { shape: 'circle', size: 20, width: 5, self: false }, scaleNote: '元素爆破拳：伤害类型可以改为强酸 / 寒冷 / 火焰 / 闪电 / 雷鸣。DC = 8 + 感知 ' + signed(abilMod(sh, 'wis')) + ' + 熟练 ' + sheetProf(sh) }), it, sh);
        break;
    }
    return true;
}

// 记录按钮：震慑拳 / 元素同调推拉 / 四象神通（出手方）、圆融自在（被打方）、拨挡攻击反弹
function monkTargetBtns(e, t, r) {
    if (!clsOn('hcMonk')) return '';
    var h = '', tok = scene.items[t.id], c = r.casterId && scene.items[r.casterId], csh = c && c.sheet && sheets[c.sheet];
    var hit = t.hit === 'hit' || t.hit === 'crit', mine = me.gm || e.who === me.name;
    var btn = function(kind, label, title, attrs) {
        return '<button class="tt-btn small react-btn" data-cx="' + kind + '" data-log="' + escapeHtml(e.id) + '" data-tok="' + escapeHtml(t.id) + '"' + (attrs || '') + ' title="' + escapeHtml(title) + '">' + label + '</button>';
    };
    var clv = monkLv(csh), tk = turnKey();
    if (r.kind === 'attack' && hit && mine && c && clv && !r.spell) {
        if (clv >= 5 && !masteryDone[e.id + ':stun'] && !(c.econ && c.econ.stunKey && c.econ.stunKey === tk) && focusCur(c, csh) >= 1)
            h += btn('mkstun', '震慑拳（1 功力）', '震慑拳（每回合一次）：目标体质豁免（DC ' + monkDC(csh) + '），失败则震慑到你下个回合开始；成功则速度减半，下一次对它的攻击具有优势');
        if (isUnarmedAct(r) && hasStatus(c, 'attuned')) {
            if (!masteryDone[e.id + ':' + t.id + ':pull'])
                h += btn('mkpull', '元素同调：推 / 拉', '元素同调：令目标力量豁免（DC ' + monkDC(csh) + '），失败则把它拉近或推开至多 10 尺');
            if (clv >= 17 && !masteryDone[e.id + ':epit'] && !(c.econ && c.econ.epKey && c.econ.epKey === tk))
                h += btn('mkepit', '四象神通 +' + maDie(csh), '四象神通（每回合一次）：元素同调中徒手命中，额外一颗武艺骰的所选元素伤害');
        }
    }
    if (r.kind === 'save' && /^元素同调（推拉）/.test(r.name || '') && (t.saved === 'no' || t.saved === 'auto') && mine && r.casterId && !masteryDone[e.id + ':' + t.id + ':moved'])
        h += btn('mkpush', '推开 10 尺', '把目标从你身边推开 10 尺', ' data-ft2="10"') + btn('mkpush', '拉近 10 尺', '把目标往你这边拉近 10 尺', ' data-ft2="-10"');
    if (tok && (me.gm || (tok.owner && tok.owner === me.name))) {
        var tsh = tok.sheet && sheets[tok.sheet], tlv = monkLv(tsh);
        if (r.kind === 'save' && t.saved === 'no' && tlv >= 14 && focusCur(tok, tsh) >= 1 && !cxRefUsed(e.id + ':' + t.id + ':dsc'))
            h += btn('mkdisc', '圆融自在（1 功力重掷）', '圆融自在（14 级）：豁免失败时花 1 功力重掷，必须用新结果（由服务器重掷并重新结算）', ' data-react-ref="' + escapeHtml(e.id + ':' + t.id + ':dsc') + '"');
        if (r.kind === 'react' && /^拨挡攻击/.test(r.name || '') && /→ 0/.test(t.note || '') && tlv >= 3 && focusCur(tok, tsh) >= 1 && !masteryDone[e.id + ':redirect'])
            h += btn('mkredir', '反弹（1 功力）', '拨挡攻击把伤害减到 0 时，花 1 功力把攻击反弹给 5 尺内（远程攻击则 60 尺内）你看得见的一个生物：敏捷豁免（DC ' + monkDC(tsh) + '），失败受到两颗武艺骰 + 敏捷调整值的伤害（与原攻击同类型）');
    }
    return h;
}

function monkClick(el, d) {
    var ent = logEntries.filter(function(x) { return x.id === d.log; })[0];
    if (!ent || !ent.act) return true;
    var r = ent.act, c = r.casterId && scene.items[r.casterId], csh = c && c.sheet && sheets[c.sheet], tgt = scene.items[d.tok];
    var once = function(key, ek) {
        masteryDone[key] = true;
        el.remove();
        if (ek && c) { var e2 = JSON.parse(JSON.stringify(c.econ || {})); e2[ek] = turnKey() || ('t' + Date.now()); patchItems([{ id: c.id, econ: e2 }]); }
    };
    switch (d.cx) {
    case 'mkstun':
        if (!c || !tgt || !spendFocus(c, csh, 1)) return true;
        once(d.log + ':stun', 'stunKey');
        openActionDialog(cxBase({ name: '震慑拳', kind: 'save', save: 'con', dc: monkDC(csh), status: 'stunned', rounds: 1,
            scaleNote: '震慑拳：失败则震慑到你下个回合开始（按 1 轮算）。成功：它速度减半，你们下一次对它的攻击具有优势——请手动处理（可以挂「缓速」或给优势）' }), c, csh);
        act.presetTargets = [tgt.id];
        break;
    case 'mkpull':
        if (!c || !tgt) return true;
        once(d.log + ':' + d.tok + ':pull');
        openActionDialog(cxBase({ name: '元素同调（推拉）', kind: 'save', save: 'str', dc: monkDC(csh), casterId: c.id,
            scaleNote: '元素同调：失败则可以把目标拉近或推开至多 10 尺（结算后在记录里点「推开 / 拉近 10 尺」）' }), c, csh);
        act.presetTargets = [tgt.id];
        break;
    case 'mkepit':
        if (!c || !tgt) return true;
        once(d.log + ':epit', 'epKey');
        openActionDialog(cxBase({ name: '四象神通（' + r.name + '）', kind: 'auto', damage: maDie(csh), dtype: ELEM_TYPES.indexOf(r.damageType) >= 0 ? r.damageType : '火焰',
            scaleNote: '四象神通：额外一颗武艺骰，伤害类型选元素' }), c, csh);
        act.presetTargets = [tgt.id];
        break;
    case 'mkpush':
        masteryDone[d.log + ':' + d.tok + ':moved'] = true;
        el.parentNode && el.parentNode.querySelectorAll('[data-cx="mkpush"]').forEach(function(x) { x.remove(); });
        pushToken(d.tok, r.casterId, parseInt(d.ft2, 10) || 10);
        break;
    case 'mkdisc':
        var tsh = tgt && tgt.sheet && sheets[tgt.sheet];
        if (!tgt || !spendFocus(tgt, tsh, 1)) return true;
        el.disabled = true;
        op({ op: 'action.react', text: d.log, target: d.tok, mode: 'disciplined' });
        break;
    case 'mkredir':
        var monk = tgt, msh = monk && monk.sheet && sheets[monk.sheet];
        var orig = logEntries.filter(function(x) { return x.id === String(ent.ref || '').split(':')[0]; })[0];
        if (!monk || !spendFocus(monk, msh, 1)) return true;
        masteryDone[d.log + ':redirect'] = true;
        el.remove();
        var src = orig && orig.act, att = src && src.casterId && scene.items[src.casterId];
        openActionDialog(cxBase({ name: '拨挡攻击·反弹', kind: 'save', save: 'dex', dc: monkDC(msh), damage: maDice(msh, 2) + signed(abilMod(msh, 'dex')), dtype: src && src.damageType || '',
            range: src && src.melee ? 0 : 60, reach: src && src.melee ? 5 : 0,
            scaleNote: '反弹：目标在 5 尺内（远程攻击则 60 尺内）；伤害 = 两颗武艺骰 + 敏捷调整值，与原攻击同类型' }), monk, msh);
        if (att) act.presetTargets = [att.id];
        break;
    }
    return true;
}

// 行动框：元素同调中的徒手打击触及 +10；真力注拳提示
function cxDialogSync(a, caster, sh) {
    var s = sh || (caster && caster.sheet && sheets[caster.sheet]);
    if (!caster || !s || a.kind !== 'attack' || !clsOn('hcMonk') || !isUnarmedAct(a)) return;
    var lv = monkLv(s), notes = [];
    if (hasStatus(caster, 'attuned') && !a.attunedReach) {
        a.reach = Math.max(5, a.reach || 5) + 10;
        a.attunedReach = true;
        notes.push('元素同调：触及 +10 尺（' + a.reach + ' 尺），伤害类型可以改为强酸 / 寒冷 / 火焰 / 闪电 / 雷鸣');
    }
    if (lv >= 6) notes.push('真力注拳：伤害类型可以改为力场');
    if (notes.length) $('acScaleNote').textContent = [a.scaleNote || ''].concat(notes).filter(Boolean).join('；');
}

// ===== 共用：施法 DC、「强力施法」、命中加伤 =====
function spellDCOf(sh) { var c = sheetCasting(sh); return c ? parseInt(c.dc, 10) || 0 : 8 + sheetProf(sh) + abilMod(sh, 'wis'); }
function onceBtnUsed(c, key) { return !!(c && c.econ && c.econ[key] && c.econ[key] === turnKey()); }
function markOnce(c, key) { var e2 = JSON.parse(JSON.stringify(c.econ || {})); e2[key] = turnKey() || ('t' + Date.now()); patchItems([{ id: c.id, econ: e2 }]); }
function openSheetPreset(it, sh, preset, msg) {
    actPreset = Object.assign({ caster: it, at: Date.now() }, preset);
    openSheet(sh.id, it.id);
    if (msg) notice(msg, false, 6000);
}
var RE_POTENT = /强力施法|potent\s*spellcasting/i;

// ===== 牧师（2024）+ 战争领域 =====
var CD_USES = [[2, 2], [6, 3], [18, 4]], SPARK_DICE = [[1, '1d8'], [7, '2d8'], [13, '3d8'], [18, '4d8']];
var RE_CD = /引导神力|channel\s*divinity/i, RE_WARPRIEST = /战争祭司|war\s*priest/i, RE_WARDOM = /战争领域|war\s*domain|导引打击|guided\s*strike/i;
var RE_DIVINT = /神圣干预|divine\s*intervention/i, RE_DSTRIKE = /神圣打击|divine\s*strike/i;
function clericLv(sh) { return clsLv(sh, '牧师'); }
function isWarDomain(sh) { return hasSub(sh, RE_WARDOM); }
function cdMax(sh) { return byLevel(CD_USES, Math.max(2, clericLv(sh))); }
function cdHas(it, sh) { return cxHas(it, RE_CD, '引导神力', cdMax(sh)); }
function divineStrike(sh) { return clericLv(sh) >= 7 && !sheetHasEntry(sh, RE_POTENT) ? (clericLv(sh) >= 14 ? '2d8' : '1d8') : ''; }

// ===== 龙裔 =====
var DRAGON_TYPES = [['黑龙', '强酸'], ['蓝龙', '闪电'], ['黄铜', '火焰'], ['青铜', '闪电'], ['赤铜', '强酸'], ['铜龙', '强酸'], ['金龙', '火焰'], ['绿龙', '毒素'], ['红龙', '火焰'], ['银龙', '寒冷'], ['白龙', '寒冷']];
var RE_BREATH = /吐息武器|breath\s*weapon/i, RE_DFLIGHT = /龙族飞翼|draconic\s*flight/i;
function isDragonborn(sh) { return /龙裔|dragonborn/i.test(String(sh && sh.race || '')); }
function breathType(sh) { var r = String(sh.race || ''); for (var i = 0; i < DRAGON_TYPES.length; i++) if (r.indexOf(DRAGON_TYPES[i][0]) >= 0) return DRAGON_TYPES[i][1]; return '火焰'; }
function breathDice(sh) { var lv = parseInt(sh.level, 10) || 1; return lv >= 17 ? '4d10' : lv >= 11 ? '3d10' : lv >= 5 ? '2d10' : '1d10'; }

// ===== 德鲁伊（2024）+ 星辰结社 =====
var WS_USES = [[2, 2], [6, 3], [17, 4]];
var RE_WS = /荒野变形|wild\s*shape/i, RE_STARS = /星辰结社|circle\s*of\s*(?:the\s*)?stars|星图|星耀形态|starry\s*form/i, RE_STARBOLT = /免费光导箭|星图/i;
var RE_PRIMAL = /原力蛮击|primal\s*strike/i, RE_OMEN = /宇宙预兆|cosmic\s*omen/i, RE_RESURGE = /荒野复苏|wild\s*resurgence/i;
var STARRY = { archer: ['射手', '🏹'], chalice: ['圣杯', '🏆'], dragon: ['巨龙', '🐉'] };
function druidLv(sh) { return clsLv(sh, '德鲁伊'); }
function wsMax(sh) { return byLevel(WS_USES, Math.max(2, druidLv(sh))); }
function isStars(sh) { return hasSub(sh, RE_STARS); }
function primalStrike(sh) { return druidLv(sh) >= 7 && sheetHasEntry(sh, RE_PRIMAL) ? (druidLv(sh) >= 15 ? '2d8' : '1d8') : ''; }
function starryOf(it) { return statusList(it).filter(function(s) { return s.id === 'starry'; })[0] || null; }
function starDie(sh) { return druidLv(sh) >= 10 ? '2d8' : '1d8'; }
function starryStatus(sh, form) {
    var st = { id: 'starry', name: '星耀形态·' + STARRY[form][0], icon: STARRY[form][1], color: '#b39ddb', rounds: 100, form: form };
    if (druidLv(sh) >= 14) st.resist = ['钝击', '穿刺', '挥砍']; // 灿若繁星
    return st;
}

// ===== 法师（2024）+ 预言师 =====
var RE_DIVINER = /预言师|预言学派|diviner|school\s*of\s*divination|预兆|portent/i, RE_AREC = /奥术回想|arcane\s*recovery/i, RE_EYE = /天眼通|third\s*eye/i, RE_SIG = /招牌法术|signature\s*spells/i;
function wizLv(sh) { return clsLv(sh, '法师'); }
function isDiviner(sh) { return hasSub(sh, RE_DIVINER); }

// ===== 奇械师（艾伯伦：奇械锻炉）+ 魔炮师 =====
var RE_ARTILLERIST = /魔炮师|artillerist|魔能炮台|eldritch\s*cannon/i, RE_FLASH = /灵光一闪|flash\s*of\s*genius/i;
function artLv(sh) { return clsLv(sh, '奇械师'); }
function isArtillerist(sh) { return hasSub(sh, RE_ARTILLERIST); }

function casterPanelBtns(it, sh) {
    var b = [], pb = sheetProf(sh), wis = abilMod(sh, 'wis');
    var CL = clsOn('hcCleric'), DR = clsOn('hcDruid'), WZ = clsOn('hcWizard'), AR = clsOn('hcArtificer'), RACE = hintOn('hintRace');
    // 牧师
    var cl = clericLv(sh);
    if (CL && cl >= 2) {
        var cdl = '（引导 ' + cxLeft(it, RE_CD, '引导神力', cdMax(sh)) + '）', sd = byLevel(SPARK_DICE, cl);
        b.push(cxBtn('cx-cl-spark', '✨ 神圣火花' + cdl, '神圣火花（魔法动作，1 次引导神力）：30 尺内一个生物体质豁免（DC ' + spellDCOf(sh) + '），失败受到 ' + sd + signed(wis) + ' 光耀或黯蚀伤害，成功减半'));
        b.push(cxBtn('cx-cl-sparkheal', '神圣火花·治疗', '神圣火花（魔法动作，1 次引导神力）：30 尺内一个生物恢复 ' + sd + signed(wis) + ' 生命值'));
        b.push(cxBtn('cx-cl-turn', '☀ 驱散亡灵', '驱散亡灵（魔法动作，1 次引导神力）：30 尺内你选择的亡灵感知豁免，失败则恐慌并失能 1 分钟（受到伤害时结束）' + (cl >= 5 ? '；灼净亡灵：失败的亡灵还受到 ' + Math.max(1, wis) + 'd8 光耀伤害' : '')));
    }
    if (CL && cl >= 3 && isWarDomain(sh)) {
        b.push(cxBtn('cx-cl-priest', '⚔ 战争祭司（' + cxLeft(it, RE_WARPRIEST, '战争祭司', Math.max(1, wis)) + '）', '战争祭司（附赠动作）：进行一次武器攻击或徒手打击。点了打开角色卡，下一次攻击自动设为附赠动作'));
        if (cl >= 6) b.push(cxBtn('cx-cl-blessing', '战神祝福', '战神祝福（1 次引导神力）：免费施放虔诚护盾或灵体武器，不需要专注，持续 1 分钟。点了打开角色卡，下一次施法不扣法术位、不专注'));
    }
    if (CL && cl >= 10) b.push(cxBtn('cx-cl-interv', '神圣干预（' + cxLeft(it, RE_DIVINT, '神圣干预', 1) + '）', '神圣干预（魔法动作，每长休一次）：免费施放一道五环或以下、不是反应的牧师法术，不需要成分。点了打开角色卡，下一次施法不扣法术位'));
    // 龙裔
    if (RACE && isDragonborn(sh)) {
        b.push(cxBtn('cx-db-breath', '🐉 吐息武器（' + cxLeft(it, RE_BREATH, '吐息武器', pb) + '）', '吐息武器（代替攻击动作中的一次攻击）：15 尺锥形或 30 尺长 5 尺宽的直线，敏捷豁免（DC ' + (8 + abilMod(sh, 'con') + pb) + '），失败受到 ' + breathDice(sh) + ' ' + breathType(sh) + '伤害，成功减半'));
        if ((parseInt(sh.level, 10) || 1) >= 5 && !hasStatus(it, 'dflight')) b.push(cxBtn('cx-db-flight', '龙族飞翼（' + cxLeft(it, RE_DFLIGHT, '龙族飞翼', 1) + '）', '龙族飞翼（附赠动作，10 分钟，每长休一次）：长出翅膀，获得等同步行速度的飞行速度'));
    }
    // 德鲁伊
    var dl = druidLv(sh);
    if (DR && dl >= 2) {
        var wsl = '（' + cxLeft(it, RE_WS, '荒野变形', wsMax(sh)) + '）', star = starryOf(it);
        if (hasStatus(it, 'wildshape')) b.push(cxBtn('cx-dr-wsend', '结束荒野变形', '结束荒野变形（临时生命值不会自动去掉）'));
        else if (!star) b.push(cxBtn('cx-dr-ws', '🐾 荒野变形' + wsl, '荒野变形（附赠动作，' + Math.max(1, Math.floor(dl / 2)) + ' 小时）：变成已知的野兽形态，获得 ' + dl + ' 点临时生命值。野兽的数值请用棋子的「变形」功能换上'));
        b.push(cxBtn('cx-dr-companion', '荒野伙伴', '荒野伙伴（魔法动作）：花一次荒野变形（或一个法术位）施放寻获魔宠（妖精），长休后消失。点了扣一次荒野变形并打开「新建随从」'));
        if (dl >= 5) {
            if (!cxHas(it, RE_WS, '荒野变形', wsMax(sh))) b.push(cxBtn('cx-dr-res1', '复苏：法术位换变形', '荒野复苏（每回合一次）：没有荒野变形次数时，花一个法术位恢复一次'));
            else b.push(cxBtn('cx-dr-res2', '复苏：变形换一环位（' + cxLeft(it, RE_RESURGE, '荒野复苏', 1) + '）', '荒野复苏（每长休一次）：花一次荒野变形，恢复一个一环法术位'));
        }
        if (dl >= 3 && isStars(sh)) {
            b.push(cxBtn('cx-dr-starbolt', '🌟 星图·光导箭（' + cxLeft(it, RE_STARBOLT, '免费光导箭', Math.max(1, wis)) + '）', '星图：免费施放光导箭（不扣法术位），次数 = 感知调整值，长休恢复'));
            if (!star) Object.keys(STARRY).forEach(function(k) {
                b.push(cxBtn('cx-dr-star-' + k, STARRY[k][1] + ' 星耀·' + STARRY[k][0] + wsl, {
                    archer: '射手座：变身时和之后每回合的附赠动作，对 60 尺内一个生物进行远程法术攻击，命中造成 ' + starDie(sh) + ' + 感知调整值 光耀伤害',
                    chalice: '圣杯座：用法术位施放治疗法术时，你或 30 尺内另一个生物额外恢复 ' + starDie(sh) + ' + 感知调整值 生命值（治疗结算后记录里有按钮）',
                    dragon: '巨龙座：智力 / 感知检定和维持专注的体质豁免，d20 掷出 9 或更低都视为 10（专注豁免自动生效）' + (dl >= 10 ? '；获得 20 尺飞行速度并可悬浮' : '')
                }[k] + '。星耀形态（附赠动作，花一次荒野变形，10 分钟）' + (dl >= 14 ? '；灿若繁星：期间钝击 / 穿刺 / 挥砍抗性' : '')));
            });
            else {
                if (star.form === 'archer') b.push(cxBtn('cx-dr-arrow', '🏹 射手光箭', '附赠动作：对 60 尺内一个生物远程法术攻击，命中 ' + starDie(sh) + ' + 感知调整值 光耀伤害'));
                if (dl >= 10) Object.keys(STARRY).forEach(function(k) { if (k !== star.form) b.push(cxBtn('cx-dr-swap-' + k, '→' + STARRY[k][0], '闪烁星座：每回合开始时可以换成别的星座')); });
                b.push(cxBtn('cx-dr-starend', '结束星耀形态', '结束星耀形态'));
            }
            if (dl >= 6) {
                var oml = '（' + cxLeft(it, RE_OMEN, '宇宙预兆', Math.max(1, wis)) + '）';
                b.push(cxBtn('cx-dr-weal', '🔮 吉兆 +1d6' + oml, '宇宙预兆（反应）：长休后掷出偶数时，30 尺内你看得见的生物做 D20 检定时加 1d6'));
                b.push(cxBtn('cx-dr-woe', '凶兆 −1d6', '宇宙预兆（反应）：长休后掷出奇数时，30 尺内你看得见的生物做 D20 检定时减 1d6'));
            }
        }
    }
    // 法师
    var wl = wizLv(sh);
    if (WZ && wl >= 1 && sheetHasEntry(sh, RE_AREC)) b.push(cxBtn('cx-wz-recover', '📖 奥术回想（' + cxLeft(it, RE_AREC, '奥术回想', 1) + '）', '奥术回想（短休时，每长休一次）：恢复总环阶不超过 ' + Math.ceil(wl / 2) + ' 的法术位（不能恢复六环或更高）。点了按从高到低自动恢复，可以在角色卡上调整'));
    if (WZ && wl >= 3 && isDiviner(sh)) {
        var pv = (it.portent || []).map(function(v) { return num(v, 0); });
        if (pv.length) {
            b.push('<span class="tt-hint" title="预兆：每回合可以用一个替换你或看得见的生物的 d20 检定（服务器掷的豁免 / 攻击在记录里点「预兆 N」）">🔮 预兆</span>');
            pv.forEach(function(v, i) { b.push(cxBtn('cx-wz-use-' + i, '用 ' + v, '把这个预兆用在一次自己掷的检定上（从预兆里去掉，并在记录里写一句）')); });
        }
        b.push(cxBtn('cx-wz-portent', pv.length ? '重掷预兆' : '🔮 掷预兆', '预兆（长休后）：掷 ' + (wl >= 14 ? 3 : 2) + ' 枚 d20 记下来，由服务器掷'));
        if (wl >= 10 && !hasStatus(it, 'thirdeye')) b.push(cxBtn('cx-wz-eye', '天眼通（' + cxLeft(it, RE_EYE, '天眼通', 1) + '）', '天眼通（附赠动作，直到休息）：120 尺黑暗视觉 / 读懂任何语言 / 看见隐形，三选一'));
    }
    if (WZ && wl >= 20) b.push(cxBtn('cx-wz-sig', '招牌法术（' + cxLeft(it, RE_SIG, '招牌法术', 2) + '）', '招牌法术：两道三环法术各可免费以三环施放一次（短休恢复）。点了打开角色卡，下一次施法不扣法术位'));
    // 奇械师
    var al = artLv(sh);
    if (AR && al >= 3 && isArtillerist(sh)) b.push(cxBtn('cx-ar-cannon', '🔧 魔能炮台', '魔能炮台（魔法动作，每长休一次或花一个法术位）：打开「新建随从」，模板选好魔能炮台、主控是你'));
    if (AR && al >= 7) b.push(cxBtn('cx-ar-flash', '💡 灵光一闪（' + cxLeft(it, RE_FLASH, '灵光一闪', Math.max(1, abilMod(sh, 'int'))) + '）', '灵光一闪（反应）：你或 30 尺内看得见的生物属性检定或豁免失败时，加上你的智力调整值 ' + signed(Math.max(1, abilMod(sh, 'int'))) + '。服务器掷的豁免请点记录里的按钮；这里给自己掷的检定用'));
    return b;
}

function casterSelAct(act0, it, sh) {
    if (!/^cx-(cl|db|dr|wz|ar)-/.test(act0)) return false;
    var pb = sheetProf(sh), wis = abilMod(sh, 'wis'), cl = clericLv(sh), dl = druidLv(sh), wl = wizLv(sh);
    var star = function(form) {
        if (!cxSpend(it, RE_WS, '荒野变形', wsMax(sh))) return;
        addStatusTo(it, starryStatus(sh, form));
        econAfterAction({ cost: 'b' }, it);
        if (form === 'archer') starArrow(it, sh, 'n');
        else notice('星耀形态·' + STARRY[form][0] + '：10 分钟' + (form === 'dragon' ? '；专注豁免的 d20 至少按 10 算（自动）' : '；用法术位施放治疗法术后，记录里有「圣杯」按钮'), false, 5000);
    };
    var m;
    if ((m = act0.match(/^cx-wz-use-(\d+)$/))) { portentUse(it, +m[1]); return true; }
    if ((m = act0.match(/^cx-dr-star-(\w+)$/))) { star(m[1]); return true; }
    if ((m = act0.match(/^cx-dr-swap-(\w+)$/))) { addStatusTo(it, starryStatus(sh, m[1])); notice('闪烁星座：换成' + STARRY[m[1]][0] + '座'); return true; }
    switch (act0) {
    case 'cx-cl-spark':
    case 'cx-cl-sparkheal':
        if (!cxSpend(it, RE_CD, '引导神力', cdMax(sh))) break;
        var sd = byLevel(SPARK_DICE, cl) + signed(wis);
        openActionDialog(cxBase(act0 === 'cx-cl-spark' ? { name: '神圣火花', kind: 'save', save: 'con', dc: spellDCOf(sh), half: true, damage: sd, dtype: '光耀', range: 30, cost: 'a', magic: true,
            scaleNote: '神圣火花：伤害类型可以改为黯蚀；要治疗请改用「神圣火花·治疗」' } : { name: '神圣火花（治疗）', kind: 'heal', damage: sd, range: 30, cost: 'a', scaleNote: '神圣火花：治疗 30 尺内一个生物' }), it, sh);
        break;
    case 'cx-cl-turn':
        if (!cxSpend(it, RE_CD, '引导神力', cdMax(sh))) break;
        openActionDialog(cxBase({ name: '驱散亡灵', kind: 'save', save: 'wis', dc: spellDCOf(sh), status: 'frightened', rounds: 10, cost: 'a', magic: true,
            damage: cl >= 5 ? Math.max(1, wis) + 'd8' : '', dtype: cl >= 5 ? '光耀' : '', half: false,
            area: { shape: 'circle', size: 30, width: 5, self: true },
            scaleNote: '驱散亡灵：只选亡灵；失败则恐慌并失能 1 分钟（受到伤害时结束，请手动移除）' + (cl >= 5 ? '；灼净亡灵：失败的还受到光耀伤害（成功不受伤）' : '') }), it, sh);
        break;
    case 'cx-cl-priest':
        if (!cxSpend(it, RE_WARPRIEST, '战争祭司', Math.max(1, wis))) break;
        openSheetPreset(it, sh, { cost: 'b' }, '战争祭司：在角色卡上点一把武器的 ⚡，自动设为附赠动作（3 分钟内有效）');
        break;
    case 'cx-cl-blessing':
        if (!cxSpend(it, RE_CD, '引导神力', cdMax(sh))) break;
        openSheetPreset(it, sh, { noConc: true, noSlot: true }, '战神祝福：在角色卡上施放虔诚护盾或灵体武器——不扣法术位、不需要专注，持续 1 分钟');
        break;
    case 'cx-cl-interv':
        if (!cxSpend(it, RE_DIVINT, '神圣干预', 1)) break;
        openSheetPreset(it, sh, { noSlot: true }, '神圣干预：在角色卡上选一道五环或以下、不是反应的牧师法术，不扣法术位');
        break;
    case 'cx-db-breath':
        if (!cxSpend(it, RE_BREATH, '吐息武器', pb)) break;
        openActionDialog(cxBase({ name: '吐息武器', kind: 'save', save: 'dex', dc: 8 + abilMod(sh, 'con') + pb, half: true, damage: breathDice(sh), dtype: breathType(sh), cost: 'a',
            area: { shape: 'cone', size: 15, width: 5, self: true }, scaleNote: '吐息武器：可以把范围改成 30 尺长、5 尺宽的直线；代替攻击动作中的一次攻击。DC = 8 + 体质 ' + signed(abilMod(sh, 'con')) + ' + 熟练 ' + pb }), it, sh);
        break;
    case 'cx-db-flight':
        if (!cxSpend(it, RE_DFLIGHT, '龙族飞翼', 1)) break;
        addStatusTo(it, { id: 'dflight', name: '龙族飞翼', icon: '🪽', color: '#ffb74d', rounds: 100 });
        econAfterAction({ cost: 'b' }, it);
        notice('龙族飞翼：10 分钟内获得等同步行速度的飞行速度');
        break;
    case 'cx-dr-ws':
        if (!cxSpend(it, RE_WS, '荒野变形', wsMax(sh))) break;
        var p = { id: it.id, status: statusList(it).filter(function(s) { return s.id !== 'wildshape'; }).concat([{ id: 'wildshape', name: '荒野变形', icon: '🐾', color: '#81c784' }]) };
        if (num(it.hpTemp, 0) < dl) p.hpTemp = dl;
        patchItems([p]);
        econAfterAction({ cost: 'b' }, it);
        notice('荒野变形：临时生命值 ' + dl + '；野兽形态的数值请用棋子的「变形」功能换上', false, 5000);
        break;
    case 'cx-dr-wsend':
        cxDropStatus(it, 'wildshape');
        break;
    case 'cx-dr-companion':
        if (!cxSpend(it, RE_WS, '荒野变形', wsMax(sh))) break;
        openNewSummon(sh, 'blank', '荒野伙伴：魔宠是妖精，长休后消失。从图鉴导入一只魔宠（猫头鹰、猫等）后在卡上「设为随从」更方便；也可以用空白随从');
        break;
    case 'cx-dr-res1':
        spendSlotAtLeast(it, 1);
        var fr = cxRes(it, RE_WS, '荒野变形', wsMax(sh));
        if (fr) { fr.r.cur = Math.min(num(fr.r.max, 0), num(fr.r.cur, 0) + 1); patchItems([{ id: it.id, res: fr.res }]); notice('荒野复苏：恢复一次荒野变形'); }
        break;
    case 'cx-dr-res2':
        if (!cxHas(it, RE_RESURGE, '荒野复苏', 1)) { notice('荒野复苏（换法术位）每长休只能用一次', true); break; }
        if (!cxSpend(it, RE_WS, '荒野变形', wsMax(sh))) break;
        cxSpend(it, RE_RESURGE, '荒野复苏', 1);
        var s1 = slotOf(sh, 1);
        if (s1) { changeSlot(sh, s1.idx, 1); notice('荒野复苏：恢复一个一环法术位'); } else notice('角色卡上没有一环法术位，请手动调整', true);
        break;
    case 'cx-dr-starbolt':
        if (!cxSpend(it, RE_STARBOLT, '免费光导箭', Math.max(1, wis))) break;
        var gi = (sh.spells || []).findIndex(function(s) { return /光导箭|guiding\s*bolt/i.test(s.name || ''); });
        actPreset = { caster: it, noSlot: true, at: Date.now() };
        if (gi >= 0) castFromSheet(sh, { kind: 'spell', idx: String(gi) });
        else { actPreset = null; openActionDialog(cxBase({ name: '光导箭（星图）', kind: 'attack', attack: normBonus((sheetCasting(sh) || {}).atk) || '+0', damage: '4d6', dtype: '光耀', range: 120, cost: 'a', magic: true, isSpell: true,
            scaleNote: '光导箭：命中后，下一次对它的攻击检定具有优势（在你下回合结束前）' }), it, sh); }
        break;
    case 'cx-dr-arrow':
        starArrow(it, sh, 'b');
        break;
    case 'cx-dr-starend':
        cxDropStatus(it, 'starry');
        break;
    case 'cx-dr-weal':
    case 'cx-dr-woe':
        if (!cxSpend(it, RE_OMEN, '宇宙预兆', Math.max(1, wis))) break;
        sheetRoll(sh, act0 === 'cx-dr-weal' ? '宇宙预兆·吉兆（加到 D20 检定上）' : '宇宙预兆·凶兆（从 D20 检定里减去）', '1d6');
        econAfterAction({ cost: 'r' }, it);
        break;
    case 'cx-wz-recover':
        if (!cxSpend(it, RE_AREC, '奥术回想', 1)) break;
        var budget = Math.ceil(wl / 2), got = [];
        for (var lv = Math.min(5, budget); lv >= 1; lv--) {
            var s = slotOf(sh, lv);
            while (s && budget >= lv && s.cur < s.max) { changeSlot(sh, s.idx, 1); budget -= lv; got.push(lv + '环'); s = slotOf(sh, lv); }
        }
        notice(got.length ? '奥术回想：恢复了 ' + got.join('、') + '（可以在角色卡上调整）' : '没有可以恢复的法术位（用掉的都高于预算）', !got.length, 5000);
        break;
    case 'cx-wz-portent':
        op({ op: 'fight.portent', ids: [it.id] });
        break;
    case 'cx-wz-eye':
        if (!cxSpend(it, RE_EYE, '天眼通', 1)) break;
        addStatusTo(it, { id: 'thirdeye', name: '天眼通', icon: '👁', color: '#9575cd' });
        econAfterAction({ cost: 'b' }, it);
        notice('天眼通：选一项生效到下次休息——120 尺黑暗视觉 / 读懂任何语言 / 看见隐形（告诉 GM）');
        break;
    case 'cx-wz-sig':
        if (!cxSpend(it, RE_SIG, '招牌法术', 2)) break;
        openSheetPreset(it, sh, { noSlot: true }, '招牌法术：在角色卡上以三环施放你的招牌法术，不扣法术位');
        break;
    case 'cx-ar-cannon':
        openNewSummon(sh, 'cannon', '魔能炮台：每长休一次，或花一个一环以上的法术位再造一门');
        break;
    case 'cx-ar-flash':
        if (!cxSpend(it, RE_FLASH, '灵光一闪', Math.max(1, abilMod(sh, 'int')))) break;
        econAfterAction({ cost: 'r' }, it);
        notice('灵光一闪：把 ' + signed(Math.max(1, abilMod(sh, 'int'))) + ' 加到刚才失败的检定 / 豁免上', false, 5000);
        break;
    }
    return true;
}

function starArrow(it, sh, cost) {
    var c = sheetCasting(sh) || {};
    openActionDialog(cxBase({ name: '星耀·射手光箭', kind: 'attack', attack: normBonus(c.atk) || '+0', damage: starDie(sh) + signed(abilMod(sh, 'wis')), dtype: '光耀', range: 60, cost: cost, magic: true,
        scaleNote: '射手座：远程法术攻击，60 尺，命中 ' + starDie(sh) + ' + 感知调整值 光耀伤害' }), it, sh);
}

function openNewSummon(sh, tpl, msg) {
    sheetView = { mode: 'newsummon', back: { mode: 'list' } };
    switchPane('sheets');
    renderSheets();
    if ($('smTpl')) $('smTpl').value = tpl;
    if ($('smMaster')) $('smMaster').value = sh.id;
    if (msg) notice(msg, false, 6000);
}

// 记录按钮：导引打击（失手）、神圣打击 / 原力蛮击（命中，每回合一次）、圣杯（治疗后）、预兆（替换 d20）、灵光一闪（豁免失败）
function casterTargetBtns(e, t, r) {
    var h = '', tok = scene.items[t.id], c = r.casterId && scene.items[r.casterId], csh = c && c.sheet && sheets[c.sheet];
    var hit = t.hit === 'hit' || t.hit === 'crit', mine = me.gm || e.who === me.name;
    var btn = function(kind, label, title, attrs) {
        return '<button class="tt-btn small react-btn" data-cx="' + kind + '" data-log="' + escapeHtml(e.id) + '" data-tok="' + escapeHtml(t.id) + '"' + (attrs || '') + ' title="' + escapeHtml(title) + '">' + label + '</button>';
    };
    if (r.kind === 'attack' && hit && mine && c && csh && !r.spell) {
        var ds = clsOn('hcCleric') ? divineStrike(csh) : '', ps = clsOn('hcDruid') ? primalStrike(csh) : '';
        if (ds && !masteryDone[e.id + ':ds'] && !onceBtnUsed(c, 'dsKey')) h += btn('ccds', '神圣打击 +' + ds, '受祝击·神圣打击（每回合一次）：武器命中额外 ' + ds + ' 光耀或黯蚀伤害');
        if (ps && !masteryDone[e.id + ':ps'] && !onceBtnUsed(c, 'psKey')) h += btn('ccps', '原力蛮击 +' + ps, '元素之怒·原力蛮击（每回合一次）：武器或野兽形态攻击命中额外 ' + ps + ' 寒冷 / 火焰 / 闪电 / 雷鸣伤害');
    }
    if (clsOn('hcDruid') && r.kind === 'heal' && r.slotLevel > 0 && mine && c && csh && (starryOf(c) || {}).form === 'chalice' && !masteryDone[e.id + ':chalice'])
        h += btn('ccchal', '圣杯：再治疗一人', '星耀·圣杯座：用法术位施放治疗法术后，你或 30 尺内另一个生物恢复 ' + starDie(csh) + ' + 感知调整值 生命值');
    // 导引打击：失手（不是天然 1），出手的是战争牧师自己或 30 尺内的生物
    if (clsOn('hcCleric') && r.kind === 'attack' && t.hit === 'miss' && c) sortedItems().forEach(function(o) {
        var osh = o.kind === 'token' && o.sheet && sheets[o.sheet];
        if (!osh || !mineTok(o) || clericLv(osh) < 3 || !isWarDomain(osh) || !cdHas(o, osh) || cxRefUsed(e.id + ':' + t.id + ':gs')) return;
        var self = o.id === c.id;
        if (!self && (!canReact(o) || creatureDist(o, c) > 30)) return;
        h += btn('ccguide', '导引打击 +10' + (self ? '' : '（' + escapeHtml(chipName(o.label)) + '）'), '导引打击（1 次引导神力' + (self ? '' : '，用反应') + '）：这次攻击检定 +10，命中则由服务器结算伤害', ' data-by="' + escapeHtml(o.id) + '" data-react-ref="' + escapeHtml(e.id + ':' + t.id + ':gs') + '"');
    });
    // 预兆：服务器掷的豁免 / 攻击，预言师可以用一个预兆替换 d20（每回合一次）
    var roll = r.kind === 'save' ? t.save : r.kind === 'attack' ? t.attack : null;
    if (clsOn('hcWizard') && roll && tok && !cxRefUsed(e.id + ':' + t.id + ':pt')) sortedItems().forEach(function(o) {
        var osh = o.kind === 'token' && o.sheet && sheets[o.sheet];
        if (!osh || !mineTok(o) || !(o.portent || []).length || wizLv(osh) < 3 || !isDiviner(osh) || onceBtnUsed(o, 'ptKey')) return;
        (o.portent || []).forEach(function(v, i) {
            h += btn('ccportent', '预兆 ' + num(v, 0), '预兆（每回合一次）：用 ' + num(v, 0) + ' 替换这次' + (r.kind === 'save' ? '豁免' : '攻击') + '的 d20，由服务器重新判定（成功 / 命中变化时自动重新结算）', ' data-by="' + escapeHtml(o.id) + '" data-pi="' + i + '" data-react-ref="' + escapeHtml(e.id + ':' + t.id + ':pt') + '"');
        });
    });
    // 灵光一闪：豁免失败，奇械师自己或 30 尺内看得见的生物
    if (clsOn('hcArtificer') && r.kind === 'save' && t.saved === 'no' && tok && !cxRefUsed(e.id + ':' + t.id + ':fg')) sortedItems().forEach(function(o) {
        var osh = o.kind === 'token' && o.sheet && sheets[o.sheet];
        if (!osh || !mineTok(o) || artLv(osh) < 7 || !canReact(o) || (o.id !== tok.id && creatureDist(o, tok) > 30)) return;
        if (!cxHas(o, RE_FLASH, '灵光一闪', Math.max(1, abilMod(osh, 'int')))) return;
        h += btn('ccflash', '灵光一闪 ' + signed(Math.max(1, abilMod(osh, 'int'))) + '（' + escapeHtml(chipName(o.label)) + '）', '灵光一闪（反应）：豁免加上智力调整值，达到 DC 则改为成功并重新结算', ' data-by="' + escapeHtml(o.id) + '" data-react-ref="' + escapeHtml(e.id + ':' + t.id + ':fg') + '"');
    });
    return h;
}

function casterClick(el, d) {
    var ent = logEntries.filter(function(x) { return x.id === d.log; })[0];
    if (!ent || !ent.act) return true;
    var r = ent.act, c = r.casterId && scene.items[r.casterId], csh = c && c.sheet && sheets[c.sheet], tgt = scene.items[d.tok];
    var by = d.by && scene.items[d.by], bsh = by && by.sheet && sheets[by.sheet];
    switch (d.cx) {
    case 'ccds':
    case 'ccps':
        if (!c || !tgt) return true;
        var ds = d.cx === 'ccds';
        masteryDone[d.log + (ds ? ':ds' : ':ps')] = true;
        el.remove();
        markOnce(c, ds ? 'dsKey' : 'psKey');
        openActionDialog(cxBase({ name: (ds ? '神圣打击' : '原力蛮击') + '（' + r.name + '）', kind: 'auto', damage: ds ? divineStrike(csh) : primalStrike(csh), dtype: ds ? '光耀' : '雷鸣', magic: true,
            scaleNote: ds ? '神圣打击：类型可以改为黯蚀（重击时请自己把骰子翻倍）' : '原力蛮击：类型可以改为寒冷 / 火焰 / 闪电 / 雷鸣（重击时请自己把骰子翻倍）' }), c, csh);
        act.presetTargets = [tgt.id];
        break;
    case 'ccchal':
        if (!c) return true;
        masteryDone[d.log + ':chalice'] = true;
        el.remove();
        openActionDialog(cxBase({ name: '星耀·圣杯', kind: 'heal', damage: starDie(csh) + signed(abilMod(csh, 'wis')), range: 30, scaleNote: '圣杯座：你或 30 尺内另一个生物恢复生命' }), c, csh);
        break;
    case 'ccguide':
        if (!by || !cxSpend(by, RE_CD, '引导神力', cdMax(bsh))) return true;
        el.disabled = true;
        op({ op: 'action.react', text: d.log, target: d.tok, mode: 'guided', ids: [d.by] });
        break;
    case 'ccportent':
        if (!by) return true;
        el.parentNode && el.parentNode.querySelectorAll('[data-cx="ccportent"]').forEach(function(x) { x.disabled = true; });
        markOnce(by, 'ptKey');
        op({ op: 'action.react', text: d.log, target: d.tok, mode: 'portent', ids: [d.by, d.pi] });
        break;
    case 'ccflash':
        if (!by || !cxSpend(by, RE_FLASH, '灵光一闪', Math.max(1, abilMod(bsh, 'int')))) return true;
        el.disabled = true;
        op({ op: 'action.react', text: d.log, target: d.tok, mode: 'flash', ids: [d.by] });
        break;
    }
    return true;
}

// 预兆：用在自己掷的检定上（从预兆里去掉，记录里写一句）
function portentUse(it, i) {
    var list = (it.portent || []).slice(), v = list.splice(i, 1)[0];
    if (v == null) return;
    patchItems([{ id: it.id, portent: list.length ? list : null }]);
    op({ op: 'chat', text: '🔮 ' + (it.label || '') + ' 使用预兆：把一次 d20 检定换成 ' + num(v, 0) });
}

// 行动框：强力施法（牧师 / 德鲁伊 7 级：戏法伤害加感知调整值）、奥法火器（魔炮师 5 级：奇械师法术伤害 +1d8）
function casterDialogSync(a, caster, sh) {
    var s = sh || (caster && caster.sheet && sheets[caster.sheet]);
    var fw = $('acFirearmWrap');
    if (fw) { fw.style.display = 'none'; $('acFirearm').checked = false; }
    if (!caster || !s || !hintOn('hintClass') || !a.isSpell || !a.damage) return false;
    if (a.spellLevel === 0 && !a.potentAdded && ((clsOn('hcCleric') && clericLv(s) >= 7) || (clsOn('hcDruid') && druidLv(s) >= 7)) && sheetHasEntry(s, RE_POTENT)) {
        a.damage = addToDamage(a.damage, signed(abilMod(s, 'wis')) || '+0');
        a.potentAdded = true;
        $('acDamage').value = a.damage;
        $('acScaleNote').textContent = [a.scaleNote || '', '强力施法：戏法伤害 + 感知调整值 ' + signed(abilMod(s, 'wis'))].filter(Boolean).join('；');
    }
    if (fw && clsOn('hcArtificer') && artLv(s) >= 5 && isArtillerist(s) && !a.firearmAdded && a.kind !== 'heal' && a.kind !== 'temp') {
        fw.style.display = '';
        $('acFirearm').checked = true;
        return true;
    }
    return false;
}
function casterDialogApply(a) {
    if (!$('acFirearmWrap') || $('acFirearmWrap').style.display === 'none' || !$('acFirearm').checked || a.firearmAdded) return;
    a.damage = addToDamage(a.damage || '', '1d8');
    a.firearmAdded = true;
}

// 专业预言（预言师 6 级）：用二环以上法术位施放预言法术后，恢复一个更低环（≤ 五环）的已用法术位
function cxAfterSlot(a, sh) {
    if (!sh || wizLv(sh) < 6 || !isDiviner(sh) || a.school !== '预言' || !(a.slotLevel >= 2) || !clsOn('hcWizard')) return;
    for (var lv = Math.min(5, a.slotLevel - 1); lv >= 1; lv--) {
        var s = slotOf(sh, lv);
        if (s && s.cur < s.max) { changeSlot(sh, s.idx, 1); notice('专业预言：恢复一个 ' + lv + ' 环法术位', false, 4000); return; }
    }
}

// 要塞阵地（魔炮师 15 级）：魔能炮台 10 尺内的你和盟友享有半身掩护
function fortifiedCover(att, tgt) {
    if (!att || !tgt || !clsOn('hcArtificer')) return '';
    var found = sortedItems().some(function(o) {
        var sh = o.kind === 'token' && o.sheet && sheets[o.sheet], m = sh && sh.kind === 'summon' && masterSheet(sh);
        return !!m && /魔能炮台|eldritch\s*cannon/i.test(sh.name || '') && artLv(m) >= 15 && tokenSide(o) === tokenSide(tgt) && tokenSide(att) !== tokenSide(tgt) &&
            !hasStatus(o, 'dead') && creatureDist(o, tgt) <= 10;
    });
    return found ? '要塞阵地：魔能炮台 10 尺内，半身掩护' : '';
}

// ===== 手动豁免：属性面板「自动掷豁免」不勾时，服务器不替这个角色掷豁免 =====
// 记录里提示要掷什么、成败各怎样；玩家点「掷豁免」由服务器当场掷，或用实体骰子掷完点「成功 / 失败」，之后伤害和状态照样自动结算
var SAVE_CN = { str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力', strdex: '力量或敏捷（取高）' };
function saveModeRowHtml(it) {
    if (!canEdit(it) || !isCreatureToken(it)) return '';
    return '<div class="prop-row"><label>豁免</label><label title="勾上：需要豁免时由服务器自动掷并结算。不勾：需要豁免时提示你自己掷，掷完后伤害和状态照样自动结算">' +
        '<input type="checkbox" data-autosave="' + escapeHtml(it.id) + '"' + (it.manualSave ? '' : ' checked') + '> 自动掷豁免</label>' +
        (it.manualSave ? '<span class="tt-hint">需要豁免时会提示你自己掷</span>' : '') + '</div>';
}
function saveBonusOf(tok, ab) {
    var sh = tok && tok.sheet && sheets[tok.sheet];
    var a = sh && (sh.abilities || []).filter(function(x) { return x.key === ab || x.name === ABILITY_NAMES[ab]; })[0];
    return a ? normBonus(a.save || a.mod) || '+0' : '+0';
}
function saveOutcome(r) {
    var dmg = r.roll ? num(r.roll.total, 0) : 0;
    var parts = (r.parts || []).filter(function(p) { return p.roll; }).map(function(p) { return p.roll.total + ' ' + (p.type || ''); });
    var full = (dmg ? dmg + ' ' + (r.damageType || '') : '') + (parts.length ? (dmg ? ' + ' : '') + parts.join(' + ') : '');
    var st = r.statusDef && r.statusDef.name;
    var fail = [full ? '受到 ' + full + ' 伤害' : '', st ? '陷入「' + st + '」' : ''].filter(Boolean).join('，') || '承受这次效果';
    var ok = r.half && (dmg || parts.length) ? '只受一半伤害' + (dmg ? '（约 ' + Math.floor(dmg / 2) + '）' : '') : '不受影响';
    return '需要' + (SAVE_CN[r.save] || '') + '豁免 DC ' + r.dc + '——成功：' + ok + '；失败：' + fail;
}
function pendingSaveHtml(e, t, r) {
    if (r.kind !== 'save' || t.saved !== 'pending' || !t.id || !e.id) return '';
    var tok = scene.items[t.id], ref = e.id + ':' + t.id + ':sv';
    if (cxRefUsed(ref)) return '';
    var txt = '<span class="tt-hint">🎲 ' + escapeHtml(saveOutcome(r)) + '</span>';
    if (!tok || !(me.gm || (tok.owner && tok.owner === me.name))) return txt;
    var ab = r.save === 'strdex' ? (parseInt(saveBonusOf(tok, 'dex'), 10) > parseInt(saveBonusOf(tok, 'str'), 10) ? 'dex' : 'str') : r.save;
    var btn = function(mode, label, title) {
        return '<button class="tt-btn small react-btn" data-psv="' + mode + '" data-log="' + escapeHtml(e.id) + '" data-tok="' + escapeHtml(t.id) + '" data-react-ref="' + escapeHtml(ref) + '" title="' + escapeHtml(title) + '">' + label + '</button>';
    };
    return txt + btn('roll', '🎲 掷' + (SAVE_CN[ab] || '') + '豁免 ' + saveBonusOf(tok, ab), '由服务器现在掷这次豁免（加值、优势、反射闪避等照常计算），然后自动结算伤害和状态') +
        btn('yes', '成功', '用自己的骰子掷完：按成功结算（伤害和状态自动处理）') + btn('no', '失败', '用自己的骰子掷完：按失败结算（伤害和状态自动处理）');
}
function pendingSaveClick(el) {
    var d = el.dataset;
    el.parentNode && el.parentNode.querySelectorAll('[data-psv]').forEach(function(x) { x.disabled = true; });
    op({ op: 'action.resolve', text: d.log, target: d.tok, mode: d.psv });
    return true;
}
// 记录到达时：自己的角色有待掷的豁免就弹提示
function pendingSaveNotice(entry) {
    var r = entry && entry.act;
    if (!r || r.kind !== 'save') return;
    (r.targets || []).forEach(function(t) {
        var tok = t.saved === 'pending' && scene.items[t.id];
        if (tok && tok.owner && tok.owner === me.name) notice('🎲 ' + (tok.label || '') + '：' + saveOutcome(r) + '（在记录里掷）', false, 9000);
    });
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
    $('selPanel').addEventListener('change', function(e) { // 属性面板「自动掷豁免」
        var id = e.target.dataset && e.target.dataset.autosave;
        if (!id || !scene.items[id]) return;
        patchItems([{ id: id, manualSave: e.target.checked ? null : true }]);
        notice(e.target.checked ? '已改为自动掷豁免' : '已改为自己掷豁免：需要豁免时记录里会提示，掷完后自动结算');
    });
    $('sheetPane').addEventListener('change', function(e) {
        var id = e.target.dataset && e.target.dataset.sheetsub;
        if (!id || !sheets[id]) return;
        op({ op: 'sheet', sheet: { id: id, subclass: e.target.value.trim() || null } });
        notice('子职已改为「' + (e.target.value.trim() || '（空）') + '」');
    });
}
