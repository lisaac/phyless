# Compose Build

在 Compose 列表中为可构建的项目提供一键 `docker compose build`。

## 功能概述

Compose 列表每行的操作区中，「删除」按钮**前面**会出现一个 `🔨 Build` 按钮。
点击后对该项目执行 `docker compose build`，构建过程以流式日志的形式经全局任务
队列（`web/src/stores/taskQueue.ts`）返回，与 Up / Pull 等操作一致。

Build 按钮**仅在满足以下全部条件时显示**：

1. 项目为**已注册**项目（自动发现的项目只显示「注册」，不显示 Build / 删除）；
2. 项目的 compose 文件**可被服务读取**（缺失、未挂载、解析失败都视为不可读）；
3. compose 文件中**至少有一个 service 声明了 `build:`**（纯 `image:` 的服务不算）。

任一条件不满足时按钮不出现，避免对不含构建配置的项目给出无意义的操作。

## 后端

### 接口

```
POST /api/compose/build?id=<项目ID>
```

复用 `runComposeOperation`（`internal/api/compose.go`），内部调用官方 Compose API 的
`service.Compose().Build`，进度以 `plain` 模式流式写回。需要可读的 compose 文件；
文件不可读时返回错误，不会静默构建一个不同的配置（与 Up / Pull 的严格策略一致）。

### 构建能力标记 `can_build`

列表接口 `GET /api/compose` 的每个**已注册**项目会附带 `can_build` 字段：

```go
func (s *Server) projectHasBuild(ctx, p) bool // 加载 compose 文件，任一 service 含 Build 即为 true
```

加载失败（不可读）返回 `false`，恰好满足「仅当 yaml 可读」的要求。

> 注意：该判断在每次列表轮询（默认 5s）时对已注册项目逐个解析 compose 文件。
> 注册项目数量少、文件在本地，成本可忽略；若日后成为热点，可按文件 mtime 缓存。

### 校验

`validateComposeOperation` 中针对**含 `build:` 的 service**的既有限制现在同样覆盖
`build` 操作：使用拉取代理、远程构建 context / Dockerfile / 附加 context 时会拒绝
（嵌入式 Compose API 不支持这些远程构建源）。

## 前端

- `build` 已并入共享的 `ComposeVerb` 与 `VERB_LABEL`（`composeShared.tsx`），
  与其他 compose 动词共用一套按钮与运行态逻辑。
- 类型 `ComposeProject` 新增可选字段 `can_build`（`web/src/types.ts`），仅出现在
  列表响应中。
- 按钮渲染在 `ComposeListPage.tsx` 的操作区，位于「删除」之前，`<Show when={p.can_build}>`
  控制显隐。Build 不需要拉取选项，点击后直接入队执行。

## 已知范围

- Build 按钮目前只在**列表页**提供；详情页未加（如需可后续对齐）。
- 自动发现的项目不提供 Build。
