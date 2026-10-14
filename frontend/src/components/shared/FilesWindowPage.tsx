import { Component, createEffect, createResource, onCleanup, Show } from "solid-js";
import { useParams, useSearchParams } from "@solidjs/router";
import { SourceFileBrowser } from "./SourceFileBrowser";
import { DownloadStatusWidget } from "./UploadStatusWidget";
import { createDownloadTask } from "../../api/download";
import type { FileSourceKind } from "../../api/fileSources";
import { currentUser } from "../../stores/auth";
import { get } from "../../api/client";
import { findContainer } from "../containers/containerActions";
import type { ContainerSummary, ImageSummary } from "../../types";
import { InfoBar, Info, ContainerInfo, ImageInfo, ImageInspectModal } from "./Inspect";

// Standalone file-browser window, the file-side twin of TerminalWindowPage:
// a top-level route outside Guard/Layout, opened via FileBrowser's "独立窗口"
// button. Handlers are rebuilt from (kind, id) by SourceFileBrowser; files open
// in the read-only tar viewer (editing stays in the main window's editor).
const KIND_LABEL: Record<FileSourceKind, string> = {
  container: "容器", image: "镜像", volume: "存储卷", compose: "Compose", config: "本机配置",
};

export const FilesWindowPage: Component = () => {
  const params = useParams();
  const [search, setSearch] = useSearchParams();
  const kind = () => params.kind as FileSourceKind;
  // Router params stay percent-encoded (an image id "sha256:…" arrives as
  // "sha256%3A…"); fileSource encodes again, so decode once here.
  const id = () => decodeURIComponent(params.id);
  const name = () => (search.name as string) || id();

  createEffect(() => { document.title = `文件 · ${name()}`; });

  // Container/image basic info for the header strip; other kinds (and a
  // failed lookup) fall back to just the kind + name.
  const [container] = createResource(() => (kind() === "container" ? id() : null), (cid) =>
    get<ContainerSummary[]>("/api/containers").then((all) => findContainer(all, cid)).catch(() => undefined));
  const [image] = createResource(() => (kind() === "image" ? id() : null), (iid) =>
    get<ImageSummary[]>("/api/images").then((all) => all.find((i) => i.Id === iid)).catch(() => undefined));

  const download = createDownloadTask();
  onCleanup(() => download.cancel());

  return (
    <Show when={currentUser()} fallback={<p class="p-8 text-sm text-zinc-500">未登录，请先在主窗口登录。</p>}>
      <div class="min-h-screen bg-zinc-950 p-3">
        {/* Same info strip as the in-page 文件 / Inspect modals. */}
        <Show when={kind() === "container" && container()} fallback={
          <Show when={kind() === "image" && image()} fallback={
            <InfoBar kind={KIND_LABEL[kind()] ?? kind()}>
              {/* 本机配置 has no name/id of its own — the label says it all. */}
              <Show when={kind() !== "config"}>
                <Info k="名称" title={name()}>{name()}</Info>
                <Show when={id() !== name()}><Info k="ID" title={id()}>{id()}</Info></Show>
              </Show>
            </InfoBar>
          }>
            {(img) => <ImageInfo img={img()} />}
          </Show>
        }>
          {(c) => <ContainerInfo c={c()} />}
        </Show>
        <SourceFileBrowser
          src={{ kind: kind(), id: id(), name: name() }}
          download={download}
          writable
          noPopout
          initialPath={(search.path as string) || "/"}
          onPathChange={(path) => setSearch({ path }, { replace: true })}
        />
      </div>
      <DownloadStatusWidget task={download} />
      <ImageInspectModal />
    </Show>
  );
};
