# Infra Manager — Design Spec
_2026-06-29_

## 1. 项目概述

自托管基础设施管理 Web UI，运行在 Linux 服务器上，类似 Portainer。

- **后端**：Go，单二进制
- **前端**：SolidJS + Tailwind CSS + Vite
- **实时通信**：WebSocket（日志/终端/stats/事件）
- **文件传输**：HTTP chunked streaming（全程 pipe，不缓冲）

---

## 2. 整体架构

```
[Browser] ←── REST / WebSocket ──→ [Go Server :8080]
                                          │
                                 ┌────────┼────────┐
                            Docker SDK  JSON文件  FileSystem
                            (unix sock) /data/     (config)
```

### 目录结构

**后端：**
```
cmd/server/
internal/
  api/
    docker/        ← container / image / network / volume / compose / events
    config/        ← 配置文件管理
    auth/          ← 登录、用户、角色
  docker/
    container/
    image/
    network/
    volume/
    compose/
    events/
  config/
  auth/            ← JWT、bcrypt、RBAC
  ws/              ← WebSocket hub
  models/
```

**前端：**
```
web/src/
  components/
    docker/
      containers/  ← 列表、详情、终端、日志、文件
      images/
      compose/
      networks/
      volumes/
      events/
    config/        ← 文件树 + 编辑器
    auth/
    shared/        ← 布局、侧边栏、通用组件
  api/             ← fetch + WebSocket 封装
  stores/          ← SolidJS store
```

### 依赖选型

| 用途 | 选择 |
|---|---|
| HTTP 路由 | `chi` |
| WebSocket | `gorilla/websocket` |
| Docker SDK | `docker/docker` (官方 Go SDK) |
| 持久化 | JSON 文件（`/data/config.json`） |
| 前端路由 | `@solidjs/router` |
| 代码编辑器 | CodeMirror 6 |
| 终端 | xterm.js |
| docker run ↔ compose 转换 | `composerize` + `decomposerize`（npm，前端执行） |

---

## 3. 数据持久化

无数据库，全部用文件：

```
/data/
  config.json     ← 用户/角色/compose项目注册/镜像仓库凭证
  audit.log       ← 操作审计，每行一条 JSON（append-only）
  certs/          ← 预留：多主机 TLS 证书
```

**config.json 结构：**
```json
{
  "users": [{ "id": "", "username": "", "password_hash": "", "role": "" }],
  "roles": ["admin", "operator", "viewer"],
  "compose_projects": [{ "id": "", "name": "", "base_dir": "", "compose_file": "", "env_file": "" }],
  "registries": [{ "id": "", "url": "", "username": "", "password_enc": "" }]
}
```

**audit.log 格式：**
```json
{"time":"2026-06-29T12:00:00Z","user":"admin","action":"container.stop","target":"nginx","result":"ok"}
```

读写加文件锁，并发安全。

---

## 4. 认证 & 权限

**JWT**：Access token 24h 有效，无 refresh token（小项目重登录可接受）。

**角色：**

| 角色 | 权限 |
|---|---|
| `admin` | 全部，含用户管理、审计日志 |
| `operator` | 全部 Docker/Compose/配置操作 |
| `viewer` | 只读 GET + 日志/事件 WebSocket，无终端 |

---

## 5. API 路由

### 认证
```
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me
```

### 用户管理（admin）
```
GET/POST        /api/users
GET/PUT/DELETE  /api/users/:id
```

### 容器
```
GET    /api/containers
POST   /api/containers                      ← 创建（完整 HostConfig 参数）
GET    /api/containers/:id
DELETE /api/containers/:id
POST   /api/containers/:id/start
POST   /api/containers/:id/stop
POST   /api/containers/:id/restart
POST   /api/containers/:id/pause
POST   /api/containers/:id/unpause
POST   /api/containers/:id/kill
POST   /api/containers/:id/rename
POST   /api/containers/:id/duplicate        ← 复制（可指定模版）
POST   /api/containers/:id/upgrade          ← pull 新镜像 + 重建
PUT    /api/containers/:id/resources        ← 热更新资源限制
GET    /api/containers/:id/inspect
GET    /api/containers/:id/export           ← 流式 tar 导出
POST   /api/containers/import               ← 流式导入
GET    /api/containers/:id/files            ← 列目录（?path=）
GET    /api/containers/:id/files/download   ← 流式文件下载（?path=）
POST   /api/containers/:id/files/upload     ← 流式文件上传（?path=）

WS     /ws/containers/:id/logs
WS     /ws/containers/:id/terminal          ← operator+ 才能连
WS     /ws/containers/:id/stats
```

### 镜像
```
GET    /api/images
GET    /api/images/:id
DELETE /api/images/:id
GET    /api/images/:id/inspect
GET    /api/images/:id/history
POST   /api/images/pull
POST   /api/images/:id/tag
DELETE /api/images/:id/tags/:tag
GET    /api/images/:id/save                 ← 流式导出
POST   /api/images/load                     ← 流式导入
```

### 网络
```
GET    /api/networks
POST   /api/networks                        ← 含 macvlan/ipvlan 参数
GET    /api/networks/:id
DELETE /api/networks/:id
GET    /api/networks/:id/inspect
POST   /api/networks/:id/connect
POST   /api/networks/:id/disconnect
```

### 存储卷
```
GET    /api/volumes
POST   /api/volumes
GET    /api/volumes/:id
DELETE /api/volumes/:id
GET    /api/volumes/:id/inspect
GET    /api/volumes/:id/files               ← 浏览内容（?path=）
```

### Compose
```
GET    /api/compose
POST   /api/compose                         ← 注册项目
GET    /api/compose/:id
DELETE /api/compose/:id
POST   /api/compose/:id/up
POST   /api/compose/:id/down
POST   /api/compose/:id/pull
POST   /api/compose/:id/restart
GET    /api/compose/:id/file                ← 读取 YAML
PUT    /api/compose/:id/file                ← 保存 YAML

WS     /ws/compose/:id/logs
```

### 镜像仓库
```
GET/POST        /api/registries
DELETE          /api/registries/:id
POST            /api/registries/:id/test    ← 测试连接
```

### Docker 事件
```
WS     /ws/events
```

### 配置文件管理
```
GET    /api/config/files                    ← 目录列表（?path=）
GET    /api/config/files/content            ← 读文件（?path=）
PUT    /api/config/files/content            ← 写文件（?path=）
```

### 审计日志（admin）
```
GET    /api/audit                           ← 分页查询
```

> **注**：无 `/api/convert/*` 端点，docker run ↔ compose 转换全在前端由 `composerize`/`decomposerize` 完成。

---

## 6. 实时通信 & 流式传输

### WebSocket 端点（各自独立连接）

| 端点 | 方向 | 用途 |
|---|---|---|
| `/ws/containers/:id/logs` | 服务器→客户端 | 容器日志流 |
| `/ws/containers/:id/terminal` | 双向 | exec 终端 (xterm.js) |
| `/ws/containers/:id/stats` | 服务器→客户端 | CPU/内存/网络实时数据 |
| `/ws/compose/:id/logs` | 服务器→客户端 | Compose 服务日志流 |
| `/ws/events` | 服务器→客户端 | Docker 全局事件 |

### HTTP 流式传输原则

所有文件/镜像/容器的上传、下载、导入、导出均为流式：
- 后端：`io.Copy(responseWriter, dockerSDKStream)`，不在内存中缓冲
- 前端：`fetch` + `ReadableStream`，显示进度，不等待完整响应

---

## 7. 前端页面结构

### 导航（侧边栏）
```
容器 / 镜像 / Compose / 网络 / 存储卷 / 事件 / 配置文件
设置 → 用户管理 / 镜像仓库 / 审计日志
```

### 共享组件：`<RunComposeEditor>`

所有涉及 docker run / compose.yaml 的窗口使用同一个双窗口组件，只有操作按钮因场景不同：

```
┌─────────────────────┬─────────────────────┐
│  docker run 命令     │   compose.yaml       │
│  (CodeMirror, 可编辑)│  (CodeMirror, 可编辑)│
│  编辑 → 实时同步 →  │  ← 实时同步 ← 编辑  │
└─────────────────────┴─────────────────────┘
              [ 操作按钮区（由调用方注入） ]
```

- 左侧编辑 → `composerize` → 更新右侧
- 右侧编辑 → `decomposerize` → 更新左侧
- 转换在前端实时执行，无网络请求

**各场景操作按钮：**

| 场景 | 操作按钮 |
|---|---|
| 容器列表「启动命令」 | 复制 docker run / 复制 compose / 关闭 |
| 创建容器（粘贴解析入口） | 「解析并进入表单」 |
| 容器详情「显示命令」 | 复制 docker run / 复制 compose / 关闭 |
| Compose 详情「转换视图」 | 多服务：右侧完整 compose，左侧每服务一条 docker run；复制 / 关闭 |
| 独立转换工具页 | 复制 |

---

### 容器列表页

**表格列：**
```
[名称 + ID]   [镜像]         [状态]   [网络 + 端口]   [挂载点]   [命令]   [创建时间]
[CPU / 内存]  (第二行，实时)
```

**批量操作**（多选触发）：新建 / 启动 / 停止 / 强制关闭(kill) / 删除 / 导出 / 转为 Compose

**每行快捷操作**：启动 / 停止 / 终端 / 日志 / 详情 / 显示命令

**「显示命令」**：打开 `<RunComposeEditor>`，操作按钮为「复制 docker run / 复制 compose / 关闭」

**「新建容器」入口支持三种模式**（Modal 内 Tab 切换）：
1. 分步表单（可选已有容器为模版，自动填充所有参数）
2. 粘贴 docker run → `<RunComposeEditor>` → 点击「解析并进入表单」
3. 粘贴 compose.yaml → `<RunComposeEditor>` → 选择服务 → 点击「解析并进入表单」

**创建表单参数覆盖完整 HostConfig：**
基础（名称/镜像/重启策略）/ 网络（模式/IP/别名/端口）/ 存储（volumes/binds/tmpfs）/ 环境变量+标签 / 高级（capabilities/devices/sysctls/运行时/healthcheck/user/hostname/DNS/安全选项/特权模式/只读 rootfs/…）

### 容器详情页（Tab 布局）

| Tab | 内容 |
|---|---|
| 概览 | inspect 信息展示 |
| 日志 | WebSocket 流式，搜索/时间戳/过滤 |
| 终端 | xterm.js，支持全屏 |
| 统计 | CPU/内存/网络/磁盘实时图表 |
| 文件 | 容器内文件树，上传/下载/预览（全流式） |
| 编辑 | 资源限制/环境变量热更新 |

### Compose 详情页

- 服务列表 + 各服务状态
- 每个服务「查看命令」→ 弹出该服务 docker run 命令
- 整体/单服务 up/down/restart/pull 按钮
- YAML 编辑器（CodeMirror，yaml 语法高亮），直接保存到磁盘
- 日志面板（WebSocket，可按服务过滤）
- 「转换视图」：展示所有服务对应的 docker run 集合（`decomposerize`）

### 配置文件页

- 左：文件树（根路径可在设置中配置）
- 右：CodeMirror 编辑器，按扩展名自动选择语法高亮

### 前端状态管理

- 每类资源一个 SolidJS store（`createStore`）
- WebSocket 连接生命周期绑定组件，组件卸载时断开
- 列表页 5 秒轮询兜底（WebSocket 断线时保底更新）

---

## 8. 多主机扩展预留

当前：单主机，后端直连本机 Docker unix socket。

预留：
- `config.json` 中 `hosts` 数组已预留
- `/data/certs/` 目录用于存放远程主机 TLS 证书
- Docker client 初始化封装成工厂函数，后续切换 host 只需改参数
