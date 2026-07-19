// Shared in-memory MistNodeLike fake for node/client tests.

import type { MistNodeLike } from "../node.js";
import { decode, type ProtocolMessage } from "../protocol.js";

export class FakeMistNode implements MistNodeLike {
  handler: ((eventType: number, fromId: string, payload: unknown, roomId?: string) => void) | null = null;
  joinedRooms: string[] = [];
  leaveCount = 0;
  /** Every `roomId` (or `undefined` for an argless call) passed to leaveRoom(), in call order. */
  leftRooms: (string | undefined)[] = [];
  sent: { toId: string | null | undefined; payload: Uint8Array; delivery?: number }[] = [];

  constructor(public readonly nodeId: string) {}

  async init(): Promise<void> {}

  onEvent(handler: (eventType: number, fromId: string, payload: unknown, roomId?: string) => void): void {
    this.handler = handler;
  }

  joinRoom(roomId: string): void {
    this.joinedRooms.push(roomId);
  }

  leaveRoom(roomId?: string): void {
    this.leaveCount += 1;
    this.leftRooms.push(roomId);
  }

  sendMessage(toId: string | null | undefined, payload: Uint8Array, delivery?: number): void {
    this.sent.push({ toId, payload, delivery });
  }

  /**
   * Simulates the wrapper dispatching an event to the registered handler.
   * `roomId` is optional, matching real multi-room-capable wrappers (see
   * MistNodeLike.onEvent in ../node.ts) — omit it to simulate a room-less
   * event (delivered to every handle by shared-node's dispatch filter).
   */
  emit(eventType: number, fromId: string, payload: unknown, roomId?: string): void {
    this.handler?.(eventType, fromId, payload, roomId);
  }

  /** Decoded view of everything sent through this node. */
  sentMessages(): { toId: string | null | undefined; msg: ProtocolMessage | null; delivery?: number }[] {
    return this.sent.map((s) => ({ toId: s.toId, msg: decode(s.payload), delivery: s.delivery }));
  }
}

/** FakeMistNode whose init() stays pending until the test releases it. */
export class SlowInitFakeMistNode extends FakeMistNode {
  releaseInit!: () => void;
  private readonly initPromise = new Promise<void>((resolve) => {
    this.releaseInit = resolve;
  });

  override init(): Promise<void> {
    return this.initPromise;
  }
}

/** Waits until all currently queued microtasks/promises have settled. */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}
