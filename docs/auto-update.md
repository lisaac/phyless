# 自动检查与更新

为单个容器或 Compose 项目设置策略：定时检查镜像是否有新版本，可选自动更新，可选更新后删除旧镜像。手动检查升级见 [container-upgrade.md](container-upgrade.md)，phyless 自身升级见 [self-update.md](self-update.md)。

## 使用

- **容器详情**：操作栏 `↻ 自动更新`。由 Compose 管理的容器不显示这个按钮，请到所属项目设置。
- **Compose 详情**：操作栏 `↻ 自动更新`。
- 设置了策略的容器 / 项目，在列表行和详情标题旁显示 `↻ 自动`，悬停可看定时和上次结果。颜色：绿 = 正常，琥珀 = 有新版本（只检查模式），红 = 失败或跳过，灰 = 已停用。
- 弹窗里可以 `立即执行` 一次（进入任务抽屉），也可以删除策略。
- **全局管理**：侧栏「配置 → 自动更新」（operator 及以上）列出当前 Docker 服务器的全部策略：目标、定时、上次运行、最近一次更新的结果和原因。每行可以编辑（同一个弹窗）、立即执行、删除。目标已不存在的策略标为「目标不存在」，在这里清理。

## 结构

| 部分 | 位置 | 说明 |
|---|---|---|
| 定时计算与调度循环 | `backend/internal/autoupdate` | 不依赖 Docker；调用方提供策略列表和执行函数 |
| 执行与接口 | `backend/internal/api/autoupdate.go` | 检查、更新、记录结果 |
| 检查 | `checkUpdates`（`update_check.go`） | 与手动检查共用 |
| 容器升级 | `upgradeContainer`（`containers.go`） | 与手动升级共用，含自身容器 helper 交接 |
| Compose 操作 | `composeRun`（`compose.go`） | 与 HTTP 操作共用：加锁、校验、自身项目交接 |
| 删除旧镜像 | `removeUnusedImages`（`containers.go`） | 手动升级和自动更新共用 |
| 前端 | `stores/autoUpdate.ts`、`components/shared/AutoUpdate.tsx` | 容器和 Compose 共用同一个弹窗和标记 |

## 策略

存在 `config.json` 的 `auto_updates`，每个目标（同一 Docker 服务器上的同一 `kind` + `target`）只有一条：

| 字段 | 说明 |
|---|---|
| `kind` | `container` \| `compose` |
| `target` | 容器**名**（不用 ID：升级后 ID 会变），或 Compose 项目 ID（与 `/api/compose` 中的 `id` 一致） |
| `server_id` | 所属 Docker 服务器，保存时取当前激活的服务器 |
| `enabled` | 停用后保留设置，不再运行 |
| `mode` | `check`：只检查并标记；`update`：有新版本就更新 |
| `schedule` | 见"定时格式" |
| `proxy_url`, `registry_ids` | 拉取方式，同拉取选项 |
| `remove_old_image` | 更新成功后删除旧镜像 |
| `updated_at` | 保存时间，从未运行过时作为定时起点 |
| `last_run_at`, `last_status`, `last_error`, `last_log` | 上次运行结果；`last_log` 只留最后 30 行文本，跳过逐层下载进度 |

`last_status`：`running`、`latest`（已是最新）、`available`（只检查模式下有新版本）、`updated`、`handed-off`（phyless 自身，交给 helper 完成并审计）、`skipped`（需要人工处理，原因在 `last_error`）、`missing`（目标不存在）、`interrupted`（执行中 phyless 停止）、`error`。

**最近一次更新**单独记录，不会被之后的例行检查覆盖：

| 字段 | 说明 |
|---|---|
| `last_update_at` | 开始更新的时间（检查结束、真正动手之前写入） |
| `last_update_status` | `running`、`updated`、`handed-off`、`failed`、`interrupted` |
| `last_update_message` | 改了什么（容器：`ref：旧镜像 → 新镜像`；Compose：`服务 a, b`）；失败时附上原因 |

**中断**：phyless 启动（或切换到某个 Docker 服务器）时，把该服务器上仍是 `running` 的记录改为 `interrupted`。更新 phyless 自身时一定会这样结束，结果以审计日志里 helper 的记录为准。

### 目标不存在

- 执行时容器 inspect 返回 NotFound，或 Compose 项目查找返回 404，记为 `missing`，并在 `missing_since` 记下第一次发现的时间。`compose down` 后项目仍登记着，这算"未运行"（`skipped`），不算不存在。
- **从不自动删除策略**：同名容器重新创建（CLI `docker rm` + `docker run --name 同名`、重建 Compose 项目）后，下次执行会自动接上，并清除 `missing_since`。
- 在 phyless 里删除容器或注销 Compose 项目时，同时删除对应策略；在 phyless 里重命名容器时，策略跟着改到新名字。这一步只在存在容器策略时多做一次 inspect。
- 在 CLI 中删除或改名不经过 phyless，靠上面的执行时检查发现。全局管理页还会拿当前的容器 / Compose 列表比对，不必等到下次执行。

**拉取方式**：只支持"不使用代理"和"服务端代理"。"浏览器代理导入"要求浏览器在线，定时任务无法执行，弹窗中不提供这个选项。

### 定时格式

`schedule` 是一个对象，`kind` 决定其余字段：

| `kind` | 字段 | 含义 |
|---|---|---|
| `hours` | `every`（1–168） | 每 N 小时 |
| `daily` | `time`（`HH:MM`） | 每天该时刻 |
| `weekly` | `weekday`（0=周日 … 6=周六）、`time` | 每周该日该时刻 |
| `monthly` | `day`（1–31）、`time` | 每月该日该时刻；当月没有该日（如 31 日）时取当月最后一天 |

到期时间 = 从起点之后的第一个触发时刻，起点取"上次运行"和"保存时间"中较晚的一个。因此保存后不会立刻执行，需要立刻跑就用 `立即执行`。phyless 停机期间错过的多次触发，恢复后只补跑一次。时间按服务端本地时区计算，容器部署需设置 `TZ`。没有引入 cron 依赖。

## 调度与资源占用

- 每个 Docker runtime 一个 goroutine（`newState` 中启动），切换 Docker 服务器时随 runtime 的 ctx 停止，新 runtime 重新启动。
- **不轮询**：只有一个 timer，睡到最早到期的策略；保存或删除策略时唤醒它重新计算。最长睡 1 小时再重算一次，以感知系统休眠、校时等时钟跳变。
- **串行执行**：同一时间只跑一个策略，避免 registry 限流和多个服务同时停机。
- 单次执行最长 1 小时。
- 每次执行写两次 `config.json`：开始时记录 `running` 和运行时间，结束时记录结果。如果开始时的写入失败，调度器在内存中记住启动时间，不会反复执行同一个策略。
- **限制**：只运行当前激活的 Docker 服务器上的策略。让所有服务器都运行，需要为每个服务器常驻一个 client，暂不做。

## 单容器

1. `checkUpdates` 检查容器镜像。
2. `latest`：记为已是最新。`unsupported` / `error`：记为失败。
3. 有新版本：
   - `mode=check`：记为 `available`；
   - `mode=update`：`update` 拉取后升级，`local-newer` 直接用本地镜像升级。phyless 自身容器交给 helper。
4. 以下情况跳过（`skipped`），需要人工处理：
   - 带 `io.phyless.upgrade-image-ref` 标签，且有"镜像也定义、但值不同"的 ENV（即升级弹窗里需要确认 `env_from_image` 的情况，`NeedsEnvReview`）：手动升级一次即可；
   - 带 `com.docker.compose.project` 标签：应对项目设置策略，避免 `com.docker.compose.image` 标签与实际镜像不一致。

## Compose 项目

1. 项目必须在运行（能从标签找到容器），否则跳过。
2. 对项目**正在运行**的容器调用 `checkUpdates`，按服务汇总（手动停掉的服务不检查，也不会被 `up` 启动）。部分服务检查失败时记入日志，不影响其他服务；全部失败才记为失败。
3. 有服务落后且 `mode=update`：
   - `pull` **只拉取有新版本的服务**（不带依赖）；`local-newer` 的服务不需要拉取；
   - `up`（`pull_policy: never`）**只作用于落后的服务及其依赖**，不会启动你手动停掉的其他服务。compose 只重建镜像变化的容器；
   - 项目正在被手动操作（拿不到项目锁）：本次失败，下次到期再试；
   - phyless 自身所在的项目：拉取在本进程完成，`up` 交给 helper，同样只作用于这些服务。
4. 带 `build` 的服务不会重建，base 镜像更新也不跟进。

## 清理旧镜像

- 只在更新成功后执行；失败、回滚、交给 helper 的情况都不清理。
- 列出所有容器一次，旧镜像仍被任何容器使用就保留，并在日志中注明。
- 旧镜像仍有 tag（例如还被 `app:v1` 引用）时保留：按 ID 删除只剩一个 tag 的镜像时 Docker 不会拒绝，会连 tag 一起删掉。
- 调用 `removeImage(ctx, id, false)`，**从不 force**，Docker 拒绝时记录"未删除"即可。
- 不做全局 `image prune`。

手动升级弹窗也有同样的勾选项（单个和批量共用，记住上次的选择），升级接口参数为 `remove_old_image`。

## 网络消耗：HEAD 优先

Docker Hub 把 manifest GET 计入拉取配额，定时检查会放大这个问题。所以检查时：

- 同一 `ref|平台` 下的本地镜像都有 RepoDigests（daemon 拉取的镜像）时，先用 HEAD 取顶层 digest 比对。HEAD 不计入 Docker Hub 配额，也不下载 manifest 内容；
- HEAD 失败（registry 不返回 digest 头、phyless 直连不到 registry 等）时，回到原来的完整查询。不使用代理时，HEAD 最多等 5 秒，给完整查询留出时间；
- 没有 RepoDigests 的镜像（代理或浏览器导入）仍用 GET 取 config digest。

手动检查升级也走同样的逻辑。

## 接口

```
GET    /api/auto-updates            （operator）当前 Docker 服务器的策略，含上次结果
PUT    /api/auto-updates            （operator）按 kind+target 新建或替换，保留上次结果
DELETE /api/auto-updates/{id}       （operator）
POST   /api/auto-updates/{id}/run   （operator）立即执行一次，输出与升级相同的 NDJSON 进度流
```

审计：保存 `autoupdate.save`、删除 `autoupdate.delete`，执行 `autoupdate.container` / `autoupdate.compose`，执行时用户记为 `auto-update`。

## 已知限制

- 不发外部通知（webhook / 邮件），结果只在 UI 和审计日志中。
- Compose 项目 ID 变化（例如自动发现的 `auto:<名称>` 项目被手动注册后）：旧策略显示「目标不存在」，需要重新设置后删除旧的。
- phyless 自身容器或项目更新后，不会清理旧镜像。
