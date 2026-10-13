import { Component, Match, Switch } from "solid-js";
import { mode } from "../../stores/theme";

// 15px icon for the current theme mode (sun / moon / half-filled circle = auto), sized to match the other top-bar SVG icons.
export const ThemeIcon: Component = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"
  >
    <Switch>
      <Match when={mode() === "light"}>
        <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </Match>
      <Match when={mode() === "dark"}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
      </Match>
      <Match when={mode() === "auto"}>
        <circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
      </Match>
    </Switch>
  </svg>
);
