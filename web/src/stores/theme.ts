import { createSignal } from "solid-js";

const STORAGE_KEY = "phyless_theme";
const stored = (localStorage.getItem(STORAGE_KEY) ?? "dark") as "dark" | "light";

export const [theme, setTheme] = createSignal<"dark" | "light">(stored);

function apply(t: "dark" | "light") {
  document.documentElement.classList.toggle("dark", t === "dark");
  localStorage.setItem(STORAGE_KEY, t);
}

export function toggleTheme() {
  const next = theme() === "dark" ? "light" : "dark";
  setTheme(next);
  apply(next);
}

// Apply on module load (runs before first render)
apply(stored);
