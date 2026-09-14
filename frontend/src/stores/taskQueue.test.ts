import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("../api/client", () => ({ getToken: () => "token", setToken: vi.fn() }));
vi.mock("../components/shared/Toast", () => ({ toast: { error: toastError } }));

class FakeXHR {
  static requests: FakeXHR[] = [];
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  status = 200;
  responseText = "";
  contentType: string | null = null;
  onload?: () => void;
  onprogress?: () => void;
  onabort?: () => void;
  onerror?: () => void;
  method = ""; url = ""; headers: Record<string, string> = {}; sent: unknown;
  open(m: string, u: string) { this.method = m; this.url = u; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  send(b: unknown) { this.sent = b; }
  getResponseHeader() { return this.contentType; }
  abort = vi.fn(() => this.onabort?.());
  constructor() { FakeXHR.requests.push(this); }
  finish(text: string, status = 200) { this.status = status; this.responseText = text; this.onload?.(); }
}

const load = () => import("./taskQueue");
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { FakeXHR.requests = []; toastError.mockClear(); vi.stubGlobal("XMLHttpRequest", FakeXHR); localStorage.clear(); vi.resetModules(); });
afterEach(() => vi.unstubAllGlobals());

describe("taskQueue scheduling", () => {
  it("counts only running tasks and decreases as they finish", async () => {
    const q = await load();
    const a = q.enqueue({ title: "a", url: "/a" });
    const b = q.enqueue({ title: "b", url: "/b" });

    expect(q.runningCount()).toBe(2);
    FakeXHR.requests[0].finish("");
    await a.done;
    expect(q.runningCount()).toBe(1);
    FakeXHR.requests[1].finish("");
    await b.done;
    expect(q.runningCount()).toBe(0);
  });

  it("announces new tasks without opening the drawer", async () => {
    const q = await load();
    const announced: string[] = [];
    const onEnqueued = (e: Event) => announced.push((e as CustomEvent<{ id: string }>).detail.id);
    window.addEventListener(q.ENQUEUED_EVENT, onEnqueued);

    const { id } = q.enqueue({ title: "a", url: "/a" });

    expect(q.panelHidden()).toBe(true);
    expect(announced).toEqual([id]);
    window.removeEventListener(q.ENQUEUED_EVENT, onEnqueued);
  });

  it("serializes tasks sharing a key and runs different keys concurrently", async () => {
    const q = await load();
    const a = q.enqueue({ title: "a", url: "/a", key: "k" });
    const b = q.enqueue({ title: "b", url: "/b", key: "k" });
    const c = q.enqueue({ title: "c", url: "/c", key: "other" });
    expect(FakeXHR.requests.map((r) => r.url)).toEqual(["/a", "/c"]);
    expect(q.tasks.list.find((t) => t.id === b.id)?.status).toBe("queued");
    FakeXHR.requests[0].finish('{"status":"done"}\n');
    expect(FakeXHR.requests.map((r) => r.url)).toEqual(["/a", "/c", "/b"]);
    expect((await a.done).status).toBe("done");
    expect(q.tasks.list.find((t) => t.id === c.id)?.status).toBe("running");
  });

  it("cancels a queued task without starting it", async () => {
    const q = await load();
    q.enqueue({ title: "a", url: "/a", key: "k" });
    const b = q.enqueue({ title: "b", url: "/b", key: "k" });
    q.cancel(b.id);
    expect((await b.done).status).toBe("cancelled");
    FakeXHR.requests[0].finish("");
    expect(FakeXHR.requests).toHaveLength(1);
  });

  it("cancels running and queued work without sending queued work to a new server", async () => {
    const q = await load();
    const running = q.enqueue({ title: "running", url: "/running", key: "server" });
    const queued = q.enqueue({ title: "queued", url: "/queued", key: "server" });

    q.cancelActiveTasks();

    expect(FakeXHR.requests).toHaveLength(1);
    expect((await running.done).status).toBe("cancelled");
    expect((await queued.done).status).toBe("cancelled");
  });
});

describe("taskQueue outcomes", () => {
  it.each([
    '{"id":"layer","status":"Pull complete","errorDetail":{"message":"denied"}}',
    '{"error":"denied"}',
    '{"id":"layer","status":"done","errorDetail":{"code":403}}',
    "null", "invalid JSON",
  ])("does not report HTTP 200 errors as success: %s", async (line) => {
    const q = await load();
    const { done } = q.enqueue({ title: "pull", url: "/pull" });
    FakeXHR.requests[0].finish(line);
    expect((await done).status).toBe("error");
  });

  it("captures layers, notes and the resulting container id", async () => {
    const q = await load();
    const { id, done } = q.enqueue({ title: "up", url: "/upgrade" });
    FakeXHR.requests[0].finish('{"id":"abc","status":"Downloading","progressDetail":{"current":1,"total":2}}\n{"stream":"done","container_id":"new-container"}\n');
    const t = await done;
    expect(t.status).toBe("done");
    expect(t.containerId).toBe("new-container");
    expect(q.tasks.list.find((x) => x.id === id)?.layers).toEqual([{ id: "abc", status: "Downloading", current: 1, total: 2 }]);
    expect(q.tasks.list.find((x) => x.id === id)?.notes).toEqual(["done"]);
  });

  it("treats a plain JSON write as success unless it carries an error", async () => {
    const q = await load();
    const ok = q.queued("create", "POST", "/api/networks", { name: "n" });
    FakeXHR.requests[0].contentType = "application/json";
    FakeXHR.requests[0].finish('{"id":"net123"}');
    await expect(ok).resolves.toBeUndefined();
    expect(q.tasks.list[0].layers).toEqual([]);
    const bad = q.queued("create", "POST", "/api/networks");
    FakeXHR.requests[1].contentType = "application/json";
    FakeXHR.requests[1].finish('{"error":"exists"}');
    await expect(bad).rejects.toThrow("exists");
    const http = q.queued("del", "DELETE", "/x");
    FakeXHR.requests[2].finish("boom", 500);
    await expect(http).rejects.toThrow("boom");
    const httpJson = q.queued("start", "POST", "/y");
    FakeXHR.requests[3].finish('{"error":"port already allocated"}', 500);
    await expect(httpJson).rejects.toThrow("port already allocated");
  });

  it("sends the right method, content type and body", async () => {
    const q = await load();
    q.enqueue({ title: "raw", method: "PUT", url: "/f", body: "text body" });
    q.enqueue({ title: "json", url: "/j", body: { a: 1 } });
    q.enqueue({ title: "del", method: "DELETE", url: "/d" });
    const [raw, json, del] = FakeXHR.requests;
    expect([raw.method, raw.headers["Content-Type"], raw.sent]).toEqual(["PUT", "text/plain", "text body"]);
    expect([json.method, json.headers["Content-Type"], json.sent]).toEqual(["POST", "application/json", '{"a":1}']);
    expect([del.method, del.sent]).toEqual(["DELETE", undefined]);
  });

  it("marks an aborted request cancelled and dispatches the settled event", async () => {
    const q = await load();
    const seen: string[] = [];
    window.addEventListener(q.SETTLED_EVENT, (e) => seen.push((e as CustomEvent).detail.status));
    const { id, done } = q.enqueue({ title: "pull", url: "/pull" });
    q.cancel(id);
    expect((await done).status).toBe("cancelled");
    expect(seen).toEqual(["cancelled"]);
  });

  it("fails before retaining an unbounded progress response", async () => {
    const q = await load();
    const { done } = q.enqueue({ title: "pull", url: "/pull" });
    FakeXHR.requests[0].finish("x".repeat(2 * 1024 * 1024 + 1));
    const t = await done;
    expect([t.status, t.error]).toEqual(["error", "进度响应过大"]);
  });

  it("logs out on 401", async () => {
    const q = await load();
    const client = await import("../api/client");
    const unauthorized = vi.fn();
    window.addEventListener("phyless:unauthorized", unauthorized);
    const { done } = q.enqueue({ title: "x", url: "/x" });
    FakeXHR.requests[0].finish("", 401);
    expect((await done).status).toBe("error");
    expect(client.setToken).toHaveBeenCalledWith(null);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it("notifies an unseen failure until the task panel is opened", async () => {
    const q = await load();
    const { done } = q.enqueue({ title: "pull", url: "/pull" });
    FakeXHR.requests[0].finish('{"error":"registry denied"}\n');

    await expect(done).resolves.toMatchObject({ status: "error", error: "registry denied" });
    expect(toastError).toHaveBeenCalledWith("registry denied");
    expect(q.unseenFailureCount()).toBe(1);
    q.showTaskPanel();
    expect(q.unseenFailureCount()).toBe(0);
  });
});

describe("taskQueue persistence", () => {
  it("persists status without file/body/layers and marks in-flight tasks interrupted on reload", async () => {
    const q = await load();
    const file = new File(["x"], "a.tar");
    const running = q.enqueue({ title: "load", url: "/load", file, meta: { type: "load" } });
    const finished = q.enqueue({ title: "pull", url: "/pull", body: { image: "nginx" } });
    FakeXHR.requests[1].finish('{"id":"l","status":"Downloading","progressDetail":{"current":1,"total":2}}\n');
    await finished.done;
    const stored = JSON.parse(localStorage.getItem("phyless_tasks")!);
    expect(stored).toHaveLength(2);
    expect(stored[0]).not.toHaveProperty("file");
    expect(stored[1]).not.toHaveProperty("body");
    expect(stored[1].layers).toEqual([]);
    expect(stored[0].status).toBe("running");

    vi.resetModules();
    const q2 = await load();
    const byId = Object.fromEntries(q2.tasks.list.map((t) => [t.id, t.status]));
    expect(byId[running.id]).toBe("interrupted");
    expect(byId[finished.id]).toBe("done");
    await flush();
  });

  it("keeps detailed targets while stripping request bodies and secrets", async () => {
    const q = await load();
    q.enqueue({
      title: "delete images", url: "/api/images/delete",
      body: { ids: ["sha256:a", "sha256:b"], force: true, password: "never-store-this" },
      meta: { type: "image-delete", images: ["nginx:latest", "redis:7"] },
    });
    const detail = q.tasks.list[0].details;
    expect(detail).toContainEqual({ label: "镜像", value: ["nginx:latest", "redis:7"] });
    expect(detail).toContainEqual({ label: "镜像 ID", value: ["sha256:a", "sha256:b"] });
    expect(detail).toContainEqual({ label: "强制", value: "是" });
    expect(JSON.stringify(detail)).not.toContain("never-store-this");
    expect(JSON.stringify(localStorage.getItem("phyless_tasks"))).not.toContain("never-store-this");
  });

  it("does not retain Docker TLS PEM text in task details", async () => {
    const q = await load();
    q.enqueue({
      title: "save Docker", url: "/api/settings/docker", method: "PUT",
      body: { host: "tcp://docker.example:2376", tls: true, key_pem: "never-store-this" },
    });
    expect(JSON.stringify(q.tasks.list[0].details)).not.toContain("never-store-this");
    expect(localStorage.getItem("phyless_tasks")).not.toContain("never-store-this");
  });
});
