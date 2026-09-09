# Compose「Update」与 容器/镜像列表「升级」— 设计

日期：2026-09-09

## 目标

1. 为 Compose 项目新增「Update」动作：`build`（若有 build 服务）→ `pull` → `down` → `up`，
   兼顾服务端代理与浏览器（CF worker）代理两种拉取方式。
2. 容器列表新增「升级」按键，复用容器详情页已有的升级流程。
3. 镜像列表新增「升级」按键，复用现有 pull 流程（弹窗确认代理）。

约束：一份共享实现（禁止各页面拷贝）、解耦收敛、控制 CPU/内存/网络开销。

## 背景（现状）

后端已具备全部所需端点，均以 NDJSON 流式返回、接受代理选项与 `pull_policy`，**无需后端改动**：

- `POST /api/compose/{up,down,pull,build,restart,stop}`（`internal/api/compose.go`）
- `GET /api/compose/pull-plan`（`internal/api/server.go`）— 返回 `{images[], rejected[]}`，
  `rejected` 的 `reason` 为 `"build"`（build 服务）或 `"digest"`（digest 固定，无法拉取）。
- 容器升级：`POST /api/containers/{id}/upgrade`，接受 `PullOptions` 代理载荷（仅服务端代理）。

前端现状：

- `stores/taskQueue.ts`：全局任务队列，同 `key` 串行 FIFO、全局并发上限 4；`start()` 按 `meta.type`
  分发 `browser-pull` / `browser-pull-compose`，其余走 XHR。**队列失败不停后续同 key 任务**。
- `stores/browserPull.ts`：`runBrowserPull`（浏览器下载→流式导入 daemon）、`runBrowserPullCompose`
  （预载项目所有镜像→可选 `up pull_policy=never`）、内部 `composeUpNever`（NDJSON 解析报错）。
- `components/compose/ComposeActionModal.tsx`：`up/pull` 打开代理选项弹窗，其余直接入队；已含
  browser-pull-compose 分支。
- `components/compose/composeShared.tsx`：`ComposeVerb`、`VERB_LABEL`、`servicesHaveBuild`、`ActBtn`。
- 容器升级逻辑**内联**在 `components/containers/ContainerDetailPage.tsx`（`doUpgrade`/`startUpgrade`
  + Modal + `upgradePull`，仅服务端代理）。
- `components/containers/ContainerRow.tsx`：容器列表 / compose 列表展开区 / compose 详情三处共用的行，
  已用页面级回调模式（`onViewCmd`/`onConsole`）。
- `components/images/ImageListPage.tsx`：已有完整 pull 流程（`showPullInput` + `pull` + `startPull`
  + 带 `allowBrowser` 的 `PullOptions` 弹窗）。

## 决策

- Update 末步 `up` 使用 `pull_policy=never`：build/pull 刚产出本地镜像，避免多一次 registry 往返，
  也让浏览器代理模式下 daemon 不再访问 registry。
- 服务端模式下 `build` 与 `pull` 均携带代理载荷（build 端点已经 `runComposeOperation` →
  `composeRequest` 解析同一套代理选项）。浏览器模式无服务端 `proxy_url`，build 仍走 daemon，见下方限制。
- 浏览器代理 + build 服务：采用**混合**。`pull-plan` 已把项目拆成 `images`（可预载）/ `rejected:build`
  （交给服务端 build）/ `rejected:digest`（报错）。因此：build 服务端 build，`images` 浏览器预载，
  遇到 `digest` 拒绝则报错。
- Update 编排采用**单个客户端编排任务**（新 `meta.type = "compose-update"`），而非 4 条独立任务或新增
  服务端端点。理由：队列失败不停 → 4 条任务语义错误；服务端端点无法走浏览器代理 → 浏览器模式仍需另一条
  客户端路径，导致分叉。单编排一次覆盖两种模式，且零后端改动。

## 设计

### 1. Compose Update 编排

`runComposeUpdate(params, cb, deps)`（新增于 `stores/browserPull.ts`），顺序 `await`、任一步抛错即整体失败：

```
服务端模式:                            浏览器模式:
  1. build  [代理选项]（若 canBuild）   1. build（若 canBuild）      ← 服务端，无 server 代理
  2. pull        [代理选项]             2. 预载 plan.images         ← 浏览器 CF worker
  3. down                               3. rejected 中含非 build（digest）→ 报错
  4. up  pull_policy=never              4. down
                                        5. up  pull_policy=never
```

参数：`{ id, mode: "server"|"browser", canBuild: boolean, workerUrl?, creds?, pullOptions? }`
（`pullOptions` 为服务端模式的代理载荷）。

**收敛**：从现有代码抽两个 helper 并复用：

- `streamCompose(verb, id, { body, token, onProgress, signal })` — 泛化现有 `composeUpNever` 的
  NDJSON 解析报错循环，供 build/pull/down/up 共用。
- `preloadComposeImages(id, { workerUrl, token, creds }, cb, deps)` — 浏览器预载循环（含 `rejected`
  判定：仅 `build` 允许跳过交给服务端，其余原因报错），供 `runBrowserPullCompose` 与
  `runComposeUpdate` 共用。

结果：`runBrowserPullCompose` 变小；`composeUpNever` 由 `streamCompose("up", …, { pull_policy: "never" })` 取代。

**已知限制（v1 范围外，`// ponytail:` 标注）**：浏览器代理下，若 build 服务的 `FROM` 基础镜像本地缺失且
daemon 无法访问 registry，服务端 `compose build` 会在 `FROM` 阶段失败——编排如实报错并停止。这是既有限制
（现有 Build 按钮同样如此）。升级路径：将来在 build 前经浏览器预载 build 服务的 `FROM` 基础镜像。

**队列分发**（`stores/taskQueue.ts`）：`start()` 新增
`if (t.meta?.type === "compose-update") { startComposeUpdate(id); return; }`，`startComposeUpdate` 仿
`startBrowserPullCompose`：建 `AbortController`、接 note/progress、读 `t.meta`（`composeId`/`mode`/`canBuild`/`workerUrl`）
与 `t.secret.creds` 与 `t.body`（服务端 `pullOptions`），调用 `runComposeUpdate`。

**入口 UI**：

- `composeShared.tsx`：`ComposeVerb` 增 `"update"`；`VERB_LABEL.update = "Update"`。
- `ComposeActionModal.tsx`：
  - `requestComposeAction`：把 `update` 纳入「打开代理选项弹窗」集合（与 up/pull 并列）。
  - 弹窗内 update **不显示** `pull_policy` 选择器（强制 never）；显示 `PullOptions`（`allowBrowser`）。
  - `start()` 增 update 分支：浏览器模式入队 `meta.type=compose-update, mode=browser, canBuild, workerUrl`
    + `secret.creds`；服务端模式入队 `meta.type=compose-update, mode=server, canBuild`，`body=pull.payload()`。
  - `ComposeAction` 接口加 `canBuild?: boolean`。
- `ComposeDetailPage.tsx`：动作栏加 `⬆ Update` `ActBtn`，`canBuild = servicesHaveBuild(detail()?.services)`。
- `ComposeListPage.tsx`：项目行动作区加 `⬆` 升级 `IBtn`，`canBuild = p.can_build`。

Update 任务 `key = compose:{id}`，与该项目其他 compose 操作串行，天然避免后端 per-project 409。

### 2. 容器列表「升级」

新增共享组件 `components/containers/UpgradeContainerModal.tsx`（`{ target: {id,name}|null; onClose }`），
内部持 `createPullOptions()` + enqueue 到 `/api/containers/{id}/upgrade`（`meta.type="upgrade"`，仅服务端代理），
照搬 `ViewCmdModal`/`ConsoleModal` 的页面级模态模式。

- `ContainerDetailPage.tsx`：删除内联 `doUpgrade`/`startUpgrade`/`closeUpgradeOptions` + 内联 Modal +
  `upgradePull`，改渲染 `<UpgradeContainerModal>`，升级按钮改为设置 `target`。
- `ContainerRow.tsx`：加可选 `onUpgrade?: (t:{id,name}) => void`，operator 分支加 `↑` 升级 `IBtn`
  （点击 `stopPropagation` 后调 `onUpgrade`）。
- `ContainerListPage.tsx`：渲染**一个** `<UpgradeContainerModal>` 实例，把 `onUpgrade` 传给每个
  `ContainerRow`。`ComposeListPage`/`ComposeDetailPage` 已渲染 `ContainerRow`，可按需一并接上（列表升级为主）。

**要点**：模态在页面级、行仅发回调 → 不会每行创建一份 `createPullOptions` 信号（省内存）。行为与详情页完全一致
（仅服务端代理）。

### 3. 镜像列表「升级」

镜像升级 = 重新 pull 该镜像 tag。复用 `ImageListPage` 现有 pull 流程：每行加 `↑` 升级 `IBtn`，点击时
`setPullRef(img.RepoTags[0])` 后 `setShowPullInput(true)`，打开**现有** pull 弹窗（`PullOptions` 即代理确认）。

- 无 tag(`<none>`) 的镜像不显示升级按钮；多 tag 取 `RepoTags[0]`。
- 零新组件、零新入队逻辑。

## 测试

- `browserPull.test.ts`：`runComposeUpdate` 用注入 deps 断言两种模式的调用序列与失败即停
  （build 失败不触发 down/up；digest 拒绝报错；浏览器模式 build 服务交给 build、`images` 预载）。
  `streamCompose`/`preloadComposeImages` 抽取后现有 `browserPullCompose` 测试应保持通过。
- `ComposeActionModal.test.tsx`：update 打开弹窗、无 pull_policy 选择器、两种模式入队 meta/body 正确。
- `UpgradeContainerModal` 测试：入队 URL/meta 正确；`ContainerDetailPage` 迁移后行为不变。
- `ImageListPage`：升级按钮预填 ref 并打开弹窗；`<none>` 不显示。

## 改动文件

- `web/src/stores/browserPull.ts`、`web/src/stores/taskQueue.ts`
- `web/src/components/compose/{composeShared.tsx, ComposeActionModal.tsx, ComposeDetailPage.tsx, ComposeListPage.tsx}`
- 新增 `web/src/components/containers/UpgradeContainerModal.tsx`；改
  `web/src/components/containers/{ContainerDetailPage.tsx, ContainerRow.tsx, ContainerListPage.tsx}`
- `web/src/components/images/ImageListPage.tsx`
- 相应 `*.test.tsx / *.test.ts`

无后端改动。
