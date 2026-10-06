import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsumerClient } from "../client.js";
import { emptyLlmConfig } from "../llm-config.js";
import { EVENT_PEER_CONNECTED, EVENT_PEER_DISCONNECTED, EVENT_RAW } from "../node.js";
import { decode, encode, type ProtocolMessage } from "../protocol.js";
import { RoomProviderService, type RoomProviderOptions } from "../room-provider.js";
import { createRoomConsumers } from "../rooms.js";
import { createSharedNodeScope } from "../shared-node.js";
import { FakeMistNode, flushMicrotasks } from "./fake-node.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  vi.unstubAllGlobals();
});

// Queue delivery so an echo loop fails deterministically instead of overflowing
// the stack. Real shared-node scopes fan each frame out to all local consumers.
function transport() {
  vi.stubGlobal("localStorage", { getItem: (key: string) => key, setItem: () => {} });
  const queue: { from: string; to: string | null | undefined; payload: Uint8Array; room?: string }[] = [];
  const sent: { from: string; to: string | null | undefined; msg: ProtocolMessage | null }[] = [];
  class QueuedNode extends FakeMistNode {
    override sendMessage(to: string | null | undefined, payload: Uint8Array, delivery?: number, room?: string) {
      super.sendMessage(to, payload, delivery, room);
      sent.push({ from: this.nodeId, to, msg: decode(payload) });
      queue.push({ from: this.nodeId, to, payload, room });
    }
  }
  const a = new QueuedNode("a"), b = new QueuedNode("b");
  const scopeA = createSharedNodeScope(() => a), scopeB = createSharedNodeScope(() => b);
  function drain() {
    let delivered = 0;
    while (queue.length && delivered < 200) {
      const frame = queue.shift()!;
      for (const node of [a, b]) {
        if (node.nodeId !== frame.from && (!frame.to || frame.to === node.nodeId)) {
          node.emit(EVENT_RAW, frame.from, frame.payload, frame.room);
        }
      }
      delivered += 1;
    }
    expect(queue, "hello feedback must settle within 200 messages").toHaveLength(0);
    return delivered;
  }
  return { a, b, scopeA, scopeB, sent, drain };
}

function provider(nodeScope: ReturnType<typeof createSharedNodeScope>, nodeId: string) {
  const options: RoomProviderOptions = {
    consumers: createRoomConsumers(nodeScope, { nodeIdStorageKey: nodeId }),
    config: {
      ...emptyLlmConfig(),
      providers: [
        { id: "room", label: "Room", apiKey: "", baseUrl: "mist-network://test" },
        { id: "http", label: "HTTP", apiKey: "", baseUrl: "https://example.invalid", models: ["m"] },
      ],
      defaultModel: { providerId: "http", model: "m" },
    },
    roomProvide: { room: { enabled: true, shared: [{ providerId: "http", model: "m" }] } },
  };
  const service = new RoomProviderService(options);
  cleanup.push(() => service.destroy());
  return {
    service,
    update(model: string) {
      options.config.providers[1].models = [model];
      options.config.defaultModel = { providerId: "http", model };
      options.roomProvide.room.shared = [{ providerId: "http", model }];
      service.update(options);
    },
  };
}

function consumer(createNode: ReturnType<typeof createSharedNodeScope>, nodeId: string) {
  const client = new ConsumerClient({ createNode, nodeIdStorageKey: nodeId });
  cleanup.push(() => client.disconnect());
  return client;
}

async function pair(duplicate = false) {
  const wire = transport();
  const ca = consumer(wire.scopeA, "a"), cb = consumer(wire.scopeB, "b");
  const extra = duplicate ? consumer(wire.scopeB, "b") : undefined;
  const pa = provider(wire.scopeA, "a"), pb = provider(wire.scopeB, "b");
  await Promise.all([ca.connect("test"), cb.connect("test"), extra?.connect("test")]);
  await flushMicrotasks();
  return { ...wire, ca, cb, extra, pa, pb };
}

describe("hello regression", () => {
  it("quiesces with a consumer and provider on both nodes", async () => {
    const p = await pair();
    expect(p.drain()).toBeLessThanOrEqual(12);
    expect(p.ca.status.phase).toBe("connected");
    expect(p.cb.status.phase).toBe("connected");
    expect(p.pa.service.states.room.consumerCount).toBe(1);
    expect(p.pb.service.states.room.consumerCount).toBe(1);
  });

  it("quiesces with two consumers sharing one node", async () => {
    const p = await pair(true);
    expect(p.drain()).toBeLessThanOrEqual(16);
    expect(p.extra?.status.phase).toBe("connected");
    expect(p.pa.service.states.room.consumerCount).toBe(1);
  });

  it("propagates a live room model update without an acknowledgement echo", async () => {
    const p = await pair();
    p.drain();
    const before = p.sent.length;
    p.pb.update("updated");
    p.drain();
    expect(p.ca.status).toMatchObject({ models: ["updated"] });
    expect(p.sent.slice(before)).toEqual([
      { from: "b", to: null, msg: expect.objectContaining({ type: "provider_hello", models: ["updated"] }) },
    ]);
  });

  it("resets both discovery guards when a peer reconnects", async () => {
    const p = await pair();
    p.drain();
    p.a.emit(EVENT_PEER_DISCONNECTED, "b", null, "test");
    p.b.emit(EVENT_PEER_DISCONNECTED, "a", null, "test");
    expect(p.ca.status.phase).toBe("searching");
    expect(p.pa.service.states.room.consumerCount).toBe(0);
    const before = p.sent.length;
    p.a.emit(EVENT_PEER_CONNECTED, "b", null, "test");
    p.b.emit(EVENT_PEER_CONNECTED, "a", null, "test");
    p.drain();
    for (const from of ["a", "b"]) {
      // One solicitation on connection, then one acknowledgement on discovery.
      expect(p.sent.slice(before).filter(s => s.from === from && s.msg?.type === "consumer_hello")).toHaveLength(2);
    }
    expect(p.ca.status.phase).toBe("connected");
    expect(p.pa.service.states.room.consumerCount).toBe(1);
    expect(p.pb.service.states.room.consumerCount).toBe(1);
  });

  it("resolves a waiting voice request when an existing provider updates its services", async () => {
    const node = new FakeMistNode("consumer");
    const client = new ConsumerClient({ createNode: () => node });
    cleanup.push(() => client.disconnect());
    await client.connect("test");
    node.emit(EVENT_RAW, "provider", encode({ v: 1, type: "provider_hello", services: [] }));
    const waiting = client.requestTts("test", { text: "hello", model: "later" });
    await flushMicrotasks();
    expect(node.sentMessages().some(s => s.msg?.type === "tts_request")).toBe(false);
    const before = node.sent.length;
    node.emit(EVENT_RAW, "provider", encode({ v: 1, type: "provider_hello", services: ["tts"], models: ["later"], voices: ["alloy"] }));
    await flushMicrotasks();
    const requests = node.sentMessages().slice(before);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ toId: "provider", msg: { type: "tts_request", model: "later" } });
    const request = requests[0].msg;
    if (request?.type !== "tts_request") throw new Error("missing TTS request");
    node.emit(EVENT_RAW, "provider", encode({ v: 1, type: "tts_response", id: request.id, seq: 0, data: "", last: true, mime: "audio/mpeg" }));
    await expect(waiting).resolves.toBeInstanceOf(Blob);
    expect(client.status).toMatchObject({ models: ["later"], voices: ["alloy"] });
  });

  it("settles with a legacy consumer that answers every provider hello, including updates and reconnect", async () => {
    const wire = transport();
    // Model the unpatched consumer's unconditional response on the wire.
    wire.a.onEvent((event, from, payload) => {
      if (event === EVENT_RAW && decode(payload as Uint8Array)?.type === "provider_hello") {
        wire.a.sendMessage(from, encode({ v: 1, type: "consumer_hello" }), 0, "test");
      }
    });
    const pb = provider(wire.scopeB, "b");
    await flushMicrotasks();
    expect(wire.drain()).toBeLessThanOrEqual(4);
    expect(pb.service.states.room.consumerCount).toBe(1);
    pb.update("updated");
    expect(wire.drain()).toBe(2);
    wire.b.emit(EVENT_PEER_DISCONNECTED, "a", null, "test");
    expect(pb.service.states.room.consumerCount).toBe(0);
    wire.b.emit(EVENT_PEER_CONNECTED, "a", null, "test");
    expect(wire.drain()).toBeLessThanOrEqual(4);
    expect(pb.service.states.room.consumerCount).toBe(1);
  });
});
