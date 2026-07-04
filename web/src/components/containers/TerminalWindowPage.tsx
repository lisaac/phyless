import { Component } from "solid-js";
import { useParams, useSearchParams } from "@solidjs/router";
import { ContainerTerminal } from "./ContainerTerminal";

// Rendered at a top-level route outside Guard/Layout — no sidebar, no tab
// strip, just the terminal filling the window. Meant to be opened via
// window.open() as a chrome-less popup from ConsoleModal, not navigated to
// directly inside the app.
export const TerminalWindowPage: Component = () => {
  const params = useParams();
  const [search] = useSearchParams();

  return (
    <div class="h-screen w-screen bg-[#0c0c0c]">
      <ContainerTerminal
        id={params.id}
        cmd={(search.cmd as string) || "/bin/sh"}
        user={(search.user as string) || ""}
      />
    </div>
  );
};
