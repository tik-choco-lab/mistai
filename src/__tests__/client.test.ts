import { describe, expect, it } from "vitest";
import { ConsumerClient, type ConsumerStatus } from "../client.js";
import { EVENT_PEER_DISCONNECTED, EVENT_RAW } from "../node.js";
import { encode, type LlmRequestMsg, type TtsRequestMsg } from "../protocol.js";
import { FakeMistNode, flushMicrotasks } from "./fake-node.js";

function makeClient(options: { providerWaitTimeoutMs?: number; requestTimeoutMs?: number } = {}) {
  const nodes: FakeMistNode[] = [];
  const client = new ConsumerClient({
    createNode: (nodeId) => {
      const node = new FakeMistNode(nodeId);
      nodes.push(node);
      return node;
    },
    ...options,
  });
  return { client, nodes };
}

describe("ConsumerClient", () => {
  it("connects, broadcasts consumer_hello, and reaches connected with models on provider_hello", async () => {
    const { client, nodes } = makeClient();
    const statuses: ConsumerStatus[] = [];
    client.onStatusChange((s) => statuses.push(s));

    expect(client.status).toEqual({ phase: "idle" });
    await client.connect("room1");

    const node = nodes[0];
    expect(node.joinedRooms).toEqual(["room1"]);
    // Improvement over the tc-translate reference: consumer_hello is
    // broadcast right after joining so providers can label/count us.
    expect(node.sentMessages()).toEqual([
      { toId: null, msg: { v: 1, type: "consumer_hello" }, delivery: 0 },
    ]);
    expect(client.status).toEqual({ phase: "searching" });
    expect(statuses.map((s) => s.phase)).toEqual(["joining", "searching"]);

    node.emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello", models: ["m1", "m2"] }));
    expect(client.status).toEqual({ phase: "connected", providerId: "prov1", models: ["m1", "m2"] });

    // ...and a directed consumer_hello goes back to the provider that greeted us.
    const sent = node.sentMessages();
    expect(sent[1]).toEqual({ toId: "prov1", msg: { v: 1, type: "consumer_hello" }, delivery: 0 });
  });

  it("reports connected without models when provider_hello has none", async () => {
    const { client, nodes } = makeClient();
    await client.connect("room1");
    nodes[0].emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello" }));
    expect(client.status).toEqual({ phase: "connected", providerId: "prov1" });
  });

  it("routes a chat request to the connected provider and resolves on done", async () => {
    const { client, nodes } = makeClient();
    await client.connect("room1");
    const node = nodes[0];
    node.emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello" }));

    const deltas: string[] = [];
    const promise = client.requestChat("room1", [{ role: "user", content: "hi" }], {
      model: "m1",
      onDelta: (d) => deltas.push(d),
    });
    await flushMicrotasks();

    const req = node.sentMessages().find((s) => s.msg?.type === "llm_request");
    expect(req?.toId).toBe("prov1");
    const reqMsg = req?.msg as LlmRequestMsg;
    expect(reqMsg.model).toBe("m1");

    node.emit(EVENT_RAW, "prov1", encode({ v: 1, type: "llm_response_chunk", id: reqMsg.id, delta: "he", seq: 0 }));
    node.emit(EVENT_RAW, "prov1", encode({ v: 1, type: "llm_response_done", id: reqMsg.id, content: "hey" }));
    await expect(promise).resolves.toBe("hey");
    expect(deltas).toEqual(["he"]);
  });

  it("rejects requests and throws for an empty room id", async () => {
    const { client } = makeClient();
    await expect(client.requestChat("  ", [{ role: "user", content: "hi" }])).rejects.toThrow(
      "room ID is not set",
    );
  });

  it("rejects in-flight voice requests and reverts to searching when the provider disconnects", async () => {
    const { client, nodes } = makeClient();
    await client.connect("room1");
    const node = nodes[0];
    node.emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello" }));

    const tts = client.requestTts("room1", { text: "hi" });
    await flushMicrotasks();
    expect(node.sentMessages().some((s) => s.msg?.type === "tts_request")).toBe(true);

    node.emit(EVENT_PEER_DISCONNECTED, "prov1", null);
    await expect(tts).rejects.toThrow("Connection to the provider was lost");
    expect(client.status).toEqual({ phase: "searching" });
  });

  it("rejects in-flight chat requests when the provider disconnects", async () => {
    const { client, nodes } = makeClient();
    await client.connect("room1");
    const node = nodes[0];
    node.emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello" }));

    const chat = client.requestChat("room1", [{ role: "user", content: "hi" }]);
    await flushMicrotasks();
    node.emit(EVENT_PEER_DISCONNECTED, "prov1", null);
    await expect(chat).rejects.toThrow("Connection to the provider was lost");
  });

  it("ignores disconnects of peers that are not the provider", async () => {
    const { client, nodes } = makeClient();
    await client.connect("room1");
    nodes[0].emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello" }));
    nodes[0].emit(EVENT_PEER_DISCONNECTED, "other-peer", null);
    expect(client.status).toEqual({ phase: "connected", providerId: "prov1" });
  });

  it("fails a request when no provider appears in time", async () => {
    const { client } = makeClient({ providerWaitTimeoutMs: 30 });
    const statuses: ConsumerStatus[] = [];
    client.onStatusChange((s) => statuses.push(s));

    await client.connect("room1");
    await expect(client.requestChat("room1", [{ role: "user", content: "hi" }])).rejects.toThrow(
      "No provider found",
    );
    expect(client.status).toEqual({
      phase: "error",
      message: "No provider found on the LLM Network.",
      code: "PROVIDER_NOT_FOUND",
    });
  });

  it("recovers after a wait timeout once a provider announces itself", async () => {
    const { client, nodes } = makeClient({ providerWaitTimeoutMs: 30 });
    await client.connect("room1");
    await expect(client.requestChat("room1", [{ role: "user", content: "hi" }])).rejects.toThrow();

    nodes[0].emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello" }));
    expect(client.status).toEqual({ phase: "connected", providerId: "prov1" });

    const promise = client.requestChat("room1", [{ role: "user", content: "hi" }]);
    await flushMicrotasks();
    const req = nodes[0].sentMessages().find((s) => s.msg?.type === "llm_request");
    nodes[0].emit(EVENT_RAW, "prov1", encode({ v: 1, type: "llm_response_done", id: (req?.msg as LlmRequestMsg).id, content: "ok" }));
    await expect(promise).resolves.toBe("ok");
  });

  it("surfaces join failures via error status without throwing from connect()", async () => {
    const client = new ConsumerClient({
      createNode: () => {
        return {
          init: async () => {
            throw new Error("wasm init failed");
          },
          onEvent: () => {},
          joinRoom: () => {},
          leaveRoom: () => {},
          sendMessage: () => {},
        };
      },
    });
    const statuses: ConsumerStatus[] = [];
    client.onStatusChange((s) => statuses.push(s));

    await client.connect("room1"); // must not throw
    expect(client.status).toEqual({ phase: "error", message: "wasm init failed", code: "JOIN_FAILED" });
  });

  it("disconnect() tears down the session and resets to idle", async () => {
    const { client, nodes } = makeClient();
    await client.connect("room1");
    client.disconnect();
    expect(nodes[0].leaveCount).toBe(1);
    expect(client.status).toEqual({ phase: "idle" });
  });

  it("replaces the session when connecting to a different room", async () => {
    const { client, nodes } = makeClient();
    await client.connect("room1");
    await client.connect("room2");
    expect(nodes).toHaveLength(2);
    expect(nodes[0].leaveCount).toBe(1);
    expect(nodes[1].joinedRooms).toEqual(["room2"]);
  });

  it("reuses the existing session for the same room", async () => {
    const { client, nodes } = makeClient();
    await client.connect("room1");
    await client.connect("room1");
    expect(nodes).toHaveLength(1);
  });

  it("passes STT parameters through and resolves with the recognized text", async () => {
    const { client, nodes } = makeClient();
    await client.connect("room1");
    const node = nodes[0];
    node.emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello" }));

    const promise = client.requestStt("room1", {
      audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
      model: "whisper-1",
      fileName: "rec.webm",
    });
    await flushMicrotasks();

    const req = node.sentMessages().find((s) => s.msg?.type === "stt_request");
    expect(req?.toId).toBe("prov1");
    const sttMsg = req?.msg as { id: string; model?: string; fileName?: string };
    expect(sttMsg.model).toBe("whisper-1");
    expect(sttMsg.fileName).toBe("rec.webm");

    node.emit(EVENT_RAW, "prov1", encode({ v: 1, type: "stt_response", id: sttMsg.id, text: "hello" }));
    await expect(promise).resolves.toBe("hello");
  });

  it("applies requestTimeoutMs to chat requests", async () => {
    const { client, nodes } = makeClient({ requestTimeoutMs: 30 });
    await client.connect("room1");
    nodes[0].emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello" }));

    await expect(client.requestChat("room1", [{ role: "user", content: "hi" }])).rejects.toThrow("timed out");
  });

  it("sends TTS requests to the provider", async () => {
    const { client, nodes } = makeClient();
    await client.connect("room1");
    const node = nodes[0];
    node.emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello" }));

    const promise = client.requestTts("room1", { text: "hello", model: "tts-1", voice: "alloy" });
    await flushMicrotasks();
    const req = node.sentMessages().find((s) => s.msg?.type === "tts_request");
    const ttsMsg = req?.msg as TtsRequestMsg;
    expect(ttsMsg.text).toBe("hello");
    expect(ttsMsg.model).toBe("tts-1");
    expect(ttsMsg.voice).toBe("alloy");

    node.emit(
      EVENT_RAW,
      "prov1",
      encode({ v: 1, type: "tts_response", id: ttsMsg.id, seq: 0, data: "", last: true, mime: "audio/mpeg" }),
    );
    const blob = await promise;
    expect(blob.type).toBe("audio/mpeg");
  });
});
