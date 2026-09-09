import { describe, it } from "vitest";

// ImageListPage 依赖 /api/images、/api/registries 等多路 fetch 与轮询 store。
// 「升级」按钮仅是 setPullRef(RepoTags[0]) + setShowPullInput(true)（均为文件内既有
// 信号），逻辑平凡；为它单独搭建 fetch mock 基建不划算（YAGNI）。改由类型检查 +
// 手动浏览器验证覆盖：镜像行出现 ↑ 升级按钮 → 点击 → 弹出「拉取镜像」→ 输入框已填
// 该 tag → PullOptions 可选服务端/浏览器代理。
describe("ImageListPage 升级按钮", () => {
  it.todo("升级按钮预填镜像 tag 并打开 pull 弹窗（缺 fetch mock 基建，手动验证）");
});
