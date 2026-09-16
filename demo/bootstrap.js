(() => {
  const now = Math.floor(Date.now() / 1000);
  const iso = (secondsAgo) => new Date((now - secondsAgo) * 1000).toISOString();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const state = {
    containers: [
      { Id: "a1b2c3d4e5f6", Names: ["/phyless"], Image: "ghcr.io/lisaac/phyless:0.1.0", ImageId: "sha256:111111111111", State: "running", Status: "Up 2 hours", Created: now - 7200, Command: "./phyless -C /data", Project: "infra", Ports: [{ PrivatePort: 8080, PublicPort: 8080, Type: "tcp", IP: "0.0.0.0" }], Mounts: [{ Source: "/srv/phyless/data", Destination: "/data", Type: "volume", Name: "phyless-data" }] },
      { Id: "b2c3d4e5f6a1", Names: ["/caddy"], Image: "caddy:2.9-alpine", ImageId: "sha256:222222222222", State: "running", Status: "Up 2 hours", Created: now - 7200, Command: "caddy run --config /etc/caddy/Caddyfile", Project: "edge", Ports: [{ PrivatePort: 80, PublicPort: 80, Type: "tcp", IP: "0.0.0.0" }, { PrivatePort: 443, PublicPort: 443, Type: "tcp", IP: "0.0.0.0" }], Mounts: [{ Source: "/srv/compose/edge/Caddyfile", Destination: "/etc/caddy/Caddyfile", Type: "bind" }] },
      { Id: "c3d4e5f6a1b2", Names: ["/uptime-kuma"], Image: "louislam/uptime-kuma:1", ImageId: "sha256:333333333333", State: "running", Status: "Up 5 days", Created: now - 432000, Command: "node server/server.js", Project: "monitoring", Ports: [{ PrivatePort: 3001, PublicPort: 3001, Type: "tcp", IP: "0.0.0.0" }], Mounts: [{ Source: "/srv/compose/monitoring/data", Destination: "/app/data", Type: "bind" }] },
      { Id: "d4e5f6a1b2c3", Names: ["/redis-cache"], Image: "redis:7-alpine", ImageId: "sha256:444444444444", State: "exited", Status: "Exited (0) 3 hours ago", Created: now - 86400, Command: "redis-server --appendonly yes", Project: "infra", Ports: [], Mounts: [] },
    ],
    images: [
      { Id: "sha256:111111111111", RepoTags: ["ghcr.io/lisaac/phyless:0.1.0"], RepoDigests: ["ghcr.io/lisaac/phyless@sha256:111111111111"], Size: 48234496, Created: now - 172800, UsedBy: [{ Id: "a1b2c3d4e5f6", Name: "phyless" }] },
      { Id: "sha256:222222222222", RepoTags: ["caddy:2.9-alpine"], RepoDigests: ["docker.io/library/caddy@sha256:222222222222"], Size: 60293120, Created: now - 259200, UsedBy: [{ Id: "b2c3d4e5f6a1", Name: "caddy" }] },
      { Id: "sha256:333333333333", RepoTags: ["louislam/uptime-kuma:1"], RepoDigests: ["docker.io/louislam/uptime-kuma@sha256:333333333333"], Size: 231735296, Created: now - 604800, UsedBy: [{ Id: "c3d4e5f6a1b2", Name: "uptime-kuma" }] },
      { Id: "sha256:444444444444", RepoTags: ["redis:7-alpine"], RepoDigests: ["docker.io/library/redis@sha256:444444444444"], Size: 41877504, Created: now - 1209600, UsedBy: [{ Id: "d4e5f6a1b2c3", Name: "redis-cache" }] },
      { Id: "sha256:555555555555", RepoTags: ["alpine:3.21"], RepoDigests: ["docker.io/library/alpine@sha256:555555555555"], Size: 8126464, Created: now - 2592000, UsedBy: [] },
    ],
    projects: [
      { id: "infra", name: "infra", base_dir: "/srv/compose/infra", compose_file: "/srv/compose/infra/compose.yaml", env_file: "/srv/compose/infra/.env", project_name: "infra", discovered: false, running: 1, total: 2, can_build: false },
      { id: "edge", name: "edge", base_dir: "/srv/compose/edge", compose_file: "/srv/compose/edge/compose.yaml", project_name: "edge", discovered: true, running: 1, total: 1, can_build: false },
      { id: "monitoring", name: "monitoring", base_dir: "/srv/compose/monitoring", compose_file: "/srv/compose/monitoring/compose.yaml", project_name: "monitoring", discovered: false, running: 1, total: 1, can_build: true },
    ],
    networks: [
      { Id: "net-bridge-01", Name: "bridge", Driver: "bridge", Scope: "local", Created: iso(864000), Internal: false, Attachable: false, IPAM: { Config: [{ Subnet: "172.17.0.0/16", Gateway: "172.17.0.1" }] }, UsedBy: [{ Id: "a1b2c3d4e5f6", Name: "phyless" }, { Id: "b2c3d4e5f6a1", Name: "caddy" }] },
      { Id: "net-edge-01", Name: "edge_default", Driver: "bridge", Scope: "local", Created: iso(432000), Internal: false, Attachable: true, IPAM: { Config: [{ Subnet: "172.19.0.0/16", Gateway: "172.19.0.1" }] }, UsedBy: [{ Id: "b2c3d4e5f6a1", Name: "caddy" }] },
      { Id: "net-monitor-1", Name: "monitoring_default", Driver: "bridge", Scope: "local", Created: iso(345600), Internal: false, Attachable: true, IPAM: { Config: [{ Subnet: "172.20.0.0/16", Gateway: "172.20.0.1" }] }, UsedBy: [{ Id: "c3d4e5f6a1b2", Name: "uptime-kuma" }] },
    ],
    volumes: [
      { Name: "phyless-data", Driver: "local", Mountpoint: "/var/lib/docker/volumes/phyless-data/_data", Scope: "local", CreatedAt: iso(2592000), UsedBy: [{ Id: "a1b2c3d4e5f6", Name: "phyless" }] },
      { Name: "redis-data", Driver: "local", Mountpoint: "/var/lib/docker/volumes/redis-data/_data", Scope: "local", CreatedAt: iso(1209600), UsedBy: [{ Id: "d4e5f6a1b2c3", Name: "redis-cache" }] },
    ],
    users: [{ id: "u-admin", username: "admin", role: "admin" }, { id: "u-ops", username: "operator", role: "operator" }, { id: "u-view", username: "viewer", role: "viewer" }],
    registries: [{ id: "r-dockerhub", url: "https://index.docker.io/v1/", username: "demo-user" }, { id: "r-ghcr", url: "ghcr.io", username: "demo-user" }],
    audit: [
      { time: iso(1200), user: "admin", action: "container.start", target: "phyless", result: "ok" },
      { time: iso(3600), user: "admin", action: "compose.up", target: "edge", result: "ok" },
      { time: iso(7200), user: "operator", action: "image.pull", target: "caddy:2.9-alpine", result: "ok" },
    ],
    templates: [{ id: "tpl-nginx", name: "Nginx", cmd: "docker run -d --name web -p 8080:80 nginx:alpine", created: iso(86400) }],
    dockerServers: [{ id: "local", name: "本机 Docker", host: "", tls: false, has_ca_pem: false, has_cert_pem: false, has_key_pem: false }],
    activeDockerServer: "local",
    files: {
      "/etc/hostname": "phyless-host\n",
      "/etc/os-release": "NAME=Alpine Linux\nID=alpine\nVERSION_ID=3.21.3\n",
      "/srv/compose/infra/compose.yaml": "services:\n  phyless:\n    image: ghcr.io/lisaac/phyless:0.1.0\n    ports:\n      - 8080:8080\n    volumes:\n      - phyless-data:/data\n  redis:\n    image: redis:7-alpine\n    volumes:\n      - redis-data:/data\nvolumes:\n  phyless-data:\n  redis-data:\n",
      "/srv/compose/infra/.env": "TZ=Asia/Kuala_Lumpur\nADMIN_PASSWORD=••••••••\n",
      "/srv/compose/edge/compose.yaml": "services:\n  caddy:\n    image: caddy:2.9-alpine\n    ports:\n      - 80:80\n      - 443:443\n",
      "/srv/compose/edge/Caddyfile": "example.com {\n  reverse_proxy phyless:8080\n}\n",
      "/srv/compose/monitoring/compose.yaml": "services:\n  uptime-kuma:\n    image: louislam/uptime-kuma:1\n    build: .\n    ports:\n      - 3001:3001\n",
      "/srv/compose/monitoring/Dockerfile": "FROM louislam/uptime-kuma:1\n",
    },
  };

  const links = (items) => items.map((c) => ({ Id: c.Id, Name: c.Names[0].replace(/^\//, "") }));
  const labels = (container) => ({
    "com.docker.compose.project": container.Project,
    "com.docker.compose.service": container.Names[0].replace(/^\//, ""),
    "com.docker.compose.project.config_files": `/srv/compose/${container.Project}/compose.yaml`,
    "com.docker.compose.project.working_dir": `/srv/compose/${container.Project}`,
  });
  const containerSummary = (c) => ({
    Id: c.Id,
    Names: c.Names,
    Image: c.Image,
    State: c.State,
    Status: c.Status,
    Created: c.Created,
    Ports: c.Ports,
    Mounts: c.Mounts,
    Command: c.Command,
    Labels: labels(c),
    NetworkSettings: { Networks: { bridge: { IPAddress: c.Id === "a1b2c3d4e5f6" ? "172.17.0.2" : "172.17.0.3" } } },
  });
  const inspectContainer = (c) => ({
    Id: c.Id.padEnd(64, "0"), Created: iso(now - c.Created), Path: c.Command.split(" ")[0], Args: c.Command.split(" ").slice(1),
    State: { Status: c.State, Running: c.State === "running", Paused: c.State === "paused", Restarting: false, OOMKilled: false, Dead: false, Pid: c.State === "running" ? 3124 : 0, ExitCode: c.State === "exited" ? 0 : 0, Error: "", StartedAt: iso(7200), FinishedAt: iso(0), Health: c.State === "running" ? { Status: "healthy", FailingStreak: 0 } : undefined },
    Image: c.ImageId, Name: c.Names[0], RestartCount: 0, Driver: "overlay2", Platform: "linux",
    HostConfig: { Binds: c.Mounts.filter((m) => m.Type === "bind").map((m) => `${m.Source}:${m.Destination}`), Memory: 536870912, MemorySwap: 1073741824, CpuQuota: 0, CpuPeriod: 100000, CpuShares: 0, RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 }, NetworkMode: "bridge", PortBindings: {} },
    Mounts: c.Mounts,
    Config: { Hostname: c.Names[0].replace(/^\//, ""), User: "", Image: c.Image, Env: ["TZ=Asia/Kuala_Lumpur", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"], Cmd: c.Command.split(" ").slice(1), Entrypoint: [c.Command.split(" ")[0]], WorkingDir: "/app", Labels: labels(c), ExposedPorts: { "8080/tcp": {} } },
    NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.2", Gateway: "172.17.0.1", MacAddress: "02:42:ac:11:00:02" } } },
  });
  const composeConfig = (project) => ({
    name: project.project_name,
    services: Object.fromEntries(state.containers.filter((c) => c.Project === project.project_name).map((c) => [c.Names[0].replace(/^\//, ""), { image: c.Image, build: project.can_build ? "." : undefined, ports: c.Ports.map((p) => `${p.PublicPort}:${p.PrivatePort}`) }])),
    volumes: project.project_name === "infra" ? { "phyless-data": {}, "redis-data": {} } : {},
  });
  const fileEntry = (name, path, is_dir, size = 0) => ({ name, path, is_dir, size, mode: is_dir ? "drwxr-xr-x" : "-rw-r--r--", mod_time: now - 1800 });
  const directoryEntries = (path) => {
    const root = path === "/" || path === "";
    const normalized = path.endsWith("/") ? path : `${path}/`;
    const names = root
      ? Object.keys(state.files).filter((p) => p.startsWith("/etc/")).map((p) => p.slice(5))
      : Object.keys(state.files).filter((p) => p.startsWith(normalized)).map((p) => p.slice(normalized.length));
    const dirs = new Set();
    const files = [];
    for (const rest of names) {
      if (!rest) continue;
      const [name, ...tail] = rest.split("/");
      if (tail.length) dirs.add(name);
      else files.push(name);
    }
    return [
      ...[...dirs].map((name) => fileEntry(name, root ? `/${name}` : `${normalized}${name}`, true)),
      ...files.map((name) => {
        const full = root ? `/${name}` : `${normalized}${name}`;
        return fileEntry(name, full, false, (state.files[full] ?? "").length);
      }),
    ];
  };
  const result = (data, status = 200) => ({ data, status });
  const textResult = (text, status = 200) => ({ text, status });
  const notFound = () => result({ error: "演示数据中没有此资源" }, 404);
  const parseBody = (body) => {
    if (typeof body !== "string") return body ?? {};
    try { return JSON.parse(body); } catch { return body; }
  };

  function route(method, input, rawBody) {
    const url = new URL(input, location.href);
    const path = url.pathname;
    const query = url.searchParams;
    const body = parseBody(rawBody);

    if (path === "/api/auth/setup" && method === "GET") return result({ configured: true });
    if (path === "/api/auth/login" && method === "POST") return result({ token: "demo-token" });
    if (path === "/api/auth/me" && method === "GET") return result({ id: "u-admin", username: "demo-admin", role: "admin" });
    if (path === "/api/auth/logout") return result({}, 204);

    if (path === "/api/containers" && method === "GET") return result(state.containers.map(containerSummary));
    if (path === "/api/containers" && method === "POST") return result({ id: "new-container" }, 201);
    let match = path.match(/^\/api\/containers\/([^/]+)\/inspect$/);
    if (match) {
      const container = state.containers.find((c) => c.Id === match[1]);
      return container ? result(inspectContainer(container)) : notFound();
    }
    match = path.match(/^\/api\/containers\/([^/]+)\/top$/);
    if (match) return result({ Titles: ["PID", "USER", "TIME", "COMMAND"], Processes: [["1", "root", "00:00:12", "./phyless -C /data"], ["18", "app", "00:00:02", "worker"]] });
    match = path.match(/^\/api\/containers\/([^/]+)\/files$/);
    if (match) return result(directoryEntries(query.get("path") || "/"));
    match = path.match(/^\/api\/containers\/([^/]+)$/);
    if (match && method === "GET") {
      const c = state.containers.find((item) => item.Id === match[1]);
      return c ? result(containerSummary(c)) : notFound();
    }

    if (path === "/api/images" && method === "GET") return result(clone(state.images));
    if (path === "/api/images/inspect" || path === "/api/images/detail") {
      const image = state.images.find((item) => item.Id === query.get("id") || item.RepoTags.includes(query.get("id")));
      return image ? result({ Id: image.Id, RepoTags: image.RepoTags, RepoDigests: image.RepoDigests, Created: iso(now - image.Created), Size: image.Size, Architecture: "amd64", Os: "linux", Config: { Cmd: ["/bin/sh"], Entrypoint: null, WorkingDir: "/" }, RootFS: { Type: "layers", Layers: ["sha256:layer-one", "sha256:layer-two"] } }) : notFound();
    }
    if (path === "/api/images/history") return result([{ Id: "sha256:layer-two", Created: now - 3600, CreatedBy: "/bin/sh -c #(nop) CMD [\\\"/bin/sh\\\"]", Size: 0, Comment: "" }, { Id: "sha256:layer-one", Created: now - 7200, CreatedBy: "alpine base layer", Size: 8126464, Comment: "" }]);
    if (path === "/api/images/files") return result(directoryEntries(query.get("path") || "/"));

    if (path === "/api/compose" && method === "GET") return result(clone(state.projects));
    if (path === "/api/compose/detail") {
      const project = state.projects.find((p) => p.id === query.get("id") || p.name === query.get("id"));
      return project ? result({ ...clone(project), services: composeConfig(project).services }) : notFound();
    }
    if (path === "/api/compose/config") {
      const project = state.projects.find((p) => p.id === query.get("id"));
      return project ? textResult(JSON.stringify(composeConfig(project), null, 2)) : notFound();
    }
    if (path === "/api/compose/pull-plan") return result({ images: state.images.map((i) => i.RepoTags[0]).filter(Boolean) });
    if (path === "/api/compose/files") return result(directoryEntries(`/srv/compose/${query.get("id")}${query.get("path") || "/"}`));
    if (path === "/api/compose/files/content") {
      const file = query.get("path") || "";
      const key = `/srv/compose/${query.get("id") || ""}${file}`;
      return Object.hasOwn(state.files, key) ? textResult(state.files[key]) : notFound();
    }
    if (path === "/api/config/files/content") {
      const key = `/etc/${(query.get("path") || "").replace(/^\/+/, "")}`;
      return Object.hasOwn(state.files, key) ? textResult(state.files[key]) : notFound();
    }
    if (path === "/api/fs/file") {
      const key = query.get("path") || "";
      return Object.hasOwn(state.files, key) ? textResult(state.files[key]) : notFound();
    }

    if (path === "/api/networks" && method === "GET") return result(clone(state.networks));
    match = path.match(/^\/api\/networks\/([^/]+)\/inspect$/);
    if (match) {
      const network = state.networks.find((item) => item.Id === match[1] || item.Name === match[1]);
      return network ? result({ ...clone(network), Containers: Object.fromEntries(network.UsedBy.map((c) => [c.Id, { Name: c.Name, IPv4Address: "172.17.0.2/16" }])) }) : notFound();
    }
    if (path === "/api/volumes" && method === "GET") return result(clone(state.volumes));
    match = path.match(/^\/api\/volumes\/([^/]+)\/inspect$/);
    if (match) {
      const volume = state.volumes.find((item) => item.Name === match[1]);
      return volume ? result({ ...clone(volume), Options: {}, Labels: {}, UsageData: { RefCount: volume.UsedBy.length, Size: 73400320 } }) : notFound();
    }
    if (/^\/api\/volumes\/[^/]+\/files$/.test(path)) return result(directoryEntries(query.get("path") || "/"));

    if (path === "/api/system/info") return result({ host_name: "phyless-host", server_version: "28.0.1", api_version: "1.48", min_api_version: "1.24", operating_system: "Alpine Linux 3.21", os_type: "linux", architecture: "x86_64", kernel_version: "6.12.8", n_cpu: 8, mem_total: 17179869184, n_goroutines: 42, n_fds: 38, docker_root_dir: "/var/lib/docker", storage_driver: "overlay2", storage_available: "84 GB", cgroup_driver: "cgroupfs", cgroup_version: "2", logging_driver: "json-file", default_runtime: "runc", live_restore: true });
    if (path === "/api/system/platform") return result({ os: "linux", arch: "amd64" });
    if (path === "/api/settings/docker") return result({ servers: clone(state.dockerServers), active_id: state.activeDockerServer });
    if (path === "/api/users") return result(clone(state.users));
    if (path === "/api/registries" && method === "GET") return result(clone(state.registries));
    if (path === "/api/registries" && method === "POST") return result({ id: "demo-registry" }, 201);
    if (/^\/api\/registries\/[^/]+\/test$/.test(path)) return result({ status: "演示模式：未连接仓库" });
    if (path === "/api/audit") return result(clone(state.audit));
    if (path === "/api/templates") return result(clone(state.templates));
    if (path === "/api/fs/list") return result(directoryEntries(query.get("path") || "/"));
    if (path === "/api/config/files") return result(directoryEntries(query.get("path") || "/"));

    if (path.endsWith("/download") || path.endsWith("/export") || path.endsWith("/save")) return result({ error: "演示模式不会生成或下载实际文件" }, 403);
    if (path.startsWith("/api/")) return notFound();
    return null;
  }

  function responseFor(output) {
    if (!output) return new Response("Not found", { status: 404 });
    if (output.status === 204) return new Response(null, { status: 204 });
    if (output.text !== undefined) return new Response(output.text, { status: output.status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    return new Response(JSON.stringify(output.data), { status: output.status, headers: { "Content-Type": "application/json" } });
  }

  function audit(task) {
    state.audit.unshift({ time: new Date().toISOString(), user: "demo-admin", action: task.title || "demo.action", target: task.url, result: "ok" });
    state.audit = state.audit.slice(0, 30);
  }

  function mutate(task) {
    const url = new URL(task.url, location.href);
    const path = url.pathname;
    const query = url.searchParams;
    const body = parseBody(task.body);
    let match = path.match(/^\/api\/containers\/([^/]+)\/(start|stop|pause|unpause|restart|kill|rename|resources|upgrade)$/);
    if (match) {
      const c = state.containers.find((item) => item.Id === match[1]);
      if (c) {
        if (match[2] === "start" || match[2] === "unpause" || match[2] === "restart") { c.State = "running"; c.Status = "Up less than a minute"; }
        if (match[2] === "pause") { c.State = "paused"; c.Status = "Up less than a minute (Paused)"; }
        if (match[2] === "stop" || match[2] === "kill") { c.State = "exited"; c.Status = "Exited (0) less than a minute ago"; }
        if (match[2] === "rename" && body.name) c.Names = [`/${body.name}`];
      }
    }
    match = path.match(/^\/api\/containers\/([^/]+)$/);
    if (match && (task.method || "POST") === "DELETE") state.containers = state.containers.filter((c) => c.Id !== match[1]);
    if (path === "/api/containers" && (task.method || "POST") === "POST") {
      const name = body.name || "demo-container";
      state.containers.unshift({ Id: `new-${Date.now().toString(36)}`, Names: [`/${name}`], Image: body.image || "nginx:alpine", ImageId: "sha256:555555555555", State: "running", Status: "Up less than a minute", Created: now, Command: "nginx -g daemon off;", Project: "manual", Ports: [], Mounts: [] });
    }
    if (path === "/api/images/pull") {
      const ref = body.image || "example:latest";
      if (!state.images.some((i) => i.RepoTags.includes(ref))) state.images.unshift({ Id: `sha256:${Date.now().toString(16).padEnd(12, "0")}`, RepoTags: [ref], RepoDigests: [], Size: 67108864, Created: now, UsedBy: [] });
    }
    if (path === "/api/images/tag") {
      const image = state.images.find((i) => i.Id === query.get("id"));
      if (image && body.tag && !image.RepoTags.includes(body.tag)) image.RepoTags.push(body.tag);
    }
    if (path === "/api/images/untag") {
      const ref = query.get("ref");
      state.images.forEach((i) => { i.RepoTags = i.RepoTags.filter((tag) => tag !== ref); });
      state.images = state.images.filter((i) => i.RepoTags.length || i.UsedBy.length);
    }
    if (path === "/api/images/delete") {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      state.images = state.images.filter((i) => !ids.includes(i.Id));
    }
    if (path === "/api/images/prune") state.images = state.images.filter((i) => i.UsedBy.length > 0);
    if (path === "/api/compose") {
      if ((task.method || "POST") === "POST") {
        const id = body.name || `compose-${Date.now().toString(36)}`;
        state.projects.unshift({ id, name: body.name || id, project_name: id, base_dir: body.base_dir || `/srv/compose/${id}`, compose_file: body.compose_file || `/srv/compose/${id}/compose.yaml`, running: 0, total: 0, can_build: false });
      } else if ((task.method || "POST") === "DELETE") {
        state.projects = state.projects.filter((p) => p.id !== query.get("id"));
      }
    }
    match = path.match(/^\/api\/compose\/(up|stop|pause|restart|down|pull|build|update)$/);
    if (match) {
      const project = state.projects.find((p) => p.id === query.get("id"));
      const members = state.containers.filter((c) => c.Project === (project?.project_name || project?.id));
      if (project) {
        if (match[1] === "down") { project.running = 0; project.total = 0; members.forEach((c) => { c.State = "exited"; c.Status = "Exited (0)"; }); }
        else if (match[1] === "stop") { project.running = 0; members.forEach((c) => { c.State = "exited"; c.Status = "Exited (0)"; }); }
        else if (match[1] === "pause") members.forEach((c) => { c.State = "paused"; c.Status = "Up (Paused)"; });
        else if (["up", "restart", "update"].includes(match[1])) { project.running = project.total; members.forEach((c) => { c.State = "running"; c.Status = "Up less than a minute"; }); }
      }
    }
    if (path === "/api/networks") {
      if ((task.method || "POST") === "POST") state.networks.push({ Id: `net-${Date.now().toString(36)}`, Name: body.name || "demo-network", Driver: body.driver || "bridge", Scope: "local", Created: new Date().toISOString(), IPAM: { Config: body.subnet ? [{ Subnet: body.subnet, Gateway: body.gateway }] : [] }, UsedBy: [] });
    }
    match = path.match(/^\/api\/networks\/([^/]+)$/);
    if (match && task.method === "DELETE") state.networks = state.networks.filter((n) => n.Id !== match[1] && n.Name !== match[1]);
    if (path === "/api/volumes") {
      if ((task.method || "POST") === "POST") state.volumes.push({ Name: body.name || "demo-volume", Driver: "local", Mountpoint: `/var/lib/docker/volumes/${body.name || "demo-volume"}/_data`, Scope: "local", CreatedAt: new Date().toISOString(), UsedBy: [] });
    }
    match = path.match(/^\/api\/volumes\/([^/]+)$/);
    if (match && task.method === "DELETE") state.volumes = state.volumes.filter((v) => v.Name !== match[1]);
    if (path === "/api/users" && task.method === "POST") state.users.push({ id: `u-${Date.now().toString(36)}`, username: body.username || "new-user", role: body.role || "viewer" });
    match = path.match(/^\/api\/users\/([^/]+)$/);
    if (match && task.method === "DELETE") state.users = state.users.filter((u) => u.id !== match[1]);
    if (path === "/api/registries" && task.method === "POST") state.registries.push({ id: `r-${Date.now().toString(36)}`, url: body.url || "registry.example.com", username: body.username || "" });
    match = path.match(/^\/api\/registries\/([^/]+)$/);
    if (match && task.method === "DELETE") state.registries = state.registries.filter((r) => r.id !== match[1]);
    if (path === "/api/settings/docker/servers" && task.method === "POST") state.dockerServers.push({ id: `d-${Date.now().toString(36)}`, name: body.name || "演示服务器", host: body.host || "", tls: !!body.tls, has_ca_pem: !!body.ca_pem, has_cert_pem: !!body.cert_pem, has_key_pem: !!body.key_pem });
    match = path.match(/^\/api\/settings\/docker\/servers\/([^/]+)\/select$/);
    if (match) state.activeDockerServer = match[1];
    audit(task);
    return { status: 200, data: { status: "演示操作已模拟" } };
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input), location.href);
    const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.origin !== location.origin) return Promise.resolve(new Response("演示模式已阻止外部网络请求", { status: 403 }));
    if (url.pathname.startsWith("/api/")) return Promise.resolve(responseFor(route(method, url.href, init.body)));
    return nativeFetch(input, init);
  };

  const showNotice = (message) => {
    const badge = document.getElementById("phyless-demo-badge");
    if (!badge) return;
    badge.textContent = message;
    clearTimeout(showNotice.timer);
    showNotice.timer = setTimeout(() => { badge.textContent = "演示模式 · 数据为模拟"; }, 2600);
  };
  window.__phylessDemo = {
    request: (method, path, body) => route(method, path, body),
    runTask: (task) => new Promise((resolve) => setTimeout(() => { mutate(task); showNotice("演示操作已模拟；没有连接 Docker"); resolve(); }, 320)),
  };

  class DemoWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = DemoWebSocket.CONNECTING;
      this.bufferedAmount = 0;
      this.binaryType = "arraybuffer";
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this.timer = null;
      setTimeout(() => {
        if (this.readyState !== DemoWebSocket.CONNECTING) return;
        this.readyState = DemoWebSocket.OPEN;
        this.onopen?.({ type: "open", target: this });
        this.stream();
      }, 20);
    }
    send() {}
    close() {
      if (this.readyState === DemoWebSocket.CLOSED) return;
      this.readyState = DemoWebSocket.CLOSED;
      clearInterval(this.timer);
      setTimeout(() => this.onclose?.({ type: "close", target: this }), 0);
    }
    emit(data) { this.onmessage?.({ data, target: this, type: "message" }); }
    stream() {
      const path = new URL(this.url).pathname;
      if (path === "/ws/events") {
        ["container start","health_status: healthy","image pull caddy:2.9-alpine"].forEach((line, i) => setTimeout(() => this.emit(`${new Date(Date.now() - i * 60000).toISOString()} ${line}\n`), i * 180));
      } else if (path.includes("/stats")) {
        let tick = 0;
        const sample = () => {
          tick++;
          const cpu = 350000000 + tick * 5000000;
          const system = 84000000000 + tick * 1500000000;
          this.emit(JSON.stringify({ read: new Date().toISOString(), cpu_stats: { cpu_usage: { total_usage: cpu }, system_cpu_usage: system, online_cpus: 8 }, precpu_stats: { cpu_usage: { total_usage: cpu - 25000000 }, system_cpu_usage: system - 1500000000 }, memory_stats: { usage: 151781376 + (tick % 4) * 1048576, limit: 536870912 }, networks: { eth0: { rx_bytes: tick * 512000, tx_bytes: tick * 96000 } } }));
        };
        sample();
        this.timer = setInterval(sample, 1200);
      } else if (path.includes("/terminal")) {
        this.emit("phyless 演示终端\r\n输入不会发送到真实容器。\r\n$ ");
      } else {
        const name = path.includes("/compose/") ? "phyless" : path.split("/")[3] || "phyless";
        ["Starting service…", `${name}: ready`, "health check passed"].forEach((line, i) => setTimeout(() => this.emit(`${new Date().toISOString()} ${line}\n`), i * 150));
      }
    }
  }
  window.WebSocket = DemoWebSocket;

  const originalOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    const parsed = new URL(String(url), location.href);
    if (parsed.origin === location.origin && parsed.pathname.startsWith("/")) {
      return originalOpen(`${location.pathname}#${parsed.pathname}${parsed.search}`, target, features);
    }
    return originalOpen(url, target, features);
  };
  document.addEventListener("click", (event) => {
    const anchor = event.target.closest?.("a[href]");
    if (!anchor) return;
    const url = new URL(anchor.href, location.href);
    if (url.pathname.startsWith("/api/")) {
      event.preventDefault();
      showNotice("演示模式不会下载实际文件");
    }
  }, true);

  try {
    localStorage.setItem("phyless_token", "demo-token");
    localStorage.removeItem("phyless_tasks");
    localStorage.removeItem("phyless_task_failure_seen_at");
  } catch {}
  const badge = document.createElement("div");
  badge.id = "phyless-demo-badge";
  badge.textContent = "演示模式 · 数据为模拟";
  badge.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:1000;padding:6px 9px;background:#27272a;border:1px solid #52525b;color:#d4d4d8;font:11px ui-sans-serif,system-ui,sans-serif;pointer-events:none";
  document.addEventListener("DOMContentLoaded", () => document.body.append(badge), { once: true });
  if (document.body) document.body.append(badge);
})();
