import { Component, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { doLogin } from "../../stores/auth";
import { ApiError } from "../../api/client";

export const LoginPage: Component = () => {
  const navigate = useNavigate();
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await doLogin(username(), password());
      navigate("/containers", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? "Invalid credentials" : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="flex h-full items-center justify-center">
      <form onSubmit={submit} class="w-80 rounded-lg bg-zinc-900 p-6 shadow-lg">
        <h1 class="mb-4 text-lg font-semibold">phyless</h1>
        <input
          class="mb-2 w-full rounded bg-zinc-800 px-3 py-2 outline-none"
          placeholder="username"
          value={username()}
          onInput={(e) => setUsername(e.currentTarget.value)}
        />
        <input
          class="mb-2 w-full rounded bg-zinc-800 px-3 py-2 outline-none"
          type="password"
          placeholder="password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
        />
        {error() && <p class="mb-2 text-sm text-red-400">{error()}</p>}
        <button
          class="w-full rounded bg-blue-600 py-2 font-medium hover:bg-blue-500 disabled:opacity-50"
          disabled={busy()}
        >
          {busy() ? "…" : "Sign in"}
        </button>
      </form>
    </div>
  );
};
