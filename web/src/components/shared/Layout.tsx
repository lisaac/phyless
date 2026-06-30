import { Component, JSX } from "solid-js";
import { Sidebar } from "./Sidebar";

export const Layout: Component<{ children?: JSX.Element }> = (props) => (
  <div class="flex h-full">
    <Sidebar />
    <main class="flex-1 overflow-auto p-6">{props.children}</main>
  </div>
);
