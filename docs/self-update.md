# phyless 管理自身容器

phyless 运行在容器里时，也可以在界面上升级、重启、停止自己所在的容器，或对自己所在的 Compose 项目执行操作。问题在于：升级或 Compose 重建都需要先停止旧容器，而停掉旧容器就会结束 phyless 进程本身，后面的“启动新容器”就永远不会执行，结果是旧容器已停、新容器没起来。

解决办法是把这类操作交给一个一次性的 **helper 容器** 来完成。helper 在 phyless 之外运行，phyless 被停掉后它仍会把操作做完。

## 识别自身容器

- 启动时，phyless 在**当前工作目录**写一个隐藏的标记文件 `.phyless-self-<随机值>`，写之前先删掉上次运行留下的 `.phyless-self-*`。当前目录不可写（例如 `read_only` 容器）时改写到数据目录。
- 需要判断时，phyless 通过 Docker API 的 `ContainerStatPath` 依次检查正在运行的容器里有没有这个文件，有就是自身。容器 ID 以 hostname 开头的那个先检查（Docker 默认 hostname 是短 ID），通常一次调用就能找到。
- phyless 所在的容器在进程启动前就已经在运行，所以扫描一次的结果就是最终结论。结果按 Docker 运行时缓存，切换 Docker 服务器后重新扫描；扫描时出现暂时性错误不会被缓存。
- **裸运行**：标记文件在主机上，任何容器里都找不到它，所有操作都走原来的流程，行为不变。连接远程 Docker 主机时同理。
- 没有采用的方案：解析 `/proc/self/mountinfo` 或比较 hostname（只能猜，`network_mode: host` 下 hostname 就是主机名）；watchtower 式的镜像 label（只能知道“这是一个 phyless”，不能确定是不是当前进程，而且要求使用官方镜像）。watchtower 能先启动新实例、再由新实例停掉旧实例，是因为它不占端口；phyless 要监听 8080，新旧两个实例不能同时运行。

接口：`GET /api/system/self` 返回 `{"id": "<自身容器 ID>"}`，裸运行时为空字符串。

## helper 容器

| 项 | 取值 |
|---|---|
| 名称 | `phyless-helper`（固定名称；已有一个在运行时拒绝新操作，相当于跨进程锁） |
| 镜像 | 当前 phyless 容器的镜像 ID，保证发起操作和执行操作的是同一版本代码 |
| 命令 | `phyless -C <数据目录> helper --user <用户> <操作>` |
| 挂载 | `VolumesFrom: [自身容器]`：docker.sock、数据目录、Compose 文件都和 phyless 看到的路径一致 |
| 其他 | 复制 User、Env、GroupAdd、SecurityOpt 和网络；不共享 phyless 的网络命名空间（它会随 phyless 一起消失）；`RestartPolicy=no`；带 `phyless.role=helper` 标签，容器列表里不显示 |

helper 支持的操作：

- `container-upgrade <id> [ENV...]`：执行现有的升级流程，使用已拉取的镜像；失败时同样会回滚。
- `compose <up|redeploy|restart|stop|down> <项目 id>`：只使用本地镜像，不在 helper 里拉取。

helper 执行结束后**保留不删**，下次执行前再删除，这样 phyless 重启后仍能读到上次的结果（`GET /api/system/helper`：`none | running | ok | failed`，附带最后一条消息或错误）。代价是它会让上一版 phyless 镜像一直被引用，直到下一次 helper 运行；如果要立即清理旧镜像，先删掉 `phyless-helper` 容器。审计记录由 helper 写入，用户名是发起操作的用户。

## 各操作的处理方式

| 操作 | 目标是自身时 |
|---|---|
| 容器升级（包括“待重建”） | 拉取和校验镜像仍在 phyless 里完成，最后的重建交给 helper |
| Compose up / restart | 整个项目交给 helper。需要拉取的镜像先由 phyless 按请求里的凭据和代理拉好 |
| Compose Update | 前端把原来的 down、up 两个请求合并成一个 `POST /api/compose/redeploy`，避免 phyless 在两个请求之间被停掉；非自身项目同样使用这个接口 |
| Compose stop / down | 交给 helper，操作结束后 phyless 停止；前端会先确认 |
| Compose pause、容器暂停 | 拒绝：暂停后 phyless 无法自行恢复 |
| 容器重启 | 不需要 helper：Docker 的重启在守护进程内一次完成，客户端断开不会打断（moby `containerRestart` 使用 `context.WithoutCancel`）。前端先确认，断线后等待 phyless 恢复，然后刷新页面 |
| 容器停止 / 强制关闭 / 删除 | 不需要 helper（删除接口不受请求取消影响）。前端先确认，断线后任务记为完成并提示需要在主机上手动启动 |

## 前端

- 进度流中带有 `"helper": true` 的事件表示操作已交给 helper。从这一刻起，前端立即开始每 2 秒轮询 `/api/system/helper`，以 helper 的结果为准，不依赖进度流是否结束。经过反向代理时，phyless 退出后浏览器端的连接可能一直不断开（vite 实测如此）。任务队列（XHR）和 `streamPost` 共用 `frontend/src/api/selfRestart.ts` 的同一实现。
- `"stops": true` 表示操作结束后 phyless 不会再启动（Compose stop/down）：后端变得不可达即为完成，不刷新页面。其他情况在 helper 成功后自动刷新页面，加载新版前端。
- 代理在 phyless 停止后返回的 5xx 错误页（非 JSON）视为断线，不当作 phyless 的报错。
- 等待期间不显示“无法连接后端服务”的常驻提示；最长等待 10 分钟。取消任务会同时停止轮询。
- 所有响应都带有 `X-Content-Type-Options: nosniff`。否则 Chrome 会为了嗅探 MIME 类型先缓冲约 1KB 的 `text/plain` 流，交接时只有几行的短进度流在连接断开后就一行都显示不出来。

## 代码位置

- `backend/internal/docker/self/`：标记文件、扫描、启动 helper 并转发其日志、读取结果
- `backend/internal/api/helper.go`：`phyless helper` 子命令、`/api/system/helper`、`/api/system/self`
- `backend/internal/api/compose.go`：`composeSelf` / `composeHandoff` / `composeExec`（进程内和 helper 共用的 Compose 执行逻辑）
- `backend/internal/docker/container/upgrade.go`：`UpgradeOptions.Handoff`
- `frontend/src/api/selfRestart.ts`、`frontend/src/stores/taskQueue.ts`、`frontend/src/stores/browserPull.ts`（`streamPost`）、`frontend/src/components/containers/containerActions.ts`

## 已知限制

- 真实 Docker 环境下的端到端验证需要在实际部署中进行；仓库里的测试覆盖了标记扫描、交接后的前端流程和 Compose 命令序列。
- helper 只使用本地镜像。Compose 项目中缺少镜像的 build 服务会在 helper 里构建，构建时拉取的 `FROM` 基础镜像走 daemon 自身的网络和凭据，不经过请求里的代理。
- 删除 phyless 自身容器时，原有的“删除容器”确认之后还会再弹一次针对自身的确认。
