import { Component, createSignal, createResource, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { post, del, get, getToken, setToken } from "../../api/client";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import { createContainerActions, fmtContainerStatus, fmtRelTime } from "../containers/containerActions";
import { ContainerRow } from "../containers/ContainerRow";
import { ViewCmdModal } from "../containers/ViewCmdModal";
import { ConsoleModal } from "../containers/ConsoleModal";
import { composeToRuns } from "../../api/convert";
import type { ComposeProject, ContainerSummary } from "../../types";

const LABEL_PROJECT = "com.docker.compose.project";
const LABEL_CONFIG_FILES = "com.docker.compose.project.config_files";

// Mirrors the matching handleListCompose (internal/api/compose.go) does
// server-side: discovered projects match by the project label directly, but
// registered ones match by compose_file — a registered project's `name` is
// user-typed and may not equal the actual docker compose project name.
function containersOf(p: ComposeProject, all: ContainerSummary[]): ContainerSummary[] {
  if (p.discovered) return all.filter((c) => c.Labels?.[LABEL_PROJECT] === p.name);
  return all.filter((c) => c.Labels?.[LABEL_CONFIG_FILES]?.split(",")[0] === p.compose_file);
}

// The container whose status best represents the whole project's uptime —
// a running one if any, else just the first (matches what the aggregate
// running/total badge already implies).
function representative(cs: ContainerSummary[]): ContainerSummary | undefined {
  return cs.find((c) => c.State === "running") ?? cs[0];
}

type ComposeVerb = "up" | "stop" | "down" | "restart" | "pull";
const VERB_LABEL: Record<ComposeVerb, string> = { up: "Up", stop: "Stop", down: "Down", restart: "Restart", pull: "Pull" };

// Runs `docker compose <verb>` for one project and streams its plain-text
// output live — same fetch+reader pattern ComposeDetailPage uses for its own
// Up/Down/Pull/Restart buttons, just popped into a modal instead of a
// permanently-mounted pane, since the list has no dedicated output area.
const ComposeActionModal: Component<{ target: { id: string; name: string; verb: ComposeVerb } | null; onClose: () => void }> = (props) => {
  const [output, setOutput] = createSignal("");
  const [running, setRunning] = createSignal(false);
  let ctrl: AbortController | undefined;

  createEffect(() => {
    const t = props.target;
    ctrl?.abort();
    if (!t) return;
    setOutput("");
    setRunning(true);
    ctrl = new AbortController();
    const c = ctrl;
    void (async () => {
      try {
        const res = await fetch(`/api/compose/${t.verb}?id=${encodeURIComponent(t.id)}`, {
          method: "POST", headers: { Authorization: `Bearer ${getToken()}` }, signal: c.signal,
        });
        if (res.status === 401) { setToken(null); window.dispatchEvent(new CustomEvent("phyless:unauthorized")); return; }
        const reader = res.body?.getReader();
        if (!reader) return;
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          setOutput((o) => o + dec.decode(value));
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") setOutput((o) => o + "\n" + (e as Error).message);
      } finally {
        setRunning(false);
      }
    })();
  });
  onCleanup(() => ctrl?.abort());

  return (
    <Modal open={!!props.target} onClose={() => { ctrl?.abort(); props.onClose(); }} title={`${VERB_LABEL[props.target?.verb ?? "up"]} — ${props.target?.name ?? ""}`} wide>
      <pre class="h-[50vh] overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-3 font-mono text-xs">{output() || (running() ? "运行中…" : "")}</pre>
    </Modal>
  );
};

// Shows the docker-run-command view of a project's compose file — same
// conversion ComposeDetailPage's "转换视图" button does, fetched fresh since
// the list page doesn't keep any project's yaml preloaded.
const ComposeConvertModal: Component<{ project: ComposeProject | null; onClose: () => void }> = (props) => {
  const [runs] = createResource(() => props.project?.id, async (id) => {
    const yaml = await get<string>(`/api/compose/file?id=${encodeURIComponent(id)}`);
    try { return composeToRuns(yaml); } catch { return []; }
  });

  return (
    <Modal open={!!props.project} onClose={props.onClose} title={`docker run 集合 — ${props.project?.name ?? ""}`} wide>
      <div class="space-y-2">
        <For each={runs() ?? []} fallback={<p class="text-sm text-zinc-400">无法转换或无服务</p>}>
          {(r) => (
            <div class="flex items-center gap-2">
              <code class="flex-1 overflow-auto rounded bg-zinc-950 p-2 text-xs">{r}</code>
              <Button onClick={() => navigator.clipboard.writeText(r)}>复制</Button>
            </div>
          )}
        </For>
      </div>
    </Modal>
  );
};

// Compact text button matching the icon-row density used in ContainerListPage's
// bulk-action bar — a plain <Button> (px-3 py-1.5) is too wide for 5+ of these
// side by side in a list row.
const ActBtn: Component<{ title: string; onClick: () => void; children: string }> = (p) => (
  <button
    title={p.title}
    onClick={(e) => { e.stopPropagation(); p.onClick(); }}
    class="px-2 py-0.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
  >{p.children}</button>
);

export const ComposeListPage: Component = () => {
  const navigate = useNavigate();
  const store = createResourceStore<ComposeProject>("/api/compose");
  const containers = createResourceStore<ContainerSummary>("/api/containers");
  const { isP, act } = createContainerActions(containers.refresh);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [runTarget, setRunTarget] = createSignal<{ id: string; name: string } | null>(null);
  const [consoleTarget, setConsoleTarget] = createSignal<{ id: string; name: string } | null>(null);
  const [composeAction, setComposeAction] = createSignal<{ id: string; name: string; verb: ComposeVerb } | null>(null);
  const [convertProject, setConvertProject] = createSignal<ComposeProject | null>(null);
  const [show, setShow] = createSignal(false);
  const [form, setForm] = createSignal({ name: "", base_dir: "", compose_file: "", env_file: "" });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  onMount(() => { store.startPolling(); containers.startPolling(); });
  onCleanup(() => { store.stopPolling(); containers.stopPolling(); });

  const toggleExpand = (id: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const create = async () => {
    try {
      await post("/api/compose", form());
      setShow(false); setForm({ name: "", base_dir: "", compose_file: "", env_file: "" });
      await store.refresh();
    } catch (e) { toast.error((e as Error).message); }
  };
  const remove = async (id: string) => {
    try { await del(`/api/compose?id=${encodeURIComponent(id)}`); await store.refresh(); }
    catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div>
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-semibold">Compose</h1>
        <Show when={hasRole("operator")}>
          <Button variant="primary" onClick={() => setShow(true)}>注册项目</Button>
        </Show>
      </div>
      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>

      <div class="flex flex-col gap-2">
        <For each={store.items()}>
          {(p) => {
            const isOpen = () => expanded().has(p.id);
            const cs = () => containersOf(p, containers.items());
            const rep = () => representative(cs());
            return (
              <div class="border border-zinc-800">
                <div
                  class="flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-white/[0.03] transition-colors"
                  onClick={() => toggleExpand(p.id)}
                >
                  <span class={`mt-0.5 text-zinc-500 transition-transform ${isOpen() ? "rotate-90" : ""}`}>▸</span>
                  <div class="min-w-0 flex-1">
                    <div class="font-medium">{p.name}</div>
                    <div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                      <Show when={p.discovered}>
                        <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400" title="根据容器上的 compose 标签自动发现，非手动注册">自动发现</span>
                      </Show>
                      <span class={(p.running ?? 0) > 0 ? "text-emerald-400" : "text-zinc-500"}>
                        {p.total ? `${p.running ?? 0}/${p.total} 运行中` : "未部署"}
                      </span>
                      <Show when={rep()}>
                        {(r) => <span class="text-zinc-400">{fmtContainerStatus(r().State, r().Status)}{" · 创建 "}{fmtRelTime(r().Created)}</span>}
                      </Show>
                    </div>
                    <div class="mt-0.5 text-[11px] text-zinc-400">{p.base_dir} · {p.compose_file}</div>
                  </div>
                  <div class="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                    <Show when={hasRole("operator")}>
                      <ActBtn title="docker compose up -d" onClick={() => setComposeAction({ id: p.id, name: p.name, verb: "up" })}>▶ Up</ActBtn>
                      <ActBtn title="docker compose stop" onClick={() => setComposeAction({ id: p.id, name: p.name, verb: "stop" })}>■ Stop</ActBtn>
                      <ActBtn title="docker compose down（停止并移除容器、网络）" onClick={() => setComposeAction({ id: p.id, name: p.name, verb: "down" })}>⊘ Down</ActBtn>
                      <ActBtn title="docker compose restart" onClick={() => setComposeAction({ id: p.id, name: p.name, verb: "restart" })}>↺ Restart</ActBtn>
                      <ActBtn title="docker compose pull" onClick={() => setComposeAction({ id: p.id, name: p.name, verb: "pull" })}>⇩ Pull</ActBtn>
                      <span class="mx-0.5 text-zinc-600">│</span>
                    </Show>
                    <ActBtn title="查看转换出的 docker run 命令" onClick={() => setConvertProject(p)}>⧉ Run/Compose</ActBtn>
                    <Button onClick={() => navigate(`/compose/${p.id}`, { replace: true })}>详情</Button>
                    <Show when={hasRole("operator") && !p.discovered}>
                      <Button variant="danger" onClick={() => remove(p.id)}>删除</Button>
                    </Show>
                  </div>
                </div>
                <Show when={isOpen()}>
                  <div class="border-t border-zinc-800">
                    <Show when={cs().length > 0} fallback={<div class="px-8 py-3 text-xs text-zinc-500">无容器</div>}>
                      <div class="divide-y divide-zinc-800">
                        <For each={cs()}>
                          {(c) => (
                            <ContainerRow
                              c={c}
                              isP={isP}
                              act={act}
                              onViewCmd={setRunTarget}
                              onConsole={setConsoleTarget}
                            />
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
        <Show when={store.items().length === 0 && !store.error()}>
          <div class="border border-zinc-800 py-16 text-center text-zinc-400">暂无 Compose 项目</div>
        </Show>
      </div>

      <Modal open={show()} onClose={() => setShow(false)} title="注册 Compose 项目">
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="名称" value={form().name} onInput={(e) => set("name", e.currentTarget.value)} />
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="base 目录 /opt/stacks/app" value={form().base_dir} onInput={(e) => set("base_dir", e.currentTarget.value)} />
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="compose 文件 /opt/stacks/app/compose.yaml" value={form().compose_file} onInput={(e) => set("compose_file", e.currentTarget.value)} />
        <input class="mb-3 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="env 文件 (可选)" value={form().env_file} onInput={(e) => set("env_file", e.currentTarget.value)} />
        <div class="flex justify-end gap-2">
          <Button onClick={() => setShow(false)}>取消</Button>
          <Button variant="primary" onClick={create}>注册</Button>
        </div>
      </Modal>

      <ViewCmdModal target={runTarget()} onClose={() => setRunTarget(null)} />
      <ConsoleModal target={consoleTarget()} onClose={() => setConsoleTarget(null)} />
      <ComposeActionModal target={composeAction()} onClose={() => { setComposeAction(null); void store.refresh(); void containers.refresh(); }} />
      <ComposeConvertModal project={convertProject()} onClose={() => setConvertProject(null)} />
    </div>
  );
};
