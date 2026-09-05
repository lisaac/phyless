import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { LogsView } from "./LogsView";

const mockState = vi.hoisted(() => ({
  sockets: [] as Array<{ close: ReturnType<typeof vi.fn>; handlers: any }>,
}));
const originalScrollTo = HTMLElement.prototype.scrollTo;

vi.mock("../../api/ws", () => ({
  connectWS: vi.fn((_path: string, handlers: any) => {
    const socket = {
      handlers,
      close: vi.fn(() => handlers.onClose?.()),
    };
    mockState.sockets.push(socket);
    return socket;
  }),
  reportWSError: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  HTMLElement.prototype.scrollTo = vi.fn();
  mockState.sockets = [];
});

afterEach(() => {
  cleanup();
  HTMLElement.prototype.scrollTo = originalScrollTo;
  vi.useRealTimers();
});

describe("LogsView", () => {
  it("flushes a split UTF-8 sequence when the current socket closes", () => {
    const view = render(() => <LogsView wsUrl="/logs" />);
    const socket = mockState.sockets[0];
    socket.handlers.onMessage({ data: new Uint8Array([0xe2, 0x82]) });
    socket.handlers.onMessage({ data: new Uint8Array([0xac]) });
    socket.handlers.onClose();
    vi.advanceTimersByTime(80);
    expect(view.container.querySelector("pre")?.textContent).toBe("€");
  });
});
