import { createSignal } from "solid-js";

type Theme = "dark" | "light";

// Manual override; absent = follow the device's prefers-color-scheme.
const STORAGE_KEY = "phyless_theme_override";
const media = window.matchMedia?.("(prefers-color-scheme: dark)");
const system = (): Theme => (media?.matches === false ? "light" : "dark");

// Legacy key was always written ("dark" by default), so only "light" was a real choice.
const legacy = localStorage.getItem("phyless_theme");
if (legacy !== null) {
  localStorage.removeItem("phyless_theme");
  if (legacy === "light") localStorage.setItem(STORAGE_KEY, legacy);
}

const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;

export const [theme, setTheme] = createSignal<Theme>(stored ?? system());

function apply(t: Theme) {
  setTheme(t);
  document.documentElement.classList.toggle("dark", t === "dark");
}

export function toggleTheme() {
  const next = theme() === "dark" ? "light" : "dark";
  // Toggling back to the device theme drops the override → auto again.
  if (next === system()) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, next);
  apply(next);
}

media?.addEventListener("change", () => {
  if (!localStorage.getItem(STORAGE_KEY)) apply(system());
});

// Apply on module load (runs before first render)
apply(theme());
