import * as matchers from "@testing-library/jest-dom/matchers";
import { expect } from "vitest";

// The monorepo currently has separate Vitest versions for the compatibility
// board and Classroom Compass. Extend this workspace's expect instance directly
// so the DOM matchers cannot attach to the other workspace's Vitest singleton.
expect.extend(matchers);

class BroadcastChannelMock {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage() {}
  close() {}
}

Object.defineProperty(globalThis, "BroadcastChannel", { value: BroadcastChannelMock, writable: true });
