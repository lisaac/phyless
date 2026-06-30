import { Component, onMount, For, Show } from "solid-js";
import { createResourceStore } from "../../stores/resource";
import type { AuditEntry } from "../../types";

export const AuditPage: Component = () => {
  const store = createResourceStore<AuditEntry>("/api/audit");
  onMount(() => store.refresh());

  return (
    <div>
      <h1 class="mb-4 text-xl font-semibold">审计日志</h1>
      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>
      <table class="w-full text-left text-sm">
        <thead class="border-b border-zinc-800 text-zinc-400">
          <tr><th class="px-2 py-2">时间</th><th class="px-2 py-2">用户</th><th class="px-2 py-2">动作</th><th class="px-2 py-2">对象</th><th class="px-2 py-2">结果</th></tr>
        </thead>
        <tbody>
          <For each={store.items()}>
            {(e) => (
              <tr class="border-b border-zinc-900">
                <td class="px-2 py-1 text-xs text-zinc-500">{new Date(e.time).toLocaleString()}</td>
                <td class="px-2 py-1">{e.user}</td>
                <td class="px-2 py-1">{e.action}</td>
                <td class="px-2 py-1 text-zinc-300">{e.target}</td>
                <td class={`px-2 py-1 ${e.result === "ok" ? "text-green-400" : "text-red-400"}`}>{e.result}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
};
