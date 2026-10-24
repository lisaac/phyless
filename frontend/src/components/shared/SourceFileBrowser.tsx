import { Component, createSignal } from "solid-js";
import { FileBrowser } from "./FileBrowser";
import { TarTextViewer } from "./TarTextViewer";
import { createDownloadTask } from "../../api/download";
import { confirmOpenText } from "../../api/textFile";
import { fileSource, type FileSourceRef } from "../../api/fileSources";
import { hasRole } from "../../stores/auth";

// FileBrowser fully wired from a (kind, id) file source: download, open-file
// in the read-only tar viewer, and (with `writable`) operator file actions.
// The one place list-page modals and the standalone window get their file
// behaviour from, so every "文件" browser opens files the same way.
// `download` is owned by the caller so a transfer outlives the modal.
export const SourceFileBrowser: Component<{
  src: FileSourceRef;
  download: ReturnType<typeof createDownloadTask>;
  writable?: boolean;
  initialPath?: string;
  onPathChange?: (path: string) => void;
  noPopout?: boolean; // already inside the standalone window
  stopped?: boolean; // container not running: writes only inside its mounts
}> = (props) => {
  const src = () => fileSource(props.src.kind, props.src.id, { stopped: props.stopped });
  const op = () => !!props.writable && hasRole("operator");
  const [viewPath, setViewPath] = createSignal<string | null>(null);
  const viewUrl = () => { const p = viewPath(); return p ? src().downloadUrl(p) : null; };

  return (
    <>
      <FileBrowser
        instanceKey={`${props.src.kind}:${props.src.id}`}
        initialPath={props.initialPath}
        onPathChange={props.onPathChange}
        listPath={(sub) => src().listPath(sub)}
        listDiff={src().listDiff}
        listMarks={src().listMarks}
        onDownload={(sub, n) => props.download.start(src().downloadUrl(sub), `${n}.tar`)}
        onOpenFile={async (p) => { if (await confirmOpenText(p)) setViewPath(p); }}
        onUpload={op() ? src().upload : undefined}
        onCreate={op() ? src().create : undefined}
        onDelete={op() ? src().remove : undefined}
        onRename={op() ? src().rename : undefined}
        onChmod={op() ? src().chmod : undefined}
        mountsOnly={src().mountsOnly}
        popout={props.noPopout ? undefined : props.src}
      />
      <TarTextViewer url={viewUrl()} path={viewPath() ?? ""} onClose={() => setViewPath(null)} />
    </>
  );
};
