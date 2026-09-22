import { createSignal } from "solid-js";
import { login, setup, get, setToken, getToken, ApiError, cancelPendingReads } from "../api/client";
import { cancelActiveTasks } from "./taskQueue";
import { ROLE_LEVEL, type Role, type User } from "../types";

const [currentUser, setCurrentUser] = createSignal<User | null>(null);
export { currentUser };

export async function doLogin(username: string, password: string): Promise<void> {
	await login(username, password);
	const me = await get<User>("/api/auth/me");
	setCurrentUser(me);
}

export async function doSetup(password: string): Promise<void> {
	await setup(password);
	const me = await get<User>("/api/auth/me");
	setCurrentUser(me);
}

export function doLogout(): void {
  setToken(null);
  setCurrentUser(null);
  cancelPendingReads();
  cancelActiveTasks();
}

export async function loadSession(): Promise<void> {
  const token = getToken();
  if (!token) return;
  try {
    const me = await get<User>("/api/auth/me");
    setCurrentUser(me);
  } catch (e) {
    // A transient 5xx/network error must leave the token available for a
    // later retry. The request helper already handles a current-token 401;
    // this guard also clears stale user state when called without App.
    if (e instanceof ApiError && e.status === 401 && (getToken() === token || getToken() === null)) {
      if (getToken() === token) setToken(null);
      setCurrentUser(null);
    }
  }
}

export function hasRole(min: Role): boolean {
  const u = currentUser();
  if (!u) return false;
  return ROLE_LEVEL[u.role] >= ROLE_LEVEL[min];
}
