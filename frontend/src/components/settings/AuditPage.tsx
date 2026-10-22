import { Component, onMount, For, Show } from "solid-js";
import { PageHeader } from "../shared/Button";
import { createResourceStore } from "../../stores/resource";
import type { AuditEntry } from "../../types";

export const AuditPage: Component = () => {
  const store = createResourceStore<AuditEntry>("/api/audit");
  onMount(() => store.refresh());

  return (
    <div>
      <PageHeader title="审计日志" />
      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>
      <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="border-b border-zinc-800 text-zinc-400">
          <tr><th class="px-2 py-2">时间</th><th class="px-2 py-2">用户</th><th class="px-2 py-2">动作</th><th class="px-2 py-2">对象</th><th class="px-2 py-2">结果</th></tr>
        </thead>
        <tbody>
          <For each={store.items()}>
            {(e) => (
              <tr class="border-b border-zinc-900">
                <td class="whitespace-nowrap px-2 py-1 text-xs text-zinc-500">{new Date(e.time).toLocaleString()}</td>
                <td class="px-2 py-1">{e.user}</td>
                <td class="px-2 py-1">{e.action}</td>
                <td class="px-2 py-1 text-zinc-300"><div class="line-clamp-2 min-w-[8rem] break-all" title={e.target}>{e.target}</div></td>
                <td class={`px-2 py-1 ${e.result === "ok" ? "text-green-400" : "text-red-400"}`}><div class="line-clamp-2 min-w-[6rem] break-all" title={e.result}>{e.result}</div></td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      </div>
    </div>
  );
};
