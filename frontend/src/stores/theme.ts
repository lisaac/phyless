import { createSignal } from "solid-js";

export type ThemeMode = "auto" | "light" | "dark";

// Manual override; absent = "auto" (follow the device's prefers-color-scheme).
const STORAGE_KEY = "phyless_theme_override";
const media = window.matchMedia?.("(prefers-color-scheme: dark)");
const systemDark = () => media?.matches !== false;

// Legacy key was always written ("dark" by default), so only "light" was a real choice.
const legacy = localStorage.getItem("phyless_theme");
if (legacy !== null) {
  localStorage.removeItem("phyless_theme");
  if (legacy === "light") localStorage.setItem(STORAGE_KEY, legacy);
}

const stored = localStorage.getItem(STORAGE_KEY);
export const [mode, setMode] = createSignal<ThemeMode>(stored === "light" || stored === "dark" ? stored : "auto");

const LABELS: Record<ThemeMode, string> = { auto: "自动", light: "日间", dark: "夜间" };
const NEXT: Record<ThemeMode, ThemeMode> = { auto: "light", light: "dark", dark: "auto" };

export const themeLabel = () => `主题：${LABELS[mode()]}（点击切换为${LABELS[NEXT[mode()]]}）`;

function apply() {
  const m = mode();
  document.documentElement.classList.toggle("dark", m === "auto" ? systemDark() : m === "dark");
}

export function cycleTheme() {
  const next = NEXT[mode()];
  if (next === "auto") localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, next);
  setMode(next);
  apply();
}

media?.addEventListener("change", () => {
  if (mode() === "auto") apply();
});

// Apply on module load (runs before first render)
apply();
