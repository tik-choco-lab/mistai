// tc-translate/lib/network.ts, scoped to the host's shared node factory.
import { ConsumerClient, type ConsumerClientOptions } from './client.js';
import { OaiTunnelClient, type OaiTunnelRequestInit } from './tunnel.js';
import type { ChatMessage } from './protocol.js';
import type { MistNodeLike } from './node.js';
import { cacheRoomModels } from './model-catalog.js';

export type NodeScope = (nodeId: string) => MistNodeLike;
export interface RoomConsumers {
  nodeScope: NodeScope;
  nodeIdStorageKey: string;
  roomConsumer(roomId: string): ConsumerClient;
  disconnectRoom(roomId: string): void;
  requestRoomChat(roomId: string, messages: ChatMessage[], model?: string, onDelta?: (delta: string, full: string) => void): Promise<string>;
  requestRoomTts(roomId: string, params: { text: string; model?: string; voice?: string; lang?: string }): Promise<Blob>;
  requestRoomStt(roomId: string, params: { audio: Blob; model?: string; fileName?: string }): Promise<string>;
  requestRoomOpenAi(roomId: string, request: OaiTunnelRequestInit): ReturnType<OaiTunnelClient['request']>;
}

export function createRoomConsumers(nodeScope: NodeScope, options: Omit<ConsumerClientOptions, 'createNode'> = {}): RoomConsumers {
  const consumers = new Map<string, ConsumerClient>();
  const tunnels = new Map<string, OaiTunnelClient>();
  const nodeIdStorageKey = options.nodeIdStorageKey ?? 'mistai-node-id-v1';
  const result: RoomConsumers = {
    nodeScope, nodeIdStorageKey,
    roomConsumer(roomId) {
      const room = roomId.trim();
      let client = consumers.get(room);
      if (!client) {
        client = new ConsumerClient({ requestTimeoutMs: 120_000, providerWaitTimeoutMs: 30_000, ...options, createNode: nodeScope, nodeIdStorageKey });
        consumers.set(room, client);
        client.onStatusChange(status => { if (status.phase === 'connected') cacheRoomModels(room, status.models ?? []); });
      }
      return client;
    },
    disconnectRoom(roomId) { const room = roomId.trim(); consumers.get(room)?.disconnect(); tunnels.get(room)?.disconnect(); },
    requestRoomChat(room, messages, model, onDelta) { return result.roomConsumer(room).requestChat(room.trim(), messages, { model, onDelta }); },
    requestRoomTts(room, params) { return result.roomConsumer(room).requestTts(room.trim(), params); },
    requestRoomStt(room, params) { return result.roomConsumer(room).requestStt(room.trim(), params); },
    requestRoomOpenAi(roomId, request) {
      const room = roomId.trim();
      let client = tunnels.get(room);
      if (!client) { client = new OaiTunnelClient({ createNode: nodeScope, nodeIdStorageKey }); tunnels.set(room, client); }
      return client.request(room, request);
    },
  };
  defaultRooms = result;
  return result;
}

let defaultRooms: RoomConsumers | undefined;
export function getRoomConsumers(): RoomConsumers {
  return defaultRooms ?? createRoomConsumers(() => { throw new Error('Call createRoomConsumers(nodeScope) before joining rooms.'); });
}
export const roomConsumer = (room: string) => getRoomConsumers().roomConsumer(room);
export const disconnectRoom = (room: string) => getRoomConsumers().disconnectRoom(room);
export const requestRoomChat: RoomConsumers['requestRoomChat'] = (...args) => getRoomConsumers().requestRoomChat(...args);
export const requestRoomTts: RoomConsumers['requestRoomTts'] = (...args) => getRoomConsumers().requestRoomTts(...args);
export const requestRoomStt: RoomConsumers['requestRoomStt'] = (...args) => getRoomConsumers().requestRoomStt(...args);
export const requestRoomOpenAi: RoomConsumers['requestRoomOpenAi'] = (...args) => getRoomConsumers().requestRoomOpenAi(...args);
export type { ConsumerStatus, ConsumerStatusListener } from './client.js';
