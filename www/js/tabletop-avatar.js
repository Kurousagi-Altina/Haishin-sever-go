// 跑团桌面：棋子头像（上传 / 从资产库选 / 缩放、拖动位置、圆形或方形、边框颜色）
// 棋子字段：asset（图片）、circle、color（圆形时是边框色）、iz（缩放，1 = 刚好铺满）、ix / iy（图片中心相对棋子中心的偏移，单位 = 棋子宽 / 高）。
// 设了 iz 的棋子按「铺满不变形」画（tokenImgDraw）；没设的照旧拉伸到棋子大小。
// 玩家可以改自己控制的棋子；勾「设为角色卡头像」时卡上记 tokenImg + tokenCrop，以后从卡放的棋子都用它。

function tokenImgDraw(img, it, w, h) {
    if (it.iz == null) { ctx.drawImage(img, -w / 2, -h / 2, w, h); return; }
    var iw = img.naturalWidth || img.width || w, ih = img.naturalHeight || img.height || h;
    var k = Math.max(w / iw, h / ih) * Math.max(0.2, num(it.iz, 1)), dw = iw * k, dh = ih * k;
    ctx.save();
    if (!it.circle) { ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); ctx.clip(); }
    ctx.drawImage(img, -dw / 2 + num(it.ix, 0) * w, -dh / 2 + num(it.iy, 0) * h, dw, dh);
    ctx.restore();
}

// 属性面板里的一行
function avatarRowHtml(it, row) {
    if (!canEdit(it) || it.kind !== 'token') return '';
    return row('头像', '<button class="tt-btn small" data-act="avatar" title="上传或从资产库选一张图，调整缩放和位置；可以同时设为角色卡头像">🖼 换头像 / 调整</button>');
}

var avatarEd = null; // { id, asset, circle, color, iz, ix, iy, el }

function openAvatarEditor(it) {
    if (!it || !canEdit(it)) return;
    closeAvatarEditor();
    var sh = it.sheet && sheets[it.sheet];
    avatarEd = { id: it.id, asset: it.asset || '', circle: it.asset ? !!it.circle : true, color: it.color || '#1e88e5',
        iz: it.iz != null ? num(it.iz, 1) : 1, ix: num(it.ix, 0), iy: num(it.iy, 0) };
    var el = document.createElement('div');
    el.className = 'roll-dialog ask-dialog avatar-dialog';
    el.innerHTML = '<div class="roll-box ask-box avatar-box"><div class="rd-who">🖼 ' + escapeHtml(it.label || '棋子') + ' 的头像</div>' +
        '<div class="avatar-main"><canvas id="avCanvas" width="240" height="240" title="拖动调整位置，滚轮缩放"></canvas>' +
        '<div class="avatar-side">' +
        '<button class="tt-btn small" data-av="upload">⬆ 上传图片</button><input type="file" id="avFile" accept="image/*" style="display:none;">' +
        '<button class="tt-btn small" data-av="pick">从资产库选</button>' +
        '<label class="avatar-line">缩放 <input type="range" id="avZoom" min="0.5" max="4" step="0.05" value="' + avatarEd.iz + '"></label>' +
        '<label class="avatar-line"><input type="radio" name="avShape" value="circle"' + (avatarEd.circle ? ' checked' : '') + '> 圆形</label>' +
        '<label class="avatar-line"><input type="radio" name="avShape" value="square"' + (avatarEd.circle ? '' : ' checked') + '> 方形</label>' +
        '<label class="avatar-line">边框 <input type="color" id="avColor" value="' + escapeHtml(avatarEd.color) + '"></label>' +
        '<button class="tt-btn small" data-av="reset" title="缩放回 1、居中">居中</button>' +
        '</div></div>' +
        '<div class="asset-grid avatar-pick" id="avPick" style="display:none;"></div>' +
        (sh && canEditSheet(sh) ? '<label class="avatar-line"><input type="checkbox" id="avSheet" checked> 同时设为角色卡「' + escapeHtml(sh.name) + '」的头像（以后放置都用它）</label>' : '') +
        (sh ? '<label class="avatar-line"><input type="checkbox" id="avAll" checked> 这个角色在地图上的其他棋子一起换</label>' : '') +
        '<div class="rd-btns"><span class="tt-hint">拖动图片调整位置，滚轮缩放</span><button class="tt-btn" data-av="cancel">取消</button><button class="tt-btn primary" data-av="save">保存</button></div></div>';
    document.body.appendChild(el);
    avatarEd.el = el;
    el.addEventListener('click', onAvatarClick);
    el.addEventListener('keydown', function(e) { e.stopPropagation(); if (e.key === 'Escape') closeAvatarEditor(); });
    $('avZoom').addEventListener('input', function() { avatarEd.iz = parseFloat(this.value) || 1; drawAvatarPreview(); });
    $('avColor').addEventListener('input', function() { avatarEd.color = this.value; drawAvatarPreview(); });
    el.querySelectorAll('[name=avShape]').forEach(function(r) { r.addEventListener('change', function() { avatarEd.circle = this.value === 'circle'; drawAvatarPreview(); }); });
    $('avFile').addEventListener('change', function() { avatarUpload(this); });
    var cv = $('avCanvas'), drag = null;
    cv.addEventListener('pointerdown', function(e) { drag = { x: e.clientX, y: e.clientY, ix: avatarEd.ix, iy: avatarEd.iy }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', function(e) {
        if (!drag) return;
        var s = avatarBox();
        avatarEd.ix = Math.max(-2, Math.min(2, drag.ix + (e.clientX - drag.x) / s));
        avatarEd.iy = Math.max(-2, Math.min(2, drag.iy + (e.clientY - drag.y) / s));
        drawAvatarPreview();
    });
    cv.addEventListener('pointerup', function() { drag = null; });
    cv.addEventListener('wheel', function(e) {
        e.preventDefault();
        avatarEd.iz = Math.max(0.5, Math.min(4, avatarEd.iz * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
        $('avZoom').value = avatarEd.iz;
        drawAvatarPreview();
    }, { passive: false });
    drawAvatarPreview();
}

function closeAvatarEditor() {
    if (avatarEd && avatarEd.el) avatarEd.el.remove();
    avatarEd = null;
}

function avatarBox() { return 180; } // 预览里棋子的边长（像素）

function drawAvatarPreview() {
    var cv = $('avCanvas');
    if (!cv || !avatarEd) return;
    var c = cv.getContext('2d'), S = avatarBox(), W = cv.width;
    c.clearRect(0, 0, W, W);
    c.fillStyle = '#2a2d35';
    c.fillRect(0, 0, W, W);
    var img = avatarEd.asset ? getImg(avatarEd.asset) : null;
    if (img && !imgReady(img)) img.addEventListener('load', drawAvatarPreview, { once: true });
    c.save();
    c.translate(W / 2, W / 2);
    if (img && imgReady(img)) { // 外面淡淡地画整张图，方便看裁掉了什么
        var iw = img.naturalWidth || S, ih = img.naturalHeight || S, k = Math.max(S / iw, S / ih) * avatarEd.iz;
        var dx = -iw * k / 2 + avatarEd.ix * S, dy = -ih * k / 2 + avatarEd.iy * S;
        c.globalAlpha = 0.3;
        c.drawImage(img, dx, dy, iw * k, ih * k);
        c.globalAlpha = 1;
        c.save();
        c.beginPath();
        if (avatarEd.circle) c.arc(0, 0, S / 2, 0, Math.PI * 2); else c.rect(-S / 2, -S / 2, S, S);
        c.clip();
        c.drawImage(img, dx, dy, iw * k, ih * k);
        c.restore();
    } else {
        c.fillStyle = avatarEd.color;
        c.beginPath();
        c.arc(0, 0, S / 2, 0, Math.PI * 2);
        c.fill();
    }
    c.beginPath();
    if (avatarEd.circle) c.arc(0, 0, S / 2, 0, Math.PI * 2); else c.rect(-S / 2, -S / 2, S, S);
    c.lineWidth = avatarEd.circle ? 6 : 2;
    c.strokeStyle = avatarEd.circle ? avatarEd.color : 'rgba(255,255,255,0.6)';
    c.stroke();
    c.restore();
}

function avatarUpload(input) {
    var file = input.files && input.files[0];
    input.value = '';
    if (!file || !avatarEd) return;
    notice('正在上传 ' + file.name + '…');
    uploadAsset(file, 'token').then(function(a) {
        if (!a || !avatarEd) return;
        if (!room.assets.some(function(x) { return x.id === a.id; })) room.assets.push(a);
        avatarEd.asset = a.id;
        avatarEd.iz = 1; avatarEd.ix = 0; avatarEd.iy = 0;
        $('avZoom').value = 1;
        drawAvatarPreview();
    }).catch(apiError);
}

function onAvatarClick(e) {
    var b = e.target.closest('[data-av]');
    if (!b || !avatarEd) return;
    switch (b.dataset.av) {
    case 'upload': $('avFile').click(); break;
    case 'pick':
        var grid = $('avPick');
        if (grid.style.display !== 'none') { grid.style.display = 'none'; break; }
        var list = (room.assets || []).filter(function(a) { return (a.kind || 'token') === 'token'; });
        grid.innerHTML = list.length ? list.map(function(a) {
            return '<div class="asset-card" data-av="use" data-id="' + escapeHtml(a.id) + '" title="' + escapeHtml(a.name || '') + '"><img src="' + escapeHtml(assetThumbURL(a.id)) + '" onerror="this.onerror=null;this.src=\'' + escapeHtml(assetURL(a.id)) + '\'" alt=""></div>';
        }).join('') : '<div class="tt-hint">资产库里还没有棋子图片，点「上传图片」</div>';
        grid.style.display = '';
        break;
    case 'use':
        avatarEd.asset = b.dataset.id;
        avatarEd.iz = 1; avatarEd.ix = 0; avatarEd.iy = 0;
        $('avZoom').value = 1;
        $('avPick').style.display = 'none';
        drawAvatarPreview();
        break;
    case 'reset':
        avatarEd.iz = 1; avatarEd.ix = 0; avatarEd.iy = 0;
        $('avZoom').value = 1;
        drawAvatarPreview();
        break;
    case 'cancel': closeAvatarEditor(); break;
    case 'save': avatarSave(); break;
    }
}

function avatarSave() {
    var ed = avatarEd, it = ed && scene.items[ed.id];
    if (!it) { closeAvatarEditor(); return; }
    var r2 = function(v) { return Math.round(v * 1000) / 1000; };
    var crop = { circle: ed.circle, color: ed.color, iz: r2(ed.iz), ix: r2(ed.ix), iy: r2(ed.iy) };
    var patch = function(id) { return Object.assign({ id: id, asset: ed.asset || null }, crop); };
    var sh = it.sheet && sheets[it.sheet];
    var ids = [it.id];
    if (sh && $('avAll') && $('avAll').checked) sortedItems().forEach(function(t) { if (t.kind === 'token' && t.sheet === sh.id && t.id !== it.id && canEdit(t)) ids.push(t.id); });
    patchItems(ids.map(patch));
    if (sh && $('avSheet') && $('avSheet').checked && canEditSheet(sh) && ed.asset) {
        op({ op: 'sheet', sheet: { id: sh.id, tokenImg: ed.asset, tokenCrop: crop } });
        sh.tokenImg = ed.asset; sh.tokenCrop = crop;
    }
    notice('头像已更新' + (ids.length > 1 ? '（' + ids.length + ' 个棋子）' : ''));
    closeAvatarEditor();
}

// 从角色卡放棋子：用卡上的头像和裁剪
function avatarApplySheet(sh, it) {
    if (!sh || !sh.tokenImg || it.asset !== sh.tokenImg || !sh.tokenCrop) return;
    var c = sh.tokenCrop;
    it.circle = !!c.circle;
    if (c.color) it.color = c.color;
    ['iz', 'ix', 'iy'].forEach(function(k) { if (c[k] != null) it[k] = num(c[k], k === 'iz' ? 1 : 0); });
}
