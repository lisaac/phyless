import { shellQuote as q } from "./shell";

/**
 * Convert docker container inspect + image inspect JSON into a docker run command.
 * Logic adapted from docs/docker.html — filters out values already present in the
 * image defaults so the generated command is minimal.
 */

function arrEq(a: unknown[], b: unknown[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => JSON.stringify(v) === JSON.stringify(b[i]));
}

// Docker inspect sometimes returns {} instead of null for empty arrays
const toArr = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []) as T[];

function parseEnvArr(arr?: unknown): Record<string, string> {
  const m: Record<string, string> = {};
  toArr<string>(arr).forEach((e) => {
    const idx = e.indexOf("=");
    if (idx < 0) return;
    m[e.slice(0, idx)] = e.slice(idx + 1);
  });
  return m;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
/** Human-readable image reference. Upgraded containers pin Config.Image to a
 *  sha256 ID and keep the original tag in a label; prefer the tag. */
export const UPGRADE_IMAGE_REF_LABEL = "io.phyless.upgrade-image-ref";
export function displayImage(image: string | undefined, labels?: Record<string, string> | null): string {
  const img = image ?? "";
  if (img.startsWith("sha256:")) return labels?.[UPGRADE_IMAGE_REF_LABEL] || img.replace(/^sha256:/, "").slice(0, 12);
  return img;
}

export function inspectToRunCmd(container: any, image: any): string {
  const cfg = container?.Config ?? {};
  const img = image?.Config ?? {};
  const host = container?.HostConfig ?? {};
  const run: string[] = ["docker run -d"];

  // Name
  if (container?.Name) run.push(`--name ${q(container.Name.replace(/^\//, ""))}`);

  // Env: only values that differ from image defaults
  const envMap = parseEnvArr(cfg.Env);
  const imgEnvMap = parseEnvArr(img.Env);
  for (const k in envMap) {
    if (!(k in imgEnvMap) || envMap[k] !== imgEnvMap[k])
      run.push(`-e ${q(`${k}=${envMap[k]}`)}`);
  }

  // Hostname: Docker sets it to the container ID prefix by default — skip that
  if (cfg.Hostname && !container?.Id?.startsWith(cfg.Hostname))
    run.push(`--hostname ${q(cfg.Hostname)}`);

  // DNS
  toArr<string>(host.Dns).forEach((d) => run.push(`--dns ${d}`));
  toArr<string>(host.DnsSearch).forEach((s) => run.push(`--dns-search ${s}`));
  toArr<string>(host.DnsOptions).forEach((o) => run.push(`--dns-option ${o}`));

  // Volumes / bind mounts
  toArr<any>(container?.Mounts).forEach((m: any) => {
    if (m.Type === "tmpfs") return; // handled by host.Tmpfs below
    const mode = m.Mode || (m.RW === false ? "ro" : "");
    const source = m.Type === "volume" ? (m.Name || m.Source) : m.Source;
    run.push(`-v ${q(`${source}:${m.Destination}${mode ? ":" + mode : ""}`)}`);
  });

  // Tmpfs
  if (host.Tmpfs) {
    for (const path in host.Tmpfs) run.push(`--tmpfs ${q(`${path}:${host.Tmpfs[path]}`)}`);
  }

  // Port bindings
  const ports = host.PortBindings ?? {};
  for (const k in ports) {
    (ports[k] ?? []).forEach((p: any) => {
      const ip = p.HostIp?.includes(":") ? `[${p.HostIp}]` : p.HostIp;
      const hostPart = ip && ip !== "0.0.0.0" ? `${ip}:${p.HostPort}` : p.HostPort;
      run.push(`-p ${q(`${hostPart}:${k}`)}`);
    });
  }

  // Restart policy
  if (host.RestartPolicy?.Name && host.RestartPolicy.Name !== "no")
    run.push(`--restart ${host.RestartPolicy.Name}${host.RestartPolicy.Name === "on-failure" && host.RestartPolicy.MaximumRetryCount > 0 ? `:${host.RestartPolicy.MaximumRetryCount}` : ""}`);

  // Working directory (skip if matches image default)
  if (cfg.WorkingDir && cfg.WorkingDir !== (img.WorkingDir || "/"))
    run.push(`-w ${q(cfg.WorkingDir)}`);

  // User (docker default is root)
  if (cfg.User && cfg.User !== (img.User || "root"))
    run.push(`-u ${q(cfg.User)}`);

  // Privileged / readonly
  if (host.Privileged === true) run.push("--privileged");
  if (host.ReadonlyRootfs === true) run.push("--read-only");

  // Capabilities
  toArr<string>(host.CapAdd).forEach((c) => run.push(`--cap-add ${c}`));
  toArr<string>(host.CapDrop).forEach((c) => run.push(`--cap-drop ${c}`));

  // Security options
  toArr<string>(host.SecurityOpt).forEach((s) => run.push(`--security-opt ${q(s)}`));

  // Devices
  toArr<any>(host.Devices).forEach((d: any) => {
    run.push(`--device ${d.PathOnHost}:${d.PathInContainer}${d.CgroupPermissions ? ":" + d.CgroupPermissions : ""}`);
  });

  // Resources
  if (host.Memory > 0) run.push(`--memory ${host.Memory}`);
  if (host.NanoCpus > 0) run.push(`--cpus ${(host.NanoCpus / 1e9).toFixed(2)}`);
  if (host.CpusetCpus) run.push(`--cpuset-cpus ${host.CpusetCpus}`);
  if (host.OomKillDisable) run.push("--oom-kill-disable");
  if (host.PidsLimit) run.push(`--pids-limit ${host.PidsLimit}`);
  const defaultShm = img.ShmSize ?? 67108864;
  if (host.ShmSize && host.ShmSize !== defaultShm) run.push(`--shm-size ${host.ShmSize}`);
  if (host.Init === true) run.push("--init");

  // TTY / stdin
  if (cfg.Tty === true) run.push("--tty");
  if (cfg.OpenStdin === true) run.push("--interactive");

  // Stop options
  if (cfg.StopTimeout != null && cfg.StopTimeout !== 10) run.push(`--stop-timeout ${cfg.StopTimeout}`);
  if (cfg.StopSignal && cfg.StopSignal !== (img.StopSignal || "SIGTERM"))
    run.push(`--stop-signal ${cfg.StopSignal}`);

  // Extra hosts
  toArr<string>(host.ExtraHosts).forEach((h) => run.push(`--add-host ${h}`));

  // Sysctls
  if (host.Sysctls) {
    for (const k in host.Sysctls) run.push(`--sysctl ${k}=${host.Sysctls[k]}`);
  }

  // IPC mode
  if (host.IpcMode && host.IpcMode !== (img.IpcMode || "private"))
    run.push(`--ipc ${host.IpcMode}`);

  // Labels — skip labels that come from the image or infrastructure tooling
  if (cfg.Labels) {
    const imgLabels = img.Labels ?? {};
    for (const k in cfg.Labels) {
      if (k.startsWith("com.docker.compose.")) continue;
      if (k.startsWith("org.opencontainers.image.")) continue;
      if (k.startsWith("org.label-schema.")) continue;
      if (k.startsWith("com.docker.")) continue;
      if (cfg.Labels[k] === imgLabels[k]) continue;  // same as image default
      run.push(`--label ${q(`${k}=${cfg.Labels[k]}`)}`);
    }
  }

  // Network mode / networks
  const networks = container?.NetworkSettings?.Networks ?? {};
  const netMode: string = host.NetworkMode ?? "";
  if (netMode.startsWith("container:")) {
    run.push(`--network ${netMode}`);
  } else {
    const onlyBridge =
      netMode === "bridge" &&
      Object.keys(networks).length === 1 &&
      networks.bridge &&
      !networks.bridge.IPAMConfig;
    if (!onlyBridge) {
      for (const net in networks) {
        run.push(`--network ${net}`);
        const n = networks[net];
        if (n.IPAMConfig?.IPv4Address) run.push(`--ip ${n.IPAMConfig.IPv4Address}`);
        if (n.MacAddress) run.push(`--mac-address ${n.MacAddress}`);
        const seen = new Set<string>();
        toArr<string>(n.Aliases).forEach((alias) => {
          if (!seen.has(alias)) { seen.add(alias); run.push(`--network-alias ${alias}`); }
        });
      }
    }
  }

  // Log driver
  if (host.LogConfig?.Type && host.LogConfig.Type !== "json-file") {
    run.push(`--log-driver ${host.LogConfig.Type}`);
    for (const k in host.LogConfig.Config) run.push(`--log-opt ${k}=${host.LogConfig.Config[k]}`);
  }

  // Healthcheck — only if it differs from image defaults
  if (cfg.Healthcheck) {
    const hc = cfg.Healthcheck;
    const imgHc = img.Healthcheck ?? {};
    if (hc.Test?.length && hc.Test[0] !== "NONE" && JSON.stringify(hc.Test) !== JSON.stringify(imgHc.Test))
      run.push(`--health-cmd=${q(hc.Test.slice(1).join(" "))}`);
    if (hc.Interval > 0 && hc.Interval !== imgHc.Interval) run.push(`--health-interval=${hc.Interval}ns`);
    if (hc.Timeout > 0 && hc.Timeout !== imgHc.Timeout) run.push(`--health-timeout=${hc.Timeout}ns`);
    if (hc.StartPeriod > 0 && hc.StartPeriod !== imgHc.StartPeriod) run.push(`--health-start-period=${hc.StartPeriod}ns`);
    if (typeof hc.Retries === "number" && hc.Retries !== imgHc.Retries) run.push(`--health-retries=${hc.Retries}`);
  }

  // Ulimits
  toArr<any>(host.Ulimits).forEach((u: any) =>
    run.push(`--ulimit ${u.Name}=${u.Soft}:${u.Hard}`)
  );

  // --entrypoint resets the image CMD, so retain the effective command too.
  const entryDiff = !arrEq(cfg.Entrypoint ?? [], img.Entrypoint ?? []);
  const cmdDiff = !arrEq(cfg.Cmd ?? [], img.Cmd ?? []);
  if (entryDiff) run.push(`--entrypoint ${q(cfg.Entrypoint?.[0] ?? "")}`);
  run.push(q(displayImage(cfg.Image, cfg.Labels)));
  if (entryDiff) (cfg.Entrypoint ?? []).slice(1).forEach((p: string) => run.push(q(p)));
  if (entryDiff || cmdDiff) (cfg.Cmd ?? []).forEach((p: string) => run.push(q(p)));

  return run.join(" \\\n  ");
}
