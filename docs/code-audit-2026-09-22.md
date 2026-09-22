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

## 已知边界与后续优先级

1. imagefs 第一次浏览仍需扫描整个 tar，跳过正文不等于不传输正文。大镜像/停止容器和远程 daemon 的成本主要在这里；若实际负载频繁触发新增容量限制，应改为磁盘索引或更局部的读取，不应直接移除限额。
2. 概览页仍每五秒轮询五个列表，约每个可见会话 60 次 GET/分钟，另有首次/手动系统信息请求。多用户、大资源列表场景需要真实负载数据后再决定摘要 API 或请求共享。
3. Compose build 能力缓存仍只跟踪顶层 Compose 文件；include/.env 变化没有完整依赖失效。首次检查每项目一个协程，缓存避免同项目重复加载；未改为长期调度服务。
4. 审计日志仍是追加文件，读取有界但磁盘总量未轮转；保留策略应由部署明确，不能在审计修复中自行删除历史。
5. 前端生产包仍存在大于 500 kB 的按需 chunk（容器创建/命令转换相关）。入口和页面懒加载已存在，本次没有为消除构建提示而移动依赖。
6. 本次没有执行真实 Docker 拉取/升级/回滚验收或线上 CPU/RSS/带宽采样；没有将微基准收益推算成整站收益。原有一个前端 todo 用例仍待补齐。

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

