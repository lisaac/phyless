# Compose Update 与 容器/镜像列表升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Compose 项目加「Update」(build→pull→down→up，兼顾服务端/浏览器代理)，并给容器、镜像列表加复用式「升级」按键。

**Architecture:** 纯前端。Update 作为单个客户端编排任务 (`meta.type="compose-update"`)，在 `browserPull.ts` 里顺序 await 现有 compose 端点，失败即停。从现有 `runBrowserPullCompose` 抽出 `streamCompose`/`preloadComposeImages` 复用。容器升级模态从 `ContainerDetailPage` 抽为共享组件供列表复用；镜像升级复用现有 pull 弹窗。零后端改动。

**Tech Stack:** SolidJS + TypeScript + Vitest。测试命令 `npm test`（=`vitest run`），类型检查 `npm run typecheck`。全部命令在 `web/` 目录运行。

## Global Constraints

- 所有命令 cwd = `/path/to/repo/web`。
- 分支 `feat/compose-update-list-upgrade`（已创建）。
- UI 文案中文；沿用现有 `Btn`/`IBtn`/`ActBtn`/`Modal`/`PullOptions` 组件，不新造样式。
- 共享 UI 只能有一份实现（模态放页面级，行只发回调，禁止每行 `createPullOptions`）。
- Update 末步 `up` 强制 `pull_policy=never`；build 步不带代理载荷（与现有 Build 一致）。
- 提交信息结尾加：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- 每个任务末尾 `npm run typecheck` 必须通过。

---

### Task 1: 抽取 `streamCompose` 与 `preloadComposeImages`，重连 `runBrowserPullCompose`

**Files:**
- Modify: `web/src/stores/browserPull.ts`（`composeUpNever` → `streamCompose`；抽 `preloadComposeImages`；`runBrowserPullCompose` 复用两者）
- Test: `web/src/stores/browserPull.test.ts`（新增，仅测 `streamCompose`）；`web/src/stores/browserPullCompose.test.ts`（保持通过）

**Interfaces:**
- Produces:
  - `streamCompose(verb: string, id: string, opts: { body?: unknown; token: string; onProgress?: (line: string) => void; signal: AbortSignal }): Promise<void>`
  - `preloadComposeImages(images: { service: string; ref: string; platform?: string }[], opts: { workerUrl: string; token: string; creds?: Creds }, cb: BrowserPullCallbacks, runPull: (p: BrowserPullParams, cb: BrowserPullCallbacks) => Promise<void>): Promise<void>`

- [ ] **Step 1: 写 `streamCompose` 的失败测试**

新建 `web/src/stores/browserPull.test.ts`：

```ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { streamCompose } from "./browserPull";

afterEach(() => vi.unstubAllGlobals());

const sig = () => new AbortController().signal;

describe("streamCompose", () => {
  it("throws on an error event line", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }) + "\n", { status: 200 })));
    await expect(streamCompose("pull", "1", { token: "t", signal: sig() })).rejects.toThrow(/boom/);
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(streamCompose("down", "1", { token: "t", signal: sig() })).rejects.toThrow(/失败（500）/);
  });

  it("resolves on a clean stream and forwards progress lines", async () => {
    const onProgress = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ stream: "ok" }) + "\n", { status: 200 })));
    await expect(streamCompose("up", "1", { body: { pull_policy: "never" }, token: "t", onProgress, signal: sig() })).resolves.toBeUndefined();
    expect(onProgress).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- browserPull.test.ts`
Expected: FAIL —「streamCompose is not exported / not a function」。

- [ ] **Step 3: 实现 `streamCompose` 与 `preloadComposeImages`，重连 `runBrowserPullCompose`**

在 `browserPull.ts` 中，用下面的 `streamCompose` 取代现有 `composeUpNever`（约 122-151 行），并在其后加 `preloadComposeImages`：

```ts
// Generic compose command streamer: POST /api/compose/<verb>, parse NDJSON,
// throw on an error event or non-ok status. Body/Content-Type only when a body
// is given (matches the XHR path — a bodyless verb sends no Content-Type).
export async function streamCompose(
  verb: string,
  id: string,
  opts: { body?: unknown; token: string; onProgress?: (line: string) => void; signal: AbortSignal },
): Promise<void> {
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}` };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(`/api/compose/${verb}?id=${encodeURIComponent(id)}`, {
    method: "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (!resp.ok || !resp.body) throw new Error(`Compose ${verb} 失败（${resp.status}）`);
  const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      opts.onProgress?.(s);
      try {
        const evt = JSON.parse(s) as { error?: string; errorDetail?: { message?: string } };
        if (evt.error || evt.errorDetail) throw new Error(evt.error || evt.errorDetail?.message || `Compose ${verb} 失败`);
      } catch (e) {
        if (e instanceof SyntaxError) continue; // non-JSON progress line
        throw e;
      }
    }
  }
}

// Browser-preload a list of already-resolved service images (loops runBrowserPull).
// Reject policy stays with the caller — this only pulls what it is handed.
export async function preloadComposeImages(
  images: { service: string; ref: string; platform?: string }[],
  opts: { workerUrl: string; token: string; creds?: Creds },
  cb: BrowserPullCallbacks,
  runPull: (params: BrowserPullParams, cb: BrowserPullCallbacks) => Promise<void>,
): Promise<void> {
  for (const img of images) {
    cb.note(`拉取 ${img.service}：${img.ref}`);
    await runPull(
      { ref: img.ref, platform: img.platform ?? "", workerUrl: opts.workerUrl, token: opts.token, creds: opts.creds },
      { note: cb.note, progress: cb.progress, signal: cb.signal },
    );
  }
}
```

然后把 `runBrowserPullCompose`（约 159-183 行）的循环与 up 改为复用（reject 语义不变——任一 rejected 即抛）：

```ts
export async function runBrowserPullCompose(
  params: BrowserPullComposeParams,
  cb: BrowserPullCallbacks,
  deps: BrowserPullComposeDeps = defaultComposeDeps,
): Promise<void> {
  cb.note("解析 Compose 项目镜像…");
  const plan = await deps.fetchPlan(params.id);
  if (plan.rejected.length) {
    const detail = plan.rejected.map((r) => `${r.service}（${rejectReasonText[r.reason] ?? r.reason}）`).join("，");
    throw new Error(`以下服务无法用浏览器下载：${detail}。请改用服务端代理。`);
  }
  await preloadComposeImages(plan.images, { workerUrl: params.workerUrl, token: params.token, creds: params.creds }, cb, deps.runBrowserPull);
  if (params.mode === "up") {
    cb.note("启动 Compose（使用本地镜像）…");
    await deps.composeUp(params.id, params.token, cb.progress, cb.signal);
  } else {
    cb.note("镜像预加载完成");
  }
}
```

最后把 `defaultComposeDeps.composeUp` 改为复用 `streamCompose`，并删除 `composeUpNever`：

```ts
export const defaultComposeDeps: BrowserPullComposeDeps = {
  fetchPlan: (id) => get<ComposePullPlan>(`/api/compose/pull-plan?id=${encodeURIComponent(id)}`),
  runBrowserPull: (params, cb) => runBrowserPull(params, cb),
  composeUp: (id, token, onProgress, signal) => streamCompose("up", id, { body: { pull_policy: "never" }, token, onProgress, signal }),
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- browserPull.test.ts browserPullCompose.test.ts`
Expected: PASS（新 3 条 + 原有 3 条全绿）。

- [ ] **Step 5: 类型检查并提交**

```bash
npm run typecheck
git add src/stores/browserPull.ts src/stores/browserPull.test.ts
git commit -m "refactor(browser-pull): 抽 streamCompose/preloadComposeImages 供复用

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `runComposeUpdate` 编排器

**Files:**
- Modify: `web/src/stores/browserPull.ts`
- Test: `web/src/stores/composeUpdate.test.ts`（新建）

**Interfaces:**
- Consumes: `streamCompose`, `preloadComposeImages`, `ComposePullPlan`, `BrowserPullParams`, `BrowserPullCallbacks`, `Creds`（Task 1）
- Produces:
  - `ComposeUpdateParams = { id: string; mode: "server" | "browser"; canBuild: boolean; workerUrl?: string; token: string; creds?: Creds; pullOptions?: Record<string, unknown> }`
  - `ComposeUpdateDeps = { fetchPlan: (id: string) => Promise<ComposePullPlan>; runBrowserPull: (p: BrowserPullParams, cb: BrowserPullCallbacks) => Promise<void>; streamCompose: typeof streamCompose }`
  - `runComposeUpdate(params: ComposeUpdateParams, cb: BrowserPullCallbacks, deps?: ComposeUpdateDeps): Promise<void>`
  - `defaultUpdateDeps: ComposeUpdateDeps`

- [ ] **Step 1: 写编排器测试**

新建 `web/src/stores/composeUpdate.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { runComposeUpdate, type ComposeUpdateDeps, type ComposePullPlan } from "./browserPull";

function deps(plan: ComposePullPlan, over: Partial<ComposeUpdateDeps> = {}): ComposeUpdateDeps {
  return {
    fetchPlan: vi.fn(async () => plan),
    runBrowserPull: vi.fn(async () => {}),
    streamCompose: vi.fn(async () => {}),
    ...over,
  };
}
const cb = () => ({ note: vi.fn(), progress: vi.fn(), signal: new AbortController().signal });
const verbs = (sc: ReturnType<typeof vi.fn>) => sc.mock.calls.map((c) => c[0]);

describe("runComposeUpdate", () => {
  it("server mode runs build→pull→down→up(never) in order", async () => {
    const d = deps({ images: [], rejected: [] });
    await runComposeUpdate({ id: "1", mode: "server", canBuild: true, token: "t", pullOptions: { proxy_url: "http://p" } }, cb(), d);
    const sc = d.streamCompose as ReturnType<typeof vi.fn>;
    expect(verbs(sc)).toEqual(["build", "pull", "down", "up"]);
    expect(sc.mock.calls[1][2]).toMatchObject({ body: { proxy_url: "http://p" } }); // pull carries proxy opts
    expect(sc.mock.calls[3][2]).toMatchObject({ body: { pull_policy: "never" } }); // up forces never
    expect(d.runBrowserPull).not.toHaveBeenCalled();
    expect(d.fetchPlan).not.toHaveBeenCalled();
  });

  it("skips build when canBuild is false", async () => {
    const d = deps({ images: [], rejected: [] });
    await runComposeUpdate({ id: "1", mode: "server", canBuild: false, token: "t" }, cb(), d);
    expect(verbs(d.streamCompose as ReturnType<typeof vi.fn>)).toEqual(["pull", "down", "up"]);
  });

  it("stops after a failed build — never reaches down/up", async () => {
    const streamCompose = vi.fn(async (verb: string) => { if (verb === "build") throw new Error("build boom"); });
    const d = deps({ images: [], rejected: [] }, { streamCompose });
    await expect(runComposeUpdate({ id: "1", mode: "server", canBuild: true, token: "t" }, cb(), d)).rejects.toThrow(/build boom/);
    expect(verbs(streamCompose)).toEqual(["build"]);
  });

  it("browser mode: build server-side, preload pull images, then down→up(never)", async () => {
    const d = deps({ images: [{ service: "web", ref: "nginx:1" }], rejected: [{ service: "api", ref: "", reason: "build" }] });
    await runComposeUpdate({ id: "1", mode: "browser", canBuild: true, workerUrl: "https://w", token: "tok" }, cb(), d);
    expect(verbs(d.streamCompose as ReturnType<typeof vi.fn>)).toEqual(["build", "down", "up"]); // no server pull in browser mode
    expect(d.runBrowserPull).toHaveBeenCalledTimes(1); // preloaded the one pullable image
    expect((d.runBrowserPull as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ ref: "nginx:1", workerUrl: "https://w" });
  });

  it("browser mode: digest-rejected service aborts before any pull", async () => {
    const d = deps({ images: [{ service: "web", ref: "nginx:1" }], rejected: [{ service: "db", ref: "x@sha256:...", reason: "digest" }] });
    await expect(runComposeUpdate({ id: "1", mode: "browser", canBuild: false, workerUrl: "https://w", token: "t" }, cb(), d)).rejects.toThrow(/无法用浏览器下载/);
    expect(d.runBrowserPull).not.toHaveBeenCalled();
    expect(d.streamCompose).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- composeUpdate.test.ts`
Expected: FAIL —「runComposeUpdate is not exported」。

- [ ] **Step 3: 实现 `runComposeUpdate`**

在 `browserPull.ts` 末尾追加：

```ts
// --- Compose update: build → pull/preload → down → up(never) ---
// One task, sequential, stop-on-failure. Covers both proxy modes: server pull
// (proxy opts in body) or browser preload (CF worker). build services in browser
// mode are handled server-side by the build step, so only non-"build" rejections
// (e.g. digest-pinned) abort the browser path.
// ponytail: browser mode + a build service whose FROM base is not local and the
// daemon can't reach the registry will fail at `compose build`. Pre-existing limit
// (today's Build button too). Upgrade path: browser-preload the FROM base first.

export interface ComposeUpdateParams {
  id: string;
  mode: "server" | "browser";
  canBuild: boolean;
  workerUrl?: string;
  token: string;
  creds?: Creds;
  pullOptions?: Record<string, unknown>;
}

export interface ComposeUpdateDeps {
  fetchPlan: (id: string) => Promise<ComposePullPlan>;
  runBrowserPull: (params: BrowserPullParams, cb: BrowserPullCallbacks) => Promise<void>;
  streamCompose: typeof streamCompose;
}

export const defaultUpdateDeps: ComposeUpdateDeps = {
  fetchPlan: (id) => get<ComposePullPlan>(`/api/compose/pull-plan?id=${encodeURIComponent(id)}`),
  runBrowserPull: (params, cb) => runBrowserPull(params, cb),
  streamCompose,
};

export async function runComposeUpdate(
  params: ComposeUpdateParams,
  cb: BrowserPullCallbacks,
  deps: ComposeUpdateDeps = defaultUpdateDeps,
): Promise<void> {
  const { id, token, signal } = { id: params.id, token: params.token, signal: cb.signal };

  if (params.canBuild) {
    cb.note("构建镜像…");
    await deps.streamCompose("build", id, { token, onProgress: cb.progress, signal });
  }

  if (params.mode === "browser") {
    cb.note("解析 Compose 项目镜像…");
    const plan = await deps.fetchPlan(id);
    const blocked = plan.rejected.filter((r) => r.reason !== "build");
    if (blocked.length) {
      const detail = blocked.map((r) => `${r.service}（${rejectReasonText[r.reason] ?? r.reason}）`).join("，");
      throw new Error(`以下服务无法用浏览器下载：${detail}。请改用服务端代理。`);
    }
    await preloadComposeImages(plan.images, { workerUrl: params.workerUrl ?? "", token, creds: params.creds }, cb, deps.runBrowserPull);
  } else {
    cb.note("拉取镜像…");
    await deps.streamCompose("pull", id, { body: params.pullOptions, token, onProgress: cb.progress, signal });
  }

  cb.note("停止并移除旧容器…");
  await deps.streamCompose("down", id, { token, onProgress: cb.progress, signal });

  cb.note("启动 Compose（使用本地镜像）…");
  await deps.streamCompose("up", id, { body: { pull_policy: "never" }, token, onProgress: cb.progress, signal });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- composeUpdate.test.ts`
Expected: PASS（5 条全绿）。

- [ ] **Step 5: 类型检查并提交**

```bash
npm run typecheck
git add src/stores/browserPull.ts src/stores/composeUpdate.test.ts
git commit -m "feat(compose): runComposeUpdate 编排 build/pull/down/up

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: taskQueue 分发 `compose-update`

**Files:**
- Modify: `web/src/stores/taskQueue.ts`（import `runComposeUpdate`；`start()` 加分发；加 `startComposeUpdate`）

**Interfaces:**
- Consumes: `runComposeUpdate`, `ComposeUpdateParams`（Task 2）
- 任务约定：`meta = { type: "compose-update", composeId, mode: "server"|"browser", canBuild: boolean, workerUrl? }`；服务端代理载荷放 `body`；浏览器凭据放 `secret.creds`。

- [ ] **Step 1: 改 import（约第 4 行）**

```ts
import { runBrowserPull, runBrowserPullCompose, runComposeUpdate } from "./browserPull";
```

- [ ] **Step 2: `start()` 加分发（在现有两行 browser-pull 分发之后，约 255 行）**

```ts
  if (t.meta?.type === "browser-pull-compose") { startBrowserPullCompose(id); return; }
  if (t.meta?.type === "compose-update") { startComposeUpdate(id); return; }
```

- [ ] **Step 3: 加 `startComposeUpdate`（紧挨 `startBrowserPullCompose` 之后）**

```ts
// startComposeUpdate orchestrates build → pull/preload → down → up(never) as one
// task. body holds the server-mode proxy payload; secret.creds the browser creds.
function startComposeUpdate(id: string) {
  const t = find(id)!;
  const ac = new AbortController();
  browserAborts.set(id, ac);
  const note = (m: string) =>
    setTasks("list", (x) => x.id === id, "notes", (n) => [...n, m.slice(0, MAX_ERROR)].slice(-MAX_NOTES));
  runComposeUpdate(
    {
      id: String(t.meta?.composeId ?? ""),
      mode: t.meta?.mode === "browser" ? "browser" : "server",
      canBuild: t.meta?.canBuild === true,
      workerUrl: String(t.meta?.workerUrl ?? ""),
      token: getToken() ?? "",
      creds: t.secret?.creds,
      pullOptions: (t.body as Record<string, unknown> | undefined) ?? undefined,
    },
    { note, progress: note, signal: ac.signal },
  ).then(
    () => settle(id, "done"),
    (err) => settle(id, ac.signal.aborted ? "cancelled" : "error", err instanceof Error ? err.message : String(err)),
  );
}
```

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`
Expected: typecheck 通过；现有测试全绿（本任务无新测试——分发是 3 行，仿现有 `browser-pull-compose`，由后续 Task 4 的入队测试与手动验证覆盖）。

- [ ] **Step 5: 提交**

```bash
git add src/stores/taskQueue.ts
git commit -m "feat(queue): 分发 compose-update 编排任务

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: composeShared 增 `update` 动词；ComposeActionModal 增 update 分支

**Files:**
- Modify: `web/src/components/compose/composeShared.tsx`（`ComposeVerb` + `VERB_LABEL`）
- Modify: `web/src/components/compose/ComposeActionModal.tsx`（`ComposeAction.canBuild`；`requestComposeAction`；`start()`；隐藏 update 的 pull_policy 选择器）
- Test: `web/src/components/compose/ComposeActionModal.test.tsx`

**Interfaces:**
- Consumes: taskQueue 约定（Task 3）
- Produces: `ComposeAction = { id: string; name: string; verb: ComposeVerb; canBuild?: boolean }`；`ComposeVerb` 含 `"update"`。

- [ ] **Step 1: 看现有入队测试的断言风格**

Run: `cat src/components/compose/ComposeActionModal.test.tsx`
用途：沿用其 mock `enqueue`/渲染方式，避免风格漂移。

- [ ] **Step 2: 写 update 的失败测试**

在 `ComposeActionModal.test.tsx` 追加两条（沿用文件既有的 render/mock helper；下面示意断言，按文件现有工具改写调用形式）：

```ts
// server mode: enqueue meta.type=compose-update, mode=server, body=proxy payload
it("update (server proxy) enqueues a compose-update task with proxy body", async () => {
  // render <ComposeActionModal target={{ id: "1", name: "app", verb: "update", canBuild: true }} .../>
  // 填一个 proxy_url，点击「Update」
  // expect enqueue 收到 { meta: { type: "compose-update", composeId: "1", mode: "server", canBuild: true }, body: { proxy_url: ... } }
});

// update modal must NOT render the pull_policy selector (forced never)
it("update modal hides the pull_policy selector", async () => {
  // render with verb: "update"
  // expect 查询「镜像拉取策略」label 不存在
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test -- ComposeActionModal.test.tsx`
Expected: FAIL（update 未处理 / 仍渲染 pull_policy）。

- [ ] **Step 4: 改 `composeShared.tsx`**

```ts
export type ComposeVerb = "up" | "stop" | "down" | "restart" | "pull" | "build" | "update";
export const VERB_LABEL: Record<ComposeVerb, string> = { up: "Up", stop: "Stop", down: "Down", restart: "Restart", pull: "Pull", build: "Build", update: "Update" };
```

- [ ] **Step 5: 改 `ComposeActionModal.tsx`**

接口加 `canBuild`：

```ts
export interface ComposeAction { id: string; name: string; verb: ComposeVerb; canBuild?: boolean; }
```

`requestComposeAction` 把 update 纳入开弹窗集合：

```ts
export const requestComposeAction = (a: ComposeAction, openOptions: (a: ComposeAction) => void) => {
  if (a.verb === "up" || a.verb === "pull" || a.verb === "update") openOptions(a);
  else void startComposeAction(a);
};
```

`start()` 里，在现有 `isBrowserDownload` 分支中把 update 与浏览器模式合并，并在服务端分支加 update。改写 `start` 为：

```ts
  const start = () => {
    const t = props.target;
    if (!t) return;
    if (isBrowserDownload(pull.value)) {
      if (!pull.value.workerUrl?.trim()) { toast.error("请先填写 CF worker 地址"); return; }
      if (t.verb === "update") {
        enqueue({
          title: `${VERB_LABEL.update} — ${t.name}`,
          url: "",
          key: `compose:${t.id}`,
          meta: { type: "compose-update", composeId: t.id, mode: "browser", canBuild: t.canBuild === true, workerUrl: pull.value.workerUrl ?? "" },
          secret: pull.value.creds?.secret ? { creds: pull.value.creds } : undefined,
        });
      } else {
        enqueue({
          title: `${VERB_LABEL[t.verb]} — ${t.name}`,
          url: "",
          key: `compose:${t.id}`,
          meta: { type: "browser-pull-compose", composeId: t.id, verb: t.verb, mode: t.verb === "up" ? "up" : "pull", workerUrl: pull.value.workerUrl ?? "" },
          secret: pull.value.creds?.secret ? { creds: pull.value.creds } : undefined,
        });
      }
      close();
      return;
    }
    if (t.verb === "update") {
      const opts = pull.payload();
      enqueue({
        title: `${VERB_LABEL.update} — ${t.name}`,
        url: "",
        body: Object.keys(opts).length > 0 ? opts : undefined,
        key: `compose:${t.id}`,
        meta: { type: "compose-update", composeId: t.id, mode: "server", canBuild: t.canBuild === true },
      });
      close();
      return;
    }
    const options = { ...pull.payload(), ...(t.verb === "up" ? { pull_policy: pullPolicy() } : {}) };
    void startComposeAction(t, Object.keys(options).length > 0 ? options : undefined);
    close();
  };
```

pull_policy 选择器的 `Show` 条件加 `t().verb === "up"`（已是 `t().verb === "up" && !isBrowserDownload(...)`，无需改——update 不满足，自然隐藏）。确认该 `Show` 保持 `when={t().verb === "up" && !isBrowserDownload(pull.value)}`。

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test -- ComposeActionModal.test.tsx`
Expected: PASS。

- [ ] **Step 7: 类型检查并提交**

```bash
npm run typecheck
git add src/components/compose/composeShared.tsx src/components/compose/ComposeActionModal.tsx src/components/compose/ComposeActionModal.test.tsx
git commit -m "feat(compose): ComposeActionModal 支持 update 动作

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Compose 详情 + 列表加「Update」按钮

**Files:**
- Modify: `web/src/components/compose/ComposeDetailPage.tsx`（动作栏加 `⬆ Update`）
- Modify: `web/src/components/compose/ComposeListPage.tsx`（项目行动作区加 `⬆`）

**Interfaces:**
- Consumes: `requestComposeAction`（Task 4）、`ComposeAction.canBuild`。

- [ ] **Step 1: 详情页动作栏加按钮**

在 `ComposeDetailPage.tsx` 的动作栏，紧接 Build 的 `Show` 之后（约 262 行 `</Show>` 后、`<span>│</span>` 前）加：

```tsx
          <ActBtn
            title="更新：build（若有）→ pull → down → up"
            loading={isRunning("update")}
            onClick={() => request({ id: id(), name: project()?.name ?? id(), verb: "update", canBuild: servicesHaveBuild(detail()?.services) })}
          >⬆ Update</ActBtn>
```

- [ ] **Step 2: 列表行加按钮**

在 `ComposeListPage.tsx` 的 operator 动作区，紧接 Pull 的 `IBtn` 之后（约 171 行）、`<span>│</span>` 前加：

```tsx
                      <IBtn
                        title="更新：build（若有）→ pull → down → up"
                        loading={isRunning(p.id, "update")}
                        onClick={() => request({ id: p.id, name: p.name, verb: "update", canBuild: p.can_build })}
                      >⬆</IBtn>
```

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`
Expected: 通过、全绿。

- [ ] **Step 4: 提交**

```bash
git add src/components/compose/ComposeDetailPage.tsx src/components/compose/ComposeListPage.tsx
git commit -m "feat(compose): 详情与列表加 Update 按钮

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: 抽 `UpgradeContainerModal`，迁移 ContainerDetailPage

**Files:**
- Create: `web/src/components/containers/UpgradeContainerModal.tsx`
- Modify: `web/src/components/containers/ContainerDetailPage.tsx`（删内联升级逻辑，改用组件）
- Test: `web/src/components/containers/UpgradeContainerModal.test.tsx`（新建）

**Interfaces:**
- Produces: `UpgradeContainerModal: Component<{ target: { id: string; name: string } | null; onClose: () => void }>`；入队 `POST /api/containers/{id}/upgrade`，`meta.type="upgrade"`，`key=id`，body=`pull.payload()`（仅服务端代理）。

- [ ] **Step 1: 写组件测试**

新建 `web/src/components/containers/UpgradeContainerModal.test.tsx`：

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { UpgradeContainerModal } from "./UpgradeContainerModal";

const enqueue = vi.fn();
vi.mock("../../stores/taskQueue", () => ({ enqueue: (s: unknown) => enqueue(s) }));

beforeEach(() => enqueue.mockClear());

describe("UpgradeContainerModal", () => {
  it("enqueues an upgrade task for the target container", async () => {
    const onClose = vi.fn();
    const { getByText } = render(() => <UpgradeContainerModal target={{ id: "abc", name: "web" }} onClose={onClose} />);
    fireEvent.click(getByText("升级"));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      url: "/api/containers/abc/upgrade",
      key: "abc",
      meta: expect.objectContaining({ type: "upgrade", containerId: "abc" }),
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing when target is null", () => {
    const { queryByText } = render(() => <UpgradeContainerModal target={null} onClose={() => {}} />);
    expect(queryByText("升级")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- UpgradeContainerModal.test.tsx`
Expected: FAIL —「Cannot find module ./UpgradeContainerModal」。

- [ ] **Step 3: 实现组件**

新建 `web/src/components/containers/UpgradeContainerModal.tsx`：

```tsx
import { Component, Show } from "solid-js";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { PullOptions, createPullOptions } from "../shared/PullOptions";
import { enqueue } from "../../stores/taskQueue";

// Shared container-upgrade dialog: pull the target's image with the chosen proxy
// options, then replace the container. Page-level (one instance per page); the
// list rows just hand it a target. Server-side proxy only — mirrors the flow the
// detail page has always used.
export const UpgradeContainerModal: Component<{
  target: { id: string; name: string } | null;
  onClose: () => void;
}> = (props) => {
  const pull = createPullOptions();
  const close = () => { pull.reset(); props.onClose(); };
  const start = () => {
    const t = props.target;
    if (!t) return;
    const options = pull.payload();
    enqueue({
      title: `升级 — ${t.name}`,
      url: `/api/containers/${t.id}/upgrade`,
      body: Object.keys(options).length > 0 ? options : undefined,
      key: t.id,
      meta: { type: "upgrade", containerId: t.id },
    });
    close();
  };
  return (
    <Show when={props.target}>
      {(t) => (
        <Modal open onClose={close} title={`升级 — ${t().name}`}>
          <p class="mb-3 text-xs text-zinc-500">先按本次选项拉取镜像，成功后再替换容器；留空则沿用 Docker 默认行为。</p>
          <PullOptions options={pull} />
          <div class="mt-4 flex justify-end gap-2">
            <Button onClick={close}>取消</Button>
            <Button variant="primary" onClick={start}>升级</Button>
          </div>
        </Modal>
      )}
    </Show>
  );
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- UpgradeContainerModal.test.tsx`
Expected: PASS。

- [ ] **Step 5: 迁移 ContainerDetailPage**

改 `ContainerDetailPage.tsx`：

1. 顶部加 import：`import { UpgradeContainerModal } from "./UpgradeContainerModal";`
2. 删除 `showUpgradeOptions`/`upgradePull`（154-155 行）、`closeUpgradeOptions`/`doUpgrade`/`startUpgrade`（223-235 行）。
3. 新增一个 target 信号（放在其它 `createSignal` 附近）：
   ```ts
   const [upgradeTarget, setUpgradeTarget] = createSignal<{ id: string; name: string } | null>(null);
   ```
4. 升级按钮（373 行）改为：
   ```tsx
   <Btn onClick={() => setUpgradeTarget({ id: id(), name: name() })}>↑ 升级</Btn>
   ```
5. 删除内联升级 Modal（741-748 行），改渲染：
   ```tsx
   <UpgradeContainerModal target={upgradeTarget()} onClose={() => setUpgradeTarget(null)} />
   ```
6. 若 `Button`/`PullOptions`/`createPullOptions` 迁移后不再被文件其它处使用，删掉这些 import（用 `npm run typecheck` 的 unused 报错定位；`PullOptions`/`createPullOptions` 很可能可删，`Button` 需确认其它弹窗是否仍用）。

- [ ] **Step 6: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`
Expected: 通过、全绿（含既有 ContainerDetailPage 相关测试）。

- [ ] **Step 7: 提交**

```bash
git add src/components/containers/UpgradeContainerModal.tsx src/components/containers/UpgradeContainerModal.test.tsx src/components/containers/ContainerDetailPage.tsx
git commit -m "refactor(containers): 升级模态抽为共享组件

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: ContainerRow 加 `onUpgrade`；容器列表接入

**Files:**
- Modify: `web/src/components/containers/ContainerRow.tsx`（加可选 `onUpgrade` + 升级按钮）
- Modify: `web/src/components/containers/ContainerListPage.tsx`（渲染 `UpgradeContainerModal`，传 `onUpgrade`）

**Interfaces:**
- Consumes: `UpgradeContainerModal`（Task 6）
- Produces: `ContainerRow` props 增 `onUpgrade?: (target: { id: string; name: string }) => void`。

- [ ] **Step 1: ContainerRow 加 prop 与按钮**

在 `ContainerRow.tsx` 的 props 类型加：

```ts
  onUpgrade?: (target: { id: string; name: string }) => void;
```

在 operator 动作区，`viewBtns()` 之后（约 131 行后）加一个升级按钮（仅在有回调时显示）：

```tsx
            <Show when={p.onUpgrade}>
              <IBtn title="升级（拉取镜像并替换容器）" onClick={() => p.onUpgrade?.({ id: c().Id, name: name() || c().Id.slice(0, 8) })}>↑</IBtn>
            </Show>
```

- [ ] **Step 2: 容器列表接入**

在 `ContainerListPage.tsx`：

1. import：`import { UpgradeContainerModal } from "./UpgradeContainerModal";`
2. 加信号：`const [upgradeTarget, setUpgradeTarget] = createSignal<{ id: string; name: string } | null>(null);`
3. 给每个 `<ContainerRow ...>` 传 `onUpgrade={setUpgradeTarget}`。
4. 在页面 JSX 末尾（其它 Modal 附近）渲染：
   ```tsx
   <UpgradeContainerModal target={upgradeTarget()} onClose={() => setUpgradeTarget(null)} />
   ```

（`ComposeListPage`/`ComposeDetailPage` 的 `ContainerRow` 可暂不接 `onUpgrade`——不传即不显示升级按钮，行为不变；本任务只做容器列表。）

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`
Expected: 通过、全绿。

- [ ] **Step 4: 提交**

```bash
git add src/components/containers/ContainerRow.tsx src/components/containers/ContainerListPage.tsx
git commit -m "feat(containers): 列表行加升级按钮

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: 镜像列表加「升级」按钮（复用 pull 弹窗）

**Files:**
- Modify: `web/src/components/images/ImageListPage.tsx`（每行加升级按钮，预填 ref 开 pull 弹窗）
- Test: `web/src/components/images/ImageListPage.test.tsx`（若不存在则新建，仅测「升级预填 ref」这一行为）

**Interfaces:**
- Consumes: 现有 `setPullRef`/`setShowPullInput`/pull 弹窗。

- [ ] **Step 1: 写测试**

新建/追加 `web/src/components/images/ImageListPage.test.tsx`（若已存在则只加此用例）。仅验证：有 tag 的镜像显示升级按钮，点击后 pull 弹窗打开且输入框值为该 tag。

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { ImageListPage } from "./ImageListPage";

// 复用现有测试对 resource/store 的 mock 方式；若文件已有 setup，沿用之。
// 关键断言：
// 1) 渲染一张 RepoTags=["nginx:1.25"] 的镜像后，存在 title 含「升级」的按钮；
// 2) 点击后出现「拉取镜像」弹窗，且 placeholder 为 nginx:latest 的那个 input 的 value === "nginx:1.25"。
it.todo("升级按钮预填镜像 tag 并打开 pull 弹窗（按文件既有 mock 补全）");
```

> 说明：`ImageListPage` 依赖 `/api/images`、`/api/registries` 等 fetch。若仓库尚无该页测试基建，保留此 `it.todo` 占位并以手动验证为准（见 Step 4 手动检查），不为此单独搭建 fetch mock 基建——YAGNI。

- [ ] **Step 2: 加升级按钮**

在 `ImageListPage.tsx` 每行的 inline actions 区（operator 分支内，`使用此镜像创建容器` 按钮之后，约 379 行后）加：

```tsx
                        <Show when={(img.RepoTags ?? []).length > 0}>
                          <IBtn
                            title="升级：重新拉取该镜像标签"
                            onClick={() => { setPullRef(img.RepoTags![0]); setShowPullInput(true); }}
                          >
                            <Ico path="M12 19V5M5 12l7-7 7 7" />
                          </IBtn>
                        </Show>
```

（`IBtn`/`Ico`/`setPullRef`/`setShowPullInput` 均已在文件中导入/定义。）

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`
Expected: 通过、全绿（`it.todo` 计为待办不算失败）。

- [ ] **Step 4: 手动验证（浏览器）**

Run: `npm run dev`（或用本仓库既有 mock API 预览方式）。检查：镜像行出现 ↑ 升级按钮 → 点击 → 弹出「拉取镜像」→ 输入框已填该 tag → `PullOptions` 可选服务端/浏览器代理。

- [ ] **Step 5: 提交**

```bash
git add src/components/images/ImageListPage.tsx src/components/images/ImageListPage.test.tsx
git commit -m "feat(images): 列表加升级按钮，复用 pull 弹窗

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Compose Update（build→pull→down→up，双代理）→ Task 1（helper）+ Task 2（编排）+ Task 3（分发）+ Task 4（弹窗）+ Task 5（按钮）。✅
- `up` 强制 never → Task 2 实现 + 测试；build 不带代理 → Task 2（build 步无 body）。✅
- 浏览器+build 混合（build 服务端、其余预载、digest 报错）→ Task 2 实现 + 两条测试。✅
- 容器列表升级复用详情 → Task 6（抽共享组件）+ Task 7（行按钮+列表接入）。✅
- 镜像列表升级复用 pull + 代理弹窗 → Task 8。✅
- 共享 UI 单实现、模态页面级 → Task 6/7 明确页面级模态 + 行回调。✅

**Placeholder scan:** Task 8 Step 1 用 `it.todo` 是**刻意**的（缺 fetch mock 基建时不硬造），并配 Step 4 手动验证兜底；其余步骤均含完整代码/命令，无 TBD。

**Type consistency:** `runComposeUpdate` 的 `ComposeUpdateParams` 字段（mode/canBuild/workerUrl/pullOptions）与 Task 3 `startComposeUpdate` 读取的 meta/body/secret 一一对应；`streamCompose` 签名在 Task 1 定义、Task 2 注入一致；`ComposeAction.canBuild` 在 Task 4 定义、Task 5 传入；`UpgradeContainerModal` props 在 Task 6 定义、Task 7 消费一致。✅
