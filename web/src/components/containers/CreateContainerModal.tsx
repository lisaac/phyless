import { Component, createSignal, Show, For } from "solid-js";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { RunComposeEditor } from "../shared/RunComposeEditor";
import { post } from "../../api/client";
import { toast } from "../shared/Toast";
import { emptyForm, formToPayload, type CreateForm } from "./containerForm";

type Tab = "form" | "run" | "compose";

export const CreateContainerModal: Component<{
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}> = (props) => {
  const [tab, setTab] = createSignal<Tab>("form");
  const [form, setForm] = createSignal<CreateForm>(emptyForm());
  const set = <K extends keyof CreateForm>(k: K, v: CreateForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    try {
      const out = await post<{ id: string }>("/api/containers", formToPayload(form()));
      toast.info(`created ${out.id.slice(0, 12)}`);
      setForm(emptyForm());
      props.onCreated();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // text/number inputs
  const T = (label: string, k: keyof CreateForm, ph = "") => (
    <label class="block">
      <span class="text-xs text-zinc-400">{label}</span>
      <input
        class="mb-2 w-full rounded bg-zinc-800 px-2 py-1 text-sm outline-none"
        placeholder={ph}
        value={form()[k] as string}
        onInput={(e) => set(k, e.currentTarget.value as never)}
      />
    </label>
  );
  const TA = (label: string, k: keyof CreateForm, ph = "") => (
    <label class="block">
      <span class="text-xs text-zinc-400">{label}</span>
      <textarea
        rows="3"
        class="mb-2 w-full rounded bg-zinc-800 px-2 py-1 font-mono text-xs outline-none"
        placeholder={ph}
        value={form()[k] as string}
        onInput={(e) => set(k, e.currentTarget.value as never)}
      />
    </label>
  );
  const CB = (label: string, k: keyof CreateForm) => (
    <label class="mb-2 flex items-center gap-2 text-sm">
      <input type="checkbox" checked={form()[k] as boolean} onChange={(e) => set(k, e.currentTarget.checked as never)} />
      {label}
    </label>
  );

  // Parse pasted docker run / compose into the form via composeToRun -> very rough field fill.
  // ponytail: we only auto-fill image+name from a parsed run; user reviews the rest.
  const parseRun = (run: string) => {
    const m = run.match(/--name\s+(\S+)/);
    if (m) set("name", m[1]);
    const img = run.trim().split(/\s+/).pop();
    if (img) set("image", img);
    setTab("form");
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: "form", label: "表单" },
    { key: "run", label: "粘贴 docker run" },
    { key: "compose", label: "粘贴 compose" },
  ];

  return (
    <Modal open={props.open} onClose={props.onClose} title="新建容器" wide>
      <div class="mb-3 flex gap-2 border-b border-zinc-800">
        <For each={tabs}>
          {(t) => (
            <button
              class={`px-3 py-1 text-sm ${tab() === t.key ? "border-b-2 border-blue-500" : "text-zinc-400"}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          )}
        </For>
      </div>

      <Show when={tab() === "form"}>
        <div class="grid grid-cols-2 gap-x-4">
          {T("名称", "name", "web")}
          {T("镜像", "image", "nginx:latest")}
          {T("重启策略", "restart_policy", "always | unless-stopped | no")}
          {T("网络模式", "network_mode", "bridge | host | <network>")}
          {TA("命令 (逗号分隔)", "cmd", "nginx,-g,daemon off;")}
          {TA("环境变量 (每行 K=V)", "env", "TZ=UTC")}
          {TA("挂载 binds (每行)", "binds", "/host:/container:ro")}
          {TA("标签 (每行 K=V)", "labels", "team=infra")}
          {T("Cap Add (逗号)", "cap_add", "NET_ADMIN")}
          {T("Cap Drop (逗号)", "cap_drop", "ALL")}
          {T("内存上限 MB", "memory", "256")}
          {T("CPU Quota", "cpu_quota", "50000")}
          {T("CPU Period", "cpu_period", "100000")}
          {TA("Sysctls (每行 K=V)", "sysctls", "net.core.somaxconn=1024")}
        </div>
        <div class="mt-1 flex gap-4">
          {CB("特权模式", "privileged")}
          {CB("只读 rootfs", "readonly_rootfs")}
        </div>
        <div class="mt-3 flex justify-end gap-2">
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" onClick={submit}>创建</Button>
        </div>
      </Show>

      <Show when={tab() === "run"}>
        <div class="h-[55vh]">
          <RunComposeEditor
            initialRun="docker run -d --name web -p 8080:80 nginx"
            actions={(s) => (
              <div class="flex justify-end">
                <Button variant="primary" onClick={() => parseRun(s.run)}>解析并进入表单</Button>
              </div>
            )}
          />
        </div>
      </Show>

      <Show when={tab() === "compose"}>
        <div class="h-[55vh]">
          <RunComposeEditor
            initialCompose={"services:\n  web:\n    image: nginx\n    ports:\n      - \"8080:80\"\n"}
            actions={(s) => (
              <div class="flex justify-end">
                <Button variant="primary" onClick={() => parseRun(s.run)}>解析并进入表单</Button>
              </div>
            )}
          />
        </div>
      </Show>
    </Modal>
  );
};
