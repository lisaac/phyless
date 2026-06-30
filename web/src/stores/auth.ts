import { createSignal } from "solid-js";
import { login, get, setToken, getToken } from "../api/client";
import { ROLE_LEVEL, type Role, type User } from "../types";

const [currentUser, setCurrentUser] = createSignal<User | null>(null);
export { currentUser };

export async function doLogin(username: string, password: string): Promise<void> {
  await login(username, password);
  const me = await get<User>("/api/auth/me");
  setCurrentUser(me);
}

export function doLogout(): void {
  setToken(null);
  setCurrentUser(null);
}

export async function loadSession(): Promise<void> {
  if (!getToken()) return;
  try {
    const me = await get<User>("/api/auth/me");
    setCurrentUser(me);
  } catch {
    setToken(null);
    setCurrentUser(null);
  }
}

export function hasRole(min: Role): boolean {
  const u = currentUser();
  if (!u) return false;
  return ROLE_LEVEL[u.role] >= ROLE_LEVEL[min];
}
