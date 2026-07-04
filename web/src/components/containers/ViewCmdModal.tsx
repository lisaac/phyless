import { Component, createResource } from "solid-js";
import { get, imageInspectUrl } from "../../api/client";
import { inspectToRunCmd } from "../../api/inspect";
import { CreateContainerModal } from "./CreateContainerModal";

// Always mounted (open just toggles CreateContainerModal's own visibility) —
// wrapping it in a <Show> would unmount CreateContainerModal, and with it the
// PullStatusWidget it embeds, the instant onClose fires (e.g. right after
// clicking "创建容器"), killing the in-flight creation before it can render.
export const ViewCmdModal: Component<{ target: { id: string; name: string } | null; onClose: () => void }> = (props) => {
  const [cmd] = createResource(() => props.target, async (t) => {
    const inspect = await get<Record<string, unknown>>(`/api/containers/${t.id}/inspect`);
    const imageId = (inspect?.Image as string) ?? "";
    let imageInspect = {};
    if (imageId) {
      try { imageInspect = await get(imageInspectUrl(imageId)); } catch { /* ignore */ }
    }
    return inspectToRunCmd(inspect, imageInspect);
  });

  return (
    <CreateContainerModal
      open={!!props.target && !cmd.loading}
      onClose={props.onClose}
      onCreated={props.onClose}
      initialRun={cmd() ?? ""}
    />
  );
};
