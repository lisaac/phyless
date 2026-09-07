# 镜像文件浏览 — 执行计划

Spec：`docs/superpowers/specs/2026-09-07-image-files-design.md`。主代理统筹与验收；不得改动/提交工作区里与本功能无关的未提交改动。

1. [opus] `internal/docker/imagefs` 包 + 单测（索引器、Manager、GC、inflight、启动清理）。
2. [sonnet] API：两路由、`serveArchive` 抽取、`IsHelper` 过滤、`removeImage` 收敛、`Run` 接入 + 路由测试。依赖 1。
3. [sonnet] 前端：`createDownloadTask` 抽取、`ImageListPage` 文件 modal + 测试。可与 1 并行。
4. 主代理审核每步，最后 `go test -race ./...`、`vitest`、`go build`/`vite build`。
