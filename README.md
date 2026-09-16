# phyless

一个自托管的 Docker 管理面板。打开网页，就能管理服务器上的容器、镜像和 Compose 项目。

[在线演示](https://lisaac.github.io/phyless/) · [Docker 镜像](https://github.com/lisaac/phyless/pkgs/container/phyless)

> 在线演示只展示界面，操作的是浏览器中的示例数据，不会连接真实 Docker。

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

## 注意

挂载 Docker Socket 等同于授予 phyless 管理宿主机 Docker 的高权限。请只向可信用户开放，并在公网环境中使用 HTTPS 反向代理。`phyless-data` 卷保存账号和配置，请定期备份且不要公开。
