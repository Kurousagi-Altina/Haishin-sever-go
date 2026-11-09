// 跑团桌面：行动（攻击 / 法术 / 能力）—— 选目标、看范围、一键结算
// - 从武器、法术说明、怪物动作文字里自动识别：攻击加值、伤害骰与类型、治疗、豁免属性与 DC、
//   成功减半、射程 / 触及、范围形状（球 / 锥 / 线 / 立方）与大小、目标数、附带状态、专注
// - 行动框里所有字段都可以手动改；也可以「自定义行动」从空白开始填
// - 地图上显示射程圈和范围模板，点选目标或放置范围；确认后由服务器掷骰并结算到每个目标
//   （攻击对 AC、豁免对 DC、抗性 / 免疫 / 易伤、治疗、临时生命、状态、专注）
// 依赖 tabletop.js / tabletop-sheets.js / tabletop-combat.js / tabletop-status.js 的全局状态与函数

var ABIL_KEY = { '力量': 'str', '敏捷': 'dex', '体质': 'con', '智力': 'int', '感知': 'wis', '魅力': 'cha' };
var CN_NUM = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
var DMG_TYPES = '强酸|钝击|寒冷|火焰|力场|闪电|黯蚀|死灵|穿刺|毒素|心灵|光耀|挥砍|雷鸣';
var SPELL_BUFFS = { '祝福术': 'blessed', '灾祸术': 'baned', '加速术': 'hasted', '侵扰术': 'hexed', '神导术': 'guidance', '隐形术': 'invisible' };
var ACT_KINDS = [['attack', '攻击检定'], ['save', '豁免'], ['auto', '自动命中伤害'], ['heal', '治疗'], ['temp', '临时生命'], ['effect', '仅附加状态']];
var AREA_SHAPES = [['', '无（点选目标）'], ['circle', '球形 / 圆形（半径）'], ['cone', '锥形（长度）'], ['line', '直线（长度）'], ['cube', '立方（边长）']];

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
    m = t.match(new RegExp('[（(]\\s*(\\d+d\\d+(?:\\s*[+＋\\-－]\\s*\\d+)?)\\s*[)）]\\s*点?\\s*(' + DMG_TYPES + ')?\\s*伤害')) ||
        t.match(new RegExp('(\\d+d\\d+(?:\\s*[+＋\\-－]\\s*\\d+)?)\\s*点?\\s*(' + DMG_TYPES + ')\\s*伤害')) ||
        t.match(/(\d+d\d+(?:\s*[+＋\-－]\s*\d+)?)\s*点?\s*伤害/);
    if (m) { a.damage = m[1].replace(/\s/g, '').replace(/＋/g, '+').replace(/[－−]/g, '-'); a.dtype = m[2] || ''; }
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
    if ((m = t.match(/(\d+)\s*尺\s*半径/) || t.match(/半径\s*(\d+)\s*尺/) || t.match(/(\d+)\s*尺\s*的?\s*(?:光环|散发)/))) a.area = { shape: 'circle', size: +m[1], width: 5, self: a.area.self || selfCenter };
    else if ((m = t.match(/(\d+)\s*尺\s*的?\s*(?:长的?)?\s*锥/))) a.area = { shape: 'cone', size: +m[1], width: 5, self: true };
    else if ((m = t.match(/(\d+)\s*尺\s*(?:长)?(?:[，,、]?\s*(\d+)\s*尺\s*宽)?\s*的?\s*(?:直线|线状|线形)/))) a.area = { shape: 'line', size: +m[1], width: +(m[2] || 5), self: true };
    else if ((m = t.match(/(\d+)\s*尺\s*的?\s*立方/))) a.area = { shape: 'cube', size: +m[1], width: 5, self: a.area.self };
    // 目标数
    if ((m = t.match(/至多\s*([一二两三四五六七八九十\d]+)\s*(?:名|个)/))) a.targets = cnInt(m[1]) || 1;
    // 附带状态
    var buff = Object.keys(SPELL_BUFFS).filter(function(k) { return (name || '').indexOf(k) >= 0; })[0];
    if (buff) a.status = SPELL_BUFFS[buff];
    else {
        STATUS_DEFS.some(function(d) {
            if (['concentration', 'advantage', 'disadvantage', 'hidden', 'bardic', 'guidance', 'dodging', 'raging'].indexOf(d.id) >= 0) return false;
            if (t.indexOf(d.name + '状态') >= 0 || t.indexOf('陷入' + d.name) >= 0 || t.indexOf('变得' + d.name) >= 0) { a.status = d.id; return true; }
            return false;
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
    return a;
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
            openActionDialog(finishAction(a, sh), caster, sh);
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
    f('acDtype').value = a.dtype || '';
    f('acSave').value = a.save || 'dex';
    f('acDC').value = a.dc || '';
    f('acHalf').checked = !!a.half;
    f('acRange').value = a.range || (a.reach && !a.rangeLong ? a.reach : '') || '';
    f('acLong').value = a.rangeLong || '';
    f('acShape').innerHTML = AREA_SHAPES.map(function(s) { return '<option value="' + s[0] + '">' + s[1] + '</option>'; }).join('');
    f('acShape').value = a.area.shape || '';
    f('acSize').value = a.area.size || '';
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
    a.save = v('acSave');
    a.dc = parseInt(v('acDC'), 10) || 0;
    a.half = $('acHalf').checked;
    a.range = parseFloat(v('acRange')) || 0;
    a.rangeLong = parseFloat(v('acLong')) || 0;
    a.area = { shape: v('acShape'), size: parseFloat(v('acSize')) || 0, width: a.area && a.area.width || 5, self: $('acSelf').checked };
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
    $('acTargetsWrap').style.display = shape ? 'none' : '';
}

function closeActionDialog() { $('actDialog').style.display = 'none'; }

// 不选目标：只掷骰（原来的掷骰确认框）
function actionRollOnly() {
    var a = readActionDialog(), who = act.sheet ? act.sheet.name : (act.caster && act.caster.label) || '';
    closeActionDialog();
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
    actionMode = { act: a, caster: act.caster, targets: {}, aim: null, locked: false };
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
function actionShape() {
    var m = actionMode, a = m.act, ar = a.area;
    if (!ar.shape || !m.aim) return null;
    var size = ftToPx(ar.size || 0), c = m.caster ? tokenCenter(m.caster) : null;
    var half = m.caster ? hitPx(m.caster) : 0; // 从施放者判定圆的边缘展开
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
    var hint = a.area.shape ? (actionMode.locked ? '已放置范围：点击生物可排除 / 加入，点空地重新放置' : (a.area.self ? '移动鼠标调整方向，点击确定' : '点击地图放置范围中心')) :
        '点击选择目标（最多 ' + a.targets + ' 个）';
    var names = Object.keys(actionMode.targets).map(function(id) { return scene.items[id] && scene.items[id].label; }).filter(Boolean);
    bar.innerHTML = '<div class="ab-line"><b>⚡ ' + escapeHtml(a.name) + '</b><span class="tt-hint">' + escapeHtml(hint) + '</span></div>' +
        '<div class="ab-line"><span>目标 ' + n + '：' + escapeHtml(names.join('、') || '—') + '</span>' +
        '<button class="tt-btn small primary" data-ab="go">结算（Enter）</button><button class="tt-btn small" data-ab="edit">修改</button><button class="tt-btn small" data-ab="cancel">取消（Esc）</button></div>';
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
        if (!m.caster || t.id === m.caster.id) return o;
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
    cancelActionTargeting();
    op(body);
}

function onActionBarClick(e) {
    var b = e.target.closest('[data-ab]');
    if (!b || !actionMode) return;
    if (b.dataset.ab === 'go') confirmActionTargeting();
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
    $('actDialog').addEventListener('change', function(e) { if (e.target.id === 'acKind' || e.target.id === 'acShape') syncActionDialog(); });
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
