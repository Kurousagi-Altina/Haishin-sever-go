// 跑团桌面：职业特性第 7–9 步 —— 圣武士（征服 / 守望之誓）、术士（狂野 / 龙族术法，术法点与超魔）、魔契师（咒剑）
// 外加专长（凶蛮打手、盾击、双持客、紫龙新兵·振军战吼、元素掌控）和「通用特性」兜底（没有专门适配的特性：扣次数 + 记录 + 能解析就打开行动框）。
// 房间设置 hcPaladin / hcSorcerer / hcWarlock（职业）、hintFeat（专长）。规则见 docs/战斗规则.md 第 17–20 节。
// 依赖 tabletop-class.js（cxRes / cxBtn / cxBase / hasSub …）、tabletop-fight.js、tabletop-action.js 的全局函数

// ===== 共用 =====
function x2Cha(sh) { return abilMod(sh, 'cha'); }
// 按数量扣资源（圣疗池、术法点）
function cxSpendN(tok, re, name, max, n) {
    var fr = cxRes(tok, re, name, max);
    if (!fr) return true;
    if (num(fr.r.cur, 0) < n) { notice('「' + fr.r.name + '」只剩 ' + num(fr.r.cur, 0) + '，不够 ' + n, true); return false; }
    fr.r.cur = num(fr.r.cur, 0) - n;
    patchItems([{ id: tok.id, res: fr.res }]);
    notice(fr.r.name + '：剩 ' + fr.r.cur + '/' + fr.r.max);
    return true;
}
function cxGain(tok, re, name, max, n) {
    var fr = cxRes(tok, re, name, max);
    if (!fr) return 0;
    var before = num(fr.r.cur, 0);
    fr.r.cur = Math.min(num(fr.r.max, 0), before + n);
    patchItems([{ id: tok.id, res: fr.res }]);
    return fr.r.cur - before;
}
function cxCur(tok, re, name, max) { var fr = cxRes(tok, re, name, max); return fr ? num(fr.r.cur, 0) : 0; }
function x2Tok(sh) { return sortedItems().filter(function(t) { return t.kind === 'token' && t.sheet === sh.id && canEdit(t); })[0] || null; }

// ===== 圣武士（2024）+ 征服之誓 / 守望之誓 =====
var RE_LOH = /圣疗|lay\s*on\s*hands/i, RE_SMITE_FREE = /免费至圣斩|圣武斩|paladin'?s\s*smite/i, RE_STEED = /信实坐骑|faithful\s*steed/i;
var RE_CONQ = /征服之誓|征服圣誓|引导神力-征服|oath\s*of\s*conquest|征服威压|conquering\s*presence/i, RE_WATCH = /守望之誓|守望圣誓|引导神力-守望|watchers|守望者的意志/i;
function palLv(sh) { return clsLv(sh, '圣武士'); }
function palCdMax(sh) { return palLv(sh) >= 11 ? 3 : 2; }
function isConquest(sh) { return hasSub(sh, RE_CONQ); }
function isWatchers(sh) { return hasSub(sh, RE_WATCH); }
function palDC(sh) { var c = sheetCasting(sh); return c && parseInt(c.dc, 10) || 8 + sheetProf(sh) + x2Cha(sh); }
function hasDivineSmite(sh) { return !!sh && ((sh.spells || []).some(function(s) { return /至圣斩|divine\s*smite/i.test(s.name || ''); }) || sheetHasEntry(sh, /圣武斩|至圣斩/)); }
// 斩击法术（2024：命中后附赠动作施放）：卡上「…斩」的法术，至圣斩单独处理
function smiteSpells(sh) {
    return (sh && sh.spells || []).map(function(s, i) { return { s: s, i: i }; }).filter(function(x, k, all) {
        var n = String(x.s.name || '');
        return /斩$|smite/i.test(n) && !/至圣斩|divine\s*smite/i.test(n) && all.findIndex(function(y) { return y.s.name === x.s.name; }) === k;
    });
}

function palPanelBtns(it, sh) {
    var b = [], lv = palLv(sh);
    if (!lv || !clsOn('hcPaladin')) return b;
    if (sheetHasEntry(sh, RE_LOH) || lv >= 1)
        b.push(cxBtn('cx-pl-loh', '🙌 圣疗（池 ' + cxLeft(it, RE_LOH, '圣疗', 5 * lv) + '）', '圣疗（附赠动作，触碰）：从治疗池里取任意点数治疗一个生物（可以是自己），或花 5 点移除中毒。池子 = 圣武士等级 × 5，长休补满'));
    if (lv >= 2 && sheetHasEntry(sh, /圣武斩/))
        b.push('<span class="tt-hint" title="圣武斩：长休前可以免费施放一次至圣斩（近战命中后在记录里点「至圣斩」，选「免费」）">✨ 免费至圣斩 ' + cxLeft(it, RE_SMITE_FREE, '免费至圣斩', 1) + '</span>');
    if (lv >= 3) {
        var cdl = '（引导 ' + cxLeft(it, RE_CD, '引导神力', palCdMax(sh)) + '）';
        b.push(cxBtn('cx-pl-sense', '👁 神圣感知' + cdl, '神圣感知（附赠动作，1 次引导神力，10 分钟）：感知 60 尺内天界生物、邪魔、亡灵的位置和类型'));
        if (isConquest(sh)) b.push(cxBtn('cx-pl-conq', '😱 征服威压', '征服威压（动作，1 次引导神力）：你周围 30 尺内你选择的生物感知豁免（DC ' + palDC(sh) + '），失败恐慌 1 分钟，每回合结束重复豁免。神助打击（攻击检定 +10）在记录里失手后点'));
        if (isWatchers(sh)) {
            b.push(cxBtn('cx-pl-will', '🛡 守望者的意志', '守望者的意志（动作，1 次引导神力，1 分钟）：你和 30 尺内至多 ' + Math.max(1, x2Cha(sh)) + ' 个生物的智力 / 感知 / 魅力豁免具有优势（服务器掷豁免时自动生效）'));
            b.push(cxBtn('cx-pl-abjure', '驱散异域', '驱散异域（动作，1 次引导神力）：30 尺内的异怪、天界生物、元素、精类、邪魔感知豁免（DC ' + palDC(sh) + '），失败受驱散 1 分钟（受到伤害时结束）'));
        }
    }
    if (lv >= 5 && sheetHasEntry(sh, RE_STEED))
        b.push(cxBtn('cx-pl-steed', '🐴 信实坐骑（' + cxLeft(it, RE_STEED, '信实坐骑', 1) + '）', '信实坐骑：每长休一次免费施放寻获坐骑。点了打开角色卡，下一次施法不扣法术位'));
    return b;
}

function palSelAct(act0, it, sh) {
    var lv = palLv(sh);
    switch (act0) {
    case 'cx-pl-loh':
        var fr = cxRes(it, RE_LOH, '圣疗', 5 * lv), left = fr ? num(fr.r.cur, 0) : 0;
        if (left <= 0) { notice('圣疗池已经用完了（长休补满，可以在棋子资源里改）', true); break; }
        ttAsk({ title: '🙌 圣疗（池子剩 ' + left + '）', text: '附赠动作，触碰一个生物（可以是自己）。', choices: [{ label: '恢复生命值', value: 'heal' }].concat(left >= 5 ? [{ label: '移除中毒（花 5 点）', value: 'cure' }] : []) }).then(function(v) {
            if (v === 'cure') {
                if (!cxSpendN(it, RE_LOH, '圣疗', 5 * lv, 5)) return;
                econAfterAction({ cost: 'b' }, it);
                if (hasStatus(it, 'poisoned')) { cxDropStatus(it, 'poisoned'); notice('圣疗：移除了自己的中毒'); }
                else op({ op: 'chat', text: '🙌 ' + (it.label || '') + ' 用圣疗（5 点）移除了一个生物的中毒（请在目标棋子上去掉「中毒」）' });
                return;
            }
            if (v !== 'heal') return;
            var miss = it.hpMax > 0 ? Math.max(0, it.hpMax - num(it.hp, it.hpMax)) : 0;
            ttAsk({ title: '🙌 圣疗：治疗多少？', text: '池子剩 ' + left + ' 点（先选目标的话填它缺的血量）', input: { value: String(Math.min(left, miss || left)) } }).then(function(s) {
                var n = Math.min(left, Math.max(0, parseInt(s, 10) || 0));
                if (!n || !cxSpendN(it, RE_LOH, '圣疗', 5 * lv, n)) return;
                openActionDialog(cxBase({ name: '圣疗', kind: 'heal', damage: String(n), reach: 5, cost: 'b', scaleNote: '圣疗：已从池子里扣掉 ' + n + ' 点。选目标（触碰，可以是自己）' }), it, sh);
            });
        });
        break;
    case 'cx-pl-sense':
        if (!cxSpend(it, RE_CD, '引导神力', palCdMax(sh))) break;
        econAfterAction({ cost: 'b' }, it);
        op({ op: 'chat', text: '👁 ' + (it.label || '') + ' 使用神圣感知：60 尺内的天界生物、邪魔、亡灵（GM 请告知位置和类型）' });
        break;
    case 'cx-pl-conq':
        if (!cxSpend(it, RE_CD, '引导神力', palCdMax(sh))) break;
        openActionDialog(cxBase({ name: '征服威压', kind: 'save', save: 'wis', dc: palDC(sh), status: 'frightened', rounds: 10, repeatSave: true, cost: 'a', magic: true, enemiesOnly: true,
            area: { shape: 'circle', size: 30, width: 5, self: true }, scaleNote: '征服威压：你选择的生物（默认只选敌人），失败恐慌于你 1 分钟，每回合结束重复豁免' }), it, sh);
        break;
    case 'cx-pl-will':
        if (!cxSpend(it, RE_CD, '引导神力', palCdMax(sh))) break;
        openActionDialog(cxBase({ name: '守望者的意志', kind: 'effect', status: 'watchwill', rounds: 10, range: 30, targets: Math.max(1, x2Cha(sh)) + 1, cost: 'a',
            scaleNote: '守望者的意志：你自己和至多 ' + Math.max(1, x2Cha(sh)) + ' 个 30 尺内的生物（目标数已经算上你自己），1 分钟内智力 / 感知 / 魅力豁免优势' }), it, sh);
        act.presetTargets = [it.id];
        break;
    case 'cx-pl-abjure':
        if (!cxSpend(it, RE_CD, '引导神力', palCdMax(sh))) break;
        openActionDialog(cxBase({ name: '驱散异域', kind: 'save', save: 'wis', dc: palDC(sh), status: 'turned', rounds: 10, cost: 'a', magic: true, enemiesOnly: true,
            area: { shape: 'circle', size: 30, width: 5, self: true }, scaleNote: '驱散异域：只选异怪、天界生物、元素、精类、邪魔；失败受驱散 1 分钟（受到伤害时结束，请手动去掉），只能远离你' }), it, sh);
        break;
    case 'cx-pl-steed':
        if (!cxSpend(it, RE_STEED, '信实坐骑', 1)) break;
        openSheetPreset(it, sh, { noSlot: true }, '信实坐骑：在角色卡上施放寻获坐骑，不扣法术位');
        break;
    default:
        return false;
    }
    return true;
}

// ===== 术士（2024）+ 狂野术法 / 龙族术法 =====
var RE_SP = /术法点|sorcery\s*points/i, RE_INNATE = /先天术法|innate\s*sorcery/i, RE_SRESTORE = /术法复苏|sorcerous\s*restoration/i, RE_TIDES = /混乱之潮|tides\s*of\s*chaos/i;
var RE_WILDMAGIC = /狂野术法|狂野魔法|wild\s*magic/i;
var SLOT_COST = { 1: 2, 2: 3, 3: 5, 4: 6, 5: 7 }, SLOT_MINLV = { 1: 2, 2: 3, 3: 5, 4: 7, 5: 9 };
var METAMAGIC = [
    { key: 'quick', re: /瞬发法术|quickened/i, name: '瞬发', cost: 2, title: '瞬发法术（2 点）：施法时间为动作的法术改为附赠动作（同一回合不能再用法术位施放一环以上的法术）' },
    { key: 'empower', re: /强效法术|empowered/i, name: '强效', cost: 1, title: '强效法术（1 点）：伤害骰里至多「魅力调整值」颗低于平均值的骰子重掷一次（服务器从最低的开始挑）。可以和别的超魔同时用' },
    { key: 'height', re: /升阶法术|heightened/i, name: '升阶', cost: 2, title: '升阶法术（2 点）：法术影响的一个生物豁免具有劣势（选中的第一个目标）' },
    { key: 'twin', re: /双生法术|孪生法术|twinned/i, name: '双生', cost: 1, title: '双生法术（1 点）：升环时能多指定一个生物的法术，多指定一个目标（目标数 +1）' },
    { key: 'distant', re: /远程法术|远距法术|distant/i, name: '远程', cost: 1, title: '远程法术（1 点）：射程翻倍；触碰的法术射程变为 30 尺' },
    { key: 'careful', re: /谨慎法术|精妙法术|careful/i, name: '谨慎', cost: 1, title: '谨慎法术（1 点）：至多魅力调整值个生物的豁免自动成功，成功时不受伤害（请把它们从目标里去掉）' },
    { key: 'extend', re: /延效法术|延长法术|extended/i, name: '延效', cost: 1, title: '延效法术（1 点）：持续时间翻倍，维持专注的豁免有优势' },
    { key: 'subtle', re: /精微法术|隐匿法术|subtle/i, name: '精微', cost: 1, title: '精微法术（1 点）：不需要言语、姿势和非消耗性材料成分' },
    { key: 'seek', re: /追踪法术|寻的法术|seeking/i, name: '追踪', cost: 1, title: '追踪法术（1 点）：法术攻击失手时可以重掷 d20（请在记录里看结果后自己重掷）' },
    { key: 'trans', re: /转化法术|transmuted/i, name: '转化', cost: 1, title: '转化法术（1 点）：把强酸 / 寒冷 / 火焰 / 闪电 / 毒素 / 雷鸣伤害改成其中另一种（在伤害类型里改）' }
];
function sorLv(sh) { return clsLv(sh, '术士'); }
function spMax(sh) { return sorLv(sh) >= 2 ? sorLv(sh) : 0; }
function isWildMagic(sh) { return hasSub(sh, RE_WILDMAGIC); }
function knownMeta(sh) { return METAMAGIC.filter(function(m) { return sheetHasEntry(sh, m.re); }); }

function sorPanelBtns(it, sh) {
    var b = [], lv = sorLv(sh);
    if (!lv || !clsOn('hcSorcerer')) return b;
    if (sheetHasEntry(sh, RE_INNATE))
        b.push(hasStatus(it, 'innate') ? cxBtn('cx-so-innateend', '结束先天术法', '结束先天术法') :
            cxBtn('cx-so-innate', '✨ 先天术法（' + cxLeft(it, RE_INNATE, '先天术法', 2) + '）', '先天术法（附赠动作，1 分钟）：术士法术豁免 DC +1（行动框自动加），术士法术的攻击检定具有优势（自动）'));
    if (lv >= 2) {
        b.push('<span class="tt-hint" title="术法点：长休补满；超魔在施法的行动框里勾选">🔮 术法点 ' + cxLeft(it, RE_SP, '术法点', spMax(sh)) + '</span>');
        b.push(cxBtn('cx-so-slot2sp', '法术位→术法点', '法术位转化为术法点（不需要动作）：花一个法术位，得到等同于其环阶的术法点（不超过上限）'));
        b.push(cxBtn('cx-so-sp2slot', '术法点→法术位', '创造法术位（附赠动作）：一环 2 点、二环 3、三环 5、四环 6、五环 7（对应最低术士等级 2 / 3 / 5 / 7 / 9）。创造的法术位长休后消失'));
    }
    if (lv >= 5 && sheetHasEntry(sh, RE_SRESTORE))
        b.push(cxBtn('cx-so-restore', '术法复苏（' + cxLeft(it, RE_SRESTORE, '术法复苏', 1) + '）', '术法复苏（短休结束时，每长休一次）：恢复至多 ' + Math.floor(lv / 2) + ' 点术法点'));
    if (isWildMagic(sh) && sheetHasEntry(sh, RE_TIDES))
        b.push(hasStatus(it, 'lucky') ? '' : cxBtn('cx-so-tides', '🌀 混乱之潮（' + cxLeft(it, RE_TIDES, '混乱之潮', 1) + '）', '混乱之潮：下一次 D20 检定具有优势（攻击、由服务器掷的豁免自动取优势）。用完后用法术位施放术士法术时会恢复，并自动掷狂野魔法浪涌表'));
    return b;
}

function sorSelAct(act0, it, sh) {
    var lv = sorLv(sh), max = spMax(sh);
    switch (act0) {
    case 'cx-so-innate':
        if (!cxSpend(it, RE_INNATE, '先天术法', 2)) break;
        addStatusTo(it, { id: 'innate', name: '先天术法', icon: '✨', color: '#ba68c8', rounds: 10 });
        econAfterAction({ cost: 'b' }, it);
        notice('先天术法：1 分钟内术士法术 DC +1、法术攻击优势（都自动处理）', false, 5000);
        break;
    case 'cx-so-innateend':
        cxDropStatus(it, 'innate');
        break;
    case 'cx-so-slot2sp':
        var have = (sh.slots || []).filter(function(s) { return num(s.cur, 0) > 0 && parseInt(s.level, 10) > 0; });
        if (!have.length) { notice('角色卡上没有剩余的法术位', true); break; }
        ttAsk({ title: '法术位 → 术法点', text: '术法点现在 ' + cxLeft(it, RE_SP, '术法点', max) + '。花哪一环？', choices: have.map(function(s) {
            return { label: s.level + ' 环（剩 ' + s.cur + '）→ +' + s.level + ' 点', value: String(s.level) };
        }) }).then(function(v) {
            if (!v) return;
            var s = slotOf(sh, parseInt(v, 10));
            if (!s || s.cur <= 0) return;
            changeSlot(sh, s.idx, -1);
            var got = cxGain(it, RE_SP, '术法点', max, parseInt(v, 10));
            notice('花了 1 个 ' + v + ' 环法术位，术法点 +' + got + (got < parseInt(v, 10) ? '（已到上限）' : ''));
        });
        break;
    case 'cx-so-sp2slot':
        var pts = cxCur(it, RE_SP, '术法点', max), opts = [];
        for (var L = 1; L <= 5; L++) if (lv >= SLOT_MINLV[L] && pts >= SLOT_COST[L]) opts.push({ label: L + ' 环（花 ' + SLOT_COST[L] + ' 点）', value: String(L) });
        if (!opts.length) { notice('术法点不够创造法术位（一环要 2 点）', true); break; }
        ttAsk({ title: '术法点 → 法术位（附赠动作）', text: '术法点现在 ' + pts + '。创造哪一环？', choices: opts }).then(function(v) {
            if (!v) return;
            var L2 = parseInt(v, 10), s = slotOf(sh, L2);
            if (!cxSpendN(it, RE_SP, '术法点', max, SLOT_COST[L2])) return;
            econAfterAction({ cost: 'b' }, it);
            if (s && s.cur < s.max) { changeSlot(sh, s.idx, 1); notice('创造了一个 ' + L2 + ' 环法术位'); }
            else notice('创造了一个 ' + L2 + ' 环法术位：角色卡上这一环已满（或没有这一环），请记住多出的一个（长休消失）', false, 6000);
        });
        break;
    case 'cx-so-restore':
        if (!cxSpend(it, RE_SRESTORE, '术法复苏', 1)) break;
        var g = cxGain(it, RE_SP, '术法点', max, Math.floor(lv / 2));
        notice('术法复苏：恢复 ' + g + ' 点术法点');
        break;
    case 'cx-so-tides':
        if (!cxSpend(it, RE_TIDES, '混乱之潮', 1)) break;
        addStatusTo(it, { id: 'lucky', name: '混乱之潮', icon: '🌀', color: '#ab47bc' });
        notice('混乱之潮：下一次 D20 检定具有优势（攻击、服务器掷的豁免自动处理；自己掷检定时选优势）', false, 5000);
        break;
    default:
        return false;
    }
    return true;
}

// 用法术位施放术士法术后：狂野魔法浪涌（每回合一次掷 d20，20 = 掷浪涌表）；混乱之潮用过的话恢复并直接掷浪涌表
var surgeTurn = {};
function sorAfterSlot(a, sh) {
    if (!sh || !sorLv(sh) || !isWildMagic(sh) || !clsOn('hcSorcerer') || !(a.slotLevel >= 1)) return;
    var tok = x2Tok(sh);
    if (tok && sheetHasEntry(sh, RE_TIDES) && cxCur(tok, RE_TIDES, '混乱之潮', 1) <= 0) {
        cxGain(tok, RE_TIDES, '混乱之潮', 1, 1);
        sheetRoll(sh, '狂野魔法浪涌表（混乱之潮恢复）', '1d100');
        notice('混乱之潮已恢复；自动在狂野魔法浪涌表上掷了 d100', false, 6000);
        return;
    }
    var k = sh.id + '|' + (turnKey() || '');
    if (turnKey() && surgeTurn[k]) return;
    surgeTurn[k] = true;
    sheetRoll(sh, '狂野魔法浪涌（掷出 20 再掷 1d100 查浪涌表）', '1d20');
}

// ===== 魔契师 + 咒剑 =====
var RE_HEXBLADE = /咒剑|hexblade/i, RE_HEXCURSE = /咒剑诅咒|hexblade'?s\s*curse/i, RE_MCUNNING = /秘法回流|magical\s*cunning/i, RE_VIGOR = /邪魔活力|fiendish\s*vigor/i;
var RE_AGONIZING = /苦痛魔爆|agonizing\s*blast/i, RE_PACTBLADE = /刃之魔契|锋刃契约|pact\s*of\s*the\s*blade/i;
function wlLv(sh) { return clsLv(sh, '魔契师') || clsLv(sh, '邪术师'); }

function wlPanelBtns(it, sh) {
    var b = [], lv = wlLv(sh);
    if (!lv || !clsOn('hcWarlock')) return b;
    if (sheetHasEntry(sh, RE_HEXCURSE))
        b.push(cxBtn('cx-wl-curse', '☠ 咒剑诅咒（' + cxLeft(it, RE_HEXCURSE, '咒剑诅咒', 1) + '）', '咒剑诅咒（附赠动作，30 尺内一个生物，1 分钟；短休或长休恢复）：对它的伤害 +' + sheetProf(sh) + '（熟练加值），攻击掷出 19–20 就是重击，它死亡时你恢复 ' + (lv + Math.max(1, x2Cha(sh))) + ' 生命值。都自动处理'));
    if (sheetHasEntry(sh, RE_PACTBLADE))
        b.push(cxBtn('cx-wl-blade', '🗡 召唤契约武器', '刃之魔契（附赠动作）：在手中召唤契约武器，用魅力攻击和伤害，伤害类型可以改为黯蚀 / 心灵 / 光耀'));
    if (sheetHasEntry(sh, RE_VIGOR))
        b.push(cxBtn('cx-wl-vigor', '🩸 邪魔活力', '邪魔活力：不花法术位施放虚假生命，临时生命直接取最大值（2d4 + 4 = 12；已有更多临时生命时保留原来的）'));
    if (lv >= 2 && sheetHasEntry(sh, RE_MCUNNING))
        b.push(cxBtn('cx-wl-cunning', '秘法回流（' + cxLeft(it, RE_MCUNNING, '秘法回流', 1) + '）', '秘法回流（1 分钟仪式，每长休一次）：恢复一半已用的契约法术位（向上取整）'));
    return b;
}

function wlSelAct(act0, it, sh) {
    var lv = wlLv(sh);
    switch (act0) {
    case 'cx-wl-curse':
        if (!cxSpend(it, RE_HEXCURSE, '咒剑诅咒', 1)) break;
        openActionDialog(cxBase({ name: '咒剑诅咒', kind: 'effect', status: 'hexcurse', rounds: 10, range: 30, cost: 'b',
            scaleNote: '咒剑诅咒：1 分钟。之后你对它的攻击：伤害 +' + sheetProf(sh) + '、19–20 重击（自动）；它死亡时记录里有「回复生命」按钮' }), it, sh);
        break;
    case 'cx-wl-blade':
        econAfterAction({ cost: 'b' }, it);
        op({ op: 'chat', text: '🗡 ' + (it.label || '') + ' 召唤了契约武器（魅力攻击与伤害，伤害类型可改为黯蚀 / 心灵 / 光耀）' });
        break;
    case 'cx-wl-vigor':
        var temp = 12;
        if (num(it.hpTemp, 0) >= temp) { notice('已有 ' + num(it.hpTemp, 0) + ' 点临时生命，比 12 多，保留原来的', true); break; }
        patchItems([{ id: it.id, hpTemp: temp }]);
        econAfterAction({ cost: 'a' }, it);
        op({ op: 'chat', text: '🩸 ' + (it.label || '') + ' 邪魔活力：虚假生命（不耗法术位），临时生命 ' + temp });
        break;
    case 'cx-wl-cunning':
        var slots = (sh.slots || []).map(function(s, i) { return { i: i, lv: parseInt(s.level, 10) || 0, cur: num(s.cur, 0), max: num(s.max, 0) }; }).filter(function(s) { return s.max > 0; });
        var top = slots.sort(function(a, b) { return b.lv - a.lv; })[0];
        if (!top) { notice('角色卡上没有法术位', true); break; }
        if (top.cur >= top.max) { notice('契约法术位是满的，不用恢复', true); break; }
        if (!cxSpend(it, RE_MCUNNING, '秘法回流', 1)) break;
        var n = Math.min(top.max - top.cur, Math.ceil(top.max / 2));
        changeSlot(sh, top.i, n);
        notice('秘法回流：恢复 ' + n + ' 个 ' + top.lv + ' 环契约法术位');
        break;
    default:
        return false;
    }
    return true;
}

// ===== 专长：紫龙新兵·振军战吼 =====
var RE_PURPLE = /紫龙新兵|purple\s*dragon\s*rook/i;
function x2FeatBtns(it, sh) {
    var b = [];
    if (!hintOn('hintFeat') || !sh) return b;
    if (sheetHasEntry(sh, RE_PURPLE))
        b.push(cxBtn('cx-ft-rally', '📯 振军战吼（' + cxLeft(it, /振军战吼|rallying\s*cry/i, '振军战吼', 1) + '）', '紫龙新兵·振军战吼（投先攻时，每长休一次）：30 尺内至多 ' + sheetProf(sh) + ' 个你看得见的生物获得英雄激励'));
    return b;
}
function x2FeatAct(act0, it, sh) {
    if (act0 !== 'cx-ft-rally') return false;
    if (!cxSpend(it, /振军战吼|rallying\s*cry/i, '振军战吼', 1)) return true;
    openActionDialog(cxBase({ name: '振军战吼', kind: 'effect', status: 'heroic', range: 30, targets: sheetProf(sh), cost: 'n',
        scaleNote: '振军战吼：选至多 ' + sheetProf(sh) + ' 个生物获得英雄激励（用掉时请手动去掉「英雄激励」）' }), it, sh);
    return true;
}

// ===== 属性面板 / 选择面板入口（tabletop-class.js 调用） =====
function x2PanelBtns(it, sh) { return palPanelBtns(it, sh).concat(sorPanelBtns(it, sh), wlPanelBtns(it, sh)); }
function x2SelAct(act0, it, sh) {
    if (!/^cx-(pl|so|wl|ft|gn)-/.test(act0)) return false;
    if (/^cx-gn-/.test(act0)) { genericUse(it, sh, act0.slice(6)); return true; }
    return palSelAct(act0, it, sh) || sorSelAct(act0, it, sh) || wlSelAct(act0, it, sh) || x2FeatAct(act0, it, sh) || true;
}

// ===== 记录里的按钮 =====
function x2TargetBtns(e, t, r) {
    var h = '', tok = scene.items[t.id], c = r.casterId && scene.items[r.casterId], csh = c && c.sheet && sheets[c.sheet];
    var hit = t.hit === 'hit' || t.hit === 'crit', mine = me.gm || e.who === me.name;
    if (!c || !csh || !mine || !tok) return '';
    var btn = function(kind, label, title) {
        return '<button class="tt-btn small react-btn" data-cx="' + kind + '" data-log="' + escapeHtml(e.id) + '" data-tok="' + escapeHtml(t.id) + '" title="' + escapeHtml(title) + '">' + label + '</button>';
    };
    var weaponHit = r.kind === 'attack' && hit && !r.spell && !/法术|戏法/.test(r.name || '');
    // 至圣斩 / 其他斩击法术：近战武器（或徒手）命中后，附赠动作
    if (weaponHit && r.melee && clsOn('hcPaladin') && !isDeadToken(tok)) {
        if (hasDivineSmite(csh) && !masteryDone[e.id + ':' + t.id + ':smite'])
            h += btn('pldsm', '✨ 至圣斩', '至圣斩（附赠动作）：2d8 光耀，每高一环 +1d8；对邪魔 / 亡灵再 +1d8。' + (t.hit === 'crit' ? '这次是重击，骰子自动翻倍。' : '') + '可以选免费（圣武斩）或花法术位');
        if (smiteSpells(csh).length && !masteryDone[e.id + ':' + t.id + ':smite2'])
            h += btn('plsmite', '⚡ 斩击法术', '命中后附赠动作施放卡上的斩击法术（' + smiteSpells(csh).map(function(x) { return x.s.name; }).join('、') + '），目标自动选好');
    }
    // 盾牌大师·盾击：攻击动作中的近战武器攻击命中 5 尺内的生物，每回合一次
    if (weaponHit && r.melee && hintOn('hintFeat') && sheetFeat(csh, 'shieldmaster') && !isDeadToken(tok) && creatureDist(c, tok) <= 5 && !onceBtnUsed(c, 'sbKey') && !masteryDone[e.id + ':bash'])
        h += btn('ftbash', '🛡 盾击', '盾牌大师·盾击（每回合一次，装备着盾牌）：目标力量豁免（DC ' + (8 + abilMod(csh, 'str') + sheetProf(csh)) + '），失败推离 5 尺或倒地（你选）');
    // 双持：攻击动作用轻型武器攻击后，附赠动作用另一把武器追加攻击
    if (r.kind === 'attack' && !r.spell && r.melee && hintOn('hintFeat') && !masteryDone[e.id + ':dual'] && !onceBtnUsed(c, 'dwKey') && dualOffhands(csh, r.name).length && (lightWeapon(csh, r.name) || sheetHasEntry(csh, /双持客|dualwielder/i)))
        h += btn('ftdual', '🗡 副手攻击（附赠）', '用另一把武器追加一次攻击（附赠动作）。' + (sheetHasEntry(csh, /双武器战斗|two-?weaponfighting/i) ? '双武器战斗：伤害照常加属性调整值' : '伤害不加属性调整值（为负时照加）'));
    // 咒剑诅咒：被诅咒的目标死亡 → 回复生命
    var cursed = statusList(tok).filter(function(s) { return s.id === 'hexcurse' && s.by === c.id; })[0];
    if (cursed && t.amount < 0 && (isDeadToken(tok) || (tok.hpMax > 0 && num(tok.hp, tok.hpMax) <= 0)) && !masteryDone[e.id + ':' + t.id + ':hexheal'] && clsOn('hcWarlock'))
        h += btn('wlheal', '☠ 诅咒回复 ' + (wlLv(csh) + Math.max(1, x2Cha(csh))), '咒剑诅咒：被诅咒的目标死亡，你恢复 魔契师等级 + 魅力调整值 生命值');
    return h;
}

function x2Click(el, d) {
    var ent = logEntries.filter(function(x) { return x.id === d.log; })[0];
    if (!ent || !ent.act) return true;
    var r = ent.act, c = r.casterId && scene.items[r.casterId], csh = c && c.sheet && sheets[c.sheet], tgt = scene.items[d.tok];
    if (!c || !csh || !tgt) { notice('出手的棋子或目标不在当前场景', true); return true; }
    var t = (r.targets || []).filter(function(x) { return x.id === d.tok; })[0] || {}, crit = t.hit === 'crit';
    switch (d.cx) {
    case 'pldsm':
        var opts = [], free = sheetHasEntry(csh, /圣武斩/) && cxHas(c, RE_SMITE_FREE, '免费至圣斩', 1);
        if (free) opts.push({ label: '免费（圣武斩）：' + (crit ? 4 : 2) + 'd8', value: 'free' });
        (csh.slots || []).forEach(function(s) {
            var L = parseInt(s.level, 10) || 0;
            if (L >= 1 && num(s.cur, 0) > 0) opts.push({ label: L + ' 环（剩 ' + s.cur + '）：' + ((1 + L) * (crit ? 2 : 1)) + 'd8', value: String(L) });
        });
        if (!opts.length) { notice('没有剩余的法术位，圣武斩的免费次数也用过了', true); return true; }
        ttAsk({ title: '✨ 至圣斩' + (crit ? '（重击，骰子翻倍）' : ''), text: '用哪个法术位？对邪魔 / 亡灵在行动框里再加 1d8' + (crit ? '（重击 2d8）' : '') + '。', choices: opts }).then(function(v) {
            if (!v) return;
            var L = 1;
            if (v === 'free') cxSpend(c, RE_SMITE_FREE, '免费至圣斩', 1);
            else { L = parseInt(v, 10); var s = slotOf(csh, L); if (s) changeSlot(csh, s.idx, -1); }
            masteryDone[d.log + ':' + d.tok + ':smite'] = true;
            el.remove();
            openActionDialog(cxBase({ name: '至圣斩（' + (v === 'free' ? '免费' : L + ' 环') + '）', kind: 'auto', damage: ((1 + L) * (crit ? 2 : 1)) + 'd8', dtype: '光耀', cost: 'b', magic: true,
                scaleNote: '至圣斩：' + (crit ? '重击已翻倍；' : '') + '目标是邪魔或亡灵时把伤害改成多 ' + (crit ? 2 : 1) + 'd8' }), c, csh);
            act.presetTargets = [tgt.id];
        });
        break;
    case 'plsmite':
        var list = smiteSpells(csh);
        var go = function(i) {
            masteryDone[d.log + ':' + d.tok + ':smite2'] = true;
            el.remove();
            actPreset = { caster: c, targets: [tgt.id], cost: 'b', at: Date.now() };
            castFromSheet(csh, { kind: 'spell', idx: String(i) });
            if (crit) notice('这次是重击：斩击法术的伤害骰请在行动框里翻倍', false, 5000);
        };
        if (list.length === 1) go(list[0].i);
        else ttAsk({ title: '⚡ 斩击法术', text: '命中后附赠动作施放：', choices: list.map(function(x) { return { label: x.s.name, value: String(x.i) }; }) }).then(function(v) { if (v != null) go(+v); });
        break;
    case 'ftbash':
        masteryDone[d.log + ':bash'] = true;
        el.remove();
        markOnce(c, 'sbKey');
        var dc = 8 + abilMod(csh, 'str') + sheetProf(csh);
        openActionDialog(cxBase({ name: '推撞·盾击', kind: 'save', save: 'str', dc: dc, status: 'prone', cost: 'n', reach: 5, casterId: c.id,
            scaleNote: '盾牌大师·盾击：失败倒地；想推离 5 尺就把附加状态改成（无），结算后点记录里的「推开 5 尺」' }), c, csh);
        act.presetTargets = [tgt.id];
        break;
    case 'ftdual':
        var offs = dualOffhands(csh, r.name);
        var twf = sheetHasEntry(csh, /双武器战斗|two-?weaponfighting/i);
        var attack = function(i) {
            masteryDone[d.log + ':dual'] = true;
            el.remove();
            markOnce(c, 'dwKey');
            actPreset = { caster: c, cost: 'b', at: Date.now() };
            castFromSheet(csh, { kind: 'atk', idx: String(i) });
            if (act && !twf) { // 追加攻击的伤害不加（正的）属性调整值
                var dm = String(act.a.damage || '').replace(/\s/g, ''), m = dm.match(/^(.*\dd\d+[^+\-]*)\+(\d+)$/);
                if (m) { act.a.damage = m[1]; $('acDamage').value = m[1]; $('acScaleNote').textContent = '副手追加攻击：伤害不加属性调整值（去掉了 +' + m[2] + '）'; }
            }
        };
        if (offs.length === 1) attack(offs[0].i);
        else ttAsk({ title: '🗡 副手攻击', text: '用哪一把武器追加攻击？', choices: offs.map(function(x) { return { label: x.a.name, value: String(x.i) }; }) }).then(function(v) { if (v != null) attack(+v); });
        break;
    case 'wlheal':
        masteryDone[d.log + ':' + d.tok + ':hexheal'] = true;
        el.remove();
        var n = wlLv(csh) + Math.max(1, x2Cha(csh));
        openActionDialog(cxBase({ name: '咒剑诅咒·回复', kind: 'heal', damage: String(n), cost: 'n', scaleNote: '咒剑诅咒：被诅咒的目标死亡，恢复 魔契师等级 + 魅力调整值' }), c, csh);
        act.presetTargets = [c.id];
        break;
    }
    return true;
}

function lightWeapon(sh, name) {
    var base = String(name || '').replace(/（[^）]*）$/, '');
    var at = (sh && sh.attacks || []).filter(function(x) { return x.name === base; })[0];
    return !!at && /轻型|light/i.test(at.props || '');
}
// 副手武器：卡上另一把不是双手、不是远程的武器
function dualOffhands(sh, name) {
    var base = String(name || '').replace(/（[^）]*）$/, '');
    return (sh && sh.attacks || []).map(function(a, i) { return { a: a, i: i }; }).filter(function(x) {
        var p = String(x.a.props || '');
        return x.a.name !== base && !/双手|two-?handed/i.test(p) && !/弓|弩|投石|吹箭|bow|sling/i.test(x.a.name || '') && !/徒手/.test(x.a.name || '');
    });
}

// ===== 行动框：超魔 / 凶蛮打手 / 元素掌控 / 苦痛魔爆 / 先天术法 =====
function adeptType(sh) {
    var f = (sh && sh.features || []).filter(function(x) { return /元素掌控|elementaladept/i.test(String(x.name || '').replace(/\s/g, '')); })[0];
    var m = f && String(f.text || '').match(/无视(强酸|寒冷|火焰|闪电|雷鸣)/);
    return m ? m[1] : '';
}
function x2DialogSync(a, caster, sh) {
    var row = $('acMetaRow');
    if (!row) return;
    row.style.display = 'none';
    $('acMetaBox').innerHTML = '';
    var s = sh || (caster && caster.sheet && sheets[caster.sheet]);
    if (!caster || !s) return;
    var opts = [], notes = [];
    var box = function(key, label, title, checked, extra) {
        opts.push('<label title="' + escapeHtml(title) + '"><input type="checkbox" data-meta="' + key + '"' + (checked ? ' checked' : '') + (extra || '') + '> ' + label + '</label>');
    };
    // 凶蛮打手：每回合一次武器命中掷两次伤害取高
    if (a.kind === 'attack' && !a.isSpell && hintOn('hintFeat') && sheetHasEntry(s, /凶蛮打手|savageattacker/i))
        box('savage', '凶蛮打手', '每回合一次：武器命中时伤害掷两次取高（服务器自动）', !onceBtnUsed(caster, 'savKey'));
    if (a.isSpell) {
        // 魔能爆：光束数按角色等级（1 / 5 / 11 / 17 级 1 / 2 / 3 / 4 道），每道单独攻击，可以打同一个目标
        if (/魔能爆|eldritch\s*blast/i.test(a.name || '') && a.kind === 'attack' && !a.beamsSet) {
            var lvl = parseInt(s.level, 10) || 1, beams = lvl >= 17 ? 4 : lvl >= 11 ? 3 : lvl >= 5 ? 2 : 1;
            a.beamsSet = true;
            if (beams > (a.targets || 1)) { a.targets = beams; $('acTargets').value = beams; }
            if (a.damage) { a.damage = a.damage.replace(/^\d+d10/, '1d10'); $('acDamage').value = a.damage; } // 戏法强化是加光束，不是加骰子
            notes.push(beams + ' 道光束：每道单独攻击，可以都打同一个目标（选目标时再点一下）');
        }
        // 苦痛魔爆：魔能爆每道光束加魅力调整值
        if (clsOn('hcWarlock') && /魔能爆|eldritch\s*blast/i.test(a.name || '') && sheetHasEntry(s, RE_AGONIZING) && !a.agonAdded && a.damage) {
            a.damage = addToDamage(a.damage, signed(x2Cha(s)) || '+0');
            a.agonAdded = true;
            $('acDamage').value = a.damage;
            notes.push('苦痛魔爆：伤害 + 魅力调整值 ' + signed(x2Cha(s)));
        }
        // 先天术法：术士法术 DC +1（攻击优势在确认目标时加）
        if (clsOn('hcSorcerer') && sorLv(s) && hasStatus(caster, 'innate') && a.kind === 'save' && a.dc && !a.innateDC) {
            a.dc += 1;
            a.innateDC = true;
            $('acDC').value = a.dc;
            notes.push('先天术法：DC +1');
        }
        if (clsOn('hcSorcerer') && sorLv(s) && hasStatus(caster, 'innate') && a.kind === 'attack') notes.push('先天术法：法术攻击优势（自动）');
        // 元素掌控：无视这种伤害的抗性，伤害骰的 1 按 2 算
        var ad = hintOn('hintFeat') && adeptType(s);
        if (ad && a.damage && (a.dtype === ad || (a.parts || []).some(function(p) { return p.type === ad; })))
            box('adept', '元素掌控（' + ad + '）', '无视' + ad + '抗性，' + ad + '伤害骰掷出的 1 按 2 算', true);
        // 超魔
        var metas = clsOn('hcSorcerer') && spMax(s) ? knownMeta(s) : [];
        if (metas.length) {
            var tok = caster.sheet === s.id ? caster : x2Tok(s), pts = tok ? cxCur(tok, RE_SP, '术法点', spMax(s)) : 0;
            opts.push('<span class="tt-hint">超魔（术法点 ' + pts + '）</span>');
            metas.forEach(function(m) {
                if (m.key === 'height' && a.kind !== 'save') return;
                if (m.key === 'empower' && !a.damage) return;
                if (m.key === 'quick' && (a.cost || 'a') !== 'a') return;
                box('mm-' + m.key, m.name + '（' + m.cost + '）', m.title, false, ' data-cost="' + m.cost + '"');
            });
        }
    }
    if (notes.length) $('acScaleNote').textContent = [a.scaleNote || ''].concat(notes).filter(Boolean).join('；');
    if (!opts.length) return;
    $('acMetaBox').innerHTML = opts.join('');
    row.style.display = '';
}

// 读行动框（在消耗读完之后）：把勾选的超魔 / 专长写进行动
function x2DialogApply(a) {
    var row = $('acMetaRow');
    a.savage = false;
    a.meta = [];
    a.metaCost = 0;
    a.empower = 0;
    a.heighten = false;
    if (!row || row.style.display === 'none') return;
    var on = function(k) { var el = row.querySelector('[data-meta="' + k + '"]'); return !!(el && el.checked); };
    a.savage = on('savage');
    var s = act && (act.sheet || (act.caster && act.caster.sheet && sheets[act.caster.sheet]));
    if (on('adept') && !a.adeptAdded && s) {
        var ad = adeptType(s), mi = function(x) { return String(x || '').replace(/(\d*d\d+)(?![\dmr!k])/gi, '$1mi2'); };
        if (a.dtype === ad) a.damage = mi(a.damage);
        (a.parts || []).forEach(function(p) { if (p.type === ad) p.dice = mi(p.dice); });
        a.pierce = ad;
        a.adeptAdded = true;
    }
    METAMAGIC.forEach(function(m) {
        if (!on('mm-' + m.key)) return;
        a.meta.push(m.name);
        a.metaCost += m.cost;
        if (m.key === 'quick') a.cost = 'b';
        if (m.key === 'empower' && s) a.empower = Math.max(1, x2Cha(s));
        if (m.key === 'height') a.heighten = true;
        if (m.key === 'twin' && !a.twinAdded) { a.targets = (a.targets || 1) + 1; a.twinAdded = true; }
        if (m.key === 'distant' && !a.distAdded) { if (a.range > 0) a.range *= 2; else if (a.reach) { a.range = 30; a.reach = 0; a.meleeOnly = false; } a.distAdded = true; }
    });
    if (a.metaCost && act && act.caster && s) {
        var pts = cxCur(act.caster.sheet === s.id ? act.caster : x2Tok(s) || act.caster, RE_SP, '术法点', spMax(s));
        if (pts < a.metaCost) {
            notice('术法点不够（需要 ' + a.metaCost + '，剩 ' + pts + '），超魔没有生效', true, 5000);
            a.meta = []; a.metaCost = 0; a.empower = 0; a.heighten = false;
        }
    }
    if (!a.meta.length) a.empower = 0;
}

// 确认目标时，每个目标：咒剑诅咒（+熟练、19 重击）、脆弱诅咒（+1d6 黯蚀）、先天术法（法术攻击优势）、升阶（第一个目标豁免劣势）
function x2TargetMods(a, caster, tgt, o, first) {
    if (!caster) return;
    var csh = caster.sheet && sheets[caster.sheet], notes = o.note ? [o.note] : [];
    if (a.kind === 'attack') {
        var hc = statusList(tgt).filter(function(s) { return s.id === 'hexcurse' && s.by === caster.id; })[0];
        if (hc && csh && clsOn('hcWarlock')) {
            o.bonus = (o.bonus || []).concat([{ dice: String(sheetProf(csh)), type: a.dtype || '' }]);
            o.critOn = 19;
            notes.push('咒剑诅咒：伤害 +' + sheetProf(csh) + '，19–20 重击');
        }
        if (statusList(tgt).some(function(s) { return s.id === 'hexed' && s.by === caster.id; })) {
            o.bonus = (o.bonus || []).concat([{ dice: '1d6', type: '黯蚀' }]);
            notes.push('脆弱诅咒：+1d6 黯蚀');
        }
        if (a.isSpell && hasStatus(caster, 'innate') && csh && sorLv(csh) && clsOn('hcSorcerer')) {
            o.mode = o.mode === 'dis' ? '' : 'adv';
            notes.push('先天术法：法术攻击优势');
        }
    }
    if (a.kind === 'save' && a.heighten && first) o.mode = 'dis';
    o.note = notes.join('；');
}

// 结算之后：扣术法点、记凶蛮打手
function x2AfterAction(a, caster) {
    if (!caster) return;
    var s = caster.sheet && sheets[caster.sheet];
    if (a.metaCost && s) {
        cxSpendN(caster, RE_SP, '术法点', spMax(s), a.metaCost);
        notice('超魔：' + a.meta.join('、') + '（花 ' + a.metaCost + ' 点术法点）', false, 4000);
    }
    if (a.savage) markOnce(caster, 'savKey');
}

// ===== 通用特性：没有专门适配的特性也能「用一次」 =====
// 已自动化（职业按钮 / 判定修正 / 行动框）和纯被动、数值已经算在卡上的特性，不出「使用」按钮
var AUTOMATED_FEATS = /额外攻击|回气|动作如潮|不屈|战术思维|战术转进|究明攻击|巨人之力|符文|化兽|迅捷|狂暴|偷袭|诗人激励|功力|武艺|疾风连击|坚强防御|疾步如风|拨挡|震慑拳|圆融自在|元素同调|四象|运转周天|自我修复|神圣火花|驱散亡灵|神圣打击|强力施法|神圣干预|战争祭司|导引打击|战神祝福|战争化身|吐息武器|龙族飞翼|荒野变形|荒野伙伴|荒野复苏|原力蛮击|星图|星耀形态|宇宙预兆|奥术回想|招牌法术|预兆|专业预言|天眼通|灵光一闪|魔能炮台|奥法火器|要塞阵地|圣疗|至圣斩|圣武斩|引导神力|神圣感知|征服|守望|信实坐骑|守护灵光|勇气灵光|术法点|魔力泉涌|先天术法|超魔法|强效法术|瞬发法术|升阶法术|双生法术|谨慎法术|远程法术|延效法术|精微法术|追踪法术|转化法术|术法复苏|狂野魔法浪涌|混乱之潮|咒剑诅咒|饥渴魔刃|刃之魔契|邪魔活力|苦痛魔爆|秘法回流|巨武器|长柄武器大师|哨兵|神射手|强弩专家|擒抱者|战地施法者|幸运|防御式决斗|拦截|盾牌大师|酒馆斗殴者|徒手战斗|凶蛮打手|双持客|双武器战斗|紫龙新兵|元素掌控|武器精通|武器大师|反射闪避|魔法抗性|危机感应|侏儒狡黠|矮人体魄|精类血统|妖精血统|勇气|构装坚韧|伤害抗性|抗性$|吐息|法术反制|吸收元素|炼狱叱喝/;
var PASSIVE_FEATS = /^(生物种类|体型|速度|技能|豁免熟练|技能熟练|武器熟练|工具熟练|护甲受训|起始装备|施法|契约魔法|法术位|准备法术|施法属性|施法法器|戏法|改变(你的)?准备法术|黑暗视觉|属性值提升|语言|出神|敏锐感官|精灵血系|高等精灵|木精灵|适应力|多才多艺|法术书|仪式学家|学者|已知形态|野兽形态|变形时的规则|使用次数|必备工具|方案数量|已造物品|仿制魔法物品|无甲防御|龙族体魄|龙族血统|警戒|对决|箭术|防御|战斗风格|内嵌防护|哨兵之憩|特化设计|不知疲倦|德鲁伊语|工艺魔法|魔能祈唤|魔法学徒|医疗师|巫咒战士|圣职|记忆法术|扩展与替换法术书|将一道法术抄写到法术书中|替换法术书|准备一环或以上的法术|魔法连结|兽性本能)$|子职|法术$|法术表|扩展法术|行业工具|魔法物品方案|原初职能|^领袖之证$/;
function featKind(name) {
    var n = String(name || '').replace(/\s/g, '').replace(/。$/, '');
    if (/圣誓法术|扩展法术|法术表|^原初之一的教习$/.test(n)) return 'passive'; // 始终准备的法术列表、给专长的祈唤
    if (AUTOMATED_FEATS.test(n)) return 'auto';
    if (PASSIVE_FEATS.test(n)) return 'passive';
    return 'manual';
}
function genericFeats(sh) {
    var seen = {};
    return (sh && sh.features || []).map(function(f, i) { return { f: f, i: i }; }).filter(function(x) {
        var n = String(x.f.name || '').trim();
        if (!n || seen[n] || featKind(n) !== 'manual') return false;
        seen[n] = true;
        return true;
    });
}
// 卡上的「特殊资源」：没有被职业按钮管的（比如「冰刃 1/1」「法杖充能」）
function genericRes(it, sh) {
    return (it.res || []).filter(function(r) {
        var n = String(r.name || '');
        return !/环法术位$/.test(n) && !AUTOMATED_FEATS.test(n) && num(r.max, 0) > 0;
    });
}
function genericRowHtml(it) {
    var sh = it.sheet && sheets[it.sheet];
    if (!sh || !canEdit(it) || sh.kind !== 'pc') return '';
    var feats = genericFeats(sh), res = genericRes(it, sh);
    if (!feats.length && !res.length) return '';
    var b = res.map(function(r) {
        return '<button class="tt-btn small" data-act="cx-gn-r:' + escapeHtml(r.name) + '" title="用一次「' + escapeHtml(r.name) + '」：扣 1 次并在记录里写一句">' + escapeHtml(r.name) + ' ' + num(r.cur, 0) + '/' + num(r.max, 0) + '</button>';
    });
    if (feats.length) b.push('<select class="tt-select" data-genfeat style="max-width:130px;" title="没有专门适配的特性：选一个点「使用」，扣同名资源（有的话）、在记录里写一句；说明能解析出攻击 / 豁免 / 治疗时直接打开行动框">' +
        feats.map(function(x) { return '<option value="' + x.i + '">' + escapeHtml(x.f.name) + '</option>'; }).join('') + '</select>' +
        '<button class="tt-btn small" data-act="cx-gn-use" title="使用选中的特性">使用</button>');
    return '<div class="prop-row"><label>其他特性</label><span class="prop-btns" style="margin:0;">' + b.join('') + '</span></div>';
}
function genericUse(it, sh, what) {
    if (what === 'use') {
        var sel = $('selPanel').querySelector('[data-genfeat]'), f = sel && sh.features[+sel.value];
        if (!f) return;
        var fr = featRes(it, String(f.name).slice(0, 20), 0);
        if (fr && fr.r && num(fr.r.max, 0) > 0 && !spendFeat(it, String(fr.r.name), 0)) return;
        op({ op: 'chat', text: '🔹 ' + (it.label || sh.name) + ' 使用「' + f.name + '」' + (fr && fr.r ? '（剩 ' + Math.max(0, num(fr.r.cur, 0) - 1) + '/' + fr.r.max + '）' : '') });
        if (entryActionable(f.text)) castFromSheet(sh, { kind: 'feat', idx: String(sh.features.indexOf(f)) });
        else notice('「' + f.name + '」没有自动化：按特性说明手动处理（说明在角色卡「特性与专长」里）', false, 5000);
        return;
    }
    if (what.indexOf('r:') === 0) {
        var name = what.slice(2);
        if (!spendFeat(it, name, 0)) return;
        var r2 = (it.res || []).filter(function(r) { return r.name === name; })[0];
        op({ op: 'chat', text: '🔹 ' + (it.label || sh.name) + ' 使用「' + name + '」' + (r2 ? '（剩 ' + Math.max(0, num(r2.cur, 0) - 1) + '/' + r2.max + '）' : '') });
        var ft = (sh.features || []).filter(function(f) { return f.name === name || String(f.text || '').indexOf(name) >= 0 && /施展|施放/.test(f.text || ''); })[0];
        var sp = (sh.spells || []).findIndex(function(s) { return s.name === name; });
        if (sp >= 0) { actPreset = { caster: it, noSlot: true, at: Date.now() }; castFromSheet(sh, { kind: 'spell', idx: String(sp) }); }
        else if (ft && entryActionable(ft.text)) castFromSheet(sh, { kind: 'feat', idx: String(sh.features.indexOf(ft)) });
    }
}

// 角色卡上的「自动化情况」：哪些特性已经自动处理，哪些要手动
function autoStatusHtml(sh) {
    if (!sh || sh.kind !== 'pc' || !(sh.features || []).length) return '';
    var auto = [], manual = [], seen = {};
    sh.features.forEach(function(f) {
        var n = String(f.name || '').replace(/。$/, '').trim();
        if (!n || seen[n]) return;
        seen[n] = true;
        var k = featKind(n);
        if (k === 'auto') auto.push(n); else if (k === 'manual') manual.push(n);
    });
    if (!auto.length && !manual.length) return '';
    return '<details class="side-section auto-status"><summary><b>⚙ 自动化情况</b> <span class="tt-hint">已自动 ' + auto.length + ' · 需手动 ' + manual.length + '</span></summary>' +
        (auto.length ? '<div class="tt-hint">✅ 已自动处理（棋子属性面板 / 行动框 / 服务器结算）：' + escapeHtml(auto.join('、')) + '</div>' : '') +
        (manual.length ? '<div class="tt-hint">✋ 需要按说明手动处理（棋子属性面板「其他特性」可以一键扣次数、记一笔）：' + escapeHtml(manual.join('、')) + '</div>' : '') + '</details>';
}

// 重新导入（覆盖）人物卡后：已放置棋子的资源上限跟着卡变，并报告新增 / 需手动的特性
function sheetReimportSync(old, sh) {
    if (!old) return;
    var patches = [];
    sortedItems().forEach(function(t) {
        if (t.kind !== 'token' || t.sheet !== sh.id || !canEdit(t)) return;
        var res = JSON.parse(JSON.stringify(t.res || [])), ch = false;
        (sh.resources || []).forEach(function(r) {
            var max = num(r.max, 0), x = res.filter(function(y) { return y.name === String(r.name).slice(0, 20); })[0];
            if (!(max > 0)) return;
            if (!x) { if (res.length < 16) { res.push({ id: genId(), name: String(r.name).slice(0, 20), type: 'count', cur: max, max: max, icon: 'gem' }); ch = true; } return; }
            if (num(x.max, 0) !== max) { x.cur = Math.max(0, Math.min(max, num(x.cur, 0) + max - num(x.max, 0))); x.max = max; ch = true; }
        });
        (sh.slots || []).forEach(function(s) {
            var max = num(s.max, 0), name = s.level + '环法术位', x = res.filter(function(y) { return y.name === name; })[0];
            if (max > 0 && !x && res.length < 16) { res.push({ id: genId(), name: name, type: 'count', cur: num(s.cur, max), max: max, icon: 'spellbook' }); ch = true; }
            else if (x && num(x.max, 0) !== max) { x.max = max; x.cur = Math.min(max, num(s.cur, max)); ch = true; }
        });
        var p = { id: t.id };
        if (ch) p.res = res;
        var hm = sh.hp ? num(sh.hp.max, 0) : 0;
        if (hm > 0 && hm !== num(t.hpMax, 0)) { p.hp = Math.max(0, num(t.hp, hm) + hm - num(t.hpMax, hm)); p.hpMax = hm; }
        var ac = parseFloat(sh.ac);
        if (ac > 0 && ac !== num(t.ac, 0)) p.ac = ac;
        if (Object.keys(p).length > 1) patches.push(p);
    });
    if (patches.length) patchItems(patches);
    var oldNames = {};
    (old.features || []).forEach(function(f) { oldNames[f.name] = 1; });
    var added = (sh.features || []).filter(function(f) { return f.name && !oldNames[f.name]; }).map(function(f) { return f.name; });
    var manual = added.filter(function(n) { return featKind(n) === 'manual'; });
    var msg = '已用新卡更新「' + sh.name + '」' + (sh.class ? '：' + sh.class + (sh.subclass ? '·' + sh.subclass : '') + ' ' + (sh.level || '') + ' 级' : '') +
        (patches.length ? '；' + patches.length + ' 个棋子的血量上限 / AC / 资源跟着更新' : '') +
        (added.length ? '；新增特性 ' + added.length + ' 个' + (manual.length ? '，其中需要手动处理：' + manual.join('、') : '（都已自动化或是被动）') : '');
    notice(msg, false, 9000);
}
