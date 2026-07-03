import { Component, createSignal, createResource, createEffect, Show, For, onMount, onCleanup } from "solid-js";
import { Modal } from "../shared/Modal";
import { PullStatusWidget } from "../shared/PullStatusWidget";
import { Button } from "../shared/Button";
import { RunComposeEditor } from "../shared/RunComposeEditor";
import { get, post, del, imageInspectUrl } from "../../api/client";
import { toast } from "../shared/Toast";
import { emptyForm, formToPayload, formToRunCmd, parseRunIntoForm, type CreateForm } from "./containerForm";
import { inspectToRunCmd } from "../../api/inspect";
import type { ImageSummary, NetworkSummary, ContainerSummary, Template } from "../../types";

type Tab = "form" | "cmd";

const RESTART_OPTS = [
  { value: "", label: "不重启" },
  { value: "always", label: "always" },
  { value: "unless-stopped", label: "unless-stopped" },
  { value: "on-failure", label: "on-failure" },
];

const PULL_OPTS = [
  { value: "", label: "默认" },
  { value: "always", label: "always" },
  { value: "missing", label: "missing" },
  { value: "never", label: "never" },
];

const LOG_DRIVERS = ["", "json-file", "local", "syslog", "journald", "gelf", "fluentd", "awslogs", "splunk", "none"];

const CAP_LIST = [
  "NET_ADMIN", "NET_RAW", "NET_BIND_SERVICE",
  "SYS_ADMIN", "SYS_PTRACE", "SYS_TIME", "SYS_CHROOT",
  "DAC_OVERRIDE", "DAC_READ_SEARCH",
  "CHOWN", "FOWNER", "SETUID", "SETGID", "SETFCAP",
  "KILL", "IPC_LOCK", "MKNOD", "AUDIT_WRITE",
];

// Pre-load images immediately (not gated on modal open)
const [allImages] = createResource(() => get<ImageSummary[]>("/api/images"));

// Auto-resize textarea to fit its content
function autoH(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export const CreateContainerModal: Component<{
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  // When set, jumps to CMD tab with this run command pre-loaded and hides the source selection row.
  initialRun?: string;
}> = (props) => {
  const DEFAULT_RUN = "docker run -d --name my-container nginx:latest";
  const [tab, setTab] = createSignal<Tab>(props.initialRun ? "cmd" : "form");
  const [form, setForm] = createSignal<CreateForm>(emptyForm());
  const [runCmd, setRunCmd] = createSignal(props.initialRun ?? DEFAULT_RUN);
  const [liveRun, setLiveRun] = createSignal(runCmd());
  const [savingTpl, setSavingTpl] = createSignal(false);
  const [tplName, setTplName] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [createTitle, setCreateTitle] = createSignal("");
  const [createBody, setCreateBody] = createSignal<unknown>(undefined);

  // Keep select boxes on the user's choice (not auto-reset)
  const [selectedTplId, setSelectedTplId] = createSignal("");
  const [selectedContainerId, setSelectedContainerId] = createSignal("");

  // Sync state whenever the modal opens (or initialRun changes while already
  // open — e.g. clicking Run/Compose on a different container). The modal
  // stays mounted across opens now (so PullStatusWidget survives past
  // onClose), so this can no longer rely on remount-time signal init.
  createEffect(() => {
    if (!props.open) return;
    if (props.initialRun) {
      setRunCmd(props.initialRun);
      setLiveRun(props.initialRun);
      setTab("cmd");
      return;
    }
    setForm(emptyForm());
    setRunCmd(DEFAULT_RUN);
    setLiveRun(DEFAULT_RUN);
    setTab("form");
    setSelectedTplId("");
    setSelectedContainerId("");
    setSavingTpl(false);
    setTplName("");
  });

  // Cap dropdowns (Add + Drop share same close listener)
  const [capAddOpen, setCapAddOpen] = createSignal(false);
  const [capDropOpen, setCapDropOpen] = createSignal(false);
  let capAddRef!: HTMLDivElement;
  let capDropRef!: HTMLDivElement;
  onMount(() => {
    const close = (e: MouseEvent) => {
      if (!capAddRef?.contains(e.target as Node)) setCapAddOpen(false);
      if (!capDropRef?.contains(e.target as Node)) setCapDropOpen(false);
    };
    document.addEventListener("mousedown", close);
    onCleanup(() => document.removeEventListener("mousedown", close));
  });

  const set = <K extends keyof CreateForm>(k: K, v: CreateForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const [networks] = createResource(
    () => props.open,
    (open) => open ? get<NetworkSummary[]>("/api/networks") : Promise.resolve([]),
  );
  const [containers] = createResource(
    () => props.open,
    (open) => open ? get<ContainerSummary[]>("/api/containers") : Promise.resolve([]),
  );
  const [templates, { refetch: refetchTpls }] = createResource(
    () => props.open,
    (open) => open ? get<Template[]>("/api/templates") : Promise.resolve([]),
  );

  const imageOptions = () =>
    (allImages() ?? []).flatMap((img) => img.RepoTags ?? []).filter(Boolean);
  const networkOptions = () => [
    { value: "", label: "默认 (bridge)" },
    { value: "host", label: "host" },
    { value: "none", label: "none" },
    ...(networks() ?? []).map((n) => ({ value: n.Name, label: n.Name })),
  ];

  const switchTab = (newTab: Tab) => {
    if (newTab === "cmd" && tab() === "form") {
      setRunCmd(formToRunCmd(form()));
    } else if (newTab === "form" && tab() === "cmd") {
      const run = liveRun() || runCmd();
      const partial = parseRunIntoForm(run);
      if (Object.keys(partial).length > 0) setForm((f) => ({ ...f, ...partial }));
    }
    setTab(newTab);
  };

  // Creation streams progress via PullStatusWidget (non-blocking), so close
  // this form immediately and hand off to the floating widget below.
  const submit = () => {
    if (!form().image.trim()) { toast.error("请填写镜像名称"); return; }
    setCreateTitle(`创建 ${form().name || form().image}`);
    setCreateBody(formToPayload(form()));
    setCreating(true);
    setForm(emptyForm());
    setSelectedTplId("");
    setSelectedContainerId("");
    props.onClose();
  };

  const loadTemplate = (cmd: string) => {
    setRunCmd(cmd);
    setLiveRun(cmd);
    const partial = parseRunIntoForm(cmd);
    setForm((f) => ({ ...f, ...partial }));
    toast.success("模板已加载");
  };

  const loadFromContainer = async (id: string) => {
    if (!id) return;
    try {
      const containerInspect: Record<string, unknown> = await get(`/api/containers/${id}/inspect`);
      const imageId = (containerInspect?.Image as string) ?? "";
      let imageInspect = {};
      if (imageId) {
        try { imageInspect = await get(imageInspectUrl(imageId)); } catch { /* non-fatal */ }
      }
      const cmd = inspectToRunCmd(containerInspect, imageInspect);
      // Same as "查看Run命令": show clean command in CMD tab, don't auto-parse into form
      setRunCmd(cmd);
      setLiveRun(cmd);
      setTab("cmd");
      toast.success("已加载 Run 命令，确认后点击创建");
    } catch (e) {
      toast.error("读取容器信息失败: " + (e as Error).message);
    }
  };

  const getCurrentRun = () =>
    tab() === "cmd" ? (liveRun() || runCmd()) : formToRunCmd(form());

  const saveTemplate = async () => {
    const name = tplName().trim();
    if (!name) return;
    try {
      await post("/api/templates", { name, cmd: getCurrentRun() });
      toast.success(`模板 "${name}" 已保存`);
      setTplName("");
      setSavingTpl(false);
      refetchTpls();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const deleteTemplate = async (id: string) => {
    try {
      await del(`/api/templates/${id}`);
      refetchTpls();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const toggleCap = (k: "cap_add" | "cap_drop", cap: string) => {
    const caps = form()[k].split(",").map((c) => c.trim()).filter(Boolean);
    const idx = caps.indexOf(cap);
    if (idx >= 0) caps.splice(idx, 1); else caps.push(cap);
    set(k, caps.join(","));
  };
  const activeCaps = (k: "cap_add" | "cap_drop") =>
    form()[k].split(",").map((c) => c.trim()).filter(Boolean);

  // ── Field helpers ──────────────────────────────────────────────────────────
  const fieldCls = "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500 transition-colors";
  const selCls = `${fieldCls} appearance-none pr-8`;
  const selArrow = <span class="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-zinc-500">▾</span>;

  const inp = (label: string, k: keyof CreateForm, ph = "", tip?: string) => (
    <label class="block">
      <span class="mb-1 block text-xs text-zinc-500 cursor-help" title={tip}>{label}</span>
      <input class={fieldCls} placeholder={ph}
        value={form()[k] as string}
        onInput={(e) => set(k, e.currentTarget.value as never)} />
    </label>
  );

  const ta = (label: string, k: keyof CreateForm, ph = "", tip?: string) => (
    <label class="block">
      <span class="mb-1 block text-xs text-zinc-500 cursor-help" title={tip}>{label}</span>
      <textarea
        rows={2}
        class={`${fieldCls} resize-none overflow-hidden font-mono text-xs`}
        placeholder={ph}
        value={form()[k] as string}
        ref={(el) => setTimeout(() => autoH(el), 0)}
        onInput={(e) => { set(k, e.currentTarget.value as never); autoH(e.currentTarget); }}
      />
    </label>
  );

  const sel = (label: string, k: keyof CreateForm, opts: { value: string; label: string }[], tip?: string) => (
    <label class="block">
      <span class="mb-1 block text-xs text-zinc-500 cursor-help" title={tip}>{label}</span>
      <div class="relative">
        <select class={selCls} value={form()[k] as string}
          onChange={(e) => set(k, e.currentTarget.value as never)}>
          <For each={opts}>{(o) => <option value={o.value}>{o.label}</option>}</For>
        </select>
        {selArrow}
      </div>
    </label>
  );

  const rg = (label: string, k: keyof CreateForm, opts: { value: string; label: string }[], tip?: string) => (
    <div>
      <span class="mb-1 block text-xs text-zinc-500 cursor-help" title={tip}>{label}</span>
      <div class="flex flex-wrap gap-1">
        <For each={opts}>
          {(o) => (
            <button type="button"
              class={`px-2 py-1 text-xs transition-colors ${
                form()[k] === o.value
                  ? "bg-indigo-600 text-white"
                  : "border border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-200"
              }`}
              onClick={() => set(k, o.value as never)}
            >{o.label}</button>
          )}
        </For>
      </div>
    </div>
  );

  const tog = (label: string, k: "privileged" | "readonly_rootfs" | "publish_all" | "interactive" | "tty" | "auto_remove" | "init" | "no_healthcheck", warn = false) => (
    <button type="button"
      class={`px-2 py-1 text-xs transition-colors ${
        form()[k]
          ? warn ? "bg-amber-600 text-white" : "bg-indigo-600 text-white"
          : "border border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-200"
      }`}
      onClick={() => set(k, !form()[k] as never)}
    >{label}</button>
  );

  const SectionLabel = (p: { children: string }) => (
    <p class="text-xs text-zinc-400 mt-1">{p.children}</p>
  );

  return (
    <>
    <Modal open={props.open} onClose={props.onClose} title="新建容器" wide noBackdropClose>

      {/* ── Quick selectors ────────────────────────────────────────────────── */}
      <div class={`mb-3 flex flex-wrap gap-2${props.initialRun ? " hidden" : ""}`}>
        {/* Template select — stays on selection */}
        <div class="flex flex-1 items-center gap-1 min-w-0">
          <div class="relative flex-1 min-w-0">
          <select
            class="w-full appearance-none border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 pr-8 text-sm text-zinc-300 outline-none"
            value={selectedTplId()}
            onChange={(e) => {
              const id = e.currentTarget.value;
              setSelectedTplId(id);
              const tpl = (templates() ?? []).find((t) => t.id === id);
              if (tpl) loadTemplate(tpl.cmd);
            }}
          >
            <option value="">选择模板…</option>
            <For each={templates() ?? []}>
              {(t) => <option value={t.id}>{t.name}</option>}
            </For>
          </select>
          <span class="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-zinc-500">▾</span>
          </div>
          <Show when={(templates() ?? []).length > 0}>
            <details class="relative shrink-0">
              <summary class="cursor-pointer border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-500 hover:text-zinc-200 list-none">
                管理
              </summary>
              <div class="absolute right-0 z-10 mt-1 w-52 border border-zinc-700 bg-zinc-950 p-2 shadow-2xl">
                <For each={templates() ?? []}>
                  {(t) => (
                    <div class="flex items-center justify-between py-1 text-xs">
                      <span class="truncate text-zinc-300">{t.name}</span>
                      <button class="ml-2 shrink-0 text-red-400 hover:text-red-300"
                        onClick={() => void deleteTemplate(t.id)}>删除</button>
                    </div>
                  )}
                </For>
              </div>
            </details>
          </Show>
        </div>

        {/* Container clone select — stays on selection */}
        <div class="relative flex-1 min-w-0">
          <select
            class="w-full appearance-none border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 pr-8 text-sm text-zinc-300 outline-none"
            value={selectedContainerId()}
            onChange={(e) => {
              const id = e.currentTarget.value;
              setSelectedContainerId(id);
              if (id) void loadFromContainer(id);
            }}
          >
            <option value="">从现有容器复制…</option>
            <For each={containers() ?? []}>
              {(c) => (
                <option value={c.Id}>
                  {(c.Names[0] ?? "").replace(/^\//, "")} — {c.Image}
                </option>
              )}
            </For>
          </select>
          <span class="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-zinc-500">▾</span>
        </div>
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <div class="mb-4 flex border-b border-zinc-800">
        {(["form", "cmd"] as Tab[]).map((t) => (
          <button
            class={`px-4 py-2 text-sm font-medium transition-colors ${
              tab() === t
                ? "border-b-2 border-blue-500 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
            onClick={() => switchTab(t)}
          >
            {t === "form" ? "表单" : "命令行 / Compose"}
          </button>
        ))}
      </div>

      {/* ── Save template bar ─────────────────────────────────────────────── */}
      <Show when={savingTpl()}>
        <div class="mb-3 flex items-center gap-2 border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800/40">
          <span class="text-xs text-zinc-400">模板名称：</span>
          <input
            class="flex-1 border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none"
            placeholder="my-nginx"
            value={tplName()}
            onInput={(e) => setTplName(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void saveTemplate(); if (e.key === "Escape") setSavingTpl(false); }}
            ref={(el) => setTimeout(() => el?.focus(), 50)}
          />
          <Button variant="primary" onClick={() => void saveTemplate()}>保存</Button>
          <Button onClick={() => setSavingTpl(false)}>取消</Button>
        </div>
      </Show>

      {/* ══ FORM TAB ══════════════════════════════════════════════════════════ */}
      <Show when={tab() === "form"}>
        <div class="space-y-4">

          {/* 基本 */}
          <SectionLabel>基本</SectionLabel>
          <div class="grid grid-cols-2 gap-3">
            {inp("容器名称", "name", "my-container", "容器的唯一标识名称，对应 --name")}
            <label class="block">
              <span class="mb-1 block text-xs text-zinc-500 cursor-help" title="容器使用的 Docker 镜像，格式：名称:标签，如 nginx:latest">镜像</span>
              <input
                list="phyless-image-list"
                class={fieldCls}
                placeholder="nginx:latest"
                value={form().image}
                onInput={(e) => set("image", e.currentTarget.value)}
              />
              <datalist id="phyless-image-list">
                <For each={imageOptions()}>{(tag) => <option value={tag} />}</For>
              </datalist>
            </label>
          </div>
          <div class="grid grid-cols-2 gap-3">
            {rg("重启策略", "restart_policy", RESTART_OPTS, "容器退出后的重启行为：no/always/unless-stopped/on-failure")}
            {rg("拉取策略", "pull_policy", PULL_OPTS, "创建前是否拉取最新镜像：always/missing/never")}
          </div>
          <div>
            <span class="mb-1 block text-xs text-zinc-500 cursor-help" title="额外的运行时标志，控制 stdin/tty/权限等行为">运行标志</span>
            <div class="flex flex-wrap gap-1">
              {tog("-i 交互", "interactive")}
              {tog("-t TTY", "tty")}
              {tog("--rm 退出删除", "auto_remove")}
              {tog("--init 信号代理", "init")}
              {tog("禁用健康检查", "no_healthcheck")}
              {tog("-P 暴露端口", "publish_all")}
              {tog("--read-only 只读", "readonly_rootfs")}
              {tog("--privileged 特权", "privileged", true)}
            </div>
          </div>
          {ta("启动命令 (逗号分隔参数)", "cmd", "nginx,-g,daemon off;", "覆盖镜像默认 CMD，多个参数用逗号分隔")}

          {/* 网络 & 端口 */}
          <SectionLabel>网络 & 端口</SectionLabel>
          <div class="grid grid-cols-2 gap-3">
            {sel("网络", "network_mode", networkOptions(), "容器网络模式：bridge/host/none 或自定义网络名")}
            {ta("端口映射 (-p)", "ports", "8080:80\n443:443/tcp", "宿主机端口:容器端口，每行一条。格式：[IP:]主机端口:容器端口[/协议]")}
          </div>
          {/* 存储 & 环境 */}
          <SectionLabel>存储 & 环境</SectionLabel>
          <div class="grid grid-cols-2 gap-3">
            {ta("挂载 (-v)", "binds", "/data:/data\n/etc/localtime:/etc/localtime:ro", "主机路径:容器路径[:mode]，每行一条。mode 可为 ro/rw/z/Z 等")}
            {ta("环境变量 (-e)", "env", "TZ=Asia/Shanghai\nDEBUG=false", "KEY=value 格式，每行一条，对应 -e 参数")}
          </div>

          {/* 高级 */}
          <details>
            <summary class="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300 select-none py-1">
              高级选项
            </summary>
            <div class="mt-3 space-y-3">
              <div class="grid grid-cols-2 gap-3">
                {inp("用户 (-u)", "user", "1000 或 www-data", "运行容器进程的用户/UID，对应 -u。如 1000、www-data、1000:1000")}
                {inp("主机名", "hostname", "留空使用容器 ID", "容器的主机名，对应 -h。留空时 Docker 用容器 ID 前 12 位")}
              </div>
              {inp("工作目录", "working_dir", "/app", "容器进程的初始工作目录，对应 -w / --workdir")}
              <div class="grid grid-cols-2 gap-3">
                {ta("DNS (--dns)", "dns", "8.8.8.8\n1.1.1.1", "自定义 DNS 服务器，每行一条，对应 --dns")}
                {ta("设备 (--device)", "devices", "/dev/snd:/dev/snd", "映射宿主机设备到容器，格式：/dev/host:/dev/container[:权限]，对应 --device")}
              </div>
              <div class="grid grid-cols-2 gap-3">
                {ta("tmpfs (--tmpfs)", "tmpfs", "/run:size=64m\n/tmp", "在内存中挂载 tmpfs，格式：/路径[:选项]，如 /run:size=64m,uid=1000")}
                {ta("Sysctls", "sysctls", "net.core.somaxconn=1024", "内核参数，格式：key=value，每行一条。对应 --sysctl")}
              </div>

              {/* Cap Add + Cap Drop — single-row combo: text input + dropdown picker */}
              <div class="grid grid-cols-2 gap-3">
                {/* Cap Add */}
                <div>
                  <span class="mb-1 block text-xs text-zinc-500 cursor-help" title="添加 Linux Capabilities，逗号分隔。如 NET_ADMIN,SYS_PTRACE。点击 ▾ 可选择">Cap Add (--cap-add)</span>
                  <div class="relative" ref={capAddRef!}>
                    <div class="flex">
                      <input
                        class="flex-1 min-w-0 border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs font-mono outline-none transition-colors"
                        placeholder="NET_ADMIN,SYS_PTRACE,…"
                        value={form().cap_add}
                        onInput={(e) => set("cap_add", e.currentTarget.value)}
                      />
                      <button
                        type="button"
                        class="shrink-0 border border-l-0 border-zinc-700 bg-zinc-800 px-2 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
                        onClick={() => setCapAddOpen((v) => !v)}
                      >▾</button>
                    </div>
                    <Show when={capAddOpen()}>
                      <div class="absolute z-20 left-0 top-full mt-0.5 w-72 border border-zinc-700 bg-zinc-950 shadow-2xl p-2 flex flex-wrap gap-1 max-h-44 overflow-y-auto">
                        <For each={CAP_LIST}>
                          {(cap) => {
                            const active = () => activeCaps("cap_add").includes(cap);
                            return (
                              <button type="button" onClick={() => toggleCap("cap_add", cap)}
                                class={`px-1.5 py-0.5 text-xs font-mono transition-colors ${
                                  active() ? "bg-blue-600 text-white" : "border border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-200"
                                }`}>{cap}</button>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>

                {/* Cap Drop */}
                <div>
                  <span class="mb-1 block text-xs text-zinc-500 cursor-help" title="移除 Linux Capabilities，逗号分隔。如 NET_RAW,SETUID。点击 ▾ 可选择">Cap Drop (--cap-drop)</span>
                  <div class="relative" ref={capDropRef!}>
                    <div class="flex">
                      <input
                        class="flex-1 min-w-0 border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs font-mono outline-none transition-colors"
                        placeholder="ALL"
                        value={form().cap_drop}
                        onInput={(e) => set("cap_drop", e.currentTarget.value)}
                      />
                      <button
                        type="button"
                        class="shrink-0 border border-l-0 border-zinc-700 bg-zinc-800 px-2 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
                        onClick={() => setCapDropOpen((v) => !v)}
                      >▾</button>
                    </div>
                    <Show when={capDropOpen()}>
                      <div class="absolute z-20 right-0 top-full mt-0.5 w-72 border border-zinc-700 bg-zinc-900 shadow-2xl p-2 flex flex-wrap gap-1 max-h-44 overflow-y-auto">
                        <For each={CAP_LIST}>
                          {(cap) => {
                            const active = () => activeCaps("cap_drop").includes(cap);
                            return (
                              <button type="button" onClick={() => toggleCap("cap_drop", cap)}
                                class={`px-1.5 py-0.5 text-xs font-mono transition-colors ${
                                  active() ? "bg-red-700 text-white" : "border border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-200"
                                }`}>{cap}</button>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-3">
                {ta("标签 (--label)", "labels", "team=infra\nenv=prod", "容器元数据标签，格式：key=value，每行一条，对应 --label")}
              </div>
              <div class="grid grid-cols-3 gap-3">
                {inp("内存上限 (MB)", "memory", "256", "容器可使用的最大内存（MB）。超出后进程会被 OOM 强制终止")}
                {inp("内存+Swap (MB)", "memory_swap", "512 或 -1", "内存+Swap 合计上限（MB），需大于内存上限。留空=默认(2×内存)，设 -1 表示 Swap 无限")}
                {inp("CPU 权重", "cpu_shares", "1024", "相对 CPU 权重，默认 1024。多容器竞争时，权重越高分得越多 CPU 时间")}
              </div>
              <div class="grid grid-cols-2 gap-3">
                {inp("CPU Quota (μs)", "cpu_quota", "50000", "每个调度周期内容器最多使用的 CPU 时间（微秒）。如 50000 / 100000 Period = 50% CPU")}
                {inp("CPU Period (μs)", "cpu_period", "100000", "CPU 调度周期长度（微秒），默认 100000（100ms）。通常无需修改")}
              </div>
              <div class="grid grid-cols-2 gap-3">
                <label class="block">
                  <span class="mb-1 block text-xs text-zinc-500 cursor-help" title="日志收集驱动，默认 json-file。修改后需重建容器才生效">日志驱动 (--log-driver)</span>
                  <div class="relative">
                    <select class={selCls} value={form().log_driver}
                      onChange={(e) => set("log_driver", e.currentTarget.value)}>
                      <For each={LOG_DRIVERS}>{(d) => <option value={d}>{d || "默认 (json-file)"}</option>}</For>
                    </select>
                    {selArrow}
                  </div>
                </label>
                {ta("日志选项 (--log-opt)", "log_opts", "max-size=10m\nmax-file=3")}
              </div>
            </div>
          </details>
        </div>

        {/* Form footer */}
        <div class="mt-5 flex items-center justify-end gap-2 border-t border-zinc-800 pt-4">
          <Button onClick={() => setSavingTpl(true)}>存为模版</Button>
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" onClick={submit}>创建容器</Button>
        </div>
      </Show>

      {/* ══ CMD TAB ═══════════════════════════════════════════════════════════ */}
      <Show when={tab() === "cmd"}>
        <div class="flex flex-col" style={{ height: "65vh" }}>
          <div class="flex-1 min-h-0">
            <RunComposeEditor
              initialRun={runCmd()}
              actions={(s) => {
                setLiveRun(s.run);
                return (
                  <div class="flex flex-wrap items-center justify-end gap-2">
                    <Button onClick={() => setRunCmd(DEFAULT_RUN)}>清空</Button>
                    <Button onClick={() => { void navigator.clipboard.writeText(s.run); toast.success("已复制"); }}>复制命令</Button>
                  </div>
                );
              }}
            />
          </div>
          <div class="mt-3 flex justify-end gap-2 border-t border-zinc-800 pt-3">
            <Button onClick={() => setSavingTpl(true)}>存为模版</Button>
            <Button onClick={props.onClose}>取消</Button>
            <Button
              variant="primary"
              onClick={() => {
                const partial = parseRunIntoForm(liveRun() || runCmd());
                if (!partial.image) { toast.error("无法识别镜像名称"); return; }
                setForm((f) => ({ ...f, ...partial }));
                void submit();
              }}
            >创建容器</Button>
          </div>
        </div>
      </Show>
    </Modal>
    <PullStatusWidget
      active={creating()}
      onClose={() => setCreating(false)}
      title={createTitle()}
      url="/api/containers"
      body={createBody()}
      onDone={() => { setCreating(false); props.onCreated(); }}
    />
    </>
  );
};
