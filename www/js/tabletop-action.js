// 跑团桌面：行动（攻击 / 法术 / 能力）—— 选目标、看范围、一键结算
// - 从武器、法术说明、怪物动作文字里自动识别：攻击加值、伤害骰与类型、治疗、豁免属性与 DC、
//   成功减半、射程 / 触及、范围形状（球 / 锥 / 线 / 立方）与大小、目标数、附带状态、专注
// - 行动框里所有字段都可以手动改；也可以「自定义行动」从空白开始填
// - 地图上显示射程圈和范围模板，点选目标或放置范围；确认后由服务器掷骰并结算到每个目标
//   （攻击对 AC、豁免对 DC、抗性 / 免疫 / 易伤、治疗、临时生命、状态、专注）
// 依赖 tabletop.js / tabletop-sheets.js / tabletop-combat.js / tabletop-status.js 的全局状态与函数

var ABIL_KEY = { '力量': 'str', '敏捷': 'dex', '体质': 'con', '智力': 'int', '感知': 'wis', '魅力': 'cha' };
var CN_NUM = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
var DMG_TYPES = '强酸|钝击|寒冷|火焰|力场|闪电|黯蚀|暗蚀|死灵|穿刺|毒素|心灵|光耀|挥砍|雷鸣';
var SPELL_BUFFS = { '祝福术': 'blessed', '灾祸术': 'baned', '加速术': 'hasted', '侵扰术': 'hexed', '神导术': 'guidance', '隐形术': 'invisible' };
var ACT_KINDS = [['attack', '攻击检定'], ['save', '豁免'], ['auto', '自动命中伤害'], ['heal', '治疗'], ['temp', '临时生命'], ['effect', '仅附加状态']];
var AREA_SHAPES = [['', '无（点选目标）'], ['circle', '球形 / 圆形（半径）'], ['cone', '锥形（长度）'], ['line', '直线（长度）'], ['cube', '立方（边长）'],
    ['wall', '直墙（点两下定起点和方向）'], ['path', '自由形状墙（连续路径）'], ['ring', '环形墙（直径）']];
// 大小那一栏的含义
var AREA_SIZE_LABEL = { circle: '半径', cone: '长度', line: '长度', cube: '边长', wall: '最长', path: '总长至多', ring: '直径' };
// 在地图上逐点放置的形状（直墙、自由路径、不从自身发出的直线）
function isPathShape(ar) { return ar && (ar.shape === 'wall' || ar.shape === 'path' || (ar.shape === 'line' && !ar.self)); }
function hasWidth(ar) { return ar && (ar.shape === 'line' || ar.shape === 'wall' || ar.shape === 'path' || ar.shape === 'ring'); }

var act = null;        // 行动框里正在编辑的行动
var actionMode = null; // 地图选目标状态 { act, caster, targets:{}, aim, locked }

function cnInt(s) { return /^\d+$/.test(s) ? parseInt(s, 10) : (CN_NUM[s] || 0); }
function ftToPx(ft) { return ft / num(scene.props.gridScale, 5) * gridSize(); }

// ===== 从文字识别行动 =====
function parseActionText(name, text, meta) {
    var t = String(meta || '') + '\n' + String(text || '');
    var a = { name: name || '行动', range: 0, area: { shape: '', size: 0, width: 5, self: false }, targets: 1 };
    var m;
    // 伤害：「10（2d6+3）点挥砍伤害」「受到8d6点火焰伤害」
    m = t.match(new RegExp('[（(]\\s*(\\d+d\\d+(?:\\s*[+＋\\-－]\\s*\\d+)?)\\s*[)）]\\s*点?\\s*(' + DMG_TYPES + ')?\\s*伤害'));
    if (m) { a.damage = m[1]; a.dtype = m[2] || ''; }
    else if ((m = t.match(new RegExp('(\\d+d\\d+(?:\\s*[+＋\\-－]\\s*\\d+)?)(\\s*[+＋]\\s*你?的?施法属性调整值)?\\s*(?:点|的)?\\s*(' + DMG_TYPES + ')?\\s*伤害')))) {
        a.damage = m[1]; a.dtype = m[3] || ''; a.dmgMod = !!m[2];
    }
    if (a.damage) a.damage = a.damage.replace(/\s/g, '').replace(/＋/g, '+').replace(/[－−]/g, '-');
    if (a.dtype === '暗蚀') a.dtype = '黯蚀'; // 2024 版译作「暗蚀」
    // 治疗 / 临时生命
    var heal = t.match(/(?:恢复|回复)[^。\n]{0,30}?(\d+d\d+(?:\s*[+＋]\s*\d+)?)([^。\n]{0,20})/);
    if (heal && /生命/.test(heal[0] + heal[2])) { a.heal = heal[1].replace(/\s|＋/g, function(c) { return c === '＋' ? '+' : ''; }); a.healMod = /施法属性调整值/.test(heal[2]); }
    var temp = t.match(/(\d+d\d+(?:\s*[+＋]\s*\d+)?)[^。\n]{0,12}临时生命/) || t.match(/临时生命[^。\n]{0,12}?(\d+d\d+(?:\s*[+＋]\s*\d+)?)/);
    if (temp) a.temp = temp[1].replace(/\s/g, '');
    // 豁免
    m = t.match(/(力量|敏捷|体质|智力|感知|魅力)豁免/);
    if (m) a.save = ABIL_KEY[m[1]];
    m = t.match(/DC\s*(\d+)/i);
    if (m) a.dc = parseInt(m[1], 10);
    a.half = /减半|一半伤害|伤害的一半|半数伤害|半伤/.test(t);
    // 攻击
    if (/法术攻击/.test(t)) a.spellAttack = true;
    m = t.match(/(?:攻击检定|命中)\s*[：:]?\s*([+＋\-－]\s*\d+)/);
    if (m) a.attack = m[1].replace(/\s/g, '').replace('＋', '+').replace(/[－−]/, '-');
    // 射程 / 触及
    m = t.match(/射程\s*(\d+)\s*[\/／]\s*(\d+)/);
    if (m) { a.range = +m[1]; a.rangeLong = +m[2]; }
    else if ((m = t.match(/(?:施法距离|射程)\s*[：:]?\s*(\d+)\s*尺/))) a.range = +m[1];
    if ((m = t.match(/触及\s*(\d+)\s*尺/))) a.reach = +m[1];
    String(meta || '').split(/\s*·\s*/).forEach(function(part) {
        if (/^\d+\s*尺$/.test(part)) a.range = parseInt(part, 10);
        else if (/^触碰/.test(part)) a.reach = 5;
        else if (/^自身/.test(part)) a.area.self = true;
    });
    if (/施法距离[：:]\s*触碰/.test(t)) a.reach = 5;
    if (/施法距离[：:]\s*自身/.test(t)) a.area.self = true;
    // 范围
    // 光环 / 散发 / 以自身所在空间为中心 → 从自身展开
    var selfCenter = /光环|散发|以(?:它|你|其|自身)所在(?:的)?空间为中心|以(?:你|自身)为中心/.test(t);
    // 取正文里最先出现的范围描述（妖火「20尺立方区域」在前，后面「10尺半径的微光」只是照明）
    var areaCands = [];
    var areaCand = function(re, mk) { var mm = re.exec(t); if (mm) areaCands.push({ i: mm.index, area: mk(mm) }); };
    var selfNow = a.area.self;
    [/(\d+)\s*尺\s*半径/, /半径\s*(\d+)\s*尺/, /(\d+)\s*尺\s*的?\s*(?:光环|散发)/].forEach(function(re) {
        areaCand(re, function(mm) { return { shape: 'circle', size: +mm[1], width: 5, self: selfNow || selfCenter }; });
    });
    areaCand(/(\d+)\s*尺\s*的?\s*(?:长的?)?\s*锥/, function(mm) { return { shape: 'cone', size: +mm[1], width: 5, self: true }; });
    // 「长100尺、宽5尺的直线」
    areaCand(/长\s*(\d+)\s*尺\s*[、，,]?\s*(?:宽\s*(\d+)\s*尺)?\s*的?\s*(?:直线|线状|线形)/, function(mm) { return { shape: 'line', size: +mm[1], width: +(mm[2] || 5), self: true }; });
    areaCand(/(\d+)\s*尺\s*(?:长)?(?:[，,、]?\s*(\d+)\s*尺\s*宽)?\s*的?\s*(?:直线|线状|线形)/, function(mm) { return { shape: 'line', size: +mm[1], width: +(mm[2] || 5), self: true }; });
    // 「20尺立方」「20尺见方」「20尺方格区域」「20尺方状区域」
    areaCand(/(\d+)\s*尺\s*的?\s*(?:立方|见方|方格|方形|方状|方块|正方)/, function(mm) { return { shape: 'cube', size: +mm[1], width: 5, self: selfNow }; });
    if (areaCands.length) a.area = areaCands.sort(function(x, y) { return x.i - y.i; })[0].area;
    // 墙：「长至多50尺、高15尺、厚1尺」「可塑造为任意形状 / 连续路径」「直径至多20尺的环形墙」「十块10尺×10尺的嵌板」
    if (/墙|屏障|护壁/.test(t)) {
        var wl = t.match(/长(?:度)?\s*(?:为|可达|达)?\s*(?:至多|最多|不超过|不过)?\s*(\d+)\s*尺/);
        var panels = t.match(/([一二两三四五六七八九十\d]+)\s*(?:块|片|个)[^。\d一二两三四五六七八九十]{0,8}?(\d+)\s*(?:尺)?\s*[×xX＊*乘]\s*\d+\s*尺/);
        var th = t.match(/厚(?:度)?\s*(?:为|达)?\s*(?:至多|最多|不超过|不过)?\s*(\d+)\s*尺/) || t.match(/(\d+)\s*尺\s*厚/);
        var ringM = t.match(/直径\s*(?:为)?\s*(?:至多|最多|不超过|不过)?\s*(\d+)\s*尺[^。；;]{0,24}环/) || t.match(/环形[^。；;]{0,20}?直径\s*(?:至多|最多|不超过|不过)?\s*(\d+)\s*尺/);
        var free = /任意形状|任何形状|连续(?:的)?路径|形状由你决定|蜿蜒|相邻/.test(t);
        // 有嵌板时按嵌板算总长（冰墙术「半球状（半径最长10尺）……十个10尺×10尺的方板块」）
        var len = panels ? (cnInt(panels[1]) || 1) * +panels[2] : wl ? +wl[1] : 0;
        if (len) a.area = { shape: free || panels ? 'path' : 'wall', size: len, width: th ? +th[1] : (panels ? 1 : 1), self: false };
        else if (ringM) a.area = { shape: 'ring', size: +ringM[1], width: th ? +th[1] : 1, self: false };
        if (ringM) a.area.ringSize = +ringM[1];
    }
    // 目标数
    if ((m = t.match(/至多\s*([一二两三四五六七八九十\d]+)\s*(?:名|个)/))) a.targets = cnInt(m[1]) || 1;
    // 魔法飞弹「三枚飞镖」、灼热射线「三道射线」：每一发可以打不同目标
    else if ((m = t.match(/(?:创造|射出|发射|造出)\s*([一二两三四五六七八九十\d]+)\s*(?:枚|支|道|发|束)/))) a.targets = cnInt(m[1]) || 1;
    // 附带状态
    var buff = Object.keys(SPELL_BUFFS).filter(function(k) { return (name || '').indexOf(k) >= 0; })[0];
    if (buff) a.status = SPELL_BUFFS[buff];
    else {
        // 取正文里最早出现的状态；「免疫力竭状态」「无法受益于隐形状态」「结束束缚状态」这类否定说法不算
        var best = -1;
        STATUS_DEFS.forEach(function(d) {
            if (['concentration', 'advantage', 'disadvantage', 'hidden', 'bardic', 'guidance', 'dodging', 'raging'].indexOf(d.id) >= 0) return;
            [d.name + '状态', '陷入' + d.name, '变得' + d.name].forEach(function(w) {
                for (var i = t.indexOf(w); i >= 0; i = t.indexOf(w, i + 1)) {
                    // 只看紧挨着的前几个字：「免疫力竭状态」「无法受益于隐形状态」「结束其束缚状态」算否定，「回合结束陷入失能状态」不算
                    var before = t.slice(Math.max(0, i - 8), i);
                    if (/(?:免疫|无法受益于?|不受|不会|结束|解除|移除|终止|摆脱|不再)(?:其|该|此|所有|此类)?(?:的)?$/.test(before)) continue;
                    if (best < 0 || i < best) { best = i; a.status = d.id; }
                    break;
                }
            });
        });
    }
    a.conc = /专注/.test(String(meta || '')) || /持续时间[：:]\s*专注/.test(t);
    // 类型
    if (a.attack || a.spellAttack) a.kind = 'attack';
    else if (a.save) a.kind = 'save';
    else if (a.heal) a.kind = 'heal';
    else if (a.temp) a.kind = 'temp';
    else if (a.damage) a.kind = 'auto';
    else if (a.status) a.kind = 'effect';
    return a;
}

function sheetCasting(sh) { return sh && sh.casting && sh.casting[0] || null; }

function castingMod(sh) {
    var c = sheetCasting(sh);
    if (!c || !sh.abilities) return 0;
    var ab = sh.abilities.filter(function(a) { return a.name === c.ability || a.key === ABIL_KEY[c.ability]; })[0];
    return ab ? num(String(ab.mod || '0').replace('+', ''), 0) : 0;
}

// 施放者：从棋子打开的卡用那个棋子，否则关联这张卡的棋子（优先自己的），再否则当前攻击者
function casterFor(sh) {
    var tok = sheetView.tokenId && scene.items[sheetView.tokenId];
    if (tok && tok.sheet === (sh && sh.id)) return tok;
    if (sh) {
        var list = sortedItems().filter(function(t) { return t.kind === 'token' && t.sheet === sh.id; });
        // 同一张怪物卡放了多个棋子：优先用正在行动的那个，其次是选中的那个
        var cs = combatState(), cur = cs && scene.items[cs.turn];
        if (cur && cur.sheet === sh.id && canEdit(cur)) return cur;
        var sel = list.filter(function(t) { return selected[t.id] && canEdit(t); })[0];
        if (sel) return sel;
        var mine = list.filter(function(t) { return canEdit(t); });
        if (mine.length || list.length) return (mine[0] || list[0]);
    }
    return attackerToken();
}

// 把识别结果补成可以直接用的行动（施法属性、DC、治疗调整值）
function finishAction(a, sh) {
    var c = sheetCasting(sh);
    if (a.spellAttack && !a.attack && c) a.attack = normBonus(c.atk) || '+0';
    if (a.save && !a.dc && c) a.dc = parseInt(c.dc, 10) || 0;
    if (a.kind === 'heal' && a.healMod) {
        var mod = castingMod(sh);
        if (mod) a.heal += signed(mod);
    }
    if (a.kind === 'heal' || a.kind === 'temp') a.damage = a.heal || a.temp;
    else if (a.dmgMod && a.damage) { // 「1d8+你的施法属性调整值」
        var dm = castingMod(sh);
        if (dm) a.damage += signed(dm);
    }
    return a;
}

// ===== 升环 / 戏法强化 =====
// 升环：「使用的法术位每比二环高一环，伤害增加1d10」「使用2环或更高的法术位…每高一环…提高1d8」
//       「每比一环高一环，就会多制造出一支飞镖」（多一个目标）
// 戏法强化：「5级（2d8）、11级（3d8）、17级（4d8）」按角色等级取对应的骰子
function parseScaling(t) {
    var out = {};
    t = String(t || '');
    var i = t.search(/升环|更高环位|更高的法术位/);
    if (i >= 0) {
        var s = t.slice(i, i + 180).split('\n')[0], from = 0, fm;
        if ((fm = s.match(/比\s*([一二三四五六七八九\d])\s*环高/) || s.match(/高于\s*([一二三四五六七八九\d])\s*环/))) from = cnInt(fm[1]);
        else if ((fm = s.match(/使用\s*([一二三四五六七八九\d])\s*环或更高/))) from = cnInt(fm[1]) - 1;
        var dice = s.match(/(?:增加|提高|多)\s*(\d+d\d+)/) || s.match(/(\d+d\d+)/);
        var extra = /(?:多|额外)(?:制造出?|发射|创造|射出)?\s*(?:一|1)\s*(?:支|道|枚|发|个|条|束)/.test(s);
        if (dice || extra) out.upcast = { from: from, dice: dice ? dice[1] : '', extra: !dice && extra };
    }
    var j = t.indexOf('戏法强化');
    if (j >= 0) {
        var tiers = [], re = /(\d+)\s*级[^（(，,、。\d]{0,6}(?:\d+d\d+)?\s*[（(]\s*(\d+d\d+)/g, mm, seg = t.slice(j, j + 220);
        while ((mm = re.exec(seg))) tiers.push([+mm[1], mm[2]]);
        if (tiers.length) out.cantrip = tiers;
    }
    return out;
}

// 给表达式加上 n 份骰子：同面数的合并（2d10 + 1d10 → 3d10），否则追加
function addDice(expr, inc, n) {
    var im = String(inc || '').match(/^(\d+)d(\d+)$/);
    if (!im || !(n > 0)) return expr;
    var cnt = +im[1] * n, die = im[2];
    var re = new RegExp('(^|[+\\-])(\\d+)d' + die + '(?!\\d)');
    if (re.test(expr)) return expr.replace(re, function(all, sign, c) { return sign + (+c + cnt) + 'd' + die; });
    return (expr ? expr + '+' : '') + cnt + 'd' + die;
}

// 法术：环阶、升环、戏法强化、是否持续（在地图上保留区域）
function applySpellScaling(a, sp, text, meta, sh) {
    var sc = parseScaling(text);
    a.spellLevel = parseInt(sp.level, 10) || 0;
    if (a.spellLevel === 0 && sc.cantrip && a.damage) {
        var lv = parseInt(sh && sh.level, 10) || 1, pick = null;
        sc.cantrip.forEach(function(t) { if (lv >= t[0]) pick = t[1]; });
        if (pick) { a.damage = a.damage.replace(/^\d+d\d+/, pick); a.scaleNote = '戏法强化：' + lv + ' 级 → ' + pick; }
    }
    if (a.spellLevel > 0 && sc.upcast) {
        a.upcast = sc.upcast;
        if (!a.upcast.from) a.upcast.from = a.spellLevel;
    }
    a.slotLevel = a.spellLevel;
    a.baseDamage = a.damage || '';
    a.baseTargets = a.targets || 1;
    // 持续时间：不全书正文里有「持续时间：专注，至多1分钟」，角色卡导入的法术可能写在 meta 的最后一段
    var dm = String(text || '').match(/持续时间[：:]\s*([^\n]+)/);
    var dur = dm ? dm[1] : (meta ? String(meta).split(/\s*·\s*/).pop() : '');
    a.lasting = !!(a.area && a.area.shape) && !!dur && !/立即/.test(dur) && /专注|分钟|小时|轮|天/.test(dur);
    a.zone = a.lasting;
    return a;
}

// 角色卡上某一环的法术位（没有就 null）
function slotOf(sh, lv) {
    var list = sh && sh.slots || [];
    for (var i = 0; i < list.length; i++) if (parseInt(list[i].level, 10) === lv) return { idx: i, cur: num(list[i].cur, 0), max: num(list[i].max, 0) };
    return null;
}

// 换环阶：按升环规则重算伤害 / 治疗骰和目标数
function applySlotLevel(a, lv) {
    a.slotLevel = lv;
    if (!a.upcast) return;
    var n = Math.max(0, lv - a.upcast.from);
    if (a.upcast.dice) a.damage = addDice(a.baseDamage, a.upcast.dice, n);
    if (a.upcast.extra) a.targets = (a.baseTargets || 1) + n;
}

// 施放时扣法术位（勾了「消耗法术位」时）
function consumeSlot(a, sheetId) {
    var sh = sheetId && sheets[sheetId];
    if (!a.useSlot || !(a.slotLevel > 0) || !sh || !canEditSheet(sh)) return;
    var s = slotOf(sh, a.slotLevel);
    if (s && s.cur > 0) { changeSlot(sh, s.idx, -1); notice('已消耗 1 个 ' + a.slotLevel + ' 环法术位（剩 ' + (s.cur - 1) + '）'); }
    else notice('没有剩余的 ' + a.slotLevel + ' 环法术位（仍然施放了，可在角色卡上调整）', true);
}

function actionFromAttack(sh, at) {
    var r = parseAttackRange((at.props || '') + ' ' + (at.range || ''));
    return { name: at.name, kind: 'attack', attack: normBonus(at.atk) || '+0', damage: String(at.damage || '').replace(/\s/g, ''), dtype: at.type || '',
        range: r.normal || 0, rangeLong: r.long || 0, reach: r.reach || 0, area: { shape: '', size: 0, width: 5, self: false }, targets: 1 };
}

// 打开行动框：kind = atk / spell / entry / feat
function castFromSheet(sh, ds) {
    if (!sh) return;
    var caster = casterFor(sh);
    if (ds.kind === 'atk') { openActionDialog(actionFromAttack(sh, sh.attacks[+ds.idx]), caster, sh); return; }
    if (ds.kind === 'spell') {
        var sp = sh.spells[+ds.idx];
        var go = function(text, meta) {
            var a = parseActionText(sp.name, text, meta);
            if (!a.kind && /法术攻击/.test(text)) a.kind = 'attack';
            a = applySpellScaling(finishAction(a, sh), sp, text, meta, sh);
            // 有法术位时默认选能用的最低一环
            if (a.spellLevel > 0 && sh.slots && sh.slots.length) {
                for (var lv = a.spellLevel; lv <= 9; lv++) { var s = slotOf(sh, lv); if (s && s.cur > 0) { applySlotLevel(a, lv); break; } }
                a.useSlot = canEditSheet(sh);
            }
            openActionDialog(a, caster, sh);
        };
        if (sp.text) { go(sp.text, sp.meta); return; }
        notice('正在查找「' + sp.name + '」的法术说明…');
        findSpell(sp.name, sp.level).then(function(found) {
            if (found) go(found.text, found.meta);
            else { notice('没找到法术说明，请手动填写', true); openActionDialog(finishAction({ name: sp.name, area: { shape: '', size: 0, width: 5 }, targets: 1 }, sh), caster, sh); }
        });
        return;
    }
    var en = ds.kind === 'entry' ? sh.sections[+ds.sec].entries[+ds.idx] : sh.features[+ds.idx];
    var name = (en.name || '').replace(/。$/, '');
    openActionDialog(finishAction(parseActionText(name, en.text, ''), sh), caster, sh);
}

// 动作条目是否值得显示 ⚡ 按钮
function entryActionable(text) {
    var a = parseActionText('', text, '');
    return !!a.kind;
}

// ===== 行动框 =====
function openActionDialog(a, caster, sh) {
    a = a || { name: '自定义行动', kind: 'auto', area: { shape: '', size: 0, width: 5 }, targets: 1 };
    a.area = a.area || { shape: '', size: 0, width: 5 };
    act = { a: a, caster: caster || null, sheet: sh || null };
    var f = function(id) { return $(id); };
    f('acName').value = a.name || '';
    f('acKind').innerHTML = ACT_KINDS.map(function(k) { return '<option value="' + k[0] + '">' + k[1] + '</option>'; }).join('');
    f('acKind').value = a.kind || 'auto';
    f('acAttack').value = a.attack || '';
    f('acDamage').value = a.damage || '';
    var types = DMG_TYPES.split('|');
    f('acDtype').innerHTML = '<option value="">（无类型）</option>' + types.map(function(t) { return '<option value="' + t + '">' + t + '</option>'; }).join('') +
        (a.dtype && types.indexOf(a.dtype) < 0 ? '<option value="' + escapeHtml(a.dtype) + '">' + escapeHtml(a.dtype) + '</option>' : '');
    f('acDtype').value = a.dtype || '';
    // 环阶（升环）
    if (a.spellLevel > 0) {
        var top = 9;
        if (sh && sh.slots && sh.slots.length) top = Math.max(a.spellLevel, Math.max.apply(null, sh.slots.map(function(s) { return parseInt(s.level, 10) || 0; })));
        var opts = '';
        for (var lv = a.spellLevel; lv <= top; lv++) {
            var s = slotOf(sh, lv);
            opts += '<option value="' + lv + '">' + lv + ' 环' + (s ? '（剩 ' + s.cur + '/' + s.max + '）' : sh && sh.slots && sh.slots.length ? '（没有法术位）' : '') + '</option>';
        }
        f('acSlot').innerHTML = opts;
        f('acSlot').value = a.slotLevel || a.spellLevel;
        f('acUseSlot').checked = !!a.useSlot;
        f('acUseSlot').parentNode.style.display = sh && sh.slots && sh.slots.length && canEditSheet(sh) ? '' : 'none';
        f('acUpHint').textContent = a.upcast ? (a.upcast.dice ? '每高一环 +' + a.upcast.dice : '每高一环多 1 个目标') : '';
        f('acSlotRow').style.display = '';
    } else f('acSlotRow').style.display = 'none';
    f('acScaleNote').textContent = a.scaleNote || '';
    f('acZone').checked = !!a.zone;
    f('acSave').value = a.save || 'dex';
    f('acDC').value = a.dc || '';
    f('acHalf').checked = !!a.half;
    f('acRange').value = a.range || (a.reach && !a.rangeLong ? a.reach : '') || '';
    f('acLong').value = a.rangeLong || '';
    f('acShape').innerHTML = AREA_SHAPES.map(function(s) { return '<option value="' + s[0] + '">' + s[1] + '</option>'; }).join('');
    f('acShape').value = a.area.shape || '';
    f('acSize').value = a.area.size || '';
    f('acWidth').value = a.area.width || '';
    f('acSelf').checked = !!a.area.self;
    f('acTargets').value = a.targets || 1;
    f('acStatus').innerHTML = '<option value="">（无）</option>' + STATUS_DEFS.map(function(d) { return '<option value="' + d.id + '">' + d.icon + ' ' + d.name + '</option>'; }).join('');
    f('acStatus').value = a.status || '';
    f('acRounds').value = a.rounds || '';
    f('acConc').checked = !!a.conc;
    f('acHidden').checked = $('diceHidden').checked;
    f('acCaster').textContent = caster ? (caster.label || '未命名棋子') : '（未指定：先在地图上选中你的棋子再打开，或不限距离）';
    syncActionDialog();
    $('actDialog').style.display = 'flex';
}

function readActionDialog() {
    var a = act.a, v = function(id) { return $(id).value.trim(); };
    a.name = v('acName') || '行动';
    a.kind = v('acKind');
    a.attack = normBonus(v('acAttack')) || (a.kind === 'attack' ? '+0' : '');
    a.damage = v('acDamage').replace(/\s/g, '');
    a.dtype = v('acDtype');
    if (a.spellLevel > 0) { a.slotLevel = parseInt(v('acSlot'), 10) || a.spellLevel; a.useSlot = $('acUseSlot').checked; }
    a.zone = $('acZone').checked;
    a.save = v('acSave');
    a.dc = parseInt(v('acDC'), 10) || 0;
    a.half = $('acHalf').checked;
    a.range = parseFloat(v('acRange')) || 0;
    a.rangeLong = parseFloat(v('acLong')) || 0;
    var oldArea = a.area || {};
    a.area = { shape: v('acShape'), size: parseFloat(v('acSize')) || 0, width: parseFloat(v('acWidth')) || oldArea.width || 5, self: $('acSelf').checked, ringSize: oldArea.ringSize };
    a.targets = Math.max(1, parseInt(v('acTargets'), 10) || 1);
    a.status = v('acStatus');
    a.rounds = parseInt(v('acRounds'), 10) || 0;
    a.conc = $('acConc').checked;
    a.hidden = $('acHidden').checked;
    return a;
}

function syncActionDialog() {
    var k = $('acKind').value, shape = $('acShape').value;
    $('acAttackRow').style.display = k === 'attack' ? '' : 'none';
    $('acSaveRow').style.display = k === 'save' ? '' : 'none';
    $('acDamageRow').style.display = k === 'effect' ? 'none' : '';
    $('acDamageLabel').textContent = k === 'heal' ? '治疗' : k === 'temp' ? '临时生命' : '伤害';
    $('acDtype').style.display = k === 'heal' || k === 'temp' ? 'none' : '';
    $('acSizeWrap').style.display = shape ? '' : 'none';
    $('acSizeLabel').textContent = AREA_SIZE_LABEL[shape] || '大小';
    $('acWidthWrap').style.display = hasWidth({ shape: shape }) ? '' : 'none';
    $('acSelfLabel').style.display = shape === 'wall' || shape === 'path' ? 'none' : '';
    $('acZoneRow').style.display = shape ? '' : 'none';
    $('acTargetsWrap').style.display = shape ? 'none' : '';
}

function closeActionDialog() { $('actDialog').style.display = 'none'; }

// 不选目标：只掷骰（原来的掷骰确认框）
function actionRollOnly() {
    var a = readActionDialog(), who = act.sheet ? act.sheet.name : (act.caster && act.caster.label) || '';
    closeActionDialog();
    consumeSlot(a, act.sheet && act.sheet.id);
    if (a.kind === 'attack') openRollDialog({ who: who, label: a.name + ' 命中', bonus: a.attack, attack: true, range: { normal: a.range, long: a.rangeLong, reach: a.reach } });
    else if (a.damage) openRollDialog({ who: who, label: a.name + (a.kind === 'heal' ? ' 治疗' : a.kind === 'temp' ? ' 临时生命' : ' 伤害'), expr: a.damage });
    else notice('这个行动没有可以掷的骰子', true);
}

// ===== 地图选目标 =====
function startActionTargeting() {
    var a = readActionDialog();
    if ((a.kind === 'attack' || a.kind === 'auto' || a.kind === 'save') && a.kind !== 'attack' && !a.damage && !a.status) { notice('填写伤害骰或要附加的状态', true); return; }
    if (a.kind === 'save' && !a.dc) { notice('填写豁免 DC', true); return; }
    if ((a.kind === 'heal' || a.kind === 'temp') && !a.damage) { notice('填写治疗 / 临时生命的骰子', true); return; }
    closeActionDialog();
    actionMode = { act: a, caster: act.caster, targets: {}, aim: null, locked: false, sheetId: act.sheet ? act.sheet.id : '' };
    if (a.area.shape && a.area.self && act.caster) actionMode.aim = tokenCenter(act.caster);
    setTool('select');
    selectOnly([]);
    renderActionBar();
    requestRender();
}

function cancelActionTargeting() {
    actionMode = null;
    renderActionBar();
    requestRender();
}

function actionRangePx() {
    var a = actionMode.act, r = Math.max(a.range || 0, a.rangeLong || 0, a.reach || 0);
    return r > 0 ? ftToPx(r) : 0;
}

// 区域多边形 / 圆（世界坐标）；self 区域从施放者占格边缘朝鼠标方向展开
// ===== 逐点放置的墙 / 直线 =====
function pathLen(pts) {
    var l = 0;
    for (var i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return l;
}
// 下一个点：直线固定长度；直墙 / 自由路径不超过剩余长度
function clampNext(pts, w, ar) {
    var last = pts[pts.length - 1], dx = w.x - last[0], dy = w.y - last[1], d = Math.hypot(dx, dy);
    var maxPx = ftToPx(ar.size || 0);
    if (!d) return [last[0], last[1]];
    var len = ar.shape === 'line' ? maxPx : Math.min(d, Math.max(0, maxPx - pathLen(pts)));
    if (!(maxPx > 0)) len = d;
    return [last[0] + dx / d * len, last[1] + dy / d * len];
}
// 改了最长长度：把已经画好的路径截到新长度以内
function clampPath(pts, maxPx) {
    if (!(maxPx > 0) || pts.length < 2) return pts;
    var out = [pts[0]], left = maxPx;
    for (var i = 1; i < pts.length && left > 0; i++) {
        var a = out[out.length - 1], dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], d = Math.hypot(dx, dy);
        var k = d > left ? left / d : 1;
        out.push([a[0] + dx * k, a[1] + dy * k]);
        left -= d * k;
    }
    return out;
}

function actionShape() {
    var m = actionMode, a = m.act, ar = a.area;
    if (isPathShape(ar)) {
        var pts = (m.pts || []).slice(), wpx = ftToPx(ar.width || (ar.shape === 'line' ? 5 : 1));
        if (!pts.length) return m.aim ? { type: 'path', pts: [[m.aim.x, m.aim.y], [m.aim.x, m.aim.y]], w: wpx } : null;
        if (!m.locked && m.aim && !(ar.shape !== 'path' && pts.length >= 2)) pts.push(clampNext(pts, m.aim, ar));
        if (pts.length === 1) pts.push(pts[0]);
        return { type: 'path', pts: pts, w: wpx };
    }
    if (!ar.shape || !m.aim) return null;
    var size = ftToPx(ar.size || 0), c = m.caster ? tokenCenter(m.caster) : null;
    var half = m.caster ? hitPx(m.caster) : 0; // 从施放者判定圆的边缘展开
    if (ar.shape === 'ring') {
        var rc = ar.self && c ? c : m.aim;
        return { type: 'ring', x: rc.x, y: rc.y, r: size / 2, w: ftToPx(ar.width || 1) };
    }
    if (ar.shape === 'circle') {
        var center = ar.self && c ? c : m.aim;
        return { type: 'circle', x: center.x, y: center.y, r: size + (ar.self && c ? half : 0) };
    }
    var dirFrom = c && (ar.self || ar.shape !== 'cube') ? c : null;
    if (ar.shape === 'cube' && !dirFrom) {
        return { type: 'poly', pts: [[m.aim.x - size / 2, m.aim.y - size / 2], [m.aim.x + size / 2, m.aim.y - size / 2], [m.aim.x + size / 2, m.aim.y + size / 2], [m.aim.x - size / 2, m.aim.y + size / 2]] };
    }
    if (!dirFrom) dirFrom = { x: m.aim.x - 1, y: m.aim.y };
    var dx = m.aim.x - dirFrom.x, dy = m.aim.y - dirFrom.y, len = Math.hypot(dx, dy) || 1;
    var ux = dx / len, uy = dy / len, px = -uy, py = ux;
    var ox = dirFrom.x + ux * half, oy = dirFrom.y + uy * half;
    if (ar.shape === 'cone') { // 5e：锥形末端宽度 = 长度
        return { type: 'poly', pts: [[ox, oy], [ox + ux * size + px * size / 2, oy + uy * size + py * size / 2], [ox + ux * size - px * size / 2, oy + uy * size - py * size / 2]] };
    }
    var w = ar.shape === 'line' ? ftToPx(ar.width || 5) : size;
    return { type: 'poly', pts: [[ox + px * w / 2, oy + py * w / 2], [ox + ux * size + px * w / 2, oy + uy * size + py * w / 2],
        [ox + ux * size - px * w / 2, oy + uy * size - py * w / 2], [ox - px * w / 2, oy - py * w / 2]] };
}

// 生物的判定圆只要有一部分在区域内就算
function tokenInShape(t, sh) {
    var c = tokenCenter(t), r = hitPx(t);
    if (sh.type === 'circle') return Math.hypot(c.x - sh.x, c.y - sh.y) < sh.r + r;
    if (sh.type === 'ring') return Math.abs(Math.hypot(c.x - sh.x, c.y - sh.y) - sh.r) < sh.w / 2 + r;
    if (sh.type === 'path') {
        for (var k = 1; k < sh.pts.length; k++) {
            if (distToSeg(c.x, c.y, sh.pts[k - 1][0], sh.pts[k - 1][1], sh.pts[k][0], sh.pts[k][1]) < sh.w / 2 + r) return true;
        }
        return false;
    }
    if (pointInPoly(c.x, c.y, sh.pts)) return true;
    for (var i = 0; i < sh.pts.length; i++) {
        var p1 = sh.pts[i], p2 = sh.pts[(i + 1) % sh.pts.length];
        if (distToSeg(c.x, c.y, p1[0], p1[1], p2[0], p2[1]) < r) return true;
    }
    return false;
}

function actionCandidates() {
    return sortedItems().filter(function(t) { return t.kind === 'token' && isCreatureToken(t) && (!t.hidden || me.gm) && visibleToMe(t); });
}

function inActionRange(t) {
    var m = actionMode, a = m.act;
    if (!m.caster) return true;
    var lim = Math.max(a.range || 0, a.rangeLong || 0, a.reach || 0);
    return !lim || t.id === m.caster.id || creatureDist(m.caster, t) <= lim;
}

function recomputeAreaTargets() {
    var m = actionMode, sh = actionShape();
    m.targets = {};
    if (!sh) return;
    actionCandidates().forEach(function(t) {
        if (m.act.area.self && m.caster && t.id === m.caster.id) return; // 从自身展开的范围默认不含自己
        if (tokenInShape(t, sh)) m.targets[t.id] = true;
    });
}

function actionPointerDown(w, e) {
    var m = actionMode, a = m.act;
    var hit = hitTest(w, ['token']);
    if (hit && (!isCreatureToken(hit) || !visibleToMe(hit))) hit = null;
    if (isPathShape(a.area)) {
        if (m.locked && hit) { // 已放好：点生物切换是否包含
            if (m.targets[hit.id]) delete m.targets[hit.id]; else m.targets[hit.id] = true;
        } else if (m.locked || !m.pts || !m.pts.length) { // 起点（重新放置）
            if (m.caster && actionRangePx()) {
                var c0 = tokenCenter(m.caster);
                if (Math.hypot(w.x - c0.x, w.y - c0.y) > actionRangePx() + hitPx(m.caster)) { notice('起点超出施法距离', true); return; }
            }
            m.pts = [[w.x, w.y]];
            m.locked = false;
            m.targets = {};
        } else {
            var last = m.pts[m.pts.length - 1], nx = clampNext(m.pts, w, a.area);
            if (Math.hypot(nx[0] - last[0], nx[1] - last[1]) * view.s < 4) { if (m.pts.length > 1) finishPathShape(); } // 原地再点一下 = 完成
            else {
                m.pts.push(nx);
                if (a.area.shape !== 'path' || pathLen(m.pts) >= ftToPx(a.area.size || 0) - 0.5) finishPathShape();
            }
        }
        recomputeAreaTargets();
        renderActionBar();
        requestRender();
        return;
    }
    if (a.area.shape) {
        if (m.locked && hit) { // 已放置范围：点生物切换是否包含
            if (m.targets[hit.id]) delete m.targets[hit.id]; else m.targets[hit.id] = true;
        } else {
            if (!a.area.self && m.caster && actionRangePx()) {
                var c = tokenCenter(m.caster), lim = actionRangePx() + hitPx(m.caster);
                if (Math.hypot(w.x - c.x, w.y - c.y) > lim) { notice('超出射程', true); return; }
            }
            m.aim = { x: w.x, y: w.y };
            m.locked = true;
            recomputeAreaTargets();
        }
    } else if (hit) {
        if (m.targets[hit.id]) delete m.targets[hit.id];
        else if (!inActionRange(hit)) notice('「' + (hit.label || '') + '」超出射程 / 触及', true);
        else if (Object.keys(m.targets).length >= a.targets) notice('最多选择 ' + a.targets + ' 个目标', true);
        else m.targets[hit.id] = true;
    }
    renderActionBar();
    requestRender();
}

function actionPointerMove(w) {
    var m = actionMode;
    if (m.act.area.shape && !m.locked) { m.aim = { x: w.x, y: w.y }; recomputeAreaTargets(); renderActionBar(); }
    requestRender();
}

// 自由路径画完（再点一下原地 / Enter / 「完成形状」）
function finishPathShape() {
    var m = actionMode;
    if (!m || !m.pts || m.pts.length < 2) { notice('至少要放两个点', true); return; }
    m.locked = true;
    recomputeAreaTargets();
    renderActionBar();
    requestRender();
}

// 撤销上一个点（画完后也可以，回到继续画的状态）
function undoPathPoint() {
    var m = actionMode;
    if (!m || !m.pts || !m.pts.length) return;
    m.pts.pop();
    m.locked = false;
    recomputeAreaTargets();
    renderActionBar();
    requestRender();
}

// 重画：清掉已放置的范围，从头再放
function redrawArea() {
    var m = actionMode;
    if (!m) return;
    m.pts = [];
    m.locked = false;
    m.targets = {};
    renderActionBar();
    requestRender();
}

// 只放置区域、不结算：施法（扣法术位、进入专注）并把区域留在地图上，之后需要时再「对区域内结算」
function placeZoneOnly() {
    var m = actionMode;
    if (!m) return;
    var a = m.act;
    if (isPathShape(a.area) && !m.locked) { if (!m.pts || m.pts.length < 2) { notice('先把范围画好', true); return; } finishPathShape(); }
    var shp = actionShape();
    if (!shp) { notice('先把范围放到地图上', true); return; }
    if (a.conc && m.caster) endOldConcZones(m.caster.id);
    createZone(a, shp, m.caster);
    consumeSlot(a, m.sheetId);
    var caster = m.caster && scene.items[m.caster.id];
    if (a.conc && caster && canEdit(caster)) {
        op({ op: 'action', hidden: !!a.hidden, act: { name: a.name, kind: 'effect', caster: caster.id, concentration: true, targets: [] } });
    }
    cancelActionTargeting();
    notice('「' + a.name + '」已放到地图上；需要时选中区域边框点「⚡ 对区域内结算」');
}

// 放置时调整大小 / 宽度（操作条上的 − / ＋）
function adjustArea(which, dir) {
    var m = actionMode, ar = m.act.area;
    if (which === 'size') ar.size = Math.max(5, (ar.size || 0) + dir * 5);
    else { var st = (ar.width || 1) < 5 || ((ar.width || 1) === 5 && dir < 0) ? 1 : 5; ar.width = Math.max(1, (ar.width || 1) + dir * st); }
    if (which === 'size' && m.pts && m.pts.length > 1 && ar.shape !== 'line') m.pts = clampPath(m.pts, ftToPx(ar.size));
    if (which === 'size' && ar.shape === 'line' && m.pts && m.pts.length > 1) m.pts = [m.pts[0], clampNext([m.pts[0]], { x: m.pts[1][0], y: m.pts[1][1] }, ar)];
    if (m.locked || isPathShape(ar)) recomputeAreaTargets();
    renderActionBar();
    requestRender();
}

function drawActionOverlay() {
    var m = actionMode;
    if (!m) return;
    var c = m.caster ? tokenCenter(m.caster) : null;
    ctx.save();
    if (c && actionRangePx()) { // 射程圈
        var a = m.act, half = hitPx(m.caster);
        [[a.range || a.reach, 'rgba(100,181,246,0.9)'], [a.rangeLong, 'rgba(255,183,77,0.8)']].forEach(function(r) {
            if (!(r[0] > 0)) return;
            ctx.beginPath();
            ctx.arc(c.x, c.y, ftToPx(r[0]) + half, 0, Math.PI * 2);
            ctx.setLineDash([8 / view.s, 6 / view.s]);
            ctx.lineWidth = 2 / view.s;
            ctx.strokeStyle = r[1];
            ctx.stroke();
        });
        ctx.setLineDash([]);
    }
    var sh = actionShape();
    var heal0 = m.act.kind === 'heal' || m.act.kind === 'temp';
    if (sh && (sh.type === 'path' || sh.type === 'ring')) { // 墙：按厚度画出带子 + 中线
        ctx.beginPath();
        if (sh.type === 'ring') ctx.arc(sh.x, sh.y, sh.r, 0, Math.PI * 2);
        else sh.pts.forEach(function(p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(sh.w, 4 / view.s);
        ctx.strokeStyle = heal0 ? 'rgba(102,187,106,0.35)' : 'rgba(255,82,82,0.35)';
        ctx.stroke();
        ctx.lineWidth = 1.5 / view.s;
        ctx.strokeStyle = heal0 ? '#66bb6a' : '#ff5252';
        ctx.setLineDash([6 / view.s, 4 / view.s]);
        ctx.stroke();
        ctx.setLineDash([]);
        if (sh.type === 'path') sh.pts.forEach(function(p) { ctx.beginPath(); ctx.arc(p[0], p[1], 3 / view.s, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); });
        sh = null;
    }
    if (sh) {
        ctx.beginPath();
        if (sh.type === 'circle') ctx.arc(sh.x, sh.y, sh.r, 0, Math.PI * 2);
        else sh.pts.forEach(function(p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
        ctx.closePath();
        ctx.fillStyle = m.act.kind === 'heal' || m.act.kind === 'temp' ? 'rgba(102,187,106,0.22)' : 'rgba(255,82,82,0.2)';
        ctx.fill();
        ctx.lineWidth = 2 / view.s;
        ctx.strokeStyle = m.act.kind === 'heal' || m.act.kind === 'temp' ? '#66bb6a' : '#ff5252';
        ctx.stroke();
    }
    var good = m.act.kind === 'heal' || m.act.kind === 'temp' || m.act.kind === 'effect' && STATUS_BY_ID[m.act.status] && /增益|祝福|加速|神导|隐形/.test(STATUS_BY_ID[m.act.status].name + STATUS_BY_ID[m.act.status].desc);
    ctx.restore();
    // 所有可选生物显示判定圆，已选中的再加一圈
    actionCandidates().forEach(function(t) { drawHitCircle(t, m.targets[t.id] ? (good ? '#66bb6a' : '#ff5252') : '#b0bec5', !m.targets[t.id]); });
    ctx.save();
    Object.keys(m.targets).forEach(function(id) {
        var t = scene.items[id];
        if (!t) return;
        var bb = itemBBox(t);
        ctx.beginPath();
        ctx.arc((bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2, Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) * 0.6, 0, Math.PI * 2);
        ctx.lineWidth = 3 / view.s;
        ctx.strokeStyle = good ? '#66bb6a' : '#ff5252';
        ctx.stroke();
    });
    ctx.restore();
    if (m.caster) drawHitCircle(m.caster, '#64b5f6', false);
}

function renderActionBar() {
    var bar = $('actionBar');
    if (!actionMode) { bar.style.display = 'none'; return; }
    var a = actionMode.act, n = Object.keys(actionMode.targets).length;
    var ar = a.area, m0 = actionMode, hint;
    if (isPathShape(ar)) {
        var np = (m0.pts || []).length;
        hint = m0.locked ? '已放好：点击生物可排除 / 加入，点空地重新放置' :
            !np ? '点击地图放起点' : ar.shape === 'path' ? '继续点击添加拐点（总长不超过上限），原地再点一下 / Enter 完成，Backspace 撤掉上一点' : '点击确定方向和终点';
    } else hint = ar.shape ? (m0.locked ? '已放置范围：点击生物可排除 / 加入，点空地重新放置' : (ar.self ? '移动鼠标调整方向，点击确定' : '点击地图放置范围中心')) :
        '点击选择目标（最多 ' + a.targets + ' 个）';
    var shp0 = ar.shape ? actionShape() : null, sizeTxt = '';
    if (ar.shape) {
        var used = shp0 && shp0.type === 'path' ? ' 已用 ' + fmtDist(Math.round(pxToFt(pathLen(shp0.pts)))) : '';
        sizeTxt = '<span class="ab-size">' + (AREA_SIZE_LABEL[ar.shape] || '大小') + ' <button class="tt-btn small" data-ab="sz-">−</button> <b>' + (ar.size || 0) + '</b> 尺' +
            ' <button class="tt-btn small" data-ab="sz+">＋</button>' + used + '</span>' +
            (hasWidth(ar) ? '<span class="ab-size">' + (ar.shape === 'line' ? '宽' : '厚') + ' <button class="tt-btn small" data-ab="w-">−</button> <b>' + (ar.width || 1) + '</b> 尺' +
                ' <button class="tt-btn small" data-ab="w+">＋</button></span>' : '') +
            (ar.shape === 'path' && !m0.locked && (m0.pts || []).length > 1 ? '<button class="tt-btn small primary" data-ab="finish">完成形状</button>' : '') +
            (isPathShape(ar) && (m0.pts || []).length ? '<button class="tt-btn small" data-ab="undo-pt" title="Backspace">↶ 撤销上一点</button>' : '') +
            ((m0.locked || (m0.pts || []).length) && !m0.zoneId ? '<button class="tt-btn small" data-ab="redraw">重画</button>' : '');
    }
    if (m0.zoneMoved) hint = '「' + a.name + '」已移动：要对现在区域内的生物结算吗？（可点击生物增减）';
    var names = Object.keys(actionMode.targets).map(function(id) { return scene.items[id] && scene.items[id].label; }).filter(Boolean);
    bar.innerHTML = '<div class="ab-line"><b>⚡ ' + escapeHtml(a.name) + '</b><span class="tt-hint">' + escapeHtml(hint) + '</span></div>' +
        (sizeTxt ? '<div class="ab-line">' + sizeTxt + '</div>' : '') +
        '<div class="ab-line"><span>目标 ' + n + '：' + escapeHtml(names.join('、') || '—') + '</span>' +
        '<button class="tt-btn small primary" data-ab="go">' + (m0.zoneMoved ? '⚡ 结算（Enter）' : '结算（Enter）') + '</button>' +
        (a.zone && ar.shape && !m0.zoneId && (m0.locked || isPathShape(ar)) ? '<button class="tt-btn small" data-ab="place" title="只把区域放到地图上（施法、扣法术位、专注），现在不结算伤害">只放置，不结算</button>' : '') +
        (m0.zoneId ? '' : '<button class="tt-btn small" data-ab="edit">修改</button>') +
        '<button class="tt-btn small" data-ab="cancel">' + (m0.zoneMoved ? '不结算（Esc）' : '取消（Esc）') + '</button></div>';
    bar.style.display = '';
}

// 确认：按目标算掩护、优劣势、自动重击，交给服务器结算
function confirmActionTargeting() {
    var m = actionMode;
    if (!m) return;
    if (m.caster) m.caster = scene.items[m.caster.id] || null; // 用最新的棋子数据（状态可能变了）
    var a = m.act, ids = Object.keys(m.targets).filter(function(id) { return scene.items[id]; });
    if (!ids.length && !a.conc) { notice('还没有选择目标', true); return; }
    var targets = ids.map(function(id) {
        var t = scene.items[id], o = { id: id, cover: 0, mode: '', autoCrit: false };
        if (!m.caster || t.id === m.caster.id || m.zoneId) return o;
        var ci = coverInfo(m.caster, t);
        if (a.kind === 'attack') {
            if (ci.level < 0) return null; // 完全掩护：无法被直接攻击
            o.cover = ci.level > 0 ? ci.level : 0;
            var sm = statusAttackMods(m.caster, t, ci.dist), adv = sm.adv.length > 0, dis = sm.dis.length > 0;
            var v = rangeVerdict({ normal: a.range, long: a.rangeLong, reach: a.reach }, ci.dist);
            if (v && v.dis) dis = true;
            if (a.range && !(a.reach && ci.dist <= a.reach) && hostileAdjacent(m.caster)) dis = true; // 近身有敌人：远程劣势
            o.extra = sm.extra || '';   // 祝福 / 灾祸
            o.adj = sm.adj || 0;        // 力竭
            o.mode = adv && dis ? '' : adv ? 'adv' : dis ? 'dis' : '';
            o.autoCrit = sm.autoCrit;
        } else if (a.kind === 'save' && a.save === 'dex' && (a.area.self || !a.area.shape)) {
            o.cover = ci.level > 0 ? ci.level : 0;
        }
        return o;
    }).filter(Boolean);
    if (ids.length && !targets.length) { notice('目标都处于完全掩护，无法攻击', true); return; }
    var def = a.status && STATUS_BY_ID[a.status];
    var body = { op: 'action', hidden: !!a.hidden, act: {
        name: a.name, kind: a.kind, attack: a.attack || '', damage: a.damage || '', damageType: a.dtype || '',
        save: a.kind === 'save' ? a.save || '' : '', dc: a.kind === 'save' ? a.dc || 0 : 0, half: !!a.half,
        caster: m.caster && canEdit(m.caster) ? m.caster.id : '', concentration: !!a.conc, targets: targets,
        status: def ? { id: def.id, name: def.name, color: def.color, icon: def.icon, rounds: a.rounds || 0 } : null
    } };
    if (isPathShape(a.area) && !m.locked && m.pts && m.pts.length > 1) finishPathShape();
    if (a.conc && !m.zoneId && m.caster) endOldConcZones(m.caster.id);
    if (a.zone && a.area && a.area.shape && !m.zoneId) createZone(a, actionShape(), m.caster);
    if (!m.zoneId) consumeSlot(a, m.sheetId);
    cancelActionTargeting();
    op(body);
}

// 开始新的专注 = 结束旧的专注：先移除同一施放者之前留下的专注区域（服务器那边专注状态本来就只有一个）
function endOldConcZones(casterId) {
    var old = sortedItems().filter(function(z) { return z.zone && z.zone.conc === casterId && canEdit(z); });
    if (!old.length) return;
    old.forEach(function(z) { zoneGone[z.id] = true; });
    deleteItems(old.map(function(z) { return z.id; }));
    notice('开始新的专注，「' + old.map(function(z) { return z.label || '区域'; }).join('」「') + '」已结束', false, 3500);
}

// ===== 持续区域（月华之光、灵体卫士、匕首之云…）=====
// 地图上留一个半透明区域（绘制物件，带 zone 信息）：可拖动移动；以自身为中心的光环跟随施放者；
// 选中后可「对区域内结算」（生物进入 / 在其中结束回合时）；施放者失去专注时自动移除
function zoneAct(a) {
    return { name: a.name, kind: a.kind, attack: a.attack || '', damage: a.damage || '', dtype: a.dtype || '', save: a.save || '', dc: a.dc || 0,
        half: !!a.half, status: a.status || '', rounds: a.rounds || 0 };
}

function createZone(a, shp, caster) {
    if (!shp) return;
    if (!me.gm && !roomSetting('playerDraw', true)) { notice('GM 关闭了玩家绘制，区域没有保留在地图上', true); return; }
    var minZ = 0;
    for (var id in scene.items) minZ = Math.min(minZ, scene.items[id].z || 0);
    var good = a.kind === 'heal' || a.kind === 'temp';
    var it = { id: genId(), kind: 'draw', fill: true, width: 2, color: good ? '#66bb6a' : '#ff7043', z: minZ - 1, label: a.name,
        zone: { act: zoneAct(a), caster: caster ? caster.id : '', conc: a.conc && caster ? caster.id : '' } };
    if (shp.type === 'circle') { it.shape = 'circle'; it.x = shp.x; it.y = shp.y; it.r = shp.r; }
    else if (shp.type === 'ring') { it.shape = 'circle'; it.x = shp.x; it.y = shp.y; it.r = shp.r; it.width = Math.max(shp.w, 3); it.fill = false; it.zone.geom = 'ring'; }
    else if (shp.type === 'path') {
        it.shape = 'line'; it.x = shp.pts[0][0]; it.y = shp.pts[0][1]; it.fill = false; it.width = Math.max(shp.w, 4); it.zone.geom = 'path';
        it.points = shp.pts.map(function(p) { return [p[0] - it.x, p[1] - it.y]; });
    } else { it.shape = 'poly'; it.x = shp.pts[0][0]; it.y = shp.pts[0][1]; it.points = shp.pts.map(function(p) { return [p[0] - it.x, p[1] - it.y]; }); }
    if (a.area.self && caster) it.follow = caster.id; // 光环跟着施放者走
    createItems([it]);
}

function zoneShapeOf(z) {
    var g0 = z.zone && z.zone.geom;
    if (g0 === 'ring') return { type: 'ring', x: z.x, y: z.y, r: z.r || 0, w: z.width || 3 };
    if (g0 === 'path') return { type: 'path', pts: (z.points || []).map(function(p) { return [p[0] + (z.x || 0), p[1] + (z.y || 0)]; }), w: z.width || 4 };
    return z.shape === 'circle' ? { type: 'circle', x: z.x, y: z.y, r: z.r || 0 } :
        { type: 'poly', pts: (z.points || []).map(function(p) { return [p[0] + (z.x || 0), p[1] + (z.y || 0)]; }) };
}

// 对区域内的生物再结算一次（目标已自动选好，可点选增减）
function zoneRetrigger(z, moved) {
    if (!z || !z.zone || !z.zone.act) return;
    var a = JSON.parse(JSON.stringify(z.zone.act));
    a.area = { shape: '', size: 0, width: 5, self: false };
    a.targets = 99; a.range = 0; a.rangeLong = 0; a.reach = 0;
    actionMode = { act: a, caster: scene.items[z.zone.caster] || null, targets: {}, aim: null, locked: false, zoneId: z.id, zoneMoved: !!moved };
    var shp = zoneShapeOf(z);
    actionCandidates().forEach(function(t) { if (tokenInShape(t, shp)) actionMode.targets[t.id] = true; });
    setTool('select');
    selectOnly([]);
    renderActionBar();
    requestRender();
}

// 施放者不再专注 → 移除它的区域（由 GM 或区域的主人那一端执行；新建的区域先等几秒，等服务器加上专注）
var zoneSeen = {}, zoneGone = {};
function cleanupZones() {
    var now = Date.now();
    sortedItems().forEach(function(z) {
        if (!z.zone || !z.zone.conc || zoneGone[z.id]) return;
        if (!zoneSeen[z.id]) { zoneSeen[z.id] = now; return; }
        if (now - zoneSeen[z.id] < 4000 || !canEdit(z) || !(me.gm || z.owner === me.name)) return;
        var c = scene.items[z.zone.conc];
        if (c && hasStatus(c, 'concentration')) return;
        zoneGone[z.id] = true;
        deleteItems([z.id]);
        notice('「' + (z.label || '区域') + '」的专注结束，区域已移除', false, 3000);
    });
}

function onActionBarClick(e) {
    var b = e.target.closest('[data-ab]');
    if (!b || !actionMode) return;
    if (b.dataset.ab === 'go') confirmActionTargeting();
    else if (b.dataset.ab === 'sz-' || b.dataset.ab === 'sz+') adjustArea('size', b.dataset.ab === 'sz+' ? 1 : -1);
    else if (b.dataset.ab === 'w-' || b.dataset.ab === 'w+') adjustArea('width', b.dataset.ab === 'w+' ? 1 : -1);
    else if (b.dataset.ab === 'finish') finishPathShape();
    else if (b.dataset.ab === 'undo-pt') undoPathPoint();
    else if (b.dataset.ab === 'redraw') redrawArea();
    else if (b.dataset.ab === 'place') placeZoneOnly();
    else if (b.dataset.ab === 'cancel') cancelActionTargeting();
    else if (b.dataset.ab === 'edit') {
        var m = actionMode;
        cancelActionTargeting();
        openActionDialog(m.act, m.caster, act && act.sheet);
    }
}

// ===== 记录 =====
function actionLogHtml(e) {
    var r = e.act, h = '<div class="act-log">';
    var KIND = { attack: '攻击', save: '豁免', auto: '伤害', heal: '治疗', temp: '临时生命', effect: '效果' };
    if (r.roll) h += '<div class="act-roll">' + (KIND[r.kind] || '') + (r.damageType ? '（' + escapeHtml(r.damageType) + '）' : '') + rollHtml(r.roll).replace(/^<div class="log-roll">|<\/div>$/g, '') + '</div>';
    if (r.save && r.kind === 'save') h += '<div class="tt-hint">' + ({ str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力' }[r.save] || r.save) + '豁免 DC ' + r.dc + '</div>';
    (r.targets || []).forEach(function(t) {
        var parts = [];
        if (t.attack) {
            var HIT = { hit: ['命中', 'hit'], miss: ['未命中', 'miss'], crit: ['重击！', 'crit'], fumble: ['大失败', 'miss'] }[t.hit] || ['', ''];
            parts.push('<span class="tt-hint">' + escapeHtml(t.attack.expr) + '</span> <b>' + t.attack.total + '</b> <span class="hit-tag ' + HIT[1] + '">' + HIT[0] + '</span>');
        }
        if (t.saved) parts.push(t.saved === 'auto' ? '<span class="hit-tag hit">豁免自动失败</span>' :
            '<span class="tt-hint">豁免</span> <b>' + (t.save ? t.save.total : '') + '</b> <span class="hit-tag ' + (t.saved === 'yes' ? 'miss">成功' : 'hit">失败') + '</span>');
        if (t.damage) parts.push('<span class="tt-hint">伤害 ' + escapeHtml(t.damage.expr) + '</span>');
        if (t.amount) parts.push('<b class="' + (t.amount < 0 ? 'amt-dmg' : 'amt-heal') + '">' + (t.amount < 0 ? t.amount : '+' + t.amount) + (r.kind === 'temp' ? ' 临时' : '') + '</b>');
        if (t.status) parts.push('<span class="hit-tag crit">' + escapeHtml(t.status) + '</span>');
        if (t.note) parts.push('<span class="tt-hint">' + escapeHtml(t.note) + '</span>');
        h += '<div class="act-target">🎯 ' + escapeHtml(t.name) + ' ' + parts.join(' ') + '</div>';
    });
    if (r.note) h += '<div class="tt-hint">' + escapeHtml(r.note) + '</div>';
    return h + '</div>';
}

function initAction() {
    $('actDialog').addEventListener('change', function(e) {
        if (e.target.id === 'acShape' && act) { // 换成环形墙时带出法术写的直径
            if (e.target.value === 'ring' && act.a.area && act.a.area.ringSize) $('acSize').value = act.a.area.ringSize;
            if (hasWidth({ shape: e.target.value }) && !$('acWidth').value) $('acWidth').value = e.target.value === 'line' ? 5 : 1;
        }
        if (e.target.id === 'acKind' || e.target.id === 'acShape') syncActionDialog();
        if (e.target.id === 'acSlot' && act) { // 换环阶：自动改成对应的伤害 / 治疗公式和目标数
            applySlotLevel(act.a, parseInt(e.target.value, 10) || act.a.spellLevel);
            $('acDamage').value = act.a.damage || '';
            $('acTargets').value = act.a.targets || 1;
        }
    });
    $('actDialog').addEventListener('click', function(e) { if (e.target === $('actDialog')) closeActionDialog(); });
    $('actDialog').addEventListener('keydown', function(e) {
        if (e.key === 'Escape') { e.preventDefault(); closeActionDialog(); }
        e.stopPropagation();
    });
    $('actionBar').addEventListener('click', onActionBarClick);
    // GM 把角色卡分配给玩家：卡和关联的棋子都归他
    $('sheetPane').addEventListener('change', function(e) {
        var id = e.target.dataset && e.target.dataset.sheetowner;
        if (!id || !me.gm) return;
        var owner = e.target.value || null;
        op({ op: 'sheet', sheet: { id: id, owner: owner } });
        var toks = sortedItems().filter(function(t) { return t.kind === 'token' && t.sheet === id; });
        if (toks.length) patchItems(toks.map(function(t) { return { id: t.id, owner: owner }; }));
        notice(owner ? '已把角色卡和 ' + toks.length + ' 个棋子分配给 ' + owner : '已取消分配');
    });
    $('actionBar').addEventListener('pointerdown', function(e) { e.stopPropagation(); });
}
