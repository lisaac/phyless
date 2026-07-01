import { Component, For, Show } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { currentUser, doLogout, hasRole } from "../../stores/auth";
import { theme, toggleTheme } from "../../stores/theme";

const mainLinks = [
  { to: "/containers", label: "容器" },
  { to: "/images", label: "镜像" },
  { to: "/compose", label: "Compose" },
  { to: "/networks", label: "网络" },
  { to: "/volumes", label: "存储卷" },
  { to: "/events", label: "事件" },
  { to: "/config", label: "配置文件" },
];
const adminLinks = [
  { to: "/settings/users", label: "用户管理" },
  { to: "/settings/registries", label: "镜像仓库" },
  { to: "/settings/audit", label: "审计日志" },
];

export const Sidebar: Component = () => {
  const navigate = useNavigate();
  const linkClass = "block rounded px-3 py-2 text-sm hover:bg-zinc-800";
  const activeClass = "bg-zinc-800 font-medium";
  return (
    <nav class="flex w-48 flex-col border-r border-zinc-800 bg-zinc-900 p-2">
      <div class="flex items-center justify-between px-3 py-2">
        <span class="text-lg font-bold">phyless</span>
        <button
          title={theme() === "dark" ? "切换日间模式" : "切换夜间模式"}
          class="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          onClick={toggleTheme}
        >
          {theme() === "dark" ? "☀" : "☽"}
        </button>
      </div>
      <For each={mainLinks}>
        {(l) => (
          <A href={l.to} class={linkClass} activeClass={activeClass}>{l.label}</A>
        )}
      </For>
      <Show when={hasRole("admin")}>
        <div class="mt-3 px-3 py-1 text-xs uppercase text-zinc-500">设置</div>
        <For each={adminLinks}>
          {(l) => <A href={l.to} class={linkClass} activeClass={activeClass}>{l.label}</A>}
        </For>
      </Show>
      <div class="mt-auto border-t border-zinc-800 px-3 py-2 text-xs text-zinc-400">
        {currentUser()?.username} ({currentUser()?.role})
        <button
          class="mt-1 block text-zinc-400 hover:text-zinc-100"
          onClick={() => { doLogout(); navigate("/login", { replace: true }); }}
        >
          退出
        </button>
      </div>
    </nav>
  );
};
