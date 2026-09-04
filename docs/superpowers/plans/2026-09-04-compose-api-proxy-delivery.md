# Compose API / ImagePull 代理改造交付记录

日期：2026-09-04。实现、主代理审核与隔离 Docker 验收记录；安全扫描仍有 7 项报告，适用性和限制见下文，不宣称零漏洞。

## 分支与执行方式

- 原执行计划已提交到 main：`3d35113`。
- 实施分支：`codex/compose-api-proxy-pull`。
- 分批提交：`15028a2` 前端请求选项/进度、`43d1dcd` 前端项目名与错误流修正、`2ef8481` Compose API / ImagePull 后端及自动化验收。
- Luna（max）子代理并行负责 Compose 后端、前端、代理核心；主代理负责普通 API 接线、集成、交叉审核与最终验证。
- 仅操作本地 Git；没有推送远程，也没有修改既有业务容器。

## 已确定的实现边界

- 使用 compose-go 加载项目，使用官方 `docker/compose/v2/pkg/compose` 实现编排；`pkg/api` 定义参数与接口。不复制 pull_policy、依赖排序或重建引擎。
- Docker `APIClient` 薄封装只覆盖 `ImagePull`。无请求代理时透传，有代理时下载数据流直接交给 Docker `ImageLoad`。
- “不落盘”指应用侧没有中间镜像 tar、layer 或磁盘缓存；Docker daemon 自身存储不在此限制内。
- 代理配置只在单次请求内生效，不写入 Compose 文件、容器环境或模板。
- 代理首版不支持 digest 引用、全标签拉取、非 Linux 镜像及构建阶段 Registry 代理；未实现的能力必须明确报错，不能静默直连。
- 普通无代理本地构建仍需保持；外部 builder/provider/credential helper 等路径不能借 API 化隐式执行 CLI。
- 页面沿用单进度卡片：旧卡片未关闭时拒绝发起同一卡片的第二个任务，避免混流或漏发；没有新增任务队列。

## 依赖门禁与版本调整

初始候选 Compose v2.40.3 与项目原 compose-go v2.13.0 有实际编译冲突：Compose 使用布尔类型 `CreateHostPath`，v2.13.0 已将其改为 `types.OptOut`。

实施分支采用官方匹配的 compose-go v2.9.1，Docker SDK/CLI Go 包保留 v28.5.2。该调整不是“无变化升级”；已覆盖项目加载、bind `create_host_path` 的省略/true/false、环境文件、profiles、include、多文件 override 与已有 stack 名称/标签测试。新的 Compose 规范功能不能未经验证宣称支持。

go-containerregistry 采用 v0.20.6，避免 v0.22.0 拉入 Docker CLI 29 的类型组合；其 tarball writer 的 layer reader 释放由局部适配与测试覆盖。版本以 go.mod / go.sum 为准，没有模块缓存补丁或 replace 分叉。

### 安全扫描（2026-09-04）

初次 `go run golang.org/x/vuln/cmd/govulncheck@v1.7.0 ./...` 非零退出，报告 29 项；不能表述为扫描通过。当前安全版本组合：Go 1.26.6、x/crypto 0.56.0、x/net 0.57.0、x/text 0.41.0、gRPC 1.82.1、containerd/v2 2.2.5、spdystream 0.5.1、in-toto 0.11.0。传递依赖由 Go MVS 一并调整，最终版本以 go.mod 为准。

尝试 go-archive 0.3.0 后，Docker CLI 28 的构建代码因 `archive.Gzip` 被删除而编译失败；没有修改模块缓存或私自 fork 上游。暂保留官方匹配的 0.1.0，以下提取路径适用性必须单独说明。

升级后仍报告 **7 项 / 4 个模块**，扫描非零退出。保留报告并按实际运行边界判断，没有压制扫描：

| 报告 | 上游描述与本项目适用性审核 |
| --- | --- |
| [GO-2026-4610](https://pkg.go.dev/vuln/GO-2026-4610) | Windows CLI 插件搜索路径；交付目标是 Linux 且不得调用外部插件，不据此声称 Windows 受支持 |
| [GO-2026-4887](https://pkg.go.dev/vuln/GO-2026-4887)、[GO-2026-4883](https://pkg.go.dev/vuln/GO-2026-4883) | Engine AuthZ / 插件权限校验；应用使用 SDK，不承载 daemon。升级应用不能修复远端 Engine，仍应单独维护 daemon 安全版本 |
| [GO-2026-6255](https://github.com/moby/buildkit/security/advisories/GHSA-7236-3392-c5c6)、[GO-2026-4858](https://pkg.go.dev/vuln/GO-2026-4858)、[GO-2026-4859](https://pkg.go.dev/vuln/GO-2026-4859) | BuildKit 服务端 frontend / 存储逃逸；`go list -deps ./cmd/server` 中是客户端、协议和类型依赖，不含执行这些功能的 solver/executor/git source 实现。应用不运行 buildkitd。远端 builder 的漏洞仍由运维处理，本地构建只应接受受信任的项目与 Dockerfile |
| [GO-2026-6253](https://pkg.go.dev/vuln/GO-2026-6253) | go-archive 提取路径逃逸；应用未调用 Compose Copy / Bridge 转换，也未调用 go-archive Untar / CopyTo；本地构建路径只打包上下文。以后开放这些功能必须重新处理此版本门禁 |

应用依赖中也不包含 Docker daemon 的 AuthZ/plugin 实现。上述为源码与依赖清单的适用性判断，不是上游漏洞已修复声明。若以后开放 Windows、Compose Copy/Watch/Bridge、外部插件或自管 buildkitd，必须重做版本门禁；远端 Docker Engine / BuildKit 安全维护独立于本次提交，不擅自升级用户的 daemon。

## 审核发现与修正记录

- Docker 的 HTTP 200 响应仍可包含 `error` / `errorDetail`，不能只复制流后记录成功。
- 升级容器必须在拉取并检查镜像成功后才能停止/删除旧容器；停止或删除失败不得继续创建。已经停止的容器返回 `NotModified`，按幂等成功处理。
- 下载与导入必须共用可取消的请求生命周期，不能只取消导入而遗留下载。
- 官方 Compose 可能逐层 `Unwrap` 错误；脱敏错误不能通过底层 cause 再泄漏凭据。
- Compose 内置 Buildx 路径需要正确初始化 context store、daemon endpoint 和 TLS，不能只验证 Pull 的注入。
- 部分 BuildKit 输出直接写进程 stdout，不能通过全局重定向混入其他请求。
- 进度组件必须区分失败/取消/成功；清除请求凭据不能重发 POST；无效 JSON 也不能显示成功。
- `errorDetail` 仅有 code、没有 message 时同样失败，不能误判成功。
- manifest、JSON 元数据及选中的 config blob 限制为 16 MiB；config 即使是 octet-stream 或重定向到对象存储也受限，layer 保持流式。重定向复用标准 HTTP client，不维护另一套 HTTP 跳转规则。
- 按真实 Compose label 名称加进程内项目锁；有歧义返回 409，查询 daemon 失败返回 503，不通过“查不到”推断允许新建。
- 升级前的网络、导入、平台或停止失败不会继续删旧容器。但保留既有升级方式：删除旧容器后若 Create/Start 失败，没有自动回滚；重要容器应先确认备份与可重建配置。

## 验证记录

默认测试不连接 Docker；真实环境用例通过显式环境变量开启。

| 检查 | 当前结果 |
| --- | --- |
| 前端测试 | `npm test -- --run`：14 个文件、41 项通过 |
| 前端构建 | 通过；保留原有大 chunk 警告 |
| 公共流消费、升级 | HTTP 200 内错误、取消、短写、超长/坏 JSON、升级前失败门禁与平台保留测试通过 |
| Compose 依赖接线 | 官方 service.Pull 命中注入的 APIClient，保留 context/platform/auth，错误流向上传播 |
| 全量 Go test / race / vet | `go test ./...`、`go test -race ./...`、`go vet ./...` 通过 |
| Linux 交付构建 | CGO=0，linux/amd64 与 linux/arm64 的 server 构建通过；arm64 未在真实 daemon 运行 |
| 依赖漏洞检查 | 由 29 项降至 7 项，非零退出；上文逐组说明实际路径，不按“全绿”处理 |
| 真实 daemon / 无 CLI 本地构建 | Docker 26.1.5 amd64，生命周期与本地 build 验收通过 |
| Compose 各拉取路径 | missing、always、显式 Pull 均通过实际代理/导入/Up；二次 Up 验证 missing 不重拉、always 重拉 |
| HTTP handler 兼容 | 显示名不同于真实名、文件移走后的 Stop/Restart/Down 与保留卷验收通过 |
| 代理端到端 / 内存上限 / 无中间文件 | 只读 scratch 容器、256 MiB 内存、大于 1 GiB 压缩层实际验收通过，见下文 |

前端已有 Sparkline 测试会输出 jsdom 未实现 canvas 的 stderr，但测试通过；此次不为消除既有警告新增 canvas 依赖。

使用 Go 1.26.6 构建的未裁剪 server 二进制：amd64 为 101,164,245 字节，arm64 为 95,362,516 字节（不含独立 web/dist）。嵌入官方 Compose/BuildKit 客户端确实增大依赖和二进制，没有把“去掉 CLI”解释成零依赖。

## 真实环境验收与回退

用户已授权使用 `docker.example.test`，独立 SSH 检查确认 Docker 26.1.5、Linux amd64、overlay2。已有 `protected-container` 和 `phyless-app` 是业务资源，不停止、删除或替换；不重启 daemon、不修改全局代理、防火墙或 daemon 配置。测试只使用唯一命名资源并精确清理。

按原执行计划第 7.3 节执行：无 Docker/Compose/buildx 二进制运行、Compose 生命周期/日志/本地构建、daemon 无法访问容器内 Registry 时经代理导入、只读根文件系统和临时目录、大于应用内存上限的镜像、取消/失败资源收敛与镜像属性检查。

### 已执行的代理验收

- 基于 `FROM scratch` 的静态测试容器；挂载 Docker socket，不包含 Docker/Compose/buildx 可执行文件。
- Registry 和 HTTP 代理均在测试容器内通过 `httptest` 启动。原生 daemon pull 无法访问该容器的 loopback Registry；同一引用经请求代理成功导入并检查 config ID / 标签 / 平台。
- 小层验收耗时约 0.19 秒；大层 payload 为 **1,073,741,825 字节**，使用生成式伪随机内容，gzip 后仍超过 1 GiB，不是以高度可压缩零数据代替大下载。
- 首轮大层验收耗时约 **66.63 秒**，容器 `Memory=268435456`、`MemorySwap=268435456`（256 MiB、无额外 swap）、`ReadonlyRootfs=true`，退出码 0、`OOMKilled=false`。一次 `docker stats` 采样显示约 4 MiB 容器内存使用量，不作为 RSS 或峰值声明。
- 最终提交 `2ef8481` 复测 **72.49 秒通过**：Registry 实际输出压缩层 **1,074,069,675 字节**，与生成压缩层长度一致；仍为只读根文件系统、256 MiB、无额外 swap、退出 0、未 OOM。最终一次采样 6.863 MiB，同样不视为峰值。导入 config ID 为 `sha256:c6b9433a7f7bdfe3978fe09bbe20db5afda287c69af217327c8c09788b689400`。
- 未挂载可写 `/tmp` 或镜像缓存目录。`docker diff` 仅显示 Docker 为 socket 挂载创建的 `/var/run/docker.sock` 及其父目录，没有镜像 tar/layer 中间文件。
- 上述测试只删除自己生成的唯一镜像标签；业务容器测试前已处于停止状态，未启动或改动。

### Compose 真实验收

- 首次使用外部 Docker Hub 的原生拉取在约 15 秒后超时，确认用户描述的 daemon 网络问题；没有修改 daemon。验收 fixture 改为缓存的固定 busybox digest 与进程内 Registry，生产逻辑没有为测试绕过拉取策略。
- `TestComposeAPIRealAcceptance`：三个服务，覆盖缓存镜像、本地 Dockerfile 构建、profile、健康依赖、命名卷、Config、Ps、Logs、Up/Stop/Restart/Down；约 47.37 秒通过。默认 Down 保留卷和构建镜像，测试独立清理自己创建的资源。
- `TestComposeAPIProxyPullAcceptance`：实际 SDK → ImagePull 薄封装 → HTTP 代理 → Registry → ImageLoad；三个场景约 38.86 秒通过。每个场景使用唯一 tag/project，`missing` 两次 Up 共拉 1 次，`always` 两次 Up 共拉 2 次，显式 Pull 后 Up 共拉 1 次。
- 最终提交 `2ef8481` 再次运行这三个代理场景，约 **38.97 秒通过**。
- `TestComposeAPIHandlerRealAcceptance`：从 HTTP handler 进入，已覆盖 YAML 真实项目名与登记显示名区分（无 COMPOSE_PROJECT_NAME 强制覆盖），以及配置文件丢失后的生命周期回退，最终约 22.76 秒通过。
- 上述 Compose 测试容器是只读 scratch，只有 `/tmp` tmpfs 用于 Compose 项目/构建元数据；没有 Docker、Compose 或 buildx 可执行文件。测试 harness 在宿主机使用 Docker CLI 创建测试容器，不属于应用运行链路。
- HTTP CONNECT 与 SOCKS5 有自动化网络测试；真实 daemon 验收使用 HTTP 代理。未连接公网私有 Registry 或实际 ARM daemon，不将模拟检查等同于这些环境的实测。

## 使用与兼容边界

1. 镜像拉取、创建容器与升级页面可填写本次代理，并显式选择 Registry 账号。Compose 的 Up/Pull 支持一次选择多个不同仓库账号；同一 host 的多个账号拒绝，Docker Hub 域名别名统一处理。未选择账号不读取宿主 credential helper。
2. 代理地址需从 **phyless 进程/容器** 可达：容器中的 `127.0.0.1` 指向该容器。支持 `http://`、`https://`、`socks5://`、`socks5h://`，用户名密码中的特殊字符需 URL 编码；不写到模板、Compose YAML 或全局设置。
3. 普通 pull JSON 采用 `proxy_url`、`registry_id`、`platform`；Compose Up/Pull 使用 `proxy_url`、`registry_ids`，平台来自每个 service 的 `platform`。未指定平台时代理 backend 根据 daemon 的 OS/arch 选择，不取 phyless 自身架构。
4. 有代理时只支持 Linux 单个平台的 tag 拉取；镜像 index 选取目标子镜像，tar load 不保存 index/RepoDigest 语义。digest 引用、all-tags、privilege retry、foreign/zstd 层等明确失败，不自动直连。不承诺流式 load 具有原生 pull 的所有层缓存/去重效率。
5. 有代理且活动服务带 `build` 的 Up/Pull 拒绝：Dockerfile FROM/BuildKit 访问不是 ImagePull API，不能假装覆盖。无代理本地构建保留。远程 Compose 来源、远程构建上下文和外部 provider 等能力不提供 CLI 回退。
6. Compose runtime 在进程启动时固定 `COMPOSE_BAKE=false`、`BUILDX_BUILDER=default`；显式冲突配置和 `DOCKER_AUTH_CONFIG` 报错。默认 builder 的配置目录须可写；只读部署可用小型 tmpfs，镜像代理流本身不需要该目录。
7. 同一真实 Compose 项目操作并发返回 409，不排队；多实例部署不提供跨进程锁。显式 Compose Pull 暂串行规避 v2.40.3 上游 build-fallback 共享切片竞态，Up 保留官方并发。未来升级上游后可恢复 Pull 并行。
8. 代理错误不会向页面/audit 暴露底层含 token/签名 URL 的 cause，因此详细网络错误被归为阶段错误。取消立即终止客户端管道，不承诺 Docker daemon 回滚已导入内容；没有自动删除镜像以避免误删共享数据。

## 重跑与交付

本地检查：

```sh
go test ./...
go test -race ./...
go vet ./...
go run golang.org/x/vuln/cmd/govulncheck@v1.7.0 ./...
# 在 web 目录
npm test -- --run
npm run build
```

真实用例是 opt-in，必须选择允许创建/删除测试资源的 daemon。`scripts/compose-proxy-acceptance.sh` 默认只读检查；`PHYLESS_ACCEPTANCE_RUN=1` 才创建测试容器，可通过 `PHYLESS_ACCEPTANCE_SSH_TARGET` / `PHYLESS_ACCEPTANCE_SSH_KEY` 覆盖本次环境。该脚本只跑两个 Compose 库验收，额外用例如下：

| 测试包 | 启用变量 | test.run |
| --- | --- | --- |
| `internal/docker/compose` | `PHYLESS_ACCEPTANCE=1` | `^TestComposeAPI(Real\|ProxyPull)Acceptance$` |
| `internal/api` | `PHYLESS_COMPOSE_API_ACCEPTANCE=1` | `^TestComposeAPIHandlerRealAcceptance$` |
| `internal/docker` | `PHYLESS_IMAGE_PULL_ACCEPTANCE=1` | `^TestImagePullProxyAcceptance$` |

先用 `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go test -c -o <binary> <package>` 构建；在无 CLI 的测试容器中只读挂载二进制和 Docker socket，传入上述变量。大层用例额外设置 `PHYLESS_PROXY_TEST_PAYLOAD_BYTES=1073741825`，容器采用 `--read-only --memory=256m --memory-swap=256m`，不要提供可写镜像缓存目录。Compose 用例须有缓存的固定 busybox digest（测试文件中列出）和可写的临时项目目录。

本次不部署/替换现有 phyless 服务、不推送远端。上线只替换 phyless，不改 daemon 配置、不重启 dockerd；回退也只替换 phyless，不删除卷、容器或镜像。原计划检查项保留历史状态，以此交付记录的实测结果和限制为准。

验收后已清理本次 8 个 runner 容器、2 个 runner 镜像及其无引用父镜像、唯一命名的测试项目资源和远端临时文件；本地临时二进制已移到废纸篓，可恢复或重新构建。没有全局 prune，daemon 可保留正常构建缓存。最终检查无本次测试容器/网络/卷/镜像标签残留，原有 10 个业务容器的 ID/状态未变，`phyless:latest` 仍为 `4cfdb8a61c7d`。
