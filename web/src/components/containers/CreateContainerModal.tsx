import { Component, createSignal, createResource, Show, For } from "solid-js";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { RunComposeEditor } from "../shared/RunComposeEditor";
import { get, post } from "../../api/client";
import { toast } from "../shared/Toast";
import { emptyForm, formToPayload, parseRunIntoForm, type CreateForm } from "./containerForm";
import type { ImageSummary, NetworkSummary } from "../../types";

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

  const set = <K extends keyof CreateForm>(k: K, v: CreateForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Load images and networks when the modal is open
  const [images] = createResource(
    () => props.open,
    (open) => open ? get<ImageSummary[]>("/api/images") : Promise.resolve([]),
  );
  const [networks] = createResource(
    () => props.open,
    (open) => open ? get<NetworkSummary[]>("/api/networks") : Promise.resolve([]),
  );

  const imageOptions = () =>
    (images() ?? []).flatMap((img) => img.RepoTags ?? []).filter(Boolean);

  const networkOptions = () => [
    { value: "", label: "默认 (bridge)" },
    { value: "host", label: "host" },
    { value: "none", label: "none" },
    ...(networks() ?? []).map((n) => ({ value: n.Name, label: n.Name })),
  ];

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

  // ── Shared field helpers ────────────────────────────────────────────────────
  const inp = (
    label: string,
    k: keyof CreateForm,
    ph = "",
    extra?: { type?: string; list?: string },
  ) => (
    <label class="block">
      <span class="mb-0.5 block text-xs text-zinc-400">{label}</span>
      <input
        {...extra}
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
      <input
        type="checkbox"
        class="rounded"
        checked={form()[k] as boolean}
        onChange={(e) => set(k, e.currentTarget.checked as never)}
      />
      {label}
    </label>
  );

  return (
    <Modal open={props.open} onClose={props.onClose} title="新建容器" wide>
      {/* Tabs */}
      <div class="mb-4 flex gap-0 border-b border-zinc-800">
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

      {/* ── FORM TAB ───────────────────────────────────────────────────────── */}
      <Show when={tab() === "form"}>
        <div class="space-y-4">
          {/* Row 1: Name + Image */}
          <div class="grid grid-cols-2 gap-3">
            {inp("容器名称", "name", "my-container")}
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
                <For each={imageOptions()}>
                  {(tag) => <option value={tag} />}
                </For>
              </datalist>
            </label>
          </div>

          {/* Row 2: Restart + Network */}
          <div class="grid grid-cols-2 gap-3">
            <label class="block">
              <span class="mb-0.5 block text-xs text-zinc-400">重启策略</span>
              <select
                class="w-full rounded border border-zinc-800 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-blue-500"
                value={form().restart_policy}
                onChange={(e) => set("restart_policy", e.currentTarget.value)}
              >
                <For each={RESTART_OPTS}>
                  {(o) => <option value={o.value}>{o.label}</option>}
                </For>
              </select>
            </label>
            <label class="block">
              <span class="mb-0.5 block text-xs text-zinc-400">网络</span>
              <select
                class="w-full rounded border border-zinc-800 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-blue-500"
                value={form().network_mode}
                onChange={(e) => set("network_mode", e.currentTarget.value)}
              >
                <For each={networkOptions()}>
                  {(o) => <option value={o.value}>{o.label}</option>}
                </For>
              </select>
            </label>
          </div>

          {/* Row 3: Hostname + Working dir */}
          <div class="grid grid-cols-2 gap-3">
            {inp("主机名 (Hostname)", "hostname", "留空使用容器 ID")}
            {inp("工作目录 (WorkingDir)", "working_dir", "/app")}
          </div>

          {/* Ports */}
          {ta(
            "端口映射 (每行一条，格式: 宿主机端口:容器端口 或 IP:宿主机端口:容器端口/协议)",
            "ports",
            "8080:80\n0.0.0.0:443:443/tcp\n127.0.0.1:9000:9000",
            3,
          )}

          {/* Env */}
          {ta("环境变量 (每行 KEY=VALUE)", "env", "TZ=Asia/Shanghai\nDEBUG=false", 3)}

          {/* Binds */}
          {ta("挂载 (每行一条，格式: 宿主机路径:容器路径[:ro])", "binds", "/data:/data\n/etc/localtime:/etc/localtime:ro", 3)}

          {/* Command */}
          {ta("启动命令 (逗号分隔各参数)", "cmd", "nginx,-g,daemon off;")}

          {/* Advanced section */}
          <details class="rounded border border-zinc-800">
            <summary class="cursor-pointer px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100">
              高级选项
            </summary>
            <div class="space-y-3 p-3">
              <div class="grid grid-cols-2 gap-3">
                {inp("内存上限 (MB)", "memory", "256")}
                {inp("CPU Quota", "cpu_quota", "50000 (对应 50%)")}
              </div>
              <div class="grid grid-cols-2 gap-3">
                {inp("CPU Period", "cpu_period", "100000")}
                {inp("Cap Add (逗号分隔)", "cap_add", "NET_ADMIN")}
              </div>
              <div class="grid grid-cols-2 gap-3">
                {inp("Cap Drop (逗号分隔)", "cap_drop", "ALL")}
                <div />
              </div>
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

      {/* ── CMD TAB ────────────────────────────────────────────────────────── */}
      <Show when={tab() === "cmd"}>
        <div class="h-[55vh]">
          <RunComposeEditor
            initialRun="docker run -d --name web -p 8080:80 nginx:latest"
            actions={(s) => (
              <div class="flex items-center gap-2">
                <Show when={parseErr()}>
                  <span class="text-sm text-red-400">{parseErr()}</span>
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
      </Show>
    </Modal>
  );
};
