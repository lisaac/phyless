export interface FileTarget { id: string; path: string; }

export interface FileRequest {
  target: FileTarget;
  generation: number;
  signal: AbortSignal;
}

export function canSaveFile(
  loaded: FileTarget | undefined,
  selected: FileTarget,
  loading: boolean,
  error: string,
  truncated: boolean,
): boolean {
  return Boolean(loaded && !loading && !error && !truncated
    && loaded.id === selected.id && loaded.path === selected.path);
}

// One small request guard for editors that can change target while a file is
// still loading. Starting a request aborts the previous one; the generation
// check remains necessary for fetchers that resolve after aborting.
export function createLatestFileRequest() {
  let generation = 0;
  let controller: AbortController | undefined;

  const begin = (target: FileTarget): FileRequest => {
    controller?.abort();
    const next = new AbortController();
    controller = next;
    return { target, generation: ++generation, signal: next.signal };
  };
  const isCurrent = (request: FileRequest) => request.generation === generation;
  const cancel = () => {
    generation++;
    controller?.abort();
    controller = undefined;
  };

  return { begin, isCurrent, cancel };
}
