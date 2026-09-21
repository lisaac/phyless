import { Component, createEffect, createSignal, For, on, Show } from "solid-js";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { PullOptions, createPullOptions, isBrowserDownload, browserWorkerReady } from "../shared/PullOptions";
import { confirmAction } from "../shared/ConfirmModal";
import { LABEL_PROJECT } from "../compose/composeShared";
import { enqueue } from "../../stores/taskQueue";
import { updateCheckFor, staleEnvCandidates } from "../../stores/updateCheck";
import { UpdateBadge } from "./UpdateBadge";
import { UPGRADE_IMAGE_REF_LABEL, type EnvCandidate } from "../../api/inspect";
import { containerName } from "./containerActions";
import type { ContainerSummary } from "../../types";

export interface UpgradeTarget {
  id: string;
  name: string;
  imageId?: string;
  labels?: Record<string, string>;
}

export const toUpgradeTarget = (c: ContainerSummary): UpgradeTarget =>
  ({ id: c.Id, name: containerName(c) || c.Id.slice(0, 8), imageId: c.ImageID, labels: c.Labels });

const LABEL_SERVICE = "com.docker.compose.service";
// Upgrading one compose-managed container recreates it outside compose; the
// user must acknowledge that before anything is queued.
export function composeUpgradeWarning(targets: UpgradeTarget[]): string | null {
  const managed = targets.filter((t) => t.labels?.[LABEL_PROJECT]);
  if (managed.length === 0) return null;
  const tail = "单独升级会按当前容器配置重建它；之后对该项目执行 compose up 时，可能被 compose 定义再次覆盖或重建。";
  if (targets.length === 1) {
    const t = managed[0];
    const svc = t.labels?.[LABEL_SERVICE];
    return `${t.name} 由 Compose 项目 ${t.labels![LABEL_PROJECT]}${svc ? `（服务 ${svc}）` : ""} 管理。\n${tail}`;
  }
  const list = managed.map((t) => `· ${t.name}（${t.labels![LABEL_PROJECT]}）`).join("\n");
  return `以下 ${managed.length} 个容器由 Compose 管理：\n${list}\n${tail}`;
}

// Shared container-upgrade dialog for one or many containers: pull each
// target's image with the chosen options, then replace the container.
// Page-level (one instance per page); rows / bulk bar just hand it targets.
export const UpgradeContainerModal: Component<{
  targets: UpgradeTarget[] | null;
  onClose: () => void;
}> = (props) => {
  const pull = createPullOptions();
  const [skip, setSkip] = createSignal<Set<string>>(new Set());
  const check = (t: UpgradeTarget) => updateCheckFor(t.id, t.imageId);
  // Known-latest containers start unchecked in a batch; the backend would skip
  // them anyway, so ticking one back is harmless.
  createEffect(on(() => props.targets, (ts) => {
    ts ??= [];
    setSkip(new Set(ts.length > 1 ? ts.filter((t) => check(t)?.status === "latest").map((t) => t.id) : []));
  }));
  // Stale-ENV review for legacy-upgraded targets: candidates default to
  // "use the image's value"; `keepEnv` holds the ones the user keeps.
  const [envCands, setEnvCands] = createSignal<Record<string, EnvCandidate[]>>({});
  const [keepEnv, setKeepEnv] = createSignal<Set<string>>(new Set());
  createEffect(on(() => props.targets, (ts) => {
    setEnvCands({});
    setKeepEnv(new Set<string>());
    for (const t of (ts ?? []).filter((t) => t.labels?.[UPGRADE_IMAGE_REF_LABEL])) {
      staleEnvCandidates(t.id).then((c) => {
        if (c.length && props.targets === ts) setEnvCands((m) => ({ ...m, [t.id]: c }));
      }, () => { /* inspect failed: nothing to review */ });
    }
  }));
  const envKey = (id: string, key: string) => `${id}\u0000${key}`;
  const toggleEnv = (k: string) => setKeepEnv((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const envFromImage = (id: string) => (envCands()[id] ?? []).map((c) => c.key).filter((k) => !keepEnv().has(envKey(id, k)));
  const multi = () => (props.targets?.length ?? 0) > 1;
  const chosen = () => (props.targets ?? []).filter((t) => !skip().has(t.id));
  const toggle = (id: string) => setSkip((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const close = () => { pull.reset(); props.onClose(); };

  const start = async () => {
    const ts = chosen();
    if (ts.length === 0) return;
    const browser = isBrowserDownload(pull.value);
    if (!browserWorkerReady(pull.value)) return;
    const warning = composeUpgradeWarning(ts);
    if (warning && !await confirmAction(warning, {
      title: "升级 Compose 管理的容器",
      confirmText: ts.length > 1 ? "仍然升级全部" : "仍然升级",
    })) return;
    const options = pull.payload();
    for (const t of ts) {
      const env = envFromImage(t.id);
      // A local-newer tag already points at the newer image (possibly a local
      // build): rebuild from it instead of pulling, which could fail or undo it.
      const localOnly = check(t)?.status === "local-newer";
      if (browser && !localOnly) {
        enqueue({
          title: `升级 — ${t.name}`,
          url: "",
          key: t.id,
          meta: {
            type: "browser-pull-action", action: "upgrade", containerId: t.id, workerUrl: pull.value.workerUrl ?? "",
            envFromImage: env.length ? env : undefined,
          },
          secret: pull.value.creds?.secret ? { creds: pull.value.creds } : undefined,
        });
        continue;
      }
      const body = { ...(localOnly ? { pull_policy: "never" } : options), ...(env.length ? { env_from_image: env } : {}) };
      enqueue({
        title: `升级 — ${t.name}`,
        url: `/api/containers/${t.id}/upgrade`,
        body: Object.keys(body).length ? body : undefined,
        key: t.id,
        meta: { type: "upgrade", containerId: t.id },
      });
    }
    close();
  };

  return (
    <Show when={props.targets?.length}>
      <Modal open onClose={close} title={multi() ? `批量升级（${props.targets!.length} 个容器）` : `升级 — ${props.targets![0].name}`}>
        <p class="mb-3 text-xs text-zinc-500">先按本次选项拉取镜像，成功后再替换容器；已是最新的容器不会被重建；「待重建」的容器直接使用本地镜像，不再拉取。浏览器模式只在预拉成功后调用本地升级。</p>
        <Show
          when={multi()}
          fallback={
            <Show when={check(props.targets![0])}>
              {(c) => (
                <p class="mb-3 flex items-center gap-1.5 text-xs text-zinc-400">
                  上次检查：<UpdateBadge check={c()} showLatest />
                </p>
              )}
            </Show>
          }
        >
          <div class="mb-3 max-h-48 overflow-y-auto border border-zinc-800">
            <For each={props.targets}>
              {(t) => (
                <label class="flex items-center gap-2 border-b border-zinc-800 px-2.5 py-1.5 text-xs last:border-b-0">
                  <input type="checkbox" checked={!skip().has(t.id)} onChange={() => toggle(t.id)} />
                  <span class="min-w-0 truncate text-zinc-200">{t.name}</span>
                  <Show when={t.labels?.[LABEL_PROJECT]}>
                    <span class="shrink-0 text-[10px] text-zinc-500">compose: {t.labels![LABEL_PROJECT]}</span>
                  </Show>
                  <span class="ml-auto" />
                  <UpdateBadge check={check(t)} showLatest />
                </label>
              )}
            </For>
          </div>
        </Show>
        <Show when={Object.keys(envCands()).length > 0}>
          <div class="mb-3 border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs">
            <p class="mb-2 text-amber-400">
              以下环境变量与当前镜像的默认值不同，可能是旧版升级残留的旧镜像值。勾选的变量将改用新镜像的值（新镜像不再定义则移除）；如果是你特意设置的，请取消勾选。
            </p>
            <For each={(props.targets ?? []).filter((t) => envCands()[t.id])}>
              {(t) => (
                <div class="mb-1.5 last:mb-0">
                  <Show when={multi()}><div class="mb-0.5 text-zinc-400">{t.name}</div></Show>
                  <For each={envCands()[t.id]}>
                    {(c) => (
                      <label class="flex min-w-0 items-center gap-2 py-0.5 font-mono text-[11px]">
                        <input type="checkbox" checked={!keepEnv().has(envKey(t.id, c.key))} onChange={() => toggleEnv(envKey(t.id, c.key))} />
                        <span class="shrink-0 text-zinc-200">{c.key}</span>
                        <span class="min-w-0 truncate text-zinc-500" title={`当前：${c.current}\n镜像：${c.image}`}>
                          {c.current} → <span class="text-zinc-300">{c.image}</span>
                        </span>
                      </label>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Show>
        <PullOptions options={pull} allowBrowser multipleRegistries />
        <div class="mt-4 flex justify-end gap-2">
          <Button onClick={close}>取消</Button>
          <Button variant="primary" disabled={chosen().length === 0} onClick={() => void start()}>
            {multi() ? `升级 ${chosen().length} 个` : "升级"}
          </Button>
        </div>
      </Modal>
    </Show>
  );
};
