import { Component, createSignal, onMount, Show } from "solid-js";
import { createResourceStore } from "../../stores/resource";
import { Table, type Column } from "../shared/Table";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { queued } from "../../stores/taskQueue";
import { toast } from "../shared/Toast";
import type { User, Role } from "../../types";

export const UsersPage: Component = () => {
  const store = createResourceStore<User>("/api/users", "id");
  const [show, setShow] = createSignal(false);
  const [editing, setEditing] = createSignal<User | null>(null);
  const [newPassword, setNewPassword] = createSignal("");
  const [form, setForm] = createSignal<{ username: string; password: string; role: Role }>({
    username: "", password: "", role: "viewer",
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const closeEditor = () => { setEditing(null); setNewPassword(""); };

  onMount(() => store.refresh());

  const create = async () => {
    try {
      await queued(`创建用户 ${form().username}`, "POST", "/api/users", form());
      setShow(false); setForm({ username: "", password: "", role: "viewer" });
      await store.refresh();
    } catch (e) { toast.error((e as Error).message); }
  };
  const remove = async (id: string) => {
    try { await queued("删除用户", "DELETE", `/api/users/${id}`); await store.refresh(); }
    catch (e) { toast.error((e as Error).message); }
  };
  const changePassword = async () => {
    const user = editing();
    if (!user) return;
    try {
      await queued(`修改 ${user.username} 的密码`, "PUT", `/api/users/${user.id}`, { password: newPassword() });
      closeEditor();
    } catch (e) { toast.error((e as Error).message); }
  };

  const columns: Column<User>[] = [
    { header: "用户名", cell: (u) => <span class="font-medium">{u.username}</span> },
    { header: "角色", cell: (u) => <span>{u.role}</span> },
    { header: "操作", cell: (u) => <div class="flex gap-2"><Button onClick={() => setEditing(u)}>改密码</Button><Button variant="danger" onClick={() => remove(u.id)}>删除</Button></div> },
  ];

  return (
    <div>
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-semibold">用户管理</h1>
        <Button variant="primary" onClick={() => setShow(true)}>新建用户</Button>
      </div>
      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>
      <Table rows={store.items()} columns={columns} rowKey={(u) => u.id} />

      <Modal open={show()} onClose={() => setShow(false)} title="新建用户">
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="用户名" value={form().username} onInput={(e) => set("username", e.currentTarget.value)} />
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" type="password" placeholder="密码" value={form().password} onInput={(e) => set("password", e.currentTarget.value)} />
        <select class="mb-3 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" value={form().role} onChange={(e) => set("role", e.currentTarget.value)}>
          <option value="viewer">viewer</option>
          <option value="operator">operator</option>
          <option value="admin">admin</option>
        </select>
        <div class="flex justify-end gap-2">
          <Button onClick={() => setShow(false)}>取消</Button>
          <Button variant="primary" onClick={create}>创建</Button>
        </div>
      </Modal>

      <Modal open={!!editing()} onClose={closeEditor} title={`修改 ${editing()?.username ?? ""} 的密码`}>
        <input class="mb-3 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" type="password" placeholder="新密码" value={newPassword()} onInput={(e) => setNewPassword(e.currentTarget.value)} />
        <div class="flex justify-end gap-2"><Button onClick={closeEditor}>取消</Button><Button variant="primary" disabled={!newPassword()} onClick={changePassword}>保存</Button></div>
      </Modal>
    </div>
  );
};
