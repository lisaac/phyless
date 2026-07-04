// Shared Docker stats-stream parsing — one JSON line per `/ws/containers/{id}/stats`
// message. Used by both the per-container stats tab and the overview dashboard.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cpuPercent(s: any): number {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats.online_cpus ?? 1;
  if (sysDelta <= 0 || cpuDelta <= 0) return 0;
  return (cpuDelta / sysDelta) * cpus * 100;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function memUsageMB(s: any): number {
  return (s.memory_stats?.usage ?? 0) / 1024 / 1024;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function memLimitMB(s: any): number {
  return (s.memory_stats?.limit ?? 0) / 1024 / 1024;
}
