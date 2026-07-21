import "@testing-library/jest-dom/vitest";

class BroadcastChannelMock {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage() {}
  close() {}
}

Object.defineProperty(globalThis, "BroadcastChannel", { value: BroadcastChannelMock, writable: true });
