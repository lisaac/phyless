import { Component, createSignal, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { doLogin, doSetup } from "../../stores/auth";
import { ApiError, get } from "../../api/client";

export const LoginPage: Component = () => {
  const navigate = useNavigate();
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");
  const [configured, setConfigured] = createSignal<boolean | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    void get<{ configured: boolean }>("/api/auth/setup")
      .then((state) => setConfigured(state.configured))
      .catch((err) => setError(String(err)));
  });

  const submit = async (e: Event) => {
    e.preventDefault();
    if (configured() === false && password() !== confirmPassword()) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (configured() === false) await doSetup(password());
      else await doLogin(username(), password());
      navigate("/containers", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? "用户名或密码错误" : String(err));
    } finally {
      setBusy(false);
    }
  };

  const fieldCls = "w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-colors";

  return (
    <div class="flex h-full items-center justify-center bg-zinc-950">
      <form onSubmit={submit} class="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-8 shadow-2xl">
        <div class="mb-7">
          <div class="mb-1 flex items-center gap-2">
            <div class="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600">
              <span class="text-xs font-bold text-white">P</span>
            </div>
            <span class="font-semibold tracking-tight text-zinc-100">phyless</span>
          </div>
          <p class="mt-4 text-lg font-semibold text-zinc-100">{configured() === false ? "创建管理员密码" : "欢迎回来"}</p>
          <p class="mt-0.5 text-sm text-zinc-500">{configured() === false ? "首次使用：账号为 admin" : "基础设施管理控制台"}</p>
        </div>

        <Show when={configured() !== false}>
          <div class="mb-4">
            <label class="mb-1.5 block text-sm font-medium text-zinc-300">用户名</label>
            <input
              class={fieldCls}
              placeholder="admin"
              autocomplete="username"
              value={username()}
              onInput={(e) => setUsername(e.currentTarget.value)}
            />
          </div>
        </Show>
        <div class="mb-5">
          <label class="mb-1.5 block text-sm font-medium text-zinc-300">密码</label>
          <input
            class={fieldCls}
            type="password"
            placeholder="••••••••"
            autocomplete={configured() === false ? "new-password" : "current-password"}
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </div>
        <Show when={configured() === false}>
          <div class="mb-5">
            <label class="mb-1.5 block text-sm font-medium text-zinc-300">确认密码</label>
            <input class={fieldCls} type="password" placeholder="••••••••" autocomplete="new-password" value={confirmPassword()} onInput={(e) => setConfirmPassword(e.currentTarget.value)} />
          </div>
        </Show>

        {error() && (
          <div class="mb-4 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error()}
          </div>
        )}

        <button
          class="w-full rounded-md bg-indigo-600 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
          disabled={busy() || configured() === null}
        >
          {busy() ? "处理中…" : configured() === false ? "创建并登录" : "登录"}
        </button>
      </form>
    </div>
  );
};
