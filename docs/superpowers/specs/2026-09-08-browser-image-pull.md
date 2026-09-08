# 浏览器侧流式拉取镜像（browser-pull）设计

状态：设计已批准，待实现（2026-09-08）。

关联文档：

- [服务端代理拉取方案](2026-09-08-compose-image-pull-proxy.md)（同源问题域，互补路径）

## 1. 背景与目标

服务端代理方案解决的是「phyless 进程能经代理访问 registry，但 daemon 不能改全局代理」。
但存在另一类环境：**phyless 服务端与 Docker daemon 都无法访问 registry，只有用户浏览器能上网**。

本方案让浏览器成为下载通路：浏览器经用户自建的 Cloudflare Worker（CORS 代理）下载镜像，
边下边组装 `docker load` 兼容的 tar，经 WebSocket 顺序流式推给 phyless，后端
`io.Pipe → ImageLoad` 灌进 daemon。目标：

1. **全程不落盘**：浏览器不写 OPFS/磁盘、不整包缓冲；服务端不写中间 tar；内存有界（同时最多驻留一层的传输窗口，靠背压约束）。
2. **顺序流式**：tar 是严格顺序格式，按 config → 各 layer（manifest 顺序）→ 小元数据 → trailer 依次发射，不并行下载 layer。
3. **凭据不进服务端**：私有镜像凭据只经 浏览器 → CF worker → registry；可存浏览器 `localStorage`，绝不发给 phyless。
4. **与服务端代理并存**：作为 Pull 选项里的一种「下载方式」，共用同一套共享 UI 与全局任务队列。
5. **WS/API 局部失败只影响对应任务**，错误脱敏并节流提示，不阻塞页面主体。

「不落盘」范围是浏览器与 phyless 应用侧；Docker daemon 自身解包/存镜像是其正常行为。

## 2. 为什么是 WebSocket

浏览器要把浏览器组装的 tar 流式推给 phyless，只有以下几条路，权衡后选 WebSocket：

| 方式 | 纯 HTTP 可行 | 真流式 | 浏览器不落盘 | 内存有界 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `fetch` 请求体传 `ReadableStream`（`duplex:'half'`） | 否（需 HTTP/2，即 TLS） | 是 | 是 | 是 | phyless 当前是纯 HTTP/1.1（`cmd/server/main.go` `ListenAndServe`），不可行 |
| 内存拼整包 Blob + XHR 上传 | 是 | 否 | 是 | 否（整压缩镜像驻留内存） | 大镜像 OOM，放弃 |
| OPFS 暂存后 XHR 上传（参考项目做法） | 是 | 否 | **否（用浏览器磁盘）** | 是 | 违反不落盘，放弃 |
| **WebSocket 二进制帧流式** | 是 | 是 | 是 | 是（帧→`io.Pipe` 背压） | **选用** |

WebSocket 走 HTTP/1.1 Upgrade，不需要 TLS/H2；单连接帧按序到达（RFC 6455）；
phyless 已有 WS 基建（logs/stats/terminal/compose-logs），复用鉴权与进度模式。

## 3. 适用范围（v1）

- 单镜像拉取：镜像页「拉取」。
- Compose：**预加载 + 本地编排**（见 §7）。
- 仅 tag 引用、仅 Linux 单平台。
- layer 压缩格式 gzip / zstd / 未压缩一律**原样透传**（不在浏览器解压），拒 foreign/non-distributable 层。

「下载方式」开关由 `PullOptions` 的 `allowBrowser` 显式开启，只有真正接管 browser-pull 任务的入口才亮出它。

**明确不做（v1）**：容器创建/升级入口的浏览器下载（沿用「预加载 + 本地动作」模式，作为后续；当前这些入口只有服务端代理）、digest（`@sha256:`）引用、all-tags、含 `build` 的 compose 服务、浏览器侧解压/预览层内容、并行 layer 下载、TLS/H2 的 `fetch` 流式方案。

## 4. CF Worker（`cloudflare-worker/registry-proxy.js`）

参考 `docker-save-browser` 的 `?url=` CORS 代理的精简优化版。仅提供 JS，由使用者自行部署到 Cloudflare Worker。

行为：

- 仅 `GET`/`HEAD`/`OPTIONS`；其余 405。
- 双白名单：`ALLOWED_ORIGINS`（请求 Origin）与 `UPSTREAM_ALLOWLIST`（目标 host，支持 `*.suffix`）；缺 Origin 默认拒绝（`ALLOW_MISSING_ORIGIN` 可放开）；`ALLOW_ANY_UPSTREAMS=true` 或 `UPSTREAM_ALLOWLIST=*` 放开上游。
- 转发头：`accept, authorization, cache-control, content-type, if-modified-since, if-none-match, range`。
- 暴露头：`Accept-Ranges, Content-Encoding, Content-Length, Content-Range, Content-Type, Docker-Content-Digest, WWW-Authenticate`（token dance 与 blob 下载需要）。
- 响应 `Cache-Control: no-store`、`Vary: Origin`；`redirect: follow`（blob 常 302 到对象存储）；流式透传 `upstream.body`。

优化点（相对参考实现）：常量表集中、配置解析单次缓存、默认拒绝更严、去掉与本项目无关的分支。附 wrangler 环境变量说明（README 片段），不含 CI/wrangler.jsonc（部署方自理）。

## 5. 前端组件

所有新代码遵循「共享实现，不做每页副本」；所有写操作作为任务进入全局任务队列并在右侧抽屉展示。

### 5.1 registry 客户端 `web/src/api/registryPull.ts`

输入：`ref`（tag）、`platform`、`workerUrl`、可选 `creds`。

- 经 worker 请求 manifest：`GET {workerUrl}?url={registryUrl}`。
- token dance：401 → 解析 `WWW-Authenticate`（`realm`/`service`/`scope`）→ 经 worker 取 token（私有镜像带 `Authorization: Basic`）→ 用 `Bearer` 重试。
- 解析 manifest：manifest list/index → 按 `platform` 选单镜像 manifest；拿 config 描述符（含 digest/size）与 layer 描述符列表（digest/size/mediaType）。
- 校验（对齐服务端 §7）：拒 digest-only ref、all-tags；manifest/config 限 16 MiB；OS 必须 linux；拒 foreign/non-distributable 层媒体类型。
- config blob 直接下载进内存（≤16 MiB），layer 保持流式（后续按需 fetch）。
- **up-to-date 预检**：下载 layer 前用现有 inspect（`web/src/api/inspect.ts`）查本地 tag，若本地 image ID == 远端 config digest 则跳过，返回「已是最新」。

输出：`{ repoTag, config:{hex,size,bytes}, layers:[{hex,size,mediaType,url}], manifestBytes, authHeader }`。

### 5.2 docker-load tar 组装 `web/src/api/dockerTar.ts`

极简 USTAR 流式写入器，产出 `ReadableStream<Uint8Array>`，按序发：

1. `blobs/sha256/<configHex>`（config JSON 字节，已在内存）
2. 每个 layer：`blobs/sha256/<layerHex>` —— 头里写死 `layer.size`，随后经 worker `fetch(layer.url, {headers:{Authorization:authHeader}})` 把响应体**原样**灌进 tar（不解压）。**边灌边计数，实际字节 ≠ 声明 size 立即中止**。
3. `manifest.json`（`[{Config, RepoTags, Layers}]`，路径均为 `blobs/sha256/<hex>`）、`oci-layout`、`index.json`、`repositories`（沿用 `docker load` 兼容布局）。
4. 512×2 全零 trailer。

USTAR 头处理长路径（name/prefix 拆分）、八进制字段、checksum。写入器只做写路径，不含参考项目的解析/预览逻辑。

### 5.3 WS 流式上传 `web/src/api/imageLoadStream.ts`

- 连 `ws(s)://…/ws/images/load?token=<jwt>`（协议按页面 http/https 决定 ws/wss）。
- 读 §5.2 的 `ReadableStream`：按 `socket.bufferedAmount` 做背压（高于阈值时暂停读取上游），逐块 `socket.send(chunk)`。
- 收 daemon 进度：text 帧（NDJSON），解析 `error/errorDetail` 判失败。
- 完成：tar 写完后发一个「输入结束」信号（关闭 socket 的 write 侧或发约定的结束帧，见 §6）。
- 取消/错误：abort 上游 fetch + close socket + 传播错误。

### 5.4 任务队列集成 `web/src/stores/taskQueue.ts`

- 新增任务类型 `browser-pull`（单镜像）与 `browser-pull-compose`（父任务）。
- runner 串联 5.1 → 5.2 → 5.3，用现有 `upd()/settle()/notes` 上报，使其在抽屉里与其它任务**外观一致**。
- 现有 XHR 分支不变；WS 分支是并列的执行路径，任务项数据结构不变。
- 取消：`xhrs` 之外维护一个可取消句柄（AbortController + socket），`cancel(id)` 统一触发。

### 5.5 共享 Pull 选项 UI

在现有共享 Pull 选项组件里加「下载方式」：`服务端代理` / `浏览器下载（经 CF worker）`。选浏览器模式时：

- worker URL 输入框：`localStorage`（origin 级），仅存合法 `https://` 且无凭据/path/query 的 URL。
- 可选私有凭据：按 registry host 存 `localStorage`（opt-in 勾选「记住」），存 `{username, secret}`。**spec 注明 XSS 可读取 localStorage 的风险**，默认不勾选、可一键清除。
- 复用到镜像拉取、容器创建/升级、Compose 入口（单一组件，非每页副本）。

## 6. 后端 WebSocket handler

新增 `internal/ws/imageload.go`，路由：

```go
r.Get("/ws/images/load", wsAuthWithUser(jwtSecret, models.RoleOperator, s.lookupUser, ws.ImageLoad(dc)))
```

流程：

1. `upgrader.Upgrade`（沿用同源策略）。
2. 建 `io.Pipe`；goroutine 调 `dc.ImageLoad(ctx, pipeReader)`（复用现有薄封装无代理路径）。
3. 读循环：`BinaryMessage` → `pipeWriter.Write`（阻塞即背压）；约定「结束帧」= 客户端正常 Close 或一个约定的 `TextMessage:"__eof__"` → `pipeWriter.Close()`（EOF）。
4. `ImageLoad` 响应进度经 `ConsumeProgress` 解析，逐行作为 `TextMessage` 回传；检出 `error/errorDetail` → 脱敏（不回传可能含签名 URL 的 daemon 原文）→ 作为失败结束帧。
5. 任一端错误/取消/连接断开 → cancel context、关闭 pipe 两端、等待 `ImageLoad` goroutine 退出，避免泄漏。
6. 大小/时序：限制单帧大小与总时序超时；读侧不额外缓冲（一帧一写）。

后端不解析 tar、不校验 digest（daemon 负责）；不因失败自动 prune 或删旧镜像。

## 7. Compose：预加载 + 本地编排

浏览器不在后端 compose 的 `ImagePull` 调用栈里，无法在编排触发拉取的那一刻去浏览器下载。
因此 compose 浏览器模式 = **先把项目所需镜像逐个 browser-pull 进 daemon，再让后端本地编排**。

1. 新增 `GET /api/compose/pull-plan?id=…`（沿用现有 project loader，尊重 profiles/多配置文件）：返回将被拉取的镜像清单 `[{service, ref, platform}]` 与 `rejected:[{service, ref, reason}]`。**「拉什么」仍由后端决定**，前端不重实现 profile/build 逻辑。
2. 前端：有 `rejected` 先明确提示；对可拉的逐个 browser-pull（复用 §5 单镜像链路），作为父任务下的子任务。
3. 触发编排：
   - Compose **「拉取」**（浏览器模式）= 仅预加载，不 up。
   - Compose **「Up」**（浏览器模式）= 预加载全部成功后，调现有 `POST /api/compose/up`，**强制 `pull_policy=never`、不带 `proxy_url`** → daemon 用本地镜像，绝不回连 registry。
4. 抽屉里以一个父任务展示（N 个预加载子任务 + 1 个 up）。

**边界（v1）**：

- 活动服务含 `build`：`pull-plan` 标记为 `rejected`（reason=build），前端拒绝该项目浏览器拉取（与服务端 §4 一致）。
- image 用 digest 引用：`rejected`（reason=digest）。
- 强制 `pull=never` 会**覆盖** compose 文件中的 `always/missing` —— 这是浏览器模式的刻意行为，spec 明示。

## 8. 安全与边界

- 凭据、token、worker URL 不写审计、不进模板/YAML/容器 Env/daemon 配置；错误脱敏后再展示。
- localStorage 存 worker URL 与（opt-in）私有凭据：注明 XSS 可读风险，提供清除入口。
- worker 双白名单默认拒绝；phyless 的 WS `/ws/images/load` 走现有 JWT（`?token=`）+ RoleOperator。
- 单帧/总时序/manifest/config 大小限制；layer 保持流式。
- 失败不自动 prune、不删共享镜像或旧容器；升级失败前不停旧容器（沿用现有升级保护）。
- zstd 透传但若 daemon 不支持由 daemon 明确报错，不静默直连或回退。

## 9. 测试

### 自动化

```sh
go test ./...
go vet ./...
npm --prefix web test -- --run
npm --prefix web run build
```

- Go：`ws.ImageLoad` handler —— 二进制帧→ImageLoad、结束帧=EOF、中途 daemon error 脱敏、客户端断开/取消不泄漏 goroutine、RoleOperator 鉴权（用假 `ImageLoad`）。
- 前端（vitest）：`dockerTar` 往返（用 tar 解析校验头/size/顺序/padding）、字节数校验中止；`registryPull` token-dance 与媒体类型/大小/digest 拒绝；`imageLoadStream` 背压与取消；`pull-plan` 前端处理 rejected；worker URL 与凭据的 localStorage 持久化与脱敏。
- worker：纯函数单测（origin/upstream 白名单、`*.suffix`、头转发/暴露、缺 Origin 拒绝）。

### 真实环境

隔离 daemon（禁止 daemon 直连 registry）+ 真实 CF worker：

1. 单镜像浏览器拉取成功进 daemon。
2. 大不可压镜像流式导入无 OOM、无浏览器/服务端落盘、无 goroutine 泄漏。
3. 二次同 tag 命中 up-to-date 预检，不重复下载 layer。
4. Compose 预加载 + `up(pull=never)` 全部本地命中，daemon 不回连 registry。
5. 取消、认证失败、中途错误不误报成功、不清理用户资源。
6. 含 build 或 digest 的 compose 被明确拒绝并提示。

## 10. 完成定义

- 浏览器经 CF worker 顺序流式把镜像导入 daemon，浏览器与服务端全程不落盘、内存有界。
- 单镜像与 compose（预加载 + 本地编排）两条路径可用；build/digest 边界明确拒绝。
- 凭据只经浏览器/worker，不进服务端；worker 白名单默认拒绝。
- 「下载方式」共享 UI 复用到镜像/容器/compose；任务进全局队列与抽屉，外观统一。
- 自动化与真实环境验收通过并记录。
