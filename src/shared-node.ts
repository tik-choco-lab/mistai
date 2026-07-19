// mistlib-wasm supports exactly ONE active MistNode per page (a module-level
// `activeNode` guard plus one global event callback in the vendored wrapper),
// but that single node is multi-room: joinRoom(roomId) can be called for any
// number of rooms and every event carries the roomId it happened in. An app
// consuming this library, however, may want up to three independent
// "network stacks" alive at once — an LLM consumer (ConsumerClient), a
// provider (useNetworkProvider), and an OAI tunnel client (./tunnel.ts) —
// each constructing its own `Network`, which in turn creates and init()s its
// own MistNodeLike. Without this facade, the second such stack throws
// "mistlib-wasm supports one active MistNode per page".
//
// createSharedNodeScope() fixes that by multiplexing every createNode()
// caller within one scope onto a single real node behind lightweight
// per-caller handles:
// - init() lazily creates/inits the single real node (first handle's nodeId
//   wins; every handle in a scope should derive its id from the same storage
//   key anyway, since they're meant to be one peer on the wire).
// - Events fan out to every live handle, filtered by the rooms that handle
//   actually joined (the wrapper's optional 4th onEvent arg — see
//   MistNodeLike in ./node.ts; events without a roomId, if any, are
//   delivered to every handle).
// - leaveRoom(roomId) releases only this handle's membership in that one
//   room, reference counted across every handle in the scope, so e.g. the
//   consumer disconnecting doesn't kick the provider out of a room they
//   share. leaveRoom() with no argument releases every room this handle
//   joined (matching the pre-widening MistNodeLike.leaveRoom() shape). The
//   real node's own per-room leave (`realNode.leaveRoom(roomId)`) is only
//   called once a room's reference count hits zero, and the argless
//   real-node leave is NEVER called — re-creating the real node later would
//   just re-trip the wrapper's singleton guard for no benefit, so it stays
//   initialized for the scope's lifetime.
//
// Consequence of the shared identity: every handle sharing a scope is one
// peer on the wire (same nodeId). In particular, a page's own provider can
// no longer be "discovered" by that same page's consumer if they share a
// scope (mist doesn't loop broadcasts back to the sender) — this was only
// ever a degenerate loopback anyway, so there's no practical loss.
//
// Ported from tc-translate/src/lib/mistNodeShared.ts, generalized from
// module-level globals into a scope closure (`createSharedNodeScope`) so
// callers — notably tests — can create more than one isolated scope instead
// of sharing one implicit page-wide singleton.

import type { MistNodeLike } from "./node.js";

interface ScopeState {
  realNode: MistNodeLike | null;
  realNodeId: string | null;
  readonly liveHandles: Set<SharedNodeHandle>;
  readonly roomRefCounts: Map<string, number>;
}

class SharedNodeHandle implements MistNodeLike {
  private readonly nodeId: string;
  private readonly scope: ScopeState;
  private readonly createRealNode: (nodeId: string) => MistNodeLike;
  private readonly rooms = new Set<string>();
  private handler: ((eventType: number, fromId: string, payload: unknown) => void) | null = null;

  constructor(nodeId: string, scope: ScopeState, createRealNode: (nodeId: string) => MistNodeLike) {
    this.nodeId = nodeId;
    this.scope = scope;
    this.createRealNode = createRealNode;
  }

  async init(): Promise<void> {
    await this.ensureRealNode().init();
    this.scope.liveHandles.add(this);
  }

  private ensureRealNode(): MistNodeLike {
    const scope = this.scope;
    if (!scope.realNode) {
      const node = this.createRealNode(this.nodeId);
      scope.realNode = node;
      scope.realNodeId = this.nodeId;
      node.onEvent((eventType, fromId, payload, roomId) => {
        // Copy: a handler may add/remove handles (e.g. reconnect) mid-dispatch.
        for (const handle of [...scope.liveHandles]) handle.dispatch(eventType, fromId, payload, roomId);
      });
    } else if (scope.realNodeId !== this.nodeId) {
      // Every handle in a scope is meant to derive its id from the same
      // storage key, so this only fires if a caller passes a divergent id —
      // it still shares the scope's wire identity (fixed at first init).
      console.warn(
        `@tik-choco/mistai: shared MistNode already initialized as ${scope.realNodeId}; ignoring requested id ${this.nodeId}`,
      );
    }
    return scope.realNode;
  }

  onEvent(handler: (eventType: number, fromId: string, payload: unknown) => void): void {
    this.handler = handler;
  }

  joinRoom(roomId: string): void {
    if (!this.rooms.has(roomId)) {
      this.rooms.add(roomId);
      this.scope.roomRefCounts.set(roomId, (this.scope.roomRefCounts.get(roomId) ?? 0) + 1);
    }
    // Re-joining an already-joined room is an idempotent re-announce per the
    // wrapper, so no need to guard the underlying call.
    this.scope.realNode?.joinRoom(roomId);
  }

  /**
   * `roomId` omitted leaves every room this handle joined (matching the
   * original argless MistNodeLike.leaveRoom() shape); an explicit `roomId`
   * leaves only that one room, so a caller managing several rooms on one
   * handle can drop just one of them.
   */
  leaveRoom(roomId?: string): void {
    const roomsToLeave = roomId !== undefined ? [roomId] : [...this.rooms];
    for (const room of roomsToLeave) {
      if (!this.rooms.has(room)) continue;
      this.rooms.delete(room);
      const remaining = (this.scope.roomRefCounts.get(room) ?? 1) - 1;
      if (remaining <= 0) {
        this.scope.roomRefCounts.delete(room);
        // Per-room leave (mist_leave_room_id) — unlike the argless wrapper
        // leaveRoom(), this does NOT reset the wrapper's activeNode guard, so
        // the shared node stays usable for the other handles and for later
        // re-joins. The real node's leaveRoom() is NEVER called without a
        // roomId for exactly this reason.
        this.scope.realNode?.leaveRoom(room);
      } else {
        this.scope.roomRefCounts.set(room, remaining);
      }
    }
    if (this.rooms.size === 0) this.scope.liveHandles.delete(this);
  }

  sendMessage(toId: string | null | undefined, payload: Uint8Array, delivery?: number): void {
    this.scope.realNode?.sendMessage(toId, payload, delivery);
  }

  /** Fan-out target for the real node's single global event callback. */
  dispatch(eventType: number, fromId: string, payload: unknown, roomId?: string): void {
    if (!this.handler) return;
    // Room-scoped events only reach handles that joined that room; events
    // without a room tag (defensive — real wrappers today always pass one)
    // are delivered to everyone.
    if (typeof roomId === "string" && roomId && !this.rooms.has(roomId)) return;
    this.handler(eventType, fromId, payload);
  }
}

/**
 * Creates an isolated "shared node" scope: a factory that hands out
 * lightweight `MistNodeLike` handles which all multiplex onto one real node
 * (created via `createRealNode`, e.g. `(id) => new MistNode(id)` from an
 * app's vendored mistlib wrapper). Every handle produced by the SAME scope
 * shares one wire identity; call `createSharedNodeScope` again for an
 * independent identity (e.g. one scope per test, or per logically distinct
 * peer within the same process).
 *
 * Typical app usage — call once at module scope and reuse the returned
 * factory as `createNode` for every network stack that should share a page
 * identity:
 *
 * ```ts
 * import { MistNode } from "./vendor/mistlib/wrappers/web/index.js";
 * export const createSharedMistNode = createSharedNodeScope((nodeId) => new MistNode(nodeId));
 * // ...later, in each stack:
 * new Network({ createNode: createSharedMistNode, nodeIdStorageKey: "my-app:node-id" });
 * new OaiTunnelClient({ createNode: createSharedMistNode, nodeIdStorageKey: "my-app:node-id" });
 * ```
 */
export function createSharedNodeScope(createRealNode: (nodeId: string) => MistNodeLike): (nodeId: string) => MistNodeLike {
  const scope: ScopeState = {
    realNode: null,
    realNodeId: null,
    liveHandles: new Set(),
    roomRefCounts: new Map(),
  };
  return (nodeId: string) => new SharedNodeHandle(nodeId, scope, createRealNode);
}
