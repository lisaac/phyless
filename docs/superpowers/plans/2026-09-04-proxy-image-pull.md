# Compose API 化与统一 ImagePull 代理执行计划

日期：2026-09-04
状态：待实施；本次只更新执行计划，未修改业务代码或依赖，未运行兼容性编译与真实 Docker 验收。

## 1. 最终方向与执行顺序

按用户最新要求，先把当前 Compose 命令行链路改为进程内 API，再接入 Docker ImagePull 薄封装：

    阶段 A：Compose API 化，去除 Docker/Compose 命令行子进程
        ↓ 验收现有功能与官方 Compose 行为
    阶段 B：统一 Docker APIClient，覆盖 ImagePull，接入代理流式导入
        ↓
    阶段 C：页面、创建、升级及 Compose 各入口传递本次代理配置
        ↓
    阶段 D：集成验收、上线与回退

本版完整替代此前“应用预拉取镜像，再执行 compose up --pull never --no-build”的候选方案。**不自行重写 Compose 的 pull_policy、依赖排序、profiles、重建和资源编排，也不再保留 CLI 回退。**

已确认的不落盘边界：phyless 下载端不保存镜像 tar、layer 或磁盘缓存，下载数据直接流入 Docker API；Docker 自身校验、导入、解包和最终存储的写盘行为不受此限制。不能把完整镜像或 layer 全量缓冲到内存。

## 2. 架构与已核实的注入点

### 2.1 三个包的职责

| 组件 | 用途 | 不负责什么 |
| --- | --- | --- |
| compose-spec/compose-go/v2 | 加载 Compose 文件、插值、合并、校验，生成 types.Project | 不负责启动 Docker 容器 |
| docker/compose/v2/pkg/api | 官方 Compose 接口和操作参数 | 仅导入接口不会得到编排实现 |
| docker/compose/v2/pkg/compose | NewComposeService 提供官方进程内实现 | 不需要通过 Cobra 执行命令行 |

目标调用链：

    phyless HTTP / WebSocket API
        ├─ 项目加载 → compose-go → types.Project
        └─ 官方 Compose service：Pull / Up / Stop / Down / Restart / Logs
                              ↓
                      注入的 Docker APIClient
                              ↓
                  ImagePull 薄封装（同一方法签名）
                      ├─ 未指定代理 → 原生 ImagePull
                      └─ 指定代理 → remote.Image → tarball.Write
                                                  → io.Pipe → 原生 ImageLoad

普通镜像页面、创建容器和升级容器也使用同一个包装后的 APIClient。Compose 只决定“是否拉取、拉什么”，薄封装只决定“怎么拉取”。

已核对的官方 v2.40.3 源码：

- NewComposeService 接收 command.Cli，并通过其 Client() 获取 client.APIClient。
- Compose 服务镜像拉取调用该 APIClient.ImagePull，并读取 Docker JSON 进度，再 inspect 本地镜像。
- docker/cli 的 command.WithAPIClient 可以注入包装后的 client。
- pkg/api 的正式服务接口是 api.Compose；配置展示使用 compose-go 序列化，不假设存在一个不存在的 Config 方法。

这意味着不需要 fork Compose，也不需要新增 Docker socket/HTTP 反向代理服务。[构造与注入](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/compose.go)、[拉取调用点](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/pull.go)、[WithAPIClient](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli_options.go)

### 2.2 “去掉 CLI”的准确含义

- 删除应用运行时对 docker、docker compose、docker-compose 可执行程序的调用。
- Compose config 与 logs 也必须迁移，不能只替换 up/pull。
- 不通过 exec、shell、Cobra Execute 或插件转发包装另一条命令行链路。
- 允许使用官方实现所需的 docker/cli/cli/command、streams、configfile 等 **Go 包**。包名含 cli 不等于启动命令行程序。
- 不重新实现整个 command.Cli 接口；优先用官方对象和 WithAPIClient。只有请求级凭据需要时，增加嵌入官方对象、仅覆盖 ConfigFile() 的小适配器。
- 去掉的是二进制依赖，不是声称 Compose 库的依赖树很小；官方实现会引入 BuildKit/buildx 等 Go 依赖，接受并审查其构建成本。

## 3. 当前代码与迁移映射

当前唯一 Docker 命令行调用集中在 internal/api/compose.go：生命周期 runner、config 和 WebSocket logs。镜像/容器 API 已直接使用 Docker SDK。Dockerfile 目前安装 docker-cli 和 docker-cli-compose。

| 当前入口 | 迁移后的实现 | 兼容要求 |
| --- | --- | --- |
| POST /api/compose/pull | service.Pull(ctx, project, api.PullOptions) | 只拉取，不创建/启动容器 |
| POST /api/compose/up | service.Up(ctx, project, api.UpOptions) | 保持原 up --detach 语义 |
| POST /api/compose/stop | service.Stop(ctx, name, api.StopOptions) | 不删除资源，不新增拉取 |
| POST /api/compose/down | service.Down(ctx, name, api.DownOptions) | 默认不删卷、不删镜像、不扩大 orphan 范围 |
| POST /api/compose/restart | service.Restart(ctx, name, api.RestartOptions) | 不是重新部署，不改成 down+up |
| GET /api/compose/config | 统一项目加载 + Compose 规范 YAML 序列化 | 返回有效配置，不联网锁定 digest |
| GET /api/compose/detail | 同一 loader 的项目信息视图 | 不再用跳过插值/校验的独立解析 |
| /ws/compose/logs | service.Logs + api.LogConsumer 适配 WebSocket | 保留 follow、时间戳、since/until、容器前缀 |
| 项目登记/删除登记、文件管理 | 保留现有 store 与文件 API | 登记不部署，删除登记不 down |
| 自动发现/列表 | 保留现有标签发现和登记项目合并 | 不顺便重写整个列表系统 |

HTTP 路由、项目 ID、NDJSON 进度卡片和 WebSocket 帧类型保持兼容。前置阶段 A 不要求用户填写代理，不改变现有页面操作入口。

建议实施代码边界：

- internal/docker/compose：project.go 负责加载，service.go 负责官方 service 初始化与选项映射，output.go 负责进度/日志适配。
- internal/docker/client.go 与紧邻的 image_pull.go：连接工厂及 ImagePull 薄封装。
- internal/api/compose.go 保留 HTTP/WS 入参、权限、审计，删除命令行 runner。
- 仅把需要注入 client 的参数改成官方 client.APIClient；不为此创建自有巨型 Docker 接口，不改无关业务模块。

## 4. 阶段 A：先完成 Compose API 化

### A0. 依赖与嵌入可行性门禁

实施时先做最小编译/初始化验证，确认下面这些组合，再迁移 handler：

| 依赖 | 计划基线 |
| --- | --- |
| docker/compose/v2 | v2.40.3，作为与现有 Docker 28 接近的兼容性验证基线，不宣称是最新版本 |
| docker/docker | 保留当前 v28.5.2+incompatible |
| docker/cli Go 包 | 先验证 v28.5.2+incompatible，与 Engine SDK 类型保持同一代 |
| compose-go/v2 | 优先保留当前 v2.13.0，验证是否与 Compose v2.40.3 所需接口兼容 |
| go-containerregistry | 阶段 A 不加入；阶段 B 单独做依赖兼容性门禁 |

Compose v2.40.3 原始依赖使用 compose-go v2.9.1、Docker/CLI v28.5.1；项目已有更新的 compose-go 和其他依赖。Go 的版本选择不保证这些组合源代码兼容，必须实测。[Compose go.mod](https://github.com/docker/compose/blob/v2.40.3/go.mod)

- [ ] 验证 compose-go loader、官方 NewComposeService、注入 APIClient 可在当前主模块编译。
- [ ] 使用假的 Docker HTTP endpoint 验证 service.Pull 的确经过注入 client，而非创建另一条默认 daemon 连接。
- [ ] 验证必要的 Up/Stop/Down/Restart/Logs 参数类型和服务初始化，不调用 Cobra 根命令。
- [ ] 记录依赖 diff、构建时间与运行二进制大小；不使用 @latest 或未经验证的 replace 掩盖冲突。
- [ ] 若 compose-go v2.13.0 与此 Compose 版本存在实际编译冲突，暂停接口迁移并列出冲突；只能在编译和回归通过后冻结版本组合，不能默默降级项目现有语义。

门禁产物：精确版本组合、最小可编译接线测试、已验证的 client 注入路径。本文尚未执行该门禁。

### A1. 统一项目加载

用现有 compose-go/cli.NewProjectOptions 与 LoadProject 封装一个加载入口。这里的 cli 包只是 Go 配置加载助手，不调用外部程序。

- [ ] 输入固定为工作目录、配置文件有序列表、环境文件有序列表、可选真实项目名和本次环境快照。
- [ ] 使用 WithWorkingDirectory、WithEnv、WithEnvFiles、WithDotEnv、WithDefaultProfiles 等官方选项完成插值、校验和 profile 解析；不逐请求 os.Chdir/os.Setenv。
- [ ] 显式传入进程环境快照并保持环境优先级；配置的 EnvFile、项目 .env、服务 env_file 的职责不能混淆。
- [ ] 自动发现项目保留 config_files 标签中的全部文件与顺序，以及 environment_file、working_dir、实际 project 标签；修复当前只取第一个配置文件的截断。
- [ ] 已登记项目继续保留现有 schema；运行时使用更完整的项目来源结构，不要求迁移 config.json。
- [ ] 人工登记的 Name 是显示名称，不能盲目作为 Compose project name。已运行项目优先沿用标签名；新项目按官方名称解析规则生成。
- [ ] Up/Pull 一次加载后使用同一个 types.Project，不再“CLI config 解析一次，CLI up 再解析一次”。不要全局缓存会被 Compose 修改的 Project 指针。
- [ ] Config/Detail 复用同一加载规则，展示需要时保留 disabled services；执行时让官方库按活动 profiles 选择服务，不能误启动 inactive services。
- [ ] 普通配置错误明确返回；Stop/Down/Restart/Logs 在已发现项目文件失效时，可使用可信标签 project name 走官方按名称操作路径，不因此创建一个同名新项目。
- [ ] 加载后的原始文件、环境值和 secret 不写审计或进度全文；仅 config API 按现有权限返回用户主动请求的配置内容。

直接嵌入官方 service 时，原命令层做过的准备不能漏掉：按固定版本源码给各服务补齐 ProjectLabel、ServiceLabel、VersionLabel、WorkingDirLabel、ConfigFilesLabel、OneoffLabel 和适用的 EnvironmentFileLabel；Compose 保留的内部标签不能由用户配置覆盖。容器号、配置 hash 等仍交给官方实现，不自行编造。[官方项目准备逻辑](https://github.com/docker/compose/blob/v2.40.3/cmd/compose/compose.go)

### A2. 官方 service 初始化和生命周期

- [ ] 使用 command.NewDockerCli、WithAPIClient、WithBaseContext、请求级输入/输出流构造非交互对象，然后调用 compose.NewComposeService。
- [ ] APIClient 指向与现有 Server 相同的 daemon，保留连接和 API 版本协商设置；禁止初始化期间因 Docker context 配置改连其他 daemon。
- [ ] 每次操作拥有独立 service/输出/内存凭据视图，不跨请求修改一个全局 DockerCli 的 ConfigFile 或输出流。
- [ ] 底层共享 Docker client 由 Server 拥有；请求结束不调用会关闭该 client 的 service.Close。请求只清理自身 writer/context；底层连接在服务关闭时统一释放。
- [ ] 输入使用非交互流，WithPrompt 回调对未授权的破坏性确认返回明确错误，不读取服务器 stdin，不自动接受。
- [ ] 不逐请求改 progress.Mode、全局 logger、api.Separator 或代理环境变量。涉及官方全局状态的固定配置仅在进程启动时确定。
- [ ] 注册表凭据按现有配置构造请求级内存 AuthConfigs。允许已有只读 Docker 认证配置时应显式配置并拷贝；默认不依赖宿主机 credential helper 可执行程序。

薄包装后的 APIClient 在阶段 A 可以只是透传；但这条接线必须提前完成，供阶段 B 覆盖 ImagePull 使用。

### A3. 生命周期 handler 迁移

- [ ] Pull 调用官方 service.Pull；不手动枚举服务并重写拉取策略。
- [ ] Up 调用官方 service.Up，Start.Attach=nil 对应后台启动；明确 RecreateDiverged、依赖服务及启动参数的默认值，不能认为所有零值都等价于旧命令。[Up 实现](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/up.go)
- [ ] Stop/Restart 传入原项目名和适用 Project，保持默认 timeout。
- [ ] Down 默认 Volumes=false、Images 为空、RemoveOrphans=false；对比旧命令行为，不扩大删除范围。
- [ ] 文件管理、项目登记、列表合并只做必要接线，不改无关业务。
- [ ] 所有 mutating 操作以返回 error 与 context 状态共同判定成功，并补齐 compose.pull/up/stop/down/restart 审计。
- [ ] 不因 API 化就强制所有 Up 禁止 build；普通本地构建是单独的兼容验收项，见 A5。
- [ ] 同项目的并发变更在请求入口拒绝第二个活跃操作（409），避免 Up/Down 互相覆盖；不同项目可并行，锁仅用于有实际冲突的编排动作，不构建通用任务队列。

### A4. 进度、配置输出与 WebSocket 日志

- [ ] Config 使用同一个 Project 的 Compose 序列化能力生成 YAML，不调用 docker compose config；保留 literal dollar、环境值和路径语义，不进行二次插值。
- [ ] 阶段 A 优先将官方非 TTY stdout/stderr 的逐行输出适配为现有 {stream} NDJSON，保留 {error} 终态；不把终端转义控制符直接发给 UI。
- [ ] 官方 v2.40.3 的 progress.Run 会构造自己的 writer；不能未经验证就假设仅 WithContextWriter 能拦截所有进度。选用稳定的非 TTY 输出路径，后续确有需要再做结构化事件适配。
- [ ] 请求级输出 writer 串行化，处理跨 Write 的半行、最后一行无换行、写入失败、flush 和取消，不无界累计整次操作日志。
- [ ] Logs 使用 api.LogConsumer.Log/Err/Status；设置 Follow=true、Timestamps=true，透传经校验的 Since/Until，保持现有容器名前缀和二进制 WebSocket 帧格式。
- [ ] 多容器日志回调可能并发，WebSocket 只能由单一受保护的写入路径发送；连接断开/写入失败要取消 Logs context，并关闭相关 reader。
- [ ] 不把 service.Up 的 attached 模式当作日志接口，避免 signal handler、终端菜单和请求关闭时停止整个项目的副作用。
- [ ] 前端继续使用原 PullStatusWidget；错误优先于 id/status 处理，HTTP 200 但流内报错不得触发成功 onDone，取消不能显示绿色成功。

[进度实现](https://github.com/docker/compose/blob/v2.40.3/pkg/progress/writer.go)、[日志接口](https://github.com/docker/compose/blob/v2.40.3/pkg/api/api.go)

### A5. 真正去除外部命令依赖

官方库的某些分支仍可能启动子进程；调用 API 不等于已经满足“无 CLI”。

- [ ] 移除生命周期 runner、Config 与 Logs 的所有 exec.CommandContext 调用，删除失效的 os/exec、bufio 等导入和相关旧注释。
- [ ] 官方 v2.40.3 默认可能走 Bake 并启动 buildx。运行配置显式固定 COMPOSE_BAKE=false，走该版本的进程内构建实现；该开关只在部署/启动时设置，不能逐请求切换。[Bake 子进程路径](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/build_bake.go)
- [ ] 默认验证 Docker daemon 内置 builder，不自动创建新的 docker-container builder 或下载 builder 镜像；其他 builder driver 不作为已验证能力。
- [ ] 审查凭据 helper、provider、远程 Git/OCI 配置加载器等外部程序路径。当前接口未承诺这些扩展：不自动启用，不支持时在执行前报出具体能力缺失，不回退 CLI。
- [ ] 本地 Dockerfile 构建、image+build 和 pull_policy=build 必须在无 docker/buildx/compose 二进制的环境中验收；若官方内置路径仍依赖外部程序，列为前置迁移阻塞，不假装“禁掉 build”就是无损迁移完成。
- [ ] 运行镜像删除 docker-cli、docker-cli-compose，不安装 buildx；保留应用、CA 证书、数据目录和 Docker socket。
- [ ] 真实验收记录宿主机进程 exec 跟踪或等效证据，不只依赖源码里搜不到 docker 字符串。

“无 CLI”针对应用的 Docker/Compose 编排路径，不禁止用户容器内本来就要运行的业务命令。阶段 A 不处理构建阶段的请求级 Registry 代理；该边界在阶段 B 单独明确。

### A6. 前置迁移验收门禁

进入代理实现之前，下列条件必须通过：

- [ ] 原有 Pull/Up/Stop/Down/Restart/Config/Logs 均走官方 API，无命令行回退。
- [ ] 多文件 override、.env/EnvFile/env_file、profiles、depends_on 健康依赖、project name 和 Docker 标签与基线一致。
- [ ] API 创建的项目可被现有列表发现；也能正确管理 CLI 以前创建的项目，不创建重复 stack。
- [ ] 普通本地 build 通过 A5 的无二进制验收；不可用的扩展与阻塞明确记录。
- [ ] Down 不删卷/镜像，Stop 不删除容器，Restart 不重新拉取或重建。
- [ ] 并发请求不串日志、凭据或项目，Logs 断连能退出，操作失败不误记成功。
- [ ] Dockerfile 不再安装 Docker/Compose CLI。测试中可保留独立 CLI 容器作为行为对照工具，但交付运行镜像不得依赖它。

## 5. 阶段 B：ImagePull 薄封装与代理导入

### B0. 后续依赖门禁

不要直接沿用旧计划固定的 go-containerregistry v0.22.0：它会要求 docker/cli v29.7.2，而前置迁移基线为 CLI/SDK 28，可能使 Compose v2 的接口类型不兼容。

- 优先验证仍使用 Docker/CLI 28 的 go-containerregistry v0.20.6 作为候选；它不是未经审计就可发布的最终版本。
- 该候选的 tarball writer 旧实现未在逐层写入处显式关闭 reader，必须验证成功、异常和取消时的资源释放。需要补偿时仅加局部 reader 生命周期适配并测试，不忽略问题，不复制整套库。
- 若候选不能通过资源、完整性或安全检查，停止该阶段并给出可兼容的新版本组合；不为了一个库默默升级整套 Compose/Docker SDK，也不 fork 整个 Compose。
- 最终交付必须固定通过编译、资源测试和漏洞检查的精确版本，提交 go.mod/go.sum；阶段 A 可独立先交付，不被代理库依赖拖住。

[新版本依赖](https://github.com/google/go-containerregistry/blob/v0.22.0/go.mod)、[兼容候选依赖](https://github.com/google/go-containerregistry/blob/v0.20.6/go.mod)、[候选 writer](https://github.com/google/go-containerregistry/blob/v0.20.6/pkg/v1/tarball/write.go)

### B1. 保持 SDK 方法签名，不新增业务下载接口

包装官方 client.APIClient，嵌入透传所有其他方法，只覆盖 ImagePull：

    type Client struct {
        client.APIClient
    }

    func (c *Client) ImagePull(
        ctx context.Context,
        ref string,
        options image.PullOptions,
    ) (io.ReadCloser, error)

- 使用官方接口做编译期断言，确保包装对象可直接被 Compose 接受。
- 本次代理策略通过私有 typed context key 传递，提供一个 WithPullProxy(ctx, ...) 帮助函数。这样保留 SDK 签名，不修改 Compose 上游代码；不能使用 string key 或全局可变代理。
- 无代理时原样调用底层 APIClient.ImagePull，保留 RegistryAuth、Platform、All、PrivilegeFunc 等现有参数行为。
- 有代理时由封装内部解析认证和平台、下载镜像、调用底层 APIClient.ImageLoad，返回 Docker 兼容 JSON 进度流；不能在内部递归调用自身 ImagePull。
- 方法返回 reader 不等于操作完成；所有调用者都必须消费完整流并处理错误。reader.Close 必须取消下载/导入和收尾，不只是丢弃输出。
- API handlers 不根据 proxy_url 分叉选择下载实现；Compose service 更不需要知道这个分支。
- 原 Server 字段和 Upgrade 等依赖具体 *client.Client 的必要接点改为 client.APIClient；无关 WS 功能不为此整体重构。

### B2. 代理和认证

- 请求级克隆 HTTP Transport，设置显式代理并通过 remote.WithTransport 使用；支持标准库能处理的 HTTP/HTTPS/SOCKS5 代理，不改 daemon 配置。
- Registry、token endpoint 和 blob/CDN 请求均走同一代理；不因进程 NO_PROXY 静默直连，失败也不自动直连回退。
- 解析/校验 proxy URL 的协议、host、端口与 userinfo；错误返回必须脱敏，不能泄漏代理密码、Registry token 或带凭据 URL。
- 保留 TLS 校验与连接超时，不对整个大镜像下载设置过短总超时；context 控制取消，结束时关闭本请求闲置连接。
- RegistryAuth 使用 Docker SDK 标准编码/解码；认证交给 remote/authn，不重写 Bearer token 协议。
- 直接镜像接口按 registry_id 从 store 查凭据；Compose 按 host 构造本次内存 AuthConfigs，再让官方实现生成 RegistryAuth。未知 ID、host 不匹配或多个账号无法唯一选择时明确报错。
- 不把代理注入用户容器 Env、Compose YAML、Run 文本、模板或浏览器持久化存储。
- 代理仅从 phyless 容器访问；宿主机代理需使用容器可达地址，容器内 127.0.0.1 不是宿主机。

### B3. 流式导入和错误契约

数据链路固定为 remote.Image → tarball.Write → io.Pipe → 底层 ImageLoad；不用磁盘 tar、缓存目录、完整 layer Buffer 或 ImageImport。

1. 校验引用/平台/认证，固定本次远端 manifest/config 对象；平台来自 options.Platform，缺失时使用目标 daemon，不用应用 runtime.GOARCH。
2. 下载生产端写入 tar pipe，消费端直接交给 ImageLoad；元数据可有限缓存，镜像数据不全量缓存。
3. 另一条返回给调用者的进度流采用 Docker JSONMessage 形状，按阶段输出，字节进度最多每 250ms 一次；不能把 tar 字节混入进度。
4. 消费 Docker load 响应，识别 error 和 errorDetail.message，校验 producer 结果以及最后 inspect 的预期 config ID/tag。
5. 完成全部校验才结束为正常 EOF；失败同时产生 Docker errorDetail 兼容信息和可被 decoder 捕获的读取错误，不只返回一个被 Compose 忽略的自定义字段。
6. 任一端失败/调用者关闭 reader：取消 context，先关闭相关 pipe/body 再等待 producer 退出；避免 writer 阻塞与循环等待。
7. 保留首次业务错误，清理产生的 canceled/closed pipe 不覆盖根因。context 已取消时即使上游返回 nil，handler 也不得记成功。
8. 失败不自动 prune、不删除旧镜像或其他请求的 tag。Docker 已接收的部分内容允许保留，不承诺事务回滚。

薄封装返回的是 Docker 进度协议而非直接绑定 HTTP ResponseWriter：Compose 可自行消费并转换为服务进度，普通接口也能沿用现有输出形状。

### B4. 兼容边界与所有拉取路径审计

- Compose 的显式 Pull、Up 内部 pullRequiredImages、依赖服务和支持的 image volume 拉取，使用官方库自己的逻辑，测试最终均到达包装 client。
- 对库中另建 client、DistributionInspect、远程配置解析、附属工件下载等网络路径逐项审计；未经过 ImagePull 的路径不能声称自动支持请求代理。
- 首版代理路径支持普通 Linux 单平台镜像；index 选择一个目标平台，不导入整份多平台索引及附属签名。
- tag/默认 latest 为首批支持对象；digest 引用的 RepoDigest/本地寻址语义须单独验证，未通过前代理路径明确拒绝，不能伪造 tag 或 RepoDigest。原生路径保持 Docker 原有能力。
- 本地完整 config ID 已存在时允许核验后补 tag，避免完整重传；不实现跨镜像的 layer 增量下载。
- 同一 tag 多平台导入及媒体类型兼容以真实 daemon 测试为准；不能让先后覆盖 tag 的结果伪装成多平台同时可用。
- Compose 官方策略和并发由库管理，应用不另写 daily/weekly/never/missing 判定器或去重调度器。
- BuildKit 的 FROM、外部 COPY --from、syntax frontend、cache 等并不保证经过 Docker ImagePull。**阶段 A 保留并验证无代理的本地构建；阶段 B 不宣称请求代理已覆盖构建。**
- 在 BuildKit 代理方案未确认前，有代理且活动服务配置了 build 时，先明确拒绝该操作以防失败后回退为直连构建；无代理的既有 build 不因此被禁用。这是保守、可见的首版边界，不是构建代理已完成。
- 若用户要求构建阶段也走请求代理，增加独立的 BuildKit resolver/认证/存储方案评审；不把“去 CLI”误当作已经解决这个问题。

## 6. 阶段 C：业务与页面接入

### C1. 对外接口

前置阶段 A 无 API 变更。代理阶段只给现有请求增加可选字段：

| 请求 | 字段 |
| --- | --- |
| POST /api/images/pull | 保留 image、registry_id，新增 proxy_url、platform |
| POST /api/containers | 新增 proxy_url、registry_id、platform |
| POST /api/containers/{id}/upgrade | 可选 body：proxy_url、registry_id；继续兼容空 body |
| POST /api/compose/pull、/up | 可选 body：proxy_url、registry_ids；继续兼容空 body |

Compose 平台来自各服务配置，profiles 来自项目加载，不新增项目级平台覆盖。Stop/Down/Restart 不增加无意义的代理表单。

### C2. 后端接线

- [ ] 在 handler 边界校验并把不可变代理策略放进 context；Compose 与普通 API 调用同一个包装 client。
- [ ] 直接拉取/创建/升级路径读取 Docker 流内错误，不再只 io.Copy 后记成功；统一一个小型流消费辅助函数。
- [ ] 创建的 always 必拉、missing 仅对明确 NotFound 拉取、never 不拉；保留当前空策略不主动拉的行为，非法策略报错。Compose 的默认策略仍由官方实现决定。
- [ ] 升级先成功拉取并 inspect，才比较 ID 并进入 Stop/Remove；拉取失败不动旧容器，Stop/Remove 返回错误时不继续创建。
- [ ] 不因薄封装顺便重构整个容器升级回滚；原有非事务重建风险另行记录。
- [ ] 原生 registryAuth 的手工 JSON 拼接改为标准结构化编码，覆盖密码中引号/反斜杠。
- [ ] 只记录实际成功；error/canceled 记录脱敏结果，不记录请求 body。

### C3. UI

- [ ] 镜像页面、新建容器、升级、Compose 列表/详情的 Pull/Up 提供“代理地址（仅本次）”与适用 Registry 选择。
- [ ] 复用同一个小型选项组件，不建全局代理管理页面；平台只在适用入口提供。
- [ ] 新建容器的代理选项独立于 Run/Compose 编辑模型，绝不进入容器环境变量或保存的模板。
- [ ] 输入只存在当前任务内存，结束/取消后释放；关闭填写弹窗不取消已启动的卡片，关闭进度卡片才 abort。
- [ ] 原 PullStatusWidget 继续消费 NDJSON；区分失败、取消、成功，HTTP 200 内的 errorDetail 也必须显示错误。
- [ ] Compose 使用官方 service 的服务名/镜像关联进度，避免来自多服务的事件互相覆盖。
- [ ] 说明代理范围及 BuildKit 边界，不把“应用请求级拉取代理”描述为 daemon 全局代理。

## 7. 自动化与真实环境验收

使用已有 Go testing、httptest、Vitest/Solid 测试库；不新增测试框架。新测试集中在真实分支与跨层接线，不给每个薄封装建庞大 fixture。

### 7.1 Compose API 化测试

| 场景 | 验收内容 |
| --- | --- |
| 方法映射 | 每个 HTTP/WS 入口调用预期官方 API，没有命令行回退 |
| detached Up | API 返回后容器继续运行，请求结束不会触发 attached shutdown |
| 资源行为 | Stop/Restart/Down 的容器、卷、镜像变化与旧语义一致 |
| 项目加载 | 多文件有序合并、插值、env_file、.env、profiles、extends、本地 include |
| 命名与发现 | 自定义 project name、人工显示名、旧 CLI 项目、完整标签均正确 |
| 依赖与重建 | healthcheck depends_on、配置变化、重复 Up 交给官方行为 |
| Config | literal dollar、路径、secret 和 disabled services 无错误二次处理 |
| 日志 | 多容器并发、since/until、时间戳、最后半行、WebSocket 断连 |
| 并发与资源 | 同项目冲突 409；不同项目输出/凭据隔离；共享 client 不被关闭 |
| 无二进制运行 | 运行环境没有 docker/docker-compose/buildx，常用编排和本地 build 仍可用 |
| 上游暗含 subprocess | Bake、credential helper/provider 等不会偷偷拉起外部命令 |

### 7.2 薄封装测试

| 场景 | 验收内容 |
| --- | --- |
| 原生路径 | 原始参数和行为透传，不访问应用代理 |
| 代理路径 | 调用底层 ImageLoad，不再调用原生远端 ImagePull |
| Compose 接线 | 官方 Pull/Up 内的拉取到达包装 client，handler 无镜像预拉取逻辑 |
| 认证 | 私有仓库、token endpoint、特殊字符密码、多 host 不串凭据 |
| 网络 | HTTP CONNECT、HTTPS/SOCKS5、CDN 重定向均使用本请求代理 |
| 平台 | amd64/arm64 index 选择目标 daemon/显式平台，不按应用架构选择 |
| 完整性 | 截断 layer、坏 digest、错误媒体类型、错误平台不能报成功 |
| 流式生命周期 | ImageLoad 提前拒绝、慢消费者、调用者 Close、context 取消全部退出 |
| 资源上限 | 镜像显著大于内存限额仍成功；reader/goroutine 不随重试累计泄漏 |
| 结果协议 | Docker errorDetail 被 Compose 消费；HTTP 200 失败不调用 onDone |
| 安全范围 | 有代理的 build 拒绝或进入另行验证的实现，不偷偷原生构建 |
| 创建/升级 | 拉取失败不创建/删除容器；无更新不重建；后续错误不假成功 |

### 7.3 必须执行的集成验收

1. 专用 daemon 上记录 Server 版本、平台、存储后端，不能拿 SDK 版本代替服务端版本。
2. 运行镜像不安装 docker/compose/buildx，以独立测试 CLI 容器作行为对照；用 API 完整操作一个含卷、网络、健康依赖和 profiles 的项目。
3. 验证普通本地 build 的无外部 Docker CLI 路径，跟踪 exec 调用，确认没有隐藏的 Bake 子进程。
4. 阻止 daemon 直接访问测试 Registry，只允许 phyless 经代理访问；分别从镜像页面和 Compose Pull/Up 拉取并运行，确认 dockerd 未重启。
5. phyless 采用只读根文件系统和不可写 /tmp，仅保留正常配置/审计所需 /data 与 socket；追踪 /data 写入，确认没有中间 tar/layer/cache。
6. 使用明显大于 phyless 内存限额的不可压缩镜像，例如传输体积超过 1 GiB、应用限额 256 MiB，记录 RSS，无 OOM/全量缓存；宿主机 daemon 不受此应用内存限额限制。
7. inspect 检查 ID/tag/platform/Entrypoint/Cmd/Env/Labels，使用禁止再次拉取的创建/运行方式确认镜像可用。
8. 取消、认证失败、第二个服务镜像失败、导入提前拒绝分别验证；不自动删除已有镜像、卷或旧容器。
9. 至少一套经典存储后端通过；交付环境若使用 containerd image store，增加该后端验收。
10. 记录未支持的引用、媒体类型、builder driver 与扩展功能，不把拒绝某功能写成该功能已完成。

实施阶段执行的检查命令（本文编写时未运行）：

    go test ./...
    go test -race ./internal/docker/... ./internal/api/...
    go vet ./...
    make test-web
    npm --prefix web run build
    go build ./cmd/server
    docker compose build phyless

最后一条仅用于外部构建/验证交付镜像，不是应用运行时依赖。依赖版本冻结后补充可达漏洞检查；不能只靠“能编译”判断旧版本可以交付。

## 8. 提交顺序、上线与完成条件

建议按以下独立变更交付，避免把所有问题混在一个大提交：

1. 依赖兼容性门禁、官方 service 构造和透传 APIClient 注入测试。
2. 统一项目加载、标签准备和生命周期 API 迁移。
3. Config/Logs/进度迁移、删除 CLI runner 与运行镜像的 CLI 包，完成阶段 A 验收。
4. ImagePull 薄封装、代理传输与生命周期测试。
5. 各业务/UI 请求级代理接线及 Compose 全路径代理验收。

上线只替换 phyless，不改 daemon 配置、不重启 dockerd。已有配置存储无强制迁移，已运行的 Compose 项目继续沿用名称和标签。回退部署旧 phyless；不删除新版本已创建的 Docker 资源作为回退步骤。

完成条件：

- [ ] Compose 前置迁移通过，当前所有 Compose 运行时路径不调用外部 Docker/Compose CLI。
- [ ] 官方 Compose 编排实现保留，应用没有复制一套 pull_policy/依赖/重建引擎。
- [ ] 普通业务和 Compose 使用同一个 ImagePull 薄封装，只有封装内部决定原生或代理路径。
- [ ] 下载端无中间镜像文件，内存有界，取消与错误处理通过。
- [ ] 原接口、日志、进度、资源保留行为通过回归，敏感信息不外泄。
- [ ] BuildKit 与非 ImagePull 下载边界明确记录；未经实现和验证的能力不宣称完成。
- [ ] 最终依赖组合、真实环境结果、已知限制和回退方式附在交付说明中。

## 9. 关键源码参考

- [Compose 接口定义](https://github.com/docker/compose/blob/v2.40.3/pkg/api/api.go)
- [Compose service 实现与 client 注入](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/compose.go)
- [显式及隐式拉取实现](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/pull.go)
- [DockerCli 的 APIClient 注入选项](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli_options.go)
- [compose-go 项目加载](https://github.com/compose-spec/compose-go/blob/v2.13.0/cli/options.go)
- [Compose 项目标签与加载准备](https://github.com/docker/compose/blob/v2.40.3/cmd/compose/compose.go)
- [官方构建与 Bake 分支](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/build_bake.go)
- [Docker daemon 代理配置](https://docs.docker.com/engine/daemon/proxy/)
