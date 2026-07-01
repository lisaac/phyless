import { Component, createSignal, createResource, Show, For } from "solid-js";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { RunComposeEditor } from "../shared/RunComposeEditor";
import { get, post, del } from "../../api/client";
import { toast } from "../shared/Toast";
import { emptyForm, formToPayload, parseRunIntoForm, type CreateForm } from "./containerForm";
import { inspectToRunCmd } from "../../api/inspect";
import type { ImageSummary, NetworkSummary, ContainerSummary, Template } from "../../types";

type Tab = "form" | "cmd";

const RESTART_OPTS = [
  { value: "", label: "不自动重启 (no)" },
  { value: "always", label: "always — 始终重启" },
  { value: "unless-stopped", label: "unless-stopped — 手动停止除外" },
  { value: "on-failure", label: "on-failure — 仅错误退出时重启" },
];

export const CreateContainerModal: Component<{
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}> = (props) => {
  const [tab, setTab] = createSignal<Tab>("form");
  const [form, setForm] = createSignal<CreateForm>(emptyForm());
  const [parseErr, setParseErr] = createSignal("");
  const [cmdKey, setCmdKey] = createSignal(0); // remount RunComposeEditor on template load
  const [cmdInit, setCmdInit] = createSignal("docker run -d --name web -p 8080:80 nginx:latest");
  const [savingTpl, setSavingTpl] = createSignal(false);
  const [tplName, setTplName] = createSignal("");

  const set = <K extends keyof CreateForm>(k: K, v: CreateForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Resources loaded while the modal is open
  const [images] = createResource(
    () => props.open,
    (open) => open ? get<ImageSummary[]>("/api/images") : Promise.resolve([]),
  );
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
    (images() ?? []).flatMap((img) => img.RepoTags ?? []).filter(Boolean);
  const networkOptions = () => [
    { value: "", label: "默认 (bridge)" },
    { value: "host", label: "host" },
    { value: "none", label: "none" },
    ...(networks() ?? []).map((n) => ({ value: n.Name, label: n.Name })),
  ];

  // ── Submit ──────────────────────────────────────────────────────────────────
  const submit = async () => {
    if (!form().image.trim()) { toast.error("请填写镜像名称"); return; }
    try {
      const out = await post<{ id: string }>("/api/containers", formToPayload(form()));
      toast.info(`created ${out.id.slice(0, 12)}`);
      setForm(emptyForm());
      props.onCreated();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // ── Import run command into form ─────────────────────────────────────────────
  const importFromCmd = (run: string) => {
    setParseErr("");
    const partial = parseRunIntoForm(run);
    if (!partial.image) {
      setParseErr("无法识别镜像名称，请检查命令格式");
      return;
    }
    setForm((f) => ({ ...f, ...partial }));
    setTab("form");
    toast.info("已从命令导入字段");
  };

  // ── Load template ────────────────────────────────────────────────────────────
  const loadTemplate = (cmd: string) => {
    setCmdInit(cmd);
    setCmdKey((k) => k + 1);
    setTab("cmd");
    // Also import to form immediately
    const partial = parseRunIntoForm(cmd);
    if (partial.image) setForm((f) => ({ ...f, ...partial }));
  };

  // ── From existing container ──────────────────────────────────────────────────
  const loadFromContainer = async (id: string) => {
    if (!id) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const containerInspect: any = await get(`/api/containers/${id}`);
      const imageId: string = containerInspect?.Image ?? "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let imageInspect: any = {};
      if (imageId) {
        try { imageInspect = await get(`/api/images/${encodeURIComponent(imageId)}/inspect`); }
        catch { /* non-fatal; run will just include all fields */ }
      }
      const cmd = inspectToRunCmd(containerInspect, imageInspect);
      loadTemplate(cmd);
      toast.info("已从容器生成命令");
    } catch (e) {
      toast.error("获取容器信息失败: " + (e as Error).message);
    }
  };

  // ── Save as template ─────────────────────────────────────────────────────────
  const saveTemplate = async (run: string) => {
    const name = tplName().trim() || prompt("模板名称");
    if (!name) return;
    try {
      await post("/api/templates", { name, cmd: run });
      toast.info(`模板 "${name}" 已保存`);
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

  // ── Field helpers ────────────────────────────────────────────────────────────
  const inp = (label: string, k: keyof CreateForm, ph = "") => (
    <label class="block">
      <span class="mb-0.5 block text-xs text-zinc-400">{label}</span>
      <input
        class="w-full rounded border border-zinc-800 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-blue-500"
        placeholder={ph}
        value={form()[k] as string}
        onInput={(e) => set(k, e.currentTarget.value as never)}
      />
    </label>
  );
  const ta = (label: string, k: keyof CreateForm, ph = "", rows = 3) => (
    <label class="block">
      <span class="mb-0.5 block text-xs text-zinc-400">{label}</span>
      <textarea
        rows={rows}
        class="w-full rounded border border-zinc-800 bg-zinc-800 px-2 py-1.5 font-mono text-xs outline-none focus:border-blue-500"
        placeholder={ph}
        value={form()[k] as string}
        onInput={(e) => set(k, e.currentTarget.value as never)}
      />
    </label>
  );
  const cb = (label: string, k: keyof CreateForm) => (
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" class="rounded" checked={form()[k] as boolean}
        onChange={(e) => set(k, e.currentTarget.checked as never)} />
      {label}
    </label>
  );

  return (
    <Modal open={props.open} onClose={props.onClose} title="新建容器" wide>
      {/* ── Quick selectors: template / from container ─────────────────────── */}
      <div class="mb-3 flex flex-wrap gap-2 rounded border border-zinc-800 bg-zinc-950 p-2">
        {/* Template picker */}
        <select
          class="flex-1 rounded border border-zinc-800 bg-zinc-800 px-2 py-1 text-sm outline-none"
          value=""
          onChange={(e) => { if (e.currentTarget.value) loadTemplate(e.currentTarget.value); e.currentTarget.value = ""; }}
        >
          <option value="">选择模板…</option>
          <For each={templates() ?? []}>
            {(t) => <option value={t.cmd}>{t.name}</option>}
          </For>
        </select>

        {/* From container picker */}
        <select
          class="flex-1 rounded border border-zinc-800 bg-zinc-800 px-2 py-1 text-sm outline-none"
          value=""
          onChange={(e) => { if (e.currentTarget.value) void loadFromContainer(e.currentTarget.value); e.currentTarget.value = ""; }}
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

        {/* Template management */}
        <Show when={(templates() ?? []).length > 0}>
          <details class="relative">
            <summary class="cursor-pointer rounded border border-zinc-800 px-2 py-1 text-sm text-zinc-400 hover:text-zinc-100">
              管理模板
            </summary>
            <div class="absolute right-0 z-10 mt-1 w-56 rounded border border-zinc-800 bg-zinc-900 p-2 shadow-xl">
              <For each={templates() ?? []}>
                {(t) => (
                  <div class="flex items-center justify-between py-1 text-sm">
                    <span class="truncate text-zinc-300">{t.name}</span>
                    <Button variant="danger" onClick={() => void deleteTemplate(t.id)}>删除</Button>
                  </div>
                )}
              </For>
            </div>
          </details>
        </Show>
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <div class="mb-4 flex border-b border-zinc-800">
        {(["form", "cmd"] as Tab[]).map((t) => (
          <button
            class={`px-4 py-2 text-sm font-medium transition-colors ${
              tab() === t
                ? "border-b-2 border-blue-500 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-100"
            }`}
            onClick={() => setTab(t)}
          >
            {t === "form" ? "表单" : "命令行"}
          </button>
        ))}
      </div>

      {/* ── FORM TAB ──────────────────────────────────────────────────────── */}
      <Show when={tab() === "form"}>
        <div class="space-y-3">
          <div class="grid grid-cols-2 gap-3">
            {inp("容器名称", "name", "my-container")}
            {/* Image combobox */}
            <label class="block">
              <span class="mb-0.5 block text-xs text-zinc-400">镜像</span>
              <input
                list="phyless-image-list"
                class="w-full rounded border border-zinc-800 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-blue-500"
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
            {/* Restart policy */}
            <label class="block">
              <span class="mb-0.5 block text-xs text-zinc-400">重启策略</span>
              <select
                class="w-full rounded border border-zinc-800 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-blue-500"
                value={form().restart_policy}
                onChange={(e) => set("restart_policy", e.currentTarget.value)}
              >
                <For each={RESTART_OPTS}>{(o) => <option value={o.value}>{o.label}</option>}</For>
              </select>
            </label>
            {/* Network */}
            <label class="block">
              <span class="mb-0.5 block text-xs text-zinc-400">网络</span>
              <select
                class="w-full rounded border border-zinc-800 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-blue-500"
                value={form().network_mode}
                onChange={(e) => set("network_mode", e.currentTarget.value)}
              >
                <For each={networkOptions()}>{(o) => <option value={o.value}>{o.label}</option>}</For>
              </select>
            </label>
          </div>

          <div class="grid grid-cols-2 gap-3">
            {inp("主机名 (Hostname)", "hostname", "留空使用容器 ID")}
            {inp("工作目录 (WorkingDir)", "working_dir", "/app")}
          </div>

          {ta(
            "端口映射 (每行：宿主机端口:容器端口 或 IP:宿主机端口:容器端口/协议)",
            "ports",
            "8080:80\n0.0.0.0:443:443/tcp",
            2,
          )}
          {ta("环境变量 (每行 KEY=VALUE)", "env", "TZ=Asia/Shanghai\nDEBUG=false", 2)}
          {ta("挂载 (每行：宿主机路径:容器路径[:ro])", "binds", "/data:/data\n/etc/localtime:/etc/localtime:ro", 2)}
          {ta("启动命令 (逗号分隔各参数)", "cmd", "nginx,-g,daemon off;")}

          <details class="rounded border border-zinc-800">
            <summary class="cursor-pointer px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100">
              高级选项
            </summary>
            <div class="space-y-3 p-3">
              <div class="grid grid-cols-2 gap-3">
                {inp("内存上限 (MB)", "memory", "256")}
                {inp("CPU Quota", "cpu_quota", "50000 = 50%")}
              </div>
              <div class="grid grid-cols-2 gap-3">
                {inp("CPU Period", "cpu_period", "100000")}
                {inp("Cap Add (逗号分隔)", "cap_add", "NET_ADMIN")}
              </div>
              {inp("Cap Drop (逗号分隔)", "cap_drop", "ALL")}
              {ta("Sysctls (每行 KEY=VALUE)", "sysctls", "net.core.somaxconn=1024")}
              {ta("标签 (每行 KEY=VALUE)", "labels", "team=infra\nenv=prod")}
              <div class="flex gap-4 pt-1">
                {cb("特权模式 (Privileged)", "privileged")}
                {cb("只读根文件系统", "readonly_rootfs")}
              </div>
            </div>
          </details>
        </div>

        <div class="mt-4 flex justify-end gap-2">
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" onClick={submit}>创建</Button>
        </div>
      </Show>

      {/* ── CMD TAB ───────────────────────────────────────────────────────── */}
      <Show when={tab() === "cmd"}>
        <div class="h-[52vh]">
          {/* key remounts the editor so it picks up a new initialRun */}
          <div style={{ height: "100%" }} data-key={cmdKey()}>
            <RunComposeEditor
              initialRun={cmdInit()}
              actions={(s) => (
                <div class="flex flex-wrap items-center gap-2">
                  <Show when={parseErr()}>
                    <span class="text-sm text-red-400">{parseErr()}</span>
                  </Show>

                  {/* Save as template */}
                  <Show
                    when={savingTpl()}
                    fallback={
                      <Button onClick={() => setSavingTpl(true)}>存为模板</Button>
                    }
                  >
                    <input
                      class="rounded border border-zinc-800 bg-zinc-800 px-2 py-1 text-sm outline-none"
                      placeholder="模板名称"
                      value={tplName()}
                      onInput={(e) => setTplName(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveTemplate(s.run);
                        if (e.key === "Escape") setSavingTpl(false);
                      }}
                    />
                    <Button variant="primary" onClick={() => void saveTemplate(s.run)}>保存</Button>
                    <Button onClick={() => setSavingTpl(false)}>取消</Button>
                  </Show>

                  <div class="ml-auto flex gap-2">
                    <Button onClick={() => navigator.clipboard.writeText(s.run)}>复制命令</Button>
                    <Button variant="primary" onClick={() => importFromCmd(s.run)}>
                      导入到表单 →
                    </Button>
                  </div>
                </div>
              )}
            />
          </div>
        </div>
      </Show>
    </Modal>
  );
};
