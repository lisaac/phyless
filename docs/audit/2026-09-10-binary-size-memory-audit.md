# 2026-09-10 二进制体积与内存审计

目标：未来可能跑在路由器上，在不降低功能的前提下压缩二进制、降低常驻内存。

## 现状测量（linux/amd64，`-s -w -trimpath` 已开）

| 构建 | 大小 |
|---|---|
| 不用 overlay | 72.7 MB |
| 去掉 k8s/remote 驱动（审计前的发布构建） | 37.4 MB |
| 去掉 Compose 内嵌的探针二进制（docker client + chi + jwt + gcr + 前端） | 7.5 MB |
| **本次之后** | **32.2 MB**（arm64 30.1 MB） |

体积分解（go-size-analyzer，审计前）：buildkit 3.4 MB、protobuf 2.0、otel 1.9、aws-sdk 1.6、grpc 1.5、compose 1.0、buildx 0.6、compose-go 0.57、go-cty 0.49、两份 yaml 0.62、std（runtime/crypto/net）5.9。

包初始化后 RSS（macOS 探针）：含 compose 24 MB，只含 docker client 9.4 MB；差额是 buildkit/proto/otel 的 init 注册表。运行期热点：`imagefs` 把整个镜像 tar 头索引进内存（约 150 到 200 B/条，10 万文件约 20 MB），空闲 10 分钟释放，无数量上限；镜像拉取走 `io.Pipe` 流式，WebSocket 每连接 36 KB 缓冲，均无问题。

## 已执行

| 项 | 改动 | 效果 |
|---|---|---|
| A2 / 路线 1 | `scripts/go-build.sh` overlay 存根：docker-container 驱动、buildx S3 凭证、buildflags cty、docker/cli telemetry、compose tracing | 37.4 → 33.3 MB |
| A4 | `web/scripts/gzip.mjs` 只嵌 `.gz`，`spaHandler` 直出或现场解压 | embed 1.6 → 0.59 MB，二进制 → 32.2 MB |
| C6 | `main.go` 默认 `SetMemoryLimit(128 MiB)` + `GOGC=50`，环境变量可覆盖 | 高峰堆不再按 GOGC=100 翻倍 |
| C7 | `imagefs` 空闲 3 分钟、LRU 上限 4 个索引 | 索引内存有界 |

## 评估后放弃

- **A1 合并两份 yaml**：Go 拒绝 `replace gopkg.in/yaml.v3 => go.yaml.in/yaml/v3`（used for two different module paths），只能等上游统一。
- **A3 `-gcflags=all=-l`**：−8%，CPU 慢 5 到 15%，路由器 CPU 弱，不值。
- **UPX**：启动时整包解压进匿名内存，不能按需换页，等于常驻多占约 30 MB；路由器应依赖 squashfs/xz 文件系统压缩（约 12 MB 落盘、零 RSS 代价）。
- **经典 builder（`DOCKER_BUILDKIT=0`）**：可再省约 9 MB，但丢 `secrets`、`RUN --mount`、heredoc，属功能降级。
- cobra / notary / prometheus 各 0.2 到 0.3 MB，被 compose 直接依赖，性价比低。

## 如果还要更小：路线 2

Compose 本体只有 3 到 4 MB，剩余大头是 `Build()` 走 buildx → buildkit client → gRPC 的客户端 solver 栈（约 7 MB）。按符号统计 buildkit `session/*` 仅 0.14 MB，solver/gateway/control/llb 占 1.36 MB。可改为 daemon 侧 BuildKit：调用 `ImageBuild(Version=BuilderBuildKit)`，客户端只起 session 提供 filesync / auth / secrets / ssh（moby v28.5 `builder-next` 仍支持 `client-session` 上下文）。保留 `RUN --mount`、secrets、ssh、cache_from、单 platform；丢多平台输出与 bake（本项目已在启动时禁用）。预计再 −6 到 −7 MB，约 300 到 400 行 Go，Docker CLI v27 的 `cli/command/image/build_buildkit.go` 可作参考。代价是 build 实现脱离 compose 官方路径，需自行维护。
