import { Component } from "solid-js";

// 15px sun/moon, sized to match the other top-bar SVG icons (task/refresh/
// gear). `dark` = currently dark → show a sun (click switches to day).
export const ThemeIcon: Component<{ dark: boolean }> = (p) => (
  <svg
    xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"
  >
    {p.dark
      ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>
      : <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />}
  </svg>
);
