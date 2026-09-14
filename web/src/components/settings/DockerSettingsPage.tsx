import { Component, Show, createSignal, onMount } from "solid-js";
import { request } from "../../api/client";
import { queued } from "../../stores/taskQueue";
import { toast } from "../shared/Toast";
import { Button } from "../shared/Button";
import type { DockerSettings } from "../../types";

type Form = { host: string; tls: boolean; ca_pem: string; cert_pem: string; key_pem: string };

export const DockerSettingsPage: Component = () => {
  const [saved, setSaved] = createSignal<DockerSettings>({ host: "", tls: false, has_ca_pem: false, has_cert_pem: false, has_key_pem: false });
  const [form, setForm] = createSignal<Form>({ host: "", tls: false, ca_pem: "", cert_pem: "", key_pem: "" });

  const load = async () => {
    try {
      const next = await request<DockerSettings>("GET", "/api/settings/docker");
      setSaved(next);
      setForm({ host: next.host, tls: next.tls, ca_pem: "", cert_pem: "", key_pem: "" });
    } catch (e) { toast.error((e as Error).message); }
  };
  onMount(() => { void load(); });

  const setText = (key: "host" | "ca_pem" | "cert_pem" | "key_pem", value: string) => setForm((f) => ({ ...f, [key]: value }));
  const save = async () => {
    const f = form();
    const body: Record<string, string | boolean> = { host: f.host.trim(), tls: f.tls };
    if (f.tls) {
      if (f.ca_pem.trim()) body.ca_pem = f.ca_pem;
      if (f.cert_pem.trim()) body.cert_pem = f.cert_pem;
      if (f.key_pem.trim()) body.key_pem = f.key_pem;
    }
    try {
      await queued("保存 Docker 连接", "PUT", "/api/settings/docker", body);
      await load();
      toast.success("已保存，重启服务后生效");
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div class="max-w-3xl">
      <h1 class="text-xl font-semibold">Docker 连接</h1>
      <p class="mt-1 text-sm text-zinc-500">留空继续使用本机 Docker。远程地址使用 <code>tcp://host:port</code>；保存后重启服务生效。</p>

      <label class="mt-5 block text-sm text-zinc-300">
        Docker API 地址
        <input
          class="mt-1 w-full bg-zinc-900 border border-zinc-800 px-3 py-2"
          placeholder="tcp://docker.example.com:2375"
          value={form().host}
          onInput={(e) => setText("host", e.currentTarget.value)}
        />
      </label>

      <label class="mt-4 flex items-center gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={form().tls} onChange={(e) => setForm((f) => ({ ...f, tls: e.currentTarget.checked }))} />
        使用 TLS（通常为 tcp://host:2376）
      </label>

      <Show when={form().tls}>
        <p class="mt-3 text-sm text-zinc-500">PEM 文本将保存在服务器的配置文件中；已保存的内容不会回传到浏览器，留空即可保留。</p>
        <PemField label="CA 证书" value={form().ca_pem} saved={saved().has_ca_pem} onInput={(value) => setText("ca_pem", value)} />
        <PemField label="客户端证书" value={form().cert_pem} saved={saved().has_cert_pem} onInput={(value) => setText("cert_pem", value)} />
        <PemField label="客户端私钥" value={form().key_pem} saved={saved().has_key_pem} onInput={(value) => setText("key_pem", value)} />
      </Show>

      <div class="mt-5">
        <Button variant="primary" onClick={save}>保存</Button>
      </div>
    </div>
  );
};

const PemField: Component<{ label: string; value: string; saved: boolean; onInput: (value: string) => void }> = (props) => (
  <label class="mt-3 block text-sm text-zinc-300">
    {props.label}
    <textarea
      class="mt-1 min-h-28 w-full bg-zinc-900 border border-zinc-800 px-3 py-2 font-mono text-xs"
      placeholder={props.saved ? "已保存，留空保持不变" : "-----BEGIN ...-----"}
      value={props.value}
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
  </label>
);
