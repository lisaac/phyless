export interface CreateForm {
  name: string;
  image: string;
  cmd: string;
  env: string;
  restart_policy: string;
  network_mode: string;
  ports: string;
  binds: string;
  hostname: string;
  working_dir: string;
  user: string;
  dns: string;
  devices: string;
  tmpfs: string;
  cap_add: string;
  cap_drop: string;
  privileged: boolean;
  readonly_rootfs: boolean;
  publish_all: boolean;
  interactive: boolean;
  tty: boolean;
  auto_remove: boolean;
  init: boolean;
  no_healthcheck: boolean;
  memory: string;
  memory_swap: string;
  cpu_quota: string;
  cpu_period: string;
  cpu_shares: string;
  sysctls: string;
  labels: string;
  log_driver: string;
  log_opts: string;
  pull_policy: string;
}

export function emptyForm(): CreateForm {
  return {
    name: "", image: "", cmd: "", env: "", restart_policy: "unless-stopped", network_mode: "",
    ports: "", binds: "", hostname: "", working_dir: "", user: "", dns: "",
    devices: "", tmpfs: "", cap_add: "", cap_drop: "",
    privileged: false, readonly_rootfs: false, publish_all: false,
    interactive: false, tty: false, auto_remove: false, init: false, no_healthcheck: false,
    memory: "", memory_swap: "", cpu_quota: "", cpu_period: "", cpu_shares: "",
    sysctls: "", labels: "", log_driver: "", log_opts: "", pull_policy: "",
  };
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const csv = (s: string) => s.split(",").map((l) => l.trim()).filter(Boolean);
function kvObject(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines(s)) {
    const i = l.indexOf("=");
    if (i > 0) out[l.slice(0, i)] = l.slice(i + 1);
  }
  return out;
}

export function formToPayload(f: CreateForm): Record<string, unknown> {
  const p: Record<string, unknown> = { name: f.name, image: f.image };
  if (f.cmd.trim()) p.cmd = csv(f.cmd);
  if (f.env.trim()) p.env = lines(f.env);
  if (f.restart_policy) p.restart_policy = f.restart_policy;
  if (f.network_mode) p.network_mode = f.network_mode;
  if (f.ports.trim()) p.ports = lines(f.ports);
  if (f.binds.trim()) p.binds = lines(f.binds);
  if (f.hostname.trim()) p.hostname = f.hostname;
  if (f.working_dir.trim()) p.working_dir = f.working_dir;
  if (f.user.trim()) p.user = f.user;
  if (f.dns.trim()) p.dns = lines(f.dns);
  if (f.devices.trim()) p.devices = lines(f.devices);
  if (f.tmpfs.trim()) p.tmpfs = lines(f.tmpfs);
  if (f.cap_add.trim()) p.cap_add = csv(f.cap_add);
  if (f.cap_drop.trim()) p.cap_drop = csv(f.cap_drop);
  if (f.privileged) p.privileged = true;
  if (f.readonly_rootfs) p.readonly_rootfs = true;
  if (f.publish_all) p.publish_all = true;
  if (f.interactive) p.interactive = true;
  if (f.tty) p.tty = true;
  if (f.auto_remove) p.auto_remove = true;
  if (f.init) p.init = true;
  if (f.no_healthcheck) p.no_healthcheck = true;
  if (f.memory.trim()) p.memory = Number(f.memory) * 1024 * 1024;
  if (f.memory_swap.trim()) {
    const v = Number(f.memory_swap);
    p.memory_swap = v === -1 ? -1 : v * 1024 * 1024;
  }
  if (f.cpu_quota.trim()) p.cpu_quota = Number(f.cpu_quota);
  if (f.cpu_period.trim()) p.cpu_period = Number(f.cpu_period);
  if (f.cpu_shares.trim()) p.cpu_shares = Number(f.cpu_shares);
  if (f.sysctls.trim()) p.sysctls = kvObject(f.sysctls);
  if (f.labels.trim()) p.labels = kvObject(f.labels);
  if (f.log_driver.trim()) {
    p.log_driver = f.log_driver;
    if (f.log_opts.trim()) p.log_opts = kvObject(f.log_opts);
  }
  if (f.pull_policy) p.pull_policy = f.pull_policy;
  return p;
}

// Generate a docker run command from form fields
export function formToRunCmd(f: CreateForm): string {
  const parts: string[] = ["docker run -d"];
  if (f.pull_policy) parts.push(`--pull ${f.pull_policy}`);
  if (f.name) parts.push(`--name ${f.name}`);
  if (f.hostname) parts.push(`-h ${f.hostname}`);
  if (f.user) parts.push(`-u ${f.user}`);
  if (f.restart_policy) parts.push(`--restart ${f.restart_policy}`);
  if (f.network_mode) parts.push(`--network ${f.network_mode}`);
  if (f.working_dir) parts.push(`-w ${f.working_dir}`);
  if (f.interactive) parts.push("-i");
  if (f.tty) parts.push("-t");
  if (f.privileged) parts.push("--privileged");
  if (f.readonly_rootfs) parts.push("--read-only");
  if (f.publish_all) parts.push("-P");
  if (f.auto_remove) parts.push("--rm");
  if (f.init) parts.push("--init");
  if (f.no_healthcheck) parts.push("--no-healthcheck");
  for (const p of lines(f.ports)) parts.push(`-p ${p}`);
  for (const e of lines(f.env)) parts.push(`-e ${/\s/.test(e) ? JSON.stringify(e) : e}`);
  for (const b of lines(f.binds)) parts.push(`-v ${b}`);
  for (const d of lines(f.dns)) parts.push(`--dns ${d}`);
  for (const d of lines(f.devices)) parts.push(`--device ${d}`);
  for (const t of lines(f.tmpfs)) parts.push(`--tmpfs ${t}`);
  for (const [k, v] of Object.entries(kvObject(f.sysctls))) parts.push(`--sysctl ${k}=${v}`);
  for (const [k, v] of Object.entries(kvObject(f.labels))) parts.push(`--label ${k}=${v}`);
  for (const c of csv(f.cap_add)) parts.push(`--cap-add ${c}`);
  for (const c of csv(f.cap_drop)) parts.push(`--cap-drop ${c}`);
  if (f.memory) parts.push(`-m ${f.memory}m`);
  if (f.memory_swap) parts.push(`--memory-swap ${Number(f.memory_swap) === -1 ? "-1" : f.memory_swap + "m"}`);
  if (f.cpu_quota) parts.push(`--cpu-quota ${f.cpu_quota}`);
  if (f.cpu_period) parts.push(`--cpu-period ${f.cpu_period}`);
  if (f.cpu_shares) parts.push(`--cpu-shares ${f.cpu_shares}`);
  if (f.log_driver) {
    parts.push(`--log-driver ${f.log_driver}`);
    for (const [k, v] of Object.entries(kvObject(f.log_opts))) parts.push(`--log-opt ${k}=${v}`);
  }
  if (f.image) parts.push(f.image);
  if (f.cmd.trim()) for (const c of csv(f.cmd)) parts.push(c);
  return parts.join(" \\\n  ");
}

// Strip surrounding quotes from a regex \S+ capture (quotes included when docker run cmd was pasted)
const stripQ = (s: string | undefined): string | undefined =>
  s ? s.replace(/^["']|["']$/g, "") : s;

// Shell-aware tokenizer — strips quotes and handles spaces inside them
function shellTokenize(s: string): string[] {
  const tokens: string[] = [];
  let tok = "", inDQ = false, inSQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inDQ) {
      if (c === '"') inDQ = false;
      else if (c === "\\") tok += s[++i] ?? "";
      else tok += c;
    } else if (inSQ) {
      if (c === "'") inSQ = false;
      else tok += c;
    } else if (c === '"') { inDQ = true; }
    else if (c === "'") { inSQ = true; }
    else if (/\s/.test(c)) { if (tok) { tokens.push(tok); tok = ""; } }
    else tok += c;
  }
  if (tok) tokens.push(tok);
  return tokens;
}

// Parse a docker run command into form fields
export function parseRunIntoForm(run: string): Partial<CreateForm> {
  const result: Partial<CreateForm> = {};
  const r = run.trim().replace(/\\\n\s*/g, " ");  // join line continuations

  const name = r.match(/--name[=\s]+(\S+)/);
  if (name) result.name = stripQ(name[1])!;

  const net = r.match(/--network[=\s]+(\S+)/);
  if (net) result.network_mode = stripQ(net[1])!;

  const restart = r.match(/--restart[=\s]+(\S+)/);
  if (restart) result.restart_policy = stripQ(restart[1])!;

  const hostname = r.match(/-h[=\s]+(\S+)|--hostname[=\s]+(\S+)/);
  if (hostname) result.hostname = stripQ(hostname[1] ?? hostname[2])!;

  const user = r.match(/-u[=\s]+(\S+)|--user[=\s]+(\S+)/);
  if (user) result.user = stripQ(user[1] ?? user[2])!;

  const workdir = r.match(/-w[=\s]+(\S+)|--workdir[=\s]+(\S+)|--work-dir[=\s]+(\S+)/);
  if (workdir) result.working_dir = stripQ(workdir[1] ?? workdir[2] ?? workdir[3])!;

  const pull = r.match(/--pull[=\s]+(\S+)/);
  if (pull) result.pull_policy = stripQ(pull[1])!;

  const logDriver = r.match(/--log-driver[=\s]+(\S+)/);
  if (logDriver) result.log_driver = stripQ(logDriver[1])!;

  if (/\s-P\b|--publish-all/.test(r)) result.publish_all = true;
  if (/--privileged/.test(r)) result.privileged = true;
  if (/--read-only/.test(r)) result.readonly_rootfs = true;
  // single-dash compound flags: -i, -it, -ti, -dit …
  if (/(?:^|\s)-[a-z]*i[a-z]*(?:\s|$)|--interactive/.test(r)) result.interactive = true;
  if (/(?:^|\s)-[a-z]*t[a-z]*(?:\s|$)|--tty/.test(r)) result.tty = true;
  if (/--rm\b/.test(r)) result.auto_remove = true;
  if (/--init\b/.test(r)) result.init = true;
  if (/--no-healthcheck\b/.test(r)) result.no_healthcheck = true;

  let m: RegExpExecArray | null;

  const ports: string[] = [];
  const portRe = /-p[=\s]+(\S+)|--publish[=\s]+(\S+)/g;
  while ((m = portRe.exec(r)) !== null) ports.push(stripQ(m[1] ?? m[2])!);
  if (ports.length) result.ports = ports.join("\n");

  const envs: string[] = [];
  // Handle both -e "KEY=value with spaces" and -e KEY=value
  const envRe = /(?:-e|--env)[=\s]+"([^"]+)"|(?:-e|--env)[=\s]+'([^']+)'|(?:-e|--env)[=\s]+(\S+)/g;
  while ((m = envRe.exec(r)) !== null) envs.push(m[1] ?? m[2] ?? stripQ(m[3])!);
  if (envs.length) result.env = envs.join("\n");

  const binds: string[] = [];
  const bindRe = /-v[=\s]+(\S+)|--volume[=\s]+(\S+)/g;
  while ((m = bindRe.exec(r)) !== null) binds.push(stripQ(m[1] ?? m[2])!);
  if (binds.length) result.binds = binds.join("\n");

  const dns: string[] = [];
  const dnsRe = /--dns[=\s]+(\S+)/g;
  while ((m = dnsRe.exec(r)) !== null) dns.push(stripQ(m[1])!);
  if (dns.length) result.dns = dns.join("\n");

  const devices: string[] = [];
  const devRe = /--device[=\s]+(\S+)/g;
  while ((m = devRe.exec(r)) !== null) devices.push(stripQ(m[1])!);
  if (devices.length) result.devices = devices.join("\n");

  const tmpfsList: string[] = [];
  const tmpfsRe = /--tmpfs[=\s]+(\S+)/g;
  while ((m = tmpfsRe.exec(r)) !== null) tmpfsList.push(stripQ(m[1])!);
  if (tmpfsList.length) result.tmpfs = tmpfsList.join("\n");

  const sysctls: string[] = [];
  const sysctlRe = /--sysctl[=\s]+(\S+)/g;
  while ((m = sysctlRe.exec(r)) !== null) sysctls.push(stripQ(m[1])!);
  if (sysctls.length) result.sysctls = sysctls.join("\n");

  const labels: string[] = [];
  const labelRe = /--label[=\s]+(\S+)|-l[=\s]+(\S+)/g;
  while ((m = labelRe.exec(r)) !== null) labels.push(stripQ(m[1] ?? m[2])!);
  if (labels.length) result.labels = labels.join("\n");

  const capAdds: string[] = [];
  const capAddRe = /--cap-add[=\s]+(\S+)/g;
  while ((m = capAddRe.exec(r)) !== null) capAdds.push(stripQ(m[1])!);
  if (capAdds.length) result.cap_add = capAdds.join(",");

  const capDrops: string[] = [];
  const capDropRe = /--cap-drop[=\s]+(\S+)/g;
  while ((m = capDropRe.exec(r)) !== null) capDrops.push(stripQ(m[1])!);
  if (capDrops.length) result.cap_drop = capDrops.join(",");

  const mem = r.match(/-m[=\s]+(\d+)([mMgG]?)|--memory[=\s]+(\d+)([mMgG]?)/);
  if (mem) {
    const val = Number(mem[1] ?? mem[3]);
    const unit = (mem[2] ?? mem[4] ?? "m").toLowerCase();
    result.memory = unit === "g" ? String(val * 1024) : String(val);
  }
  const memSwap = r.match(/--memory-swap[=\s]+(-?\d+)([mMgG]?)/);
  if (memSwap) {
    const val = Number(memSwap[1]);
    if (val === -1) result.memory_swap = "-1";
    else {
      const unit = (memSwap[2] ?? "m").toLowerCase();
      result.memory_swap = unit === "g" ? String(val * 1024) : String(val);
    }
  }
  const cpuShares = r.match(/--cpu-shares[=\s]+(\d+)|-c[=\s]+(\d+)/);
  if (cpuShares) result.cpu_shares = cpuShares[1] ?? cpuShares[2];
  const cpuQuota = r.match(/--cpu-quota[=\s]+(\d+)/);
  if (cpuQuota) result.cpu_quota = cpuQuota[1];
  const cpuPeriod = r.match(/--cpu-period[=\s]+(\d+)/);
  if (cpuPeriod) result.cpu_period = cpuPeriod[1];

  const logOpts: string[] = [];
  const logOptRe = /--log-opt[=\s]+(\S+)/g;
  while ((m = logOptRe.exec(r)) !== null) logOpts.push(stripQ(m[1])!);
  if (logOpts.length) result.log_opts = logOpts.join("\n");

  // Image: use shell tokenizer so quoted values with spaces don't confuse detection
  const stripped = r.replace(/docker\s+run\s+/, "");
  const tokens = shellTokenize(stripped);
  // All docker run flags that consume the next token as their value.
  // Missing entries here shift the image name into a flag value position,
  // causing everything after to appear in the CMD field.
  const flagsWithValue = new Set([
    // identity / naming
    "--name", "--hostname", "-h", "--domainname",
    // network
    "--network", "--net", "--network-alias", "--net-alias",
    "--ip", "--ip6", "--mac-address", "--add-host", "--link", "--link-local-ip",
    "--dns", "--dns-option", "--dns-search", "--expose",
    // publish
    "-p", "--publish",
    // env / labels / secrets
    "-e", "--env", "--env-file", "--label", "-l", "--label-file",
    // volumes / mounts
    "-v", "--volume", "--volume-driver", "--volumes-from", "--mount", "--tmpfs",
    // user / workdir
    "--user", "-u", "--workdir", "-w", "--group-add",
    // runtime / restart
    "--restart", "--entrypoint", "--runtime", "--pull",
    "--stop-signal", "--stop-timeout",
    // cpu
    "--cpus", "--cpu-shares", "-c", "--cpu-period", "--cpu-quota",
    "--cpu-rt-period", "--cpu-rt-runtime", "--cpu-count", "--cpu-percent",
    "--cpuset-cpus", "--cpuset-mems",
    // memory
    "--memory", "-m", "--memory-reservation", "--memory-swap", "--memory-swappiness",
    "--kernel-memory", "--shm-size",
    // blkio / io
    "--blkio-weight", "--blkio-weight-device",
    "--device-read-bps", "--device-read-iops", "--device-write-bps", "--device-write-iops",
    "--io-maxbandwidth", "--io-maxiops",
    // devices / caps / security
    "--device", "--cap-add", "--cap-drop", "--security-opt", "--sysctl",
    "--ulimit", "--ipc", "--pid", "--userns", "--uts", "--isolation",
    "--cgroup-parent", "--cgroupns",
    // logging
    "--log-driver", "--log-opt",
    // health
    "--health-cmd", "--health-interval", "--health-retries",
    "--health-start-period", "--health-timeout",
    // misc
    "--attach", "-a", "--cidfile", "--oom-score-adj", "--pids-limit",
    "--platform", "--gpus", "--storage-opt",
  ]);
  let skipNext = false;
  for (let i = 0; i < tokens.length; i++) {
    if (skipNext) { skipNext = false; continue; }
    const w = tokens[i];
    if (!w) continue;
    if (w.startsWith("-")) {
      // flag=value form: no skip needed; bare flag with value: skip next token
      if (!w.includes("=") && flagsWithValue.has(w)) skipNext = true;
      continue;
    }
    result.image = w;
    const cmdArgs = tokens.slice(i + 1).join(",");
    if (cmdArgs) result.cmd = cmdArgs;
    break;
  }

  return result;
}
