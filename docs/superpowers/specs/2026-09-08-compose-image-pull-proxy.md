# Compose API 化与 Docker ImagePull 请求级代理方案

状态：已实施；本文记录最终架构、边界、接口和验收口径（2026-09-08）。

关联文档：

- [详细执行计划](../plans/2026-09-04-proxy-image-pull.md)
- [实施与真实环境交付记录](../plans/2026-09-04-compose-api-proxy-delivery.md)

## 1. 背景与目标

Docker daemon 有时无法直接访问镜像仓库，而修改 daemon 全局代理或重启 dockerd 不可接受。应用需要在**单次请求**内使用代理拉取镜像，并满足：

1. 下载完成后直接导入 Docker image；应用侧在导入前不保存镜像 tar、layer 或缓存文件。
2. Compose 的显式 Pull、Up 内部拉取及官方编排触发的其他 ImagePull 路径使用同一逻辑。
3. Compose 运行时只走 Go API，不依赖 `docker`、`docker compose` 或 `buildx` 外部命令。
4. 代理地址可由前端复用，但凭据不落盘、不进入 Compose 文件或容器环境。
5. WebSocket 或后端局部失败只影响对应功能，并以节流错误提示反馈，不阻塞页面主体。

“不落盘”的范围是 phyless 下载端：Docker daemon 自己的校验、解包和镜像存储仍可能写盘，这是 Docker image 的正常存储行为。

## 2. 架构决策

### 2.1 Compose 先 API 化

Compose 使用官方库的进程内实现：

- `compose-spec/compose-go`：加载、插值、合并和校验 Compose 项目。
- `docker/compose/v2/pkg/api`：Compose 服务接口和操作参数。
- `docker/compose/v2/pkg/compose`：官方 `NewComposeService` 和生命周期实现。

应用删除运行时的 CLI 子进程链路。这里允许依赖 `docker/cli` 的 **Go 包**，因为它们用于配置、认证和 API client 注入；“去掉 CLI”指不启动外部可执行文件，不是删除所有包名含 `cli` 的 Go 依赖。

### 2.2 ImagePull 只做薄封装

应用包装官方 `client.APIClient`，只覆盖 `ImagePull`，其余 Docker API 原样透传：

```text
HTTP / WebSocket handler
        │
        ├─ Compose project loader (compose-go)
        └─ official Compose service (pkg/compose)
                         │
                  injected APIClient
                         │
                 ImagePull thin wrapper
                    ├─ no proxy → daemon ImagePull
                    └─ proxy → registry stream → ImageLoad
```

代理策略通过请求级 context typed key 传递，不改 SDK 方法签名、不使用全局可变代理、不让 handler 分叉出另一套下载接口。

### 2.3 当前实际 API

当前 Docker SDK 固定为 `github.com/docker/docker/client`（v28.5.2），实际调用如下：

| 场景 | Go API | Docker Engine endpoint |
| --- | --- | --- |
| 无代理 | `client.APIClient.ImagePull` | `POST /images/create` |
| 有代理，导入阶段 | `client.APIClient.ImageLoad` | `POST /images/load` |

有代理时，Registry 访问由 `go-containerregistry` 的 `remote` 实现完成，tar 数据经 `io.Pipe` 交给 `ImageLoad`；不会再次调用 daemon 的 `ImagePull`。Compose 的 `pkg/api.Compose` 服务接收注入的包装 client，其内部所有镜像拉取最终仍调用包装后的 `ImagePull`，不是调用 `docker compose` 命令。

## 3. 镜像拉取流程

### 3.1 无代理

直接调用 daemon 的原生 `APIClient.ImagePull`，保留 Docker SDK 的认证、平台、all-tags 和其他既有行为。

### 3.2 有代理

1. 校验镜像引用、平台、Registry 凭据和代理 URL。
2. 使用本次请求的 HTTP/HTTPS/SOCKS5 transport 访问 Registry、token endpoint、manifest、config 和 layer/CDN；失败时不静默直连。
3. 解析 manifest，选择目标 daemon 平台的单个平台镜像。
4. 获取远端 config digest，在调用 `ImageLoad` 前与本地标签对应的 config digest 比较；相同则返回 `Image is up to date`，不重复下载和导入 layer。
5. 不相同则使用 `remote.Image → tarball.Write → io.Pipe → APIClient.ImageLoad`，让 tar 数据从网络流直接进入 Docker API。
6. 消费 `ImageLoad` 的 Docker JSON 进度，检查 `error`、`errorDetail`、producer 错误和最终 config ID/tag/platform。
7. 任何一端失败、取消或调用者关闭 reader，都取消同一 context，关闭 pipe/body，并等待 producer 退出。

应用侧不创建临时 tar，不把 layer 或完整镜像读入内存，也不调用 `ImageImport`。失败不自动 prune、不删除共享镜像或旧容器；Docker 已接收的部分内容按 daemon 语义处理。

## 4. Compose 链路和覆盖范围

统一项目 loader 负责工作目录、多个配置文件顺序、`.env`/`env_file`、profiles、include、项目名和官方 Compose labels。一次请求加载出的 `types.Project` 交给同一个官方 service，不再先用 CLI config、再用 CLI up 解析两次。

| 操作 | API 实现 | ImagePull 代理是否覆盖 |
| --- | --- | --- |
| `POST /api/compose/pull` | `Compose.Pull` | 是 |
| `POST /api/compose/up` | `Compose.Up` | 是，包含官方 pull policy 触发的拉取 |
| `stop` / `restart` / `down` | 官方对应 service 方法 | 不主动拉取 |
| 依赖服务、profile 活动服务的镜像拉取 | 官方 Compose 内部逻辑 | 是，只要最终调用 `APIClient.ImagePull` |
| Config、Detail、Logs | project loader、序列化和 `LogConsumer` | 不拉取 |

应用不复制 `pull_policy`、depends_on、profiles、重建或资源删除算法。代理封装只决定“如何拉取”，Compose 官方实现决定“何时拉取、拉什么以及如何编排”。

带代理且活动服务包含 `build` 时，首版明确拒绝该操作：Dockerfile `FROM`、BuildKit cache 和外部 provider 不等于 ImagePull。无代理的既有本地 build 继续支持；不回退到 CLI，也不偷偷直连。

## 5. 请求接口

新增字段均可选，省略时保持原行为：

| 请求 | 字段 |
| --- | --- |
| `POST /api/images/pull` | `image`、`registry_id`、`proxy_url`、`platform` |
| `POST /api/containers` | `image`、`registry_id`、`proxy_url`、`platform` |
| `POST /api/containers/{id}/upgrade` | 可选 `proxy_url`、`registry_id`，兼容空 body |
| `POST /api/compose/pull`、`/up` | `proxy_url`、`registry_ids` |

Compose 的平台来自各 service 的 `platform`；未指定时按目标 daemon 的 OS/arch 选择，不使用 phyless 自身编译架构。Registry 凭据按 host 在本次请求内构造，未知 ID、host 不匹配或同 host 多账号无法唯一选择时直接报错。

## 6. 前端持久化与错误降级

### 6.1 代理地址

代理地址保存在浏览器 origin 级 `localStorage`（前端本地持久化；不上传为服务器全局配置），由 Pull 选项组件复用到镜像、容器和 Compose 入口：

- 仅保存合法的 `http`、`https`、`socks5`、`socks5h` 地址。
- 不保存用户名、密码、路径、query 或 hash；带认证信息的 URL 不写入存储。
- 请求仍显式携带 `proxy_url`，关闭弹窗或任务结束不会把代理写进模板、YAML、Run 文本、容器 Env 或 daemon 配置。
- 代理地址必须从 phyless 进程/容器可达；容器内的 `127.0.0.1` 不是宿主机地址。

### 6.2 API 与 WebSocket

- HTTP 200 但流内含 `error`/`errorDetail` 时仍判定失败，不能显示绿色成功。
- 拉取、导入或升级失败时，旧容器在成功拉取和 inspect 之前不停止、不删除。
- 日志、统计、终端和 Compose 日志 WebSocket 的连接/解析/写入错误转为节流 Toast；WS 失败只停止实时数据，不阻塞详情、文件、操作按钮和其他 API。
- 同一错误短时间重复出现只提示一次；用户仍可继续操作和重新连接。
- Compose 详情源文件不可见时返回项目元数据和可见性提示；文件编辑与 Up/Pull 仍要求源目录可访问。
- 页面 smoke 需要实际打开 Compose 列表、详情和 Modal，防止构建未捕获的运行时符号错误（例如漏引入 `Modal`）。

## 7. 安全与兼容边界

- 代理、Registry token 和签名 URL 不写审计、进度全文或错误响应；底层错误向用户展示前脱敏。
- TLS 校验、context 取消和连接关闭沿用标准 HTTP client；代理失败不自动改走直连。
- 首版代理路径支持普通 Linux 单平台 tag；digest 引用、all-tags、foreign/zstd 层和附属签名未通过专项验证前明确拒绝。
- `manifest`、JSON 元数据和选中的 config blob 有限大小限制；layer 保持流式。
- Compose 运行时固定 `COMPOSE_BAKE=false`、`BUILDX_BUILDER=default`，不自动创建外部 builder 或运行 credential helper/provider。
- 多实例部署只提供进程内同项目操作锁；同一项目并发变更返回 409，不排队。
- “无 CLI”不限制用户容器内执行其业务命令；仅限制 phyless 的 Docker/Compose 编排路径。

## 8. 验收清单

### 自动化检查

```sh
go test ./...
go test -race ./...
go vet ./...
npm --prefix web test -- --run
npm --prefix web run build
```

必须覆盖：Compose API 方法映射、项目加载、profiles/依赖/多文件 override、Config/Logs、资源保留行为、ImagePull 原生与代理路径、认证、HTTP CONNECT/SOCKS5、取消和 reader Close、坏 manifest/config/layer、同 digest 不重复导入、升级失败不删除旧容器、前端 WS 错误节流和代理地址持久化。

### 真实 daemon

使用显式 opt-in 的独立 daemon；测试容器不包含 docker/compose/buildx 可执行文件，只挂载 Docker socket。阻止 daemon 直接访问测试 Registry，只允许 phyless 经请求代理访问，验证：

1. Compose Pull/Up 的所有镜像拉取到达包装后的 `ImagePull`。
2. 传输体积显著大于应用内存限制的不可压缩镜像仍能成功，无中间文件、OOM 或 goroutine 泄漏。
3. 第二次同 tag 拉取命中 config digest 预检，不增加 Registry layer 字节。
4. 取消、认证失败、导入提前拒绝和第二个服务失败不会误报成功或清理用户资源。
5. 应用容器可重启，业务容器、daemon 配置和 Docker 全局代理不被修改。

当前已在 `docker.example.test` 完成 Compose、代理拉取、内存上限、无中间文件、WS 状态码和前端资源检查；最新前端运行时修复提交为 `b1c93af`。

## 9. 部署、回退与完成定义

部署只替换 phyless 应用镜像/容器，不能以重启 dockerd 或修改 daemon 配置作为步骤。前端静态资源应随运行镜像发布，避免仅用容器内临时拷贝导致重启后回退。

回退时替换为上一版 phyless 镜像，不删除新版本已创建的容器、卷或镜像；如需清理，只能在确认归属后删除本次验收生成的唯一命名资源。

方案完成的判断标准：

- Compose 所有运行时路径使用官方 Go API，无外部 CLI 回退。
- 普通业务和 Compose 共用同一个 ImagePull 薄封装。
- 有代理时下载端无镜像中间文件，流式导入、取消、错误和内存边界通过验证。
- digest 预检、升级前保护、认证脱敏和不支持能力的错误契约明确。
- 前端代理可复用但凭据不落盘；WS/API 失败不阻塞页面。
- 自动化、真实 daemon、部署和回退证据记录在[交付记录](../plans/2026-09-04-compose-api-proxy-delivery.md)中。
