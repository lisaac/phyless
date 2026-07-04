import { Component, createSignal, createEffect } from "solid-js";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";

// Shared by ContainerListPage (per-row button) and ContainerDetailPage
// (action bar button): pick a shell command + user, then open a standalone,
// chrome-less terminal window for it (see TerminalWindowPage).
export const ConsoleModal: Component<{ target: { id: string; name: string } | null; onClose: () => void }> = (props) => {
  const [cmd, setCmd] = createSignal("/bin/sh");
  const [user, setUser] = createSignal("");

  createEffect(() => {
    if (props.target) { setCmd("/bin/sh"); setUser(""); }
  });

  const confirm = () => {
    const t = props.target;
    if (!t) return;
    const params = new URLSearchParams();
    if (cmd()) params.set("cmd", cmd());
    if (user()) params.set("user", user());
    params.set("name", t.name);
    window.open(
      `/terminal/${t.id}?${params.toString()}`,
      "_blank",
      "width=960,height=600,menubar=no,toolbar=no,location=no,status=no,resizable=yes",
    );
    props.onClose();
  };

  const fieldCls = "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500 transition-colors";

  return (
    <Modal open={!!props.target} onClose={props.onClose} title={`控制台 — ${props.target?.name ?? ""}`}>
      <div class="flex flex-col gap-3">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-zinc-400">命令行</span>
          <input
            class={fieldCls}
            value={cmd()}
            onInput={(e) => setCmd(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && confirm()}
            placeholder="/bin/sh"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-zinc-400">用户</span>
          <input
            class={fieldCls}
            value={user()}
            onInput={(e) => setUser(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && confirm()}
            placeholder="留空使用镜像默认用户"
          />
        </label>
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <Button onClick={props.onClose}>取消</Button>
        <Button variant="primary" onClick={confirm}>确定</Button>
      </div>
    </Modal>
  );
};
