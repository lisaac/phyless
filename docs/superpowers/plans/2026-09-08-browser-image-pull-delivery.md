# 浏览器侧流式拉取镜像（browser-pull）交付记录

日期：2026-09-08　状态：已实现并合入 `main`。

关联文档：

- [设计说明](../specs/2026-09-08-browser-image-pull.md)
- [实施计划](2026-09-08-browser-image-pull.md)
- [服务端代理拉取方案](../specs/2026-09-08-compose-image-pull-proxy.md)（互补路径）

## 1. 概述

面向「phyless 服务端与 Docker daemon 都连不上 registry，只有用户浏览器能上网」的场景。
浏览器经用户自建的 Cloudflare Worker 下载镜像，边下边组装 `docker load` 兼容的 tar，
经 WebSocket 顺序流式推给 phyless，后端 `io.Pipe → ImageLoad` 灌进 daemon。

**全程浏览器与 phyless 应用侧都不落盘、不整包缓冲，内存靠背压约束在「一层的传输窗口」量级。**
Docker daemon 自身解包/存镜像是其正常行为，不在「不落盘」范围内。

## 2. 数据流

```text
浏览器                              CF Worker            Registry
  registryPull  ──?url=…──────────►  CORS 代理  ──────►  manifest/token/config/blob
      │  (token dance、选平台、拿 config+layers 描述符)
      ▼
  dockerTar（USTAR 流式组装，按序：config → 各 layer → 元数据 → trailer）
      │  layer 经 Worker fetch 原样透传，不解压；字节数与声明 size 不符即中止
      ▼
  imageLoadStream ──WS 二进制帧（bufferedAmount 背压）──►  phyless /ws/images/load
                                                              │  帧 → io.Pipe → ImageLoad
                                                              ▼
                                                          Docker daemon
                    ◄──── 进度 NDJSON（text 帧，error 事件脱敏）────
```

## 3. 组件清单

| 层 | 文件 | 职责 |
| --- | --- | --- |
| CF Worker | `cloudflare-worker/registry-proxy.js` | `?url=` CORS 代理，双白名单默认拒绝，转发 auth/range，流式透传 |
| 后端 WS | `internal/ws/imageload.go` | `/ws/images/load`：二进制帧 → `io.Pipe` → `ImageLoad`，进度回传并脱敏 |
| 前端 | `web/src/api/registryPull.ts` | ref 解析、token dance、manifest 平台选择、config 下载、约束校验 |
| 前端 | `web/src/api/dockerTar.ts` | USTAR 流式写入器，产出 `docker load` 归档的 `ReadableStream` |
| 前端 | `web/src/api/imageLoadStream.ts` | WS 上传，`bufferedAmount` 背压，进度/错误/取消 |
| 前端 | `web/src/stores/browserPull.ts` | 单镜像 runner（含 up-to-date 预检）+ Compose Build/Update + Create/Upgrade 本地动作 |
| 前端 | `web/src/stores/browserPullSettings.ts` | worker URL / 下载方式 / 凭据的 localStorage 持久化 |
| 共享 UI | `web/src/components/shared/PullOptions.tsx` | 「下载方式」开关（`allowBrowser` 门控）+ worker/凭据输入 |
| 后端 | `internal/api/compose.go` | `GET /api/compose/pull-plan`：列出需预拉的镜像、Build `FROM` 基础镜像与被拒服务 |
| 后端 | `internal/docker/container/container.go` | `UpgradeWithoutPull`：复用平台校验、锁、回滚的本地镜像升级 |
| 任务队列 | `web/src/stores/taskQueue.ts` | 新增 `browser-pull` / `browser-pull-compose` / `browser-pull-action` 执行分支 |

## 4. CF Worker 部署

Worker 只提供 JS，由使用者自行部署：

```bash
npx wrangler deploy cloudflare-worker/registry-proxy.js \
  --name phyless-registry-proxy --compatibility-date 2024-11-01
```

环境变量（详见 `cloudflare-worker/README.md`）：

| 变量 | 含义 | 示例 |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | 允许使用代理的请求 Origin（逗号分隔，空=反射任意 Origin） | `https://phyless.example,http://docker.example.test:8080` |
| `UPSTREAM_ALLOWLIST` | 允许的 registry host（`*.suffix` 匹配子域，`*` 放开） | `registry-1.docker.io,auth.docker.io,*.docker.io,ghcr.io,*.githubusercontent.com,production.cloudflare.docker.com` |
| `ALLOW_ANY_UPSTREAMS` | `true` 跳过上游白名单（生产不建议） | `false` |
| `ALLOW_MISSING_ORIGIN` | `true` 接受无 Origin 的请求 | `false` |

> 安全提醒：Worker 会把 `Authorization` 转发给目标上游，务必收紧 `UPSTREAM_ALLOWLIST`；
> 切勿在生产保留 `ALLOW_ANY_UPSTREAMS=true`，否则会变成开放的凭据转发代理。

## 5. 使用方法

1. 部署 Worker，拿到其 URL。
2. 镜像页点「拉取」，展开「本次拉取选项」，把「下载方式」切到**浏览器下载**，填入 Worker 地址。
3. 私有镜像可填用户名 + 密码/Token；勾选「记住凭据」会存入**本浏览器** localStorage（明文，XSS 可读，默认不勾，可一键清除），凭据只经浏览器与 Worker 发往 registry，**不会发给 phyless 服务端**。
4. Compose：在 Up/拉取弹窗切到浏览器下载。
   - 「拉取」= 仅把项目所需镜像预加载进 daemon。
   - 「Up」= 预加载全部后调用 `compose up` 并强制 `pull_policy=never`，daemon 用本地镜像、绝不回连 registry。
   - 「Build」= 顺序预拉可静态解析的 Dockerfile `FROM` 基础镜像后构建；Update 浏览器模式复用该步骤。
5. 容器 Create/Upgrade：浏览器先完成镜像预拉，再以 `pull_policy=never` 调用后端本地动作；预拉失败或取消不会创建/替换容器。Upgrade 的目标 tag 来自原容器稳定引用，平台来自原镜像 inspect。

## 6. 关键设计决策

- **为什么用 WebSocket 而非 `fetch` 流式上传**：phyless 当前是纯 HTTP/1.1（`cmd/server/main.go` `ListenAndServe`），
  而浏览器 `fetch` 传 `ReadableStream` 请求体需要 HTTP/2（即 TLS）。WebSocket 走 HTTP/1.1 Upgrade 即可，
  单连接帧按序到达（RFC 6455），并复用 phyless 现有 WS 基建。
- **layer 压缩原样透传**：gzip/zstd/未压缩都不在浏览器解压，直接搬运压缩 blob，由 daemon 解包。
  因此不引入 zstd wasm 解码器；daemon 若不支持 zstd 会由其明确报错，不静默直连。
- **顺序流式、不并行下载 layer**：tar 是严格顺序格式（头里写死 size），逐层顺序灌入；
  要并行就得把乱序 layer 暂存到内存或磁盘，违反「不落盘/有界内存」。每层校验实际字节数 == 声明 size。
- **凭据不进服务端**：token dance 由浏览器经 Worker 完成；任务队列里凭据放在 `secret` 字段，
  `persist()` 会将其剔除，不写入 localStorage 任务历史。
- **up-to-date 预检**：下载前用 `GET /api/images/inspect` 比对本地 image ID 与远端 config digest，
  命中则跳过下载。

## 7. 安全与边界

- 错误脱敏：daemon 进度里的 `error/errorDetail` 不原样回传（可能含签名 URL/token），替换为固定安全提示。
- WS 鉴权沿用 `wsAuthWithUser(RoleOperator, ?token=)`；仅显式 `__eof__` 结束帧才视为完整输入，
  中途断连不会被误认为完整 tar。
- 约束（对齐服务端代理）：仅 tag 引用（拒 digest）、仅 Linux 单平台、manifest/config ≤ 16 MiB、
  拒 foreign/non-distributable 层；失败不自动 prune、不删旧镜像。

## 8. v1 范围与后续

- 已交付：镜像页拉取、容器 Create/Upgrade、Compose（预加载 + 本地编排/Build）。
- 后续：digest 引用、无法静态解析的 `FROM`/外部构建上下文、浏览器侧解压/预览、TLS/H2 的 `fetch` 流式方案。

## 9. 验收证据

自动化（`worktree-browser-pull` rebase 到最新 `main` 后）：

- `go build ./...`、`go vet ./...` 通过。
- `go test ./...` 全绿（含新增 `internal/ws` ImageLoad handler、`internal/api` compose pull-plan 用例）。
- `npm --prefix web run build` 通过。
- 新增前端用例全部通过：dockerTar 5、registryPull 10、imageLoadStream 4、browserPull 4、browserPullSettings 6、browserPullCompose 3；CF Worker 纯函数 `node --test` 5。
- 既有 `web/src/components/shared/TaskQueueWidget.test.tsx` 的 3 个用例在**合入前的 `main` 上已失败**（任务面板改抽屉后测试未同步，与本功能无关），已单独登记跟进。

真实环境验收（隔离 daemon + 真实 Worker）尚待在目标环境执行，建议覆盖：
单镜像浏览器拉取、大不可压镜像无 OOM/落盘、二次命中 up-to-date、Compose 预加载 + `up(never)` 不回连 registry、
取消/认证失败/中途错误不误报成功；Compose Build 预拉基础镜像，digest/动态 `FROM` 边界明确。
