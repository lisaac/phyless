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

export interface NetworkSample { rx: number; tx: number; timeMs: number; }

// Sum Docker's per-interface counters and turn two samples into bytes/sec.
// The first sample and counter resets establish a baseline with zero rate.
// `nowMs` is supplied by the reader so tests and callers use the actual sample
// interval rather than assuming Docker's nominal one-second cadence.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function networkBytes(s: any): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const value of Object.values(s?.networks ?? {})) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const net = value as any;
    const rxValue = Number(net?.rx_bytes ?? 0);
    const txValue = Number(net?.tx_bytes ?? 0);
    if (Number.isFinite(rxValue) && rxValue >= 0) rx += rxValue;
    if (Number.isFinite(txValue) && txValue >= 0) tx += txValue;
  }
  return { rx, tx };
}

export function networkRates(
  current: { rx: number; tx: number },
  previous: NetworkSample | undefined,
  nowMs: number,
): { rx: number; tx: number; sample: NetworkSample } {
  const sample = { ...current, timeMs: nowMs };
  if (!previous) return { rx: 0, tx: 0, sample };
  const seconds = (nowMs - previous.timeMs) / 1000;
  if (seconds <= 0 || current.rx < previous.rx || current.tx < previous.tx) {
    return { rx: 0, tx: 0, sample };
  }
  return {
    rx: (current.rx - previous.rx) / seconds,
    tx: (current.tx - previous.tx) / seconds,
    sample,
  };
}
