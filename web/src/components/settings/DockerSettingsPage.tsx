import { Component, Show, createSignal, onMount } from "solid-js";
import { request } from "../../api/client";
import { queued } from "../../stores/taskQueue";
import { cancelDockerServerRequests, dockerServerChanged } from "../../stores/dockerServer";
import { toast } from "../shared/Toast";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { Table, type Column } from "../shared/Table";
import type { DockerServer, DockerSettings } from "../../types";

type Form = { name: string; host: string; tls: boolean; ca_pem: string; cert_pem: string; key_pem: string };

const emptyForm = (): Form => ({ name: "", host: "", tls: false, ca_pem: "", cert_pem: "", key_pem: "" });

export const DockerSettingsPage: Component = () => {
  const [settings, setSettings] = createSignal<DockerSettings>({ servers: [], active_id: "" });
  const [show, setShow] = createSignal(false);
  const [editing, setEditing] = createSignal<DockerServer>();
  const [form, setForm] = createSignal<Form>(emptyForm());

  const load = async () => {
    try { setSettings(await request<DockerSettings>("GET", "/api/settings/docker")); }
    catch (e) { toast.error((e as Error).message); }
  };
  onMount(() => { void load(); });

  const openCreate = () => {
    setEditing(undefined);
    setForm(emptyForm());
    setShow(true);
  };
  const openEdit = (server: DockerServer) => {
    setEditing(server);
    setForm({ name: server.name, host: server.host, tls: server.tls, ca_pem: "", cert_pem: "", key_pem: "" });
    setShow(true);
  };
  const close = () => setShow(false);
  const setText = (key: "name" | "host" | "ca_pem" | "cert_pem" | "key_pem", value: string) => setForm((f) => ({ ...f, [key]: value }));
  const isActive = (server: DockerServer) => server.id === settings().active_id;

  const save = async () => {
    const current = editing();
    const updatesActiveServer = Boolean(current && isActive(current));
    const f = form();
    const body: Record<string, string | boolean> = { name: f.name.trim(), host: f.host.trim(), tls: f.tls };
    if (f.tls) {
      if (f.ca_pem.trim()) body.ca_pem = f.ca_pem;
      if (f.cert_pem.trim()) body.cert_pem = f.cert_pem;
      if (f.key_pem.trim()) body.key_pem = f.key_pem;
    }
    if (updatesActiveServer) cancelDockerServerRequests();
    try {
      await queued(
        current ? "保存 Docker 服务器" : "添加 Docker 服务器",
        current ? "PUT" : "POST",
        current ? "/api/settings/docker/servers/" + current.id : "/api/settings/docker/servers",
        body,
      );
      close();
      if (updatesActiveServer) {
        dockerServerChanged();
        toast.success("已保存并热切换");
        return;
      }
      await load();
      toast.success("已保存");
    } catch (e) { toast.error((e as Error).message); }
  };
  const select = async (server: DockerServer) => {
    cancelDockerServerRequests();
    try {
      await queued("切换 Docker 服务器", "POST", "/api/settings/docker/servers/" + server.id + "/select");
      dockerServerChanged();
      toast.success("已切换，无需重启");
    } catch (e) { toast.error((e as Error).message); }
  };
  const remove = async (server: DockerServer) => {
    try {
      await queued("删除 Docker 服务器", "DELETE", "/api/settings/docker/servers/" + server.id);
      await load();
    } catch (e) { toast.error((e as Error).message); }
  };

  const columns: Column<DockerServer>[] = [
    {
      header: "服务器",
      cell: (server) => <div class="flex items-center gap-2"><span class="font-medium">{server.name}</span><Show when={isActive(server)}><span class="text-xs text-emerald-400">当前</span></Show></div>,
    },
    { header: "Docker API", cell: (server) => <code class="text-xs text-zinc-400">{server.host || "本机 Docker"}</code> },
    { header: "连接", cell: (server) => <span>{server.tls ? "TLS" : "明文"}</span> },
    {
      header: "操作",
      cell: (server) => (
        <div class="flex gap-1">
          <Show when={!isActive(server)}><Button onClick={() => select(server)}>使用</Button></Show>
          <Button onClick={() => openEdit(server)}>编辑</Button>
          <Show when={!isActive(server)}><Button variant="danger" onClick={() => remove(server)}>删除</Button></Show>
        </div>
      ),
    },
  ];

  const saved = () => editing();
  return (
    <div class="max-w-5xl">
      <div class="mb-4 flex items-center justify-between">
        <div>
          <h1 class="text-xl font-semibold">Docker 连接</h1>
          <p class="mt-1 text-sm text-zinc-500">添加多个本机或远程 Docker API，选择后立即切换，无需重启。</p>
        </div>
        <Button variant="primary" onClick={openCreate}>添加服务器</Button>
      </div>
      <Table rows={settings().servers} columns={columns} rowKey={(server) => server.id} />

      <Modal open={show()} onClose={close} title={editing() ? "编辑 Docker 服务器" : "添加 Docker 服务器"}>
        <label class="mb-3 block text-sm text-zinc-300">
          名称
          <input class="mt-1 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="生产环境" value={form().name} onInput={(e) => setText("name", e.currentTarget.value)} />
        </label>
        <label class="mb-3 block text-sm text-zinc-300">
          Docker API 地址
          <input class="mt-1 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="留空使用本机 Docker，或 tcp://docker.example.com:2375" value={form().host} onInput={(e) => setText("host", e.currentTarget.value)} />
        </label>
        <label class="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={form().tls} onChange={(e) => setForm((f) => ({ ...f, tls: e.currentTarget.checked }))} />
          使用 TLS（通常为 tcp://host:2376）
        </label>
        <Show when={form().tls}>
          <p class="mt-3 text-sm text-zinc-500">PEM 文本保存在服务器配置文件中，不会回传浏览器；已保存时留空即可保留。</p>
          <PemField label="CA 证书" value={form().ca_pem} saved={saved()?.has_ca_pem ?? false} onInput={(value) => setText("ca_pem", value)} />
          <PemField label="客户端证书" value={form().cert_pem} saved={saved()?.has_cert_pem ?? false} onInput={(value) => setText("cert_pem", value)} />
          <PemField label="客户端私钥" value={form().key_pem} saved={saved()?.has_key_pem ?? false} onInput={(value) => setText("key_pem", value)} />
        </Show>
        <div class="mt-5 flex justify-end gap-2">
          <Button onClick={close}>取消</Button>
          <Button variant="primary" onClick={save}>保存</Button>
        </div>
      </Modal>
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
