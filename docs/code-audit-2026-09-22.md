# 代码审计与修复（2026-09-22）

范围：Go API、Docker/Compose 调用与流生命周期、文件索引、配置持久化、前端请求和任务队列、浏览器镜像下载、Cloudflare Worker。采用源码链路审查、回归测试、Go race/vet 和局部微基准；未对真实 Docker 主机做生产负载压测，也未部署 Worker。以下是已确认的问题与本次修复，不代表仓库不存在其他缺陷。

## 已修复问题

| 优先级 | 问题、触发条件和影响 | 修复位置与处理 |
| --- | --- | --- |
| P1 | Worker 使用自动重定向，只验证初始上游；后续跳转可越过白名单，Cloudflare 还会向不同域名转发 Authorization。 | `cloudflare-worker/registry-proxy.js`：逐跳校验、跨来源删除 Authorization、拒绝 HTTPS 降级及 URL 内嵌凭据、最多五次跳转；关闭中间响应并传递取消信号。 |
| P1 | registry 元数据的 16 MiB 校验在完整 `arrayBuffer()` 之后；无 Content-Length 或伪造长度时先发生巨量分配。Token 和错误正文也未经读取限额。 | `frontend/src/api/registryPull.ts`：共用流式限额读取，超限立即取消，几何扩容；元数据/Token 16 MiB，错误正文 64 KiB。 |
| P1 | imagefs 的“四个缓存”只是软限制：所有缓存都在构建或下载时仍创建新缓存；单个目录索引也无容量上限。 | `backend/internal/docker/imagefs/imagefs.go`：构建和使用中的索引计入容量，忙时明确拒绝；每索引最多十万条目，累计名称元数据 16 MiB，路径最长 4096 字节、最多 256 个分隔符。容量不是整个进程 RSS 的硬上限。 |
| P1 | imagefs 在返回 session 后才增加下载引用；GC/异步驱逐可同时删除 helper，甚至删除新请求正在复用的 helper。启动清理也可能与首个构建竞争。 | 同上：获取 session 时在锁内占用；List/下载统一释放；删除期间保留占位，禁止复用；统一 `discard`，删除限时十秒，失败保留以便重试；失败建索引清理 helper。启动清理与 session 创建互斥。 |
| P2 | Compose `computeCanBuild` 超时/取消返回后，协程继续改写返回切片，调用者读取时发生数据竞争。取消的加载还可能缓存为永久 false，直到顶层文件变化。 | `backend/internal/api/compose.go`：协程通过缓冲 channel 交付结果，仅请求协程修改返回值；取消结果不入缓存，空文件签名不复用。 |
| P2 | 已完成/失败/取消任务仍在全局 store 中保留 File、body 和 secret；可保留大文件引用或正文，直到历史被淘汰。删除 queued 任务也会遗留未完成的 Promise。 | `frontend/src/stores/taskQueue.ts`：所有终态统一清除瞬时载荷，完成事件与 Promise 也不携带正文/文件/凭据；活动任务必须先取消再删除。 |
| P2 | 退出登录只清 token/UI，后台 XHR、浏览器拉取和队列仍继续执行。 | `frontend/src/stores/auth.ts`：复用现有读取取消和任务取消入口。取消连接不等于回滚服务器已经完成的操作。 |
| P2 | 停止列表轮询或隐藏页面只丢弃响应，没有取消网络请求；任务完成时若旧 GET 仍在进行，刷新被合并掉，可能继续显示写操作之前的数据。 | `frontend/src/stores/resource.ts`：本地 AbortController 跟随页面生命周期；写完成使旧代失效，旧请求结束后补一次刷新。`api/client.ts` 合并局部取消与主机切换取消，并在结束时释放监听器。 |
| P2 | XHR 将一次网络回调的全部数据当作一行计算限额，合法的多行大批次被误报；fetch 流只检查剩余半行，完整超长行反而绕过限额。 | `taskQueue.ts`、`browserPull.ts`：分别检查完整行和残留半行。 |
| P2 | 服务端/浏览器更新检查忽略当前镜像 inspect 失败，可能显示“可升级”或“待重建”；服务端每个镜像组都先创建协程，再等待四个执行槽。 | `api/update_check.go`、`stores/updateCheck.ts`：当前镜像不可读时明确标为 error，停止远程查询；在启动协程之前获取执行槽，等待支持取消。 |
| P2 | 审计日志尾部每读入一条记录，就将最多 1000 条记录整体前移；复杂度为 O(N×K)，并持有日志锁。 | `backend/internal/audit/audit.go`：环形覆盖，结束时一次还原顺序，复杂度 O(N+K)，不改变返回条数或时间顺序。 |
| P3 | Compose 更新任务重复实现 AbortController、进度记录和成功/失败收尾。 | `taskQueue.ts`：复用现有 `startBrowserTask`，取消/终态处理在同一入口维护。没有新增依赖或服务层。 |

Cloudflare 的重定向行为依据：[官方 Request 文档](https://developers.cloudflare.com/workers/runtime-apis/request/)。Worker 的 CDN 白名单要求已同步到其 README；需要重新部署 Worker 才会作用于已上线实例。

## CPU、内存和网络结论

- CPU：明确消除了日志尾部逐条搬移，以及超长元数据下载后的无效解析。保留前端 JSON 比较以避免整个列表重建，未在没有测量依据时替换它。具体日志微基准见下方。
- 内存：任务终态不再持有载荷；registry 读取在接收过程中限额；imagefs 同时限制构建数量和索引规模，避免无界增长。网络层单个已交付 chunk、JSON 对象、Go map/slice 开销仍存在，不能把上述限额直接当作 RSS。
- 网络：停止/隐藏列表、切换主机、退出登录都会取消相应请求；更新检查不会在当前镜像无法读取时继续访问 registry；拒绝 Worker 白名单以外的跳转并关闭中间响应。
- 已有正确机制保留：拉取 layer 使用流式传输和背压；WS 有客户端帧和写超时限制；配置修改使用串行原子更新；前端路由按需加载。

## 已知边界与后续优先级（第三轮处理状态）

| 原剩余项 | 本轮处理 |
| --- | --- |
| imagefs 整树内存索引、大树容量限制 | 改为只保存 tar 元数据的临时磁盘索引，每个上限 128 MiB、最多 4 个会话。浏览时只保留当前目录的条目；超过十万文件但分布在多个目录的树可以读取。单目录仍限制十万项/16 MiB 名称，防止一次响应失控。临时文件创建后立即 unlink，失败、释放、GC 和运行时退出关闭文件，避免崩溃后残留元数据。 |
| 概览五份完整列表轮询 | 新增 `/api/system/summary`，只返回六个计数。前端复用原轮询取消/隐藏/刷新机制，每五秒从 5 次 GET 收敛为 1 次（稳定轮询 60 → 12 GET/分钟/会话）；Docker 列表调用从 8 次降为 4 次，容器只扫描一次，不解析 Compose YAML、不构造使用关系。首次/手动系统信息请求仍独立。 |
| Compose 缓存依赖和协程数量 | 普通项目把显式 env 文件、环境变量指定的 env 文件和默认 `.env` 纳入签名（含文件从不存在变为存在）。Compose 官方 loader 检测到 include/extends 时不复用结果，下次查询重新解析，避免维护第二套 YAML 依赖解释器；服务 env_file 同样不复用。每批最多 4 个 worker，运行时最多 4 个实际检查；保留逐项目并发去重，清除已删除项目的缓存。 |
| 审计日志磁盘无界增长 | 明确保留策略：活动文件 10 MiB，最多 5 个轮转备份（`audit.log.1` 最新），新日志总量正常稳定在 60 MiB 以内。轮转失败返回错误，不截断活动文件；读取跨轮转文件保留时间顺序，所有文件共用 1 MiB/1000 条读取预算。 |
| 前端大 chunk | 两个转换库独立缓存，编辑器及转换库仅在打开容器配置弹窗时加载。生产最大 JS chunk 从约 709 kB 降到约 315 kB，无 500 kB 告警；已核对镜像/容器列表的静态依赖不再包含转换库，并用测试验证关闭弹窗时不加载编辑器。 |
| 缺验收、资源测量和前端 todo | todo 已替换为真实交互测试：点击镜像升级、预填 tag、显示代理选项并提交。新增 SDK 驱动的真实拉取/升级/失败回滚验收及 CPU/峰值 RSS/API 正文传输计量；补磁盘索引微基准。真实 daemon 验收已尝试，但本机没有可用的 Docker socket，连接阶段失败，仍待具备 daemon 的环境执行。 |

仍需准确区分的边界：磁盘索引降低 Go 堆常驻量，不会消除 Docker 首次导出整个 tar 的传输；操作系统文件缓存和 `/tmp` 所在存储仍有成本，不能据此声称整机 RSS 降低。目录查询扫描本地元数据，使用路径前缀过滤后只解码匹配记录。include/extends 项目选择重新加载以保证正确性，复杂项目仍有解析成本，但概览轮询已不再触发它。

日志轮转会淘汰最旧备份；需要长期审计留存的部署应在淘汰前归档这些文件。升级前已有超大 `audit.log` 会完整保留到备份中，直至按后续轮转顺序淘汰，不会为了立刻满足 60 MiB 而截断历史。

## 验证

- `go test -race ./... -timeout=90s`：全部通过（Docker 验收仍为原有 opt-in，未启用）。
- `go vet ./...`：通过。
- `npm test -- --reporter=dot`：196 通过，1 个原有 todo。
- `npm run build`：类型检查和生产构建通过；保留大 chunk 提示。
- `node --test cloudflare-worker/registry-proxy.test.mjs`：8 通过。
- `git diff --check`：通过。

新增覆盖：Compose 返回结果不被后台改写；imagefs 构建/下载容量、删除中禁止复用、过长路径、十万条目上限和失败清理；任务终态载荷释放、queued 删除保护、多行进度；列表取消和写后刷新；局部与全局取消合并；退出登录取消；inspect 失败；registry 无长度超限响应；Worker 白名单/跨源凭据/重定向循环/降级。

全量验证期间，现有路由测试的 Docker 替身缺少新清理路径所需的 `ContainerRemove`，导致 panic 后等待未完成索引；补齐替身方法后全量测试通过，没有绕过清理逻辑或屏蔽用例。

### 日志微基准

Apple M1 Pro / darwin arm64 / Go 1.26.6；每次解析 8000 条 JSON，保留最新 1000 条，`-cpu=1 -count=3`，原版与修复版串行运行。原版代码取自本次修改前的 HEAD，在临时目录使用同一个 benchmark、同一个 Go 版本执行。

| 指标 | 原版 | 修复版 |
| --- | --- | --- |
| 三次耗时 | 25.487 / 26.196 / 26.066 ms | 10.616 / 10.637 / 10.697 ms |
| 中位耗时 | 26.066 ms | 10.637 ms |
| 分配量 | 约 2.90 MB/op | 约 2.90 MB/op |
| 分配次数 | 79993/op | 79993/op |

此用例耗时降低约 **59%**，收益来自减少内存搬移，JSON 解码分配基本不变。不是整个应用 CPU 降低 59%；未测整站吞吐或真实 daemon 的 RSS/流量。

修复版复现命令：

```sh
go test ./backend/internal/audit -run '^$' -bench BenchmarkScanTail -benchmem -cpu=1 -count=3
```


## 第二轮复查

第一轮修复已提交为 `8f5ded6`。本轮继续检查取消链路、持久化副本和错误恢复，新增修复如下。

| 问题 | 修复与验证 |
| --- | --- |
| 任务取消未传到平台查询、Compose plan、容器/镜像 inspect，任务可长期占用运行槽。 | 任务信号贯穿所有这些 GET；用五种任务入口验证取消会中断实际 fetch，并且不启动后续步骤。 |
| 登录/初始化/会话恢复的迟到响应可能恢复退出的账号或覆盖新 token。 | 登录和初始化共用可取消的建立会话流程；保存 token 和用户资料前检查取消；恢复会话时核对 token。覆盖迟到 token 和 profile。 |
| 代理 URL 的 userinfo/query 可进入任务详情和 localStorage，即使请求 body 已剥离。 | 详情、持久化 metadata 和完成事件移除 URL 用户名/密码、query、fragment；正在执行的真实请求保持原值。修复防止新记录泄漏，不会撤销此前可能已暴露的凭据。 |
| XHR open/send 等同步异常绕过 onerror，任务永远 running。 | 调度入口捕获同步异常，统一 settle，释放执行槽；验证后续同 key 任务能继续。 |
| 刷新间隔接受 Infinity 或过大的有限数，定时器溢出后可形成高频轮询。 | 保证有限值并约束到有符号 32 位毫秒范围；保留正常整数秒行为。 |
| imagefs helper 已被外部删除时，清理的 NotFound 被视为失败，旧索引无法驱逐。 | 统一删除入口将 NotFound 视为已完成；验证满缓存仍能换入新索引。 |
| include/.env 变更未修改顶层 Compose 文件时，can_build 可无限陈旧。 | 保留 mtime 快速失效，增加 30 秒 TTL；真实 include 文件测试证明到期后重新加载。不是即时依赖追踪，显示更新还取决于下一次查询。 |
| 更新检查先启动 registry Promise、再等待 tag inspect；registry 快速失败时可能触发未处理拒绝。 | 先完成 tag inspect，再在 try/await 范围启动 registry 查询，保留按镜像组去重。 |
| 镜像认证重试遗弃旧 401 body，可能继续下载并占用连接。 | 元数据与 layer 路径在重试/放弃前取消 challenge body；补取消行为测试。 |

本轮验证：`go test -race ./... -timeout=90s`、`go vet ./...` 全部通过；前端 209 个测试通过，保留 1 个原有 todo；类型检查与生产构建通过；`git diff --check` 通过。仍保留原有大 chunk 提示，未部署或执行真实 Docker 生产负载测试。


## 第三轮验证与复现

- `go test -race ./... -timeout=90s`、`go vet ./...`：通过。
- 前端 212 个测试通过，原有 todo 已清零；类型检查与生产构建通过，无大 chunk 告警。
- 真实 Docker 验收：已执行以下命令，但在连接 `unix:///var/run/docker.sock` 时失败，未创建 Docker 资源。没有把它计为通过，也没有线上 CPU/RSS/带宽结论。

```sh
PHYLESS_UPGRADE_ACCEPTANCE=1 go test ./backend/internal/docker/container -run '^TestUpgradeRealAcceptance$' -v -count=1 -timeout=5m
```

该验收从 `DOCKER_HOST` 等标准 Docker 环境变量读取连接配置；默认拉取固定 digest 的 busybox（可用 `PHYLESS_ACCEPTANCE_IMAGE` 指定兼容 `sh`/`sleep` 的镜像）。创建唯一标签的临时镜像/容器，验证升级后名称/镜像/运行状态和旧容器删除，再用无法启动的新镜像验证原容器恢复。清理仅作用于该次标记的资源，基础镜像保留，不执行 prune。输出 CPU 时间与峰值 RSS 属于 **Go 测试进程**；传输计量是 **Docker API 请求/响应正文**，不含协议开销，也不等于 daemon 自己从 registry 下载的字节。计量器另有本地 HTTP 测试验证，不依赖 daemon。

### 磁盘索引微基准

Apple M1 Pro / darwin arm64；合成一万份空文件 tar header（100 个目录，每目录 100 项），三次串行运行。这里没有远程 daemon 或大文件正文，不能当作镜像首次浏览的端到端吞吐。

| 操作 | 三次耗时 | 每次分配 |
| --- | --- | --- |
| 构建磁盘元数据索引 | 23.387 / 23.370 / 23.259 ms | 约 6.94 MB，170014 次分配 |
| 从该索引列出 100 项目录 | 0.581 / 0.577 / 0.588 ms | 约 78.6 kB，1026 次分配 |

分配量不是常驻内存；新索引不再让整个树的 map/slice 长期存活。此改动用本地磁盘扫描换取较小堆常驻量，并保留磁盘和单目录响应上限。

```sh
go test ./backend/internal/docker/imagefs -run '^$' -bench BenchmarkDiskIndex -benchmem -cpu=1 -count=3
```
