// 跑团桌面：画布渲染 + SSE 实时同步 + 骰子
// 坐标：世界坐标（地图像素）→ 屏幕坐标 = 世界 * view.s + (view.x, view.y)

var authToken = '';
var currentUser = null;
var nickname = localStorage.getItem('ttNickname') || '';

var roomId = '';
var es = null;
var me = { name: '', gm: false, color: '#fff' };
var room = { id: '', name: '', owner: '', active: '', scenes: [], assets: [] };
var scene = { id: '', name: '', props: {}, items: {} };
var logEntries = [];
var users = [];

var view = { x: 0, y: 0, s: 1 };
var tool = 'select';
var drawOpts = { shape: 'pen', color: '#e53935', width: 4, fill: false };
var fogOpts = { mode: 'cover', shape: 'rect' };
var wallOpts = { type: 'wall', mode: 'draw' };
var wallDraft = null;
var wallsVersion = 0;
var visCache = { key: '', polys: [] };
var explored = {}; // 场景 id → 已探索的视野多边形（仅本机内存）
var selected = {};
var gesture = null;
var polyDraft = null;
var cursorWorld = { x: 0, y: 0 };
var spaceDown = false;
var assetFilter = 'all';
var remote = { pointers: {}, rulers: {}, pings: [] };
var imgCache = {};
var canvas, ctx, fogCanvas, fctx, visCanvas, vctx, exCanvas, exCtx, dpr = 1;
var renderPending = false;
var fitPending = false;

var SWATCHES = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#ffffff', '#212121'];
var DICE = [4, 6, 8, 10, 12, 20, 100];

// ===== 通用 =====
function enc(s) { return encodeURIComponent(s); }
function num(v, def) { v = parseFloat(v); return isFinite(v) ? v : def; }
function isDoor() { return currentUser && currentUser.role === 'door'; }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function notice(msg, isError) {
    var n = $('notice');
    n.textContent = msg;
    n.className = 'tt-notice show' + (isError ? ' error' : '');
    clearTimeout(notice.timer);
    notice.timer = setTimeout(function() { n.className = 'tt-notice'; }, 3000);
}

function api(url, method, body) {
    var headers = {};
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
    var opts = { method: method, headers: headers };
    if (body) opts.body = body instanceof FormData ? body : JSON.stringify(body);
    return fetch(url, opts).then(function(r) {
        if (r.status === 401 && !url.endsWith('/api/me')) {
            handleAuthExpired();
            return Promise.reject('unauthorized');
        }
        return r.json().catch(function() { return {}; }).then(function(data) {
            if (!r.ok) return Promise.reject(data.error || ('请求失败 (' + r.status + ')'));
            return data;
        });
    });
}

function apiError(e) {
    if (e !== 'unauthorized') notice(typeof e === 'string' ? e : '网络错误', true);
    return null;
}

function op(body) {
    if (isDoor()) body.name = nickname;
    return api('/api/tabletop/op?room=' + enc(roomId), 'POST', body).catch(apiError);
}

// 物件更新队列：同一时间只有一个请求在途，未发送的补丁按 id 合并，保证顺序且自动节流
var itemQueue = { pending: {}, order: [], busy: false, inflight: {} };
function queueItems(patches) {
    patches.forEach(function(p) {
        var cur = itemQueue.pending[p.id];
        if (!cur) { cur = itemQueue.pending[p.id] = {}; itemQueue.order.push(p.id); }
        for (var k in p) cur[k] = p[k];
    });
    flushItems();
}
function flushItems() {
    if (itemQueue.busy || !itemQueue.order.length) return;
    var ids = itemQueue.order.splice(0, 400); // 服务器单次最多接受 500 个
    var items = ids.map(function(id) { var p = itemQueue.pending[id]; delete itemQueue.pending[id]; return p; });
    itemQueue.inflight = idSet(ids);
    itemQueue.busy = true;
    op({ op: 'items', items: items }).then(function(ok) {
        itemQueue.busy = false;
        itemQueue.inflight = {};
        if (!ok) connect(); // 被拒绝：重新连接以拿到服务器上的真实状态
        flushItems();
    });
}

var fxQueue = { list: [], busy: false };
function sendFx(fx) {
    var last = fxQueue.list[fxQueue.list.length - 1];
    if (last && last.t === fx.t && (fx.t === 'ptr' || fx.t === 'ruler')) fxQueue.list[fxQueue.list.length - 1] = fx;
    else fxQueue.list.push(fx);
    flushFx();
}
function flushFx() {
    if (fxQueue.busy || !fxQueue.list.length) return;
    var fx = fxQueue.list.shift();
    fxQueue.busy = true;
    op({ op: 'fx', fx: fx }).then(function() { fxQueue.busy = false; flushFx(); });
}

// ===== 鉴权 =====
function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === tab); });
    $('panelDoor').style.display = tab === 'door' ? '' : 'none';
    $('panelLogin').style.display = tab === 'login' ? '' : 'none';
    $('doorError').textContent = '';
    $('loginError').textContent = '';
}

function doDoorVerify() {
    var pw = $('doorPassword').value;
    $('doorError').textContent = '';
    if (!pw) { $('doorError').textContent = '请输入口令'; return; }
    fetch('/api/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
    }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.success) {
            authToken = data.token;
            currentUser = { username: '', role: 'door', user_id: 0 };
            onAuthSuccess();
        } else {
            $('doorError').textContent = data.error || '口令错误';
        }
    }).catch(function() { $('doorError').textContent = '连接服务器失败'; });
}

function doLogin() {
    var u = $('loginUsername').value.trim();
    var p = $('loginPassword').value;
    $('loginError').textContent = '';
    if (!u || !p) { $('loginError').textContent = '请填写用户名和密码'; return; }
    fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
    }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.success) {
            authToken = data.token;
            currentUser = { username: data.username, role: data.role, user_id: data.user_id };
            localStorage.setItem('authToken', authToken);
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            onAuthSuccess();
        } else {
            $('loginError').textContent = data.error || '登录失败';
        }
    }).catch(function() { $('loginError').textContent = '网络错误'; });
}

function handleAuthExpired() {
    authToken = '';
    currentUser = null;
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    if (es) { es.close(); es = null; }
    $('table').style.display = 'none';
    $('lobby').style.display = 'none';
    $('authOverlay').style.display = 'flex';
}

function doLogout() {
    handleAuthExpired();
    $('doorPassword').value = '';
}

function onAuthSuccess() {
    $('authOverlay').style.display = 'none';
    $('topBarUsername').textContent = isDoor() ? '访客' : currentUser.username;
    $('nickRow').style.display = isDoor() ? '' : 'none';
    $('createRow').style.display = isDoor() ? 'none' : '';
    $('nickInput').value = nickname;
    var q = new URLSearchParams(location.search).get('room');
    if (q && (!isDoor() || nickname)) enterRoom(q);
    else showLobby();
}

function initAuth() {
    var savedToken = localStorage.getItem('authToken');
    var savedUser = localStorage.getItem('currentUser');
    if (!savedToken || !savedUser) return;
    authToken = savedToken;
    try { currentUser = JSON.parse(savedUser); } catch (e) { currentUser = null; }
    if (!currentUser || currentUser.role === 'door') { handleAuthExpired(); return; }
    fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + authToken } })
        .then(function(r) { if (r.ok) return r.json(); throw new Error('invalid'); })
        .then(function(data) {
            if (data.role !== 'user' && data.role !== 'admin') throw new Error('invalid');
            currentUser = data;
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            onAuthSuccess();
        })
        .catch(function() { handleAuthExpired(); });
}

// ===== 大厅 =====
function showLobby() {
    $('table').style.display = 'none';
    $('lobby').style.display = 'flex';
    loadRooms();
}

function saveNickname() {
    nickname = $('nickInput').value.trim().slice(0, 16);
    localStorage.setItem('ttNickname', nickname);
}

function loadRooms() {
    api('/api/tabletop/rooms', 'GET').then(function(data) {
        var tbody = $('roomList');
        if (!data.rooms.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="tt-hint">还没有房间' + (data.can_create ? '，创建一个吧' : '，请让 GM 创建') + '</td></tr>';
            return;
        }
        var isAdmin = currentUser.role === 'admin';
        tbody.innerHTML = data.rooms.map(function(r) {
            var canDel = isAdmin || (!isDoor() && r.owner === currentUser.username);
            return '<tr>' +
                '<td>' + escapeHtml(r.name) + '</td>' +
                '<td>' + escapeHtml(r.owner) + '</td>' +
                '<td class="' + (r.online ? 'online' : '') + '">' + r.online + '</td>' +
                '<td>' + escapeHtml(r.updated_at) + '</td>' +
                '<td class="actions">' +
                '<button class="tt-btn primary small" data-join="' + escapeHtml(r.id) + '">进入</button> ' +
                (canDel ? '<button class="tt-btn danger small" data-del="' + escapeHtml(r.id) + '" data-name="' + escapeHtml(r.name) + '">删除</button>' : '') +
                '</td></tr>';
        }).join('');
    }).catch(apiError);
}

function createRoom() {
    var name = $('newRoomName').value.trim();
    if (!name) { notice('请输入房间名', true); return; }
    api('/api/tabletop/rooms', 'POST', { name: name }).then(function(data) {
        $('newRoomName').value = '';
        enterRoom(data.id);
    }).catch(apiError);
}

function deleteRoom(id, name) {
    if (!confirm('确定删除房间「' + name + '」？所有场景和记录将被永久删除（建议先导出备份）。')) return;
    api('/api/tabletop/rooms?id=' + enc(id), 'DELETE').then(loadRooms).catch(apiError);
}

function importRoom(input) {
    var file = input.files[0];
    input.value = '';
    if (!file) return;
    var fd = new FormData();
    fd.append('file', file);
    notice('正在导入...');
    api('/api/tabletop/import', 'POST', fd).then(function(data) {
        notice('导入成功');
        enterRoom(data.id);
    }).catch(apiError);
}

// ===== 进入 / 离开房间 =====
function enterRoom(id) {
    if (isDoor()) {
        saveNickname();
        if (!nickname) { showLobby(); notice('请先填写访客昵称', true); $('nickInput').focus(); return; }
    }
    roomId = id;
    history.replaceState(null, '', 'tabletop.html?room=' + enc(id));
    $('lobby').style.display = 'none';
    $('table').style.display = 'flex';
    scene = { id: '', name: '', props: {}, items: {} };
    selected = {};
    logEntries = [];
    $('logList').innerHTML = '';
    resizeCanvas();
    renderMacros();
    connect();
}

function leaveRoom() {
    if (es) { es.close(); es = null; }
    roomId = '';
    history.replaceState(null, '', 'tabletop.html');
    showLobby();
}

function copyRoomLink() {
    var link = location.origin + location.pathname + '?room=' + enc(roomId);
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(link).then(function() { notice('已复制邀请链接'); });
    } else {
        prompt('复制下面的邀请链接：', link);
    }
}

function connect() {
    if (es) es.close();
    var url = '/api/tabletop/events?room=' + enc(roomId) + '&token=' + enc(authToken) +
        (isDoor() ? '&name=' + enc(nickname) : '');
    var source = es = new EventSource(url);
    source.onopen = function() { $('connDot').classList.add('ok'); };
    source.onmessage = function(ev) {
        var m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        handleMsg(m);
    };
    source.onerror = function() {
        $('connDot').classList.remove('ok');
        if (source.readyState !== EventSource.CLOSED || es !== source) return;
        // 被服务器拒绝（令牌失效 / 房间不存在）时 EventSource 不会自动重连
        fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + authToken } }).then(function(r) {
            if (r.status === 401) { handleAuthExpired(); return; }
            return api('/api/tabletop/rooms', 'GET').then(function(data) {
                if (es !== source) return;
                var exists = data.rooms.some(function(r) { return r.id === roomId; });
                if (!exists) { notice('房间不存在或已被删除', true); leaveRoom(); return; }
                setTimeout(function() { if (es === source) connect(); }, 2000);
            });
        }).catch(function() {
            setTimeout(function() { if (es === source) connect(); }, 3000);
        });
    };
}

// ===== 消息处理 =====
function handleMsg(m) {
    switch (m.type) {
    case 'state':
        me = m.me;
        var newScene = m.scene.id !== scene.id;
        setRoomMeta(m.room);
        scene = { id: m.scene.id, name: m.scene.name, props: m.scene.props || {}, items: {} };
        m.scene.items.forEach(function(it) { scene.items[it.id] = it; });
        if (newScene) { selected = {}; gesture = null; polyDraft = null; wallDraft = null; fitPending = true; }
        wallsVersion++;
        onSheetsState(m.sheets || []);
        logEntries = m.log || [];
        renderLog();
        users = m.users || [];
        renderUsers();
        updateGmUi();
        onPropsChanged();
        renderSelPanel();
        break;
    case 'room':
        setRoomMeta(m.room);
        break;
    case 'props':
        scene.props = m.props;
        onPropsChanged();
        break;
    case 'items':
        m.items.forEach(function(it) {
            // 本地正在拖动或还有未确认的修改：忽略回显，避免棋子来回跳
            if (gesture && gesture.ids && gesture.ids[it.id]) return;
            if (itemQueue.pending[it.id] || itemQueue.inflight[it.id]) return;
            if (it.kind === 'wall') wallsVersion++;
            scene.items[it.id] = it;
        });
        renderSelPanel();
        requestRender();
        break;
    case 'del':
        m.ids.forEach(function(id) {
            if (scene.items[id] && scene.items[id].kind === 'wall') wallsVersion++;
            delete scene.items[id];
            delete selected[id];
        });
        renderSelPanel();
        requestRender();
        break;
    case 'sheets':
        m.sheets.forEach(function(sh) { sheets[sh.id] = sh; });
        renderSheets();
        break;
    case 'sheetdel':
        m.ids.forEach(function(id) { delete sheets[id]; });
        renderSheets();
        break;
    case 'log':
        logEntries.push(m.entry);
        if (logEntries.length > 300) logEntries.shift();
        appendLog(m.entry, true);
        break;
    case 'users':
        users = m.users;
        renderUsers();
        break;
    case 'fx':
        handleFx(m);
        break;
    case 'closed':
        notice('房间已被删除', true);
        leaveRoom();
        break;
    }
}

function setRoomMeta(r) {
    room = r;
    $('roomName').textContent = r.name;
    document.title = r.name + ' - 跑团桌面';
    var cur = r.scenes.filter(function(s) { return s.id === r.active; })[0];
    $('sceneName').textContent = cur ? '· ' + cur.name : '';
    if (cur) scene.name = cur.name;
    if (document.activeElement !== $('setRoomName')) $('setRoomName').value = r.name;
    renderAssets();
    renderScenes();
}

function renderUsers() {
    $('userList').innerHTML = users.map(function(u) {
        return '<span class="tt-user"><span class="dot" style="background:' + escapeHtml(u.color) + '"></span>' +
            escapeHtml(u.name) + (u.gm ? ' 👑' : '') + '</span>';
    }).join('');
}

function updateGmUi() {
    document.querySelectorAll('.gm-only').forEach(function(el) { el.style.display = me.gm ? '' : 'none'; });
    if (!me.gm && (tool === 'fog')) setTool('select');
    var activeTab = document.querySelector('.side-tab.active');
    if (activeTab && activeTab.style.display === 'none') switchPane('dice');
}

function handleFx(m) {
    var fx = m.fx, now = performance.now();
    if (fx.t === 'ptr') {
        var p = remote.pointers[m.from] || (remote.pointers[m.from] = { trail: [] });
        p.color = m.color;
        p.trail.push({ x: fx.x, y: fx.y, at: now });
        p.at = now;
    } else if (fx.t === 'ping') {
        remote.pings.push({ x: fx.x, y: fx.y, color: m.color, name: m.from, at: now });
    } else if (fx.t === 'ruler') {
        remote.rulers[m.from] = { a: fx.a, b: fx.b, color: m.color, at: now };
    } else if (fx.t === 'ruler-end') {
        delete remote.rulers[m.from];
    }
    requestRender();
}

// ===== 场景属性 =====
function gridSize() { return Math.max(4, num(scene.props.gridSize, 70)); }

function onPropsChanged() {
    var p = scene.props;
    if (!document.activeElement || !document.activeElement.id || document.activeElement.id.indexOf('set') !== 0) {
        $('setGridShow').checked = p.gridShow !== false;
        $('setGridSize').value = num(p.gridSize, 70);
        $('setGridOffX').value = num(p.gridOffX, 0);
        $('setGridOffY').value = num(p.gridOffY, 0);
        $('setGridColor').value = p.gridColor || '#000000';
        $('setGridAlpha').value = num(p.gridAlpha, 0.35);
        $('setGridScale').value = num(p.gridScale, 5);
        $('setGridUnit').value = p.gridUnit || 'ft';
        $('setMeasure').value = p.measure || 'chebyshev';
        $('setBg').value = p.bg || '#1b1d22';
        $('setVision').checked = !!p.vision;
        $('setCells').value = p.mapW ? Math.round(p.mapW / gridSize() * 100) / 100 : '';
    }
    $('mapInfo').textContent = p.mapAsset ? '当前地图：' + p.mapW + ' × ' + p.mapH + ' px，约 ' +
        Math.round(p.mapW / gridSize() * 10) / 10 + ' × ' + Math.round(p.mapH / gridSize() * 10) / 10 + ' 格' : '当前场景没有地图';
    if (fitPending && (!p.mapAsset || getImg(p.mapAsset).complete)) { fitPending = false; fitView(); }
    requestRender();
}

function setProps(props) {
    for (var k in props) {
        if (props[k] === null) delete scene.props[k]; else scene.props[k] = props[k];
    }
    onPropsChanged();
    op({ op: 'props', props: props });
}

function bindSettings() {
    function bind(id, key, conv) {
        $(id).addEventListener('change', function() {
            var v = conv(this);
            if (v === undefined) return;
            var o = {};
            o[key] = v;
            setProps(o);
        });
    }
    var number = function(el) { var v = parseFloat(el.value); return isFinite(v) ? v : undefined; };
    var text = function(el) { return el.value; };
    bind('setGridShow', 'gridShow', function(el) { return el.checked; });
    bind('setGridSize', 'gridSize', function(el) { var v = number(el); return v >= 4 ? v : undefined; });
    bind('setGridOffX', 'gridOffX', number);
    bind('setGridOffY', 'gridOffY', number);
    bind('setGridColor', 'gridColor', text);
    bind('setGridAlpha', 'gridAlpha', number);
    bind('setGridScale', 'gridScale', number);
    bind('setGridUnit', 'gridUnit', text);
    bind('setMeasure', 'measure', text);
    bind('setBg', 'bg', text);
    bind('setVision', 'vision', function(el) { return el.checked || null; });
    $('setCells').addEventListener('change', function() {
        var cells = parseFloat(this.value);
        if (!scene.props.mapW || !(cells >= 1)) return;
        setProps({ gridSize: scene.props.mapW / cells, gridOffX: 0, gridOffY: 0 });
    });
    $('setRoomName').addEventListener('change', function() {
        if (this.value.trim()) op({ op: 'room.rename', text: this.value.trim() });
    });
}

// ===== 图片 =====
function assetURL(id) { return '/tabletop-assets/' + enc(id) + '?token=' + enc(authToken); }

function getImg(id) {
    var img = imgCache[id];
    if (!img) {
        img = imgCache[id] = new Image();
        img.onload = function() {
            if (fitPending && scene.props.mapAsset === id) { fitPending = false; fitView(); }
            requestRender();
        };
        img.src = assetURL(id);
    }
    return img;
}

function imgReady(img) { return img && img.complete && img.naturalWidth > 0; }

function uploadAsset(file, kind) {
    var fd = new FormData();
    fd.append('file', file);
    var url = '/api/tabletop/upload?room=' + enc(roomId) + '&kind=' + kind + (isDoor() ? '&name=' + enc(nickname) : '');
    return api(url, 'POST', fd).then(function(data) { return data.asset; });
}

function loadImageSize(id) {
    return new Promise(function(resolve, reject) {
        var img = getImg(id);
        if (imgReady(img)) { resolve(img); return; }
        img.addEventListener('load', function() { resolve(img); });
        img.addEventListener('error', function() { reject('图片加载失败'); });
    });
}

// ===== 视图 =====
function resizeCanvas() {
    var stage = $('stage');
    var w = stage.clientWidth, h = stage.clientHeight;
    dpr = window.devicePixelRatio || 1;
    [canvas, fogCanvas].forEach(function(c) {
        c.width = Math.max(1, Math.round(w * dpr));
        c.height = Math.max(1, Math.round(h * dpr));
    });
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    requestRender();
}

function toWorld(sx, sy) { return { x: (sx - view.x) / view.s, y: (sy - view.y) / view.s }; }
function toScreen(wx, wy) { return { x: wx * view.s + view.x, y: wy * view.s + view.y }; }

function eventPos(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function zoomAt(sx, sy, factor) {
    var s = Math.min(8, Math.max(0.05, view.s * factor));
    var w = toWorld(sx, sy);
    view.s = s;
    view.x = sx - w.x * s;
    view.y = sy - w.y * s;
    $('zoomLabel').textContent = Math.round(s * 100) + '%';
    requestRender();
}

function zoomBy(factor) {
    zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor);
}

function fitView() {
    var p = scene.props, b = null;
    if (p.mapAsset && p.mapW) {
        b = { x0: 0, y0: 0, x1: p.mapW, y1: p.mapH };
    } else {
        Object.keys(scene.items).forEach(function(id) {
            var bb = itemBBox(scene.items[id]);
            if (!b) b = { x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 };
            else { b.x0 = Math.min(b.x0, bb.x0); b.y0 = Math.min(b.y0, bb.y0); b.x1 = Math.max(b.x1, bb.x1); b.y1 = Math.max(b.y1, bb.y1); }
        });
    }
    var W = canvas.clientWidth, H = canvas.clientHeight;
    if (!b || W < 10) { view = { x: W / 2, y: H / 2, s: 1 }; }
    else {
        var bw = Math.max(b.x1 - b.x0, gridSize() * 4), bh = Math.max(b.y1 - b.y0, gridSize() * 4);
        var s = Math.min(8, Math.max(0.05, Math.min((W - 40) / bw, (H - 40) / bh)));
        view.s = s;
        view.x = W / 2 - (b.x0 + b.x1) / 2 * s;
        view.y = H / 2 - (b.y0 + b.y1) / 2 * s;
    }
    $('zoomLabel').textContent = Math.round(view.s * 100) + '%';
    requestRender();
}

// ===== 网格 / 测距 =====
function snapToGrid(x, y, step) {
    var p = scene.props, ox = num(p.gridOffX, 0), oy = num(p.gridOffY, 0);
    step = step || gridSize();
    return { x: Math.round((x - ox) / step) * step + ox, y: Math.round((y - oy) / step) * step + oy };
}

function cellCenter(x, y) {
    var p = scene.props, g = gridSize(), ox = num(p.gridOffX, 0), oy = num(p.gridOffY, 0);
    return { x: Math.floor((x - ox) / g) * g + ox + g / 2, y: Math.floor((y - oy) / g) * g + oy + g / 2 };
}

function measureText(ax, ay, bx, by) {
    var p = scene.props, g = gridSize();
    var dx = Math.abs(bx - ax) / g, dy = Math.abs(by - ay) / g, d;
    if (p.measure === 'euclidean') d = Math.sqrt(dx * dx + dy * dy);
    else if (p.measure === 'alternating') d = Math.max(dx, dy) + Math.floor(Math.min(dx, dy) / 2);
    else d = Math.max(dx, dy);
    return fmtDist(d * num(p.gridScale, 5));
}

function fmtDist(v) {
    return (Math.round(v * 10) / 10) + ' ' + (scene.props.gridUnit || 'ft');
}

function distText(len) { return fmtDist(len / gridSize() * num(scene.props.gridScale, 5)); }

// ===== 物件 =====
function sortedItems() {
    var list = [];
    for (var id in scene.items) list.push(scene.items[id]);
    list.sort(function(a, b) { return (a.z || 0) - (b.z || 0); });
    return list;
}

function nextZ() {
    var z = 0;
    for (var id in scene.items) z = Math.max(z, scene.items[id].z || 0);
    return z + 1;
}

function canEdit(it) { return me.gm || (it.owner && it.owner === me.name); }
function canMove(it) {
    if (me.gm) return !it.locked;
    return canEdit(it) || (it.kind === 'token' && !it.locked);
}

function itemBBox(it) {
    var x = it.x || 0, y = it.y || 0;
    if (it.kind === 'token') return { x0: x, y0: y, x1: x + (it.w || gridSize()), y1: y + (it.h || gridSize()) };
    if (it.shape === 'circle') { var r = it.r || 0; return { x0: x - r, y0: y - r, x1: x + r, y1: y + r }; }
    var pts = shapePoints(it), b = { x0: x, y0: y, x1: x, y1: y };
    pts.forEach(function(p) {
        b.x0 = Math.min(b.x0, x + p[0]); b.y0 = Math.min(b.y0, y + p[1]);
        b.x1 = Math.max(b.x1, x + p[0]); b.y1 = Math.max(b.y1, y + p[1]);
    });
    var pad = it.shape === 'brush' || it.kind === 'draw' ? (it.width || 0) / 2 : 0;
    b.x0 -= pad; b.y0 -= pad; b.x1 += pad; b.y1 += pad;
    return b;
}

// 形状轮廓点（相对 x,y）：锥形为三角形顶点
function shapePoints(it) {
    var pts = it.points || [];
    if (it.shape === 'cone' && pts[0]) {
        var dx = pts[0][0], dy = pts[0][1], len = Math.sqrt(dx * dx + dy * dy) || 1;
        var nx = -dy / len * len / 2, ny = dx / len * len / 2;
        return [[0, 0], [dx + nx, dy + ny], [dx - nx, dy - ny]];
    }
    if (it.shape === 'rect' && pts[1]) return [[0, 0], [pts[1][0], 0], pts[1], [0, pts[1][1]]];
    return pts;
}

function distToSeg(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    var t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
    var cx = ax + t * dx - px, cy = ay + t * dy - py;
    return Math.sqrt(cx * cx + cy * cy);
}

function pointInPoly(x, y, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function hitItem(it, w) {
    var tol = 6 / view.s;
    var lx = w.x - (it.x || 0), ly = w.y - (it.y || 0);
    if (it.kind === 'token') {
        var b = itemBBox(it);
        return w.x >= b.x0 && w.x <= b.x1 && w.y >= b.y0 && w.y <= b.y1;
    }
    if (it.shape === 'circle') {
        var d = Math.sqrt(lx * lx + ly * ly), r = it.r || 0;
        return it.fill || it.kind === 'fog' ? d <= r + tol : Math.abs(d - r) <= tol + (it.width || 0) / 2;
    }
    var pts = shapePoints(it);
    var closed = it.shape === 'rect' || it.shape === 'cone' || it.shape === 'poly';
    if (closed && (it.fill || it.kind === 'fog') && pointInPoly(lx, ly, pts)) return true;
    var half = (it.width || 0) / 2 + tol;
    for (var i = 1; i < pts.length; i++) {
        if (distToSeg(lx, ly, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= half) return true;
    }
    if (closed && pts.length > 2 && distToSeg(lx, ly, pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]) <= half) return true;
    return pts.length === 1 && Math.sqrt(lx * lx + ly * ly) <= half;
}

// 命中测试：棋子优先，其次绘制；迷雾仅在迷雾选择模式下
function hitTest(w, kinds) {
    var list = sortedItems().reverse();
    for (var k = 0; k < kinds.length; k++) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].kind === kinds[k] && hitItem(list[i], w)) return list[i];
        }
    }
    return null;
}

function selectedIds() { return Object.keys(selected).filter(function(id) { return scene.items[id]; }); }

function selectOnly(ids) {
    selected = {};
    ids.forEach(function(id) { selected[id] = true; });
    renderSelPanel();
    requestRender();
}

function patchItems(patches) {
    wallsVersion++;
    patches.forEach(function(p) {
        var it = scene.items[p.id];
        if (!it) return;
        for (var k in p) { if (p[k] === null) delete it[k]; else it[k] = p[k]; }
    });
    queueItems(patches);
    requestRender();
}

function createItems(items) {
    wallsVersion++;
    items.forEach(function(it) {
        if (!me.gm) it.owner = me.name;
        scene.items[it.id] = it;
    });
    queueItems(items);
    requestRender();
}

function deleteItems(ids) {
    ids = ids.filter(function(id) { return scene.items[id] && canEdit(scene.items[id]); });
    if (!ids.length) return;
    wallsVersion++;
    ids.forEach(function(id) { delete scene.items[id]; delete selected[id]; });
    op({ op: 'delete', ids: ids });
    renderSelPanel();
    requestRender();
}

function duplicateSelected() {
    var g = gridSize(), copies = [];
    selectedIds().forEach(function(id) {
        var src = scene.items[id];
        if (!canEdit(src)) return;
        var c = JSON.parse(JSON.stringify(src));
        c.id = genId();
        c.x = (c.x || 0) + g;
        c.y = (c.y || 0) + g;
        c.z = nextZ() + copies.length;
        delete c.owner;
        copies.push(c);
    });
    if (!copies.length) return;
    createItems(copies);
    selectOnly(copies.map(function(c) { return c.id; }));
}

function placeToken(asset, wx, wy) {
    var g = gridSize();
    loadImageSize(asset.id).catch(function() { return null; }).then(function(img) {
        var w = g, h = g;
        if (img) {
            var ratio = img.naturalHeight / img.naturalWidth;
            if (ratio > 1) w = g / ratio; else h = g * ratio;
        }
        var pos = snapToGrid(wx - g / 2, wy - g / 2);
        var it = { id: genId(), kind: 'token', x: pos.x + (g - w) / 2, y: pos.y + (g - h) / 2, w: w, h: h,
            asset: asset.id, label: asset.name, z: nextZ() };
        createItems([it]);
        setTool('select');
        selectOnly([it.id]);
    });
}

function addMarker() {
    var g = gridSize(), c = toWorld(canvas.clientWidth / 2, canvas.clientHeight / 2);
    var pos = snapToGrid(c.x - g / 2, c.y - g / 2);
    var it = { id: genId(), kind: 'token', x: pos.x, y: pos.y, w: g, h: g, circle: true,
        color: SWATCHES[Math.floor(Math.random() * 6)], label: '标记', z: nextZ() };
    createItems([it]);
    setTool('select');
    selectOnly([it.id]);
}

function clearDrawings() {
    var ids = sortedItems().filter(function(it) { return it.kind === 'draw' && canEdit(it); }).map(function(it) { return it.id; });
    if (!ids.length) return;
    if (!confirm(me.gm ? '删除本场景的全部绘制？' : '删除你画的全部内容？')) return;
    deleteItems(ids);
}

function fogCoverAll() {
    var p = scene.props, g = gridSize(), b;
    if (p.mapAsset && p.mapW) b = { x: 0, y: 0, w: p.mapW, h: p.mapH };
    else { var c = toWorld(0, 0), d = toWorld(canvas.clientWidth, canvas.clientHeight); b = { x: c.x - g * 20, y: c.y - g * 20, w: d.x - c.x + g * 40, h: d.y - c.y + g * 40 }; }
    createItems([{ id: genId(), kind: 'fog', shape: 'rect', x: b.x, y: b.y, points: [[0, 0], [b.w, b.h]], z: nextZ() }]);
}

function fogClearAll() {
    var ids = sortedItems().filter(function(it) { return it.kind === 'fog'; }).map(function(it) { return it.id; });
    if (!ids.length) return;
    if (!confirm('清除本场景的全部迷雾？')) return;
    deleteItems(ids);
}

// ===== 渲染 =====
function requestRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(render);
}

function applyView(c) { c.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.x, dpr * view.y); }

function render() {
    renderPending = false;
    if (!canvas || $('table').style.display === 'none') return;
    var p = scene.props;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = p.bg || '#1b1d22';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    applyView(ctx);

    if (p.mapAsset) {
        var img = getImg(p.mapAsset);
        if (imgReady(img)) ctx.drawImage(img, 0, 0, p.mapW || img.naturalWidth, p.mapH || img.naturalHeight);
    }
    drawGrid();

    var items = sortedItems();
    items.forEach(function(it) { if (it.kind === 'draw') drawShape(ctx, it); });
    var vision = visionActive() ? computeVision() : null;
    items.forEach(function(it) {
        if (it.kind !== 'token') return;
        // 动态视野下，不在视野内的他人棋子不绘制（避免在已探索的昏暗区域看到敌人）
        if (vision && it.owner !== me.name && !pointVisible(it.x + (it.w || gridSize()) / 2, it.y + (it.h || gridSize()) / 2, vision)) return;
        drawToken(it);
    });
    if (!me.gm) drawWalls(items, false);
    drawFog(items);
    if (vision) drawVision(vision);
    if (me.gm) drawWalls(items, true);
    drawOverlays();

    var animating = remote.pings.length || Object.keys(remote.pointers).length || Object.keys(remote.rulers).length;
    if (animating) requestRender();
}

function drawGrid() {
    var p = scene.props;
    if (p.gridShow === false) return;
    var g = gridSize();
    if (g * view.s < 5) return;
    var ox = num(p.gridOffX, 0), oy = num(p.gridOffY, 0);
    var a = toWorld(0, 0), b = toWorld(canvas.clientWidth, canvas.clientHeight);
    var x0 = a.x, y0 = a.y, x1 = b.x, y1 = b.y;
    if (p.mapAsset && p.mapW) {
        x0 = Math.max(x0, 0); y0 = Math.max(y0, 0);
        x1 = Math.min(x1, p.mapW); y1 = Math.min(y1, p.mapH);
        if (x0 >= x1 || y0 >= y1) return;
    }
    ctx.beginPath();
    for (var x = Math.ceil((x0 - ox) / g) * g + ox; x <= x1; x += g) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (var y = Math.ceil((y0 - oy) / g) * g + oy; y <= y1; y += g) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.strokeStyle = p.gridColor || '#000';
    ctx.globalAlpha = num(p.gridAlpha, 0.35);
    ctx.lineWidth = 1 / view.s;
    ctx.stroke();
    ctx.globalAlpha = 1;
}

function tracePath(c, it) {
    var pts = shapePoints(it);
    c.beginPath();
    if (it.shape === 'circle') { c.arc(0, 0, it.r || 0, 0, Math.PI * 2); return true; }
    pts.forEach(function(p, i) { if (i) c.lineTo(p[0], p[1]); else c.moveTo(p[0], p[1]); });
    var closed = it.shape === 'rect' || it.shape === 'cone' || it.shape === 'poly';
    if (closed) c.closePath();
    return closed;
}

function drawShape(c, it) {
    var color = it.color || '#e53935';
    c.save();
    c.translate(it.x || 0, it.y || 0);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = it.width || 4;
    c.strokeStyle = color;
    var pts = it.points || [];
    if ((it.shape === 'pen' || it.shape === 'line') && pts.length === 1) {
        c.beginPath();
        c.arc(pts[0][0], pts[0][1], (it.width || 4) / 2, 0, Math.PI * 2);
        c.fillStyle = color;
        c.fill();
    } else {
        var closed = tracePath(c, it);
        if (closed && it.fill) {
            c.fillStyle = color;
            c.globalAlpha = 0.3;
            c.fill();
            c.globalAlpha = 1;
        }
        c.stroke();
    }
    c.restore();
}

function drawToken(it) {
    var g = gridSize(), w = it.w || g, h = it.h || g;
    var img = it.asset ? getImg(it.asset) : null;
    ctx.save();
    if (it.hidden) ctx.globalAlpha = 0.45;
    ctx.translate((it.x || 0) + w / 2, (it.y || 0) + h / 2);
    if (it.rot) ctx.rotate(it.rot * Math.PI / 180);
    var r = Math.min(w, h) / 2;
    if (it.circle || !img) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        if (!img || !imgReady(img)) {
            ctx.fillStyle = it.color || '#607d8b';
            ctx.fill();
            if (!img) {
                ctx.fillStyle = '#fff';
                ctx.font = 'bold ' + (r * 0.9) + 'px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText((it.label || '?').slice(0, 1), 0, r * 0.05);
            }
        }
        ctx.clip();
        if (imgReady(img)) ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.restore();
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(2 / view.s, r * 0.08);
        ctx.strokeStyle = it.circle && it.color ? it.color : 'rgba(255,255,255,0.85)';
        ctx.stroke();
    } else if (imgReady(img)) {
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
    }
    ctx.restore();

    var x = it.x || 0, y = it.y || 0;
    if (it.hpMax > 0) {
        var ratio = Math.max(0, Math.min(1, (it.hp || 0) / it.hpMax));
        var bh = Math.max(4 / view.s, h * 0.08), by = y - bh - 2 / view.s;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(x, by, w, bh);
        ctx.fillStyle = ratio > 0.5 ? '#43a047' : ratio > 0.25 ? '#fb8c00' : '#e53935';
        ctx.fillRect(x, by, w * ratio, bh);
    }
    if (it.label) drawLabel(it.label, x + w / 2, y + h, it.hidden ? '#ba68c8' : '#fff', true);
    if (it.hidden) {
        ctx.save();
        ctx.setLineDash([6 / view.s, 4 / view.s]);
        ctx.strokeStyle = '#ba68c8';
        ctx.lineWidth = 2 / view.s;
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
    }
}

// 屏幕尺寸固定的文字标签；below=true 时画在点的下方
function drawLabel(text, wx, wy, color, below) {
    var s = toScreen(wx, wy);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '12px sans-serif';
    var tw = ctx.measureText(text).width + 10;
    var ty = below ? s.y + 3 : s.y - 22;
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    roundRect(ctx, s.x - tw / 2, ty, tw, 18, 5);
    ctx.fill();
    ctx.fillStyle = color || '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, s.x, ty + 9.5);
    ctx.restore();
}

function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
}

function fogShape(c, it) {
    c.save();
    c.translate(it.x || 0, it.y || 0);
    if (it.shape === 'brush') {
        var pts = it.points || [];
        c.lineCap = 'round';
        c.lineJoin = 'round';
        c.lineWidth = it.width || gridSize();
        c.beginPath();
        pts.forEach(function(p, i) { if (i) c.lineTo(p[0], p[1]); else c.moveTo(p[0], p[1]); });
        if (pts.length === 1) c.lineTo(pts[0][0] + 0.01, pts[0][1]);
        c.stroke();
    } else {
        tracePath(c, it);
        c.fill();
    }
    c.restore();
}

function drawFog(items) {
    var fogs = items.filter(function(it) { return it.kind === 'fog'; });
    var preview = gesture && gesture.type === 'fog' ? gesture.item : null;
    if (!fogs.length && !preview) return;
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, fogCanvas.width, fogCanvas.height);
    applyView(fctx);
    fctx.fillStyle = fctx.strokeStyle = '#0a0b0e';
    fogs.concat(preview ? [preview] : []).forEach(function(it) {
        fctx.globalCompositeOperation = it.cut ? 'destination-out' : 'source-over';
        fogShape(fctx, it);
    });
    fctx.globalCompositeOperation = 'source-over';

    var playerView = !me.gm || $('fogPreview').checked;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = playerView ? 1 : 0.55;
    ctx.drawImage(fogCanvas, 0, 0);
    ctx.restore();
    applyView(ctx);

    if (me.gm && tool === 'fog') {
        ctx.save();
        ctx.setLineDash([6 / view.s, 4 / view.s]);
        ctx.lineWidth = 1.5 / view.s;
        fogs.forEach(function(it) {
            if (it.shape === 'brush') return;
            ctx.strokeStyle = it.cut ? 'rgba(129,199,132,0.8)' : 'rgba(144,202,249,0.8)';
            ctx.save();
            ctx.translate(it.x || 0, it.y || 0);
            tracePath(ctx, it);
            ctx.stroke();
            ctx.restore();
        });
        ctx.restore();
    }
}

function drawOverlays() {
    var g = gridSize();
    // 选中框
    var ids = selectedIds();
    ids.forEach(function(id) {
        var it = scene.items[id], b = itemBBox(it), pad = 3 / view.s;
        ctx.save();
        ctx.setLineDash([5 / view.s, 3 / view.s]);
        ctx.lineWidth = 1.5 / view.s;
        ctx.strokeStyle = '#42a5f5';
        ctx.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2);
        ctx.restore();
    });
    var handle = resizeHandle();
    if (handle) {
        ctx.fillStyle = '#42a5f5';
        ctx.fillRect(handle.x - handle.r, handle.y - handle.r, handle.r * 2, handle.r * 2);
    }

    if (gesture) {
        if (gesture.type === 'marquee') {
            var m = gesture;
            ctx.save();
            ctx.fillStyle = 'rgba(66,165,245,0.12)';
            ctx.strokeStyle = '#42a5f5';
            ctx.lineWidth = 1 / view.s;
            var rx = Math.min(m.a.x, m.b.x), ry = Math.min(m.a.y, m.b.y), rw = Math.abs(m.b.x - m.a.x), rh = Math.abs(m.b.y - m.a.y);
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeRect(rx, ry, rw, rh);
            ctx.restore();
        } else if (gesture.type === 'draw') {
            var it = gesture.item;
            drawShape(ctx, it);
            var pts = it.points || [];
            if (it.shape === 'circle' && it.r) drawLabel('半径 ' + distText(it.r), it.x, it.y - it.r, '#fff');
            else if ((it.shape === 'line' || it.shape === 'cone') && pts.length) {
                var end = pts[pts.length - 1];
                drawLabel(distText(Math.sqrt(end[0] * end[0] + end[1] * end[1])), it.x + end[0], it.y + end[1], '#fff');
            } else if (it.shape === 'rect' && pts[1]) {
                drawLabel(distText(Math.abs(pts[1][0])) + ' × ' + distText(Math.abs(pts[1][1])), it.x + pts[1][0], it.y + pts[1][1], '#fff');
            }
        } else if (gesture.type === 'ruler') {
            drawRuler(gesture.a, gesture.b, me.color, '');
        } else if (gesture.type === 'resize') {
            var t = scene.items[gesture.id];
            if (t) drawLabel(Math.round((t.w || g) / g * 10) / 10 + ' 格', t.x + (t.w || g) / 2, t.y, '#fff');
        }
    }

    // 多边形迷雾草稿
    if (polyDraft) {
        ctx.save();
        ctx.strokeStyle = polyDraft.cut ? '#81c784' : '#90caf9';
        ctx.lineWidth = 2 / view.s;
        ctx.beginPath();
        polyDraft.points.forEach(function(p, i) { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
        ctx.lineTo(cursorWorld.x, cursorWorld.y);
        ctx.stroke();
        polyDraft.points.forEach(function(p) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4 / view.s, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
        });
        ctx.restore();
    }

    // 其他玩家的尺子 / 指针 / 标记
    var now = performance.now();
    for (var name in remote.rulers) {
        var rr = remote.rulers[name];
        if (now - rr.at > 5000) { delete remote.rulers[name]; continue; }
        drawRuler({ x: rr.a[0], y: rr.a[1] }, { x: rr.b[0], y: rr.b[1] }, rr.color, name);
    }
    for (var pn in remote.pointers) {
        var pt = remote.pointers[pn];
        pt.trail = pt.trail.filter(function(q) { return now - q.at < 800; });
        if (!pt.trail.length) { delete remote.pointers[pn]; continue; }
        drawTrail(pt.trail, pt.color, now);
        var last = pt.trail[pt.trail.length - 1];
        drawLabel(pn, last.x, last.y, pt.color);
    }
    remote.pings = remote.pings.filter(function(pg) { return now - pg.at < 1500; });
    remote.pings.forEach(function(pg) {
        var t = (now - pg.at) / 1500;
        ctx.save();
        ctx.globalAlpha = 1 - t;
        ctx.strokeStyle = pg.color;
        ctx.lineWidth = 3 / view.s;
        for (var k = 0; k < 2; k++) {
            var tt = (t + k * 0.3) % 1;
            ctx.beginPath();
            ctx.arc(pg.x, pg.y, (10 + tt * 50) / view.s, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();
        if (pg.name) drawLabel(pg.name, pg.x, pg.y + 14 / view.s, pg.color, true);
    });
    if (localTrail.length) {
        localTrail = localTrail.filter(function(q) { return now - q.at < 800; });
        drawTrail(localTrail, me.color, now);
        if (localTrail.length) requestRender();
    }
}

var localTrail = [];
function drawTrail(trail, color, now) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    for (var i = 1; i < trail.length; i++) {
        ctx.globalAlpha = Math.max(0, 1 - (now - trail[i].at) / 800);
        ctx.lineWidth = 4 / view.s;
        ctx.beginPath();
        ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
        ctx.lineTo(trail[i].x, trail[i].y);
        ctx.stroke();
    }
    var last = trail[trail.length - 1];
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(last.x, last.y, 6 / view.s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawRuler(a, b, color, who) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3 / view.s;
    ctx.setLineDash([10 / view.s, 6 / view.s]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    [a, b].forEach(function(p) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 / view.s, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
    });
    ctx.restore();
    drawLabel((who ? who + '：' : '') + measureText(a.x, a.y, b.x, b.y), b.x, b.y, color);
}

function resizeHandle() {
    var ids = selectedIds();
    if (ids.length !== 1 || tool !== 'select') return null;
    var it = scene.items[ids[0]];
    if (it.kind !== 'token' || !canEdit(it) || it.locked) return null;
    var b = itemBBox(it);
    return { x: b.x1, y: b.y1, r: 5 / view.s, id: it.id };
}

// ===== 墙体 / 门窗 / 动态视野 =====
// 墙体物件：{ kind:'wall', wtype:'wall'|'window'|'door', x, y, points:[[dx,dy]...], open }
// 墙挡视线和移动；窗挡移动不挡视线；门关着时同墙，打开后都不挡
var WALL_STYLE = {
    wall: { color: '#ff9800', name: '墙' },
    window: { color: '#4fc3f7', name: '窗' },
    door: { color: '#a1887f', name: '门' }
};

function wallSegments(forMove) {
    var segs = [];
    for (var id in scene.items) {
        var w = scene.items[id];
        if (w.kind !== 'wall') continue;
        if (w.wtype === 'door' && w.open) continue;
        if (w.wtype === 'window' && !forMove) continue;
        var pts = w.points || [], x = w.x || 0, y = w.y || 0;
        for (var i = 1; i < pts.length; i++) segs.push([x + pts[i - 1][0], y + pts[i - 1][1], x + pts[i][0], y + pts[i][1]]);
    }
    return segs;
}

function segmentsCross(ax, ay, bx, by, s) {
    var d1x = bx - ax, d1y = by - ay, d2x = s[2] - s[0], d2y = s[3] - s[1];
    var den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-9) return false;
    var t = ((s[0] - ax) * d2y - (s[1] - ay) * d2x) / den;
    var u = ((s[0] - ax) * d1y - (s[1] - ay) * d1x) / den;
    return t > 0.001 && t < 0.999 && u >= 0 && u <= 1;
}

function moveBlocked(ax, ay, bx, by) {
    return wallSegments(true).some(function(s) { return segmentsCross(ax, ay, bx, by, s); });
}

// 射线与线段求交，返回射线参数 t（无交点返回 -1）
function raySeg(ox, oy, dx, dy, s) {
    var sx = s[2] - s[0], sy = s[3] - s[1];
    var den = dx * sy - dy * sx;
    if (Math.abs(den) < 1e-12) return -1;
    var t = ((s[0] - ox) * sy - (s[1] - oy) * sx) / den;
    var u = ((s[0] - ox) * dy - (s[1] - oy) * dx) / den;
    return t >= 0 && u >= -1e-9 && u <= 1 + 1e-9 ? t : -1;
}

// 经典扫描法：向所有线段端点（及其两侧微小偏移）发射线，取最近交点连成可见多边形
function visibilityPolygon(ox, oy, segs, b) {
    var all = segs.concat([[b.x0, b.y0, b.x1, b.y0], [b.x1, b.y0, b.x1, b.y1], [b.x1, b.y1, b.x0, b.y1], [b.x0, b.y1, b.x0, b.y0]]);
    var seen = {}, angles = [];
    all.forEach(function(s) {
        [[s[0], s[1]], [s[2], s[3]]].forEach(function(p) {
            var a = Math.atan2(p[1] - oy, p[0] - ox), k = a.toFixed(5);
            if (seen[k]) return;
            seen[k] = true;
            angles.push(a - 0.00005, a, a + 0.00005);
        });
    });
    angles.sort(function(a, b) { return a - b; });
    var pts = [];
    angles.forEach(function(a) {
        var dx = Math.cos(a), dy = Math.sin(a), best = Infinity;
        for (var i = 0; i < all.length; i++) {
            var t = raySeg(ox, oy, dx, dy, all[i]);
            if (t >= 0 && t < best) best = t;
        }
        if (best < Infinity) pts.push([ox + dx * best, oy + dy * best]);
    });
    return pts;
}

function visionActive() {
    return !!scene.props.vision && (!me.gm || $('fogPreview').checked);
}

// 视野来源：GM 预览时用选中的棋子；玩家用自己控制的棋子，没有则用全队（有控制者 / 关联 PC 卡的棋子）
function visionViewers() {
    var toks = sortedItems().filter(function(t) { return t.kind === 'token' && !t.hidden; });
    if (me.gm) {
        var sel = toks.filter(function(t) { return selected[t.id]; });
        if (sel.length) return sel;
    }
    var mine = toks.filter(function(t) { return t.owner && t.owner === me.name; });
    if (mine.length) return mine;
    var owned = toks.filter(function(t) { return t.owner; });
    if (owned.length) return owned;
    return toks.filter(function(t) { return t.sheet && sheets[t.sheet] && sheets[t.sheet].kind === 'pc'; });
}

function computeVision() {
    var g = gridSize(), p = scene.props;
    var viewers = visionViewers();
    var key = wallsVersion + '|' + (p.mapW || 0) + '|' + viewers.map(function(t) {
        return t.id + ',' + Math.round(t.x) + ',' + Math.round(t.y) + ',' + (t.sight || 0);
    }).join(';');
    if (key === visCache.key) return visCache.polys;

    var b;
    if (p.mapAsset && p.mapW) b = { x0: -g, y0: -g, x1: p.mapW + g, y1: p.mapH + g };
    else b = { x0: -20000, y0: -20000, x1: 20000, y1: 20000 };
    var segs = wallSegments(false);
    var polys = viewers.map(function(t) {
        var cx = t.x + (t.w || g) / 2, cy = t.y + (t.h || g) / 2;
        var r = t.sight > 0 ? t.sight / num(p.gridScale, 5) * g : 0;
        return { x: cx, y: cy, r: r, pts: visibilityPolygon(cx, cy, segs, b) };
    });
    visCache = { key: key, polys: polys };
    if (!gesture) { // 拖动途中不记录，避免探索记录被大量中间状态挤满
        var ex = explored[scene.id] || (explored[scene.id] = []);
        polys.forEach(function(poly) { ex.push(poly); });
        if (ex.length > 300) ex.splice(0, ex.length - 300);
    }
    return polys;
}

function pointVisible(x, y, polys) {
    return polys.some(function(p) {
        if (p.r && Math.hypot(x - p.x, y - p.y) > p.r) return false;
        return pointInPoly(x, y, p.pts);
    });
}

function fillVis(c, p) {
    c.save();
    if (p.r) { c.beginPath(); c.arc(p.x, p.y, p.r, 0, Math.PI * 2); c.clip(); }
    c.beginPath();
    p.pts.forEach(function(q, i) { if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); });
    c.closePath();
    c.fill();
    c.restore();
}

// 黑暗层：全黑 → 已探索区域减为半暗 → 当前视野完全透明
function drawVision(polys) {
    [visCanvas, exCanvas].forEach(function(c) {
        if (c.width !== canvas.width || c.height !== canvas.height) { c.width = canvas.width; c.height = canvas.height; }
    });
    exCtx.setTransform(1, 0, 0, 1, 0, 0);
    exCtx.clearRect(0, 0, exCanvas.width, exCanvas.height);
    applyView(exCtx);
    exCtx.fillStyle = '#000';
    (explored[scene.id] || []).forEach(function(p) { fillVis(exCtx, p); });

    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.globalCompositeOperation = 'source-over';
    vctx.globalAlpha = 1;
    vctx.fillStyle = '#050608';
    vctx.fillRect(0, 0, visCanvas.width, visCanvas.height);
    vctx.globalCompositeOperation = 'destination-out';
    vctx.globalAlpha = 0.45;
    vctx.drawImage(exCanvas, 0, 0);
    vctx.globalAlpha = 1;
    applyView(vctx);
    vctx.fillStyle = '#000';
    polys.forEach(function(p) { fillVis(vctx, p); });
    vctx.globalCompositeOperation = 'source-over';

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(visCanvas, 0, 0);
    ctx.restore();
}

// GM 看到全部墙体；玩家只看到门（用于点击开关）
function drawWalls(items, gmView) {
    var preview = me.gm && $('fogPreview').checked;
    var strong = tool === 'wall';
    items.forEach(function(it) {
        if (it.kind !== 'wall') return;
        if ((!gmView || preview) && it.wtype !== 'door') return;
        var st = WALL_STYLE[it.wtype] || WALL_STYLE.wall, pts = it.points || [];
        ctx.save();
        ctx.translate(it.x || 0, it.y || 0);
        ctx.lineCap = 'round';
        ctx.strokeStyle = it.wtype === 'door' && it.open ? '#81c784' : st.color;
        ctx.globalAlpha = gmView && !strong && it.wtype !== 'door' ? 0.6 : 1;
        ctx.lineWidth = (it.wtype === 'door' ? 6 : strong ? 4 : 3) / view.s;
        if (it.wtype === 'window' || (it.wtype === 'door' && it.open)) ctx.setLineDash([8 / view.s, 5 / view.s]);
        ctx.beginPath();
        pts.forEach(function(p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
        ctx.stroke();
        if (strong) {
            ctx.setLineDash([]);
            ctx.fillStyle = st.color;
            pts.forEach(function(p) { ctx.beginPath(); ctx.arc(p[0], p[1], 3.5 / view.s, 0, Math.PI * 2); ctx.fill(); });
        }
        ctx.restore();
    });

    if (wallDraft && gmView) {
        var st2 = WALL_STYLE[wallDraft.type];
        var cur = wallSnap(cursorWorld, false);
        ctx.save();
        ctx.strokeStyle = st2.color;
        ctx.lineWidth = 3 / view.s;
        ctx.setLineDash([6 / view.s, 4 / view.s]);
        ctx.beginPath();
        wallDraft.points.forEach(function(p, i) { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
        ctx.lineTo(cur.x, cur.y);
        ctx.stroke();
        ctx.restore();
        var last = wallDraft.points[wallDraft.points.length - 1];
        drawLabel(distText(Math.hypot(cur.x - last.x, cur.y - last.y)), cur.x, cur.y, st2.color);
    }
}

function wallSnap(w, free) {
    return free ? { x: w.x, y: w.y } : snapToGrid(w.x, w.y, gridSize() / 2);
}

function finishWall() {
    if (!wallDraft) return;
    var pts = [];
    wallDraft.points.forEach(function(p) {
        var last = pts[pts.length - 1];
        if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 0.5) pts.push(p);
    });
    var type = wallDraft.type;
    wallDraft = null;
    if (pts.length < 2) { requestRender(); return; }
    var o = pts[0];
    var it = { id: genId(), kind: 'wall', wtype: type, x: o.x, y: o.y, z: nextZ(),
        points: pts.map(function(p) { return [p.x - o.x, p.y - o.y]; }) };
    if (type === 'door') it.open = false;
    createItems([it]);
}

// 选择工具下点击门：开 / 关（GM 或未锁定的门）
function doorAt(w) {
    var list = sortedItems().reverse();
    for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (it.kind === 'wall' && it.wtype === 'door' && hitItem(it, w)) return it;
    }
    return null;
}

function syncWallOpts() {
    document.querySelectorAll('[data-walltype]').forEach(function(b) { b.classList.toggle('active', b.dataset.walltype === wallOpts.type && wallOpts.mode === 'draw'); });
    document.querySelectorAll('[data-wallmode]').forEach(function(b) { b.classList.toggle('active', b.dataset.wallmode === wallOpts.mode); });
}

function clearWalls() {
    var ids = sortedItems().filter(function(it) { return it.kind === 'wall'; }).map(function(it) { return it.id; });
    if (!ids.length) return;
    if (!confirm('删除本场景的全部墙体、门窗（共 ' + ids.length + ' 段）？')) return;
    deleteItems(ids);
}

// ===== 工具 =====
function setTool(t) {
    if ((t === 'fog' || t === 'wall') && !me.gm) return;
    if (tool === 'wall' && t !== 'wall') finishWall();
    tool = t;
    polyDraft = null;
    document.querySelectorAll('.tool-btn[data-tool]').forEach(function(b) { b.classList.toggle('active', b.dataset.tool === t); });
    $('optsDraw').classList.toggle('show', t === 'draw');
    $('optsFog').classList.toggle('show', t === 'fog');
    $('optsWall').classList.toggle('show', t === 'wall');
    if (t !== 'select' && !(t === 'fog' && fogOpts.shape === 'select') && !(t === 'wall' && wallOpts.mode === 'select')) selectOnly([]);
    updateCursor();
    requestRender();
}

function updateCursor() {
    var c = 'default';
    if (spaceDown || tool === 'pan') c = gesture && gesture.type === 'pan' ? 'grabbing' : 'grab';
    else if (tool === 'draw' || tool === 'ruler' || (tool === 'fog' && fogOpts.shape !== 'select') || (tool === 'wall' && wallOpts.mode === 'draw')) c = 'crosshair';
    else if (tool === 'pointer') c = 'pointer';
    canvas.style.cursor = c;
}

function syncToolOpts() {
    document.querySelectorAll('[data-shape]').forEach(function(b) { b.classList.toggle('active', b.dataset.shape === drawOpts.shape); });
    document.querySelectorAll('[data-fogmode]').forEach(function(b) { b.classList.toggle('active', b.dataset.fogmode === fogOpts.mode); });
    document.querySelectorAll('[data-fogshape]').forEach(function(b) { b.classList.toggle('active', b.dataset.fogshape === fogOpts.shape); });
    document.querySelectorAll('.swatch').forEach(function(s) { s.classList.toggle('active', s.dataset.color === drawOpts.color); });
    $('drawColor').value = drawOpts.color;
}

var pointers = {};

function onPointerDown(e) {
    canvas.setPointerCapture(e.pointerId);
    var s = eventPos(e);
    pointers[e.pointerId] = s;
    var ids = Object.keys(pointers);
    if (ids.length === 2) { // 双指缩放
        cancelGesture();
        var p1 = pointers[ids[0]], p2 = pointers[ids[1]];
        gesture = { type: 'pinch', dist: Math.hypot(p1.x - p2.x, p1.y - p2.y), mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } };
        return;
    }
    if (ids.length > 2) return;

    var w = toWorld(s.x, s.y);
    var start = { s: s, w: w, moved: false };

    if (tool === 'wall' && wallDraft && e.button === 2) { finishWall(); return; } // 右键结束墙体
    if (e.button === 1 || e.button === 2 || tool === 'pan' || spaceDown) {
        gesture = { type: 'pan', start: start, view: { x: view.x, y: view.y } };
        updateCursor();
        return;
    }
    if (e.button !== 0) return;

    if (tool === 'wall' && wallOpts.mode === 'draw') {
        var wp = wallSnap(w, e.altKey);
        if (!wallDraft) wallDraft = { type: wallOpts.type, points: [] };
        wallDraft.points.push(wp);
        if (wallDraft.type === 'door' && wallDraft.points.length >= 2) finishWall(); // 门是一段直线
        requestRender();
        return;
    }

    if (tool === 'select' || (tool === 'fog' && fogOpts.shape === 'select') || (tool === 'wall' && wallOpts.mode === 'select')) {
        var handle = resizeHandle();
        if (handle && Math.abs(w.x - handle.x) <= handle.r * 2 && Math.abs(w.y - handle.y) <= handle.r * 2) {
            var t = scene.items[handle.id];
            gesture = { type: 'resize', start: start, id: t.id, ids: idSet([t.id]), orig: { w: t.w || gridSize(), h: t.h || gridSize() } };
            return;
        }
        var hit = hitTest(w, tool === 'fog' ? ['fog'] : tool === 'wall' ? ['wall'] : ['token', 'draw']);
        if (!hit && tool === 'select') {
            var door = doorAt(w);
            if (door && (me.gm || !door.locked)) {
                patchItems([{ id: door.id, open: !door.open || null }]);
                return;
            }
        }
        if (hit) {
            if (e.shiftKey) {
                if (selected[hit.id]) delete selected[hit.id]; else selected[hit.id] = true;
                renderSelPanel();
            } else if (!selected[hit.id]) {
                selectOnly([hit.id]);
            }
            var movable = selectedIds().filter(function(id) { return canMove(scene.items[id]); });
            if (movable.length) {
                var orig = {};
                movable.forEach(function(id) { orig[id] = { x: scene.items[id].x || 0, y: scene.items[id].y || 0 }; });
                gesture = { type: 'move', start: start, ids: idSet(movable), orig: orig, lastSent: 0 };
            }
        } else {
            if (!e.shiftKey) selectOnly([]);
            gesture = { type: 'marquee', start: start, a: w, b: w };
        }
        requestRender();
        return;
    }

    if (tool === 'draw') {
        var it = { id: genId(), kind: 'draw', shape: drawOpts.shape, x: w.x, y: w.y, points: [[0, 0]],
            color: drawOpts.color, width: drawOpts.width };
        if (drawOpts.fill && (it.shape === 'rect' || it.shape === 'circle' || it.shape === 'cone')) it.fill = true;
        if (it.shape === 'circle') { it.r = 0; delete it.points; }
        if (it.shape === 'cone') it.points = [[0, 0]];
        gesture = { type: 'draw', start: start, item: it };
        return;
    }

    if (tool === 'fog') {
        var cut = fogOpts.mode === 'reveal';
        if (fogOpts.shape === 'poly') {
            if (polyDraft && polyDraft.points.length > 2) {
                var first = polyDraft.points[0];
                if (Math.hypot(first.x - w.x, first.y - w.y) * view.s < 10) { finishPoly(); return; }
            }
            if (!polyDraft) polyDraft = { cut: cut, points: [] };
            polyDraft.points.push(w);
            requestRender();
            return;
        }
        var f = { id: genId(), kind: 'fog', shape: fogOpts.shape, x: w.x, y: w.y, points: [[0, 0]] };
        if (cut) f.cut = true;
        if (f.shape === 'brush') f.width = parseFloat($('fogBrush').value) * gridSize();
        gesture = { type: 'fog', start: start, item: f };
        requestRender();
        return;
    }

    if (tool === 'ruler') {
        var a = e.altKey ? w : cellCenter(w.x, w.y);
        gesture = { type: 'ruler', start: start, a: a, b: a };
        requestRender();
        return;
    }

    if (tool === 'pointer') {
        gesture = { type: 'pointer', start: start };
        localTrail.push({ x: w.x, y: w.y, at: performance.now() });
        sendFx({ t: 'ptr', x: w.x, y: w.y });
        requestRender();
    }
}

function idSet(ids) { var o = {}; ids.forEach(function(id) { o[id] = true; }); return o; }

function onPointerMove(e) {
    var s = eventPos(e);
    if (pointers[e.pointerId]) pointers[e.pointerId] = s;
    var w = toWorld(s.x, s.y);
    cursorWorld = w;
    if (polyDraft) requestRender();
    if (!gesture) return;

    if (gesture.type === 'pinch') {
        var ids = Object.keys(pointers);
        if (ids.length < 2) return;
        var p1 = pointers[ids[0]], p2 = pointers[ids[1]];
        var dist = Math.hypot(p1.x - p2.x, p1.y - p2.y), mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        view.x += mid.x - gesture.mid.x;
        view.y += mid.y - gesture.mid.y;
        zoomAt(mid.x, mid.y, dist / gesture.dist);
        gesture.dist = dist;
        gesture.mid = mid;
        return;
    }

    var st = gesture.start;
    if (Math.hypot(s.x - st.s.x, s.y - st.s.y) > 3) st.moved = true;
    var dx = w.x - st.w.x, dy = w.y - st.w.y;

    switch (gesture.type) {
    case 'pan':
        view.x = gesture.view.x + (s.x - st.s.x);
        view.y = gesture.view.y + (s.y - st.s.y);
        break;
    case 'move':
        if (!st.moved) return;
        var patches = [];
        for (var id in gesture.orig) {
            var it = scene.items[id];
            if (!it) continue;
            it.x = gesture.orig[id].x + dx;
            it.y = gesture.orig[id].y + dy;
            patches.push({ id: id, x: it.x, y: it.y });
        }
        var now = performance.now();
        if (now - gesture.lastSent > 60) { gesture.lastSent = now; queueItems(patches); }
        break;
    case 'resize':
        var t = scene.items[gesture.id];
        if (!t) return;
        var ratio = gesture.orig.h / gesture.orig.w;
        var nw = Math.max(gridSize() / 4, gesture.orig.w + Math.max(dx, dy / ratio));
        if (!e.altKey) nw = Math.max(0.5, Math.round(nw / gridSize() * 2) / 2) * gridSize();
        t.w = nw;
        t.h = nw * ratio;
        break;
    case 'marquee':
        gesture.b = w;
        break;
    case 'draw':
        var d = gesture.item, lx = w.x - d.x, ly = w.y - d.y;
        if (d.shape === 'pen') {
            var lp = d.points[d.points.length - 1];
            if (Math.hypot(lx - lp[0], ly - lp[1]) * view.s > 2 && d.points.length < 3000) d.points.push([lx, ly]);
        } else if (d.shape === 'circle') {
            d.r = Math.hypot(lx, ly);
        } else if (d.shape === 'cone') {
            d.points = [[lx, ly]];
        } else {
            d.points = [[0, 0], [lx, ly]];
        }
        break;
    case 'fog':
        var f = gesture.item, fx = w.x - f.x, fy = w.y - f.y;
        if (f.shape === 'brush') {
            var fp = f.points[f.points.length - 1];
            if (Math.hypot(fx - fp[0], fy - fp[1]) * view.s > 3 && f.points.length < 3000) f.points.push([fx, fy]);
        } else {
            f.points = [[0, 0], [fx, fy]];
        }
        break;
    case 'ruler':
        gesture.b = e.altKey ? w : cellCenter(w.x, w.y);
        sendFx({ t: 'ruler', a: [gesture.a.x, gesture.a.y], b: [gesture.b.x, gesture.b.y] });
        break;
    case 'pointer':
        localTrail.push({ x: w.x, y: w.y, at: performance.now() });
        sendFx({ t: 'ptr', x: w.x, y: w.y });
        break;
    }
    requestRender();
}

function onPointerUp(e) {
    delete pointers[e.pointerId];
    if (!gesture) return;
    if (gesture.type === 'pinch') { if (Object.keys(pointers).length < 2) gesture = null; return; }
    var g = gesture, w = toWorld(eventPos(e).x, eventPos(e).y);
    gesture = null;

    switch (g.type) {
    case 'pan':
        updateCursor();
        break;
    case 'move':
        if (!g.start.moved) break;
        var patches = [], blocked = false;
        for (var id in g.orig) {
            var it = scene.items[id];
            if (!it) continue;
            if (it.kind === 'token' && !me.gm) {
                var hw = (it.w || gridSize()) / 2, hh = (it.h || gridSize()) / 2;
                if (moveBlocked(g.orig[id].x + hw, g.orig[id].y + hh, it.x + hw, it.y + hh)) {
                    it.x = g.orig[id].x; // 玩家不能穿墙 / 穿窗 / 穿过关着的门
                    it.y = g.orig[id].y;
                    blocked = true;
                    patches.push({ id: id, x: it.x, y: it.y });
                    continue;
                }
            }
            if (it.kind === 'token' && !e.altKey) {
                // 左上角对齐网格；小于 1 格的棋子按半格对齐，非整格的余量居中
                var gs = gridSize(), step = (it.w || gs) >= gs ? gs : gs / 2;
                var adjX = ((it.w || gs) % step) / 2, adjY = ((it.h || gs) % step) / 2;
                var c = snapToGrid(it.x - adjX, it.y - adjY, step);
                it.x = c.x + adjX;
                it.y = c.y + adjY;
            }
            patches.push({ id: id, x: it.x, y: it.y });
        }
        if (blocked) notice('被墙挡住了', true);
        queueItems(patches);
        break;
    case 'resize':
        var t = scene.items[g.id];
        if (t) queueItems([{ id: t.id, w: t.w, h: t.h }]);
        renderSelPanel();
        break;
    case 'marquee':
        if (!g.start.moved) break;
        var x0 = Math.min(g.a.x, g.b.x), y0 = Math.min(g.a.y, g.b.y), x1 = Math.max(g.a.x, g.b.x), y1 = Math.max(g.a.y, g.b.y);
        sortedItems().forEach(function(it) {
            if (it.kind === 'fog' || it.kind === 'wall') return;
            var b = itemBBox(it);
            if (b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1) selected[it.id] = true;
        });
        renderSelPanel();
        break;
    case 'draw':
        var d = g.item;
        var big = d.shape === 'circle' ? d.r * view.s > 3 : g.start.moved || d.shape === 'pen';
        if (big) { d.z = nextZ(); createItems([d]); }
        break;
    case 'fog':
        var f = g.item;
        if (f.shape === 'brush' || g.start.moved) { f.z = nextZ(); createItems([f]); }
        break;
    case 'ruler':
        sendFx({ t: 'ruler-end' });
        break;
    case 'pointer':
        if (!g.start.moved) {
            remote.pings.push({ x: w.x, y: w.y, color: me.color, at: performance.now() });
            sendFx({ t: 'ping', x: w.x, y: w.y });
        }
        break;
    }
    requestRender();
}

function cancelGesture() {
    if (gesture && gesture.type === 'ruler') sendFx({ t: 'ruler-end' });
    gesture = null;
    requestRender();
}

function finishPoly() {
    if (!polyDraft || polyDraft.points.length < 3) { polyDraft = null; requestRender(); return; }
    var o = polyDraft.points[0];
    var f = { id: genId(), kind: 'fog', shape: 'poly', x: o.x, y: o.y, z: nextZ(),
        points: polyDraft.points.map(function(p) { return [p.x - o.x, p.y - o.y]; }) };
    if (polyDraft.cut) f.cut = true;
    polyDraft = null;
    createItems([f]);
}

function onWheel(e) {
    e.preventDefault();
    var s = eventPos(e);
    var delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    zoomAt(s.x, s.y, Math.exp(-delta * 0.0015));
}

function onKeyDown(e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || $('table').style.display === 'none') return;
    if (e.key === ' ') { if (!spaceDown) { spaceDown = true; updateCursor(); } e.preventDefault(); return; }
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 'd' || e.key === 'D') { e.preventDefault(); duplicateSelected(); }
        return;
    }
    var keyTools = { v: 'select', h: 'pan', d: 'draw', m: 'ruler', l: 'pointer', f: 'fog', w: 'wall' };
    var k = e.key.toLowerCase();
    if (keyTools[k]) { setTool(keyTools[k]); return; }
    if (k === '0') { fitView(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { deleteItems(selectedIds()); e.preventDefault(); return; }
    if (e.key === 'Escape') { polyDraft = null; wallDraft = null; cancelGesture(); selectOnly([]); return; }
    if (e.key === 'Enter' && polyDraft) { finishPoly(); return; }
    if (e.key === 'Enter' && wallDraft) { finishWall(); return; }
    var arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) {
        var step = e.shiftKey ? gridSize() / 4 : gridSize();
        var patches = selectedIds().filter(function(id) { return canMove(scene.items[id]); }).map(function(id) {
            var it = scene.items[id], hw = (it.w || gridSize()) / 2, hh = (it.h || gridSize()) / 2;
            var p = { id: id, x: (it.x || 0) + arrows[e.key][0] * step, y: (it.y || 0) + arrows[e.key][1] * step };
            if (!me.gm && it.kind === 'token' && moveBlocked(it.x + hw, it.y + hh, p.x + hw, p.y + hh)) return null;
            return p;
        }).filter(Boolean);
        if (patches.length) { e.preventDefault(); patchItems(patches); }
    }
}

function onKeyUp(e) {
    if (e.key === ' ') { spaceDown = false; updateCursor(); }
}

// 从资产栏或电脑拖入图片
function onDragOver(e) {
    var types = Array.prototype.slice.call(e.dataTransfer.types || []);
    if (types.indexOf('text/tt-asset') < 0 && types.indexOf('Files') < 0) return;
    e.preventDefault();
    $('stage').classList.add('drop-hover');
}

function onDrop(e) {
    e.preventDefault();
    $('stage').classList.remove('drop-hover');
    var s = eventPos(e), w = toWorld(s.x, s.y);
    var assetId = e.dataTransfer.getData('text/tt-asset');
    var onToken = hitTest(w, ['token']);
    if (assetId && onToken && canEdit(onToken)) { // 拖到已有棋子上 = 更换图片
        patchItems([{ id: onToken.id, asset: assetId, circle: onToken.asset ? onToken.circle : true }]);
        notice('已更换棋子图片');
        return;
    }
    if (assetId) {
        var a = room.assets.filter(function(x) { return x.id === assetId; })[0];
        if (a) placeToken(a, w.x, w.y);
        return;
    }
    var files = Array.prototype.filter.call(e.dataTransfer.files || [], function(f) { return /^image\//.test(f.type); });
    files.forEach(function(file, i) {
        notice('正在上传 ' + file.name + '...');
        uploadAsset(file, 'token').then(function(asset) {
            placeToken(asset, w.x + i * gridSize(), w.y);
        }).catch(apiError);
    });
}

// ===== 属性面板 =====
function renderSelPanel() {
    var panel = $('selPanel');
    var ids = selectedIds();
    if (!ids.length) { panel.className = 'tt-float'; panel.innerHTML = ''; return; }
    if (panel.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && panel.dataset.ids === ids.join(',')) return;
    panel.dataset.ids = ids.join(',');
    panel.className = 'tt-float show';

    if (ids.length > 1) {
        var editable = ids.filter(function(id) { return canEdit(scene.items[id]); });
        panel.innerHTML = '<h4>已选择 ' + ids.length + ' 个物件 <button class="tt-btn small" data-act="close">✕</button></h4>' +
            '<div class="prop-btns">' +
            (me.gm ? '<button class="tt-btn small" data-act="hideAll">隐藏</button><button class="tt-btn small" data-act="showAll">显示</button>' +
                '<button class="tt-btn small" data-act="lockAll">锁定</button><button class="tt-btn small" data-act="unlockAll">解锁</button>' : '') +
            (editable.length ? '<button class="tt-btn small" data-act="dup">复制</button><button class="tt-btn small danger" data-act="del">删除</button>' : '') +
            '</div>';
        return;
    }

    var it = scene.items[ids[0]];
    var edit = canEdit(it), g = gridSize();
    var title = it.kind === 'token' ? '棋子' : it.kind === 'fog' ? (it.cut ? '揭示区域' : '迷雾') :
        it.kind === 'wall' ? (WALL_STYLE[it.wtype] || WALL_STYLE.wall).name : '绘制';
    var h = '<h4>' + title + ' <button class="tt-btn small" data-act="close">✕</button></h4>';
    if (!edit) {
        h += '<div class="tt-hint">' + escapeHtml(it.label || '') + (it.owner ? '<br>控制者：' + escapeHtml(it.owner) : '') +
            '<br>' + (it.locked ? '已锁定' : (it.kind === 'token' ? '可拖动移动' : '只读')) + '</div>';
        panel.innerHTML = h;
        return;
    }
    if (it.kind === 'token') {
        h += row('名称', '<input class="tt-input" data-prop="label" maxlength="40" value="' + escapeHtml(it.label || '') + '">');
        h += row('尺寸', '<input class="tt-input narrow" data-prop="size" type="number" min="0.25" step="0.5" value="' + (Math.round((it.w || g) / g * 100) / 100) + '"> 格');
        h += row('HP', '<input class="tt-input narrow" data-prop="hp" type="number" value="' + (it.hp != null ? it.hp : '') + '"> / ' +
            '<input class="tt-input narrow" data-prop="hpMax" type="number" min="0" value="' + (it.hpMax || '') + '">');
        h += row('', '<button class="tt-btn small" data-hp="-5">-5</button><button class="tt-btn small" data-hp="-1">-1</button>' +
            '<button class="tt-btn small" data-hp="1">+1</button><button class="tt-btn small" data-hp="5">+5</button>');
        h += row('颜色', '<input class="tt-input" type="color" data-prop="color" value="' + escapeHtml(it.color || '#607d8b') + '">' +
            '<label><input type="checkbox" data-prop="circle"' + (it.circle ? ' checked' : '') + '> 圆形</label>');
        h += row('旋转', '<input type="range" data-prop="rot" min="0" max="345" step="15" value="' + (it.rot || 0) + '" style="flex:1;">');
        h += row('视野', '<input class="tt-input narrow" data-prop="sight" type="number" min="0" step="5" value="' + (it.sight || '') + '" placeholder="不限"> ' +
            escapeHtml(scene.props.gridUnit || 'ft') + '<span class="tt-hint">（动态视野用）</span>');
        var linked = it.sheet && sheets[it.sheet];
        h += row('角色卡', linked ? '<button class="tt-btn small" data-act="sheet">' + escapeHtml(linked.name) + '</button>' +
            '<button class="tt-btn small" data-act="unlink" title="取消关联">✕</button>' :
            '<select class="tt-select" data-prop="sheet" style="flex:1;"><option value="">（未关联）</option>' +
            Object.keys(sheets).map(function(id) { return '<option value="' + escapeHtml(id) + '">' + escapeHtml(sheets[id].name) + '</option>'; }).join('') +
            '</select>');
    } else if (it.kind === 'draw') {
        h += row('颜色', '<input class="tt-input" type="color" data-prop="color" value="' + escapeHtml(it.color || '#e53935') + '">' +
            (it.shape === 'rect' || it.shape === 'circle' || it.shape === 'cone' ? '<label><input type="checkbox" data-prop="fill"' + (it.fill ? ' checked' : '') + '> 填充</label>' : ''));
        h += row('线宽', '<input class="tt-input narrow" type="number" min="1" max="64" data-prop="width" value="' + (it.width || 4) + '">');
        if (it.shape === 'circle') h += row('半径', '<span>' + distText(it.r || 0) + '</span>');
    } else if (it.kind === 'wall') {
        h += row('类型', '<select class="tt-select" data-prop="wtype" style="flex:1;">' +
            ['wall', 'window', 'door'].map(function(t) {
                return '<option value="' + t + '"' + ((it.wtype || 'wall') === t ? ' selected' : '') + '>' + WALL_STYLE[t].name + '</option>';
            }).join('') + '</select>');
        if (it.wtype === 'door') h += row('', '<label><input type="checkbox" data-prop="open"' + (it.open ? ' checked' : '') + '> 打开</label>' +
            '<label><input type="checkbox" data-prop="locked"' + (it.locked ? ' checked' : '') + '> 上锁（玩家打不开）</label>');
        h += '<div class="tt-hint">墙：挡视线和移动；窗：只挡移动；门：关着时同墙，玩家可点击开关。</div>';
    } else if (it.kind === 'fog') {
        h += row('类型', '<label><input type="checkbox" data-prop="cut"' + (it.cut ? ' checked' : '') + '> 揭示（挖空迷雾）</label>');
    }
    if (me.gm && it.kind !== 'fog' && it.kind !== 'wall') {
        h += row('', '<label><input type="checkbox" data-prop="hidden"' + (it.hidden ? ' checked' : '') + '> 对玩家隐藏</label>' +
            '<label><input type="checkbox" data-prop="locked"' + (it.locked ? ' checked' : '') + '> 锁定</label>');
        if (it.kind === 'token') {
            var names = users.filter(function(u) { return !u.gm; }).map(function(u) { return u.name; });
            if (it.owner && names.indexOf(it.owner) < 0) names.push(it.owner);
            h += row('控制者', '<select class="tt-select" data-prop="owner" style="flex:1;"><option value="">（仅 GM）</option>' +
                names.map(function(n) { return '<option value="' + escapeHtml(n) + '"' + (n === it.owner ? ' selected' : '') + '>' + escapeHtml(n) + '</option>'; }).join('') +
                '</select>');
        }
    }
    h += '<div class="prop-btns"><button class="tt-btn small" data-act="front">置顶</button><button class="tt-btn small" data-act="back">置底</button>' +
        '<button class="tt-btn small" data-act="dup">复制</button><button class="tt-btn small danger" data-act="del">删除</button></div>';
    panel.innerHTML = h;

    function row(label, inner) { return '<div class="prop-row"><label>' + label + '</label>' + inner + '</div>'; }
}

function onSelPanelChange(e) {
    var el = e.target, prop = el.dataset.prop;
    var ids = selectedIds();
    if (!prop || ids.length !== 1) return;
    var it = scene.items[ids[0]], g = gridSize(), patch = { id: it.id };
    if (el.type === 'checkbox') patch[prop] = el.checked || null;
    else if (prop === 'size') {
        var cells = parseFloat(el.value);
        if (!(cells > 0)) return;
        var ratio = (it.h || g) / (it.w || g);
        patch.w = cells * g;
        patch.h = cells * g * ratio;
    } else if (prop === 'hp' || prop === 'hpMax' || prop === 'width' || prop === 'rot' || prop === 'sight') {
        patch[prop] = el.value === '' ? null : parseFloat(el.value);
    } else patch[prop] = el.value === '' ? null : el.value;
    if (prop === 'color' && it.kind === 'token' && !it.asset) patch.circle = true;
    patchItems([patch]);
}

function onSelPanelClick(e) {
    var b = e.target.closest('button');
    if (!b) return;
    var ids = selectedIds();
    if (b.dataset.hp) {
        var it = scene.items[ids[0]];
        patchItems([{ id: it.id, hp: (it.hp || 0) + parseInt(b.dataset.hp, 10) }]);
        $('selPanel').dataset.ids = '';
        renderSelPanel();
        return;
    }
    var flag = function(key, val) { patchItems(ids.map(function(id) { var p = { id: id }; p[key] = val; return p; })); };
    switch (b.dataset.act) {
    case 'close': selectOnly([]); break;
    case 'sheet': openSheet(scene.items[ids[0]].sheet, ids[0]); break;
    case 'unlink': patchItems([{ id: ids[0], sheet: null }]); $('selPanel').dataset.ids = ''; renderSelPanel(); break;
    case 'del': deleteItems(ids); break;
    case 'dup': duplicateSelected(); break;
    case 'hideAll': flag('hidden', true); break;
    case 'showAll': flag('hidden', null); break;
    case 'lockAll': flag('locked', true); break;
    case 'unlockAll': flag('locked', null); break;
    case 'front':
        patchItems([{ id: ids[0], z: nextZ() }]);
        break;
    case 'back':
        var minZ = 0;
        for (var id in scene.items) minZ = Math.min(minZ, scene.items[id].z || 0);
        patchItems([{ id: ids[0], z: minZ - 1 }]);
        break;
    }
}

// ===== 资产栏 =====
function renderAssets() {
    var list = (room.assets || []).filter(function(a) { return assetFilter === 'all' || a.kind === assetFilter; });
    if (!list.length) {
        $('assetGrid').innerHTML = '<div class="tt-hint" style="grid-column:1/-1;">还没有' + (assetFilter === 'map' ? '地图' : '图片') + '，点上方按钮上传</div>';
        return;
    }
    $('assetGrid').innerHTML = list.map(function(a) {
        return '<div class="asset-card" draggable="true" data-asset="' + escapeHtml(a.id) + '" title="' + escapeHtml(a.name + '（' + a.by + ' 上传）') + '">' +
            '<span class="kind">' + (a.kind === 'map' ? '地图' : '棋子') + '</span>' +
            '<img loading="lazy" src="' + assetURL(a.id) + '" alt="">' +
            '<div class="name">' + escapeHtml(a.name) + '</div>' +
            '<div class="ops"><button class="tt-btn small" data-place="' + escapeHtml(a.id) + '">放置</button>' +
            (me.gm ? '<button class="tt-btn small" data-setmap="' + escapeHtml(a.id) + '">作地图</button>' +
                '<button class="tt-btn small danger" data-delasset="' + escapeHtml(a.id) + '">✕</button>' : '') +
            '</div></div>';
    }).join('');
}

function onAssetClick(e) {
    var b = e.target.closest('button');
    if (!b) return;
    var id = b.dataset.place || b.dataset.setmap || b.dataset.delasset;
    var a = room.assets.filter(function(x) { return x.id === id; })[0];
    if (!a) return;
    if (b.dataset.place) {
        var c = toWorld(canvas.clientWidth / 2, canvas.clientHeight / 2);
        placeToken(a, c.x, c.y);
    } else if (b.dataset.setmap) {
        setMapAsset(a.id, null);
    } else if (b.dataset.delasset) {
        if (confirm('从资产库移除「' + a.name + '」？（已放置的棋子不受影响）')) op({ op: 'asset.delete', ids: [a.id] });
    }
}

function uploadTokens(input) {
    var files = Array.prototype.slice.call(input.files);
    input.value = '';
    var chain = Promise.resolve();
    files.forEach(function(f) {
        chain = chain.then(function() {
            notice('正在上传 ' + f.name + '...');
            return uploadAsset(f, 'token').then(function() { notice('已上传 ' + f.name); }).catch(apiError);
        });
    });
}

// ===== 地图导入 =====
function importMap(input) {
    var file = input.files[0];
    input.value = '';
    if (!file) return;
    if (/\.(dd2vtt|uvtt|df2vtt|json)$/i.test(file.name)) { importUVTT(file); return; }
    notice('正在上传地图...');
    uploadAsset(file, 'map').then(function(asset) { setMapAsset(asset.id, null); }).catch(apiError);
}

// Universal VTT：JSON 内嵌 base64 地图图片与网格信息
function importUVTT(file) {
    notice('正在解析 ' + file.name + '...');
    file.text().then(function(text) {
        var j = JSON.parse(text);
        if (!j.image) throw '文件中没有地图图片';
        var bin = atob(String(j.image).replace(/^data:[^,]*,/, ''));
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
        var isJpg = bytes[0] === 0xFF && bytes[1] === 0xD8;
        var type = isPng ? 'image/png' : isJpg ? 'image/jpeg' : 'image/webp';
        var name = file.name.replace(/\.[^.]+$/, '') + (isPng ? '.png' : isJpg ? '.jpg' : '.webp');
        var res = j.resolution || {};
        var ppg = num(res.pixels_per_grid, 0);
        var size = res.map_size || {};
        notice('正在上传地图...');
        return uploadAsset(new File([bytes], name, { type: type }), 'map').then(function(asset) {
            var extra = {};
            if (ppg > 0) {
                extra.gridSize = ppg;
                extra.gridOffX = 0;
                extra.gridOffY = 0;
                if (size.x && size.y) { extra.mapW = size.x * ppg; extra.mapH = size.y * ppg; }
            }
            setMapAsset(asset.id, extra);
            if (ppg > 0) importUVTTWalls(j, ppg);
        });
    }).catch(function(e) { apiError(typeof e === 'string' ? e : '无法解析该文件'); });
}

// UVTT 的 line_of_sight / objects_line_of_sight 是墙（格为单位），portals 是门
function importUVTTWalls(j, ppg) {
    var o = (j.resolution && j.resolution.map_origin) || { x: 0, y: 0 };
    var toW = function(p) { return [(num(p.x, 0) - num(o.x, 0)) * ppg, (num(p.y, 0) - num(o.y, 0)) * ppg]; };
    var walls = [], z = nextZ(), doors = 0;
    var add = function(pts, type, extra) {
        if (pts.length < 2) return;
        var it = { id: genId(), kind: 'wall', wtype: type, x: pts[0][0], y: pts[0][1], z: z + walls.length,
            points: pts.map(function(p) { return [p[0] - pts[0][0], p[1] - pts[0][1]]; }) };
        for (var k in extra || {}) if (extra[k] != null) it[k] = extra[k];
        walls.push(it);
    };
    (j.line_of_sight || []).concat(j.objects_line_of_sight || []).forEach(function(line) {
        if (Array.isArray(line)) add(line.map(toW), 'wall');
    });
    (j.portals || []).forEach(function(pt) {
        if (pt.bounds && pt.bounds.length >= 2) { add(pt.bounds.map(toW), 'door', { open: pt.closed ? null : true }); doors++; }
    });
    if (!walls.length) return;
    createItems(walls);
    notice('已导入 ' + (walls.length - doors) + ' 段墙体、' + doors + ' 扇门；在「设置」中开启动态视野即可生效');
}

function setMapAsset(id, extra) {
    loadImageSize(id).then(function(img) {
        var props = { mapAsset: id, mapW: img.naturalWidth, mapH: img.naturalHeight };
        for (var k in extra || {}) props[k] = extra[k];
        fitPending = true;
        setProps(props);
        notice('地图已更新');
    }).catch(apiError);
}

function removeMap() {
    if (!scene.props.mapAsset || !confirm('移除当前场景的地图？（棋子和绘制保留）')) return;
    setProps({ mapAsset: null, mapW: null, mapH: null });
}

// ===== 场景 =====
function renderScenes() {
    $('sceneList').innerHTML = (room.scenes || []).map(function(s) {
        var active = s.id === room.active;
        return '<li class="' + (active ? 'active' : '') + '"><span class="name">' + (active ? '▶ ' : '') + escapeHtml(s.name) + '</span>' +
            (active ? '' : '<button class="tt-btn small primary" data-sact="activate" data-sid="' + escapeHtml(s.id) + '">切换</button>') +
            '<button class="tt-btn small" data-sact="rename" data-sid="' + escapeHtml(s.id) + '">改名</button>' +
            '<button class="tt-btn small" data-sact="duplicate" data-sid="' + escapeHtml(s.id) + '">复制</button>' +
            '<button class="tt-btn small danger" data-sact="delete" data-sid="' + escapeHtml(s.id) + '">✕</button></li>';
    }).join('');
}

function onSceneClick(e) {
    var b = e.target.closest('button');
    if (!b || !b.dataset.sact) return;
    var s = room.scenes.filter(function(x) { return x.id === b.dataset.sid; })[0];
    if (!s) return;
    switch (b.dataset.sact) {
    case 'activate': op({ op: 'scene.activate', scene: s.id }); break;
    case 'duplicate': op({ op: 'scene.duplicate', scene: s.id }); break;
    case 'rename':
        var name = prompt('新的场景名：', s.name);
        if (name && name.trim()) op({ op: 'scene.rename', scene: s.id, text: name.trim() });
        break;
    case 'delete':
        if (confirm('删除场景「' + s.name + '」？场景内所有棋子、绘制、迷雾将被删除。')) op({ op: 'scene.delete', scene: s.id });
        break;
    }
}

function addScene() {
    op({ op: 'scene.add', text: $('newSceneName').value.trim() });
    $('newSceneName').value = '';
}

function exportRoom() {
    window.location.href = '/api/tabletop/export?room=' + enc(roomId) + '&token=' + enc(authToken);
}

function clearLog() {
    if (confirm('清空本房间的所有掷骰与聊天记录？')) op({ op: 'log.clear' });
}

// ===== 骰子 =====
var dicePool = {};
var advMode = '';

function renderDiceButtons() {
    $('diceBtns').innerHTML = DICE.map(function(d) {
        return '<button class="die-btn" data-die="' + d + '" title="单击加入，Shift+单击直接投掷">d' + d +
            (dicePool[d] ? '<span class="cnt">' + dicePool[d] + '</span>' : '') + '</button>';
    }).join('');
    $('btnAdv').classList.toggle('active', advMode === 'adv');
    $('btnDis').classList.toggle('active', advMode === 'dis');
}

function buildTrayExpr() {
    var parts = [];
    DICE.slice().reverse().forEach(function(d) {
        var n = dicePool[d];
        if (!n) return;
        if (d === 20 && n === 1 && advMode) parts.push('2d20' + (advMode === 'adv' ? 'kh1' : 'kl1'));
        else parts.push(n + 'd' + d);
    });
    var mod = parseInt($('diceMod').value, 10) || 0;
    var expr = parts.join('+');
    if (mod) expr += (mod > 0 ? '+' : '') + mod;
    $('diceExpr').value = expr;
}

function onDieClick(e) {
    var b = e.target.closest('[data-die]');
    if (!b) return;
    var d = parseInt(b.dataset.die, 10);
    if (e.shiftKey) { roll('1d' + d, '', $('diceHidden').checked); return; }
    dicePool[d] = (dicePool[d] || 0) + 1;
    renderDiceButtons();
    buildTrayExpr();
}

function toggleAdv(mode) {
    advMode = advMode === mode ? '' : mode;
    if (advMode && !dicePool[20]) dicePool[20] = 1;
    renderDiceButtons();
    buildTrayExpr();
}

function clearTray() {
    dicePool = {};
    advMode = '';
    $('diceMod').value = 0;
    $('diceExpr').value = '';
    $('diceLabel').value = '';
    renderDiceButtons();
}

function rollFromTray() {
    var expr = $('diceExpr').value.trim();
    if (!expr) { notice('先选择骰子或输入表达式', true); return; }
    roll(expr, $('diceLabel').value.trim(), $('diceHidden').checked);
    dicePool = {};
    advMode = '';
    renderDiceButtons();
}

function roll(expr, label, hidden) {
    op({ op: 'roll', expr: expr, label: label || '', hidden: !!hidden });
}

function sendChat() {
    var text = $('chatInput').value.trim();
    if (!text) return;
    var m = text.match(/^\/(r|roll|gr)\s+(\S+)\s*(.*)$/i);
    if (m) roll(m[2], m[3], m[1].toLowerCase() === 'gr');
    else op({ op: 'chat', text: text });
    $('chatInput').value = '';
}

function macroKey() { return 'ttMacros:' + roomId; }
function loadMacros() { try { return JSON.parse(localStorage.getItem(macroKey())) || []; } catch (e) { return []; } }

function renderMacros() {
    var list = loadMacros();
    $('macroList').innerHTML = list.map(function(m, i) {
        return '<span class="macro" title="' + escapeHtml(m.expr) + '"><span data-macro="' + i + '">' + escapeHtml(m.name) + '</span><i data-delmacro="' + i + '">✕</i></span>';
    }).join('') + '<button class="tt-btn small" id="addMacroBtn" title="把当前表达式保存为快捷骰（只保存在本浏览器）">+ 快捷骰</button>';
}

function onMacroClick(e) {
    var list = loadMacros(), t = e.target;
    if (t.id === 'addMacroBtn') {
        var expr = $('diceExpr').value.trim();
        if (!expr) { notice('先在上方输入要保存的表达式', true); return; }
        var name = prompt('快捷骰名称（如：长剑攻击）：', $('diceLabel').value.trim() || expr);
        if (!name) return;
        list.push({ name: name.slice(0, 20), expr: expr });
    } else if (t.dataset.macro) {
        var m = list[parseInt(t.dataset.macro, 10)];
        if (m) roll(m.expr, m.name, $('diceHidden').checked);
        return;
    } else if (t.dataset.delmacro) {
        list.splice(parseInt(t.dataset.delmacro, 10), 1);
    } else return;
    localStorage.setItem(macroKey(), JSON.stringify(list));
    renderMacros();
}

// ===== 记录 =====
function userColor(name) {
    for (var i = 0; i < users.length; i++) if (users[i].name === name) return users[i].color;
    return '#ccc';
}

function rollHtml(r) {
    var crit = false, fumble = false;
    var detail = r.terms.map(function(t, i) {
        var op = i === 0 ? (t.sign < 0 ? '-' : '') : (t.sign < 0 ? ' - ' : ' + ');
        if (!t.sides) return op + t.value;
        var dice = t.rolls.map(function(d) {
            var cls = d.v === t.sides ? 'max' : d.v === 1 ? 'min' : '';
            if (t.sides === 20 && !d.d) { if (d.v === 20) crit = true; if (d.v === 1) fumble = true; }
            var s = cls ? '<span class="' + cls + '">' + d.v + '</span>' : String(d.v);
            if (d.x) s += '!';
            return d.d ? '<s>' + d.v + '</s>' : s;
        }).join(', ');
        return op + '[' + dice + ']';
    }).join('');
    var cls = crit && !fumble ? 'crit' : fumble && !crit ? 'fumble' : '';
    return '<div class="log-roll"><span class="expr">' + escapeHtml(r.expr) + '</span> → <span class="detail">' + detail +
        '</span> = <span class="total ' + cls + '">' + r.total + '</span></div>';
}

function logHtml(e) {
    var time = '<span class="time">' + escapeHtml((e.t || '').slice(11, 16)) + '</span>';
    var who = '<span class="who" style="color:' + escapeHtml(userColor(e.who)) + '">' + escapeHtml(e.who) + '</span>';
    if (e.kind === 'sys') return '<div class="log-entry sys">' + escapeHtml(e.who) + ' ' + escapeHtml(e.text) + time + '</div>';
    if (e.kind === 'chat') return '<div class="log-entry">' + who + time + '<div>' + escapeHtml(e.text) + '</div></div>';
    var h = '<div class="log-entry">' + who + (e.label ? '<span class="label">' + escapeHtml(e.label) + '</span>' : '') +
        (e.hidden ? '<span class="hidden-tag">暗骰</span>' : '') + time;
    h += e.roll ? rollHtml(e.roll) : '<div class="tt-hint">' + escapeHtml(e.text || '') + '</div>';
    return h + '</div>';
}

function renderLog() {
    var el = $('logList');
    el.innerHTML = logEntries.map(logHtml).join('');
    el.scrollTop = el.scrollHeight;
}

function appendLog(e, live) {
    var el = $('logList');
    var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.insertAdjacentHTML('beforeend', logHtml(e));
    if (atBottom || e.who === me.name) el.scrollTop = el.scrollHeight;
    if (live && e.kind === 'roll') showRollToast(e);
}

function showRollToast(e) {
    var t = document.createElement('div');
    t.className = 'roll-toast';
    t.innerHTML = '🎲 <span style="color:' + escapeHtml(userColor(e.who)) + '">' + escapeHtml(e.who) + '</span> ' +
        escapeHtml(e.label || '') + (e.roll ? ' <span class="tt-hint">' + escapeHtml(e.roll.expr) + '</span><b>' + e.roll.total + '</b>' : ' 进行了一次暗骰');
    $('rollToasts').appendChild(t);
    setTimeout(function() { t.remove(); }, 4000);
}

// ===== 侧栏 =====
function switchPane(name) {
    document.querySelectorAll('.side-tab').forEach(function(t) { t.classList.toggle('active', t.dataset.pane === name); });
    document.querySelectorAll('.side-pane').forEach(function(p) { p.classList.toggle('active', p.id === 'pane-' + name); });
}

function toggleSide() {
    $('side').classList.toggle('collapsed');
    resizeCanvas();
}

// ===== 初始化 =====
function init() {
    canvas = $('board');
    ctx = canvas.getContext('2d');
    fogCanvas = document.createElement('canvas');
    fctx = fogCanvas.getContext('2d');
    visCanvas = document.createElement('canvas');
    vctx = visCanvas.getContext('2d');
    exCanvas = document.createElement('canvas');
    exCtx = exCanvas.getContext('2d');

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', function(e) { e.preventDefault(); });
    canvas.addEventListener('dblclick', function(e) {
        if (polyDraft) { finishPoly(); return; }
        if (wallDraft) { finishWall(); return; }
        if (tool !== 'select') return;
        var s = eventPos(e), hit = hitTest(toWorld(s.x, s.y), ['token']);
        if (hit && hit.sheet && sheets[hit.sheet]) openSheet(hit.sheet, hit.id);
    });
    $('stage').addEventListener('dragover', onDragOver);
    $('stage').addEventListener('dragleave', function() { $('stage').classList.remove('drop-hover'); });
    $('stage').addEventListener('drop', onDrop);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', function() { spaceDown = false; });
    window.addEventListener('resize', resizeCanvas);

    $('toolbar').addEventListener('click', function(e) {
        var b = e.target.closest('[data-tool]');
        if (b) setTool(b.dataset.tool);
    });
    $('swatches').innerHTML = SWATCHES.map(function(c) {
        return '<span class="swatch" data-color="' + c + '" style="background:' + c + ';display:inline-block;vertical-align:middle;margin:0 2px;"></span>';
    }).join('');
    $('optsDraw').addEventListener('click', function(e) {
        if (e.target.dataset.shape) drawOpts.shape = e.target.dataset.shape;
        if (e.target.dataset.color) drawOpts.color = e.target.dataset.color;
        syncToolOpts();
    });
    $('drawColor').addEventListener('input', function() { drawOpts.color = this.value; syncToolOpts(); });
    $('drawWidth').addEventListener('change', function() { drawOpts.width = parseFloat(this.value); });
    $('drawFill').addEventListener('change', function() { drawOpts.fill = this.checked; });
    $('optsFog').addEventListener('click', function(e) {
        if (e.target.dataset.fogmode) fogOpts.mode = e.target.dataset.fogmode;
        if (e.target.dataset.fogshape) {
            fogOpts.shape = e.target.dataset.fogshape;
            polyDraft = null;
            if (fogOpts.shape !== 'select') selectOnly([]);
            updateCursor();
        }
        syncToolOpts();
        requestRender();
    });
    syncToolOpts();
    $('optsWall').addEventListener('click', function(e) {
        var b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.walltype) { wallOpts.type = b.dataset.walltype; wallOpts.mode = 'draw'; }
        if (b.dataset.wallmode) wallOpts.mode = b.dataset.wallmode;
        finishWall();
        if (wallOpts.mode === 'draw') selectOnly([]);
        syncWallOpts();
        updateCursor();
    });
    syncWallOpts();

    $('selPanel').addEventListener('change', onSelPanelChange);
    $('selPanel').addEventListener('click', onSelPanelClick);
    $('selPanel').addEventListener('pointerdown', function(e) { e.stopPropagation(); });

    $('assetGrid').addEventListener('click', onAssetClick);
    $('assetGrid').addEventListener('dragstart', function(e) {
        var card = e.target.closest('[data-asset]');
        if (card) e.dataTransfer.setData('text/tt-asset', card.dataset.asset);
    });
    $('assetFilter').addEventListener('click', function(e) {
        var b = e.target.closest('[data-filter]');
        if (!b) return;
        assetFilter = b.dataset.filter;
        this.querySelectorAll('[data-filter]').forEach(function(x) { x.classList.toggle('active', x === b); });
        renderAssets();
    });
    $('sceneList').addEventListener('click', onSceneClick);
    document.querySelector('.side-tabs').addEventListener('click', function(e) {
        var t = e.target.closest('[data-pane]');
        if (t) switchPane(t.dataset.pane);
    });

    $('diceBtns').addEventListener('click', onDieClick);
    $('diceMod').addEventListener('input', function() { if (Object.keys(dicePool).length) buildTrayExpr(); });
    $('diceExpr').addEventListener('keydown', function(e) { if (e.key === 'Enter') rollFromTray(); });
    $('chatInput').addEventListener('keydown', function(e) { if (e.key === 'Enter') sendChat(); });
    $('macroList').addEventListener('click', onMacroClick);
    renderDiceButtons();

    $('roomList').addEventListener('click', function(e) {
        var b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.join) enterRoom(b.dataset.join);
        if (b.dataset.del) deleteRoom(b.dataset.del, b.dataset.name);
    });
    $('nickInput').addEventListener('change', saveNickname);
    $('newRoomName').addEventListener('keydown', function(e) { if (e.key === 'Enter') createRoom(); });
    $('doorPassword').addEventListener('keydown', function(e) { if (e.key === 'Enter') doDoorVerify(); });
    $('loginPassword').addEventListener('keydown', function(e) { if (e.key === 'Enter') doLogin(); });

    bindSettings();
    initSheets();
    initAuth();
}

init();
