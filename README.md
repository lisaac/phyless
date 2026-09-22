# phyless

轻量的自托管 Docker 管理面板：**一个二进制，无需任何依赖。**

整个程序就是一个约 31 MB 的静态可执行文件（压缩后约 12 MB），网页前端和 Compose 引擎都编译在里面。不需要数据库、运行时或额外的库，也不需要安装 docker CLI 或 docker compose。只要机器上有 Docker Engine，下载后直接运行即可。

[在线演示](https://lisaac.github.io/phyless/) · [Docker 镜像](https://github.com/lisaac/phyless/pkgs/container/phyless) · [下载二进制](https://github.com/lisaac/phyless/releases/latest)

> 在线演示只展示界面，数据是浏览器里的示例，不会连接真实 Docker。

- [快速开始](#快速开始)
- [为什么用 phyless](#为什么用-phyless)
- [功能一览](#功能一览)
- [部署](#部署)
- [使用代理拉取镜像](#使用代理拉取镜像)
- [本地开发](#本地开发)
- [安全须知](#安全须知)

## 快速开始

前提：服务器上已运行 Docker Engine，除此之外不需要任何东西。

**用容器运行：**

```bash
docker volume create phyless-data
```

```bash
docker run -d \
  --name phyless \
  --restart unless-stopped \
  -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v phyless-data:/data \
  ghcr.io/lisaac/phyless:latest
```

**或者直接运行二进制**（Linux amd64）：

```bash
curl -fsSL https://github.com/lisaac/phyless/releases/latest/download/phyless-linux-amd64.tar.gz | tar -xz
```

```bash
sudo ./phyless-linux-amd64 -C /var/lib/phyless
```

打开 `http://<服务器地址>:8080`，按提示为 `admin` 设置密码，完成。

接下来可以：

- 在「容器」页点 **创建**，粘贴一条 `docker run` 命令即可建容器；
- 在「Compose」页 **注册** 已有的 `compose.yaml` 项目（需要先挂载目录，见 [管理宿主机上的 Compose 项目](#管理宿主机上的-compose-项目)）；
- 服务器拉不动镜像时，在拉取对话框里选一个代理（见 [使用代理拉取镜像](#使用代理拉取镜像)）。

## 为什么用 phyless

### 轻量

- **单个二进制**：后端、网页和 Compose 引擎编译进同一个文件，Linux amd64 约 31 MB（压缩包约 12 MB）。容器镜像基于 Alpine，里面也只有这一个文件。
- **无需任何依赖**：静态编译，不依赖 glibc 或其他系统库；不需要数据库，账号和配置是数据目录里的普通文件；Compose 通过内嵌的 Go API 执行，宿主机无需安装 `docker` 或 `docker compose` 命令。
- **省内存**：默认把堆内存软上限设为 128 MB，路由器、NAS、小 VPS 也跑得动（可用 `GOMEMLIMIT`、`GOGC` 环境变量调整）。
- **部署简单**：一条 `docker run`，或者下载二进制直接运行。

### 网络受限也能拉镜像

- 每次拉取都可以临时指定代理，不用改 daemon 配置，也不用重启 Docker。
- 服务器完全连不上镜像仓库时，可以改由浏览器经 Cloudflare Worker 下载镜像，再流式导入服务器。

### 迁移和升级更省事

- `docker run` 命令和 `compose.yaml` 可以互相转换。
- 容器可以批量检查有没有新镜像；升级时沿用原配置，失败会自动回滚。Compose 项目一键拉取并更新。

## 功能一览

### 总览

Docker 主机与版本、操作系统和内核、总内存、存储驱动与可用空间，以及容器（运行中 / 总数）、镜像、网络、存储卷数量。

### 容器

- 列表：状态、端口、镜像、CPU/内存曲线；支持批量启动、停止、重启、删除。
- 生命周期：启动、停止、重启、暂停/恢复、强制结束、重命名、删除。
- 详情：配置（inspect）、实时日志、资源占用、进程列表（top）、网页终端（可在独立窗口打开）。
- 文件：浏览容器内文件，上传、下载、重命名，在容器之间复制文件。
- 创建：表单或直接粘贴 `docker run` 命令；可把常用命令保存为模板；随时查看任意容器对应的 `docker run` 命令或 `compose.yaml`。
- 复制、导出与导入容器。
- 检查升级 / 升级：单个或批量；显示本地与远端 digest；升级失败自动回滚。详见 [docs/container-upgrade.md](docs/container-upgrade.md)。

### Compose

- 注册宿主机上已有的项目；自动发现正在运行但未注册的项目。
- 查看项目下的服务与容器状态。
- 在线编辑 `compose.yaml` 及项目目录内的其他文件（上传、下载、重命名）。
- 操作：Up、Down、Stop、Restart、Pause、Pull、Build、Update（拉取并重建）；输出以流式日志显示在任务抽屉中。
- Build 仅对含 `build:` 的项目显示，浏览器代理模式下会先预拉 Dockerfile 的 `FROM` 镜像。详见 [docs/compose-build.md](docs/compose-build.md)。

### 镜像

- 拉取（可选代理）、上传 tar 导入、导出为 tar。
- 打标签 / 删除标签、删除镜像、清理悬空镜像。
- 查看详情、构建历史（history），浏览镜像内文件并下载。

### 网络与存储卷

- 网络：创建、删除、查看详情，把容器连入或断开网络。
- 存储卷：创建、删除（带确认）、查看详情，浏览卷内文件。

### 事件

实时查看 Docker 事件，默认显示最近 1 小时；可按时间范围、事件类型筛选，并按名称 / 动作 / 镜像搜索。

### 本机配置

浏览和编辑 phyless 所在环境的配置文件（如 `/etc`）。容器部署时看到的是容器内的文件系统，不是宿主机。

### 设置（仅管理员）

| 页面 | 作用 |
| --- | --- |
| Docker 连接 | 管理多个 Docker 主机：本机 socket 或 `tcp://host:2375`，可配置 TLS 证书（CA / Cert / Key），随时切换当前主机。 |
| 用户管理 | 创建账号并分配角色：**admin**（全部权限）、**operator**（可执行操作）、**viewer**（只读）。 |
| 镜像仓库 | 保存私有仓库凭据，拉取时自动使用；可测试连通性。 |
| 审计日志 | 记录谁在什么时间执行了什么操作。 |

### 其他

- 所有写操作进入全局任务队列，在右侧任务抽屉查看进度、日志或取消。
- 适配手机浏览器；支持日间 / 夜间主题。

## 部署

phyless 需要访问 Docker Socket，并把数据（账号、JWT 密钥、配置、审计日志）存放在一个目录里。下面三种方式任选其一。

### 方式一：Docker 容器（推荐）

见 [快速开始](#快速开始)。镜像基于 Alpine，里面只有 phyless 二进制和 CA 证书；数据保存在 `phyless-data` 卷的 `/data` 下。

升级 phyless：

```bash
docker pull ghcr.io/lisaac/phyless:latest
```

```bash
docker rm -f phyless
```

然后重新执行快速开始中的 `docker run` 命令。`phyless-data` 卷会保留，账号和配置不会丢失。

常用命令：

```bash
docker logs -f phyless       # 查看日志
docker restart phyless       # 重启，不影响数据
docker rm -f phyless         # 删除容器，phyless-data 卷仍保留
```

### 方式二：直接运行二进制

适合不想多跑一个容器的机器。[Releases](https://github.com/lisaac/phyless/releases/latest) 提供 Linux amd64 版本，其他平台请[自行构建](#本地开发)。

```bash
curl -fsSL https://github.com/lisaac/phyless/releases/latest/download/phyless-linux-amd64.tar.gz | tar -xz
```

```bash
sudo install phyless-linux-amd64 /usr/local/bin/phyless
```

```bash
sudo phyless -C /var/lib/phyless
```

`-C` 指定数据目录。运行用户需要能读写 `/var/run/docker.sock`，也就是 root 或 `docker` 组成员。直接运行时，phyless 能看到宿主机上的 Compose 目录和 `/etc`，不需要额外挂载。

作为 systemd 服务常驻：

```ini
# /etc/systemd/system/phyless.service
[Unit]
Description=phyless
After=docker.service
Requires=docker.service

[Service]
ExecStart=/usr/local/bin/phyless -C /var/lib/phyless
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now phyless
```

升级时替换 `/usr/local/bin/phyless`，然后执行 `sudo systemctl restart phyless`。

### 方式三：Docker Compose（从源码构建）

在仓库根目录执行：

```bash
docker compose up -d --build
```

[`compose.yaml`](compose.yaml) 用本地源码构建镜像，把 `./data` 挂载到 `/data`，并挂载 Docker Socket。更新代码后重新执行同一条命令即可。`data/` 已被 Git 和构建上下文忽略，不要提交。

### 管理宿主机上的 Compose 项目

直接运行二进制时不需要这一步。以容器方式运行时，Docker Socket 只提供 Docker API，不会把宿主机的 Compose 文件带进容器。需要把项目目录以**相同的绝对路径**挂载进 phyless：

```bash
docker run -d \
  --name phyless \
  --restart unless-stopped \
  -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v phyless-data:/data \
  -v /srv/compose:/srv/compose \
  ghcr.io/lisaac/phyless:latest
```

Compose 部署时在 `compose.yaml` 中加同样的挂载：

```yaml
services:
  phyless:
    volumes:
      - /srv/compose:/srv/compose
```

然后在「Compose」页用 `/srv/compose/<项目>` 注册项目。路径必须一致，否则相对路径的 `build:`、`volumes:`、`env_file` 会解析到错误位置。

### 管理远程 Docker 主机

在「设置 → Docker 连接」添加 `tcp://<主机>:2375`（或启用 TLS 并填写证书），保存后切换即可。远程主机需要自行开放 Docker API，务必配 TLS 或限定内网访问。

### 部署参数

| 项目 | 默认值 | 说明 |
| --- | --- | --- |
| 端口 | `8080` | 用 `-p <宿主端口>:8080` 修改对外端口。 |
| 数据目录 | `/data` | 启动参数 `-C <目录>` 可修改。 |
| 内存上限 | 128 MB（软上限） | 环境变量 `GOMEMLIMIT`（如 `256MiB`）、`GOGC` 可覆盖。 |
| Docker Socket | `/var/run/docker.sock` | 管理本机 Docker 必需。 |

公网访问请放在 HTTPS 反向代理之后（见 [安全须知](#安全须知)）。

## 使用代理拉取镜像

代理只对当前这次操作生效。镜像拉取、Compose 的 Pull / Up / Build / Update、容器升级与检查升级的对话框里都能选择：

| 方式 | 适用场景 | 要求 |
| --- | --- | --- |
| **服务端代理** | 服务器能访问某个代理 | HTTP / HTTPS / SOCKS5 地址，需能从 phyless 容器内访问 |
| **浏览器代理导入** | 服务器完全连不上镜像仓库 | 部署一个 Cloudflare Worker |

### 浏览器代理：三步配置

**1. 部署 Worker**

Worker 源码是 [`cloudflare-worker/registry-proxy.js`](cloudflare-worker/registry-proxy.js)，二选一：

- **控制台**：[打开 Cloudflare 创建 Worker](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)，选择 **Create Worker → Deploy**，把脚本完整粘贴进编辑器后再次部署。参考 [Dashboard 部署文档](https://developers.cloudflare.com/workers/get-started/dashboard/)。
- **命令行**（需要 Node.js）：在仓库根目录执行

  ```bash
  npx wrangler login
  ```

  ```bash
  npx wrangler deploy cloudflare-worker/registry-proxy.js --name phyless-registry-proxy --compatibility-date 2024-11-01
  ```

部署后在 Worker 概览页复制地址 `https://<name>.<subdomain>.workers.dev`。

**2. 配置白名单**

在 Worker 的 **Settings → Variables and Secrets** 添加变量并重新部署：

| 变量 | 示例 | 作用 |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | `https://phyless.example.com` | 允许调用 Worker 的 phyless 网址，多个用逗号分隔；不带路径和结尾 `/`。 |
| `UPSTREAM_ALLOWLIST` | 见下 | 允许访问的镜像仓库域名，按实际使用收紧。 |
| `ALLOW_ANY_UPSTREAMS` | `false` | 是否允许任意上游，生产环境保持 `false`。 |
| `ALLOW_MISSING_ORIGIN` | `false` | 是否接受无 Origin 的请求，保持 `false`。 |

`UPSTREAM_ALLOWLIST` 常用取值：

```text
# Docker Hub + GHCR
registry-1.docker.io,auth.docker.io,production.cloudflare.docker.com,*.docker.io,ghcr.io,*.githubusercontent.com,pkg-containers.githubusercontent.com

# 仅 Docker Hub
registry-1.docker.io,auth.docker.io,production.cloudflare.docker.com,*.docker.io

# 仅 GHCR
ghcr.io,*.githubusercontent.com,pkg-containers.githubusercontent.com
```

完整变量说明见 [cloudflare-worker/README.md](cloudflare-worker/README.md)。

**3. 在 phyless 中使用**

1. 打开任一拉取 / 升级对话框，选择 **浏览器代理导入**；
2. 填入 Worker 地址，如 `https://phyless-registry-proxy.example.workers.dev`（无需手动拼 `?url=`）；
3. 私有镜像可填写用户名和密码/Token。凭据不会发给 phyless 服务端，“记住凭据”只存在当前浏览器的 localStorage。

限制：只支持 Linux 平台的 tag 镜像，不支持 digest 引用和 foreign layer；Compose Build 只预拉 Dockerfile 中能静态解析的 `FROM` 镜像。Worker 只处理 `GET` / `HEAD` / `OPTIONS`，不保存镜像内容。

## 本地开发

需要 Go（版本见 [go.mod](go.mod)）和 Node.js。

```bash
./build.sh                          # 构建前端并嵌入，产出 ./phyless
```

```bash
./phyless -C ./data                 # 启动后端，监听 :8080
```

```bash
cd frontend && npm install && npm run dev   # 前端热更新，/api 代理到 localhost:8080
```

测试：`go test ./...`、`cd frontend && npm test`。

## 安全须知

- 挂载 Docker Socket 等同于授予宿主机 root 级权限，只向可信用户开放。
- 公网访问务必放在 HTTPS 反向代理之后。
- `/data`（`phyless-data` 卷或 `./data`）保存 JWT 密钥、账号和审计日志：定期备份，不要公开或提交到 Git。
- 给日常使用者分配 operator 或 viewer 角色，admin 只留给管理者。
