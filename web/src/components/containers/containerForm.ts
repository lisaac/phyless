export interface CreateForm {
  name: string;
  image: string;
  cmd: string;
  env: string;
  restart_policy: string;
  network_mode: string;
  binds: string;
  cap_add: string;
  cap_drop: string;
  privileged: boolean;
  readonly_rootfs: boolean;
  memory: string; // MB
  cpu_quota: string;
  cpu_period: string;
  sysctls: string; // k=v lines
  labels: string; // k=v lines
}

export function emptyForm(): CreateForm {
  return {
    name: "", image: "", cmd: "", env: "", restart_policy: "", network_mode: "",
    binds: "", cap_add: "", cap_drop: "", privileged: false, readonly_rootfs: false,
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
  if (f.binds.trim()) p.binds = lines(f.binds);
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
