import { Component, For, Show, createResource, onMount, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { get } from "../../api/client";
import { fmtBytes } from "../../api/download";
import { createPollingResource } from "../../stores/resource";
import { REFRESH_EVENT } from "../../stores/refresh";
import type { DockerInfo } from "../../types";
import { ContainerIcon } from "../containers/ContainerIcon";
import { ComposeIcon } from "../compose/composeShared";

export const OverviewPage: Component = () => {
  const navigate = useNavigate();
  const summary = createPollingResource("/api/system/summary", {
    containers: 0, running: 0, images: 0, compose: 0, volumes: 0, networks: 0,
  });
  const [dockerInfo, { refetch: refetchDockerInfo }] = createResource(() => get<DockerInfo>("/api/system/info"));
  const refreshDockerInfo = () => { void refetchDockerInfo(); };

  onMount(() => {
    summary.startPolling();
    window.addEventListener(REFRESH_EVENT, refreshDockerInfo);
  });
  onCleanup(() => {
    summary.stopPolling();
    window.removeEventListener(REFRESH_EVENT, refreshDockerInfo);
  });


  const cards = () => [
    { label: "容器", value: `${summary.items().running} / ${summary.items().containers}`, sub: "运行中 / 总数", to: "/containers", icon: <ContainerIcon size={20} class="shrink-0" /> },
    { label: "镜像", value: `${summary.items().images}`, sub: "总数", to: "/images", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8" cy="9" r="1.5" /><path d="m4 18 5-5 4 4 3-3 4 4" /></svg> },
    { label: "Compose", value: `${summary.items().compose}`, sub: "项目", to: "/compose", icon: <ComposeIcon size={20} class="shrink-0" /> },
    { label: "存储卷", value: `${summary.items().volumes}`, sub: "总数", to: "/volumes", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5"><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v9c0 1.7 3.1 3 7 3s7-1.3 7-3V5" /><path d="M5 10c0 1.7 3.1 3 7 3s7-1.3 7-3" /></svg> },
    { label: "网络", value: `${summary.items().networks}`, sub: "总数", to: "/networks", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5"><circle cx="5" cy="12" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="19" cy="18" r="2" /><path d="m7 11 10-4M7 13l10 4" /></svg> },
  ];
  const infoRows = () => {
    const info = dockerInfo();
    if (!info) return [];
    const apiVersion = info.min_api_version ? `${info.api_version}（最低 ${info.min_api_version}）` : info.api_version;
    const cgroup = [info.cgroup_driver, info.cgroup_version && `v${info.cgroup_version}`].filter(Boolean).join(" / ");
    return [
      { label: "Docker 主机", value: info.host_name || "—" },
      { label: "Docker 版本", value: info.server_version || "—" },
      { label: "API 版本", value: apiVersion || "—" },
      { label: "平台", value: [info.os_type, info.architecture].filter(Boolean).join("/") || "—" },
      { label: "操作系统", value: info.operating_system || "—" },
      { label: "内核", value: info.kernel_version || "—" },
      { label: "CPU", value: info.n_cpu ? `${info.n_cpu} 核` : "—" },
      { label: "总内存", value: info.mem_total ? fmtBytes(info.mem_total) : "—" },
      { label: "Docker 协程", value: String(info.n_goroutines) },
      { label: "打开文件数", value: String(info.n_fds) },
      { label: "存储驱动", value: info.storage_driver || "—" },
      { label: "Docker 根目录", value: info.docker_root_dir || "—" },
      ...(info.storage_available ? [{ label: "存储可用空间", value: info.storage_available }] : []),
      { label: "Cgroup", value: cgroup || "—" },
      { label: "默认运行时", value: info.default_runtime || "—" },
      { label: "日志驱动", value: info.logging_driver || "—" },
      { label: "Live Restore", value: info.live_restore ? "已启用" : "未启用" },
    ];
  };

  return (
    <div>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <For each={cards()}>
          {(c) => (
            <div
              class="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-900 p-4 transition-colors hover:border-zinc-700"
              onClick={() => navigate(c.to, { replace: true })}
            >
              <div class="flex items-start justify-between">
                <div class="text-xs text-zinc-500">{c.label}</div>
                <span aria-hidden="true" class="text-zinc-500">{c.icon}</span>
              </div>
              <div class="mt-1 text-2xl font-semibold text-zinc-100">{c.value}</div>
              <div class="text-[11px] text-zinc-500">{c.sub}</div>
            </div>
          )}
        </For>
      </div>

      <Show when={dockerInfo()} fallback={<Show when={dockerInfo.error}><p class="mt-6 text-sm text-red-400" role="status">无法加载 Docker 信息</p></Show>}>
        <section class="mt-6 border border-zinc-800 bg-zinc-900">
          <h2 class="border-b border-zinc-800 px-4 py-3 text-sm font-semibold text-zinc-200">Docker 信息</h2>
          <dl class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
            <For each={infoRows()}>
              {(item) => (
                <div class="border-b border-zinc-800 px-4 py-3">
                  <dt class="text-xs text-zinc-500">{item.label}</dt>
                  <dd class="mt-1 truncate text-sm text-zinc-200" title={item.value}>{item.value}</dd>
                </div>
              )}
            </For>
          </dl>
        </section>
      </Show>
    </div>
  );
};
