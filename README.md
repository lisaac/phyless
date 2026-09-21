# phyless

一个自托管的 Docker 管理面板。打开网页，就能管理服务器上的容器、镜像和 Compose 项目。

[在线演示](https://lisaac.github.io/phyless/) · [Docker 镜像](https://github.com/lisaac/phyless/pkgs/container/phyless)

> 在线演示只展示界面，操作的是浏览器中的示例数据，不会连接真实 Docker。

## 亮点

- 拉取镜像时可以随时切换代理，不需要重启 Docker daemon。
- Docker daemon 无法直连镜像仓库时，可以使用浏览器代理拉取镜像（需要 Cloudflare Worker）。
- `docker run` 命令和 `compose.yaml` 可以互相转换，迁移服务更方便。
- 容器和 Compose 项目都支持一键升级；容器可批量检查是否有新镜像，升级时保留原配置并在失败时自动回滚（见 [docs/container-upgrade.md](docs/container-upgrade.md)）。
- Compose 项目可视化管理：查看状态、编辑配置，并执行启动、停止、重启、构建、拉取和更新。

## 能做什么

- 管理容器：查看状态、日志、终端和资源占用；启动、停止、重启、删除、复制或升级容器。
- 管理镜像：拉取、导入、导出、打标签和清理镜像。
- 管理 Compose：添加项目、编辑配置、启动、停止、构建、拉取和更新服务。
- 管理 Docker 资源：网络、数据卷、镜像仓库，以及本机或远程 Docker 主机。
- 管理权限：创建管理员、操作员和只读账号，并查看操作记录。

## 安装

需要已经运行 Docker Engine。执行：

```bash
docker volume create phyless-data

docker run -d \
  --name phyless \
  --restart unless-stopped \
  -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v phyless-data:/data \
  ghcr.io/lisaac/phyless:latest
```

打开 `http://<服务器地址>:8080`。首次使用时，按页面提示为 `admin` 设置密码。

## Compose 部署

如果习惯使用 Docker Compose，可以在仓库根目录执行：

```bash
docker compose up -d --build
```

这个 `compose.yaml` 用本地源码构建 phyless，把 `./data` 挂载到 `/data` 保存账号和配置，并挂载 Docker Socket 管理宿主机 Docker。

### 让 phyless 管理宿主机上的 Compose 项目

Docker Socket 只提供 Docker API，不会自动把宿主机的 Compose 文件放进 phyless 容器。需要把项目目录以**相同的绝对路径**挂载进去：

```yaml
services:
  phyless:
    volumes:
      - /srv/compose:/srv/compose
```

然后在 phyless 中使用 `/srv/compose/...` 注册项目。容器部署时，「本机配置」页面看到的是容器内的 `/etc`，不是宿主机的 `/etc`。

## 使用代理拉取镜像

代理只对当前操作生效，不需要重启 Docker daemon：

- **服务端代理**：phyless 通过 HTTP、HTTPS 或 SOCKS5 代理拉取；代理地址必须能从 phyless 容器内访问。
- **浏览器代理导入**：浏览器通过 Cloudflare Worker 下载镜像，再流式导入 Docker。适合 phyless 服务端或 Docker daemon 无法访问镜像仓库的情况。

### 一键部署 Cloudflare Worker

浏览器代理需要先部署 Worker。Worker 源码是 [`cloudflare-worker/registry-proxy.js`](./cloudflare-worker/registry-proxy.js)。

**Cloudflare 控制台：** [一键创建 Worker](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)，登录后选择 **Create Worker → Deploy**，把上述脚本完整粘贴到编辑器并再次部署。完整流程见 [Cloudflare Dashboard 部署文档](https://developers.cloudflare.com/workers/get-started/dashboard/)。

**Wrangler 命令行：** 在仓库根目录执行，首次使用会打开 Cloudflare 登录流程：

```bash
npx wrangler login
npx wrangler deploy cloudflare-worker/registry-proxy.js \
  --name phyless-registry-proxy \
  --compatibility-date 2024-11-01
```

Wrangler 需要 Node.js；不想在本机安装 Node.js 时，使用上面的 Cloudflare 控制台方式即可。命令格式见 [Wrangler deploy 文档](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)。

部署完成后，在 Worker 概览页复制得到的 `https://<name>.<subdomain>.workers.dev` 地址。

### 配置 Worker 白名单

在 Cloudflare Worker 的 **Settings → Variables and Secrets** 中添加变量，然后重新部署：

| 变量 | 示例 | 作用 |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | `https://phyless.example.com` | 允许使用 Worker 的 phyless 网页来源。多个来源用逗号分隔；不要填写路径或结尾 `/`。 |
| `UPSTREAM_ALLOWLIST` | `registry-1.docker.io,auth.docker.io,production.cloudflare.docker.com,*.docker.io,ghcr.io,*.githubusercontent.com,pkg-containers.githubusercontent.com` | 允许访问的镜像仓库域名；按实际使用的仓库收紧。 |
| `ALLOW_ANY_UPSTREAMS` | `false` | 是否允许任意上游，生产环境保持 `false`。 |
| `ALLOW_MISSING_ORIGIN` | `false` | 是否接受没有 Origin 的请求，浏览器场景保持 `false`。 |

只使用 Docker Hub 时，可将 `UPSTREAM_ALLOWLIST` 缩短为：

```text
registry-1.docker.io,auth.docker.io,production.cloudflare.docker.com,*.docker.io
```

只使用 GHCR 时，可使用：

```text
ghcr.io,*.githubusercontent.com,pkg-containers.githubusercontent.com
```

### 在 phyless 中使用浏览器代理

1. 打开镜像页面的拉取对话框，或打开 Compose 的 **Pull / Up / Build / Update**、容器的升级对话框。
2. 选择 **浏览器代理导入**。
3. 填入 Worker 的 HTTPS 地址，例如 `https://phyless-registry-proxy.example.workers.dev`。
4. 公共镜像直接执行；私有镜像可填写用户名和密码/Token。凭据不会发送给 phyless 服务端；“记住凭据”只保存在当前浏览器的 localStorage。

不用手动拼接 Worker 的 `?url=` 参数，phyless 会自动把镜像仓库请求交给 Worker。

浏览器代理目前只支持 Linux 的 tag 镜像，不支持 digest、foreign layer；Compose Build 只会预拉 Dockerfile 中能静态解析的 `FROM` 镜像。Worker 只处理 `GET`、`HEAD` 和 `OPTIONS`，不会保存镜像内容。

完整的 Worker 变量说明见 [Cloudflare Worker README](./cloudflare-worker/README.md)。

## 常用命令

```bash
docker logs -f phyless       # 查看日志
docker restart phyless       # 重启 phyless，不会删除数据
docker rm -f phyless         # 删除容器，phyless-data 卷仍会保留
```

更新 phyless 镜像时，执行 `docker pull ghcr.io/lisaac/phyless:latest`，删除旧容器后重新执行上面的 `docker run`；`phyless-data` 卷会保留账号和配置。

## 注意

挂载 Docker Socket 等同于授予 phyless 管理宿主机 Docker 的高权限。请只向可信用户开放，并在公网环境中使用 HTTPS 反向代理。`phyless-data` 卷保存账号和配置，请定期备份且不要公开。
