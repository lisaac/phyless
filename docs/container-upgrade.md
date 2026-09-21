# 容器检查升级与升级

检查容器镜像是否有新版本；可单个或批量升级。升级时尽量还原容器原来的配置。

## 使用

- **容器列表**的批量栏（仅 operator 可见）：
  - `↻ 检查升级`：有选中容器就检查选中的，否则检查全部容器；
  - `↑ 升级选中`：批量升级选中的容器；
  - `可升级 N`：有可升级容器时出现，点击只显示这些容器，再点一次恢复。
- **容器行**：镜像名后显示状态标签，悬停可看本地和远端 digest、检查时间；可升级时 `↑` 按钮变为琥珀色。
- **容器详情**：标题旁显示同一个标签；镜像名旁有 `↻ 检查升级`；可升级时 `↑ 升级` 按钮高亮。
- **升级弹窗**：单个和批量共用。批量时列出每个容器的检查状态，已是最新的默认不勾选。
- **Compose 管理的容器**（带有 `com.docker.compose.project` 标签）：点升级后会先二次确认，提示所属项目和服务，以及之后执行 `compose up` 时可能被 compose 定义覆盖。点取消会回到升级弹窗，已选内容保留。

检查以任务形式出现在任务抽屉中，可以取消。结果保存在当前浏览器的 localStorage（`phyless_update_checks`）里，以容器 ID 和镜像 ID 作键：容器换了镜像（升级或重建）后，旧结果自动失效，保留 30 天。

## 检查状态

| 状态 | 标签 | 含义 |
|---|---|---|
| `update` | 可升级 | registry 上有新镜像 |
| `local-newer` | 待重建 | 本地 tag 已指向更新的镜像，但容器还没重建；升级时直接用本地镜像（`pull_policy: never`），不再拉取 |
| `latest` | （不显示） | 已是最新 |
| `unsupported` | `?` | 不是 registry tag 引用，例如按 digest 固定的镜像或直接用镜像 ID 创建的容器 |
| `error` | `?` | 检查失败，悬停查看原因 |

## 代理：检查和拉取走同一条网络

检查只读取 manifest，不下载层，也不重建容器。但它要能访问 registry，所以网络路径和拉取一致。检查弹窗复用拉取选项（`PullOptions`）：

| 模式 | 检查方式 |
|---|---|
| 不使用代理 | 通过 daemon 的 `DistributionInspect`，使用 daemon 自己的 mirror、代理和 insecure 配置。本地镜像没有 RepoDigests（经代理或浏览器导入的镜像）时，再由 phyless 直连 registry 获取 config digest；直连失败就用 daemon 返回的结果，无法比对的容器标为 `error`，不会误报可升级 |
| 服务端代理 | phyless 用 go-containerregistry 按请求里的代理解析 manifest，和代理拉取用同一套连接（`backend/internal/docker/image_check.go`） |
| 浏览器代理导入 | 浏览器经 CF worker 解析 manifest（`frontend/src/stores/updateCheck.ts`）。凭据只保存在浏览器，不发给 phyless |

私有仓库：`registry_ids` 可以多选，每个镜像按 host 选用对应账号，找不到就匿名请求。升级接口同样支持 `registry_ids`。

### 判断逻辑

本地镜像满足以下任一条件就算"已是最新"（`matchesRemote`）：

- 镜像 ID 等于 config digest：classic 镜像存储；
- 镜像 ID 等于 index 或平台 manifest 的 digest：containerd 镜像存储，包括浏览器导入的镜像；
- RepoDigests 中包含远端 digest：daemon 拉取的镜像。

前端的 `matchesRemote`（`frontend/src/api/registryPull.ts`）和后端的 `RemoteImage.Matches` 是同一套规则，代理拉取前的"本地已是最新"判断也用它。

同一 `ref|平台` 只请求一次，同一请求内镜像 inspect 结果复用，所有 registry 请求共用一个 transport（连接和 token 复用），最多 4 个并发，每个 20 秒超时。服务端模式取消检查任务会中断请求。registry 错误只返回 HTTP 状态码和错误码，不原样回显，避免泄露带凭据的代理地址。

## 接口

```
POST /api/containers/check-updates      （operator）
{ "ids": ["<容器ID>", …], "proxy_url": "…", "registry_ids": ["…"] }
→ [{ "id", "ref", "status", "local_id", "remote_id", "error" }]
```

`ids` 为空时检查全部容器。升级仍使用 `POST /api/containers/{id}/upgrade`：

- `pull_policy: "never"`：不拉取，直接用本地镜像；
- `env_from_image: ["KEY", …]`：这些变量改用新镜像的值（见下文"旧版升级残留的 ENV"）。

## 代理导入的 tar 格式

服务端代理（`backend/internal/docker/image_pull.go` 的 `writeImageTar`）和浏览器代理（`frontend/src/api/dockerTar.ts`）生成相同结构的 tar：OCI image layout（`oci-layout`、`index.json`，`index.json` 指向**原样保留的 registry manifest**），同时附带 docker-save 格式的 `manifest.json`。manifest 中重复列出的层只下载、写入一次。

- **classic 镜像存储**：读取 `manifest.json`，镜像 ID 等于 config digest；
- **containerd 镜像存储**：原样导入 OCI layout，镜像 ID 等于 registry 的平台 manifest digest。`index.json` 带 `io.containerd.image.name` 注解，镜像名是完整规范名（如 `docker.io/library/nginx:1.27`）。

如果只给 docker-save 格式，containerd 会自己合成一份 manifest，得到的 ID 与 registry 对不上：导入后的校验会失败，检查升级也会一直显示可升级。因此导入校验（`verifyLoaded`）和"本地已是最新"判断都同时接受 config digest 和 manifest digest。

## 升级时如何还原配置

实现在 `backend/internal/docker/container/upgrade.go`，参考 watchtower 的 `GetCreateConfig` 和 docker compose 的重建流程。

**流程**：拉取（按原镜像的平台）→ 校验镜像 ID 和平台 → 用临时名创建新容器 → 停止原容器 → 启动新容器 → 观察 5 秒 → 把原容器改为备份名、新容器改用原名 → 删除原容器。改名切换之前任何一步失败，都会删除新容器并恢复原容器，包括运行状态和 macvlan 地址。

**还原的配置**：

- **去掉旧镜像的默认值**：inspect 得到的 Config 里已经合并了旧镜像的 ENV、CMD/ENTRYPOINT、WorkingDir、User、StopSignal、Shell、OnBuild、Healthcheck、Labels、Volumes、ExposedPorts。和旧镜像相同的项会被去掉，由新镜像提供自己的默认值；用户显式设置的值保留。
  - 入口点是默认值、CMD 是自定义参数时，只保留 CMD。
  - 用 `--entrypoint` 显式指定、且同时丢弃了镜像 CMD 的，保留入口点，避免把 CMD 恢复回来。
  - 已发布的端口始终保持暴露。
- **`Config.Image`**：保持原写法（如 `nginx:latest`）。只有 tag 已不指向刚校验过的镜像时，才用镜像 ID 固定，并把原 tag 记在 label `io.phyless.upgrade-image-ref` 中，供下次升级使用。
- **旧版升级残留的 ENV**：旧版 phyless 升级时，会把前一个镜像的 ENV 原样复制进新容器，这些值和"你特意覆盖的值"在数据上无法区分。对带 `io.phyless.upgrade-image-ref` 标签的容器，升级弹窗会列出"当前镜像也定义了、但值不同"的变量，默认勾选"改用新镜像的值"；你特意设置的变量取消勾选即可保留。勾选的变量通过升级接口的 `env_from_image` 传给后端，升级时去掉容器里的值，由新镜像提供（新镜像不再定义则移除）。即使镜像已是最新，只要勾选的变量确实存在于容器中，也会按所选重建。通常只需确认一次：升级后这个标签会被移除，之后按新逻辑自动处理；如果当时 tag 已指向别的镜像、容器仍被固定，下次还会提示。
- **Hostname**：等于容器短 ID（Docker 默认值）时清空。旧版 phyless 升级过的容器（带上述 label）继承了前一个容器的短 ID，也会一并清掉。
- **网络**：
  - 保留所有网络、别名、静态 IP 和 IPAM 配置；
  - macvlan/ipvlan 保留动态分配到的 IP，macvlan 还保留 MAC，避免 DHCP 保留地址失效；
  - 去掉旧短 ID 形式的别名；
  - daemon API 低于 1.44（Docker 24 及更早）时，创建时只接入主网络，其余网络在启动前再接入。
- **卷和挂载**：bind mount 和具名卷原样保留，匿名卷按名称复用，数据不丢。
- **HostConfig**：端口、重启策略、资源限制、设备、capabilities 等原样复制。容器网络模式（`container:<x>`）下，会清掉和它冲突的选项（hostname、端口、DNS 等）。

**安全检查**：

- 拒绝：`--rm` 容器、暂停中/重启中/已死亡的容器、预定义网络上的静态地址；
- 新镜像的 ID 或平台和预期不符：不做任何改动；
- 同一容器的升级互斥。

**启动后观察**：原容器在运行时，新容器启动后观察 5 秒。如果异常退出、被 OOM 杀掉或进入重启循环，就回滚，并把最后 20 行日志输出到任务里。

**共享网络的依赖容器**（`network_mode: container:<本容器>`，例如 gluetun）：

- 升级前找出这些容器，并在整个升级期间持有它们的升级锁。任一依赖容器正在升级或处于无法重建的状态时，拒绝升级。
- 主容器切换成功后，依次重建依赖容器：按 ID 引用的改为指向新容器；主容器未运行时，依赖容器重建为停止状态。
- 主容器升级失败回滚时，会重启原本在运行的依赖容器，让它们重新接入网络。
- 单个依赖容器重建失败只输出警告，不回滚已经完成的主容器升级。

## 已知限制

- 在开启 containerd 镜像存储的 daemon 上，OCI 格式导入还需要实机验证，可运行 `PHYLESS_IMAGE_PULL_ACCEPTANCE=1 go test ./backend/internal/docker -run Acceptance`。本次修改前用服务端代理导入的镜像，ID 仍是合成 manifest 的 digest，需要重新拉取一次才能被正确识别。
- 升级后不会清理旧镜像。
- 用旧式 `--link` 链接到本容器的其他容器不会被处理。
- Compose 容器的 `com.docker.compose.image` 标签仍是旧值，之后执行 `compose up` 会重建该容器。
