import { Component, createSignal, createResource, onMount, onCleanup, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { IBtn, Ico } from "../shared/ActionButton";
import { createListView, SearchBox, LoadMore } from "../shared/ListView";
import { get } from "../../api/client";
import { queued } from "../../stores/taskQueue";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import type { NetworkSummary } from "../../types";

const fmtDate = (s?: string): string => {
  if (!s) return "—";
  const t = new Date(s);
  if (isNaN(t.getTime())) return "—";
  return t.toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
};

// Subnet/gateway pairs from IPAM — the concrete address ranges the network hands out.
const ipamRanges = (n: NetworkSummary) =>
  (n.IPAM?.Config ?? []).filter((c) => c.Subnet || c.Gateway);

export const NetworkListPage: Component = () => {
  const navigate = useNavigate();
  const store = createResourceStore<NetworkSummary>("/api/networks");
  const view = createListView(store.items, (n) =>
    `${n.Name} ${n.Id} ${n.Driver} ${n.Scope} ${ipamRanges(n).map((c) => `${c.Subnet} ${c.Gateway}`).join(" ")} ${n.UsedBy?.map((c) => c.Name).join(" ") ?? ""}`);
  const [show, setShow] = createSignal(false);
  const [form, setForm] = createSignal({ name: "", driver: "bridge", subnet: "", gateway: "", parent: "" });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const needsParent = () => form().driver === "macvlan" || form().driver === "ipvlan";
  const [inspectFor, setInspectFor] = createSignal<NetworkSummary | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [inspectData] = createResource(inspectFor, (n) => get<any>(`/api/networks/${encodeURIComponent(n.Id)}/inspect`));

  onMount(() => store.startPolling());
  onCleanup(() => store.stopPolling());

  const create = async () => {
    const f = form();
    const body: Record<string, unknown> = { name: f.name, driver: f.driver };
    if (f.subnet) body.subnet = f.subnet;
    if (f.gateway) body.gateway = f.gateway;
    if (f.parent) body.parent = f.parent;
    try {
      await queued(`创建网络 ${f.name}`, "POST", "/api/networks", body);
      setShow(false);
      setForm({ name: "", driver: "bridge", subnet: "", gateway: "", parent: "" });
      await store.refresh();
    } catch (e) { toast.error((e as Error).message); }
  };
  const remove = async (id: string, name: string) => {
    if (!confirm(`删除网络 ${name}？`)) return;
    try { await queued(`删除网络 ${name}`, "DELETE", `/api/networks/${id}`); await store.refresh(); }
    catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div>
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-semibold">网络</h1>
        <Show when={hasRole("operator")}>
          <Button variant="primary" onClick={() => setShow(true)}>创建网络</Button>
        </Show>
      </div>
      <div class="mb-3">
        <SearchBox value={view.query()} onInput={view.setQuery} placeholder="搜索网络…" />
      </div>
      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>

      <div class="overflow-x-auto border border-zinc-800">
        <div class="hidden border-b border-zinc-800 text-xs text-zinc-500 sm:flex">
          <div class="min-w-0 flex-1 px-3 py-2">名称</div>
          <div class="w-28 shrink-0 px-3 py-2">驱动 / 范围</div>
          <div class="w-48 shrink-0 px-3 py-2">子网 / 网关</div>
          <div class="w-28 shrink-0 px-3 py-2">特性</div>
          <div class="w-44 shrink-0 px-3 py-2">使用容器</div>
          <div class="w-40 shrink-0 px-3 py-2 text-center">创建时间</div>
        </div>
        <div class="divide-y divide-zinc-800">
          <For each={view.visible()}>
            {(n) => (
              <div class="flex flex-col text-sm transition-colors sm:flex-row sm:items-start hover:bg-white/[0.03]">
                <div class="min-w-0 w-full px-3 py-2 sm:flex-1">
                  <div class="font-medium" title={n.Name}>{n.Name}</div>
                  <button
                    class="mt-0.5 block font-mono text-[11px] text-zinc-400 transition-colors hover:text-indigo-400"
                    title="查看 inspect"
                    onClick={() => setInspectFor(n)}
                  >{n.Id.slice(0, 12)}</button>
                  <div class="mt-1 flex items-center gap-0.5">
                    <IBtn title="inspect" onClick={() => setInspectFor(n)}>
                      <Ico path="M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM21 21l-4.35-4.35" />
                    </IBtn>
                    <Show when={hasRole("operator")}>
                      <IBtn title="删除" danger onClick={() => remove(n.Id, n.Name)}>
                        ⊖
                      </IBtn>
                    </Show>
                  </div>
                </div>
                <div class="w-full border-t border-zinc-800/60 px-3 py-2 text-xs text-zinc-400 sm:w-28 sm:shrink-0 sm:border-t-0">
                  <div>{n.Driver}</div>
                  <Show when={n.Scope}><div class="text-zinc-500">{n.Scope}</div></Show>
                </div>
                <div class="w-full min-w-0 border-t border-zinc-800/60 px-3 py-2 text-xs text-zinc-400 sm:w-48 sm:shrink-0 sm:border-t-0">
                  <Show when={ipamRanges(n).length > 0} fallback={<span class="text-zinc-600">—</span>}>
                    <div class="flex flex-col gap-0.5 font-mono">
                      <For each={ipamRanges(n)}>
                        {(c) => (
                          <div class="truncate" title={`${c.Subnet ?? ""}${c.Gateway ? ` → ${c.Gateway}` : ""}`}>
                            <span>{c.Subnet ?? ""}</span>
                            <Show when={c.Gateway}><span class="text-zinc-600"> → {c.Gateway}</span></Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
                <div class="w-full border-t border-zinc-800/60 px-3 py-2 sm:w-28 sm:shrink-0 sm:border-t-0">
                  <div class="flex flex-wrap gap-1">
                    <Show when={n.Internal}><span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">internal</span></Show>
                    <Show when={n.Attachable}><span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">attachable</span></Show>
                    <Show when={n.EnableIPv6}><span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">IPv6</span></Show>
                    <Show when={!n.Internal && !n.Attachable && !n.EnableIPv6}><span class="text-xs text-zinc-600">—</span></Show>
                  </div>
                </div>
                <div class="w-full border-t border-zinc-800/60 px-3 py-2 sm:w-44 sm:shrink-0 sm:border-t-0">
                  <Show when={(n.UsedBy?.length ?? 0) > 0} fallback={<span class="text-xs text-zinc-500">—</span>}>
                    <div class="flex flex-wrap gap-x-1.5 gap-y-0.5">
                      <For each={n.UsedBy}>
                        {(c) => (
                          <a
                            href={`/containers/${c.Id}`}
                            class="text-xs text-indigo-400 hover:text-indigo-300 hover:underline transition-colors"
                            onClick={(e) => { e.preventDefault(); navigate(`/containers/${c.Id}`, { replace: true }); }}
                          >
                            {c.Name || c.Id.slice(0, 8)}
                          </a>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
                <div class="w-full border-t border-zinc-800/60 px-3 py-2 text-left text-xs text-zinc-400 sm:w-40 sm:shrink-0 sm:border-t-0 sm:text-center">{fmtDate(n.Created)}</div>
              </div>
            )}
          </For>
          <LoadMore when={view.hasMore()} onMore={view.loadMore} />
        </div>
        <Show when={view.filtered().length === 0 && !store.error()}>
          <div class="py-16 text-center text-zinc-400">
            {store.items().length === 0 ? "暂无网络" : "无匹配结果"}
          </div>
        </Show>
      </div>

      <Modal open={show()} onClose={() => setShow(false)} title="创建网络">
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="名称" value={form().name} onInput={(e) => set("name", e.currentTarget.value)} />
        <select class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" value={form().driver} onChange={(e) => set("driver", e.currentTarget.value)}>
          <option value="bridge">bridge</option>
          <option value="macvlan">macvlan</option>
          <option value="ipvlan">ipvlan</option>
        </select>
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="子网 192.168.1.0/24 (可选)" value={form().subnet} onInput={(e) => set("subnet", e.currentTarget.value)} />
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="网关 192.168.1.1 (可选)" value={form().gateway} onInput={(e) => set("gateway", e.currentTarget.value)} />
        <Show when={needsParent()}>
          <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="父接口 eth0" value={form().parent} onInput={(e) => set("parent", e.currentTarget.value)} />
        </Show>
        <div class="flex justify-end gap-2">
          <Button onClick={() => setShow(false)}>取消</Button>
          <Button variant="primary" onClick={create}>创建</Button>
        </div>
      </Modal>

      <Modal open={!!inspectFor()} onClose={() => setInspectFor(null)} title={`Inspect · ${inspectFor()?.Name ?? ""}`} wide>
        <Show when={!inspectData.loading} fallback={<p class="text-xs text-zinc-500">加载中…</p>}>
          <pre class="max-h-[70vh] overflow-auto bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-400">
            {JSON.stringify(inspectData(), null, 2)}
          </pre>
        </Show>
      </Modal>
    </div>
  );
};
