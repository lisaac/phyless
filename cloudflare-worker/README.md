# phyless 注册表 CORS 代理（Cloudflare Worker）

这是一个仅支持 `?url=` 的透传代理：当 phyless 服务端和 Docker daemon 无法直接访问镜像仓库时，让 phyless Web UI 在浏览器中拉取容器镜像。它会添加 CORS 响应头，转发 OCI 拉取所需的请求头，并以流式方式返回上游响应，不保存任何内容。

仅支持 `GET`、`HEAD`、`OPTIONS`。请求来源和上游地址两个白名单默认拒绝。

## 一键创建

[一键创建 Cloudflare Worker](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)

登录 Cloudflare 后打开上面的链接，选择 **Create Worker → Deploy**，再将 [`registry-proxy.js`](./registry-proxy.js) 的完整内容粘贴到编辑器并部署。

## 使用 Wrangler 部署

```bash
npm i -g wrangler        # 或直接使用 npx wrangler
wrangler deploy registry-proxy.js --name phyless-registry-proxy --compatibility-date 2024-11-01
```

部署完成后，将 Worker URL 填入 phyless 拉取对话框的「Worker URL」（浏览器下载模式）。

## 环境变量

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | 允许使用代理的请求 Origin，多个值用逗号分隔。为空时反射任意 Origin，但仍要求请求带 Origin，除非设置了 `ALLOW_MISSING_ORIGIN`。 | `https://phyless.example,http://localhost:8080` |
| `UPSTREAM_ALLOWLIST` | 允许访问的注册表主机名，多个值用逗号分隔。`*.suffix` 匹配子域名，`*` 表示允许任意上游。 | `registry-1.docker.io,auth.docker.io,*.docker.io,ghcr.io,*.githubusercontent.com,production.cloudflare.docker.com` |
| `ALLOW_ANY_UPSTREAMS` | 设置为 `true` 可跳过上游白名单，建议使用明确的白名单。 | `false` |
| `ALLOW_MISSING_ORIGIN` | 设置为 `true` 可接受不带 Origin 的请求（例如 curl）。默认关闭。 | `false` |

可通过 `wrangler secret put`、`wrangler deploy --var` 或 Cloudflare 控制台设置这些变量。

## 常用白名单

Docker Hub：

```
registry-1.docker.io,auth.docker.io,production.cloudflare.docker.com,*.docker.io
```

GHCR：

```
ghcr.io,*.githubusercontent.com,pkg-containers.githubusercontent.com
```

## 安全说明

- 代理会将 `Authorization` 转发到指定的上游地址，因此必须收紧 `UPSTREAM_ALLOWLIST`；生产环境不要将 `ALLOW_ANY_UPSTREAMS` 设为 `true`，否则 Worker 会变成可转发凭据的开放代理。
- 私有注册表凭据只在请求期间经过「浏览器 → Worker → 注册表」，不会发送给 phyless 服务端。
