import { type Component, createEffect, createResource, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { get, request } from "../../api/client";
import { registryCredsHost } from "../../api/registryPull";
import { queued } from "../../stores/taskQueue";
import type { Registry } from "../../types";
import { confirmAction } from "./ConfirmModal";
import { verifyRegistryCreds } from "../../api/registrySearch";
import { rememberCreds, validWorkerUrl } from "../../stores/browserPullSettings";
import { Ico } from "./ActionButton";
import { browserCreds, type CredEntry, type PullOptionsState } from "./PullOptions";

const KNOWN: Record<string, { label: string; cls: string }> = {
  "docker.io": { label: "Docker Hub", cls: "bg-sky-500/15 text-sky-300" },
  "ghcr.io": { label: "GitHub", cls: "bg-zinc-500/25 text-zinc-100" },
  "quay.io": { label: "Quay", cls: "bg-rose-500/15 text-rose-300" },
  "registry.gitlab.com": { label: "GitLab", cls: "bg-orange-500/15 text-orange-300" },
};
const PRESETS = Object.keys(KNOWN);
const ICON_EDIT = "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4";
const ICON_TRASH = "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3";
const ICON_CHECK = "M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4";

type Status = { state: "checking" | "ok" | "error"; message?: string };

const inputCls = "w-full min-w-0 border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs outline-none transition-colors focus:border-indigo-500";

/** Inline add/edit form. Typing stays in local signals, so the list never re-renders mid-edit. */
export const AccountEditor: Component<{
  initial: CredEntry;
  isNew: boolean;
  /** Editing a server account: a blank password keeps the stored one. */
  keepSecretHint?: boolean;
  onSave: (entry: CredEntry) => string | Promise<string>;
  onCancel: () => void;
}> = (props) => {
  const [host, setHost] = createSignal(props.initial.host);
  const [username, setUsername] = createSignal(props.initial.username);
  const [secret, setSecret] = createSignal(props.initial.secret);
  const [error, setError] = createSignal("");
  const listId = createUniqueId();
  const [saving, setSaving] = createSignal(false);
  const save = async () => {
    if (saving()) return;
    setSaving(true);
    try { setError(await props.onSave({ host: host(), username: username().trim(), secret: secret() })); } finally { setSaving(false); }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    if (e.key === "Escape") { e.stopPropagation(); props.onCancel(); }
  };
  return (
    <div class="space-y-2 rounded-md border border-indigo-500/40 bg-indigo-500/5 p-2.5" onKeyDown={onKeyDown}>
      <span class="block text-[11px] text-zinc-400">{props.isNew ? "添加仓库账号" : "编辑仓库账号"}</span>
      <input
        class={`${inputCls} font-mono ${host().trim() && !registryCredsHost(host()) ? "border-red-500/60" : ""}`}
        list={listId}
        placeholder="Registry，如 docker.io / ghcr.io"
        aria-label="Registry 地址"
        autocomplete="off"
        spellcheck={false}
        value={host()}
        onInput={(e) => setHost(e.currentTarget.value)}
      />
      <datalist id={listId}><For each={PRESETS}>{(h) => <option value={h} />}</For></datalist>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          class={inputCls}
          placeholder="用户名"
          aria-label="私有镜像用户名"
          autocomplete="off"
          value={username()}
          ref={(el) => { if (props.initial.host) setTimeout(() => el.focus(), 0); }}
          onInput={(e) => setUsername(e.currentTarget.value)}
        />
        <input
          type="password"
          class={inputCls}
          placeholder={props.keepSecretHint ? "密码 / Token（留空不修改）" : "密码 / Access Token"}
          aria-label="密码 / Token"
          autocomplete="new-password"
          value={secret()}
          onInput={(e) => setSecret(e.currentTarget.value)}
        />
      </div>
      <Show when={host().trim() === "docker.io" || registryCredsHost(host()) === "docker.io"}>
        <p class="text-[11px] text-zinc-500">推荐使用 Docker Hub Personal Access Token（只读权限即可）。</p>
      </Show>
      <Show when={error()}><p class="text-[11px] text-red-400">{error()}</p></Show>
      <div class="flex justify-end gap-2">
        <button type="button" class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200" onClick={props.onCancel}>取消</button>
        <button type="button" class="rounded bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-500 disabled:opacity-50" disabled={saving()} onClick={save}>{saving() ? "保存中…" : "保存"}</button>
      </div>
    </div>
  );
};

/** One account: registry badge, user, verification state and actions. With
 *  `select`, clicking the card toggles it for this pull (server accounts). */
export const AccountCard: Component<{
  host: string;
  username: string;
  status?: Status;
  select?: { kind: "radio" | "checkbox"; checked: boolean; onToggle: () => void };
  onVerify: () => void;
  onEdit: () => void;
  onDelete: () => void;
}> = (props) => {
  const known = () => KNOWN[props.host];
  return (
    <div class={`rounded-md border px-2.5 py-2 transition-colors ${props.select?.checked ? "border-indigo-500/60 bg-indigo-500/10" : "border-zinc-800 bg-zinc-950/40"}`}>
      <div class="flex items-center gap-2.5">
        <Show when={props.select}>
          {(sel) => (
            <input
              type={sel().kind}
              class="shrink-0"
              aria-label={`本次拉取使用 ${props.username} @ ${props.host}`}
              checked={sel().checked}
              onChange={() => sel().onToggle()}
            />
          )}
        </Show>
        <span class={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold uppercase ${known()?.cls ?? "bg-indigo-500/15 text-indigo-300"}`} aria-hidden="true">
          {(known()?.label ?? props.host).slice(0, 2)}
        </span>
        <div class={`min-w-0 flex-1 ${props.select ? "cursor-pointer" : ""}`} onClick={() => props.select?.onToggle()}>
          <div class="flex min-w-0 items-center gap-1.5">
            <span class="truncate text-xs text-zinc-200">{known()?.label ?? props.host}</span>
            <Show when={props.status}>
              <span class={`shrink-0 rounded px-1.5 text-[10px] leading-4 ${
                props.status?.state === "ok" ? "bg-emerald-500/10 text-emerald-300" : props.status?.state === "error" ? "bg-red-500/10 text-red-300" : "bg-zinc-800 text-zinc-400"
              }`}>{props.status?.state === "ok" ? "✓ 可用" : props.status?.state === "error" ? "✗ 失败" : "验证中…"}</span>
            </Show>
          </div>
          <div class="truncate font-mono text-[11px] text-zinc-500" title={`${props.username} @ ${props.host}`}>
            {known() ? `${props.username} · ${props.host}` : props.username}
          </div>
        </div>
        <div class="flex shrink-0 text-zinc-500">
          <button type="button" class="p-1 transition-colors hover:text-zinc-200 disabled:opacity-40" title="验证账号" aria-label={`验证账号 ${props.host}`} disabled={props.status?.state === "checking"} onClick={props.onVerify}><Ico path={ICON_CHECK} /></button>
          <button type="button" class="p-1 transition-colors hover:text-zinc-200" title="编辑" aria-label={`编辑账号 ${props.host}`} onClick={props.onEdit}><Ico path={ICON_EDIT} /></button>
          <button type="button" class="p-1 transition-colors hover:text-red-400" title="删除" aria-label={`删除账号 ${props.host}`} onClick={props.onDelete}><Ico path={ICON_TRASH} /></button>
        </div>
      </div>
      <Show when={props.status?.state === "error" && props.status?.message}>
        <p class="mt-1.5 break-words text-[11px] text-red-400">{props.status?.message}</p>
      </Show>
    </div>
  );
};

/** Browser-side registry accounts: one per host, verified through the Worker. */
export const RegistryAccounts: Component<{ options: PullOptionsState }> = (props) => {
  const { value, set } = props.options;
  const [editing, setEditing] = createSignal("");
  const [adding, setAdding] = createSignal<CredEntry | null>(null);
  const [status, setStatus] = createStore<Record<string, Status | undefined>>({});
  const controllers = new Map<string, AbortController>();
  let root: HTMLDivElement | undefined;
  onCleanup(() => controllers.forEach((c) => c.abort()));

  const persist = () => { if (value.rememberCreds) rememberCreds(value.workerUrl, browserCreds(value) ?? null); };

  const verify = async (entry: CredEntry) => {
    const workerUrl = validWorkerUrl(value.workerUrl);
    if (!workerUrl) { setStatus(entry.host, { state: "error", message: "请先填写前端代理地址（CF worker）" }); return; }
    controllers.get(entry.host)?.abort();
    const controller = new AbortController();
    controllers.set(entry.host, controller);
    setStatus(entry.host, { state: "checking" });
    try {
      await verifyRegistryCreds(workerUrl, entry.host, { username: entry.username, secret: entry.secret }, controller.signal);
      if (!controller.signal.aborted) setStatus(entry.host, { state: "ok" });
    } catch (e) {
      if (!controller.signal.aborted) setStatus(entry.host, { state: "error", message: e instanceof Error ? e.message : "验证失败" });
    }
  };

  const save = (original: string, draft: CredEntry): string => {
    const host = registryCredsHost(draft.host);
    if (!host) return "请输入有效的 registry 地址，如 docker.io、ghcr.io、registry.example.com:5000";
    if (!draft.username || !draft.secret) return "请填写用户名和密码 / Token";
    if (host !== original && value.creds.some((c) => c.host === host)) return `已存在 ${host} 的账号，请直接编辑`;
    const entry = { host, username: draft.username, secret: draft.secret };
    set("creds", (list) => original ? list.map((c) => c.host === original ? entry : c) : [...list, entry]);
    persist();
    setEditing(""); setAdding(null);
    void verify(entry);
    return "";
  };

  const remove = (host: string) => {
    controllers.get(host)?.abort();
    set("creds", (list) => list.filter((c) => c.host !== host));
    setStatus(host, undefined);
    persist();
  };

  const startAdd = (host = "") => { setEditing(""); setAdding({ host, username: "", secret: "" }); };

  // The search panel asks for an account (e.g. Docker Hub after a 429).
  createEffect(() => {
    const host = value.addAccount;
    if (!host) return;
    set("addAccount", "");
    const existing = value.creds.find((c) => c.host === host);
    if (existing) { setAdding(null); setEditing(host); } else startAdd(host);
    setTimeout(() => root?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }), 0);
  });

  return (
    <div ref={root}>
      <div class="mb-1.5 flex items-center justify-between">
        <span class="text-xs text-zinc-500">仓库账号<Show when={value.creds.length}>（{value.creds.length}）</Show></span>
        <Show when={value.creds.length && !adding()}>
          <button type="button" class="text-xs text-indigo-400 hover:text-indigo-300" onClick={() => startAdd()}>+ 添加</button>
        </Show>
      </div>
      <div class="space-y-1.5">
        <For each={value.creds}>{(entry) => {
          const st = () => status[entry.host];
          return (
            <Show when={editing() !== entry.host} fallback={
              <AccountEditor initial={entry} isNew={false} onSave={(d) => save(entry.host, d)} onCancel={() => setEditing("")} />
            }>
              <AccountCard
                host={entry.host}
                username={entry.username}
                status={st()}
                onVerify={() => verify(entry)}
                onEdit={() => { setAdding(null); setEditing(entry.host); }}
                onDelete={() => remove(entry.host)}
              />
            </Show>
          );
        }}</For>
        <Show when={adding()}>
          {(draft) => <AccountEditor initial={{ ...draft() }} isNew onSave={(d) => save("", d)} onCancel={() => setAdding(null)} />}
        </Show>
        <Show when={!value.creds.length && !adding()}>
          <div class="rounded-md border border-dashed border-zinc-700 px-3 py-3 text-center">
            <p class="text-[11px] text-zinc-500">未添加账号：Docker Hub 将匿名访问，共享 Worker 出口 IP 的限额，容易触发 429。</p>
            <div class="mt-2 flex flex-wrap justify-center gap-3">
              <button type="button" class="text-xs text-indigo-400 hover:text-indigo-300" onClick={() => startAdd("docker.io")}>+ 添加 Docker Hub 账号</button>
              <button type="button" class="text-xs text-zinc-400 hover:text-zinc-200" onClick={() => startAdd()}>+ 其他 registry</button>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
};

/** Server-side registry accounts (stored by phyless, shared by all users).
 *  Checked cards are the credentials this pull sends; none means anonymous.
 *  Verification follows the pull mode: direct, or through the server proxy. */
export const ServerAccounts: Component<{ options: PullOptionsState; multiple?: boolean }> = (props) => {
  const { value, set } = props.options;
  const [registries, { refetch }] = createResource(() => get<Registry[]>("/api/registries"));
  const [editing, setEditing] = createSignal("");
  const [adding, setAdding] = createSignal<CredEntry | null>(null);
  const [status, setStatus] = createStore<Record<string, Status | undefined>>({});
  const hostOf = (r: Registry) => registryCredsHost(r.url) || r.url;
  const list = () => registries() ?? [];

  const checked = (id: string) => props.multiple ? value.registryIds.includes(id) : value.registryId === id;
  const toggle = (id: string) => {
    if (props.multiple) set("registryIds", (ids) => ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id]);
    else set("registryId", value.registryId === id ? "" : id);
  };

  const verify = async (id: string) => {
    setStatus(id, { state: "checking" });
    try {
      await request("POST", `/api/registries/${encodeURIComponent(id)}/test`, value.useProxy && value.proxyUrl.trim() ? { proxy_url: value.proxyUrl.trim() } : {});
      setStatus(id, { state: "ok" });
    } catch (e) {
      setStatus(id, { state: "error", message: e instanceof Error ? e.message : "验证失败" });
    }
  };

  const save = async (original: Registry | null, draft: CredEntry): Promise<string> => {
    const host = registryCredsHost(draft.host);
    if (!host) return "请输入有效的 registry 地址，如 docker.io、ghcr.io、registry.example.com:5000";
    if (!draft.username || (!original && !draft.secret)) return "请填写用户名和密码 / Token";
    const body = { url: host, username: draft.username, password: draft.secret };
    try {
      if (original) await queued(`更新仓库账号 ${host}`, "PUT", `/api/registries/${encodeURIComponent(original.id)}`, body);
      else await queued(`添加仓库账号 ${host}`, "POST", "/api/registries", body);
    } catch (e) {
      return e instanceof Error ? e.message : "保存失败";
    }
    const before = new Set(list().map((r) => r.id));
    const next = (await refetch()) ?? [];
    const saved = original ?? next.find((r) => !before.has(r.id));
    setEditing(""); setAdding(null);
    if (saved) {
      if (!original && !checked(saved.id)) toggle(saved.id);
      void verify(saved.id);
    }
    return "";
  };

  const remove = async (r: Registry) => {
    if (!await confirmAction(`删除服务端保存的 ${hostOf(r)} 账号 ${r.username}？所有用户都将无法再使用它。`, { title: "删除仓库账号", confirmText: "删除", danger: true })) return;
    try {
      await queued(`删除仓库账号 ${hostOf(r)}`, "DELETE", `/api/registries/${encodeURIComponent(r.id)}`);
      if (checked(r.id)) toggle(r.id);
      setStatus(r.id, undefined);
      await refetch();
    } catch (e) {
      setStatus(r.id, { state: "error", message: e instanceof Error ? e.message : "删除失败" });
    }
  };

  const startAdd = (host = "") => { setEditing(""); setAdding({ host, username: "", secret: "" }); };

  return (
    <div>
      <div class="mb-1.5 flex items-center justify-between">
        <span class="text-xs text-zinc-500" title="保存在 phyless 服务端，所有用户共享">服务端仓库账号<Show when={list().length}>（{list().length}）</Show></span>
        <Show when={list().length && !adding()}>
          <button type="button" class="text-xs text-indigo-400 hover:text-indigo-300" onClick={() => startAdd()}>+ 添加</button>
        </Show>
      </div>
      <div class="space-y-1.5">
        <Show when={registries.error}><p class="text-[11px] text-red-400">仓库账号加载失败</p></Show>
        <For each={list()}>{(r) => (
          <Show when={editing() !== r.id} fallback={
            <AccountEditor initial={{ host: hostOf(r), username: r.username, secret: "" }} isNew={false} keepSecretHint onSave={(d) => save(r, d)} onCancel={() => setEditing("")} />
          }>
            <AccountCard
              host={hostOf(r)}
              username={r.username}
              status={status[r.id]}
              select={{ kind: props.multiple ? "checkbox" : "radio", checked: checked(r.id), onToggle: () => toggle(r.id) }}
              onVerify={() => verify(r.id)}
              onEdit={() => { setAdding(null); setEditing(r.id); }}
              onDelete={() => remove(r)}
            />
          </Show>
        )}</For>
        <Show when={adding()}>
          {(draft) => <AccountEditor initial={{ ...draft() }} isNew onSave={(d) => save(null, d)} onCancel={() => setAdding(null)} />}
        </Show>
        <Show when={!registries.loading && !registries.error && !list().length && !adding()}>
          <div class="rounded-md border border-dashed border-zinc-700 px-3 py-3 text-center">
            <p class="text-[11px] text-zinc-500">未添加账号：拉取私有镜像，或避免 Docker Hub 匿名拉取限额时需要。</p>
            <div class="mt-2 flex flex-wrap justify-center gap-3">
              <button type="button" class="text-xs text-indigo-400 hover:text-indigo-300" onClick={() => startAdd("docker.io")}>+ 添加 Docker Hub 账号</button>
              <button type="button" class="text-xs text-zinc-400 hover:text-zinc-200" onClick={() => startAdd()}>+ 其他 registry</button>
            </div>
          </div>
        </Show>
        <Show when={list().length}>
          <p class="text-[11px] text-zinc-600">{props.multiple ? "勾选的账号按镜像所在 registry 自动使用" : "选中的账号用于本次拉取"}，未选则匿名。账号保存在 phyless 服务端，所有用户共享。</p>
        </Show>
      </div>
    </div>
  );
};
