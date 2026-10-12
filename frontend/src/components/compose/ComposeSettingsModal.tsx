import { Component, Index, createEffect, createSignal, on } from "solid-js";
import { get } from "../../api/client";
import { queued } from "../../stores/taskQueue";
import { toast } from "../shared/Toast";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { PathPicker } from "../shared/PathPicker";

export const loadComposeDirs = () => get<{ dirs: string[] }>("/api/settings/compose").then((r) => r.dirs);

export const ComposeSettingsModal: Component<{ open: boolean; onClose: () => void; onSaved: () => void }> = (props) => {
  const [dirs, setDirs] = createSignal<string[]>([]);
  const [saving, setSaving] = createSignal(false);

  createEffect(on(() => props.open, (open) => {
    if (open) loadComposeDirs().then(setDirs, (e) => toast.error((e as Error).message));
  }));

  const setAt = (i: number, value: string) => setDirs((d) => d.map((x, j) => (j === i ? value : x)));
  const save = async () => {
    setSaving(true);
    try {
      await queued("保存 Compose 设置", "PUT", "/api/settings/compose", { dirs: dirs() });
      toast.success("已保存");
      props.onSaved();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={props.open} onClose={props.onClose} title="Compose 设置">
      <h3 class="text-sm font-medium text-zinc-200">搜索目录</h3>
      <p class="mt-1 text-xs text-zinc-500">
        目录位于 phyless 所在主机（连接远程 Docker 时也一样，Compose 文件与 build 上下文都从这里读取）。扫描这些目录及其一级子目录中的 compose.yaml，标记为「目录中发现」；第一个目录是新建项目的默认位置，注册/新建时路径为空会优先列出这些目录。
      </p>
      <div class="mt-3 space-y-2">
        {/* Index, not For: rows are keyed by position so editing a string doesn't remount the input. */}
        <Index each={dirs()}>
          {(dir, i) => (
            <div class="flex items-center gap-2">
              <span class="w-8 shrink-0 text-[11px] text-zinc-500">{i === 0 ? "默认" : `#${i + 1}`}</span>
              <div class="min-w-0 flex-1"><PathPicker value={dir()} onChange={(v) => setAt(i, v)} placeholder="/srv" /></div>
              <Button variant="danger" disabled={dirs().length <= 1} onClick={() => setDirs((d) => d.filter((_, j) => j !== i))}>删除</Button>
            </div>
          )}
        </Index>
      </div>
      <div class="mt-5 flex justify-between gap-2">
        <Button onClick={() => setDirs((d) => [...d, ""])}>添加目录</Button>
        <div class="flex gap-2">
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" disabled={saving()} onClick={() => void save()}>保存</Button>
        </div>
      </div>
    </Modal>
  );
};
