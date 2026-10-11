# 拉取镜像、远程搜索与仓库账号

拉取对话框负责三件事：选择拉取方式、搜索远程镜像、选用仓库账号。三者共用同一条网络路径——**拉取走哪条路，搜索、查标签和账号验证就走哪条路**。

## 拉取方式与网络路径

| 拉取方式 | 拉取 | 搜索 / 查标签 / 读 manifest | 账号验证 |
|---|---|---|---|
| 不使用代理 | Docker daemon 直接拉取 | phyless 服务端直接访问 | 服务端登录 registry |
| 服务端代理 | phyless 经代理下载后导入 daemon | 服务端经同一代理访问 | 服务端经代理登录 |
| 浏览器代理导入 | 浏览器经 CF Worker 下载，流式导入 daemon | 浏览器经 Worker 访问 | 浏览器经 Worker 换取 registry 令牌 |

服务端一侧的只读查询都走 `POST /api/images/remote`，只接受这几类目标：

- Docker Hub API：`/v2/search/repositories/`、`/v2/namespaces/{ns}/repositories/{repo}/tags`（响应体原样转发）；
- 任意 registry 的 `/v2/<repo>/tags/list`（服务端自行跟随分页，最多 5000 个）；
- `/v2/<repo>/manifests/<tag|digest>` 与 `/v2/<repo>/blobs/sha256:…`（blob 限 1 MiB，只够读 config，镜像层会被拒绝）。

registry 返回的 401 会转成 403 再交给前端，避免被当成 phyless 会话过期而登出。

## 远程搜索

对话框默认是小窗；点「搜索远程镜像」切换到大窗。

- **关键词**：搜索 Docker Hub，显示官方标记、stars、下载量。
- **完整仓库名**（含 `/` 或 `:`，如 `ghcr.io/owner/app`）：直接列标签。
- **Docker Hub 标签**：来自 Hub API，按更新时间排序，带大小、架构，过滤在服务端进行。
- **其他 registry 标签**（GHCR、私有仓库）：`tags/list` 只有名字，按版本号倒序（`latest` 置顶）；当前显示的标签会逐个读取 manifest 和 config（并发 4），补全更新时间、大小、架构，并从镜像标签（`org.opencontainers.image.*`）显示仓库描述、源码链接、许可证。
- 单击标签回填镜像引用；双击或行尾「拉取」直接拉取；本地已有的标签会标出。

### 为什么经 Worker 容易 429

Docker Hub API（包括搜索、标签和 `/v2/auth/token` 登录）按**来源 IP** 限额，约 180 次/分钟。CF Worker 的出口 IP 是全球共享的，配额常被别人用完，登录了也没用。因此：

- 经 Worker 查 Hub 标签遇到 429 时，自动改走 registry 接口（`registry-1.docker.io/v2/…/tags/list`，按账号或拉取配额计数），只剩标签名，界面会提示；
- Hub 登录被 429 后，按 `Retry-After` 暂停重试；
- 账号验证不用 Hub 登录，而是走 registry 令牌服务（`auth.docker.io`）；
- 经常 429 时，改用「不使用代理 / 服务端代理」，用服务器自己的 IP。

**不读取 Docker Hub 的 manifest 来展示信息**：在 Docker Hub 上 GET manifest 会计入拉取次数。

## 平台

「平台」留空即 Docker daemon 所在平台，输入框里会显示，例如 `linux/arm/v7（当前 Docker daemon）`。

- daemon 上报的是 `uname -m`（`x86_64`、`aarch64`、`armv7l`、`armv6l`、`i686`），由 `docker.DaemonPlatform` 统一换算成 OCI 平台；服务端代理、检查更新和 `/api/system/platform` 共用这一份换算。
- 自动取 daemon 平台时，32 位 ARM 按 Docker 的顺序回退：v7 → v6 → v5；arm64 不会回退到 32 位。
- **手动指定平台时严格匹配**，两种代理都不回退。浏览器端识别 Docker 的平台别名（`x86_64`、`aarch64`、`arm` = `arm/v7` 等）。
- 浏览器路径拿不到 daemon 平台时直接报错，不会默认按 amd64 拉取。

## 仓库账号

两类账号，都在拉取对话框里按 registry 分组显示：每个 registry 一组单选，可以选「不使用账号（匿名）」或其中一个账号。同一 registry 可以有多个账号，由你选用哪一个。

| | 服务端仓库账号 | 浏览器账号 |
|---|---|---|
| 保存位置 | phyless 服务端，所有用户共享 | 当前浏览器（按前端代理地址分别保存；需勾选「记住凭据」） |
| 加密 | AES-256-GCM，密钥由 `<datadir>/jwt-secret` 经 HKDF 派生 | 明文存于 localStorage（XSS 可读取） |
| 何处管理 | 「不使用代理 / 服务端代理」下：添加、编辑（密码留空不改）、删除、验证 | 「浏览器代理导入」下：添加、编辑、删除、验证 |
| 服务端拉取 | ✓（请求带 `registry_ids`，按镜像所在 registry 取对应账号） | — |
| 前端代理拉取 | ✓（选用时经 `POST /api/registries/{id}/credentials` 临时取用，只存内存，记入审计） | ✓ |

注意：

- 删除或替换 `jwt-secret` 后，已保存的服务端密码无法解密，需要重新填写。
- `/credentials` 接口向能执行拉取的角色返回明文密码，这是前端代理路径的必要代价（浏览器要自己向 registry 认证）；每次调用都写审计日志，响应禁止缓存。
- 每个镜像只会用到其所在 registry 的账号，不会把一个 registry 的密码发给另一个。

## CF Worker

Worker 源码在 `cloudflare-worker/registry-proxy.js`，部署和白名单配置见 README。与本功能相关的约束：

- 只处理 `GET` / `HEAD` / `OPTIONS`，以及发往 `https://hub.docker.com/v2/auth/token` 的 `POST`（≤4 KiB，不跟随重定向）。
- 白名单需要显式包含 `hub.docker.com`：`*.docker.io` 并不匹配它。
- 前端代理地址默认预填 `https://registry-proxy.phyless.com`。
