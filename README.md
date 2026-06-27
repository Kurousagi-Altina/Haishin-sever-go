# 直播平台 - Live Broadcast Platform

基于 Go 后端 + 纯前端的前后端分离直播平台，集成 ZLMediaKit 流媒体服务，支持双通道鉴权（门禁口令 + 用户账号）、用户注册与管理、直播间列表浏览、FLV 直播流播放、云盘文件上传/下载/管理，以及基于 `action_logs` 的全量操作行为记录与管理后台。

## 项目架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        浏览器 (Frontend)                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ 门禁口令  │  │ 用户登录  │  │ 频道列表  │  │ FLV 播放器│  │  云盘    │  │
│  │ (door)   │  │ (login)  │  │ (stream) │  │ (flv.js) │  │ (cloud)  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │              │             │              │              │        │
│  ┌────▼──────────────▼─────────────▼──────────────▼──────────────▼────┐  │
│  │                   admin.html (管理后台)                              │  │
│  │  概览 │ 操作记录 │ 鉴权记录 │ 观看记录 │ 用户管理                      │  │
│  └──────────────────────────────────┬─────────────────────────────────┘  │
└─────────────────────────────────────┼────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Go 后端 (Backend :80)                      │
│                                                                   │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐  │
│  │ 公开 API    │  │ 受保护 API  │  │ 管理员 API  │  │ 静态文件   │  │
│  │ /api/      │  │ /api/      │  │ /api/admin/│  │ /www/*    │  │
│  │ verify     │  │ streams    │  │ stats      │  │           │  │
│  │ register   │  │ stream-url │  │ visitors   │  │           │  │
│  │ login      │  │ me         │  │ users      │  │           │  │
│  │            │  │ cloud/*    │  │ approve    │  │           │  │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └───────────┘  │
│        │                │         └─────┬──────┘                 │
│  ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼──────────┐             │
│  │ bcrypt    │   │ ZLM API   │   │ SQLite3 数据库   │             │
│  │ 密码哈希   │   │ Proxy     │   │ action_logs     │             │
│  │ Token     │   │           │   │ auth_attempts   │             │
│  │ Manager   │   │           │   │ stream_views    │             │
│  │           │   │           │   │ users           │             │
│  └───────────┘   └─────┬─────┘   │ cloud_files     │             │
│                         │         └─────────────────┘             │
└─────────────────────────┼────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│                  ZLMediaKit 流媒体服务器                            │
│               http://47.97.153.51                                 │
│  ┌──────────────────────┐  ┌──────────────────────────────┐      │
│  │ /index/api/           │  │ /{app}/{stream}.live.flv     │      │
│  │ getMediaList          │  │ (FLV 直播流)                  │      │
│  └──────────────────────┘  └──────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────┘
```

### 鉴权体系说明

系统支持**两套鉴权通道**，可同时使用：

| 通道 | 入口 | 方式 | Token 角色 | 适用场景 |
|------|------|------|-----------|----------|
| 门禁口令 | `POST /api/verify` | 输入共享口令 | `door` | 快速访问，无需注册 |
| 用户账号 | `POST /api/login` | 用户名+密码登录 | `user` / `admin` | 注册用户，可跳过门禁口令 |

- **门禁口令用户**: 进入后仅能观看直播，无用户身份，不可访问管理后台
- **普通注册用户**: 登录后直接进入直播大厅，跳过门禁口令页面
- **管理员**: 登录后可访问管理后台 `/admin.html`，管理用户和查看所有记录

### 用户注册与审核流程

```
用户点击"注册" → 填写用户名+密码 → 提交申请(状态: pending)
                                            ↓
                              管理员在后台看到待审核申请
                                            ↓
                              ┌──── 通过 ────┴──── 拒绝 ────┐
                              ↓                              ↓
                        状态变为 active                  用户被删除
                              ↓
                      用户可正常登录使用
```

## 数据流说明

1. **门禁口令流程**: 前端发送口令 → 后端校验 → 签发 `door` 角色 Token → 记录鉴权日志 + 操作日志
2. **用户登录流程**: 前端发送用户名+密码 → 后端 bcrypt 校验 → 签发含角色 Token → 跳过门禁页面直接进入 → 记录操作日志
3. **直播列表流程**: 前端携带 Token 请求 → 后端代理转发到 ZLM API → 过滤返回唯一流列表
4. **视频播放流程**: 前端获取流地址后，直接从 ZLM 服务器拉取 FLV 流播放（不经过 Go 后端）→ 记录观看日志 + 操作日志
5. **操作日志**: 所有关键行为（验证、注册、登录、观看、上传、下载等）均通过 `action_logs` 表记录，含 IP、用户名、操作类型、详情
6. **管理员审核**: 管理员登录后台 → 查看待审核用户 → 通过/拒绝注册申请
7. **云盘文件**: 前端携带 Token 请求 → 后端列出/上传/下载/管理 `/userdata/download/` 目录中的文件，支持子目录导航（`?path=` 参数）；游客仅可下载，注册用户可上传，管理员可新建文件夹/删除/移动文件；页面展示已用/总共空间及进度条（静默扣减 4GB 预留）；文件列表回显上传者名称，上传记录持久化到 `cloud_files` 表，管理员操作文件后上传者更新为管理员

## 项目结构

```
E:\Livenetwork\
├── backend/                  # Go 后端程序
│   ├── main.go               # 入口：路由注册、服务启动
│   ├── config.go             # 配置管理（环境变量 + 运行时目录）
│   ├── db.go                 # SQLite 数据库层（建表迁移、种子数据、CRUD、action_logs）
│   ├── handler.go            # HTTP 请求处理器（公开 + 受保护 + 云盘 API）
│   ├── admin_handler.go      # 管理员 API 处理器
│   ├── middleware.go          # 中间件（Token鉴权、Admin鉴权、操作日志、CORS、日志）
│   ├── token.go              # Token 管理器（含角色/用户ID/用户名元数据）
│   ├── zlm.go                # ZLMediaKit API 客户端
│   ├── disk_unix.go          # Linux/Unix 磁盘空间查询（syscall.Statfs）
│   ├── disk_windows.go       # Windows 磁盘空间查询（stub）
│   ├── Makefile              # 构建脚本（make → build/liveserver）
│   ├── go.mod                # Go 模块定义
│   └── go.sum                # 依赖校验
├── www/                      # 前端静态资源（由 Go 后端直接托管）
│   ├── index.html            # 主页（门禁口令 + 用户登录 + 注册 + 直播大厅）
│   ├── admin.html            # 管理后台（概览/操作记录/鉴权/观看/用户管理）
│   ├── cloud.html            # 云盘页面（权限分级：游客/用户/管理员）
│   ├── icon.png              # 网站图标
│   ├── bg.webp               # 背景图片（WebP 压缩）
│   ├── css/
│   │   └── common.css        # 共享样式（毛玻璃主题、导航栏、鉴权遮罩、弹窗、滚动条）
│   └── js/
│       └── utils.js          # 共享工具函数（$、escapeHtml、escapeAttr、formatSize）
├── userdata/                 # 用户数据目录（运行时自动创建）
│   └── download/             # 云盘文件存储目录
└── README.md                 # 本文件
```

## 数据库设计

使用 SQLite3（纯 Go 驱动 `modernc.org/sqlite`），数据库文件 `data.db` 在运行时自动创建。

### visitors - 页面访问记录

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键自增 |
| ip | TEXT | 访问者 IP 地址 |
| user_agent | TEXT | 浏览器 User-Agent |
| path | TEXT | 访问路径 |
| visit_time | DATETIME | 访问时间（本地时间） |

### auth_attempts - 鉴权记录

记录所有门禁口令尝试和用户登录尝试。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键自增 |
| ip | TEXT | 尝试者 IP 地址 |
| password | TEXT | 尝试的口令或账号名 |
| success | INTEGER | 是否成功（0=失败, 1=成功） |
| attempt_time | DATETIME | 尝试时间（本地时间） |

### stream_views - 直播观看记录

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键自增 |
| ip | TEXT | 观看者 IP 地址 |
| app | TEXT | 直播应用名 |
| stream | TEXT | 直播流名 |
| view_time | DATETIME | 观看时间（本地时间） |

### users - 用户账号

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键自增 |
| username | TEXT | 用户名（唯一） |
| password_hash | TEXT | bcrypt 密码哈希 |
| role | TEXT | 角色：`admin` / `user` |
| status | TEXT | 状态：`active` / `pending` |
| created_at | DATETIME | 注册时间（本地时间） |

**种子数据**: 首次启动时自动创建管理员账号 `admin` / `krusgaltn`（密码使用 bcrypt 哈希存储）。

### cloud_files - 云盘文件上传者记录

| 字段 | 类型 | 说明 |
|------|------|------|
| filepath | TEXT | 文件相对路径（主键） |
| uploader | TEXT | 上传者用户名 |
| updated_at | DATETIME | 最后更新时间（本地时间） |

文件无记录时前端回显为 `admin`。管理员对文件执行移动/重命名操作时，上传者更新为管理员用户名。

### action_logs - 操作行为日志

统一记录所有关键操作，替代早期按请求全量记录的 visitors 表。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键自增 |
| ip | TEXT | 操作者 IP 地址 |
| username | TEXT | 关联用户名（未登录时为空） |
| action | TEXT | 操作类型：`verify` / `register` / `login` / `watch_stream` / `download` / `upload` 等 |
| detail | TEXT | 操作详情（如流名、文件名、成功/失败状态） |
| created_at | DATETIME | 操作时间（本地时间） |

- 用户登录、注册、观看直播、上传/下载文件等关键行为均写入此表
- 门禁口令验证也记录（username 为空，detail 包含成功/失败状态）
- 管理后台「操作记录」标签页从此表分页查询


## API 接口文档

### 公开接口（无需 Token）

#### POST /api/verify — 门禁口令验证

请求:
```json
{
  "password": "114514"
}
```

成功响应 (200):
```json
{
  "success": true,
  "token": "b8e98c9d86d9c1bd...",
  "role": "door"
}
```

失败响应 (401):
```json
{
  "success": false,
  "error": "口令错误"
}
```

#### POST /api/register — 用户注册

提交注册申请，状态为 pending，需管理员审核。

请求:
```json
{
  "username": "myuser",
  "password": "mypassword"
}
```

成功响应 (200):
```json
{
  "success": true,
  "message": "注册申请已提交，请等待管理员审核通过"
}
```

约束: 用户名 2-32 字符，密码至少 6 字符。

#### POST /api/login — 用户登录

仅 `status=active` 的用户可登录。

请求:
```json
{
  "username": "admin",
  "password": "krusgaltn"
}
```

成功响应 (200):
```json
{
  "success": true,
  "token": "0b5af9734f0f...",
  "username": "admin",
  "role": "admin"
}
```

失败响应 (401):
```json
{
  "success": false,
  "error": "用户名或密码错误"
}
```

> 未审核通过的用户登录会返回 "账号未审核通过或用户名密码错误"。

### 受保护接口（需要任意有效 Token）

Header: `Authorization: Bearer <token>`

#### GET /api/me — 获取当前用户信息

响应 (200):
```json
{
  "user_id": 1,
  "username": "admin",
  "role": "admin"
}
```

对于门禁口令 Token，`user_id=0, username="", role="door"`。

#### GET /api/streams — 获取直播列表

响应 (200):
```json
{
  "code": 0,
  "streams": [
    {
      "app": "live",
      "stream": "channel1",
      "totalReaderCount": 42
    }
  ]
}
```

#### GET /api/stream-url — 获取流播放地址

参数: `?app=live&stream=channel1`

响应 (200):
```json
{
  "url": "http://47.97.153.51/live/channel1.live.flv"
}
```

> 调用此接口自动记录 `stream_views`。

#### GET /api/stats — 获取访客统计（公开版）

响应 (200):
```json
{
  "total_visits": 128,
  "unique_visitors": 45,
  "auth_attempts": 60,
  "auth_success": 38,
  "stream_views": 120
}
```

#### GET /api/cloud/list?path=xxx — 获取云盘文件列表

返回指定目录内的所有文件和文件夹。

参数: `?path=subdir/nested`（可选，不传则列出根目录）

响应 (200):
```json
{
  "files": [
    {
      "name": "document.pdf",
      "size": 1048576,
      "isDir": false,
      "modTime": "2026-05-13 10:30:00",
      "uploader": "myuser"
    },
    {
      "name": "我的文件夹",
      "size": 4096,
      "isDir": true,
      "modTime": "2026-05-13 09:15:00",
      "uploader": "admin"
    }
  ],
  "path": ""
}
```

#### GET /api/cloud/download?file=xxx&path=xxx&token=xxx — 下载文件

此接口不走 AuthMiddleware，改为自行校验 Token，支持两种鉴权方式：

- Query 参数: `?token=xxx`（推荐，前端直接 `window.location` 跳转，浏览器流式下载不占内存）
- Authorization Header: `Bearer xxx`（备用）

参数: `?file=document.pdf&path=subdir&token=xxx`（`path` 可选，指定文件所在子目录）

返回文件二进制内容，响应头包含 `Content-Disposition: attachment`。

> 文件名经过路径穿越防护，仅允许下载 `/userdata/download/` 目录内的文件。

#### POST /api/cloud/upload?path=xxx — 上传文件

**权限**: 注册用户及以上（游客 `door` 角色返回 403）。

参数: `?path=subdir`（可选，上传到指定子目录）

请求: `multipart/form-data`，字段名 `file`。

限制: 单文件最大 100MB。

成功响应 (200):
```json
{
  "success": true,
  "filename": "document.pdf"
}
```

游客拒绝响应 (403):
```json
{
  "error": "游客无上传权限，请登录后操作"
}
```

#### GET /api/cloud/space — 获取磁盘空间

返回存储目录所在分区的磁盘空间信息，后端已静默扣减 4GB 系统预留。

响应 (200):
```json
{
  "total": 107374182400,
  "used": 5368709120,
  "free": 98000000000
}
```

> `total` 为分区总空间，`used` 为云盘目录实际占用大小（递归计算），`free` 为扣除 4GB 预留后的剩余可用字节。

#### POST /api/cloud/mkdir?path=xxx — 新建文件夹（admin）

请求:
```json
{
  "name": "新文件夹"
}
```

成功响应 (200):
```json
{ "success": true }
```

#### DELETE /api/cloud/delete?name=xxx&path=xxx — 删除文件/文件夹（admin）

参数: `?name=新文件夹&path=subdir`（`path` 可选，指定目标所在子目录；支持文件和文件夹删除，文件夹会递归删除）。

成功响应 (200):
```json
{ "success": true }
```

#### POST /api/cloud/move?path=xxx — 移动/重命名文件或文件夹（admin）

请求:
```json
{
  "from": "旧名称.txt",
  "to": "新名称.txt"
}
```

成功响应 (200):
```json
{ "success": true }
```

> 目标名称已存在时返回 409。

### 管理员接口（需要 admin 角色 Token）

全部以 `/api/admin/` 为前缀，非 admin 角色返回 403。

#### GET /api/admin/stats — 管理概览统计

响应格式同 `/api/stats`。

#### GET /api/admin/visitors?page=1 — 操作记录（分页）

从 `action_logs` 表分页查询，每页 50 条。返回字段：`ip`, `username`, `action`, `detail`, `created_at`。

#### GET /api/admin/auth-attempts?page=1 — 鉴权记录（分页）

每页 50 条。

#### GET /api/admin/stream-views?page=1 — 观看记录（分页）

每页 50 条。

#### GET /api/admin/users — 所有用户列表

#### GET /api/admin/pending-users — 待审核注册列表

#### POST /api/admin/approve-user — 通过注册申请

```json
{ "user_id": 2 }
```

#### POST /api/admin/reject-user — 拒绝（删除）注册申请

```json
{ "user_id": 2 }
```

#### DELETE /api/admin/users/{id} — 删除用户

不可删除 admin 角色用户。

#### POST /api/admin/change-password — 管理员修改自身密码

```json
{ "new_password": "newpass123" }
```

## 页面说明

### 主页面 (`/` — index.html)

- **顶部导航栏**: 未登录时显示"注册"和"登录"按钮；已登录时显示用户名 + 退出（管理员额外显示"管理后台"链接）
- **门禁口令弹窗**: 未登录且无缓存 Token 时显示；已登录用户自动跳过
- **注册弹窗**: 用户名 + 密码 + 确认密码，提交后等待管理员审核
- **登录弹窗**: 用户名 + 密码，成功后直接进入直播大厅
- **直播大厅**: 左侧频道列表（每 5 秒刷新），右侧 FLV 播放器
- **Token 缓存**: 用户/管理员登录 Token 存储于 localStorage（关闭浏览器不清除，3天内有效）；门禁口令不持久化，刷新页面需重新验证

### 管理后台 (`/admin.html`)

需以 admin 角色登录后访问，包含以下功能标签页：

| 标签 | 功能 |
|------|------|
| 概览 | 总操作数、独立IP、鉴权尝试/成功、直播观看次数统计卡片 |
| 操作记录 | 分页表格：IP、用户、操作类型、详情、时间 |
| 鉴权记录 | 分页表格：IP、尝试内容、成功/失败标记、时间 |
| 观看记录 | 分页表格：IP、App、Stream、时间 |
| 用户管理 | 待审核用户（通过/拒绝按钮）+ 所有用户列表（删除按钮） |

管理员可在管理后台修改自身密码。

### 云盘 (`/cloud.html`)

需鉴权后访问，支持门禁口令和用户登录两种方式。已登录用户自动跳过鉴权。权限分级：

- **游客**（门禁口令）: 仅可浏览文件列表和下载文件，无上传权限
- **注册用户**: 可浏览、下载、上传文件
- **管理员**: 除上传/下载外，还可新建文件夹、重命名文件/文件夹、删除文件/文件夹

功能包括：

- **存储空间**: 页面顶部展示「已用 X / 总共 Y」+ 进度条 + 右侧「剩余 Z」，后端静默扣减 4GB 系统预留
- **面包屑导航**: 文件列表上方显示路径层级，点击可快速跳转到任意父级目录
- **文件夹双击进入**: 文件夹行支持双击进入子目录，带有光标悬停效果和「进入」按钮
- **文件列表**: 表格展示文件名（文件夹/文件图标区分）、上传者、大小（文件夹显示 `-`）、修改时间，支持刷新。无记录的文件回显为 `admin`
- **文件下载**: 直接将带 Token 的下载 URL 交给浏览器处理，流式写入磁盘，不受文件大小限制
- **文件上传**: 注册用户及以上可用，选择本地文件后上传至当前目录，单文件最大 100MB
- **管理员操作**: 新建文件夹（输入名称即可）、重命名（弹窗输入新名称，调用 move API）、删除（确认弹窗后删除，支持文件和文件夹）
- **鉴权门禁**: 未登录用户可通过门禁口令或用户登录两个标签页进行身份验证

## 配置说明

程序启动时按优先级加载配置：**`config.json` > 环境变量 > 默认值**。首次启动若目录下无 `config.json`，会自动创建含默认值的配置文件。

参照 `backend/config.example.json` 编辑 `config.json`：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `server_addr` | `:80` | Go 后端监听地址 |
| `zlm_base_url` | `http://47.96.99.181:8080` | ZLMediaKit 服务器地址 |
| `zlm_secret` | `035c73f7-...` | ZLM API 密钥 |
| `admin_password` | `114514` | 门禁共享口令 |
| `db_path` | `./data.db` | SQLite 数据库文件路径 |
| `static_dir` | `../www` | 前端静态资源目录 |
| `token_expiry` | `72h` | Token 有效期，支持 Go duration 格式（`72h`、`2h30m`）或纯秒数（`259200`） |
| `download_dir` | `../userdata/download` | 云盘文件存储目录 |
| `game_dir` | `../game` | 游戏文件目录 |
| `video_dir` | `../userdata/videos` | VOD 视频文件目录 |
| `cloud_upload_min_role` | `user` | 云盘上传最低角色：`admin`（仅管理员）、`user`（注册用户及以上）、`door`（所有人含游客） |

环境变量名称为配置项的蛇形大写形式（如 `SERVER_ADDR`、`CLOUD_UPLOAD_MIN_ROLE`），可覆盖配置文件中的值。

> 管理员账号 `admin` / `krusgaltn` 在首次启动时写入数据库，后续启动不会重复创建。如需重置，删除 `data.db` 后重启即可。

## 运行部署

### 前置条件

- Go 1.21+（已测试 1.26.1）
- 不需要安装 GCC（使用纯 Go SQLite 驱动 `modernc.org/sqlite`）
- ZLMediaKit 流媒体服务器（需提前部署）

### 本地开发

```bash
# 进入后端目录
cd backend

# 安装依赖（含 bcrypt + pure Go SQLite）
go mod tidy

# 运行（开发模式）
go run .

# 编译
go build -o server.exe .

# 自定义配置运行（环境变量覆盖 config.json）
SERVER_ADDR=:9090 go run .
```

启动后：
- 主页: `http://localhost:80`
- 管理后台: `http://localhost:80/admin.html`

### 生产部署

```bash
# 编译 Linux amd64 精简二进制（输出到 build/liveserver）
cd backend
make

# 或手动编译
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o build/liveserver .

# 复制配置模板并编辑
cp config.example.json config.json
vim config.json

# 运行
./build/liveserver
```

建议配合 systemd (Linux) 或 NSSM (Windows) 将程序注册为系统服务。

## 前后端职责划分

| 功能 | 原实现 | 新实现 |
|------|--------|--------|
| 门禁口令校验 | 前端 `prompt()` 明文比对，密码硬编码在 HTML | 后端 `POST /api/verify` 服务端校验，Token 机制 |
| 用户注册与管理 | 无 | 用户注册 → 管理员审核 → bcrypt 密码哈希存储 |
| 用户登录 | 无 | `POST /api/login` → 含角色 Token → 免门禁口令 |
| 流列表获取 | 前端直接调用 ZLM API，API Secret 暴露 | 后端代理转发，Secret 仅存于后端 |
| 流地址获取 | 前端拼接硬编码的服务器 IP | 后端 `/api/stream-url` 动态返回 |
| 视频播放 | 前端 flv.js 直连 ZLM | 不变，前端仍直连 ZLM 拉流 |
| 访客记录 | 无 | `action_logs` 表按关键操作记录（验证/注册/登录/观看/上传/下载），管理后台分页查询 |
| 管理后台 | 无 | `/admin.html` 管理员面板，完整数据查询（操作/鉴权/观看记录）与用户管理 |
| 云盘文件 | 无 | `/cloud.html` 鉴权页面，权限分级（游客仅下载、用户可上传、管理员可管理），支持上传者追踪（`cloud_files` 表），大文件流式下载，后端 `/api/cloud/*` 含上传/下载/列表/空间/新建文件夹/删除/移动 |
| 前端架构 | 各页面独立内联样式 | 共享 `css/common.css`（毛玻璃主题 + 通用组件）+ `js/utils.js`（工具函数 + XSS 防护），背景图 WebP 压缩 |

## 技术栈

- **后端**: Go 标准库 `net/http` + `golang.org/x/crypto/bcrypt` + `modernc.org/sqlite`（纯 Go SQLite 驱动，无 CGO 依赖）
- **前端**: 原生 HTML/CSS/JS（无框架依赖，兼容性好）+ [flv.js](https://github.com/bilibili/flv.js) 播放器
- **流媒体**: ZLMediaKit (RTMP/FLV/HLS)
- **数据库**: SQLite3 (WAL 模式)
- **密码安全**: bcrypt 哈希（Cost=10）
