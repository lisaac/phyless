import { Component, createSignal, createEffect, For, Show } from "solid-js";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { tags, refreshTags, createTag, bindingsFor, bindTag, unbindTag } from "../../stores/tags";
import { toast } from "../shared/Toast";

// Per-resource tag assignment popover — reused on both the container and
// image list pages so tagging doesn't require a trip to the Tags page.
export const TagPicker: Component<{
  open: boolean;
  onClose: () => void;
  resourceType: "container" | "image";
  resourceId: string;
  resourceName: string;
}> = (props) => {
  const [bound, setBound] = createSignal<Set<string>>(new Set());
  const [newName, setNewName] = createSignal("");
  const [busy, setBusy] = createSignal("");

  createEffect(() => {
    if (!props.open) return;
    void refreshTags();
    void bindingsFor(props.resourceType, props.resourceId).then((ids) => setBound(new Set(ids)));
  });

  const toggle = async (tagId: string) => {
    setBusy(tagId);
    try {
      if (bound().has(tagId)) {
        await unbindTag(tagId, props.resourceType, props.resourceId);
        setBound((b) => { const n = new Set(b); n.delete(tagId); return n; });
      } else {
        await bindTag(tagId, props.resourceType, props.resourceId);
        setBound((b) => new Set(b).add(tagId));
      }
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(""); }
  };

  const addNew = async () => {
    const name = newName().trim();
    if (!name) return;
    try {
      const t = await createTag(name);
      setNewName("");
      await bindTag(t.id, props.resourceType, props.resourceId);
      setBound((b) => new Set(b).add(t.id));
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <Modal open={props.open} onClose={props.onClose} title={`标签 · ${props.resourceName}`}>
      <div class="mb-3 flex max-h-64 flex-col gap-0.5 overflow-auto">
        <For each={tags()} fallback={<p class="text-xs text-zinc-500">暂无标签，先在下方创建一个</p>}>
          {(t) => (
            <label class="flex cursor-pointer items-center gap-2 px-1 py-1.5 text-sm hover:bg-zinc-800/50">
              <input
                type="checkbox"
                checked={bound().has(t.id)}
                disabled={busy() === t.id}
                onChange={() => void toggle(t.id)}
              />
              <span class="h-2 w-2 shrink-0 rounded-full" style={{ "background-color": t.color || "#71717a" }} />
              <span>{t.name}</span>
            </label>
          )}
        </For>
      </div>
      <div class="flex gap-2 border-t border-zinc-800 pt-3">
        <input
          class="flex-1 border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600 transition-colors"
          placeholder="新建标签"
          value={newName()}
          onInput={(e) => setNewName(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && void addNew()}
        />
        <Button variant="primary" onClick={() => void addNew()}>创建并添加</Button>
      </div>
    </Modal>
  );
};
