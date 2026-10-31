import { Component, For, Show, createSignal, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { PageHeader } from "../shared/Button";
import { IBtn } from "../shared/ActionButton";
import { confirmAction } from "../shared/ConfirmModal";
import { toast } from "../shared/Toast";
import { AutoUpdateModal, AutoUpdateRecord } from "../shared/AutoUpdate";
import { createResourceStore } from "../../stores/resource";
import { autoUpdateList, deleteAutoUpdate, runAutoUpdate, scheduleLabel, type AutoUpdatePolicy } from "../../stores/autoUpdate";
import { containerName } from "../containers/containerActions";
import type { ComposeProject, ContainerSummary } from "../../types";

// Every auto-update policy of the active Docker server in one place, including
// ones whose target is gone (deleted or renamed outside phyless): they are
// never removed automatically, so this is where they get cleaned up.
export const AutoUpdatesPage: Component = () => {
  const navigate = useNavigate();
  // One read each, no polling: only to tell whether a target still exists.
  const containers = createResourceStore<ContainerSummary>("/api/containers");
  const projects = createResourceStore<ComposeProject>("/api/compose", "id");
  const [loaded, setLoaded] = createSignal(false);
  onMount(() => void Promise.all([containers.refresh(), projects.refresh()]).then(() => setLoaded(true)));
  const [editing, setEditing] = createSignal<AutoUpdatePolicy | null>(null);

  const containerId = (name: string) => containers.items().find((c) => containerName(c) === name)?.Id;
  const href = (p: AutoUpdatePolicy) => {
    if (p.kind === "compose") return projects.items().some((x) => x.id === p.target) ? `/compose/${p.target}` : undefined;
    const id = containerId(p.target);
    return id ? `/containers/${id}` : undefined;
  };
  // Until both lists loaded cleanly, trust only the backend's last finding.
  const missing = (p: AutoUpdatePolicy) =>
    loaded() && !containers.error() && !projects.error() ? !href(p) : !!p.missing_since;

  const remove = async (p: AutoUpdatePolicy) => {
    if (!await confirmAction(`删除 ${p.target} 的自动更新设置？`, { title: "删除自动更新", confirmText: "删除", danger: true })) return;
    try { await deleteAutoUpdate(p); } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div>
      <PageHeader title="自动更新" description="当前 Docker 服务器上所有容器与 Compose 项目的自动检查 / 更新设置。目标被删除或改名后设置不会自动删除，在这里清理。" />
      <div class="overflow-x-auto border border-zinc-800">
        <div class="hidden border-b border-zinc-800 text-xs text-zinc-500 sm:flex">
          <div class="min-w-0 flex-1 px-3 py-2">目标</div>
          <div class="w-40 shrink-0 px-3 py-2">定时</div>
          <div class="w-80 shrink-0 px-3 py-2">上次运行 / 最近更新</div>
        </div>
        <div class="divide-y divide-zinc-800">
          <Show when={autoUpdateList().length > 0}>
            <For each={autoUpdateList()}>
              {(p) => (
                <div class="flex flex-col text-sm transition-colors sm:flex-row sm:items-start hover:bg-white/[0.03]">
                  <div class="min-w-0 w-full px-3 py-2 sm:flex-1">
                    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Show when={href(p)} fallback={<span class="break-all font-medium text-zinc-300">{p.target}</span>}>
                        {(h) => (
                          <a
                            href={h()}
                            class="break-all font-medium text-indigo-400 transition-colors hover:text-indigo-300 hover:underline"
                            onClick={(e) => { e.preventDefault(); navigate(h(), { replace: true }); }}
                          >{p.target}</a>
                        )}
                      </Show>
                      <span class="border border-zinc-700 px-1 text-[10px] text-zinc-400">{p.kind === "compose" ? "Compose" : "容器"}</span>
                      <Show when={missing(p)}>
                        <span class="border border-red-500/40 bg-red-500/10 px-1 text-[10px] text-red-400" title="目标已被删除或改名；设置不会自动删除">目标不存在</span>
                      </Show>
                      <Show when={!p.enabled}><span class="text-[10px] text-zinc-500">已停用</span></Show>
                    </div>
                    <div class="mt-1 flex items-center gap-0.5">
                      <IBtn title="编辑" onClick={() => setEditing(p)}>✎</IBtn>
                      <IBtn title="立即执行一次" onClick={() => runAutoUpdate(p)}>▶</IBtn>
                      <IBtn title="删除" danger onClick={() => void remove(p)}>⊖</IBtn>
                    </div>
                  </div>
                  <div class="w-full border-t border-zinc-800/60 px-3 py-2 text-xs text-zinc-400 sm:w-40 sm:shrink-0 sm:border-t-0">
                    <div>{scheduleLabel(p.schedule)}</div>
                    <div class="text-zinc-500">{p.mode === "update" ? "自动更新" : "只检查"}{p.remove_old_image ? " · 删除旧镜像" : ""}</div>
                  </div>
                  <div class="w-full min-w-0 border-t border-zinc-800/60 px-3 py-2 sm:w-80 sm:shrink-0 sm:border-t-0">
                    <AutoUpdateRecord policy={p} />
                  </div>
                </div>
              )}
            </For>
          </Show>
          <Show when={autoUpdateList().length === 0}>
            <p class="px-3 py-6 text-center text-xs text-zinc-500">还没有自动更新设置。在容器或 Compose 详情页点「↻ 自动更新」添加。</p>
          </Show>
        </div>
      </div>
      <AutoUpdateModal
        kind={editing()?.kind ?? "container"}
        target={editing()?.target ?? null}
        title={editing()?.target ?? ""}
        onClose={() => setEditing(null)}
      />
    </div>
  );
};
