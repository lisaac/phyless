import { Component } from "solid-js";

// `dark` = currently dark → show a sun (click switches to day).
export const ThemeIcon: Component<{ dark: boolean }> = (p) => (
  <span aria-hidden="true" class="inline-block w-[15px] text-center text-[15px] leading-none">
    {p.dark ? "☀︎" : "☾"}
  </span>
);
