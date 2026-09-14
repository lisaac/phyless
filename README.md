# phyless

自托管的 Docker Web 控制台。一个二进制文件内置 Go API 与 Solid 前端，通过 Docker API 管理本机或远程 Docker 主机。

## 功能

- 容器：查看状态、日志、事件、实时资源使用情况和终端；创建、启动、停止、重启、删除、导入/导出及升级容器。
- 镜像：拉取、导入、导出、检查镜像层与文件，并可选择服务端代理或浏览器代理导入。
- Compose：自动发现或手动注册项目，执行 Up、Stop、Restart、Down、Pull/Build、Update，并编辑项目文件。
- Docker 资源：管理网络、存储卷、镜像仓库和多个本机/远程 Docker API（支持 TLS）。
- 运维能力：用户角色（viewer / operator / admin）、审计日志，以及 `/etc` 配置文件浏览与编辑。
- Cloudflare Worker：为浏览器侧镜像下载提供受白名单保护的 OCI Registry CORS 代理。

```
普通管理：浏览器 ──> phyless（Web UI + Go API）──> Docker API

浏览器代理导入：浏览器 ──> Cloudflare Worker ──> 镜像仓库
                    │
                    └──> phyless ──> Docker API
```

## 快速开始

只需 Docker Engine，且宿主机的 `8080` 端口可用。在仓库根目录复制执行以下命令，并替换管理员密码：

```bash
docker build -t phyless:latest . && \
docker volume create phyless-data && \
docker run -d --name phyless --restart unless-stopped -p 8080:8080 \
  -e ADMIN_PASSWORD='请替换为强密码' \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v phyless-data:/data \
  phyless:latest
```

打开 `http://<服务器地址>:8080`，使用用户名 `admin` 和 `ADMIN_PASSWORD` 登录。

未设置 `JWT_SECRET` 时，phyless 会在首次启动时生成随机密钥并保存到 `phyless-data` 卷。`ADMIN_PASSWORD` 只会在没有任何用户的首次启动时用于创建管理员；之后请在「设置 → 用户管理」中修改用户。

常用运维命令：

```bash
docker logs -f phyless
docker restart phyless
docker rm -f phyless # 删除容器不会删除 phyless-data 卷
```

运行数据保存在 `phyless-data` 卷，其中包含用户配置、JWT 密钥和审计记录。请备份该卷，且不要公开其中内容。

## 容器化部署

上面的 `docker run` 是默认部署方式：依赖少、命令短，也不需要安装 Compose。Docker Socket 会让 phyless 管理宿主机 Docker，命名卷会保留服务状态。

### Compose（可选）

仓库也提供 [compose.yaml](./compose.yaml)，适合已经用 Compose 管理服务、希望将运行参数保存在仓库中的场景；它不是必需或默认方案：

- 构建包含前端和后端的 `phyless:latest` 镜像；
- 将 `./data` 挂载到容器的 `/data` 以保存状态；
- 挂载 `/var/run/docker.sock`，使 phyless 能管理宿主机 Docker；
- 将服务发布到 `8080` 并设置 `unless-stopped` 重启策略。

```bash
export JWT_SECRET="$(openssl rand -hex 32)"
export ADMIN_PASSWORD='请替换为强密码'
docker compose up -d --build
```

### 宿主机文件与 Compose 项目

Docker Socket 只能提供 Docker API 访问；它不会让容器自动看见宿主机的 Compose 文件。若要在容器化部署中编辑或操作宿主机某个 Compose 项目，请额外挂载项目目录，并保持容器内外绝对路径一致，例如：

```yaml
services:
  phyless:
    volumes:
      - /srv/compose:/srv/compose
```

然后在 phyless 中使用 `/srv/compose/...` 注册项目。类似地，「本机配置」页面在容器部署时访问的是**容器内**的 `/etc`，不是宿主机的 `/etc`。

### 安全边界

挂载 Docker Socket 相当于授予该服务对宿主机 Docker 的高权限控制。仅向可信管理员开放 phyless；生产环境请放在 HTTPS 反向代理之后，不要把未加保护的 `8080` 端口直接暴露到互联网。

## Cloudflare Worker：浏览器代理导入

当 phyless 服务端或 Docker daemon 无法直连镜像仓库时，可以让浏览器经 Cloudflare Worker 下载镜像，再流式导入 Docker。Worker 源码位于 [cloudflare-worker/registry-proxy.js](./cloudflare-worker/registry-proxy.js)。

### 部署

1. 登录 Cloudflare。使用控制台创建一个 Worker，或在本机执行：

   ```bash
   npx wrangler deploy cloudflare-worker/registry-proxy.js \
     --name phyless-registry-proxy \
     --compatibility-date 2024-11-01
   ```

2. 在 Worker 的 **Settings → Variables and Secrets** 中添加以下普通环境变量：

   | 变量 | 推荐值 | 作用 |
   | --- | --- | --- |
   | `ALLOWED_ORIGINS` | `https://phyless.example.com` | 仅允许该 phyless 站点发起请求；多个 Origin 用逗号分隔。 |
   | `UPSTREAM_ALLOWLIST` | `registry-1.docker.io,auth.docker.io,production.cloudflare.docker.com,*.docker.io` | 允许访问的 Registry 域名。Docker Hub 示例；请按实际仓库收紧。 |
   | `ALLOW_ANY_UPSTREAMS` | 留空或 `false` | 不要在生产环境启用。 |
   | `ALLOW_MISSING_ORIGIN` | 留空或 `false` | 浏览器使用场景无需启用。 |

   GHCR 可使用：`ghcr.io,*.githubusercontent.com,pkg-containers.githubusercontent.com`。

3. 回到 phyless 的镜像或 Compose 拉取对话框，选择「浏览器代理导入」，填入部署得到的 HTTPS Worker 地址。

Worker 只处理 `GET`、`HEAD` 和 `OPTIONS`，会转发 Registry 拉取所需的授权头但不会持久化内容。务必设置精确的 `ALLOWED_ORIGINS` 与 `UPSTREAM_ALLOWLIST`：开放上游白名单会使它成为可转发凭据的开放代理。浏览器代理导入目前适用于 Linux 的 tag 镜像和可静态解析的构建基础镜像；digest、动态 `FROM` 等场景请使用服务端拉取方式。

详细变量说明见 [Worker README](./cloudflare-worker/README.md)。Wrangler 命令与变量配置可参考 [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy) 和 [环境变量文档](https://developers.cloudflare.com/workers/configuration/environment-variables/)。

## 从源码运行与开发

本地构建需要 Node.js 20 与 Go 1.26.6（与 [Dockerfile](./Dockerfile) 一致）：

```bash
(cd frontend && npm ci)
./build.sh
ADMIN_PASSWORD='请替换为强密码' ./phyless -C ./data
```

未设置 `JWT_SECRET` 时，首次启动会在数据目录生成并以受限权限保存随机密钥；生产部署仍建议显式设置该变量。默认连接本机 Docker Socket，Web UI 地址为 `http://localhost:8080`。

运行本地检查：

```bash
./scripts/check.sh
node --test cloudflare-worker/registry-proxy.test.mjs
```

## 项目结构

| 路径 | 内容 |
| --- | --- |
| [backend/](./backend) | Go HTTP API、鉴权、Docker 与 Compose 集成。 |
| [frontend/](./frontend) | Solid + Vite Web UI。 |
| [cloudflare-worker/](./cloudflare-worker) | 浏览器镜像拉取使用的 CORS Registry 代理。 |
| [Dockerfile](./Dockerfile) | 多阶段构建镜像。 |
| [compose.yaml](./compose.yaml) | 可选的单服务 Compose 部署配置。 |
