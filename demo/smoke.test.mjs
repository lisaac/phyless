import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const storage = new Map();
const localStorage = {
  setItem: (key, value) => storage.set(key, value),
  getItem: (key) => storage.get(key) ?? null,
  removeItem: (key) => storage.delete(key),
};
const document = {
  body: { append() {} },
  addEventListener() {},
  createElement: () => ({ style: {} }),
  getElementById: () => null,
};
const location = { href: "https://example.github.io/phyless/", origin: "https://example.github.io", pathname: "/phyless/" };
const window = {
  fetch: async () => new Response("asset"),
  open: () => null,
};
const source = await readFile(new URL("./bootstrap.js", import.meta.url), "utf8");
vm.runInNewContext(source, { window, location, document, localStorage, URL, Request, Response, Date, JSON, Promise, setTimeout, clearTimeout, setInterval, clearInterval });

const containers = window.__phylessDemo.request("GET", "/api/containers").data;
assert.equal(containers.length, 4);
assert.equal(window.__phylessDemo.request("GET", "/api/config/files/content?path=%2Fhostname").text, "phyless-host\n");
await window.__phylessDemo.runTask({ url: "/api/containers/a1b2c3d4e5f6/stop", title: "停止 phyless" });
assert.equal(window.__phylessDemo.request("GET", "/api/containers").data[0].State, "exited");
assert.equal((await window.fetch("https://registry.example/v2/" )).status, 403);
assert.equal(localStorage.getItem("phyless_token"), "demo-token");

console.log("demo mock smoke test passed");
