import { Component, For, Show } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { currentUser, doLogout, hasRole } from "../../stores/auth";
import { theme, toggleTheme } from "../../stores/theme";
import { ThemeIcon } from "./ThemeIcon";

// Flat list kept as the single source of truth for path→label lookups
// (stores/tabs.ts builds its labelFor() map from this + adminLinks) — the
// Sidebar's own rendering below groups a subset of these under "Docker"
// without needing a second data structure to keep in sync.
export const mainLinks = [
  { to: "/overview",   label: "总览" },
  { to: "/containers", label: "容器" },
  { to: "/compose",    label: "Compose" },
  { to: "/images",     label: "镜像" },
  { to: "/networks",   label: "网络" },
  { to: "/volumes",    label: "存储卷" },
  { to: "/events",     label: "事件" },
  { to: "/config",     label: "配置文件" },
];
export const adminLinks = [
  { to: "/settings/users",      label: "用户管理" },
  { to: "/settings/registries", label: "镜像仓库" },
  { to: "/settings/audit",      label: "审计日志" },
];

const DOCKER_PATHS = new Set(["/containers", "/compose", "/images", "/networks", "/volumes", "/events"]);
const dockerLinks = mainLinks.filter((l) => DOCKER_PATHS.has(l.to));
const overviewLink = mainLinks.find((l) => l.to === "/overview")!;
const configLink = mainLinks.find((l) => l.to === "/config")!;

export const Sidebar: Component<{ onClose?: () => void }> = (props) => {
  const navigate = useNavigate();
  const linkCls = "mx-2 flex items-center rounded-md px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors";
  const activeCls = "bg-zinc-800 text-zinc-100 font-medium";

  const nav = (to: string) => {
    props.onClose?.();
    navigate(to, { replace: true });
  };

  return (
    <nav class="flex h-full w-52 flex-col border-r border-zinc-800 bg-zinc-900">
      {/* Header */}
      <div class="flex items-center justify-between px-4 py-4">
        <div class="flex items-center gap-2">
          <div class="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-600">
            <span class="text-[10px] font-bold text-white">P</span>
          </div>
          <span class="text-sm font-semibold text-zinc-100">phyless</span>
        </div>
        <div class="flex items-center gap-1">
          <button
            title={theme() === "dark" ? "切换日间模式" : "切换夜间模式"}
            aria-label={theme() === "dark" ? "切换日间模式" : "切换夜间模式"}
            class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
            onClick={toggleTheme}
          >
            <ThemeIcon dark={theme() === "dark"} />
          </button>
          <Show when={props.onClose}>
            <button
              class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
              onClick={props.onClose}
              aria-label="关闭菜单"
            >
              ✕
            </button>
          </Show>
        </div>
      </div>

      {/* Main nav */}
      <div class="flex-1 overflow-y-auto py-1">
        <A href={overviewLink.to} replace class={linkCls} activeClass={activeCls} onClick={() => props.onClose?.()}>
          {overviewLink.label}
        </A>

        <div class="mx-4 mt-4 mb-1 border-t border-zinc-800 pt-3 text-[10px] font-medium uppercase tracking-widest text-zinc-500">
          Docker
        </div>
        <For each={dockerLinks}>
          {(l) => (
            <A
              href={l.to}
              replace
              class={linkCls}
              activeClass={activeCls}
              onClick={() => props.onClose?.()}
            >
              {l.label}
            </A>
          )}
        </For>

        <A href={configLink.to} replace class={linkCls} activeClass={activeCls} onClick={() => props.onClose?.()}>
          {configLink.label}
        </A>

        <Show when={hasRole("admin")}>
          <div class="mx-4 mt-4 mb-1 border-t border-zinc-800 pt-3 text-[10px] font-medium uppercase tracking-widest text-zinc-500">
            设置
          </div>
          <For each={adminLinks}>
            {(l) => (
              <A
                href={l.to}
                replace
                class={linkCls}
                activeClass={activeCls}
                onClick={() => props.onClose?.()}
              >
                {l.label}
              </A>
            )}
          </For>
        </Show>
      </div>

      {/* Footer */}
      <div class="border-t border-zinc-800 px-4 py-3">
        <div class="mb-2 text-xs text-zinc-300">
          {currentUser()?.username}
          <span class="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">{currentUser()?.role}</span>
        </div>
        <button
          class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          onClick={() => { doLogout(); nav("/login"); }}
        >
          退出登录
        </button>
        <div class="mt-2 text-[10px] text-zinc-600" title="构建时间 · commit">
          {__BUILD_TIME__} · {__GIT_HASH__}
        </div>
      </div>
    </nav>
  );
};
