// Thin wrapper around an injected mist node: owns the node lifecycle,
// persists a random nodeId, and exposes a typed send/receive surface for
// protocol messages. The mistlib wasm wrapper is NOT imported here — apps
// inject their own vendored `MistNode` via `createNode`, so this library
// stays transport-agnostic.
//
// Ported from tc-mistllm/src/lib/node.ts / tc-translate/src/lib/mistllm/node.ts.

import { decode, encode, type ProtocolMessage } from "./protocol.js";
import { getPersistentNodeId } from "./id.js";

// Mist event/delivery constants, mirrored from the mistlib web wrapper so the
// library does not have to import it.
export const EVENT_RAW = 0;
export const EVENT_PEER_CONNECTED = 5;
export const EVENT_PEER_DISCONNECTED = 6;
export const DELIVERY_RELIABLE = 0;

/** Structural interface for the vendored mistlib `MistNode` (or any compatible transport). */
export interface MistNodeLike {
  init(): Promise<void>;
  onEvent(handler: (eventType: number, fromId: string, payload: unknown) => void): void;
  joinRoom(roomId: string): void;
  leaveRoom(): void;
  sendMessage(toId: string | null | undefined, payload: Uint8Array, delivery?: number): void;
}

export interface NetworkCallbacks {
  onPeerConnected?(peerId: string): void;
  onPeerDisconnected?(peerId: string): void;
  onMessage?(fromId: string, msg: ProtocolMessage): void;
}

export interface NetworkOptions {
  /** Factory for the app's vendored mist node (e.g. `(id) => new MistNode(id)`). */
  createNode: (nodeId: string) => MistNodeLike;
  /** Explicit node id; defaults to getPersistentNodeId(nodeIdStorageKey). */
  nodeId?: string;
  /** localStorage key used by the default persistent node id. */
  nodeIdStorageKey?: string;
  callbacks?: NetworkCallbacks;
}

/** Defensively coerces whatever the wrapper hands us for EVENT_RAW into decodable input. */
function coercePayload(payload: unknown): Uint8Array | string | null {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === "string") return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  try {
    return new Uint8Array(payload as ArrayBufferLike);
  } catch {
    return null;
  }
}

export class Network {
  private node: MistNodeLike | null = null;
  private readonly createNode: (nodeId: string) => MistNodeLike;
  private readonly nodeId: string;
  private roomId: string | null = null;
  private disposed = false;
  private readonly callbacks: NetworkCallbacks;

  constructor(options: NetworkOptions) {
    this.createNode = options.createNode;
    this.nodeId = options.nodeId ?? getPersistentNodeId(options.nodeIdStorageKey);
    this.callbacks = options.callbacks ?? {};
  }

  get id(): string {
    return this.nodeId;
  }

  get currentRoomId(): string | null {
    return this.roomId;
  }

  async join(roomId: string): Promise<void> {
    const node = this.createNode(this.nodeId);
    await node.init();
    if (this.disposed) {
      node.leaveRoom();
      return;
    }

    node.onEvent((eventType, fromId, payload) => {
      if (this.disposed || this.node !== node) return;
      if (eventType === EVENT_RAW) {
        const bytes = coercePayload(payload);
        if (bytes === null) return;
        const msg = decode(bytes);
        if (msg) this.callbacks.onMessage?.(fromId, msg);
      } else if (eventType === EVENT_PEER_CONNECTED) {
        this.callbacks.onPeerConnected?.(fromId);
      } else if (eventType === EVENT_PEER_DISCONNECTED) {
        this.callbacks.onPeerDisconnected?.(fromId);
      }
    });

    this.node = node;
    this.roomId = roomId;
    node.joinRoom(roomId);
  }

  send(toId: string | null, msg: ProtocolMessage): void {
    this.node?.sendMessage(toId, encode(msg), DELIVERY_RELIABLE);
  }

  leave(): void {
    this.node?.leaveRoom();
    this.node = null;
    this.roomId = null;
  }

  destroy(): void {
    this.leave();
    this.disposed = true;
  }
}
