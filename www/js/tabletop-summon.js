// 跑团桌面：随从 / 召唤物（角色卡 kind = "summon"）
// - 卡上的 master = 主控角色卡 id。没有自己施法数据的随从，法术攻击 / 法术 DC / 施法属性 / 熟练加值都跟随主控
//   （finishAction → sheetCasting / castingMod / sheetProf 会取主控的）
// - 卡上文字可以写【…】占位，按主控实时换算：
//   【法术攻击】【法术DC】【熟练】【等级】【施法属性】【力量】…【魅力】【奇械师等级】
//   【奇械师等级×5】（乘）、【智力≥1】（至少）、【奇械师9级：3d8｜2d8】（职业等级达到时取前者）
// - 只掷骰的条目（noCast）不显示 ⚡，不会自动结算（例如临时生命按房规自己调）
// - 随从倒下就是摧毁 / 消失，没有死亡豁免；在先攻外行动时，消耗记在主控身上
// 依赖 tabletop.js / tabletop-sheets.js / tabletop-action.js / tabletop-fight.js 的全局状态与函数

function isSummonSheet(sh) { return !!sh && sh.kind === 'summon'; }
function masterSheet(sh) { return sh && sh.master && sh.master !== sh.id && sheets[sh.master] || null; }

// 主控的某个数值：{ v, s }（s = 写成带正负号的加值）
function summonVal(m, key) {
    var c = m.casting && m.casting[0];
    if (key === '法术攻击') return c ? { v: num(String(c.atk || '0').replace('+', ''), 0), s: true } : null;
    if (key === '法术DC' || key === '法术豁免DC' || key === 'DC') return c ? { v: parseInt(c.dc, 10) || 0, s: false } : null;
    if (key === '熟练' || key === '熟练加值') return { v: sheetProf(m), s: true };
    if (key === '等级') return { v: parseInt(m.level, 10) || 1, s: false };
    if (key === '施法属性') return { v: castingMod(m), s: true };
    if (ABIL_KEY[key]) return { v: sheetAbilityMod(m, ABIL_KEY[key]), s: true };
    var cm = key.match(/^(.+?)等级$/);
    if (cm) return { v: classLevel(m, cm[1]), s: false };
    return null;
}

function summonToken(m, body) {
    body = body.replace(/\s/g, '');
    var c = body.match(/^(.*?)(\d+)级[：:](.*?)[｜|](.*)$/);
    if (c) return (c[1] ? classLevel(m, c[1]) : parseInt(m.level, 10) || 1) >= +c[2] ? c[3] : c[4];
    var mm = body.match(/^(.+?)(?:[×xX*](\d+))?(?:≥(-?\d+))?$/);
    var r = mm && summonVal(m, mm[1]);
    if (!r) return null;
    var v = r.v * (mm[2] ? +mm[2] : 1);
    if (mm[3] != null) v = Math.max(v, +mm[3]);
    return { v: v, s: r.s && !mm[2] };
}

function summonText(sh, text) {
    var m = masterSheet(sh);
    if (!m || text == null || String(text).indexOf('【') < 0) return text;
    return String(text).replace(/([+＋]\s*)?【([^】]{1,40})】/g, function(all, plus, body) {
        var r = summonToken(m, body);
        if (r == null) return all;
        if (typeof r === 'string') return (plus || '') + r;
        return plus || r.s ? (r.v >= 0 ? '+' : '') + r.v : String(r.v);
    });
}

// 显示 / 结算用的随从卡：占位都换成主控的数值（原卡不动）
function viewSheet(sh) {
    if (!isSummonSheet(sh) || !masterSheet(sh)) return sh;
    var c = JSON.parse(JSON.stringify(sh)), f = function(s) { return summonText(sh, s); };
    (c.sections || []).forEach(function(sec) { (sec.entries || []).forEach(function(en) { en.text = f(en.text); }); });
    (c.features || []).forEach(function(x) { x.text = f(x.text); });
    (c.props || []).forEach(function(p) { p.value = f(p.value); });
    (c.attacks || []).forEach(function(a) { a.atk = f(a.atk); a.damage = f(a.damage); a.props = f(a.props); });
    c.ac = f(c.ac);
    var hm = summonHpMax(sh);
    if (hm > 0) { c.hp = c.hp || {}; c.hp.max = hm; if (c.hp.cur == null || num(c.hp.cur, hm) > hm) c.hp.cur = hm; }
    return c;
}

// 生命上限：hpRule（数字或【奇械师等级×5】）按主控换算
function summonHpMax(sh) {
    if (!sh || !sh.hpRule) return 0;
    return parseInt(summonText(sh, sh.hpRule), 10) || 0;
}

// 主控的棋子（当前场景，优先自己能控制的）
function masterToken(sh) {
    var m = masterSheet(sh);
    if (!m) return null;
    var list = sortedItems().filter(function(t) { return t.kind === 'token' && t.sheet === m.id; });
    return list.filter(function(t) { return canEdit(t); })[0] || list[0] || null;
}

// 可以选作主控的角色卡：GM = 所有角色卡；玩家 = 自己的
function masterChoices() {
    return Object.keys(sheets).map(function(id) { return sheets[id]; }).filter(function(s) {
        return s.kind === 'pc' && (me.gm || canEditSheet(s));
    }).sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
}

function masterOptions(sel) {
    return '<option value="">（未设置）</option>' + masterChoices().map(function(s) {
        return '<option value="' + escapeHtml(s.id) + '"' + (s.id === sel ? ' selected' : '') + '>' + escapeHtml(s.name) + '</option>';
    }).join('');
}

// 随从卡顶部：主控选择 + 跟随主控的数值
function summonHeadHtml(sh, edit) {
    var raw = sheets[sh.id] || sh, m = masterSheet(raw), h = '';
    if (isSummonSheet(raw)) {
        h += '<div class="lobby-row" style="gap:6px;flex-wrap:wrap;"><span class="tt-hint">主控</span>' +
            (edit ? '<select class="tt-select" data-summonmaster="' + escapeHtml(sh.id) + '">' + masterOptions(raw.master) + '</select>'
                : '<b>' + escapeHtml(m ? m.name : '（未设置）') + '</b>') +
            (edit ? '<button class="tt-btn small" data-act="smedit" data-id="' + escapeHtml(sh.id) + '">' + (sheetView.edit ? '完成编辑' : '✏ 编辑') + '</button>' : '') + '</div>';
        if (m) {
            var c = m.casting && m.casting[0];
            h += '<div class="tt-hint">跟随主控：' + [c ? '法术攻击 ' + (normBonus(c.atk) || '+0') : '', c ? '法术 DC ' + escapeHtml(c.dc) : '', '熟练 +' + sheetProf(m),
                c ? '施法属性 ' + (castingMod(m) >= 0 ? '+' : '') + castingMod(m) : ''].filter(Boolean).join(' · ') + (c ? '' : '（主控卡上没有施法数据）') + '</div>';
        } else h += '<div class="tt-hint">还没有设置主控：卡上的【…】数值和法术攻击 / DC 无法换算。</div>';
        h += '<div class="lobby-row" style="gap:6px;flex-wrap:wrap;"><span class="tt-hint">行动方式</span>' +
            (edit ? '<select class="tt-select" data-summoninit="' + escapeHtml(sh.id) + '">' +
                '<option value=""' + (raw.initMode !== 'own' ? ' selected' : '') + '>跟随主控（在主控回合行动）</option>' +
                '<option value="own"' + (raw.initMode === 'own' ? ' selected' : '') + '>独立先攻（自己的回合）</option></select>'
                : '<b>' + (raw.initMode === 'own' ? '独立先攻' : '跟随主控') + '</b>') + '</div>';
        h += summonIconHtml(raw, edit);
    } else if (me.gm && raw.kind === 'monster') {
        h += '<div class="lobby-row" style="gap:6px;"><span class="tt-hint">设为随从，主控</span><select class="tt-select" data-summonmaster="' + escapeHtml(sh.id) + '">' +
            masterOptions('') + '</select></div>';
    }
    return h;
}

// 设置 / 更换主控。怪物卡被设为随从时改成 summon，归主控的玩家
function setSummonMaster(id, mid) {
    var sh = sheets[id];
    if (!sh) return;
    var m = mid && sheets[mid];
    var patch = { id: id, master: mid || null };
    if (me.gm && m && sh.kind !== 'summon') { patch.kind = 'summon'; patch.owner = m.owner || null; }
    else if (me.gm && m && m.owner && !sh.owner) patch.owner = m.owner;
    op({ op: 'sheet', sheet: patch });
    if (patch.owner) {
        var toks = sortedItems().filter(function(t) { return t.kind === 'token' && t.sheet === id && t.owner !== patch.owner; });
        if (toks.length) patchItems(toks.map(function(t) { return { id: t.id, owner: patch.owner }; }));
    }
    notice(m ? '「' + sh.name + '」的主控设为「' + m.name + '」' : '已清除主控');
}

// ===== 模板 =====
var SUMMON_TEMPLATES = {
    cannon: { label: '魔能炮台（奇械师·魔炮师）', make: function() {
        var dmg = '【奇械师9级：3d8｜2d8】';
        return { name: '魔能炮台', meta: '小型或微型 魔法物品 · 奇械师（魔炮师）', ac: '18', hpRule: '【奇械师等级×5】', speed: '15 尺（有腿时，可攀爬）',
            abilities: tplAbilities(),
            props: [{ label: '伤害免疫', value: '毒素、心灵' }, { label: '状态免疫', value: '所有状态' },
                { label: '说明', value: '属性检定和豁免都按 10（+0）。被修复术修理时恢复 2d6 生命值。生命值降到 0 或 1 小时后消失；主控可以用魔法动作提前解散。' }],
            sections: [{ title: '激活（主控在 60 尺内用附赠动作，可顺带让炮台移动 15 尺）', entries: [
                { name: '火焰喷射', text: '主控的附赠动作。炮台向相邻的 15 尺锥形区域喷火，区域内每个生物进行一次敏捷豁免，DC【法术DC】，失败受到 ' + dmg + ' 点火焰伤害，成功减半。区域内未被穿戴或携带的易燃物被点燃。' },
                { name: '力场弩炮', text: '主控的附赠动作。从炮台对 120 尺内一个生物或物体进行一次远程法术攻击，射程 120 尺，命中【法术攻击】，命中后目标受到 ' + dmg + ' 点力场伤害；目标是生物时被推离炮台至多 5 尺。' },
                { name: '护卫', noCast: true, text: '主控的附赠动作。炮台和它 10 尺内任意数量主控选择的生物获得临时生命值：【奇械师9级：2d8｜1d8】+【智力≥1】。只掷骰，不自动加，按房规自己调整后手动填。' },
                { name: '引爆（奇械师 9 级起）', text: '炮台受到伤害时，主控（60 尺内）可以用反应让它引爆：炮台摧毁，20 尺半径内每个生物进行一次敏捷豁免，DC【法术DC】，失败受到 3d10 点力场伤害，成功减半。' }
            ] }] };
    } },
    blank: { label: '空白随从（自己填）', make: function() {
        return { name: '随从', meta: '召唤物', ac: '10', hpRule: '10', speed: '30 尺', abilities: tplAbilities(),
            sections: [{ title: '动作', entries: [
                { name: '攻击', text: '近战法术攻击，触及 5 尺，命中【法术攻击】，命中后造成 1d8+【施法属性】 点力场伤害。（按需要改写；【…】会按主控换算）' }
            ] }] };
    } }
};

function tplAbilities() {
    return ['str', 'dex', 'con', 'int', 'wis', 'cha'].map(function(k) { return { key: k, name: ABILITY_NAMES[k], score: '10', mod: '+0', save: '+0' }; });
}

function newSummonHtml() {
    var ms = masterChoices();
    return '<div class="sheet-head"><button class="tt-btn small" data-act="back">←</button><div class="title"><div class="name">新建随从 / 召唤物</div>' +
        '<div class="sub">没有独立怪物卡的召唤物：攻击和 DC 跟随主控</div></div></div>' +
        '<div class="side-section"><div class="rd-row"><span class="rd-key">模板</span><select class="tt-select" id="smTpl">' +
        Object.keys(SUMMON_TEMPLATES).map(function(k) { return '<option value="' + k + '">' + escapeHtml(SUMMON_TEMPLATES[k].label) + '</option>'; }).join('') + '</select></div>' +
        '<div class="rd-row"><span class="rd-key">主控</span><select class="tt-select" id="smMaster">' + masterOptions(ms.length === 1 ? ms[0].id : '') + '</select></div>' +
        '<div class="lobby-row" style="gap:6px;margin-top:8px;"><button class="tt-btn primary" data-act="mksummon">创建</button></div>' +
        '<div class="tt-hint" style="margin-top:8px;">有怪物卡的召唤物（魔宠、钢铁卫士等）：从图鉴导入后在卡上「设为随从」选主控即可。' +
        '随从卡可以自己编辑，文字里的【法术攻击】【法术DC】【智力】【奇械师等级×5】之类会按主控实时换算。</div></div>';
}

function createSummon() {
    var tpl = SUMMON_TEMPLATES[$('smTpl').value] || SUMMON_TEMPLATES.blank, mid = $('smMaster').value;
    var sh = tpl.make();
    sh.id = genId();
    sh.kind = 'summon';
    if (mid) sh.master = mid;
    var m = mid && sheets[mid];
    if (me.gm && m && m.owner) sh.owner = m.owner;
    var hm = summonHpMax(Object.assign({}, sh, { id: sh.id }));
    sh.hp = { max: hm > 0 ? hm : 10 };
    sheetView = { mode: 'list' };
    importSheet(sh);
}

// ===== 编辑随从卡 =====
function summonEditHtml(sh) {
    var raw = sheets[sh.id] || sh, h = '<div class="side-section sm-edit"><h5>编辑随从卡</h5>';
    var row = function(label, key, val, ph) {
        return '<div class="rd-row"><span class="rd-key">' + label + '</span><input class="tt-input" data-smf="' + key + '" value="' + escapeHtml(val == null ? '' : val) + '" placeholder="' + escapeHtml(ph || '') + '"></div>';
    };
    h += row('名字', 'name', raw.name) + row('描述', 'meta', raw.meta) + row('AC', 'ac', raw.ac, '18 或【…】') +
        row('生命上限', 'hpRule', raw.hpRule || (raw.hp && raw.hp.max), '数字或【奇械师等级×5】') + row('速度', 'speed', raw.speed);
    (raw.sections || []).forEach(function(sec, si) {
        h += '<div class="rd-row"><span class="rd-key">分组</span><input class="tt-input" data-smsec="' + si + '" value="' + escapeHtml(sec.title || '') + '"></div>';
        (sec.entries || []).forEach(function(en, ei) {
            h += '<div class="sm-entry" data-sec="' + si + '" data-idx="' + ei + '" style="margin:6px 0;padding:6px;border:1px solid rgba(255,255,255,.12);border-radius:6px;">' +
                '<div class="rd-row"><input class="tt-input" data-sme="name" value="' + escapeHtml(en.name || '') + '" placeholder="名字">' +
                '<label class="tt-hint" title="只显示掷骰按钮，不出现 ⚡ 自动结算"><input type="checkbox" data-sme="noCast"' + (en.noCast ? ' checked' : '') + '> 只掷骰</label>' +
                '<button class="tt-btn small danger" data-act="smdel" data-sec="' + si + '" data-idx="' + ei + '">✕</button></div>' +
                '<textarea class="tt-input" data-sme="text" rows="3" style="width:100%;">' + escapeHtml(en.text || '') + '</textarea></div>';
        });
        h += '<button class="tt-btn small" data-act="smadd" data-sec="' + si + '">＋ 条目</button>';
    });
    if (!(raw.sections || []).length) h += '<button class="tt-btn small" data-act="smadd" data-sec="0">＋ 条目</button>';
    return h + '<div class="lobby-row" style="gap:6px;margin-top:8px;"><button class="tt-btn primary" data-act="smsave" data-id="' + escapeHtml(raw.id) + '">保存</button></div></div>';
}

// 从编辑框读出来（addSec / delEntry：增删条目时先保留已经填的内容）
function readSummonEdit(raw, addSec, del) {
    var pane = $('sheetPane'), out = { id: raw.id };
    pane.querySelectorAll('[data-smf]').forEach(function(el) { out[el.dataset.smf] = el.value.trim(); });
    var secs = JSON.parse(JSON.stringify(raw.sections || []));
    if (!secs.length) secs = [{ title: '动作', entries: [] }];
    pane.querySelectorAll('[data-smsec]').forEach(function(el) { var s = secs[+el.dataset.smsec]; if (s) s.title = el.value.trim(); });
    pane.querySelectorAll('.sm-entry').forEach(function(box) {
        var s = secs[+box.dataset.sec], en = s && s.entries[+box.dataset.idx];
        if (!en) return;
        en.name = box.querySelector('[data-sme="name"]').value.trim();
        en.text = box.querySelector('[data-sme="text"]').value;
        if (box.querySelector('[data-sme="noCast"]').checked) en.noCast = true; else delete en.noCast;
    });
    if (del) secs[del.sec].entries.splice(del.idx, 1);
    if (addSec != null) (secs[addSec] || secs[0]).entries.push({ name: '新条目', text: '' });
    out.sections = secs;
    var hp = out.hpRule;
    delete out.hpRule;
    if (/^\d+$/.test(hp)) { out.hpRule = null; out.hp = { max: +hp }; }
    else if (hp) { out.hpRule = hp; var hm = summonHpMax(Object.assign({}, raw, { hpRule: hp })); if (hm > 0) out.hp = { max: hm }; }
    return out;
}

function saveSummonEdit(raw, addSec, del) {
    var patch = readSummonEdit(raw, addSec, del);
    if (!patch.name) { notice('名字不能为空', true); return; }
    op({ op: 'sheet', sheet: patch }).then(function(ok) {
        if (!ok) return;
        Object.assign(sheets[raw.id], patch);
        if (addSec == null && !del) { sheetView.edit = false; notice('已保存「' + patch.name + '」'); }
        renderSheets();
    });
}

function onSummonClick(b, sh) {
    switch (b.dataset.act) {
    case 'newsummon': sheetView = { mode: 'newsummon', back: { mode: 'list' } }; renderSheets(); return true;
    case 'mksummon': createSummon(); return true;
    case 'smedit': sheetView.edit = !sheetView.edit; renderSheets(); return true;
    case 'smsave': saveSummonEdit(sheets[b.dataset.id]); return true;
    case 'smadd': if (sh && sheets[sh.id]) saveSummonEdit(sheets[sh.id], +b.dataset.sec); return true;
    case 'smdel': if (sh && sheets[sh.id]) saveSummonEdit(sheets[sh.id], null, { sec: +b.dataset.sec, idx: +b.dataset.idx }); return true;
    case 'smiconup': uploadSummonIcon(b.dataset.id); return true;
    case 'smiconclr': setSummonIcon(b.dataset.id, ''); return true;
    }
    return false;
}

// 放置随从棋子：放在主控旁边，归主控的玩家，生命上限按主控换算；跟随主控的战斗中不自动掷先攻（在主控回合行动）
function summonPlaceAdjust(sh, it) {
    if (!isSummonSheet(sh)) return;
    it.color = '#43a047';
    var hm = summonHpMax(sh);
    if (hm > 0) { it.hpMax = hm; it.hp = hm; }
    if (me.gm && sh.owner) it.owner = sh.owner;
    var mt = masterToken(sh);
    if (mt) { it.x = r1((mt.x || 0) + (mt.w || gridSize())); it.y = r1(mt.y || 0); }
}

// 先攻外的随从：动作消耗记在主控棋子上
function econOwner(caster) {
    if (!followsMaster(caster)) return caster;
    var mt = masterToken(sheets[caster.sheet]);
    return mt && inInit(mt) ? mt : caster;
}

// ===== 棋子图标 =====
function summonIconHtml(raw, edit) {
    var img = raw.tokenImg ? '<img src="' + escapeHtml(assetURL(raw.tokenImg)) + '" alt="" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid #43a047;">'
        : '<span class="tt-hint">（默认圆点）</span>';
    if (!edit) return raw.tokenImg ? '<div class="lobby-row" style="gap:6px;"><span class="tt-hint">棋子图标</span>' + img + '</div>' : '';
    var assets = (room.assets || []).filter(function(a) { return a.kind === 'token'; });
    return '<div class="lobby-row" style="gap:6px;flex-wrap:wrap;align-items:center;"><span class="tt-hint">棋子图标</span>' + img +
        '<select class="tt-select" data-summonicon="' + escapeHtml(raw.id) + '" title="从资产库选一张图" style="max-width:150px;"><option value="">从资产库选…</option>' +
        assets.map(function(a) { return '<option value="' + escapeHtml(a.id) + '"' + (a.id === raw.tokenImg ? ' selected' : '') + '>' + escapeHtml(a.name || a.id) + '</option>'; }).join('') + '</select>' +
        '<button class="tt-btn small" data-act="smiconup" data-id="' + escapeHtml(raw.id) + '">上传图片</button>' +
        (raw.tokenImg ? '<button class="tt-btn small" data-act="smiconclr" data-id="' + escapeHtml(raw.id) + '">恢复默认</button>' : '') + '</div>';
}

// 换图标：卡上记 tokenImg（以后放置都用它），已放置的棋子一起换
function setSummonIcon(id, asset) {
    var sh = sheets[id];
    if (!sh) return;
    op({ op: 'sheet', sheet: { id: id, tokenImg: asset || null } }).then(function(ok) {
        if (!ok) return;
        sh.tokenImg = asset || undefined;
        var toks = sortedItems().filter(function(t) { return t.kind === 'token' && t.sheet === id && canEdit(t); });
        if (toks.length) patchItems(toks.map(function(t) { return asset ? { id: t.id, asset: asset, circle: false } : { id: t.id, asset: null, circle: true }; }));
        notice(asset ? '已更换「' + sh.name + '」的棋子图标' + (toks.length ? '（已放置的 ' + toks.length + ' 个棋子一起换了）' : '') : '已恢复默认图标');
        renderSheets();
    });
}

function uploadSummonIcon(id) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = function() {
        var f = inp.files[0];
        if (!f) return;
        notice('正在上传图片…');
        uploadAsset(f, 'token').then(function(a) { if (a && a.id) setSummonIcon(id, a.id); }).catch(apiError);
    };
    inp.click();
}

// ===== 跟随主控：在主控的回合行动 =====
function followsMaster(t) {
    var sh = t && t.kind === 'token' && t.sheet && sheets[t.sheet];
    return isSummonSheet(sh) && !!sh.master && sh.initMode !== 'own' && !inInit(t);
}

// 这个棋子的随从（跟随主控、不在先攻里）
function companionsOf(tok) {
    if (!tok || !tok.sheet) return [];
    return sortedItems().filter(function(t) { return followsMaster(t) && sheets[t.sheet].master === tok.sheet && visibleToMe(t); });
}

// 现在是它主控的回合：移动计入本回合、可以自由行动
function summonActsNow(t) {
    var c = combatState(), cur = c && scene.items[c.turn];
    return !!cur && followsMaster(t) && sheets[t.sheet].master === cur.sheet;
}

// 先攻条：主控后面挂上随从的小头像
function companionChipsHtml(master, portrait, active) {
    return companionsOf(master).map(function(t) {
        var down = (t.hpMax > 0 && num(t.hp, t.hpMax) <= 0) || hasStatus(t, 'dead');
        var cls = 'init-chip comp' + (portrait ? ' pt' : '') + (active ? ' active' : '') + (down ? ' down' : '');
        var tip = escapeHtml((t.label || '随从') + ' · 跟随主控，在「' + (master.label || '主控') + '」的回合行动');
        var col = escapeHtml(t.color || '#43a047');
        var face = t.asset ? '<img src="' + escapeHtml(assetURL(t.asset)) + '" alt="" draggable="false">' : '<i style="background:' + col + '">' + escapeHtml((t.label || '?').slice(0, 1)) + '</i>';
        if (portrait) return '<span class="' + cls + '" data-focus="' + escapeHtml(t.id) + '" title="' + tip + '"><span class="pt-img" style="border-color:' + col + '">' + face + '</span><span class="nm">' + escapeHtml(chipName(t.label)) + '</span></span>';
        return '<span class="' + cls + '" data-focus="' + escapeHtml(t.id) + '" title="' + tip + '">' + (t.asset ? face.replace('<img ', '<img class="ci" ') : face) + '<span class="nm">' + escapeHtml(chipName(t.label)) + '</span></span>';
    }).join('');
}

function initSummon() {
    $('sheetPane').addEventListener('change', function(e) {
        var d = e.target.dataset || {};
        if (d.summonmaster) setSummonMaster(d.summonmaster, e.target.value);
        if (d.summoninit && sheets[d.summoninit]) {
            op({ op: 'sheet', sheet: { id: d.summoninit, initMode: e.target.value || null } });
            notice(e.target.value === 'own' ? '改为独立先攻：在先攻栏把它加进去、掷先攻' : '改为跟随主控：不进先攻条，在主控的回合行动');
        }
        if (d.summonicon && e.target.value) setSummonIcon(d.summonicon, e.target.value);
    });
}
