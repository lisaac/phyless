# 浏览器侧流式拉取镜像 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 浏览器经用户自建 CF Worker 下载镜像，边下边组装 docker-load tar，经 WebSocket 顺序流式导入 daemon；浏览器与服务端全程不落盘、内存有界。

**Architecture:** 前端 `registryPull`（token+manifest）→ `dockerTar`（USTAR 流式组装 `ReadableStream`）→ `imageLoadStream`（WS 二进制帧上传 + 背压）→ 后端 `ws.ImageLoad`（帧→`io.Pipe`→`docker.ImageLoad`）。Compose 走「预加载所有镜像 + `up(pull=never)`」。共享 Pull 选项加「下载方式」，写操作统一进 `taskQueue`。

**Tech Stack:** Go（chi 路由、gorilla/websocket、docker client）、TypeScript + SolidJS（web/，vitest）、Cloudflare Worker（原生 JS）。

## Global Constraints

- 浏览器与 phyless 应用侧全程不落盘、不整包缓冲；layer 保持流式。
- 仅 tag 引用、仅 Linux 单平台；layer 压缩原样透传（不解压），拒 foreign/non-distributable。
- 凭据/token/worker URL 不进服务端、不写审计/模板/YAML/Env；错误脱敏。
- manifest/config ≤ 16 MiB。
- WS 鉴权沿用 `wsAuthWithUser(... RoleOperator ...)` + `?token=`。
- 共享实现，不做每页副本；写操作进 `taskQueue`，抽屉外观统一。
- 提交信息结尾：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: CF Worker registry 代理

**Files:**
- Create: `cloudflare-worker/registry-proxy.js`
- Create: `cloudflare-worker/README.md`
- Create: `cloudflare-worker/registry-proxy.test.mjs`（node:test，测纯函数）

**Interfaces:**
- Produces: 一个 ES module `export default { fetch(request, env) }`；导出纯函数 `parseAllowlist`, `isAllowedHost`, `resolveAllowedOrigin`, `normalizeOrigin`, `validateOriginPolicy` 供单测。

- [ ] Step 1：写纯函数失败测试 `registry-proxy.test.mjs`：`isAllowedHost('registry-1.docker.io', ['*.docker.io'])===true`；`isAllowedHost('evil.com', ['ghcr.io'])===false`；`resolveAllowedOrigin({originAllowlist:['https://a']}, 'https://a')==='https://a'`；`validateOriginPolicy({originAllowlist:[],allowsMissingOrigin:false},'')` 返回非空错误串。
- [ ] Step 2：`node --test cloudflare-worker/registry-proxy.test.mjs` → FAIL（模块不存在）。
- [ ] Step 3：实现 `registry-proxy.js`：`?url=` 代理，GET/HEAD/OPTIONS，双白名单（origin + upstream，`*.suffix`），转发 `accept,authorization,cache-control,content-type,if-modified-since,if-none-match,range`，暴露 `Accept-Ranges,Content-Encoding,Content-Length,Content-Range,Content-Type,Docker-Content-Digest,WWW-Authenticate`，`Cache-Control:no-store`、`Vary:Origin`、`redirect:'follow'`、流式 `upstream.body`；缺 Origin 默认拒绝（`ALLOW_MISSING_ORIGIN`），`ALLOW_ANY_UPSTREAMS`/`UPSTREAM_ALLOWLIST=*` 放开上游。导出上述纯函数。
- [ ] Step 4：`node --test` → PASS。
- [ ] Step 5：写 `README.md`（部署：`wrangler deploy`；env：`ALLOWED_ORIGINS`,`UPSTREAM_ALLOWLIST`,`ALLOW_ANY_UPSTREAMS`,`ALLOW_MISSING_ORIGIN`；示例 upstream：`registry-1.docker.io,auth.docker.io,*.docker.io,ghcr.io,*.githubusercontent.com,production.cloudflare.docker.com`）。
- [ ] Step 6：commit `feat(worker): registry CORS proxy for browser image pull`。

---

### Task 2: 后端 WS ImageLoad handler

**Files:**
- Create: `internal/ws/imageload.go`
- Create: `internal/ws/imageload_test.go`
- Modify: `internal/api/server.go`（注册路由，约 line 139 WS 组附近）

**Interfaces:**
- Consumes: `docker` client 具备 `ImageLoad(ctx, io.Reader) (image.LoadResponse, error)`（已存在，见 `internal/api/images.go:274`）。`ConsumeProgress(ctx, io.Writer, io.Reader) error`（`internal/docker/stream.go`）。
- Produces: `func ImageLoad(dc *docker.Client) http.HandlerFunc`（放 `internal/ws`）。约定：客户端发 `BinaryMessage` = tar 分片；发 `TextMessage("__eof__")` = 输入结束；服务端把进度 NDJSON 作为 `TextMessage` 回传，末尾发 `{"status":"done"}` 或 `{"error":...}` 后关闭。

- [ ] Step 1：失败测试 `imageload_test.go`：用假 docker client（`ImageLoad` 把 reader 读空并回一段进度 JSON）跑一个内存 WS（`httptest.NewServer` + gorilla dialer）：发两帧二进制 + `__eof__`，断言假 client 收到完整拼接字节、客户端收到进度帧与最终 `done`。第二用例：假 client 回含 `{"error":"x"}` 的进度 → 客户端收到脱敏 error 帧、无 `done`。第三用例：客户端中途 Close → context 取消、`ImageLoad` 的 reader 收到 EOF/err，handler 返回不泄漏。
- [ ] Step 2：`go test ./internal/ws/ -run ImageLoad -v` → FAIL。
- [ ] Step 3：实现 handler：`upgrader.Upgrade`；`io.Pipe`；goroutine `dc.ImageLoad(ctx, pr)`；读循环 binary→`pw.Write`，`__eof__`→`pw.Close()`；`ConsumeProgress` 结果经脱敏 sink 逐行 `WriteMessage(Text)`；任一错误 cancel+关 pipe+等 goroutine。脱敏复用 `writeProgressError` 思路（不回传 daemon 原文里可能的签名 URL）。
- [ ] Step 4：`go test ./internal/ws/ -run ImageLoad -v` → PASS。
- [ ] Step 5：`server.go` 注册 `r.Get("/ws/images/load", wsAuthWithUser(jwtSecret, models.RoleOperator, s.lookupUser, ws.ImageLoad(dc)))`；确认 `dc` 在该作用域可得（同其它 `ws.*` 用法）。
- [ ] Step 6：`go build ./... && go vet ./...`。
- [ ] Step 7：commit `feat(ws): streaming image load over websocket`。

---

### Task 3: 前端 docker-load tar 组装器

**Files:**
- Create: `web/src/api/dockerTar.ts`
- Create: `web/src/api/dockerTar.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TarBlob { name: string; size: number; body: ReadableStream<Uint8Array> | Uint8Array; }
  // 组装 docker-load 归档为 ReadableStream；layerFetch 按 index 惰性返回 {stream,size}
  export function buildDockerLoadTar(input: {
    configHex: string; configBytes: Uint8Array;
    layers: { hex: string; size: number }[];
    repoTag: string | null;
    manifest: { mediaType: string; digest: string; size: number };
    platform: { os: string; architecture: string; variant?: string };
    openLayer: (index: number) => Promise<ReadableStream<Uint8Array>>;
  }): ReadableStream<Uint8Array>;
  ```
  内部导出 `tarHeader(name, size, opts?)`, `readableFromBytes(bytes)` 供测试。

- [ ] Step 1：失败测试：`buildDockerLoadTar` 用内存 config + 两个假 layer（`openLayer` 返回固定字节流）产出 stream；用一个最小 tar 解析（测试内自带 512-block 解析）断言条目顺序为 `blobs/sha256/<config>`、两个 layer、`manifest.json`、`oci-layout`、`index.json`、`repositories`、trailer；断言每条 header 的 size/checksum 正确、内容 padding 到 512。再测：layer 实际字节 < 声明 size → stream 报错中止。
- [ ] Step 2：`npm --prefix web test -- --run dockerTar` → FAIL。
- [ ] Step 3：实现 USTAR 写入器（`tarHeader` 处理 name/prefix 拆分、八进制、checksum；`buildDockerLoadTar` 用 `ReadableStream` 的 `pull` 顺序发条目，layer 用 `openLayer(i)` 边读边计数，读毕校验 `count===size` 否则 `controller.error`）。manifest/oci-layout/index.json/repositories 布局照 spec §5.2。
- [ ] Step 4：`npm --prefix web test -- --run dockerTar` → PASS。
- [ ] Step 5：commit `feat(web): streaming docker-load tar builder`。

---

### Task 4: 前端 registry 客户端

**Files:**
- Create: `web/src/api/registryPull.ts`
- Create: `web/src/api/registryPull.test.ts`

**Interfaces:**
- Consumes: worker URL（`{workerUrl}?url=<encoded>`）；可选 `creds:{username,secret}`。
- Produces:
  ```ts
  export interface ResolvedImage {
    repoTag: string; ref: string;
    config: { hex: string; size: number; bytes: Uint8Array };
    layers: { hex: string; size: number; mediaType: string }[];
    manifest: { mediaType: string; digest: string; size: number };
    platform: { os: string; architecture: string; variant?: string };
    authHeader: string | null;   // Bearer/Basic，供后续 openLayer 复用
  }
  export function parseImageRef(ref: string): { registry: string; repository: string; tag: string };
  export function parseWWWAuthenticate(h: string): { realm: string; service?: string; scope?: string };
  export async function resolveImage(ref: string, platform: string, workerUrl: string, creds?: {username:string;secret:string}): Promise<ResolvedImage>;
  export function layerBlobUrl(workerUrl: string, registry: string, repository: string, layerHex: string): string;
  ```

- [ ] Step 1：失败测试：`parseImageRef('nginx:1.27')` → docker.io/library/nginx:1.27；`parseImageRef('ghcr.io/o/r:tag')`；`parseImageRef('x@sha256:..')` 抛错（v1 拒 digest）。`parseWWWAuthenticate('Bearer realm="https://a/token",service="s",scope="repository:x:pull"')`。`resolveImage` 用 mock fetch（manifest list→选平台→image manifest）断言返回 config/layers/mediaType；拒 zstd 之外无需拒（透传）；拒 foreign mediaType；manifest > 16MiB 抛错。
- [ ] Step 2：`npm --prefix web test -- --run registryPull` → FAIL。
- [ ] Step 3：实现：ref 解析（补 docker.io/library、拒 `@sha256:`）、token dance（401→parseWWWAuthenticate→取 token，带 Basic if creds→Bearer）、manifest list 平台选择、大小与 mediaType 校验、config blob 下载进内存。`layerBlobUrl` 组 `{registry}/v2/{repository}/blobs/sha256:{hex}` 再包 workerUrl。
- [ ] Step 4：`npm --prefix web test -- --run registryPull` → PASS。
- [ ] Step 5：commit `feat(web): browser registry client (token dance + manifest)`。

---

### Task 5: 前端 WS 流式上传

**Files:**
- Create: `web/src/api/imageLoadStream.ts`
- Create: `web/src/api/imageLoadStream.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function streamTarToDaemon(opts: {
    tar: ReadableStream<Uint8Array>;
    token: string;
    onProgress?: (line: string) => void;
    signal?: AbortSignal;
  }): Promise<void>;   // resolve=daemon done；reject=error/取消
  ```
  用页面 `location` 推导 `ws(s)://…/ws/images/load?token=`（测试可注入 `wsUrl`/`WebSocketCtor`）。

- [ ] Step 1：失败测试：用假 WebSocket（记录 send 的帧、可手动 emit message/close）：喂一个 3 块的 tar stream，断言按序 send 二进制帧后 send `__eof__`；模拟服务端回进度→`onProgress` 收到、回 `{"status":"done"}`→resolve；回 `{"error":"x"}`→reject；`signal.abort()`→close+reject；`bufferedAmount` 高时暂停读取（断言未一次性 send 完）。
- [ ] Step 2：`npm --prefix web test -- --run imageLoadStream` → FAIL。
- [ ] Step 3：实现：open→读 tar reader→按 `bufferedAmount` 阈值背压 send→`__eof__`；onmessage 解析 NDJSON（`done`/`error`）；abort/onerror/onclose 处理。
- [ ] Step 4：`npm --prefix web test -- --run imageLoadStream` → PASS。
- [ ] Step 5：commit `feat(web): websocket tar upload with backpressure`。

---

### Task 6: taskQueue 集成（browser-pull runner）

**Files:**
- Modify: `web/src/stores/taskQueue.ts`
- Create: `web/src/stores/browserPull.ts`（runner，串 4→3→5 + up-to-date 预检）
- Create: `web/src/stores/browserPull.test.ts`

**Interfaces:**
- Consumes: `resolveImage`,`layerBlobUrl`(T4)、`buildDockerLoadTar`(T3)、`streamTarToDaemon`(T5)、`inspectImage`（`web/src/api/inspect.ts`，查本地 ID）。
- Produces: `taskQueue` 的 `enqueue` 支持 `meta.type:'browser-pull'` 与字段 `{ref,platform,workerUrl,creds?}`；runner `runBrowserPull(task, {upd,settle,addNote,signal})`。

- [ ] Step 1：失败测试 `browserPull.test.ts`：mock T3/T4/T5 与 inspect：正常路径调用顺序与 `settle('done')`；本地 ID==config digest→settle done 且不调用 `streamTarToDaemon`（up-to-date）；layer 校验失败→settle error。
- [ ] Step 2：`npm --prefix web test -- --run browserPull` → FAIL。
- [ ] Step 3：实现 runner + 在 `taskQueue` 里对 `meta.type==='browser-pull'` 走 `runBrowserPull` 而非 XHR；`cancel(id)` 触发 `AbortController`。
- [ ] Step 4：`npm --prefix web test -- --run browserPull` → PASS。
- [ ] Step 5：commit `feat(web): browser-pull task runner in queue`。

---

### Task 7: 共享 Pull 选项 UI（下载方式 + worker URL + 凭据）

**Files:**
- Modify: 现有共享 Pull 选项组件（`web/src/components/shared/` 下，实现里定位；`web/src/components/images/ImageListPage.tsx:168` 拉取入口复用它）
- Create: `web/src/stores/browserPullSettings.ts`（localStorage：worker URL + 按 host 凭据）
- Create: `web/src/stores/browserPullSettings.test.ts`

**Interfaces:**
- Produces: `getWorkerUrl()/setWorkerUrl(v)`（仅存合法 https 无凭据 URL）、`getCreds(host)/setCreds(host,c)/clearCreds(host)`（opt-in）、`getDownloadMode()/setDownloadMode('proxy'|'browser')`。

- [ ] Step 1：失败测试：`setWorkerUrl('https://w.example')` 存取；`setWorkerUrl('https://u:p@w')` 拒绝（含凭据）；`setWorkerUrl('http://w')` 拒绝（非 https）；`setCreds/getCreds/clearCreds` round-trip；默认 mode='proxy'。
- [ ] Step 2：`npm --prefix web test -- --run browserPullSettings` → FAIL。
- [ ] Step 3：实现 settings store；在共享 Pull 选项组件加「下载方式」单选，browser 模式露出 worker URL 输入 + 可选「记住凭据(本机)」勾选（默认关，附清除按钮与 XSS 提示文案）。browser 模式提交时 `enqueue({meta:{type:'browser-pull'}, ...})` 而非 POST `/api/images/pull`。
- [ ] Step 4：`npm --prefix web test -- --run browserPullSettings` → PASS；`npm --prefix web run build`。
- [ ] Step 5：commit `feat(web): download-mode option with worker url + creds`。

---

### Task 8: 后端 compose pull-plan 接口

**Files:**
- Modify: `internal/api/compose.go`（加 `handleComposePullPlan`）
- Modify: `internal/api/server.go`（注册 `r.Get("/api/compose/pull-plan", ...)`，RoleViewer）
- Create: `internal/api/compose_pull_plan_test.go`

**Interfaces:**
- Consumes: 现有 project loader（`resolved`/`project.Services`，见 `compose.go:459`）。
- Produces: `GET /api/compose/pull-plan?id=…` → `{"images":[{"service","ref","platform"}],"rejected":[{"service","ref","reason"}]}`；reason ∈ `build|digest`。

- [ ] Step 1：失败测试：加载一个含普通 image、一个 `build:` 服务、一个 digest 引用服务的项目 → 断言普通进 `images`（带 platform）、build 进 `rejected(build)`、digest 进 `rejected(digest)`。
- [ ] Step 2：`go test ./internal/api/ -run ComposePullPlan -v` → FAIL。
- [ ] Step 3：实现：遍历活动 `project.Services`；有 `Build` 非空→rejected(build)；`Image` 含 `@sha256:`→rejected(digest)；否则进 images，platform 取 service.Platform 否则空（前端按 daemon）。
- [ ] Step 4：`go test ./internal/api/ -run ComposePullPlan -v` → PASS。
- [ ] Step 5：commit `feat(api): compose pull-plan endpoint`。

---

### Task 9: Compose 浏览器拉取 UI 编排

**Files:**
- Modify: compose 详情/列表操作组件（`web/src/components/compose/`，定位「拉取」「Up」按钮）
- Modify: `web/src/stores/browserPull.ts`（加 `runBrowserPullCompose` 父任务）
- Create: `web/src/stores/browserPullCompose.test.ts`

**Interfaces:**
- Consumes: `GET /api/compose/pull-plan`、`runBrowserPull`(T6)、`POST /api/compose/up`（`pull_policy:'never'`，不带 proxy_url）。
- Produces: `runBrowserPullCompose(id, mode:'pull'|'up', deps)`。

- [ ] Step 1：失败测试：mock pull-plan 返回 2 images + 1 rejected(build) → 断言先提示 rejected 即中止（不 up）；无 rejected 时逐个 `runBrowserPull`，全成功后 mode='up' 调用 up 且 body 含 `pull_policy:'never'` 且无 `proxy_url`；mode='pull' 不调用 up。
- [ ] Step 2：`npm --prefix web test -- --run browserPullCompose` → FAIL。
- [ ] Step 3：实现父任务 runner；compose 按钮在 browser 模式走它。
- [ ] Step 4：`npm --prefix web test -- --run browserPullCompose` → PASS。
- [ ] Step 5：commit `feat(web): compose browser-pull (preload + up pull=never)`。

---

### Task 10: 收尾校验

- [ ] Step 1：`go test ./... && go vet ./...`（docker 真机 acceptance 为 opt-in，跳过）。
- [ ] Step 2：`npm --prefix web test -- --run && npm --prefix web run build`。
- [ ] Step 3：更新服务端代理 spec 的关联链接（可选）；确认新 spec/plan 已提交。
- [ ] Step 4：commit（若有）`chore: browser-pull final verification`。

## Self-Review

- 覆盖 spec §4(T1) §5.1(T4) §5.2(T3) §5.3(T5) §5.4(T6) §5.5(T7) §6(T2) §7(T8,T9) §9(各任务测试+T10)。
- 无 TBD/占位；类型名跨任务一致（`buildDockerLoadTar`/`resolveImage`/`layerBlobUrl`/`streamTarToDaemon`/`runBrowserPull`/`runBrowserPullCompose`）。
- 待实现时定位：共享 Pull 组件与 compose 按钮的确切文件（T7/T9 首步先 grep 定位再改）。
