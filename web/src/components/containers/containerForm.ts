export interface CreateForm {
  name: string;
  image: string;
  cmd: string;
  env: string;
  restart_policy: string;
  network_mode: string;
  ports: string;        // one spec per line: "8080:80", "0.0.0.0:443:443/tcp"
  binds: string;
  hostname: string;
  working_dir: string;
  cap_add: string;
  cap_drop: string;
  privileged: boolean;
  readonly_rootfs: boolean;
  memory: string;       // MB
  cpu_quota: string;
  cpu_period: string;
  sysctls: string;      // k=v lines
  labels: string;       // k=v lines
}

export function emptyForm(): CreateForm {
  return {
    name: "", image: "", cmd: "", env: "", restart_policy: "", network_mode: "",
    ports: "", binds: "", hostname: "", working_dir: "",
    cap_add: "", cap_drop: "", privileged: false, readonly_rootfs: false,
    memory: "", cpu_quota: "", cpu_period: "", sysctls: "", labels: "",
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
  if (f.cap_add.trim()) p.cap_add = csv(f.cap_add);
  if (f.cap_drop.trim()) p.cap_drop = csv(f.cap_drop);
  if (f.privileged) p.privileged = true;
  if (f.readonly_rootfs) p.readonly_rootfs = true;
  if (f.memory.trim()) p.memory = Number(f.memory) * 1024 * 1024;
  if (f.cpu_quota.trim()) p.cpu_quota = Number(f.cpu_quota);
  if (f.cpu_period.trim()) p.cpu_period = Number(f.cpu_period);
  if (f.sysctls.trim()) p.sysctls = kvObject(f.sysctls);
  if (f.labels.trim()) p.labels = kvObject(f.labels);
  return p;
}

// Parse a docker run command or compose YAML output into form fields.
// Handles name, image, ports, env, volumes, network, restart, hostname.
export function parseRunIntoForm(run: string): Partial<CreateForm> {
  const result: Partial<CreateForm> = {};
  const r = run.trim();

  const name = r.match(/--name[=\s]+(\S+)/);
  if (name) result.name = name[1];

  const net = r.match(/--network[=\s]+(\S+)/);
  if (net) result.network_mode = net[1];

  const restart = r.match(/--restart[=\s]+(\S+)/);
  if (restart) result.restart_policy = restart[1];

  const hostname = r.match(/-h[=\s]+(\S+)|--hostname[=\s]+(\S+)/);
  if (hostname) result.hostname = hostname[1] ?? hostname[2];

  const ports: string[] = [];
  const portRe = /-p[=\s]+(\S+)|--publish[=\s]+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = portRe.exec(r)) !== null) ports.push(m[1] ?? m[2]);
  if (ports.length) result.ports = ports.join("\n");

  const envs: string[] = [];
  const envRe = /-e[=\s]+(\S+)|--env[=\s]+(\S+)/g;
  while ((m = envRe.exec(r)) !== null) envs.push(m[1] ?? m[2]);
  if (envs.length) result.env = envs.join("\n");

  const binds: string[] = [];
  const bindRe = /-v[=\s]+(\S+)|--volume[=\s]+(\S+)/g;
  while ((m = bindRe.exec(r)) !== null) binds.push(m[1] ?? m[2]);
  if (binds.length) result.binds = binds.join("\n");

  // Image: last non-flag word that looks like an image name (after 'docker run ...')
  const words = r.replace(/docker\s+run\s+/, "").split(/\s+/);
  let skipNext = false;
  const flagsWithValue = new Set([
    "--name", "--network", "--restart", "--hostname", "-h", "-p", "--publish",
    "-e", "--env", "-v", "--volume", "--entrypoint", "--user", "-u",
    "--workdir", "-w", "--label", "-l", "--add-host", "--device",
    "--cpus", "--memory", "-m",
  ]);
  for (let i = 0; i < words.length; i++) {
    if (skipNext) { skipNext = false; continue; }
    const w = words[i];
    if (!w) continue;
    if (w.startsWith("-")) {
      // if flag=value form, skip just this; if standalone known flag, skip next
      if (!w.includes("=") && flagsWithValue.has(w)) skipNext = true;
      continue;
    }
    // first non-flag word after stripping 'docker run' is the image
    result.image = w;
    break;
  }

  return result;
}
