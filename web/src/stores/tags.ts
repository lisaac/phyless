import { createSignal } from "solid-js";
import { get, post, put, del } from "../api/client";
import type { Tag } from "../types";

const [tags, setTags] = createSignal<Tag[]>([]);
export { tags };

export async function refreshTags(): Promise<void> {
  setTags(await get<Tag[]>("/api/tags"));
}

export async function createTag(name: string, color?: string): Promise<Tag> {
  const t = await post<Tag>("/api/tags", { name, color });
  await refreshTags();
  return t;
}

export async function updateTag(id: string, patch: { name?: string; color?: string }): Promise<void> {
  await put(`/api/tags/${encodeURIComponent(id)}`, patch);
  await refreshTags();
}

export async function deleteTag(id: string): Promise<void> {
  await del(`/api/tags/${encodeURIComponent(id)}`);
  await refreshTags();
}

export async function bindingsFor(resourceType: "container" | "image", resourceId: string): Promise<string[]> {
  return get<string[]>(
    `/api/tag-bindings?resource_type=${resourceType}&resource_id=${encodeURIComponent(resourceId)}`
  );
}

export async function bindTag(tagId: string, resourceType: "container" | "image", resourceId: string): Promise<void> {
  await post("/api/tag-bindings", { tag_id: tagId, resource_type: resourceType, resource_id: resourceId });
  await refreshTags();
}

export async function unbindTag(tagId: string, resourceType: "container" | "image", resourceId: string): Promise<void> {
  await del(
    `/api/tag-bindings?tag_id=${encodeURIComponent(tagId)}&resource_type=${resourceType}&resource_id=${encodeURIComponent(resourceId)}`
  );
  await refreshTags();
}
