import { type Component, createEffect, createResource, createSignal, createUniqueId, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { get, request } from "../../api/client";
import { registryCredsHost } from "../../api/registryPull";
import { verifyRegistryCreds } from "../../api/registrySearch";
import { newAccountId, validWorkerUrl } from "../../stores/browserPullSettings";
import { queued } from "../../stores/taskQueue";
import type { Registry } from "../../types";
import { Ico } from "./ActionButton";
import { confirmAction } from "./ConfirmModal";
import { browserAccount, type CredEntry, persistBrowserAccounts, type PullOptionsState } from "./PullOptions";

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
type Draft = { host: string; username: string; secret: string };

const inputCls = "w-full min-w-0 border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs outline-none transition-colors focus:border-indigo-500";
const hostOf = (r: Registry) => registryCredsHost(r.url) || r.url;
const errorText = (e: unknown, fallback: string) => e instanceof Error ? e.message : fallback;

/** Inline add/edit form. Typing stays in local signals, so the list never re-renders mid-edit. */
export const AccountEditor: Component<{
  initial: Draft;
  isNew: boolean;
  /** Editing a server account: a blank password keeps the stored one. */
  keepSecretHint?: boolean;
  onSave: (draft: Draft) => string | Promise<string>;
  onCancel: () => void;
}> = (props) => {
  const [host, setHost] = createSignal(props.initial.host);
  const [username, setUsername] = createSignal(props.initial.username);
  const [secret, setSecret] = createSignal(props.initial.secret);
  const [error, setError] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const listId = createUniqueId();
  const save = async () => {
    if (saving()) return;
    setSaving(true);
    try { setError(await props.onSave({ host: host(), username: username().trim(), secret: secret() })); } finally { setSaving(false); }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); void save(); }
    if (e.key === "Escape") { e.stopPropagation(); props.onCancel(); }
  };
  return (
    <div class="space-y-2 border-t border-indigo-500/30 bg-indigo-500/5 p-2.5" onKeyDown={onKeyDown}>
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
      <Show when={registryCredsHost(host()) === "docker.io"}>
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

/** One account row inside a registry group. */
export interface PickerRow {
  key: string;
  host: string;
  username: string;
  /** Where it is saved, when a group mixes sources. */
  source?: "浏览器" | "服务端";
  status?: Status;
  /** Replaces the row while it is being edited. */
  editor?: JSX.Element;
  onVerify: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

const StatusChip: Component<{ status?: Status }> = (props) => (
  <Show when={props.status}>
    <span class={`shrink-0 rounded px-1.5 text-[10px] leading-4 ${
      props.status?.state === "ok" ? "bg-emerald-500/10 text-emerald-300" : props.status?.state === "error" ? "bg-red-500/10 text-red-300" : "bg-zinc-800 text-zinc-400"
    }`}>{props.status?.state === "ok" ? "✓ 可用" : props.status?.state === "error" ? "✗ 失败" : "验证中…"}</span>
  </Show>
);

/** Accounts grouped by registry; each registry uses one account or none. */
export const AccountPicker: Component<{
  rows: PickerRow[];
  selected: (host: string) => string;
  onSelect: (host: string, key: string) => void;
  onAdd: (host: string) => void;
  /** An add form: inside its registry's group, or below the groups. */
  adding?: { host: string; editor: JSX.Element };
}> = (props) => {
  const name = createUniqueId();
  const hosts = () => {
    const seen = [...new Set([...props.rows.map((r) => r.host), ...(props.adding?.host ? [props.adding.host] : [])])];
    const rank = (h: string) => { const i = PRESETS.indexOf(h); return i < 0 ? PRESETS.length : i; };
    return seen.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  };
  const rowCls = (on: boolean) => `flex cursor-pointer items-center gap-2 px-2.5 py-1.5 transition-colors ${on ? "bg-indigo-500/10" : "hover:bg-zinc-800/50"}`;
  return (
    <div class="space-y-2">
      <For each={hosts()}>{(host) => {
        const known = () => KNOWN[host];
        const rows = () => props.rows.filter((r) => r.host === host);
        return (
          <div class="overflow-hidden rounded-md border border-zinc-800" role="radiogroup" aria-label={`${known()?.label ?? host} 账号`}>
            <div class="flex items-center gap-2 bg-zinc-950/40 px-2.5 py-1.5">
              <span class={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] font-semibold uppercase ${known()?.cls ?? "bg-indigo-500/15 text-indigo-300"}`} aria-hidden="true">
                {(known()?.label ?? host).slice(0, 2)}
              </span>
              <span class="truncate text-xs text-zinc-200">{known()?.label ?? host}</span>
              <Show when={known()}><span class="truncate font-mono text-[10px] text-zinc-600">{host}</span></Show>
              <button type="button" class="ml-auto shrink-0 text-[11px] text-indigo-400 hover:text-indigo-300" aria-label={`为 ${host} 添加账号`} onClick={() => props.onAdd(host)}>+ 账号</button>
            </div>
            <label class={`border-t border-zinc-800/60 ${rowCls(props.selected(host) === "")}`}>
              <input type="radio" name={`${name}-${host}`} aria-label={`${host} 不使用账号`} checked={props.selected(host) === ""} onChange={() => props.onSelect(host, "")} />
              <span class="text-xs text-zinc-400">不使用账号（匿名）</span>
            </label>
            <For each={rows()}>{(row) => (
              <Show when={!row.editor} fallback={row.editor}>
                <div class="border-t border-zinc-800/60">
                  <label class={rowCls(props.selected(host) === row.key)}>
                    <input
                      type="radio"
                      name={`${name}-${host}`}
                      aria-label={`使用 ${row.username} @ ${host}${row.source ? `（${row.source}）` : ""}`}
                      checked={props.selected(host) === row.key}
                      onChange={() => props.onSelect(host, row.key)}
                    />
                    <span class="min-w-0 truncate font-mono text-xs text-zinc-200" title={`${row.username} @ ${host}`}>{row.username}</span>
                    <Show when={row.source}>
                      <span class={`shrink-0 rounded px-1 text-[10px] leading-4 ${row.source === "服务端" ? "bg-indigo-500/10 text-indigo-300" : "bg-zinc-800 text-zinc-400"}`}>{row.source}</span>
                    </Show>
                    <StatusChip status={row.status} />
                    <span class="ml-auto flex shrink-0 text-zinc-500">
                      <button type="button" class="p-1 transition-colors hover:text-zinc-200 disabled:opacity-40" title="验证账号" aria-label={`验证账号 ${row.username} @ ${host}`} disabled={row.status?.state === "checking"} onClick={(e) => { e.preventDefault(); row.onVerify(); }}><Ico path={ICON_CHECK} /></button>
                      <Show when={row.onEdit}>
                        <button type="button" class="p-1 transition-colors hover:text-zinc-200" title="编辑" aria-label={`编辑账号 ${row.username} @ ${host}`} onClick={(e) => { e.preventDefault(); row.onEdit!(); }}><Ico path={ICON_EDIT} /></button>
                      </Show>
                      <Show when={row.onDelete}>
                        <button type="button" class="p-1 transition-colors hover:text-red-400" title="删除" aria-label={`删除账号 ${row.username} @ ${host}`} onClick={(e) => { e.preventDefault(); row.onDelete!(); }}><Ico path={ICON_TRASH} /></button>
                      </Show>
                    </span>
                  </label>
                  <Show when={row.status?.state === "error" && row.status?.message}>
                    <p class="break-words px-2.5 pb-1.5 pl-8 text-[11px] text-red-400">{row.status?.message}</p>
                  </Show>
                </div>
              </Show>
            )}</For>
            <Show when={props.adding?.host === host}>{props.adding!.editor}</Show>
          </div>
        );
      }}</For>
      <Show when={props.adding && !props.adding.host}>
        <div class="overflow-hidden rounded-md border border-zinc-800">{props.adding!.editor}</div>
      </Show>
    </div>
  );
};

const EmptyAccounts: Component<{ text: string; onAdd: (host: string) => void }> = (props) => (
  <div class="rounded-md border border-dashed border-zinc-700 px-3 py-3 text-center">
    <p class="text-[11px] text-zinc-500">{props.text}</p>
    <div class="mt-2 flex flex-wrap justify-center gap-3">
      <button type="button" class="text-xs text-indigo-400 hover:text-indigo-300" onClick={() => props.onAdd("docker.io")}>+ 添加 Docker Hub 账号</button>
      <button type="button" class="text-xs text-zinc-400 hover:text-zinc-200" onClick={() => props.onAdd("")}>+ 其他 registry</button>
    </div>
  </div>
);

/** Frontend-proxy accounts: ones saved in this browser plus phyless server
 *  accounts. A picked server account's secret is fetched for this pull only
 *  (memory, never localStorage). Verification goes through the Worker. */
export const FrontendAccounts: Component<{ options: PullOptionsState }> = (props) => {
  const { value, set } = props.options;
  const [registries] = createResource(() => get<Registry[]>("/api/registries").catch(() => [] as Registry[]));
  const [editing, setEditing] = createSignal("");
  const [adding, setAdding] = createSignal<string | null>(null);
  const [status, setStatus] = createStore<Record<string, Status | undefined>>({});
  const controllers = new Map<string, AbortController>();
  let root: HTMLDivElement | undefined;
  onCleanup(() => controllers.forEach((c) => c.abort()));

  const servers = () => registries() ?? [];
  const keyHost = (key: string): string => {
    const id = key.slice(2);
    if (key.startsWith("b:")) return value.creds.find((c) => c.id === id)?.host ?? "";
    const r = servers().find((x) => x.id === id);
    return r ? hostOf(r) : value.revealed[id]?.host ?? "";
  };
  const selected = (host: string) => value.browserUse.find((k) => keyHost(k) === host) ?? "";

  const reveal = async (id: string): Promise<CredEntry> => {
    const cached = value.revealed[id];
    if (cached) return cached;
    const r = await request<{ url: string; username: string; password: string }>("POST", `/api/registries/${encodeURIComponent(id)}/credentials`);
    const entry = { id, host: registryCredsHost(r.url) || r.url, username: r.username, secret: r.password };
    set("revealed", id, entry);
    return entry;
  };

  const select = (host: string, key: string) => {
    set("browserUse", (keys) => [...keys.filter((k) => keyHost(k) !== host), ...(key ? [key] : [])]);
    persistBrowserAccounts(value);
    if (key.startsWith("s:")) {
      reveal(key.slice(2)).catch((e) => {
        setStatus(key, { state: "error", message: `无法取用服务端账号：${errorText(e, "请求失败")}` });
        set("browserUse", (keys) => keys.filter((k) => k !== key));
        persistBrowserAccounts(value);
      });
    }
  };

  // Picks remembered from an earlier visit still need their server secret.
  onMount(() => {
    for (const key of value.browserUse) {
      if (!key.startsWith("s:")) continue;
      reveal(key.slice(2)).catch(() => {
        set("browserUse", (keys) => keys.filter((k) => k !== key));
        persistBrowserAccounts(value);
      });
    }
  });

  const verify = async (key: string) => {
    const workerUrl = validWorkerUrl(value.workerUrl);
    if (!workerUrl) { setStatus(key, { state: "error", message: "请先填写前端代理地址（CF worker）" }); return; }
    controllers.get(key)?.abort();
    const controller = new AbortController();
    controllers.set(key, controller);
    setStatus(key, { state: "checking" });
    try {
      const account = key.startsWith("s:") ? await reveal(key.slice(2)) : browserAccount(value, key);
      if (!account) throw new Error("账号不存在");
      await verifyRegistryCreds(workerUrl, account.host, { username: account.username, secret: account.secret }, controller.signal);
      if (!controller.signal.aborted) setStatus(key, { state: "ok" });
    } catch (e) {
      if (!controller.signal.aborted) setStatus(key, { state: "error", message: errorText(e, "验证失败") });
    }
  };

  const save = (id: string, draft: Draft): string => {
    const host = registryCredsHost(draft.host);
    if (!host) return "请输入有效的 registry 地址，如 docker.io、ghcr.io、registry.example.com:5000";
    if (!draft.username || !draft.secret) return "请填写用户名和密码 / Token";
    const entry: CredEntry = { id: id || newAccountId(), host, username: draft.username, secret: draft.secret };
    const key = `b:${entry.id}`;
    const wasUsed = value.browserUse.includes(key);
    set("creds", (list) => id ? list.map((c) => c.id === id ? entry : c) : [...list, entry]);
    // A new account, or an edited one still in use, becomes its registry's pick.
    if (!id || wasUsed) select(host, key);
    else persistBrowserAccounts(value);
    setEditing(""); setAdding(null);
    void verify(key);
    return "";
  };

  const remove = (id: string) => {
    const key = `b:${id}`;
    controllers.get(key)?.abort();
    set("browserUse", (keys) => keys.filter((k) => k !== key));
    set("creds", (list) => list.filter((c) => c.id !== id));
    setStatus(key, undefined);
    persistBrowserAccounts(value);
  };

  const startAdd = (host: string) => { setEditing(""); setAdding(host); };

  // The search panel asks for an account (e.g. Docker Hub after a 429).
  createEffect(() => {
    const host = value.addAccount;
    if (!host) return;
    set("addAccount", "");
    startAdd(host);
    setTimeout(() => root?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }), 0);
  });

  const rows = (): PickerRow[] => [
    ...value.creds.map((c): PickerRow => {
      const key = `b:${c.id}`;
      return {
        key, host: c.host, username: c.username, source: "浏览器", status: status[key],
        editor: editing() === key
          ? <AccountEditor initial={{ host: c.host, username: c.username, secret: c.secret }} isNew={false} onSave={(d) => save(c.id, d)} onCancel={() => setEditing("")} />
          : undefined,
        onVerify: () => verify(key),
        onEdit: () => { setAdding(null); setEditing(key); },
        onDelete: () => remove(c.id),
      };
    }),
    ...servers().map((r): PickerRow => {
      const key = `s:${r.id}`;
      return { key, host: hostOf(r), username: r.username, source: "服务端", status: status[key], onVerify: () => verify(key) };
    }),
  ];

  return (
    <div ref={root}>
      <div class="mb-1.5 flex items-center justify-between">
        <span class="text-xs text-zinc-500">前端代理仓库账号</span>
        <Show when={rows().length && adding() === null}>
          <button type="button" class="text-xs text-indigo-400 hover:text-indigo-300" onClick={() => startAdd("")}>+ 添加</button>
        </Show>
      </div>
      <Show when={rows().length || adding() !== null} fallback={
        <EmptyAccounts text="未添加账号：Docker Hub 将匿名访问，共享 Worker 出口 IP 的限额，容易触发 429。" onAdd={startAdd} />
      }>
        <AccountPicker
          rows={rows()}
          selected={selected}
          onSelect={select}
          onAdd={startAdd}
          adding={adding() === null ? undefined : {
            host: registryCredsHost(adding()!) || "",
            editor: <AccountEditor initial={{ host: adding()!, username: "", secret: "" }} isNew onSave={(d) => save("", d)} onCancel={() => setAdding(null)} />,
          }}
        />
        <p class="mt-1.5 text-[11px] text-zinc-600">每个 registry 选一个账号，未选则匿名。「浏览器」账号只保存在此浏览器；「服务端」账号由 phyless 保存，选用时临时取用（记入审计）、不写入浏览器，在「不使用代理 / 服务端代理」下管理。</p>
      </Show>
    </div>
  );
};

/** Server-side registry accounts (stored by phyless, shared by all users).
 *  Each registry uses one picked account or none; verification follows the
 *  pull mode: direct, or through the server proxy. */
export const ServerAccounts: Component<{ options: PullOptionsState }> = (props) => {
  const { value, set } = props.options;
  const [registries, { refetch }] = createResource(() => get<Registry[]>("/api/registries"));
  const [editing, setEditing] = createSignal("");
  const [adding, setAdding] = createSignal<string | null>(null);
  const [status, setStatus] = createStore<Record<string, Status | undefined>>({});
  const list = () => registries() ?? [];
  const byId = (id: string) => list().find((r) => r.id === id);

  const selected = (host: string) => {
    const id = value.registryIds.find((x) => { const r = byId(x); return r && hostOf(r) === host; });
    return id ? `s:${id}` : "";
  };
  const select = (host: string, key: string) =>
    set("registryIds", (ids) => [...ids.filter((x) => { const r = byId(x); return !r || hostOf(r) !== host; }), ...(key ? [key.slice(2)] : [])]);

  const verify = async (id: string) => {
    setStatus(id, { state: "checking" });
    try {
      await request("POST", `/api/registries/${encodeURIComponent(id)}/test`, value.useProxy && value.proxyUrl.trim() ? { proxy_url: value.proxyUrl.trim() } : {});
      setStatus(id, { state: "ok" });
    } catch (e) {
      setStatus(id, { state: "error", message: errorText(e, "验证失败") });
    }
  };

  const save = async (original: Registry | null, draft: Draft): Promise<string> => {
    const host = registryCredsHost(draft.host);
    if (!host) return "请输入有效的 registry 地址，如 docker.io、ghcr.io、registry.example.com:5000";
    if (!draft.username || (!original && !draft.secret)) return "请填写用户名和密码 / Token";
    const body = { url: host, username: draft.username, password: draft.secret };
    try {
      if (original) await queued(`更新仓库账号 ${host}`, "PUT", `/api/registries/${encodeURIComponent(original.id)}`, body);
      else await queued(`添加仓库账号 ${host}`, "POST", "/api/registries", body);
    } catch (e) {
      return errorText(e, "保存失败");
    }
    const before = new Set(list().map((r) => r.id));
    const next = (await refetch()) ?? [];
    const saved = original ?? next.find((r) => !before.has(r.id));
    setEditing(""); setAdding(null);
    if (saved) {
      if (!original) select(host, `s:${saved.id}`);
      void verify(saved.id);
    }
    return "";
  };

  const remove = async (r: Registry) => {
    if (!await confirmAction(`删除服务端保存的 ${hostOf(r)} 账号 ${r.username}？所有用户都将无法再使用它。`, { title: "删除仓库账号", confirmText: "删除", danger: true })) return;
    try {
      await queued(`删除仓库账号 ${hostOf(r)}`, "DELETE", `/api/registries/${encodeURIComponent(r.id)}`);
      set("registryIds", (ids) => ids.filter((x) => x !== r.id));
      setStatus(r.id, undefined);
      await refetch();
    } catch (e) {
      setStatus(r.id, { state: "error", message: errorText(e, "删除失败") });
    }
  };

  const startAdd = (host: string) => { setEditing(""); setAdding(host); };

  const rows = (): PickerRow[] => list().map((r) => ({
    key: `s:${r.id}`, host: hostOf(r), username: r.username, status: status[r.id],
    editor: editing() === r.id
      ? <AccountEditor initial={{ host: hostOf(r), username: r.username, secret: "" }} isNew={false} keepSecretHint onSave={(d) => save(r, d)} onCancel={() => setEditing("")} />
      : undefined,
    onVerify: () => verify(r.id),
    onEdit: () => { setAdding(null); setEditing(r.id); },
    onDelete: () => remove(r),
  }));

  return (
    <div>
      <div class="mb-1.5 flex items-center justify-between">
        <span class="text-xs text-zinc-500" title="保存在 phyless 服务端，所有用户共享">服务端仓库账号</span>
        <Show when={list().length && adding() === null}>
          <button type="button" class="text-xs text-indigo-400 hover:text-indigo-300" onClick={() => startAdd("")}>+ 添加</button>
        </Show>
      </div>
      <Show when={registries.error}><p class="text-[11px] text-red-400">仓库账号加载失败</p></Show>
      <Show when={list().length || adding() !== null} fallback={
        <Show when={!registries.loading && !registries.error}>
          <EmptyAccounts text="未添加账号：拉取私有镜像，或避免 Docker Hub 匿名拉取限额时需要。" onAdd={startAdd} />
        </Show>
      }>
        <AccountPicker
          rows={rows()}
          selected={selected}
          onSelect={select}
          onAdd={startAdd}
          adding={adding() === null ? undefined : {
            host: registryCredsHost(adding()!) || "",
            editor: <AccountEditor initial={{ host: adding()!, username: "", secret: "" }} isNew onSave={(d) => save(null, d)} onCancel={() => setAdding(null)} />,
          }}
        />
        <p class="mt-1.5 text-[11px] text-zinc-600">每个 registry 选一个账号用于本次拉取，未选则匿名。账号保存在 phyless 服务端，所有用户共享。</p>
      </Show>
    </div>
  );
};
