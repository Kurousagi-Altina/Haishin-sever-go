// 跑团桌面：COC 7 版（克苏鲁的呼唤）人物卡与检定
// - 房间设置 rules = 'coc'（右上角 DnD / COC 切换，GM 设置）时，角色栏可以新建 COC 人物卡；地图和工具栏两种规则通用
// - 人物卡 = sheet kind pc（GM 的 NPC 为 monster），system: 'coc'；字段见 cocNewSheet
// - 点属性 / 技能的全值、一半、五分之一 = 普通 / 困难 / 极难检定，服务器掷 d100 并判定成功等级（op coc，backend/tabletop_coc.go）
// 依赖 tabletop.js / tabletop-sheets.js / tabletop-extra.js 中的全局函数（op, sheets, sheetView, renderSheets, ttAsk ...）

var COC_ATTRS = [['str', '力量', 'STR'], ['dex', '敏捷', 'DEX'], ['pow', '意志', 'POW'], ['con', '体质', 'CON'], ['app', '外貌', 'APP'],
    ['edu', '教育', 'EDU'], ['siz', '体型', 'SIZ'], ['int', '智力', 'INT']];
// [技能名, 初始值, 自动初始值（dodge = 敏捷一半，edu = 教育）]；名字以「：」结尾的是要自己填专攻的
var COC_SKILLS = [['会计', 5], ['人类学', 1], ['估价', 5], ['考古学', 1], ['技艺：', 5], ['魅惑', 15], ['攀爬', 20], ['计算机使用', 5],
    ['信用评级', 0], ['克苏鲁神话', 0], ['乔装', 5], ['闪避', 0, 'dodge'], ['汽车驾驶', 20], ['电气维修', 10], ['电子学', 1], ['话术', 5],
    ['格斗：斗殴', 25], ['射击：手枪', 20], ['射击：步枪/霰弹枪', 25], ['急救', 30], ['历史', 5], ['恐吓', 15], ['跳跃', 20],
    ['外语：', 1], ['母语：', 0, 'edu'], ['法律', 5], ['图书馆使用', 20], ['聆听', 20], ['锁匠', 1], ['机械维修', 10], ['医学', 1],
    ['博物学', 10], ['领航', 10], ['神秘学', 5], ['操作重型机械', 1], ['说服', 10], ['驾驶：', 1], ['精神分析', 1], ['心理学', 10],
    ['骑术', 5], ['科学：', 1], ['妙手', 10], ['侦查', 25], ['潜行', 20], ['生存：', 10], ['游泳', 20], ['投掷', 20], ['追踪', 10],
    ['驯兽', 5], ['潜水', 1], ['爆破', 1], ['读唇', 1], ['催眠', 1], ['炮术', 1]];
var COC_STORY = [['desc', '个人描述'], ['belief', '思想与信念'], ['people', '重要之人'], ['places', '意义非凡之地'], ['items', '宝贵之物'],
    ['traits', '特质'], ['secret', '难言之隐'], ['scars', '伤口和疤痕'], ['phobia', '恐惧症和狂躁症'], ['bg', '经历'], ['gear', '随身物品'], ['assets', '资产']];
var COC_INFO = [['player', '玩家'], ['occupation', '职业'], ['age', '年龄'], ['sex', '性别'], ['residence', '住地'], ['birthplace', '故乡'], ['era', '时代']];
var COC_LEVEL = { crit: ['大成功', 'crit'], extreme: ['极难成功', 'ok'], hard: ['困难成功', 'ok'], regular: ['成功', 'ok'], fail: ['失败', 'bad'], fumble: ['大失败', 'fumble'] };
var COC_DIFF = ['普通', '困难', '极难'];
var COC_QUICK = ['侦查', '聆听', '图书馆使用', '闪避', '心理学', '说服'];

var cocBonus = 0;        // 下一次检定的奖励骰（+）/ 惩罚骰（−）数，掷完归零
var cocFilterText = '';  // 技能表搜索
var cocAllSkills = false; // 显示所有技能（默认隐藏没加点的）

function isCoc() { return roomSetting('rules', '') === 'coc'; }
function isCocSheet(sh) { return !!sh && sh.system === 'coc'; }
function cocN(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

// ===== 规则切换（右上角）=====
function cocApplyRules() {
    var box = $('rulesSwitch');
    if (!box) return;
    var r = isCoc() ? 'coc' : '';
    box.querySelectorAll('button').forEach(function(b) {
        b.classList.toggle('active', (b.dataset.rules || '') === r);
        b.disabled = !me.gm;
    });
    box.title = me.gm ? '房间规则：切换角色卡和检定方式（地图与工具栏不变）' : '房间规则（由 GM 设置）';
    if (cocApplyRules.last !== r) { cocApplyRules.last = r; renderSheets(); renderSelPanel(); }
}

function onRulesSwitch(e) {
    var b = e.target.closest('button[data-rules]');
    if (!b || !me.gm) return;
    var v = b.dataset.rules || null;
    if ((v || '') === (isCoc() ? 'coc' : '')) return;
    setRoomSetting('rules', v);
    notice(v === 'coc' ? '已切换到 COC 7 版：角色栏可新建调查员，点技能 / 属性直接检定' : '已切换回 DnD 规则');
}

// ===== 推导数值 =====
function cocAttr(sh, k) { return cocN((sh.attrs || {})[k]); }

function cocDbBuild(sh) {
    var t = cocAttr(sh, 'str') + cocAttr(sh, 'siz');
    if (t <= 64) return ['-2', -2];
    if (t <= 84) return ['-1', -1];
    if (t <= 124) return ['0', 0];
    if (t <= 164) return ['+1d4', 1];
    if (t <= 204) return ['+1d6', 2];
    var extra = Math.floor((t - 205) / 80); // 205–284 = +2d6，之后每 80 点再 +1d6
    return ['+' + (2 + extra) + 'd6', 3 + extra];
}

function cocMov(sh) {
    if ((sh.attrs || {}).mov != null && sh.attrs.mov !== '') return cocN(sh.attrs.mov);
    var s = cocAttr(sh, 'str'), d = cocAttr(sh, 'dex'), z = cocAttr(sh, 'siz');
    var m = s < z && d < z ? 7 : s > z && d > z ? 9 : 8;
    var age = cocN((sh.info || {}).age);
    if (age >= 40) m -= Math.min(5, Math.floor((age - 30) / 10));
    return Math.max(0, m);
}

function cocSkillVal(s) { return cocN(s.base) + cocN(s.occ) + cocN(s.int) + cocN(s.grow); }
function cocSkill(sh, name) { return (sh.cskills || []).filter(function(s) { return s.n === name; })[0] || null; }

// 属性改了：重算自动初始值（闪避 / 母语）和体力、魔法、理智上限；原来是满的就跟着满
function cocDerive(sh, fresh) {
    (sh.cskills || []).forEach(function(s) {
        if (s.auto === 'dodge') s.base = Math.floor(cocAttr(sh, 'dex') / 2);
        if (s.auto === 'edu') s.base = cocAttr(sh, 'edu');
    });
    var myth = cocSkill(sh, '克苏鲁神话');
    var hpMax = Math.floor((cocAttr(sh, 'con') + cocAttr(sh, 'siz')) / 10), mpMax = Math.floor(cocAttr(sh, 'pow') / 5);
    var sanMax = 99 - (myth ? cocSkillVal(myth) : 0);
    var fit = function(o, max) {
        o = o || {};
        var full = fresh || o.cur == null || o.cur === '' || cocN(o.cur) === cocN(o.max);
        o.max = max;
        if (full) o.cur = max;
        else o.cur = Math.min(cocN(o.cur), max);
        return o;
    };
    sh.hp = fit(sh.hp, hpMax);
    sh.mp = fit(sh.mp, mpMax);
    sh.san = sh.san || {};
    if (fresh || sh.san.start == null || sh.san.start === '') sh.san.start = cocAttr(sh, 'pow');
    if (fresh || sh.san.cur == null || sh.san.cur === '') sh.san.cur = sh.san.start;
    sh.san.max = sanMax;
    sh.san.cur = Math.min(cocN(sh.san.cur), sanMax);
}

// ===== 新建 / 保存 =====
function cocNewSheet(kind) {
    var attrs = {};
    COC_ATTRS.forEach(function(a) { attrs[a[0]] = 50; });
    var sh = { id: genId(), kind: kind, system: 'coc', name: kind === 'pc' ? '新调查员' : '新 NPC', info: { era: '1920s' }, attrs: attrs, luck: { cur: 50 },
        cskills: COC_SKILLS.map(function(s) { var o = { n: s[0], base: s[1] }; if (s[2]) o.auto = s[2]; return o; }),
        weapons: [{ name: '徒手', skill: '格斗：斗殴', dmg: '1d3+DB', range: '—', rof: '1' }], story: {} };
    if (!me.gm) sh.owner = me.name;
    cocDerive(sh, true);
    op({ op: 'sheet', sheet: sh }).then(function(ok) {
        if (!ok) return;
        if (!sheets[sh.id]) sheets[sh.id] = sh;
        sheetView = { mode: 'sheet', id: sh.id, tokenId: '', back: { mode: 'list' }, edit: true };
        switchPane('sheets');
        renderSheets();
        notice('已新建「' + sh.name + '」：先在编辑模式里填属性和技能点，再点「完成」');
    });
}

// 改本地副本并只发改动的顶层字段
function cocSave(sh, keys) {
    var patch = { id: sh.id };
    keys.forEach(function(k) { patch[k] = sh[k] == null ? null : JSON.parse(JSON.stringify(sh[k])); });
    op({ op: 'sheet', sheet: patch });
    renderSheetsRemote();
}

// 体力同步到这张卡在当前场景里的棋子（状态栏 / 血条用棋子的 hp）
function cocSyncTokens(sh) {
    var max = cocN(sh.hp && sh.hp.max), cur = cocN(sh.hp && sh.hp.cur), patches = [];
    sortedItems().forEach(function(t) {
        if (t.kind !== 'token' || t.sheet !== sh.id || !canEdit(t)) return;
        if (num(t.hp, -1) !== cur || num(t.hpMax, -1) !== max) patches.push({ id: t.id, hp: cur, hpMax: max });
    });
    if (patches.length) patchItems(patches);
}

// 从棋子打开 / 场景里有关联棋子：体力以棋子为准
function cocToken(sh) {
    var tok = sheetView.tokenId && scene.items[sheetView.tokenId];
    if (tok && tok.sheet === sh.id && tok.hpMax > 0) return tok;
    return sortedItems().filter(function(t) { return t.kind === 'token' && t.sheet === sh.id && t.hpMax > 0; })[0] || null;
}

// ===== 检定 =====
function cocCheck(sh, label, value, diff, skill) {
    var body = { op: 'coc', mode: 'check', label: (sh ? sh.name + '·' : '') + label, hidden: $('diceHidden').checked,
        coc: { value: cocN(value), bonus: cocBonus, diff: cocN(diff) } };
    if (sh && skill && canEditSheet(sh)) { body.coc.sheet = sh.id; body.coc.skill = skill; }
    if (cocBonus) { cocBonus = 0; renderSheetsRemote(); }
    op(body);
}

function cocSanCheck(sh) {
    ttAsk({ title: '理智检定 · ' + sh.name, text: '当前理智 ' + cocN(sh.san && sh.san.cur) + '。输入理智损失「成功/失败」，如 0/1d6、1/1d4+1、1d6/1d20。',
        input: { value: '0/1d6', maxlength: 30 }, ok: '检定' }).then(function(v) {
        if (v == null) return;
        v = String(v).trim();
        if (!/^[^/／]+[/／][^/／]+$/.test(v)) { notice('格式应为「成功/失败」，如 0/1d6', true); return; }
        op({ op: 'coc', mode: 'san', label: sh.name + '·理智检定', hidden: $('diceHidden').checked, coc: { sheet: sh.id, loss: v, bonus: cocBonus } });
        if (cocBonus) { cocBonus = 0; renderSheetsRemote(); }
    });
}

function cocGrow(sh) {
    var marked = (sh.cskills || []).filter(function(s) { return s.mark; });
    if (!marked.length) { notice('还没有打成长标记的技能：检定成功时会自动打上，也可以手动勾选', true); return; }
    ttAsk({ title: '成长检定', text: '对 ' + marked.length + ' 个打了标记的技能做成长检定（' + marked.map(function(s) { return s.n; }).join('、') +
        '）：d100 大于技能值或大于 95 则 +1d10，标记清除。', ok: '开始' }).then(function(ok) {
        if (ok) op({ op: 'coc', mode: 'grow', label: sh.name + '·成长检定', coc: { sheet: sh.id } });
    });
}

// 伤害里的 DB 换成伤害加值
function cocDmgExpr(sh, dmg) {
    var db = cocDbBuild(sh)[0];
    var s = String(dmg || '').replace(/\s/g, '').replace(/[＋]/g, '+');
    s = s.replace(/([+-])?(?:DB|db|伤害加值)/g, function(m, sign) {
        if (db === '0') return '';
        var v = /^[+-]/.test(db) ? db : '+' + db;
        if (sign === '-') v = v[0] === '-' ? '+' + v.slice(1) : '-' + v.slice(1);
        return v;
    });
    s = s.replace(/^\+/, '').toLowerCase();
    return s;
}

// ===== 列表按钮 =====
function cocListButtons() {
    return '<div class="lobby-row" style="gap:6px;">' +
        '<button class="tt-btn primary" data-act="cocnew" data-kind="pc">＋ 新建调查员</button>' +
        '<button class="tt-btn" data-act="xlsx" title="中文 COC 7 版 Excel 人物卡（.xlsx，读「人物卡」工作表）；DnD 人物卡也能导入">导入 Excel 人物卡</button>' +
        (me.gm ? '<button class="tt-btn" data-act="cocnew" data-kind="monster" title="只有 GM 看得到，可以「共享」给玩家">＋ 新建 NPC</button>' : '') + '</div>';
}

function cocSheetSub(sh) {
    var i = sh.info || {};
    return [i.occupation, i.age ? i.age + '岁' : '', i.era, i.player ? '玩家：' + i.player : ''].filter(Boolean).join(' · ') || 'COC 7 版人物卡';
}

// ===== 人物卡界面 =====
function cocValBtns(label, v, skill, cls) {
    var d = ' data-cocl="' + escapeHtml(label) + '"' + (skill ? ' data-cocs="' + escapeHtml(skill) + '"' : '');
    return '<button class="coc-v full ' + (cls || '') + '" data-cocv="' + v + '" data-cocd="0"' + d + ' title="普通检定">' + v + '</button>' +
        '<button class="coc-v" data-cocv="' + v + '" data-cocd="1"' + d + ' title="困难检定（一半）">' + Math.floor(v / 2) + '</button>' +
        '<button class="coc-v" data-cocv="' + v + '" data-cocd="2"' + d + ' title="极难检定（五分之一）">' + Math.floor(v / 5) + '</button>';
}

function cocNumIn(attr, v, extra) {
    return '<input class="tt-input coc-num" type="number" ' + attr + ' value="' + (v == null ? '' : escapeHtml(String(v))) + '"' + (extra || '') + '>';
}

function cocSheetHtml(sh, preview) {
    var edit = !preview && canEditSheet(sh), editing = edit && sheetView.edit;
    var h = '<div class="sheet-head"><button class="tt-btn small" data-act="back">←</button>' +
        '<div class="title"><div class="name">' + escapeHtml(sh.name) + ' <span class="coc-badge">COC</span></div><div class="sub">' + escapeHtml(cocSheetSub(sh)) + '</div></div>' +
        (edit ? '<button class="tt-btn small' + (editing ? ' primary' : '') + '" data-act="cocedit">' + (editing ? '完成' : '✎ 编辑') + '</button>' : '') + '</div>';
    if (sh.portrait) h += '<div class="sheet-portrait"><img src="' + escapeHtml(assetURL(sh.portrait)) + '" alt=""></div>';
    if (!preview && me.gm && sh.kind === 'pc') {
        var players = users.filter(function(u) { return !u.gm; }).map(function(u) { return u.name; });
        if (sh.owner && players.indexOf(sh.owner) < 0) players.push(sh.owner);
        h += '<div class="lobby-row" style="gap:6px;"><span class="tt-hint">分配给</span><select class="tt-select" data-sheetowner="' + escapeHtml(sh.id) + '"><option value="">（未分配）</option>' +
            players.map(function(n) { return '<option value="' + escapeHtml(n) + '"' + (n === sh.owner ? ' selected' : '') + '>' + escapeHtml(n) + '</option>'; }).join('') + '</select></div>';
    }
    if (edit) h += '<div class="lobby-row" style="gap:6px;"><button class="tt-btn small" data-act="place" data-id="' + escapeHtml(sh.id) + '">放置棋子</button></div>';

    // 奖励骰 / 惩罚骰（只作用于下一次检定）
    h += '<div class="coc-bar"><span class="tt-hint">下一次检定</span>' + [[-2, '惩罚×2'], [-1, '惩罚'], [0, '正常'], [1, '奖励'], [2, '奖励×2']].map(function(o) {
        return '<button class="tt-btn small' + (cocBonus === o[0] ? ' primary' : '') + '" data-cocbonus="' + o[0] + '">' + o[1] + '</button>';
    }).join('') + '</div>';

    // 调查员信息
    var info = sh.info || {};
    if (editing) {
        h += '<div class="side-section"><h5>调查员信息</h5><div class="coc-info-grid"><label>姓名<input class="tt-input" data-cname value="' + escapeHtml(sh.name || '') + '" maxlength="40"></label>' +
            COC_INFO.map(function(f) { return '<label>' + f[1] + '<input class="tt-input" data-cinfo="' + f[0] + '" value="' + escapeHtml(info[f[0]] || '') + '" maxlength="30"></label>'; }).join('') + '</div></div>';
    }

    // 属性
    h += '<div class="side-section"><h5>属性</h5><div class="coc-attrs">' + COC_ATTRS.map(function(a) {
        var v = cocAttr(sh, a[0]);
        return '<div class="coc-attr"><div class="nm">' + a[1] + ' <small>' + a[2] + '</small></div>' +
            (editing ? cocNumIn('data-cattr="' + a[0] + '" min="0" max="999"', v) : '<div class="vals">' + cocValBtns(a[1], v) + '</div>') + '</div>';
    }).join('') +
        '<div class="coc-attr"><div class="nm">移动力 <small>MOV</small></div>' + (editing ? cocNumIn('data-cattr="mov" min="0" max="20" placeholder="自动"', (sh.attrs || {}).mov) : '<div class="vals"><b>' + cocMov(sh) + '</b></div>') + '</div>' +
        '</div>';
    var db = cocDbBuild(sh);
    h += '<div class="stat-chips">' + chip('伤害加值 DB', db[0]) + chip('体格', db[1]) + '</div></div>';

    // 体力 / 理智 / 魔法 / 幸运
    var tok = cocToken(sh), hp = tok ? { cur: num(tok.hp, tok.hpMax), max: tok.hpMax } : (sh.hp || {});
    var canHp = tok ? canEdit(tok) : edit;
    var vital = function(key, label, o, can, extra) {
        o = o || {};
        return '<div class="coc-vital"><span>' + label + '</span><div>' +
            (can ? cocNumIn('data-cvital="' + key + '" min="0"', cocN(o.cur)) : '<b>' + cocN(o.cur) + '</b>') +
            (o.max != null ? ' / ' + (editing && key !== 'hp' || editing && !tok ? cocNumIn('data-cvmax="' + key + '" min="0"', cocN(o.max)) : '<b>' + cocN(o.max) + '</b>') : '') +
            '</div>' + (can ? '<div class="pm"><button class="tt-btn small" data-cocadj="' + key + '" data-delta="-1">−</button><button class="tt-btn small" data-cocadj="' + key + '" data-delta="1">＋</button></div>' : '') +
            (extra || '') + '</div>';
    };
    var luck = cocN((sh.luck || {}).cur), san = sh.san || {};
    h += '<div class="side-section"><h5>状态</h5><div class="coc-vitals">' +
        vital('hp', '体力 HP', hp, canHp) +
        vital('san', '理智 SAN', { cur: san.cur, max: san.max }, edit, '<div class="tt-hint">初始 ' + (editing ? cocNumIn('data-csanstart min="0"', cocN(san.start)) : cocN(san.start)) + '</div>' +
            (edit ? '<button class="tt-btn small" data-act="cocsan">理智检定</button>' : '') +
            '<div class="vals">' + cocValBtns('理智', cocN(san.cur)) + '</div>') +
        vital('mp', '魔法 MP', sh.mp, edit) +
        vital('luck', '幸运 Luck', { cur: luck }, edit, '<div class="vals">' + cocValBtns('幸运', luck) + '</div>') +
        '</div></div>';

    // 技能
    var skills = sh.cskills || [];
    var marked = skills.filter(function(s) { return s.mark; }).length;
    h += '<div class="side-section"><h5>技能' + (edit && marked ? ' <button class="tt-btn small" data-act="cocgrow" title="对打了成长标记的技能做成长检定">成长检定（' + marked + '）</button>' : '') + '</h5>';
    if (editing) {
        var occ = 0, intr = 0;
        skills.forEach(function(s) { occ += cocN(s.occ); intr += cocN(s.int); });
        h += '<div class="tt-hint">已用 职业点 ' + occ + ' · 兴趣点 ' + intr + ' / ' + cocAttr(sh, 'int') * 2 + '（智力×2）。★ = 本职技能，勾选 = 成长标记</div>' +
            '<div class="coc-sk-edit"><div class="hd"><span>★</span><span>技能</span><span>初始</span><span>职业</span><span>兴趣</span><span>成长</span><span>=</span><span></span></div>' +
            skills.map(function(s, i) {
                var auto = s.auto ? ' disabled title="' + (s.auto === 'dodge' ? '敏捷的一半' : '等于教育') + '"' : '';
                return '<div class="row"><input type="checkbox" data-csk="' + i + '" data-f="job"' + (s.job ? ' checked' : '') + ' title="本职技能">' +
                    '<input class="tt-input" data-csk="' + i + '" data-f="n" value="' + escapeHtml(s.n || '') + '" maxlength="20">' +
                    cocNumIn('data-csk="' + i + '" data-f="base" min="0"', cocN(s.base), auto) +
                    cocNumIn('data-csk="' + i + '" data-f="occ" min="0"', s.occ || '') +
                    cocNumIn('data-csk="' + i + '" data-f="int" min="0"', s.int || '') +
                    cocNumIn('data-csk="' + i + '" data-f="grow" min="0"', s.grow || '') +
                    '<b>' + cocSkillVal(s) + '</b><button class="tt-btn small danger" data-cskdel="' + i + '" title="删除这一行">✕</button></div>';
            }).join('') + '</div><button class="tt-btn small" data-act="cocskadd">＋ 添加技能</button>';
    } else {
        h += '<div class="coc-sk-tools"><input class="tt-input" id="cocFilter" placeholder="搜索技能" value="' + escapeHtml(cocFilterText) + '" autocomplete="off">' +
            '<label class="tt-hint"><input type="checkbox" id="cocAll"' + (cocAllSkills ? ' checked' : '') + '> 全部</label></div><div class="coc-skills" id="cocSkills">' +
            skills.map(function(s, i) {
                var v = cocSkillVal(s), plain = !s.job && !s.mark && !cocN(s.occ) && !cocN(s.int) && !cocN(s.grow);
                return '<div class="coc-sk' + (s.job ? ' job' : '') + (plain ? ' plain' : '') + '" data-name="' + escapeHtml(s.n || '') + '">' +
                    '<input type="checkbox" data-cmark="' + i + '"' + (s.mark ? ' checked' : '') + (edit ? '' : ' disabled') + ' title="成长标记（检定成功时自动勾上）">' +
                    '<span class="nm">' + (s.job ? '★' : '') + escapeHtml(s.n || '') + '</span>' + cocValBtns(s.n || '技能', v, s.n) + '</div>';
            }).join('') + '</div>';
    }
    h += '</div>';

    // 武器
    var weapons = sh.weapons || [];
    h += '<div class="side-section"><h5>武器</h5>';
    if (editing) {
        h += weapons.map(function(w, i) {
            var f = function(k, ph, size) { return '<input class="tt-input" data-cwp="' + i + '" data-f="' + k + '" value="' + escapeHtml(w[k] || '') + '" placeholder="' + ph + '" style="width:' + size + ';">'; };
            return '<div class="coc-wp-edit">' + f('name', '武器', '30%') + f('skill', '使用技能', '30%') + f('dmg', '伤害（可写 DB）', '30%') +
                f('range', '射程', '22%') + f('rof', '次数', '14%') + f('ammo', '装弹', '14%') + f('malf', '故障', '14%') +
                '<button class="tt-btn small danger" data-cwpdel="' + i + '">✕</button></div>';
        }).join('') + '<button class="tt-btn small" data-act="cocwpadd">＋ 添加武器</button>';
    } else {
        h += weapons.length ? weapons.map(function(w) {
            var sk = cocSkill(sh, w.skill), v = sk ? cocSkillVal(sk) : null, expr = cocDmgExpr(sh, w.dmg);
            return '<div class="attack-row"><div class="name">' + escapeHtml(w.name || '') + '</div>' +
                (v != null ? '<button class="roll-btn atk" data-cocv="' + v + '" data-cocd="0" data-cocl="' + escapeHtml((w.name || '') + '（' + w.skill + '）') + '" data-cocs="' + escapeHtml(w.skill) + '" title="' + escapeHtml(w.skill) + '检定">' + escapeHtml(w.skill) + ' ' + v + '</button>' : (w.skill ? '<span class="tt-hint">' + escapeHtml(w.skill) + '（卡上没有这个技能）</span>' : '')) +
                (expr ? '<button class="roll-btn dmg" data-cocdmg="' + escapeHtml(expr) + '" data-cocl="' + escapeHtml((w.name || '') + ' 伤害') + '" title="' + escapeHtml(w.dmg) + '">' + escapeHtml(w.dmg) + '</button>' : '') +
                ([w.range && !/^[—-]+$/.test(w.range) ? '射程 ' + w.range : '', w.rof ? '次数 ' + w.rof : '', w.ammo ? '装弹 ' + w.ammo : '', w.malf ? '故障 ' + w.malf : ''].filter(Boolean).length ?
                    '<div class="tt-hint">' + escapeHtml([w.range && !/^[—-]+$/.test(w.range) ? '射程 ' + w.range : '', w.rof ? '次数 ' + w.rof : '', w.ammo ? '装弹 ' + w.ammo : '', w.malf ? '故障 ' + w.malf : ''].filter(Boolean).join(' · ')) + '</div>' : '') +
                '</div>';
        }).join('') : '<div class="tt-hint">没有武器</div>';
    }
    h += '</div>';

    // 背景故事
    var story = sh.story || {};
    if (editing) {
        h += '<div class="side-section"><h5>背景与物品</h5>' + COC_STORY.map(function(f) {
            return '<label class="coc-story-edit">' + f[1] + '<textarea class="tt-input" data-cstory="' + f[0] + '" rows="2" maxlength="2000">' + escapeHtml(story[f[0]] || '') + '</textarea></label>';
        }).join('') + '</div>';
    } else {
        var rows = COC_STORY.filter(function(f) { return story[f[0]]; });
        if (rows.length) h += '<div class="side-section"><h5>背景与物品</h5>' + rows.map(function(f) {
            return '<div class="prop-line"><b>' + f[1] + '</b> ' + escapeHtml(story[f[0]]).replace(/\n/g, '<br>') + '</div>';
        }).join('') + '</div>';
    }
    return h;
}

// 不重绘就按搜索 / 「全部」过滤技能行
function cocFilterSkills() {
    var box = $('cocSkills');
    if (!box) return;
    var q = cocFilterText.trim().toLowerCase();
    box.querySelectorAll('.coc-sk').forEach(function(r) {
        var show = q ? (r.dataset.name || '').toLowerCase().indexOf(q) >= 0 : cocAllSkills || !r.classList.contains('plain');
        r.style.display = show ? '' : 'none';
    });
}

// ===== 事件 =====
// 返回 true = 已处理
function onCocClick(b, sh, e) {
    if (b.dataset.act === 'cocnew') { cocNewSheet(b.dataset.kind === 'monster' && me.gm ? 'monster' : 'pc'); return true; }
    if (!isCocSheet(sh)) return false;
    if (b.dataset.cocv != null) { cocCheck(sh, b.dataset.cocl, b.dataset.cocv, b.dataset.cocd, b.dataset.cocs); return true; }
    if (b.dataset.cocdmg) { roll(b.dataset.cocdmg, sh.name + '·' + b.dataset.cocl, $('diceHidden').checked); return true; }
    if (b.dataset.cocbonus != null) { cocBonus = cocN(b.dataset.cocbonus); renderSheets(); return true; }
    var edit = canEditSheet(sh);
    if (b.dataset.cocadj && edit) { cocAdjust(sh, b.dataset.cocadj, cocN(b.dataset.delta), true); return true; }
    if (b.dataset.cskdel != null && edit) {
        sh.cskills.splice(cocN(b.dataset.cskdel), 1);
        cocSave(sh, ['cskills']);
        renderSheets();
        return true;
    }
    if (b.dataset.cwpdel != null && edit) {
        sh.weapons.splice(cocN(b.dataset.cwpdel), 1);
        cocSave(sh, ['weapons']);
        renderSheets();
        return true;
    }
    switch (b.dataset.act) {
    case 'cocedit':
        sheetView.edit = !sheetView.edit;
        renderSheets();
        return true;
    case 'cocsan': if (edit) cocSanCheck(sh); return true;
    case 'cocgrow': if (edit) cocGrow(sh); return true;
    case 'cocskadd':
        if (!edit) return true;
        sh.cskills = sh.cskills || [];
        sh.cskills.push({ n: '新技能', base: 1 });
        cocSave(sh, ['cskills']);
        renderSheets();
        return true;
    case 'cocwpadd':
        if (!edit) return true;
        sh.weapons = sh.weapons || [];
        sh.weapons.push({ name: '新武器', skill: '格斗：斗殴', dmg: '1d6+DB', range: '—', rof: '1' });
        cocSave(sh, ['weapons']);
        renderSheets();
        return true;
    }
    return false;
}

// 体力 / 理智 / 魔法 / 幸运：delta 模式（±）或直接设值
function cocAdjust(sh, key, v, isDelta) {
    if (key === 'hp') {
        var tok = cocToken(sh);
        if (tok && canEdit(tok)) {
            var next = Math.max(0, Math.min(tok.hpMax, isDelta ? num(tok.hp, tok.hpMax) + v : v));
            patchItems([{ id: tok.id, hp: next }]);
            if (canEditSheet(sh)) { sh.hp = sh.hp || {}; sh.hp.cur = next; sh.hp.max = tok.hpMax; cocSave(sh, ['hp']); }
            renderSheetsRemote();
            return;
        }
    }
    if (!canEditSheet(sh)) return;
    var o = key === 'luck' ? (sh.luck = sh.luck || {}) : (sh[key] = sh[key] || {});
    var cur = isDelta ? cocN(o.cur) + v : v;
    if (o.max != null && key !== 'luck') cur = Math.min(cur, cocN(o.max));
    o.cur = Math.max(0, cur);
    cocSave(sh, [key]);
    if (key === 'hp') cocSyncTokens(sh);
}

function cocOnChange(e) {
    var t = e.target, sh = currentSheet();
    if (t.id === 'cocAll') { cocAllSkills = t.checked; cocFilterSkills(); return true; }
    if (!isCocSheet(sh) || !canEditSheet(sh)) return false;
    var d = t.dataset;
    if (d.cname != null) { sh.name = String(t.value).trim().slice(0, 40) || sh.name; cocSave(sh, ['name']); return true; }
    if (d.cinfo) { sh.info = sh.info || {}; sh.info[d.cinfo] = String(t.value).trim().slice(0, 30); cocSave(sh, ['info']); return true; }
    if (d.cattr) {
        sh.attrs = sh.attrs || {};
        var oldPow = cocAttr(sh, 'pow');
        if (d.cattr === 'mov' && t.value === '') delete sh.attrs.mov;
        else sh.attrs[d.cattr] = Math.max(0, cocN(t.value));
        // 初始理智 = 意志：还没动过（等于旧意志）就跟着改，当前理智原来等于初始值也一起改
        if (d.cattr === 'pow' && sh.san && cocN(sh.san.start) === oldPow) {
            if (cocN(sh.san.cur) === oldPow) sh.san.cur = cocAttr(sh, 'pow');
            sh.san.start = cocAttr(sh, 'pow');
        }
        cocDerive(sh, false);
        cocSave(sh, ['attrs', 'cskills', 'hp', 'mp', 'san']);
        cocSyncTokens(sh);
        return true;
    }
    if (d.cvital) { cocAdjust(sh, d.cvital, Math.max(0, cocN(t.value)), false); return true; }
    if (d.cvmax) {
        var o = sh[d.cvmax] = sh[d.cvmax] || {};
        o.max = Math.max(0, cocN(t.value));
        if (cocN(o.cur) > o.max) o.cur = o.max;
        cocSave(sh, [d.cvmax]);
        if (d.cvmax === 'hp') cocSyncTokens(sh);
        return true;
    }
    if (d.csanstart != null) { sh.san = sh.san || {}; sh.san.start = Math.max(0, cocN(t.value)); cocSave(sh, ['san']); return true; }
    if (d.cmark != null) {
        var s = (sh.cskills || [])[cocN(d.cmark)];
        if (s) { if (t.checked) s.mark = true; else delete s.mark; cocSave(sh, ['cskills']); }
        return true;
    }
    if (d.csk != null) {
        var sk = (sh.cskills || [])[cocN(d.csk)];
        if (!sk) return true;
        if (d.f === 'job') { if (t.checked) sk.job = true; else delete sk.job; }
        else if (d.f === 'n') sk.n = String(t.value).trim().slice(0, 20) || sk.n;
        else { var n = Math.max(0, cocN(t.value)); if (n || d.f === 'base') sk[d.f] = n; else delete sk[d.f]; }
        var keys = ['cskills'];
        if (sk.n === '克苏鲁神话') { cocDerive(sh, false); keys.push('san'); } // 理智上限 = 99 − 克苏鲁神话
        cocSave(sh, keys);
        return true;
    }
    if (d.cwp != null) {
        var w = (sh.weapons || [])[cocN(d.cwp)];
        if (w) { w[d.f] = String(t.value).trim().slice(0, 40); cocSave(sh, ['weapons']); }
        return true;
    }
    if (d.cstory) { sh.story = sh.story || {}; sh.story[d.cstory] = String(t.value).slice(0, 2000); cocSave(sh, ['story']); return true; }
    return false;
}

// ===== 记录 =====
function cocDiceText(c) {
    if (!c.tens) return '';
    var tens = c.tens.map(function(t) { return t === 0 ? '00' : String(t); });
    return '十位 [' + tens.join(', ') + '] 个位 [' + c.units + ']';
}

function cocLevelTag(c) {
    var lv = COC_LEVEL[c.level] || ['?', ''];
    return '<span class="coc-lv ' + lv[1] + '">' + lv[0] + '</span>';
}

function cocLogHtml(e) {
    var c = e.coc;
    if (c.mode === 'grow') {
        return '<div class="log-coc">' + (c.grow || []).map(function(g) {
            return '<div>' + escapeHtml(g.name) + ' ' + g.from + '：掷 ' + g.roll + ' → ' + (g.gain ? '<b class="coc-lv ok">+' + g.gain + '（' + (g.from + g.gain) + '）</b>' : '<span class="tt-hint">未成长</span>') + '</div>';
        }).join('') + '</div>';
    }
    var bonus = c.bonus > 0 ? '奖励骰×' + c.bonus : c.bonus < 0 ? '惩罚骰×' + (-c.bonus) : '';
    var h = '<div class="log-coc"><span class="expr">d100' + (bonus ? '（' + bonus + '）' : '') + ' / ' + c.value +
        (c.diff ? ' · 要求' + COC_DIFF[c.diff] + '（' + Math.floor(c.value / (c.diff === 1 ? 2 : 5)) + '）' : '') + '</span> → ' +
        (c.tens && c.tens.length > 1 ? '<span class="detail">' + escapeHtml(cocDiceText(c)) + '</span> ' : '') +
        '<span class="total">' + c.roll + '</span> ' + cocLevelTag(c) +
        (c.diff ? (c.pass ? ' <span class="coc-lv ok">✓ 达到' + COC_DIFF[c.diff] + '</span>' : ' <span class="coc-lv bad">✗ 未达' + COC_DIFF[c.diff] + '</span>') : '') +
        (c.mark ? ' <span class="tt-hint" title="已在人物卡上打成长标记">☑ 成长</span>' : '') + '</div>';
    if (c.mode === 'san') {
        h += '<div class="log-coc">理智损失 ' + escapeHtml(c.loss || '') + (c.lossRoll ? '：' + escapeHtml(c.lossRoll.expr) + ' = <b>' + c.lossRoll.total + '</b>' : '') +
            '，SAN ' + c.sanFrom + ' → <b>' + c.sanTo + '</b></div>';
        var lost = c.sanFrom - c.sanTo;
        if (c.sanTo === 0) h += '<div class="tt-hint">理智归零：永久疯狂</div>';
        else if (lost >= 5) h += '<div class="tt-hint">单次损失 ≥ 5：进行智力检定，成功则陷入临时疯狂</div>';
    }
    // 自己的普通检定失败：可以孤注一掷（只能一次）
    if (!c.mode && e.who === me.name && c.level === 'fail' && !/（孤注一掷）$/.test(e.label || '')) {
        h += '<button class="reroll" data-cocpush="' + c.value + '" data-cocd="' + (c.diff || 0) + '" data-label="' + escapeHtml(e.label || '') + '" data-hidden="' + (e.hidden ? 1 : 0) +
            '" title="孤注一掷：再掷一次，失败的后果会更严重">孤注一掷</button>';
    }
    return h;
}

function cocToastText(e) {
    var c = e.coc;
    if (c.mode === 'grow') return '成长检定 ' + (c.grow || []).filter(function(g) { return g.gain; }).length + ' 项成长';
    return c.roll + ' ' + (COC_LEVEL[c.level] || ['?'])[0] + (c.mode === 'san' ? '，SAN ' + c.sanFrom + '→' + c.sanTo : '');
}

function onCocLogClick(e) {
    var b = e.target.closest('[data-cocpush]');
    if (!b) return false;
    op({ op: 'coc', mode: 'check', label: b.dataset.label + '（孤注一掷）', hidden: b.dataset.hidden === '1',
        coc: { value: cocN(b.dataset.cocpush), diff: cocN(b.dataset.cocd), bonus: 0 } });
    b.remove();
    return true;
}

// 骰子栏的角色快捷条
function cocQuickChips(sh, chip) {
    COC_QUICK.forEach(function(n) {
        var s = cocSkill(sh, n);
        if (s) chip(n + ' ' + cocSkillVal(s), 'data-qcoc="' + cocSkillVal(s) + '" data-qlabel="' + escapeHtml(n) + '"');
    });
    chip('幸运 ' + cocN((sh.luck || {}).cur), 'data-qcoc="' + cocN((sh.luck || {}).cur) + '" data-qlabel="幸运"');
}

function initCoc() {
    var box = $('rulesSwitch');
    if (box) box.addEventListener('click', onRulesSwitch);
    var pane = $('sheetPane');
    pane.addEventListener('input', function(e) {
        if (e.target.id === 'cocFilter') { cocFilterText = e.target.value; cocFilterSkills(); }
    });
    var obs = new MutationObserver(function() { cocFilterSkills(); });
    obs.observe(pane, { childList: true });
    $('logList').addEventListener('click', function(e) { onCocLogClick(e); });
}
