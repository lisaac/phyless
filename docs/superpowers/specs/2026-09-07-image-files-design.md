# 镜像文件浏览 — 设计

状态：已确认（2026-09-07）。参数：空闲 10 分钟回收，GC 每 1 分钟。

## 约束
- 容器文件列表走 exec `ls`，停止容器不可用，镜像浏览不能复用。
- 部署只挂 `docker.sock`，无宿主机 `/var/lib/docker`，只能走 Docker API。
- Archive API 无"列目录"，只有递归 tar。

## 决策：一次 export 建索引（方案 A）
创建**只创建不启动**的容器，`ContainerExport` 一次流过整个 rootfs，只解析 tar header（内容 `io.Discard`），
内存里建 `dir → []FileEntry` 索引。之后列目录零 Docker 调用；下载走 `CopyFromContainer` 单文件直通。

否决：每次列目录 `CopyFromContainer(dir)`（点 `/` 等于拉整镜像，重复传输）；宿主机 overlay2 层合并（与部署不符）。

## 后端：`internal/docker/imagefs`
- `Manager`：`New(cli client.APIClient) *Manager`；`List(ctx, imageID, path) ([]container.FileEntry, error)`；
  `Open(ctx, imageID, path) (io.ReadCloser, error)`；`Release(ctx, imageID) error`；`Run(ctx)`（GC 循环，阻塞）；
  `IsHelper(labels map[string]string) bool`。
- 会话 `{containerID, index, lastUsed, inflight}`。首次访问按 label 查已有容器，没有则 create，然后 export 建索引。
  同镜像并发合并为一次索引（`ready chan`），不同镜像互不阻塞。慢 I/O 不持全局锁。
- 容器：`Image=<imageID>`（sha256 完整 ID，不用 tag）、`Cmd=["/"]`、`NetworkMode=none`、名 `phyless-imgfs-<12hex>`、
  标签 `phyless.role=image-fs` + `phyless.image=<imageID>`。永不 start。删除时 `RemoveVolumes:true`（镜像 VOLUME 会生成匿名卷）。
- GC：每分钟扫，`inflight==0 && idle>10min` 的会话 `ContainerRemove` + 丢索引。启动时删除全部带 label 的遗留容器。
  `Open` 返回的 reader 在 Close 时减 inflight，下载中不会被回收。
- 索引：复用 `container.FileEntry`；symlink 记为文件（size 0），hardlink 按普通文件；路径按 POSIX 规范化，
  `..` 越界返回 400 语义错误。目录条目缺失时按隐式目录处理（tar 可能只有 `a/b/c` 没有 `a/`）。

## API
- `GET /api/images/files?id=&path=` → `[]FileEntry`，viewer。
- `GET /api/images/files/download?id=&path=&token=` → tar，`wsAuth` viewer，与容器下载相同。
  抽 `serveArchive(w, rc, base)` 供容器/镜像两处共用。

## 侵入点
- `handleListContainers`、`handleListImages` 的 `UsedBy`：过滤 `IsHelper`。
- 删镜像：`handleDeleteImage` 与 `handleImageDeleteProgress` 收敛到 `s.removeImage(ctx, id, force)`，先 `Release` 再 `ImageRemove`。
- `api.New` 里 `go mgr.Run(context.Background())`（main 无优雅退出，启动清理兜底）。
- `/ws/events` 因辅助容器多触发几次 refetch，接受。

## 前端
- `ImageListPage` 行操作加"文件"按钮 → `Modal wide` 内嵌 `FileBrowser`（`instanceKey=img.Id`，只传 `listPath`/`onDownload`）。
- `ContainerDetailPage` 的下载状态机抽为 `createDownloadTask()`（`web/src/api/download.ts`），两页共用。

## 开销
CPU：每镜像每 idle 窗口一次 header 扫描。内存：约 80B/文件，10 分钟释放。网络：一次 export + 单文件下载。磁盘：空 upper 层。

## 测试
- imagefs：现造 tar 喂索引器（目录/隐式目录/symlink/嵌套）；fake client + 注入时钟验证 GC、inflight 保护、启动清理、并发合并。
- api：fake client 验证两路由鉴权、删镜像前 Release、列表过滤。
- web：`createDownloadTask` 单测，ImageListPage smoke。
