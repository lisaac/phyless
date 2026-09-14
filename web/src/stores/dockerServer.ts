import { createSignal } from "solid-js";
import { cancelPendingReads } from "../api/client";
import { cancelActiveTasks } from "./taskQueue";

// A server switch invalidates every Docker-backed screen at once. Recreating
// the route subtree also closes its WebSockets and polling timers.
export const [dockerServerEpoch, setDockerServerEpoch] = createSignal(1);
export const cancelDockerServerRequests = () => {
  cancelPendingReads();
  cancelActiveTasks();
};

export const dockerServerChanged = () => {
  cancelDockerServerRequests();
  setDockerServerEpoch((epoch) => epoch + 1);
};
